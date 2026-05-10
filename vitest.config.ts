import { defineConfig } from 'vitest/config';

// Coverage thresholds are intentionally set ~1 point below the measured
// floors as of the day this PR landed. The buffer absorbs v8's branch-
// counting edge cases and refactors of already-uncovered code without
// false-positive CI failures. The point is to make CI fail on real
// regression, not to enforce an aspirational target — when test
// additions move the actual numbers, ratchet these up in a follow-up
// PR. The ratchet policy itself (manual-on-improvement vs cron-recalibrated
// vs N-run rolling floor) is queued behind the autoresearch cycle approval.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.integration.test.ts',
        'src/**/types.ts',
      ],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 33,
        statements: 33,
        functions: 46,
        branches: 79,
      },
    },
  },
});
