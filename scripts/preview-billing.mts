// Preview script for /org/billing — IA shell + dunning states.
//
// Renders the page across {none, payment-failing, past-due, final-warning,
// final-warning-last-48h, suspended, recovered} × {dark, light} into /tmp
// using mock user/org/data so reviewers can open the files in a browser
// without needing a running server or seeded database.
//
// Usage: tsx scripts/preview-billing.mts
//        then open the paths printed at the end.

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderTeamBilling,
  TEAM_BILLING_STYLES,
  DUNNING_TOAST_SCRIPT,
  type TeamBillingData,
  type DunningView,
} from '../src/web/templates/team-billing.js';
import { getPlan } from '../src/billing/plan-catalog.js';

const plan = getPlan('pro')!;
const memberCount = 6;
const creditsAllocated = plan.creditAllocation * memberCount;

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

const baseInvoices: TeamBillingData['invoices'] = [
  { id: 'in_001', number: '2026-0042', date: new Date(Date.now() - 16 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
  { id: 'in_002', number: '2026-0035', date: new Date(Date.now() - 46 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
  { id: 'in_003', number: '2026-0028', date: new Date(Date.now() - 76 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
  { id: 'in_004', number: '2026-0021', date: new Date(Date.now() - 106 * 86_400_000).toISOString(), amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
];

const FIVE_DAYS_FUT = new Date(Date.now() + 5 * 86_400_000).toISOString();
const TWO_DAYS_FUT = new Date(Date.now() + 2 * 86_400_000).toISOString();
const THIRTY_SIX_HOURS = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();
const FOUR_DAYS_AGO = new Date(Date.now() - 4 * 86_400_000).toISOString();
const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60_000).toISOString();

function buildData(dunning: DunningView): TeamBillingData {
  return {
    org: baseOrg,
    plan,
    memberCount,
    creditsUsed: Math.floor(creditsAllocated * 0.37),
    creditsAllocated,
    paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
    nextInvoice: {
      amountCents: 4900,
      currency: 'usd',
      dueDate: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    },
    invoices: baseInvoices,
    dunning,
    firstName: 'Aaron',
  };
}

const user = {
  sub: 'auth0|preview',
  email: 'aaron@wyretechnology.com',
  name: 'Aaron',
  emailVerified: true,
};

const scenarios: Array<{ slug: string; dunning: DunningView }> = [
  { slug: 'none',                dunning: { state: 'none' } },
  { slug: 'payment-failing',     dunning: { state: 'payment-failing', firstFailDate: FOUR_DAYS_AGO, attemptCount: 2, nextRetryDate: TWO_DAYS_FUT, cardBrand: 'visa', cardLast4: '4242', amountCents: 4900, currency: 'usd' } },
  { slug: 'past-due',            dunning: { state: 'past-due',        firstFailDate: TEN_DAYS_AGO,  attemptCount: 4, nextRetryDate: TWO_DAYS_FUT, cardBrand: 'visa', cardLast4: '4242', amountCents: 4900, currency: 'usd' } },
  { slug: 'final-warning',       dunning: { state: 'final-warning',   firstFailDate: TEN_DAYS_AGO,  attemptCount: 6, serviceEndDate: FIVE_DAYS_FUT, cardBrand: 'visa', cardLast4: '4242', amountCents: 4900, currency: 'usd' } },
  { slug: 'final-warning-last48',dunning: { state: 'final-warning',   firstFailDate: TEN_DAYS_AGO,  attemptCount: 6, serviceEndDate: THIRTY_SIX_HOURS, cardBrand: 'visa', cardLast4: '4242', amountCents: 4900, currency: 'usd' } },
  { slug: 'suspended',           dunning: { state: 'suspended',       firstFailDate: TEN_DAYS_AGO,  attemptCount: 7, suspendedAt: FOUR_DAYS_AGO, cardBrand: 'visa', cardLast4: '4242' } },
  { slug: 'recovered',           dunning: { state: 'recovered',       recoveredAt: FIVE_MIN_AGO, amountCents: 4900, currency: 'usd', nextChargeDate: new Date(Date.now() + 30 * 86_400_000).toISOString() } },
];

const themes: Array<'dark' | 'light'> = ['dark', 'light'];

const written: string[] = [];
for (const sc of scenarios) {
  const data = buildData(sc.dunning);
  const pageScripts = sc.dunning.state === 'recovered' ? DUNNING_TOAST_SCRIPT : undefined;
  const html = renderLayout(
    {
      user,
      org: data.org,
      activePath: '/org/billing',
      title: `${data.org.name} - Billing`,
      pageStyles: TEAM_BILLING_STYLES,
      pageScripts,
    },
    renderTeamBilling(data),
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
