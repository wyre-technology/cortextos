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
 *   3. Org-level credentials
 *   4. Throw AuthError if none found
 *
 * Service accounts (svc:<orgId>:<clientId>): service client creds → org creds
 */
export async function injectCredentials(
  authHeader: string | undefined,
  vendorSlug: string,
  credentialService: CredentialService,
  orgService?: OrgService,
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
          const userTeams = await orgService.getUserTeams(org.id, userId);
          const hits = (await Promise.all(
            userTeams.map(async (t) => ({ t, creds: await credentialService.getTeamCredential(t.id, vendorSlug) }))
          )).filter((x) => x.creds !== null);

          if (hits.length === 1) {
            const hasAccess = await orgService.hasServerAccess(org.id, userId, vendorSlug);
            if (hasAccess) {
              creds = hits[0].creds!;
              teamId = hits[0].t.id;
              orgId = org.id;
              break;
            }
          }
          // 0 or >1 matching teams → fall through to org tier
        }

        const orgCreds = await credentialService.getOrgCredential(org.id, vendorSlug);
        if (orgCreds) {
          const hasAccess = await orgService.hasServerAccess(org.id, userId, vendorSlug);
          if (!hasAccess) {
            continue;
          }
          creds = orgCreds;
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
