import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import config from './config';
import { PBKDF2_ITERATIONS } from '../../../src/core/recovery/cloud/cloudBackupEnvelope';

// Only the cloud transport is simulated. CloudBackupV2 still encrypts and
// decrypts with the real password/KDF/AEAD and owner biometric paths.
function requireIsolation(): void {
  if (!__DEV__ || Device.isDevice || config.relay !== 'http://127.0.0.1:18551'
    || !/^0x[0-9a-f]{64}$/.test(config.instanceId)) throw Error('isolated_native_build_required');
}
requireIsolation();
const storageKey = `isolated_recourse_backups_${config.instanceId.slice(2)}`;
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
function validateKey(key: string): void {
  if (!/^provian_cloud_backup_v2(?:__0x[0-9a-f]{40})?$/.test(key)) throw Error('isolated_backup_key_refused');
}
function validateCiphertext(value: string): void {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('isolated_backup_ciphertext_required');
  const blob = parsed as Record<string, unknown>;
  if (Object.keys(blob).some(key => !['version', 'salt', 'nonce', 'ciphertext', 'iterations', 'wallet_address'].includes(key))
    || blob.version !== 2 || typeof blob.salt !== 'string' || !/^[0-9a-f]{64}$/.test(blob.salt)
    || typeof blob.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(blob.nonce)
    || typeof blob.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){16,}$/.test(blob.ciphertext)
    || blob.iterations !== PBKDF2_ITERATIONS || typeof blob.wallet_address !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(blob.wallet_address)) throw Error('isolated_backup_ciphertext_required');
}
async function read(): Promise<Record<string, string>> {
  requireIsolation();
  const raw = await SecureStore.getItemAsync(storageKey, options);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('isolated_backup_store_invalid');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    validateKey(key);
    if (typeof value !== 'string') throw Error('isolated_backup_store_invalid');
    validateCiphertext(value); result[key] = value;
  }
  return result;
}
let tail: Promise<void> = Promise.resolve();
async function change(key: string, value?: string): Promise<void> {
  requireIsolation(); validateKey(key);
  if (value !== undefined) validateCiphertext(value);
  const pending = tail.then(async () => {
    const records = await read();
    if (value === undefined) delete records[key]; else records[key] = value;
    const encoded = JSON.stringify(records);
    await SecureStore.setItemAsync(storageKey, encoded, options);
    if (await SecureStore.getItemAsync(storageKey, options) !== encoded) throw Error('isolated_backup_write_unconfirmed');
  });
  tail = pending.catch(() => undefined);
  return pending;
}
export function isCloudKeychainAvailable(): boolean { requireIsolation(); return true; }
export async function isSyncAvailable(): Promise<boolean> { requireIsolation(); return true; }
export async function signInForRecovery(): Promise<boolean> { requireIsolation(); return true; }
export function cloudTargetLabel(): string { requireIsolation(); return 'local simulator backup'; }
export async function storeSynced(key: string, value: string): Promise<void> { return change(key, value); }
export async function deleteSynced(key: string): Promise<void> { return change(key); }
export async function retrieveSynced(key: string): Promise<string | null> { validateKey(key); return (await read())[key] ?? null; }
export async function listSyncedKeys(): Promise<string[]> { return Object.keys(await read()); }
export async function verifySync(key: string): Promise<boolean> { return await retrieveSynced(key) !== null; }
