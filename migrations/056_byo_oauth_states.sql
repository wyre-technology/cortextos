-- =============================================================================
-- Migration:      056_byo_oauth_states.sql
-- Date:           2026-06-18
-- Ticket:         WYREAI-187 (BYOMCP — OAuth route increment; the PKCE flow
--                 state that must survive the authorize→callback redirect for a
--                 user-supplied MCP server)
--
-- Purpose:
--   Persistent backing store for an in-flight BYO OAuth (auth-code + PKCE) flow.
--   The authorize step and the callback can land on different replicas, so the
--   per-flow secrets cannot live in process memory — they live here, keyed by an
--   opaque single-use state token, and are consumed (DELETE ... RETURNING) on
--   callback. Models `vendor_oauth_flow_states` (migration 017) but carries the
--   BYO-specific link: which byo_mcp_servers row the flow is connecting, plus the
--   dynamically-registered (RFC 7591) client_id, with the PKCE code_verifier and
--   the confidential client_secret encrypted at rest (AES-GCM, scope-bound to the
--   owner's user_id) exactly like credentials/byo_mcp_servers.
--
--   FORCE ROW LEVEL SECURITY scoped to `conduit.current_user_id` — a flow state
--   is visible/consumable ONLY by the user who started it, so one tenant can
--   never consume another's in-flight OAuth state (the BYOMCP hard-isolation
--   invariant, same predicate as byo_mcp_servers).
--
--   Request-path privileges (conduit_request, NOBYPASSRLS) are granted
--   automatically by migration 029's ALTER DEFAULT PRIVILEGES — no GRANT here.
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS; DROP POLICY IF EXISTS +
--   CREATE POLICY. Re-runnable.
-- Rollback: forward-only project convention. To revert, DROP TABLE
--   byo_oauth_states (its policies cascade).
-- =============================================================================

CREATE TABLE IF NOT EXISTS byo_oauth_states (
  state_token              TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  byo_server_id            TEXT NOT NULL,
  client_id                TEXT NOT NULL,
  -- Encrypted blob = JSON { codeVerifier, clientSecret? }. Both are flow
  -- secrets; client_id is not secret and stays plaintext for debuggability.
  encrypted_data           TEXT NOT NULL,
  iv                       TEXT NOT NULL,
  auth_tag                 TEXT NOT NULL,
  salt                     TEXT NOT NULL,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_byo_oauth_states_user ON byo_oauth_states (user_id);
CREATE INDEX IF NOT EXISTS idx_byo_oauth_states_expires ON byo_oauth_states (expires_at);

ALTER TABLE byo_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE byo_oauth_states FORCE  ROW LEVEL SECURITY;

-- Tenant isolation — owner-only, same predicate as byo_mcp_servers.
DROP POLICY IF EXISTS byo_oauth_states_select ON byo_oauth_states;
CREATE POLICY byo_oauth_states_select ON byo_oauth_states
  FOR SELECT
  USING (byo_oauth_states.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_oauth_states_insert ON byo_oauth_states;
CREATE POLICY byo_oauth_states_insert ON byo_oauth_states
  FOR INSERT
  WITH CHECK (byo_oauth_states.user_id = current_setting('conduit.current_user_id', true));

DROP POLICY IF EXISTS byo_oauth_states_update ON byo_oauth_states;
CREATE POLICY byo_oauth_states_update ON byo_oauth_states
  FOR UPDATE
  USING (byo_oauth_states.user_id = current_setting('conduit.current_user_id', true))
  WITH CHECK (byo_oauth_states.user_id = current_setting('conduit.current_user_id', true));

-- DELETE policy is load-bearing: consume() is a DELETE ... RETURNING. Without
-- it, under FORCE RLS the consume would match 0 rows and every callback would
-- fail (the org_tool_allowlist #67 lesson).
DROP POLICY IF EXISTS byo_oauth_states_delete ON byo_oauth_states;
CREATE POLICY byo_oauth_states_delete ON byo_oauth_states
  FOR DELETE
  USING (byo_oauth_states.user_id = current_setting('conduit.current_user_id', true));
