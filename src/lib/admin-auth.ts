import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

const CSRF_COOKIE = 'admin_csrf';
const CSRF_FIELD = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_TOKEN_BYTES = 32;
const CSRF_COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours, scoped to a working session

function isValidAdminToken(token: string): boolean {
  if (!config.adminApiKey || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminApiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isBearerAdmin(request: FastifyRequest): boolean {
  const auth = request.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!bearer && isValidAdminToken(bearer);
}

function isAdminSessionUser(request: FastifyRequest): boolean {
  const user = request.auth0User;
  const email = user?.email?.toLowerCase();
  if (!email) return false;
  // Email must be on the allowlist AND attested verified by the upstream IdP.
  // Without the verified gate, a hostile Entra tenant (or an unverified
  // Auth0 social connection) claiming an admin's email gets admin via
  // session. Bearer-token auth (ADMIN_API_KEY) remains the unconditional
  // path for scripts and CI.
  if (!user?.emailVerified) return false;
  return config.adminEmails.has(email);
}

/**
 * Read or mint the per-session CSRF token. Use in HTML page renderers to
 * embed the token in mutation forms via {@link csrfHiddenInput}.
 *
 * The cookie is signed (so the value is unforgeable without the cookie
 * secret) and HttpOnly+Lax+Secure-by-config — same shape as the gateway
 * session cookie.
 */
export function getOrSetCsrfToken(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.unsignCookie(request.cookies[CSRF_COOKIE] ?? '');
  if (existing.valid && existing.value && /^[a-f0-9]{64}$/.test(existing.value)) {
    return existing.value;
  }
  const token = randomBytes(CSRF_TOKEN_BYTES).toString('hex');
  reply.setCookie(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    signed: true,
    maxAge: CSRF_COOKIE_MAX_AGE,
  });
  return token;
}

/**
 * Render the hidden form input that carries the CSRF token. Pair with
 * {@link getOrSetCsrfToken} in the GET that renders the form.
 */
export function csrfHiddenInput(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}" />`;
}

function isValidCsrf(request: FastifyRequest): boolean {
  const cookie = request.unsignCookie(request.cookies[CSRF_COOKIE] ?? '');
  if (!cookie.valid || !cookie.value) return false;
  const submitted =
    (request.headers[CSRF_HEADER] as string | undefined) ??
    (request.body && typeof request.body === 'object' && CSRF_FIELD in (request.body as Record<string, unknown>)
      ? String((request.body as Record<string, unknown>)[CSRF_FIELD] ?? '')
      : '');
  if (!submitted) return false;
  const a = Buffer.from(cookie.value);
  const b = Buffer.from(submitted);
  return a.length === b.length && timingSafeEqual(a, b);
}

function wantsHtml(request: FastifyRequest): boolean {
  return (request.headers.accept ?? '').includes('text/html');
}

/**
 * Authorise an admin request. Two paths are accepted:
 *
 *   1. `Authorization: Bearer <ADMIN_API_KEY>` — for scripts and CI.
 *   2. A logged-in browser session whose email is in `ADMIN_EMAILS`.
 *
 * Sends 401 (or 403) and returns false on failure; callers must `return`
 * immediately.
 *
 * /admin/* MUST NOT route random visitors through the customer sign-up flow,
 * so:
 *   - Unauthenticated HTML requests get an "Admin only" page with a
 *     sign-in-only link (no Sign-Up button).
 *   - Signed-in-but-not-listed users get a "Not authorised" 403 page with
 *     a Sign-Out link, instead of a JSON 401 dump.
 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (bearer && isValidAdminToken(bearer)) return true;

  if (isAdminSessionUser(request)) return true;

  if (wantsHtml(request)) {
    if (request.auth0User) {
      // Signed in, but not on the admin allowlist.
      const email = request.auth0User.email ?? request.auth0User.sub ?? '';
      reply.code(403).type('text/html').send(renderForbiddenPage(email));
      return false;
    }

    // Not signed in — show a WYRE-only sign-in page (no customer sign-up).
    const returnTo = encodeURIComponent(request.url);
    reply.code(401).type('text/html').send(renderSignInPage(returnTo));
    return false;
  }

  reply.code(401).send({ error: 'Unauthorized' });
  return false;
}

/**
 * Authorise an admin mutation (POST/PUT/DELETE/PATCH). Same auth rules as
 * {@link requireAdmin}, plus a CSRF check for the session-cookie path.
 *
 * - Bearer requests skip CSRF (browsers can't auto-inject Authorization
 *   headers cross-origin, so they're not CSRF-reachable).
 * - Session-cookie requests must submit a CSRF token via either the
 *   `csrf_token` form field or the `x-csrf-token` header. The token must
 *   match the signed `admin_csrf` cookie issued by the GET that rendered
 *   the form.
 *
 * Use this for ALL admin POST/PUT/DELETE/PATCH endpoints. The destructive
 * ones (org delete, comp credits) are the highest-impact CSRF targets.
 */
