// Preview for Track C Surface 2 — Customer Detail (/org/customers/:id).
// Renders the page × dark/light into /tmp.
//
// S2's analytics load client-side from the reseller-scoped dashboard
// endpoints, which a static file:// preview can't reach. So this script
// injects a window.fetch stub (mock usage/vendors payloads)
// ahead of the page loader — the page then populates exactly as it
// would in production, making the preview faithful for design review.
//
// Usage: tsx scripts/preview-reseller-customer-detail.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderResellerCustomerDetail,
  RESELLER_CUSTOMER_DETAIL_STYLES,
} from '../src/web/templates/reseller-customer-detail.js';
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

const customer = {
  id: 'cust_am3',
  name: 'AM3 Technology & Cybersecurity',
  plan: 'BUSINESS',
  userCount: 12,
  mcpCount: 4,
  subdomain: 'am3.conduit.wyre.ai',
};

// Mock payloads shaped like dashboard-service.ts read models.
// errorRate is included so the preview shows the populated card —
// production UsageSummary has no errorRate yet, so the live card
// exercises the em-dash fallback until that aggregate ships.
const mockUsage = {
  totalCalls: 8247,
  uniqueUsers: 11,
  avgResponseTimeMs: 142,
  errorRate: 0.008,
  byVendor: [],
  byUser: [
    { userId: 'u1', email: 'cramirez@am3-it.com', count: 3182 },
    { userId: 'u2', email: 'jmartinez@am3-it.com', count: 2417 },
    { userId: 'u3', email: 'kwilliams@am3-it.com', count: 1605 },
    { userId: 'u4', email: 'mchen@am3-it.com', count: 1043 },
  ],
  byDay: [],
  bySource: [],
};
const mockVendors = {
  vendors: [
    { vendor: 'Autotask', totalCalls: 4120, uniqueUsers: 8, avgResponseTimeMs: 168, topTools: [{ tool: 'search_tickets', count: 1840 }] },
    { vendor: 'Datto RMM', totalCalls: 2630, uniqueUsers: 12, avgResponseTimeMs: 121, topTools: [{ tool: 'list_devices', count: 980 }] },
    { vendor: 'Huntress', totalCalls: 994, uniqueUsers: 6, avgResponseTimeMs: 96, topTools: [{ tool: 'list_incidents', count: 412 }] },
    { vendor: 'ITGlue', totalCalls: 503, uniqueUsers: 12, avgResponseTimeMs: 210, topTools: [{ tool: 'search_documents', count: 221 }] },
  ],
};

const fetchStub = `
<script>
  window.fetch = function (url) {
    var body = url.indexOf('/usage') !== -1 ? ${JSON.stringify(JSON.stringify(mockUsage))}
      : ${JSON.stringify(JSON.stringify(mockVendors))};
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(body)); } });
  };
</script>`;

const { body, pageScripts } = renderResellerCustomerDetail({ org, customer });

const html = renderLayout(
  {
    user,
    org,
    activePath: `/org/customers/${customer.id}`,
    title: `${org.name} - ${customer.name}`,
    navMode: 'customer-detail',
    customerContext: { id: customer.id, name: customer.name },
    pageStyles: RESELLER_CUSTOMER_DETAIL_STYLES,
    // fetch stub must run before the page loader.
    pageScripts: fetchStub + pageScripts,
  },
  body,
);

const written: string[] = [];
for (const theme of ['dark', 'light'] as const) {
  const path = `/tmp/customer-detail-${theme}.html`;
  const themed = theme === 'light'
    ? html.replace(
        '<script>\n    (function() {',
        `<script>\n    localStorage.setItem('gateway-theme', 'light');\n    (function() {`,
      )
    : html;
  writeFileSync(path, themed);
  written.push(path);
}

console.log(`Wrote ${written.length} preview files:`);
for (const p of written) console.log('  ' + p);
