// Preview for Track C Surface 5 — White-Label Branding (/org/reseller/branding).
// Renders the branding panel × dark/light into /tmp.
//
// Usage: tsx scripts/preview-reseller-branding.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderResellerBranding,
  RESELLER_BRANDING_STYLES,
  type ResellerBranding,
} from '../src/web/templates/reseller-branding.js';
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

const branding: ResellerBranding = {
  defaultUrl: 'conduit.wyre.ai/v1/mcp/wyre-technology/am3-technology',
  brandAlias: 'mcp.wyretechnology.com',
  aliasVerified: true,
  logoUrl: null,
  colors: { accent: '#D93232', textOnDark: '#F2F2F5', textOnLight: '#212126' },
  emailFromName: 'WYRE Technology',
  emailFromAddress: 'notifications@conduit.wyre.ai',
  emailAuthStatus: 'SPF + DKIM verified · DMARC pending',
  emailAuthVerified: false,
  directBillingEnabled: false,
};

const html = renderLayout(
  {
    user,
    org,
    activePath: '/org/reseller/branding',
    title: `${org.name} - Branding`,
    navMode: 'reseller-settings',
    pageStyles: RESELLER_BRANDING_STYLES,
  },
  renderResellerBranding({ org, branding, sampleCustomerName: 'AM3 Technology' }),
);

const written: string[] = [];
for (const theme of ['dark', 'light'] as const) {
  const path = `/tmp/reseller-branding-${theme}.html`;
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
