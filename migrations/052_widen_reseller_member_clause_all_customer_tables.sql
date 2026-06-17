-- =============================================================================
-- Migration:      052_widen_reseller_member_clause_all_customer_tables.sql
-- Date:           2026-06-17
-- Ticket:         LAYER-B subtenant-RLS-fix (boss msg-1781725590563)
--
-- Purpose:
--   Widen RLS reseller-clause from admin-only (`conduit_is_reseller_admin_of_parent`)
--   to any-role (`conduit_is_reseller_member_of_parent`) across the 7 customer-
--   facing tables — mirroring mig 030's pattern for request_log VERBATIM
--   (warden HARD-REQ-a) but applied UNIFORMLY across the broader table-set
--   (warden HARD-REQ-b).
--
--   Background: subtenant experience was unusable on staging.conduit.wyre.ai
--   because operators (reseller-members) acting against customer-orgs hit
--   RLS denials on every customer-detail read + write. The READ-side bug
--   was already partially-mitigated for request_log by mig 030, but the
--   other 7 affected tables retained the admin-only reseller-clause —
--   silently empty data on every server-rendered customer-detail tab +
--   403/no-effect on every customer-write.
--
--   Aaron's call: support_agent + billing_viewer + admin + owner SHOULD ALL
--   see + mutate customer-org rows when the parent-org-of-customer is their
--   reseller-org. Authz already happens at the app layer via
--   requireResellerAccess + requireCustomerOwnership; RLS is defense-in-depth.
--
-- Substrate authority (warden HARD-REQ-a — verbatim mirror, not new predicate):
--   The reseller branch predicate copy-pasted from mig 030's request_log_select:
--     OR conduit_is_reseller_member_of_parent(
--          current_setting('conduit.current_user_id', true), <table>.org_id
--        )
--
-- Table-set (warden HARD-REQ-b — handler-grounded SET-COMPLETENESS, NOT
-- mig-018-derived):
--   The 7 tables enumerated below correspond to the read-handler-queries +
--   write-handler-queries surfaced from the customer-detail handler-map at
--   src/web/routes.ts customer-detail surfaces + the reseller-on-customer
--   mutation paths the LAYER-C build needs to land. Plus request_log
--   (already done via mig 030) for SET-COMPLETENESS witness in tests.
--
--   FK source (warden HARD-REQ-c): organizations.parent_org_id — the SAME
--   relationship requireCustomerOwnership uses at the app layer. No parallel
--   relationship-source. Validated by conduit_is_reseller_member_of_parent's
--   body at mig 030 which joins organizations o ON rm.reseller_org_id =
--   o.parent_org_id.
--
--   GUC stability (warden HARD-REQ-d): conduit.current_user_id is the SAME
--   GUC mig 030 uses on request_log. Pool checkout/checkin discipline is
--   established at the connection layer in src/db/context.ts; no new GUC
--   introduced here.
--
--   Active-only (warden HARD-REQ-e): conduit_is_reseller_member_of_parent
--   queries reseller_members directly. Soft-deleted reseller_members rows
--   are NOT present in the table (the substrate uses hard delete OR a
--   deleted_at clause; both eliminate the row from the EXISTS lookup).
--   Regression test asserts soft-delete -> RLS rejects.
--
--   Cross-reseller defense-in-depth (warden HARD-REQ-f): reseller-A querying
--   for a row owned by customer-of-reseller-B still rejects because reseller_A
--   is NOT a reseller_member of customer-B's parent_org (= reseller_B).
--   Regression test asserts this directly.
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations (used by Settings tab + main customer-detail header)
--
-- The reseller-of-parent clause is widened to member-of-parent. Other reseller
-- branches (reseller_member_of, member_of_child_under, support_grant) are
-- preserved unchanged — this migration only swaps the admin-of-parent branch.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_member_of_child_under(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         organizations.id
       )
  );

-- ---------------------------------------------------------------------------
-- 2. org_members (used by Users tab + member-mgmt writes + main header)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_members_select ON org_members;
CREATE POLICY org_members_select ON org_members
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

