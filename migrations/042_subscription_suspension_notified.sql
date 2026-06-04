-- =============================================================================
-- Migration:      042_subscription_suspension_notified.sql
-- Date:           2026-06-04
-- Linear:         (ruby D2 HIGH launch-blocker audit follow-up)
--
-- Purpose:
--   Idempotency anchor for the dunning-suspension Loops-event scheduler.
--   When an org's subscription crosses the by-time-elapsed grace boundary
--   in dunning-view's state-machine (past_due / unpaid / incomplete +
--   first_failure_at + grace_days < NOW()), it transitions to 'suspended'
--   for the service-active gate -- but until now no webhook anchor fired
--   to surface that transition to the customer. The scheduler we're
--   adding (src/billing/dunning-suspension-scheduler.ts) polls + fires a
--   one-shot Loops 'dunning-suspended' event per suspended org.
--
--   This column is the idempotency-by-construction guard: each
--   subscription row gets ONE suspension_notified_at write the first time
--   the scheduler observes it suspended. The next tick's WHERE clause
--   filters `suspension_notified_at IS NULL`, so the same suspension can
--   never fire twice. Cleared at recovery (subscription returns to
--   active/trialing -- in the existing webhook handler where recovered_at
--   is also cleared).
--
-- Schema rationale:
--   - TIMESTAMPTZ NULL default: present + non-null means "we already
--     queued the dunning-suspended Loops event for this dunning-cycle."
--     Null means "either healthy or never-notified-yet-suspended."
--   - No CHECK constraint: the temporal-ordering invariant
--     (notified_at >= first_failure_at + grace) is enforced by the
--     scheduler's WHERE clause + cleared by the same recovery path that
--     clears first_failure_at + recovered_at. Encoding it as a CHECK
--     would block legitimate cancel-during-grace flows.
--   - No FK or index: subscriptions already has the indexes the
--     scheduler's filter needs (status, first_failure_at). This is a
--     plain nullable timestamp.
--
-- No RLS policy change: subscriptions RLS already exists; this column
-- inherits the existing policies (read+write via the system-path
-- scheduler that runs under runAsSystem).
-- =============================================================================

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS suspension_notified_at TIMESTAMPTZ NULL;

COMMIT;
