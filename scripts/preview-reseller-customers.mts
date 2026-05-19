// Preview for Track C Surface 1 — Reseller Dashboard (Customers list).
// Renders /org/customers with mock data × dark/light into /tmp.
//
// Usage: tsx scripts/preview-reseller-customers.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderResellerCustomers,
  RESELLER_CUSTOMERS_STYLES,
  RESELLER_CUSTOMERS_SCRIPT,
  type ResellerCustomer,
} from '../src/web/templates/reseller-customers.js';
import type { Organization } from '../src/org/org-service.js';

const org: Organization = {
  id: 'org_preview',
  name: 'WYRE Technology',
  ownerId: 'auth0|preview',
  plan: 'business',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: 'cus_preview',
  stripeSubscriptionId: 'sub_preview',
  type: 'reseller',
  parentOrgId: null,
  createdAt: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-16T00:00:00Z',
};

const user = {
  sub: 'auth0|preview',
  email: 'aaron@wyretechnology.com',
  name: 'Aaron',
  emailVerified: true,
};

const min = 60 * 1000;
const now = Date.now();
const customers: ResellerCustomer[] = [
  { id: 'c1', name: 'AM3 Technology & Cybersecurity', subdomain: 'am3.conduit.wyre.ai',     plan: 'business', userCount: 12, mcpCalls30d: 8247,  lastActivity: new Date(now - 2 * min).toISOString() },
  { id: 'c2', name: 'Team DNS Solutions',             subdomain: 'teamdns.conduit.wyre.ai', plan: 'pro',      userCount: 8,  mcpCalls30d: 3182,  lastActivity: new Date(now - 47 * min).toISOString() },
  { id: 'c3', name: 'Mountain MSP Group',             subdomain: 'mtnmsp.conduit.wyre.ai',  plan: 'pro',      userCount: 6,  mcpCalls30d: 1094,  lastActivity: new Date(now - 3 * 60 * min).toISOString() },
  { id: 'c4', name: 'Coastal IT Partners',            subdomain: 'coastal.conduit.wyre.ai', plan: 'business', userCount: 15, mcpCalls30d: 12403, lastActivity: new Date(now - 24 * 60 * min).toISOString() },
];

const html = renderLayout(
  {
    user,
    org,
    activePath: '/org/customers',
    title: `${org.name} - Customers`,
    pageStyles: RESELLER_CUSTOMERS_STYLES,
    pageScripts: RESELLER_CUSTOMERS_SCRIPT,
  },
  renderResellerCustomers({ org, customers }),
);

const written: string[] = [];
for (const theme of ['dark', 'light'] as const) {
  const path = `/tmp/reseller-customers-${theme}.html`;
  const body = theme === 'light'
    ? html.replace(
        '<script>\n    (function() {',
        `<script>\n    localStorage.setItem('gateway-theme', 'light');\n    (function() {`,
      )
    : html;
  writeFileSync(path, body);
  written.push(path);
}

console.log(`Wrote ${written.length} preview files:`);
for (const p of written) console.log('  ' + p);
