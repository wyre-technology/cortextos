-- =============================================================================
-- Migration:      004_reseller_shared_vendor_grants.sql
-- Date:           2026-04-18
-- PRD Reference:  prd-reseller-tenancy.md §5.3, §6.3
-- Ticket:         reseller-tenancy / Task #3
--
-- Purpose:
--   Introduce `reseller_shared_vendor_grants`, the opt-in gate that permits a
--   customer sub-org to fall through to its parent reseller's `org_credentials`
--   row for a given vendor during credential resolution (see PRD §5.3 step 5).
--
--   The reseller stores its shared credential in `org_credentials` keyed by
--   (reseller_org_id, vendor_slug) using the same crypto path as any other
--   org-level credential (`credential-service.ts:160-166`). This table is
--   strictly the PER-CUSTOMER OPT-IN; without a matching row the reseller
--   fallback does not fire. That opt-in granularity is load-bearing per the
--   PRD: opt-in-per-customer-per-vendor prevents the "accidental shared
--   ConnectWise key" foot-gun (§5.3).
--
-- Schema decisions vs. the taskmaster task #3 description:
--   - The task ticket described a `credential_set_id` FK column. The PRD §6.3
--     sketch does not carry one — the resolver uses (reseller_org_id,
--     vendor_slug) to look up `org_credentials` directly. Per the execution
--     instructions ("trust actual DB schema + PRD over task description when
--     they conflict"), this migration matches the PRD shape.
--   - Likewise the PRD uniqueness key is (reseller_org_id, customer_org_id,
--     vendor_slug), not (reseller_org_id, vendor_slug) — the grant is scoped
--     per customer, so the broader key is correct.
--
-- Idempotency:
--   CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, guarded trigger.
--   Safe to re-run.
--
-- Rollback Notes:
--   Greenfield: drop trigger, function, indexes, table. No down-migration
--   file — forward-only project convention.
--
-- Ordering / Concerns:
--   - Two ON DELETE CASCADE FKs to `organizations(id)`. Deleting either the
--     reseller or the customer org cleans up the grant row automatically.
--   - The "customer_org_id must be a child of reseller_org_id, and reseller
--     must be type=reseller, and customer must be type=customer" invariant is
--     enforced by trigger (CHECK cannot subquery). This is the same pattern
--     used in 002_enforce_org_hierarchy and 003_enforce_reseller_member_parent
--     _type.
--   - No FK to `org_credentials` is modeled: the resolver looks up the
--     reseller's credential lazily at read time (PRD §5.3 step 5), and a
--     grant may exist ahead of the credential being stored.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_shared_vendor_grants (
  id               TEXT PRIMARY KEY,
  reseller_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_slug      TEXT NOT NULL,
  granted_by       TEXT NOT NULL REFERENCES users(id),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reseller_org_id, customer_org_id, vendor_slug)
);

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- Primary hot path: the credential injector resolves by (customer_org_id,
-- vendor_slug) when stepping through the resolution order.
CREATE INDEX IF NOT EXISTS idx_rsvg_customer_vendor
  ON reseller_shared_vendor_grants (customer_org_id, vendor_slug);

-- Secondary: reseller-side listings ("which customers have I shared X with?").
CREATE INDEX IF NOT EXISTS idx_rsvg_reseller
  ON reseller_shared_vendor_grants (reseller_org_id);

-- ---------------------------------------------------------------------------
-- 3. Integrity trigger — reseller/customer type + parent linkage
--
-- Enforces:
--   * reseller_org_id references an org with type='reseller'
--   * customer_org_id references an org with type='customer'
--   * customer_org_id's parent_org_id = reseller_org_id
-- A plain CHECK cannot subquery, so this is done per-row in a BEFORE trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_reseller_shared_vendor_grant()
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

DROP TRIGGER IF EXISTS trg_enforce_reseller_shared_vendor_grant ON reseller_shared_vendor_grants;
CREATE TRIGGER trg_enforce_reseller_shared_vendor_grant
  BEFORE INSERT OR UPDATE ON reseller_shared_vendor_grants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reseller_shared_vendor_grant();

COMMIT;

-- =============================================================================
-- End of 004_reseller_shared_vendor_grants.sql
-- =============================================================================
