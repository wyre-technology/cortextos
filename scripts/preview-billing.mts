// Preview script for /org/billing IA shell.
// Renders the page to /tmp/billing-preview-{dark,light}.html using mock
// user/org/data so a designer or reviewer can open the file in a
// browser without needing a running server or seeded database.
//
// Usage: tsx scripts/preview-billing.mts
//        then open the two paths printed at the end.

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import { renderTeamBilling, TEAM_BILLING_STYLES, type TeamBillingData } from '../src/web/templates/team-billing.js';
import { getPlan } from '../src/web/../billing/plan-catalog.js';

const plan = getPlan('pro')!;
const memberCount = 6;
const creditsAllocated = plan.creditAllocation * memberCount;

const data: TeamBillingData = {
  org: {
    id: 'org_preview_001',
    name: 'Acme MSP',
    ownerId: 'auth0|preview-owner',
    plan: 'pro',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: 'cus_preview',
    stripeSubscriptionId: 'sub_preview',
    type: 'team',
    parentOrgId: null,
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-05-13T00:00:00Z',
  } as TeamBillingData['org'],
  plan,
  memberCount,
  creditsUsed: Math.floor(creditsAllocated * 0.37),
  creditsAllocated,
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
  nextInvoice: {
    amountCents: 4900,
    currency: 'usd',
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  invoices: [
    { id: 'in_001', number: '2026-0042', date: new Date(Date.now() - 16 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
    { id: 'in_002', number: '2026-0035', date: new Date(Date.now() - 46 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
    { id: 'in_003', number: '2026-0028', date: new Date(Date.now() - 76 * 86_400_000).toISOString(),  amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
    { id: 'in_004', number: '2026-0021', date: new Date(Date.now() - 106 * 86_400_000).toISOString(), amountCents: 4900, currency: 'usd', status: 'paid', pdfUrl: null },
  ],
};

const user = { sub: 'auth0|preview', email: 'aaron@wyretechnology.com', name: 'Aaron', emailVerified: true };

const html = renderLayout(
  { user, org: data.org, activePath: '/org/billing', title: `${data.org.name} - Billing`, pageStyles: TEAM_BILLING_STYLES },
  renderTeamBilling(data),
);

const darkPath = '/tmp/billing-preview-dark.html';
const lightPath = '/tmp/billing-preview-light.html';

writeFileSync(darkPath, html);
writeFileSync(
  lightPath,
  html.replace(
    '<script>\n    (function() {',
    `<script>\n    localStorage.setItem('gateway-theme', 'light');\n    (function() {`,
  ),
);

console.log('Dark:  ' + darkPath);
console.log('Light: ' + lightPath);
