import { describe, it, expect } from 'vitest';
import {
  renderResellerCustomerDetail,
  type CustomerSummary,
  type ResellerCustomerDetailData,
} from './reseller-customer-detail.js';
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

const customer = (over: Partial<CustomerSummary> = {}): CustomerSummary => ({
  id: 'cust_1',
  name: 'AM3 Technology',
  plan: 'BUSINESS',
  userCount: 12,
  mcpCount: 4,
  subdomain: 'am3.conduit.wyre.ai',
  ...over,
});

function data(over: Partial<CustomerSummary> = {}): ResellerCustomerDetailData {
  return { org, customer: customer(over) };
}

describe('renderResellerCustomerDetail', () => {
  it('renders a breadcrumb with the reseller and customer names', () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toContain('WYRE Technology');
    expect(body).toContain('Customers');
    expect(body).toContain('AM3 Technology');
  });

  it('renders the header with the plan/counts/subdomain subtitle', () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toContain('BUSINESS plan');
    expect(body).toContain('12 users');
    expect(body).toContain('4 MCPs');
    expect(body).toContain('am3.conduit.wyre.ai');
  });

  it('renders Impersonate disabled and Onboard MCP linking to the wizard', () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toMatch(/cd-btn-secondary[^>]*disabled/);
    expect(body).toContain('/org/customers/cust_1/onboard-mcp?step=1');
  });

  it('renders the four stat-card slots and loading + content shell', () => {
    const { body } = renderResellerCustomerDetail(data());
    for (const id of ['cdMcpCalls', 'cdActiveUsers', 'cdAvgLatency', 'cdCostSaved']) {
      expect(body).toContain(`id="${id}"`);
    }
    expect(body).toContain('id="cdLoading"');
    expect(body).toContain('id="cdContent"');
    expect(body).toContain('id="cdMcpGrid"');
    expect(body).toContain('id="cdUserBody"');
  });

  it('builds a fetch script scoped to the reseller and customer ids', () => {
    const { pageScripts } = renderResellerCustomerDetail(data({ id: 'cust_xyz' }));
    expect(pageScripts).toContain('/admin/reseller/org_reseller/customers/cust_xyz/dashboard');
    expect(pageScripts).toContain("'/usage'");
    expect(pageScripts).toContain("'/savings'");
    expect(pageScripts).toContain("'/vendors'");
  });

  it('populates the DOM without innerHTML (untrusted request-log strings)', () => {
    const { pageScripts } = renderResellerCustomerDetail(data());
    expect(pageScripts).not.toContain('innerHTML');
    expect(pageScripts).toContain('createElement');
    expect(pageScripts).toContain('textContent');
  });

  it('escapes the customer name in the rendered body (no HTML injection)', () => {
    const { body } = renderResellerCustomerDetail(data({ name: '<script>x</script>' }));
    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('flags the live-analytics scope in the shell note', () => {
    const { body } = renderResellerCustomerDetail(data());
    expect(body).toContain('Analytics on this page are live');
  });
});
