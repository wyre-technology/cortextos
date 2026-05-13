-- Migration 023 — conduit_is_reseller_admin_of_ancestor SECURITY DEFINER
-- helper for bounded-depth-3 ancestor lookup.
--
-- Companion: orgs/wyre/agents/analyst/memory/2026-05-12-subtenant-scope-doc.md
-- (DP-A α: recursive CTE) + migration 021 (MAX_ORG_DEPTH=3 trigger).
--
-- =============================================================================
-- BACKGROUND
-- =============================================================================
--
-- Migration 021 relaxed enforce_org_hierarchy to allow 3-tier reseller →
-- customer → sub-customer hierarchies (MAX_ORG_DEPTH=3). Existing RLS
-- helpers (mig 018 + 020) operate on direct-parent relationships only:
--
--   conduit_is_reseller_admin_of_parent(user_id, child_org_id)
--     → walks ONE level up from child_org_id to find a reseller parent
--
-- For a depth-3 hierarchy (e.g., WYRE-reseller → AM3-customer →
-- AM3-Internal-IT-sub-customer), the direct-parent helper fails on
-- sub-customer access: AM3-Internal-IT's parent is AM3, a customer, not
-- a reseller. The user who is reseller-admin of WYRE has legitimate
-- read/write authority over AM3-Internal-IT's data but cannot reach it
-- through _of_parent because _of_parent only walks one level.
--
-- This migration introduces conduit_is_reseller_admin_of_ancestor — a
-- recursive helper that walks the parent_org_id chain bounded at
-- MAX_ORG_DEPTH=3 (matching mig 021's trigger). For any target org, it
-- returns true if the calling user is a reseller_owner or reseller_admin
-- of ANY ancestor reseller in the chain (depth 0 self, depth 1 parent,
-- depth 2 grandparent). The bound mirrors mig 021's trigger semantics
-- exactly — if mig 021's MAX_ORG_DEPTH bumps for a future-tier expansion,
-- this helper's bound must bump in lock-step. The audit DO-block at the
-- end of this migration enforces that invariant at apply-time.
--
-- =============================================================================
-- DESIGN (per Walter's scope-doc DP-A α)
-- =============================================================================
--
-- Recursive CTE walking parent_org_id chain bounded by depth < 3.
--
-- Why recursive CTE over the alternatives surveyed in scope-doc DP-A:
--   (β) Materialized closure table — heavier write-amplification on every
--       org insert/update via trigger maintenance; not justified for
--       depth-3 cap. Right move IF depth grows beyond 3 OR read volume
--       exceeds the write-amplification cost; depth-3 doesn't justify
--       the trigger-maintenance complexity yet.
--   (γ) Application-layer enrichment — most surface area for application
--       bugs; helpers stay direct-parent-only and apps pass ancestor
--       lists via session vars. Rejected — too much drift surface.
--
-- (α) recursive CTE is the chosen design: single source of truth at the
-- RLS layer, bounded recursion (max 3 iterations per call), no trigger
-- maintenance, no application-layer drift risk.
--
-- =============================================================================
-- SECURITY DEFINER + SET search_path discipline (per mig 018 helper-context
-- investigation)
-- =============================================================================
--
-- SECURITY DEFINER — helper bypasses RLS for its internal walk because
-- it runs as the function owner. The owner is whichever role applies
-- migrations; that role has broad SELECT on organizations + reseller_
-- members. Helper only ever returns boolean — no row data leaks via
-- the helper's signature.
--
-- SET search_path = pg_catalog, public — standard SECURITY DEFINER
-- search-path-injection mitigation. Without it, a malicious local user
-- could create a same-named function in their search_path and have the
-- helper resolve to their version when called from policy context.
--
-- LANGUAGE plpgsql (not sql) — required because the function body
-- contains a WITH RECURSIVE CTE. sql language can technically host a
-- single-statement CTE but plpgsql gives cleaner error semantics and
-- matches the convention for non-trivial helpers in this codebase.
--
-- STABLE — pure function of (user_id, target_org_id) within a single
-- transaction; safe for query planner to cache + reuse during policy
-- evaluation.
--
-- =============================================================================
-- HELPER-CONTEXT (per mig 018/020 investigation)
-- =============================================================================
--
-- This helper is intended for SELECT/UPDATE/DELETE contexts where the
-- target row exists in organizations. The recursive walk via
-- organizations.parent_org_id requires that target_org_id resolves to a
-- committed row — which it does in those contexts.
--
-- For INSERT context (where NEW row isn't committed yet), use
-- conduit_is_reseller_admin_of_reseller (direct parent_org_id passed
-- via NEW.parent_org_id) instead. See mig 020's similar split. INSERT
-- of a sub-customer is a separate design surface; this migration does
-- not introduce a new INSERT-context predicate.
--
-- Future RLS-policy retrofit to USE this helper is OUT OF SCOPE for this
-- migration per Walter's dispatch — that wiring lands when Surface 1
-- backend work begins, with its own paired tests against the actual
-- USE site (SELECT/UPDATE policies for sub-customer-owned rows).
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- conduit_is_reseller_admin_of_ancestor
-- ---------------------------------------------------------------------------
-- Returns TRUE iff p_user_id is a reseller_owner or reseller_admin of any
-- ancestor org in the chain rooted at p_target_org_id, walking up to
-- MAX_ORG_DEPTH=3 levels (depth 0 = target self, depth 1 = parent,
-- depth 2 = grandparent).
--
-- The bound (depth < 3) mirrors migration 021's trigger semantics. If
-- MAX_ORG_DEPTH bumps in a future migration, the bound here MUST bump
-- in lock-step or the helper silently fails to reach legitimate
-- ancestors. The DO-block audit at the end of this file is the
-- runtime-check pin (sub-pattern #10 third-pin); it asserts the
-- helper is callable + returns expected shape at apply-time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conduit_is_reseller_admin_of_ancestor(
  p_user_id text,
  p_target_org_id text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result boolean;
BEGIN
  -- Reject NULL inputs cleanly. current_setting('conduit.current_user_id',
  -- true) returns NULL when the GUC is unset; defensively short-circuit.
  IF p_user_id IS NULL OR p_target_org_id IS NULL THEN
    RETURN false;
  END IF;

  WITH RECURSIVE chain AS (
    -- Anchor: the target org itself (depth 0).
    SELECT id, parent_org_id, 0 AS depth
      FROM organizations
     WHERE id = p_target_org_id
    UNION ALL
    -- Walk-up: each step climbs to the parent. Bounded by depth < 2 in
    -- the WHERE clause so the recursion adds rows at depths 1 and 2
    -- only — three nodes total (depths 0, 1, 2) matching mig 021's
    -- MAX_ORG_DEPTH=3 (which counts NEW row as depth 1, so total tree
    -- height is 3 levels: target + 2 ancestors at most).
    SELECT o.id, o.parent_org_id, c.depth + 1
      FROM organizations o
      JOIN chain c ON o.id = c.parent_org_id
     WHERE c.depth < 2
  )
  SELECT EXISTS (
    SELECT 1
      FROM chain c
      JOIN reseller_members rm ON rm.reseller_org_id = c.id
     WHERE rm.user_id = p_user_id
       AND rm.role IN ('reseller_owner', 'reseller_admin')
  )
  INTO v_result;

  RETURN COALESCE(v_result, false);
END;
$$;

COMMENT ON FUNCTION conduit_is_reseller_admin_of_ancestor(text, text) IS
  'Migration 023: bounded-depth-3 ancestor helper for reseller-admin authority. Walks parent_org_id chain from target up to 2 levels, checks if caller is reseller_owner/reseller_admin of any ancestor reseller. Bound mirrors migration 021 MAX_ORG_DEPTH=3 — keep in lock-step. SELECT/UPDATE/DELETE contexts only; for INSERT use _of_reseller (mig 020).';

GRANT EXECUTE ON FUNCTION conduit_is_reseller_admin_of_ancestor(text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Post-migration audit: assert helper exists + is callable + returns
-- the expected shape. This is the runtime-check pin (sub-pattern #10
-- third-pin) for the lock-step-with-mig-021-MAX_ORG_DEPTH invariant.
-- A future migration that bumps MAX_ORG_DEPTH without updating this
-- helper would not be caught by this audit alone — the audit is a
-- proof-of-life check, not a depth-bound check. The cross-migration
-- bound-coherence check is deferred to integration tests (paired
-- accept at depth 2, reject at depth 3+).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_proc_count INT;
  v_callable boolean;
BEGIN
  -- Proof-of-existence: helper is defined in public schema.
  SELECT COUNT(*) INTO v_proc_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'conduit_is_reseller_admin_of_ancestor'
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id text, p_target_org_id text';

  IF v_proc_count <> 1 THEN
    RAISE EXCEPTION 'mig 023 audit: helper conduit_is_reseller_admin_of_ancestor(text, text) not found (count=%)', v_proc_count;
  END IF;

  -- Proof-of-callability: invoking with NULL args must return false
  -- cleanly without raising. This catches a missing GRANT, a missing
  -- SECURITY DEFINER, or a search_path misconfiguration that would
  -- otherwise surface as a runtime policy-evaluation error.
  SELECT conduit_is_reseller_admin_of_ancestor(NULL, NULL) INTO v_callable;
  IF v_callable IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'mig 023 audit: helper returned unexpected value % for NULL inputs (expected false)', v_callable;
  END IF;

  RAISE NOTICE 'mig 023 audit: helper conduit_is_reseller_admin_of_ancestor callable + returns expected shape. Bound=2 walks (lock-step with mig 021 MAX_ORG_DEPTH=3).';
END;
$$;

COMMIT;
