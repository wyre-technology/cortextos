import { describe, it, expect, vi } from "vitest";

// Auth0 env must be set before ./routes (and the transitive ../config import)
// loads, because config.ts snapshots process.env at module-eval time.
// `vi.hoisted` executes before any ESM import in this file.
vi.hoisted(() => {
  process.env.AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || "test.auth0.com";
  process.env.AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID || "client_abc";
  process.env.BASE_URL = process.env.BASE_URL || "http://localhost:8080";
});

import Fastify from "fastify";
import formbody from "@fastify/formbody";
import type postgres from "postgres";
import {
  signupRoutes,
  validateEmail,
  InMemoryRateLimiter,
  renderSignupPage,
} from "./routes.js";
import { enterTestContext } from "../db/context.js";
import { ConsentService } from "../consent/consent-service.js";

// ---------------------------------------------------------------------------
// postgres.js tagged-template mock — captures INSERTed intent rows.
// ---------------------------------------------------------------------------

interface MockIntent {
  id: string;
  email: string;
  funnel: string;
  ip: string | null;
  userAgent: string | null;
  // WYREAI-98 consent capture columns
  consentAccepted: boolean;
  consentDocumentUrl: string | null;
  consentDocumentVersion: string | null;
  consentDocumentSizeBytes: number | null;
  consentAcceptedAt: string | null;
}

