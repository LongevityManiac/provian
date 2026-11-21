import { withBiometricAction, assertBiometricAction, isBiometricActionValid, type BiometricAction } from '../security/biometricAction';
/**
 * PE METER (app) — the production wiring of `PhoneMeter`: the relay transport under wallet auth,
 * the phone's files, the person's own iCloud / Google Drive, the seed-derived archive key, App
 * Attest, the device PE key, and the seed-derived message key. Started once from the navigator;
 * ticks every 5 minutes while the app is in the foreground and on every return to the foreground.
 *
 * Every import of an app service is lazy (inside a function) so this module never forms an import
 * cycle with the provenance manager, and nothing here loads during unit tests of other modules.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { createExpoMeterFiles } from './meterFiles';
import { createPlatformCloudFiles } from './cloudFiles';
import { createRelayMeterTransport } from './meterTransport';
import {sealPrivatePricing} from './privatePricing';
import {type PeBatch} from './meter-wire';
import { createRelayArchiveTransport } from './phoneArchive';
import { createExpoArchiveObjectCache } from './archiveObjectCache';
import { PhoneMeter, METER_TICK_MS } from './phoneMeter';
import { setRelayAuthoredListener } from './relayAuthoredInbox';
import { checkedTextHash, type BackupKeyProvider } from './peCloudBackup';
import type { PhonePeExportProgress, PhonePeExportResult } from './phoneExport';
import type { ProvenanceEnvelope } from '../provenance/types';
import { translate } from '../../i18n/translate';

const MESSAGE_KEY_PUBLISHED_KEY = 'provian_meter_message_key_published_v1';
const mailboxKeyReason = (): string => translate('biometricPrompts.openAgentRecords', 'Open the records your agents sent you');
const publishKeyReason = (): string => translate('biometricPrompts.letAgentsSendRecords', 'Let your agents send you their records');

let instance: PhoneMeter | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** An unset or malformed value is "no override"; `keepDaysOf` then bounds any number to 0..30. */
function parseKeepDaysEnv(raw: string | undefined): number | undefined {
    if (raw === undefined || !/^\d{1,2}$/.test(raw.trim())) return undefined;
    return Number(raw.trim());
}
let appStateSub: { remove(): void } | null = null;

function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
}

const backupKeys: BackupKeyProvider = {
    async current(options, biometricAction?: BiometricAction) {
        const PECloudSync = (await import('../provenance/PECloudSync')).default;
        const k = await PECloudSync.getArchiveKeyForBackup(options, biometricAction);
        return k ? { saltHex: k.saltHex, key: hexToBytes(k.keyHex) } : null;
    },
    async forSalt(saltHex, options, biometricAction?: BiometricAction) {
        const PECloudSync = (await import('../provenance/PECloudSync')).default;
        const keyHex = await PECloudSync.getArchiveKeyForSalt(saltHex, options, biometricAction);
        return keyHex ? hexToBytes(keyHex) : null;
    },
    async adopt(key) {
        const PECloudSync = (await import('../provenance/PECloudSync')).default;
        await PECloudSync.adoptArchiveKey(key.saltHex, bytesToHex(key.key));
    },
};

async function messageSecretKey(options: { allowPrompt: boolean; biometricAction?: BiometricAction }, biometricAction?: BiometricAction): Promise<Uint8Array | null> {
    biometricAction ??= options.biometricAction;
    const { cachedMessageKeyPair, getMessageKeyPair } = await import('../commons/threadCrypto');
    const cached = cachedMessageKeyPair();
    if (cached) return cached.secretKey;
    if (!isBiometricActionValid(biometricAction)) return null;
    try {
        const pair = await getMessageKeyPair(mailboxKeyReason(), biometricAction);
        await publishIfNeeded(pair.pubkeyB64u, biometricAction);
        return pair.secretKey;
    } catch {
        return null;
    }
}

async function publishIfNeeded(pubkeyB64u: string, biometricAction?: BiometricAction): Promise<boolean> {
    if ((await AsyncStorage.getItem(MESSAGE_KEY_PUBLISHED_KEY)) === pubkeyB64u) return true;
    const CommonsService = await import('../commons/CommonsService');
    await CommonsService.publishMessageKey(pubkeyB64u, biometricAction);
    await AsyncStorage.setItem(MESSAGE_KEY_PUBLISHED_KEY, pubkeyB64u);
    return true;
}

