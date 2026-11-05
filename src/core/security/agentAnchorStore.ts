import { withBiometricAction, assertBiometricAction, type BiometricAction } from './biometricAction';
/**
 * agentAnchorStore — durable, CLOUD-BACKED custody of the recovery ANCHOR SECRET.
 *
 * ── WHY THIS FILE IS FUND-SAFETY CRITICAL ────────────────────────────────────
 * In the two-touch agent onboarding the inviting human's phone is the agent
 * wallet's recovery custodian. At "Invite an agent" the phone mints an x25519
 * anchor keypair (see agentKeyRecovery.ts); the agent seals a copy of its OWN
 * secp256k1 wallet key to the anchor PUBLIC half and escrows only the ciphertext
 * to the relay. The anchor SECRET half — held here — is the ONLY key that can
 * ever re-open that escrow. If it is lost, the agent's wallet is unrecoverable.
 *
 * Therefore the secret MUST survive loss of the phone. It is written — ONLY as
 * seed-wrapped XChaCha20-Poly1305 ciphertext (see anchorWrapKey; the native
 * transport does not encrypt, so plaintext here would reach the cloud in the
 * clear) — to the SAME cloud-backed keychain that already carries the human's
 * own BIP-39 mnemonic — iCloud Keychain on iOS, the Google Drive appDataFolder
 * on Android (ProvianCloudKeychainSync, the module CloudBackupV2 uses).
 * Recovery ordering on a new phone: restore the human wallet first (PIN
 * cloud-backup flow) — the restored seed is what re-opens the anchors. "Recover your
 * Provian app on a new phone → your agent anchors come back with it." The secret
 * is NEVER written to expo-secure-store WHEN_UNLOCKED_THIS_DEVICE_ONLY or any
 * device-only location: that would silently strand recovery on phone loss.
 *
 * ── THE DURABLE JOIN KEY IS THE ANCHOR PUBLIC KEY ────────────────────────────
 * Each secret is stored under a key derived from its OWN public key. That is the
 * one identifier that round-trips through a phone replacement, because at
 * recovery time the relay hands the phone back `recovery_anchor_pubkey` (see
 * GET /v1/agent/wallet/:wallet_id/recovery-escrow). So recovery is always:
 * backend gives the pubkey → look up the secret under that pubkey → open the
 * blob. No device-local mapping is required on the fund-safety path.
 *
 * A convenience index (connection-token / agent-wallet-id → pubkey) is also kept
 * in AsyncStorage. It is NON-SENSITIVE (public keys + opaque ids only, never the
 * secret) and is device-local: it does NOT survive phone loss and is never on
 * the fund-safety path. It only lets the UI look an anchor up before it has the
 * backend's pubkey. The secret itself lives ONLY in the synced keychain.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils';
import {
    storeSynced,
    retrieveSynced,
    deleteSynced,
    verifySync,
    isCloudKeychainAvailable,
    cloudTargetLabel,
} from '../recovery/cloud/ProvianCloudKeychainSync';
import SeedManager from '../wallet/SeedManager';
import { toB64u, fromB64u } from './agentKeyRecovery';
import securityLog from './securityLogger';
import { translate } from '../../i18n/translate';

const X25519_KEY_LEN = 32;
const XCHACHA_NONCE_LEN = 24;
/** Domain-separates the anchor-wrap derivation from every other seed use. */
const ANCHOR_WRAP_INFO = new TextEncoder().encode('provian-anchor-wrap-v1');

/**
 * Derive the anchor-wrapping AEAD key from the HUMAN WALLET SEED (Security
 * Invariant #1: only ciphertext ever leaves the device — the native cloud
 * transport does not encrypt, so a raw secret here would land in the Google
 * Drive appDataFolder in the clear). HKDF(seed, salt=anchor pubkey) means:
 *   - the cloud blob is inert without the seed, which is exactly the secret
 *     the human already custodies (and already survives phone loss via the
 *     PIN-encrypted CloudBackupV2 flow — restore the wallet first, then agent
 *     anchors open again with no extra credential);
 *   - a blob re-filed under a different pubkey derives a different key and
 *     fails AEAD authentication (the salt binds blob to anchor identity).
 * Reading the mnemonic requires a biometric session (SeedManager reuses a
 * live session, so invite/recovery flows prompt at most once).
 */
async function anchorWrapKey(anchorPubkey: Uint8Array, biometricAction?: BiometricAction): Promise<Uint8Array> {
    return await withBiometricAction(translate('biometricPrompts.secureAgentRecoveryAnchor', 'Secure agent recovery anchor'), async (biometricAction) => {
        assertBiometricAction(biometricAction);
        const mnemonic = await SeedManager.getMnemonic(biometricAction);
        if (!mnemonic) {
            throw new Error('wallet_seed_unavailable');
        }
        return hkdf(sha256, new TextEncoder().encode(mnemonic), anchorPubkey, ANCHOR_WRAP_INFO, 32);

    }, biometricAction);
}

