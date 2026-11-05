import { withBiometricAction } from '../../security/biometricAction';
vi.mock('../../security/requireBiometric', () => ({ requireBiometric: vi.fn(async () => { if (session.declineOnce) { session.declineOnce=false; throw new Error('User cancelled biometric prompt'); } session.valid=true; return true; }) }));
/**
 * Recovery PE seams — Pass-2 WS7 behavioral coverage (findings #3, #35), on the LEGACY archive path.
 *
 * PE METER : the relay keeps no PEs, so recovery never asks it for any, and new
 * PEs are backed up as encrypted files by `core/meter/peCloudBackup.ts` (its own suite). Wallets an
 * earlier build backed up as keychain month archives must still restore, so these tests seed the
 * cloud the way that build did (`priorBuildBackup`, transcribing the retired `pushToCloud`) and prove:
 *
 * #3 After a cloud restore, Activity (the hot tier) is repopulated AND CHAIN_HEAD_KEY is set to
 * the restored chain tip; the seed-derived archive needs a biometric SESSION.
 *
 * #35 Ordering: restore must run (and set the head) BEFORE the first new PE is created, or the
 * new PE forks from GENESIS. The "broken ordering" test reproduces the fork.
 *
 * Skip: continuing without history restores NOTHING and asks the relay for nothing (the former
 * seedless backend-summary path is gone with the relay's PE store).
 *
 * (#4, the hot-tier mirror to synced keychain items, is retired: every PE is in the meter's backup.)
 *
 * Boundaries faked: native cloud transport, the seed (SeedManager.getMnemonic), the device key
 * (KeyManager), file system, footprint + relay. Everything between (AES-GCM archive crypto,
 * seed-derived key, archive index, tier classification, chain-head wiring, real createEnvelope) is
 * real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fsStore, cloud, MNEMONIC, session } = vi.hoisted(() => ({
    fsStore: new Map<string, string>(),
    cloud: new Map<string, string>(),
    MNEMONIC: 'test test test test test test test test test test test junk',
    // Models SeedManager's biometric-SESSION gate (the real failure mode for #3):
    // getMnemonic throws unless requireBiometricSession() has been called. A fresh
    // device starts with no session (and no cached archive key), so the only way
    // restore can decrypt the seed-derived archive is if the recovery screen
    // established a session first. We deliberately do NOT pre-seed/bypass this.
    // declineOnce models a user dismissing/failing the biometric prompt once.
    session: { valid: false, declineOnce: false },
}));

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
        clear: vi.fn(async () => { mem.clear(); }),
        multiSet: vi.fn(async (pairs: [string, string][]) => { pairs.forEach(([k, v]) => mem.set(k, v)); }),
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

// Restored seed on the "new device" returns the SAME mnemonic, so the
// seed-derived archive key re-derives identically and the archives decrypt -
// BUT only once a biometric session exists. getMnemonic faithfully throws the
// BiometricSessionRequiredError SeedManager throws (code-bearing), so a test
// that forgets the session reproduces the real fresh-reinstall #3 failure
// instead of silently passing. requireBiometricSession opens the session.
vi.mock('../../wallet/SeedManager', () => ({
    default: {
        getMnemonic: vi.fn(async (action) => {
            if (!(await import('../../security/biometricAction')).isBiometricActionValid(action)) throw new Error('no action');
            return MNEMONIC;
        }),
    },
}));

// Device key for the REAL createEnvelope path. verifySignature returns valid so
// PECloudSync's archive signature check (via the real ProvenanceEnvelopeManager)
// passes on restore.
vi.mock('../../security/KeyManager', () => ({
    default: {
        getAddress: vi.fn().mockResolvedValue('0xabc0000000000000000000000000000000000001'),
        hasKey: vi.fn().mockResolvedValue(true),
        generateKey: vi.fn().mockResolvedValue({}),
        performDeviceAttestation: vi.fn().mockResolvedValue({
            deviceId: 'dev-1',
            isHardwareBacked: true,
            securityLevel: 'hardware',
        }),
        signPayload: vi.fn().mockResolvedValue('sig-deadbeef'),
        verifySignature: vi.fn().mockResolvedValue({ isValid: true }),
    },
}));

vi.mock('../../footprint/FootprintService', () => ({
    ingestPE: vi.fn().mockResolvedValue(undefined),
    estimateFromPE: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../services/RelayAPIService', () => ({
    default: {
        // Recovery never asks the relay for a PE (it keeps none). Watched so a regression shows.
        meterRequest: vi.fn().mockResolvedValue({ status: 404, body: null, error: null }),
    },
}));

import PELifecycleManager from '../PELifecycleManager';
import PECloudSync from '../PECloudSync';
import ProvenanceEnvelopeManager, { EnvelopeContext } from '../ProvenanceEnvelopeManager';
import SeedManager from '../../wallet/SeedManager';
import RelayAPIService from '../../../services/RelayAPIService';
import { restoreActivityHistory } from '../../recovery/restoreActivityHistory';
import { hashEnvelopeCanonical } from '../peHash';
import { getItemHmac, setItemHmac } from '../../security/hmacAsyncStorage';
import { ProvenanceEnvelope } from '../types';
import { GENESIS_PREV_HASH } from '../constants';
import * as SecureStore from 'expo-secure-store';

const TIERED_KEY = 'provian_pe_tiered';
const CHAIN_HEAD_KEY = 'provian_pe_chain_head';
const SALT_KEY = 'provian_pe_encryption_salt';
const INDEX_CACHE = 'provian_pe_cloud_index';
const MIGRATION_KEY = 'provian_pe_migration_complete';
const ARCHIVE_KEY_CACHE = 'provian_pe_archive_key';

/** Build a chain of `n` RECENT (hot-tier) PEs with valid prev links. */
async function buildHotChain(n: number): Promise<ProvenanceEnvelope[]> {
    const base = Date.now() - n * 1000; // all within the last few seconds -> hot
    const out: ProvenanceEnvelope[] = [];
    let prev = GENESIS_PREV_HASH;
    for (let i = 0; i < n; i++) {
        const pe = {
            envelope_id: `env-${i}`,
            prev_envelope_hash: prev,
            timestamp: base + i * 1000,
            actor_address: '0xabc',
            chain_id: 8453,
            action_type: 'ai_conversation',
            intent_text: `pe number ${i}`,
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
        out.push(pe);
        prev = await hashEnvelopeCanonical(pe);
    }
    return out;
}

async function seedHotTier(pes: ProvenanceEnvelope[]): Promise<void> {
    mem.set(MIGRATION_KEY, 'true');
    await setItemHmac(TIERED_KEY, {
        version: 1,
        hotPEs: pes,
        coldHashes: [],
        warmBoundaryHash: GENESIS_PREV_HASH,
        lastArchivalAt: Date.now(),
        migrationComplete: true,
    });
}

/**
 * Establish a biometric session — what the recovery screen now does before
 * restore (and what a device does at unlock during normal operation, so the
 * archive-key derivation works on the backup side too).
 */
async function unlock(): Promise<void> {
    await withBiometricAction('test: read seed', async action => {
        await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction: action });
    });
}

