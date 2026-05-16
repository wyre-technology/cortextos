import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { OrgService } from '../org/org-service.js';
import type postgres from 'postgres';

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

// Stub sql for webhook tests that exercise no DB path (signature / plan
// upserts go through the orgService mock; only dunning paths touch sql).
function createStubSql(): postgres.Sql {
  return vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;
}

async function buildApp(orgService: OrgService): Promise<FastifyInstance> {
  vi.resetModules();
  stubStripeEnv();

  const { stripeWebhookRoutes } = await import('./stripe-webhook.js');
  const app = Fastify({ logger: false });
  await app.register(stripeWebhookRoutes(orgService, createStubSql()));
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
    await app.register(stripeWebhookRoutes(orgService, createStubSql()));

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
    await app.register(stripeWebhookRoutes(orgService, createStubSql()));

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
    (orgService.getOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'org_abc',
      name: 'Test Org',
      plan: 'free',
      stripeCustomerId: null,
    });

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

  it('skips upgrade when checkout.session.completed org is not found', async () => {
    const orgService = createMockOrgService();
    (orgService.getOrg as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    mockConstructEvent.mockReturnValue({
      id: 'evt_no_org',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session',
          customer: 'cus_test_customer',
          subscription: 'sub_test_subscription',
          metadata: { org_id: 'org_ghost' },
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

  it('refuses plan update when checkout.session customer != org customer and fires anomaly alert', async () => {
    // Stub the webhook URL so the notifier actually invokes fetch.
    vi.stubEnv('SLACK_SALES_WEBHOOK_URL', 'https://hooks.slack.test/services/billing');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    const orgService = createMockOrgService();
    (orgService.getOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'org_billy',
      name: "Billy's Org",
      plan: 'pro',
      stripeCustomerId: 'cus_original',
    });

    mockConstructEvent.mockReturnValue({
      id: 'evt_mismatch',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_dup_customer',
          // Stripe minted a duplicate customer; doesn't match the org.
          customer: 'cus_duplicate',
          subscription: 'sub_new',
          metadata: { org_id: 'org_billy' },
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
    // Plan must NOT be updated when customer IDs don't match.
    expect(orgService.updateOrgPlan).not.toHaveBeenCalled();

    // Anomaly notifier is fire-and-forget — give the microtask a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hooks.slack.test/services/billing',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
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
    (orgService.getOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'org_fail',
      name: 'Fail Org',
      plan: 'free',
      stripeCustomerId: null,
    });
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

  // -------------------------------------------------------------------------
  // Track C — reseller-channel invoice routing
  // -------------------------------------------------------------------------

  // postgres.js returns a query result that is an array with a `.count`
  // property. The Track C handlers read `.count` to rowCount-gate; the
  // mock must carry it.
  function createCountingSql(count: number): postgres.Sql {
    const result = Object.assign([], { count });
    return vi.fn().mockResolvedValue(result) as unknown as postgres.Sql;
  }

  async function buildAppWithSql(orgService: OrgService, sql: postgres.Sql): Promise<FastifyInstance> {
    vi.resetModules();
    stubStripeEnv();
    const { stripeWebhookRoutes } = await import('./stripe-webhook.js');
    const app = Fastify({ logger: false });
    await app.register(stripeWebhookRoutes(orgService, sql));
    return app;
  }

  it('routes invoice.payment_succeeded WITH reseller_invoice_id to Track C → marks paid, 200', async () => {
    const orgService = createMockOrgService();
    const sql = createCountingSql(1);
    mockConstructEvent.mockReturnValue({
      id: 'evt_rc_paid',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_x', metadata: { reseller_invoice_id: 'inv-rc-1' } } },
    });
    const app = await buildAppWithSql(orgService, sql);

    const response = await app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid_sig' },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    // Track C path ran the reseller_invoices UPDATE; Track A subscription
    // path was not taken (no orgService call).
    expect(sql).toHaveBeenCalled();
    await app.close();
  });

  it('routes invoice.payment_failed WITH reseller_invoice_id to Track C → marks past_due, 200', async () => {
    const orgService = createMockOrgService();
    const sql = createCountingSql(1);
    mockConstructEvent.mockReturnValue({
      id: 'evt_rc_failed',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_x', metadata: { reseller_invoice_id: 'inv-rc-2' } } },
    });
    const app = await buildAppWithSql(orgService, sql);

    const response = await app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid_sig' },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
    expect(sql).toHaveBeenCalled();
    await app.close();
  });

  it('200-acks (not 500) when reseller_invoice_id matches no row — permanent failure, retry cannot help', async () => {
    const orgService = createMockOrgService();
    const sql = createStubSql(); // zero rows matched
    mockConstructEvent.mockReturnValue({
      id: 'evt_rc_orphan',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_x', metadata: { reseller_invoice_id: 'inv-nonexistent' } } },
    });
    const app = await buildAppWithSql(orgService, sql);

    const response = await app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid_sig' },
      payload: Buffer.from('{}'),
    });

    // Unresolvable event is 200-acked, not 500 — a 500 would trigger a
    // Stripe exponential-retry storm on a permanently-unresolvable event.
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('invoice.payment_succeeded WITHOUT reseller_invoice_id stays on the Track A path', async () => {
    const orgService = createMockOrgService();
    // Track A path: no reseller metadata → subscription-recovery logic.
    // subRaw is absent → the Track A handler breaks early; no Track C UPDATE.
    const sql = createStubSql();
    mockConstructEvent.mockReturnValue({
      id: 'evt_ta',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_x', metadata: {} } },
    });
    const app = await buildAppWithSql(orgService, sql);

    const response = await app.inject({
      method: 'POST', url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid_sig' },
      payload: Buffer.from('{}'),
    });

    expect(response.statusCode).toBe(200);
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
