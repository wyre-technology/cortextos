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
    // docs/src/lib/*.test.ts: faq.ts (docs-only-consumed FAQ JSON-LD builder)
    // lives under docs/src/ so it resolves inside the docs-builder Docker
    // stage (WORKDIR /docs). Its drift-test + escape tests run under the
    // root vitest runner — docs/ has no vitest of its own — so the FAQ_DATA-
    // matches-visible-Q/A drift gate stays in `npm test`.
    include: ['src/**/*.test.ts', 'docs/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      // faq.ts is measured alongside src/** so moving it out of repo-root
      // src/ does not drop it from the coverage denominator (it stays
      // well-covered by faq.test.ts). docs/src is otherwise Astro
      // components/content with no unit tests, so only the lib/ subtree
      // is included — not all of docs/src.
      include: ['src/**', 'docs/src/lib/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/*.integration.test.ts',
        'src/**/types.ts',
        'docs/src/**/*.test.ts',
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
