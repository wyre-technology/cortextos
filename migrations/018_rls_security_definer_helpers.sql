-- =============================================================================
-- Migration:      018_rls_security_definer_helpers.sql
-- Date:           2026-05-10
-- PRD Reference:  prd-reseller-tenancy.md §5.6 Phase 2 (deferred follow-up)
-- Ticket:         reseller-tenancy / rls-recursion-fix
--
-- Purpose:
--   Fix the infinite-recursion bug introduced by migrations 007 and 014.
--
--   007 enabled FORCED RLS on tenant-scoped tables and defined READ
--   policies whose USING clauses subquery the same tables they protect
--   (e.g. `org_members_select` USING does
--   `EXISTS (SELECT 1 FROM org_members m2 WHERE …)`). Under FORCED RLS,
--   the subquery's SELECT triggers RLS on `org_members`, which fires the
--   same policy, which subqueries `org_members`, ad infinitum. Postgres
--   detects this with SQLSTATE 42P17 ("infinite recursion detected in
--   policy for relation"). 014's WITH CHECK clauses inherit the same
--   problem because their EXISTS subqueries hit the same recursive
--   tables.
--
--   007's own header explicitly defers the fix: "A helper function
--   would be cleaner; deferred to follow-up (see PRD §5.6 Phase 2)."
--   This migration is that follow-up.
--
-- Discovery
-- ---------
--   Caught by the RLS-aware integration test on branch
--   `test/rls-with-check-integration`. The test's paired-accept/reject
--   design exposed the recursion: the "should-accept" half of every
--   organizations INSERT/UPDATE assertion failed with 42P17, surfacing
--   the bug before the suite could ship a misleading green checkmark
--   built on rejection-by-recursion.
--
-- Fix shape: SECURITY DEFINER helper functions
-- --------------------------------------------
--   Each recursive predicate is replaced by a call to a SECURITY DEFINER
--   helper function. The helper runs as its owner (the role that ran
--   this migration) and bypasses RLS for its single internal lookup —
--   the helper only ever returns a boolean, never a row, so no data
--   can leak via the helper's signature.
--
--   Helpers are LANGUAGE sql, STABLE, with `SET search_path = pg_catalog,
--   public` pinned to mitigate the standard SECURITY DEFINER
--   search-path-injection risk. EXECUTE is granted to PUBLIC, per-function
--   (no `GRANT EXECUTE ON ALL FUNCTIONS …` wildcards), so policy evaluation
--   under any role can call them.
--
-- Privilege chain
-- ---------------
--   SECURITY DEFINER means the helper's body executes with the function
--   OWNER's privileges, not the caller's. The owner is whichever role
--   runs this migration (typically the migration / platform-admin role,
--   often a superuser-equivalent or the bootstrap-time `postgres` user).
--   That role has broad SELECT on the underlying tables — exactly what
--   the helper needs to do its single bool-returning lookup. The
--   narrowness of what each helper actually queries (one EXISTS, one
--   table, one column predicate) is the containment: even if the owner
--   is broadly privileged, the helper cannot do anything with that
--   privilege beyond returning yes/no on the hard-coded predicate.
--   Future operators changing the migration role: be aware the helper
--   will inherit whatever read privileges that role has. Don't drop the
--   migration role's read access to these tables, or the helpers stop
--   working.
--
-- Why this fix is correct under both production scenarios
-- -------------------------------------------------------
--   (α) `gatewayadmin` has BYPASSRLS — RLS is decorative for gateway
--       traffic. The helpers are unused at request time; the fix is
--       latent until role-switching is wired in (separate workstream).
--       But the policies are no longer recursive, so any future query
--       under a non-bypass role works.
--   (β) `gatewayadmin` does NOT have BYPASSRLS — every query trips the
--       recursion today. The helpers replace the recursive predicates
--       at every read/write evaluation; the policies become functional.
--
--   Either way, this migration is the prerequisite for RLS to work as
--   designed.
--
-- Idempotency
-- -----------
--   Helper functions use `CREATE OR REPLACE FUNCTION`. Policies use
--   `DROP POLICY IF EXISTS` followed by `CREATE POLICY`. Safe to re-run.
--
-- Rollback Notes
-- --------------
--   Forward-only project convention. To revert: drop the helpers and
--   restore the recursive policies (which would re-introduce the bug).
--   Don't.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Helper functions
-- ---------------------------------------------------------------------------
--
-- All helpers:
--   * RETURNS boolean — no row data, just yes/no.
--   * STABLE — no side effects, same input → same output within one
--     statement.
--   * SECURITY DEFINER — bypasses RLS for the helper's internal lookup
--     because it runs as the function owner (which has read access to
--     the tables and is not constrained by the RLS policies that depend
--     on this helper). The owner is whichever role applies migrations.
--   * SET search_path = pg_catalog, public — SECURITY DEFINER best
--     practice. Without it, a malicious local user could create a
--     same-named function in their search_path and have the helper
--     resolve to their version when called from policy context.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION conduit_is_member_of_org(p_user_id text, p_org_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org_id
      AND user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION conduit_is_reseller_member_of(p_user_id text, p_reseller_org_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM reseller_members
    WHERE reseller_org_id = p_reseller_org_id
      AND user_id = p_user_id
  );
$$;

-- "Reseller_admin (or reseller_owner) of the parent of <org>." The hot
-- path for cross-org write authorization in 014's WITH CHECK clauses.
CREATE OR REPLACE FUNCTION conduit_is_reseller_admin_of_parent(p_user_id text, p_child_org_id text)
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
       AND rm.role IN ('reseller_owner', 'reseller_admin')
  );
$$;

-- For the customer-sees-parent-reseller branch in organizations_select:
-- "is the current user a member of any customer org under this reseller?"
CREATE OR REPLACE FUNCTION conduit_is_member_of_child_under(p_user_id text, p_reseller_org_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM org_members m
      JOIN organizations c ON c.id = m.org_id
     WHERE c.parent_org_id = p_reseller_org_id
       AND m.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION conduit_is_member_of_team(p_user_id text, p_team_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM org_teams t
      JOIN org_members m ON m.org_id = t.org_id
     WHERE t.id = p_team_id
       AND m.user_id = p_user_id
  );
$$;

-- For the reseller_admin-on-team branch: "reseller_admin of the parent of
-- the org the team belongs to."
CREATE OR REPLACE FUNCTION conduit_is_reseller_admin_over_team(p_user_id text, p_team_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM org_teams t
      JOIN organizations o ON o.id = t.org_id
      JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
     WHERE t.id = p_team_id
       AND rm.user_id = p_user_id
       AND rm.role IN ('reseller_owner', 'reseller_admin')
  );
$$;

-- Active+approved support grant for the given user/grant_id/customer.
-- Single helper because the four-condition check (id match, granted_to
-- match, customer match, not revoked, not expired, approved-or-no-
-- approval-required) is identical at every call site.
CREATE OR REPLACE FUNCTION conduit_has_active_support_grant_for(
  p_user_id text,
  p_grant_id text,
  p_customer_org_id text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM reseller_support_grants g
     WHERE g.id = p_grant_id
       AND g.granted_to_user_id = p_user_id
       AND g.customer_org_id = p_customer_org_id
       AND g.revoked_at IS NULL
       AND g.expires_at > NOW()
       AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL)
  );
$$;

-- Open EXECUTE to all roles. The helpers return boolean; no row data
-- is exposed via the function signature, so PUBLIC EXECUTE doesn't
-- broaden read access beyond what the policies already imply.
GRANT EXECUTE ON FUNCTION conduit_is_member_of_org(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_is_reseller_member_of(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_is_reseller_admin_of_parent(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_is_member_of_child_under(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_is_member_of_team(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_is_reseller_admin_over_team(text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION conduit_has_active_support_grant_for(text, text, text) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Rewrite 007's USING (SELECT) policies using the helpers
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_member_of_child_under(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         organizations.id
       )
  );

DROP POLICY IF EXISTS org_members_select ON org_members;
CREATE POLICY org_members_select ON org_members
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

DROP POLICY IF EXISTS org_credentials_select ON org_credentials;
CREATE POLICY org_credentials_select ON org_credentials
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_credentials.org_id
       )
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

DROP POLICY IF EXISTS org_team_credentials_select ON org_team_credentials;
CREATE POLICY org_team_credentials_select ON org_team_credentials
  FOR SELECT
  USING (
       conduit_is_member_of_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
    OR conduit_is_reseller_admin_over_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
  );

DROP POLICY IF EXISTS org_invitations_select ON org_invitations;
CREATE POLICY org_invitations_select ON org_invitations
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_invitations.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_invitations.org_id)
  );

DROP POLICY IF EXISTS org_tool_allowlist_select ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_select ON org_tool_allowlist
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_tool_allowlist.org_id)
  );

DROP POLICY IF EXISTS org_server_access_select ON org_server_access;
CREATE POLICY org_server_access_select ON org_server_access
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_server_access.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_server_access.org_id)
  );

