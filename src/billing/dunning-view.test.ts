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
  });

  describe('terminal states', () => {
    it.each(['canceled', 'incomplete_expired'])(
      'returns suspended for %s status regardless of grace',
      (status) => {
        const out = mapSubscriptionToDunningView(
          { status, first_failure_at: null, recovered_at: null },
          REAL_VISUALS,
          GRACE_DAYS,
          NOW,
        );
        expect(out.state).toBe('suspended');
      },
    );
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
