/**
 * Flat-pricing constants — single source of truth.
 *
 * Per Aaron's 2026-05-26 FLAT-PRICING decision (boss msg 1779800509151,
 * params locked through 1779803148807):
 *
 *   FLAT model — no tiers, no credits, no call-gating, everything-included.
 *   monthlyTotalCents = ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats
 *
 *   billableSeats keeps the Shape-A agent inclusion: the first
 *   INCLUDED_AGENT_SEATS agent seats are free, humans always bill.
 *   (Aaron "keep it" — agent #1/#2 free, #3+ = a seat; humans = a seat.)
 *
 * The OLD Layer-1 model ($600 base + $20/seat + credit pool + free/pro/
 * business tiers) is removed in this change: tiers, credits, and the
 * per-tier rate-limit differential all go. The per-user rate-limit
 * MECHANISM stays (flattened — see ANTI_ABUSE_RATE_PER_HOUR); dunning and
 * request_log analytics are untouched.
 *
 * Constants are imported by plan-catalog (the single flat plan), seat-
 * service (the composed billing snapshot), and the Stripe-config call
 * sites. No magic numbers anywhere else in src/billing.
 */

/** $399/org flat monthly base. */
export const ORG_FEE_CENTS = 39_900;
/** $39 per billable seat. */
export const PER_SEAT_PRICE_CENTS = 3_900;
/**
 * Agent seats included in the org fee (Shape-A inclusion). The first
 * INCLUDED_AGENT_SEATS service-client (agent) seats bill at $0; agent
 * #(INCLUDED_AGENT_SEATS + 1) and beyond each cost PER_SEAT_PRICE_CENTS.
 * Human (member) seats always bill from seat 1.
 */
export const INCLUDED_AGENT_SEATS = 2;
export const TRIAL_PERIOD_DAYS = 14;

/**
 * Flat per-user anti-abuse rate ceiling (requests/hour), applied
 * identically to every org. This is INFRA-PROTECTION, not a pricing gate:
 * it is a module constant with no plan-object slot to vary by, so it
 * cannot differentiate a paying tier even by accident (divorced-from-the-
 * plan-object = infra-not-pricing enforceable-by-construction). It
 * replaces the former per-tier rateLimitPerHour (free 100 / pro 1000 /
 * business 5000); the per-user-keyed Fastify rate-limit MECHANISM in the
 * proxy routers is unchanged — only the max value is flattened. Set at the
 * old top-tier ceiling so no legitimate use regresses.
 */
export const ANTI_ABUSE_RATE_PER_HOUR = 5_000;

export const CURRENCY = 'usd' as const;
