import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import {
  requireAdminMutation,
  getOrSetCsrfToken,
  csrfHiddenInput,
} from './admin-auth.js';
import { config } from '../config.js';

const COOKIE_SECRET = randomBytes(32).toString('hex');

describe('requireAdminMutation — CSRF', () => {
  const original = {
    adminEmails: new Set(config.adminEmails),
    adminApiKey: config.adminApiKey,
  };
  let app: FastifyInstance;

  beforeEach(async () => {
    (config as { adminEmails: Set<string> }).adminEmails = new Set(['admin@example.com']);
    (config as { adminApiKey: string }).adminApiKey = 'super-secret-admin-key';

    app = Fastify({ logger: false });
    await app.register(cookie, { secret: COOKIE_SECRET });
    await app.register(formbody);

    // Mirror production: every request gets `auth0User` decorated. The test
    // helper below toggles it per-request via the `x-test-user` header.
    app.decorateRequest('auth0User', null);
    app.addHook('onRequest', async (request) => {
      const header = request.headers['x-test-user'] as string | undefined;
      if (header) {
        // Format: "<email>:<verified>"
        const [email, verified] = header.split(':');
        (request as unknown as Record<string, unknown>).auth0User = {
          sub: 'auth0|x',
          email,
          name: '',
          emailVerified: verified === 'true',
        };
      }
    });

    // Page that mints a CSRF token (simulates the GET /admin/orgs/:id page).
    app.get('/render-form', async (request, reply) => {
      const token = getOrSetCsrfToken(request, reply);
      return reply.type('text/html').send(`<form>${csrfHiddenInput(token)}</form>`);
    });

    // Mutation route gated by requireAdminMutation.
    app.post('/admin/do-thing', async (request, reply) => {
      if (!requireAdminMutation(request, reply)) return;
      return reply.send({ ok: true });
    });
  });

  afterEach(async () => {
    await app.close();
    (config as { adminEmails: Set<string> }).adminEmails = original.adminEmails;
    (config as { adminApiKey: string }).adminApiKey = original.adminApiKey;
  });

  it('Bearer requests skip CSRF', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: { authorization: 'Bearer super-secret-admin-key' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('session request without CSRF token is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: {
        'x-test-user': 'admin@example.com:true',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'amount=1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('session request with mismatched CSRF token is rejected', async () => {
    // Mint a token by hitting the form-render endpoint as the admin.
    const formRes = await app.inject({
      method: 'GET',
      url: '/render-form',
      headers: { 'x-test-user': 'admin@example.com:true' },
    });
    const setCookie = formRes.headers['set-cookie'];
    expect(setCookie).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: {
        'x-test-user': 'admin@example.com:true',
        cookie: Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie as string),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'csrf_token=wrong-token',
    });
    expect(res.statusCode).toBe(403);
  });

  it('session request with matching CSRF token is allowed', async () => {
    const formRes = await app.inject({
      method: 'GET',
      url: '/render-form',
      headers: { 'x-test-user': 'admin@example.com:true' },
    });
    const setCookie = formRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie as string);

    const tokenMatch = formRes.body.match(/value="([0-9a-f]{64})"/);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1];

    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: {
        'x-test-user': 'admin@example.com:true',
        cookie: cookieHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrf_token=${token}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('CSRF token can also come from the x-csrf-token header', async () => {
    const formRes = await app.inject({
      method: 'GET',
      url: '/render-form',
      headers: { 'x-test-user': 'admin@example.com:true' },
    });
    const setCookie = formRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie as string);
    const token = formRes.body.match(/value="([0-9a-f]{64})"/)![1];

    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: {
        'x-test-user': 'admin@example.com:true',
        cookie: cookieHeader,
        'x-csrf-token': token,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('non-admin session is rejected (auth check still runs)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/do-thing',
      headers: {
        'x-test-user': 'random@example.com:true',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'csrf_token=any',
    });
    // Hits the requireAdmin path → 401 Unauthorized JSON
    expect(res.statusCode).toBe(401);
  });
});
