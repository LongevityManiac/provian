import { beforeEach, expect, test, vi } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import { encryptFile, decryptFile, deriveArchiveKey, PeCloudBackup, type BackupKeyProvider } from '../meter/peCloudBackup';
import { DEVICE, openStore, recordPes } from '../meter/__tests__/meterTestkit';
import { MemoryMeterFiles } from '../meter/meterFiles';
const state = vi.hoisted(() => ({ device: false, files: new Map<string, string>() }));
vi.mock('expo-device', () => ({ get isDevice() { return state.device; } }));
vi.mock('../../../scripts/recourse/native/config', () => ({ default: {
  userId:'public-fixture-eoa', relay: 'http://127.0.0.1:18551', instanceId: `0x${'12'.repeat(32)}`,
} }));
vi.mock('../meter/meterFiles', async importOriginal => ({ ...await importOriginal<typeof import('../meter/meterFiles')>(), createExpoMeterFiles: (root: string) => {
  expect(root).toBe(`isolated_recourse_cloud_${'12'.repeat(32)}_public-fixture-eoa`);
  return { read: async (name: string) => state.files.get(name) ?? null,
    writeAtomic: async (name: string, text: string) => { state.files.set(name, text); },
    list: async () => [...state.files.keys()],
  };
} }));
import { createPlatformCloudFiles } from '../../../scripts/recourse/native/cloud-files';
beforeEach(() => { state.device = false; state.files.clear(); });

test('PE backup transport stores real ciphertext locally and refuses plaintext, paths and devices', async () => {
  const transport = createPlatformCloudFiles(), key = new Uint8Array(32).fill(1), name = `pe_object_${'ab'.repeat(24)}`;
  const wire = encryptFile(key, name, 'fixture PE record', new Uint8Array(12).fill(2));
  await expect(transport.write('../escape', wire)).rejects.toThrow('name_refused');
  await expect(transport.write(name, JSON.stringify({ pe: 'plaintext' }))).rejects.toThrow('ciphertext_required');
  expect(await transport.prepare!()).toBe(false);
  await transport.write(name, wire);
  expect(await transport.list()).toEqual([name]);
  expect(await transport.prepare!()).toBe(true);
  expect(decryptFile(key, name, (await transport.read(name))!)).toBe('fixture PE record');
  expect([...state.files.values()].join('')).not.toContain('fixture PE record');
  state.device = true;
  await expect(transport.available()).rejects.toThrow('isolated_native_build_required');
  expect(() => createPlatformCloudFiles()).toThrow('isolated_native_build_required');
});

test('actual PE snapshots restore through the isolated adapter and reject tampering or swapped names', async () => {
  const mnemonic = 'test test test test test test test test test test test junk', saltHex = 'ab'.repeat(16);
  const key = await deriveArchiveKey(mnemonic, saltHex);
  const keys: BackupKeyProvider = { current: async () => ({ key, saltHex }),
    forSalt: salt => deriveArchiveKey(mnemonic, salt), adopt: async () => undefined };
  const original = await openStore(); await recordPes(original.store, 2);
  const cloud = createPlatformCloudFiles();
  expect(await new PeCloudBackup({ store: original.store, cloud, keys, randomBytes }).backup()).toMatchObject({ ok: true });
  expect((await cloud.list()).some(name => name.startsWith('pe_snapshot_'))).toBe(true);
  const fresh = await openStore(new MemoryMeterFiles(), 'isolated_restored_device');
  await new PeCloudBackup({ store: fresh.store, cloud, keys, randomBytes }).restore();
  expect((await (await fresh.store.chain(DEVICE)).allPes()).map(row => row.pe.pe_hash))
    .toEqual((await original.store.own().allPes()).map(row => row.pe.pe_hash));
  const name = (await cloud.list()).find(value => value.startsWith('pe_object_'))!;
  const wire = (await cloud.read(name))!;
  expect(() => decryptFile(key, name + 'x', wire)).toThrow();
  const box = JSON.parse(wire) as { data: string };
  const corrupt = JSON.stringify({ ...box, data: (box.data[0] === 'A' ? 'B' : 'A') + box.data.slice(1) });
  await cloud.write(name, corrupt);
  const corruptedRestore = await openStore(new MemoryMeterFiles(), 'isolated_corrupt_restore');
  const refused = await new PeCloudBackup({ store: corruptedRestore.store, cloud, keys, randomBytes }).restore();
  expect(refused.refusedFiles).toHaveLength(1);
  expect(refused.refusedFiles[0]).toMatch(/:undecryptable$/);
});