/**
 * Publish the person's message key (HKDF over the seed) if it has not been, so the relay can seal
 * relay-authored PEs to them and their linked agents can seal theirs. Silent unless allowed to prompt.
 */
async function ensureMessageKeyPublished(options: { allowPrompt: boolean; biometricAction?: BiometricAction }, biometricAction?: BiometricAction): Promise<boolean> {
    biometricAction ??= options.biometricAction;
    const { cachedMessageKeyPair, getMessageKeyPair } = await import('../commons/threadCrypto');
    const cached = cachedMessageKeyPair();
    if (cached) return publishIfNeeded(cached.pubkeyB64u, biometricAction);
    if (!isBiometricActionValid(biometricAction)) return false;
    const pair = await getMessageKeyPair(publishKeyReason(), biometricAction);
    return publishIfNeeded(pair.pubkeyB64u, biometricAction);
}

/**
 * At launch and at wallet unlock: make sure the person's message key is published. The relay seals
 * relay-authored PEs — and the history it hands back — to `commons_message_keys/{wallets doc id}`;
 * with no key there nothing can reach this phone. Order, so a prompt is shown only when needed:
 *   1. already confirmed on this install → done;
 *   2. ask the relay (no prompt): a key is there → remember it, done;
 *   3. missing → derive it from the seed (HKDF, the same key `threadCrypto` uses for Commons
 *      threads and that opens the mailbox) and publish it: silently inside a live biometric
 *      action. Without an explicit capability, wait for the next unlock.
 * Idempotent; never throws.
 */
export async function ensureMessageKeyAtLaunch(options: { allowPrompt: boolean; biometricAction?: BiometricAction }, biometricAction?: BiometricAction): Promise<boolean> {
    biometricAction ??= options.biometricAction;
    try {
        if (await AsyncStorage.getItem(MESSAGE_KEY_PUBLISHED_KEY)) return true;
        const relay = (await import('../../services/RelayAPIService')).default;
        if (!(await relay.isRegistered())) return false;
        const walletDocId = await relay.getRelayWalletId(biometricAction);
        if (!walletDocId) return false;
        const CommonsService = await import('../commons/CommonsService');
        const remote = await CommonsService.readMessageKey(walletDocId, biometricAction);
        if (remote?.pubkey_b64u) {
            // Remembered as published; if this seed's key ever differs, the next derivation republishes.
            await AsyncStorage.setItem(MESSAGE_KEY_PUBLISHED_KEY, remote.pubkey_b64u);
            return true;
        }
        return await ensureMessageKeyPublished({ allowPrompt: false, biometricAction }, biometricAction);
    } catch (err) {
        console.warn('[PE meter] message key not published yet:', err instanceof Error ? err.message : String(err));
        return false;
    }
}

/** How long the unlock waits for the session check before letting the person in anyway. */
export const UNLOCK_SESSION_CHECK_TIMEOUT_MS = 6_000;

/**
 * One participation read with the unlock's biometric action. On a 401 the relay request renews the
 * session with that same action (no new prompt). Bounded so a slow relay never holds the unlock;
 * never throws.
 */
export async function checkRelaySessionAtUnlock(
    address: string | null,
    biometricAction: BiometricAction,
    timeoutMs: number = UNLOCK_SESSION_CHECK_TIMEOUT_MS,
): Promise<void> {
    return checkRelaySession(address, biometricAction, timeoutMs);
}

/** One bounded participation read (with the action when given), its answer saved. Never throws. */
async function checkRelaySession(
    address: string | null,
    biometricAction?: BiometricAction,
    timeoutMs: number = UNLOCK_SESSION_CHECK_TIMEOUT_MS,
): Promise<void> {
    if (!address) return;
    try {
        const relay = (await import('../../services/RelayAPIService')).default;
        if (!(await relay.isRegistered())) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const accrual = await Promise.race([relay.getPVTAccrual(biometricAction), timedOut]).finally(() => clearTimeout(timer));
        if (accrual) {
            const { saveWalletTop } = await import('../wallet/walletTopCache');
            await saveWalletTop('accrual', address, accrual);
        }
    } catch (err) {
        console.warn('[WalletLock] relay session check deferred', err instanceof Error ? err.message : String(err));
    }
}

