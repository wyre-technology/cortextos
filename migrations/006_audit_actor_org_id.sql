-- =============================================================================
-- Migration:      006_audit_actor_org_id.sql
-- Date:           2026-04-18
-- PRD Reference:  prd-reseller-tenancy.md §5.5, §6.5
-- Ticket:         reseller-tenancy / Task #5
--
-- Purpose:
--   Extend existing audit surfaces so reseller-originated activity can be
--   attributed back to the reseller org the actor was operating from, without
--   denormalizing the reseller hierarchy into every row.
--
--   Adds `actor_org_id` to:
--     - `admin_audit_log` (defined in src/org/org-service.ts:277)
--     - `request_log`     (defined in src/org/org-service.ts:230)
--
--   Adds `impersonation_grant_id` on `admin_audit_log` so impersonation-driven
--   actions can be tied to the exact `reseller_support_grants` row they were
--   issued under (PRD §5.5 mentions support_grant_id as a documented metadata
--   key; we promote it to a real column for query efficiency in reseller
--   audit exports).
--
--   Semantics:
--     - actor_org_id IS NULL  => actor is a direct member of `org_id`.
--     - actor_org_id IS NOT NULL AND actor_org_id != org_id
--                             => actor was acting from their reseller home
--                                (actor_org_id) INTO the customer (org_id).
--     - impersonation_grant_id IS NOT NULL
--                             => action was performed under a specific
--                                support grant; correlates with source=
--                                'support_grant' in the existing metadata
--                                JSONB.
--
-- Idempotency:
--   ALTER TABLE ... ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   Safe to re-run.
--
-- Rollback Notes:
--   Greenfield: drop the indexes, then drop the columns. Once rows have been
--   written with actor_org_id set, rollback loses that provenance data.
--   Forward-only project convention — no down-migration file.
--
-- Ordering / Concerns:
--   - `admin_audit_log.actor_org_id` uses ON DELETE SET NULL: if a reseller
--     org is hard-deleted, we preserve the audit row but lose the pointer.
--     This is the right tradeoff for audit integrity (rows must outlive orgs).
--   - `request_log` historically has NO FK on `org_id` (see schema in
--     src/org/org-service.ts:230-239) — we match that parity: `actor_org_id`
--     is a plain TEXT column without a FK. Adding a FK here would be a
--     behavior change out of scope for this migration. PRD §6.5 explicitly
--     notes "request_log historically has no FK on org_id; keep parity."
--   - The FK on admin_audit_log is added as a guarded DO-block because
--     Postgres has no ADD CONSTRAINT IF NOT EXISTS for FKs.
--   - Composite index (actor_org_id, created_at) mirrors the existing
--     (org_id, created_at) hot path for reseller-scoped audit queries
--     (PRD §5.5 "reseller admins query admin_audit_log WHERE ...").
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. admin_audit_log.actor_org_id
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS actor_org_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'admin_audit_log_actor_org_id_fkey'
       AND conrelid = 'admin_audit_log'::regclass
  ) THEN
    ALTER TABLE admin_audit_log
      ADD CONSTRAINT admin_audit_log_actor_org_id_fkey
      FOREIGN KEY (actor_org_id)
      REFERENCES organizations(id)
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_org
  ON admin_audit_log (actor_org_id, created_at)
  WHERE actor_org_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. admin_audit_log.impersonation_grant_id
--
-- FK to reseller_support_grants(id). ON DELETE SET NULL preserves audit rows
-- if a grant is ever hard-deleted (the PRD prefers revoked_at over delete,
-- but the FK is defensive).
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS impersonation_grant_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'admin_audit_log_impersonation_grant_id_fkey'
       AND conrelid = 'admin_audit_log'::regclass
  ) THEN
    ALTER TABLE admin_audit_log
      ADD CONSTRAINT admin_audit_log_impersonation_grant_id_fkey
      FOREIGN KEY (impersonation_grant_id)
      REFERENCES reseller_support_grants(id)
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_admin_audit_impersonation_grant
  ON admin_audit_log (impersonation_grant_id)
  WHERE impersonation_grant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. request_log.actor_org_id
--
-- No FK — matches existing parity (request_log.org_id has no FK either).
-- ---------------------------------------------------------------------------
ALTER TABLE request_log
  ADD COLUMN IF NOT EXISTS actor_org_id TEXT;

CREATE INDEX IF NOT EXISTS idx_request_log_actor_org
  ON request_log (actor_org_id, created_at)
  WHERE actor_org_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- End of 006_audit_actor_org_id.sql
-- =============================================================================
