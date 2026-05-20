/**
 * Unit tests for /admin/reseller/* CRUD routes (PRD §7.1).
 *
 * Covers, per endpoint: auth rejection, role-based rejection, happy path,
 * and service-layer error translation.
 *
 * Mocks ResellerService, ResellerMemberService, and OrgService with
 * lightweight fakes — no postgres, no real auth0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ResellerService } from './reseller-service.js';
import type {
  ResellerMemberService,
  ResellerMember,
  ResellerMemberWithProfile,
  ResellerRole,
} from '../org/reseller-member-service.js';
import { ResellerMemberError } from '../org/reseller-member-service.js';
import type { OrgService, Organization } from '../org/org-service.js';
import type { DashboardService } from '../dashboard/dashboard-service.js';
import type { AuditService } from '../audit/audit-service.js';

// ---------------------------------------------------------------------------
// Mock requireAuth0
// ---------------------------------------------------------------------------

const mockRequireAuth0 = vi.fn();

vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_USER = { sub: 'user_alice', email: 'alice@example.com', name: 'Alice' };
const RESELLER_ID = 'reseller_a';
const CUSTOMER_ID = 'customer_x';
const MEMBER_ID = 'm1';

function makeResellerOrg(id = RESELLER_ID, name = 'Acme MSP'): Organization {
  return {
    id,
    name,
    ownerId: 'owner_user',
    plan: 'pro',
    defaultServerAccess: 'none',
    promptCaptureEnabled: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    type: 'reseller',
    parentOrgId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  };
}

function makeMember(role: ResellerRole, overrides: Partial<ResellerMember> = {}): ResellerMember {
  return {
    id: MEMBER_ID,
    resellerOrgId: RESELLER_ID,
    userId: TEST_USER.sub,
    role,
    invitedBy: null,
    joinedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMemberWithProfile(
  role: ResellerRole,
  overrides: Partial<ResellerMemberWithProfile> = {},
): ResellerMemberWithProfile {
  return {
    ...makeMember(role),
    email: 'alice@example.com',
    name: 'Alice',
    displayName: null,
    firstName: 'Alice',
    lastName: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

interface MockDeps {
  resellerService: ResellerService;
  resellerMemberService: ResellerMemberService;
  orgService: OrgService;
  dashboardService: DashboardService;
  auditService: AuditService;
}

function makeMocks(options: {
  actorRole?: ResellerRole | null;
  org?: Organization | null;
  customers?: Organization[];
  memberList?: ResellerMemberWithProfile[];
  createImpl?: ResellerMemberService['create'];
  updateRoleImpl?: ResellerMemberService['updateRole'];
  deleteImpl?: ResellerMemberService['delete'];
  updateOrgImpl?: OrgService['updateOrg'];
  /** Whether CUSTOMER_ID's parent_org_id resolves to RESELLER_ID. */
  customerLinkedToReseller?: boolean;
  /** Whether the caller is a direct org_member of CUSTOMER_ID. */
  customerSelfMember?: boolean;
  auditQueryImpl?: AuditService['query'];
} = {}): MockDeps {
  const {
    actorRole = 'reseller_admin',
    org = makeResellerOrg(),
    customers = [],
    memberList = [],
    customerLinkedToReseller = true,
    customerSelfMember = false,
  } = options;

  const resellerService = {
    getMembership: vi.fn(async (resellerId: string, userId: string) => {
      if (actorRole === null) return null;
      if (resellerId !== RESELLER_ID || userId !== TEST_USER.sub) return null;
      return makeMember(actorRole);
    }),
    getMembershipsForUser: vi.fn(async (userId: string) =>
      actorRole !== null && userId === TEST_USER.sub ? [makeMember(actorRole)] : [],
    ),
    roleAtLeast: vi.fn(),
  } as unknown as ResellerService;

  const resellerMemberService = {
    list: vi.fn(async () => memberList),
    create: options.createImpl ?? vi.fn(async (_r, userId, role, createdBy) =>
      makeMember(role, { id: 'new_member', userId, invitedBy: createdBy }),
    ),
    updateRole: options.updateRoleImpl ?? vi.fn(async (memberId, newRole) =>
      makeMember(newRole, { id: memberId }),
    ),
    delete: options.deleteImpl ?? vi.fn(async () => true),
    getById: vi.fn(),
    getMembershipByUser: vi.fn(),
  } as unknown as ResellerMemberService;

  const orgService = {
    getOrg: vi.fn(async (id: string) => (id === RESELLER_ID ? org : null)),
    getCustomersOfReseller: vi.fn(async () => customers),
    updateOrg: options.updateOrgImpl ??
      vi.fn(async (id: string, name: string) => {
        if (!org) return null;
        return { ...org, id, name, updatedAt: '2024-02-01T00:00:00.000Z' };
      }),
    // requireResellerOrCustomerAccess: customer's reseller parent.
    getResellerOfCustomer: vi.fn(async (customerId: string) =>
      customerLinkedToReseller && customerId === CUSTOMER_ID ? org : null,
    ),
    // requireResellerOrCustomerAccess: customer-side self-membership.
    getMembership: vi.fn(async (orgId: string, userId: string) =>
      customerSelfMember && orgId === CUSTOMER_ID && userId === TEST_USER.sub
        ? { id: 'om1', orgId, userId, role: 'member' }
        : null,
    ),
  } as unknown as OrgService;

  const dashboardService = {
    getUsageSummary: vi.fn(async (orgId: string) => ({ orgId, totalCalls: 42 })),
    getTokenSavings: vi.fn(async (orgId: string) => ({ orgId, tokensSaved: 7 })),
    getVendorBreakdown: vi.fn(async () => [{ vendor: 'datto-rmm', calls: 12 }]),
  } as unknown as DashboardService;

  const auditService = {
    query: options.auditQueryImpl ?? vi.fn(async () => ({ entries: [], total: 0 })),
  } as unknown as AuditService;

  return { resellerService, resellerMemberService, orgService, dashboardService, auditService };
}

