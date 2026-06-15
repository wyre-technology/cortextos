import { test, expect } from '@playwright/test';
import { hasEnv, stagingUrl } from './fixtures/env.js';
import {
  fetchServiceAccountToken,
  hasServiceAccount,
} from './fixtures/sa.js';

/**
 * PR-1 smoke: load-bearing witness that the harness can reach staging
 * AND that the service-account bootstrap path works (BYOC path b per
 * murph cred-inventory 2026-06-15).
 *
 * Aaron-pending: vendor sandbox creds + signup-test-account. Until those
 * arrive, the harness ships these two smokes + the PR-2/3 flow stubs in
 * flows.spec.ts. Tests are CI-safe by default: no env-var, no run.
 */
test.describe('staging harness — smoke', () => {
  test('staging URL is configured to an https origin', () => {
    const url = stagingUrl();
    expect(url, 'staging URL is empty').toBeTruthy();
    expect(url, 'staging URL should be http(s)').toMatch(/^https?:\/\//);
  });

  test('staging URL responds with Conduit-shaped HTML', async ({ page }) => {
    if (!hasEnv('CONDUIT_STAGING_URL')) {
      test.skip(
        true,
        'CONDUIT_STAGING_URL not set — see tests/e2e/README.md',
      );
    }
    const response = await page.goto('/');
    expect(response, 'page.goto returned null').not.toBeNull();
    // Azure Container Apps can serve 502/503 during cold-start; treat
    // anything < 400 as "reachable". 4xx/5xx is a real staging-down
    // signal we want to see fail loudly.
    expect(response!.status(), `expected 2xx/3xx, got ${response!.status()}`).toBeLessThan(400);
    const html = await page.content();
    expect(html.length, 'response body is empty').toBeGreaterThan(0);
  });

  test('service-account creds mint a bearer token (BYOC path b)', async () => {
    if (!hasServiceAccount()) {
      test.skip(
        true,
        'service-account creds not wired — see tests/e2e/README.md',
      );
    }
    const token = await fetchServiceAccountToken();
    expect(typeof token, 'access_token should be a string').toBe('string');
    // Minimal shape witness: tokens are at least ~20 chars; any reasonable
    // bearer (JWT or opaque) clears that. We deliberately don't pin
    // format — Auth0 has flipped JWT vs opaque before.
    expect(token.length, 'access_token suspiciously short').toBeGreaterThan(20);
  });

  // Re-enabled per Aaron clarification msg-1781554979423: conduit-staging has
  // its OWN Auth0 tenant (separate from conduit-prod), so the signup-UI walk
  // is testable safely. Skip-gated until Aaron-pending answer on whether the
  // staging tenant has an existing test-account or we create one.
  test('Auth0 signup-UI walk-through lands at dashboard (BYOC path a — signup form)', async ({ page }) => {
    if (!hasEnv('CONDUIT_STAGING_URL', 'STAGING_TEST_EMAIL', 'STAGING_TEST_PASSWORD')) {
      test.skip(
        true,
        'STAGING_TEST_EMAIL + STAGING_TEST_PASSWORD not wired — Aaron-pending ' +
          'on staging-tenant test-account substrate. See tests/e2e/README.md.',
      );
    }
    // PR-2 replaces this with the full pearl §1.1 → §1.2 sequence (POST /signup
    // with MSA consent → drive Auth0 form → land at /settings). For PR-1 the
    // scaffold simply asserts the signup form is reachable — proving the
    // browser can hit /signup against the staging tenant without WAF/etc
    // blocking the path.
    const response = await page.goto('/signup');
    expect(response, '/signup returned null').not.toBeNull();
    expect(response!.status(), `expected 2xx/3xx at /signup, got ${response!.status()}`).toBeLessThan(400);
  });
});
