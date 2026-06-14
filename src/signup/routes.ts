/**
 * Public reseller signup — Funnel A (prd-onboarding.md §4).
 *
 * Surfaces:
 *   GET  /signup  — public HTML page. Email + Continue. Posts to itself.
 *   POST /signup  — validates email, rate-limits per IP, persists a pending
 *                   signup intent, then 302s the user to Auth0 /authorize
 *                   with `login_hint=<email>` and `state=<intent_id>` so the
 *                   Auth0 callback can resume Funnel A.
 *
 * Gating:
 *   - Plugin only registers when `config.features.signup` is true
 *     (env SIGNUP_ENABLED=true). Matches the RESELLER_CONSOLE_ENABLED
 *     pattern. Default off — we don't want the page indexable before
 *     legal/ops sign off on ToS + DPA links.
 *
 * Auth0 integration:
 *   - We hand-roll the /authorize redirect here rather than going through
 *     `src/auth/auth0.ts`'s `/auth/login` helper because that helper does
 *     not accept `login_hint`. The URL we build is a plain OAuth2 authorize
 *     request (no PKCE yet) — the `state` we pass is the signup-intent id.
 *   - Wiring up the callback to consume `signup_intents` and finish
 *     provisioning lives in a follow-up task. Today the existing
 *     `/auth/callback` will reject the state (no matching `auth_state` row)
 *     and return the user to the login page, which is safe behaviour until
 *     the callback is extended.
 *
 * Schema note:
 *   The onboarding PRD §7.5 calls for an `onboarding_progress` row at this
 *   step, but that table requires a non-null `org_id` (FK →
 *   organizations) and `user_id`. Neither exists until after Auth0 returns.
 *   We persist the pre-auth state in a dedicated `signup_intents` table
 *   and promote it to `onboarding_progress` once the user + org are
 *   materialised in the callback. Keeps the write path simple and avoids
 *   placeholder rows that confuse admin queries.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { nanoid } from "nanoid";
import { brand } from "../brand/index.js";
import { config } from "../config.js";
import { PAGE_STYLES } from "../web/styles.js";
import { escapeHtml } from "../web/helpers.js";
import { getSql, runAsSystem } from "../db/context.js";
// IdP slice 2 Piece 1 — STATIC imports for drift-resistance per analyst item 3
// (PR #392 triangle, boss msg-1781452923263). Dynamic imports inside the
// default resolver would silently rot if OrgDomainService/OrgService method
// names changed. Static imports surface the rename at tsc time.
import { OrgDomainService } from "../org/domain-service.js";
import { OrgService } from "../org/org-service.js";
import {
  AI_MSA_DOCUMENT_URL,
  ConsentService,
  type DocumentFingerprint,
} from "../consent/consent-service.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Simple, intentionally-not-exhaustive email regex. Good enough to reject
// obvious typos; Auth0 will do the authoritative check at verification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254; // RFC 5321

export function validateEmail(
  raw: unknown,
): { ok: true; email: string } | { ok: false; reason: string } {
  if (typeof raw !== "string")
    return { ok: false, reason: "Email is required" };
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "Email is required" };
  if (trimmed.length > EMAIL_MAX_LEN)
    return { ok: false, reason: "Email is too long" };
  if (!EMAIL_RE.test(trimmed))
    return { ok: false, reason: "Invalid email address" };
  return { ok: true, email: trimmed };
}

// ---------------------------------------------------------------------------
// Rate limit shim — falls back to in-memory token bucket if @fastify/rate-limit
// isn't loaded on the instance. Keyed on IP. TODO (production): replace the
// in-memory store with Redis-backed limits so it survives horizontal scale.
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

interface BucketEntry {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(
    private readonly max: number = RATE_LIMIT_MAX,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  } {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterMs: 0 };
    }
    if (existing.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: existing.resetAt - now,
      };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: this.max - existing.count,
      retryAfterMs: 0,
    };
  }

  /** Test helper. */
  reset(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * Signup funnel choice — the org-type the signer is provisioning.
 *
 *   - 'reseller': MSP onboarding their clients. They will get the reseller
 *     console (/org/customers, /org/hierarchy, etc.) and bill-and-resell
 *     downstream customer orgs.
 *   - 'direct': Direct customer (just their own team). They will get the
 *     plain team console without the reseller surface. No customer-org
 *     provisioning, no Stripe Connect, no white-label.
 *
 * The DB column already exists (`signup_intents.funnel TEXT NOT NULL DEFAULT
 * 'reseller'`); this picker just lets the UI capture which one the signer
 * actually wants instead of silently defaulting to reseller. 2026-06-13
 * sweep-2 cluster-1 finding (Aaron): the missing picker was forcing every
 * signup down the reseller funnel even when the signer was a direct end-
 * user. The downstream Auth0 callback (separate PR) will branch on this
 * field to create the right org type.
 */
export type SignupFunnel = "reseller" | "direct";

export const SIGNUP_FUNNELS: readonly SignupFunnel[] = ["reseller", "direct"];

export function isSignupFunnel(value: unknown): value is SignupFunnel {
  return (
    typeof value === "string" &&
    (SIGNUP_FUNNELS as readonly string[]).includes(value)
  );
}

interface RenderSignupPageOptions {
  error?: string;
  email?: string;
  /** Pre-checked state of the MSA consent box on re-render (sticky form
   *  state after a validation error). Defaults to false on first render. */
  consentChecked?: boolean;
  /** Canonical PDF URL surfaced as the link target on the consent checkbox
   *  label. Defaults to the AI_MSA_DOCUMENT_URL constant. Injected for
   *  test-overridability + future scope where the URL becomes
   *  org-customizable. */
  consentDocumentUrl?: string;
  /** Pre-selected funnel on re-render (sticky form state after a
   *  validation error). Defaults to 'reseller' on first render — that is
   *  the most common case (MSPs are the primary audience) and preserves
   *  the pre-picker behavior where every signup was funneled as reseller.
   *  Adding the picker is non-breaking by-construction: the default is
   *  the pre-picker value, so a user who ignores the picker gets the same
   *  experience as before. */
  funnel?: SignupFunnel;
}

export function renderSignupPage(opts: RenderSignupPageOptions = {}): string {
  const brandName = escapeHtml(brand.name);
  const emailValue = opts.email ? escapeHtml(opts.email) : "";
  const consentChecked = opts.consentChecked === true;
  // Default to the AI_MSA constant; injected override for tests + future
  // org-customizable URL scope. Always escapeHtml — the URL ends up in an
  // anchor href, so an attacker-controlled override would otherwise XSS.
  const consentDocumentUrl = escapeHtml(
    opts.consentDocumentUrl ?? AI_MSA_DOCUMENT_URL,
  );
  const errorBlock = opts.error
    ? `<div class="error-box" role="alert">${escapeHtml(opts.error)}</div>`
    : "";
  // Default the funnel pick to 'reseller' on first render — pre-picker
  // behavior. Re-render uses the user's prior choice for sticky form
  // state. The two values are constants so no escapeHtml needed (they
  // appear as the `value=` attribute and in the `checked` discriminator).
  const funnel: SignupFunnel = isSignupFunnel(opts.funnel)
    ? opts.funnel
    : "reseller";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Start your Conduit trial - ${brandName}</title>
  <meta name="description" content="Start your Conduit trial — sign up to provision your MSP reseller account." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script>
    (function() {
      var theme = localStorage.getItem('gateway-theme');
      if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      if (theme === 'light') document.documentElement.classList.add('light');
    })();
  </script>
  <style>
    ${PAGE_STYLES}
    .error-box {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: var(--error-text);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .form-row { margin-bottom: 16px; }
    .form-row label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-label);
      margin-bottom: 6px;
    }
    .form-row input {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg-input);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;
    }
    .form-row input:focus { outline: none; border-color: var(--accent); }
    /* Org-type picker — 2026-06-13 (boss) sweep-2 (2). Two stacked radio
     * tiles. Whole tile is clickable (label wraps the radio). Selected
     * tile gets the accent border + a subtle fill so the choice is
     * obvious even at a glance. */
    .funnel-picker { display: grid; gap: 8px; }
    .funnel-tile {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      background: var(--bg-input);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      cursor: pointer;
    }
    .funnel-tile:hover { border-color: var(--accent); }
    .funnel-tile input[type="radio"] { margin-top: 3px; }
    .funnel-tile input[type="radio"]:checked + .funnel-tile-copy {
      color: var(--text-primary);
    }
    .funnel-tile:has(input[type="radio"]:checked) {
      border-color: var(--accent);
      background: var(--bg-input-selected, var(--bg-input));
    }
    .funnel-tile-copy { display: block; }
    .funnel-tile-title { display: block; font-weight: 600; font-size: 14px; color: var(--text-primary); }
    .funnel-tile-desc { display: block; font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .btn-primary {
      display: block;
      width: 100%;
      padding: 12px;
      background: var(--accent);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 8px;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .footnote {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <div class="brand">${brandName}</div>
      <h1>Start your Conduit trial</h1>
      <p class="subtitle">${
        funnel === "direct"
          ? "Spin up a workspace for your team and connect your first MCP server in under fifteen minutes."
          : "Spin up a reseller workspace and connect your first customer in under fifteen minutes."
      }</p>
      ${errorBlock}
      <form method="POST" action="/signup" novalidate>
        <div class="form-row">
          <label>Who is this for?</label>
          <div class="funnel-picker" role="radiogroup" aria-label="Org type">
            <label class="funnel-tile">
              <input type="radio" name="funnel" value="reseller"${funnel === "reseller" ? " checked" : ""} />
              <span class="funnel-tile-copy">
                <span class="funnel-tile-title">MSP / Reseller</span>
                <span class="funnel-tile-desc">I'm onboarding multiple downstream customer orgs and want the reseller console.</span>
              </span>
            </label>
            <label class="funnel-tile">
              <input type="radio" name="funnel" value="direct"${funnel === "direct" ? " checked" : ""} />
              <span class="funnel-tile-copy">
                <span class="funnel-tile-title">Direct customer</span>
                <span class="funnel-tile-desc">It's just my team — no downstream customers to manage.</span>
              </span>
            </label>
          </div>
        </div>
        <div class="form-row">
          <label for="email">Work email</label>
          <input type="email" id="email" name="email" value="${emailValue}" placeholder="you@yourmsp.com" required autocomplete="email" />
        </div>
        <div class="form-row consent-row">
          <label class="consent-label">
            <input type="checkbox" id="accept_msa" name="accept_msa" value="1"${consentChecked ? " checked" : ""} required />
            <span>I accept the WYRE AI <a href="${consentDocumentUrl}" target="_blank" rel="noopener noreferrer">Master Service Agreement</a>.</span>
          </label>
        </div>
        <button type="submit" class="btn-primary">Continue</button>
      </form>
      <p class="footnote">We will send you to sign in or create an account on our identity provider.</p>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Auth0 /authorize URL builder
// ---------------------------------------------------------------------------

/**
 * Hardenings from PR #392 triangle review (boss msg-1781452923263):
 *   - LENS (b) silent-bug-swallowing CLOSED: structured warn-log emits on
 *     every resolver failure with err_class + err_message + anonymized
 *     email_domain (PII-safe). The optional onResolverFailure hook lets
 *     production wiring increment a Prom counter for sustained-error-
 *     rate alerting.
 *   - LENS (c) timeout-circuit-breaker ADDED: Promise.race with 300ms
 *     limit. Risk-asymmetric resolution stays PERMISSIVE (signup never
 *     blocks) but by-construction (slow resolver no longer bricks signup
 *     despite catch-all).
 *   - ANALYST item 3 drift-resistance CLOSED: static imports (above) +
 *     direct class instantiation make findVerifiedByEmail/getOrg renames
 *     surface at tsc time.
 */
const DEFAULT_RESOLVER_TIMEOUT_MS = 300;

/**
 * PII-safe email anonymization: keep domain (load-bearing for the resolver-
 * failure surface — the domain IS what the resolver looks up), redact local
 * part. Used only in failure-path logs.
 */
function anonymizeEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "<no-@>";
  return `<redacted>@${email.slice(at + 1)}`;
}

/**
 * Hook fired on resolver failure (timeout OR throw). Production wiring
 * increments a Prom counter `signup_resolver_error_total{err_class=...}`
 * so sustained-error-rate alerting can detect outages. Tests inject a spy.
 * Optional + no-op default — the lookup itself never depends on this.
 */
export type ResolverFailureHook = (info: {
  errClass: string;
  errMessage: string;
  anonymizedEmail: string;
}) => void;

/**
 * Default email → auth0_org_id resolver. Multi-IdP foundation slice 4
 * Piece 1 (pearl-owned routing-decision). Chains:
 *   1. OrgDomainService.findVerifiedByEmail(email) → OrgDomain | null
 *   2. OrgService.getOrg(orgDomain.orgId) → Organization
 *   3. Returns Organization.auth0OrgId
 *
 * Returns null on any failure step (no verified domain match, public-email
 * domain, lookup error, OR timeout). NULL preserves existing default-pool
 * behavior at /authorize per the risk-asymmetric resolution discipline
 * (signup must not block on a lookup-side failure — better to miss IdP
 * routing once than block the funnel).
 *
 * System-context: this runs inside the POST /signup request-path. The
 * lookup uses runAsSystem because the OrgDomainService + OrgService
 * methods need DB context the request-pool doesn't carry pre-auth.
 */
function makeDefaultResolver(
  onFailure?: ResolverFailureHook,
): (email: string) => Promise<string | null> {
  return async function defaultResolveAuth0OrgFromEmail(
    email: string,
  ): Promise<string | null> {
    // LENS (c): timeout-circuit-breaker. The resolver chain is sub-100ms
    // typically (one verified-domain lookup + one org lookup); 300ms is a
    // generous bound that catches DB stalls without bricking signup.
    const timeoutSym = Symbol("resolver-timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = runAsSystem(async () => {
        const orgDomain = await new OrgDomainService().findVerifiedByEmail(email);
        if (!orgDomain) return null;
        const org = await new OrgService().getOrg(orgDomain.orgId);
        return org?.auth0OrgId ?? null;
      });
      const timeout = new Promise<typeof timeoutSym>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeoutSym), DEFAULT_RESOLVER_TIMEOUT_MS);
      });
      const result = await Promise.race([lookup, timeout]);
      if (result === timeoutSym) {
        emitFailure(onFailure, email, "ResolverTimeout", `>${DEFAULT_RESOLVER_TIMEOUT_MS}ms`);
        return null;
      }
      return result;
    } catch (err) {
      const errClass = err instanceof Error ? err.constructor.name : typeof err;
      const errMessage = err instanceof Error ? err.message : String(err);
      emitFailure(onFailure, email, errClass, errMessage);
      return null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
}

