import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org/org-service.js';
import type postgres from 'postgres';

// Minimal sql tagged-template mock. Tests that exercise dunning paths
// override this per-test to assert on the UPDATE query + returned rows.
function createMockSql(): postgres.Sql {
  const sql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;
  return sql;
}

// ---------------------------------------------------------------------------
// Mock Stripe
// ---------------------------------------------------------------------------

const mockConstructEvent = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      webhooks: {
        constructEvent: mockConstructEvent,
      },
    })),
  };
});

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
  vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_test_fake');
}

function createMockOrgService(): OrgService {
  return {
    updateOrgPlan: vi.fn().mockResolvedValue(undefined),
    getOrg: vi.fn(),
    getMembership: vi.fn(),
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
  } as unknown as OrgService;
}

async function buildApp(orgService: OrgService): Promise<FastifyInstance> {
  vi.resetModules();
  stubStripeEnv();

  const { stripeWebhookRoutes } = await import('./stripe-webhook.js');
  const app = Fastify({ logger: false });
  await app.register(stripeWebhookRoutes(orgService, createMockSql()));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripeWebhookRoutes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockConstructEvent.mockReset();
  });

  // -------------------------------------------------------------------------
  // Skipped registration when Stripe config is missing
  // -------------------------------------------------------------------------

  it('skips registration when STRIPE_SECRET_KEY is missing', async () => {
    vi.stubEnv('MASTER_KEY', MASTER_KEY);
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');

    const { stripeWebhookRoutes } = await import('./stripe-webhook.js');
    const orgService = createMockOrgService();
    const app = Fastify({ logger: false });
    await app.register(stripeWebhookRoutes(orgService, createMockSql()));

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      payload: {},
    });

    // Route was never registered, so Fastify returns 404
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('skips registration when STRIPE_WEBHOOK_SECRET is missing', async () => {
    vi.stubEnv('MASTER_KEY', MASTER_KEY);
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_key');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');

    const { stripeWebhookRoutes } = await import('./stripe-webhook.js');
    const orgService = createMockOrgService();
    const app = Fastify({ logger: false });
    await app.register(stripeWebhookRoutes(orgService, createMockSql()));

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Missing stripe-signature header
  // -------------------------------------------------------------------------

  it('returns 400 when stripe-signature header is missing', async () => {
    const orgService = createMockOrgService();
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing stripe-signature header' });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Invalid signature
  // -------------------------------------------------------------------------

  it('returns 400 when Stripe signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const orgService = createMockOrgService();
    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid signature' });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // checkout.session.completed -> upgrade to pro
  // -------------------------------------------------------------------------

  it('upgrades org to pro on checkout.session.completed', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session',
          customer: 'cus_test_customer',
          subscription: 'sub_test_subscription',
          metadata: { org_id: 'org_abc' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(orgService.updateOrgPlan).toHaveBeenCalledWith(
      'org_abc',
      'pro',
      'cus_test_customer',
      'sub_test_subscription',
    );
    await app.close();
  });

  it('skips upgrade when checkout.session.completed is missing org_id metadata', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_test_no_meta',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session',
          customer: 'cus_test_customer',
          subscription: 'sub_test_subscription',
          metadata: {},
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(orgService.updateOrgPlan).not.toHaveBeenCalled();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // customer.subscription.updated -> sync plan
  // -------------------------------------------------------------------------

  it('syncs plan to pro when subscription status is active', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_id',
          customer: 'cus_test_customer',
          status: 'active',
          metadata: { org_id: 'org_xyz' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(orgService.updateOrgPlan).toHaveBeenCalledWith(
      'org_xyz',
      'pro',
      'cus_test_customer',
      'sub_test_id',
    );
    await app.close();
  });

  it('KEEPS plan=pro on past_due status (dunning grace, mig 024)', async () => {
    // Behavior change from prior version: past_due used to flip plan to free,
    // which bypassed Ruby's 7-day-grace dunning lifecycle. Now plan stays
    // 'pro' for past_due and unpaid; isServiceActive in gate.ts uses
    // (status, first_failure_at, grace) to decide whether to admit the
    // paid-gate at request time.
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_past_due',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_id',
          customer: 'cus_test_customer',
          status: 'past_due',
          metadata: { org_id: 'org_xyz' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(orgService.updateOrgPlan).toHaveBeenCalledWith(
      'org_xyz',
      'pro',
      'cus_test_customer',
      'sub_test_id',
    );
    await app.close();
  });

  it('flips plan=free on canceled status (terminal)', async () => {
    // Only canonical terminal states downgrade the plan-tier. Stripe's
    // canceled + incomplete_expired are the truly-over signals; past_due
    // and unpaid keep plan='pro' under the dunning grace.
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_canceled',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_id',
          customer: 'cus_test_customer',
          status: 'canceled',
          metadata: { org_id: 'org_xyz' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(orgService.updateOrgPlan).toHaveBeenCalledWith(
      'org_xyz',
      'free',
      'cus_test_customer',
      'sub_test_id',
    );
    await app.close();
  });

  // -------------------------------------------------------------------------
  // customer.subscription.deleted -> downgrade to free
  // -------------------------------------------------------------------------

  it('downgrades org to free on customer.subscription.deleted', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_deleted',
          customer: 'cus_test_customer',
          metadata: { org_id: 'org_deleted' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(orgService.updateOrgPlan).toHaveBeenCalledWith('org_deleted', 'free');
    await app.close();
  });

  it('skips downgrade when subscription.deleted is missing org_id metadata', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_no_meta',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_deleted',
          customer: 'cus_test_customer',
          metadata: {},
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(orgService.updateOrgPlan).not.toHaveBeenCalled();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Unhandled event type
  // -------------------------------------------------------------------------

  it('returns 500 when orgService.updateOrgPlan throws so Stripe retries', async () => {
    const orgService = createMockOrgService();
    (orgService.updateOrgPlan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection lost'));

    mockConstructEvent.mockReturnValue({
      id: 'evt_fail',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fail',
          customer: 'cus_fail',
          subscription: 'sub_fail',
          metadata: { org_id: 'org_fail' },
        },
      },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Webhook handler failed' });
    await app.close();
  });

  it('returns 200 for unhandled event types without calling orgService', async () => {
    const orgService = createMockOrgService();

    mockConstructEvent.mockReturnValue({
      id: 'evt_unknown',
      type: 'invoice.payment_succeeded',
      data: { object: {} },
    });

    const app = await buildApp(orgService);

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid_sig',
      },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(orgService.updateOrgPlan).not.toHaveBeenCalled();
    await app.close();
  });
});
