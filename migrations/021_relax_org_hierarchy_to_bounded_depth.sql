-- Migration 021 — relax enforce_org_hierarchy from hardcoded-depth-2 to
-- bounded-depth-N, with MAX_ORG_DEPTH=3 for MVP.
--
-- Companion: orgs/wyre/agents/analyst/memory/2026-05-11-subtenant-research-notes.md
-- (Walter's research substrate). Surface 4 in the Figma frames shows the
-- 3-tier MVP target: WYRE (reseller) → AM3 (customer) → AM3-Internal-IT
-- (customer-under-customer). The existing trigger from migration 002
-- rejects that nesting because it required `customer.parent.type = 'reseller'`
-- strictly — no customer-as-parent allowed.
--
-- DESIGN:
--
-- The trigger walks the parent_org_id chain from NEW up to root on every
-- INSERT or UPDATE and validates four invariants:
--   1. Type-based parent-presence: standalone/reseller forbid parent_org_id;
--      customer requires parent_org_id (unchanged from mig 002).
--   2. Total chain depth ≤ MAX_ORG_DEPTH. NEW row counts as depth 1; each
--      walk-up increments. MAX_ORG_DEPTH=3 today (reseller → customer →
--      customer-under-customer); bump for future tiers.
--   3. Chain composition: the ROOT of the chain must be a 'reseller';
--      every intermediate rung must be a 'customer'. This preserves the
--      "customer hierarchies are rooted at a reseller" invariant while
--      relaxing the previous "parent must be exactly a reseller" rule to
--      allow nested customers.
--   4. Cycle prevention: if cur_id ever equals NEW.id during the walk, we
--      have a cycle; reject. Mig 002 prevented cycles trivially by capping
--      depth at 2; the new bounded-depth shape needs an explicit check.
--
-- COST-SHAPE (per Walter's research):
--   - Trigger-only change. No schema change.
--   - No RLS-helper rewrite (existing helpers `_of_parent`, `_of_reseller`,
--     `_of_child_under`, `_member_of_team`, `_has_active_support_grant_for`
--     all use SECURITY DEFINER + parameter-passed-id shapes that already
--     work for any parent → child relationship regardless of depth.
--   - No data-rewrite. Existing depth-2 chains (reseller → customer) remain
--     valid post-mig because 2 ≤ MAX_ORG_DEPTH=3.
--
-- ROLLBACK:
--   To revert: re-run mig 002's original CREATE OR REPLACE FUNCTION block.
--   Forward-only migration convention (per 001_customer_tenants.sql) means
--   no down-file is provided. If a depth-3 chain exists at rollback time,
--   the old trigger will fail any INSERT/UPDATE on those depth-3 rows
--   (which currently exist with parent_type=customer, which the old trigger
--   rejects). Rollback is destructive once depth-3 data exists.

BEGIN;

-- Drop the trigger before replacing its function — defensive, ensures the
-- new function is wired correctly when the trigger is recreated.
DROP TRIGGER IF EXISTS trg_enforce_org_hierarchy ON organizations;

CREATE OR REPLACE FUNCTION enforce_org_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
  parent_type TEXT;
  parent_parent_id TEXT;
  cur_id TEXT;
  depth INT := 1;  -- NEW row is depth 1 from itself
  -- MAX_ORG_DEPTH is a constant within the trigger body for MVP. Future
  -- iterations can promote it to a settings-table lookup or PG GUC.
  MAX_ORG_DEPTH CONSTANT INT := 3;
BEGIN
  -- ---------------------------------------------------------------------
  -- Standalone + reseller: no parent allowed (preserves mig 002 rule).
  -- ---------------------------------------------------------------------
  IF NEW.type IN ('reseller', 'standalone') THEN
    IF NEW.parent_org_id IS NOT NULL THEN
      RAISE EXCEPTION '% orgs cannot have a parent_org_id', NEW.type;
    END IF;
    RETURN NEW;
  END IF;

  -- ---------------------------------------------------------------------
  -- Customer: must have parent_org_id, parent chain must root at a
  -- reseller, intermediate rungs must be customers, total depth must
  -- be ≤ MAX_ORG_DEPTH.
  -- ---------------------------------------------------------------------
  IF NEW.type = 'customer' THEN
    IF NEW.parent_org_id IS NULL THEN
      RAISE EXCEPTION 'customer orgs must have parent_org_id (org=%)', NEW.id;
    END IF;

    cur_id := NEW.parent_org_id;

    -- Walk-up the parent chain. Bounded by MAX_ORG_DEPTH so even a
    -- pathological cycle exits with a clear error.
    LOOP
      -- Cycle detection: if we ever reach NEW.id walking up, this is a
      -- cycle. Mig 002's trivial depth-cap-of-2 made cycles impossible;
      -- bounded-depth-N must check explicitly.
      IF cur_id = NEW.id THEN
        RAISE EXCEPTION 'cyclic parent_org_id chain detected (org=%)', NEW.id;
      END IF;

      depth := depth + 1;

      IF depth > MAX_ORG_DEPTH THEN
        RAISE EXCEPTION 'org hierarchy depth exceeds MAX_ORG_DEPTH=% (org=%)',
          MAX_ORG_DEPTH, NEW.id;
      END IF;

      SELECT type, parent_org_id
        INTO parent_type, parent_parent_id
        FROM organizations
       WHERE id = cur_id;

      IF parent_type IS NULL THEN
        RAISE EXCEPTION 'parent_org_id % does not exist', cur_id;
      END IF;

      -- At this point cur_id is either an intermediate rung or the root.
      IF parent_parent_id IS NULL THEN
        -- Reached root of the chain. Root must be a reseller.
        IF parent_type <> 'reseller' THEN
          RAISE EXCEPTION
            'customer hierarchy must root at a reseller (root org % has type %)',
            cur_id, parent_type;
        END IF;
        EXIT;
      ELSE
        -- Intermediate rung. Must be type customer (the only valid
        -- non-root rung in a customer hierarchy chain).
        IF parent_type <> 'customer' THEN
          RAISE EXCEPTION
            'intermediate parent must be type customer (got % at org %)',
            parent_type, cur_id;
        END IF;
      END IF;

      cur_id := parent_parent_id;
    END LOOP;

    RETURN NEW;
  END IF;

  -- Defensive: should be unreachable because of organizations_type_check.
  RAISE EXCEPTION 'unknown organizations.type value: %', NEW.type;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger with the same INSERT-OR-UPDATE binding. Note that
-- UPDATE checks apply: a repoint of parent_org_id triggers a fresh walk
-- of the new chain. Cannot UPDATE a row into a deeper-than-MAX chain.
CREATE TRIGGER trg_enforce_org_hierarchy
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_org_hierarchy();

COMMIT;
