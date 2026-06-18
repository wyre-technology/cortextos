import { describe, it, expect } from 'vitest';
import type { Organization } from '../../org/org-service.js';
import { getPlan } from '../../billing/plan-catalog.js';
import { makeSeatBilling, EAP_WAIVER } from './test-helpers/seat-billing-fixture.js';
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
  auth0OrgId: null,
  suspendedAt: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-15T00:00:00Z',
};

function mockData(
  dunning: DunningView,
  over: Partial<TeamBillingData> = {},
): TeamBillingData {
  const plan = getPlan('conduit')!;
  const seatBilling = makeSeatBilling(4, 0); // 4 humans, 0 agents
  return {
    org: mockOrg,
    plan,
    seatBilling,
    trial: null,
    dunning,
    firstName: 'Aaron',
    ...over,
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

  // Ruby PSR2 (2026-06-05, Aaron-option-A): post-suspension recovery
  // gets a distinct copy variant. Routine recovery preserved.
  it('PSR2: post-suspension recovery renders Welcome back / Your service is restored', () => {
    const html = renderRecoveredToast({ ...RECOVERED, wasPreviouslySuspended: true });
    expect(html).toContain('Welcome back.');
    expect(html).toContain('Your service is restored.');
    expect(html).not.toContain("You're set");
    expect(html).not.toContain('Card was charged successfully');
  });

  it('PSR2: routine recovery (wasPreviouslySuspended omitted/false) preserves existing copy', () => {
    const html = renderRecoveredToast({ ...RECOVERED, wasPreviouslySuspended: false });
    expect(html).toContain("You're set.");
    expect(html).toContain('Card was charged successfully.');
    expect(html).not.toContain('Welcome back');
    expect(html).not.toContain('Your service is restored');
  });

  it('PSR2: wasPreviouslySuspended undefined defaults to routine copy (backward-compat)', () => {
    // Explicitly omit the field — existing call-sites that haven't
    // upgraded to pass it shouldn't change behavior.
    const html = renderRecoveredToast(RECOVERED);
    expect(html).toContain("You're set.");
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

describe('renderTeamBilling — Layer 1 §8 composed bill', () => {
  it('renders the composed bill and the period-comma seat breakdown line', () => {
    // AGENTS-BILLABLE (Aaron 2026-06-17, WYREAI-25): every agent is a $39
    // billable seat. 5 humans + 2 agents = 7 billable seats → $672/mo.
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2),
    }));
    expect(html).toContain('$399 base + 7 seats × $39 = $672/mo');
    expect(html).toContain('7 seats. 5 members, 2 agents.');
    expect(html).toContain('$672/mo'); // the prominent total
  });

  it('every additional agent adds $39 — no free-agent tier', () => {
    // 5 humans + 4 agents = 9 billable seats → $750/mo.
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 4),
    }));
    expect(html).toContain('9 seats. 5 members, 4 agents.');
    expect(html).toContain('$750/mo');
  });

  it('drops the obsolete "Change plan" button (one paid plan, nothing to change to)', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }));
    expect(html).not.toContain('Change plan');
  });

  it('off-trial: the bill is labelled as the live monthly charge', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, { trial: null }));
    expect(html).toContain('Monthly bill');
    expect(html).not.toContain('After your trial');
    expect(html).not.toContain('trial-banner');
  });

  it('on-trial: trial banner shown + the bill framed as post-trial', () => {
    const endsAt = new Date(Date.now() + 9 * 86_400_000).toISOString();
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(1, 0), // $438/mo recurring total
      trial: { endsAt },
    }));
    expect(html).toContain('trial-banner');
    expect(html).toContain('Free trial — 9 days left');
    // First-charge amount = the composed-bill recurring total, single-sourced.
    expect(html).toContain('Your first charge is $438.00 on ');
    expect(html).toContain('Nothing is billed before then');
    expect(html).toContain('After your trial');
  });

  it('the trial first-charge amount equals the composed-bill total (single source)', () => {
    const endsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 4), // $750/mo at AGENTS-BILLABLE math
      trial: { endsAt },
    }));
    expect(html).toContain('Your first charge is $750.00 on ');
    expect(html).toContain('$399 base + 9 seats × $39 = $750/mo'); // same number
  });

  it('on-trial with 1 day left — singular copy', () => {
    const endsAt = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      trial: { endsAt },
    }));
    expect(html).toContain('Free trial — 1 day left');
  });

  it('on-trial ending today — "ends today" copy', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      trial: { endsAt: new Date().toISOString() },
    }));
    expect(html).toContain('Free trial — ends today');
  });

  it('a malformed trial-end date degrades to honest-vague, never "Invalid Date"', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      trial: { endsAt: 'not-a-date' },
    }));
    expect(html).not.toContain('Invalid Date');
    expect(html).toContain('when the trial ends');
  });

  it('shows the two-line-item invoice reconcile note (S4)', () => {
    // Ruby voice-batch (msg-1781750560957) folded the existing em-dash
    // ICP-violation in this note into the EAP PR. Reconcile-note now reads:
    //   "Your invoice itemizes this as two lines: the $399 base and the
    //    per-seat charge. Both reconcile exactly with the breakdown above."
    const html = renderTeamBilling(mockData({ state: 'none' }));
    expect(html).toContain('itemizes this as two lines');
    expect(html).toContain('reconcile exactly');
  });
});