/** When the lock screen started its session check (0 = no check this foreground). */
let lockProbeStartedAtMs = 0;

/**
 * At the lock screen, before any approval: read the participation summary with no biometric action.
 * A healthy session answers (and the answer is saved for the wallet screen); an expired one answers
 * 401, which marks the session rejected. Never prompts, never throws.
 */
export function probeRelaySessionAtLock(address: string | null, nowMs: number = Date.now()): void {
    lockProbeStartedAtMs = nowMs;
    void checkRelaySession(address);
}

/** The relay surface the unlock uses (injectable for tests). */
export interface UnlockRelay {
    isRegistered(): Promise<boolean>;
    relaySessionRejected(): boolean;
    sessionAcceptedSince(sinceMs: number): boolean;
    prepareSessionRenewal(address: string, biometricAction: BiometricAction): Promise<boolean>;
    renewWithPresignedProof(address: string): Promise<boolean>;
}

/** The longest the unlock spends signing a renewal proof (hash accounts read Base first). */
export const UNLOCK_PRESIGN_TIMEOUT_MS = 3_000;

/**
 * Inside the unlock approval, before landing. No relay request is made or awaited here:
 * - the relay already accepted this session since the lock screen appeared → nothing to do;
 * - otherwise (rejected, or not answered yet) → sign a renewal proof locally, bounded, so a 401
 *   found now or after landing renews with no second prompt and no wait.
 * Never throws.
 */
export async function prepareRenewalAtUnlock(
    address: string | null,
    biometricAction: BiometricAction,
    relay?: UnlockRelay,
    sinceMs: number = lockProbeStartedAtMs || Date.now(),
    timeoutMs: number = UNLOCK_PRESIGN_TIMEOUT_MS,
): Promise<'healthy' | 'signed' | 'skipped'> {
    if (!address) return 'skipped';
    try {
        const r = relay ?? ((await import('../../services/RelayAPIService')).default as UnlockRelay);
        if (!(await r.isRegistered())) return 'skipped';
        if (r.sessionAcceptedSince(sinceMs)) return 'healthy';
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
        const signed = await Promise.race([r.prepareSessionRenewal(address, biometricAction), timedOut])
            .finally(() => clearTimeout(timer));
        return signed ? 'signed' : 'skipped';
    } catch (err) {
        console.warn('[WalletLock] renewal proof deferred', err instanceof Error ? err.message : String(err));
        return 'skipped';
    }
}

/**
 * After landing, not awaited by the unlock: if the relay already rejected the session, renew it
 * now with the pre-signed proof (no approval needed). A later 401 renews the same way on its own.
 */
export function renewRejectedSessionAfterUnlock(address: string | null, relay?: UnlockRelay): Promise<boolean> {
    return (async () => {
        if (!address) return false;
        const r = relay ?? ((await import('../../services/RelayAPIService')).default as UnlockRelay);
        return r.relaySessionRejected() ? r.renewWithPresignedProof(address) : false;
    })().catch(() => false);
}

export const UNLOCK_MAINTENANCE_TIMEOUT_MS = 6_000;
/**
 * The longest any one unlock-maintenance step may run, counted from the unlock. A step still
 * running then is abandoned and reported; every step runs again at the next unlock, and the
 * relay, message-key and Solana steps also on every foreground and meter tick.
 */
export const UNLOCK_STEP_CAP_MS = 45_000;

export type UnlockStepOutcome = 'done' | 'failed' | 'skipped' | 'gave_up';
export interface UnlockStepReport { readonly step: string; readonly outcome: UnlockStepOutcome; readonly ms: number; readonly error?: string }

/** Steps of the most recent unlock that are still running (in order of start). */
const runningUnlockSteps = new Map<string, number>();
let lastUnlockReport: UnlockStepReport[] = [];
/** The outcome of each step of the latest unlock (diagnostics and tests). */
export function lastUnlockMaintenanceReport(): readonly UnlockStepReport[] { return lastUnlockReport; }

