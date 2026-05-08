/**
 * Azure AD OIDC middleware — Fastify plugin
 *
 * Provides user authentication via Azure AD (multi-tenant) using the
 * authorization code flow with PKCE. PKCE verifiers are stored server-side
 * in PostgreSQL (keyed by the OAuth `state` parameter) to avoid cookie
 * race conditions from concurrent login requests. Exposes:
 *
 *   GET  /auth/login    — Redirect to Azure AD login
 *   GET  /auth/callback — Handle Azure AD return, upsert user, set session
 *   GET  /auth/logout   — Clear session and redirect to Azure AD logout
 *
 * Decorates requests with `auth0User` (reuses the same request property
 * for compatibility) when an active session exists.
 *
 * Multi-tenant: uses the /common/ endpoint so any Azure AD org can sign in.
 * Customer onboarding is handled separately via admin-consent.ts.
 */

import { randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type postgres from 'postgres';
import { brand } from '../brand/index.js';
import { config } from '../config.js';
import { enrollNewUserInLoops } from '../email/loops.js';
import { getRequestBaseUrl } from '../http/base-url.js';
import { isSafePath } from './safe-path.js';
import { decodeSessionCookie } from '../lib/session-cookie.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AzureAdUser {
  /** Azure AD object ID (oid claim) */
  sub: string;
  email: string;
  name: string;
  /** Azure AD tenant ID (tid claim) */
  tenantId: string;
  /**
   * True only if the user's tenant id is in `config.entraTrustedTenantIds`.
   * Microsoft tokens don't include `email_verified`, so we treat email from
   * a token whose `tid` we've enrolled as verified. Any code consuming this
   * field MUST refuse identity decisions when it's false. Maps to the same
   * field on Auth0User so admin / merge / claim gates can use one shape.
   */
  emailVerified: boolean;
}

// Session cookie stores JSON: { sub, email, name, tenantId }
const SESSION_COOKIE = 'gateway_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

