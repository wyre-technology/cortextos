// Preview for Track C Surface 4 — Nested Hierarchy (/org/hierarchy).
// Renders the tenant tree × dark/light into /tmp.
//
// Usage: tsx scripts/preview-reseller-hierarchy.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderResellerHierarchy,
  RESELLER_HIERARCHY_STYLES,
  RESELLER_HIERARCHY_SCRIPT,
  type TenantNode,
} from '../src/web/templates/reseller-hierarchy.js';
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

const root: TenantNode = {
  id: 'org_preview', name: 'WYRE Technology', kind: 'reseller',
  meta: '4 customers · 8 users · BUSINESS',
  children: [
    {
      id: 'c1', name: 'AM3 Technology', kind: 'customer', meta: '12 users · BUSINESS',
      children: [
        { id: 's1', name: 'AM3 — Internal IT',     kind: 'subtenant', meta: '5 users', children: [] },
        { id: 's2', name: 'AM3 — Client Services', kind: 'subtenant', meta: '7 users', children: [] },
      ],
    },
    { id: 'c2', name: 'Team DNS Solutions', kind: 'customer', meta: '8 users · PRO', children: [] },
    {
      id: 'c3', name: 'Mountain MSP Group', kind: 'customer', meta: '6 users · PRO',
      children: [
        { id: 's3', name: 'Mountain — Healthcare', kind: 'subtenant', meta: '3 users', children: [] },
        { id: 's4', name: 'Mountain — Legal',      kind: 'subtenant', meta: '2 users', children: [] },
        { id: 's5', name: 'Mountain — SMB Pool',   kind: 'subtenant', meta: '1 user',  children: [] },
      ],
    },
    { id: 'c4', name: 'Coastal IT Partners', kind: 'customer', meta: '15 users · BUSINESS', children: [] },
  ],
};

const html = renderLayout(
  {
    user,
    org,
    activePath: '/org/hierarchy',
    title: `${org.name} - Hierarchy`,
    pageStyles: RESELLER_HIERARCHY_STYLES,
    pageScripts: RESELLER_HIERARCHY_SCRIPT,
  },
  renderResellerHierarchy({ org, root }),
);

const written: string[] = [];
for (const theme of ['dark', 'light'] as const) {
  const path = `/tmp/reseller-hierarchy-${theme}.html`;
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
