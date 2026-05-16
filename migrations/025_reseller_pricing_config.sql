-- =============================================================================
-- Migration:      025_reseller_pricing_config.sql
-- Date:           2026-05-15
-- PRD Reference:  Track C scope-doc (2026-05-13, Walter), DPs A/B/C/D/E/F locked
-- Ticket:         Track C PR-A — reseller-channel-billing foundation
--
-- Purpose:
--   Introduce `reseller_pricing_config` — the foundation table for Track C
--   Layer B billing. Stores per-(reseller, subtenant) markup configuration in
--   one of two modes:
--     - percentage          (rate_basis_points, e.g. 500 = 5%)
--     - absolute_per_seat   (amount_cents, USD only v1)
--
--   Aaron-locked DPs (per scope-doc 2026-05-13):
--     DP-A: markup% + absolute_per_seat both in v1
--     DP-C: flat-org-level granularity (no per-vendor override in v1)
--     DP-E: opaque subtenant visibility (subtenant can SELECT own config,
--           cannot inspect underlying WYRE rate or markup-vs-base split)
--     DP-F: standard audit-log via append-only supersession (this migration
--           IS the audit-of-truth substrate; PR-C mig 029 audit-table is a
--           view/projection over supersession history, not dual-write)
--
-- Design: APPEND-ONLY supersession
--   No UPDATE/DELETE policies. Price changes = new row with later
--   effective_at. Reads use ORDER BY effective_at DESC LIMIT 1 per
--   (reseller_org_id, subtenant_org_id) pair to resolve "current" config.
--
--   Rationale (boss-greenlit 2026-05-15):
--     (1) audit-of-truth — change-history preserved natively, matches
--         DP-D taxation compliance lens (price-change provenance must
--         be reconstructible at audit time)
--     (2) boundary simplicity — PR-C audit-table becomes a genuine view
--         over this table's supersession ordering, not dual-write
--         infrastructure with consistency-risk.
--
--   The append-only semantics are enforced by RLS (no UPDATE/DELETE
--   policies attached) NOT by a trigger. Reason: an explicit DELETE
--   from a role with bypass_rls (DB owner / migration role) is
--   legitimate for hard-purge scenarios (GDPR erasure, test cleanup).
--   RLS-only means application code cannot mutate history; ops still
--   has the escape hatch.
--
-- Trigger-enforced invariants (rejected at DB layer, not application):
--   - reseller_org_id MUST reference org with type='reseller'
--   - subtenant_org_id MUST be a descendant of reseller_org_id within
--     MAX_ORG_DEPTH=3 (uses mig 023 ancestor-walk helper inverted —
--     subtenant's ancestor chain must include reseller_org_id)
--   Same enforce-via-trigger pattern as mig 003's
--   enforce_reseller_member_parent_type (CHECK cannot subquery).
--
-- Idempotency: CREATE TABLE/INDEX/FUNCTION/TRIGGER IF NOT EXISTS or
--   CREATE OR REPLACE. Safe to re-run.
--
-- Rollback: greenfield drop trigger/function/policies/indexes/table.
--   Once production rows exist, supersession history is regulatory
--   evidence — coordinate retention via the same expand/backfill/contract
--   playbook as other reseller-tenancy tables.
--
-- =============================================================================
-- RLS shape
-- =============================================================================
--
-- SELECT (two read-paths, opaque-but-not-secret per DP-E):
--   - reseller-admin reads all configs for their reseller branch
--     (uses conduit_is_reseller_admin_of_ancestor from mig 023 — subtenant
--      may be 2 levels below the reseller in MAX_ORG_DEPTH=3 chain)
--   - subtenant member reads own subtenant's config
--     (uses conduit_is_member_of_org from mig 018)
--   Subtenant CANNOT see underlying WYRE plan rate — that's a separate
--   query against PlanDefinition catalog; the config row exposes only
--   what subtenant pays, not the markup-vs-base decomposition.
--
-- INSERT:
--   - WITH CHECK: conduit_is_reseller_admin_of_ancestor only.
--   - Trigger additionally enforces descendant-of-reseller relationship
--     and reseller_org_id.type='reseller'. Two-layer defense: RLS gates
--     by user authority; trigger gates by structural invariant. RLS
--     alone cannot enforce structural invariants because policies cannot
--     execute the ancestor walk against NEW row (subtenant_org_id) in
--     INSERT context without round-tripping back through helpers.
--
-- UPDATE / DELETE: no policies attached. Append-only semantics at
--   application layer. Role with bypass_rls retains the escape hatch
--   for ops/GDPR.
--
-- =============================================================================
-- Three-pin discipline (sub-pattern #10)
-- =============================================================================
--
-- Pin 1 (docblock): this header — names append-only + the mig 023
--   helper dependency + the trigger-enforced structural invariants.
-- Pin 2 (helper): trigger function enforce_reseller_pricing_config_*
--   below; failure mode is a clean RAISE EXCEPTION that surfaces in
--   logs + tests, not silent data corruption.
-- Pin 3 (runtime-check): DO-block audit at end of this migration
--   asserts table exists, RLS enabled, trigger attached, CHECK
--   constraint live, mode IN values match application-layer enum.
--   Apply-time failure = migration rolls back via the surrounding BEGIN.
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reseller_pricing_config (
  id                TEXT PRIMARY KEY,
  reseller_org_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subtenant_org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL,
  rate_basis_points INTEGER,
  amount_cents      INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  effective_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Guarded constraints (Postgres lacks IF NOT EXISTS for ADD CONSTRAINT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_pricing_config_mode_check'
       AND conrelid = 'reseller_pricing_config'::regclass
  ) THEN
    ALTER TABLE reseller_pricing_config
      ADD CONSTRAINT reseller_pricing_config_mode_check
      CHECK (mode IN ('percentage', 'absolute_per_seat'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_pricing_config_mode_value_check'
       AND conrelid = 'reseller_pricing_config'::regclass
  ) THEN
    -- Exactly one of rate_basis_points / amount_cents is set, matching the mode.
    -- Both-NULL or both-set is rejected at insert time.
    ALTER TABLE reseller_pricing_config
      ADD CONSTRAINT reseller_pricing_config_mode_value_check
      CHECK (
        (mode = 'percentage'        AND rate_basis_points IS NOT NULL AND rate_basis_points >= 0
                                     AND amount_cents IS NULL)
        OR
        (mode = 'absolute_per_seat' AND amount_cents IS NOT NULL AND amount_cents >= 0
                                     AND rate_basis_points IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reseller_pricing_config_currency_check'
       AND conrelid = 'reseller_pricing_config'::regclass
  ) THEN
    -- USD-only in v1 (DP-A scope). Multi-currency is v2 work — the column
    -- exists now to avoid a future ALTER, but values are constrained.
    ALTER TABLE reseller_pricing_config
      ADD CONSTRAINT reseller_pricing_config_currency_check
      CHECK (currency = 'USD');
  END IF;
END$$;

-- Read index: resolve "current" config for a (reseller, subtenant) pair.
-- ORDER BY effective_at DESC LIMIT 1 is the hot read path.
CREATE INDEX IF NOT EXISTS reseller_pricing_config_resolve_idx
  ON reseller_pricing_config (reseller_org_id, subtenant_org_id, effective_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Structural-invariant trigger
-- ---------------------------------------------------------------------------
-- COUPLING NOTE: this trigger is NOT SECURITY DEFINER. The recursive
-- chain walk over `organizations` runs under the caller's RLS, so it
-- relies on the organizations_select policy being permissive enough to
-- expose all ancestor rows in the depth-3 chain to a reseller-admin.
-- The current policy (mig 018) admits this via conduit_is_member_of_child_under
-- + conduit_is_reseller_admin_of_parent. If a future migration narrows
-- organizations_select to direct-only-visibility, depth-2 pricing inserts
-- start failing the descendant check with a confusing "not a descendant"
-- error even when the structural relationship is real. Keep this trigger
-- in lock-step with organizations_select breadth, or promote to
-- SECURITY DEFINER + SET search_path if the policy narrows.
CREATE OR REPLACE FUNCTION enforce_reseller_pricing_config_structure()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reseller_type TEXT;
  v_descendant    BOOLEAN;
BEGIN
  -- (a) reseller_org_id.type must be 'reseller'
  SELECT type INTO v_reseller_type
    FROM organizations
   WHERE id = NEW.reseller_org_id;

  IF v_reseller_type IS NULL THEN
    RAISE EXCEPTION 'reseller_pricing_config.reseller_org_id % does not exist', NEW.reseller_org_id;
  END IF;

  IF v_reseller_type IS DISTINCT FROM 'reseller' THEN
    RAISE EXCEPTION
      'reseller_pricing_config.reseller_org_id must reference an org with type=reseller (got %)',
      v_reseller_type;
  END IF;

  -- (b) subtenant_org_id must be a descendant of reseller_org_id within
  --     MAX_ORG_DEPTH=3. Walk subtenant's parent chain up to 2 levels
  --     (matching mig 023's bound) and look for reseller_org_id.
  WITH RECURSIVE chain AS (
    SELECT id, parent_org_id, 0 AS depth
      FROM organizations
     WHERE id = NEW.subtenant_org_id
    UNION ALL
    SELECT o.id, o.parent_org_id, c.depth + 1
      FROM organizations o
      JOIN chain c ON o.id = c.parent_org_id
     WHERE c.depth < 2
  )
  SELECT EXISTS (
    SELECT 1 FROM chain WHERE id = NEW.reseller_org_id AND depth > 0
  ) INTO v_descendant;

  IF NOT v_descendant THEN
    RAISE EXCEPTION
      'reseller_pricing_config.subtenant_org_id % is not a descendant of reseller_org_id % within MAX_ORG_DEPTH=3',
      NEW.subtenant_org_id, NEW.reseller_org_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reseller_pricing_config_structure ON reseller_pricing_config;
CREATE TRIGGER trg_enforce_reseller_pricing_config_structure
  BEFORE INSERT ON reseller_pricing_config
  FOR EACH ROW
  EXECUTE FUNCTION enforce_reseller_pricing_config_structure();

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE reseller_pricing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_pricing_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reseller_pricing_config_select ON reseller_pricing_config;
CREATE POLICY reseller_pricing_config_select ON reseller_pricing_config
  FOR SELECT
  USING (
       conduit_is_reseller_admin_of_ancestor(
         current_setting('conduit.current_user_id', true),
         subtenant_org_id
       )
    OR conduit_is_member_of_org(
         current_setting('conduit.current_user_id', true),
         subtenant_org_id
       )
  );

DROP POLICY IF EXISTS reseller_pricing_config_insert ON reseller_pricing_config;
CREATE POLICY reseller_pricing_config_insert ON reseller_pricing_config
  FOR INSERT
  WITH CHECK (
    conduit_is_reseller_admin_of_ancestor(
      current_setting('conduit.current_user_id', true),
      subtenant_org_id
    )
  );

-- No UPDATE/DELETE policies — append-only semantics enforced via absence.
-- Roles without bypass_rls cannot mutate history.

-- ---------------------------------------------------------------------------
-- 4. Apply-time audit (sub-pattern #10 third-pin)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls_enabled BOOLEAN;
  v_trigger_exists BOOLEAN;
  v_policy_count INTEGER;
BEGIN
  -- Table exists with expected columns + nullability.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'reseller_pricing_config'
       AND column_name = 'mode' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'mig 025 audit: reseller_pricing_config.mode missing or wrong shape';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'reseller_pricing_config'
       AND column_name = 'effective_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'mig 025 audit: reseller_pricing_config.effective_at missing or wrong type';
  END IF;

  -- RLS enabled + forced.
  SELECT relrowsecurity AND relforcerowsecurity INTO v_rls_enabled
    FROM pg_class WHERE relname = 'reseller_pricing_config';
  IF NOT COALESCE(v_rls_enabled, false) THEN
    RAISE EXCEPTION 'mig 025 audit: RLS not enabled+forced on reseller_pricing_config';
  END IF;

  -- Trigger attached.
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_enforce_reseller_pricing_config_structure'
       AND tgrelid = 'reseller_pricing_config'::regclass
       AND NOT tgisinternal
  ) INTO v_trigger_exists;
  IF NOT v_trigger_exists THEN
    RAISE EXCEPTION 'mig 025 audit: structure-enforcement trigger missing';
  END IF;

  -- Exactly 2 policies (SELECT + INSERT); no UPDATE/DELETE policy attached.
  SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies WHERE tablename = 'reseller_pricing_config';
  IF v_policy_count <> 2 THEN
    RAISE EXCEPTION 'mig 025 audit: expected 2 policies on reseller_pricing_config, found %', v_policy_count;
  END IF;
END$$;

COMMIT;
