-- =============================================================================
-- Migration:      030_widen_request_log_reseller_read.sql
-- Date:           2026-05-17
-- Ticket:         Track C S2 — reseller-scoped customer dashboard (app/RLS reconcile)
--
-- Purpose:
--   Widen request_log_select so ANY reseller role linked to a customer's
--   parent — not only reseller_owner / reseller_admin — may read that
--   customer's request_log rows.
--
--   Background: the Track C S2 endpoint (/admin/reseller/:resellerId/
--   customers/:customerId/dashboard/*) authorizes ANY reseller role via the
--   app middleware (requireResellerOrCustomerAccess). But request_log_select
--   gated the reseller branch on conduit_is_reseller_admin_of_parent, which
--   only admits reseller_owner / reseller_admin. Net: a reseller_support_agent
--   or reseller_billing_viewer got a 200 dashboard page with silently-empty
--   data — the app granted access, RLS returned no rows. Aaron ruled (option
--   a, WIDEN): support_agent + billing_viewer SHOULD see customer dashboards,
--   so the RLS side widens to match the app grant.
--
--   conduit_is_reseller_admin_of_parent is a SHARED SECURITY DEFINER helper
--   called by the SELECT policies of 8 tables plus WITH CHECK clauses. It is
--   deliberately NOT mutated here — widening it in place would change the
--   reseller boundary for every caller. Instead this migration adds a new
--   helper, conduit_is_reseller_member_of_parent (the admin-of-parent body
--   minus the role filter), and switches ONLY request_log_select to it.
--
--   Scope is request_log_select alone. org_members_select is deliberately
--   left owner/admin + support-grant scoped: the customer member roster is
--   broader than the usage data Aaron approved, and org_members already has
--   a deliberate scoped path (conduit_has_active_support_grant_for).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- New helper: is the user a reseller_member (ANY role) of the org's parent?
--
-- Identical to conduit_is_reseller_admin_of_parent except it omits the
-- `rm.role IN ('reseller_owner','reseller_admin')` filter — so it admits
-- every reseller role. SECURITY DEFINER + pinned search_path, matching the
-- other reseller helpers in migration 018.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conduit_is_reseller_member_of_parent(p_user_id text, p_child_org_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM organizations o
      JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
     WHERE o.id = p_child_org_id
       AND rm.user_id = p_user_id
  );
$$;

GRANT EXECUTE ON FUNCTION conduit_is_reseller_member_of_parent(text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- request_log_select — swap ONLY the reseller branch to the member helper.
--
-- Identical to the migration 018 policy except the reseller predicate is now
-- conduit_is_reseller_member_of_parent (any reseller role) rather than
-- conduit_is_reseller_admin_of_parent (owner/admin only). The user-self and
-- org-member branches are unchanged. This is a pure widen — owner/admin still
-- pass, since any-role is a superset.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS request_log_select ON request_log;
CREATE POLICY request_log_select ON request_log
  FOR SELECT
  USING (
    request_log.user_id = current_setting('conduit.current_user_id', true)
    OR (
      request_log.org_id IS NOT NULL AND (
           conduit_is_member_of_org(current_setting('conduit.current_user_id', true), request_log.org_id)
        OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), request_log.org_id)
      )
    )
  );

COMMIT;

-- =============================================================================
-- End of 030_widen_request_log_reseller_read.sql
-- =============================================================================
