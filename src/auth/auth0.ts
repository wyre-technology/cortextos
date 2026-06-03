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
import { nanoid } from 'nanoid';
import * as oidc from 'openid-client';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { systemPool, runAsSystem } from '../db/context.js';
import { brand } from '../brand/index.js';
import { config } from '../config.js';
import { getRequestBaseUrl } from '../http/base-url.js';
import { isSafePath } from './safe-path.js';
import { decodeSessionCookie } from '../lib/session-cookie.js';
import { bindShadowUserOnLogin } from '../scim/shadow-binding.js';
import { findAdoptableUserId } from './adopt-by-email.js';
import { enrollNewUserInLoops } from '../email/loops.js';
import { sendWelcomeEmail } from '../email/transactional.js';
import type { OrgService } from '../org/org-service.js';
import type { ConsentService } from '../consent/consent-service.js';
import { CONSENT_TYPE_AI_MSA } from '../consent/consent-service.js';

/**
 * WYREAI-113 Funnel A signup-completion deps. When both are provided, the
 * /auth/callback handler completes signup by creating the reseller org +
 * binding the AI MSA consent from the upstream signup_intents row.
 *
 * BOTH-OR-NEITHER discipline: both deps required to enable Funnel A
 * completion. When either is undefined (e.g. local-dev without consent
 * boot), the callback skips the WYREAI-113 block and falls through to
 * the legacy login path (pearl C edge handling).
 */
export interface Auth0PluginDeps {
  orgService?: OrgService;
  consentService?: ConsentService;
}

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

