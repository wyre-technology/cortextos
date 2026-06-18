/**
 * Flat-pricing constants — single source of truth.
 *
 * Per Aaron's 2026-05-26 FLAT-PRICING decision (boss msg 1779800509151,
 * params locked through 1779803148807) + 2026-06-17 AGENTS-BILLABLE
 * decision (boss msg-1781747082415, WYREAI-25):
 *
 *   FLAT model — no tiers, no credits, no call-gating, everything-included.
 *   monthlyTotalCents = ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats
 *
 *   billableSeats = humans + agents. Every team member is a billable seat;
 *   agents and humans bill at the same per-seat rate. There is NO free-
 *   agent carve-out (the earlier Shape-A "first 2 agents free" inclusion
 *   was removed at Aaron's 2026-06-17 GO).
 *
 * The OLD Layer-1 model ($600 base + $20/seat + credit pool + free/pro/
 * business tiers) is removed: tiers, credits, and the per-tier rate-limit
 * differential all go. The per-user rate-limit MECHANISM stays (flattened
 * — see ANTI_ABUSE_RATE_PER_HOUR); dunning and request_log analytics are
 * untouched.
 *
 * Constants are imported by plan-catalog (the single flat plan), seat-
 * service (the composed billing snapshot), and the Stripe-config call
 * sites. No magic numbers anywhere else in src/billing.
 */

/** $399/org flat monthly base. */
export const ORG_FEE_CENTS = 39_900;
/** $39 per billable seat. Applies uniformly to humans AND agents. */
export const PER_SEAT_PRICE_CENTS = 3_900;
/**
 * Agent seats included in the org fee. Per Aaron's 2026-06-17 AGENTS-
 * BILLABLE decision (boss msg-1781747082415, WYREAI-25): zero free agents.
 * Every agent bills from seat 1, identical to a human. The constant is
 * kept (rather than inlined) so future Shape-A or promotional-inclusion
 * variants land here without touching seat-service.ts. Today's value is
 * 0 — strictly agents-billable.
 */
export const INCLUDED_AGENT_SEATS = 0;
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
