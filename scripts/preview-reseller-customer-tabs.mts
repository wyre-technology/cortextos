// Preview for Track C step 5 — the 7 per-org management tabs.
// Renders each tab × dark/light into /tmp.
//
// The Usage tab loads live from the reseller-scoped dashboard endpoint,
// which a static file:// preview can't reach. So for that tab this script
// injects a window.fetch stub (mock usage payload) ahead of the page
// loader — the tab then populates exactly as it would in production.
//
// Usage: tsx scripts/preview-reseller-customer-tabs.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderCustomerTab,
  CUSTOMER_TAB_STYLES,
  type CustomerTabId,
  type CustomerTabData,
} from '../src/web/templates/reseller-customer-tabs.js';
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

function data(tab: CustomerTabId): CustomerTabData {
  return {
    org,
    customer,
    tab,
    mcps: [
      { vendor: 'Autotask', pattern: 'OEM · BYOC', seats: '8/12 users', status: 'healthy' },
      { vendor: 'Datto RMM', pattern: 'OEM · BYOC', seats: '12/12 users', status: 'healthy' },
      { vendor: 'Huntress', pattern: 'OEM · BYOC', seats: '6/12 users', status: 'degraded' },
      { vendor: 'ITGlue', pattern: 'OEM · BYOC', seats: '12/12 users', status: 'healthy' },
    ],
    members: [
      { name: 'C. Ramirez', email: 'cramirez@am3-it.com', role: 'Owner', department: 'Service Delivery', toolAccess: 'All MCPs', lastActive: '12m ago' },
      { name: 'J. Martinez', email: 'jmartinez@am3-it.com', role: 'Admin', department: 'Service Delivery', toolAccess: 'All MCPs', lastActive: '1h ago' },
      { name: 'K. Williams', email: 'kwilliams@am3-it.com', role: 'Member', department: 'Help Desk', toolAccess: 'Autotask, Datto RMM', lastActive: '3h ago' },
    ],
    memberTotal: 12,
    toolDepartment: 'Service Delivery (4 users)',
    toolDepartments: ['Service Delivery', 'Help Desk'],
    toolGroups: [
      { name: 'Tickets', tools: [{ name: 'create_ticket', enabled: true }, { name: 'search_tickets', enabled: true }, { name: 'delete_ticket', enabled: false }] },
      { name: 'Devices', tools: [{ name: 'list_devices', enabled: true }, { name: 'reboot_device', enabled: false }] },
    ],
    audit: [
      { when: '12m ago', actor: 'C. Ramirez', action: 'mcp.tool.invoke', target: 'Autotask · search_tickets' },
      { when: '1h ago', actor: 'J. Martinez', action: 'member.invite', target: 'newhire@am3-it.com' },
      { when: '3h ago', actor: 'C. Ramirez', action: 'tool.access.grant', target: 'Datto RMM' },
    ],
    billingPlan: 'Business',
    billingRate: '$49 / user / month',
    invoices: [
      { number: 'INV-2026-0042', date: '2026-05-01', amount: '$588.00', status: 'paid' },
      { number: 'INV-2026-0031', date: '2026-04-01', amount: '$588.00', status: 'paid' },
    ],
  };
}

const mockUsage = {
  totalCalls: 8247,
  uniqueUsers: 11,
  avgResponseTimeMs: 142,
  byVendor: [
    { vendor: 'Autotask', count: 4120 },
    { vendor: 'Datto RMM', count: 2630 },
    { vendor: 'Huntress', count: 994 },
    { vendor: 'ITGlue', count: 503 },
  ],
  byUser: [],
  byDay: [],
  bySource: [
    { source: 'claude.ai', count: 6210 },
    { source: 'Claude Code', count: 2037 },
  ],
};

const mockAudit = {
  entries: [
    { when: new Date(Date.now() - 12 * 60000).toISOString(), actor: 'C. Ramirez', action: 'mcp.tool.invoke', target: 'autotask · search_tickets' },
    { when: new Date(Date.now() - 3 * 3600000).toISOString(), actor: 'J. Martinez', action: 'mcp.tool.invoke', target: 'datto-rmm · list_devices' },
    { when: new Date(Date.now() - 2 * 86400000).toISOString(), actor: 'kwilliams@am3-it.com', action: 'mcp.tool.invoke', target: 'huntress · list_incidents' },
  ],
};

// The Usage and Audit tabs both client-fetch; branch the stub on URL.
const fetchStub = `
<script>
  window.fetch = function (url) {
    var body = String(url).indexOf('/audit') !== -1
      ? ${JSON.stringify(JSON.stringify(mockAudit))}
      : ${JSON.stringify(JSON.stringify(mockUsage))};
    return Promise.resolve({ ok: true, json: function () {
      return Promise.resolve(JSON.parse(body));
    } });
  };
</script>`;

const tabs: CustomerTabId[] = ['mcps', 'users', 'usage', 'tools', 'audit', 'billing', 'settings'];

const written: string[] = [];
for (const tab of tabs) {
  const { body, pageScripts } = renderCustomerTab(data(tab));
  const html = renderLayout(
    {
      user,
      org,
      activePath: `/org/customers/${customer.id}/${tab}`,
      title: `${org.name} - ${customer.name} - ${tab}`,
      navMode: 'customer-detail',
      customerContext: {
        id: customer.id,
        name: customer.name,
        siblings: [
          { id: customer.id, name: customer.name },
          { id: 'cust_mock_2', name: 'Team DNS Solutions' },
          { id: 'cust_mock_3', name: 'Mountain MSP Group' },
        ],
      },
      pageStyles: CUSTOMER_TAB_STYLES,
      pageScripts: pageScripts ? fetchStub + pageScripts : '',
    },
    body,
  );

  for (const theme of ['dark', 'light'] as const) {
    const path = `/tmp/customer-tab-${tab}-${theme}.html`;
    const themed = theme === 'light'
      ? html.replace(
          '<script>\n    (function() {',
          `<script>\n    localStorage.setItem('gateway-theme', 'light');\n    (function() {`,
        )
      : html;
    writeFileSync(path, themed);
    written.push(path);
  }
}

console.log(`Wrote ${written.length} preview files:`);
for (const p of written) console.log('  ' + p);
