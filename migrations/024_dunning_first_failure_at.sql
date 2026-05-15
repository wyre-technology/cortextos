-- Migration 024 — first_failure_at + recovered_at helper fields on subscriptions
-- for dunning lifecycle support.
--
-- Companion: orgs/wyre/agents/ruby/memory/2026-05-14-dunning-checkpoint3-data-fields.md
-- (Ruby's data-field map for the 5-state dunning experience).
--
-- =============================================================================
-- BACKGROUND
-- =============================================================================
--
-- Ruby's dunning design (acked by Aaron, dispatched via boss msg 1778810674158)
-- introduces a 5-state lifecycle: payment-failing / past-due / final-warning /
-- suspended / recovered. Each state-transition fires a Loops event + drives a
-- different UI surface in the billing area.
--
-- The architecture is "derive-on-fly" — Stripe is the source of truth for
-- subscription state, and Conduit computes the dunning state from
-- (subscription.status, first_failure_at, WYRE_DUNNING_GRACE_DAYS). No
-- dunning_state table; one helper field on subscriptions captures the
-- timeline anchor.
--
-- Two helper fields needed:
--
-- (1) first_failure_at: TIMESTAMPTZ — timestamp of the FIRST
--     invoice.payment_failed event for the subscription's current
--     dunning cycle. Persisted on first failure, cleared on
--     invoice.payment_succeeded. Used to compute service_end_date
--     (= first_failure_at + Stripe-retry-window + WYRE_DUNNING_GRACE_DAYS)
--     and to drive the dunning state machine.
--
-- (2) recovered_at: TIMESTAMPTZ — timestamp of the SUCCESSFUL payment that
--     ended a dunning cycle. Set on invoice.payment_succeeded immediately
--     after first_failure_at was non-null (i.e., a recovery, not a
--     normal billing cycle). Used to render the "recovered" state with
--     a 1h TTL: any DunningView read more than 1h after recovered_at
--     collapses to state='none' (Pearl's spec).
--
-- Both are nullable: a subscription that has never failed has
-- first_failure_at = NULL + recovered_at = NULL. A subscription currently
-- in dunning has first_failure_at = <timestamp> + recovered_at = NULL.
-- A subscription that just recovered has first_failure_at = NULL +
-- recovered_at = <timestamp> for the 1h TTL window.
--
-- =============================================================================

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS first_failure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovered_at     TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.first_failure_at IS
  'Migration 024: timestamp of first invoice.payment_failed in the current dunning cycle. NULL when subscription is healthy or has just recovered. Cleared on invoice.payment_succeeded (then recovered_at is set). Anchors the 7-day-grace + dunning-state-machine derivation.';

COMMENT ON COLUMN subscriptions.recovered_at IS
  'Migration 024: timestamp of successful payment that ended a dunning cycle. Non-null only for the 1h TTL window after recovery. After 1h, DunningView render collapses to state=none and recovered_at can be safely cleared by webhook on next event.';

-- Post-migration audit: assert columns exist + are TIMESTAMPTZ + are nullable.
-- This is the runtime-check pin (sub-pattern #10 third-pin) for the schema
-- invariants that the derive-on-fly DunningView depends on.
DO $$
DECLARE
  v_col_count INT;
BEGIN
  SELECT COUNT(*) INTO v_col_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'subscriptions'
     AND column_name IN ('first_failure_at', 'recovered_at')
     AND data_type = 'timestamp with time zone'
     AND is_nullable = 'YES';

  IF v_col_count <> 2 THEN
    RAISE EXCEPTION 'mig 024 audit: expected 2 nullable TIMESTAMPTZ columns (first_failure_at, recovered_at) on subscriptions; found %', v_col_count;
  END IF;

  RAISE NOTICE 'mig 024 audit: first_failure_at + recovered_at on subscriptions present, both nullable TIMESTAMPTZ.';
END;
$$;

COMMIT;
