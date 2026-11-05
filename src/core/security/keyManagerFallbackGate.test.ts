import { describe, it, expect, afterEach } from 'vitest';
import KeyManager from './KeyManager';

// WS8: KeyManager.generateKey() silently minted a software-backed PE key whenever
// the native Secure Enclave module was absent — even in production, where absence
// means a broken native build. The downstream M-17 gate only rejects fallback keys
// at the authorization layer; the source now fails closed in production.
//
// This file does NOT mock react-native, so NativeModules.ProvianSecureEnclaveP256
// is absent (the default stub exports NativeModules = {}), i.e. SecureEnclave is
// null — exactly the "native module unavailable" condition under test.
describe('WS8: KeyManager software fallback is production-gated', () => {
  const originalDev = (globalThis as unknown as { __DEV__: boolean }).__DEV__;
  afterEach(() => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = originalDev;
  });

  it('fails closed in production instead of minting a software-backed PE key', async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    await expect(KeyManager.generateKey()).rejects.toThrow(/Secure Enclave native module unavailable/i);
  });

  it('still allows the software fallback in a dev build (simulator / Expo Go)', async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
    const key = await KeyManager.generateKey();
    expect(key.securityLevel).toBe('software');
    expect(key.isHardwareBacked).toBe(false);
  });
});