const RETURN_TO_COOKIE = 'azure_ad_return_to';

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function azureAdPlugin(sql: postgres.Sql) {
  return fp(async function plugin(app: FastifyInstance): Promise<void> {
    // Skip registration if Azure AD is not configured
    if (!config.azureClientId || !config.azureClientSecret) {
      app.log.warn('Azure AD not configured — skipping azureAd plugin registration');
      app.decorateRequest('auth0User', null);
      return;
    }

    // -----------------------------------------------------------------------
    // OIDC Discovery — multi-tenant endpoint
    // -----------------------------------------------------------------------

    const issuer = new URL('https://login.microsoftonline.com/common/v2.0');
    // Derive the callback URL from the incoming request when AZURE_AD_CALLBACK_URL
    // isn't explicitly set. The gateway is reachable on multiple hosts; pinning
    // the callback to a single host strands the session cookie on the other host.
    function resolveCallbackUrl(request: Pick<FastifyRequest, 'headers' | 'protocol'>): string {
      if (config.azureCallbackUrl) return config.azureCallbackUrl;
      return `${getRequestBaseUrl(request, config.allowedHosts)}/auth/callback`;
    }

    const oidcConfig = await oidc.discovery(
      issuer,
      config.azureClientId,
      config.azureClientSecret,
    );

    // -----------------------------------------------------------------------
    // Tables (same schema as Auth0 plugin for compatibility)
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

    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id TEXT`;

    // PKCE verifiers stored server-side, keyed by OAuth state parameter.
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

    function setSessionCookie(reply: FastifyReply, user: AzureAdUser): void {
      const encoded = Buffer.from(JSON.stringify(user)).toString('base64');
      reply.setCookie(SESSION_COOKIE, encoded, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
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

    async function redirectToAzureAd(
      request: FastifyRequest<{ Querystring: { return_to?: string } }>,
      reply: FastifyReply,
    ): Promise<void> {
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = randomUUID();

      // Store verifier server-side keyed by state
      await sql`
        INSERT INTO auth_state (state, code_verifier)
        VALUES (${state}, ${codeVerifier})
      `;

      // Store return_to URL if provided. Reject anything that isn't a same-
      // origin absolute path; without this an attacker can craft a login URL
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
        // prompt=select_account lets users pick which org account to use
        prompt: 'select_account',
      };

      const authUrl = oidc.buildAuthorizationUrl(oidcConfig, params);
      return reply.redirect(authUrl.href, 302);
    }

    app.get<{ Querystring: { return_to?: string } }>(
      '/auth/login',
      async (request, reply) => redirectToAzureAd(request, reply),
    );

    // -----------------------------------------------------------------------
    // GET /auth/callback
    // -----------------------------------------------------------------------

    app.get('/auth/callback', async (request, reply) => {
      // openid-client derives redirect_uri from this URL; must match what was
      // sent at authorize time. Use the request's actual host, not config.baseUrl.
      const currentUrl = new URL(`${getRequestBaseUrl(request, config.allowedHosts)}${request.url}`);
      const state = currentUrl.searchParams.get('state');
      if (!state) {
        app.log.warn('Azure AD callback missing state parameter');
        return reply.code(400).send('Missing state parameter. Please try logging in again.');
      }

      // Look up and consume the PKCE verifier (one-time use)
      const rows = await sql`
        DELETE FROM auth_state WHERE state = ${state} RETURNING code_verifier
      `;
      if (rows.length === 0) {
        app.log.warn({ state }, 'Azure AD callback: no matching auth_state row (expired or already used)');
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
        }, 'Azure AD token exchange failed');
        const errorDetail = cause?.error_description || 'token exchange error';
        const issueParams = new URLSearchParams({
          title: '[Gateway] Azure AD login failed',
          body: `## Bug Report\n\n**Error:** ${errorDetail}\n**Timestamp:** ${new Date().toISOString()}\n\n## Additional Context\n<!-- Add any other context about the problem here -->`,
          labels: 'bug,gateway',
        });
        const reportUrl = `${brand.issuesUrl}?${issueParams.toString()}`;
        return reply.code(502).send(
          `Azure AD login failed: ${errorDetail}. Please try again. | <a href="${reportUrl}">Report this issue</a>`,
        );
      }

      // Extract user identity from ID token claims
      const claims = tokens.claims();
      if (!claims || !claims.sub) {
        return reply.code(500).send('No identity claims returned from Azure AD.');
      }

      // Azure AD specific claims
      const oid = (claims.oid as string) || (claims.sub as string);
      const tid = (claims.tid as string) || '';
      const email = (claims.preferred_username as string) || (claims.email as string) || '';
      const name = (claims.name as string) || '';

      // Use oid as the user ID (stable across tenants)
      let sub = oid;

      // Upsert user in the database. ON CONFLICT (id) covers the common case
      // and tells us via RETURNING (xmax = 0) whether this was a new insert
      // (drives Loops enrollment). The 23505 catch handles the rarer
      // email-unique race.
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
        const winner = await sql`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1
        `;
        if (winner.length > 0 && winner[0].id !== sub) {
          request.log.warn(
            { winnerId: winner[0].id, claimedSub: sub, email },
            'azure-ad login: email-unique race, adopting winner row id',
          );
          sub = winner[0].id as string;
          await sql`UPDATE users SET last_login = NOW() WHERE id = ${sub}`;
        }
      }

      if (tid) {
        await sql`UPDATE users SET tenant_id = ${tid} WHERE id = ${sub}`;
      }

      if (isNewUser) enrollNewUserInLoops(app.log, email, name);

      // Microsoft tokens lack email_verified; we trust verification only when
      // the user's tenant id is on the explicit allowlist. Empty allowlist
      // (default) means every Entra session arrives with emailVerified=false.
      const emailVerified = tid !== '' && config.entraTrustedTenantIds.has(tid);

      // Set the gateway session cookie
      const user: AzureAdUser = { sub, email, name, tenantId: tid, emailVerified };
      setSessionCookie(reply, user);

      // Redirect to the return_to URL or settings. Re-validate even though
      // we sanitised on write — defense in depth in case the cookie ever
      // gets populated by a different code path.
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

      // Redirect to Azure AD logout endpoint
      const logoutUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/logout');
      logoutUrl.searchParams.set('post_logout_redirect_uri', config.baseUrl);

      return reply.redirect(logoutUrl.href, 302);
    });
  });
}
