import { describe, it, expect } from 'vitest';
import {
  renderOnboardMcp,
  coerceStep,
  type OnboardMcpData,
  type OnboardStep,
} from './reseller-onboard-mcp.js';
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

function data(step: OnboardStep, over: Partial<OnboardMcpData> = {}): OnboardMcpData {
  return {
    org,
    customerId: 'cust_1',
    customerName: 'AM3 Technology',
    step,
    vendorName: 'Autotask',
    catalogCategories: ['All', 'PSA', 'RMM'],
    catalog: [
      { id: 'autotask', name: 'Autotask', abbr: 'AT', iconColor: '#d93333', vendor: 'Datto', category: 'PSA', hosting: 'OEM · BYOC' },
      { id: 'checkpoint', name: 'Check Point', abbr: 'CP', iconColor: '#8c59d9', vendor: 'Check Point', category: 'Security', hosting: 'OEM · BYOC', isNew: true },
    ],
    patterns: [
      { id: 'byoc', title: 'BYOC — Per User', supported: true, recommended: true, desc: 'd', pros: ['p1'], cons: ['c1'], bestFor: 'psa' },
      { id: 'shared', title: 'Shared — Reseller-Managed', supported: true, desc: 'd', pros: ['p1'], cons: ['c1'], bestFor: 'rmm' },
      { id: 'self-hosted', title: 'Self-Hosted (Sidecar)', supported: false, desc: 'd', pros: ['p1'], cons: ['c1'], bestFor: 'custom' },
    ],
    seats: [
      { name: 'C. Ramirez', department: 'Service Delivery', role: 'Owner', selected: true },
      { name: 'S. Patel', department: 'Tier 2 Support', role: 'Member', selected: false },
    ],
    extraSeatCount: 7,
    toolPresets: ['Read Only', 'Service Delivery', 'Full Access', 'Custom'],
    activePreset: 'Service Delivery',
    department: 'Service Delivery (4 users)',
    toolGroups: [
      { name: 'Tickets', tools: [
        { name: 'create_ticket', enabled: true },
        { name: 'delete_ticket', enabled: false },
      ] },
    ],
    summary: [
      { label: 'Vendor', value: 'Autotask (Datto)' },
      { label: 'Seats provisioned', value: '5 of 12 users' },
    ],
    ...over,
  };
}

describe('coerceStep', () => {
  it('passes through valid steps 2-4', () => {
    expect(coerceStep('2')).toBe(2);
    expect(coerceStep('3')).toBe(3);
    expect(coerceStep('4')).toBe(4);
  });
  it('defaults out-of-range / garbage input to step 1', () => {
    expect(coerceStep('1')).toBe(1);
    expect(coerceStep('0')).toBe(1);
    expect(coerceStep('5')).toBe(1);
    expect(coerceStep('abc')).toBe(1);
    expect(coerceStep(undefined)).toBe(1);
  });
  it('rejects parseInt-salvageable garbage instead of accepting it', () => {
    expect(coerceStep('3abc')).toBe(1);
    expect(coerceStep('2.9')).toBe(1);
    expect(coerceStep('  3  ')).toBe(3); // trimmed, still valid
    expect(coerceStep(['3'])).toBe(1);
    expect(coerceStep('0x3')).toBe(1);
    expect(coerceStep(null)).toBe(1);
  });
});

describe('renderOnboardMcp — shared chrome', () => {
  it('renders the reseller banner with the customer name on every step', () => {
    for (const s of [1, 2, 3, 4] as OnboardStep[]) {
      const html = renderOnboardMcp(data(s));
      expect(html).toContain('ONBOARDING AS RESELLER');
      expect(html).toContain('for AM3 Technology');
    }
  });

  it('marks prior steps done, the current step active, later steps pending', () => {
    const html = renderOnboardMcp(data(3));
    expect(html).toContain('ob-step-done');   // steps 1 & 2
    expect(html).toContain('ob-step-active'); // step 3
    expect(html).toContain('ob-step-pending'); // step 4
  });

  it('step 1 back-link points to the customer, later steps to the prior step', () => {
    expect(renderOnboardMcp(data(1))).toContain('Back to AM3 Technology');
    expect(renderOnboardMcp(data(3))).toContain('Back to Wire Up');
  });
});