/** What an earlier build did for a backup: archive the PEs locally, then push the archives + index to the synced keychain. */
async function priorBuildBackup(pes: ProvenanceEnvelope[]): Promise<void> {
    await seedHotTier(pes);
    await unlock();
    await PECloudSync.initialize();
    await PECloudSync.syncPEsToCloud(pes);
    const sync = PECloudSync as unknown as { getCloudArchiveIndex(): Promise<{ archives: { fileName: string }[] } | null>; cloudKeyForFile(f: string): string };
    const index = await sync.getCloudArchiveIndex();
    if (!index) throw new Error('no local archive index');
    for (const entry of index.archives) {
        const path = [...fsStore.keys()].find((k) => k.endsWith(`/${entry.fileName}`));
        if (path) cloud.set(sync.cloudKeyForFile(entry.fileName), fsStore.get(path)!);
    }
    cloud.set('provian_pe_index', JSON.stringify(index));
}

/** No meter backup in these tests (the legacy archive is what is restored). */
const noMeterBackup = async () => ({ found: false, activityRestored: 0, received: 0, devices: [] as { imported: number }[] });

/**
 * Device loss: local app state gone, cloud + restored seed remain. A FRESH
 * device has NO biometric session and NO device-only archive-key cache, so
 * restore must re-establish a session to read the seed (the #3 failure mode).
 */
