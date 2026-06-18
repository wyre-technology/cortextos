import { describe, it, expect } from 'vitest';
import {
  buildTrialingSubscriptionParams,
  customerIdempotencyKey,
  subscriptionIdempotencyKey,
} from './subscription-factory.js';
import { TRIAL_PERIOD_DAYS } from './prices.js';

describe('buildTrialingSubscriptionParams — locked contract shape', () => {
  const baseInputs = {
    customerId: 'cus_test_abc',
    basePriceId: 'price_base_xxx',
    seatPriceId: 'price_seat_yyy',
    seatBilling: { billableSeats: 5, baseCents: 39_900 },
    orgId: 'org_test_123',
  };

  it('returns the two-item subscription shape: base qty 1 + seat qty = billableSeats', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.items).toEqual([
      { price: 'price_base_xxx', quantity: 1 },
      { price: 'price_seat_yyy', quantity: 5 },
    ]);
  });

  it('sets trial_period_days = TRIAL_PERIOD_DAYS (14) by default', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.trial_period_days).toBe(TRIAL_PERIOD_DAYS);
    expect(params.trial_period_days).toBe(14);
  });

  it('allows trialPeriodDays override (for integration tests with shorter clocks)', () => {
    const params = buildTrialingSubscriptionParams({ ...baseInputs, trialPeriodDays: 1 });
    expect(params.trial_period_days).toBe(1);
  });

  it('sets billing_cycle_anchor explicitly to "trial_end" (defense-in-depth)', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    // Stripe's TS types declare billing_cycle_anchor as number | undefined;
    // the API also accepts the literal string "trial_end" — encoded via cast.
    expect(params.billing_cycle_anchor).toBe('trial_end');
  });

  it('sets proration_behavior to "none" (no partial-period proration at trial_end)', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.proration_behavior).toBe('none');
  });

  it('sets payment_behavior to "default_incomplete" (client-side payment-method flow)', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.payment_behavior).toBe('default_incomplete');
  });

  it('carries org_id in metadata so webhook handlers can route on it', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.metadata).toEqual({ org_id: 'org_test_123' });
  });

  it('expands latest_invoice.payment_intent so the create response is ready for client setup', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.expand).toContain('latest_invoice.payment_intent');
  });

  it('binds seat-item quantity to seatBilling.billableSeats at the moment of creation', () => {
    const seven = buildTrialingSubscriptionParams({
      ...baseInputs,
      seatBilling: { billableSeats: 7, baseCents: 39_900 },
    });
    expect((seven.items as Array<{ quantity: number }>)[1].quantity).toBe(7);

    const ten = buildTrialingSubscriptionParams({
      ...baseInputs,
      seatBilling: { billableSeats: 10, baseCents: 39_900 },
    });
    expect((ten.items as Array<{ quantity: number }>)[1].quantity).toBe(10);
  });

  it('attaches customer = inputs.customerId verbatim', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.customer).toBe('cus_test_abc');
  });
});

describe('buildTrialingSubscriptionParams — EAP item-omission (WYREAI-25)', () => {
  // Page-and-billing-agree closure: when org_discounts has an eap/org_fee/100
  // row for the org, computeSeatBilling returns SeatBilling with baseCents=0.
  // subscription-factory reads that and OMITS the basePriceId line entirely —
  // Stripe sees a single seat line, charges accordingly, and our display +
  // Stripe invoice cannot diverge (shared applyDiscounts helper at
  // src/billing/discounts.ts is the single math path for both).
  const eapInputs = {
    customerId: 'cus_test_abc',
    basePriceId: 'price_base_xxx',
    seatPriceId: 'price_seat_yyy',
    seatBilling: { billableSeats: 5, baseCents: 0 },
    orgId: 'org_eap_test',
  };

  it('drops the basePriceId item when baseCents=0 — Stripe sees one seat item only', () => {
    const params = buildTrialingSubscriptionParams(eapInputs);
    expect(params.items).toEqual([
      { price: 'price_seat_yyy', quantity: 5 },
    ]);
  });

  it('seat-item quantity is still bound to billableSeats — math discipline holds', () => {
    const nine = buildTrialingSubscriptionParams({
      ...eapInputs,
      seatBilling: { billableSeats: 9, baseCents: 0 },
    });
    expect(nine.items).toHaveLength(1);
    expect((nine.items as Array<{ quantity: number }>)[0].quantity).toBe(9);
  });

  it('partial org_fee discount (baseCents>0) KEEPS the base item — only fully-waived omits', () => {
    // Example: a hypothetical 50% off org_fee → baseCents=19_950. The base
    // line stays at price=basePriceId. Partial discounts on a Stripe sub
    // are a (c) annual-prepay concern via sub-level discounts[], NOT
    // item-omission. For (b), only baseCents=0 triggers omission.
    const partial = buildTrialingSubscriptionParams({
      ...eapInputs,
      seatBilling: { billableSeats: 5, baseCents: 19_950 },
    });
    expect(partial.items).toEqual([
      { price: 'price_base_xxx', quantity: 1 },
      { price: 'price_seat_yyy', quantity: 5 },
    ]);
  });

  it('all the locked contract terms still hold under EAP', () => {
    const params = buildTrialingSubscriptionParams(eapInputs);
    expect(params.trial_period_days).toBe(TRIAL_PERIOD_DAYS);
    expect(params.billing_cycle_anchor).toBe('trial_end');
    expect(params.proration_behavior).toBe('none');
    expect(params.payment_behavior).toBe('default_incomplete');
    expect(params.metadata).toEqual({ org_id: 'org_eap_test' });
  });
});

describe('idempotency-key helpers — orgId-bound (retry-safe by construction)', () => {
  it('customerIdempotencyKey uses the org-create-${orgId} format', () => {
    expect(customerIdempotencyKey('org_test_123')).toBe('org-create-org_test_123');
  });

  it('subscriptionIdempotencyKey uses the org-sub-${orgId} format', () => {
    expect(subscriptionIdempotencyKey('org_test_123')).toBe('org-sub-org_test_123');
  });

  it('keys are distinct per (orgId, kind) so customer and sub never collide', () => {
    const orgId = 'org_collide_test';
    expect(customerIdempotencyKey(orgId)).not.toBe(subscriptionIdempotencyKey(orgId));
  });
});
