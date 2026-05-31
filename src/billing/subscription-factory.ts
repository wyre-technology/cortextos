/**
 * Trialing-subscription factory — builds the Stripe params for a Layer 1
 * org's two-item trialing subscription and (optionally) executes the create.
 *
 * Per LOCKED DOR §7 + ruby PR-A spec TRIAL-END CHARGE CONTRACT
 * (msg 1779410784520, ratified 1779411593149):
 *
 *   At trial_end the first Stripe charge MUST equal
 *     BASE_PRICE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats-at-trial-end
 *   with NO partial-period proration. billing_cycle_anchor = "trial_end"
 *   set EXPLICITLY (defense-in-depth against documented-default drift).
 *
 * The shape returned by buildTrialingSubscriptionParams is the locked
 * contract surface. The integration test in __tests__/trial-end-contract
 * .integration.test.ts is the runtime verifier-cleanliness pass — it
 * exercises this exact shape against real Stripe test mode + test clocks
 * to confirm Stripe behavior matches the contract.
 */

import type Stripe from 'stripe';
import { TRIAL_PERIOD_DAYS } from './prices.js';
import type { SeatBilling } from './seat-service.js';

export interface TrialingSubscriptionInputs {
  /** Stripe customer the subscription attaches to. Caller creates the
   *  customer first (with its own idempotency key — see createOrgCustomer). */
  customerId: string;
  /** Stripe Price ID for the $399 flat base item. From config.stripeConduitBasePriceId. */
  basePriceId: string;
  /** Stripe Price ID for the $39 per-unit seat item. From config.stripeConduitSeatPriceId. */
  seatPriceId: string;
  /** Seat-billing snapshot at the moment of subscription creation. The
   *  seat-item quantity is bound to billableSeats from this snapshot. */
  seatBilling: Pick<SeatBilling, 'billableSeats'>;
  /** Org ID — propagated to metadata and used as the idempotency-key root. */
  orgId: string;
  /** Optional override for testing — production callers omit this. */
  trialPeriodDays?: number;
}

/**
 * Pure function — returns the SubscriptionCreateParams for a Layer 1
 * trialing subscription. No I/O, no Stripe client. Used by:
 *   - createTrialingSubscription (production)
 *   - subscription-factory.test.ts (shape lock)
 *   - trial-end-contract.integration.test.ts (real-Stripe driver)
 *
 * Every locked term — two-item shape, trial_period_days, proration_behavior,
 * billing_cycle_anchor, payment_behavior, metadata — is encoded here as
 * the single source.
 */
export function buildTrialingSubscriptionParams(
  inputs: TrialingSubscriptionInputs,
): Stripe.SubscriptionCreateParams {
  const trialDays = inputs.trialPeriodDays ?? TRIAL_PERIOD_DAYS;

  return {
    customer: inputs.customerId,
    items: [
      { price: inputs.basePriceId, quantity: 1 },
      { price: inputs.seatPriceId, quantity: inputs.seatBilling.billableSeats },
    ],
    trial_period_days: trialDays,
    // EXPLICIT — Stripe's documented default when trial_period_days is set,
    // but encoding it makes the contract structural rather than discipline-
    // dependent on a docs-stated default that could shift across API
    // versions. Ratified by ruby 1779411593149.
    billing_cycle_anchor: 'trial_end' as unknown as number,
    // No partial-period proration at trial_end. The first real invoice is
    // a clean full-cycle charge of monthlyTotalCents at trial_end.
    proration_behavior: 'none',
    // Standard for client-side payment-method collection — sub stays
    // active during the trial without a payment method, then either user
    // adds one before trial_end or the sub goes incomplete and enters the
    // existing dunning flow (deriveDunningView / isServiceActive).
    payment_behavior: 'default_incomplete',
    metadata: { org_id: inputs.orgId },
    expand: ['latest_invoice.payment_intent'],
  };
}

/**
 * Idempotency-key helpers — tied to orgId so a transient failure between
 * Stripe call and DB write does not orphan a duplicate Stripe object on
 * retry. Ratified by ruby 1779411593149.
 */
export function customerIdempotencyKey(orgId: string): string {
  return `org-create-${orgId}`;
}

export function subscriptionIdempotencyKey(orgId: string): string {
  return `org-sub-${orgId}`;
}

export interface TrialingSubscriptionResult {
  customerId: string;
  subscriptionId: string;
  subscription: Stripe.Subscription;
}

/**
 * Production wrapper — creates the Stripe customer + the trialing
 * subscription, both with idempotency keys tied to orgId. Returns the
 * IDs to persist on the org row (stripeCustomerId, stripeSubscriptionId).
 *
 * Caller is responsible for the surrounding order-of-operations per ruby's
 * Q4 ratify (org row INSERT → owner-member INSERT → THIS function →
 * persist returned IDs). createOrg integration is Group B.
 */
export async function createTrialingSubscription(
  stripe: Stripe,
  args: {
    orgId: string;
    customerEmail?: string;
    customerName?: string;
    basePriceId: string;
    seatPriceId: string;
    seatBilling: Pick<SeatBilling, 'billableSeats'>;
    trialPeriodDays?: number;
    /** Optional Stripe test-clock ID (used by integration tests, never prod). */
    testClock?: string;
  },
): Promise<TrialingSubscriptionResult> {
  const customer = await stripe.customers.create(
    {
      email: args.customerEmail,
      name: args.customerName,
      metadata: { org_id: args.orgId },
      ...(args.testClock ? { test_clock: args.testClock } : {}),
    },
    { idempotencyKey: customerIdempotencyKey(args.orgId) },
  );

  const params = buildTrialingSubscriptionParams({
    customerId: customer.id,
    basePriceId: args.basePriceId,
    seatPriceId: args.seatPriceId,
    seatBilling: args.seatBilling,
    orgId: args.orgId,
    trialPeriodDays: args.trialPeriodDays,
  });

  const subscription = await stripe.subscriptions.create(params, {
    idempotencyKey: subscriptionIdempotencyKey(args.orgId),
  });

  return {
    customerId: customer.id,
    subscriptionId: subscription.id,
    subscription,
  };
}
