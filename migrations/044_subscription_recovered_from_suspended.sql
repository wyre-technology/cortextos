-- =============================================================================
-- Migration:      044_subscription_recovered_from_suspended.sql
-- Date:           2026-06-05
-- Linear:         (ruby PSR2 Tier-2 polish — Aaron-option-A 2026-06-05)
--
-- Purpose:
--   History-marker for the post-suspension recovery branch of the
--   recovered-toast copy pivot. When a subscription's invoice.payment_
--   succeeded fires + the prior suspension_notified_at was non-null
--   (mig 042 — D2 dunning-suspension scheduler had observed the
--   subscription cross into suspended), write recovered_from_suspended_at
--   = NOW() in the same UPDATE. The dunning-view reads this column
--   within the existing 1h-TTL recovery-toast window to discriminate
--   was-previously-suspended (copy: "Welcome back. / Your service is
--   restored.") from routine-recovery (copy: "You're set. / Card was
--   charged successfully.").
--
--   Required because suspension_notified_at is CLEARED in the same
--   payment_succeeded UPDATE (mig 042 + PR #346) — without preserving
--   the history-trace in a separate column, dunning-view at any later
--   render time cannot tell whether the prior dunning cycle reached
--   suspended-state.
--
-- Schema rationale:
--   - TIMESTAMPTZ NULL default: present + non-null means "the most-recent
--     recovery was from a previously-suspended state." Null means
--     "either healthy / never-recovered OR recovered-but-not-from-
--     suspended (the routine billing-cycle case)."
--   - Sibling-shape to trial_converted_at (mig 043) + suspension_
--     notified_at (mig 042) — same TIMESTAMPTZ-as-discriminator pattern.
--   - No CHECK constraint: invariant (only set when prior
--     suspension_notified_at was non-null at recovery time) is enforced
--     by the webhook UPDATE's CTE-snapshot pattern. CHECK would block
--     legitimate ops manual-fix paths.
--
-- Lifetime note: the column is OVERWRITTEN on each subsequent recovery
-- from suspension (not append-only). The 1h-TTL read window in
-- dunning-view collapses to none after the window closes, so an old
-- recovered_from_suspended_at outside the window naturally falls
-- through to state='none' regardless of column value. No GC needed.
-- =============================================================================

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS recovered_from_suspended_at TIMESTAMPTZ NULL;

COMMIT;
