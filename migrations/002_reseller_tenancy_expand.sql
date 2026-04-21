-- =============================================================================
-- Migration:      002_reseller_tenancy_expand.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-reseller-tenancy.md §6.1 (Release A — expand phase)
-- Ticket:         reseller-tenancy / Task #1
--
-- Purpose:
--   Expand the existing `organizations` table (defined in src/org/org-service.ts
--   `initTables`) to support a two-level MSP->customer hierarchy. Adds:
--     - organizations.type                          (enum-like TEXT, default 'standalone')
--     - organizations.parent_org_id                 (nullable self-FK, ON DELETE RESTRICT)
--     - organizations.support_grants_require_approval (BOOLEAN, default FALSE)
--     - indexes on parent_org_id and type
--     - enforce_org_hierarchy() trigger function
--     - trg_enforce_org_hierarchy trigger (BEFORE INSERT OR UPDATE)
--
-- Idempotency:
--   All statements use IF NOT EXISTS / OR REPLACE / DROP IF EXISTS. Safe to
--   re-run. The CHECK constraint is added via a guarded DO-block because
--   Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for CHECKs.
--
-- Backfill:
--   Existing rows get type='standalone', parent_org_id=NULL. The defaults
--   handle this but we also issue an explicit UPDATE for clarity and to cover
--   any rows pre-existing the default (shouldn't exist, but defensive).
--
-- Rollback Notes:
--   A greenfield rollback is trivial — drop the trigger, function, indexes,
--   constraint, and columns in reverse order. Once reseller data exists
--   (type='reseller' or type='customer' rows, non-null parent_org_id),
--   rollback is destructive and MUST be coordinated. See §6 ("expand/backfill
--   /contract") and §8.5 in the PRD. No down-migration file is provided because
--   the project convention is single-file forward-only (see 001_customer_tenants.sql).
--
-- Ordering / Concerns:
--   - The self-referential FK on parent_org_id uses ON DELETE RESTRICT per §5.1
--     and §6.1. RESTRICT (not CASCADE) is deliberate — deleting a reseller with
--     live customers should fail loudly.
--   - No circular FK risk: self-ref is acyclic because depth is capped at 2 by
--     the trigger (a reseller cannot have a parent).
--   - No deadlock risk on apply: all operations are on a single table and are
--     metadata-only except the backfill UPDATE, which touches existing rows.
--     Expected row count on production at migration time is small (<10k).
--   - The trigger reads `organizations` inside the BEFORE trigger on the same
--     table. This is fine for row-level BEFORE triggers in Postgres; the
--     SELECT sees the pre-update snapshot of the parent row.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations.type
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'standalone';

-- Guarded CHECK constraint (Postgres lacks IF NOT EXISTS for ADD CONSTRAINT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'organizations_type_check'
       AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_type_check
      CHECK (type IN ('reseller', 'customer', 'standalone'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2. organizations.parent_org_id (self-FK, RESTRICT on delete)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS parent_org_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'organizations_parent_org_id_fkey'
       AND conrelid = 'organizations'::regclass
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_parent_org_id_fkey
      FOREIGN KEY (parent_org_id)
      REFERENCES organizations(id)
      ON DELETE RESTRICT;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. organizations.support_grants_require_approval
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS support_grants_require_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_organizations_parent
  ON organizations (parent_org_id)
  WHERE parent_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_type
  ON organizations (type);

-- ---------------------------------------------------------------------------
-- 5. Explicit backfill (defensive — defaults already cover new rows)
-- ---------------------------------------------------------------------------
UPDATE organizations
   SET type = 'standalone'
 WHERE type IS NULL;

UPDATE organizations
   SET parent_org_id = NULL
 WHERE parent_org_id IS NOT NULL
   AND type = 'standalone';  -- no-op guard; exists only to document intent

-- ---------------------------------------------------------------------------
-- 6. Hierarchy-enforcement trigger
--
-- Invariants (PRD §5.1):
--   * type='customer'   => parent_org_id IS NOT NULL AND parent.type='reseller'
--   * type='reseller'   => parent_org_id IS NULL
--   * type='standalone' => parent_org_id IS NULL
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_org_hierarchy()
RETURNS TRIGGER AS $$
DECLARE
  parent_type TEXT;
BEGIN
  IF NEW.type = 'customer' THEN
    IF NEW.parent_org_id IS NULL THEN
      RAISE EXCEPTION 'customer orgs must have parent_org_id (org=%)', NEW.id;
    END IF;
    SELECT type INTO parent_type
      FROM organizations
     WHERE id = NEW.parent_org_id;
    IF parent_type IS NULL THEN
      RAISE EXCEPTION 'parent_org_id % does not exist', NEW.parent_org_id;
    END IF;
    IF parent_type IS DISTINCT FROM 'reseller' THEN
      RAISE EXCEPTION 'customer parent must be a reseller (got %)', parent_type;
    END IF;
  ELSIF NEW.type IN ('reseller', 'standalone') THEN
    IF NEW.parent_org_id IS NOT NULL THEN
      RAISE EXCEPTION '% orgs cannot have a parent_org_id', NEW.type;
    END IF;
  ELSE
    -- Should be unreachable thanks to organizations_type_check, but defend
    -- against future enum additions bypassing the trigger.
    RAISE EXCEPTION 'unknown organizations.type value: %', NEW.type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_org_hierarchy ON organizations;
CREATE TRIGGER trg_enforce_org_hierarchy
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_org_hierarchy();

COMMIT;

-- =============================================================================
-- End of 002_reseller_tenancy_expand.sql
-- =============================================================================
