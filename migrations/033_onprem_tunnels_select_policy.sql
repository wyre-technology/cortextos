-- =============================================================================
-- Migration:      033_onprem_tunnels_select_policy.sql
-- Date:           2026-05-21
-- Ticket:         On-prem stream PR #2 — §4 step 6 (RLS SELECT policy on
--                 onprem_tunnels, deferred from PR #1 / migration 032).
--
-- Purpose:
--   Add the request-path SELECT policy on `onprem_tunnels` that PR #1
--   deliberately deferred. PR #1 left the table RLS-ENABLED + FORCED with
--   ZERO policies — deny-by-default — because nothing on the request path
--   touched the table in M1. PR #2 introduces the cloud-gateway routing
--   read: an authenticated `/v1/mcp` request now triggers a check for
--   "does this subtenant have a live on-prem tunnel?" — and that read runs
--   request-path (NOBYPASSRLS as `conduit_request`).
--
-- RLS model — who may see which onprem_tunnels rows:
--   A subtenant's tunnel may be SEEN BY:
--     (1) Members of the subtenant's own org (any role) — `conduit_is_member_of_org`.
--     (2) Reseller members linked to the subtenant's PARENT org (any reseller role) —
--         `conduit_is_reseller_member_of_parent`. Same shape as request_log_select
--         after migration 030: a reseller dashboard / routing flow for a customer
--         org must see the customer's on-prem tunnel.
--
--   Same predicate shape warden flagged at scope-stage for this PR: reseller/
--   owner-scoped, NOT user-id-only. Two SECURITY DEFINER helpers from the
--   existing reseller/member helpers (migrations 018 + 030) are reused; this
--   migration is a pure policy add — no new helper, no schema change.
--
--   The system (migration / relay / cloud-gateway-system-path) role is
--   BYPASSRLS, so the relay's tunnel-registry writes + the cloud-gateway's
--   future system-path reads (if any) are unaffected by this policy.
--
--   No INSERT/UPDATE/DELETE request-path policies are added — the table is
--   relay-managed; only the relay (system-path) writes. Request-path writes
--   stay deny-by-default for the foreseeable future.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- SELECT — a tunnel row is visible to (org members of its subtenant) OR
-- (reseller members of its subtenant's parent). The two-branch shape mirrors
-- request_log_select (migration 030) and uses the same helpers.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS onprem_tunnels_select ON onprem_tunnels;
CREATE POLICY onprem_tunnels_select ON onprem_tunnels
  FOR SELECT
  USING (
    conduit_is_member_of_org(
      current_setting('conduit.current_user_id', true),
      onprem_tunnels.subtenant_id
    )
    OR
    conduit_is_reseller_member_of_parent(
      current_setting('conduit.current_user_id', true),
      onprem_tunnels.subtenant_id
    )
  );

COMMIT;

-- =============================================================================
-- End of 033_onprem_tunnels_select_policy.sql
-- =============================================================================
