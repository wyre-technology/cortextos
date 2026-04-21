-- =============================================================================
-- Migration:      011_hash_invitation_tokens.sql
-- Date:           2026-04-20
-- PRD Reference:  prd-onboarding.md §7.1 (invite token storage),
--                 §8.4 (SOC2 invariant: no plaintext tokens at rest),
--                 §A.19 acceptance criterion ("a DB snapshot contains no
--                 plaintext token").
--                 Taskmaster tag `onboarding` / Task #3.
--                 Upstream reference: mcp-gateway commit e94835d
--                 (fix/hash-invitation-tokens).
--
-- Purpose:
--   Add SHA-256 hash-at-rest storage for org_invitations tokens. This is
--   phase 1 of an expand/backfill/contract rollout:
--
--     1. Add `token_hash TEXT` column (nullable during dual-write phase).
--     2. Add `token_hash_algo TEXT DEFAULT 'sha256'` so any future rotation
--        to a stronger hash (e.g. HMAC-SHA-256 with a server-side pepper)
--        can be distinguished at lookup time.
--     3. Index `token_hash` to support the lookup path InvitationService
--        switches to in this same task.
--
--   The plaintext `token` column is intentionally NOT dropped here. The
--   invitation service dual-writes (hash + plaintext) during this migration
--   so that:
--     - Outstanding invitations created before rollout continue to resolve
--       via the plaintext column for their remaining validity window
--       (7 days default, see InvitationService.createInvitation).
--     - Any rollback to the pre-hash code path does not brick accepted-at
--       joins.
--
--   A follow-up task will (a) verify all outstanding invitations have
--   a token_hash, (b) switch lookups to hash-only, and (c) drop the
--   plaintext token column and its UNIQUE constraint in migration 012.
--
-- Scope note — no backfill here:
--   Existing rows get NULL token_hash. InvitationService lookup tries
--   token_hash first and falls back to plaintext token match, so pre-
--   existing invitations continue to work until their natural expiry.
--   A backfill of the hash for existing rows is deliberately omitted —
--   the plaintext tokens in the DB ARE the SOC 2 finding we're remediating,
--   so hashing them in-place would leak them into PG wal/audit. They will
--   age out naturally within `expires_at` (max 7 days from issue).
--
-- Idempotency:
--   ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DO-block guards
--   where needed. Safe to re-run.
--
-- Rollback Notes:
--   Forward-only. If you must revert: drop idx_org_invitations_token_hash,
--   drop token_hash and token_hash_algo columns. Outstanding invitations
--   remain valid via their plaintext `token` column.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. org_invitations.token_hash (PRD §7.1)
-- ---------------------------------------------------------------------------
ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- ---------------------------------------------------------------------------
-- 2. org_invitations.token_hash_algo (PRD §8.4 — allow future rotation)
-- ---------------------------------------------------------------------------
ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS token_hash_algo TEXT NOT NULL DEFAULT 'sha256';

-- Constrain algo values to the set the service understands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'org_invitations_token_hash_algo_check'
       AND conrelid = 'org_invitations'::regclass
  ) THEN
    ALTER TABLE org_invitations
      ADD CONSTRAINT org_invitations_token_hash_algo_check
      CHECK (token_hash_algo IN ('sha256'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Index on token_hash — the new lookup path.
-- ---------------------------------------------------------------------------
-- Partial index: rows created pre-rollout have NULL token_hash and are
-- looked up via the legacy plaintext column, so they don't need the index.
CREATE INDEX IF NOT EXISTS idx_org_invitations_token_hash
  ON org_invitations (token_hash)
  WHERE token_hash IS NOT NULL;

COMMIT;

-- =============================================================================
-- End of 011_hash_invitation_tokens.sql
-- =============================================================================
