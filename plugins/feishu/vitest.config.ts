import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 30000,
    fileParallelism: false,
    include: ['vitest/**/*.test.ts'],
  },
});