describe('renderOnboardMcp — step 1 catalog', () => {
  it('renders a card per catalog entry with vendor and hosting', () => {
    const html = renderOnboardMcp(data(1));
    expect(html).toContain('Autotask');
    expect(html).toContain('Datto &middot; PSA');
    expect(html).toContain('OEM · BYOC');
  });
  it('flags new catalog entries', () => {
    const html = renderOnboardMcp(data(1));
    expect(html).toContain('ob-new');
  });
  it('onboard links advance to step 2', () => {
    const html = renderOnboardMcp(data(1));
    expect(html).toContain('onboard-mcp?step=2');
  });
});

describe('renderOnboardMcp — step 2 patterns', () => {
  it('renders all wiring patterns with the recommended one selected', () => {
    const html = renderOnboardMcp(data(2));
    expect(html).toContain('BYOC — Per User');
    expect(html).toContain('Shared — Reseller-Managed');
    expect(html).toContain('ob-pattern-selected');
    expect(html).toContain('RECOMMENDED');
  });
  it('renders unsupported patterns disabled', () => {
    const html = renderOnboardMcp(data(2));
    expect(html).toContain('ob-pattern-disabled');
    expect(html).toContain('NOT SUPPORTED');
  });
});

describe('renderOnboardMcp — step 3 seats', () => {
  it('renders a seat row per user with selection state', () => {
    const html = renderOnboardMcp(data(3));
    expect(html).toContain('C. Ramirez');
    expect(html).toContain('S. Patel');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });
  it('renders the "+ N more users" affordance', () => {
    const html = renderOnboardMcp(data(3));
    expect(html).toContain('+ 7 more users');
  });
  it('renders the customer-facing preview card', () => {
    const html = renderOnboardMcp(data(3));
    expect(html).toContain('Connect Autotask');
    expect(html).toContain('What AM3 Technology users will see');
  });
});

describe('renderOnboardMcp — step 4 allowlist', () => {
  it('renders tool groups with an enabled count', () => {
    const html = renderOnboardMcp(data(4));
    expect(html).toContain('Tickets');
    expect(html).toContain('1 of 2 enabled');
    expect(html).toContain('create_ticket');
  });
  it('renders preset chips with the active one marked', () => {
    const html = renderOnboardMcp(data(4));
    expect(html).toContain('ob-preset-active');
    expect(html).toContain('Read Only');
  });
  it('renders the summary panel rows', () => {
    const html = renderOnboardMcp(data(4));
    expect(html).toContain('Vendor');
    expect(html).toContain('Autotask (Datto)');
  });
  it('ships the final onboard CTA disabled (no persistence in v1)', () => {
    const html = renderOnboardMcp(data(4));
    expect(html).toMatch(/ob-finish[^>]*disabled/);
    expect(html).toContain('Onboard Autotask for AM3 Technology');
  });
});

describe('renderOnboardMcp — escaping', () => {
  it('escapes the customer name (no HTML injection)', () => {
    const html = renderOnboardMcp(data(2, { customerName: '<script>x</script>' }));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects a CSS-injection payload in a catalog icon color', () => {
    const html = renderOnboardMcp(data(1, {
      catalog: [
        { id: 'x', name: 'X', abbr: 'X', iconColor: 'red;background:url(https://evil/x)',
          vendor: 'V', category: 'PSA', hosting: 'OEM' },
      ],
    }));
    expect(html).not.toContain('url(https://evil/x)');
    expect(html).toContain('style="background:var(--border-secondary)"');
  });

  it('renders an empty-catalog state instead of a blank grid', () => {
    const html = renderOnboardMcp(data(1, { catalog: [] }));
    expect(html).toContain('No MCPs available in the catalog yet');
  });
});
