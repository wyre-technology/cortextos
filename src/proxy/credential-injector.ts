import * as jose from 'jose';
import { config } from '../config.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { OrgService } from '../org/org-service.js';
import { getVendor } from '../credentials/vendor-config.js';
import { refreshAccessToken, isTokenExpired, buildCredentialData } from '../oauth/vendor-oauth.js';

export interface InjectionResult {
  userId: string;
  vendor: string;
  orgId?: string;
  teamId?: string;    // set when team credentials were used
  clientId?: string;  // set when service client credentials were used
  headers: Record<string, string>;
}

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Decode and verify a Bearer token, returning the userId.
 * Used by rate-limit keyGenerator/max before the full handler runs.
 */
export async function resolveUserId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const secret = new TextEncoder().encode(config.jwtSecret);
  try {
    const { payload } = await jose.jwtVerify(token, secret, { issuer: config.baseUrl });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate a Bearer token and build the vendor-specific headers
 * that get injected into the proxied request.
 *
 * Credential resolution order:
 *   1. Personal credentials
 *   2. Team credentials (if user is in exactly 1 team with creds for this vendor)
 *   3. Org-level credentials — resolved via
 *      {@link CredentialService.resolveForOrgAndVendor}, which itself tries:
 *        a. The customer org's own org_credentials row, then
 *        b. A reseller-shared grant (reseller_shared_vendor_grants) pointing
 *           at the reseller's org_credentials row for the same vendor.
 *      When (b) is used, the resolution is logged for audit.
 *   4. Throw AuthError if none found
 *
 * Service accounts (svc:<orgId>:<clientId>): service client creds → org creds
 */
export interface InjectOptions {
  /**
   * Opt out of the per-vendor binding check for tokens with empty `vendor`
   * claim. Set ONLY at the unified `/v1/mcp` endpoint, which mints
   * intentionally-unscoped tokens. Per-vendor `/v1/{vendor}/mcp` routes
   * must leave this off — the binding check there prevents using a token
   * minted for a low-trust vendor to access a high-trust one.
   */
  allowUnscopedToken?: boolean;
}

export async function injectCredentials(
  authHeader: string | undefined,
  vendorSlug: string,
  credentialService: CredentialService,
  orgService?: OrgService,
  opts: InjectOptions = {},
): Promise<InjectionResult> {
  // 1. Extract Bearer token
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError(401, 'Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7);

  // 2. Verify JWT signature and claims
  const secret = new TextEncoder().encode(config.jwtSecret);
  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, secret, {
      issuer: config.baseUrl,
    });
    payload = result.payload;
  } catch {
    throw new AuthError(401, 'Invalid or expired token');
  }

  const userId = payload.sub;
  if (!userId) {
    throw new AuthError(401, 'Token missing subject');
  }

  // Bind the token to the vendor it was issued for.
  //
  // The OAuth flow embeds the requested vendor in the access token's `vendor`
  // claim (see issueAccessToken in oauth/authorization-server.ts). Without
  // this check, a token minted for vendor A is accepted at /v1/<vendorB>/mcp
  // — any user with credentials for two vendors can swap a low-trust token
  // for a high-trust one.
  //
  // Service-client tokens carry `vendor: ''` and are explicitly multi-vendor
  // (gated separately by the per-client allowedVendors check below). Any
  // other empty/missing `vendor` claim is rejected.
  const tokenVendor = typeof payload.vendor === 'string' ? payload.vendor : '';
  const isServiceClient = userId.startsWith('svc:');
  if (!isServiceClient) {
    if (!tokenVendor && !opts.allowUnscopedToken) {
      throw new AuthError(403, 'Token missing vendor claim — re-issue via refresh.');
    }
    if (tokenVendor && tokenVendor !== vendorSlug) {
      throw new AuthError(
        403,
        `Token issued for ${tokenVendor} cannot be used at ${vendorSlug}.`,
      );
    }
  }

  // 3. Resolve vendor configuration
  const vendor = getVendor(vendorSlug);
  if (!vendor) {
    throw new AuthError(404, `Unknown vendor: ${vendorSlug}`);
  }

  // 4. Fetch credentials
  let creds: Record<string, string> | null = null;
  let orgId: string | undefined;
  let teamId: string | undefined;
  let resultClientId: string | undefined;

  // Service client tokens have sub like "svc:<orgId>:<clientId>"
  if (userId.startsWith('svc:') && orgService) {
    const parts = userId.split(':');
    const svcOrgId = parts[1];
    const clientId = parts[2];
    if (!svcOrgId) {
      throw new AuthError(401, 'Malformed service client token');
    }
    if (clientId) {
      const svcClientCreds = await credentialService.getServiceClientCredential(clientId, vendorSlug);
      if (svcClientCreds) {
        creds = svcClientCreds;
        resultClientId = clientId;
        orgId = svcOrgId;
      }
    }
    if (!creds) {
      const orgCreds = await credentialService.getOrgCredential(svcOrgId, vendorSlug);
      if (!orgCreds) {
        throw new AuthError(
          403,
          `Organization has no credentials for ${vendor.name}.`,
        );
      }
      creds = orgCreds;
      orgId = svcOrgId;
    }
  } else {
    // Human user: personal credentials first, then org fallback
    creds = await credentialService.get(userId, vendorSlug);

    if (!creds && orgService) {
      const orgs = await orgService.getUserOrgs(userId);
      for (const org of orgs) {
        // Team tier (before org tier): check teams the user belongs to that have creds
        {
          // One set-based query for the credential across every team the
          // user is in — not a per-team Promise.all fan-out, which issues
          // concurrent queries on the request's reserved-transaction
          // connection (the deadlock class fixed in aggregateTools). Returns
          // only the teams that actually hold a credential.
          const userTeams = await orgService.getUserTeams(org.id, userId);
          const hits = await credentialService.getTeamCredentialsForTeams(
            userTeams.map((t) => t.id),
            vendorSlug,
          );

          if (hits.length === 1) {
            const hasAccess = await orgService.hasServerAccess(org.id, userId, vendorSlug);
            if (hasAccess) {
              creds = hits[0].creds;
              teamId = hits[0].teamId;
              orgId = org.id;
              break;
            }
          }
          // 0 or >1 matching teams → fall through to org tier
        }

        // Org tier: customer org's own credential, falling back to any
        // enabled reseller-shared grant for this (customer_org, vendor).
        const resolved = await credentialService.resolveForOrgAndVendor(org.id, vendorSlug);
        if (resolved) {
          const hasAccess = await orgService.hasServerAccess(org.id, userId, vendorSlug);
          if (!hasAccess) {
            continue;
          }
          if (resolved.source === 'reseller_grant') {
            // Audit trail hook: cross-org credential usage via reseller grant.
            // eslint-disable-next-line no-console
            console.info('credential-injector: reseller-grant resolution', {
              grantId: resolved.grantId,
              resellerOrgId: resolved.ownerOrgId,
              customerOrgId: org.id,
              vendorSlug,
            });
          }
          creds = resolved.data;
          orgId = org.id;
          break;
        }
      }
    }
  }

  if (!creds) {
    throw new AuthError(
      403,
      `No stored credentials for ${vendor.name}. ` +
        `Please connect at ${config.baseUrl}/connect/${vendorSlug}`,
    );
  }

  // 5. For OAuth vendors, refresh the access token if expired
  if (vendor.oauthConfig && creds.refreshToken && isTokenExpired(creds)) {
    try {
      const tokens = await refreshAccessToken(vendor.oauthConfig, creds.refreshToken);
      const extraFields: Record<string, string> = {};
      for (const key of vendor.oauthConfig.extraFields ?? []) {
        if (creds[key]) extraFields[key] = creds[key];
      }
      const refreshedData = buildCredentialData(tokens, extraFields);

      // Persist the new tokens
      if (resultClientId) {
        await credentialService.storeServiceClientCredential(resultClientId, orgId!, vendorSlug, refreshedData, userId);
      } else if (teamId) {
        await credentialService.storeTeamCredential(teamId, orgId!, vendorSlug, refreshedData, userId);
      } else if (orgId) {
        await credentialService.storeOrgCredential(orgId, vendorSlug, refreshedData, userId);
      } else {
        await credentialService.store(userId, vendorSlug, refreshedData);
      }

      creds = refreshedData;
    } catch {
      throw new AuthError(
        401,
        `Token refresh failed for ${vendor.name}. Please reconnect at ${config.baseUrl}/connect/${vendorSlug}`,
      );
    }
  }

  // 6. Map credential fields to the vendor's expected HTTP headers
  let headers: Record<string, string>;
  if (vendor.buildHeaders) {
    headers = vendor.buildHeaders(creds);
  } else {
    headers = {};
    for (const [fieldKey, headerName] of Object.entries(vendor.headerMapping)) {
      const value = creds[fieldKey];
      if (value) {
        headers[headerName] = value;
      }
    }
  }

  return { userId, vendor: vendorSlug, orgId, teamId, clientId: resultClientId, headers };
}
