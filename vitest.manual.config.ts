import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 120000,
    fileParallelism: false,
    include: ['vitest/**/*-manual.test.ts'],
  },
});