/** Cloud-synced keychain key namespace for a single anchor secret. */
const ANCHOR_KEY_PREFIX = 'provian_agent_recovery_anchor::';
/** Device-local, non-sensitive lookup index (pubkeys + ids only, never secrets). */
const ANCHOR_INDEX_KEY = '@provian_agent_recovery_anchor_index';

/**
 * On-disk shape of a stored anchor secret (cloud-synced keychain). v2 ONLY:
 * the secret is XChaCha20-Poly1305 ciphertext under the seed-derived wrap key
 * (see anchorWrapKey). v1 stored the raw secret and never shipped; it is
 * refused on read rather than migrated.
 */
interface StoredAnchorSecret {
    v: 2;
    /** base64url of the 24-byte XChaCha20-Poly1305 nonce. */
    nonceB64u: string;
    /** base64url of the AEAD ciphertext over the 32-byte anchor secret. */
    boxB64u: string;
    createdAtMs: number;
}

/** Device-local convenience index. NON-SENSITIVE — contains no secret material. */
interface AnchorIndex {
    /** connection_token (PROV-XXXX-XXXX) → anchor pubkey (base64url). */
    byToken: Record<string, string>;
    /** agent wallet id → anchor pubkey (base64url). */
    byWallet: Record<string, string>;
    /** Every anchor pubkey minted on this device (best-effort roster). */
    pubkeys: string[];
}

const EMPTY_INDEX: AnchorIndex = { byToken: {}, byWallet: {}, pubkeys: [] };

/**
 * Whether durable (cloud-backed) anchor storage is available on this build.
 * False in Expo Go / on web (the native sync module is not linked) — callers
 * MUST branch on this and degrade honestly rather than fall back to device-only
 * storage, which would strand recovery on phone loss.
 */
export function isRecoveryAnchorStorageAvailable(): boolean {
    return isCloudKeychainAvailable();
}

/** Human-facing name of the cloud destination ("iCloud Keychain" / "Google Drive"). */
export function recoveryAnchorCloudLabel(): string {
    return cloudTargetLabel();
}

function anchorCloudKey(pubkeyB64u: string): string {
    return `${ANCHOR_KEY_PREFIX}${pubkeyB64u}`;
}

async function readIndex(): Promise<AnchorIndex> {
    try {
        const raw = await AsyncStorage.getItem(ANCHOR_INDEX_KEY);
        if (!raw) return { ...EMPTY_INDEX, byToken: {}, byWallet: {}, pubkeys: [] };
        const parsed = JSON.parse(raw) as Partial<AnchorIndex>;
        return {
            byToken: parsed.byToken ?? {},
            byWallet: parsed.byWallet ?? {},
            pubkeys: Array.isArray(parsed.pubkeys) ? parsed.pubkeys : [],
        };
    } catch {
        // A corrupt index is a recoverable convenience loss, never a fund loss
        // (the fund-safe path reads the secret by pubkey from the backend). Start fresh.
        return { byToken: {}, byWallet: {}, pubkeys: [] };
    }
}