async function simulateDeviceWipe(): Promise<void> {
    mem.clear();
    fsStore.clear();
    (PECloudSync as unknown as { encryptionKey: string | null }).encryptionKey = null;
    await SecureStore.deleteItemAsync(ARCHIVE_KEY_CACHE);
    session.valid = false; // fresh process: no biometric session
}

function resetManager(): void {
    const mgr = ProvenanceEnvelopeManager as unknown as {
        pendingQueue: ProvenanceEnvelope[];
        flushTimer: ReturnType<typeof setTimeout> | null;
        hashCache: Map<string, string>;
        lastVerifiedIndex: number;
        lastVerifiedHash: string;
    };
    if (mgr.flushTimer) { clearTimeout(mgr.flushTimer); mgr.flushTimer = null; }
    mgr.pendingQueue = [];
    mgr.hashCache?.clear?.();
    mgr.lastVerifiedIndex = -1;
    mgr.lastVerifiedHash = '';
}

function ctx(i: number): EnvelopeContext {
    return {
        actionType: 'wallet_created',
        intentText: `restored-${i}`,
        assetSymbol: 'ETH',
        amount: '0',
        chainId: 0,
        riskScore: 0,
        riskCategory: 'low',
        policyDecision: 'allow',
    };
}

beforeEach(async () => {
    mem.clear();
    fsStore.clear();
    cloud.clear();
    session.valid = false;
    session.declineOnce = false;
    (PECloudSync as unknown as { encryptionKey: string | null }).encryptionKey = null;
    await SecureStore.deleteItemAsync(ARCHIVE_KEY_CACHE);
    resetManager();
});

describe('WS7 #3 — cloud restore repopulates Activity and sets the chain head', () => {
    it('restorePEsAfterRecovery sets CHAIN_HEAD_KEY to the restored chain tip', async () => {
        const chain = await buildHotChain(4);
        await priorBuildBackup(chain);

        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();
        // Head is unset on a fresh device.
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBeNull();

        await unlock();
        const restore = await PELifecycleManager.restorePEsAfterRecovery();
        expect(restore.restoredCount).toBe(4);

        // Head now points at the restored tip — not GENESIS, not unset.
        const head = await getItemHmac<string>(CHAIN_HEAD_KEY);
        expect(head).toBe(tipHash);
        expect(head).not.toBe(GENESIS_PREV_HASH);
    });
});

describe('WS7 #35 — ordering: a fresh PE after recovery links to the restored tip', () => {
    it('fixed ordering (await restore, THEN create) links the new PE to the restored tip', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);
        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();
        resetManager();

        // Screen order after the fix: session -> await restore (writes head) ->
        // create.
        await unlock();
        await PELifecycleManager.restorePEsAfterRecovery();
        const created = await ProvenanceEnvelopeManager.createEnvelope(ctx(99));

        expect(created.prev_envelope_hash).toBe(tipHash);
        expect(created.prev_envelope_hash).not.toBe(GENESIS_PREV_HASH);
    });

    it('broken ordering (create BEFORE restore completes) forks the chain — the bug this fix closes', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);
        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();
        resetManager();
        await unlock(); // session is orthogonal to ordering; isolate the race

        // The OLD (un-awaited) order: createEnvelope wins the race and links to
        // GENESIS because the head is still unset...
        const created = await ProvenanceEnvelopeManager.createEnvelope(ctx(99));
        expect(created.prev_envelope_hash).toBe(GENESIS_PREV_HASH);

        // ...then the slow restore overwrites the head to the restored tip.
        await PELifecycleManager.restorePEsAfterRecovery();
        const head = await getItemHmac<string>(CHAIN_HEAD_KEY);
        expect(head).toBe(tipHash);

        // FORK: the new PE points at GENESIS while the canonical head points at
        // the restored tip — the new PE is off the restored chain.
        expect(created.prev_envelope_hash).not.toBe(head);
    });
});

