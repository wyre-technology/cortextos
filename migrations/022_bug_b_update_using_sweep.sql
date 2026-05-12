-- Migration 022 — Bug B sweep: restore mig-014-intended-shape on the 9
-- remaining UPDATE policies that ship with WITH CHECK but qual=NULL.
--
-- Companion: src/db/__tests__/rls-helper-context-investigation.md
-- + task_1778507498148_478 (Bug B remaining 9 RLS UPDATE policies, hard-
-- linked before CP1 SET ROLE per-request work)
--
-- =============================================================================
-- BUG B RECAP
-- =============================================================================
--
-- Migration 014 created every UPDATE policy with WITH CHECK only, relying
-- on a documentation claim that USING defaults to WITH CHECK when omitted.
-- Empirically (verified on PG 17 in staging via mig 020) it does not —
-- pg_policies.qual is NULL on those policies, the UPDATE pre-image filter
-- rejects every row, UPDATEs silently affect 0 rows.
--
-- Migration 020 fixed 4 of the 13 affected tables (organizations,
-- org_members, org_credentials, org_team_credentials). This migration
-- closes the remaining 9:
--
--   1. admin_audit_log_update
--   2. credentials_update
--   3. org_invitations_update
--   4. org_server_access_update
--   5. org_tool_allowlist_update
--   6. request_log_update
--   7. reseller_members_update
--   8. reseller_shared_vendor_grants_update
--   9. reseller_support_grants_update
--
-- =============================================================================
-- DESIGN PRINCIPLE (per mig 014 docblock)
-- =============================================================================
--
-- mig 014 stated: "For each table, add INSERT and UPDATE policies with
-- WITH CHECK clauses that mirror the USING logic from the existing SELECT
-- policies. This ensures write operations are subject to the same org/
-- reseller isolation as read operations."
--
-- This migration restores that intent: each UPDATE policy gets an
-- explicit USING clause IDENTICAL to its existing WITH CHECK. The
-- WITH CHECK was already (per mig 014) the mirror of the SELECT USING
-- from mig 007. So post-mig-022, UPDATE pre-image filter == post-image
-- check == SELECT filter. Symmetric, intent-restored.
--
-- =============================================================================
-- OUT OF SCOPE (per Walter pre-ack 2026-05-12 msg 1778602000975)
-- =============================================================================
--
-- (a) Refactoring inline EXISTS subqueries to mig-018-helpers — task
--     1778602082295_980. Scope-clean follow-up; helper-context risk
--     warrants its own test posture.
-- (b) Append-only immutability for admin_audit_log + request_log — task
--     1778602082221_031. Compliance/stakeholder design decision; mig 022
--     restores mig-014-mutable-intent, not introduces new semantics.
-- (c) reseller_billing_viewer UPDATE on request_log — verified as
--     documented-with-intent via 3-layer chain (mig 007 predicate parity
--     + mig 003 role declaration + cross-table differentiation). Surfaced
--     to Walter, classified DOCUMENTED.
-- (d) Depth-3-aware predicate for nested customer hierarchies — task
--     1778602064199_259. Blocked-by subtenant scope-doc; orthogonal to
--     Bug B closure.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. admin_audit_log_update — admit org_members of target org OR reseller_
--    admin/owner of parent OR reseller_member of own org
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS admin_audit_log_update ON admin_audit_log;
CREATE POLICY admin_audit_log_update ON admin_audit_log
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = admin_audit_log.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = admin_audit_log.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- 2. credentials_update — strictly self-owned
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS credentials_update ON credentials;
CREATE POLICY credentials_update ON credentials
  FOR UPDATE
  USING (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  )
  WITH CHECK (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  );

