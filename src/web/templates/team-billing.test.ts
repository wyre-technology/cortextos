import { describe, it, expect } from 'vitest';
import type { Organization } from '../../org/org-service.js';
import { getPlan } from '../../billing/plan-catalog.js';
import {
  renderDunningBanner,
  renderDunningChip,
  renderCountdownWidget,
  renderSuspendedView,
  renderRecoveredToast,
  renderTeamBilling,
  type DunningView,
  type DunningStateActive,
  type DunningStateFinalWarning,
  type DunningStateSuspended,
  type DunningStateRecovered,
  type TeamBillingData,
} from './team-billing.js';

const FUTURE_DATE = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
const NEAR_FUTURE = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
const FRESH_RECOVERY = new Date(Date.now() - 5 * 60 * 1000).toISOString();

const mockOrg: Organization = {
  id: 'org_test',
  name: 'Acme MSP',
  ownerId: 'auth0|1',
  plan: 'pro',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: 'cus_test',
  stripeSubscriptionId: 'sub_test',
  type: 'standalone',
  parentOrgId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};

function mockData(dunning: DunningView): TeamBillingData {
  const plan = getPlan('pro')!;
  return {
    org: mockOrg,
    plan,
    memberCount: 4,
    creditsUsed: 1200,
    creditsAllocated: plan.creditAllocation * 4,
    dunning,
    firstName: 'Aaron',
    availableCreditPacks: [1000, 2500, 5000],
  };
}

const ACTIVE_FAILING: DunningStateActive = {
  state: 'payment-failing',
  firstFailDate: PAST_DATE,
  attemptCount: 2,
  nextRetryDate: FUTURE_DATE,
  cardBrand: 'visa',
  cardLast4: '4242',
  amountCents: 4900,
  currency: 'usd',
};

const ACTIVE_PAST_DUE: DunningStateActive = {
  ...ACTIVE_FAILING,
  state: 'past-due',
  attemptCount: 4,
};

const FINAL_WARN_NORMAL: DunningStateFinalWarning = {
  state: 'final-warning',
  firstFailDate: PAST_DATE,
  attemptCount: 6,
  serviceEndDate: FUTURE_DATE,
  cardBrand: 'visa',
  cardLast4: '4242',
  amountCents: 4900,
  currency: 'usd',
};

const FINAL_WARN_LAST_48: DunningStateFinalWarning = {
  ...FINAL_WARN_NORMAL,
  serviceEndDate: NEAR_FUTURE,
};

const SUSPENDED: DunningStateSuspended = {
  state: 'suspended',
  firstFailDate: PAST_DATE,
  attemptCount: 7,
  suspendedAt: PAST_DATE,
  cardBrand: 'visa',
  cardLast4: '4242',
};

const RECOVERED: DunningStateRecovered = {
  state: 'recovered',
  recoveredAt: FRESH_RECOVERY,
  amountCents: 4900,
  currency: 'usd',
  nextChargeDate: FUTURE_DATE,
};

describe('renderDunningBanner', () => {
  it('returns empty for none / suspended / recovered', () => {
    expect(renderDunningBanner({ state: 'none' }, null)).toBe('');
    expect(renderDunningBanner(SUSPENDED, null)).toBe('');
    expect(renderDunningBanner(RECOVERED, null)).toBe('');
  });

  it('renders info variant for payment-failing', () => {
    const html = renderDunningBanner(ACTIVE_FAILING, 'Aaron');
    expect(html).toContain('dunning-banner--info');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Update payment method');
    expect(html).toContain('4242');
  });

  it('renders warn variant for past-due', () => {
    const html = renderDunningBanner(ACTIVE_PAST_DUE, 'Aaron');
    expect(html).toContain('dunning-banner--warn');
    expect(html).toContain('still being declined');
  });

  it('renders warn for final-warning when more than 48h remain', () => {
    const html = renderDunningBanner(FINAL_WARN_NORMAL, null);
    expect(html).toContain('dunning-banner--warn');
    expect(html).toContain('Service pauses in');
    expect(html).toContain('dunning-countdown');
  });

  it('escalates to urgent variant in last 48h of final-warning', () => {
    const html = renderDunningBanner(FINAL_WARN_LAST_48, null);
    expect(html).toContain('dunning-banner--urgent');
    expect(html).toContain('dunning-countdown--urgent');
  });
});