describe('renderTeamBilling — EAP waiver render (WYREAI-25 (b))', () => {
  // Ruby voice-batch APPROVED (msg-1781750560957):
  //   - Chip:        "Early Adopter Program · $0 org fee"
  //   - Composed:    "7 seats × $39 = $273/mo" (no $399 prefix)
  //   - Section-desc: "Everything included. $39 per seat. Your org fee is
  //                    waived under the Early Adopter Program."
  //   - Reconcile:   "Your invoice shows the seat charge only. Your org
  //                    fee is waived under the Early Adopter Program."
  //   - Tooltip:     "Granted by {admin} on Jun 18, 2026" (on chip hover)

  it('renders the EAP indicator chip with the locked voice-batch copy', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
      eapGrantedByDisplayName: 'Aaron Sachs',
    }));
    expect(html).toContain('Early Adopter Program · $0 org fee');
    expect(html).toContain('eap-waiver-chip');
  });

  it('renders the on-hover pedigree tooltip from granted_by + granted_at', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
      eapGrantedByDisplayName: 'Aaron Sachs',
    }));
    // Date is "Jun 18, 2026" from the fixture's 2026-06-18T00:00:00Z
    // timestamp (UTC midnight; toLocaleDateString in the CI tz still
    // resolves to Jun 18 in most non-UTC tz, but the test pins on the
    // display-name + Jun 18 substring to keep it tz-stable for any
    // tz at most 12h behind UTC).
    expect(html).toContain('Granted by Aaron Sachs');
    expect(html).toContain('Jun 18, 2026');
  });

  it('falls back to raw user_id in tooltip when display name is null', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
      eapGrantedByDisplayName: null,
    }));
    // EAP_WAIVER fixture grantedBy is 'test-admin' (see seat-billing-fixture).
    expect(html).toContain('Granted by test-admin');
  });

  it('composed bill collapses to pure-math no-prefix form ("N seats × $39 = $X/mo")', () => {
    // 5 humans + 2 agents = 7 billable seats × $39 = $273. Base waived.
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
    }));
    expect(html).toContain('7 seats × $39 = $273/mo');
    expect(html).not.toContain('$399 base + 7 seats');
  });

  it('section-desc swaps to the waived variant (no "$399 base plus" copy)', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
    }));
    expect(html).toContain('$39 per seat. Your org fee is waived under the Early Adopter Program');
    expect(html).not.toContain('$399 base plus');
  });

  it('reconcile-note swaps to the single-line variant', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
    }));
    expect(html).toContain('Your invoice shows the seat charge only');
    expect(html).toContain('Your org fee is waived under the Early Adopter Program');
    expect(html).not.toContain('itemizes this as two lines');
  });

  it('un-waived org renders exactly as before — no EAP chip leak', () => {
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2),
    }));
    expect(html).not.toContain('Early Adopter Program');
    expect(html).not.toContain('eap-waiver-chip');
    expect(html).toContain('$399 base + 7 seats × $39 = $672/mo');
  });

  it('trial first-charge under EAP equals the (waived) composed-bill total (SoT contract)', () => {
    // Single-source held through the EAP wire: trial banner first-charge
    // pulls from seatBilling.monthlyTotalCents, which applyDiscounts has
    // already reduced to $273 (no $399 base). The Stripe sub-create
    // factory (subscription-factory.ts) reads the same SeatBilling and
    // omits the basePriceId line — Stripe will charge $273 at trial_end,
    // identical to what the banner says here.
    const endsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const html = renderTeamBilling(mockData({ state: 'none' }, {
      seatBilling: makeSeatBilling(5, 2, [EAP_WAIVER]),
      trial: { endsAt },
    }));
    expect(html).toContain('Your first charge is $273.00 on ');
    expect(html).toContain('7 seats × $39 = $273/mo'); // same number, math-form
  });
});
