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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { brand } from '../brand/index.js';
import { config } from '../config.js';
import { PAGE_STYLES } from '../web/styles.js';
import { escapeHtml } from '../web/helpers.js';
import { getSql } from '../db/context.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Simple, intentionally-not-exhaustive email regex. Good enough to reject
// obvious typos; Auth0 will do the authoritative check at verification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254; // RFC 5321

export function validateEmail(raw: unknown): { ok: true; email: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'Email is required' };
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: 'Email is required' };
  if (trimmed.length > EMAIL_MAX_LEN) return { ok: false, reason: 'Email is too long' };
  if (!EMAIL_RE.test(trimmed)) return { ok: false, reason: 'Invalid email address' };
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

  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterMs: 0 };
    }
    if (existing.count >= this.max) {
      return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.max - existing.count, retryAfterMs: 0 };
  }

  /** Test helper. */
  reset(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

interface RenderSignupPageOptions {
  error?: string;
  email?: string;
}

export function renderSignupPage(opts: RenderSignupPageOptions = {}): string {
  const brandName = escapeHtml(brand.name);
  const emailValue = opts.email ? escapeHtml(opts.email) : '';
  const errorBlock = opts.error
    ? `<div class="error-box" role="alert">${escapeHtml(opts.error)}</div>`
    : '';

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
      <p class="subtitle">Spin up a reseller workspace and connect your first customer in under fifteen minutes.</p>
      ${errorBlock}
      <form method="POST" action="/signup" novalidate>
        <div class="form-row">
          <label for="email">Work email</label>
          <input type="email" id="email" name="email" value="${emailValue}" placeholder="you@yourmsp.com" required autocomplete="email" />
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

function buildAuthorizeUrl(params: {
  domain: string;
  clientId: string;
  redirectUri: string;
  email: string;
  state: string;
}): string {
  const url = new URL(`https://${params.domain}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('login_hint', params.email);
  url.searchParams.set('screen_hint', 'signup');
  url.searchParams.set('state', params.state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface SignupRoutesDeps {
  /** Override for tests. */
  limiter?: InMemoryRateLimiter;
}

export function signupRoutes(deps: SignupRoutesDeps) {
  const limiter = deps.limiter ?? new InMemoryRateLimiter();

  return async function plugin(app: FastifyInstance): Promise<void> {
    // Pre-auth signup intents. One row per submitted email + state pair.
    // Consumed by the Auth0 callback (follow-up task) and promoted to
    // onboarding_progress once a user + reseller org exist.
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

    // GET /signup — public HTML
    app.get('/signup', async (_request, reply) => {
      return reply.type('text/html').send(renderSignupPage());
    });

    // POST /signup — validate + rate-limit + persist + redirect to Auth0
    app.post<{ Body: { email?: string } }>(
      '/signup',
      async (request: FastifyRequest<{ Body: { email?: string } }>, reply: FastifyReply) => {
        const ip = request.ip || 'unknown';
        const limit = limiter.check(ip);
        if (!limit.allowed) {
          reply.header('Retry-After', Math.ceil(limit.retryAfterMs / 1000).toString());
          return reply.code(429).type('text/html').send(
            renderSignupPage({ error: 'Too many signup attempts. Please try again later.' }),
          );
        }

        const result = validateEmail(request.body?.email);
        if (!result.ok) {
          return reply.code(400).type('text/html').send(
            renderSignupPage({
              error: result.reason,
              email: typeof request.body?.email === 'string' ? request.body.email : undefined,
            }),
          );
        }
        const email = result.email;

        if (!config.auth0Domain || !config.auth0ClientId) {
          app.log.error('Signup attempted but Auth0 is not configured (AUTH0_DOMAIN / AUTH0_CLIENT_ID)');
          return reply.code(503).type('text/html').send(
            renderSignupPage({
              error: 'Signup is temporarily unavailable. Please try again shortly.',
              email,
            }),
          );
        }

        const intentId = nanoid();
        try {
          await getSql()`
            INSERT INTO signup_intents (id, email, funnel, ip, user_agent)
            VALUES (
              ${intentId},
              ${email},
              ${'reseller'},
              ${ip},
              ${request.headers['user-agent'] ?? null}
            )
          `;
        } catch (err) {
          app.log.error({ err }, 'Failed to persist signup intent');
          return reply.code(500).type('text/html').send(
            renderSignupPage({ error: 'Something went wrong. Please try again.', email }),
          );
        }

        const redirectUri = config.auth0CallbackUrl || `${config.baseUrl}/auth/callback`;
        const authorizeUrl = buildAuthorizeUrl({
          domain: config.auth0Domain,
          clientId: config.auth0ClientId,
          redirectUri,
          email,
          state: intentId,
        });

        return reply.redirect(authorizeUrl, 302);
      },
    );
  };
}
