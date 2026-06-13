-- 047_org_idp_connections.sql
--
-- Multi-IdP foundation slice 7 — per-org SAML/OIDC IdP connection registry.
-- Sibling-shape to migration 046 (organizations.auth0_org_id): mig 046
-- stores the org-level Auth0 Org peer; mig 047 stores per-connection
-- references for the wizard-created SAML/OIDC IdP connections.
--
-- Why a new table (vs another column on organizations) — June 29 launch
-- directive 2026-06-13:
--   * Per-org-multiple-connections is the design (one customer-org under
--     a reseller may use Okta SAML for some users + Google direct for
--     others; another customer-org under the same reseller may use Azure
--     AD via SAML). A single-FK column would force one-or-none.
--   * Audit trail: created_at / created_by / status fields per connection
--     give the wizard + ops a per-row history (vs blanket-update on the
--     org row).
--   * Strategy-level filtering: dashboards can list "all SAML connections
--     across the tenant" cheaply with a strategy-indexed query.
--
-- Schema rationale:
--   * org_id REFERENCES organizations(id) ON DELETE CASCADE: when an org
--     is hard-deleted (the GDPR-class purge path), its IdP connections
--     are part of the org's identity-substrate and are dropped with it.
--   * auth0_connection_id TEXT UNIQUE: one-to-one mapping between Conduit
--     rows and Auth0 connections — catches accidental double-create + a
--     drift between the two systems by-construction at write-time.
--   * entity_id TEXT NOT NULL: the IdP's SAML EntityID, persisted for
--     display in the org-admin wizard list + as audit-trail breadcrumb.
--   * status TEXT: 'active' | 'disabled' (manual disable by admin) |
--     'errored' (Auth0-side validation failed). Default 'active'.
--   * strategy TEXT NOT NULL: 'samlp' | 'oidc' (post-launch). Indexed for
--     the cross-tenant strategy-filtered queries above.
--   * created_at / created_by_user_id: standard audit columns.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS + ADD CONSTRAINT IF NOT EXISTS via the
--   DO $$ + pg_constraint-lookup pattern (same shape as mig 045/046 —
--   Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for UNIQUE / CHECK).

CREATE TABLE IF NOT EXISTS org_idp_connections (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  auth0_connection_id   TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  strategy              TEXT NOT NULL,
  display_name          TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  created_by_user_id    TEXT NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_idp_connections_auth0_connection_id_unique'
  ) THEN
    ALTER TABLE org_idp_connections
      ADD CONSTRAINT org_idp_connections_auth0_connection_id_unique UNIQUE (auth0_connection_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_idp_connections_strategy_check'
  ) THEN
    ALTER TABLE org_idp_connections
      ADD CONSTRAINT org_idp_connections_strategy_check
      CHECK (strategy IN ('samlp', 'oidc'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_idp_connections_status_check'
  ) THEN
    ALTER TABLE org_idp_connections
      ADD CONSTRAINT org_idp_connections_status_check
      CHECK (status IN ('active', 'disabled', 'errored'));
  END IF;
END $$;

-- Hot-path index: wizard's GET /admin/orgs/:orgId/idp-connections lists
-- all connections for an org. Most orgs will have 0-3 connections so a
-- partial index is overkill; the FK index Postgres auto-creates on org_id
-- is the right cost for this access pattern.

-- Cross-tenant strategy filter index — supports the ops dashboard's
-- "list all samlp connections across the platform" query.
CREATE INDEX IF NOT EXISTS idx_org_idp_connections_strategy
  ON org_idp_connections (strategy);
