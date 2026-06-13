import { describe, it, expect } from 'vitest';
import {
  renderNewCustomer,
  coerceNewCustomerStep,
  type NewCustomerData,
  type NewCustomerStep,
} from './reseller-new-customer.js';
import type { Organization } from '../../org/org-service.js';

const org: Organization = {
  id: 'org_reseller',
  name: 'WYRE Technology',
  ownerId: 'auth0|1',
  plan: 'business',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'reseller',
  parentOrgId: null,
  auth0OrgId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-16T00:00:00Z',
};

function data(step: NewCustomerStep, over: Partial<NewCustomerData['draft']> = {}): NewCustomerData {
  return {
    org,
    step,
    draft: {
      name: 'Northwind IT Group',
      subdomain: 'northwind-it-group',
      adminEmail: 'admin@northwind.example',
      inheritBranding: true,
      accent: '#00C9DB',
      ...over,
    },
  };
}

describe('coerceNewCustomerStep', () => {
  it('passes through steps 2 and 3', () => {
    expect(coerceNewCustomerStep('2')).toBe(2);
    expect(coerceNewCustomerStep('3')).toBe(3);
  });
  it('defaults out-of-range / garbage to step 1', () => {
    expect(coerceNewCustomerStep('1')).toBe(1);
    expect(coerceNewCustomerStep('0')).toBe(1);
    expect(coerceNewCustomerStep('4')).toBe(1);
    expect(coerceNewCustomerStep('x')).toBe(1);
    expect(coerceNewCustomerStep(undefined)).toBe(1);
  });
  it('rejects parseInt-salvageable garbage instead of accepting it', () => {
    expect(coerceNewCustomerStep('2abc')).toBe(1);
    expect(coerceNewCustomerStep('3.9')).toBe(1);
    expect(coerceNewCustomerStep(['2'])).toBe(1);
    expect(coerceNewCustomerStep(null)).toBe(1);
    expect(coerceNewCustomerStep('  2  ')).toBe(2); // trimmed, still valid
  });
});

describe('renderNewCustomer — chrome', () => {
  it('renders the banner naming the reseller on every step', () => {
    for (const s of [1, 2, 3] as NewCustomerStep[]) {
      const { body } = renderNewCustomer(data(s));
      expect(body).toContain('NEW CUSTOMER');
      expect(body).toContain('under WYRE Technology');
    }
  });

  it('marks prior steps done, current active, later pending', () => {
    const { body } = renderNewCustomer(data(2));
    expect(body).toContain('nc-step-done');
    expect(body).toContain('nc-step-active');
    expect(body).toContain('nc-step-pending');
  });

  it('links back to the customers list', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('href="/org/customers"');
  });
});

describe('renderNewCustomer — step 1 customer', () => {
  it('renders name + subdomain fields (no plan-tier — flat-pricing)', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('Northwind IT Group');
    expect(body).toContain('northwind-it-group');
    expect(body).toContain('id="ncName"');
    expect(body).toContain('id="ncSlug"');
  });
  // Regression — ruby HIGH audit 2026-06-04: step 1 used to render a
  // `<select name="plan">` with ['Free','Pro','Business'] options that all
  // collapsed to the single conduit plan server-side (Tier-3 active-deception
  // on the MSP-facing surface). Lock the absence: no plan SELECT, no
  // planTiers data, no name="plan" input anywhere in the wizard.
  it('does NOT render a plan-tier field (Aaron flat-pricing-locked)', () => {
    const step1 = renderNewCustomer(data(1)).body;
    const step2 = renderNewCustomer(data(2)).body;
    const step3 = renderNewCustomer(data(3)).body;
    for (const body of [step1, step2, step3]) {
      expect(body).not.toMatch(/<select[^>]*name="plan"/);
      expect(body).not.toContain('name="plan"');
    }
  });
  it('previews the collision-safe path-based URL', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('conduit.wyre.ai/v1/mcp/wyre-technology/');
  });
  it('ships the slug-sync script on step 1 and the create-POST script on step 3', () => {
    expect(renderNewCustomer(data(1)).pageScripts).toContain('ncSyncSlug');
    expect(renderNewCustomer(data(2)).pageScripts).toBe('');
    expect(renderNewCustomer(data(3)).pageScripts).toContain('ncCreateBtn');
  });
});

