/**
 * Auth0 Management API client — Multi-IdP foundation slice 2.
 *
 * Why this exists (June 29 launch directive 2026-06-13):
 *   Aaron pre-launch-committed adopting Auth0 Organizations as the multi-
 *   tenancy primitive. This client is the substrate the slice-3 provisioning
 *   hook calls when a Conduit org is created — it creates the Auth0 Org
 *   peer + enables IdP connections under BOTH-OR-NEITHER discipline (if
 *   the Management API call fails the slice-3 hook fails the org-create,
 *   preventing orphan DB orgs without an Auth0 Org peer).
 *
 * Scope:
 *   * client_credentials grant via the M2M client Aaron provisions in the
 *     Auth0 dashboard. The grant exchanges (client_id, client_secret) for
 *     a short-lived access_token (~24h TTL).
 *   * Token cache: store the access_token + its `expires_at` timestamp;
 *     reuse it across calls until 60s before expiry (defensive buffer so
 *     a long-running request doesn't hit a freshly-expired token mid-call).
 *   * Operations the slice 3/4/5 caller-set needs:
 *       - createOrganization({ name, displayName, metadata })
 *           POST /api/v2/organizations
 *       - enableConnection(auth0OrgId, connectionId)
 *           POST /api/v2/organizations/:id/enabled_connections
 *       - deleteOrganization(auth0OrgId)
 *           DELETE /api/v2/organizations/:id
 *
 * Configuration:
 *   AUTH0_M2M_CLIENT_ID + AUTH0_M2M_CLIENT_SECRET env vars (slot in
 *   src/config.ts under auth0M2mClient{Id,Secret}). AUTH0_DOMAIN is reused
 *   from the existing user-facing client config — same tenant, different
 *   credential pair.
 *
 * Disabled state:
 *   When the M2M creds are unset (`config.auth0M2mClientId === ''`),
 *   `Auth0ManagementClient.createIfConfigured()` returns null and the
 *   slice-3 provisioning hook skips creating an Auth0 Org peer. The auth
 *   flow falls through to the legacy Universal Login path (slice 1
 *   migration documents this nullable contract on Organization.auth0OrgId).
 *
 * Error shape:
 *   All operations throw Auth0ManagementError on non-2xx response. The
 *   error carries (status, body) so the slice-3 provisioning hook can
 *   surface a 503-temporarily-unavailable for transient failures + a 500
 *   internal-server-error for permanent ones.
 */

import { config } from '../config.js';

const AUTH0_MANAGEMENT_TIMEOUT_MS = 5_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export class Auth0ManagementError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'Auth0ManagementError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateOrganizationOptions {
  /** Auth0 'name' — must be alphanumeric + hyphens, lowercase. Used in URLs. */
  name: string;
  /** Auth0 'display_name' — human-readable, free-form. */
  displayName: string;
  /** Arbitrary string-keyed metadata. Stored on the Auth0 Org. */
  metadata?: Record<string, string>;
}

export interface Auth0OrganizationResponse {
  id: string;
  name: string;
  display_name?: string;
  metadata?: Record<string, string>;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

export class Auth0ManagementClient {
  private cachedToken: CachedToken | null = null;
  private inFlightTokenFetch: Promise<string> | null = null;

  constructor(
    private readonly domain: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Construct an Auth0ManagementClient from runtime config, or return null
   * when M2M credentials are unset. Callers should null-check the result
   * and gracefully skip the Auth0-side provisioning when null — same
   * pattern as the slice 1 docstring on Organization.auth0OrgId.
   */
  static createIfConfigured(): Auth0ManagementClient | null {
    if (!config.auth0M2mClientId || !config.auth0M2mClientSecret || !config.auth0Domain) {
      return null;
    }
    return new Auth0ManagementClient(
      config.auth0Domain,
      config.auth0M2mClientId,
      config.auth0M2mClientSecret,
    );
  }

  /**
   * Create an Auth0 Organization. Returns the Auth0 id (`org_<alnum>`)
   * that the slice-3 provisioning hook persists to organizations.
   * auth0_org_id (migration 046).
   */
  async createOrganization(opts: CreateOrganizationOptions): Promise<Auth0OrganizationResponse> {
    const body: Record<string, unknown> = {
      name: opts.name,
      display_name: opts.displayName,
    };
    if (opts.metadata) body.metadata = opts.metadata;
    return this.request<Auth0OrganizationResponse>('POST', '/api/v2/organizations', body);
  }

  /**
   * Enable an existing Auth0 Connection on an Organization. The connection
   * itself (Okta SAML, JumpCloud SCIM, Google direct) is provisioned in
   * the Auth0 dashboard by Aaron; this call just associates it with the
   * Org so users of that Org can use it to authenticate.
   */
  async enableConnection(auth0OrgId: string, connectionId: string): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/api/v2/organizations/${encodeURIComponent(auth0OrgId)}/enabled_connections`,
      { connection_id: connectionId },
    );
  }

  /**
   * Delete an Auth0 Organization. Called from the slice-3 provisioning
   * hook's rollback path when the Conduit org create fails AFTER the Auth0
   * Org create succeeded (BOTH-OR-NEITHER discipline at the seam).
   */
  async deleteOrganization(auth0OrgId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/api/v2/organizations/${encodeURIComponent(auth0OrgId)}`,
    );
  }

  /**
   * Fetch a fresh token via client_credentials, or reuse the cached one
   * if it's still valid for at least TOKEN_REFRESH_BUFFER_MS more. The
   * in-flight Promise dedup prevents a thundering-herd of refresh calls
   * when many requests notice the cache is stale at the same time.
   */
  private async getAccessToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_BUFFER_MS) {
      return cached.accessToken;
    }

    if (this.inFlightTokenFetch) {
      return this.inFlightTokenFetch;
    }

    this.inFlightTokenFetch = (async () => {
      try {
        return await this.fetchAccessToken();
      } finally {
        this.inFlightTokenFetch = null;
      }
    })();

    return this.inFlightTokenFetch;
  }

  private async fetchAccessToken(): Promise<string> {
    const res = await this.fetchImpl(`https://${this.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `https://${this.domain}/api/v2/`,
      }),
      signal: AbortSignal.timeout(AUTH0_MANAGEMENT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Auth0ManagementError(
        `Auth0 Management /oauth/token failed: ${res.status}`,
        res.status,
        body,
      );
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAt: this.now() + json.expires_in * 1000,
    };
    return json.access_token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`https://${this.domain}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(AUTH0_MANAGEMENT_TIMEOUT_MS),
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Auth0ManagementError(
        `Auth0 Management ${method} ${path} failed: ${res.status}`,
        res.status,
        errBody,
      );
    }
    return (await res.json()) as T;
  }
}
