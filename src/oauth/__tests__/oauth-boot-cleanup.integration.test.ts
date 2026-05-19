/**
 * Boot-path / background-timer system-context guard — getSql()-no-context class.
 *
 * conduit main 171f0d49b crash-looped at boot: oauthRoutes' plugin body runs
 * `await tokenStore.cleanupExpired()` at plugin-load time, and a 5-minute
 * setInterval calls it again. cleanupExpired -> getSql() — and a boot /
 * background-timer DB call has NO request context, so getSql() throws
 * "getSql() called with no DB context". app.ready() rejected -> the revision
 * crash-looped.
 *
 * This is the SAME class as #157 (the Stripe webhook getSql()-no-context bug).
 * #157 fixed one member; cleanupExpired was a missed sibling. The fix wraps
 * every boot-path / setInterval / system-context DB call in runAsSystem().
 *
 * This suite is the class regression guard. It boots the REAL oauthRoutes
 * plugin against a REAL Postgres:
 *  - boot path: app.ready() must resolve (it rejected with the bug), and the
 *    boot cleanup must actually have deleted expired rows (proves the
 *    runAsSystem wrap established a working system context, not just that it
 *    didn't throw).
 *  - interval path: advancing fake timers past the 5-minute mark must run the
 *    cleanup again without a getSql()-no-context throw.
 *
 * Verified fail-on-regression: drop the runAsSystem wrap from
 * authorization-server.ts and app.ready() rejects -> both tests red.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import Fastify from 'fastify';

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;

let initPools: typeof import('../../db/context.js').initPools;
let runAsSystem: typeof import('../../db/context.js').runAsSystem;
let closePools: typeof import('../../db/context.js').closePools;
let TokenStore: typeof import('../token-store.js').TokenStore;
let oauthRoutes: typeof import('../authorization-server.js').oauthRoutes;

let tokenStore: import('../token-store.js').TokenStore;

/** Seed one already-expired auth_code (cleanupExpired must delete it). */
async function seedExpiredAuthCode(code: string): Promise<void> {
  await admin`
    INSERT INTO clients (client_id, client_name, redirect_uris)
    VALUES (${'client-' + code}, 'parity', 'http://localhost/cb')
    ON CONFLICT (client_id) DO NOTHING`;
  await admin`
    INSERT INTO auth_codes
      (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
    VALUES (${code}, ${'client-' + code}, 'u', 'http://localhost/cb', 'cc', 'S256', 'mcp',
            NOW() - INTERVAL '1 hour')`;
}

function countAuthCode(code: string): Promise<number> {
  return admin<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM auth_codes WHERE code = ${code}
  `.then((r) => r[0].c);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const superuserUri = container.getConnectionUri();
  admin = postgres(superuserUri, { max: 4, onnotice: () => undefined });

  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  ({ initPools, runAsSystem, closePools } = await import('../../db/context.js'));
  ({ TokenStore } = await import('../token-store.js'));
  ({ oauthRoutes } = await import('../authorization-server.js'));

  initPools({ systemUrl: superuserUri, requestUrl: superuserUri });

  tokenStore = new TokenStore();
  // initTables is itself a system-path boot call — wrap it the right way.
  await runAsSystem(() => tokenStore.initTables());
}, 120_000);

afterAll(async () => {
  await closePools?.();
  await admin?.end({ timeout: 5 });
  await container?.stop();
});

beforeEach(async () => {
  await admin`TRUNCATE auth_codes, refresh_tokens, oauth_sessions, clients CASCADE`;
});

describe('oauthRoutes boot-path + interval — getSql() system-context class', () => {
  it('app.ready() resolves and the boot cleanup deletes expired rows', async () => {
    // The crash-loop: pre-fix, the plugin body's `await cleanupExpired()`
    // runs at app.ready() with no DB context — getSql() throws and ready()
    // rejects. Post-fix the call is wrapped in runAsSystem().
    await seedExpiredAuthCode('boot-expired');

    const app = Fastify();
    app.register(oauthRoutes(tokenStore));
    try {
      await expect(app.ready()).resolves.toBeDefined();
      // Not just "didn't throw" — the wrap must have given cleanupExpired a
      // working system context, so the expired row is actually gone.
      expect(await countAuthCode('boot-expired')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('the real 5-minute cleanup interval fires and sweeps without a getSql()-no-context throw', async () => {
    // Drive the REAL setInterval in authorization-server.ts. Only setInterval/
    // clearInterval are faked — the postgres driver's own setTimeout-based
    // internals stay real, so DB I/O still works (faking ALL timers stalls
    // the driver). Pre-fix the interval tick's bare cleanupExpired() throws
    // getSql()-no-context on every fire; post-fix the runAsSystem wrap holds.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = Fastify();
    try {
      app.register(oauthRoutes(tokenStore));
      await app.ready();

      // Seed AFTER boot so only the interval tick — not the boot call — can
      // sweep it.
      await seedExpiredAuthCode('interval-expired');
      expect(await countAuthCode('interval-expired')).toBe(1);

      // Fire the interval; the tick is fire-and-forget, so give its detached
      // runAsSystem(cleanupExpired) promise real time to settle.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(await countAuthCode('interval-expired')).toBe(0);
      }, { timeout: 10_000, interval: 200 });
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
