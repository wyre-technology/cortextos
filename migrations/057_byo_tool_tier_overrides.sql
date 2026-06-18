-- =============================================================================
-- Migration:      057_byo_tool_tier_overrides.sql
-- Date:           2026-06-18
-- Ticket:         WYREAI-191 (BYOMCP registration UI — manual owner-override of
--                 a BYO tool's auto-classified permission tier; folds in the
--                 deferred-from-190 per-tool tier-pin)
--
-- Purpose:
--   The 190 classifier auto-derives a read/write/admin tier for each discovered
--   BYO tool. The owner may disagree (a custom server's `run_report` might be a
--   write the heuristic over-restricts, or a benign-named tool might actually be
--   destructive). This table stores per-(owner, server, tool) MANUAL tier pins
--   that win over the auto-classification. Absence of a row = use the auto tier.
--
--   FORCE ROW LEVEL SECURITY scoped to `conduit.current_user_id` — owner-only,
--   same predicate as byo_mcp_servers / byo_oauth_states. One tenant can never
--   read or change another's tier pins. The `tier` value is constrained to the
--   exact PermissionTier domain (read/write/admin) so a bad write can't smuggle
--   an out-of-model tier past the gate.
--
--   Request-path privileges (conduit_request, NOBYPASSRLS) are granted
--   automatically by migration 029's ALTER DEFAULT PRIVILEGES — no GRANT here.
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS +
--   CREATE POLICY. Re-runnable.
-- Rollback: forward-only project convention. To revert, DROP TABLE
--   byo_tool_tier_overrides (its policies cascade).
-- =============================================================================

CREATE TABLE IF NOT EXISTS byo_tool_tier_overrides (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  byo_server_id  TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  tier           TEXT NOT NULL CHECK (tier IN ('read', 'write', 'admin')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One pin per (owner, server, tool). Upsert target.
  UNIQUE (user_id, byo_server_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_byo_tool_tier_overrides_server
  ON byo_tool_tier_overrides (user_id, byo_server_id);

ALTER TABLE byo_tool_tier_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE byo_tool_tier_overrides FORCE  ROW LEVEL SECURITY;

-- Tenant isolation — owner-only, same predicate as byo_mcp_servers.
DROP POLICY IF EXISTS byo_tool_tier_overrides_select ON byo_tool_tier_overrides;
CREATE POLICY byo_tool_tier_overrides_select ON byo_tool_tier_overrides
  FOR SELECT
  USING (byo_tool_tier_overrides.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_tool_tier_overrides_insert ON byo_tool_tier_overrides;
CREATE POLICY byo_tool_tier_overrides_insert ON byo_tool_tier_overrides
  FOR INSERT
  WITH CHECK (byo_tool_tier_overrides.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_tool_tier_overrides_update ON byo_tool_tier_overrides;
CREATE POLICY byo_tool_tier_overrides_update ON byo_tool_tier_overrides
  FOR UPDATE
  USING (byo_tool_tier_overrides.user_id = current_setting('conduit.current_user_id', true))
  WITH CHECK (byo_tool_tier_overrides.user_id = current_setting('conduit.current_user_id', true));

-- DELETE policy is load-bearing: clearing a pin (revert to auto) is a DELETE,
-- which under FORCE RLS would match 0 rows without this (the #67 lesson).
DROP POLICY IF EXISTS byo_tool_tier_overrides_delete ON byo_tool_tier_overrides;
CREATE POLICY byo_tool_tier_overrides_delete ON byo_tool_tier_overrides
  FOR DELETE
  USING (byo_tool_tier_overrides.user_id = current_setting('conduit.current_user_id', true));
