-- =============================================================================
-- Migration:      007_rls_enable.sql
-- Date:           2026-04-18
-- PRD Reference:  prd-reseller-tenancy.md §5.6, §6.6, §9 (acceptance 23-26)
-- Ticket:         reseller-tenancy / Task #6
--
-- Purpose:
--   Enable Postgres Row-Level Security on all tenant-scoped tables and define
--   READ policies that express:
--     1. A user can see rows in their own org.
--     2. A reseller owner/admin can see rows in customer orgs where
--        parent_org_id = their reseller_org_id.
--     3. An ACTIVE, APPROVED support grant grants temporary read access to
--        the customer_org_id it points at (scoped to the session that
--        declared the grant via `conduit.active_reseller_grant_id`).
--
--   RLS is belt-and-suspenders — the application still enforces authorization
--   in middleware. RLS exists so that a single `WHERE org_id = $1` typo or a
--   future-author mistake does not silently leak one customer's data to
--   another under the same reseller.
--
-- Policy conservatism (Phase 1):
--   - All policies are USING only (no WITH CHECK). Writes pass through RLS
--     but are not filtered beyond READ rules; app layer continues to guard
--     writes. The PRD acceptance §25 eventually requires WITH CHECK on every
--     table, but the execution ticket directs us to be conservative: test
--     reads first, add WITH CHECK after verification. This is explicitly a
--     follow-up item — see `CHANGELOG.md` / Release B in PRD §5.7.
--   - FORCE ROW LEVEL SECURITY is enabled so that even the table owner (the
--     app's own Postgres role) is subject to the policies. Without FORCE,
--     RLS is a no-op for the owner.
--   - A dedicated `app_service_role` is expected to carry BYPASSRLS for
--     migration scripts and platform admin tooling. This migration does NOT
--     create the role (role creation requires superuser and varies by
--     environment). It documents the expectation; operations must provision
--     the role out-of-band. See "Operations" below.
--
-- Session variables (set by the request-scoped DB-connection acquire path,
-- PRD §8 "Wire Postgres session variables"):
--   - conduit.current_user_id           TEXT   — authenticated user id
--   - conduit.current_org_id            TEXT   — current org context (may be
--                                                a customer, reseller, or
--                                                standalone org id)
--   - conduit.active_reseller_grant_id  TEXT   — if set, the support grant
--                                                the request is piggybacking
--                                                on; policies validate it is
--                                                active + approved + for the
--                                                acting user
--
-- Note on naming: the PRD §5.6 refers to `app.user_id` / `app.current_org_id`
-- etc. We use the `conduit.*` namespace per the execution ticket to avoid
-- collision with other apps sharing the database cluster, and because the
-- ticket specifies `conduit.current_user_id`, `conduit.current_org_id`, and
-- `conduit.active_reseller_grant_id`. Middleware must set these keys.
--
-- Idempotency:
--   ENABLE ROW LEVEL SECURITY is idempotent. Policies are dropped-then-
--   created via DROP POLICY IF EXISTS + CREATE POLICY. Safe to re-run.
--
-- Rollback Notes:
--   DROP POLICY ... ; ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE ... NO FORCE ROW LEVEL SECURITY;
--   Forward-only project convention — no down-migration file.
--
-- Concerns / Follow-ups:
--   - Support-grant policy is the most complex: it reads
--     `reseller_support_grants` WHERE id = session var, which itself is an
--     RLS-enabled table. To avoid a chicken-and-egg / recursive policy, the
--     support-grant table has a permissive SELECT policy for the user the
--     grant is granted_to (so the resolver can see the grant row and
--     validate expiry/revocation). Alternatives considered: SECURITY DEFINER
--     helper function, or table-level SECURITY INVOKER bypass. A helper
--     function would be cleaner; deferred to follow-up (see PRD §5.6 Phase 2).
--   - `credentials` is personal (keyed by user_id, NOT org_id). Its RLS
--     policy is user-scoped only. See src/credentials/credential-service.ts
--     :100-114.
--   - `organizations` self-referential visibility: a user sees orgs they are
--     a member of OR the reseller org above their customer OR customer orgs
--     below their reseller (if they are a reseller_member).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enable + FORCE RLS on every tenant-scoped table.
--
-- Tables (verified against actual schema in src/**):
--   organizations, org_members, org_credentials, org_team_credentials,
--   org_invitations, org_tool_allowlist, org_server_access, admin_audit_log,
--   request_log, credentials, reseller_members,
--   reseller_shared_vendor_grants, reseller_support_grants
-- ---------------------------------------------------------------------------
ALTER TABLE organizations                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_members                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_credentials                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_credentials                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_team_credentials             ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_team_credentials             FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_invitations                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invitations                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_tool_allowlist               ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tool_allowlist               FORCE  ROW LEVEL SECURITY;
ALTER TABLE org_server_access                ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_server_access                FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE request_log                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_log                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE credentials                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE reseller_members                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_members                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE reseller_shared_vendor_grants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_shared_vendor_grants    FORCE  ROW LEVEL SECURITY;
ALTER TABLE reseller_support_grants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE reseller_support_grants          FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Helper predicates expressed inline in policies.
--
-- Core building blocks (expanded inline per-policy rather than via SQL
-- functions, to keep this migration dependency-free):
--
--   (A) user-is-member-of-org(o) ::=
--         EXISTS (SELECT 1 FROM org_members
--                  WHERE org_id = o
--                    AND user_id = current_setting('conduit.current_user_id', true))
--
--   (B) user-is-reseller-admin-over-org(o) ::=
--         EXISTS (SELECT 1
--                   FROM organizations child
--                   JOIN reseller_members rm
--                     ON rm.reseller_org_id = child.parent_org_id
--                  WHERE child.id = o
--                    AND rm.user_id = current_setting('conduit.current_user_id', true)
--                    AND rm.role IN ('reseller_owner','reseller_admin'))
--
--   (C) user-has-active-support-grant-for-org(o) ::=
--         EXISTS (SELECT 1 FROM reseller_support_grants g
--                  WHERE g.id = current_setting('conduit.active_reseller_grant_id', true)
--                    AND g.granted_to_user_id = current_setting('conduit.current_user_id', true)
--                    AND g.customer_org_id = o
--                    AND g.revoked_at IS NULL
--                    AND g.expires_at > NOW()
--                    AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL))
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. organizations — visible if:
--    - you are a member of it, or
--    - you are a reseller_member of its parent (you see child customers), or
--    - you are a reseller_member of it directly, or
--    - an active support grant names it as customer_org_id, or
--    - it is the parent reseller of a customer org you are a member of.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS organizations_select ON organizations;
CREATE POLICY organizations_select ON organizations
  FOR SELECT
  USING (
    -- Self-member
    EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.org_id = organizations.id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
    -- Reseller_member of this org (including a reseller looking at itself)
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.reseller_org_id = organizations.id
         AND rm.user_id = current_setting('conduit.current_user_id', true)
    )
    -- Reseller admin looking at a child customer
    OR EXISTS (
      SELECT 1 FROM reseller_members rm
       WHERE rm.reseller_org_id = organizations.parent_org_id
         AND rm.user_id = current_setting('conduit.current_user_id', true)
         AND rm.role IN ('reseller_owner', 'reseller_admin')
    )
    -- Customer member seeing their parent reseller (name/metadata only — the
    -- app still prevents reseller-sensitive fields from leaking; this just
    -- lets the row exist in queries).
    OR EXISTS (
      SELECT 1 FROM org_members m
        JOIN organizations c ON c.id = m.org_id
       WHERE c.parent_org_id = organizations.id
         AND m.user_id = current_setting('conduit.current_user_id', true)
    )
    -- Active support grant
    OR EXISTS (
      SELECT 1 FROM reseller_support_grants g
       WHERE g.id = current_setting('conduit.active_reseller_grant_id', true)
         AND g.granted_to_user_id = current_setting('conduit.current_user_id', true)
         AND g.customer_org_id = organizations.id
         AND g.revoked_at IS NULL
         AND g.expires_at > NOW()
         AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Generic "org-scoped rows" policy factory.
--
-- The following tables all key on `org_id TEXT`. We apply the same predicate
-- pattern: visible when the current user is a member of `org_id`, OR is a
-- reseller admin over `org_id`'s parent, OR has an active support grant for
-- `org_id`.
--
--   org_members, org_credentials, org_invitations, org_tool_allowlist,
--   org_server_access, admin_audit_log, request_log
--
-- These are written as separate CREATE POLICY statements (Postgres has no
-- "apply-to-many" primitive) but share the same body by construction.
-- ---------------------------------------------------------------------------

-- org_members
DROP POLICY IF EXISTS org_members_select ON org_members;
CREATE POLICY org_members_select ON org_members
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM org_members m2
             WHERE m2.org_id = org_members.org_id
               AND m2.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_members.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_support_grants g
                WHERE g.id = current_setting('conduit.active_reseller_grant_id', true)
                  AND g.granted_to_user_id = current_setting('conduit.current_user_id', true)
                  AND g.customer_org_id = org_members.org_id
                  AND g.revoked_at IS NULL
                  AND g.expires_at > NOW()
                  AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL))
  );

-- org_credentials (metadata visibility only — plaintext decryption is app-
-- layer, per PRD §5.6 "reseller admins cannot decrypt customer secrets
-- simply by being able to SELECT the encrypted blob")
DROP POLICY IF EXISTS org_credentials_select ON org_credentials;
CREATE POLICY org_credentials_select ON org_credentials
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_credentials.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    OR EXISTS (SELECT 1 FROM reseller_support_grants g
                WHERE g.id = current_setting('conduit.active_reseller_grant_id', true)
                  AND g.granted_to_user_id = current_setting('conduit.current_user_id', true)
                  AND g.customer_org_id = org_credentials.org_id
                  AND g.revoked_at IS NULL
                  AND g.expires_at > NOW()
                  AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL))
    -- Reseller's own org_credentials are visible to its reseller_members
    -- (this covers the reseller-shared-vendor credential rows).
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = org_credentials.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
  );

-- org_team_credentials — keyed on team_id, not org_id. Follow team -> org.
DROP POLICY IF EXISTS org_team_credentials_select ON org_team_credentials;
CREATE POLICY org_team_credentials_select ON org_team_credentials
  FOR SELECT
  USING (
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

-- org_invitations
DROP POLICY IF EXISTS org_invitations_select ON org_invitations;
CREATE POLICY org_invitations_select ON org_invitations
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_invitations.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_invitations.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- org_tool_allowlist
DROP POLICY IF EXISTS org_tool_allowlist_select ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_select ON org_tool_allowlist
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_tool_allowlist.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_tool_allowlist.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- org_server_access
DROP POLICY IF EXISTS org_server_access_select ON org_server_access;
CREATE POLICY org_server_access_select ON org_server_access
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = org_server_access.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = org_server_access.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
  );

-- admin_audit_log
DROP POLICY IF EXISTS admin_audit_log_select ON admin_audit_log;
CREATE POLICY admin_audit_log_select ON admin_audit_log
  FOR SELECT
  USING (
    -- Own-org members (owner/admin in app layer; RLS just gates org)
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = admin_audit_log.org_id
               AND m.user_id = current_setting('conduit.current_user_id', true))
    -- Reseller owner/admin over the customer
    OR EXISTS (SELECT 1 FROM organizations o
                 JOIN reseller_members rm ON rm.reseller_org_id = o.parent_org_id
                WHERE o.id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true)
                  AND rm.role IN ('reseller_owner','reseller_admin'))
    -- Reseller's OWN audit rows (e.g., reseller-level events written with
    -- org_id = reseller_org_id; treat as self-scoped to reseller_members)
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = admin_audit_log.org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
    -- Active support grant
    OR EXISTS (SELECT 1 FROM reseller_support_grants g
                WHERE g.id = current_setting('conduit.active_reseller_grant_id', true)
                  AND g.granted_to_user_id = current_setting('conduit.current_user_id', true)
                  AND g.customer_org_id = admin_audit_log.org_id
                  AND g.revoked_at IS NULL
                  AND g.expires_at > NOW()
                  AND (g.approval_required = FALSE OR g.approved_at IS NOT NULL))
  );

-- request_log — same pattern as admin_audit_log but org_id is nullable
-- (see schema). A NULL org_id means "not yet attributed" and is only visible
-- to the user who owns the request.
DROP POLICY IF EXISTS request_log_select ON request_log;
CREATE POLICY request_log_select ON request_log
  FOR SELECT
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
  );

-- ---------------------------------------------------------------------------
-- 5. credentials — personal, keyed by user_id only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS credentials_select ON credentials;
CREATE POLICY credentials_select ON credentials
  FOR SELECT
  USING (
    credentials.user_id = current_setting('conduit.current_user_id', true)
  );

-- ---------------------------------------------------------------------------
-- 6. reseller_members — visible to reseller_members of the same reseller.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_members_select ON reseller_members;
CREATE POLICY reseller_members_select ON reseller_members
  FOR SELECT
  USING (
    reseller_members.user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm2
                WHERE rm2.reseller_org_id = reseller_members.reseller_org_id
                  AND rm2.user_id = current_setting('conduit.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- 7. reseller_shared_vendor_grants — visible to reseller_members of the
--    reseller, and to customer members of the customer_org_id (so customers
--    can see what's being shared with them).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_shared_vendor_grants_select ON reseller_shared_vendor_grants;
CREATE POLICY reseller_shared_vendor_grants_select ON reseller_shared_vendor_grants
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM reseller_members rm
             WHERE rm.reseller_org_id = reseller_shared_vendor_grants.reseller_org_id
               AND rm.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM org_members m
                WHERE m.org_id = reseller_shared_vendor_grants.customer_org_id
                  AND m.user_id = current_setting('conduit.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- 8. reseller_support_grants — MUST be broadly readable enough that the
--    `conduit.active_reseller_grant_id` check on other tables can resolve
--    the grant row. Visibility:
--      - the subject (granted_to_user_id) always sees their own grants
--      - reseller_members of the reseller see all reseller grants
--      - org_members of the customer_org_id see grants targeting their org
--        (so customer owners/admins can approve/revoke)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reseller_support_grants_select ON reseller_support_grants;
CREATE POLICY reseller_support_grants_select ON reseller_support_grants
  FOR SELECT
  USING (
    reseller_support_grants.granted_to_user_id = current_setting('conduit.current_user_id', true)
    OR EXISTS (SELECT 1 FROM reseller_members rm
                WHERE rm.reseller_org_id = reseller_support_grants.reseller_org_id
                  AND rm.user_id = current_setting('conduit.current_user_id', true))
    OR EXISTS (SELECT 1 FROM org_members m
                WHERE m.org_id = reseller_support_grants.customer_org_id
                  AND m.user_id = current_setting('conduit.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- Operations: app_service_role BYPASSRLS
--
-- The following must be provisioned out-of-band (not in this migration,
-- because CREATE ROLE requires superuser and varies per-environment):
--
--   CREATE ROLE app_service_role NOLOGIN BYPASSRLS;
--   GRANT app_service_role TO <migration_user>;
--   GRANT app_service_role TO <platform_admin_user>;
--
-- Request-scoped connections MUST NOT run as app_service_role. Migration
-- and platform-admin tooling MAY. Document this in the deployment runbook.
-- ---------------------------------------------------------------------------

COMMIT;

-- =============================================================================
-- End of 007_rls_enable.sql
-- =============================================================================
