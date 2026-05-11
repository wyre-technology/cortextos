import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// These tests cover the /login route's single-provider-skip behavior + the
// landing page's non-customer Sign In button targeting /login (not
// /auth/login). The chooser HTML render itself is exercised in login.ts;
// here we exercise the route's decision-tree.
//
// landingRoutes + the config module it transitively imports are loaded
// per-test via dynamic import AFTER env stubs are in place, because
// config.ts evaluates env vars at module-import time.

async function buildApp(): Promise<FastifyInstance> {
  const { landingRoutes } = await import('./index.js');
  const app = Fastify();
  // Stub auth0User so the landing route's "redirect to /settings if logged
  // in" branch is bypassed for these unauthenticated tests.
  app.decorateRequest('auth0User', null);
  await app.register(landingRoutes());
  return app;
}

const VALID_KEY = 'abcdef0123456789'.repeat(4);

describe('landingRoutes /login chooser short-circuit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MASTER_KEY', VALID_KEY);
    vi.stubEnv('JWT_SECRET', VALID_KEY);
    // Auth0 creds present by default for these tests; tests that need
    // them absent stub empty.
    vi.stubEnv('AUTH0_DOMAIN', 'wyre.us.auth0.com');
    vi.stubEnv('AUTH0_CLIENT_ID', 'auth0-id');
    vi.stubEnv('AUTH0_CLIENT_SECRET', 'auth0-secret');
    // Azure creds absent by default.
    delete process.env.AZURE_AD_CLIENT_ID;
    delete process.env.AZURE_AD_CLIENT_SECRET;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.AUTH_PROVIDER;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects to /auth/login when only Auth0 is configured', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    await app.close();
  });

  it('redirects to /auth/microsoft/login when only Azure-AD is configured', async () => {
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    vi.stubEnv('AZURE_AD_CLIENT_ID', 'azure-id');
    vi.stubEnv('AZURE_AD_CLIENT_SECRET', 'azure-secret');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/microsoft/login');
    await app.close();
  });

  it('renders the chooser HTML when both providers are configured', async () => {
    vi.stubEnv('AZURE_AD_CLIENT_ID', 'azure-id');
    vi.stubEnv('AZURE_AD_CLIENT_SECRET', 'azure-secret');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('/auth/login');
    expect(res.body).toContain('/auth/microsoft/login');
    await app.close();
  });

  it('renders the chooser HTML (empty UI) when neither provider is configured', async () => {
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/login' });
    // Misconfigured-deployment failure mode: chooser renders but with no
    // buttons. Operator sees the problem rather than getting a redirect
    // to a provider that won't authenticate.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    await app.close();
  });

  it('respects AUTH_PROVIDER=auth0 even when Azure creds are present (single-provider redirect)', async () => {
    vi.stubEnv('AZURE_AD_CLIENT_ID', 'azure-id');
    vi.stubEnv('AZURE_AD_CLIENT_SECRET', 'azure-secret');
    vi.stubEnv('AUTH_PROVIDER', 'auth0');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    await app.close();
  });
});

describe('landingRoutes / (landing page) Sign In button', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MASTER_KEY', VALID_KEY);
    vi.stubEnv('JWT_SECRET', VALID_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the non-customer Sign In button targeting /login (the chooser), NOT /auth/login', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    // Regression guard: the prior behavior was `href="/auth/login"` which
    // bypassed the chooser. Bug surfaced when Aaron tested staging on
    // 2026-05-11 and got Auth0-direct despite Azure-AD being configured.
    expect(res.body).toContain('href="/login"');
    expect(res.body).not.toContain('href="/auth/login"');
    await app.close();
  });
});
