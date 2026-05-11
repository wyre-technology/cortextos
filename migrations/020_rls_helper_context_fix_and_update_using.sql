-- Migration 020 — RLS helper-context fix + UPDATE-policy USING repair
--
-- DRAFT (uncommitted, pending Walter + boss morning review).
--
-- Companion doc: src/db/__tests__/rls-helper-context-investigation.md
--
-- This migration resolves two distinct bugs that surfaced after 018 + 019:
--
-- BUG A (INSERT chicken-and-egg)
--   Helper conduit_is_reseller_admin_of_parent(user, organizations.id)
--   looks up the org row inside `organizations` to derive parent_org_id.
--   In INSERT WITH CHECK context the new row is not yet stored, so the
--   lookup finds 0 rows and the helper returns false. The fix is a new
--   sibling helper that takes parent_org_id directly as a parameter; the
--   INSERT policy passes the NEW row's parent_org_id column value.
--
-- BUG B (UPDATE policies with no USING)
--   Migration 014 created UPDATE policies with only WITH CHECK and no
--   USING, relying on a doc claim that USING defaults to WITH CHECK when
--   omitted. Empirically (Postgres 15) it does not — pg_policies.qual is
--   NULL, the pre-image filter rejects every row, UPDATEs affect 0 rows
--   silently. The fix is an explicit USING clause on every affected
--   UPDATE policy, mirroring the WITH CHECK predicate.
--
-- This migration also implicitly retires migration 019's temporary
-- `WITH CHECK (true)` passthrough on organizations_insert — step 3 below
-- drops + recreates that policy with the proper predicate.
--
-- Hard link: task_1778429689936_847 (the temporary-passthrough restore
-- ticket). Landing this migration closes that ticket.
--
-- Three-deep disclaimer pattern:
--   - Filename: 020_rls_helper_context_fix_and_update_using.sql
--   - Header (this comment block)
--   - COMMENT ON POLICY on the affected INSERT policy (end of file)

BEGIN;

-- ===========================================================================
-- Step 1: New helper — direct reseller-admin check against parent_org_id
-- ===========================================================================
--
-- Naming: `_of_reseller` distinguishes this from the existing
-- `_of_parent` variant. _of_parent takes a child org_id and looks up
-- the parent via JOIN through `organizations`. _of_reseller takes the
-- reseller org_id directly and does not touch `organizations`. The
-- distinction is load-bearing for INSERT WITH CHECK, where the new
-- row's id is not yet stored — _of_parent's JOIN finds 0 rows and
-- returns false. _of_reseller has no such dependency.

CREATE OR REPLACE FUNCTION conduit_is_reseller_admin_of_reseller(p_user_id text, p_reseller_org_id text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  -- INSERT-context only. UPDATE/SELECT paths should use _of_parent which
  -- looks up parent_org_id via JOIN through organizations. _of_reseller
  -- takes the parent_org_id directly because INSERT WITH CHECK fires
  -- before the row is stored — a JOIN-back to organizations would find
  -- nothing and incorrectly return false (the original Bug A).
  SELECT EXISTS (
    SELECT 1 FROM reseller_members
    WHERE reseller_org_id = p_reseller_org_id
      AND user_id = p_user_id
      AND role IN ('reseller_owner', 'reseller_admin')
  );
$$;

GRANT EXECUTE ON FUNCTION conduit_is_reseller_admin_of_reseller(text, text) TO PUBLIC;

-- ===========================================================================
-- Step 2: Fix organizations_insert (Bug A + retire 019's passthrough)
-- ===========================================================================

DROP POLICY IF EXISTS organizations_insert ON organizations;
CREATE POLICY organizations_insert ON organizations
  FOR INSERT
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_reseller(current_setting('conduit.current_user_id', true), organizations.parent_org_id)
  );

COMMENT ON POLICY organizations_insert ON organizations IS
  'Migration 020: real WITH CHECK predicate restored. Supersedes the temporary `WITH CHECK (true)` passthrough from migration 019. The reseller-admin branch uses conduit_is_reseller_admin_of_reseller (direct parent_org_id parameter), NOT conduit_is_reseller_admin_of_parent (which fails in INSERT context — see rls-helper-context-investigation.md).';

-- ===========================================================================
-- Step 3: Add explicit USING to every affected UPDATE policy (Bug B)
-- ===========================================================================
--
-- Postgres docs imply USING defaults to WITH CHECK on UPDATE policies
-- when omitted; empirically in PG 15 it does not — pg_policies.qual is
-- NULL and the policy silently rejects every pre-image. Every UPDATE
-- policy below gets an explicit USING with the same predicate as its
-- WITH CHECK.

-- organizations
DROP POLICY IF EXISTS organizations_update ON organizations;
CREATE POLICY organizations_update ON organizations
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
  )
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), organizations.id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), organizations.id)
  );

-- org_members
DROP POLICY IF EXISTS org_members_update ON org_members;
CREATE POLICY org_members_update ON org_members
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_members.org_id)
    OR conduit_has_active_support_grant_for(
         current_setting('conduit.current_user_id', true),
         current_setting('conduit.active_reseller_grant_id', true),
         org_members.org_id
       )
  )
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
DROP POLICY IF EXISTS org_credentials_update ON org_credentials;
CREATE POLICY org_credentials_update ON org_credentials
  FOR UPDATE
  USING (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  )
  WITH CHECK (
       conduit_is_member_of_org(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_admin_of_parent(current_setting('conduit.current_user_id', true), org_credentials.org_id)
    OR conduit_is_reseller_member_of(current_setting('conduit.current_user_id', true), org_credentials.org_id)
  );

-- org_team_credentials
DROP POLICY IF EXISTS org_team_credentials_update ON org_team_credentials;
CREATE POLICY org_team_credentials_update ON org_team_credentials
  FOR UPDATE
  USING (
       conduit_is_member_of_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
    OR conduit_is_reseller_admin_over_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
  )
  WITH CHECK (
       conduit_is_member_of_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
    OR conduit_is_reseller_admin_over_team(current_setting('conduit.current_user_id', true), org_team_credentials.team_id)
  );

-- ===========================================================================
-- Step 4: Audit hook — flag any UPDATE policy still missing USING
-- ===========================================================================
--
-- Defense-in-depth. Future migrations that add UPDATE policies with no
-- USING (and re-introduce Bug B) will be caught at deploy time by this
-- post-migration assertion. The DO block is informational-only; it does
-- not abort the migration. CI lint or pre-flight harness should consume
-- this as a stronger gate.

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND cmd = 'UPDATE'
    AND qual IS NULL;
  IF v_count > 0 THEN
    RAISE WARNING 'Migration 020 audit: % UPDATE policies still have qual IS NULL — Bug B not fully closed.', v_count;
  ELSE
    RAISE NOTICE 'Migration 020 audit: 0 UPDATE policies with qual IS NULL. Bug B closed.';
  END IF;
END;
$$;

COMMIT;