export function requireAdminMutation(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isBearerAdmin(request)) return true;
  if (!requireAdmin(request, reply)) return false;
  if (!isValidCsrf(request)) {
    if (wantsHtml(request)) {
      reply
        .code(403)
        .type('text/html')
        .send(adminPageShell('CSRF check failed', `
          <h1>CSRF check failed</h1>
          <p>Your form submission could not be verified. Reload the previous page and try again.</p>
          <a class="btn" href="/admin">Back to admin</a>
        `));
    } else {
      reply.code(403).send({ error: 'CSRF token missing or invalid' });
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adminPageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Wyre Technology</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0a0a; --card: #1a1a1a; --text: #e5e5e5; --muted: #737373;
    --border: #333; --accent: #00C9DB; --accent-hover: #00b5c6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Nunito Sans', system-ui, sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 40px 32px; max-width: 440px; width: 100%;
  }
  h1 { font-size: 22px; margin-bottom: 12px; color: #f5f5f5; }
  p  { font-size: 14px; color: var(--muted); margin-bottom: 16px; line-height: 1.5; }
  .btn {
    display: inline-block; background: var(--accent); color: #04181b;
    font-weight: 600; font-size: 14px; padding: 10px 16px;
    border-radius: 6px; text-decoration: none;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn-secondary {
    display: inline-block; color: var(--accent); font-size: 13px;
    text-decoration: none; margin-left: 12px;
  }
  .brand { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 20px; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Wyre Technology · Admin</div>
    ${body}
  </div>
</body>
</html>`;
}

function renderSignInPage(returnTo: string): string {
  // Defence in depth. The caller already runs encodeURIComponent() on
  // request.url, which encodes most HTML-special characters — but it
  // doesn't encode `'`, `(`, `)`, `*`, `~` and doesn't change behaviour
  // if a future caller forgets the encoding step. Applying escapeHtml()
  // means even a misuse can't break out of the href="..." attribute.
  const safeReturn = escapeHtml(returnTo);
  return adminPageShell(
    'Admin sign-in',
    `
      <h1>Admin only</h1>
      <p>This area is restricted to Wyre Technology personnel. Sign in with your Wyre Microsoft account.</p>
      <a class="btn" href="/auth/microsoft/login?return_to=${safeReturn}">Sign in with Microsoft</a>
      <a class="btn-secondary" href="/auth/login?return_to=${safeReturn}">Use email instead</a>
    `,
  );
}

function renderForbiddenPage(actor: string): string {
  return adminPageShell(
    'Not authorised',
    `
      <h1>Not authorised</h1>
      <p>You're signed in as <strong>${escapeHtml(actor)}</strong>, but that account isn't on the Wyre admin list. If you believe this is wrong, ping your Wyre contact.</p>
      <a class="btn" href="/auth/logout">Sign out</a>
      <a class="btn-secondary" href="/">Back to home</a>
    `,
  );
}
