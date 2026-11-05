import { withBiometricAction } from '../../security/biometricAction';
/**
 * PE cloud backup round-trip — WS2 proof (audit remediation), now the LEGACY READ path.
 *
 * PE METER : the app no longer pushes month archives to synced keychain items —
 * every PE is backed up as encrypted FILES by `core/meter/peCloudBackup.ts` (tested in
 * `core/meter/__tests__/peCloudBackup.test.ts`). Archives an earlier build already pushed must stay
 * recoverable, so this suite seeds the cloud the way that build did (`priorBuildPush`, transcribed
 * from the retired `pushToCloud`) and proves the read path still restores them.
 *
 * Proves the PE cloud backup actually works end to end, to the fork-harness
 * standard the user asked for: push real PEs -> simulate device loss -> restore
 * the seed on a "new device" -> pull from cloud -> the PE chain reconstructs
 * byte-identical with prev_envelope_hash links intact. Also proves the new
 * AES-256-GCM layer is authenticated (a flipped byte fails to decrypt rather
 * than silently returning garbage), and that the archive key is SEED-derived
 * (recoverable on another device), not per-device.
 *
 * The native cloud transport (iCloud Keychain / Drive) and the real SeedManager
 * are faked at their boundaries — that is the only [DEVICE]-pending residual.
 * Everything between (AES-GCM crypto, key derivation, archive index, push/pull
 * wiring, chain reconstruction) is exercised for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fsStore, cloud, MNEMONIC } = vi.hoisted(() => ({
    fsStore: new Map<string, string>(),
    cloud: new Map<string, string>(),
    MNEMONIC: 'test test test test test test test test test test test junk',
}));

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        clear: vi.fn(async () => { mem.clear(); }),
    },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///doc/',
    getInfoAsync: vi.fn(async (p: string) => ({ exists: p.endsWith('/') ? true : fsStore.has(p), uri: p })),
    makeDirectoryAsync: vi.fn(async () => {}),
    readAsStringAsync: vi.fn(async (p: string) => {
        if (!fsStore.has(p)) throw new Error(`ENOENT: ${p}`);
        return fsStore.get(p)!;
    }),
    writeAsStringAsync: vi.fn(async (p: string, v: string) => { fsStore.set(p, v); }),
}));

// In-memory "cloud" (iCloud Keychain / Drive appDataFolder boundary).
vi.mock('../../recovery/cloud/ProvianCloudKeychainSync', () => ({
    storeSynced: vi.fn(async (k: string, v: string) => { cloud.set(k, v); }),
    retrieveSynced: vi.fn(async (k: string) => (cloud.has(k) ? cloud.get(k)! : null)),
}));

vi.mock('../../recovery/cloud/CloudBackupV2', () => ({
    hasCloudBackup: vi.fn(async () => true),
}));

// Restored seed on the "new device" returns the SAME mnemonic.
vi.mock('../../wallet/SeedManager', () => ({
    default: { getMnemonic: vi.fn(async () => MNEMONIC) },
}));

// Avoid importing the real manager (pulls native modules); only verifyAllPESignatures is used.
vi.mock('../ProvenanceEnvelopeManager', () => ({
    default: {
        verifyAllPESignatures: vi.fn(async () => ({
            tamperedIds: [], missingSignatureIds: [], unverifiableIds: [], validCount: 0,
        })),
    },
}));

import PECloudSync from '../PECloudSync';
import { hashEnvelopeCanonical } from '../peHash';
import { ProvenanceEnvelope } from '../types';
import { GENESIS_PREV_HASH } from '../constants';
import * as SecureStore from 'expo-secure-store';

const ARCHIVE_KEY_CACHE = 'provian_pe_archive_key';
const SALT_KEY = 'provian_pe_encryption_salt';
const INDEX_CACHE = 'provian_pe_cloud_index';
// June 2026 timestamps so all PEs land in one month archive.
const T0 = Date.UTC(2026, 5, 1);

function pe(i: number, prev: string): ProvenanceEnvelope {
    return {
        envelope_id: `env-${i}`,
        prev_envelope_hash: prev,
        timestamp: T0 + i * 1000,
        actor_address: '0xabc',
        chain_id: 8453,
        action_type: 'ai_conversation',
        intent_text: `pe number ${i} with some content`,
        asset_symbol: 'PVT',
        amount: '0',
        risk_score: 0,
        risk_category: 'low',
        policy_decision: 'allow',
        device_attestation_id: 'dev-1',
        signature: `sig-${i}`,
        subscription_state_snapshot: 'active',
        null_state_flags: [],
    } as ProvenanceEnvelope;
}

async function buildChain(n: number): Promise<ProvenanceEnvelope[]> {
    const out: ProvenanceEnvelope[] = [];
    let prev = GENESIS_PREV_HASH;
    for (let i = 0; i < n; i++) {
        const p = pe(i, prev);
        out.push(p);
        prev = await hashEnvelopeCanonical(p);
    }
    return out;
}

/** What an earlier build's `pushToCloud` did: copy each local month archive, then the index, to the synced keychain. */
async function priorBuildPush(): Promise<void> {
    const sync = PECloudSync as unknown as { getCloudArchiveIndex(): Promise<{ archives: { fileName: string }[] } | null>; cloudKeyForFile(f: string): string };
    const index = await sync.getCloudArchiveIndex();
    if (!index) return;
    for (const entry of index.archives) {
        const path = [...fsStore.keys()].find((k) => k.endsWith(`/${entry.fileName}`));
        if (path) cloud.set(sync.cloudKeyForFile(entry.fileName), fsStore.get(path)!);
    }
    cloud.set('provian_pe_index', JSON.stringify(index));
}

