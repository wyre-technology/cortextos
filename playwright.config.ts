import { defineConfig, devices } from '@playwright/test';

/**
 * Conduit staging E2E harness — Playwright config.
 *
 * Aaron-directive 2026-06-15: full E2E test harness for conduit-staging.
 * Pearl's flow spec + murph's cred inventory will drive PR-2+ content;
 * this config is the substrate they land into.
 *
 * Tests run against a REAL deployed staging — NOT testcontainers — so
 * the harness is gated behind CONDUIT_STAGING_URL. Without it, the suite
 * is a no-op (CI-safe by default; flip on in staging pipeline only).
 *
 * Browsers: chromium-only for v1 (Aaron's urgency = fastest path to
 * green; cross-browser projects[] add later if a real cross-browser bug
 * surfaces — they don't yet).
 */
const STAGING_URL =
  process.env.CONDUIT_STAGING_URL ??
  'https://staging.conduit.wyre.ai';

export default defineConfig({
  testDir: './tests/e2e',
  // PR-1 has one smoke test; concurrency moot. PR-2+ will tune workers
  // once pearl spec is in.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: STAGING_URL,
    // Trace/video/screenshot defaults biased toward catching staging-only
    // flakes — these artifacts only land in CI when a test fails.
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
