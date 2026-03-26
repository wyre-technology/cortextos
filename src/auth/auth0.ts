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
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Auth0User {
  sub: string;
  email: string;
  name: string;
}

// Session cookie stores JSON: { sub, email, name }
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
    const callbackUrl = config.auth0CallbackUrl || `${config.baseUrl}/auth/callback`;

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

      try {
        const json = Buffer.from(raw.value, 'base64').toString('utf8');
        request.auth0User = JSON.parse(json) as Auth0User;
      } catch {
        request.auth0User = null;
      }
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

      // Store return_to URL if provided
      const returnTo = request.query.return_to || '/settings';
      reply.setCookie(RETURN_TO_COOKIE, returnTo, {
        path: '/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
        signed: true,
        maxAge: 300,
      });

      const params: Record<string, string> = {
        redirect_uri: callbackUrl,
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
      // Extract state from the callback URL to look up the PKCE verifier
      const currentUrl = new URL(
        `${config.baseUrl}${request.url}`,
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
        const reportUrl = `https://github.com/wyre-technology/msp-claude-plugins/issues/new?${issueParams.toString()}`;
        return reply.code(502).send(
          `Auth0 login failed: ${errorDetail}. Please try again. | <a href="${reportUrl}">Report this issue</a>`,
        );
      }

      // Extract user identity from ID token claims
      const claims = tokens.claims();
      if (!claims || !claims.sub) {
        return reply.code(500).send('No identity claims returned from Auth0.');
      }

      const sub = claims.sub as string;
      const email = (claims.email as string) || '';
      const name = (claims.name as string) || '';

      // Upsert user in the database
      await sql`
        INSERT INTO users (id, email, name, last_login)
        VALUES (${sub}, ${email}, ${name}, NOW())
        ON CONFLICT (id) DO UPDATE SET
          email      = EXCLUDED.email,
          name       = EXCLUDED.name,
          last_login = NOW()
      `;

      // Set the gateway session cookie
      const user: Auth0User = { sub, email, name };
      setSessionCookie(reply, user);

      // Redirect to the return_to URL or settings
      const returnToCookie = request.unsignCookie(request.cookies[RETURN_TO_COOKIE] ?? '');
      const returnTo = (returnToCookie.valid && returnToCookie.value) ? returnToCookie.value : '/settings';
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