describe('renderNewCustomer — step 2 admin', () => {
  it('renders the owner email field', () => {
    const { body } = renderNewCustomer(data(2));
    expect(body).toContain('Initial admin');
    expect(body).toContain('admin@northwind.example');
    expect(body).toContain('type="email"');
  });
});

describe('renderNewCustomer — step 3 branding + review', () => {
  it('renders the inherit-branding toggle checked by default', () => {
    const { body } = renderNewCustomer(data(3, { inheritBranding: true }));
    const toggle = body.match(/<input type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(toggle).toContain('checked');
  });
  it('disables the accent override while inheritance is on', () => {
    const onBody = renderNewCustomer(data(3, { inheritBranding: true })).body;
    expect(onBody).toMatch(/nc-input-narrow[^>]*disabled/);
    const offBody = renderNewCustomer(data(3, { inheritBranding: false })).body;
    expect(offBody.match(/nc-input-narrow[^>]*disabled/)).toBeNull();
  });
  it('renders the review summary rows', () => {
    const { body } = renderNewCustomer(data(3));
    expect(body).toContain('Review');
    expect(body).toContain('Organization');
    expect(body).toContain('Owner invite');
    expect(body).toContain('Northwind IT Group');
  });
  it('wires the Create customer CTA to the reseller customers POST endpoint', () => {
    const { body, pageScripts } = renderNewCustomer(data(3));
    expect(body).toContain('Create customer');
    expect(body).toMatch(/id="ncCreateBtn"/);
    // POST target points at the caller's reseller id.
    expect(body).toContain('data-create-url="/admin/reseller/org_reseller/customers"');
    // Name flows to the request body via data-attr. (No data-plan — the
    // server-side body schema ignores plan under flat-pricing; see
    // src/reseller/routes.ts:parseCreateCustomerBody.)
    expect(body).toContain('data-name="Northwind IT Group"');
    expect(body).not.toContain('data-plan=');
    // Step-3 script is what actually POSTs and redirects.
    expect(pageScripts).toContain("fetch(btn.dataset.createUrl");
    expect(pageScripts).toContain("/org/customers/' + encodeURIComponent(body.id)");
  });
});

describe('renderNewCustomer — escaping', () => {
  it('escapes the draft org name (no HTML injection)', () => {
    const { body } = renderNewCustomer(data(1, { name: '<script>x</script>' }));
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

// Regression — the create-customer flow shipped broken twice: (1) the step-3
// POST omitted admin_email entirely (only name+plan) -> API "admin_email is
// required"; (2) inputs were not bound/carried so a hard-coded mock draft was
// submitted regardless of input. These lock both.
describe('renderNewCustomer — create contract + input carry (regression)', () => {
  it('step-3 POST sends admin_email (was omitted -> "admin_email is required")', () => {
    const { body, pageScripts } = renderNewCustomer(data(3, { adminEmail: 'real@customer.com' }));
    // The owner email must reach the POST: as a button data-attr + in the body.
    expect(body).toContain('data-admin-email="real@customer.com"');
    expect(pageScripts).toContain('admin_email: btn.dataset.adminEmail');
  });

  it('each step is a form-GET with named inputs so typed input is carried, not ignored', () => {
    const step1 = renderNewCustomer(data(1)).body;
    expect(step1).toContain('<form method="GET" action="/org/customers/new">');
    expect(step1).toContain('name="name"'); // org-name input is named -> serialized
    expect(step1).toMatch(/<button type="submit"[^>]*class="nc-next"/); // Next submits the form

    const step2 = renderNewCustomer(data(2)).body;
    expect(step2).toContain('<form method="GET" action="/org/customers/new">');
    expect(step2).toContain('name="adminEmail"'); // owner email input is named
    // Step 2 carries the step-1 fields forward as hidden inputs (no server draft store).
    expect(step2).toContain('<input type="hidden" name="name"');
  });
});
