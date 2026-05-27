import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the reseller-console mock-data class (boss directive
// 2026-05-27, "STAGING SHOULD HAVE NO MOCK DATA"). The reseller surfaces in
// routes.ts once rendered hardcoded fabricated customers/people/audit ("AM3
// Technology", "Mountain MSP Group", "C. Ramirez", cust_mock_* …). Those read
// to a real reseller as a cross-tenant leak and triggered a P1 isolation
// investigation. This test locks the class out at the source level — the same
// source-grep discipline as layout.test.ts — so no fabricated reseller datum
// can be reintroduced into the route handlers.
//
// Real customer data flows ONLY from reseller-scoped queries
// (getCustomersOfReseller / getResellerHierarchy / requireCustomerOwnership);
// any literal below in routes.ts means someone hardcoded fabricated data again.

const routesSrc = readFileSync(
  fileURLToPath(new URL('./routes.ts', import.meta.url)),
  'utf8',
);

const FORBIDDEN_MOCK_LITERALS = [
  'cust_mock_',
  'sub_mock_',
  'AM3 Technology',
  'AM3 — Internal IT',
  'AM3 — Client Services',
  'Mountain MSP',
  'Coastal IT',
  'Team DNS',
  'C. Ramirez',
  'J. Martinez',
  'K. Williams',
  'am3-it.com',
  'am3.conduit.wyre.ai',
];

describe('reseller console — no fabricated mock data in route handlers', () => {
  for (const literal of FORBIDDEN_MOCK_LITERALS) {
    it(`routes.ts contains no "${literal}" literal`, () => {
      expect(routesSrc).not.toContain(literal);
    });
  }

  it('renders customer identity only from ownership-verified / reseller-scoped sources', () => {
    // The verified-owned customer header + the real sibling roster.
    expect(routesSrc).toContain('requireCustomerOwnership');
    expect(routesSrc).toContain('customerSummaryOf');
    expect(routesSrc).toContain('resellerSiblings');
    // Every customer-detail tab route resolves a real owned customer before
    // rendering — no tab renders identity without the ownership gate.
    expect(routesSrc).toContain('getCustomersOfReseller');
  });
});
