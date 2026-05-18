/**
 * #78 C3 — admin-consent endpoint hardening, real-Postgres guard.
 *
 * Two bugs in the Azure AD admin-consent onboarding flow:
 *
 *  (1) GET /auth/admin-consent — the initiator — was UNAUTHENTICATED. It
 *      mints the `state` the callback later trusts, and 302-redirects to
 *      login.microsoftonline.com. An unauthenticated visitor could use it
 *      as a phishing pivot with attacker-controlled state. Fix: requireAdmin.
 *
 *  (2) GET /auth/admin-consent/callback — its upsert did
 *      `ON CONFLICT (tenant_id) DO UPDATE SET customer_name = EXCLUDED...`.
 *      Combined with (1), an unauthenticated caller could flip the display
 *      name of ANY already-onboarded tenant by replaying the flow with a
 *      crafted customer_name. Fix: the callback re-activates a tenant but no
 *      longer overwrites customer_name.
 *
 * The callback runs a real INSERT ... ON CONFLICT, so this guard exercises
 * it against a real Postgres — a mock would not prove the ON CONFLICT
 * branch leaves customer_name intact.
 *
 * Verified fail-on-regression: drop requireAdmin from the initiator and the
 * 401 test goes red (302 to Microsoft); restore `customer_name = EXCLUDED.
 * customer_name` and the no-overwrite test goes red.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';

const ADMIN_API_KEY = 'test-admin-key-consent-guard';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let closePools: typeof import('../../db/context.js').closePools;
let adminConsentPlugin: typeof import('../admin-consent.js').adminConsentPlugin;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // config.ts reads these on first import — set before the dynamic import.
  // azureClientId must be truthy or adminConsentPlugin short-circuits.
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;
  process.env.AZURE_AD_CLIENT_ID = 'test-azure-client-id';

  ({ initPools, closePools } = await import('../../db/context.js'));
  ({ adminConsentPlugin } = await import('../admin-consent.js'));

  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  // The plugin CREATE TABLE IF NOT EXISTS-es customer_tenants on register;
  // truncate per test so row assertions are independent.
  await admin`
    CREATE TABLE IF NOT EXISTS customer_tenants (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      onboarded_at  TIMESTAMPTZ DEFAULT NOW(),
      active        BOOLEAN DEFAULT true
    )`;
  await admin`TRUNCATE customer_tenants`;
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth0User', null);
  await app.register(adminConsentPlugin());
  await app.ready();
  return app;
}

/** Build the callback `state` the initiator would have minted. */
function stateFor(customerName: string): string {
  return `00000000-0000-0000-0000-000000000000:${Buffer.from(customerName).toString('base64')}`;
}

describe('#78 C3 — admin-consent initiator is admin-gated', () => {
  it('GET /auth/admin-consent without admin creds is 401 — not a redirect to Microsoft', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/auth/admin-consent?customer_name=Acme' });
      // The bug: an unauthenticated visitor got a 302 to login.microsoftonline.com.
      expect(res.statusCode).toBe(401);
      expect(res.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('GET /auth/admin-consent with a valid admin token redirects to Azure AD', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/admin-consent?customer_name=Acme',
        headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('login.microsoftonline.com');
    } finally {
      await app.close();
    }
  });
});

describe('#78 C3 — callback does not overwrite an existing tenant\'s customer_name', () => {
  it('re-onboarding an existing tenant re-activates it but keeps the original name', async () => {
    // A tenant onboarded earlier, then deactivated.
    await admin`
      INSERT INTO customer_tenants (tenant_id, customer_name, active)
      VALUES ('tenant-1', 'Original Co', false)`;

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/admin-consent/callback?tenant=tenant-1&state=${stateFor('Attacker Rename')}`,
      });
      expect(res.statusCode).toBe(200);

      const [row] = await admin<{ customer_name: string; active: boolean }[]>`
        SELECT customer_name, active FROM customer_tenants WHERE tenant_id = 'tenant-1'`;
      // Re-activated, but the name is NOT the attacker-supplied one.
      expect(row.customer_name).toBe('Original Co');
      expect(row.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a brand-new tenant is still inserted with its supplied customer_name', async () => {
    // Positive control: first-time onboarding must still record the name.
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/admin-consent/callback?tenant=tenant-new&state=${stateFor('Beta LLC')}`,
      });
      expect(res.statusCode).toBe(200);

      const [row] = await admin<{ customer_name: string }[]>`
        SELECT customer_name FROM customer_tenants WHERE tenant_id = 'tenant-new'`;
      expect(row.customer_name).toBe('Beta LLC');
    } finally {
      await app.close();
    }
  });
});
