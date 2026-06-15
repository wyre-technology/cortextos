/**
 * Env-fixture helpers for the staging E2E harness.
 *
 * The harness is intentionally CI-safe by default: the suite is gated
 * behind a small set of env-vars and short-circuits to test.skip if any
 * required one is missing. Murph's cred inventory will surface the
 * actual staging values; until then, tests skip cleanly when run in
 * any pipeline that hasn't been wired up.
 *
 * Variable contract:
 *   CONDUIT_STAGING_URL       — required for any test that hits staging
 *   STAGING_TEST_EMAIL        — tenant-flow tests (PR-2+)
 *   STAGING_TEST_PASSWORD     — tenant-flow tests (PR-2+)
 *   STAGING_OPERATOR_EMAIL    — subtenant/actingAs tests (PR-3+)
 *   STAGING_OPERATOR_PASSWORD — subtenant/actingAs tests (PR-3+)
 *   STAGING_ALT_PAYMENTS_*    — vendor sandbox creds (PR-2+)
 *   STAGING_AUVIK_*           — vendor sandbox creds (PR-2+)
 *   STAGING_DO_PAT            — vendor sandbox creds (PR-2+)
 */

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export function hasEnv(...names: string[]): boolean {
  return names.every((n) => {
    const v = process.env[n];
    return typeof v === 'string' && v.trim() !== '';
  });
}

export const stagingUrl = (): string =>
  process.env.CONDUIT_STAGING_URL ??
  'https://staging.conduit.wyre.ai';