describe('WS7 #3 — the seed-derived archive needs a biometric SESSION, not just a present seed', () => {
    // The seed IS present after a cloud-PIN/seed-phrase import, but the archive
    // is encrypted with a seed-derived key and getMnemonic is session-gated. On a
    // fresh reinstall the device-only key cache is gone, so getMnemonic is the
    // ONLY key source — and it throws without a session. These tests reproduce
    // that fresh-device state (no pre-seeded keychain, no pre-opened session).

    it('without a biometric session, cloud-archive restore no-ops — Activity empty, head unset (the #3 reopen)', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);

        await simulateDeviceWipe(); // fresh device: no session, no cached key

        // Recovery WITHOUT establishing a session (the pre-fix screen behavior):
        // getEncryptionKey -> getMnemonic throws BiometricSessionRequired, the
        // per-archive fetch is caught, the cloud path yields nothing, and the
        // relay is never asked.
        const restore = await PELifecycleManager.restorePEsAfterRecovery();
        expect(restore.source).toBe('none');
        expect(restore.restoredCount).toBe(0);
        expect(await PELifecycleManager.getHotTierPEs()).toHaveLength(0);
        // The head stays unset — a subsequent PE would fork from GENESIS.
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBeNull();
    });

    it('establishing the session first (the screen requireBiometricSession fix) makes restore populate Activity + head', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);
        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();

        // The fix: the recovery screen calls requireBiometricSession BEFORE
        // restore, so getMnemonic can derive the archive key.
        const restore = await withBiometricAction('Restore your activity history', action => PELifecycleManager.restorePEsAfterRecovery(action));

        expect(restore.source).toBe('cloud');
        expect(restore.restoredCount).toBe(3);
        expect((await PELifecycleManager.getHotTierPEs()).map(p => p.envelope_id).sort())
            .toEqual(['env-0', 'env-1', 'env-2']);
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBe(tipHash);
    });
});

describe('WS7 #3 — seed-phrase recovery reaches the cloud ARCHIVE', () => {
    // Regression discovered while fixing the session gate: the seed-phrase path
    // (ImportRecoveryPhraseScreen) was ALSO never reaching the archive — without
    // a session getMnemonic threw, the per-archive fetch was swallowed, and it
    // fell to the backend-summary cold path (hash-only, no head) every time.
    // This drives the screen's exact post-fix sequence
    //   requireBiometricSession -> restorePEsAfterRecovery -> createEnvelope
    // and proves it exercises fetchPEsByMonth/loadArchiveFile and restores REAL
    // full-payload PEs from the archive, NOT summaries.
    it('with the session established, drives fetchPEsByMonth/loadArchiveFile and recovers real archive PEs (source=cloud, relay never asked)', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);
        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();
        resetManager();

        // Observe the archive read path directly (fetchPEsByMonth -> loadArchiveFile).
        const fetchSpy = vi.spyOn(PECloudSync, 'fetchPEsByMonth');
        const relaySpy = vi.mocked(RelayAPIService.meterRequest);
        relaySpy.mockClear();

        // ImportRecoveryPhraseScreen.performRestore order after the fix.
        const restore = await withBiometricAction('Restore your activity history', action => PELifecycleManager.restorePEsAfterRecovery(action));
        const walletCreated = await ProvenanceEnvelopeManager.createEnvelope({
            actionType: 'wallet_created',
            intentText: 'Wallet restored from recovery phrase',
            assetSymbol: 'ETH',
            amount: '0',
            chainId: 0,
            riskScore: 0,
            riskCategory: 'low',
            policyDecision: 'allow',
            actorAddress: '0xabc0000000000000000000000000000000000001',
        });

        // Reached the ARCHIVE, not the backend-summary cold path.
        expect(fetchSpy).toHaveBeenCalledWith(expect.any(String), expect.toSatisfy((value: unknown) => value === undefined || (typeof value === 'object' && value !== null && 'nativeId' in value)));
        expect(restore.source).toBe('cloud');
        expect(restore.restoredCount).toBe(3);
        expect(relaySpy).not.toHaveBeenCalled();

        // Recovered REAL full-payload PEs (carry their original signatures),
        // not hash-only summary stand-ins.
        const restored = await PELifecycleManager.getHotTierPEs();
        expect(restored.map(p => p.envelope_id).sort()).toEqual(['env-0', 'env-1', 'env-2']);
        expect(restored.every(p => typeof p.signature === 'string' && p.signature.length > 0)).toBe(true);

        // End-to-end: the wallet_created PE the seed-phrase screen records links to
        // the archive-restored tip, not GENESIS.
        expect(walletCreated.prev_envelope_hash).toBe(tipHash);
        expect(walletCreated.prev_envelope_hash).not.toBe(GENESIS_PREV_HASH);

        fetchSpy.mockRestore();
    });
});

