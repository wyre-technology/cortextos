/**
 * Tests for requireOrgRole + requireOrgRoleForWrite — the actingAs-aware
 * authority gates that close WYREAI-171 Phase-3 (boss msg-1781725198971 +
 * warden HARD-REQs from msg-1781725403477).
 *
 * The matrix encodes warden's 4 PR-up triangle-gates (boss msg-1781725517701):
 *   (1) only reseller-admin/owner establishes a binding (mapping)
 *   (2) effectiveRole written at binding-decoration (not gate)
 *   (3) owner-only-route REJECTS admin-binding (the load-bearing escalation guard)
 *   (4) per-write revalidation: revoked-mid-session → 401
 *
 * Plus warden HARD-REQ 3 (onBehalfOfOrgId spoof) and 4 (audit triplet) axes.
 *
 * The test surface is a unit boundary around the two gate functions +
 * `mapResellerRoleToCustomerRole` + `normalizeOrgId` + `actingAsAuditTriplet`.
 * Integration tests exist separately (route-level) in src/org/routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  requireOrgRole,
  requireOrgRoleForWrite,
  mapResellerRoleToCustomerRole,
  normalizeOrgId,
  actingAsAuditTriplet,
} from './org-route-helpers.js';
import type { OrgRole, OrgService } from './org-service.js';

// ---------------------------------------------------------------------------
// requireAuth0 is the entry-point auth — stub it so we control user.sub.
// ---------------------------------------------------------------------------
const mockRequireAuth0 = vi.fn();
vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// ---------------------------------------------------------------------------
// verifyResellerActingAuthority is the per-write DB revalidation primitive.
// requireOrgRoleForWrite calls it for PATH B; stub it so each test controls
// the verdict (membership-removed / role-demoted / archived / fresh).
// ---------------------------------------------------------------------------
const mockVerifyResellerActingAuthority = vi.fn();
vi.mock('../reseller/reseller-acting-authority.js', () => ({
  verifyResellerActingAuthority: (...args: unknown[]) =>
    mockVerifyResellerActingAuthority(...args),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OPERATOR_USER = { sub: 'auth0|operator-1', email: 'op@msp.example' };
const CUSTOMER_ORG_ID = 'L-customer-A';
const OTHER_CUSTOMER_ORG_ID = 'L-customer-B';
const RESELLER_ORG_ID = 'L-reseller-1';

function makeReply(): FastifyReply {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

interface MakeRequestOpts {
  caller?: {
    actingAs?: {
      onBehalfOfOrgId: string;
      viaResellerOrgId: string;
      sessionId?: string;
      startedAt?: string;
      effectiveRole: OrgRole;
    };
  };
}

function makeRequest(opts: MakeRequestOpts = {}): FastifyRequest {
  return {
    caller: opts.caller,
    params: {},
    headers: {},
    cookies: {},
  } as unknown as FastifyRequest;
}

function makeOrgService(
  membership: { role: OrgRole } | null,
): OrgService {
  return {
    getMembership: vi.fn().mockResolvedValue(membership),
  } as unknown as OrgService;
}

beforeEach(() => {
  mockRequireAuth0.mockReset();
  mockVerifyResellerActingAuthority.mockReset();
  mockRequireAuth0.mockReturnValue(OPERATOR_USER);
});

// ===========================================================================
// HARD-REQ 1 + 5 — mapResellerRoleToCustomerRole (closed-set monotonicity)
// ===========================================================================

describe('mapResellerRoleToCustomerRole — closed-set monotonicity', () => {
  it('reseller-admin -> customer-admin (launch policy)', () => {
    expect(mapResellerRoleToCustomerRole('admin')).toBe('admin');
  });

  it('reseller-owner -> customer-admin (monotonicity-capped, NOT owner)', () => {
    // Owner is a SUPERSET of admin on the reseller side, but we cap the
    // customer-side at admin to keep the customer-org's OWN owner role
    // reserved for the customer. Monotonicity preserved: customer-side <=
    // reseller-side (admin <= owner).
    expect(mapResellerRoleToCustomerRole('owner')).toBe('admin');
  });

  it('reseller-member -> REJECT (null binding)', () => {
    expect(mapResellerRoleToCustomerRole('member')).toBeNull();
  });

  // Monotonicity invariant — every mapping output role-level <= input
  // role-level. This is the load-bearing escalation guard.
  it('monotonicity invariant: every mapping output role-level is ≤ input role-level', async () => {
    const { ROLE_LEVEL } = await import('./org-service.js');
    const inputs: OrgRole[] = ['owner', 'admin', 'member'];
    for (const input of inputs) {
      const output = mapResellerRoleToCustomerRole(input);
      if (output !== null) {
        expect(ROLE_LEVEL[output]).toBeLessThanOrEqual(ROLE_LEVEL[input]);
      }
    }
  });
});

// ===========================================================================
// HARD-REQ 3 — normalizeOrgId (spoof mitigations c + d)
// ===========================================================================

describe('normalizeOrgId — spoof mitigation (HARD-REQ 3 c + d)', () => {
  it('trims surrounding whitespace + lowercases for case-insensitive match', () => {
    expect(normalizeOrgId('  L-Customer-A  ')).toBe('l-customer-a');
  });

  it('null/undefined/empty-string all collapse to null (REJECT)', () => {
    expect(normalizeOrgId(null)).toBeNull();
    expect(normalizeOrgId(undefined)).toBeNull();
    expect(normalizeOrgId('')).toBeNull();
    expect(normalizeOrgId('   ')).toBeNull();
  });
});

// ===========================================================================
// requireOrgRole — READ-side gate
// ===========================================================================

describe('requireOrgRole — PATH A (direct membership)', () => {
  it('returns user when direct membership.role >= minRole', async () => {
    const result = await requireOrgRole(
      makeRequest(),
      makeReply(),
      makeOrgService({ role: 'admin' }),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toEqual(OPERATOR_USER);
  });

  it('rejects with 403 when direct membership exists but role < minRole', async () => {
    const reply = makeReply();
    const result = await requireOrgRole(
      makeRequest(),
      reply,
      makeOrgService({ role: 'member' }),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });
});

describe('requireOrgRole — PATH B (actingAs binding)', () => {
  it('returns user when actingAs binding targets this org with sufficient role', async () => {
    const result = await requireOrgRole(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      makeReply(),
      makeOrgService(null), // no direct membership
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toEqual(OPERATOR_USER);
  });

  // LOAD-BEARING ESCALATION GUARD (warden HARD-REQ 1 + boss msg-1781725198971)
  it('owner-only route REJECTS admin-effective binding with 403 (escalation guard)', async () => {
    const reply = makeReply();
    const result = await requireOrgRole(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'owner', // route requires owner
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  // HARD-REQ 3 (a) — body-targetOrgId-ignored: requireOrgRole ONLY consumes
  // the `orgId` param the caller passes. A separate body-supplied id has
  // no path to influence the gate (the type signature enforces this).
  it('binding for customer-A does NOT authorize a route requesting customer-B (spoof guard)', async () => {
    const reply = makeReply();
    const result = await requireOrgRole(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      OTHER_CUSTOMER_ORG_ID, // route is for a DIFFERENT customer
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  // HARD-REQ 3 (c) — normalization applies to BOTH sides; UUID case-mismatch
  // resolves to the same canonical form so admin-binding-for-X matches
  // route-for-x.
  it('binding UUID-case mismatch still equates after normalization', async () => {
    const result = await requireOrgRole(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: 'L-Customer-A',
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      makeReply(),
      makeOrgService(null),
      'l-customer-a', // lower-case form
      'admin',
    );
    expect(result).toEqual(OPERATOR_USER);
  });
});

describe('requireOrgRole — no-authority rejects', () => {
  it('no binding + no direct membership rejects 403', async () => {
    const reply = makeReply();
    const result = await requireOrgRole(
      makeRequest(),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it('null/empty orgId rejects 400 before any auth comparison', async () => {
    const reply = makeReply();
    const result = await requireOrgRole(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService({ role: 'admin' }),
      '', // empty orgId — HARD-REQ 3 (d) reject
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(400);
  });
});

// ===========================================================================
// requireOrgRoleForWrite — WRITE-side gate (HARD-REQ 2 per-write revalidation)
// ===========================================================================

describe('requireOrgRoleForWrite — PATH B per-write revalidation', () => {
  it('FRESH binding + DB revalidation OK + sufficient role -> returns user', async () => {
    mockVerifyResellerActingAuthority.mockResolvedValue({
      ok: true,
      role: 'admin' as OrgRole,
      customerOrg: { id: CUSTOMER_ORG_ID } as never,
    });
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      makeReply(),
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toEqual(OPERATOR_USER);
    expect(mockVerifyResellerActingAuthority).toHaveBeenCalledWith(
      expect.anything(),
      OPERATOR_USER.sub,
      RESELLER_ORG_ID,
      CUSTOMER_ORG_ID,
    );
  });

  // LOAD-BEARING REVOCATION GUARD (warden HARD-REQ 2)
  it('binding present but DB-revalidation FAILS (actor removed) -> 401 binding-invalid', async () => {
    mockVerifyResellerActingAuthority.mockResolvedValue({
      ok: false,
      reason: 'actor_removed_from_reseller',
    });
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'actingAs binding revoked',
        reason: 'actor_removed_from_reseller',
      }),
    );
  });

  it('binding present but DB-revalidation FAILS (customer archived) -> 401 binding-invalid', async () => {
    mockVerifyResellerActingAuthority.mockResolvedValue({
      ok: false,
      reason: 'customer_archived',
    });
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('binding present but mid-flight role demoted to member -> 401 (mapping returns null)', async () => {
    mockVerifyResellerActingAuthority.mockResolvedValue({
      ok: false,
      reason: 'role_demoted_below_admin',
    });
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  // The owner-only route escalation guard MUST also apply at the write-side
  // gate. Revalidation succeeds, role is admin, but route needs owner → 403
  // (role-shortfall), NOT 401 (binding is valid + active).
  it('owner-only route, admin binding, fresh revalidation -> 403 (not 401)', async () => {
    mockVerifyResellerActingAuthority.mockResolvedValue({
      ok: true,
      role: 'admin' as OrgRole,
      customerOrg: { id: CUSTOMER_ORG_ID } as never,
    });
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'owner',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it('no binding + no membership rejects 403 (not 401 — no binding to invalidate)', async () => {
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest(),
      reply,
      makeOrgService(null),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(mockVerifyResellerActingAuthority).not.toHaveBeenCalled();
  });

  it('direct membership SKIPS the DB revalidation cost (cheaper path)', async () => {
    const result = await requireOrgRoleForWrite(
      makeRequest(),
      makeReply(),
      makeOrgService({ role: 'admin' }),
      CUSTOMER_ORG_ID,
      'admin',
    );
    expect(result).toEqual(OPERATOR_USER);
    expect(mockVerifyResellerActingAuthority).not.toHaveBeenCalled();
  });

  it('cross-org binding (A-binding → B-path) rejects 403 even with fresh revalidation', async () => {
    const reply = makeReply();
    const result = await requireOrgRoleForWrite(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      reply,
      makeOrgService(null),
      OTHER_CUSTOMER_ORG_ID, // route is for DIFFERENT customer than binding
      'admin',
    );
    expect(result).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(403);
    // verifyResellerActingAuthority should NOT be called for cross-org —
    // the org-mismatch is a strict rejection before any DB hit.
    expect(mockVerifyResellerActingAuthority).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// HARD-REQ 4 — actingAsAuditTriplet
// ===========================================================================

describe('actingAsAuditTriplet — forensics independence', () => {
  it('direct write -> actor populated, via_reseller + on_behalf_of both null', () => {
    const triplet = actingAsAuditTriplet(makeRequest(), OPERATOR_USER as never);
    expect(triplet).toEqual({
      actor: OPERATOR_USER.sub,
      viaResellerOrgId: null,
      onBehalfOfOrgId: null,
    });
  });

  it('actingAs write -> actor + via_reseller + on_behalf_of all populated independently', () => {
    const triplet = actingAsAuditTriplet(
      makeRequest({
        caller: {
          actingAs: {
            onBehalfOfOrgId: CUSTOMER_ORG_ID,
            viaResellerOrgId: RESELLER_ORG_ID,
            effectiveRole: 'admin',
          },
        },
      }),
      OPERATOR_USER as never,
    );
    expect(triplet).toEqual({
      actor: OPERATOR_USER.sub,
      viaResellerOrgId: RESELLER_ORG_ID,
      onBehalfOfOrgId: CUSTOMER_ORG_ID,
    });
  });
});
