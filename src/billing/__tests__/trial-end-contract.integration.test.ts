/**
 * TRIAL-END CHARGE CONTRACT — runtime verifier (layer 4).
 *
 * Locked contract (ruby spec 2026-05-22, ratified 2026-05-22):
 *   At trial_end the first Stripe charge MUST equal
 *     ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS × billableSeats-at-trial-end
 *   with NO partial-period proration. billing_cycle_anchor = trial_end.
 *
 * This test is layer 4 of the four-layer defense:
 *   1. Spec doc — the PR-A spec + DOR §7
 *   2. Type system — frozen SeatBilling snapshot (seat-service.ts)
 *   2.5. Pure-factory unit test — params shape (subscription-factory.test.ts)
 *   3. Integration test — THIS file: real Stripe behavior under test clocks
 *
 * The lower layers prevent SPEC and PARAMS drift. This layer catches
 * STRIPE-side drift — if Stripe ever changes proration_behavior semantics
 * in trialing state, or if billing_cycle_anchor:"trial_end" semantics
 * shift across API versions, THIS test goes red while the others stay
 * green. That isolation is the point.
 *
 * Gating: STRIPE_TEST_SECRET_KEY must be present AND start with sk_test_.
 * Skipped cleanly otherwise (CI sets the env; local dev sets it or skips).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
  buildTrialingSubscriptionParams,
  customerIdempotencyKey,
  subscriptionIdempotencyKey,
} from '../subscription-factory.js';
import {
  ORG_FEE_CENTS,
  CURRENCY,
  PER_SEAT_PRICE_CENTS,
  TRIAL_PERIOD_DAYS,
} from '../prices.js';

const testKey = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const enabled = testKey.startsWith('sk_test_');

// Use describe.skip when creds are missing — vitest reports as skipped,
// not failed. CI gates on the credential being present.
const describeIfEnabled = enabled ? describe : describe.skip;

describeIfEnabled('TRIAL-END CHARGE CONTRACT — real Stripe behavior', () => {
  let stripe: Stripe;
  let productId: string;
  let basePriceId: string;
  let seatPriceId: string;
  const cleanupSubscriptionIds: string[] = [];
  const cleanupCustomerIds: string[] = [];
  const cleanupClockIds: string[] = [];

  beforeAll(async () => {
    stripe = new Stripe(testKey);

    // Create ephemeral test-mode product + two prices that match the
    // Layer 1 shape. This decouples the integration test from forge's
    // production price-ID timeline — we create what we need, here, now.
    const product = await stripe.products.create({
      name: 'Conduit (integration-test ephemeral)',
      metadata: { ephemeral: 'true', test: 'trial-end-contract' },
    });
    productId = product.id;

    const basePrice = await stripe.prices.create({
      product: productId,
      unit_amount: ORG_FEE_CENTS,
      currency: CURRENCY,
      recurring: { interval: 'month' },
      nickname: 'Conduit Subscription (ephemeral)',
    });
    basePriceId = basePrice.id;

    const seatPrice = await stripe.prices.create({
      product: productId,
      unit_amount: PER_SEAT_PRICE_CENTS,
      currency: CURRENCY,
      recurring: { interval: 'month' },
      nickname: 'Conduit Seat (ephemeral)',
    });
    seatPriceId = seatPrice.id;
  }, 60_000);

  afterAll(async () => {
    // Cancel subscriptions, delete customers + their test clocks, archive
    // prices and the product. Stripe doesn't allow deleting prices once
    // attached to a subscription so they get marked inactive instead.
    for (const id of cleanupSubscriptionIds) {
      try { await stripe.subscriptions.cancel(id); } catch { /* idempotent */ }
    }
    for (const id of cleanupCustomerIds) {
      try { await stripe.customers.del(id); } catch { /* idempotent */ }
    }
    for (const id of cleanupClockIds) {
      try { await stripe.testHelpers.testClocks.del(id); } catch { /* idempotent */ }
    }
    if (basePriceId) {
      try { await stripe.prices.update(basePriceId, { active: false }); } catch { /* ignore */ }
    }
    if (seatPriceId) {
      try { await stripe.prices.update(seatPriceId, { active: false }); } catch { /* ignore */ }
    }
    if (productId) {
      try { await stripe.products.update(productId, { active: false }); } catch { /* ignore */ }
    }
  }, 30_000);

  /**
   * Advances the test clock and polls until Stripe finishes processing.
   * Stripe's clock-advance is asynchronous — invoices materialize after
   * the clock reaches 'ready' status. Without polling, the next API call
   * sees a stale state.
   */
  async function advanceClock(clockId: string, toUnix: number): Promise<void> {
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnix });
    const deadline = Date.now() + 90_000; // 90s ceiling
    while (Date.now() < deadline) {
      const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (clock.status === 'ready') return;
      if (clock.status === 'internal_failure') {
        throw new Error(`test clock ${clockId} entered internal_failure`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`test clock ${clockId} did not reach 'ready' within 90s`);
  }

  /**
   * Provisions a customer + trialing subscription against a fresh test
   * clock, using the locked subscription-factory params. Returns the
   * subscription, customer, and clock so the test can advance + inspect.
   */
  async function provisionTrialingSub(opts: {
    orgId: string;
    billableSeats: number;
    trialPeriodDays?: number;
  }): Promise<{
    customer: Stripe.Customer;
    subscription: Stripe.Subscription;
    clock: Stripe.TestHelpers.TestClock;
    trialEndUnix: number;
  }> {
    const nowUnix = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: nowUnix,
      name: `trial-end-contract ${opts.orgId}`,
    });
    cleanupClockIds.push(clock.id);

    const customer = await stripe.customers.create(
      {
        email: `${opts.orgId}@integration-test.example`,
        metadata: { org_id: opts.orgId },
        test_clock: clock.id,
      },
      { idempotencyKey: customerIdempotencyKey(opts.orgId) },
    );
    cleanupCustomerIds.push(customer.id);

    const params = buildTrialingSubscriptionParams({
      customerId: customer.id,
      basePriceId,
      seatPriceId,
      seatBilling: { billableSeats: opts.billableSeats },
      orgId: opts.orgId,
      trialPeriodDays: opts.trialPeriodDays,
    });

    const subscription = await stripe.subscriptions.create(params, {
      idempotencyKey: subscriptionIdempotencyKey(opts.orgId),
    });
    cleanupSubscriptionIds.push(subscription.id);

    const trialDays = opts.trialPeriodDays ?? TRIAL_PERIOD_DAYS;
    const trialEndUnix = nowUnix + trialDays * 24 * 60 * 60;

    return { customer, subscription, clock, trialEndUnix };
  }

  /**
   * Lists invoices for a subscription that have actually transitioned out
   * of the trial — i.e. the first REAL charge invoice. The trialing
   * subscription's auto-created $0 invoice (sometimes present) is skipped.
   */
  async function firstRealInvoice(subscriptionId: string): Promise<Stripe.Invoice> {
    const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    // Pick the highest-amount invoice — the trial-end charge. Filters out
    // any $0 trial-start placeholder Stripe may have emitted.
    const sorted = [...invoices.data].sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    if (!sorted[0]) throw new Error(`no invoices found for sub ${subscriptionId}`);
    return sorted[0];
  }

  it('1 human, 0 agents (billableSeats=1) → first charge = $438.00, no proration line', async () => {
    const orgId = `org_test1_${Date.now()}`;
    const { subscription, clock, trialEndUnix } = await provisionTrialingSub({
      orgId,
      billableSeats: 1,
    });
    expect(subscription.status).toBe('trialing');

    await advanceClock(clock.id, trialEndUnix + 60);

    const invoice = await firstRealInvoice(subscription.id);
    expect(invoice.total).toBe(ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS * 1); // 43800

    // No proration lines — Stripe marks them on invoice.lines.data[].proration.
    // Stripe v22+: proration flag is on line.parent.subscription_item_details.proration.
    // A proration line appears whenever Stripe issued a partial-period charge — under
    // the contract (proration_behavior:"none") this list MUST be empty at trial_end.
    const prorationLines = invoice.lines.data.filter(
      (line) => line.parent?.subscription_item_details?.proration === true,
    );
    expect(prorationLines).toHaveLength(0);
  }, 120_000);

  it('5 humans, 4 agents (billableSeats=7) → first charge = $672.00, no proration line', async () => {
    const orgId = `org_test2_${Date.now()}`;
    const { subscription, clock, trialEndUnix } = await provisionTrialingSub({
      orgId,
      billableSeats: 7,
    });
    expect(subscription.status).toBe('trialing');

    await advanceClock(clock.id, trialEndUnix + 60);

    const invoice = await firstRealInvoice(subscription.id);
    expect(invoice.total).toBe(ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS * 7); // 67200

    // Stripe v22+: proration flag is on line.parent.subscription_item_details.proration.
    // A proration line appears whenever Stripe issued a partial-period charge — under
    // the contract (proration_behavior:"none") this list MUST be empty at trial_end.
    const prorationLines = invoice.lines.data.filter(
      (line) => line.parent?.subscription_item_details?.proration === true,
    );
    expect(prorationLines).toHaveLength(0);
  }, 120_000);

  it('seat-change mid-trial (qty 1 → 3) → first charge reflects qty at trial_end, no proration', async () => {
    // This is the load-bearing case for the contract: PR-A spec says
    // mid-trial seat changes update the Stripe quantity but produce NO
    // proration charge because the sub is in `trialing` state. At
    // trial_end the first invoice should bill for the new quantity, not
    // the original.
    const orgId = `org_test3_${Date.now()}`;
    const { subscription, clock, trialEndUnix } = await provisionTrialingSub({
      orgId,
      billableSeats: 1,
    });

    // Mutate the seat-item quantity from 1 to 3 mid-trial (5 days in).
    const seatItem = subscription.items.data.find((it) => it.price.id === seatPriceId);
    if (!seatItem) throw new Error('seat item missing from subscription');

    const midTrialUnix = trialEndUnix - 9 * 24 * 60 * 60; // 5 days into a 14-day trial
    await advanceClock(clock.id, midTrialUnix);

    await stripe.subscriptionItems.update(seatItem.id, {
      quantity: 3,
      proration_behavior: 'none', // explicit — must hold even on item update
    });

    // Advance to trial_end and inspect the first real invoice.
    await advanceClock(clock.id, trialEndUnix + 60);

    const invoice = await firstRealInvoice(subscription.id);
    expect(invoice.total).toBe(ORG_FEE_CENTS + PER_SEAT_PRICE_CENTS * 3); // 51600

    // Stripe v22+: proration flag is on line.parent.subscription_item_details.proration.
    // A proration line appears whenever Stripe issued a partial-period charge — under
    // the contract (proration_behavior:"none") this list MUST be empty at trial_end.
    const prorationLines = invoice.lines.data.filter(
      (line) => line.parent?.subscription_item_details?.proration === true,
    );
    expect(prorationLines).toHaveLength(0);
  }, 180_000);

  it('idempotency keys: repeating subscription create with same orgId returns the same Stripe subscription', async () => {
    // Ruby Q4: idempotency_key on stripe.subscriptions.create tied to
    // orgId means a transient failure → retry never mints a duplicate.
    const orgId = `org_idem_${Date.now()}`;
    const first = await provisionTrialingSub({ orgId, billableSeats: 1 });

    // Repeat the customer create + sub create with the SAME idempotency
    // keys. Stripe should return the exact same objects.
    const customerAgain = await stripe.customers.create(
      {
        email: `${orgId}@integration-test.example`,
        metadata: { org_id: orgId },
        test_clock: first.clock.id,
      },
      { idempotencyKey: customerIdempotencyKey(orgId) },
    );
    expect(customerAgain.id).toBe(first.customer.id);

    const params = buildTrialingSubscriptionParams({
      customerId: first.customer.id,
      basePriceId,
      seatPriceId,
      seatBilling: { billableSeats: 1 },
      orgId,
    });
    const subAgain = await stripe.subscriptions.create(params, {
      idempotencyKey: subscriptionIdempotencyKey(orgId),
    });
    expect(subAgain.id).toBe(first.subscription.id);
  }, 60_000);
});

describe('TRIAL-END CHARGE CONTRACT — gating self-check', () => {
  it('integration test is enabled iff STRIPE_TEST_SECRET_KEY is a sk_test_ key', () => {
    // Visibility: when this test file runs, this single test always runs
    // (no gate), and announces whether the real-Stripe suite was
    // exercised or skipped. Helps CI logs not be ambiguous about whether
    // the layer-4 verifier actually ran.
    if (!enabled) {
      // eslint-disable-next-line no-console
      console.warn(
        '[trial-end-contract] STRIPE_TEST_SECRET_KEY not set or not a test key — real-Stripe suite SKIPPED. ' +
          'Layer 4 verifier did not run; layers 1–2.5 are still in force.',
      );
    }
    expect(typeof enabled).toBe('boolean');
  });
});
