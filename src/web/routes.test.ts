import { describe, it, expect } from 'vitest';
import { deriveTrialFromSubscription } from './routes.js';

/**
 * Regression-guard for the trial-banner dead-code fix (ruby HIGH-severity
 * launch-blocker audit 2026-06-04, PR following #341/#342). Before this
 * fix, /org/billing hard-coded `const trial = null;` for every request,
 * so a trialing customer saw their post-trial amount labeled "Monthly
 * bill" with no free-trial banner — Tier-3 customer-facing active-
 * inversion. The fix routes the trial state through
 * `deriveTrialFromSubscription`, which reads the same `subscriptions`
 * row that backs the dunning + service-active gates (single-source-pin).
 *
 * The falsifiable triad for this helper:
 *  (a) trialing + period-end present -> banner ON, endsAt is the ISO date
 *  (b) NOT trialing (active/cancelled/past_due/etc) -> banner OFF
 *  (c) trialing but no period-end -> banner OFF (defensive: no days-left
 *      to render without it)
 */
describe('deriveTrialFromSubscription — trial-banner derivation', () => {
  it('returns a TrialState carrying the period-end ISO when status=trialing', () => {
    const endsAt = new Date('2026-06-18T00:00:00.000Z');
    const trial = deriveTrialFromSubscription({
      status: 'trialing',
      current_period_end: endsAt,
    });
    expect(trial).toEqual({ endsAt: '2026-06-18T00:00:00.000Z' });
  });

  it('returns null when the org has no subscription row', () => {
    expect(deriveTrialFromSubscription(null)).toBeNull();
  });

  it('returns null for non-trialing statuses (active/canceled/past_due/etc)', () => {
    const endsAt = new Date('2026-06-18T00:00:00.000Z');
    for (const status of ['active', 'canceled', 'past_due', 'incomplete', 'unpaid']) {
      expect(
        deriveTrialFromSubscription({ status, current_period_end: endsAt }),
      ).toBeNull();
    }
  });

  it('returns null when trialing but current_period_end is missing (defense in depth)', () => {
    // Without a period-end we cannot render the days-left countdown OR the
    // "first charge on <date>" line — the banner depends on both. Refuse
    // to render rather than show a half-state banner.
    expect(
      deriveTrialFromSubscription({ status: 'trialing', current_period_end: null }),
    ).toBeNull();
  });
});