function emitFailure(
  hook: ResolverFailureHook | undefined,
  email: string,
  errClass: string,
  errMessage: string,
): void {
  const anonymizedEmail = anonymizeEmail(email);
  // LENS (b) closure: structured warn-log so resolver failures are no longer
  // silent. Anonymized email is PII-safe (domain preserved for triage).
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "signup_resolver_failure",
      err_class: errClass,
      err_message: errMessage,
      anonymized_email: anonymizedEmail,
    }),
  );
  hook?.({ errClass, errMessage, anonymizedEmail });
}

function buildAuthorizeUrl(params: {
  domain: string;
  clientId: string;
  redirectUri: string;
  email: string;
  state: string;
  /**
   * Multi-IdP foundation slice 4 — Piece 1 email-domain → org → Auth0 routing
   * (pearl-owned routing-decision per the comment at src/auth/auth0.ts:212).
   * When set, threads `organization=<auth0_org_id>` to Auth0's /authorize so
   * Auth0 routes the user to the org's enabled IdP connections (Okta SAML,
   * JumpCloud, Google direct, etc.) instead of the WYRE default Universal
   * Login connection pool. NULL/undefined preserves existing default-pool
   * behavior — the ~majority of /signup traffic where the email-domain
   * doesn't claim into a verified org.
   */
  auth0OrgId?: string | null;
}): string {
  const url = new URL(`https://${params.domain}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("login_hint", params.email);
  url.searchParams.set("screen_hint", "signup");
  url.searchParams.set("state", params.state);
  if (params.auth0OrgId) {
    url.searchParams.set("organization", params.auth0OrgId);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface SignupRoutesDeps {
  /** Override for tests. */
  limiter?: InMemoryRateLimiter;
  /**
   * ConsentService injection — WYREAI-98 AI MSA consent at signup. The
   * POST /signup handler calls `consentService.fetchDocumentFingerprint`
   * to capture the SHA256 of the canonical PDF at click-time (so the
   * binding-record promoted by the downstream callback consumer carries
   * EXACTLY the bytes the user saw). Optional + default-instantiated so
   * existing tests that don't care about consent keep working unchanged.
   */
  consentService?: ConsentService;
  /**
   * Multi-IdP foundation slice 4 — Piece 1 email-domain → org → Auth0 routing
   * (pearl-owned routing-decision per the comment at src/auth/auth0.ts:212).
   * Given a submitter's email, returns the Auth0 organization id to thread
   * into the /authorize redirect, or null if the email-domain doesn't
   * claim into a verified org with Auth0-IdP routing configured.
   *
   * Default implementation chains OrgDomainService.findVerifiedByEmail →
   * OrgService.getOrg(orgId).auth0OrgId. Optional + default-instantiated;
   * tests inject a deterministic function to exercise the routing decision
   * without standing up the DB chain. Same N=3 optional-injection-as-
   * backward-compat-affordance pattern (banked msg-1781353015514 — RC2 PR-B
   * BrandResolver + WYREAI-98 ConsentService + now this).
   *
   * RESOLVER FAILURE BEHAVIOR: returns null (NOT throws). A lookup failure
   * MUST NOT block signup — the user falls back to the WYRE default IdP
   * pool. The risk-asymmetric resolution: blocking signup on a lookup-side
   * failure is a worse outcome than missing IdP-routing for one signup.
   *
   * HARDENINGS (PR #392 triangle): the default resolver wraps in Promise.race
   * with 300ms timeout (warden lens c) + emits structured warn-log on failure
   * + invokes onResolverFailure hook for metric-counter increment (warden
   * lens b). Override resolvers are responsible for their own protections.
   */
  resolveAuth0OrgFromEmail?: (email: string) => Promise<string | null>;
  /**
   * Optional hook for resolver-failure telemetry. Production wiring
   * increments a Prom counter `signup_resolver_error_total{err_class=...}`;
   * tests inject a spy. No-op default — the resolver lookup itself never
   * depends on this. Only fires when the DEFAULT resolver fails; override
   * resolvers are responsible for their own telemetry.
   */
  onResolverFailure?: ResolverFailureHook;
}

export function signupRoutes(deps: SignupRoutesDeps) {
  const limiter = deps.limiter ?? new InMemoryRateLimiter();
  const consentService = deps.consentService ?? new ConsentService();
  const resolveAuth0OrgFromEmail =
    deps.resolveAuth0OrgFromEmail ?? makeDefaultResolver(deps.onResolverFailure);

  return async function plugin(app: FastifyInstance): Promise<void> {
    // Pre-auth signup intents. One row per submitted email + state pair.
    // Consumed by the Auth0 callback (follow-up task) and promoted to
    // onboarding_progress once a user + reseller org exist.
    //
    // Boot-time schema-init runs OUTSIDE the request-path AsyncLocalStorage
    // context (no preHandler hook has fired yet), so `getSql()` would throw
    // "called with no DB context." Wrapping in `runAsSystem` enters the
    // system-pool context the same way the migration runner does — the
    // explicit entry-point makes this query intentional system-path work.
    // 2026-06-12 boot-fix (boss): without this wrapper, enabling
    // SIGNUP_ENABLED=true crashes the container on startup. Same shape will
    // need applying to other plugins that lazy-create tables at registration
    // (waitlist/routes.ts has identical pattern but is currently
    // dark on staging so the bug is latent there).
    await runAsSystem(async () => {
      await getSql()`
        CREATE TABLE IF NOT EXISTS signup_intents (
          id          TEXT PRIMARY KEY,
          email       TEXT NOT NULL,
          funnel      TEXT NOT NULL DEFAULT 'reseller',
          ip          TEXT,
          user_agent  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          consumed_at TIMESTAMPTZ
        )
      `;
    });

    // GET /signup — public HTML
    app.get("/signup", async (_request, reply) => {
      return reply.type("text/html").send(renderSignupPage());
    });

    // POST /signup — validate + rate-limit + capture MSA consent + persist + redirect to Auth0
    app.post<{
      Body: { email?: string; accept_msa?: string; funnel?: string };
    }>(
      "/signup",
      async (
        request: FastifyRequest<{
          Body: { email?: string; accept_msa?: string; funnel?: string };
        }>,
        reply: FastifyReply,
      ) => {
        const ip = request.ip || "unknown";
        // Funnel resolution — accept the form-posted value if it is in the
        // whitelist, fall back to 'reseller' otherwise. The fallback is
        // intentional rather than an error response: any unrecognized
        // value (missing field on an older client, tampered body, copy-
        // paste from somewhere) should silently land in the pre-picker
        // default funnel rather than surface a "your signup failed"
        // 400 to a user who did nothing wrong. The whitelist gate
        // protects the DB column from arbitrary string injection.
        const funnel: SignupFunnel = isSignupFunnel(request.body?.funnel)
          ? request.body.funnel
          : "reseller";
        const limit = limiter.check(ip);
        if (!limit.allowed) {
          reply.header(
            "Retry-After",
            Math.ceil(limit.retryAfterMs / 1000).toString(),
          );
          return reply
            .code(429)
            .type("text/html")
            .send(
              renderSignupPage({
                error: "Too many signup attempts. Please try again later.",
                funnel,
              }),
            );
        }

        const result = validateEmail(request.body?.email);
        if (!result.ok) {
          return reply
            .code(400)
            .type("text/html")
            .send(
              renderSignupPage({
                error: result.reason,
                email:
                  typeof request.body?.email === "string"
                    ? request.body.email
                    : undefined,
                // Preserve checkbox state across email-error re-renders so the
                // user doesn't have to re-check it. The HTML form posts the
                // checkbox as 'accept_msa=1' when checked; absent otherwise.
                consentChecked: request.body?.accept_msa === "1",
                funnel,
              }),
            );
        }
        const email = result.email;

        // MSA consent gate (WYREAI-98). The HTML form sets accept_msa='1'
        // when the checkbox is checked, absent otherwise. STRICTEST-LEGAL
        // default per the boss-banked risk-asymmetric resolution shape:
        // reversible-failure (user re-submits with checkbox) vs
        // irreversible-failure (user proceeds without binding consent).
        // The [POLICY-DECISION] in WYREAI-98 + WYREAI-113 may relax this
        // later; the default is STRICT.
        if (request.body?.accept_msa !== "1") {
          return reply
            .code(400)
            .type("text/html")
            .send(
              renderSignupPage({
                error:
                  "Please accept the WYRE AI Master Service Agreement to continue.",
                email,
                consentChecked: false,
                funnel,
              }),
            );
        }

        if (!config.auth0Domain || !config.auth0ClientId) {
          app.log.error(
            "Signup attempted but Auth0 is not configured (AUTH0_DOMAIN / AUTH0_CLIENT_ID)",
          );
          return reply
            .code(503)
            .type("text/html")
            .send(
              renderSignupPage({
                error:
                  "Signup is temporarily unavailable. Please try again shortly.",
                email,
                consentChecked: true,
                funnel,
              }),
            );
        }

        // CRYPTOGRAPHIC LAYER: SHA256-at-click-time of the canonical MSA.
        // Throws on network failure / non-OK HTTP / empty body — we
        // refuse to record a consent against bytes we couldn't actually
        // fetch (would otherwise SHA the error page or store zero-byte
        // hash, both of which falsely bind users). Surface as
        // 503-temporarily-unavailable; user can retry once upstream is back.
        let fingerprint: DocumentFingerprint;
        try {
          fingerprint =
            await consentService.fetchDocumentFingerprint(AI_MSA_DOCUMENT_URL);
        } catch (err) {
          app.log.error(
            { err, url: AI_MSA_DOCUMENT_URL },
            "Failed to fetch MSA for consent capture",
          );
          return reply
            .code(503)
            .type("text/html")
            .send(
              renderSignupPage({
                error:
                  "MSA is temporarily unavailable. Please try again in a moment.",
                email,
                consentChecked: true,
                funnel,
              }),
            );
        }

        const intentId = nanoid();
        const acceptedAt = new Date().toISOString();
        try {
          await getSql()`
            INSERT INTO signup_intents (
              id, email, funnel, ip, user_agent,
              consent_accepted, consent_document_url,
              consent_document_version, consent_document_size_bytes,
              consent_accepted_at
            )
            VALUES (
              ${intentId},
              ${email},
              ${funnel},
              ${ip},
              ${request.headers["user-agent"] ?? null},
              ${true},
              ${AI_MSA_DOCUMENT_URL},
              ${fingerprint.version},
              ${fingerprint.sizeBytes},
              ${acceptedAt}
            )
          `;
        } catch (err) {
          app.log.error({ err }, "Failed to persist signup intent");
          return reply
            .code(500)
            .type("text/html")
            .send(
              renderSignupPage({
                error: "Something went wrong. Please try again.",
                email,
                consentChecked: true,
                funnel,
              }),
            );
        }

        const redirectUri =
          config.auth0CallbackUrl || `${config.baseUrl}/auth/callback`;

        // Multi-IdP foundation slice 4 — Piece 1 routing-decision (pearl-owned
        // per the comment at src/auth/auth0.ts:212). Look up the auth0_org_id
        // for the email-domain's verified org BEFORE building the authorize
        // URL. Lookup-failure resolves to null + falls through to the WYRE
        // default IdP pool — risk-asymmetric resolution discipline (signup
        // funnel must not block on lookup-side failure).
        const auth0OrgId = await resolveAuth0OrgFromEmail(email);

        const authorizeUrl = buildAuthorizeUrl({
          domain: config.auth0Domain,
          clientId: config.auth0ClientId,
          redirectUri,
          email,
          state: intentId,
          auth0OrgId,
        });

        return reply.redirect(authorizeUrl, 302);
      },
    );
  };
}
