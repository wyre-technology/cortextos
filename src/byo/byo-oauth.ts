/**
 * BYOMCP OAuth (WYREAI-187).
 *
 * OAuth 2.0 authorization-code + PKCE for user-supplied (non-catalog) MCP
 * servers. Unlike catalog vendors (whose authorize/token URLs + client come
 * from a compiled OAuthVendorConfig + env vars), a BYO server's authorization
 * server is DISCOVERED at runtime from the endpoint's metadata:
 *   1. RFC 9728 — GET {origin}/.well-known/oauth-protected-resource
 *                 → authorization_servers[]
 *   2. RFC 8414 — GET {as}/.well-known/oauth-authorization-server
 *                 → issuer, authorization_endpoint, token_endpoint, …
 *
 * Reuses the gateway's existing OAuth machinery where it fits — the pure PKCE
 * + RFC 9207 helpers (deriveCodeChallenge, validateCallbackIssuer) — and adds
 * only the discovery + the BYO-specific authorize/exchange (which take the
 * discovered endpoints + a dynamic/stored client rather than env config).
 *
 * SECURITY:
 *  - SSRF: validateVendorBaseUrl gates EVERY discovery + token fetch (the
 *    resource URL, the authorization server, and the discovered
 *    authorization/token endpoints are all user-influenced).
 *  - RFC 9207 issuer mandate (the WYREAI-437 / #437 lesson): discovery REFUSES
 *    an authorization server whose metadata has no `issuer`, and the callback
 *    `iss` is always validated against that discovered issuer — there is no
 *    skip path, exactly as #437 makes mandatory for the catalog.
 */
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';
import {
  deriveCodeChallenge,
  validateCallbackIssuer,
  type VendorTokenResponse,
} from '../oauth/vendor-oauth.js';

const FETCH_TIMEOUT_MS = 15_000;

export class ByoOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByoOAuthError';
  }
}

/** Discovered authorization-server metadata (RFC 8414 subset we use). */
export interface ByoAuthServerMetadata {
  /** REQUIRED — RFC 9207 validation can't be enforced without it (#437). */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7591 dynamic client registration endpoint, if advertised. */
  registrationEndpoint?: string;
  scopesSupported: string[];
  codeChallengeMethodsSupported: string[];
}

/** SSRF-validate a URL, then GET + parse JSON. Used for both .well-known docs. */
async function fetchJson(url: string): Promise<Record<string, unknown>> {
  await validateVendorBaseUrl(url);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ByoOAuthError(`metadata fetch ${url} returned HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new ByoOAuthError(`authorization server metadata is missing "${field}"`);
  }
  return value;
}

/**
 * Discover the authorization server for a BYO MCP endpoint (RFC 9728 → 8414).
 * SSRF-guards every hop and enforces the RFC 9207 issuer mandate.
 */
export async function discoverByoAuthServer(resourceUrl: string): Promise<ByoAuthServerMetadata> {
  await validateVendorBaseUrl(resourceUrl);

  // RFC 9728: protected-resource metadata lives at the resource's origin.
  const origin = new URL(resourceUrl).origin;
  const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
  const authServers = prm.authorization_servers;
  if (!Array.isArray(authServers) || authServers.length === 0) {
    throw new ByoOAuthError('protected-resource metadata advertises no authorization_servers');
  }

  // RFC 8414: authorization-server metadata.
  const asBase = String(authServers[0]).replace(/\/+$/, '');
  const asm = await fetchJson(`${asBase}/.well-known/oauth-authorization-server`);

  const issuer = asm.issuer;
  if (typeof issuer !== 'string' || !issuer) {
    throw new ByoOAuthError(
      'authorization server metadata is missing "issuer" — RFC 9207 issuer ' +
        'validation cannot be enforced, so the BYO connection is refused (WYREAI-437 mandate).',
    );
  }

  const authorizationEndpoint = requireString(asm.authorization_endpoint, 'authorization_endpoint');
  const tokenEndpoint = requireString(asm.token_endpoint, 'token_endpoint');
  // The endpoints get fetched / redirected-to next; SSRF-guard them now.
  await validateVendorBaseUrl(authorizationEndpoint);
  await validateVendorBaseUrl(tokenEndpoint);

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof asm.registration_endpoint === 'string' ? asm.registration_endpoint : undefined,
    scopesSupported: Array.isArray(asm.scopes_supported) ? asm.scopes_supported.map(String) : [],
    codeChallengeMethodsSupported: Array.isArray(asm.code_challenge_methods_supported)
      ? asm.code_challenge_methods_supported.map(String)
      : [],
  };
}

export interface ByoAuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
}

/** Build the BYO authorization URL against the discovered endpoint (PKCE S256). */
export function buildByoAuthorizeUrl(meta: ByoAuthServerMetadata, p: ByoAuthorizeParams): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(' '),
    state: p.state,
    code_challenge: deriveCodeChallenge(p.codeVerifier),
    code_challenge_method: 'S256',
  });
  return `${meta.authorizationEndpoint}?${params.toString()}`;
}

export interface ByoExchangeParams {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** The `iss` parameter returned on the OAuth callback (RFC 9207). */
  iss: string | undefined;
}

/**
 * Exchange an authorization code for tokens at the discovered token endpoint.
 * Validates the callback `iss` against the discovered issuer FIRST (RFC 9207,
 * no skip — the #437 rule), then SSRF-guards the token endpoint.
 */
export async function exchangeByoCode(
  meta: ByoAuthServerMetadata,
  p: ByoExchangeParams,
): Promise<VendorTokenResponse> {
  // meta.issuer is guaranteed present by discoverByoAuthServer, so this never
  // hits validateCallbackIssuer's skip path — RFC 9207 is always enforced.
  const issError = validateCallbackIssuer(meta.issuer, p.iss);
  if (issError) {
    throw new ByoOAuthError(`RFC 9207 issuer check failed: ${issError}`);
  }

  await validateVendorBaseUrl(meta.tokenEndpoint);

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
    client_id: p.clientId,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
  };

  const res = await fetch(meta.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ByoOAuthError(`token exchange failed (${res.status}): ${errBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: (data.expires_in as number) || 3600,
    raw: data,
  };
}
