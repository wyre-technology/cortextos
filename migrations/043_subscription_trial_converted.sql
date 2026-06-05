-- =============================================================================
-- Migration:      043_subscription_trial_converted.sql
-- Date:           2026-06-05
-- Linear:         (ruby CS1 HIGH launch-blocker audit follow-up)
--
-- Purpose:
--   Idempotency anchor for the trial-converted Loops-event fire. When a
--   trialing subscription receives its first invoice.payment_succeeded
--   (Stripe automatic charge at trial_end under flat-pricing), the
--   webhook handler atomically (a) snapshots the prior status, (b) writes
--   trial_converted_at, (c) returns a just_converted boolean so the
--   handler knows whether to fire the 'trial-converted' Loops event.
--
--   Without this column the trial→paid transition is the silent-success
--   gap ruby flagged: invoice.payment_succeeded fired but only routed
--   to dunning-recovered (gated on was_in_dunning), so the highest-
--   trust-stakes lifecycle moment (first paid charge) got zero
--   Conduit-side acknowledgment.
--
-- Schema rationale:
--   - TIMESTAMPTZ NULL default: present + non-null means "we already
--     fired the trial-converted Loops event for this subscription."
--     Null means "either never-trialed OR still-trialing OR pre-launch."
--     The webhook never clears this column — trial-conversion is a
--     one-time terminal transition per subscription (re-subscribe after
--     cancel produces a new row via subscription.id PK, gets its own
--     conversion event).
--   - No CHECK constraint: invariant (only set when prior status was
--     'trialing') is enforced by the webhook UPDATE's CASE clause +
--     the COALESCE-against-existing pattern. Encoding it as a CHECK
--     would block legitimate manual-fix paths in ops.
--   - No FK or index: the only reader is the webhook handler accessing
--     by stripe_subscription_id (already indexed).
--
-- Idempotency-by-construction pattern (sibling to mig 042
-- suspension_notified_at):
--   - WHERE clause guards prior_status='trialing' AND trial_converted_at
--     IS NULL → only the first conversion fires
--   - COALESCE(trial_converted_at, ...) never overwrites a set value
--   - Subsequent invoice.payment_succeeded events see status='active'
--     (because the same UPDATE flipped it) → CASE branch returns NULL
--     → COALESCE preserves the original timestamp → no re-fire
--
-- No RLS policy change: subscriptions RLS already exists; this column
-- inherits the existing system-path policies (writer = webhook handler,
-- runs via runAsSystem / BYPASSRLS).
-- =============================================================================

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_converted_at TIMESTAMPTZ NULL;

COMMIT;
