import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
