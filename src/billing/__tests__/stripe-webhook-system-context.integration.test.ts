/**
 * Stripe webhook system-context regression guard — the #118-introduced bug.
 *
 * PR #118 (two-connection-class RLS) made getSql() require an explicit DB
 * context. The /api/webhooks/stripe route is exempt from the request-context
 * plugin, so it has none — and stripe-webhook.ts was never wrapped in
 * runAsSystem. Every orgService.* call in the handler is getSql()-based, so
 * checkout.session.completed → orgService.getOrg threw "getSql() called with
 * no DB context" and the subscription-upgrade webhook silently 500'd: a
 * paying customer who upgraded never got upgraded.
 *
 * stripe-webhook.test.ts could not catch this — it mocks orgService entirely,
 * so the getSql path is never exercised. This test does NOT mock orgService:
 * it boots the real webhook handler + a real OrgService against a real
 * Postgres, fires a real checkout.session.completed event, and asserts the
 * org's plan actually flips to 'pro' in the database.
 *
 * Verified fail-on-regression: with the runAsSystem wrap removed from
 * stripe-webhook.ts the handler 500s and the org stays 'free' — this test
 * goes red. With the wrap it passes. Only Stripe's signature verification is
 * stubbed (it needs real keys otherwise); the DB path is entirely real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';

// Stripe is stubbed: constructEvent returns whatever event the test queues,
// so no real signature/keys are needed. Everything else stays real.
const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
  })),
}));

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let systemPool: typeof import('../../db/context.js').systemPool;
let closePools: typeof import('../../db/context.js').closePools;
let stripeWebhookRoutes: typeof import('../stripe-webhook.js').stripeWebhookRoutes;
let OrgService: typeof import('../../org/org-service.js').OrgService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  await admin`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT, stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`INSERT INTO users (id, email) VALUES ('owner-1', 'owner@acme.com')`;
  await admin`INSERT INTO organizations (id, name, owner_id, plan)
    VALUES ('org-1', 'Acme', 'owner-1', 'free')`;

  // config.ts reads STRIPE_* on first import — set before importing the
  // webhook module, or stripeWebhookRoutes() skips registration entirely.
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  ({ initPools, systemPool, closePools } = await import('../../db/context.js'));
  ({ stripeWebhookRoutes } = await import('../stripe-webhook.js'));
  ({ OrgService } = await import('../../org/org-service.js'));

  // Both pools point at the superuser here — this test guards the DB-CONTEXT
  // wiring (does the handler run inside a context at all), not RLS.
  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // creditService is unused on the subscription path this test exercises —
  // a stub keeps the guard focused on the DB-context wiring.
  const creditStub = { addBlock: async () => undefined } as unknown as Parameters<
    typeof stripeWebhookRoutes
  >[1];
  await app.register(stripeWebhookRoutes(new OrgService(), creditStub, systemPool()));
  await app.ready();
  return app;
}

describe('stripe webhook — system-path DB context', () => {
  it('checkout.session.completed upgrades the org to pro — real getSql path', async () => {
    // The regression: without the runAsSystem wrap, orgService.getOrg inside
    // the handler throws "getSql() called with no DB context", the handler
    // 500s, and org-1 stays on 'free'.
    mockConstructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'subscription',
          customer: 'cus_acme',
          subscription: 'sub_acme',
          metadata: { org_id: 'org-1' },
        },
      },
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
        payload: Buffer.from('{}'),
      });
      expect(res.statusCode).toBe(200);

      // The load-bearing assertion: the org actually got upgraded. This is
      // only true if orgService.getOrg + updateOrgPlan ran inside a DB
      // context — i.e. the runAsSystem wrap is present.
      const rows = await admin<{ plan: string }[]>`
        SELECT plan FROM organizations WHERE id = 'org-1'
      `;
      expect(rows[0].plan).toBe('pro');
    } finally {
      await app.close();
    }
  });
});
