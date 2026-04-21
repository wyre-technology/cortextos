-- =============================================================================
-- Migration:      003_reseller_members.sql
-- Date:           2026-04-18
-- PRD Reference:  prd-reseller-tenancy.md §5.2, §6.2
-- Ticket:         reseller-tenancy / Task #2
--
-- Purpose:
--   Introduce the `reseller_members` table, disjoint from `org_members`, that
--   records MSP-employee membership in a reseller organization. These are the
--   people operating the MSP itself (e.g., Acme IT Services staff) — NOT the
--   end-customer users who live in `org_members` of customer sub-orgs.
--
--   Roles are reseller-scoped only:
--     - reseller_owner
--     - reseller_admin
--     - reseller_billing_viewer
--     - reseller_support_agent
--
--   See the permission matrix in PRD §5.2 for semantics. Customer-side roles
--   (`owner`, `admin`, `member`) remain unchanged in `org_members`.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, guarded CHECK
--   addition via a DO-block, and DROP TRIGGER IF EXISTS / CREATE OR REPLACE
--   FUNCTION for the integrity trigger. Safe to re-run.
--
-- Rollback Notes:
--   Greenfield rollback: drop trigger, function, indexes, and table. Once
--   reseller rows exist, coordinate via the expand/backfill/contract playbook
--   in PRD §5.7. No down-migration file — project convention is forward-only
--   single-file migrations (see 001_customer_tenants.sql, 002_reseller_tenancy
--   _expand.sql).
--
-- Ordering / Concerns:
--   - FK to organizations(id) ON DELETE CASCADE: removing a reseller org
--     removes its member rows. Matches the PRD §6.2 sketch.
--   - FK to users(id) ON DELETE CASCADE: removing a user drops their reseller
--     memberships. Consistent with `org_members` behavior.
--   - A CHECK constraint cannot subquery, so the "reseller_org_id must point
--     at an org with type='reseller'" invariant is enforced by the
--     `enforce_reseller_member_parent_type` trigger below. Same pattern as
--     `enforce_org_hierarchy` in 002.
--   - `invited_by` / `joined_at` mirror the PRD §6.2 sketch so the member
--     service can distinguish invited-but-not-joined from accepted.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_members (
  id               TEXT PRIMARY KEY,
  reseller_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  invited_by       TEXT REFERENCES users(id),
  joined_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reseller_org_id, user_id)
);

-- Guarded role CHECK (Postgres lacks IF NOT EXISTS for ADD CONSTRAINT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'reseller_members_role_check'
       AND conrelid = 'reseller_members'::regclass
  ) THEN
    ALTER TABLE reseller_members
      ADD CONSTRAINT reseller_members_role_check
      CHECK (role IN (
        'reseller_owner',
        'reseller_admin',
        'reseller_billing_viewer',
        'reseller_support_agent'
      ));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reseller_members_org
  ON reseller_members (reseller_org_id);

CREATE INDEX IF NOT EXISTS idx_reseller_members_user
  ON reseller_members (user_id);

-- ---------------------------------------------------------------------------
-- 3. Integrity trigger — reseller_org_id must reference a reseller-typed org
--
-- A plain CHECK cannot subquery organizations.type, so we enforce via trigger
-- (same pattern as enforce_org_hierarchy in 002).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_reseller_member_parent_type()
RETURNS TRIGGER AS $$
DECLARE
  parent_type TEXT;
BEGIN
  SELECT type INTO parent_type
    FROM organizations
   WHERE id = NEW.reseller_org_id;

  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'reseller_org_id % does not exist', NEW.reseller_org_id;
  END IF;

  IF parent_type IS DISTINCT FROM 'reseller' THEN
    RAISE EXCEPTION
      'reseller_members.reseller_org_id must reference an org with type=reseller (got %)',
      parent_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_reseller_member_parent_type ON reseller_members;
CREATE TRIGGER trg_enforce_reseller_member_parent_type
  BEFORE INSERT OR UPDATE ON reseller_members
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reseller_member_parent_type();

COMMIT;

-- =============================================================================
-- End of 003_reseller_members.sql
-- =============================================================================
