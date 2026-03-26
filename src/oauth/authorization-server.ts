/**
 * OAuth 2.1 + PKCE Authorization Server — Fastify plugin
 *
 * Implements the following endpoints:
 *   GET  /.well-known/oauth-authorization-server — RFC 8414 metadata
 *   POST /oauth/register                        — Dynamic Client Registration (RFC 7591)
 *   GET  /oauth/authorize                       — Authorization endpoint (PKCE required)
 *   POST /oauth/token                           — Token endpoint (code exchange + refresh)
 *   POST /oauth/revoke                          — Token revocation (RFC 7009)
 *
 * Additionally exports `completeAuthorization` for use by the credential
 * entry web handler once the user has stored their vendor credentials.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { nanoid } from 'nanoid';

import { config } from '../config.js';
import { getMetadata, getProtectedResourceMetadata, getVendorAuthMetadata } from './metadata.js';
import { getVendor } from '../credentials/vendor-config.js';
import { TokenStore } from './token-store.js';
import type { AuthCode, OAuthSession } from './token-store.js';
import type { Auth0User } from '../auth/auth0.js';
import type { OrgService } from '../org/org-service.js';

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function getSigningKey(): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

interface AccessTokenPayload {
  sub: string;
  scope: string;
  vendor: string;
  iss: string;
}

async function issueAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(getSigningKey());
}

// ---------------------------------------------------------------------------
// PKCE S256 verification
// ---------------------------------------------------------------------------

function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Vendor extraction from scope
// ---------------------------------------------------------------------------

/** Extracts vendor from scope string, e.g. "mcp:datto-rmm" -> "datto-rmm". */
function extractVendor(scope: string): string {
  for (const part of scope.split(' ')) {
    if (part.startsWith('mcp:')) {
      return part.slice(4);
    }
  }
  return '';
}

