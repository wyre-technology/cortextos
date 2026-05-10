import { defineConfig } from 'vitest/config';

// Coverage thresholds are intentionally set at the measured floors as of
// the day this PR landed (rounded down to the nearest int). The point is
// to make CI fail on regression, not to enforce an aspirational target —
// when test additions move the actual numbers, ratchet these up in a
// follow-up PR. See docs/contributing/coverage.md if/when added.
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
        lines: 34,
        statements: 34,
        functions: 47,
        branches: 80,
      },
    },
  },
});
