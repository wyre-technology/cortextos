/**
 * Unit tests for reseller middleware helpers.
 *
 * Covers all role/permission branches for:
 *   - makeRequireResellerAccess    (baseline; smoke-tested here too)
 *   - makeRequireResellerRole
 *   - makeRequireResellerOrCustomerAccess
 *
 * Mocks follow the pattern in src/org/reseller-member-service.test.ts —
 * fake `sql` tags / services over in-memory maps so we can unit-test
 * without booting postgres or fastify.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Auth0User } from '../auth/auth0.js';
import type { OrgService, Organization, OrgMember } from '../org/org-service.js';
import { ResellerService } from './reseller-service.js';
import type { ResellerRole } from './types.js';
import {
  makeRequireResellerAccess,
  makeRequireResellerRole,
  makeRequireResellerOrCustomerAccess,
} from './middleware.js';
import { enterTestContext, type Sql } from '../db/context.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ResellerMemberRow {
  id: string;
  reseller_org_id: string;
  user_id: string;
  role: string;
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
}

function createMockSql(rows: Map<string, ResellerMemberRow>) {
  const now = new Date().toISOString();
  void now;

  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');

    // getMembership(reseller, user) — WHERE reseller_org_id AND user_id
    if (
      query.includes('FROM reseller_members') &&
      query.includes('WHERE reseller_org_id =') &&
      query.includes('AND user_id =')
    ) {
      const resellerOrgId = values[0] as string;
      const userId = values[1] as string;
      const found = [...rows.values()].find(
        (r) => r.reseller_org_id === resellerOrgId && r.user_id === userId,
      );
      return Promise.resolve(found ? [found] : []);
    }

    // getMembershipsForUser — WHERE user_id (no reseller_org_id clause)
    if (
      query.includes('FROM reseller_members') &&
      query.includes('WHERE user_id =')
    ) {
      const userId = values[0] as string;
      return Promise.resolve(
        [...rows.values()].filter((r) => r.user_id === userId),
      );
    }

    throw new Error(`Unhandled mock SQL query: ${query}`);
  };

  return handler;
}

type AnySql = Sql;

function seedMember(
  rows: Map<string, ResellerMemberRow>,
  id: string,
  resellerOrgId: string,
  userId: string,
  role: ResellerRole,
) {
  const now = new Date().toISOString();
  rows.set(id, {
    id,
    reseller_org_id: resellerOrgId,
    user_id: userId,
    role,
    invited_by: null,
    joined_at: now,
    created_at: now,
    updated_at: now,
  });
}

// Default OrgService stub used when the test doesn't care about org lookups
// (e.g. tests that only exercise reseller-member paths).
const EMPTY_ORG_SERVICE: OrgService = {
  getResellerOfCustomer: async () => null,
  getMembership: async () => null,
  getOrg: async () => null,
  getCustomersOfReseller: async () => [],
} as unknown as OrgService;

// Minimal OrgService stub — only the two methods the middleware touches.
function makeOrgServiceStub(options: {
  resellerOfCustomer?: Record<string, Organization | null>;
  membership?: Record<string, OrgMember | null>;
}): OrgService {
  const stub = {
    getResellerOfCustomer: vi.fn(async (customerId: string) => {
      return options.resellerOfCustomer?.[customerId] ?? null;
    }),
    getMembership: vi.fn(async (orgId: string, userId: string) => {
      return options.membership?.[`${orgId}:${userId}`] ?? null;
    }),
  };
  return stub as unknown as OrgService;
}

interface FakeReply {
  statusCode: number | null;
  payload: unknown;
  redirectCount: number;
  code: (c: number) => FakeReply;
  send: (p: unknown) => FakeReply;
  redirect: (url: string, status?: number) => FakeReply;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: null,
    payload: undefined,
    redirectCount: 0,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    send(p: unknown) {
      reply.payload = p;
      return reply;
    },
    redirect() {
      reply.redirectCount += 1;
      return reply;
    },
  };
  return reply;
}

function makeRequest(params: Record<string, string>, user: Auth0User | null): FastifyRequest {
  return {
    params,
    url: '/admin/reseller/test',
    auth0User: user,
  } as unknown as FastifyRequest;
}

const USER: Auth0User = { sub: 'user_alice', email: 'a@x.com', name: 'Alice', emailVerified: true };

// ---------------------------------------------------------------------------
// Feature flag helper — tests temporarily enable the reseller console.
// ---------------------------------------------------------------------------

beforeEach(() => {
  (config.features as { resellerConsole: boolean }).resellerConsole = true;
});

// ---------------------------------------------------------------------------
// makeRequireResellerAccess (baseline smoke)
// ---------------------------------------------------------------------------

describe('makeRequireResellerAccess', () => {
  it('returns null and 404 when feature flag is off', async () => {
    (config.features as { resellerConsole: boolean }).resellerConsole = false;
    const rows = new Map<string, ResellerMemberRow>();
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const service = new ResellerService(EMPTY_ORG_SERVICE);
    const mw = makeRequireResellerAccess(service);

    const req = makeRequest({}, USER);
    const reply = makeReply();
    const ctx = await mw(req, reply as unknown as FastifyReply);

    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(404);
  });

  it('returns null and 403 when the user has no reseller memberships', async () => {
    const rows = new Map<string, ResellerMemberRow>();
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const service = new ResellerService(EMPTY_ORG_SERVICE);
    const mw = makeRequireResellerAccess(service);

    const req = makeRequest({}, USER);
    const reply = makeReply();
    const ctx = await mw(req, reply as unknown as FastifyReply);

    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it('returns a context when the user has a matching membership', async () => {
    const rows = new Map<string, ResellerMemberRow>();
    seedMember(rows, 'm1', 'reseller_a', 'user_alice', 'reseller_admin');
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const service = new ResellerService(EMPTY_ORG_SERVICE);
    const mw = makeRequireResellerAccess(service);

    const req = makeRequest({}, USER);
    const reply = makeReply();
    const ctx = await mw(req, reply as unknown as FastifyReply);

    expect(ctx).not.toBeNull();
    expect(ctx?.memberships).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// makeRequireResellerRole
// ---------------------------------------------------------------------------

describe('makeRequireResellerRole', () => {
  const RESELLER_ID = 'reseller_a';
  const ROLES: ResellerRole[] = [
    'reseller_support_agent',
    'reseller_billing_viewer',
    'reseller_admin',
    'reseller_owner',
  ];

  function setup(memberRole: ResellerRole | null) {
    const rows = new Map<string, ResellerMemberRow>();
    if (memberRole) {
      seedMember(rows, 'm1', RESELLER_ID, USER.sub, memberRole);
    }
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const service = new ResellerService(EMPTY_ORG_SERVICE);
    return makeRequireResellerRole(service);
  }

  it('404s when feature flag is off', async () => {
    (config.features as { resellerConsole: boolean }).resellerConsole = false;
    const factory = setup('reseller_admin');
    const mw = factory('reseller_admin');
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(404);
  });

  it('redirects to login when there is no Auth0 session', async () => {
    const factory = setup('reseller_admin');
    const mw = factory('reseller_admin');
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID }, null),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.redirectCount).toBeGreaterThan(0);
  });

  it('400s when :resellerId route param is missing', async () => {
    const factory = setup('reseller_admin');
    const mw = factory('reseller_admin');
    const reply = makeReply();
    const ctx = await mw(makeRequest({}, USER), reply as unknown as FastifyReply);
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(400);
  });

  it('403s when the user has no membership in THIS reseller', async () => {
    const rows = new Map<string, ResellerMemberRow>();
    seedMember(rows, 'm1', 'different_reseller', USER.sub, 'reseller_owner');
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const service = new ResellerService(EMPTY_ORG_SERVICE);
    const mw = makeRequireResellerRole(service)('reseller_support_agent');
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  // Permission matrix — every (actor_role, min_role) pair.
  for (const actor of ROLES) {
    for (const min of ROLES) {
      const actorLevel = ROLES.indexOf(actor);
      const minLevel = ROLES.indexOf(min);
      const shouldAllow = actorLevel >= minLevel;
      it(`${shouldAllow ? 'allows' : 'denies'} actor=${actor} min=${min}`, async () => {
        const mw = setup(actor)(min);
        const reply = makeReply();
        const ctx = await mw(
          makeRequest({ resellerId: RESELLER_ID }, USER),
          reply as unknown as FastifyReply,
        );
        if (shouldAllow) {
          expect(ctx).not.toBeNull();
          expect(ctx?.resellerId).toBe(RESELLER_ID);
          expect(ctx?.membership.role).toBe(actor);
        } else {
          expect(ctx).toBeNull();
          expect(reply.statusCode).toBe(403);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// makeRequireResellerOrCustomerAccess
// ---------------------------------------------------------------------------

describe('makeRequireResellerOrCustomerAccess', () => {
  const RESELLER_ID = 'reseller_a';
  const CUSTOMER_ID = 'customer_1';
  const OTHER_CUSTOMER_ID = 'customer_other';

  function makeOrg(id: string, parent: string | null): Organization {
    return {
      id,
      name: id,
      ownerId: 'owner',
      plan: 'free',
      defaultServerAccess: 'none',
      promptCaptureEnabled: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      type: parent ? 'customer' : 'standalone',
      parentOrgId: parent,
      auth0OrgId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function makeOrgMember(orgId: string, userId: string): OrgMember {
    return {
      id: `om_${orgId}_${userId}`,
      orgId,
      userId,
      role: 'member',
      createdAt: new Date().toISOString(),
    } as OrgMember;
  }

  function setup(args: {
    resellerMemberRole?: ResellerRole;
    customerParentId?: string | null;
    userIsOrgMember?: boolean;
  }) {
    const rows = new Map<string, ResellerMemberRow>();
    if (args.resellerMemberRole) {
      seedMember(rows, 'rm1', RESELLER_ID, USER.sub, args.resellerMemberRole);
    }
    enterTestContext(createMockSql(rows) as unknown as AnySql);
    const resellerService = new ResellerService(EMPTY_ORG_SERVICE);

    const parentId = args.customerParentId;
    const orgService = makeOrgServiceStub({
      resellerOfCustomer: {
        [CUSTOMER_ID]: parentId ? makeOrg(parentId, null) : null,
      },
      membership: args.userIsOrgMember
        ? { [`${CUSTOMER_ID}:${USER.sub}`]: makeOrgMember(CUSTOMER_ID, USER.sub) }
        : {},
    });

    return makeRequireResellerOrCustomerAccess(resellerService, orgService)();
  }

  it('404s when feature flag is off', async () => {
    (config.features as { resellerConsole: boolean }).resellerConsole = false;
    const mw = setup({ resellerMemberRole: 'reseller_admin', customerParentId: RESELLER_ID });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(404);
  });

  it('redirects when no Auth0 session', async () => {
    const mw = setup({ resellerMemberRole: 'reseller_admin', customerParentId: RESELLER_ID });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, null),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.redirectCount).toBeGreaterThan(0);
  });

  it('400s when either route param is missing', async () => {
    const mw = setup({ resellerMemberRole: 'reseller_admin', customerParentId: RESELLER_ID });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(400);
  });

  it('grants access via reseller when caller is a reseller_member AND customer belongs to that reseller', async () => {
    const mw = setup({ resellerMemberRole: 'reseller_support_agent', customerParentId: RESELLER_ID });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).not.toBeNull();
    expect(ctx?.accessVia).toBe('reseller');
    expect(ctx?.resellerMembership?.role).toBe('reseller_support_agent');
  });

  it('denies reseller path when customer is not parented by the reseller and the user is not an org_member', async () => {
    const mw = setup({
      resellerMemberRole: 'reseller_admin',
      customerParentId: 'some_other_reseller',
      userIsOrgMember: false,
    });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it('denies reseller path when customer has no parent at all (standalone) unless user is direct member', async () => {
    const mw = setup({
      resellerMemberRole: 'reseller_admin',
      customerParentId: null,
      userIsOrgMember: false,
    });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it('grants customer-side access when user is a direct org_member even with no reseller membership', async () => {
    const mw = setup({ customerParentId: null, userIsOrgMember: true });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).not.toBeNull();
    expect(ctx?.accessVia).toBe('customer');
    expect(ctx?.resellerMembership).toBeNull();
  });

  it('falls through to customer-side access when reseller branch fails but user is an org_member', async () => {
    // User holds a reseller role in RESELLER_ID, but the customer is parented
    // to a different reseller — reseller branch should fail. Org membership
    // rescues the request.
    const mw = setup({
      resellerMemberRole: 'reseller_admin',
      customerParentId: 'different_reseller',
      userIsOrgMember: true,
    });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).not.toBeNull();
    expect(ctx?.accessVia).toBe('customer');
  });

  it('403s when user is neither a reseller_member nor an org_member', async () => {
    const mw = setup({ userIsOrgMember: false });
    const reply = makeReply();
    const ctx = await mw(
      makeRequest({ resellerId: RESELLER_ID, customerId: OTHER_CUSTOMER_ID }, USER),
      reply as unknown as FastifyReply,
    );
    expect(ctx).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it('accepts any reseller role (including reseller_support_agent) on the reseller branch', async () => {
    for (const role of [
      'reseller_support_agent',
      'reseller_billing_viewer',
      'reseller_admin',
      'reseller_owner',
    ] as ResellerRole[]) {
      const mw = setup({ resellerMemberRole: role, customerParentId: RESELLER_ID });
      const reply = makeReply();
      const ctx = await mw(
        makeRequest({ resellerId: RESELLER_ID, customerId: CUSTOMER_ID }, USER),
        reply as unknown as FastifyReply,
      );
      expect(ctx?.accessVia).toBe('reseller');
      expect(ctx?.resellerMembership?.role).toBe(role);
    }
  });
});
