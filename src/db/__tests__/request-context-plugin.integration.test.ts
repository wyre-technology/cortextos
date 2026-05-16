/**
 * request-context plugin — settle-matrix integration test.
 *
 * The plugin opens a request-path transaction per non-exempt request and must
 * settle it on every exit path. This test drives a real Postgres connection
 * (the plugin reserves a pooled connection + opens a transaction — a mock
 * cannot exercise that) and asserts, for each settle path, whether a write
 * made inside the request transaction is visible afterwards:
 *
 *   - <500 response   -> COMMIT  (write persists)
 *   - 5xx response    -> ROLLBACK (write gone)
 *   - handler throws  -> ROLLBACK via onError (write gone)
 *   - client aborts   -> ROLLBACK via the raw-socket 'close' backstop
 *   - settle-once     -> a second closeRequestContext() is an idempotent no-op
 *
 * onTimeout is not exercised with a literal slow-handler timeout (flaky to
 * time): its hook calls the same closeRequestContext(handle, 'rollback') path
 * the onError test covers, and the settle-once test proves a redundant settle
 * is safe — so the onTimeout wiring is covered by construction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  initPools,
  closePools,
  getSql,
  systemPool,
  openRequestContext,
  closeRequestContext,
} from '../context.js';
import { requestContextPlugin } from '../request-context-plugin.js';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const uri = container.getConnectionUri();
  // System and request pools both point at the testcontainer — this test
  // exercises transaction settle behaviour, not role-based RLS.
  initPools({ systemUrl: uri, requestUrl: uri });
  await systemPool()`CREATE TABLE ctx_probe (tag TEXT PRIMARY KEY)`;
}, 120_000);

afterAll(async () => {
  await closePools();
  await container?.stop();
});

beforeEach(async () => {
  await systemPool()`TRUNCATE ctx_probe`;
});

/** True when a row with `tag` is committed in ctx_probe (read system-path). */
async function probeHas(tag: string): Promise<boolean> {
  const rows = await systemPool()`SELECT 1 FROM ctx_probe WHERE tag = ${tag}`;
  return rows.length > 0;
}

/** A Fastify app with the request-context plugin and probe routes. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // The plugin reads request.auth0User; mirror the prod decorator.
  app.decorateRequest('auth0User', null);
  await app.register(requestContextPlugin());

  app.post('/commit', async () => {
    await getSql()`INSERT INTO ctx_probe (tag) VALUES ('commit')`;
    return { ok: true };
  });
  app.post('/rollback-5xx', async (_request, reply) => {
    await getSql()`INSERT INTO ctx_probe (tag) VALUES ('rollback-5xx')`;
    return reply.code(500).send({ error: 'deliberate' });
  });
  app.post('/throws', async () => {
    await getSql()`INSERT INTO ctx_probe (tag) VALUES ('throws')`;
    throw new Error('deliberate handler error');
  });
  app.post('/slow-abort', async () => {
    await getSql()`INSERT INTO ctx_probe (tag) VALUES ('slow-abort')`;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { ok: true };
  });

  await app.ready();
  return app;
}

describe('request-context plugin — settle matrix', () => {
  // PROPAGATION-CRITICAL — do not weaken this test.
  // It is the only case in the matrix that discriminates a working request
  // context from a broken one. The rollback / onError / raw-close cases all
  // assert the probe row is ABSENT — which is equally true if the plugin
  // never established a context at all (the handler's getSql() throws, 500s,
  // and never inserts). They pass vacuously against a dead-on-arrival plugin.
  // This COMMIT case asserts the row is PRESENT, so it fails the moment the
  // ALS context stops reaching the handler — exactly the c2 bug this test
  // first caught (enterWith() after an await). Keep it asserting row-PRESENT.
  it('COMMITs the request transaction on a <500 response', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/commit' });
      expect(res.statusCode).toBe(200);
      expect(await probeHas('commit')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('ROLLs BACK the request transaction on a 5xx response', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/rollback-5xx' });
      expect(res.statusCode).toBe(500);
      expect(await probeHas('rollback-5xx')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('ROLLs BACK when the handler throws (onError path)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/throws' });
      expect(res.statusCode).toBe(500);
      expect(await probeHas('throws')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('ROLLs BACK via the raw-socket close backstop when the client aborts mid-request', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const ctrl = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/slow-abort`, {
        method: 'POST',
        signal: ctrl.signal,
      }).catch(() => undefined); // the abort rejects the fetch — expected
      // Abort while the handler is still in its 2s sleep, after the INSERT.
      await new Promise((resolve) => setTimeout(resolve, 300));
      ctrl.abort();
      await pending;
      // Give the raw 'close' backstop a beat to settle the transaction.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await probeHas('slow-abort')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('closeRequestContext is idempotent — the settle-once guard', async () => {
    const handle = await openRequestContext('');
    await closeRequestContext(handle, 'commit');
    expect(handle.settled).toBe(true);
    // A second settle (the plugin can call this from both onResponse and the
    // raw-close backstop) must be a no-op — not a double COMMIT, not a
    // release of an already-released connection.
    await expect(closeRequestContext(handle, 'rollback')).resolves.toBeUndefined();
    expect(handle.settled).toBe(true);
  });
});
