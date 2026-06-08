import { describe, it, expect } from 'vitest';
import {
  mapSubscriptionToDunningView,
  extractVisualsFromStripeSubscription,
} from './dunning-view.js';

const GRACE_DAYS = 7;
const NOW = new Date('2026-05-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const EMPTY_VISUALS = {
  cardBrand: '',
  cardLast4: '',
  attemptCount: 0,
  nextRetryDate: null,
  amountCents: 0,
  currency: 'usd',
  currentPeriodEnd: null,
};

const REAL_VISUALS = {
  cardBrand: 'visa',
  cardLast4: '4242',
  attemptCount: 3,
  nextRetryDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  amountCents: 4900,
  currency: 'usd',
  currentPeriodEnd: new Date(NOW.getTime() + 16 * DAY).toISOString(),
};

describe('mapSubscriptionToDunningView', () => {
  describe('active / trialing', () => {
    it('returns none when no recovered_at is present', () => {
      const out = mapSubscriptionToDunningView(
        { status: 'active', first_failure_at: null, recovered_at: null },
        EMPTY_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out).toEqual({ state: 'none' });
    });

    it('returns recovered when recovered_at is within the 1h TTL', () => {
      const recoveredAt = new Date(NOW.getTime() - 15 * 60 * 1000);
      const out = mapSubscriptionToDunningView(
        { status: 'active', first_failure_at: null, recovered_at: recoveredAt },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('recovered');
      if (out.state === 'recovered') {
        expect(out.amountCents).toBe(4900);
        expect(out.nextChargeDate).toBe(REAL_VISUALS.currentPeriodEnd);
      }
    });

    it('collapses to none when recovered_at is older than 1h', () => {
      const recoveredAt = new Date(NOW.getTime() - 2 * HOUR);
      const out = mapSubscriptionToDunningView(
        { status: 'active', first_failure_at: null, recovered_at: recoveredAt },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out).toEqual({ state: 'none' });
    });

    it('falls back to "30 days out" nextChargeDate when current_period_end is missing', () => {
      const recoveredAt = new Date(NOW.getTime() - 5 * 60 * 1000);
      const out = mapSubscriptionToDunningView(
        { status: 'active', first_failure_at: null, recovered_at: recoveredAt },
        EMPTY_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('recovered');
      if (out.state === 'recovered') {
        const fallback = new Date(NOW.getTime() + 30 * DAY).toISOString();
        expect(out.nextChargeDate).toBe(fallback);
      }
    });

    // Ruby PSR2 (2026-06-05, Aaron-option-A): wasPreviouslySuspended
    // discriminator derives from recovered_from_suspended_at (mig 044)
    // paired with recovered_at within the 1h TTL window.
    it('PSR2: wasPreviouslySuspended=true when recovered_from_suspended_at pairs with recovered_at', () => {
      const recoveredAt = new Date(NOW.getTime() - 10 * 60 * 1000);
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: recoveredAt,
          recovered_from_suspended_at: recoveredAt, // paired (same write moment)
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('recovered');
      if (out.state === 'recovered') {
        expect(out.wasPreviouslySuspended).toBe(true);
      }
    });

    it('PSR2: wasPreviouslySuspended=false when recovered_from_suspended_at is absent (routine recovery)', () => {
      const recoveredAt = new Date(NOW.getTime() - 10 * 60 * 1000);
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: recoveredAt,
          // recovered_from_suspended_at omitted = routine recovery
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('recovered');
      if (out.state === 'recovered') {
        expect(out.wasPreviouslySuspended).toBe(false);
      }
    });

    it('PSR2: stale recovered_from_suspended_at (older than 1h from current recovered_at) does NOT promote', () => {
      // Old suspension marker from a previous cycle should not pair
      // with a fresh recovered_at from a routine billing-cycle success.
      const recoveredAt = new Date(NOW.getTime() - 10 * 60 * 1000);
      const stale = new Date(recoveredAt.getTime() - 24 * HOUR);
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: recoveredAt,
          recovered_from_suspended_at: stale,
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('recovered');
      if (out.state === 'recovered') {
        expect(out.wasPreviouslySuspended).toBe(false);
      }
    });
  });

  describe('terminal states', () => {
    // Ruby CC2 2026-06-05: customer-cancel-intent split from payment-
    // failure-suspension. Previously these two statuses collapsed into
    // 'suspended'; they now render distinct view-states with distinct
    // copy registers (peer-acknowledgment of customer choice vs we-
    // couldn't-bill-you).
    it('returns canceled for canceled status (customer-cancel-intent)', () => {
      const out = mapSubscriptionToDunningView(
        { status: 'canceled', first_failure_at: null, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('canceled');
    });

    it('returns suspended for incomplete_expired status (Stripe gave up on initial payment)', () => {
      const out = mapSubscriptionToDunningView(
        { status: 'incomplete_expired', first_failure_at: null, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('suspended');
    });
  });

  describe('CC4 scheduled-cancel state (ruby 2026-06-05)', () => {
    it('returns scheduled-cancel when status=active + cancel_at_period_end=TRUE + current_period_end present', () => {
      const periodEnd = new Date(NOW.getTime() + 10 * 24 * HOUR);
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: null,
          cancel_at_period_end: true,
          current_period_end: periodEnd,
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('scheduled-cancel');
      if (out.state === 'scheduled-cancel') {
        expect(out.scheduledEndAt).toBe(periodEnd.toISOString());
      }
    });

    it('still returns none when status=active + cancel_at_period_end=FALSE (the normal active sub)', () => {
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: null,
          cancel_at_period_end: false,
          current_period_end: new Date(NOW.getTime() + 30 * 24 * HOUR),
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('none');
    });

    it('returns none when cancel_at_period_end=TRUE but current_period_end is missing (defensive)', () => {
      const out = mapSubscriptionToDunningView(
        {
          status: 'active',
          first_failure_at: null,
          recovered_at: null,
          cancel_at_period_end: true,
          current_period_end: null,
        },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      // Without a period-end we cannot render the countdown -- fail open.
      expect(out.state).toBe('none');
    });
  });

  describe('past_due / unpaid / incomplete', () => {
    it('returns payment-failing when within first 24h since first_failure_at', () => {
      const fail = new Date(NOW.getTime() - 12 * HOUR);
      const out = mapSubscriptionToDunningView(
        { status: 'past_due', first_failure_at: fail, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('payment-failing');
      if (out.state === 'payment-failing') {
        expect(out.attemptCount).toBe(3);
        expect(out.cardLast4).toBe('4242');
      }
    });

    it('returns past-due when 24h–7d since first_failure_at', () => {
      const fail = new Date(NOW.getTime() - 4 * DAY);
      const out = mapSubscriptionToDunningView(
        { status: 'unpaid', first_failure_at: fail, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('past-due');
    });

    it('returns final-warning during the WYRE grace window (days 7–14)', () => {
      const fail = new Date(NOW.getTime() - 10 * DAY);
      const out = mapSubscriptionToDunningView(
        { status: 'past_due', first_failure_at: fail, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('final-warning');
      if (out.state === 'final-warning') {
        const expectedEnd = new Date(fail.getTime() + 14 * DAY).toISOString();
        expect(out.serviceEndDate).toBe(expectedEnd);
      }
    });

    it('returns suspended past the grace window', () => {
      const fail = new Date(NOW.getTime() - 20 * DAY);
      const out = mapSubscriptionToDunningView(
        { status: 'past_due', first_failure_at: fail, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out.state).toBe('suspended');
    });

    it('defensively treats missing first_failure_at as just-entered', () => {
      const out = mapSubscriptionToDunningView(
        { status: 'past_due', first_failure_at: null, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      // first_failure_at = now → 0h elapsed → payment-failing (within first 24h)
      expect(out.state).toBe('payment-failing');
    });
  });

  describe('unknown statuses', () => {
    it('returns none for any other status (defensive)', () => {
      const out = mapSubscriptionToDunningView(
        { status: 'paused', first_failure_at: null, recovered_at: null },
        REAL_VISUALS,
        GRACE_DAYS,
        NOW,
      );
      expect(out).toEqual({ state: 'none' });
    });
  });
});

describe('extractVisualsFromStripeSubscription', () => {
  it('extracts card + invoice + period_end from an expanded subscription', () => {
    const fakeSub = {
      default_payment_method: { card: { brand: 'mastercard', last4: '5555' } },
      latest_invoice: {
        attempt_count: 2,
        next_payment_attempt: Math.floor(NOW.getTime() / 1000) + 86400,
        amount_due: 9900,
        currency: 'usd',
      },
      current_period_end: Math.floor(NOW.getTime() / 1000) + 14 * 86400,
    } as unknown as Parameters<typeof extractVisualsFromStripeSubscription>[0];

    const out = extractVisualsFromStripeSubscription(fakeSub);
    expect(out.cardBrand).toBe('mastercard');
    expect(out.cardLast4).toBe('5555');
    expect(out.attemptCount).toBe(2);
    expect(out.amountCents).toBe(9900);
    expect(out.currency).toBe('usd');
    expect(out.nextRetryDate).toBeTruthy();
    expect(out.currentPeriodEnd).toBeTruthy();
  });

  it('returns sensible defaults when subscription fields are missing', () => {
    const fakeSub = {} as unknown as Parameters<typeof extractVisualsFromStripeSubscription>[0];
    const out = extractVisualsFromStripeSubscription(fakeSub);
    expect(out.cardBrand).toBe('');
    expect(out.cardLast4).toBe('');
    expect(out.attemptCount).toBe(0);
    expect(out.nextRetryDate).toBeNull();
    expect(out.currentPeriodEnd).toBeNull();
  });
});
