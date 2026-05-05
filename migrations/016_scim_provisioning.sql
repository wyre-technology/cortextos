-- =============================================================================
-- Migration:      016_scim_provisioning.sql
-- Date:           2026-05-01
-- PRD Reference:  plans/okay-so-we-need-imperative-pebble.md (Tier 1 SCIM)
-- Ticket:         scim-provisioning / Phase 0
--
-- Purpose:
--   Add the schema needed for SCIM 2.0 inbound provisioning at two scopes:
--     - tenant   (org_members + org_teams of customer/standalone orgs)
--     - reseller (reseller_members of MSP orgs)
--
--   Introduces:
--     - `scim_connections`            — one row per IdP-side provisioning
--                                       app, opaque bearer token (hashed),
--                                       scope, default role, IdP type.
--     - `users.external_id`           — IdP-issued stable id (Entra OID etc.)
--     - `users.active`                — soft-deactivation flag (SCIM PATCH
--                                       active=false stays here even after
--                                       org_members removal so re-activation
--                                       is idempotent).
--     - `users.deactivated_at`        — wall clock for audit.
--     - `org_teams.external_id`       — IdP-issued stable group id.
--     - `org_teams.scim_connection_id`— provenance link; on connection revoke
--                                       teams are soft-flagged, not deleted.
--
--   The connection token is a 32-byte random secret shown to the admin once;
--   only its sha256 hash persists. Same discipline as
--   src/org/invitation-service.ts:73 (PRD §8.4 / §A.19 SOC2 invariant).
--
-- Idempotency:
--   CREATE TABLE / ALTER TABLE / CREATE INDEX all gated with IF NOT EXISTS or
--   the equivalent guarded DO-block (CHECK constraints). Safe to re-run.
--
-- Rollback Notes:
--   Greenfield: drop policies, drop scim_connections, drop the added columns.
--   Forward-only project convention — no down-migration file.
--
-- Concerns / Follow-ups:
--   - users.email is already UNIQUE (src/auth/auth0.ts:82). SCIM POST /Users
--     dedupes against that constraint. If a user is provisioned into multiple
--     orgs by different IdPs, we add an org_members row against the existing
--     user row rather than create a duplicate user — handler-level concern,
--     not schema.
--   - external_id is unique only WITHIN a scim_connection (an IdP could send
--     the same OID for different objects in different tenants). Partial
--     unique index enforces this.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. scim_connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scim_connections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  idp_type        TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  default_role    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  last_sync_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT REFERENCES users(id),
  revoked_at      TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scim_connections_scope_check'
       AND conrelid = 'scim_connections'::regclass
  ) THEN
    ALTER TABLE scim_connections
      ADD CONSTRAINT scim_connections_scope_check
      CHECK (scope IN ('tenant', 'reseller'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scim_connections_idp_type_check'
       AND conrelid = 'scim_connections'::regclass
  ) THEN
    ALTER TABLE scim_connections
      ADD CONSTRAINT scim_connections_idp_type_check
      CHECK (idp_type IN ('entra', 'okta', 'jumpcloud', 'google', 'generic'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scim_connections_status_check'
       AND conrelid = 'scim_connections'::regclass
  ) THEN
    ALTER TABLE scim_connections
      ADD CONSTRAINT scim_connections_status_check
      CHECK (status IN ('active', 'revoked'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_scim_connections_org
  ON scim_connections (org_id);

CREATE INDEX IF NOT EXISTS idx_scim_connections_active
  ON scim_connections (org_id, scope)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 2. users — external_id, active, deactivated_at
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active          BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ;

-- Index supports first-login binding by lower(email). Existing UNIQUE on
-- users.email is case-sensitive; auth0 callbacks may differ in case.
CREATE INDEX IF NOT EXISTS idx_users_lower_email
  ON users (lower(email));

-- Shadow-id discriminator: users.id LIKE 'shadow:%' means SCIM-created,
-- not yet bound to an Auth0 sub. No constraint — purely a convention.

-- ---------------------------------------------------------------------------
-- 3. org_teams — external_id, scim_connection_id
-- ---------------------------------------------------------------------------
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS external_id          TEXT;
ALTER TABLE org_teams ADD COLUMN IF NOT EXISTS scim_connection_id   TEXT
  REFERENCES scim_connections(id) ON DELETE SET NULL;

-- Stable identity per IdP connection. Partial because non-SCIM teams have
-- both columns NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_teams_external_id
  ON org_teams (scim_connection_id, external_id)
  WHERE scim_connection_id IS NOT NULL AND external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RLS — scim_connections
--
-- Mirrors org_members visibility (007_rls_enable.sql, 014_rls_with_check_clauses):
--   READ:  members of the connection's org, OR reseller admins of its parent.
--   WRITE: same — admins create/revoke connections through the app.
--
-- SCIM-side requests do NOT use these policies; the SCIM bearer-token
-- middleware sets `conduit.current_org_id` and uses an actor of the
-- connection's `created_by` (so audit ties back to a human).
-- ---------------------------------------------------------------------------
ALTER TABLE scim_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scim_connections_select ON scim_connections;
CREATE POLICY scim_connections_select ON scim_connections
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = scim_connections.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
         AND (
           rm.reseller_org_id = scim_connections.org_id
           OR rm.reseller_org_id = (
             SELECT parent_org_id FROM organizations
              WHERE id = scim_connections.org_id
           )
         )
    )
  );

DROP POLICY IF EXISTS scim_connections_insert ON scim_connections;
CREATE POLICY scim_connections_insert ON scim_connections
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = scim_connections.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
         AND (
           rm.reseller_org_id = scim_connections.org_id
           OR rm.reseller_org_id = (
             SELECT parent_org_id FROM organizations
              WHERE id = scim_connections.org_id
           )
         )
    )
  );

DROP POLICY IF EXISTS scim_connections_update ON scim_connections;
CREATE POLICY scim_connections_update ON scim_connections
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = scim_connections.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
         AND (
           rm.reseller_org_id = scim_connections.org_id
           OR rm.reseller_org_id = (
             SELECT parent_org_id FROM organizations
              WHERE id = scim_connections.org_id
           )
         )
    )
  );

DROP POLICY IF EXISTS scim_connections_delete ON scim_connections;
CREATE POLICY scim_connections_delete ON scim_connections
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = scim_connections.org_id
         AND m.user_id = current_setting('conduit.current_user_id', true)
         AND m.role IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
         AND (
           rm.reseller_org_id = scim_connections.org_id
           OR rm.reseller_org_id = (
             SELECT parent_org_id FROM organizations
              WHERE id = scim_connections.org_id
           )
         )
    )
  );

COMMIT;

-- =============================================================================
-- End of 016_scim_provisioning.sql
-- =============================================================================
