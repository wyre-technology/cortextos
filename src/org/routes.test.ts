import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { OrgService } from './org-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { BillingGate } from '../billing/gate.js';
import type { VendorMonitor } from '../monitoring/vendor-monitor.js';
import { enterTestContext, type Sql } from '../db/context.js';

// ---------------------------------------------------------------------------
// Mock requireAuth0
// ---------------------------------------------------------------------------

const mockRequireAuth0 = vi.fn();

vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// ---------------------------------------------------------------------------
// Mock vendor-config
// ---------------------------------------------------------------------------

const mockGetVendor = vi.fn();

vi.mock('../credentials/vendor-config.js', () => ({
  getVendor: (...args: unknown[]) => mockGetVendor(...args),
}));

// ---------------------------------------------------------------------------
// Mock the SCIM connections service
// ---------------------------------------------------------------------------
// POST /api/orgs/:orgId/scim/connections dynamically imports this and calls
// new ScimConnectionsService().create(). Mocked so the SSO-gate tests can
// exercise the Business-tier pass path without a live database.

const mockScimCreate = vi.fn();

vi.mock('../scim/connections-service.js', () => ({
  ScimConnectionsService: vi.fn(() => ({
    create: mockScimCreate,
    listForOrg: vi.fn().mockResolvedValue([]),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = randomBytes(32).toString('hex');
const JWT_SECRET = randomBytes(32).toString('hex');

const TEST_USER = { sub: 'user-1', email: 'test@example.com' };
const TEST_ORG = {
  id: 'org-1',
  name: 'Test Org',
  ownerId: 'user-1',
  plan: 'pro' as const,
  defaultServerAccess: 'none' as const,
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'standalone' as const,
  parentOrgId: null,
  auth0OrgId: null,
  suspendedAt: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function createMockOrgService(overrides: Partial<OrgService> = {}): OrgService {
  return {
    createOrg: vi.fn(),
    getOrg: vi.fn().mockResolvedValue(null),
    getUserOrgs: vi.fn().mockResolvedValue([]),
    getMembership: vi.fn().mockResolvedValue(null),
    getMembers: vi.fn().mockResolvedValue([]),
    getMembersWithProfiles: vi.fn().mockResolvedValue([]),
    updateOrg: vi.fn(),
    deleteOrg: vi.fn(),
    softDeleteOrg: vi.fn(),
    restoreOrg: vi.fn(),
    suspendOrg: vi.fn(),
    unsuspendOrg: vi.fn(),
    removeMember: vi.fn(),
    updateMemberRole: vi.fn(),
    createInvitation: vi.fn(),
    getInvitationByToken: vi.fn(),
    acceptInvitation: vi.fn(),
    listInvitations: vi.fn().mockResolvedValue([]),
    revokeInvitation: vi.fn(),
    updateOrgPlan: vi.fn(),
    updateOrgSettings: vi.fn(),
    initTables: vi.fn(),
    logRequest: vi.fn(),
    cleanupRequestLog: vi.fn(),
    grantServerAccess: vi.fn(),
    revokeServerAccess: vi.fn(),
    hasServerAccess: vi.fn(),
    listServerAccess: vi.fn().mockResolvedValue([]),
    bulkSetServerAccess: vi.fn(),
    grantAllServerAccess: vi.fn(),
    migrateServerAccessForExistingMembers: vi.fn(),
    getPromptCaptureEnabled: vi.fn().mockResolvedValue(false),
    setPromptCaptureEnabled: vi.fn(),
    ...overrides,
  } as unknown as OrgService;
}

function createMockCredentialService(overrides: Partial<CredentialService> = {}): CredentialService {
  return {
    storeOrgCredential: vi.fn().mockResolvedValue('cred-1'),
    listOrgVendors: vi.fn().mockResolvedValue([]),
    deleteOrgCredential: vi.fn().mockResolvedValue(true),
    getOrgCredential: vi.fn().mockResolvedValue(null),
    storeCredential: vi.fn(),
    getCredential: vi.fn(),
    deleteCredential: vi.fn(),
    listVendors: vi.fn(),
    initTables: vi.fn(),
    ...overrides,
  } as unknown as CredentialService;
}

function createMockBillingGate(overrides: Partial<BillingGate> = {}): BillingGate {
  return {
    getUserPlan: vi.fn().mockResolvedValue('free'),
    canAccessPaidFeatures: vi.fn().mockResolvedValue(false),
    canUseTeamFeatures: vi.fn().mockResolvedValue(true),
    canAddMember: vi.fn().mockResolvedValue(true),
    getConnectionLimit: vi.fn().mockResolvedValue(Infinity),
    getRateLimit: vi.fn().mockResolvedValue(1000),
    canUsePromptCapture: vi.fn().mockResolvedValue(false),
    canUseLogShipping: vi.fn().mockResolvedValue(false),
    canUseAuditLogExport: vi.fn().mockResolvedValue(false),
    canUseSso: vi.fn().mockResolvedValue(false),
    canUseServiceClients: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

/** Set up auth mock to return the test user. */
function authenticateAs(user = TEST_USER): void {
  mockRequireAuth0.mockReturnValue(user);
}

/** Set up auth mock to simulate unauthenticated request. */
function unauthenticated(): void {
  mockRequireAuth0.mockImplementation(
    (_request: unknown, reply: { redirect: (url: string, code: number) => void }) => {
      reply.redirect('/auth/login', 302);
      return null;
    },
  );
}

/** A VendorMonitor stub whose getStatus() returns the given cache. */
function createMockVendorMonitor(
  cache: Record<string, unknown> = {},
): VendorMonitor {
  return { getStatus: vi.fn().mockReturnValue(cache) } as unknown as VendorMonitor;
}

async function buildApp(
  orgService: OrgService,
  credentialService?: CredentialService,
  billingGate?: BillingGate,
  vendorMonitor?: VendorMonitor,
  actingAsSessionService?: { revokeAllForCustomerOrg: ReturnType<typeof vi.fn> },
): Promise<FastifyInstance> {
  vi.resetModules();
  vi.stubEnv('MASTER_KEY', MASTER_KEY);
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('BASE_URL', 'https://mcp.test.com');

  const { orgRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  enterTestContext({} as Sql);
  await app.register(
    orgRoutes({
      orgService,
      credentialService: credentialService ?? createMockCredentialService(),
      billingGate: billingGate ?? createMockBillingGate(),
      adminAuditService: { log: vi.fn().mockResolvedValue(undefined) } as any, //sql: {} as any,
      vendorMonitor: vendorMonitor ?? createMockVendorMonitor(),
      // LAYER-C suspend cascade dep — default mock that returns "no
      // sessions revoked" so non-suspend tests don't have to wire it.
      // Suspend-route tests pass their own mock to assert the cascade.
      actingAsSessionService:
        (actingAsSessionService ?? {
          revokeAllForCustomerOrg: vi.fn().mockResolvedValue([]),
        }) as any,
    }),
  );
  return app;
}

/** Helper to set up getMembership to return an owner membership. */
function ownerMembership(orgId = 'org-1', userId = 'user-1') {
  return vi.fn().mockResolvedValue({
    id: 'mem-1',
    orgId,
    userId,
    role: 'owner',
    joinedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

/** Helper to set up getMembership to return a member (non-owner) membership. */
function memberMembership(orgId = 'org-1', userId = 'user-1') {
  return vi.fn().mockResolvedValue({
    id: 'mem-2',
    orgId,
    userId,
    role: 'member',
    joinedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

/** Helper to set up getMembership to return an admin membership. */
function adminMembership(orgId = 'org-1', userId = 'user-1') {
  return vi.fn().mockResolvedValue({
    id: 'mem-3',
    orgId,
    userId,
    role: 'admin',
    joinedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

/**
 * getMembership that is target-aware: admin for the requester (user-1) and
 * null for anyone else. Used by the #78 M10 tests — the requester passes the
 * requireOrgRole admin check, but a non-member target must 404.
 */
function targetAwareMembership() {
  return vi.fn(async (orgId: string, userId: string) =>
    userId === 'user-1'
      ? {
          id: 'mem-3',
          orgId,
          userId,
          role: 'admin' as const,
          joinedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }
      : null,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orgRoutes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockRequireAuth0.mockReset();
    mockGetVendor.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs
  // -------------------------------------------------------------------------

  describe('POST /api/orgs', () => {
    it('creates an org successfully and returns 201', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([]),
        createOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs',
        payload: { name: 'Test Org' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(TEST_ORG);
      // Layer 1 (DOR §9.1): routes.ts no longer attaches a plan slug at the
      // call site — OrgService.createOrg defaults to getDefaultPlan() which
      // returns 'conduit'. routes.ts threads ownerEmail so Stripe gets the
      // trial-ending notification address. Main added request.log as a 5th
      // param for notifyNewSignup — match the new signature shape.
      expect(orgService.createOrg).toHaveBeenCalledWith(
        'Test Org',
        'user-1',
        undefined,
        { ownerEmail: 'test@example.com' },
        expect.anything(),
      );
    });

    it('returns 400 when name is empty', async () => {
      authenticateAs();
      const orgService = createMockOrgService();
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs',
        payload: { name: '' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Organization name is required' });
    });

    it('returns 400 when name is whitespace only', async () => {
      authenticateAs();
      const orgService = createMockOrgService();
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs',
        payload: { name: '   ' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Organization name is required' });
    });

    it('returns 409 when user already owns an org', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([TEST_ORG]),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs',
        payload: { name: 'Another Org' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('You already own an organization');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/orgs
  // -------------------------------------------------------------------------

  describe('GET /api/orgs', () => {
    it('lists user orgs', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([TEST_ORG]),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([TEST_ORG]);
      expect(orgService.getUserOrgs).toHaveBeenCalledWith('user-1');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/orgs/:orgId
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId', () => {
    it('returns org details for a member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(TEST_ORG);
    });

    it('returns 403 for non-member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1' });

      expect(response.statusCode).toBe(403);
      // Helper requireOrgRole now surfaces a more diagnostic message
      // ("Not a member..." vs the previous generic "You do not have
      // permission..."). The 403 status is the load-bearing assertion;
      // the message-text shift is an intentional ergonomics improvement
      // from the WYREAI-171 Phase-3 close.
      expect(response.json().error).toBe('Not a member of this organization');
    });

    it('returns 404 when org does not exist', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
        getOrg: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-missing' });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('Organization not found');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/orgs/:orgId
  // -------------------------------------------------------------------------

  describe('PATCH /api/orgs/:orgId', () => {
    it('updates org name when user is owner', async () => {
      authenticateAs();
      const updated = { ...TEST_ORG, name: 'Renamed Org' };
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        updateOrg: vi.fn().mockResolvedValue(updated),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1',
        payload: { name: 'Renamed Org' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('Renamed Org');
      expect(orgService.updateOrg).toHaveBeenCalledWith('org-1', 'Renamed Org');
    });

    it('returns 403 for a member who is not the owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1',
        payload: { name: 'New Name' },
      });

      expect(response.statusCode).toBe(403);
      // Helper requireOrgRole role-shortfall message ("Requires owner role
      // or higher") replaces the generic previous "You do not have
      // permission..." — intentional diagnostic improvement.
      expect(response.json().error).toBe('Requires owner role or higher');
    });

    it('returns 400 when name is empty', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1',
        payload: { name: '' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Organization name is required');
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/orgs/:orgId
  // -------------------------------------------------------------------------

  // LAYER-C destructive-lifecycle suite (WYREAI-171 Phase-3 follow-up,
  // boss msg-1781747082572 + warden pre-prep msg-1781747367566). Covers:
  //   - DELETE rewrite to admin-threshold soft-delete + typed-name +
  //     idempotency + rate-limit + audit-triplet
  //   - POST /suspend with the actingAsSessionService cascade
  //   - POST /unsuspend
  //   - POST /restore
  //   - Threshold-split test artifact (the boss-required warden proof):
  //     admin-threshold = sufficient for soft-delete; hard-delete is
  //     no longer reachable from this surface.
  describe('DELETE /api/orgs/:orgId (LAYER-C soft-delete)', () => {
    it('soft-deletes when admin + typed-name matches + audit-triplet fires + explicit cascade revokes acting-as sessions', async () => {
      authenticateAs();
      const softDeletedOrg = {
        ...TEST_ORG,
        deletedAt: new Date().toISOString(),
      };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
        softDeleteOrg: vi.fn().mockResolvedValue(softDeletedOrg),
      });
      const revokeAll = vi.fn().mockResolvedValue([
        { sessionId: 'aas_a' },
        { sessionId: 'aas_b' },
      ]);
      app = await buildApp(orgService, undefined, undefined, undefined, {
        revokeAllForCustomerOrg: revokeAll,
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: TEST_ORG.name },
      });

      expect(response.statusCode).toBe(200);
      expect(orgService.softDeleteOrg).toHaveBeenCalledWith('org-1');
      // Hard-delete must NOT be called from this surface.
      expect(orgService.deleteOrg).not.toHaveBeenCalled();
      // EXPLICIT CASCADE PROOF — warden VERIFY-1 verdict-matrix
      // APPROVE-CLEAN path (boss msg-1781750687331). The middleware
      // implicit cascade still catches the hole on the next tick,
      // but the explicit cascade here emits per-session audit-
      // revokes immediately at delete time + is symmetric with the
      // suspend route.
      expect(revokeAll).toHaveBeenCalledWith('org-1', 'customer_deleted');
      const body = response.json();
      expect(body.sessions_revoked).toBe(2);
    });

    it('400 when body.org_name does not match the current org name (typed-confirm gate)', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
        softDeleteOrg: vi.fn(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: 'Wrong Name' },
      });

      expect(response.statusCode).toBe(400);
      expect(orgService.softDeleteOrg).not.toHaveBeenCalled();
    });

    it('400 when body.org_name is missing or not a string', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const resMissing = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: {},
      });
      expect(resMissing.statusCode).toBe(400);

      const resWrongType = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: 42 },
      });
      expect(resWrongType.statusCode).toBe(400);
    });

    it('400 strict-mode body — unknown fields rejected (warden pre-prep)', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: TEST_ORG.name, sneaky_field: 'attack' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404 when the org does not exist', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-missing',
        payload: { org_name: 'whatever' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('idempotent — re-DELETE on already-soft-deleted org returns 200 without re-emitting audit', async () => {
      authenticateAs();
      const alreadySoft = {
        ...TEST_ORG,
        deletedAt: new Date().toISOString(),
      };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(alreadySoft),
        softDeleteOrg: vi.fn(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: TEST_ORG.name },
      });

      expect(response.statusCode).toBe(200);
      // Idempotency: do NOT re-call softDeleteOrg or duplicate the audit.
      expect(orgService.softDeleteOrg).not.toHaveBeenCalled();
    });

    it('returns 403 for non-admin (member)', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: TEST_ORG.name },
      });

      expect(response.statusCode).toBe(403);
    });

    // THRESHOLD-SPLIT TEST ARTIFACT (boss msg-1781747922884 — the
    // warden-required proof that the authz-loosening is justified by
    // the reversibility primitive). Pre-LAYER-C: DELETE was owner-only
    // hard-delete (effectiveRole='admin' for reseller-acting-as → 403,
    // Aaron blocked). Post-LAYER-C: DELETE is admin-threshold soft-
    // delete (effectiveRole='admin' → 200, Aaron unblocked). Hard-
    // delete is no longer reachable from this route — that's the
    // safe-by-construction split (irreversible hard-delete stays
    // owner-only, lives only in the post-window sweeper path).
    it('THRESHOLD-SPLIT: admin role is sufficient for soft-delete (was 403 pre-LAYER-C, now 200)', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
        softDeleteOrg: vi
          .fn()
          .mockResolvedValue({ ...TEST_ORG, suspendedAt: new Date().toISOString() }),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1',
        payload: { org_name: TEST_ORG.name },
      });

      expect(response.statusCode).toBe(200);
      expect(orgService.softDeleteOrg).toHaveBeenCalledWith('org-1');
    });
  });

  describe('POST /api/orgs/:orgId/suspend (LAYER-C)', () => {
    it('suspends + fires actingAs cascade + audit-triplet on success', async () => {
      authenticateAs();
      const suspendedOrg = { ...TEST_ORG, suspendedAt: new Date().toISOString() };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
        suspendOrg: vi.fn().mockResolvedValue(suspendedOrg),
      });
      const revokeAll = vi.fn().mockResolvedValue([
        { sessionId: 'aas_1' },
        { sessionId: 'aas_2' },
        { sessionId: 'aas_3' },
      ]);
      app = await buildApp(orgService, undefined, undefined, undefined, {
        revokeAllForCustomerOrg: revokeAll,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/suspend',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.sessions_revoked).toBe(3);
      expect(orgService.suspendOrg).toHaveBeenCalledWith('org-1');
      // CASCADE PROOF — the warden-required "Avoid the soft-state bug"
      // assertion (msg-1781747367566): suspend MUST call the cascade.
      expect(revokeAll).toHaveBeenCalledWith('org-1', 'customer_archived');
    });

    it('idempotent — re-suspending an already-suspended org returns 200 without re-cascade', async () => {
      authenticateAs();
      const alreadySuspended = { ...TEST_ORG, suspendedAt: new Date().toISOString() };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(alreadySuspended),
        suspendOrg: vi.fn(),
      });
      const revokeAll = vi.fn();
      app = await buildApp(orgService, undefined, undefined, undefined, {
        revokeAllForCustomerOrg: revokeAll,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/suspend',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(orgService.suspendOrg).not.toHaveBeenCalled();
      expect(revokeAll).not.toHaveBeenCalled();
    });

    it('400 strict-mode body — any field rejected', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/suspend',
        payload: { unexpected: true },
      });
      expect(response.statusCode).toBe(400);
    });

    it('403 for non-admin (member)', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/suspend',
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });

    it('404 when org missing', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-missing/suspend',
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/orgs/:orgId/unsuspend (LAYER-C)', () => {
    it('clears suspended_at + audit-triplet fires', async () => {
      authenticateAs();
      const suspendedOrg = { ...TEST_ORG, suspendedAt: new Date().toISOString() };
      const restored = { ...TEST_ORG, suspendedAt: null };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(suspendedOrg),
        unsuspendOrg: vi.fn().mockResolvedValue(restored),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/unsuspend',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(orgService.unsuspendOrg).toHaveBeenCalledWith('org-1');
    });

    it('idempotent — unsuspending an active org returns 200 without re-call', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
        unsuspendOrg: vi.fn(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/unsuspend',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(orgService.unsuspendOrg).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/orgs/:orgId/restore (LAYER-C)', () => {
    it('restores soft-deleted org via the same schema-level op as unsuspend', async () => {
      authenticateAs();
      const softDeleted = { ...TEST_ORG, deletedAt: new Date().toISOString() };
      const restored = { ...TEST_ORG, deletedAt: null };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        getOrg: vi.fn().mockResolvedValue(softDeleted),
        restoreOrg: vi.fn().mockResolvedValue(restored),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/restore',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(orgService.restoreOrg).toHaveBeenCalledWith('org-1');
    });

    it('403 for non-admin', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/restore',
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs/:orgId/invitations
  // -------------------------------------------------------------------------

  describe('POST /api/orgs/:orgId/invitations', () => {
    it('creates an invitation when owner and pro plan', async () => {
      authenticateAs();
      const invitation = {
        id: 'inv-1',
        orgId: 'org-1',
        invitedBy: 'user-1',
        expiresAt: new Date().toISOString(),
        acceptedBy: null,
        acceptedAt: null,
        maxUses: 1,
        useCount: 0,
        createdAt: new Date().toISOString(),
      };
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        // Post-015 contract: createInvitation returns { invitation, plainToken }.
        // plainToken is the only place cleartext exists outside the inviter's
        // clipboard.
        createInvitation: vi.fn().mockResolvedValue({
          invitation,
          plainToken: 'invite-token-abc',
        }),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      // The response body surfaces plaintext at create time — the once-shown
      // moment for the inviter to copy the URL.
      expect(body.token).toBe('invite-token-abc');
      expect(body.inviteUrl).toContain('/invite/invite-token-abc');
      expect(body.id).toBe('inv-1');
    });

    it('returns 402 when not on pro plan', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe('Upgrade to Pro to invite team members');
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 400 for a malformed optional email — before any invitation is created', async () => {
      authenticateAs();
      const createInvitation = vi.fn();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        createInvitation,
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
        payload: { email: 'not-an-email' },
      });

      expect(response.statusCode).toBe(400);
      // Validation precedes the mutation — no invitation row is created.
      expect(createInvitation).not.toHaveBeenCalled();
    });

    it('passes recipientEmail through to createInvitation when an email is provided (β-extension to member-invites)', async () => {
      // Per task_1779450095130 / launch-gate-batch: when the create-flow
      // has an explicit recipient address, persist it on the invitation
      // row so acceptInvitation enforces the same email-match guard as
      // the owner-invite path. Discipline does not fork between
      // owner-invite and member-invite paths.
      authenticateAs();
      const createInvitation = vi.fn().mockResolvedValue({
        invitation: {
          id: 'inv1',
          orgId: 'org-1',
          invitedBy: 'user-1',
          expiresAt: '2024-03-01T00:00:00.000Z',
          acceptedBy: null,
          acceptedAt: null,
          maxUses: 1,
          useCount: 0,
          createdAt: '2024-03-01T00:00:00.000Z',
          intendedRole: null,
          recipientEmail: 'invited@example.com',
        },
        plainToken: 'tok-1',
      });
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        createInvitation,
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
        payload: { email: 'invited@example.com' },
      });

      expect(response.statusCode).toBe(201);
      expect(createInvitation).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        expect.objectContaining({ recipientEmail: 'invited@example.com' }),
      );
    });

    it('omits recipientEmail when no email is provided (share-link/(α) shape preserved)', async () => {
      // Share-link invites stay on the (α) shape — null recipient_email,
      // any-authenticated-user accepts. The launch-gate-batch extension
      // is opt-in via the body.email field; absence preserves the
      // existing behavior.
      authenticateAs();
      const createInvitation = vi.fn().mockResolvedValue({
        invitation: {
          id: 'inv1',
          orgId: 'org-1',
          invitedBy: 'user-1',
          expiresAt: '2024-03-01T00:00:00.000Z',
          acceptedBy: null,
          acceptedAt: null,
          maxUses: 1,
          useCount: 0,
          createdAt: '2024-03-01T00:00:00.000Z',
          intendedRole: null,
          recipientEmail: null,
        },
        plainToken: 'tok-1',
      });
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        createInvitation,
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/invitations',
        payload: {},
      });

      expect(response.statusCode).toBe(201);
      // Either omitted entirely or undefined — both signal "share-link
      // shape, no recipient binding."
      expect(createInvitation).toHaveBeenCalledWith('org-1', 'user-1', undefined);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/orgs/:orgId/invitations
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId/invitations', () => {
    it('lists pending invitations', async () => {
      authenticateAs();
      const invitations = [
        { id: 'inv-1', orgId: 'org-1', token: 'tok-1', createdAt: new Date().toISOString() },
      ];
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        listInvitations: vi.fn().mockResolvedValue(invitations),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/invitations',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(invitations);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/invitations/:id
  // -------------------------------------------------------------------------

  describe('DELETE /api/orgs/:orgId/invitations/:id', () => {
    it('revokes an invitation', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        revokeInvitation: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/invitations/inv-1',
      });

      expect(response.statusCode).toBe(204);
      // Both the invitation id AND the path org id are passed so the
      // service can scope the DELETE — the route is authorized against
      // :orgId but the invitation id alone is not org-bound.
      expect(orgService.revokeInvitation).toHaveBeenCalledWith('inv-1', 'org-1');
    });

    it('returns 404 when the invitation does not belong to the org (cross-tenant guard)', async () => {
      authenticateAs();
      // revokeInvitation returns false: the scoped DELETE matched no row —
      // the invitation belongs to another org (or does not exist). The route
      // must surface an honest 404, not a silent 204 success.
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        revokeInvitation: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/invitations/inv-from-org-2',
      });

      expect(response.statusCode).toBe(404);
      expect(orgService.revokeInvitation).toHaveBeenCalledWith('inv-from-org-2', 'org-1');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/orgs/:orgId/members
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId/members', () => {
    it('lists members', async () => {
      authenticateAs();
      const members = [
        { id: 'mem-1', orgId: 'org-1', userId: 'user-1', role: 'owner' },
        { id: 'mem-2', orgId: 'org-1', userId: 'user-2', role: 'member' },
      ];
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
        getMembers: vi.fn().mockResolvedValue(members),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/members',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(2);
    });

    it('returns 403 for non-member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/members',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/members/:userId
  // -------------------------------------------------------------------------

  describe('DELETE /api/orgs/:orgId/members/:userId', () => {
    it('removes a member when user is owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        removeMember: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/members/user-2',
      });

      expect(response.statusCode).toBe(204);
      expect(orgService.removeMember).toHaveBeenCalledWith('org-1', 'user-2');
    });

    it('returns 400 when trying to remove the owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        removeMember: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/members/user-1',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Cannot remove the org owner');
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/members/user-2',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs/:orgId/credentials/:vendor
  // -------------------------------------------------------------------------

  describe('POST /api/orgs/:orgId/credentials/:vendor', () => {
    const testVendor = {
      name: 'Datto RMM',
      slug: 'datto-rmm',
      containerUrl: 'http://datto-rmm-mcp:8080',
      fields: [
        { key: 'apiKey', label: 'API Key', required: true },
        { key: 'apiSecret', label: 'API Secret', required: true, secret: true },
      ],
      headerMapping: { apiKey: 'X-Datto-API-Key', apiSecret: 'X-Datto-API-Secret' },
      docsUrl: 'https://example.com/docs',
    };

    it('stores a credential when owner and pro plan', async () => {
      authenticateAs();
      mockGetVendor.mockReturnValue(testVendor);
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const credentialService = createMockCredentialService({
        storeOrgCredential: vi.fn().mockResolvedValue('cred-new'),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, credentialService, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/datto-rmm',
        payload: { apiKey: 'key123', apiSecret: 'secret456' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: 'cred-new', vendor: 'datto-rmm' });
      expect(credentialService.storeOrgCredential).toHaveBeenCalledWith(
        'org-1',
        'datto-rmm',
        { apiKey: 'key123', apiSecret: 'secret456' },
        'user-1',
      );
    });

    it('returns 402 when not on pro plan', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/datto-rmm',
        payload: { apiKey: 'key123', apiSecret: 'secret456' },
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe('Upgrade to Pro to manage team credentials');
    });

    it('returns 404 for unknown vendor', async () => {
      authenticateAs();
      mockGetVendor.mockReturnValue(undefined);
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/unknown-vendor',
        payload: { apiKey: 'key123' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('Unknown vendor');
    });

    it('returns 400 when required field is missing', async () => {
      authenticateAs();
      mockGetVendor.mockReturnValue(testVendor);
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/datto-rmm',
        payload: { apiKey: 'key123' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('API Secret is required');
    });

    it('returns 422 when vendor validation fails', async () => {
      authenticateAs();
      const vendorWithValidation = {
        ...testVendor,
        validate: vi.fn().mockResolvedValue({ valid: false, error: 'Invalid API key' }),
      };
      mockGetVendor.mockReturnValue(vendorWithValidation);
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const billingGate = createMockBillingGate({
        canUseTeamFeatures: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/datto-rmm',
        payload: { apiKey: 'bad-key', apiSecret: 'bad-secret' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('Invalid API key');
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/credentials/datto-rmm',
        payload: { apiKey: 'key123', apiSecret: 'secret456' },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/orgs/:orgId/credentials
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId/credentials', () => {
    it('lists connected vendors', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      const credentialService = createMockCredentialService({
        listOrgVendors: vi.fn().mockResolvedValue(['datto-rmm', 'itglue']),
      });
      app = await buildApp(orgService, credentialService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/credentials',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(['datto-rmm', 'itglue']);
    });

    it('returns 403 for non-member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/credentials',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/orgs/:orgId/credentials/:vendor
  // -------------------------------------------------------------------------

  describe('DELETE /api/orgs/:orgId/credentials/:vendor', () => {
    it('removes a credential when user is owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      const credentialService = createMockCredentialService({
        deleteOrgCredential: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, credentialService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/credentials/datto-rmm',
      });

      expect(response.statusCode).toBe(204);
      expect(credentialService.deleteOrgCredential).toHaveBeenCalledWith('org-1', 'datto-rmm');
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/orgs/org-1/credentials/datto-rmm',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs/:orgId/service-clients — Business-tier gate
  // -------------------------------------------------------------------------
  // Regression guard for P1-8: canUseServiceClients was defined but never
  // called, so any org admin — including a below-Business org — could create
  // a service client by hitting the API directly. The gate is enforced at the
  // API layer (the /org/service-clients web page gate is not enough).

  describe('POST /api/orgs/:orgId/service-clients', () => {
    it('returns 402 when the org is below the Business plan', async () => {
      authenticateAs();
      const createServiceClient = vi.fn();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        createServiceClient,
      } as unknown as Partial<OrgService>);
      const billingGate = createMockBillingGate({
        canUseServiceClients: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/service-clients',
        payload: { name: 'ci-bot' },
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe('Service clients require the Business plan');
      // The gate must short-circuit before the client is ever created.
      expect(createServiceClient).not.toHaveBeenCalled();
    });

    it('creates a service client when the org is on the Business plan', async () => {
      authenticateAs();
      const createServiceClient = vi.fn().mockResolvedValue({
        id: 'sc-1',
        name: 'ci-bot',
        expiresAt: undefined,
        createdAt: new Date().toISOString(),
      });
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        createServiceClient,
      } as unknown as Partial<OrgService>);
      const billingGate = createMockBillingGate({
        canUseServiceClients: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/service-clients',
        payload: { name: 'ci-bot' },
      });

      expect(response.statusCode).toBe(201);
      // client_secret is surfaced once, at create time.
      expect(response.json().client_secret).toBeTruthy();
      expect(createServiceClient).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs/:orgId/scim/connections — Business-tier (SSO) gate
  // -------------------------------------------------------------------------
  // Regression guard for P1-8: canUseSso was defined but never called, and
  // this endpoint gated only on requireOrgRole(admin) — no plan gate at all —
  // so even a Free-org admin could provision a SCIM/SSO connection via the
  // API. The gate is enforced at the API layer.

  describe('POST /api/orgs/:orgId/scim/connections', () => {
    beforeEach(() => mockScimCreate.mockReset());

    it('returns 402 when the org is below the Business plan', async () => {
      authenticateAs();
      const orgService = createMockOrgService({ getMembership: ownerMembership() });
      const billingGate = createMockBillingGate({
        canUseSso: vi.fn().mockResolvedValue(false),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/scim/connections',
        payload: { idp_type: 'entra', default_role: 'member' },
      });

      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe('SSO / SCIM provisioning requires the Business plan');
      // The gate must short-circuit before the connection is ever created.
      expect(mockScimCreate).not.toHaveBeenCalled();
    });

    it('creates a SCIM connection when the org is on the Business plan', async () => {
      authenticateAs();
      mockScimCreate.mockResolvedValue({
        connection: {
          id: 'scim-1',
          idpType: 'entra',
          scope: 'tenant',
          defaultRole: 'member',
          createdAt: new Date().toISOString(),
        },
        token: 'scim-token-abc',
      });
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      const billingGate = createMockBillingGate({
        canUseSso: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService, undefined, billingGate);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/scim/connections',
        payload: { idp_type: 'entra', default_role: 'member' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().token).toBe('scim-token-abc');
      expect(mockScimCreate).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GET /invite/:token
  // -------------------------------------------------------------------------

  describe('GET /invite/:token', () => {
    it('renders the invite page for a valid invitation', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getInvitationByToken: vi.fn().mockResolvedValue({
          id: 'inv-1',
          orgId: 'org-1',
          token: 'valid-token',
          expiresAt: new Date().toISOString(),
        }),
        getOrg: vi.fn().mockResolvedValue(TEST_ORG),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/invite/valid-token',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Test Org');
      expect(response.body).toContain('valid-token');
    });

    it('returns 404 for expired or invalid invitation', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getInvitationByToken: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/invite/expired-token',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('expired or is no longer valid');
    });

    it('returns 404 when org not found', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getInvitationByToken: vi.fn().mockResolvedValue({
          id: 'inv-1',
          orgId: 'org-deleted',
          token: 'orphan-token',
        }),
        getOrg: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/invite/orphan-token',
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('Organization not found');
    });
  });

  // -------------------------------------------------------------------------
  // POST /invite/:token
  // -------------------------------------------------------------------------

  describe('POST /invite/:token', () => {
    it('accepts an invitation and redirects to /settings', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        acceptInvitation: vi.fn().mockResolvedValue({
          id: 'mem-new',
          orgId: 'org-1',
          userId: 'user-1',
          role: 'member',
        }),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/invite/valid-token',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/settings');
      // Layer 1 owner-invite-delivery: acceptInvitation now takes a 4th
      // userEmail argument (required when invitation.recipient_email IS NOT
      // NULL; null-tolerated for legacy invites). routes.ts threads
      // user.email ?? null verbatim from the auth context.
      expect(orgService.acceptInvitation).toHaveBeenCalledWith(
        'valid-token',
        'user-1',
        expect.anything(),
        expect.anything(),
      );
    });

    it('returns 404 for invalid token', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        acceptInvitation: vi.fn().mockResolvedValue(null),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/invite/bad-token',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('expired or is no longer valid');
    });

    it('redirects to login when not authenticated', async () => {
      unauthenticated();
      const orgService = createMockOrgService();
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/invite/some-token',
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/auth/login');
    });
  });

  // -------------------------------------------------------------------------
  // Vendor health
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId/vendor-health', () => {
    /** A monitor cache entry shaped like VendorMonitor.getStatus() output. */
    function cacheEntry(over: Record<string, unknown> = {}) {
      return {
        status: 'up',
        version: '1.0.0',
        responseMs: 120,
        lastChecked: new Date('2026-05-16T17:00:00.000Z'),
        lastStateChange: new Date('2026-05-16T16:00:00.000Z'),
        consecutiveFailures: 0,
        lastError: null,
        ...over,
      };
    }

    it('returns 403 for a non-member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({ getMembership: vi.fn().mockResolvedValue(null) });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/vendor-health',
      });

      expect(response.statusCode).toBe(403);
    });

    it('maps each connected vendor to its 4-state health', async () => {
      authenticateAs();
      mockGetVendor.mockImplementation((slug: string) => ({ name: `Vendor ${slug}` }));
      const orgService = createMockOrgService({ getMembership: memberMembership() });
      const credentialService = createMockCredentialService({
        listOrgVendors: vi.fn().mockResolvedValue(['v-healthy', 'v-degraded', 'v-down', 'v-unprobed']),
      });
      const vendorMonitor = createMockVendorMonitor({
        'v-healthy': cacheEntry(),
        // up but carrying 1-2 failures below the down threshold -> degraded
        'v-degraded': cacheEntry({ consecutiveFailures: 2, lastError: 'timeout' }),
        'v-down': cacheEntry({ status: 'down', consecutiveFailures: 5, lastError: 'HTTP 503' }),
        // 'v-unprobed' deliberately absent from the cache
      });
      app = await buildApp(orgService, credentialService, undefined, vendorMonitor);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/vendor-health',
      });

      expect(response.statusCode).toBe(200);
      const byslug = Object.fromEntries(
        response.json().vendors.map((v: { vendorSlug: string }) => [v.vendorSlug, v]),
      );
      expect(byslug['v-healthy'].status).toBe('healthy');
      expect(byslug['v-degraded'].status).toBe('degraded');
      expect(byslug['v-down'].status).toBe('down');
      expect(byslug['v-unprobed'].status).toBe('unknown');
      expect(byslug['v-healthy'].displayName).toBe('Vendor v-healthy');
    });

    it('surfaces errorDetail only for degraded/down vendors, bounded to a controlled string', async () => {
      authenticateAs();
      mockGetVendor.mockImplementation((slug: string) => ({ name: slug }));
      const orgService = createMockOrgService({ getMembership: memberMembership() });
      const credentialService = createMockCredentialService({
        listOrgVendors: vi.fn().mockResolvedValue(['v-healthy', 'v-down-http', 'v-down-raw']),
      });
      const vendorMonitor = createMockVendorMonitor({
        'v-healthy': cacheEntry({ lastError: null }),
        'v-down-http': cacheEntry({ status: 'down', consecutiveFailures: 5, lastError: 'HTTP 503' }),
        // A raw exception string from the probe catch path must NOT pass through.
        'v-down-raw': cacheEntry({
          status: 'down',
          consecutiveFailures: 5,
          lastError: 'connect ECONNREFUSED 10.0.3.7:8080',
        }),
      });
      app = await buildApp(orgService, credentialService, undefined, vendorMonitor);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/vendor-health',
      });

      const byslug = Object.fromEntries(
        response.json().vendors.map((v: { vendorSlug: string }) => [v.vendorSlug, v]),
      );
      expect(byslug['v-healthy'].errorDetail).toBeNull();
      // HTTP status collapses to a class; the raw exception string is denied.
      expect(byslug['v-down-http'].errorDetail).toBe('HTTP 5xx');
      expect(byslug['v-down-raw'].errorDetail).toBe('connection failed');
    });

    it('returns only the vendors the org has connected', async () => {
      authenticateAs();
      mockGetVendor.mockImplementation((slug: string) => ({ name: slug }));
      const orgService = createMockOrgService({ getMembership: memberMembership() });
      const credentialService = createMockCredentialService({
        listOrgVendors: vi.fn().mockResolvedValue(['v-connected']),
      });
      const vendorMonitor = createMockVendorMonitor({
        'v-connected': cacheEntry(),
        'v-other-tenant': cacheEntry(),
      });
      app = await buildApp(orgService, credentialService, undefined, vendorMonitor);

      const response = await app.inject({
        method: 'GET',
        url: '/api/orgs/org-1/vendor-health',
      });

      const slugs = response.json().vendors.map((v: { vendorSlug: string }) => v.vendorSlug);
      expect(slugs).toEqual(['v-connected']);
    });
  });

  // -------------------------------------------------------------------------
  // Server access control
  // -------------------------------------------------------------------------

  describe('GET /api/orgs/:orgId/server-access', () => {
    it('lists all grants for admin', async () => {
      authenticateAs();
      const grants = [
        { id: 'g-1', orgId: 'org-1', userId: 'user-2', vendorSlug: 'datto-rmm', grantedBy: 'user-1', grantedAt: new Date().toISOString() },
      ];
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        listServerAccess: vi.fn().mockResolvedValue(grants),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1/server-access' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(grants);
    });

    it('returns 403 for member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1/server-access' });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /api/orgs/:orgId/members/:userId/server-access', () => {
    it('allows self-access for member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
        listServerAccess: vi.fn().mockResolvedValue([]),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1/members/user-1/server-access' });
      expect(response.statusCode).toBe(200);
    });

    it('returns 403 when member tries to view another user', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'GET', url: '/api/orgs/org-1/members/user-2/server-access' });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PUT /api/orgs/:orgId/members/:userId/server-access/:vendor', () => {
    it('grants access when admin', async () => {
      authenticateAs();
      const grant = { id: 'g-1', orgId: 'org-1', userId: 'user-2', vendorSlug: 'datto-rmm', grantedBy: 'user-1', grantedAt: new Date().toISOString() };
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        grantServerAccess: vi.fn().mockResolvedValue(grant),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'PUT', url: '/api/orgs/org-1/members/user-2/server-access/datto-rmm' });
      expect(response.statusCode).toBe(200);
      expect(orgService.grantServerAccess).toHaveBeenCalledWith('org-1', 'user-2', 'datto-rmm', 'user-1');
    });

    it('returns 403 for member', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'PUT', url: '/api/orgs/org-1/members/user-2/server-access/datto-rmm' });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when the target user is not a member of the org', async () => {
      // #78 M10 — pre-fix an admin could grant access to any userId,
      // writing server-access rows for non-members and emitting
      // misleading server_access_granted audit entries. getMembership is
      // admin for the requester (user-1) and null for the stranger.
      authenticateAs();
      const grantServerAccess = vi.fn();
      const orgService = createMockOrgService({
        getMembership: targetAwareMembership(),
        grantServerAccess,
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'PUT', url: '/api/orgs/org-1/members/stranger/server-access/datto-rmm' });
      expect(response.statusCode).toBe(404);
      expect(grantServerAccess).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/orgs/:orgId/members/:userId/server-access/:vendor', () => {
    it('revokes access when admin', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        revokeServerAccess: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'DELETE', url: '/api/orgs/org-1/members/user-2/server-access/datto-rmm' });
      expect(response.statusCode).toBe(204);
      expect(orgService.revokeServerAccess).toHaveBeenCalledWith('org-1', 'user-2', 'datto-rmm');
    });

    it('returns 404 when the target user is not a member of the org', async () => {
      // #78 M10 — same target-membership check on revoke.
      authenticateAs();
      const revokeServerAccess = vi.fn();
      const orgService = createMockOrgService({
        getMembership: targetAwareMembership(),
        revokeServerAccess,
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'DELETE', url: '/api/orgs/org-1/members/stranger/server-access/datto-rmm' });
      expect(response.statusCode).toBe(404);
      expect(revokeServerAccess).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/orgs/:orgId/members/:userId/server-access (bulk)', () => {
    it('bulk-sets access when admin', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
        bulkSetServerAccess: vi.fn().mockResolvedValue(undefined),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/orgs/org-1/members/user-2/server-access',
        payload: { vendors: ['datto-rmm', 'itglue'] },
      });
      expect(response.statusCode).toBe(200);
      expect(orgService.bulkSetServerAccess).toHaveBeenCalledWith('org-1', 'user-2', ['datto-rmm', 'itglue'], 'user-1');
    });

    it('returns 400 when vendors is not an array', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/orgs/org-1/members/user-2/server-access',
        payload: { vendors: 'datto-rmm' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when the target user is not a member of the org', async () => {
      // #78 M10 — same target-membership check on bulk-set.
      authenticateAs();
      const bulkSetServerAccess = vi.fn();
      const orgService = createMockOrgService({
        getMembership: targetAwareMembership(),
        bulkSetServerAccess,
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/orgs/org-1/members/stranger/server-access',
        payload: { vendors: ['datto-rmm'] },
      });
      expect(response.statusCode).toBe(404);
      expect(bulkSetServerAccess).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/orgs/:orgId/settings', () => {
    it('updates defaultServerAccess when owner', async () => {
      authenticateAs();
      const updatedOrg = { ...TEST_ORG, defaultServerAccess: 'all' };
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        updateOrgSettings: vi.fn().mockResolvedValue(updatedOrg),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1/settings',
        payload: { defaultServerAccess: 'all' },
      });
      expect(response.statusCode).toBe(200);
      expect(orgService.updateOrgSettings).toHaveBeenCalledWith('org-1', { defaultServerAccess: 'all' });
    });

    it('returns 400 for invalid defaultServerAccess', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1/settings',
        payload: { defaultServerAccess: 'invalid' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: adminMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/orgs/org-1/settings',
        payload: { defaultServerAccess: 'all' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/orgs/:orgId/redeem-code
  // -------------------------------------------------------------------------

  describe('POST /api/orgs/:orgId/redeem-code', () => {
    it('valid code now 409s — every org already resolves to the one plan (flat-pricing)', async () => {
      // Post-flat there are no tiers and every org is created paid-with-trial,
      // so isPaidPlan resolves any slug (incl. legacy 'free') to the one plan.
      // The alpha-invite upgrade path is obsolete: a valid code on any org
      // 409s rather than upgrading. The invalid-code (422) check still runs
      // first, so this exercises the valid-code → already-on-plan branch.
      vi.stubEnv('ALPHA_INVITE_CODES', 'CODE1,CODE2,CODE3');
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        getOrg: vi.fn().mockResolvedValue({ ...TEST_ORG, plan: 'free' }),
        updateOrgPlan: vi.fn(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: 'CODE2' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Organization is already on the plan' });
      expect(orgService.updateOrgPlan).not.toHaveBeenCalled();
    });

    it('returns 422 for invalid code', async () => {
      vi.stubEnv('ALPHA_INVITE_CODES', 'CODE1,CODE2');
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: 'WRONG' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'Invalid invite code' });
    });

    it('returns 400 when code is empty', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 409 when org already resolves to the plan', async () => {
      vi.stubEnv('ALPHA_INVITE_CODES', 'CODE1');
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        getOrg: vi.fn().mockResolvedValue({ ...TEST_ORG, plan: 'conduit' }),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: 'CODE1' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Organization is already on the plan' });
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: 'CODE1' },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
