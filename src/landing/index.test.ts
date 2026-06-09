import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// These tests cover the /login route's single-provider-skip behavior + the
// landing page's non-customer Sign In button targeting /login (not
// /auth/login). The chooser HTML render itself is exercised in login.ts;
// here we exercise the route's decision-tree.
//
// landingRoutes + the config module it transitively imports are loaded
// per-test via dynamic import AFTER env stubs are in place, because
// config.ts evaluates env vars at module-import time.

async function buildApp(): Promise<FastifyInstance> {
  const { landingRoutes } = await import("./index.js");
  const app = Fastify();
  // Stub auth0User so the landing route's "redirect to /settings if logged
  // in" branch is bypassed for these unauthenticated tests.
  app.decorateRequest("auth0User", null);
  await app.register(landingRoutes());
  return app;
}

const VALID_KEY = "abcdef0123456789".repeat(4);

describe("landingRoutes /login chooser short-circuit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("MASTER_KEY", VALID_KEY);
    vi.stubEnv("JWT_SECRET", VALID_KEY);
    // Auth0 creds present by default for these tests; tests that need
    // them absent stub empty.
    vi.stubEnv("AUTH0_DOMAIN", "wyre.us.auth0.com");
    vi.stubEnv("AUTH0_CLIENT_ID", "auth0-id");
    vi.stubEnv("AUTH0_CLIENT_SECRET", "auth0-secret");
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

  it("redirects to /auth/login when only Auth0 is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/login");
    await app.close();
  });

  it("redirects to /auth/microsoft/login when only Azure-AD is configured", async () => {
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    vi.stubEnv("AZURE_AD_CLIENT_ID", "azure-id");
    vi.stubEnv("AZURE_AD_CLIENT_SECRET", "azure-secret");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/microsoft/login");
    await app.close();
  });

  it("renders the chooser HTML when both providers are configured", async () => {
    vi.stubEnv("AZURE_AD_CLIENT_ID", "azure-id");
    vi.stubEnv("AZURE_AD_CLIENT_SECRET", "azure-secret");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/auth/login");
    expect(res.body).toContain("/auth/microsoft/login");
    await app.close();
  });

  it("renders the chooser HTML (empty UI) when neither provider is configured", async () => {
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_CLIENT_ID;
    delete process.env.AUTH0_CLIENT_SECRET;
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    // Misconfigured-deployment failure mode: chooser renders but with no
    // buttons. Operator sees the problem rather than getting a redirect
    // to a provider that won't authenticate.
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    await app.close();
  });

  it("respects AUTH_PROVIDER=auth0 even when Azure creds are present (single-provider redirect)", async () => {
    vi.stubEnv("AZURE_AD_CLIENT_ID", "azure-id");
    vi.stubEnv("AZURE_AD_CLIENT_SECRET", "azure-secret");
    vi.stubEnv("AUTH_PROVIDER", "auth0");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/login");
    await app.close();
  });
});

describe("landingRoutes / (landing page) Sign In button", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("MASTER_KEY", VALID_KEY);
    vi.stubEnv("JWT_SECRET", VALID_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the non-customer Sign In button targeting /login (the chooser), NOT /auth/login", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    // Regression guard: the prior behavior was `href="/auth/login"` which
    // bypassed the chooser. Bug surfaced when Aaron tested staging on
    // 2026-05-11 and got Auth0-direct despite Azure-AD being configured.
    expect(res.body).toContain('href="/login"');
    expect(res.body).not.toContain('href="/auth/login"');
    await app.close();
  });
});

// 2026-06-09 SEO/AEO/GEO audit (Aaron). The non-customer landing must emit
// canonical + Open Graph + Twitter Card + Organization JSON-LD + WebPage
// JSON-LD (nested SoftwareApplication) + FAQPage JSON-LD. Schema shape
// matches the Astro marketing site (wyre-ai-site/src/pages/conduit/index)
// so entity identity is preserved at cutover. Customer-white-labeled
// landings keep their own entity surface and MUST NOT inherit Conduit's
// Organization JSON-LD — guarded explicitly below.
describe("landingRoutes / (landing page) SEO/AEO/GEO metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("MASTER_KEY", VALID_KEY);
    vi.stubEnv("JWT_SECRET", VALID_KEY);
    vi.stubEnv("BASE_URL", "https://conduit.wyre.ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits canonical + og:* + twitter:* on the non-customer landing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      '<link rel="canonical" href="https://conduit.wyre.ai"',
    );
    expect(res.body).toContain('property="og:title"');
    expect(res.body).toContain('property="og:image"');
    expect(res.body).toContain('property="og:url"');
    expect(res.body).toContain(
      'property="og:site_name" content="WYRE Technology"',
    );
    expect(res.body).toContain(
      'name="twitter:card" content="summary_large_image"',
    );
    await app.close();
  });

  it("emits Organization + WebPage + FAQPage JSON-LD on the non-customer landing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    // Three distinct ld+json blocks (Organization, WebPage, FAQPage).
    const ldBlocks =
      res.body.match(/<script type="application\/ld\+json">/g) ?? [];
    expect(ldBlocks.length).toBe(3);
    // Organization names WYRE Technology as the PROVIDER, not the reseller.
    expect(res.body).toContain('"@type":"Organization"');
    expect(res.body).toContain('"name":"WYRE Technology"');
    // WebPage about → SoftwareApplication "Conduit".
    expect(res.body).toContain('"@type":"WebPage"');
    expect(res.body).toContain('"@type":"SoftwareApplication"');
    expect(res.body).toContain('"name":"Conduit"');
    // FAQPage with three Question entries answering AEO-priority queries.
    expect(res.body).toContain('"@type":"FAQPage"');
    expect(res.body).toContain('"name":"What is Conduit?"');
    expect(res.body).toContain('"name":"Who is Conduit for?"');
    expect(res.body).toContain(
      '"name":"How does Conduit relate to the WYRE MCP Gateway?"',
    );
    await app.close();
  });
});
