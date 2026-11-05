import { beforeEach, vi } from 'vitest';
import { __resetSecureStoreMock } from './expo-secure-store-stub';

// Define React Native / Expo globals expected in native runtimes
// __DEV__ must be true in tests so fallback signing keys work (M-17 blocks them in production)
(globalThis as any).__DEV__ = true;
(globalThis as any).__METRO_GLOBAL_PREFIX__ = '';
(globalThis as any).nativeCallSyncHook = () => {};
(globalThis as any).nativeFlushQueueImmediate = () => {};
(globalThis as any).nativePerformanceNow = () => Date.now();

// Provide Expo global used by expo-modules-core (EventEmitter)
import './expo-modules-core-global';

// Jest-compat shim for tests written with jest.mock / jest.fn
(globalThis as any).jest = {
  fn: vi.fn,
  mock: vi.mock,
  spyOn: vi.spyOn,
};

// Hard-mock react-native to avoid Flow syntax parsing in node tests
vi.mock('react-native', async () => await import('./react-native-stub'));

// Mock native Expo modules for node test environment
vi.mock('expo-crypto', async () => await import('./expo-crypto-stub'));
vi.mock('expo-secure-store', async () => await import('./expo-secure-store-stub'));
vi.mock('expo-local-authentication', async () => await import('./expo-local-authentication-stub'));

// Mock AsyncStorage
vi.mock('@react-native-async-storage/async-storage', async () => await import('./async-storage-stub'));

beforeEach(() => {
  __resetSecureStoreMock();
});
