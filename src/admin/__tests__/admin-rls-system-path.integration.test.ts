/**
 * Admin-console RLS regression guard — #118 follow-on.
 *
 * #118 split the DB into a request-path (NOBYPASSRLS) pool and a system-path
 * (BYPASSRLS) pool. The /admin/* console reads platform-wide cross-org data,
 * but a platform admin is not a member of the orgs they administer — so on
 * the request-path connection RLS returns only the admin's own orgs, and
 * NOTHING for an ADMIN_API_KEY caller (no session user => conduit.current_
 * user_id is '' => every RLS predicate fails). The fix wraps admin-console
 * reads in runAsSystem() so they resolve to the BYPASSRLS system pool.
 *
 * This suite is the regression guard. It runs against a real Postgres with
 * real RLS policies and the real two-role pool split — nothing is mocked.
 *
 *   (A) MECHANISM — proves the principle through the real context.ts
 *       machinery: runAsSystem() sees every org; an empty-user request-path
 *       context (the regression state) sees zero; a real-user request-path
 *       context sees only that user's org (the paired assertion that proves
 *       RLS is genuinely enforced, not silently off).
 *   (B) ROUTE — boots Fastify with the request-context plugin and the real
 *       adminMetricsRoutes, injects GET /api/admin/metrics as an ADMIN_API_KEY
 *       caller, and asserts platform-wide data comes back non-empty. If the
 *       runAsSystem wrap is removed from that handler, the API-key caller's
 *       RLS context matches nothing and active_orgs.count collapses to 0 —
 *       this test fails.
 *
 * Known limitation (see PR body): (B) covers /api/admin/metrics end-to-end;
 * the other admin handlers' wraps are verified by per-handler diff review.
 * A future edit that drops a runAsSystem wrap from a handler not covered here
 * is a residual this suite does not fully close.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';

const ADMIN_API_KEY = 'test-admin-key-rls-guard';
const REQUEST_ROLE = 'conduit_request_test';
const REQUEST_ROLE_PW = 'testpw';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

// App modules — dynamically imported in beforeAll AFTER ADMIN_API_KEY is in
// the environment, so config.ts reads the key on first load.
let initPools: typeof import('../../db/context.js').initPools;
let runAsSystem: typeof import('../../db/context.js').runAsSystem;
let runInRequestContext: typeof import('../../db/context.js').runInRequestContext;
let getSql: typeof import('../../db/context.js').getSql;
let closePools: typeof import('../../db/context.js').closePools;
let requestContextPlugin: typeof import('../../db/request-context-plugin.js').requestContextPlugin;
let adminMetricsRoutes: typeof import('../routes.js').adminMetricsRoutes;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  // --- schema: the tables fetchMetrics + the mechanism queries touch --------
  await admin`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT ''
    )`;
  await admin`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
      owner_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      vendor_slug TEXT NOT NULL, tool_name TEXT, status_code INTEGER NOT NULL,
      response_time_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await admin`
    CREATE TABLE credit_ledger (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, credits_used INTEGER NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  // --- RLS: mig-007-shaped SELECT policies keyed on conduit.current_user_id -
  // users intentionally has no RLS (mirrors production).
  for (const t of ['organizations', 'org_members', 'request_log', 'credit_ledger']) {
    await admin.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await admin.unsafe(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  }
  await admin`
    CREATE POLICY organizations_select ON organizations FOR SELECT USING (
      EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = organizations.id
                 AND m.user_id = current_setting('conduit.current_user_id', true)))`;
  await admin`
    CREATE POLICY org_members_select ON org_members FOR SELECT USING (
      org_members.user_id = current_setting('conduit.current_user_id', true))`;
  await admin`
    CREATE POLICY request_log_select ON request_log FOR SELECT USING (
      request_log.user_id = current_setting('conduit.current_user_id', true)
      OR EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = request_log.org_id
                    AND m.user_id = current_setting('conduit.current_user_id', true)))`;
  await admin`
    CREATE POLICY credit_ledger_select ON credit_ledger FOR SELECT USING (
      EXISTS (SELECT 1 FROM org_members m
               WHERE m.org_id = credit_ledger.org_id
                 AND m.user_id = current_setting('conduit.current_user_id', true)))`;

  // --- request-path role: NOBYPASSRLS, so RLS genuinely enforces -----------
  await admin.unsafe(
    `CREATE ROLE ${REQUEST_ROLE} LOGIN PASSWORD '${REQUEST_ROLE_PW}' NOBYPASSRLS`,
  );
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${REQUEST_ROLE}`);
  await admin.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${REQUEST_ROLE}`,
  );

  // --- seed: two orgs, each owner a member of their own org ----------------
  await admin`INSERT INTO users (id, email) VALUES
    ('user-a', 'a@example.com'), ('user-b', 'b@example.com')`;
  await admin`INSERT INTO organizations (id, name, plan, owner_id) VALUES
    ('org-a', 'Org A', 'pro', 'user-a'),
    ('org-b', 'Org B', 'free', 'user-b')`;
  await admin`INSERT INTO org_members (id, org_id, user_id, role) VALUES
    ('m-a', 'org-a', 'user-a', 'owner'),
    ('m-b', 'org-b', 'user-b', 'owner')`;
  // Tool calls for both orgs so the active-orgs metric picks up both.
  await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms) VALUES
    ('rl-a', 'user-a', 'org-a', 'datto-rmm', 'devices.list', 200, 120),
    ('rl-b', 'user-b', 'org-b', 'datto-rmm', 'devices.list', 200, 95)`;

  // --- pools: system = superuser (BYPASSRLS), request = NOBYPASSRLS role ----
  const requestUrl = new URL(superuserUri);
  requestUrl.username = REQUEST_ROLE;
  requestUrl.password = REQUEST_ROLE_PW;

  process.env.ADMIN_API_KEY = ADMIN_API_KEY;
  ({ initPools, runAsSystem, runInRequestContext, getSql, closePools } = await import(
    '../../db/context.js'
  ));
  ({ requestContextPlugin } = await import('../../db/request-context-plugin.js'));
  ({ adminMetricsRoutes } = await import('../routes.js'));

  initPools({ systemUrl: superuserUri, requestUrl: requestUrl.toString() });
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

/** COUNT(*) of organizations visible to the current connection/context. */
function countOrgs(): Promise<number> {
  return getSql()<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM organizations`.then(
    (rows) => rows[0].c,
  );
}

describe('(A) mechanism — runAsSystem vs request-path RLS', () => {
  it('runAsSystem() sees every org platform-wide (BYPASSRLS)', async () => {
    const count = await runAsSystem(() => countOrgs());
    expect(count).toBe(2);
  });

  it('an empty-user request-path context sees zero orgs — the #118 regression state', async () => {
    // This is what an ADMIN_API_KEY caller's context looks like: no session
    // user, conduit.current_user_id = ''. Without the runAsSystem fix the
    // admin console runs here and sees nothing.
    const count = await runInRequestContext('', () => countOrgs());
    expect(count).toBe(0);
  });

  it('a real-user request-path context sees only that user\'s org — proves RLS is genuinely on', async () => {
    // Paired assertion: if this returned 2 (or 0), RLS would not actually be
    // enforcing and the zero-result above would be a false positive.
    const count = await runInRequestContext('user-a', () => countOrgs());
    expect(count).toBe(1);
  });
});

/** A Fastify app with the request-context plugin + real adminMetricsRoutes. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth0User', null);
  await app.register(requestContextPlugin());
  await app.register(adminMetricsRoutes());
  await app.ready();
  return app;
}

describe('(B) route — GET /api/admin/metrics as an ADMIN_API_KEY caller', () => {
  it('returns platform-wide metrics — non-empty across both orgs', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/metrics',
        headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The API-key caller has no session user — without the runAsSystem wrap
      // its RLS context matches nothing and these collapse to 0.
      expect(body.active_orgs.count).toBe(2);
      expect(body.plan_distribution.length).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('rejects a caller with no admin credentials', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/metrics' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('(C) app-observability — the performance aggregation', () => {
  // Runs after (A)/(B). Replaces request_log with a controlled set so the
  // percentile / error-rate / throughput assertions are deterministic.
  beforeAll(async () => {
    await admin`TRUNCATE request_log`;
    // 10 in-window rows, all 100ms latency → p50/p95/p99 all 100 exactly.
    // 8×200, 1×503, 1×404 → 5xx rate 10%, 4xx+ rate 20% (503 counts in both).
    for (let i = 0; i < 8; i++) {
      await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
        VALUES (${'perf-ok-' + i}, 'user-a', 'org-a', 'datto-rmm', 'devices.list', 200, 100)`;
    }
    await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
      VALUES ('perf-5xx', 'user-a', 'org-a', 'datto-rmm', 'devices.list', 503, 100)`;
    await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms)
      VALUES ('perf-4xx', 'user-a', 'org-a', 'datto-rmm', 'devices.list', 404, 100)`;
    // One row OUTSIDE the 24h window — must NOT be counted.
    await admin`INSERT INTO request_log (id, user_id, org_id, vendor_slug, tool_name, status_code, response_time_ms, created_at)
      VALUES ('perf-stale', 'user-a', 'org-a', 'datto-rmm', 'devices.list', 500, 9999, NOW() - INTERVAL '48 hours')`;
  });

  it('computes latency percentiles, error rates and throughput over the window', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/metrics',
        headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const perf = res.json().performance;

      expect(perf.window_hours).toBe(24);
      // The 48h-stale row is excluded — 10 rows in window, not 11.
      expect(perf.requests).toBe(10);
      expect(perf.latency_ms).toEqual({ p50: 100, p95: 100, p99: 100 });
      expect(perf.error_rate_5xx_pct).toBe(10);
      // 503 + 404 both count as >= 400.
      expect(perf.error_rate_4xx_plus_pct).toBe(20);
      expect(perf.throughput_per_min).toBe(0.01);
    } finally {
      await app.close();
    }
  });

  it('reports zeros for an empty window rather than nulls', async () => {
    await admin`TRUNCATE request_log`;
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/metrics',
        headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      const perf = res.json().performance;
      expect(perf.requests).toBe(0);
      expect(perf.latency_ms).toEqual({ p50: 0, p95: 0, p99: 0 });
      expect(perf.error_rate_5xx_pct).toBe(0);
      expect(perf.throughput_per_min).toBe(0);
    } finally {
      await app.close();
    }
  });
});
