-- 048_org_api_keys.sql
--
-- Track C reseller-settings sweep-3 — API key registry for the
-- /org/reseller/api wizard (June 29 launch directive 2026-06-13).
--
-- v1 scope per boss msg-1781452776703: API KEYS ONLY (webhooks deferred
-- to v1.1 post-launch). Sibling-shape to migrations 045/046/047 — same
-- idempotent CREATE TABLE IF NOT EXISTS + DO $$ + pg_constraint-lookup
-- pattern.
--
-- Distinct from service_clients (mig <030 or so) on purpose:
--   * service_clients are PER-CUSTOMER-ORG M2M tokens used by AI agents
--     via OAuth client_credentials flow (oauth/authorization-server.ts).
--   * org_api_keys are PER-RESELLER-ORG admin tokens used by reseller-
--     admin scripts to call the Track C management API (resellers
--     managing their downstream customers).
--   * Different audit semantics: api_key_created / api_key_revoked vs
--     service_client_created / service_client_revoked.
--   * Different consumer (admin scripts vs M2M AI agents).
--   * Different scope (reseller-org-level vs customer-org-level).
--
-- Hash convention: sha256 (matches src/org/routes.ts:1550 service-client
-- pattern). 48-char nanoid secret provides ~288 bits of entropy — far
-- above brute-force range, so plain sha256 is appropriate. Sign-axis
-- discipline (boss msg-1781452776703): plaintext returned ONLY from the
-- create endpoint response, never from list/get — irreversibility pinned
-- by test.

CREATE TABLE IF NOT EXISTS org_api_keys (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  -- 8-char public prefix (e.g. "ck_a4f9b2") shown in lists for ops
  -- visibility. Distinct from the secret — safe to display anywhere.
  key_prefix            TEXT NOT NULL,
  -- sha256(plaintext_secret). Plaintext is returned ONCE from the create
  -- response + never persisted. No list/get/anywhere returns plaintext.
  key_secret_hash       TEXT NOT NULL,
  created_by_user_id    TEXT NOT NULL REFERENCES users(id),
  last_used_at          TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_api_keys_key_prefix_unique'
  ) THEN
    ALTER TABLE org_api_keys
      ADD CONSTRAINT org_api_keys_key_prefix_unique UNIQUE (key_prefix);
  END IF;
END $$;

-- Per-org list query (the wizard's GET /org/reseller/api lists all keys
-- for the current reseller org). FK index on org_id is auto-created;
-- explicit here is documentation + guarded IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_org_api_keys_org
  ON org_api_keys (org_id);

-- Active-only lookup (verify path skips revoked rows by-construction).
CREATE INDEX IF NOT EXISTS idx_org_api_keys_active
  ON org_api_keys (org_id) WHERE revoked_at IS NULL;
