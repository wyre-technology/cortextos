// Preview for Track C Area 2 — Sub-customer onboarding wizard.
// Renders all 3 steps × dark/light into /tmp.
//
// Usage: tsx scripts/preview-reseller-new-customer.mts

import { writeFileSync } from 'node:fs';
import { renderLayout } from '../src/web/layout.js';
import {
  renderNewCustomer,
  NEW_CUSTOMER_STYLES,
  type NewCustomerData,
  type NewCustomerStep,
} from '../src/web/templates/reseller-new-customer.js';
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

function buildData(step: NewCustomerStep): NewCustomerData {
  return {
    org,
    step,
    planTiers: ['Free', 'Pro', 'Business'],
    draft: {
      name: 'Northwind IT Group',
      subdomain: 'northwind-it-group',
      plan: 'Pro',
      adminEmail: 'admin@northwind.example',
      inheritBranding: true,
      accent: '#00C9DB',
    },
  };
}

const written: string[] = [];
for (const step of [1, 2, 3] as NewCustomerStep[]) {
  const { body, pageScripts } = renderNewCustomer(buildData(step));
  const html = renderLayout(
    {
      user,
      org,
      activePath: '/org/customers',
      title: `${org.name} - New customer`,
      pageStyles: NEW_CUSTOMER_STYLES,
      pageScripts,
    },
    body,
  );
  for (const theme of ['dark', 'light'] as const) {
    const path = `/tmp/new-customer-step${step}-${theme}.html`;
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
