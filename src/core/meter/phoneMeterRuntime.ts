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

/** Initialize derived keys and publish them inside the unlock action, before it is revoked. */
export async function onWalletUnlocked(biometricAction?: BiometricAction): Promise<void> {
    if (!biometricAction) return;
    assertBiometricAction(biometricAction);
    const { getMessageKeyPair } = await import('../commons/threadCrypto');
    const PECloudSync = (await import('../provenance/PECloudSync')).default;
    const { initializePromiseTermsKey } = await import('../promises/PromiseTermsVault');
    // Cache only domain-separated messaging/archive/terms keys, never a seed or seed grant.
    await getMessageKeyPair(publishKeyReason(), biometricAction);
    await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction }, biometricAction);
    await initializePromiseTermsKey(biometricAction);
    // Another phone may have chosen a different PE backup salt. Prime it inside this approval
    // so later scheduled backup never needs to authenticate. No records are restored or uploaded.
    await getPhoneMeter().backup.primeKey(biometricAction).catch(() => undefined);
    const relay = (await import('../../services/RelayAPIService')).default;
    const { useWalletStore } = await import('../../store/walletStore');
    const address = useWalletStore.getState().address;
    if (address && !(await relay.isRegistered())) await relay.recoverRelayCredentials(address, biometricAction);
    await ensureMessageKeyAtLaunch({ allowPrompt: false, biometricAction }, biometricAction);
    await (await import('../chains/solana/solanaAddressProof')).ensureSolanaAddressProven(biometricAction);
    // Retry attestations whose Android signing window elapsed after a confirmed transaction.
    await (await import('../provenance/ProvenanceEnvelopeManager')).default.retryDeferredEnvelopes(biometricAction);
    // Archive work uses the derived caches; it holds no seed authorization after unlock.
    void getPhoneMeter().afterUnlock().catch(() => undefined);
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
