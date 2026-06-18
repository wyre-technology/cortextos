-- =============================================================================
-- Migration:      055_byo_mcp_servers.sql
-- Date:           2026-06-18
-- Ticket:         WYREAI-188 (BYOMCP — RLS-scoped storage for user-supplied
--                 MCP servers; foundation of the 186→191 chain)
--
-- Purpose:
--   Per-user storage for "bring your own" (non-catalog) MCP servers: the
--   endpoint URL + transport + the user's auth headers (encrypted at rest with
--   the same AES-GCM scheme as `credentials`). Mirrors the `credentials` model
--   exactly — FORCE ROW LEVEL SECURITY scoped to `conduit.current_user_id`, so
--   a BYO server is visible/writable/deletable ONLY by its owner. One tenant's
--   BYO server can never be discovered or called by another (the BYOMCP epic's
--   hard isolation invariant).
--
--   Request-path privileges (conduit_request, NOBYPASSRLS) are granted
--   automatically by migration 029's ALTER DEFAULT PRIVILEGES — no GRANT here.
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS +
--   CREATE POLICY. Re-runnable.
-- Rollback: forward-only project convention. To revert, DROP TABLE
--   byo_mcp_servers (and its policies cascade).
-- =============================================================================

CREATE TABLE IF NOT EXISTS byo_mcp_servers (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  endpoint_url   TEXT NOT NULL,
  transport      TEXT NOT NULL DEFAULT 'streamable-http',
  encrypted_data TEXT NOT NULL,
  iv             TEXT NOT NULL,
  auth_tag       TEXT NOT NULL,
  salt           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_byo_mcp_servers_user ON byo_mcp_servers (user_id);

ALTER TABLE byo_mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE byo_mcp_servers FORCE  ROW LEVEL SECURITY;

-- Tenant isolation — owner-only, same predicate as credentials_*.
DROP POLICY IF EXISTS byo_mcp_servers_select ON byo_mcp_servers;
CREATE POLICY byo_mcp_servers_select ON byo_mcp_servers
  FOR SELECT
  USING (byo_mcp_servers.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_mcp_servers_insert ON byo_mcp_servers;
CREATE POLICY byo_mcp_servers_insert ON byo_mcp_servers
  FOR INSERT
  WITH CHECK (byo_mcp_servers.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_mcp_servers_update ON byo_mcp_servers;
CREATE POLICY byo_mcp_servers_update ON byo_mcp_servers
  FOR UPDATE
  USING (byo_mcp_servers.user_id = current_setting('conduit.current_user_id', true))
  WITH CHECK (byo_mcp_servers.user_id = current_setting('conduit.current_user_id', true));

-- DELETE policy included from the start (the org_tool_allowlist #67 lesson: no
-- DELETE policy under FORCE RLS = deletes silently match 0 rows).
DROP POLICY IF EXISTS byo_mcp_servers_delete ON byo_mcp_servers;
CREATE POLICY byo_mcp_servers_delete ON byo_mcp_servers
  FOR DELETE
  USING (byo_mcp_servers.user_id = current_setting('conduit.current_user_id', true));