-- ---------------------------------------------------------------------------
-- 3. org_invitations_update — admit org_members of target org OR
--    reseller_admin/owner of parent
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_invitations_update ON org_invitations;
CREATE POLICY org_invitations_update ON org_invitations
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_invitations.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_invitations.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_invitations.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_invitations.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 4. org_server_access_update — same shape as org_invitations
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_server_access_update ON org_server_access;
CREATE POLICY org_server_access_update ON org_server_access
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_server_access.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_server_access.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_server_access.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_server_access.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 5. org_tool_allowlist_update — same shape as org_invitations
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS org_tool_allowlist_update ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_update ON org_tool_allowlist
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_tool_allowlist.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_tool_allowlist.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_tool_allowlist.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_tool_allowlist.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 6. request_log_update — admit row-owner OR (org-bound + member-or-
--    reseller-admin/owner/billing-viewer). reseller_billing_viewer is
--    INTENTIONALLY admitted here (and only here in this sweep) per
--    mig 007 SELECT-policy precedent — see investigation doc + Walter
--    pre-ack thread for the 3-layer-chain documented-with-intent
--    classification.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS request_log_update ON request_log;
CREATE POLICY request_log_update ON request_log
  FOR UPDATE
  USING (
    request_log.user_id = current_setting('conduit.current_user_id', true)
    OR (
      request_log.org_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = request_log.org_id
                   AND m.user_id = current_setting('conduit.current_user_id', true))
        OR EXISTS (SELECT 1 FROM organizations o
                     JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                    WHERE o.id = request_log.org_id
                      AND rm.user_id = current_setting('conduit.current_user_id', true)
                      AND rm.role IN ('reseller_owner','reseller_admin','reseller_billing_viewer'))
      )
    )
  )
  WITH CHECK (
    request_log.user_id = current_setting('conduit.current_user_id', true)
    OR (
      request_log.org_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = request_log.org_id
                   AND m.user_id = current_setting('conduit.current_user_id', true))
        OR EXISTS (SELECT 1 FROM organizations o
                     JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                    WHERE o.id = request_log.org_id
                      AND rm.user_id = current_setting('conduit.current_user_id', true)
                      AND rm.role IN ('reseller_owner','reseller_admin','reseller_billing_viewer'))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 7. reseller_members_update — admit self OR reseller_admin/owner of org
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_members_update ON reseller_members;
CREATE POLICY reseller_members_update ON reseller_members
  FOR UPDATE
  USING (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm2
                WHERE rm2.reseller_org_id = reseller_members.reseller_org_id
                  AND rm2.user_id = current_setting('conduit.current_user_id', true)
                  AND rm2.role IN ('reseller_owner', 'reseller_admin'))
  )
  WITH CHECK (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm2
                WHERE rm2.reseller_org_id = reseller_members.reseller_org_id
                  AND rm2.user_id = current_setting('conduit.current_user_id', true)
                  AND rm2.role IN ('reseller_owner', 'reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 8. reseller_shared_vendor_grants_update — reseller_admin/owner only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_shared_vendor_grants_update ON reseller_shared_vendor_grants;
CREATE POLICY reseller_shared_vendor_grants_update ON reseller_shared_vendor_grants
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_shared_vendor_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true)
               AND rm.role IN ('reseller_owner', 'reseller_admin'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_shared_vendor_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true)
               AND rm.role IN ('reseller_owner', 'reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 9. reseller_support_grants_update — three-branch: grant-recipient OR
--    reseller_admin/owner OR customer-admin/owner
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_support_grants_update ON reseller_support_grants;
CREATE POLICY reseller_support_grants_update ON reseller_support_grants
  FOR UPDATE
  USING (
    reseller_support_grants.granted_to_user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = reseller_support_grants.reseller_org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner', 'reseller_admin'))
    OR EXISTS (SELECT 1 FROM org_members m
                WHERE m.org_id = reseller_support_grants.customer_org_id
                  AND m.user_id = current_setting('conduit.current_user_id', true)
                  AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    reseller_support_grants.granted_to_user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = reseller_support_grants.reseller_org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner', 'reseller_admin'))
    OR EXISTS (SELECT 1 FROM org_members m
                WHERE m.org_id = reseller_support_grants.customer_org_id
                  AND m.user_id = current_setting('conduit.current_user_id', true)
                  AND m.role IN ('owner', 'admin'))
  );

-- ---------------------------------------------------------------------------
-- Post-migration audit hook: with mig 020 + mig 022 together, the
-- qual-IS-NULL count across all public.* UPDATE policies should now be 0
-- (only scim_connections_update from mig 016 retains its own explicit
-- USING from-the-start). Mig 020's audit raised WARNING on remaining
-- gaps; this migration's audit promotes the expectation to EXCEPTION
-- when more than 0 remain — the Bug B class is closed by mig 022, so
-- any future UPDATE policy that ships with qual=NULL is a re-regression
-- and should fail deploy loudly.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_count INT;
  v_rows TEXT;
BEGIN
  SELECT COUNT(*), string_agg(tablename || '/' || policyname, ', ')
    INTO v_count, v_rows
    FROM pg_policies
   WHERE schemaname = 'public'
     AND cmd = 'UPDATE'
     AND qual IS NULL;
  IF v_count > 0 THEN
    -- Hard fail: Bug B re-regression. mig 022 must have left a gap
    -- (which means this migration is incomplete) OR a later migration
    -- introduced a new qual-IS-NULL UPDATE policy (which means the
    -- sub-pattern #10 discipline is being violated).
    RAISE EXCEPTION 'mig 022 audit: % UPDATE polic(ies) still have qual IS NULL — Bug B not fully closed. Affected: %', v_count, v_rows;
  END IF;
  RAISE NOTICE 'mig 022 audit: 0 UPDATE policies with qual IS NULL. Bug B closed end-to-end.';
END;
$$;

COMMIT;
