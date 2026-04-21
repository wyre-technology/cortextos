import { describe, it, expect, vi } from 'vitest';

// Auth0 env must be set before ./routes (and the transitive ../config import)
// loads, because config.ts snapshots process.env at module-eval time.
// `vi.hoisted` executes before any ESM import in this file.
vi.hoisted(() => {
  process.env.AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'test.auth0.com';
  process.env.AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || 'client_abc';
  process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
});


import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import type postgres from 'postgres';
import {
  signupRoutes,
  validateEmail,
  InMemoryRateLimiter,
  renderSignupPage,
} from './routes.js';

// ---------------------------------------------------------------------------
// postgres.js tagged-template mock — captures INSERTed intent rows.
// ---------------------------------------------------------------------------

interface MockIntent {
  id: string;
  email: string;
  funnel: string;
  ip: string | null;
  userAgent: string | null;
}

function createMockSql(): { sql: postgres.Sql; intents: MockIntent[]; insertShouldFail: { value: boolean } } {
  const intents: MockIntent[] = [];
  const insertShouldFail = { value: false };

  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('CREATE TABLE')) return Promise.resolve([]);
    if (query.includes('INSERT INTO signup_intents')) {
      if (insertShouldFail.value) return Promise.reject(new Error('insert failed'));
      const [id, email, funnel, ip, userAgent] = values as [string, string, string, string | null, string | null];
      intents.push({ id, email, funnel, ip, userAgent });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;

  return { sql, intents, insertShouldFail };
}

// ---------------------------------------------------------------------------
// Fastify harness
// ---------------------------------------------------------------------------

async function makeApp(overrides?: { limiter?: InMemoryRateLimiter }) {
  const mock = createMockSql();
  const app = Fastify();
  await app.register(formbody);
  await app.register(signupRoutes({ sql: mock.sql, limiter: overrides?.limiter }));
  await app.ready();
  return { app, mock };
}

// ---------------------------------------------------------------------------
// validateEmail
// ---------------------------------------------------------------------------

describe('validateEmail', () => {
  it('accepts a normal address', () => {
    const r = validateEmail('user@example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe('user@example.com');
  });

  it('lower-cases and trims', () => {
    const r = validateEmail('  USER@Example.COM  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe('user@example.com');
  });

  it('rejects non-string', () => {
    expect(validateEmail(42).ok).toBe(false);
    expect(validateEmail(undefined).ok).toBe(false);
    expect(validateEmail(null).ok).toBe(false);
  });

  it('rejects empty', () => {
    expect(validateEmail('').ok).toBe(false);
    expect(validateEmail('   ').ok).toBe(false);
  });

  it('rejects malformed', () => {
    expect(validateEmail('no-at-sign').ok).toBe(false);
    expect(validateEmail('two@@sign.com').ok).toBe(false);
    expect(validateEmail('trailing@').ok).toBe(false);
  });

  it('rejects absurdly long input', () => {
    expect(validateEmail('a'.repeat(300) + '@example.com').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InMemoryRateLimiter
// ---------------------------------------------------------------------------

describe('InMemoryRateLimiter', () => {
  it('allows up to max per window and then blocks', () => {
    let t = 1_000_000;
    const limiter = new InMemoryRateLimiter(3, 60_000, () => t);
    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(true);
    const blocked = limiter.check('ip1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('independently tracks different keys', () => {
    const limiter = new InMemoryRateLimiter(1, 60_000);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('resets after the window elapses', () => {
    let t = 0;
    const limiter = new InMemoryRateLimiter(1, 100, () => t);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);
    t += 200;
    expect(limiter.check('ip').allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

describe('renderSignupPage', () => {
  it('includes the headline, form, and continue button', () => {
    const html = renderSignupPage();
    expect(html).toContain('Start your Conduit trial');
    expect(html).toContain('name="email"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/signup"');
    expect(html).toContain('Continue');
  });

  it('re-surfaces the error and prior email value', () => {
    const html = renderSignupPage({ error: 'Bad email', email: 'foo@bar' });
    expect(html).toContain('Bad email');
    expect(html).toContain('value="foo@bar"');
  });

  it('escapes HTML in the error and email', () => {
    const html = renderSignupPage({ error: '<script>x</script>', email: '"><script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// Route integration
// ---------------------------------------------------------------------------

describe('GET /signup', () => {
  it('returns a 200 HTML page', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/signup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Start your Conduit trial');
  });
});

describe('POST /signup', () => {
  it('redirects to Auth0 with login_hint + state on a valid email', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: 'email=user%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers['location'];
    expect(typeof location).toBe('string');
    const url = new URL(String(location));
    // config module may cache AUTH0_DOMAIN from env at import; accept either.
    expect(url.hostname.endsWith('auth0.com')).toBe(true);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('openid');
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    // Persistence: one intent row with matching id + email
    expect(mock.intents).toHaveLength(1);
    expect(mock.intents[0]?.email).toBe('user@example.com');
    expect(mock.intents[0]?.funnel).toBe('reseller');
    expect(mock.intents[0]?.id).toBe(state);
  });

  it('rejects an invalid email with 400 and re-renders the form', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: 'email=not-an-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid email');
    expect(mock.intents).toHaveLength(0);
  });

  it('rate-limits a flooding IP to 10/hour', async () => {
    const limiter = new InMemoryRateLimiter(10, 60 * 60 * 1000);
    const { app } = await makeApp({ limiter });

    for (let i = 0; i < 10; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/signup',
        payload: `email=u${i}%40example.com`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(ok.statusCode).toBe(302);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: 'email=late%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('returns 500 + error page when the intent insert fails', async () => {
    const { app, mock } = await makeApp();
    mock.insertShouldFail.value = true;
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: 'email=u%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('Something went wrong');
  });
});
