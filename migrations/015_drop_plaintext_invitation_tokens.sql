-- =============================================================================
-- Migration:      015_drop_plaintext_invitation_tokens.sql
-- Date:           2026-04-28
-- PRD Reference:  prd-onboarding.md §8.4 acceptance criteria A.19,
--                 overnight status 04-21 follow-up item
-- Ticket:         reseller-tenancy / Task #18 follow-up
--
-- Purpose:
--   Complete the hash-invitation-tokens rollout by dropping the plaintext
--   `token` column from org_invitations. This is phase 3 of the expand/
--   backfill/contract migration pattern started in 011.
--
--   Phase 1 (011): Added token_hash column with dual-write
--   Phase 2 (implicit): Service uses token_hash with plaintext fallback
--   Phase 3 (this): Drop plaintext column after verification
--
-- Prerequisites:
--   - All invitation lookups must use token_hash (verified in service code)
--   - All active invitations must have token_hash populated OR have expired
--   - No production code should reference the `token` column directly
--
-- Safety checks:
--   - Verify no active invitations rely on plaintext token before dropping
--   - Update invitation service to remove fallback logic
--   - Drop unique constraint on token before dropping column
--
-- Rollback Notes:
--   This is a destructive operation. If rollback is needed:
--   1. Re-add token TEXT column
--   2. Re-add unique constraint
--   3. Update service to dual-write again
--   4. Regenerate tokens for any active invitations
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Safety check: ensure no active invitations depend on plaintext token
-- ---------------------------------------------------------------------------

-- Count active invitations without token_hash that haven't expired
DO $$
DECLARE
  legacy_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO legacy_count
  FROM org_invitations
  WHERE token_hash IS NULL
    AND expires_at > NOW()
    AND (max_uses IS NULL OR use_count < max_uses);

  IF legacy_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop plaintext token column: % active invitations still lack token_hash', legacy_count;
  END IF;

  RAISE NOTICE 'Safety check passed: no active invitations depend on plaintext token';
END$$;

-- ---------------------------------------------------------------------------
-- 2. Drop the plaintext token column (and dependent constraints / indexes)
-- ---------------------------------------------------------------------------
--
-- DROP COLUMN ... CASCADE removes the column AND any constraints (UNIQUE,
-- NOT NULL) and indexes that reference only this column in a single atomic
-- statement. The runtime initTables created `token TEXT NOT NULL UNIQUE`
-- (auto-named `org_invitations_token_key`) plus `idx_org_invitations_token`;
-- both are dropped by CASCADE.
--
-- The original draft of this migration tried to look the constraint name
-- up in `pg_constraint` and DROP it explicitly before the column DROP. The
-- lookup query was malformed (two FROM clauses) and would have errored at
-- deploy time. CASCADE achieves the same end state without the lookup.

ALTER TABLE org_invitations DROP COLUMN IF EXISTS token CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Service-side coordination (already shipped)
-- ---------------------------------------------------------------------------
--
-- The `InvitationService.getInvitationByToken()` dual-read fallback that
-- this migration retires was removed in PR #61
-- (`refactor(invitations): contract-phase change for 015`). After PR #61
-- merged, the runtime service was already off the plaintext column —
-- this migration's column drop is therefore safe by construction at the
-- service layer; the only remaining concern (legacy NULL `token_hash`
-- rows) is handled by the safety check above and by the pre-migration
-- backfill (`scripts/backfill-invitation-tokens.ts`, run via
-- `npm run backfill:invitation-tokens`).

COMMIT;

-- =============================================================================
-- End of 015_drop_plaintext_invitation_tokens.sql
-- =============================================================================