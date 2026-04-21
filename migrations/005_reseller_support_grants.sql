-- =============================================================================
-- Migration:      005_reseller_support_grants.sql
-- Date:           2026-04-18
-- PRD Reference:  prd-reseller-tenancy.md §5.4, §6.4
-- Ticket:         reseller-tenancy / Task #4
--
-- Purpose:
--   Introduce `reseller_support_grants`, the time-boxed ticket that lets a
--   specific MSP user temporarily act with admin-equivalent rights inside a
--   specific customer sub-org. This is the OPPOSITE of a persistent support
--   role: no standing access, every grant is audited, every grant expires.
--
--   See PRD §5.4 for the semantics:
--     - Expiry is enforced per-request in middleware, not by cron.
--     - Customer owner/admin can revoke at any time.
--     - `approval_required=TRUE` gates effective access on `approved_at` being
--       set (used when the customer org has
--       `support_grants_require_approval=TRUE`).
--     - `scope` JSONB declares what the grant covers (`{"vendors":"*"}` or a
--       list of vendor slugs). Shape is app-layer; DB stores opaque JSONB.
--
--   Authorization invariants that are DELIBERATELY NOT enforced in the DB
--   (app-layer only, per execution ticket):
--     - `granted_by_user_id` must be a reseller_member with owner/admin role.
--     - `granted_to_user_id` must be a reseller_member of the same reseller.
--   Enforcing these would require cross-table lookups at write time and
--   couple this migration to `reseller_members` in a way the PRD does not
--   require.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, guarded CHECK,
--   DROP TRIGGER IF EXISTS / CREATE OR REPLACE FUNCTION. Safe to re-run.
--
-- Rollback Notes:
--   Greenfield: drop trigger, function, indexes, table. Forward-only project
--   convention — no down-migration file.
--
-- Ordering / Concerns:
--   - Three FKs to `users(id)`: `granted_to_user_id` (subject of the grant,
--     CASCADE on user delete), `granted_by_user_id` and `revoked_by_user_id`
--     and `approved_by_user_id` (all actor records — RESTRICT on delete would
--     be nice but we match the PRD §6.4 sketch, which leaves them as plain
--     FKs; we mirror that so history survives user-hard-delete).
--   - `customer_org_id`'s parent_org_id must equal `reseller_org_id`. This
--     requires a subquery, so it lives in a BEFORE trigger, same pattern as
--     004_enforce_reseller_shared_vendor_grant.
--   - Partial index on `(granted_to_user_id, customer_org_id) WHERE
--     revoked_at IS NULL` is the hot path for the per-request "does this user
--     have an active grant for this org?" check.
--   - Additional indexes on `customer_org_id` and `reseller_org_id` support
--     list/aggregation queries from both directions.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_support_grants (
  id                    TEXT PRIMARY KEY,
  reseller_org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_to_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id    TEXT NOT NULL REFERENCES users(id),
  scope                 JSONB NOT NULL DEFAULT '{"vendors":"*"}'::jsonb,
  reason                TEXT NOT NULL,
  approval_required     BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by_user_id   TEXT REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoked_by_user_id    TEXT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Guarded CHECK: expires_at must be strictly after created_at. Defensive —
-- the app layer should also refuse zero- or negative-TTL requests.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'reseller_support_grants_expiry_check'
       AND conrelid = 'reseller_support_grants'::regclass
  ) THEN
    ALTER TABLE reseller_support_grants
      ADD CONSTRAINT reseller_support_grants_expiry_check
      CHECK (expires_at > created_at);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- Hot path: per-request active-grant lookup for (subject, customer).
CREATE INDEX IF NOT EXISTS idx_rsg_active_lookup
  ON reseller_support_grants (granted_to_user_id, customer_org_id)
  WHERE revoked_at IS NULL;

-- Expiry-ordered lookup for "active grants for this user" dashboards and for
-- the per-request expiry check when cached by user alone.
CREATE INDEX IF NOT EXISTS idx_rsg_user_expires
  ON reseller_support_grants (granted_to_user_id, expires_at);

-- Customer-side listings ("who can impersonate into my org right now?").
CREATE INDEX IF NOT EXISTS idx_rsg_customer
  ON reseller_support_grants (customer_org_id);

-- Reseller-side listings ("all grants I've issued").
CREATE INDEX IF NOT EXISTS idx_rsg_reseller
  ON reseller_support_grants (reseller_org_id);

-- ---------------------------------------------------------------------------
-- 3. Integrity trigger — customer must be a child of the reseller
--
-- Enforces:
--   * reseller_org_id references an org with type='reseller'
--   * customer_org_id references an org with type='customer'
--   * customer_org_id's parent_org_id = reseller_org_id
-- Same pattern as 004_enforce_reseller_shared_vendor_grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_reseller_support_grant_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
  r_type   TEXT;
  c_type   TEXT;
  c_parent TEXT;
BEGIN
  SELECT type INTO r_type
    FROM organizations
   WHERE id = NEW.reseller_org_id;
  IF r_type IS NULL THEN
    RAISE EXCEPTION 'reseller_org_id % does not exist', NEW.reseller_org_id;
  END IF;
  IF r_type IS DISTINCT FROM 'reseller' THEN
    RAISE EXCEPTION 'reseller_org_id must reference an org with type=reseller (got %)', r_type;
  END IF;

  SELECT type, parent_org_id INTO c_type, c_parent
    FROM organizations
   WHERE id = NEW.customer_org_id;
  IF c_type IS NULL THEN
    RAISE EXCEPTION 'customer_org_id % does not exist', NEW.customer_org_id;
  END IF;
  IF c_type IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'customer_org_id must reference an org with type=customer (got %)', c_type;
  END IF;
  IF c_parent IS DISTINCT FROM NEW.reseller_org_id THEN
    RAISE EXCEPTION
      'customer_org_id %''s parent_org_id (%) does not match reseller_org_id (%)',
      NEW.customer_org_id, c_parent, NEW.reseller_org_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_reseller_support_grant_hierarchy ON reseller_support_grants;
CREATE TRIGGER trg_enforce_reseller_support_grant_hierarchy
  BEFORE INSERT OR UPDATE ON reseller_support_grants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reseller_support_grant_hierarchy();

COMMIT;

-- =============================================================================
-- End of 005_reseller_support_grants.sql
-- =============================================================================
