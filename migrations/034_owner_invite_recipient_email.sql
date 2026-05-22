-- =============================================================================
-- Migration 034 — org_invitations.recipient_email + index
--
-- Layer 1 owner-invite-delivery (PR forthcoming). Adds a recipient_email
-- column so the accept path can enforce auth.user.email === invitation
-- .recipient_email — closing the leaked-link → ownership-takeover attack
-- surface on owner-invites specifically. Per warden security ratify
-- (msg 1779450054436 + 1779450140052) on the (β) email-match disposition.
--
-- COLUMN STAYS NULLABLE during the rollout window. Rationale per warden's
-- terminus discriminator (msg 1779450140052):
--   Option (b) chosen: indefinite null-tolerance with explicit comment.
--   New code paths never write null; in-flight invitations created before
--   this migration land with NULL and expire naturally (max_uses=1 plus
--   the existing 7-day TTL). No backfill — backfill risk would exceed the
--   value (recoverable email from email log alone is brittle).
--
-- The paired-follow-up task (member-invite email-match extension) carries
-- the same null-tolerance + normalization shape forward; discipline does
-- not fork between owner-invite and member-invite paths.
--
-- NORMALIZATION INVARIANT (NOT enforced at the schema layer):
--   Application code (src/email/normalize.ts) lowercases + trims the
--   recipient_email at STORE time AND at CHECK time. The DRY shared
--   normalization function means a future change to normalization
--   touches one site. Schema-level enforcement (e.g. a CHECK constraint
--   requiring lowercase) would over-couple — the normalization shape
--   may evolve. Visibility lives in the comment at the column + the
--   application code at the line.
-- =============================================================================

BEGIN;

ALTER TABLE org_invitations
  ADD COLUMN IF NOT EXISTS recipient_email TEXT;

COMMENT ON COLUMN org_invitations.recipient_email IS
  'Email address the invite is bound to (lowercased+trimmed at application '
  'layer). When NOT NULL, acceptInvitation enforces auth.user.email '
  '=== recipient_email (case-insensitive via shared normalizer). NULL is '
  'tolerated for legacy pre-2026-05-22 invitations; new code paths never '
  'write NULL on the owner-invite path. See PR-forthcoming + paired-follow-up '
  'task_1779450095130 for member-invite extension carrying the same shape.';

-- Index for the rare admin-side "find invitations addressed to X" lookup
-- and for the on-accept email-match query. Partial — only non-null rows
-- pay index-maintenance cost.
CREATE INDEX IF NOT EXISTS idx_org_invitations_recipient_email
  ON org_invitations (recipient_email)
  WHERE recipient_email IS NOT NULL;

COMMIT;
