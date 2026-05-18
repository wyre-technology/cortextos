import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org/org-service.js';

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

const mockCheckoutCreate = vi.fn();
const mockPortalCreate = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: {
        sessions: { create: mockCheckoutCreate },
      },
      billingPortal: {
        sessions: { create: mockPortalCreate },
      },
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock requireAuth0
// ---------------------------------------------------------------------------

const mockRequireAuth0 = vi.fn();

vi.mock('../auth/auth0.js', () => ({
  requireAuth0: (...args: unknown[]) => mockRequireAuth0(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = randomBytes(32).toString('hex');
const JWT_SECRET = randomBytes(32).toString('hex');

function stubStripeEnv(): void {
  vi.stubEnv('MASTER_KEY', MASTER_KEY);
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_key');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test_fake_secret');
  vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_test_pro');
  // Credit-pack price IDs (GAP-5). 1000 is intentionally left UNSET so a test
  // can exercise the valid-size-but-unconfigured 500 path.
  vi.stubEnv('STRIPE_CREDITS_2500_PRICE_ID', 'price_credits_2500');
  vi.stubEnv('STRIPE_CREDITS_5000_PRICE_ID', 'price_credits_5000');
}

function createMockOrgService(overrides: Partial<OrgService> = {}): OrgService {
  return {
    updateOrgPlan: vi.fn().mockResolvedValue(undefined),
    getOrg: vi.fn().mockResolvedValue(null),
    getMembership: vi.fn().mockResolvedValue(null),
    createOrg: vi.fn(),
    getUserOrgs: vi.fn(),
    updateOrg: vi.fn(),
    deleteOrg: vi.fn(),
    getMembers: vi.fn(),
    removeMember: vi.fn(),
    createInvitation: vi.fn(),
    getInvitationByToken: vi.fn(),
    acceptInvitation: vi.fn(),
    listInvitations: vi.fn(),
    revokeInvitation: vi.fn(),
    initTables: vi.fn(),
    logRequest: vi.fn(),
    ...overrides,
  } as unknown as OrgService;
}

async function buildApp(orgService: OrgService): Promise<FastifyInstance> {
  vi.resetModules();
  stubStripeEnv();

  // Re-import after resetting modules so the fresh config picks up env stubs
  const { billingRoutes } = await import('./checkout.js');
  const app = Fastify({ logger: false });
  await app.register(billingRoutes(orgService));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('billingRoutes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockRequireAuth0.mockReset();
    mockCheckoutCreate.mockReset();
    mockPortalCreate.mockReset();
  });

  // -------------------------------------------------------------------------
  // Skipped registration when Stripe config is missing
  // -------------------------------------------------------------------------

  it('skips registration when STRIPE_SECRET_KEY is missing', async () => {
    vi.stubEnv('MASTER_KEY', MASTER_KEY);
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_test');

    const { billingRoutes } = await import('./checkout.js');
    const orgService = createMockOrgService();
    const app = Fastify({ logger: false });
    await app.register(billingRoutes(orgService));

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_123' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('skips registration when STRIPE_PRO_PRICE_ID is missing', async () => {
    vi.stubEnv('MASTER_KEY', MASTER_KEY);
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_key');
    vi.stubEnv('STRIPE_PRO_PRICE_ID', '');

    const { billingRoutes } = await import('./checkout.js');
    const orgService = createMockOrgService();
    const app = Fastify({ logger: false });
    await app.register(billingRoutes(orgService));

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_123' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout requires auth
  // -------------------------------------------------------------------------

  it('redirects to login when user is not authenticated', async () => {
    // requireAuth0 returns null and sends a redirect
    mockRequireAuth0.mockImplementation((_request: unknown, reply: { redirect: (url: string, code: number) => void }) => {
      reply.redirect('/auth/login?return_to=%2Fapi%2Fbilling%2Fcheckout', 302);
      return null;
    });

    const orgService = createMockOrgService();
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_123' },
    });

    expect(response.statusCode).toBe(302);
    expect(mockRequireAuth0).toHaveBeenCalled();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout requires org_id
  // -------------------------------------------------------------------------

  it('returns 400 when org_id is missing from request body', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_abc',
      email: 'user@example.com',
      name: 'Test User',
    });

    const orgService = createMockOrgService();
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'org_id is required' });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout rejects non-owner
  // -------------------------------------------------------------------------

  it('returns 403 when user is not the org owner', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_member',
      email: 'member@example.com',
      name: 'Member User',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_123',
        orgId: 'org_123',
        userId: 'auth0|user_member',
        role: 'member',
        joinedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_123' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Only the org owner can manage billing' });
    await app.close();
  });

  it('returns 403 when user has no membership at all', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|stranger',
      email: 'stranger@example.com',
      name: 'Stranger',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue(null),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_123' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Only the org owner can manage billing' });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout returns 404 for missing org
  // -------------------------------------------------------------------------

  it('returns 404 when organization does not exist', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_owner',
      email: 'owner@example.com',
      name: 'Owner',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_owner',
        orgId: 'org_ghost',
        userId: 'auth0|user_owner',
        role: 'owner',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
      getOrg: vi.fn().mockResolvedValue(null),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_ghost' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Organization not found' });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout creates a checkout session
  // -------------------------------------------------------------------------

  it('creates a Stripe checkout session for a free-plan org', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_owner',
      email: 'owner@example.com',
      name: 'Owner',
    });

    mockCheckoutCreate.mockResolvedValue({
      url: 'https://checkout.stripe.com/session_123',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_owner',
        orgId: 'org_free',
        userId: 'auth0|user_owner',
        role: 'owner',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
      getOrg: vi.fn().mockResolvedValue({
        id: 'org_free',
        name: 'Free Org',
        ownerId: 'auth0|user_owner',
        plan: 'free',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_free' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://checkout.stripe.com/session_123' });
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        metadata: { org_id: 'org_free' },
        customer_email: 'owner@example.com',
      }),
    );
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout redirects pro orgs to portal
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout reuses Stripe customer on resub
  // -------------------------------------------------------------------------

  it('reuses existing Stripe customer on resub (org on free with stripeCustomerId)', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_owner',
      email: 'owner@example.com',
      name: 'Owner',
    });

    mockCheckoutCreate.mockResolvedValue({
      url: 'https://checkout.stripe.com/resub_session',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_owner',
        orgId: 'org_resub',
        userId: 'auth0|user_owner',
        role: 'owner',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
      getOrg: vi.fn().mockResolvedValue({
        id: 'org_resub',
        name: 'Resub Org',
        ownerId: 'auth0|user_owner',
        plan: 'free',
        // Cancelled before — customer ID lingers from the prior sub.
        stripeCustomerId: 'cus_existing',
        stripeSubscriptionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_resub' },
    });

    expect(response.statusCode).toBe(200);
    // Stripe rejects passing both `customer` and `customer_email` — when
    // we have a stripeCustomerId we must pass `customer` and omit the email.
    const callArg = mockCheckoutCreate.mock.calls[0][0];
    expect(callArg.customer).toBe('cus_existing');
    expect(callArg.customer_email).toBeUndefined();
    await app.close();
  });

  it('redirects to Stripe portal when org is already on pro plan', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|user_owner',
      email: 'owner@example.com',
      name: 'Owner',
    });

    mockPortalCreate.mockResolvedValue({
      url: 'https://billing.stripe.com/portal_session',
    });

    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_owner',
        orgId: 'org_pro',
        userId: 'auth0|user_owner',
        role: 'owner',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
      getOrg: vi.fn().mockResolvedValue({
        id: 'org_pro',
        name: 'Pro Org',
        ownerId: 'auth0|user_owner',
        plan: 'pro',
        stripeCustomerId: 'cus_existing',
        stripeSubscriptionId: 'sub_existing',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      payload: { org_id: 'org_pro' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://billing.stripe.com/portal_session' });
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
      }),
    );
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /api/billing/checkout-credits — one-off credit-pack purchase (GAP-5)
  // -------------------------------------------------------------------------

  function ownerOrg() {
    return createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_owner',
        orgId: 'org_1',
        userId: 'auth0|owner',
        role: 'owner',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
      getOrg: vi.fn().mockResolvedValue({
        id: 'org_1',
        name: 'Org One',
        ownerId: 'auth0|owner',
        plan: 'free',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
  }

  it('writes metadata.credits matching the selected pack and uses mode:payment', async () => {
    // The create-side lock (boss guardrail #2): the route must put `credits`
    // in the Checkout metadata, matching the pack whose price ID it selects.
    // This is what keeps the route and the webhook in sync without a
    // line-item reverse-map.
    //
    // The lock only holds if the EXPECTED price is derived from the SAME
    // CREDIT_PACKS object the route reads — not a hardcoded mirror. PACK is
    // the single source: the route looks up CREDIT_PACKS[PACK] for the price
    // and writes PACK to metadata; the assertions read CREDIT_PACKS[PACK] and
    // PACK. A typo in the map (wrong price ID on a pack) fails this test.
    const PACK = 2500;
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|owner',
      email: 'owner@example.com',
      name: 'Owner',
    });
    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/credits' });
    const app = await buildApp(ownerOrg());
    // Imported AFTER buildApp's resetModules + env stubs, so CREDIT_PACKS is
    // built from the same config the route's module instance read.
    const { CREDIT_PACKS } = await import('./checkout.js');

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout-credits',
      payload: { org_id: 'org_1', credits: PACK },
    });

    expect(response.statusCode).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: CREDIT_PACKS[PACK], quantity: 1 }],
        metadata: { org_id: 'org_1', credits: String(PACK) },
      }),
    );
    await app.close();
  });

  it('rejects an invalid pack size with 400', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|owner',
      email: 'owner@example.com',
      name: 'Owner',
    });
    const app = await buildApp(ownerOrg());

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout-credits',
      payload: { org_id: 'org_1', credits: 999 },
    });

    expect(response.statusCode).toBe(400);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 500 for a valid pack size whose price ID is unconfigured', async () => {
    // 1000 is deliberately not stubbed — valid size, missing config.
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|owner',
      email: 'owner@example.com',
      name: 'Owner',
    });
    const app = await buildApp(ownerOrg());

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout-credits',
      payload: { org_id: 'org_1', credits: 1000 },
    });

    expect(response.statusCode).toBe(500);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 403 when the caller is not the org owner', async () => {
    mockRequireAuth0.mockReturnValue({
      sub: 'auth0|member',
      email: 'member@example.com',
      name: 'Member',
    });
    const orgService = createMockOrgService({
      getMembership: vi.fn().mockResolvedValue({
        id: 'mem_m',
        orgId: 'org_1',
        userId: 'auth0|member',
        role: 'member',
        joinedAt: null,
        createdAt: new Date().toISOString(),
      }),
    });
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/checkout-credits',
      payload: { org_id: 'org_1', credits: 2500 },
    });

    expect(response.statusCode).toBe(403);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
    await app.close();
  });
});
