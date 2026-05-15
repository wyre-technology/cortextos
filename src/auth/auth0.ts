/**
 * Auth0 OIDC middleware — Fastify plugin
 *
 * Provides user authentication via Auth0 Universal Login using the
 * authorization code flow with PKCE. PKCE verifiers are stored server-side
 * in PostgreSQL (keyed by the OAuth `state` parameter) to avoid cookie
 * race conditions from concurrent login requests. Exposes:
 *
 *   GET  /auth/login    — Redirect to Auth0 login
 *   GET  /auth/callback — Handle Auth0 return, upsert user, set session
 *   GET  /auth/logout   — Clear session and redirect to Auth0 logout
 *
 * Decorates requests with `auth0User` (Auth0 sub + email + name) when
 * an active session exists.
 */

import { randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type postgres from 'postgres';
import { brand } from '../brand/index.js';
import { config } from '../config.js';
import { getRequestBaseUrl } from '../http/base-url.js';
import { isSafePath } from './safe-path.js';
import { decodeSessionCookie } from '../lib/session-cookie.js';
import { bindShadowUserOnLogin } from '../scim/shadow-binding.js';
import { enrollNewUserInLoops } from '../email/loops.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Auth0User {
  sub: string;
  email: string;
  name: string;
  /**
   * True only if the upstream IdP attested that this email is verified:
   *   - Auth0: directly from the `email_verified` claim.
   *   - Entra: the token's `tid` is in `config.entraTrustedTenantIds`
   *     (Entra does not emit `email_verified`, but we trust verification
   *     done by tenants we've explicitly enrolled).
   * Code that consumes this field MUST refuse identity decisions (admin
   * gates, email-keyed merges, domain claims, …) when it's false. Legacy
   * cookies pre-dating this field decode to false, gating them safely.
   */
  emailVerified: boolean;
}

// Session cookie stores JSON: { sub, email, name, emailVerified }
const SESSION_COOKIE = 'gateway_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

const RETURN_TO_COOKIE = 'auth0_return_to';

