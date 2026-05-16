// Preview script for the tenant-facing vendor container health UI.
//
// Renders /org/connections with 4 connected vendors, one per health state
// (healthy / degraded / down / unknown), into /tmp × dark/light so the
// 4-state dot + label + freshness stamp + hover affordance can be reviewed
// without a running server.
//
// Usage: tsx scripts/preview-vendor-health.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderTeamConnections,
  TEAM_CONNECTIONS_STYLES,
} from '../src/web/templates/team-connections.js';
import type { VendorHealth } from '../src/monitoring/vendor-monitor.js';
import type { Organization } from '../src/org/org-service.js';

const org: Organization = {
  id: 'org_preview',
  name: 'Acme MSP',
  ownerId: 'auth0|preview',
  plan: 'pro',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'standalone',
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

const RECENT = new Date(Date.now() - 4 * 60_000).toISOString();
const STALE = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

// One connected vendor per health state.
const orgVendors = ['datto-rmm', 'connectwise-psa', 'connectwise-automate', 'abnormal-security'];

const vendorHealth = new Map<string, VendorHealth>([
  ['datto-rmm', {
    vendorSlug: 'datto-rmm', displayName: 'Datto RMM',
    status: 'healthy', lastChecked: RECENT, latencyMs: 120, version: '2.4.1', errorDetail: null,
  }],
  ['connectwise-psa', {
    vendorSlug: 'connectwise-psa', displayName: 'ConnectWise PSA',
    status: 'degraded', lastChecked: RECENT, latencyMs: 3400, version: '2.4.1',
    errorDetail: 'HTTP 5xx',
  }],
  ['connectwise-automate', {
    vendorSlug: 'connectwise-automate', displayName: 'ConnectWise Automate',
    status: 'down', lastChecked: STALE, latencyMs: 0, version: null,
    errorDetail: 'connection failed',
  }],
  ['abnormal-security', {
    vendorSlug: 'abnormal-security', displayName: 'Abnormal Security',
    status: 'unknown', lastChecked: null, latencyMs: 0, version: null, errorDetail: null,
  }],
]);

const html = renderLayout(
  {
    user,
    org,
    activePath: '/org/connections',
    title: `${org.name} - Connections`,
    pageStyles: TEAM_CONNECTIONS_STYLES,
  },
  renderTeamConnections({ orgId: org.id, orgVendors, vendorHealth }),
);

const written: string[] = [];
for (const theme of ['dark', 'light'] as const) {
  const path = `/tmp/vendor-health-${theme}.html`;
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