DROP POLICY IF EXISTS org_members_insert ON org_members;
CREATE POLICY org_members_insert ON org_members
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

DROP POLICY IF EXISTS org_members_update ON org_members;
CREATE POLICY org_members_update ON org_members
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  )
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

DROP POLICY IF EXISTS org_members_delete ON org_members;
CREATE POLICY org_members_delete ON org_members
  FOR DELETE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

-- ---------------------------------------------------------------------------
-- 3. org_credentials (used by MCPs tab + vendor connect/disconnect writes)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_credentials_select ON org_credentials;
CREATE POLICY org_credentials_select ON org_credentials
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_credentials.org_id
       )
  );

DROP POLICY IF EXISTS org_credentials_insert ON org_credentials;
CREATE POLICY org_credentials_insert ON org_credentials
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

DROP POLICY IF EXISTS org_credentials_update ON org_credentials;
CREATE POLICY org_credentials_update ON org_credentials
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  )
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

DROP POLICY IF EXISTS org_credentials_delete ON org_credentials;
CREATE POLICY org_credentials_delete ON org_credentials
  FOR DELETE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

-- ---------------------------------------------------------------------------
-- 4. org_invitations (member-invite flow; already had 2026-06-12 workaround via
--    reseller-scoped endpoint at src/reseller/routes.ts:872 — this migration
--    makes the RLS-level path consistent so the workaround can eventually be
--    folded back into the per-org endpoint).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_invitations_select ON org_invitations;
CREATE POLICY org_invitations_select ON org_invitations
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
  );

DROP POLICY IF EXISTS org_invitations_insert ON org_invitations;
CREATE POLICY org_invitations_insert ON org_invitations
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
  );

DROP POLICY IF EXISTS org_invitations_update ON org_invitations;
CREATE POLICY org_invitations_update ON org_invitations
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
  );

DROP POLICY IF EXISTS org_invitations_delete ON org_invitations;
CREATE POLICY org_invitations_delete ON org_invitations
  FOR DELETE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
  );

-- ---------------------------------------------------------------------------
-- 5. org_tool_allowlist (per-vendor tool allowlist; touched by tools tab +
--    onboard-MCP wizard writes).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_tool_allowlist_select ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_select ON org_tool_allowlist
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
  );

DROP POLICY IF EXISTS org_tool_allowlist_insert ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_insert ON org_tool_allowlist
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
  );

DROP POLICY IF EXISTS org_tool_allowlist_update ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_update ON org_tool_allowlist
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
  );

DROP POLICY IF EXISTS org_tool_allowlist_delete ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_delete ON org_tool_allowlist
  FOR DELETE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
  );

-- ---------------------------------------------------------------------------
-- 6. org_server_access (per-member-per-vendor access overrides).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_server_access_select ON org_server_access;
CREATE POLICY org_server_access_select ON org_server_access
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
  );

DROP POLICY IF EXISTS org_server_access_insert ON org_server_access;
CREATE POLICY org_server_access_insert ON org_server_access
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
  );

DROP POLICY IF EXISTS org_server_access_update ON org_server_access;
CREATE POLICY org_server_access_update ON org_server_access
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
  );

DROP POLICY IF EXISTS org_server_access_delete ON org_server_access;
CREATE POLICY org_server_access_delete ON org_server_access
  FOR DELETE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
  );

-- ---------------------------------------------------------------------------
-- 7. admin_audit_log (audit-event-emit for customer-org operations).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS admin_audit_log_select ON admin_audit_log;
CREATE POLICY admin_audit_log_select ON admin_audit_log
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         admin_audit_log.org_id
       )
  );

DROP POLICY IF EXISTS admin_audit_log_insert ON admin_audit_log;
CREATE POLICY admin_audit_log_insert ON admin_audit_log
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_member_of_parent(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
  );

COMMIT;

-- =============================================================================
-- End of 052_widen_reseller_member_clause_all_customer_tables.sql
-- =============================================================================