describe('WS7 follow-up — declined biometric surfaces retry/skip, never a silent empty-Activity success', () => {
    // restoreActivityHistory is the shared orchestration both recovery screens
    // call. mode 'with_session' on a DECLINED prompt returns session_declined
    // WITHOUT restoring (the screen shows Retry/Skip); 'skip' restores nothing. The wallet is recovered before either
    // runs, so neither blocks wallet access.

    it('decline-then-retry-succeeds: first decline does NOT restore (Activity empty, head unset, backend not taken); retry restores the archive and a new PE links to the tip', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain); // device A unlocked while it backs up
        const tipHash = await hashEnvelopeCanonical(chain[chain.length - 1]);

        await simulateDeviceWipe();
        resetManager();
        const relaySpy = vi.mocked(RelayAPIService.meterRequest);
        relaySpy.mockClear();

        // First attempt: biometric DECLINED.
        session.declineOnce = true;
        const first = await restoreActivityHistory('with_session', noMeterBackup);
        expect(first.status).toBe('session_declined');
        // No restore ran: Activity empty, head unset, and the backend-summary
        // cold path was NOT silently taken (the screen will show Retry/Skip).
        expect(await PELifecycleManager.getHotTierPEs()).toHaveLength(0);
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBeNull();
        expect(relaySpy).not.toHaveBeenCalled();

        // Retry: the seed is already in SecureStore, so this is a real
        // re-attempt — the session establishes and the archive restores.
        const retry = await restoreActivityHistory('with_session', noMeterBackup);
        expect(retry.status).toBe('restored');
        if (retry.status !== 'restored') throw new Error('expected restored outcome');
        expect(retry.source).toBe('cloud');
        expect(retry.restoredCount).toBe(3);
        expect((await PELifecycleManager.getHotTierPEs()).map(p => p.envelope_id).sort())
            .toEqual(['env-0', 'env-1', 'env-2']);
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBe(tipHash);

        // The wallet_created PE recorded after a successful retry links to the
        // restored tip, not GENESIS.
        const created = await ProvenanceEnvelopeManager.createEnvelope(ctx(99));
        expect(created.prev_envelope_hash).toBe(tipHash);
        expect(created.prev_envelope_hash).not.toBe(GENESIS_PREV_HASH);
    });

    it('decline-then-explicit-skip: Skip restores nothing, asks the relay nothing, and recovery still completes (user reaches their wallet)', async () => {
        const chain = await buildHotChain(3);
        await priorBuildBackup(chain);

        await simulateDeviceWipe();
        resetManager();
        const relaySpy = vi.mocked(RelayAPIService.meterRequest);
        relaySpy.mockClear();

        // Decline first.
        session.declineOnce = true;
        expect((await restoreActivityHistory('with_session', noMeterBackup)).status).toBe('session_declined');

        // User explicitly chooses Skip: nothing is restored, and nothing is asked of the relay.
        const skip = await restoreActivityHistory('skip', noMeterBackup);
        expect(skip).toEqual({ status: 'skipped', restoredCount: 0, source: 'none' });
        expect(relaySpy).not.toHaveBeenCalled();
        // The seed-derived archive was NOT decrypted (no session): no full PEs,
        // head still unset.
        expect(await PELifecycleManager.getHotTierPEs()).toHaveLength(0);
        expect(await getItemHmac<string>(CHAIN_HEAD_KEY)).toBeNull();

        // Recovery completes regardless — the wallet_created PE records (links to
        // GENESIS, the correct anchor for an unrestored chain) and the screen
        // navigates into the wallet. Wallet access is never blocked.
        const created = await ProvenanceEnvelopeManager.createEnvelope(ctx(99));
        expect(created.prev_envelope_hash).toBe(GENESIS_PREV_HASH);
    });
});