function simulateNewDevice(): void {
    // New device: wipe local app state (AsyncStorage + local FS + the device-only
    // derived-key cache + the in-memory singleton key) but keep the cloud and the
    // restored seed.
    mem.delete(SALT_KEY);
    mem.delete(INDEX_CACHE);
    fsStore.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (PECloudSync as any).encryptionKey = null;
}

beforeEach(async () => {
    mem.clear();
    fsStore.clear();
    cloud.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (PECloudSync as any).encryptionKey = null;
    await SecureStore.deleteItemAsync(ARCHIVE_KEY_CACHE);
});

describe('WS2 PE cloud backup round-trip', () => {
    it('reconstructs the PE chain byte-identical after device loss + cloud restore', async () => {
        const chain = await buildChain(4);

        // --- Device A: archive to cloud ---
        await PECloudSync.initialize();
        await withBiometricAction('backup', action => PECloudSync.syncPEsToCloud(chain, action));
        // The retired push writes nothing to the synced keychain any more (RED for a regression).
        expect(cloud.size).toBe(0);
        await priorBuildPush();

        // Cloud actually received the archive + index.
        expect(cloud.has('provian_pe_index')).toBe(true);
        expect([...cloud.keys()].some(k => k.startsWith('provian_pe_archive_'))).toBe(true);

        // --- Simulate a new device (local state gone, cloud + seed remain) ---
        simulateNewDevice();

        // --- Device B: recover from cloud ---
        const index = await PECloudSync.getCloudArchiveIndex();
        expect(index).not.toBeNull();
        expect(index!.archives.length).toBeGreaterThan(0);
        const monthKey = index!.archives[0].monthKey;

        const recovered = await withBiometricAction('restore', action => PECloudSync.fetchPEsByMonth(monthKey, action));

        // Byte-identical recovery.
        expect(recovered).toHaveLength(chain.length);
        expect(recovered).toEqual(chain);

        // Chain links intact after the encrypt -> cloud -> decrypt round trip.
        expect(recovered[0].prev_envelope_hash).toBe(GENESIS_PREV_HASH);
        for (let i = 1;i < recovered.length;i++) {
            expect(recovered[i].prev_envelope_hash).toBe(await hashEnvelopeCanonical(recovered[i - 1]));
        }
    });

    it('uses a seed-derived (recoverable) key: a different seed cannot decrypt', async () => {
        const chain = await buildChain(2);
        await PECloudSync.initialize();
        await withBiometricAction('backup', action => PECloudSync.syncPEsToCloud(chain, action));
        await priorBuildPush();

        simulateNewDevice();
        // Restore a DIFFERENT seed on the new device.
        const SeedManager = (await import('../../wallet/SeedManager')).default as unknown as { getMnemonic: ReturnType<typeof vi.fn> };
        SeedManager.getMnemonic.mockResolvedValueOnce('zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz zzzz');
        // Also clear the salt so the wrong-seed key is derived against the cloud salt.
        await SecureStore.deleteItemAsync(ARCHIVE_KEY_CACHE);

        const index = await PECloudSync.getCloudArchiveIndex();
        const monthKey = index!.archives[0].monthKey;

        await expect(withBiometricAction('restore', action => PECloudSync.fetchPEsByMonth(monthKey, action))).rejects.toThrow();
    });

    it('AES-256-GCM is authenticated: a tampered cloud blob fails to decrypt', async () => {
        const chain = await buildChain(2);
        await PECloudSync.initialize();
        await withBiometricAction('backup', action => PECloudSync.syncPEsToCloud(chain, action));
        await priorBuildPush();

        // Corrupt one byte of the ciphertext in the cloud blob.
        const archiveKey = [...cloud.keys()].find(k => k.startsWith('provian_pe_archive_'))!;
        const blob = JSON.parse(cloud.get(archiveKey)!);
        const hex = blob.data as string;
        const flipped = (hex[10] === 'a' ? 'b' : 'a') + hex.slice(1); // mutate first char
        blob.data = hex.slice(0, 10) + (hex[10] === 'a' ? 'b' : 'a') + hex.slice(11);
        void flipped;
        cloud.set(archiveKey, JSON.stringify(blob));

        simulateNewDevice();
        const index = await PECloudSync.getCloudArchiveIndex();
        const monthKey = index!.archives[0].monthKey;

        await expect(withBiometricAction('restore', action => PECloudSync.fetchPEsByMonth(monthKey, action))).rejects.toThrow();
    });
});