DROP POLICY IF EXISTS admin_audit_log_select ON admin_audit_log;
CREATE POLICY admin_audit_log_select ON admin_audit_log
  FOR SELECT
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), admin_audit_log.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         admin_audit_log.org_id
       )
  );

DROP POLICY IF EXISTS request_log_select ON request_log;
CREATE POLICY request_log_select ON request_log
  FOR SELECT
  USING (
    request_log.user_id = current_setting('conduit.current_user_id', true)
    OR (
      request_log.org_id IS NOT NULL AND (
           conduit_is_member_of_org(current_setting('conduit.current_user_id', true), request_log.org_id)
        OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), request_log.org_id)
      )
    )
  );

-- credentials_select is user-scoped only (no recursion). 007's policy is
-- already correct — no rewrite needed. Re-DROP+CREATE for idempotence.
DROP POLICY IF EXISTS credentials_select ON credentials;
CREATE POLICY credentials_select ON credentials
  FOR SELECT
  USING (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  );

DROP POLICY IF EXISTS reseller_members_select ON reseller_members;
CREATE POLICY reseller_members_select ON reseller_members
  FOR SELECT
  USING (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), reseller_members.reseller_org_id)
  );

DROP POLICY IF EXISTS reseller_shared_vendor_grants_select ON reseller_shared_vendor_grants;
CREATE POLICY reseller_shared_vendor_grants_select ON reseller_shared_vendor_grants
  FOR SELECT
  USING (
       conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), reseller_shared_vendor_grants.reseller_org_id)
    OR conduit_is_member_of_org(current_setting('conduit.current_user_id', true), reseller_shared_vendor_grants.customer_org_id)
  );

