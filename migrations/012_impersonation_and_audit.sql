-- =============================================================================
-- Migration:      012_impersonation_and_audit.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-msp-admin.md §9.1 (impersonation schema sketch),
--                 §7.7 / §10.2 (reseller-scope audit), Task msp-admin #2.
-- Ticket:         msp-admin / Task #2 (migrations)
--
-- Purpose:
--   Fills the remaining schema gaps for the MSP Admin Console. Earlier
--   migrations already covered much of msp-admin #2:
--
--     * 002_reseller_tenancy_expand.sql  — organizations.type, parent_org_id,
--                                          indexes on (parent_org_id), (type),
--                                          hierarchy trigger.
--     * 003_reseller_members.sql         — reseller_members table + role CHECK
--                                          + reseller_org_id type trigger.
--     * 004/005                          — support-grant plumbing.
--     * 006_audit_actor_org_id.sql       — audit_logs.actor_org_id column.
--     * 007_rls_enable.sql               — RLS policies.
--     * 011_hash_invitation_tokens.sql   — token_hash migration.
--
--   Not yet landed (this file):
--     1. organizations.suspended_at (nullable TIMESTAMPTZ) — per PRD §10.2.
--     2. impersonation_sessions table — per PRD §9.1 schema sketch plus
--        §9.2 / §9.3 fields (ended_reason) and the operational columns the
--        msp-admin #2 task calls out (scope, ip, user_agent).
--     3. reseller_admin_audit table — per PRD §7.7 / §10.2. Distinct from
--        the existing `admin_audit_log` (single-org) — this one is
--        reseller-scoped with (reseller_org_id, actor, target customer,
--        action, payload).
--     4. Trigram search indexes on organizations.name to power the
--        reseller customer-list search box (§7.2). org_members has no
--        `email` column today (see src/org/org-service.ts initTables),
--        so the email trigram index called out in the task spec is NOT
--        created here; deferred until/unless an email column lands.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX
--   IF NOT EXISTS, and DO-block guards for CHECK constraints. Safe to
--   re-run. pg_trgm is enabled with CREATE EXTENSION IF NOT EXISTS.
--
-- Rollback Notes:
--   Greenfield: drop indexes, then tables, then the suspended_at column.
--   Once real impersonation / audit rows exist, rollback is destructive
--   and must be coordinated. No down-migration file — project convention
--   is forward-only (see 001, 002, 003).
--
-- Ordering / Concerns:
--   - All new FK references use ON DELETE CASCADE on reseller_org_id /
--     customer_org_id so that deleting an org also removes its
--     impersonation history and audit trail. Delete of a reseller is
--     separately RESTRICTed by organizations.parent_org_id FK (see 002),
--     so cascades here only fire after that guard is cleared.
--   - actor_user_id uses ON DELETE RESTRICT so audit history is not lost
--     when a user is removed; deletes should soft-delete users instead.
--   - The impersonation_sessions.scope CHECK mirrors PRD §9.2 wording
--     (read_only default, mutate for the full-edit flow).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. organizations.suspended_at
--    Set by the suspend-customer flow (PRD §7.3, acceptance criterion 13).
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ NULL;

-- Partial index — only suspended rows are interesting for "list suspended".
CREATE INDEX IF NOT EXISTS idx_organizations_suspended_at
  ON organizations (suspended_at)
  WHERE suspended_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Trigram search index on organizations.name
--    Powers case-insensitive substring search on the reseller customer list.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_organizations_name_trgm
  ON organizations
  USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. impersonation_sessions
--    PRD §9.1 schema sketch + §9.2/§9.3 ended_reason + operational columns
--    (scope, ip, user_agent) from the msp-admin #2 task description.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id                TEXT PRIMARY KEY,
  reseller_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  customer_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  ticket_id         TEXT,
  scope             TEXT NOT NULL DEFAULT 'read_only',
  ip                TEXT,
  user_agent        TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  ended_reason      TEXT
);

-- reason length — PRD §9.1 requires min 10 chars.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'impersonation_sessions_reason_minlen_check'
       AND conrelid = 'impersonation_sessions'::regclass
  ) THEN
    ALTER TABLE impersonation_sessions
      ADD CONSTRAINT impersonation_sessions_reason_minlen_check
      CHECK (char_length(reason) >= 10);
  END IF;
END$$;

-- scope enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'impersonation_sessions_scope_check'
       AND conrelid = 'impersonation_sessions'::regclass
  ) THEN
    ALTER TABLE impersonation_sessions
      ADD CONSTRAINT impersonation_sessions_scope_check
      CHECK (scope IN ('read_only', 'mutate'));
  END IF;
END$$;

-- ended_reason enum (nullable; only checked when present). PRD §9.3.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'impersonation_sessions_ended_reason_check'
       AND conrelid = 'impersonation_sessions'::regclass
  ) THEN
    ALTER TABLE impersonation_sessions
      ADD CONSTRAINT impersonation_sessions_ended_reason_check
      CHECK (
        ended_reason IS NULL
        OR ended_reason IN (
          'user_ended',
          'expired',
          'logout',
          'superseded',
          'force_ended'
        )
      );
  END IF;
END$$;

-- Expiry must be after start.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'impersonation_sessions_expiry_after_start_check'
       AND conrelid = 'impersonation_sessions'::regclass
  ) THEN
    ALTER TABLE impersonation_sessions
      ADD CONSTRAINT impersonation_sessions_expiry_after_start_check
      CHECK (expires_at > started_at);
  END IF;
END$$;

-- Primary lookup index — "active sessions for this actor on this reseller".
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_reseller_actor_ended
  ON impersonation_sessions (reseller_org_id, actor_user_id, ended_at);

-- Secondary — customer drill-in view wants "recent sessions against this customer".
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_customer_started
  ON impersonation_sessions (customer_org_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 4. reseller_admin_audit
--    Per-reseller audit log (PRD §7.7 / §10.2). Distinct from the existing
--    single-org `admin_audit_log`. Uses JSONB payload to stay flexible while
--    keeping indexed columns small.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_admin_audit (
  id                TEXT PRIMARY KEY,
  reseller_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  customer_org_id   TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary index — "show the last N events for this reseller".
CREATE INDEX IF NOT EXISTS idx_reseller_admin_audit_reseller_created
  ON reseller_admin_audit (reseller_org_id, created_at DESC);

-- Secondary — filter audit feed by target customer on the drill-in page.
CREATE INDEX IF NOT EXISTS idx_reseller_admin_audit_customer_created
  ON reseller_admin_audit (customer_org_id, created_at DESC)
  WHERE customer_org_id IS NOT NULL;

-- Secondary — filter by action type on the reseller audit view.
CREATE INDEX IF NOT EXISTS idx_reseller_admin_audit_action
  ON reseller_admin_audit (reseller_org_id, action, created_at DESC);

COMMIT;

-- =============================================================================
-- End of 012_impersonation_and_audit.sql
-- =============================================================================