async function writeIndex(index: AnchorIndex): Promise<void> {
    // Best-effort: index is a convenience, so a write failure must not surface
    // as a fund error. The secret is already durably stored by this point.
    try {
        await AsyncStorage.setItem(ANCHOR_INDEX_KEY, JSON.stringify(index));
    } catch (err) {
        securityLog.warn(
            'agentAnchorStore',
            `Failed to persist anchor index (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Durably persist an anchor secret to the cloud-backed keychain, keyed by its
 * public key. Fail-CLOSED: throws if durable storage is unavailable or the
 * write does not land in the synced pool — never silently degrades to
 * device-only storage.
 *
 * @param params.publicKey       32-byte x25519 anchor public key.
 * @param params.secretKey       32-byte x25519 anchor secret key (the fund-bearing custody key).
 * @param params.connectionToken optional connection code to index this anchor by.
 */
export async function persistRecoveryAnchor(params: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    connectionToken?: string;
}, biometricAction?: BiometricAction): Promise<{ pubkeyB64u: string }> {
    if (params.publicKey.length !== X25519_KEY_LEN) {
        throw new Error(`anchor public key must be ${X25519_KEY_LEN} bytes`);
    }
    if (params.secretKey.length !== X25519_KEY_LEN) {
        throw new Error(`anchor secret key must be ${X25519_KEY_LEN} bytes`);
    }
    if (!isCloudKeychainAvailable()) {
        // FUND-SAFETY: never write the anchor secret device-only. If the cloud
        // path is unavailable, refuse — the caller degrades to "recovery not
        // enabled" rather than shipping an anchor that dies with the phone.
        throw new Error('cloud_backup_unavailable');
    }

    const pubkeyB64u = toB64u(params.publicKey);
    // Security Invariant #1: the cloud transport stores blobs verbatim, so the
    // secret is sealed to seed-derived AEAD ciphertext BEFORE it leaves this
    // function. Throws wallet_seed_unavailable pre-wallet (an anchor nobody
    // could ever decrypt must not be minted).
    const wrapKey = await anchorWrapKey(params.publicKey, biometricAction);
    const nonce = nobleRandomBytes(XCHACHA_NONCE_LEN);
    const record: StoredAnchorSecret = {
        v: 2,
        nonceB64u: toB64u(nonce),
        boxB64u: toB64u(xchacha20poly1305(wrapKey, nonce).encrypt(params.secretKey)),
        createdAtMs: Date.now(),
    };
    const cloudKey = anchorCloudKey(pubkeyB64u);

    await storeSynced(cloudKey, JSON.stringify(record));

    // Post-write verification, exactly as CloudBackupV2 does for the mnemonic: a
    // write that landed in a local-only keychain is worse than none — it gives
    // false confidence. If it did not sync, roll back and fail closed.
    const synced = await verifySync(cloudKey);
    if (!synced) {
        await deleteSynced(cloudKey).catch((err) => {
            securityLog.warn(
                'agentAnchorStore',
                `Failed to roll back unverified anchor write (orphan may remain): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        });
        throw new Error('anchor_backup_not_synced');
    }

    // Update the device-local convenience index (non-sensitive).
    const index = await readIndex();
    if (!index.pubkeys.includes(pubkeyB64u)) index.pubkeys.push(pubkeyB64u);
    if (params.connectionToken) index.byToken[params.connectionToken] = pubkeyB64u;
    await writeIndex(index);

    securityLog.log('agentAnchorStore', 'Recovery anchor secret persisted to cloud keychain and sync-verified');
    return { pubkeyB64u };
}

/**
 * Load the anchor secret for a given anchor PUBLIC KEY (base64url). This is the
 * fund-safe recovery lookup: the backend hands the phone `recovery_anchor_pubkey`
 * and the secret is stored under exactly that pubkey in the synced keychain, so
 * it round-trips through phone replacement. Returns null when this account/device
 * holds no anchor for that pubkey.
 */
export async function loadRecoveryAnchorSecret(anchorPubkeyB64u: string, biometricAction?: BiometricAction): Promise<Uint8Array | null> {
    if (!isCloudKeychainAvailable()) return null;
    const raw = await retrieveSynced(anchorCloudKey(anchorPubkeyB64u));
    if (!raw) return null;
    let record: StoredAnchorSecret;
    try {
        record = JSON.parse(raw) as StoredAnchorSecret;
    } catch {
        securityLog.error('agentAnchorStore', 'Stored anchor secret is not valid JSON');
        return null;
    }
    if (record.v !== 2 || typeof record.boxB64u !== 'string' || typeof record.nonceB64u !== 'string') {
        securityLog.error('agentAnchorStore', `Unsupported stored anchor version: ${(record as { v?: unknown }).v}`);
        return null;
    }
    let secret: Uint8Array;
    try {
        const wrapKey = await anchorWrapKey(fromB64u(anchorPubkeyB64u), biometricAction);
        secret = xchacha20poly1305(wrapKey, fromB64u(record.nonceB64u)).decrypt(fromB64u(record.boxB64u));
    } catch (err) {
        // Wrong seed (different human wallet), tampered blob, or a blob re-filed
        // under another pubkey (the HKDF salt binds identity) — all fail closed.
        securityLog.error(
            'agentAnchorStore',
            `Stored anchor secret failed authenticated decryption: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
    if (secret.length !== X25519_KEY_LEN) {
        securityLog.error('agentAnchorStore', 'Stored anchor secret has wrong length');
        return null;
    }
    return secret;
}

/**
 * Record the agent wallet id an anchor ended up bound to, once known (the
 * wallet id does not exist yet at invite time). Best-effort, device-local
 * convenience only; never on the fund-safety path.
 */
export async function linkAnchorToWallet(anchorPubkeyB64u: string, walletId: string): Promise<void> {
    const index = await readIndex();
    index.byWallet[walletId] = anchorPubkeyB64u;
    if (!index.pubkeys.includes(anchorPubkeyB64u)) index.pubkeys.push(anchorPubkeyB64u);
    await writeIndex(index);
}

/** Convenience: resolve the anchor pubkey previously indexed for a connection token (device-local). */
export async function findAnchorPubkeyByConnectionToken(connectionToken: string): Promise<string | null> {
    const index = await readIndex();
    return index.byToken[connectionToken] ?? null;
}

/** Convenience: resolve the anchor pubkey previously indexed for an agent wallet id (device-local). */
export async function findAnchorPubkeyByWalletId(walletId: string): Promise<string | null> {
    const index = await readIndex();
    return index.byWallet[walletId] ?? null;
}
