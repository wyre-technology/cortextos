// Preview for Track C Surface 3 — Onboard MCP Wizard.
// Renders all 4 steps × dark/light into /tmp.
//
// Usage: tsx scripts/preview-reseller-onboard-mcp.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderOnboardMcp,
  RESELLER_ONBOARD_MCP_STYLES,
  type OnboardMcpData,
  type OnboardStep,
} from '../src/web/templates/reseller-onboard-mcp.js';
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

function buildData(step: OnboardStep): OnboardMcpData {
  return {
    org,
    customerId: 'cust_am3',
    customerName: 'AM3 Technology',
    step,
    vendorName: 'Autotask',
    catalogCategories: ['All', 'PSA', 'RMM', 'Security', 'Microsoft 365', 'DNS', 'Backup'],
    catalog: [
      { id: 'autotask',    name: 'Autotask',    abbr: 'AT', iconColor: '#d93333', vendor: 'Datto',       category: 'PSA',      hosting: 'OEM · BYOC' },
      { id: 'datto-rmm',   name: 'Datto RMM',   abbr: 'DR', iconColor: '#1a66d9', vendor: 'Datto',       category: 'RMM',      hosting: 'OEM · Shared' },
      { id: 'halo',        name: 'Halo PSA',    abbr: 'HA', iconColor: '#f28c1a', vendor: 'HaloITSM',    category: 'PSA',      hosting: 'OEM · BYOC' },
      { id: 'connectwise', name: 'ConnectWise', abbr: 'CW', iconColor: '#33a673', vendor: 'ConnectWise', category: 'PSA',      hosting: 'OEM · BYOC' },
      { id: 'huntress',    name: 'Huntress',    abbr: 'HU', iconColor: '#7333bf', vendor: 'Huntress',    category: 'Security', hosting: 'OEM · Shared' },
      { id: 'itglue',      name: 'ITGlue',      abbr: 'IG', iconColor: '#6666d9', vendor: 'Kaseya',      category: 'Docs',     hosting: 'Self-hosted' },
      { id: 'cipp',        name: 'M365 (CIPP)', abbr: 'CI', iconColor: '#1a8c40', vendor: 'CIPP',        category: 'M365',     hosting: 'OEM · Shared' },
      { id: 'rocketcyber', name: 'RocketCyber', abbr: 'RC', iconColor: '#d95933', vendor: 'Kaseya',      category: 'Security', hosting: 'OEM · Shared' },
      { id: 'checkpoint',  name: 'Check Point', abbr: 'CP', iconColor: '#8c59d9', vendor: 'Check Point', category: 'Security', hosting: 'OEM · BYOC', isNew: true },
    ],
    patterns: [
      {
        id: 'byoc', title: 'BYOC — Per User', supported: true, recommended: true,
        desc: 'Each AM3 user supplies their own Autotask API key.',
        pros: ['Each user acts as themselves in Autotask', 'Audit trail reflects real user identity', 'Permission scope matches Autotask role'],
        cons: ['Each user must onboard their own creds', 'Higher setup friction'],
        bestFor: 'PSAs, time tracking, ticketing where identity matters',
      },
      {
        id: 'shared', title: 'Shared — Reseller-Managed', supported: true,
        desc: 'WYRE supplies one API key. All AM3 users share it.',
        pros: ['Zero-setup for AM3 users', 'You rotate creds once, all users updated', 'Simpler audit (one identity outbound)'],
        cons: ['All actions look like the service user', 'Cannot scope per-user permissions'],
        bestFor: 'read-mostly tools, security monitoring, RMM',
      },
      {
        id: 'self-hosted', title: 'Self-Hosted (Sidecar)', supported: true,
        desc: 'Conduit-hosted MCP server container with config you provide.',
        pros: ['Custom MCPs, internal tools, niche vendors', 'Full control over MCP server config', 'Per-customer container isolation'],
        cons: ['Higher per-customer infra cost', 'You manage container lifecycle'],
        bestFor: 'ITGlue, internal MCPs, custom integrations',
      },
    ],
    seats: [
      { name: 'C. Ramirez',  department: 'Service Delivery', role: 'Owner',  selected: true },
      { name: 'J. Martinez', department: 'Service Delivery', role: 'Admin',  selected: true },
      { name: 'K. Williams', department: 'Tier 1 Support',   role: 'Member', selected: true },
      { name: 'M. Chen',     department: 'Tier 1 Support',   role: 'Member', selected: true },
      { name: 'S. Patel',    department: 'Tier 2 Support',   role: 'Member', selected: false },
    ],
    extraSeatCount: 7,
    toolPresets: ['Read Only', 'Service Delivery', 'Full Access', 'Custom'],
    activePreset: 'Service Delivery',
    department: 'Service Delivery (4 users)',
    toolGroups: [
      { name: 'Tickets', tools: [
        { name: 'create_ticket', enabled: true }, { name: 'update_ticket', enabled: true },
        { name: 'search_tickets', enabled: true }, { name: 'delete_ticket', enabled: false },
      ] },
      { name: 'Time Entries', tools: [
        { name: 'create_time_entry', enabled: true }, { name: 'search_time_entries', enabled: true },
      ] },
      { name: 'Contacts & Companies', tools: [
        { name: 'search_contacts', enabled: true }, { name: 'create_contact', enabled: false },
        { name: 'search_companies', enabled: true },
      ] },
      { name: 'Invoicing', tools: [
        { name: 'search_invoices', enabled: false }, { name: 'get_invoice_details', enabled: false },
      ] },
    ],
    summary: [
      { label: 'Vendor', value: 'Autotask (Datto)' },
      { label: 'Wiring pattern', value: 'BYOC — Per User' },
      { label: 'Customer', value: 'AM3 Technology & Cybersecurity' },
      { label: 'Seats provisioned', value: '5 of 12 users' },
      { label: 'Department scoped', value: 'Service Delivery' },
      { label: 'Tools enabled', value: '8 of 13' },
      { label: 'MCP URL', value: 'am3.conduit.wyre.ai/mcp' },
      { label: 'Per-user setup link', value: 'Email + dashboard banner' },
    ],
  };
}

const written: string[] = [];
for (const step of [1, 2, 3, 4] as OnboardStep[]) {
  const html = renderLayout(
    {
      user,
      org,
      activePath: '/org/customers',
      title: `${org.name} - Onboard MCP`,
      pageStyles: RESELLER_ONBOARD_MCP_STYLES,
    },
    renderOnboardMcp(buildData(step)),
  );
  for (const theme of ['dark', 'light'] as const) {
    const path = `/tmp/onboard-mcp-step${step}-${theme}.html`;
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
