import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The kernel spawns real subprocesses in a few integration tests; give them
    // room without letting a hung CLI wedge the whole suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