async function buildApp(deps: MockDeps, featureEnabled = true): Promise<FastifyInstance> {
  vi.resetModules();
  vi.stubEnv('RESELLER_CONSOLE_ENABLED', featureEnabled ? 'true' : 'false');
  const { resellerRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  await app.register(resellerRoutes(deps));
  return app;
}

function authenticateAs(user = TEST_USER): void {
  mockRequireAuth0.mockReturnValue(user);
}

function unauthenticated(): void {
  mockRequireAuth0.mockImplementation(
    (_req: unknown, reply: { code: (c: number) => { send: (b: unknown) => unknown } }) => {
      reply.code(401).send({ error: 'Unauthorized' });
      return null;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resellerRoutes (/admin/reseller/:resellerId)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.unstubAllEnvs();
    mockRequireAuth0.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // GET /admin/reseller/:resellerId
  // -------------------------------------------------------------------------

  describe('GET /admin/reseller/:resellerId', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({ method: 'GET', url: `/admin/reseller/${RESELLER_ID}` });
      expect(res.statusCode).toBe(401);
    });

    it('403s when user has no membership in this reseller', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: null }));
      const res = await app.inject({ method: 'GET', url: `/admin/reseller/${RESELLER_ID}` });
      expect(res.statusCode).toBe(403);
    });

    it('returns reseller profile with counts on happy path', async () => {
      authenticateAs();
      const customers: Organization[] = [
        { ...makeResellerOrg('c1', 'C1'), type: 'customer', parentOrgId: RESELLER_ID },
        { ...makeResellerOrg('c2', 'C2'), type: 'customer', parentOrgId: RESELLER_ID },
      ];
      const memberList = [
        makeMemberWithProfile('reseller_admin'),
        makeMemberWithProfile('reseller_owner', { id: 'm2' }),
      ];
      app = await buildApp(makeMocks({ actorRole: 'reseller_support_agent', customers, memberList }));
      const res = await app.inject({ method: 'GET', url: `/admin/reseller/${RESELLER_ID}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: RESELLER_ID,
        name: 'Acme MSP',
        type: 'reseller',
        customerCount: 2,
        memberCount: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('404s when org is not a reseller', async () => {
      authenticateAs();
      const standalone: Organization = { ...makeResellerOrg(), type: 'standalone' };
      app = await buildApp(makeMocks({ org: standalone }));
      const res = await app.inject({ method: 'GET', url: `/admin/reseller/${RESELLER_ID}` });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/reseller/:resellerId
  // -------------------------------------------------------------------------

  describe('PATCH /admin/reseller/:resellerId', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}`,
        payload: { name: 'New' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('403s when actor is reseller_support_agent', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_support_agent' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}`,
        payload: { name: 'New' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s when name missing', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('200s on happy path', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}`,
        payload: { name: 'Renamed MSP' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: RESELLER_ID, name: 'Renamed MSP' });
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/reseller/:resellerId/members
  // -------------------------------------------------------------------------

  describe('GET /admin/reseller/:resellerId/members', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/members`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('403s when actor has no membership', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: null }));
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/members`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows reseller_support_agent to read members', async () => {
      authenticateAs();
      const memberList = [
        makeMemberWithProfile('reseller_owner', { id: 'm1' }),
        makeMemberWithProfile('reseller_admin', { id: 'm2' }),
        makeMemberWithProfile('reseller_support_agent', { id: 'm3' }),
      ];
      app = await buildApp(makeMocks({ actorRole: 'reseller_support_agent', memberList }));
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/members`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.items).toHaveLength(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
    });

    it('paginates correctly (page=2, pageSize=2)', async () => {
      authenticateAs();
      const memberList = [
        makeMemberWithProfile('reseller_owner', { id: 'm1' }),
        makeMemberWithProfile('reseller_admin', { id: 'm2' }),
        makeMemberWithProfile('reseller_support_agent', { id: 'm3' }),
      ];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', memberList }));
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/members?page=2&pageSize=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe('m3');
      expect(body.total).toBe(3);
    });

    it('rejects pageSize > 100', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/members?pageSize=500`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/reseller/:resellerId/members
  // -------------------------------------------------------------------------

  describe('POST /admin/reseller/:resellerId/members', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('403s when actor is reseller_support_agent', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_support_agent' }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s when body invalid', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('403s when reseller_admin tries to create a reseller_owner', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_owner' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('201s on happy path (reseller_admin creates reseller_admin)', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.userId).toBe('u2');
      expect(body.role).toBe('reseller_admin');
    });

    it('translates ResellerMemberError INSUFFICIENT_PERMISSION → 403', async () => {
      authenticateAs();
      const createImpl = vi.fn(async () => {
        throw new ResellerMemberError('INSUFFICIENT_PERMISSION', 'nope');
      }) as unknown as ResellerMemberService['create'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', createImpl }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('INSUFFICIENT_PERMISSION');
    });

    it('translates INVALID_ROLE → 400', async () => {
      authenticateAs();
      const createImpl = vi.fn(async () => {
        throw new ResellerMemberError('INVALID_ROLE', 'bad role');
      }) as unknown as ResellerMemberService['create'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', createImpl }));
      const res = await app.inject({
        method: 'POST',
        url: `/admin/reseller/${RESELLER_ID}/members`,
        payload: { userId: 'u2', role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/reseller/:resellerId/members/:memberId
  // -------------------------------------------------------------------------

  describe('PATCH /admin/reseller/:resellerId/members/:memberId', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
        payload: { role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('403s when actor is billing_viewer', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_billing_viewer' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
        payload: { role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('200s on happy path', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
        payload: { role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe('reseller_admin');
    });

    it('translates LAST_OWNER_PROTECTION → 409', async () => {
      authenticateAs();
      const updateRoleImpl = vi.fn(async () => {
        throw new ResellerMemberError('LAST_OWNER_PROTECTION', 'last owner');
      }) as unknown as ResellerMemberService['updateRole'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_owner', updateRoleImpl }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
        payload: { role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('LAST_OWNER_PROTECTION');
    });

    it('translates MEMBER_NOT_FOUND → 404', async () => {
      authenticateAs();
      const updateRoleImpl = vi.fn(async () => {
        throw new ResellerMemberError('MEMBER_NOT_FOUND', 'nope');
      }) as unknown as ResellerMemberService['updateRole'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', updateRoleImpl }));
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
        payload: { role: 'reseller_admin' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/reseller/:resellerId/members/:memberId
  // -------------------------------------------------------------------------

  describe('DELETE /admin/reseller/:resellerId/members/:memberId', () => {
    it('401s when no session', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('403s when actor is support_agent', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_support_agent' }));
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('204s on happy path', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin' }));
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(204);
    });

    it('404s when service returns false (member not found)', async () => {
      authenticateAs();
      const deleteImpl = vi.fn(async () => false) as unknown as ResellerMemberService['delete'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', deleteImpl }));
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('translates LAST_OWNER_PROTECTION → 409', async () => {
      authenticateAs();
      const deleteImpl = vi.fn(async () => {
        throw new ResellerMemberError('LAST_OWNER_PROTECTION', 'cannot delete last owner');
      }) as unknown as ResellerMemberService['delete'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_owner', deleteImpl }));
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(409);
    });

    it('translates INSUFFICIENT_PERMISSION → 403', async () => {
      authenticateAs();
      const deleteImpl = vi.fn(async () => {
        throw new ResellerMemberError('INSUFFICIENT_PERMISSION', 'nope');
      }) as unknown as ResellerMemberService['delete'];
      app = await buildApp(makeMocks({ actorRole: 'reseller_admin', deleteImpl }));
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/reseller/${RESELLER_ID}/members/m2`,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Reseller-scoped customer dashboard (Track C S2)
  // -------------------------------------------------------------------------

  describe('GET /admin/reseller/:resellerId/customers/:customerId/dashboard/*', () => {
    const usageUrl = `/admin/reseller/${RESELLER_ID}/customers/${CUSTOMER_ID}/dashboard/usage`;

    it('returns the customer usage summary for a reseller member of the parent', async () => {
      authenticateAs();
      const mocks = makeMocks({ actorRole: 'reseller_support_agent' });
      app = await buildApp(mocks);

      const res = await app.inject({ method: 'GET', url: usageUrl });

      expect(res.statusCode).toBe(200);
      // The payload is scoped to the TARGET customer org, not the caller's.
      expect(res.json()).toMatchObject({ orgId: CUSTOMER_ID, totalCalls: 42 });
      expect(mocks.dashboardService.getUsageSummary).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.anything(),
      );
    });

    it('serves savings and vendors for the target customer too', async () => {
      authenticateAs();
      const mocks = makeMocks();
      app = await buildApp(mocks);

      const savings = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/customers/${CUSTOMER_ID}/dashboard/savings`,
      });
      const vendors = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/customers/${CUSTOMER_ID}/dashboard/vendors`,
      });

      expect(savings.statusCode).toBe(200);
      expect(savings.json()).toMatchObject({ orgId: CUSTOMER_ID });
      expect(vendors.statusCode).toBe(200);
      expect(vendors.json()).toEqual({ vendors: [{ vendor: 'datto-rmm', calls: 12 }] });
    });

    it('403s when the customer does not belong to the reseller', async () => {
      authenticateAs();
      // Caller is a reseller member, but CUSTOMER_ID is not their customer
      // and they have no direct membership in it.
      app = await buildApp(makeMocks({ customerLinkedToReseller: false }));

      const res = await app.inject({ method: 'GET', url: usageUrl });
      expect(res.statusCode).toBe(403);
    });

    it('403s an unowned (reseller,customer) pair — customer belongs to a DIFFERENT reseller (warden Finding 2)', async () => {
      authenticateAs();
      // The cross-reseller variant: the caller IS a reseller_admin of
      // RESELLER_ID, and the target customer DOES have a reseller parent —
      // but it is a *different* reseller. getResellerOfCustomer returns a
      // truthy foreign org whose id !== RESELLER_ID, so the reseller branch's
      // `parent && parent.id === resellerId` equality must reject it (truthy
      // parent is not enough — identity must match). With no customer
      // self-membership the customer branch also fails -> 403. This proves
      // the gate rejects a real-but-foreign parent, not merely a null one.
      const mocks = makeMocks();
      const foreignReseller = makeResellerOrg('reseller_FOREIGN', 'Rival MSP');
      mocks.orgService.getResellerOfCustomer = vi.fn(async () => foreignReseller);
      app = await buildApp(mocks);

      const res = await app.inject({ method: 'GET', url: usageUrl });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'Access denied' });
    });

    it('403s a caller with no reseller membership and no customer membership', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ actorRole: null }));

      const res = await app.inject({ method: 'GET', url: usageUrl });
      expect(res.statusCode).toBe(403);
    });

    it('allows customer-side self-access (direct member of the customer org)', async () => {
      authenticateAs();
      // Not a reseller member, but a direct member of CUSTOMER_ID.
      app = await buildApp(
        makeMocks({ actorRole: null, customerSelfMember: true }),
      );

      const res = await app.inject({ method: 'GET', url: usageUrl });
      expect(res.statusCode).toBe(200);
    });

    it('rejects an unauthenticated caller', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());

      const res = await app.inject({ method: 'GET', url: usageUrl });
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Reseller-scoped customer audit feed (Track A — Audit Log tab)
  // -------------------------------------------------------------------------

  describe('GET /admin/reseller/:resellerId/customers/:customerId/audit', () => {
    const auditUrl = `/admin/reseller/${RESELLER_ID}/customers/${CUSTOMER_ID}/audit`;

    const sampleEntries = [
      {
        id: 'r1', userId: 'u1', userEmail: 'c@am3.com', userName: 'C. Ramirez',
        orgId: CUSTOMER_ID, vendorSlug: 'autotask', toolName: 'search_tickets',
        toolArguments: null, promptContext: null, source: 'claude.ai',
        statusCode: 200, responseTimeMs: 142, createdAt: '2026-05-20T12:00:00.000Z',
      },
      {
        id: 'r2', userId: 'u2', userEmail: null, userName: null,
        orgId: CUSTOMER_ID, vendorSlug: 'datto-rmm', toolName: null,
        toolArguments: null, promptContext: null, source: null,
        statusCode: 200, responseTimeMs: 88, createdAt: '2026-05-20T11:00:00.000Z',
      },
    ];

    it('returns the customer audit feed mapped to the AuditRow shape', async () => {
      authenticateAs();
      const mocks = makeMocks({
        actorRole: 'reseller_support_agent',
        auditQueryImpl: vi.fn(async () => ({ entries: sampleEntries, total: 2 })),
      });
      app = await buildApp(mocks);

      const res = await app.inject({ method: 'GET', url: auditUrl });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [
          { when: '2026-05-20T12:00:00.000Z', actor: 'C. Ramirez', action: 'mcp.tool.invoke', target: 'autotask · search_tickets' },
          // userName/userEmail null -> falls back to userId; null toolName -> vendor only.
          { when: '2026-05-20T11:00:00.000Z', actor: 'u2', action: 'mcp.tool.invoke', target: 'datto-rmm' },
        ],
      });
      // The feed is scoped to the TARGET customer org, not the caller's.
      expect(mocks.auditService.query).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: CUSTOMER_ID }),
      );
    });

    it('403s when the customer does not belong to the reseller (warden Finding 2)', async () => {
      authenticateAs();
      app = await buildApp(makeMocks({ customerLinkedToReseller: false }));

      const res = await app.inject({ method: 'GET', url: auditUrl });
      expect(res.statusCode).toBe(403);
    });

    it('403s an unowned pair — customer belongs to a DIFFERENT reseller', async () => {
      authenticateAs();
      const mocks = makeMocks();
      mocks.orgService.getResellerOfCustomer = vi.fn(async () =>
        makeResellerOrg('reseller_FOREIGN', 'Rival MSP'),
      );
      app = await buildApp(mocks);

      const res = await app.inject({ method: 'GET', url: auditUrl });
      expect(res.statusCode).toBe(403);
      // The audit query must never run for an unowned customer.
      expect(mocks.auditService.query).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated caller', async () => {
      unauthenticated();
      app = await buildApp(makeMocks());

      const res = await app.inject({ method: 'GET', url: auditUrl });
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Feature flag
  // -------------------------------------------------------------------------

  describe('feature flag', () => {
    it('404s all /admin/reseller/* routes when disabled', async () => {
      authenticateAs();
      app = await buildApp(makeMocks(), false);
      const res = await app.inject({ method: 'GET', url: `/admin/reseller/${RESELLER_ID}` });
      expect(res.statusCode).toBe(404);
    });

    it('404s the customer-dashboard route when disabled', async () => {
      authenticateAs();
      app = await buildApp(makeMocks(), false);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reseller/${RESELLER_ID}/customers/${CUSTOMER_ID}/dashboard/usage`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
