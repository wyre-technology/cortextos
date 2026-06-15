import { describe, it, expect, vi } from 'vitest';

// Stub runAsSystem to pass-through — tests don't have a real DB pool;
// production wrap is the load-bearing correctness layer (cross-org RLS
// reads need BYPASSRLS context per analyst PR #398 review).
vi.mock('../db/context.js', () => ({
  runAsSystem: async (fn: () => Promise<unknown>) => fn(),
}));

import {
  verifyResellerActingAuthority,
  type ResellerActingAuthorityResult,
} from './reseller-acting-authority.js';
import type { OrgService } from '../org/org-service.js';

/**
 * Shared primitive that BOTH the /switch entry-point
 * (authorizeResellerAdminOnCustomer) and the every-request middleware
 * (acting-as-middleware.revalidate) consume. Ruby triangle-leg MED
 * finding closure on PR #398 — single shared primitive eliminates
 * drift-bug-class between two surfaces.
 *
 * These tests pin the 3-check contract end-to-end so any future
 * implementation change has ONE test surface to update, not two.
 */

function fakeOrgService(opts: {
  membership?: { role: 'owner' | 'admin' | 'member' } | null;
  customer?: { id: string; parentOrgId: string | null } | null;
}): Pick<OrgService, 'getMembership' | 'getOrg'> {
  return {
    getMembership: vi.fn().mockResolvedValue(opts.membership ?? null),
    getOrg: vi.fn().mockImplementation((orgId: string) => {
      if (opts.customer === undefined) {
        return Promise.resolve({ id: orgId, parentOrgId: 'org_reseller' });
      }
      return Promise.resolve(opts.customer);
    }),
  } as unknown as Pick<OrgService, 'getMembership' | 'getOrg'>;
}

describe('verifyResellerActingAuthority — shared 3-check primitive', () => {
  it('HAPPY PATH: all 3 checks pass -> ok=true + role + customerOrg', async () => {
    const svc = fakeOrgService({
      membership: { role: 'admin' },
      customer: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role).toBe('admin');
      expect(result.customerOrg.id).toBe('org_customer');
    }
  });

  it('CHECK 1: no membership -> ok=false + actor_removed_from_reseller', async () => {
    const svc = fakeOrgService({
      membership: null,
      customer: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result).toEqual({ ok: false, reason: 'actor_removed_from_reseller' });
  });

  it('CHECK 1b: role demoted below admin -> ok=false + role_demoted_below_admin', async () => {
    const svc = fakeOrgService({
      membership: { role: 'member' },
      customer: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result).toEqual({ ok: false, reason: 'role_demoted_below_admin' });
  });

  it('CHECK 1b: owner role passes (>= admin threshold)', async () => {
    const svc = fakeOrgService({
      membership: { role: 'owner' },
      customer: { id: 'org_customer', parentOrgId: 'org_reseller' },
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result.ok).toBe(true);
  });

  it('CHECK 3a: customer-org hard-deleted -> ok=false + customer_archived', async () => {
    const svc = fakeOrgService({
      membership: { role: 'admin' },
      customer: null,
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result).toEqual({ ok: false, reason: 'customer_archived' });
  });

  it('CHECK 3b: customer-org reparented away from reseller -> customer_unparented_from_reseller', async () => {
    const svc = fakeOrgService({
      membership: { role: 'admin' },
      customer: { id: 'org_customer', parentOrgId: 'org_different_reseller' },
    });
    const result = await verifyResellerActingAuthority(
      svc,
      'user_alice',
      'org_reseller',
      'org_customer',
    );
    expect(result).toEqual({ ok: false, reason: 'customer_unparented_from_reseller' });
  });

  it('DENY-REASON UNION: every failure case returns a vocabulary item matching the audit-event union', async () => {
    // Type-level invariant: TypeScript narrows result.reason to the
    // exact ResellerActingAuthorityDenyReason union, which mirrors
    // ActingAsAuditEvent revokeReason. Runtime witness: the 4 cases
    // covered above exhaustively enumerate the non-admin-force union
    // members. admin_force_revoked is the OUT-OF-BAND admin-tooling
    // path (NOT a 3-check failure), so by-construction excluded here.
    const cases: Array<Parameters<typeof fakeOrgService>[0]> = [
      { membership: null },
      { membership: { role: 'member' } },
      { membership: { role: 'admin' }, customer: null },
      { membership: { role: 'admin' }, customer: { id: 'c', parentOrgId: 'other' } },
    ];
    const expectedReasons: Array<ResellerActingAuthorityResult & { ok: false }> = [
      { ok: false, reason: 'actor_removed_from_reseller' },
      { ok: false, reason: 'role_demoted_below_admin' },
      { ok: false, reason: 'customer_archived' },
      { ok: false, reason: 'customer_unparented_from_reseller' },
    ];
    for (let i = 0; i < cases.length; i += 1) {
      const svc = fakeOrgService(cases[i]);
      const result = await verifyResellerActingAuthority(svc, 'u', 'r', 'c');
      expect(result).toEqual(expectedReasons[i]);
    }
  });
});
