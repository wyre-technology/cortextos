import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // Container start-up + migration apply can take ~10–20s on first run.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Run integration files serially — multiple parallel containers are
    // possible but waste resources for our scale.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
