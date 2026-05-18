/**
 * GAP-5 credit-pack purchase — the real money-path guard.
 *
 * The 5-area found that CreditService.addBlock's `ON CONFLICT
 * (stripe_payment_intent_id) DO NOTHING` did not match migration 017's
 * PARTIAL unique index (`WHERE stripe_payment_intent_id IS NOT NULL`).
 * Postgres only infers a partial index as the ON CONFLICT arbiter when the
 * statement repeats the predicate — so the bare clause raised "no unique or
 * exclusion constraint matching the ON CONFLICT specification". addBlock had
 * no production caller before #158, so the first real credit-pack purchase
 * would have thrown → webhook 500 → no credit block → paying customer never
 * credited. The fix repeats the predicate.
 *
 * Every other test layer misses this — checkout.test.ts mocks Stripe,
 * stripe-webhook.test.ts mocks CreditService, the webhook-context integration
 * test stubs addBlock. This test executes the REAL addBlock SQL against a
 * REAL Postgres, and it builds credit_blocks from migration 017's actual DDL
 * — including the PARTIAL index — so the bug surface cannot drift away.
 *
 * Verified fail-on-regression: revert addBlock's ON CONFLICT predicate and
 * this goes red (addBlock throws → webhook 500 → no row); with the predicate
 * it is green and the redelivery is a clean idempotent 200 no-op.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockConstructEvent = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
  })),
}));

const REPO_ROOT = join(__dirname, '..', '..', '..');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let systemPool: typeof import('../../db/context.js').systemPool;
let closePools: typeof import('../../db/context.js').closePools;
let stripeWebhookRoutes: typeof import('../stripe-webhook.js').stripeWebhookRoutes;
let OrgService: typeof import('../../org/org-service.js').OrgService;
let CreditService: typeof import('../credit-service.js').CreditService;

/** Slice the credit_blocks DDL (table + both indexes) out of migration 017,
 *  so the test's bug surface — the PARTIAL unique index — is the real one. */
function creditBlocksDdlFromMigration017(): string {
  const sql = readFileSync(
    join(REPO_ROOT, 'migrations', '017_mcp_gateway_parity.sql'),
    'utf8',
  );
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS credit_blocks');
  const marker = 'WHERE stripe_payment_intent_id IS NOT NULL;';
  const end = sql.indexOf(marker, start) + marker.length;
  if (start < 0 || end < marker.length) {
    throw new Error('could not locate the credit_blocks DDL block in migration 017');
  }
  return sql.slice(start, end);
}

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
  // credit_blocks — verbatim from migration 017, partial unique index and all.
  await admin.unsafe(creditBlocksDdlFromMigration017());

  await admin`INSERT INTO users (id, email) VALUES ('owner-1', 'owner@acme.com')`;
  await admin`INSERT INTO organizations (id, name, owner_id, plan)
    VALUES ('org-1', 'Acme', 'owner-1', 'pro')`;

  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  ({ initPools, systemPool, closePools } = await import('../../db/context.js'));
  ({ stripeWebhookRoutes } = await import('../stripe-webhook.js'));
  ({ OrgService } = await import('../../org/org-service.js'));
  ({ CreditService } = await import('../credit-service.js'));

  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // billingGate is unused by addBlock — a stub keeps the focus on the SQL.
  const creditService = new CreditService({} as never);
  await app.register(stripeWebhookRoutes(new OrgService(), creditService, systemPool()));
  await app.ready();
  return app;
}

/** A mode:payment checkout.session.completed for a 2500-credit pack. */
function creditPackEvent() {
  return {
    id: 'evt_credits',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_credits',
        mode: 'payment',
        payment_intent: 'pi_pack_1',
        metadata: { org_id: 'org-1', credits: '2500' },
      },
    },
  };
}

async function fireWebhook(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/stripe',
    headers: { 'stripe-signature': 'test-sig', 'content-type': 'application/json' },
    payload: Buffer.from('{}'),
  });
}

function countBlocks(): Promise<number> {
  return admin<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM credit_blocks WHERE org_id = 'org-1'
  `.then((r) => r[0].c);
}

describe('GAP-5 — credit-pack purchase money path', () => {
  it('a mode:payment checkout.session.completed lands a credit block', async () => {
    // The regression: with addBlock's ON CONFLICT predicate missing, this
    // INSERT throws against the partial index → the webhook 500s → no row.
    mockConstructEvent.mockReturnValue(creditPackEvent());
    const app = await buildApp();
    try {
      const res = await fireWebhook(app);
      expect(res.statusCode).toBe(200);

      const rows = await admin<{ credits: number; remaining: number }[]>`
        SELECT credits, remaining FROM credit_blocks WHERE org_id = 'org-1'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ credits: 2500, remaining: 2500 });
    } finally {
      await app.close();
    }
  });

  it('a redelivered event with the same payment_intent does not double-credit', async () => {
    // Stripe delivers at-least-once. The redelivery must be a clean 200
    // idempotent no-op — count stays 1, not a 500, not a second block.
    expect(await countBlocks()).toBe(1);

    mockConstructEvent.mockReturnValue(creditPackEvent());
    const app = await buildApp();
    try {
      const res = await fireWebhook(app);
      expect(res.statusCode).toBe(200);
      expect(await countBlocks()).toBe(1);
    } finally {
      await app.close();
    }
  });
});
