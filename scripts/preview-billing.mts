// Preview script for /org/billing — Layer 1 §8 composed-bill surface.
//
// Renders the page across seat scenarios (decision-of-record §5 examples)
// × trial on/off, plus a dunning state to confirm the dunning banner still
// composes above the trial banner, into /tmp — open the files in a browser
// without a running server.
//
// Usage: tsx scripts/preview-billing.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderTeamBilling,
  TEAM_BILLING_STYLES,
  type TeamBillingData,
  type DunningView,
  type TrialState,
} from '../src/web/templates/team-billing.js';
import { getPlan } from '../src/billing/plan-catalog.js';
import { mockSeatBilling } from '../src/billing/seat-billing.js';

const plan = getPlan('pro')!;

const baseOrg: TeamBillingData['org'] = {
  id: 'org_preview_001',
  name: 'Acme MSP',
  ownerId: 'auth0|preview-owner',
  plan: 'pro',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: 'cus_preview',
  stripeSubscriptionId: 'sub_preview',
  type: 'standalone',
  parentOrgId: null,
  createdAt: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-13T00:00:00Z',
};

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();
const FIVE_DAYS_FUT = new Date(Date.now() + 5 * 86_400_000).toISOString();

function buildData(
  humans: number,
  agents: number,
  trial: TrialState | null,
  dunning: DunningView,
): TeamBillingData {
  const seatBilling = mockSeatBilling(humans, agents);
  return {
    org: baseOrg,
    plan,
    seatBilling,
    trial,
    creditsUsed: Math.floor(plan.creditAllocation * seatBilling.creditSeats * 0.37),
    creditsAllocated: plan.creditAllocation * seatBilling.creditSeats,
    dunning,
    firstName: 'Aaron',
    availableCreditPacks: [1000, 2500, 5000],
  };
}

const user = {
  sub: 'auth0|preview',
  email: 'aaron@wyretechnology.com',
  name: 'Aaron',
  emailVerified: true,
};

const none: DunningView = { state: 'none' };

const scenarios: Array<{ slug: string; data: TeamBillingData }> = [
  // Seat scenarios — decision-of-record §5.
  { slug: 'seats-5h2a',        data: buildData(5, 2, null, none) },   // all agents included
  { slug: 'seats-5h4a',        data: buildData(5, 4, null, none) },   // 2 included, 2 billed
  { slug: 'seats-1h0a',        data: buildData(1, 0, null, none) },   // smallest paid org
  // Trial state.
  { slug: 'trial-5h2a',        data: buildData(5, 2, { daysRemaining: 9 }, none) },
  { slug: 'trial-ends-today',  data: buildData(3, 1, { daysRemaining: 0 }, none) },
  // Dunning still composes above the §8 content.
  {
    slug: 'dunning-final-warning',
    data: buildData(5, 4, null, {
      state: 'final-warning', firstFailDate: TEN_DAYS_AGO, attemptCount: 6,
      serviceEndDate: FIVE_DAYS_FUT, cardBrand: 'visa', cardLast4: '4242',
      amountCents: 4900, currency: 'usd',
    }),
  },
];

const themes: Array<'dark' | 'light'> = ['dark', 'light'];

const written: string[] = [];
for (const sc of scenarios) {
  const html = renderLayout(
    {
      user,
      org: sc.data.org,
      activePath: '/org/billing',
      title: `${sc.data.org.name} - Billing`,
      pageStyles: TEAM_BILLING_STYLES,
    },
    renderTeamBilling(sc.data),
  );
  for (const theme of themes) {
    const path = `/tmp/billing-${sc.slug}-${theme}.html`;
    const body = theme === 'light'
      ? html.replace(
          '<script>\n    (function() {',
          `<script>\n    localStorage.setItem('gateway-theme', 'light');\n    (function() {`,
        )
      : html;
    writeFileSync(path, body);
    written.push(path);
  }
}

console.log(`Wrote ${written.length} preview files:`);
for (const p of written) console.log('  ' + p);