DROP POLICY IF EXISTS reseller_support_grants_select ON reseller_support_grants;
CREATE POLICY reseller_support_grants_select ON reseller_support_grants
  FOR SELECT
  USING (
    reseller_support_grants.granted_to_user_id = current_setting('conduit.current_user_id', true)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), reseller_support_grants.reseller_org_id)
    OR conduit_is_member_of_org(current_setting('conduit.current_user_id', true), reseller_support_grants.customer_org_id)
  );

-- ---------------------------------------------------------------------------
-- 3. Rewrite 014's WITH CHECK (INSERT/UPDATE) policies using the helpers
-- ---------------------------------------------------------------------------
--
-- 014 added INSERT and UPDATE policies on the same 13 tables 007 covered.
-- All of them have the same recursion problem because their WITH CHECK
-- predicates query the same tables 007's USING clauses recurse on.
--
-- Predicate parity with 014 is preserved — every OR-branch that 014
-- expresses inline is mirrored as a helper-function call.

-- organizations
DROP POLICY IF EXISTS organizations_insert ON organizations;
CREATE POLICY organizations_insert ON organizations
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
  );

DROP POLICY IF EXISTS organizations_update ON organizations;
CREATE POLICY organizations_update ON organizations
  FOR UPDATE
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
  );

-- org_members
DROP POLICY IF EXISTS org_members_insert ON org_members;
CREATE POLICY org_members_insert ON org_members
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

DROP POLICY IF EXISTS org_members_update ON org_members;
CREATE POLICY org_members_update ON org_members
  FOR UPDATE
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  );

-- org_credentials
DROP POLICY IF EXISTS org_credentials_insert ON org_credentials;
CREATE POLICY org_credentials_insert ON org_credentials
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

DROP POLICY IF EXISTS org_credentials_update ON org_credentials;
CREATE POLICY org_credentials_update ON org_credentials
  FOR UPDATE
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

-- org_team_credentials
DROP POLICY IF EXISTS org_team_credentials_insert ON org_team_credentials;
CREATE POLICY org_team_credentials_insert ON org_team_credentials
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
    OR conduit_is_reseller_admin_over_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
  );

DROP POLICY IF EXISTS org_team_credentials_update ON org_team_credentials;
CREATE POLICY org_team_credentials_update ON org_team_credentials
  FOR UPDATE
  WITH CHECK (
       conduit_is_member_of_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
    OR conduit_is_reseller_admin_over_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
  );

COMMIT;

-- =============================================================================
-- End of 018_rls_security_definer_helpers.sql
-- =============================================================================
