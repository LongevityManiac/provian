import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'react-native': resolve(__dirname, 'test/react-native-stub.ts'),
      'expo-crypto': resolve(__dirname, 'test/expo-crypto-stub.ts'),
      'expo-device': resolve(__dirname, 'test/expo-device-stub.ts'),
      'expo-secure-store': resolve(__dirname, 'test/expo-secure-store-stub.ts'),
      '@react-native-async-storage/async-storage': resolve(__dirname, 'test/async-storage-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    restoreMocks: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Core.test.ts requires a full Expo/Jest environment with native module mocks
    // that are not available in Node. It is intentionally excluded from Vitest runs.
    // Run it separately via Expo's Jest setup if needed.
    exclude: ['src/core/Core.test.ts', 'node_modules/**'],
    setupFiles: [resolve(__dirname, 'test/vitest.setup.ts')],
  },
});
