-- =============================================================================
-- Migration:      051_org_tool_allowlist_delete_policy.sql
-- Date:           2026-06-09
-- Ticket:         WYREAI-67 (warden hardening — no RLS DELETE coverage)
--
-- Purpose:
--   org_tool_allowlist has SELECT (007), INSERT (014), and UPDATE (022)
--   policies, but NO DELETE policy. The table is FORCE ROW LEVEL SECURITY
--   (007), and under FORCE RLS a command with no matching policy is denied —
--   so under the NOBYPASSRLS request role, DELETE FROM org_tool_allowlist
--   matches zero rows for every caller.
--
--   That makes this both a hardening gap and a latent correctness bug: the
--   "clear allowlist (revert to allow-all)" path —
--   DELETE /api/orgs/:orgId/tool-access/:vendor/:role -> clearToolAllowlist()
--   -> DELETE FROM org_tool_allowlist — silently deletes nothing once prod
--   runs under the request role, so a cleared allowlist would still enforce.
--
--   Add a DELETE policy gated to the same administrative tier as the
--   INSERT/UPDATE policies (050): org owner/admin, or reseller-admin of the
--   parent org. The application DELETE route already requires the 'owner' role
--   (requireOrgRole(..., 'owner')), and owner ∈ {owner, admin}, so every clear
--   the app performs passes; a non-admin DB delete is rejected by RLS.
--
-- Idempotency:
--   DROP POLICY IF EXISTS + CREATE POLICY. Re-runnable. Depends on the helpers
--   conduit_is_org_admin (050) and conduit_is_reseller_admin_of_parent (018).
--
-- Rollback Notes:
--   Forward-only project convention. To revert, DROP POLICY
--   org_tool_allowlist_delete (restoring the deny-all-deletes gap). Don't.
-- =============================================================================

DROP POLICY IF EXISTS org_tool_allowlist_delete ON org_tool_allowlist;
CREATE POLICY org_tool_allowlist_delete ON org_tool_allowlist
  FOR DELETE
  USING (
    conduit_is_org_admin(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
    OR conduit_is_reseller_admin_of_parent(
      current_setting('conduit.current_user_id', true),
      org_tool_allowlist.org_id
    )
  );
