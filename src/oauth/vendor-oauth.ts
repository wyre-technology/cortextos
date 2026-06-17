/**
 * Vendor OAuth 2.0 Authorization Code Flow handler.
 *
 * For vendors like Xero and QuickBooks Online that require user consent,
 * this module handles:
 *   1. Redirecting users to the vendor's authorization URL (with PKCE)
 *   2. Exchanging the callback authorization code for tokens
 *   3. Refreshing expired access tokens using stored refresh tokens
 *
 * Token data is stored as encrypted credentials via CredentialService,
 * using the same storage model as static API key vendors.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { OAuthVendorConfig } from '../credentials/vendor-config.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VendorTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Vendor-specific extra data from the token response (e.g. Xero tenant connections) */
  raw: Record<string, unknown>;
}

export interface VendorOAuthState {
  codeVerifier: string;
  vendor: string;
  /** The gateway OAuth session ID to complete after vendor consent */
  oauthSession?: string;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** Generate a random code verifier (43-128 chars, RFC 7636) */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** Derive the S256 code challenge from a verifier */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

/**
 * Build the vendor's authorization URL for the consent redirect.
 *
 * @param oauthCfg - The vendor's OAuth configuration
 * @param stateToken - Opaque state token to prevent CSRF (stored server-side)
 * @param codeVerifier - PKCE code verifier (stored server-side, challenge sent to vendor)
 * @returns The full authorization URL to redirect the user to
 */
export function buildAuthorizeUrl(
  oauthCfg: OAuthVendorConfig,
  stateToken: string,
  codeVerifier: string,
): string {
  const clientId = process.env[oauthCfg.clientIdEnv];
  if (!clientId) {
    throw new Error(`Missing environment variable: ${oauthCfg.clientIdEnv}`);
  }

  const callbackUrl = `${config.baseUrl}/connect/oauth/callback`;
  const codeChallenge = deriveCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: oauthCfg.scopes.join(' '),
    state: stateToken,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${oauthCfg.authorizeUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(
  oauthCfg: OAuthVendorConfig,
  code: string,
  codeVerifier: string,
): Promise<VendorTokenResponse> {
  const clientId = process.env[oauthCfg.clientIdEnv];
  if (!clientId) {
    throw new Error(`Missing environment variable: ${oauthCfg.clientIdEnv}`);
  }

  // Public-client + PKCE (WYREAI-Calendly substrate: token_endpoint_auth_methods=["none"]).
  // When publicClient is true, the PKCE code_verifier replaces the
  // client_secret on the token-exchange. Confidential clients still
  // require both the secret and the verifier.
  let clientSecret: string | undefined;
  if (!oauthCfg.publicClient) {
    if (!oauthCfg.clientSecretEnv) {
      throw new Error(
        `Vendor oauthConfig is missing clientSecretEnv (and publicClient is not set). ` +
          `Either set publicClient=true (RFC 8414 token_endpoint_auth_methods=["none"]) ` +
          `or supply clientSecretEnv.`,
      );
    }
    clientSecret = process.env[oauthCfg.clientSecretEnv];
    if (!clientSecret) {
      throw new Error(`Missing environment variable: ${oauthCfg.clientSecretEnv}`);
    }
  }

  const callbackUrl = `${config.baseUrl}/connect/oauth/callback`;

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl,
    code_verifier: codeVerifier,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...oauthCfg.extraTokenParams,
  };

  const res = await fetch(oauthCfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${errBody}`);
  }

  const data = await res.json() as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: (data.expires_in as number) || 3600,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Use a refresh token to obtain a new access token.
 * Returns the new token set (access + refresh, since most vendors rotate refresh tokens).
 */
export async function refreshAccessToken(
  oauthCfg: OAuthVendorConfig,
  refreshToken: string,
): Promise<VendorTokenResponse> {
  const clientId = process.env[oauthCfg.clientIdEnv];
  if (!clientId) {
    throw new Error(`Missing environment variable: ${oauthCfg.clientIdEnv}`);
  }

  // Public-client refresh path mirrors the exchange path: when publicClient
  // is true, omit client_secret. The vendor binds the refresh to the
  // original public-client + PKCE flow.
  let clientSecret: string | undefined;
  if (!oauthCfg.publicClient) {
    if (!oauthCfg.clientSecretEnv) {
      throw new Error(
        `Vendor oauthConfig is missing clientSecretEnv (and publicClient is not set). ` +
          `Either set publicClient=true or supply clientSecretEnv.`,
      );
    }
    clientSecret = process.env[oauthCfg.clientSecretEnv];
    if (!clientSecret) {
      throw new Error(`Missing environment variable: ${oauthCfg.clientSecretEnv}`);
    }
  }

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...oauthCfg.extraTokenParams,
  };

  const res = await fetch(oauthCfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${errBody}`);
  }

  const data = await res.json() as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) || refreshToken, // Some vendors don't rotate
    expiresIn: (data.expires_in as number) || 3600,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Microsoft 365-specific: extract tenant ID from id_token JWT
// ---------------------------------------------------------------------------

/**
 * Decode the JWT payload from an id_token and extract the `tid` (tenant ID) claim.
 * Microsoft Entra includes the tenant ID in the id_token, so no extra API call is needed.
 */
export function extractTenantIdFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    return payload.tid ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Xero-specific: fetch tenant ID after token exchange
// ---------------------------------------------------------------------------

/**
 * After Xero OAuth, we need to call /connections to get the tenant ID.
 * Returns the first connected tenant's ID.
 */
export async function fetchXeroTenantId(accessToken: string): Promise<string | null> {
  const res = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const connections = await res.json() as { tenantId: string; tenantName: string }[];
  return connections[0]?.tenantId ?? null;
}

// ---------------------------------------------------------------------------
// Build credential data for storage
// ---------------------------------------------------------------------------

/**
 * Build the credential data object to store for an OAuth vendor.
 * Includes access/refresh tokens plus expiry timestamp.
 */
export function buildCredentialData(
  tokens: VendorTokenResponse,
  extras?: Record<string, string>,
): Record<string, string> {
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: expiresAt,
    ...extras,
  };
}

