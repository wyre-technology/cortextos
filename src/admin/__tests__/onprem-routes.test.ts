/**
 * Auth-gated tests for POST /admin/onprem/enrollment-token (PR #3 §4 step 3).
 *
 * Per boss option-a fold + warden's "admin_audit_log entry on every mint
 * (operator-only-audit pattern, NOT request_log)" pin: this suite proves
 * the endpoint is admin-gated (non-admin → 403; admin → 201 + valid token).
 *
 * The audit-log INSERT path is fire-and-forget with `.catch(log.warn)` so
 * a missing DB context (as in this unit suite) does not fail the mint —
 * the row missing surfaces in audit completeness checks separately. The
 * DB-side INSERT is verified in the analog-to-T2 launch-readiness step
 * (real deploy + real DB) rather than mocked here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as jose from 'jose';

const ADMIN_API_KEY = 'test-admin-key-onprem-routes';
// JWT_SECRET must be 64 hex chars per config.ts validation.
const JWT_SECRET = 'a'.repeat(64);

let app: FastifyInstance;

beforeAll(async () => {
  process.env.ADMIN_API_KEY = ADMIN_API_KEY;
  process.env.JWT_SECRET = JWT_SECRET;
  // BASE_URL is read by enrollment-token.ts for the iss claim.
  process.env.BASE_URL = 'https://conduit.wyre.ai';

  // Dynamic import AFTER env is set so config.ts picks it up.
  const { onpremAdminRoutes } = await import('../onprem-routes.js');

  app = Fastify({ logger: false });
  await app.register(onpremAdminRoutes());
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('POST /admin/onprem/enrollment-token — auth-gated', () => {
  it('rejects unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      payload: { subtenantId: 'org-test', capabilities: ['echo'] },
    });
    // requireAdmin sends 401 for missing bearer.
    expect([401, 403]).toContain(res.statusCode);
  });

  it('rejects wrong-bearer request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: 'Bearer not-the-admin-key' },
      payload: { subtenantId: 'org-test', capabilities: ['echo'] },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('admin POST with valid body → 201 + signed token + claims match request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-customer-1', capabilities: ['echo'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; expiresAt: string; capabilities: string[] };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // JWT shape
    expect(body.capabilities).toEqual(['echo']);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Verify the token actually claims what the request asked for.
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(body.token, secret, {
      issuer: 'https://conduit.wyre.ai',
      audience: 'onprem-tunnel-enrollment',
    });
    expect(payload.subtenantId).toBe('org-customer-1');
    expect(payload.capabilities).toEqual(['echo']);
  });

  it('admin POST with multi-capability body → 201 + claims carry all caps', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-2', capabilities: ['echo', 'datto-rmm', 'autotask'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; capabilities: string[] };
    expect(body.capabilities).toEqual(['echo', 'datto-rmm', 'autotask']);

    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jose.jwtVerify(body.token, secret, {
      issuer: 'https://conduit.wyre.ai',
      audience: 'onprem-tunnel-enrollment',
    });
    expect(payload.capabilities).toEqual(['echo', 'datto-rmm', 'autotask']);
  });

  it('admin POST honors ttlSeconds when provided', async () => {
    const ttl = 600;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-3', capabilities: ['echo'], ttlSeconds: ttl },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; expiresAt: string };
    // expiresAt should be ~ttl seconds in future (allow 5s skew for test exec).
    const expiresAtMs = new Date(body.expiresAt).getTime();
    const expectedMin = Date.now() + (ttl - 5) * 1000;
    const expectedMax = Date.now() + (ttl + 5) * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAtMs).toBeLessThanOrEqual(expectedMax);
  });
});

describe('POST /admin/onprem/enrollment-token — body validation (fail-loud-with-named-actionable-choice)', () => {
  it('admin POST missing subtenantId → 400 + names what is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { capabilities: ['echo'] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/subtenantId.*required/);
  });

  it('admin POST missing capabilities → 400 + names what is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-x' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/capabilities.*required/);
  });

  it('admin POST capabilities containing empty string → 400 + names what is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-x', capabilities: ['echo', ''] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/non-empty/);
  });

  it('admin POST ttlSeconds > MAX → 400 + names mTLS-supersedes-JWT guardrail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-x', capabilities: ['echo'], ttlSeconds: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/mTLS.*supersedes/);
  });

  it('admin POST ttlSeconds = 0 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/onprem/enrollment-token',
      headers: { authorization: `Bearer ${ADMIN_API_KEY}` },
      payload: { subtenantId: 'org-x', capabilities: ['echo'], ttlSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});
