-- =============================================================================
-- Migration:      026_reseller_pricing_config_dp_e_and_created_by_strip.sql
-- Date:           2026-05-15
-- PRD Reference:  Track C scope-doc DP-E disambiguation (Aaron 2026-05-15)
--                 + created_by visibility lock (Aaron 2026-05-15)
-- Ticket:         Track C PR-A follow-up — current-only + column-strip
--
-- Purpose:
--   Aaron's DP-E disambiguation: subtenant sees CURRENT pricing only, not
--   history. Aaron's created_by visibility lock: subtenant cannot see WHO
--   set the price (the reseller-admin identity is reseller-internal).
--
--   Two mechanisms, each does ONE thing (separation of row-gating from
--   column-projection):
--     (i)  Base table SELECT policy gets a NOT-EXISTS filter on the
--          subtenant branch — only the latest-effective row per
--          (reseller_org_id, subtenant_org_id) pair survives the policy.
--          Reseller-admin branch unchanged (full history visible).
--     (ii) New view reseller_pricing_config_view with
--          security_invoker=true projects created_by conditionally via
--          CASE: reseller-admins see the real value, everyone else sees
--          NULL.
--
-- Why two mechanisms not one:
--   Postgres RLS filters rows, not columns. Column-level GRANT cannot
--   differentiate per-user_id because all app callers share one DB role
--   (auth via session GUC, not per-user DB role). View-with-CASE is the
--   only available column-visibility mechanism in this architecture.
--   Coupling row-gating and column-projection in one mechanism would
--   conflate two different change-vectors (DP-E might evolve
--   independently from column-visibility rules).
--
-- security_invoker=true on the view: caller's RLS still applies. The view
-- is purely a column-projection layer; row-access is still gated by the
-- updated base-table SELECT policy. Subtenant reads through the view
-- inherit the NOT-EXISTS filter from the base policy and see only the
-- latest-effective row, with created_by nullified.
--
-- ServiceLayer composition (post-migration, separate src change):
--   getCurrentPricing should read from reseller_pricing_config_view, not
--   the base table. That gets row-gating + column-strip for free in a
--   single SELECT. setPricing continues to INSERT into the base table.
--
-- Idempotency: DROP POLICY IF EXISTS + CREATE POLICY; CREATE OR REPLACE
--   VIEW.
--
-- Rollback: drop view, drop replacement policy, recreate original
--   policy. Original policy text preserved in the rollback note below
--   for greenfield restoration if needed:
--
--     CREATE POLICY reseller_pricing_config_select ON reseller_pricing_config
--       FOR SELECT
--       USING (
--            conduit_is_reseller_admin_of_ancestor(...subtenant_org_id...)
--         OR conduit_is_member_of_org(...subtenant_org_id...)
--       );
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- (i.helper) conduit_is_latest_pricing_row — SECURITY DEFINER helper
-- ---------------------------------------------------------------------------
-- Required because a direct NOT EXISTS subquery against
-- reseller_pricing_config inside the SELECT policy triggers infinite
-- recursion (RLS re-applies on every reference; pg 42P17 in
-- rewriteHandler). SECURITY DEFINER + SET search_path bypasses RLS for
-- the recursion check while keeping the row-gating decision pure.
-- Helper returns true iff (id) is the latest-effective row for its
-- (reseller_org_id, subtenant_org_id) pair.
-- Existence gate + supersession check. Two predicates ANDed so the
-- helper's contract is "TRUE iff p_id names a row AND that row is the
-- latest-effective for its pair." Without the EXISTS prefix, a
-- non-existent p_id would self-JOIN to zero rows and the supersession
-- NOT EXISTS would be vacuously TRUE — footgun for non-policy callers
-- (audit checks, debug queries) since GRANT EXECUTE is TO PUBLIC.
CREATE OR REPLACE FUNCTION conduit_is_latest_pricing_row(p_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM reseller_pricing_config WHERE id = p_id
  )
  AND NOT EXISTS (
    SELECT 1
      FROM reseller_pricing_config AS newer
      JOIN reseller_pricing_config AS self ON self.id = p_id
     WHERE newer.reseller_org_id  = self.reseller_org_id
       AND newer.subtenant_org_id = self.subtenant_org_id
       AND newer.effective_at     > self.effective_at
  )