/** Run one named step: it settles as done, failed, skipped, or gave_up at `capMs`. Never throws. */
export async function runUnlockStep(
    step: string,
    fn: () => Promise<unknown>,
    capMs: number = UNLOCK_STEP_CAP_MS,
    report: UnlockStepReport[] = lastUnlockReport,
    now: () => number = Date.now,
): Promise<UnlockStepOutcome> {
    const started = now();
    runningUnlockSteps.set(step, started);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<'gave_up'>(resolve => { timer = setTimeout(() => resolve('gave_up'), capMs); });
    const work = Promise.resolve().then(fn).then(
        (v): UnlockStepOutcome => (v === 'skipped' ? 'skipped' : 'done'),
        (err: unknown): UnlockStepOutcome => {
            report.push({ step, outcome: 'failed', ms: now() - started, error: err instanceof Error ? err.message : String(err) });
            return 'failed';
        },
    );
    const outcome = await Promise.race([work, cap]).finally(() => clearTimeout(timer));
    runningUnlockSteps.delete(step);
    if (outcome !== 'failed') report.push({ step, outcome, ms: now() - started });
    const line = `[WalletLock] unlock step ${step}: ${outcome} in ${now() - started}ms`;
    if (outcome === 'gave_up' || outcome === 'failed') console.warn(line + (outcome === 'gave_up' ? ' (runs again at the next unlock)' : `: ${report[report.length - 1]?.error ?? ''}`));
    else console.log(line);
    return outcome;
}

/**
 * Run after navigation. Work that needs the unlock approval gets `timeoutMs`; the approval then
 * ends and each step still running is named in the log and given at most `UNLOCK_STEP_CAP_MS`
 * in all. Never throws and never waits on a step beyond the window.
 */
export async function onWalletUnlocked(
    address: string | null,
    biometricAction: BiometricAction,
    timeoutMs: number = UNLOCK_MAINTENANCE_TIMEOUT_MS,
    capMs: number = UNLOCK_STEP_CAP_MS,
): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    runningUnlockSteps.clear();
    const report: UnlockStepReport[] = [];
    lastUnlockReport = report;
    const started = Date.now();
    try {
        const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), timeoutMs); });
        const all = maintainUnlockedWallet(address, biometricAction, controller.signal, (step, fn) => {
            // Each step's cap counts from the unlock, so nothing outlives it by more than capMs.
            return runUnlockStep(step, fn, Math.max(0, capMs - (Date.now() - started)), report);
        });
        const winner = await Promise.race([deadline, all.then(() => 'finished' as const)]);
        if (winner === 'deadline') {
            console.warn(`[WalletLock] unlock maintenance deferred after ${timeoutMs}ms; still running: ${[...runningUnlockSteps.keys()].join(', ') || 'none'}`);
        }
    } catch (err) {
        console.warn('[WalletLock] unlock maintenance deferred', err instanceof Error ? err.message : String(err));
    } finally {
        clearTimeout(timer);
        controller.abort();
        // Mailbox and archive maintenance use derived caches, without the unlock grant.
        void runUnlockStep('meter-after-unlock', () => getPhoneMeter().afterUnlock(), capMs, report);
    }
}

type UnlockStepRunner = (step: string, fn: () => Promise<unknown>) => Promise<UnlockStepOutcome>;

async function maintainUnlockedWallet(address: string | null, biometricAction: BiometricAction, signal: AbortSignal, step: UnlockStepRunner): Promise<void> {
    const stillApproved = () => !signal.aborted && isBiometricActionValid(biometricAction);
    if (!stillApproved()) return;

    // Get a renewal proof while the unlock grant is live even if another service is slow.
    const renewal = step('renewal-proof', async () => {
        const r = await prepareRenewalAtUnlock(address, biometricAction);
        if (stillApproved()) void renewRejectedSessionAfterUnlock(address);
        return r === 'skipped' ? 'skipped' : r;
    });
    const { getMessageKeyPair } = await import('../commons/threadCrypto');
    const PECloudSync = (await import('../provenance/PECloudSync')).default;
    const { initializePromiseTermsKey } = await import('../promises/PromiseTermsVault');
    const provenance = (await import('../provenance/ProvenanceEnvelopeManager')).default;
    if (!stillApproved()) return;
    await Promise.all([
        step('message-key', () => getMessageKeyPair(publishKeyReason(), biometricAction)),
        step('archive-key', () => PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction }, biometricAction)),
        step('terms-key', () => initializePromiseTermsKey(biometricAction)),
    ]);
    if (!stillApproved()) return;
    // iCloud/Drive can take minutes to inventory. Start it independently of relay and proof work.
    await Promise.all([
        step('cloud-backup-key', () => getPhoneMeter().backup.primeKey(biometricAction, signal)),
        finishRelayUnlock(address, biometricAction, stillApproved, step),
        step('deferred-records', () => provenance.retryDeferredEnvelopes(biometricAction)),
        renewal,
    ]);
}