/**
 * Validate the `iss` query parameter on an OAuth callback against the
 * expected issuer (RFC 9207 — OAuth 2.0 Authorization Server Issuer
 * Identification). Returns null on success, or a string error reason.
 *
 * `expectedIssuer` is REQUIRED (WYREAI-92): every OAuth vendor declares one,
 * so validation can never be silently skipped. There is no opt-out path.
 * - `actualIss` missing → 'missing_iss' (fail closed).
 * - mismatch → 'iss_mismatch'.
 * - match → null.
 *
 * Tenant-templated issuers: when `expectedIssuer` contains the literal
 * `{tenantid}` placeholder (Microsoft Entra returns a tenant-specific issuer
 * `https://login.microsoftonline.com/<guid>/v2.0` from the /common and
 * /organizations endpoints), the placeholder matches a single GUID/tenant
 * segment in `actualIss`. Non-templated issuers are matched exactly.
 *
 * Mitigates the OAuth mix-up attack class: an attacker controls a callback
 * URL that points to a different authorization server than the one the
 * client thinks it negotiated with; without iss-validation the client
 * accepts the wrong AS's response and may forward attacker-controlled
 * tokens to the wrong vendor.
 *
 * Ported from mcp-gateway/src/oauth/vendor-oauth.ts:validateCallbackIssuer
 * (WYREAI-75 PR B). Wired into src/web/routes.ts /connect/oauth/callback.
 */
export function validateCallbackIssuer(
  expectedIssuer: string,
  actualIss: string | undefined,
): null | 'missing_iss' | 'iss_mismatch' {
  if (!actualIss) return 'missing_iss';
  if (expectedIssuer.includes('{tenantid}')) {
    // Escape regex metachars in the literal parts, then swap the placeholder
    // for a single non-slash tenant segment (GUID or domain). Anchored so a
    // crafted iss can't match by embedding the expected issuer as a substring.
    const pattern = expectedIssuer
      .split('{tenantid}')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    return new RegExp(`^${pattern}$`).test(actualIss) ? null : 'iss_mismatch';
  }
  if (actualIss !== expectedIssuer) return 'iss_mismatch';
  return null;
}

/**
 * Check whether stored OAuth credentials have an expired access token.
 * Returns true if the token is expired or will expire within 60 seconds.
 */
export function isTokenExpired(creds: Record<string, string>): boolean {
  const expiresAt = creds.tokenExpiresAt;
  if (!expiresAt) return true;
  const expiryMs = new Date(expiresAt).getTime();
  return Date.now() >= expiryMs - 60_000; // 60s buffer
}
