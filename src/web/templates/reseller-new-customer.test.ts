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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-16T00:00:00Z',
};

function data(step: NewCustomerStep, over: Partial<NewCustomerData['draft']> = {}): NewCustomerData {
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
  it('renders name, subdomain, and plan-tier fields', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('Northwind IT Group');
    expect(body).toContain('northwind-it-group');
    expect(body).toContain('id="ncName"');
    expect(body).toContain('id="ncSlug"');
  });
  it('renders every plan tier with the draft plan selected', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('Free');
    expect(body).toContain('Business');
    expect(body).toMatch(/<option selected>Pro<\/option>/);
  });
  it('previews the collision-safe path-based URL', () => {
    const { body } = renderNewCustomer(data(1));
    expect(body).toContain('conduit.wyre.ai/v1/mcp/wyre-technology/');
  });
  it('ships the slug-sync script only on step 1', () => {
    expect(renderNewCustomer(data(1)).pageScripts).toContain('ncSyncSlug');
    expect(renderNewCustomer(data(2)).pageScripts).toBe('');
    expect(renderNewCustomer(data(3)).pageScripts).toBe('');
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
  it('ships the Create customer CTA disabled (no provisioning endpoint)', () => {
    const { body } = renderNewCustomer(data(3));
    expect(body).toMatch(/nc-create[^>]*disabled/);
    expect(body).toContain('Create customer');
  });
});

describe('renderNewCustomer — escaping', () => {
  it('escapes the draft org name (no HTML injection)', () => {
    const { body } = renderNewCustomer(data(1, { name: '<script>x</script>' }));
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
