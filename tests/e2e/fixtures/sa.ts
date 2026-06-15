/**
 * Service-account credentials fixture for the staging E2E harness.
 *
 * Conduit-staging exposes an OAuth 2.0 client-credentials flow for
 * service-account-admin scope (see ~/.cortextos/default/secrets/
 * conduit-boss-staging-svc.json + conduit-staging-svc-new-2026-06-11.json
 * for the live creds). The harness uses this to bootstrap test runs
 * without depending on the Auth0 signup UI (which has no pre-provisioned
 * test account — Aaron-pending per murph cred-inventory 2026-06-15).
 *
 * BYOC architecture: vendor creds never sit in conduit env. Per-org
 * connections happen via OAuth/PAT at connect-time. The harness models
 * BOTH paths:
 *
 *   (a) OAuth/PAT walk — TRUE E2E, exercises the signup form. Needs a
 *       real vendor sandbox cred Aaron is supplying. Lives in tests
 *       gated on STAGING_VENDOR_*_* envs.
 *   (b) Service-account direct cred-injection — admin-scope cred-write
 *       bypasses the OAuth walk for vendors-without-sandbox. Lives in
 *       tests gated on CONDUIT_STAGING_SVC_* envs.
 */

import { hasEnv, requireEnv } from './env.js';

export interface ServiceAccountCreds {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
}

export function hasServiceAccount(): boolean {
  return hasEnv(
    'CONDUIT_STAGING_SVC_CLIENT_ID',
    'CONDUIT_STAGING_SVC_CLIENT_SECRET',
    'CONDUIT_STAGING_SVC_TOKEN_URL',
  );
}

export function loadServiceAccount(): ServiceAccountCreds {
  return {
    clientId: requireEnv('CONDUIT_STAGING_SVC_CLIENT_ID'),
    clientSecret: requireEnv('CONDUIT_STAGING_SVC_CLIENT_SECRET'),
    tokenEndpoint: requireEnv('CONDUIT_STAGING_SVC_TOKEN_URL'),
  };
}

/**
 * Exchange service-account creds for a bearer token via the OAuth 2.0
 * client-credentials grant. The returned token is suitable for
 * `Authorization: Bearer ...` on conduit's admin-scope endpoints.
 *
 * Throws on non-2xx from the token endpoint so callers see the failure
 * directly in test output (vs a downstream 401 that's hard to diagnose).
 */
export async function fetchServiceAccountToken(
  creds: ServiceAccountCreds = loadServiceAccount(),
): Promise<string> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const res = await fetch(creds.tokenEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `service-account token mint failed: HTTP ${res.status} from ${creds.tokenEndpoint}`,
    );
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('service-account token response missing access_token');
  }
  return body.access_token;
}