describe('renderCountdownWidget', () => {
  it('renders fill percentage + tabular digits', () => {
    const html = renderCountdownWidget(FUTURE_DATE, false);
    expect(html).toContain('dunning-countdown--warn');
    expect(html).toContain('data-service-end="' + FUTURE_DATE + '"');
    expect(html).toMatch(/width:\s*\d+%/);
  });

  it('renders urgent variant when flagged', () => {
    expect(renderCountdownWidget(NEAR_FUTURE, true)).toContain('dunning-countdown--urgent');
  });
});

describe('renderDunningChip', () => {
  it.each([
    ['none', { state: 'none' } as DunningView, ''],
    ['suspended', SUSPENDED, ''],
    ['recovered', RECOVERED, ''],
  ])('returns empty for %s state', (_label, dunning, expected) => {
    expect(renderDunningChip(dunning)).toBe(expected);
  });

  it('renders the three banner-bearing states with the right copy + variant', () => {
    expect(renderDunningChip(ACTIVE_FAILING)).toMatch(/dunning-chip--info[^>]*>Charge didn't go through/);
    expect(renderDunningChip(ACTIVE_PAST_DUE)).toMatch(/dunning-chip--warn[^>]*>Past due</);
    expect(renderDunningChip(FINAL_WARN_NORMAL)).toMatch(/dunning-chip--warn[^>]*>Service pausing soon</);
  });
});

describe('renderSuspendedView', () => {
  it('renders the full-page card with brand + last4 + attempt count', () => {
    const html = renderSuspendedView(SUSPENDED, 'Aaron');
    expect(html).toContain('Your service is paused');
    expect(html).toContain('visa');
    expect(html).toContain('4242');
    expect(html).toContain('7 attempts');
    expect(html).toContain('Update payment method');
    expect(html).toContain('Contact support');
  });
});

describe('renderRecoveredToast', () => {
  it('renders auto-dismiss toast with dismiss button', () => {
    const html = renderRecoveredToast(RECOVERED);
    expect(html).toContain('data-auto-dismiss="8000"');
    expect(html).toContain("You're set");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe('renderTeamBilling insertion logic', () => {
  it('omits the banner + chip + toast in the none state', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }));
    expect(html).not.toContain('dunning-banner');
    expect(html).not.toContain('dunning-chip');
    expect(html).not.toContain('dunning-toast');
    expect(html).toContain('Billing'); // normal heading
  });

  it('inserts the banner above the H1 for active states', () => {
    const html = renderTeamBilling(mockData(ACTIVE_FAILING));
    expect(html).toContain('dunning-banner--info');
    expect(html.indexOf('dunning-banner')).toBeLessThan(html.indexOf('<h1'));
  });

  it('replaces the four-card grid with the suspended card', () => {
    const html = renderTeamBilling(mockData(SUSPENDED));
    expect(html).toContain('suspended-card');
    expect(html).not.toContain('billing-grid');
    expect(html).not.toContain('Current plan');
    // Billing details block still rendered below the suspended card.
    expect(html).toContain('Billing details');
  });

  it('appends the recovered toast on a normal layout', () => {
    const html = renderTeamBilling(mockData(RECOVERED));
    expect(html).toContain('dunning-toast--success');
    expect(html).toContain('billing-grid'); // normal layout still rendered
    expect(html.indexOf('dunning-toast')).toBeGreaterThan(html.indexOf('Billing details'));
  });
});

describe('renderTeamBilling — billing details block (F3)', () => {
  it('Arm 1: links to the Stripe portal when the org has a Stripe customer', () => {
    // mockOrg has stripeCustomerId: 'cus_test'.
    const html = renderTeamBilling(mockData({ state: 'none' }));
    expect(html).toContain('Billing details');
    expect(html).toContain('Open billing portal');
    expect(html).toContain('/api/billing/portal');
    expect(html).not.toContain('managed directly');
  });

  it('Arm 2: renders the managed-directly state when the org has no Stripe customer', () => {
    const data = mockData({ state: 'none' });
    const html = renderTeamBilling({
      ...data,
      org: { ...data.org, stripeCustomerId: null },
    });
    expect(html).toContain('Billing details');
    expect(html).toContain('managed directly');
    expect(html).not.toContain('Open billing portal');
    expect(html).not.toContain('/api/billing/portal');
  });

  it('renders NO fabricated billing data — no mock card, invoices, or next-invoice section', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }));
    expect(html).not.toContain('4242');            // the old mock card last4
    expect(html).not.toContain('Payment method');  // the old mock card heading
    expect(html).not.toContain('Invoice history'); // the old mock invoice section
    expect(html).not.toContain('Next invoice');    // the old mock next-invoice card
  });
});
