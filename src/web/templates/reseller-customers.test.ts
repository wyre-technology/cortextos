import { describe, it, expect } from 'vitest';
import {
  renderResellerCustomers,
  type ResellerCustomer,
  type ResellerCustomersData,
} from './reseller-customers.js';
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

const customer = (over: Partial<ResellerCustomer>): ResellerCustomer => ({
  id: 'cust_1',
  name: 'AM3 Technology',
  subdomain: 'am3.conduit.wyre.ai',
  plan: 'business',
  userCount: 12,
  mcpCalls30d: 8247,
  lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(),
  ...over,
});

function data(customers: ResellerCustomer[]): ResellerCustomersData {
  return { org, customers };
}

describe('renderResellerCustomers', () => {
  it('renders the header with org name and active count', () => {
    const html = renderResellerCustomers(data([customer({}), customer({ id: 'c2' })]));
    expect(html).toContain('Customers');
    expect(html).toContain('WYRE Technology');
    expect(html).toContain('2 active');
  });

  it('renders a row per customer with name, subdomain, and metrics', () => {
    const html = renderResellerCustomers(data([
      customer({ name: 'AM3 Technology', subdomain: 'am3.conduit.wyre.ai', userCount: 12, mcpCalls30d: 8247 }),
    ]));
    expect(html).toContain('AM3 Technology');
    expect(html).toContain('am3.conduit.wyre.ai');
    expect(html).toContain('8,247'); // comma-formatted metric
    expect(html).toContain('>12<');
  });

  it('maps plan to the right badge class', () => {
    const html = renderResellerCustomers(data([
      customer({ id: 'b', plan: 'business' }),
      customer({ id: 'p', plan: 'pro' }),
      customer({ id: 'f', plan: 'free' }),
    ]));
    expect(html).toContain('rc-plan-business');
    expect(html).toContain('rc-plan-pro');
    expect(html).toContain('rc-plan-free');
  });

  it('opens the customer via a live link; impersonate + more stay disabled', () => {
    const html = renderResellerCustomers(data([customer({ id: 'cust_x' })]));
    // Open (→) is a real link now that Surface 2 has shipped.
    expect(html).toContain('href="/org/customers/cust_x"');
    // The other two actions still route through follow-up surfaces.
    const disabled = html.match(/rc-action[^>]*disabled/g) ?? [];
    expect(disabled.length).toBe(2);
  });

  it('renders an empty state when there are no customers', () => {
    const html = renderResellerCustomers(data([]));
    expect(html).toContain('No customer organizations yet');
    expect(html).toContain('0 active');
  });

  it('escapes customer name + subdomain (no HTML injection)', () => {
    const html = renderResellerCustomers(data([
      customer({ name: '<script>x</script>', subdomain: 'a"b' }),
    ]));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('exposes data-name and data-plan on rows for client-side filtering', () => {
    const html = renderResellerCustomers(data([customer({ name: 'Acme MSP', plan: 'pro' })]));
    expect(html).toContain('data-name="acme msp"');
    expect(html).toContain('data-plan="pro"');
  });

  it('renders relative-time activity strings', () => {
    const html = renderResellerCustomers(data([
      customer({ lastActivity: new Date(Date.now() - 2 * 60_000).toISOString() }),
    ]));
    expect(html).toMatch(/2 minutes ago/);
  });

  // F3 + #235 visibility-distinct-by-design: when derived stats are not
  // yet aggregated (post-#237 A-MVP), the cells render an em-dash —
  // never a fabricated stat alongside real id/name.
  it('renders em-dash for null derived stats; never fabricates a number', () => {
    const html = renderResellerCustomers(data([
      customer({
        id: 'cust_real',
        name: 'Northwind IT',
        userCount: null,
        mcpCalls30d: null,
        lastActivity: null,
      }),
    ]));
    // Customer identity is real…
    expect(html).toContain('Northwind IT');
    expect(html).toContain('href="/org/customers/cust_real"');
    // …but every derived-stat cell renders the em-dash placeholder.
    // The Users + MCP Calls cells should each carry "—" (no fabricated numbers).
    const usersCell = html.match(/data-label="Users">([^<]+)</)?.[1];
    const mcpCell = html.match(/data-label="MCP Calls \(30d\)">([^<]+)</)?.[1];
    const activityCell = html.match(/data-label="Last Activity">([^<]+)</)?.[1];
    expect(usersCell).toBe('—');
    expect(mcpCell).toBe('—');
    expect(activityCell).toBe('—');
  });
});