async function finishRelayUnlock(address: string | null, biometricAction: BiometricAction, stillApproved: () => boolean, step: UnlockStepRunner): Promise<void> {
    const relay = (await import('../../services/RelayAPIService')).default;
    await step('relay-credentials', async () => {
        if (!address || (await relay.isRegistered())) return 'skipped';
        if (!stillApproved()) throw new Error('approval ended');
        return relay.recoverRelayCredentials(address, biometricAction);
    });
    if (!stillApproved()) return;
    await step('message-key-publish', async () => {
        if (!(await ensureMessageKeyAtLaunch({ allowPrompt: false, biometricAction }, biometricAction))) throw new Error('not published');
    });
    if (stillApproved()) {
        await step('solana-proof', async () => {
            const outcome = await (await import('../chains/solana/solanaAddressProof')).ensureSolanaAddressProven(biometricAction);
            if (outcome === 'failed') throw new Error('proof failed');
            return outcome;
        });
    }
}

/**
 * Best-effort retry of the wallet's own Solana address proof (solanaAddressProof.ts). Cheap when
 * done (one AsyncStorage read) or when no biometric session is live; never prompts, never throws.
 */
function trySolanaAddressProof(): void {
    void import('../chains/solana/solanaAddressProof')
        .then((m) => m.ensureSolanaAddressProven())
        .catch(() => { /* retried on the next trigger */ });
    tryOutputKeyRegistration();
}

/**
 * Best-effort registration of this phone's output-signing key and installation of
 * the Commons signer. Cheap once registered (one AsyncStorage read); never prompts, never throws;
 * backs off after a refusal. Rides every trigger the Solana proof rides (unlock, ticks, foreground).
 */
function tryOutputKeyRegistration(): void {
    void import('./outputSigningRuntime')
        .then((m) => m.ensureAppOutputKeyRegistered())
        .catch(() => { /* retried on the next trigger */ });
}

export function meterTransportForAction(biometricAction?: BiometricAction) {
    return createRelayMeterTransport({
            privateBatch:async (body,openings)=> {
                const relay=(await import('../../services/RelayAPIService')).default;
                const batch=JSON.parse(body) as PeBatch;
                return relay.meterRequest('POST','/v1/meter/batch/mobile',undefined,secret=>JSON.stringify({private_batch:sealPrivatePricing({batch,openings},secret,'provian-private-batch:v1')}), biometricAction);
            },
            meterRequest: async (method, path, body) => {
                const relay = (await import('../../services/RelayAPIService')).default;
                return relay.meterRequest(method, path, body, undefined, biometricAction);
            },
            meterBatchProofs: async (hashes, roots) => {
                const relay = (await import('../../services/RelayAPIService')).default;
                return relay.meterBatchProofs(hashes, roots, biometricAction);
            },
        });
}

function archiveTransportForAction(biometricAction?: BiometricAction) {
    return createRelayArchiveTransport({
            meterRequest: async (method, path, body) => {
                const relay = (await import('../../services/RelayAPIService')).default;
                return relay.meterRequest(method, path, body, undefined, biometricAction);
            },
            archiveObjectText: async (path) => {
                const relay = (await import('../../services/RelayAPIService')).default;
                return relay.archiveObjectText(path, biometricAction);
            },
        });
}