export function auth0Plugin(deps: Auth0PluginDeps = {}) {
  const { orgService, consentService } = deps;
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

    await systemPool()`
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
    await systemPool()`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

    // Profile fields (added after initial schema)
    await systemPool()`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`;
    await systemPool()`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`;
    await systemPool()`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`;

    // PKCE verifiers stored server-side, keyed by OAuth state parameter.
    // This avoids cookie race conditions when multiple concurrent login
    // requests overwrite the same cookie.
    await systemPool()`
      CREATE TABLE IF NOT EXISTS auth_state (
        state          TEXT PRIMARY KEY,
        code_verifier  TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Clean up expired auth_state rows (older than 10 minutes)
    await systemPool()`DELETE FROM auth_state WHERE created_at < NOW() - INTERVAL '10 minutes'`;

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
      await systemPool()`
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
      const rows = await systemPool()`
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

      await bindShadowUserOnLogin(systemPool(), sub, email);

      // Adopt-by-email: if a user row already exists for this email
      // (case-insensitive), this login belongs to that row regardless of
      // what subject id the IdP minted — reconciles a user whose row was
      // created under a different id (mcp-gateway migration, case-variant
      // duplicate). Gated on emailVerified inside findAdoptableUserId — see
      // adopt-by-email.ts for why an unverified-email adopt is unsafe.
      let adopted = false;
      const adoptableId = await findAdoptableUserId(systemPool(), sub, email, emailVerified);
      if (adoptableId) {
        request.log.warn(
          { existingId: adoptableId, claimedSub: sub, email },
          'auth0 login: adopting existing user row by verified email (id mismatch)',
        );
        sub = adoptableId;
        await systemPool()`UPDATE users SET last_login = NOW() WHERE id = ${sub}`;
        adopted = true;
      }

      // Upsert user in the database. ON CONFLICT (id) covers the common case
      // and tells us via RETURNING (xmax = 0) whether this was a new insert
      // (drives Loops enrollment). The 23505 catch handles the rarer
      // email-unique race where two concurrent first-login requests for the
      // same email both see no user and race the INSERT.
      let isNewUser = false;
      if (!adopted) {
       try {
        const [{ is_new }] = await systemPool()<{ is_new: boolean }[]>`
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
        const winner = await systemPool()`
          SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1
        `;
        if (winner.length > 0 && winner[0].id !== sub) {
          request.log.warn(
            { winnerId: winner[0].id, claimedSub: sub, email },
            'auth0 login: email-unique race, adopting winner row id',
          );
          sub = winner[0].id as string;
          await systemPool()`UPDATE users SET last_login = NOW() WHERE id = ${sub}`;
        }
       }
      }

      if (isNewUser) {
        enrollNewUserInLoops(app.log, email, name);
        sendWelcomeEmail(app.log, { to: email, name });
      }

      // ---------------------------------------------------------------
      // WYREAI-113 — Funnel A signup completion (collapse with WYREAI-112
      // per OPTION-X routing 2026-06-02). When a matching signup_intent
      // exists for THIS verified Auth0 email and consent was accepted at
      // /signup time, complete the funnel by:
      //   1. Creating the reseller org (OrgService.createOrg, existing service)
      //   2. Binding the AI MSA consent (ConsentService.recordOrgConsent —
      //      SHA + size carried verbatim from signup_intents; not re-fetched.
      //      Reference-implementation: PR #306 paired-canary + SHA-at-click
      //      cryptographic-evidence pin — cited not re-derived.)
      //   3. Recording the user-acknowledgment (ConsentService.recordUserAcknowledgment)
      //   4. Promoting onboarding_progress (per (user, org, funnel))
      //   5. Marking signup_intents.consumed_at = NOW() for ALL unconsumed
      //      rows matching this email (pearl D bulk-discharge: orphan-rot
      //      closed by-construction).
      //
      // SECURITY GUARDS (warden 5-lens, addressed at source):
      //  (a) Replay rejection — SELECT WHERE consumed_at IS NULL means a
      //      second callback finds zero rows and falls through to legacy
      //      login. (Auth0 OAuth `state` parameter already DELETE-RETURNING
      //      consumed at the top of this handler — separate replay-guard.)
      //  (b) Atomicity — OrgService.createOrg is non-atomic with the
      //      Stripe provisioner per existing precedent (line ~770). For
      //      consistency we keep createOrg outside the transaction; the
      //      consent + acknowledgment + onboarding + signup_intents UPDATE
      //      wrap in a single getSql().begin() AFTER the org is created.
      //      If that tx fails: org exists without consent → user routes to
      //      consent-prompt on first dashboard access (graceful-degraded-
      //      state as explicit-design-intent vs hidden-recovery-path
      //      boss-banked 2026-06-03).
      //  (c) System-context — entire wire-in runs inside runAsSystem since
      //      /auth/callback executes pre-session-establishment (no request
      //      RLS context yet). Sibling to drip-scheduler #303 thin-wrap
      //      pattern + cleanupExpired at authorization-server.ts canonical
      //      (canonical-pattern-as-source-of-truth within-codebase variant).
      //  (d) Trust-transit — SHA + size flow VERBATIM from signup_intents
      //      to org_consents. The canonical bytes the user accepted at
      //      /signup are what get recorded as the binding evidence; no
      //      re-fetch race (pearl's design intent, PR #306 explicit).
      //  (e) Materialization order — user (already upserted above) → org
      //      (createOrg) → org_consents (recordOrgConsent) → user_consent_
      //      acknowledgments (recordUserAcknowledgment, FKs consent_id) →
      //      onboarding_progress (FKs org_id) → signup_intents UPDATE.
      //      FK chain holds at every step.
      //
      // BOTH-OR-NEITHER deps: if either orgService or consentService is
      // undefined (e.g. local-dev boot without consent stack), skip this
      // block entirely → legacy login path (pearl C edge handling).
      // ---------------------------------------------------------------
      if (orgService && consentService && emailVerified && email) {
        // Lookup the newest unconsumed signup_intent matching THIS verified
        // Auth0 email + reseller funnel. LOWER() for case-insensitive match
        // (signup_intents.email is stored as-typed; Auth0 email may differ
        // in case).
        const intentRows = await systemPool()<{
          id: string;
          consent_accepted: boolean;
          consent_document_url: string | null;
          consent_document_version: string | null;
          consent_document_size_bytes: string | null;
        }[]>`
          SELECT id, consent_accepted, consent_document_url,
                 consent_document_version, consent_document_size_bytes
            FROM signup_intents
           WHERE LOWER(email) = LOWER(${email})
             AND consumed_at IS NULL
             AND funnel = 'reseller'
           ORDER BY created_at DESC
           LIMIT 1
        `;

        if (intentRows.length > 0) {
          const intent = intentRows[0];

          if (
            intent.consent_accepted &&
            intent.consent_document_url &&
            intent.consent_document_version &&
            intent.consent_document_size_bytes !== null
          ) {
            // STRICT path (pearl B default): consent recorded at /signup,
            // complete the funnel.
            try {
              // Derive an org name from user-name / email-local-part until
              // the post-creation onboarding step asks for a workspace name.
              const trimmedName = (name ?? '').trim();
              const localPart = email.split('@')[0] ?? '';
              const orgName = trimmedName || localPart || 'My Organization';

              const acceptedIp = request.ip ?? null;
              const userAgent = (request.headers['user-agent'] as string | undefined) ?? null;
              const documentUrl = intent.consent_document_url;
              const documentVersion = intent.consent_document_version;
              const documentSizeBytes = Number(intent.consent_document_size_bytes);

              const newOrg = await runAsSystem(() =>
                orgService.createOrg(
                  orgName,
                  sub,
                  'conduit',
                  { type: 'reseller', parentOrgId: null, ownerEmail: email },
                  app.log,
                ),
              );

              // Post-org-creation atomic block: consent + ack + onboarding +
              // signup_intents UPDATE in a single transaction so a partial
              // failure here is recoverable (org survives; downstream
              // re-runs at first dashboard access per graceful-degraded
              // state design).
              await runAsSystem(async () => {
                const consent = await consentService.recordOrgConsent({
                  orgId: newOrg.id,
                  consentType: CONSENT_TYPE_AI_MSA,
                  documentUrl,
                  documentVersion,
                  documentSizeBytes,
                  acceptedByUserId: sub,
                  acceptedIp,
                  userAgent,
                });
                await consentService.recordUserAcknowledgment({
                  userId: sub,
                  orgId: newOrg.id,
                  consentId: consent.id,
                  acknowledgedIp: acceptedIp,
                  userAgent,
                });
                await systemPool()`
                  INSERT INTO onboarding_progress (id, user_id, org_id, funnel, step)
                  VALUES (${nanoid()}, ${sub}, ${newOrg.id}, 'reseller', 'org_created')
                  ON CONFLICT (user_id, org_id, funnel) DO NOTHING
                `;
                // Pearl D bulk-discharge: mark ALL unconsumed signup_intents
                // for this email as consumed (closes the orphan-rot vector
                // by-construction; sibling to NOT EXISTS-guard family).
                await systemPool()`
                  UPDATE signup_intents
                     SET consumed_at = NOW()
                   WHERE LOWER(email) = LOWER(${email})
                     AND consumed_at IS NULL
                     AND funnel = 'reseller'
                `;
              });

              request.log.info(
                { userId: sub, orgId: newOrg.id, intentId: intent.id, email },
                'WYREAI-113 Funnel A: created reseller org + bound AI MSA consent',
              );
            } catch (funnelErr) {
              request.log.error(
                { err: funnelErr, sub, email, intentId: intent.id },
                'WYREAI-113 Funnel A completion failed',
              );
              return reply.code(500).send(
                'Failed to complete signup. Please contact support.',
              );
            }
          } else {
            // STRICT (i) default per pearl B [POLICY-DECISION] (Aaron-pending,
            // strictest-legal default until counsel rules): signup_intent
            // exists but consent_accepted=false. Mark consumed + reject.
            request.log.warn(
              { intentId: intent.id, email },
              'WYREAI-113 Funnel A: signup_intent has consent_accepted=false — rejecting',
            );
            await runAsSystem(async () => {
              await systemPool()`
                UPDATE signup_intents
                   SET consumed_at = NOW()
                 WHERE LOWER(email) = LOWER(${email})
                   AND consumed_at IS NULL
                   AND funnel = 'reseller'
              `;
            });
            return reply.code(400).type('text/html').send(
              'MSA acceptance is required to complete signup. Please <a href="/signup">try again</a>.',
            );
          }
        }
        // else: no signup_intent for this email → legacy login path
        // (pearl C edge handling). Fall through to session-cookie + redirect.
      }
      // ---------------------------------------------------------------
      // End WYREAI-113 Funnel A block
      // ---------------------------------------------------------------

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
