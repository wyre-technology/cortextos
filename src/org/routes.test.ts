import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { OrgService } from './org-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { BillingGate } from '../billing/gate.js';

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
    getCreditAllocation: vi.fn().mockResolvedValue(0),
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

async function buildApp(
  orgService: OrgService,
  credentialService?: CredentialService,
  billingGate?: BillingGate,
): Promise<FastifyInstance> {
  vi.resetModules();
  vi.stubEnv('MASTER_KEY', MASTER_KEY);
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('BASE_URL', 'https://mcp.test.com');

  const { orgRoutes } = await import('./routes.js');
  const app = Fastify({ logger: false });
  await app.register(
    orgRoutes({
      orgService,
      credentialService: credentialService ?? createMockCredentialService(),
      billingGate: billingGate ?? createMockBillingGate(),
      adminAuditService: { log: vi.fn().mockResolvedValue(undefined) } as any,
      sql: {} as any,
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
      expect(orgService.createOrg).toHaveBeenCalledWith('Test Org', 'user-1', 'free');
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
      expect(response.json().error).toBe('You do not have permission to perform this action');
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
      expect(response.json().error).toBe('You do not have permission to perform this action');
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

  describe('DELETE /api/orgs/:orgId', () => {
    it('deletes org when user is owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        deleteOrg: vi.fn().mockResolvedValue(true),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'DELETE', url: '/api/orgs/org-1' });

      expect(response.statusCode).toBe(204);
      expect(orgService.deleteOrg).toHaveBeenCalledWith('org-1');
    });

    it('returns 403 for non-owner', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: memberMembership(),
      });
      app = await buildApp(orgService);

      const response = await app.inject({ method: 'DELETE', url: '/api/orgs/org-1' });

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
      expect(orgService.revokeInvitation).toHaveBeenCalledWith('inv-1');
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
      expect(orgService.acceptInvitation).toHaveBeenCalledWith('valid-token', 'user-1');
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
    it('upgrades org to pro with valid code', async () => {
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

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, plan: 'pro' });
      expect(orgService.updateOrgPlan).toHaveBeenCalledWith('org-1', 'pro');
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

    it('returns 409 when org is already pro', async () => {
      vi.stubEnv('ALPHA_INVITE_CODES', 'CODE1');
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: ownerMembership(),
        getOrg: vi.fn().mockResolvedValue({ ...TEST_ORG, plan: 'pro' }),
      });
      app = await buildApp(orgService);

      const response = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-1/redeem-code',
        payload: { code: 'CODE1' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Organization is already on a paid plan' });
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
