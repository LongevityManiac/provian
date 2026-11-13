import { beforeEach, expect, test, vi } from 'vitest';
import { encryptBackupEnvelope, decryptBackupEnvelope } from '../recovery/cloud/cloudBackupEnvelope';
const state = vi.hoisted(() => ({ device: false, memory: new Map<string, string>(), dropWrite: false }));
vi.mock('expo-device', () => ({ get isDevice() { return state.device; } }));
vi.mock('../../../scripts/recourse/native/config', () => ({ default: {
  relay: 'http://127.0.0.1:18551', instanceId: `0x${'12'.repeat(32)}`,
} }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => state.memory.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options: unknown) => {
    expect(options).toEqual({ keychainAccessible: 'device-only' });
    expect(key.startsWith('isolated_recourse_backups_')).toBe(true);
    if (!state.dropWrite) state.memory.set(key, value);
  },
}));
import * as storage from '../../../scripts/recourse/native/cloud-storage';
const key = 'provian_cloud_backup_v2';
beforeEach(() => { state.device = false; state.dropWrite = false; state.memory.clear(); });
test('local transport retains the real encrypted backup and detects absent or lost writes', async () => {
  const payload = { mnemonic: 'test test test test test test test test test test test junk',
    wallet_address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', chain_ids: [8453],
    created_at: '2026-11-12T00:00:00Z', device_info: { platform: 'ios' as const, attestation_tier: 'software' } };
  const blob = { ...await encryptBackupEnvelope(payload, 'public-fixture-password'), wallet_address: payload.wallet_address };
  expect(await storage.verifySync(key)).toBe(false);
  state.dropWrite = true;
  await expect(storage.storeSynced(key, JSON.stringify(blob))).rejects.toThrow('write_unconfirmed');
  state.dropWrite = false;
  await storage.storeSynced(key, JSON.stringify(blob));
  expect(await storage.verifySync(key)).toBe(true);
  expect(await storage.listSyncedKeys()).toEqual([key]);
  expect(await decryptBackupEnvelope(JSON.parse((await storage.retrieveSynced(key))!), 'public-fixture-password')).toEqual(payload);
  await expect(decryptBackupEnvelope(blob, 'wrong-password')).rejects.toThrow();
  expect([...state.memory.values()].join('')).not.toContain(payload.mnemonic);
  await storage.deleteSynced(key);
  expect(await storage.retrieveSynced(key)).toBeNull();
});
test('plaintext, unrelated cloud keys and physical devices are refused', async () => {
  await expect(storage.storeSynced(key, JSON.stringify({ mnemonic: 'public fixture' }))).rejects.toThrow('ciphertext_required');
  await expect(storage.storeSynced('provian_agent_recovery_anchor::fixture', '{}')).rejects.toThrow('key_refused');
  state.device = true;
  await expect(storage.retrieveSynced(key)).rejects.toThrow('isolated_native_build_required');
  expect(() => storage.isCloudKeychainAvailable()).toThrow('isolated_native_build_required');
  expect(state.memory.size).toBe(0);
});