export function getPhoneMeter(): PhoneMeter {
    if (instance) return instance;
    const files = createExpoMeterFiles();
    instance = new PhoneMeter({
        files,
        cloud: createPlatformCloudFiles(),
        transport: meterTransportForAction(),
        actionTransport: meterTransportForAction,
        actionArchiveTransport: archiveTransportForAction,
        // A proof build may shorten the local window (EXPO_PUBLIC_PE_ARCHIVE_KEEP_DAYS, 0..30;).
        // Release builds leave it unset: the ruled 30 days.
        archiveKeepDays: parseKeepDaysEnv(process.env.EXPO_PUBLIC_PE_ARCHIVE_KEEP_DAYS),
        archiveObjectCache: createExpoArchiveObjectCache(),
        // "Check it's intact" reads each day root from PEAnchor on Base (public Base RPC, then its fallback).
        archiveEthCall: async (to, data) => {
            const { ethers } = await import('ethers');
            const { BASE_MAINNET } = await import('../chains/evm/config');
            let last: unknown = new Error('no_base_rpc');
            for (const url of [BASE_MAINNET.rpcUrl, BASE_MAINNET.fallbackRpcUrl]) {
                if (!url) continue;
                try {
                    return await new ethers.JsonRpcProvider(url, BASE_MAINNET.chainId, { staticNetwork: true }).call({ to, data });
                } catch (error) {
                    last = error;
                }
            }
            throw last instanceof Error ? last : new Error(String(last));
        },
        archiveTransport: archiveTransportForAction(),
        backupKeys,
        kv: AsyncStorage,
        activity: {
            async hot() {
                const PELifecycleManager = (await import('../provenance/PELifecycleManager')).default;
                return PELifecycleManager.getHotTierPEs();
            },
            async archived(options, biometricAction?: BiometricAction) {
                const PECloudSync = (await import('../provenance/PECloudSync')).default;
                biometricAction ??= options.biometricAction;
                const key = await PECloudSync.getArchiveKeyForBackup(options, biometricAction);
                if (key === null) return null;
                return PECloudSync.fetchPEsByDateRange(0, Date.now(), biometricAction);
            },
            async restore(envelopes: readonly ProvenanceEnvelope[], biometricAction?: BiometricAction) {
                const PELifecycleManager = (await import('../provenance/PELifecycleManager')).default;
                return PELifecycleManager.restoreEnvelopes(envelopes, biometricAction);
            },
        },
        async deviceId() {
            const relay = (await import('../../services/RelayAPIService')).default;
            return relay.getMeterDeviceId();
        },
        async privacySecret() {
            const relay=(await import('../../services/RelayAPIService')).default;
            const secret=await relay.getAuthSecret();
            if(!secret)throw new Error('existing wallet credential unavailable');
            return secret;
        },
        async detailHash(envelope) {
            const { hashEnvelopeCanonical } = await import('../provenance/peHash');
            return hashEnvelopeCanonical(envelope);
        },
        async witness(nonceHex) {
            const AppAttest = (await import('../security/AppAttest')).default;
            const relay = (await import('../../services/RelayAPIService')).default;
            return AppAttest.witnessForActNonceHex(nonceHex, relay);
        },
        async sign(peHash, biometricAction?: BiometricAction) {
            const KeyManager = (await import('../security/KeyManager')).default;
            return KeyManager.signPayload(peHash, biometricAction);
        },
        messageSecretKey,
        openBox: (secret, box) => {
            // Lazy require keeps threadCrypto (and the seed manager) out of module load.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { openThreadMessage } = require('../commons/threadCrypto') as typeof import('../commons/threadCrypto');
            return openThreadMessage(secret, box);
        },
        ensureMessageKeyPublished,
        randomBytes,
        // Backup file hashing on the native digest, off the JS thread (checked against the JS digest once).
        hashText: checkedTextHash(async (text) => {
            const Crypto = await import('expo-crypto');
            return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
        }),
        isForeground: () => AppState.currentState === 'active',
        isUnlocked: () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { useWalletStore } = require('../../store/walletStore') as typeof import('../../store/walletStore');
            return useWalletStore.getState().isAuthenticated === true;
        },
        log: (level, msg, extra) => {
            const line = `[PE meter] ${msg}`;
            if (level === 'error') console.error(line, extra ?? '');
            else if (level === 'warn') console.warn(line, extra ?? '');
            else console.log(line, extra ?? '');
        },
    });
    return instance;
}

/**
 * Settings → Storage → "Export all my PEs": build the complete export (`phoneExport.ts`) and write
 * it to the app's document directory as `provian-pe-export-<wallet>-<UTC timestamp>.jsonl`. The
 * caller shares the file. May show Face ID / the passcode (the person started it, in the app).
 */
