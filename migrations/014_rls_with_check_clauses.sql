-- =============================================================================
-- Migration:      014_rls_with_check_clauses.sql
-- Date:           2026-04-28
-- PRD Reference:  prd-reseller-tenancy.md §5.6 Phase 2, acceptance §25
-- Ticket:         reseller-tenancy / Task #18 (RLS hardening)
--
-- Purpose:
--   Add WITH CHECK clauses to all RLS policies created in 007_rls_enable.sql.
--   This completes the "belt-and-suspenders" RLS implementation by ensuring
--   INSERT/UPDATE operations are also constrained by the same organization
--   isolation rules that govern SELECT operations.
--
--   Migration 007 intentionally created USING-only policies to be conservative.
--   This migration adds the WITH CHECK constraints after verification that
--   the read-side policies are working correctly.
--
-- Strategy:
--   For each table, add INSERT and UPDATE policies with WITH CHECK clauses
--   that mirror the USING logic from the existing SELECT policies. This
--   ensures write operations are subject to the same org/reseller isolation
--   as read operations.
--
-- Session variables (same as 007):
--   - conduit.current_user_id           TEXT   — authenticated user id
--   - conduit.current_org_id            TEXT   — current org context
--   - conduit.active_reseller_grant_id  TEXT   — active support grant if any
--
-- Rollback Notes:
--   DROP POLICY statements for each new policy. Forward-only convention.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. organizations table - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS organizations_insert ON organizations;
CREATE POLICY organizations_insert ON organizations
  FOR INSERT
  WITH CHECK (
    -- Can only create orgs where you would have SELECT access
    -- User must be creating in a context where they can see the org
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = organizations.id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
    -- Reseller_member creating customer under their reseller
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.reseller_org_id = organizations.parent_org_id
         AND rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
    )
  );

DROP POLICY IF EXISTS organizations_update ON organizations;
CREATE POLICY organizations_update ON organizations
  FOR UPDATE
  WITH CHECK (
    -- Same logic as SELECT - can only update orgs you can see
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = organizations.id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.reseller_org_id = organizations.id
         AND rm.user_id = current_setting('conduit.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.reseller_org_id = organizations.parent_org_id
         AND rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
    )
  );

-- ---------------------------------------------------------------------------
-- 2. org_members - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_members_insert ON org_members;
CREATE POLICY org_members_insert ON org_members
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m2
             WHERE m2.org_id = org_members.org_id
               AND m2.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_members.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

DROP POLICY IF EXISTS org_members_update ON org_members;
CREATE POLICY org_members_update ON org_members
  FOR UPDATE
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m2
             WHERE m2.org_id = org_members.org_id
               AND m2.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_members.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 3. org_credentials - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_credentials_insert ON org_credentials;
CREATE POLICY org_credentials_insert ON org_credentials
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_credentials.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
  );

DROP POLICY IF EXISTS org_credentials_update ON org_credentials;
CREATE POLICY org_credentials_update ON org_credentials
  FOR UPDATE
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_credentials.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- 4. org_team_credentials - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_team_credentials_insert ON org_team_credentials;
CREATE POLICY org_team_credentials_insert ON org_team_credentials
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_teams t
              JOIN org_members m ON m.org_id = t.org_id
             WHERE t.id = org_team_credentials.team_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM org_teams t
                 JOIN organizations o ON o.id = t.org_id
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE t.id = org_team_credentials.team_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

DROP POLICY IF EXISTS org_team_credentials_update ON org_team_credentials;
CREATE POLICY org_team_credentials_update ON org_team_credentials
  FOR UPDATE
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_teams t
              JOIN org_members m ON m.org_id = t.org_id
             WHERE t.id = org_team_credentials.team_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM org_teams t
                 JOIN organizations o ON o.id = t.org_id
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE t.id = org_team_credentials.team_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 5. org_invitations - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_invitations_insert ON org_invitations;
CREATE POLICY org_invitations_insert ON org_invitations
  FOR INSERT
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

