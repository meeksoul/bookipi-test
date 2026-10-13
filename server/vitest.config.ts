import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites share one Redis DB and flush it between tests.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