$$;

GRANT EXECUTE ON FUNCTION conduit_is_latest_pricing_row(text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- (i) SELECT policy — current-only filter on subtenant branch
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_pricing_config_select ON reseller_pricing_config;
CREATE POLICY reseller_pricing_config_select ON reseller_pricing_config
  FOR SELECT
  USING (
       -- Reseller-admin: full history visible (unchanged from mig 025).
       conduit_is_reseller_admin_of_ancestor(
         current_setting('conduit.current_user_id', true),
         subtenant_org_id
       )
    OR (
       -- Subtenant member: only the latest-effective row survives.
       -- Helper uses SECURITY DEFINER to bypass RLS recursion;
       -- reseller_pricing_config_resolve_idx (reseller, subtenant,
       -- effective_at DESC) serves the lookup.
       conduit_is_member_of_org(
         current_setting('conduit.current_user_id', true),
         subtenant_org_id
       )
       AND conduit_is_latest_pricing_row(reseller_pricing_config.id)
    )
  );

-- ---------------------------------------------------------------------------
-- (ii) View — column-projection layer, nullifies created_by for non-admins
-- ---------------------------------------------------------------------------
-- security_invoker=true: caller's RLS applies. View is purely
-- column-projection; row-gating lives in the base-table policy above.
CREATE OR REPLACE VIEW reseller_pricing_config_view
WITH (security_invoker = true) AS
SELECT
  id,
  reseller_org_id,
  subtenant_org_id,
  mode,
  rate_basis_points,
  amount_cents,
  currency,
  effective_at,
  CASE
    WHEN conduit_is_reseller_admin_of_ancestor(
           current_setting('conduit.current_user_id', true),
           subtenant_org_id)
    THEN created_by
    ELSE NULL
  END AS created_by,
  created_at
FROM reseller_pricing_config;

COMMENT ON VIEW reseller_pricing_config_view IS
  'Migration 026: read-path projection over reseller_pricing_config. '
  'security_invoker=true means caller RLS applies (row-gating via base '
  'table SELECT policy). CASE nullifies created_by for non-reseller-admin '
  'callers (Aaron 2026-05-15 lock: subtenant cannot see who set the '
  'price). ServiceLayer.getCurrentPricing should read this view rather '
  'than the base table to inherit both row-gating and column-strip.';

GRANT SELECT ON reseller_pricing_config_view TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Apply-time audit (sub-pattern #10 third-pin)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_policy_def TEXT;
  v_view_exists BOOLEAN;
BEGIN
  -- Verify the new SELECT policy contains the NOT EXISTS clause (proves
  -- the replacement landed, not just that A policy exists).
  SELECT qual::TEXT INTO v_policy_def
    FROM pg_policies
   WHERE tablename = 'reseller_pricing_config'
     AND policyname = 'reseller_pricing_config_select';

  IF v_policy_def IS NULL THEN
    RAISE EXCEPTION 'mig 026 audit: reseller_pricing_config_select policy missing after replace';
  END IF;
  IF position('conduit_is_latest_pricing_row' in v_policy_def) = 0 THEN
    RAISE EXCEPTION 'mig 026 audit: SELECT policy does not reference conduit_is_latest_pricing_row helper (got: %)', v_policy_def;
  END IF;

  -- Verify view exists with the expected name.
  SELECT EXISTS (
    SELECT 1 FROM pg_views
     WHERE viewname = 'reseller_pricing_config_view'
       AND schemaname = 'public'
  ) INTO v_view_exists;
  IF NOT v_view_exists THEN
    RAISE EXCEPTION 'mig 026 audit: reseller_pricing_config_view missing';
  END IF;
END$$;

COMMIT;