/** Extracts vendor from a resource URL like https://host/v1/autotask/mcp. */
function extractVendorFromResource(resource: string): string {
  try {
    const url = new URL(resource);
    const match = url.pathname.match(/^\/v1\/([^/]+)\/mcp$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Credential existence check across all tiers (personal → team → org)
// Mirrors the resolution order in credential-injector.ts so the authorize
// endpoint correctly skips the connect page for team/org-connected vendors.
// ---------------------------------------------------------------------------

export interface CredentialChecker {
  has(userId: string, vendorSlug: string): Promise<boolean>;
  getOrgCredential(orgId: string, vendorSlug: string): Promise<Record<string, string> | null>;
  getTeamCredential(teamId: string, vendorSlug: string): Promise<Record<string, string> | null>;
}

export async function userHasAnyCredentials(
  userId: string,
  vendor: string,
  credentialService: CredentialChecker,
  orgService?: OrgService,
): Promise<boolean> {
  // 1. Personal credentials
  if (await credentialService.has(userId, vendor)) return true;

  // 2. Team / org credentials (same resolution order as credential-injector.ts)
  if (!orgService) return false;

  const orgs = await orgService.getUserOrgs(userId);
  for (const org of orgs) {
    // Team tier first
    const userTeams = await orgService.getUserTeams(org.id, userId);
    const teamHits = (
      await Promise.all(
        userTeams.map(async (t) => ({
          t,
          has: (await credentialService.getTeamCredential(t.id, vendor)) !== null,
        })),
      )
    ).filter((x) => x.has);

    if (teamHits.length === 1) {
      const hasAccess = await orgService.hasServerAccess(org.id, userId, vendor);
      if (hasAccess) return true;
    }

    // Org tier
    const orgCred = await credentialService.getOrgCredential(org.id, vendor);
    if (orgCred) {
      const hasAccess = await orgService.hasServerAccess(org.id, userId, vendor);
      if (hasAccess) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public helper — called by the /connect/{vendor} web handler
// ---------------------------------------------------------------------------

/**
 * Complete the OAuth authorization flow after the user has successfully
 * stored their vendor credentials.
 *
 * Loads the stored OAuth session, generates an authorization code, and
 * returns the redirect URL with code and state parameters.
 */
export async function completeAuthorization(
  tokenStore: TokenStore,
  sessionId: string,
  userId: string,
): Promise<{ redirectUrl: string } | { error: string }> {
  const session = await tokenStore.getSession(sessionId);

  if (!session) {
    return { error: 'invalid_session' };
  }

  const code = nanoid(32);
  const expiresAt = new Date(
    Date.now() + config.authCodeTtlSeconds * 1000,
  ).toISOString();

  const vendor = session.vendor || extractVendor(session.scope);

  const authCode: AuthCode = {
    code,
    clientId: session.clientId,
    userId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    scope: session.scope,
    expiresAt,
    vendor,
  };

  await tokenStore.storeAuthCode(authCode);

  const redirectUrl = new URL(session.redirectUri);
  redirectUrl.searchParams.set('code', code);
  redirectUrl.searchParams.set('state', session.state);

  return { redirectUrl: redirectUrl.toString() };
}

// ---------------------------------------------------------------------------
// Request schemas (for type narrowing inside handlers)
// ---------------------------------------------------------------------------

interface RegisterBody {
  client_name: string;
  redirect_uris: string[];
}

interface AuthorizeQuery {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  resource?: string;
  vendor?: string;
}

interface TokenBody {
  grant_type: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  client_id?: string;
  refresh_token?: string;
}

interface RevokeBody {
  token: string;
}

// ---------------------------------------------------------------------------
// Fastify plugin (factory function)
// ---------------------------------------------------------------------------

// Cookie used to stash OAuth params while user authenticates with Auth0
const PENDING_AUTH_COOKIE = 'pending_auth';

export function oauthRoutes(
  tokenStore: TokenStore,
  credentialService?: CredentialChecker,
  orgService?: OrgService,
) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // Run cleanup on startup and then every 5 minutes
    await tokenStore.cleanupExpired();
    const cleanupInterval = setInterval(async () => {
      await tokenStore.cleanupExpired();
    }, 5 * 60 * 1000);

    app.addHook('onClose', () => {
      clearInterval(cleanupInterval);
    });

    // -----------------------------------------------------------------------
    // GET /.well-known/oauth-authorization-server
    // -----------------------------------------------------------------------

    app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
      const metadata = getMetadata(config.baseUrl);
      return reply.type('application/json').send(metadata);
    });

    // Per-vendor Protected Resource Metadata (RFC 9728)
    // The proxy 401 points MCP clients here via the resource_metadata header.
    // Also register the RFC-compliant well-known path (host/.well-known/.../path).
    app.get<{ Params: { vendor: string } }>(
      '/.well-known/oauth-protected-resource/v1/:vendor/mcp',
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;
        if (!getVendor(vendorSlug)) {
          return reply.code(404).send({ error: `Unknown vendor: ${vendorSlug}` });
        }
        const metadata = getProtectedResourceMetadata(config.baseUrl, vendorSlug);
        return reply.type('application/json').send(metadata);
      },
    );

    // Aggregated endpoint Protected Resource Metadata (RFC 9728)
    // Points to the same auth server; no vendor slug.
    app.get('/.well-known/oauth-protected-resource/mcp', async (_request, reply) => {
      return reply.type('application/json').send({
        resource: `${config.baseUrl}/mcp`,
        authorization_servers: [config.baseUrl],
      });
    });

    // Per-vendor Authorization Server Metadata (RFC 8414 §3)
    // RFC 8414 says the well-known URI is constructed by inserting
    // /.well-known/oauth-authorization-server BETWEEN host and path.
    // For issuer https://host/v1/autotask → https://host/.well-known/oauth-authorization-server/v1/autotask
    app.get<{ Params: { vendor: string } }>(
      '/.well-known/oauth-authorization-server/v1/:vendor',
      async (request, reply) => {
        const { vendor: vendorSlug } = request.params;
        if (!getVendor(vendorSlug)) {
          return reply.code(404).send({ error: `Unknown vendor: ${vendorSlug}` });
        }
        const metadata = getVendorAuthMetadata(config.baseUrl, vendorSlug);
        return reply.type('application/json').send(metadata);
      },
    );

    // -----------------------------------------------------------------------
    // POST /oauth/register — Dynamic Client Registration (RFC 7591)
    // -----------------------------------------------------------------------

    app.post('/oauth/register', {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    }, async (request, reply) => {
      const body = request.body as RegisterBody | undefined;

      if (!body?.client_name || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'client_name and at least one redirect_uri are required.',
        });
      }

      // Validate all redirect URIs are well-formed and use http(s)
      for (const uri of body.redirect_uris) {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return reply.status(400).send({
              error: 'invalid_request',
              error_description: `redirect_uri must use https (or http for localhost). Got: ${parsed.protocol}`,
            });
          }
        } catch {
          return reply.status(400).send({
            error: 'invalid_request',
            error_description: `Invalid redirect_uri: ${uri}`,
          });
        }
      }

      const client = await tokenStore.registerClient(body.client_name, body.redirect_uris);

      if (!client) {
        return reply.status(503).send({
          error: 'server_error',
          error_description: 'Maximum number of registered clients reached.',
        });
      }

      return reply.status(201).send({
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
      });
    });

    // -----------------------------------------------------------------------
    // GET /oauth/authorize
    // -----------------------------------------------------------------------

    app.get('/oauth/authorize', async (request, reply) => {
      const query = request.query as Partial<AuthorizeQuery>;

      // -- Validate required parameters ------------------------------------
      if (query.response_type !== 'code') {
        return reply.status(400).send({
          error: 'unsupported_response_type',
          error_description: 'Only response_type=code is supported.',
        });
      }

      if (!query.client_id || !query.redirect_uri || !query.state) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'client_id, redirect_uri, and state are required.',
        });
      }

      if (!query.code_challenge || query.code_challenge_method !== 'S256') {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'PKCE is required. Provide code_challenge with code_challenge_method=S256.',
        });
      }

      // -- Validate client -------------------------------------------------
      const client = await tokenStore.getClient(query.client_id);
      if (!client) {
        return reply.status(400).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id.',
        });
      }

      if (!client.redirectUris.includes(query.redirect_uri)) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'redirect_uri does not match any registered URI for this client.',
        });
      }

      // -- Determine vendor from query param, resource URL, or scope --------
      const scope = query.scope ?? 'mcp';
      const vendor = query.vendor
        || (query.resource ? extractVendorFromResource(query.resource) : '')
        || extractVendor(scope);

      // -- Check Auth0 session -----------------------------------------------
      const auth0User = (request as { auth0User?: Auth0User | null }).auth0User;

      // If no Auth0 session, stash OAuth params and redirect to Auth0 login
      if (!auth0User) {
        const pendingAuth = JSON.stringify({
          client_id: query.client_id,
          redirect_uri: query.redirect_uri,
          state: query.state,
          code_challenge: query.code_challenge,
          code_challenge_method: query.code_challenge_method,
          scope,
          vendor,
        });

        const isSecure = config.baseUrl.startsWith('https://');
        reply.setCookie(PENDING_AUTH_COOKIE, pendingAuth, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: isSecure,
          signed: true,
          maxAge: 300, // 5 minutes
        });

        // Redirect to Auth0 login, which will return to /oauth/authorize
        return reply.redirect(
          `/auth/login?return_to=${encodeURIComponent(request.url)}`,
          302,
        );
      }

      // -- User is authenticated via Auth0 -----------------------------------
      const userId = auth0User.sub;

      // -- Store OAuth session -----------------------------------------------
      const sessionId = nanoid(32);
      const session: OAuthSession = {
        sessionId,
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        state: query.state,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        scope,
        vendor,
        createdAt: new Date().toISOString(),
      };

      await tokenStore.storeSession(session);

      // Unified endpoint (no vendor): complete authorization immediately —
      // the user doesn't need vendor-specific credentials at auth time.
      // They'll connect vendors later via the web UI; the unified endpoint
      // discovers available vendors at tools/list time.
      if (!vendor) {
        const result = await completeAuthorization(tokenStore, sessionId, userId);
        if ('redirectUrl' in result) {
          return reply.redirect(result.redirectUrl, 302);
        }
      }

      // If user already has credentials for this vendor (personal, team, or org),
      // skip the credential entry page and complete authorization immediately.
      if (vendor && credentialService) {
        const hasCreds = await userHasAnyCredentials(userId, vendor, credentialService, orgService);
        if (hasCreds) {
          const result = await completeAuthorization(tokenStore, sessionId, userId);
          if ('redirectUrl' in result) {
            return reply.redirect(result.redirectUrl, 302);
          }
        }
      }

      // Redirect to the vendor credential entry page
      const connectPath = vendor
        ? `/connect/${encodeURIComponent(vendor)}?oauth_session=${encodeURIComponent(sessionId)}`
        : `/connect?oauth_session=${encodeURIComponent(sessionId)}`;

      return reply.redirect(connectPath, 302);
    });

    // -----------------------------------------------------------------------
    // POST /oauth/token
    // -----------------------------------------------------------------------

    app.post('/oauth/token', {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    }, async (request, reply) => {
      const body = request.body as Partial<TokenBody>;

      if (!body.grant_type) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'grant_type is required.',
        });
      }

      // -- authorization_code grant ----------------------------------------
      if (body.grant_type === 'authorization_code') {
        return handleAuthorizationCodeGrant(body, reply);
      }

      // -- refresh_token grant ---------------------------------------------
      if (body.grant_type === 'refresh_token') {
        return handleRefreshTokenGrant(body, reply);
      }

      // -- client_credentials grant (M2M / AI agents) ----------------------
      if (body.grant_type === 'client_credentials') {
        return handleClientCredentialsGrant(body, request, reply);
      }

      return reply.status(400).send({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code, refresh_token, and client_credentials grants are supported.',
      });
    });

    async function handleAuthorizationCodeGrant(
      body: Partial<TokenBody>,
      reply: FastifyReply,
    ): Promise<FastifyReply> {
      if (!body.code || !body.code_verifier || !body.redirect_uri || !body.client_id) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'code, code_verifier, redirect_uri, and client_id are required.',
        });
      }

      const authCode = await tokenStore.getAuthCode(body.code);
      if (!authCode) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid or has already been used.',
        });
      }

      // Check expiration
      if (new Date(authCode.expiresAt) < new Date()) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Authorization code has expired.',
        });
      }

      // Validate client_id matches the one that initiated the flow
      if (authCode.clientId !== body.client_id) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'client_id does not match the one used during authorization.',
        });
      }

      // Validate redirect_uri matches
      if (authCode.redirectUri !== body.redirect_uri) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'redirect_uri does not match the one used during authorization.',
        });
      }

      // PKCE verification
      if (!verifyCodeChallenge(body.code_verifier, authCode.codeChallenge)) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'PKCE code_verifier does not match code_challenge.',
        });
      }

      // Issue tokens
      const vendor = authCode.vendor ?? extractVendor(authCode.scope);

      const accessToken = await issueAccessToken({
        sub: authCode.userId,
        scope: authCode.scope,
        vendor,
        iss: config.baseUrl,
      });

      const refreshTokenValue = nanoid(48);
      const refreshExpiresAt = new Date(
        Date.now() + config.refreshTokenTtlSeconds * 1000,
      ).toISOString();

      await tokenStore.storeRefreshToken({
        token: refreshTokenValue,
        clientId: authCode.clientId,
        userId: authCode.userId,
        scope: authCode.scope,
        expiresAt: refreshExpiresAt,
      });

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: refreshTokenValue,
        scope: authCode.scope,
      });
    }

    async function handleRefreshTokenGrant(
      body: Partial<TokenBody>,
      reply: FastifyReply,
    ): Promise<FastifyReply> {
      if (!body.refresh_token || !body.client_id) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'refresh_token and client_id are required.',
        });
      }

      const stored = await tokenStore.getRefreshToken(body.refresh_token);
      if (!stored) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Refresh token is invalid.',
        });
      }

      // Validate client_id matches the one the token was issued to
      if (stored.clientId !== body.client_id) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Refresh token was not issued to this client.',
        });
      }

      // Check expiration
      if (new Date(stored.expiresAt) < new Date()) {
        await tokenStore.revokeRefreshToken(body.refresh_token);
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Refresh token has expired.',
        });
      }

      // Rotate: revoke old, issue new
      await tokenStore.revokeRefreshToken(body.refresh_token);

      const vendor = extractVendor(stored.scope);

      const accessToken = await issueAccessToken({
        sub: stored.userId,
        scope: stored.scope,
        vendor,
        iss: config.baseUrl,
      });

      const newRefreshTokenValue = nanoid(48);
      const refreshExpiresAt = new Date(
        Date.now() + config.refreshTokenTtlSeconds * 1000,
      ).toISOString();

      await tokenStore.storeRefreshToken({
        token: newRefreshTokenValue,
        clientId: stored.clientId,
        userId: stored.userId,
        scope: stored.scope,
        expiresAt: refreshExpiresAt,
      });

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: newRefreshTokenValue,
        scope: stored.scope,
      });
    }

    async function handleClientCredentialsGrant(
      body: Partial<TokenBody>,
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<FastifyReply> {
      if (!orgService) {
        return reply.status(400).send({
          error: 'unsupported_grant_type',
          error_description: 'client_credentials grant is not available.',
        });
      }

      // Extract client_id and client_secret from Authorization header (Basic auth)
      // or from body params
      let clientId: string | undefined;
      let clientSecret: string | undefined;

      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx > 0) {
          clientId = decoded.slice(0, colonIdx);
          clientSecret = decoded.slice(colonIdx + 1);
        }
      }

      // Fall back to body params
      clientId = clientId || body.client_id;
      clientSecret = clientSecret || (body as { client_secret?: string }).client_secret;

      if (!clientId || !clientSecret) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'client_id and client_secret are required for client_credentials grant.',
        });
      }

      // Look up the service client
      const serviceClient = await orgService.getServiceClientByClientId(clientId);
      if (!serviceClient) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id.',
        });
      }

      // Check expiration
      if (serviceClient.expiresAt && new Date(serviceClient.expiresAt) < new Date()) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Service client has expired.',
        });
      }

      // Verify client secret (SHA-256 hash comparison)
      const secretHash = createHash('sha256').update(clientSecret).digest('hex');
      if (secretHash !== serviceClient.clientSecretHash) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Invalid client_secret.',
        });
      }

      // Update last used timestamp (fire-and-forget)
      orgService.touchServiceClientLastUsed(clientId).catch(() => {});

      // Issue access token with svc: prefix to identify service clients.
      // The credential injector will recognize this prefix and use org credentials.
      const accessToken = await issueAccessToken({
        sub: `svc:${serviceClient.orgId}:${serviceClient.clientId}`,
        scope: 'mcp',
        vendor: '', // service clients are not vendor-scoped
        iss: config.baseUrl,
      });

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        scope: 'mcp',
      });
    }

    // -----------------------------------------------------------------------
    // POST /oauth/revoke (RFC 7009)
    // -----------------------------------------------------------------------

    app.post('/oauth/revoke', {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    }, async (request, reply) => {
      const body = request.body as Partial<RevokeBody>;

      if (body.token) {
        await tokenStore.revokeRefreshToken(body.token);
      }

      // Per RFC 7009, always return 200 regardless of whether the token existed
      return reply.status(200).send({});
    });
  };
}