DROP POLICY IF EXISTS org_invitations_update ON org_invitations;
CREATE POLICY org_invitations_update ON org_invitations
  FOR UPDATE
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
-- 6. org_tool_allowlist - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_tool_allowlist_insert ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_insert ON org_tool_allowlist
  FOR INSERT
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

DROP POLICY IF EXISTS org_tool_allowlist_update ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_update ON org_tool_allowlist
  FOR UPDATE
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
-- 7. org_server_access - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS org_server_access_insert ON org_server_access;
CREATE POLICY org_server_access_insert ON org_server_access
  FOR INSERT
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

DROP POLICY IF EXISTS org_server_access_update ON org_server_access;
CREATE POLICY org_server_access_update ON org_server_access
  FOR UPDATE
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
-- 8. admin_audit_log - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS admin_audit_log_insert ON admin_audit_log;
CREATE POLICY admin_audit_log_insert ON admin_audit_log
  FOR INSERT
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

DROP POLICY IF EXISTS admin_audit_log_update ON admin_audit_log;
CREATE POLICY admin_audit_log_update ON admin_audit_log
  FOR UPDATE
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
-- 9. request_log - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS request_log_insert ON request_log;
CREATE POLICY request_log_insert ON request_log
  FOR INSERT
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

DROP POLICY IF EXISTS request_log_update ON request_log;
CREATE POLICY request_log_update ON request_log
  FOR UPDATE
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
-- 10. credentials - INSERT/UPDATE WITH CHECK (personal table)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS credentials_insert ON credentials;
CREATE POLICY credentials_insert ON credentials
  FOR INSERT
  WITH CHECK (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  );

DROP POLICY IF EXISTS credentials_update ON credentials;
CREATE POLICY credentials_update ON credentials
  FOR UPDATE
  WITH CHECK (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  );

-- ---------------------------------------------------------------------------
-- 11. reseller_members - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS reseller_members_insert ON reseller_members;
CREATE POLICY reseller_members_insert ON reseller_members
  FOR INSERT
  WITH CHECK (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm2
                WHERE rm2.reseller_org_id = reseller_members.reseller_org_id
                  AND rm2.user_id = current_setting('conduit.current_user_id', true)
                  AND rm2.role IN ('reseller_owner', 'reseller_admin'))
  );

DROP POLICY IF EXISTS reseller_members_update ON reseller_members;
CREATE POLICY reseller_members_update ON reseller_members
  FOR UPDATE
  WITH CHECK (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm2
                WHERE rm2.reseller_org_id = reseller_members.reseller_org_id
                  AND rm2.user_id = current_setting('conduit.current_user_id', true)
                  AND rm2.role IN ('reseller_owner', 'reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 12. reseller_shared_vendor_grants - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS reseller_shared_vendor_grants_insert ON reseller_shared_vendor_grants;
CREATE POLICY reseller_shared_vendor_grants_insert ON reseller_shared_vendor_grants
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_shared_vendor_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true)
               AND rm.role IN ('reseller_owner', 'reseller_admin'))
  );

DROP POLICY IF EXISTS reseller_shared_vendor_grants_update ON reseller_shared_vendor_grants;
CREATE POLICY reseller_shared_vendor_grants_update ON reseller_shared_vendor_grants
  FOR UPDATE
  WITH CHECK (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_shared_vendor_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true)
               AND rm.role IN ('reseller_owner', 'reseller_admin'))
  );

-- ---------------------------------------------------------------------------
-- 13. reseller_support_grants - INSERT/UPDATE WITH CHECK
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS reseller_support_grants_insert ON reseller_support_grants;
CREATE POLICY reseller_support_grants_insert ON reseller_support_grants
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_support_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true)
               AND rm.role IN ('reseller_owner', 'reseller_admin'))
  );

DROP POLICY IF EXISTS reseller_support_grants_update ON reseller_support_grants;
CREATE POLICY reseller_support_grants_update ON reseller_support_grants
  FOR UPDATE
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

COMMIT;

-- =============================================================================
-- End of 014_rls_with_check_clauses.sql
-- =============================================================================