export async function exportAllMyPes(onProgress?: (progress: PhonePeExportProgress) => void, biometricAction?: BiometricAction): Promise<{ filePath: string; result: PhonePeExportResult }> {
  if (!biometricAction) return withBiometricAction(translate('biometricPrompts.exportAllRecords', 'Export all your records'), action => exportAllMyPes(onProgress, action));
  assertBiometricAction(biometricAction);
  await (await import('../commons/threadCrypto')).getMessageKeyPair('Export all your records', biometricAction);
  await (await import('../provenance/PECloudSync')).default.getArchiveKeyForBackup({ allowPrompt: false, biometricAction });
  const meter = getPhoneMeter();
  const relay = (await import('../../services/RelayAPIService')).default;
  const { useWalletStore } = await import('../../store/walletStore');
  const address = useWalletStore.getState().address || null;
  const walletId = await relay.getRelayWalletId(biometricAction).catch(() => null);
  const Application = await import('expo-application');
  const appVersion = `${Application.nativeApplicationVersion ?? 'unknown'} (${Application.nativeBuildVersion ?? 'unknown'})`;
  const result = await meter.exportAllPes({ owner: { walletId, address }, appVersion, onProgress, biometricAction });
  const FileSystem = await import('expo-file-system/legacy');
  const filePath = `${FileSystem.documentDirectory ?? ''}${result.fileName}`;
  await FileSystem.writeAsStringAsync(filePath, result.text);
  return { filePath, result };
}

/** Explicit storage buttons own one approval; scheduling never creates one. */
export async function preparePeCloudAccess(meter: PhoneMeter = getPhoneMeter()): Promise<boolean> {
    const available = await meter.backup.prepareCloud();
    // Android Google sign-in can resolve before React Native observes the returning Activity.
    // Wait before starting authentication; no already-approved grant is retained through that UI.
    if (AppState.currentState === 'background') {
        await new Promise<void>(resolve => {
            const timeout = setTimeout(() => { subscription.remove(); resolve(); }, 3000);
            const subscription = AppState.addEventListener('change', state => {
                if (state === 'active') { clearTimeout(timeout); subscription.remove(); resolve(); }
            });
        });
    }
    return available;
}
export async function backUpMyPes(meter: PhoneMeter = getPhoneMeter()) {
    if (!(await preparePeCloudAccess(meter))) return meter.backupNow({ allowPrompt: false });
    return withBiometricAction(translate('biometricPrompts.backUpRecords', 'Back up your records'), action => meter.backupNow({ allowPrompt: true, biometricAction: action }));
}
export async function restoreMyPes(meter: PhoneMeter = getPhoneMeter()) {
    if (!(await preparePeCloudAccess(meter))) throw new Error('cloud_unavailable');
    return withBiometricAction(translate('biometricPrompts.restoreRecords', 'Restore your records'), action => meter.restoreAfterRecovery(action));
}

/**
 * Start the meter: open the store, schedule the ticks, and register as the provenance manager's
 * recorder so every durable activity record gets its PE v2. Idempotent; never throws.
 */
export async function startPhoneMeter(biometricAction?: BiometricAction): Promise<void> {
    const meter = getPhoneMeter();
    try {
        const ProvenanceEnvelopeManager = (await import('../provenance/ProvenanceEnvelopeManager')).default;
        ProvenanceEnvelopeManager.setMeterRecorder((envelopes) => meter.record(envelopes));
        setRelayAuthoredListener(() => { void meter.fileRelayAuthored(); });
        await meter.start();
    } catch (err) {
        console.warn('[PE meter] start failed (retried on the next tick):', err instanceof Error ? err.message : String(err));
    }
    if (!timer) {
        timer = setInterval(() => {
            if (AppState.currentState === 'active') {
                void meter.tick('timer');
                trySolanaAddressProof();
            }
        }, METER_TICK_MS);
    }
    if (!appStateSub) {
        appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state === 'active') {
                void meter.tick('foreground');
                trySolanaAddressProof();
            }
        });
    }
    void ensureMessageKeyAtLaunch({ allowPrompt: false }, biometricAction);
    tryOutputKeyRegistration();
    void meter.tick('foreground');
}