// ---------------------------------------------------------------------------
// Fastify augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    auth0User: Auth0User | null;
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function auth0Plugin(sql: postgres.Sql) {
  return fp(async function plugin(app: FastifyInstance): Promise<void> {
    // Skip registration if Auth0 is not configured
    if (!config.auth0Domain || !config.auth0ClientId || !config.auth0ClientSecret) {
      app.log.warn('Auth0 not configured — skipping auth0 plugin registration');
      app.decorateRequest('auth0User', null);
      return;
    }

    // -----------------------------------------------------------------------
    // OIDC Discovery
    // -----------------------------------------------------------------------

    const issuer = new URL(`https://${config.auth0Domain}`);

    // Derive the callback URL from the incoming request when AUTH0_CALLBACK_URL
    // isn't explicitly set. The gateway is reachable on multiple hosts
    // (mcp.wyre.ai, staging.conduit.wyre.ai); pinning the callback to a single
    // host strands the session cookie when the user starts on the other host.
    function resolveCallbackUrl(request: Pick<FastifyRequest, 'headers' | 'protocol'>): string {
      if (config.auth0CallbackUrl) return config.auth0CallbackUrl;
      return `${getRequestBaseUrl(request, config.allowedHosts)}/auth/callback`;
    }

    const oidcConfig = await oidc.discovery(
      issuer,
      config.auth0ClientId,
      config.auth0ClientSecret,
    );

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        email       TEXT UNIQUE NOT NULL,
        name        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // last_login retrofit (companion to the additive-ALTER pattern below):
    // pre-existing DBs that were created before last_login was added to
    // the CREATE TABLE never received the column, so the
    // /auth/microsoft/callback path's UPDATE fails with 42703 in
    // production-like envs. Idempotent IF NOT EXISTS; existing rows pick
    // up DEFAULT NOW() at apply-time. Same fix landed in azure-ad.ts.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

    // Profile fields (added after initial schema)
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;

    // PKCE verifiers stored server-side, keyed by OAuth state parameter.
    // This avoids cookie race conditions when multiple concurrent login
    // requests overwrite the same cookie.
    await sql`
      CREATE TABLE IF NOT EXISTS auth_state (
        state          TEXT PRIMARY KEY,
        code_verifier  TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Clean up expired auth_state rows (older than 10 minutes)
    await sql`DELETE FROM auth_state WHERE created_at < NOW() - INTERVAL '10 minutes'`;

    // -----------------------------------------------------------------------
    // Request decorator — parse session cookie on every request
    // -----------------------------------------------------------------------

    app.decorateRequest('auth0User', null);

    app.addHook('onRequest', async (request, _reply) => {
      const raw = request.unsignCookie(request.cookies[SESSION_COOKIE] ?? '');
      if (!raw.valid || !raw.value) {
        request.auth0User = null;
        return;
      }
      // decodeSessionCookie reads emailVerified as `false` for legacy cookies
      // that pre-date the field, so identity gates that consume it stay safe
      // until the user re-logs in.
      request.auth0User = decodeSessionCookie(raw.value);
    });

    // -----------------------------------------------------------------------
    // Helper: set / clear cookies
    // -----------------------------------------------------------------------

    const isSecure = config.baseUrl.startsWith('https://');

    function setSessionCookie(reply: FastifyReply, user: Auth0User): void {
      const encoded = Buffer.from(JSON.stringify(user)).toString('base64');
      reply.setCookie(SESSION_COOKIE, encoded, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax', // lax needed for Auth0 redirect back
        secure: isSecure,
        signed: true,
        maxAge: SESSION_MAX_AGE,
      });
    }

    function clearSessionCookie(reply: FastifyReply): void {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    }

    // -----------------------------------------------------------------------
    // GET /auth/login
    // -----------------------------------------------------------------------

    // Shared login/signup redirect logic
    async function redirectToAuth0(
      request: FastifyRequest<{ Querystring: { return_to?: string } }>,
      reply: FastifyReply,
      screenHint?: string,
    ): Promise<void> {
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = randomUUID();

      // Store verifier server-side keyed by state (no cookie race condition)
      await sql`
        INSERT INTO auth_state (state, code_verifier)
        VALUES (${state}, ${codeVerifier})
      `;

      // Store return_to URL if provided. Reject anything that isn't a same-
      // origin absolute path; without this, an attacker can craft a login URL
      // like /auth/login?return_to=//evil.com that ends up in a Location
      // header after the OAuth dance.
      const rawReturn = request.query.return_to;
      const returnTo = isSafePath(rawReturn) ? rawReturn : '/settings';
      reply.setCookie(RETURN_TO_COOKIE, returnTo, {
        path: '/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
        signed: true,
        maxAge: 300,
      });

      const params: Record<string, string> = {
        redirect_uri: resolveCallbackUrl(request),
        scope: 'openid profile email',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      };
      if (screenHint) {
        params.screen_hint = screenHint;
      }

      const authUrl = oidc.buildAuthorizationUrl(oidcConfig, params);
      return reply.redirect(authUrl.href, 302);
    }

    app.get<{ Querystring: { return_to?: string } }>(
      '/auth/login',
      async (request, reply) => redirectToAuth0(request, reply),
    );

    app.get<{ Querystring: { return_to?: string } }>(
      '/auth/signup',
      async (request, reply) => redirectToAuth0(request, reply, 'signup'),
    );

    // -----------------------------------------------------------------------
    // GET /auth/callback
    // -----------------------------------------------------------------------

    app.get('/auth/callback', async (request, reply) => {
      // openid-client derives redirect_uri from this URL — must match the
      // redirect_uri sent at authorize time. Use the request's actual host,
      // not config.baseUrl. See resolveCallbackUrl above.
      // Extract state from the callback URL to look up the PKCE verifier
      const currentUrl = new URL(
        `${getRequestBaseUrl(request, config.allowedHosts)}${request.url}`,
      );
      const state = currentUrl.searchParams.get('state');
      if (!state) {
        app.log.warn('Auth0 callback missing state parameter');
        return reply.code(400).send('Missing state parameter. Please try logging in again.');
      }

      // Look up and consume the PKCE verifier (one-time use)
      const rows = await sql`
        DELETE FROM auth_state WHERE state = ${state} RETURNING code_verifier
      `;
      if (rows.length === 0) {
        app.log.warn({ state }, 'Auth0 callback: no matching auth_state row (expired or already used)');
        return reply.code(400).send('Login session expired or already used. Please try again.');
      }

      const codeVerifier = rows[0].code_verifier;

      // Exchange the authorization code for tokens
      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(
          oidcConfig,
          currentUrl,
          { pkceCodeVerifier: codeVerifier, expectedState: state },
        );
      } catch (err: unknown) {
        const cause = (err as { cause?: { error?: string; error_description?: string } })?.cause;
        app.log.error({
          error: cause?.error || (err instanceof Error ? err.message : String(err)),
          errorDescription: cause?.error_description,
          state,
        }, 'Auth0 token exchange failed');
        const errorDetail = cause?.error_description || 'token exchange error';
        const issueParams = new URLSearchParams({
          title: '[Gateway] Auth0 login failed',
          body: `## Bug Report\n\n**Error:** ${errorDetail}\n**Timestamp:** ${new Date().toISOString()}\n\n## Additional Context\n<!-- Add any other context about the problem here -->`,
          labels: 'bug,gateway',
        });
        const reportUrl = `${brand.issuesUrl}?${issueParams.toString()}`;
        return reply.code(502).send(
          `Auth0 login failed: ${errorDetail}. Please try again. | <a href="${reportUrl}">Report this issue</a>`,
        );
      }

      // Extract user identity from ID token claims
      const claims = tokens.claims();
      if (!claims || !claims.sub) {
        return reply.code(500).send('No identity claims returned from Auth0.');
      }

      let sub = claims.sub as string;
      const email = (claims.email as string) || '';
      const name = (claims.name as string) || '';
      // Auth0 emits email_verified directly. Anything else (missing claim,
      // string 'true') is treated as unverified — gates downstream of this
      // field MUST fail closed.
      const emailVerified = claims.email_verified === true;

      await bindShadowUserOnLogin(sql, sub, email);

      // Upsert user in the database. ON CONFLICT (id) covers the common case
      // and tells us via RETURNING (xmax = 0) whether this was a new insert
      // (drives Loops enrollment). The 23505 catch handles the rarer
      // email-unique race where two concurrent first-login requests for the
      // same email both see no user and race the INSERT.
      let isNewUser = false;
      try {
        const [{ is_new }] = await sql<{ is_new: boolean }[]>`
          INSERT INTO users (id, email, name, last_login)
          VALUES (${sub}, ${email}, ${name}, NOW())
          ON CONFLICT (id) DO UPDATE SET
            email      = EXCLUDED.email,
            name       = EXCLUDED.name,
            last_login = NOW()
          RETURNING (xmax = 0) AS is_new
        `;
        isNewUser = is_new;
      } catch (insertErr: unknown) {
        const code = (insertErr && typeof insertErr === 'object' && 'code' in insertErr)
          ? (insertErr as { code: string }).code
          : null;
        if (code !== '23505') throw insertErr;
        // Email-unique race: another request inserted the same email first.
        // Re-fetch by lowercased email and adopt that row's sub. The winner's
        // path enrolled in Loops; this loser stays isNewUser=false.
        const winner = await sql`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1
        `;
        if (winner.length > 0 && winner[0].id !== sub) {
          request.log.warn(
            { winnerId: winner[0].id, claimedSub: sub, email },
            'auth0 login: email-unique race, adopting winner row id',
          );
          sub = winner[0].id as string;
          await sql`UPDATE users SET last_login = NOW() WHERE id = ${sub}`;
        }
      }

      if (isNewUser) enrollNewUserInLoops(app.log, email, name);

      // Set the gateway session cookie
      const user: Auth0User = { sub, email, name, emailVerified };
      setSessionCookie(reply, user);

      // Redirect to the return_to URL or settings. Re-validate the path even
      // though we sanitised on write — defense in depth in case the cookie
      // ever gets populated by a different code path.
      const returnToCookie = request.unsignCookie(request.cookies[RETURN_TO_COOKIE] ?? '');
      const returnTo = (returnToCookie.valid && returnToCookie.value && isSafePath(returnToCookie.value))
        ? returnToCookie.value
        : '/settings';
      reply.clearCookie(RETURN_TO_COOKIE, { path: '/auth' });

      return reply.redirect(returnTo, 302);
    });

    // -----------------------------------------------------------------------
    // GET /auth/logout
    // -----------------------------------------------------------------------

    app.get('/auth/logout', async (_request, reply) => {
      clearSessionCookie(reply);

      // Redirect to Auth0 logout endpoint which clears Auth0's session,
      // then Auth0 redirects back to our base URL.
      const logoutUrl = new URL(`https://${config.auth0Domain}/v2/logout`);
      logoutUrl.searchParams.set('client_id', config.auth0ClientId);
      logoutUrl.searchParams.set('returnTo', config.baseUrl);

      return reply.redirect(logoutUrl.href, 302);
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: require Auth0 session or redirect to login
// ---------------------------------------------------------------------------

export function requireAuth0(request: FastifyRequest, reply: FastifyReply): Auth0User | null {
  if (request.auth0User) {
    return request.auth0User;
  }

  const returnTo = request.url;
  reply.redirect(`/auth/login?return_to=${encodeURIComponent(returnTo)}`, 302);
  return null;
}
