import { createHash } from 'node:crypto';

/**
 * Hash an invitation token for at-rest storage and lookup.
 *
 * SOC2 invariant (PRD §8.4 / §A.19): the plaintext token never persists
 * to disk. Only the hash lives in the DB. Lookup is by hash only —
 * `InvitationService.getInvitationByToken` recomputes this hash from the
 * incoming plaintext and selects on `token_hash`.
 *
 * Shared between:
 *   - `InvitationService.createInvitation` / `getInvitationByToken`
 *   - `scripts/backfill-invitation-tokens.ts` (the pre-migration backfill
 *     that hashes any pre-011 / dual-write-era plaintext rows before
 *     migration 015 drops the plaintext column)
 *
 * Drift between the service hash and the backfill hash would be a silent
 * miss at user-click time, hard to diagnose. Keep this file the single
 * source of truth.
 *
 * Algorithm: SHA-256 hex. Distinguished from any future rotation
 * (e.g. HMAC-SHA-256 with server-side pepper) by the `token_hash_algo`
 * column added in migration 011.
 */
export function hashInvitationToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
