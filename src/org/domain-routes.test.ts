/**
 * domain-routes HTTP tests — the route layer, where the request-/system-path
 * split can be silently wrong (analyst PR #156 5-area: a request-path getOrg
 * in claim-eligibility against RLS-scoped organizations made the endpoint
 * return eligible:false for every genuinely-eligible user).
 *
 * orgService and OrgDomainService are mocked, and db/context is stubbed so
 * runAsSystem is a pass-through — these tests exercise route logic (the
 * emailVerified gate, the requireOrgRole gate, the claim happy path), not the
 * DB. The RLS behaviour itself is covered by
 * rls-organization-domains.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OrgService } from './org-service.js';
import { OrgDomainService } from './domain-service.js';

const mockRequireAuth0 = vi.fn();
vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// runAsSystem → pass-through; getSql → a tagged-template no-op (the claim
// route's membership INSERT is the only getSql() caller here).
vi.mock('../db/context.js', () => ({
  runAsSystem: <T>(fn: () => Promise<T>) => fn(),
  getSql: () => () => Promise.resolve([]),
}));

const TEST_USER = { sub: 'user-1', email: 'sam@acme.com', name: 'Sam', emailVerified: true };

function createMockOrgService(overrides: Partial<OrgService> = {}): OrgService {
  return {
    getMembership: vi.fn().mockResolvedValue(null),
    getUserOrgs: vi.fn().mockResolvedValue([]),
    getOrg: vi.fn().mockResolvedValue(null),
    // Layer 1 seat-sync: domain auto-join calls orgService.syncSeats
    // after the membership INSERT (DOR §6 — "human added" event).
    syncSeats: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OrgService;
}

function createMockDomainService(overrides: Partial<OrgDomainService> = {}): OrgDomainService {
  return {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn(),
    verify: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
    findVerifiedByDomain: vi.fn().mockResolvedValue(null),
    findVerifiedByEmail: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as OrgDomainService;
}

async function buildApp(
  orgService: OrgService,
  domainService: OrgDomainService,
): Promise<FastifyInstance> {
  const { domainRoutes } = await import('./domain-routes.js');
  const app = Fastify({ logger: false });
  await app.register(domainRoutes({ orgService, domainService }));
  return app;
}

function authenticateAs(user: typeof TEST_USER | { sub: string; email: string; name: string; emailVerified: boolean } = TEST_USER): void {
  mockRequireAuth0.mockReturnValue(user);
}

describe('domain-routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockRequireAuth0.mockReset();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /api/me/claim-eligibility
  // -------------------------------------------------------------------------
  describe('GET /api/me/claim-eligibility', () => {
    it('returns eligible:true for a non-member whose verified domain matches a claim', async () => {
      // The regression guard for the 5-area blocking bug: getOrg runs
      // system-path, so a non-member (the only caller this endpoint serves)
      // resolves the claiming org instead of always getting no_verified_org.
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([]),
        getOrg: vi.fn().mockResolvedValue({ id: 'org-a', name: 'Acme' }),
      });
      const domainService = createMockDomainService({
        findVerifiedByDomain: vi.fn().mockResolvedValue({
          orgId: 'org-a',
          domain: 'acme.com',
          autoJoinRole: 'member',
        }),
      });
      app = await buildApp(orgService, domainService);

      const res = await app.inject({ method: 'GET', url: '/api/me/claim-eligibility' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        eligible: true,
        org: { id: 'org-a', name: 'Acme' },
        role: 'member',
        domain: 'acme.com',
      });
    });

    it('returns eligible:false email_not_verified for an unverified email', async () => {
      authenticateAs({ ...TEST_USER, emailVerified: false });
      app = await buildApp(createMockOrgService(), createMockDomainService());

      const res = await app.inject({ method: 'GET', url: '/api/me/claim-eligibility' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ eligible: false, reason: 'email_not_verified' });
    });

    it('returns eligible:false already_in_org when the user already has a membership', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([{ id: 'org-x' }]),
      });
      app = await buildApp(orgService, createMockDomainService());

      const res = await app.inject({ method: 'GET', url: '/api/me/claim-eligibility' });

      expect(res.json()).toMatchObject({ eligible: false, reason: 'already_in_org' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/me/claim
  // -------------------------------------------------------------------------
  describe('POST /api/me/claim', () => {
    it('joins the user and returns 201 on a matching verified domain', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([]),
        getOrg: vi.fn().mockResolvedValue({ id: 'org-a', name: 'Acme' }),
      });
      const domainService = createMockDomainService({
        findVerifiedByDomain: vi.fn().mockResolvedValue({
          orgId: 'org-a',
          domain: 'acme.com',
          autoJoinRole: 'member',
        }),
      });
      app = await buildApp(orgService, domainService);

      const res = await app.inject({ method: 'POST', url: '/api/me/claim' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ org: { id: 'org-a', name: 'Acme' }, role: 'member' });
    });

    it('calls orgService.syncSeats(claim.orgId) after the membership INSERT — wires the 5th seat-sync site', async () => {
      // PR #221 analyst HOLD address-the-set fix: the 5th seat-sync site
      // (domain-auto-join, out-of-class) had to inherit the log+swallow
      // contract via the public OrgService.syncSeats API boundary.
      // Disposition (β): OrgService.syncSeats is now log+swallow at the
      // API contract (see src/org/org-service.ts and the contract test
      // at org-service.test.ts: "syncer failure is swallowed by syncSeats
      // (API-boundary discipline) — DB write still wins").
      //
      // This test addresses the WIRING half: prove domain-routes actually
      // calls orgService.syncSeats with the right orgId after the
      // org_members INSERT. The contract half (syncSeats never throws,
      // even when seatSyncer does) composes structurally — every
      // external caller that calls orgService.syncSeats inherits the
      // swallow by construction. Together the two tests close the
      // address-the-set: wire-in-place HERE + swallow-on-throw THERE =
      // 5xx-free-by-composition at the 5th site.
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([]),
        getOrg: vi.fn().mockResolvedValue({ id: 'org-a', name: 'Acme' }),
      });
      const domainService = createMockDomainService({
        findVerifiedByDomain: vi.fn().mockResolvedValue({
          orgId: 'org-a',
          domain: 'acme.com',
          autoJoinRole: 'member',
        }),
      });
      app = await buildApp(orgService, domainService);

      const res = await app.inject({ method: 'POST', url: '/api/me/claim' });

      expect(res.statusCode).toBe(201);
      expect(orgService.syncSeats).toHaveBeenCalledWith('org-a');
    });

    it('returns 403 when the email is not verified — the account-takeover guard', async () => {
      authenticateAs({ ...TEST_USER, emailVerified: false });
      app = await buildApp(createMockOrgService(), createMockDomainService());

      const res = await app.inject({ method: 'POST', url: '/api/me/claim' });

      expect(res.statusCode).toBe(403);
    });

    it('returns 409 when the user already belongs to an org', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getUserOrgs: vi.fn().mockResolvedValue([{ id: 'org-x' }]),
      });
      app = await buildApp(orgService, createMockDomainService());

      const res = await app.inject({ method: 'POST', url: '/api/me/claim' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when no org has claimed the email domain', async () => {
      authenticateAs();
      app = await buildApp(createMockOrgService(), createMockDomainService());

      const res = await app.inject({ method: 'POST', url: '/api/me/claim' });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Org-admin domain management — the requireOrgRole(admin) gate
  // -------------------------------------------------------------------------
  describe('org-admin domain routes', () => {
    it('GET /api/orgs/:orgId/domains returns 403 for a non-member', async () => {
      authenticateAs();
      // getMembership → null ⇒ requireOrgRole 403.
      app = await buildApp(createMockOrgService(), createMockDomainService());

      const res = await app.inject({ method: 'GET', url: '/api/orgs/org-a/domains' });

      expect(res.statusCode).toBe(403);
    });

    it('POST /api/orgs/:orgId/domains creates a claim for an admin', async () => {
      authenticateAs();
      const orgService = createMockOrgService({
        getMembership: vi.fn().mockResolvedValue({ role: 'admin' }),
      });
      const domainService = createMockDomainService({
        add: vi.fn().mockResolvedValue({ id: 'd-1', domain: 'acme.com' }),
      });
      app = await buildApp(orgService, domainService);

      const res = await app.inject({
        method: 'POST',
        url: '/api/orgs/org-a/domains',
        payload: { domain: 'acme.com' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'd-1', domain: 'acme.com' });
    });
  });
});