function createMockSql(): {
  sql: postgres.Sql;
  intents: MockIntent[];
  insertShouldFail: { value: boolean };
} {
  const intents: MockIntent[] = [];
  const insertShouldFail = { value: false };

  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("CREATE TABLE")) return Promise.resolve([]);
    if (query.includes("INSERT INTO signup_intents")) {
      if (insertShouldFail.value)
        return Promise.reject(new Error("insert failed"));
      // Post-WYREAI-98 the INSERT has 10 values (id, email, funnel, ip,
      // userAgent, consent_accepted, consent_document_url,
      // consent_document_version, consent_document_size_bytes,
      // consent_accepted_at) — destructure all + push extended shape.
      const [
        id,
        email,
        funnel,
        ip,
        userAgent,
        consentAccepted,
        consentDocumentUrl,
        consentDocumentVersion,
        consentDocumentSizeBytes,
        consentAcceptedAt,
      ] = values as [
        string,
        string,
        string,
        string | null,
        string | null,
        boolean,
        string | null,
        string | null,
        number | null,
        string | null,
      ];
      intents.push({
        id,
        email,
        funnel,
        ip,
        userAgent,
        consentAccepted: consentAccepted === true,
        consentDocumentUrl: consentDocumentUrl ?? null,
        consentDocumentVersion: consentDocumentVersion ?? null,
        consentDocumentSizeBytes: consentDocumentSizeBytes ?? null,
        consentAcceptedAt: consentAcceptedAt ?? null,
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;

  return { sql, intents, insertShouldFail };
}

/**
 * Stub ConsentService that returns a deterministic fingerprint without
 * hitting the network. Tests that need to assert fetch-failure-503 use
 * `makeFailingConsentService` instead.
 */
function makeStubConsentService(
  opts: { version?: string; sizeBytes?: number } = {},
): ConsentService {
  const fingerprint = {
    version: opts.version ?? "a".repeat(64),
    sizeBytes: opts.sizeBytes ?? 12345,
  };
  // Pass-through fetch stub; ConsentService's real fetchDocumentFingerprint
  // isn't exercised — we override the public method directly so the test
  // doesn't depend on the fetch-shape internals.
  const svc = new ConsentService();
  svc.fetchDocumentFingerprint = async () => fingerprint;
  return svc;
}

function makeFailingConsentService(): ConsentService {
  const svc = new ConsentService();
  svc.fetchDocumentFingerprint = async () => {
    throw new Error("upstream MSA unavailable");
  };
  return svc;
}

// ---------------------------------------------------------------------------
// Fastify harness
// ---------------------------------------------------------------------------

async function makeApp(overrides?: {
  limiter?: InMemoryRateLimiter;
  consentService?: ConsentService;
}) {
  const mock = createMockSql();
  const app = Fastify();
  await app.register(formbody);
  enterTestContext(mock.sql);
  await app.register(
    signupRoutes({
      limiter: overrides?.limiter,
      // Default to a stub that returns deterministic fingerprint so tests
      // don't make real network calls to the canonical MSA URL.
      consentService: overrides?.consentService ?? makeStubConsentService(),
    }),
  );
  await app.ready();
  return { app, mock };
}

// ---------------------------------------------------------------------------
// validateEmail
// ---------------------------------------------------------------------------

describe("validateEmail", () => {
  it("accepts a normal address", () => {
    const r = validateEmail("user@example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe("user@example.com");
  });

  it("lower-cases and trims", () => {
    const r = validateEmail("  USER@Example.COM  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.email).toBe("user@example.com");
  });

  it("rejects non-string", () => {
    expect(validateEmail(42).ok).toBe(false);
    expect(validateEmail(undefined).ok).toBe(false);
    expect(validateEmail(null).ok).toBe(false);
  });

  it("rejects empty", () => {
    expect(validateEmail("").ok).toBe(false);
    expect(validateEmail("   ").ok).toBe(false);
  });

  it("rejects malformed", () => {
    expect(validateEmail("no-at-sign").ok).toBe(false);
    expect(validateEmail("two@@sign.com").ok).toBe(false);
    expect(validateEmail("trailing@").ok).toBe(false);
  });

  it("rejects absurdly long input", () => {
    expect(validateEmail("a".repeat(300) + "@example.com").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InMemoryRateLimiter
// ---------------------------------------------------------------------------

describe("InMemoryRateLimiter", () => {
  it("allows up to max per window and then blocks", () => {
    const t = 1_000_000;
    const limiter = new InMemoryRateLimiter(3, 60_000, () => t);
    expect(limiter.check("ip1").allowed).toBe(true);
    expect(limiter.check("ip1").allowed).toBe(true);
    expect(limiter.check("ip1").allowed).toBe(true);
    const blocked = limiter.check("ip1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("independently tracks different keys", () => {
    const limiter = new InMemoryRateLimiter(1, 60_000);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const limiter = new InMemoryRateLimiter(1, 100, () => t);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);
    t += 200;
    expect(limiter.check("ip").allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Page render
// ---------------------------------------------------------------------------

describe("renderSignupPage", () => {
  it("includes the headline, form, and continue button", () => {
    const html = renderSignupPage();
    expect(html).toContain("Start your Conduit trial");
    expect(html).toContain('name="email"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/signup"');
    expect(html).toContain("Continue");
  });

  it("re-surfaces the error and prior email value", () => {
    const html = renderSignupPage({ error: "Bad email", email: "foo@bar" });
    expect(html).toContain("Bad email");
    expect(html).toContain('value="foo@bar"');
  });

  it("escapes HTML in the error and email", () => {
    const html = renderSignupPage({
      error: "<script>x</script>",
      email: '"><script>',
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// Route integration
// ---------------------------------------------------------------------------

describe("GET /signup", () => {
  it("returns a 200 HTML page", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/signup" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Start your Conduit trial");
  });
});

describe("POST /signup", () => {
  it("redirects to Auth0 with login_hint + state on a valid email", async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=user%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers["location"];
    expect(typeof location).toBe("string");
    const url = new URL(String(location));
    // config module may cache AUTH0_DOMAIN from env at import; accept either.
    expect(url.hostname.endsWith("auth0.com")).toBe(true);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // Persistence: one intent row with matching id + email
    expect(mock.intents).toHaveLength(1);
    expect(mock.intents[0]?.email).toBe("user@example.com");
    expect(mock.intents[0]?.funnel).toBe("reseller");
    expect(mock.intents[0]?.id).toBe(state);
  });

  it("rejects an invalid email with 400 and re-renders the form", async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=not-an-email",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid email");
    expect(mock.intents).toHaveLength(0);
  });

  it("rate-limits a flooding IP to 10/hour", async () => {
    const limiter = new InMemoryRateLimiter(10, 60 * 60 * 1000);
    const { app } = await makeApp({ limiter });

    for (let i = 0; i < 10; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/signup",
        payload: `email=u${i}%40example.com&accept_msa=1`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(ok.statusCode).toBe(302);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=late%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("returns 500 + error page when the intent insert fails", async () => {
    const { app, mock } = await makeApp();
    mock.insertShouldFail.value = true;
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// WYREAI-98 — MSA consent capture at /signup
// ---------------------------------------------------------------------------

describe("POST /signup — WYREAI-98 MSA consent", () => {
  it("rejects when accept_msa is absent (STRICT default — risk-asymmetric resolution)", async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=user%40example.com", // no accept_msa
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("accept the WYRE AI");
    // No signup_intent persisted when consent gate fails
    expect(mock.intents).toHaveLength(0);
  });

  it('rejects when accept_msa has unexpected value (only "1" counts as accepted)', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=user%40example.com&accept_msa=maybe",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(mock.intents).toHaveLength(0);
  });

  it("persists SHA256 + size + accepted_at on happy path", async () => {
    // Stub returns deterministic fingerprint — assertion proves the
    // captured-at-click-time SHA flows into the signup_intent row that
    // the downstream callback will read to write org_consents.
    const KNOWN_SHA = "c".repeat(64);
    const KNOWN_SIZE = 99_999;
    const { app, mock } = await makeApp({
      consentService: makeStubConsentService({
        version: KNOWN_SHA,
        sizeBytes: KNOWN_SIZE,
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=user%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(mock.intents).toHaveLength(1);
    const intent = mock.intents[0];
    expect(intent.consentAccepted).toBe(true);
    expect(intent.consentDocumentUrl).toBe(
      "https://docs.ourterms.live/WYRE/AI-Attachment.pdf",
    );
    expect(intent.consentDocumentVersion).toBe(KNOWN_SHA);
    expect(intent.consentDocumentSizeBytes).toBe(KNOWN_SIZE);
    expect(intent.consentAcceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601 stamp
  });

  it("returns 503 when ConsentService.fetchDocumentFingerprint throws (upstream MSA unavailable)", async () => {
    // Critical guard: a failed fetch must NOT proceed — we refuse to
    // record a consent against bytes we couldn't fetch (would otherwise
    // hash the error page OR record zero bytes, both of which falsely
    // bind users). The user can retry once upstream is back.
    const { app, mock } = await makeApp({
      consentService: makeFailingConsentService(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=user%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("temporarily unavailable");
    // No signup_intent persisted when fingerprint capture fails
    expect(mock.intents).toHaveLength(0);
  });

  it("preserves consentChecked sticky state on email-validation error re-render", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=not-an-email&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    // Re-render keeps the checkbox checked so user doesn't re-tick after fixing email.
    expect(res.body).toMatch(/<input[^>]*name="accept_msa"[^>]*checked/);
  });

  it("renderSignupPage includes the consent checkbox + MSA URL in the form", () => {
    const html = renderSignupPage();
    expect(html).toContain('name="accept_msa"');
    expect(html).toContain("required");
    expect(html).toContain("https://docs.ourterms.live/WYRE/AI-Attachment.pdf");
    expect(html).toContain("Master Service Agreement");
  });

  it("renderSignupPage respects consentChecked option (sticky form state)", () => {
    const unchecked = renderSignupPage();
    const checked = renderSignupPage({ consentChecked: true });
    expect(unchecked).not.toMatch(/<input[^>]*name="accept_msa"[^>]*checked/);
    expect(checked).toMatch(/<input[^>]*name="accept_msa"[^>]*checked/);
  });

  it("renderSignupPage escapes a custom consentDocumentUrl to prevent href XSS", () => {
    // Defensive: the consentDocumentUrl is injected for future
    // org-customizable scope; if it ever flows from an org-controlled
    // value, attacker-controlled HTML in the URL must NOT break the
    // anchor. escapeHtml at the render-site closes the rot vector.
    const html = renderSignupPage({
      consentDocumentUrl: 'javascript:alert(1)"><script>',
    });
    expect(html).not.toContain('"><script>');
    expect(html).toContain("javascript:alert(1)&quot;&gt;&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// 2026-06-13 sweep-2 cluster-1 (boss): org-type-choice picker at /signup
//
// The DB column `signup_intents.funnel TEXT NOT NULL DEFAULT 'reseller'`
// already existed; the UI was forcing every signup down the reseller
// funnel by hardcoding `"reseller"` at the INSERT site. The picker lets a
// direct end-user (just-my-team) self-select instead of being silently
// mis-routed. Tests below pin:
//   - default render selects 'reseller' (pre-picker behavior preserved)
//   - sticky form state on validation errors
//   - whitelist validation: unrecognized funnel values fall back to
//     'reseller' rather than 400-error (no user-facing failure for a
//     field that did not exist a week ago)
//   - subtitle copy diverges by funnel pick
//   - INSERT persists the selected funnel
// ---------------------------------------------------------------------------

describe("renderSignupPage — org-type funnel picker", () => {
  it("defaults to reseller on first render (pre-picker behavior preserved)", () => {
    const html = renderSignupPage();
    // Reseller radio is checked, direct is not. Use the value attr + space
    // + checked to anchor on the specific input rather than any other
    // checked input on the page.
    expect(html).toMatch(/name="funnel" value="reseller"\s+checked/);
    expect(html).not.toMatch(/name="funnel" value="direct"\s+checked/);
  });

  it('renders the direct radio as checked when funnel="direct"', () => {
    const html = renderSignupPage({ funnel: "direct" });
    expect(html).toMatch(/name="funnel" value="direct"\s+checked/);
    expect(html).not.toMatch(/name="funnel" value="reseller"\s+checked/);
  });

  it("switches the subtitle copy by funnel pick", () => {
    const reseller = renderSignupPage({ funnel: "reseller" });
    const direct = renderSignupPage({ funnel: "direct" });
    expect(reseller).toContain("reseller workspace");
    expect(reseller).toContain("first customer");
    expect(direct).toContain("workspace for your team");
    expect(direct).toContain("first MCP server");
    // Cross-check: the other-funnel copy is NOT present
    expect(reseller).not.toContain("workspace for your team");
    expect(direct).not.toContain("reseller workspace");
  });

  it("renders both org-type tiles with explanatory copy", () => {
    const html = renderSignupPage();
    expect(html).toContain("MSP / Reseller");
    expect(html).toContain("Direct customer");
    expect(html).toContain("downstream customer orgs");
    expect(html).toContain("just my team");
  });
});

describe("POST /signup — funnel handling", () => {
  it('persists funnel="direct" when posted', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&accept_msa=1&funnel=direct",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(mock.intents).toHaveLength(1);
    expect(mock.intents[0]?.funnel).toBe("direct");
  });

  it('persists funnel="reseller" when posted', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&accept_msa=1&funnel=reseller",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(mock.intents).toHaveLength(1);
    expect(mock.intents[0]?.funnel).toBe("reseller");
  });

  it('falls back to "reseller" when funnel is absent (no breaking-change for older clients)', async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&accept_msa=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(mock.intents[0]?.funnel).toBe("reseller");
  });

  it('falls back to "reseller" when funnel is an unrecognized value (whitelist gate)', async () => {
    // Tampered body / copy-paste from elsewhere shouldn't blow up the
    // signup; silently route to the pre-picker default funnel. The
    // whitelist gate prevents arbitrary strings from reaching the DB.
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&accept_msa=1&funnel=robot-mayhem",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(302);
    expect(mock.intents[0]?.funnel).toBe("reseller");
  });

  it("preserves funnel pick (sticky) on email-validation error re-render", async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=not-an-email&funnel=direct",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    // No intent persisted (validation failed)
    expect(mock.intents).toHaveLength(0);
    // The re-rendered form should still have 'direct' selected
    expect(res.body).toMatch(/name="funnel" value="direct"\s+checked/);
  });

  it("preserves funnel pick (sticky) on missing-MSA error re-render", async () => {
    const { app, mock } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/signup",
      payload: "email=u%40example.com&funnel=direct", // no accept_msa
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(mock.intents).toHaveLength(0);
    expect(res.body).toMatch(/name="funnel" value="direct"\s+checked/);
  });
});
