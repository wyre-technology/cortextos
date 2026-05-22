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
    seatBilling: { billableSeats: 5 },
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
      seatBilling: { billableSeats: 7 },
    });
    expect((seven.items as Array<{ quantity: number }>)[1].quantity).toBe(7);

    const ten = buildTrialingSubscriptionParams({
      ...baseInputs,
      seatBilling: { billableSeats: 10 },
    });
    expect((ten.items as Array<{ quantity: number }>)[1].quantity).toBe(10);
  });

  it('attaches customer = inputs.customerId verbatim', () => {
    const params = buildTrialingSubscriptionParams(baseInputs);
    expect(params.customer).toBe('cus_test_abc');
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
