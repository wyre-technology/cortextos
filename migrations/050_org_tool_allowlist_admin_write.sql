-- =============================================================================
-- Migration:      050_org_tool_allowlist_admin_write.sql
-- Date:           2026-06-09
-- Ticket:         WYREAI-66 (warden hardening — admin-only allowlist writes)
--
-- Purpose:
--   Move admin-only enforcement for org_tool_allowlist writes INTO the RLS
--   layer. Today the INSERT (014) and UPDATE (022) WITH CHECK / USING clauses
--   admit ANY org member:
--
--       EXISTS (SELECT 1 FROM org_members m
--                WHERE m.org_id = org_tool_allowlist.org_id
--                  AND m.user_id = current_setting('conduit.current_user_id', true))
--
--   i.e. a plain 'member' could write a tool allowlist at the database layer.
--   The application gate (tool-access-routes.ts) already requires the 'owner'
--   role via requireOrgRole(..., 'owner'), so RLS was strictly looser than the
--   app — a defense-in-depth gap the warden flagged: if a future code path
--   writes org_tool_allowlist without going through that route, RLS would not
--   stop a non-admin.
--
--   This migration tightens the org-member branch to the administrative tier
--   (role IN ('owner','admin')) via a SECURITY DEFINER helper, and reuses the
--   existing conduit_is_reseller_admin_of_parent helper (018) for the
--   cross-org reseller-admin branch. The reseller branch is unchanged in
--   meaning — only re-expressed through the helper for consistency.
--
--   Not a behavior change for legitimate writers: the app only ever issues
--   these writes as an org 'owner', and owner ∈ {owner, admin}, so every write
--   the app performs today still passes. What changes is that a hypothetical
--   non-admin DB write is now rejected by RLS, not just by the route.
--
-- Helper shape:
--   Mirrors 018's SECURITY DEFINER helpers exactly — LANGUAGE sql, STABLE,
--   SET search_path pinned, returns only a boolean (no row leak). Runs as the
--   owner so its single org_members lookup does not itself trip FORCE RLS on
--   org_members (which would re-evaluate org_members_select per row).
--
-- Idempotency:
--   CREATE OR REPLACE FUNCTION; DROP POLICY IF EXISTS + CREATE POLICY. Re-runnable.
--
-- Rollback Notes:
--   Forward-only project convention. To revert, restore the any-member branch
--   from 014/022 (re-introducing the warden gap). Don't.
-- =============================================================================

-- "owner or admin of <org>." The administrative tier for org-scoped writes.
CREATE OR REPLACE FUNCTION conduit_is_org_admin(p_user_id text, p_org_id text)
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
      AND role IN ('owner', 'admin')
  );
$$;

-- INSERT: administrative org member, or reseller-admin of the parent.
DROP POLICY IF EXISTS org_tool_allowlist_insert ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_insert ON org_tool_allowlist
  FOR INSERT
  WITH CHECK (
    conduit_is_org_admin(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
    OR conduit_is_reseller_admin_of_parent(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
  );

-- UPDATE: USING (which existing rows are visible to update) AND WITH CHECK
-- (what the updated row may look like) both gated to the administrative tier,
-- matching the 022 shape.
DROP POLICY IF EXISTS org_tool_allowlist_update ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_update ON org_tool_allowlist
  FOR UPDATE
  USING (
    conduit_is_org_admin(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
    OR conduit_is_reseller_admin_of_parent(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
  )
  WITH CHECK (
    conduit_is_org_admin(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
    OR conduit_is_reseller_admin_of_parent(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
  );
