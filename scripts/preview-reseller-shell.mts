// Preview script for the Track C reseller-console layout shell.
//
// Renders the two new nav contexts — reseller-console (with the
// "Customers" item) and reseller-settings — into /tmp so reviewers can
// eyeball the foundation before any surface is built on it.
//
// Usage: tsx scripts/preview-reseller-shell.mts

import { writeFileSync } from 'node:fs';
import { renderLayout, type NavMode } from '../src/web/layout.js';
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

function stubBody(surface: string): string {
  return `
    <section style="max-width:560px;margin:48px auto;padding:24px">
      <h1 style="font-size:22px;font-weight:700;margin-bottom:12px">${surface}</h1>
      <p style="color:var(--text-secondary);line-height:1.6">
        This is part of the Conduit reseller console. The ${surface}
        surface is in active development and will land in a follow-up
        release.
      </p>
    </section>
  `;
}

const scenarios: Array<{ slug: string; activePath: string; title: string; navMode: NavMode }> = [
  { slug: 'console-customers', activePath: '/org/customers', title: 'Customers', navMode: 'default' },
  { slug: 'settings-branding', activePath: '/org/reseller/branding', title: 'Branding', navMode: 'reseller-settings' },
];

const written: string[] = [];
for (const sc of scenarios) {
  const html = renderLayout(
    { user, org, activePath: sc.activePath, title: `${org.name} - ${sc.title}`, navMode: sc.navMode },
    stubBody(sc.title),
  );
  for (const theme of ['dark', 'light'] as const) {
    const path = `/tmp/reseller-${sc.slug}-${theme}.html`;
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
