/**
 * Layer 1 price constants — single source of truth.
 *
 * Per the LOCKED Decision of Record
 * (orgs/wyre/agents/ruby/memory/2026-05-20-layer-1-model-LOCKED-decision-of-record.md):
 *
 *   monthlyTotalCents = BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats
 *   creditPool        = CREDITS_PER_SEAT × creditSeats
 *
 * Constants are imported by plan-catalog (single paid plan definition),
 * seat-service (the composed billing snapshot), and any Stripe-config call
 * site. No magic numbers anywhere else in src/billing.
 */

export const BASE_PRICE_CENTS = 60_000;
export const PER_SEAT_PRICE_CENTS = 2_000;
export const CREDITS_PER_SEAT = 2_500;
export const INCLUDED_AGENT_SEATS = 2;
export const TRIAL_PERIOD_DAYS = 14;

export const CURRENCY = 'usd' as const;
