import { invalidateSeedDerivedCaches } from '../security/seedDerivedCache';
/**
 * SeedManager: BIP-39 Mnemonic Generation and Multi-Chain Key Derivation
 *
 * Derives EVM (secp256k1) AND Solana (ed25519) private keys from ONE BIP-39
 * mnemonic. The mnemonic is the canonical wallet identity and is also what the
 * PIN-encrypted cloud backup wraps for restore — so restoring the single seed
 * brings back BOTH the EVM address and the Solana address identically, with no
 * separate backup or recovery flow.
 *
 * - EVM keys: BIP-32 (secp256k1), path m/44'/60'/0'/0/0.
 * - Solana key: SLIP-0010 (ed25519), path m/44'/501'/0'/0' (the Solana / Phantom
 * standard, all-hardened). BIP-32's HDKey is secp256k1-only and CANNOT be used
 * for ed25519, so the Solana path is derived explicitly via SLIP-0010 below.
 *
 * SECURITY:
 * - Mnemonic stored in the provian-secure-seed native store : OS user-
 * authentication ACL that survives biometric re-enrollment and admits the
 * device passcode. The F14 expo-secure-store item is migrated to it with a
 * verified read-back before it is ever removed (see secureSeedStore.ts).
 * - Master seed derived on-demand from mnemonic (not persisted)
 * - Chain private keys derived on-demand (not persisted separately)
 * - getEVMPrivateKey(), getSolanaSeed() and getMnemonic() require a valid
 * action capability established by one successful native authentication.
 * It covers only that action and ends in finally or on app background.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { mnemonicToSeedPaced } from './pacedSeed';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import securityLog from '../security/securityLogger';
import { assertBiometricAction, isBiometricActionValid, revokeBiometricActions, withBiometricAction, type BiometricAction } from '../security/biometricAction';
export { BiometricSessionRequiredError } from '../security/biometricAction';
import { slip10DeriveEd25519Seed } from '../chains/solana/slip10';
import {
    SeedVault,
    loadNativeSeedStore,
    defaultKeyValueStore,
    seedUnlockPrompt,
    SeedUnreadableError,
    SeedActionKeyUpgradeDeferredError,
    type MigrationOutcome,
    type PublicAddresses,
} from './secureSeedStore';
import { translate } from '../../i18n/translate';

export { SeedUnreadableError, SeedWriteVerificationError, MultipleUnidentifiedWalletsError, UnidentifiedStoredKeyError } from './secureSeedStore';
export type { MigrationOutcome, PublicAddresses } from './secureSeedStore';

const KEYS = {
    MASTER_SEED: 'provian_master_seed',
} as const;

/**
 * [F14] Public wallet addresses cached in AsyncStorage (public, non-secret) so
 * getEVMAddress / getSolanaAddress / hasSeed / seedMatches never read the
 * mnemonic — which is now stored with `requireAuthentication` (OS presence gate).
 * Written from the in-memory mnemonic at generate()/import(); the seed is
 * therefore touched only inside a biometric session (the gated key/seed getters).
 */
const PUBLIC_ADDRESS_CACHE = {
    EVM: 'provian_public_evm_address',
    SOLANA: 'provian_public_solana_address',
} as const;

export const DERIVATION_PATHS = {
    EVM: "m/44'/60'/0'/0/0",
    // SLIP-0010 ed25519 Solana account (all path segments hardened).
    SOLANA: "m/44'/501'/0'/0'",
} as const;

/**
 * Thrown by importMnemonic() when a seed already exists locally and the
 * caller has not passed { force: true }. The destructive write primitive
 * owns its own invariant: any caller who wants to overwrite an existing
 * wallet must first run a user-facing confirmation gate (typed phrase +
 * biometric) and then opt in to the overwrite by passing { force: true }.
 *
 * B-1 (audit 2026-05-11) closed the CloudRecoveryScreen path via
 * applyCloudRecovery. This guard at the SeedManager layer is the
 * defense-in-depth backstop that also protects ImportRecoveryPhraseScreen
 * and any future caller (migration script, dev wipe-and-restore, new
 * recovery flow) from re-introducing the same loss path.
 */
export class OverwriteConfirmationRequired extends Error {
    readonly code = 'OVERWRITE_CONFIRMATION_REQUIRED';

    constructor() {
        super(
            'A wallet seed already exists on this device. importMnemonic refuses to overwrite without { force: true }; the caller must run an overwrite-confirmation gate first.',
        );
        this.name = 'OverwriteConfirmationRequired';
    }
}

export interface DerivedKey {
    privateKey: Uint8Array;
    privateKeyHex: string;
    publicKey: Uint8Array;
    publicKeyHex: string;
    address: string;
    chain: string;
    path: string;
}

function evmAddressFromPublicKey(uncompressedPubKey: Uint8Array): string {
    const key = uncompressedPubKey.length === 65
        ? uncompressedPubKey.slice(1)
        : uncompressedPubKey;
    const hash = keccak_256(key);
    const addressBytes = hash.slice(-20);
    return '0x' + bytesToHex(addressBytes);
}

/**
 * Derive the EVM address for a given mnemonic without storing it.
 *
 * Used by seedMatches() to compare a candidate seed against the resident
 * one by their derived wallet identity. Wipes the derived private key
 * before returning; never returns or logs seed material.
 */
async function deriveEvmAddressFromMnemonic(mnemonic: string): Promise<string> {
    // Paced: this runs at unlock, where the synchronous PBKDF2 held the screens (findings).
    const seed = await mnemonicToSeedPaced(mnemonic);
    const hdkey = HDKey.fromMasterSeed(seed);
    const derived = hdkey.derive(DERIVATION_PATHS.EVM);
    if (!derived.privateKey || !derived.publicKey) {
        throw new Error('Key derivation failed');
    }
    const { secp256k1 } = await import('@noble/curves/secp256k1');
    const uncompressed = secp256k1.ProjectivePoint.fromHex(derived.publicKey).toRawBytes(false);
    const address = evmAddressFromPublicKey(uncompressed);
    derived.privateKey.fill(0);
    return address;
}

// =============================================================================
// SOLANA (ed25519 / SLIP-0010) DERIVATION
// =============================================================================

/**
 * Derive the Solana address (base58) for a mnemonic without persisting any
 * secret. Wipes the ed25519 seed before returning; returns public material
 * only. Mirrors deriveEvmAddressFromMnemonic.
 */
async function deriveSolanaAddressFromMnemonic(mnemonic: string): Promise<string> {
    const bip39Seed = await mnemonicToSeedPaced(mnemonic);
    const ed25519Seed = slip10DeriveEd25519Seed(bip39Seed, DERIVATION_PATHS.SOLANA);
    const { ed25519 } = await import('@noble/curves/ed25519');
    const publicKey = ed25519.getPublicKey(ed25519Seed);
    const address = bs58.encode(publicKey);
    bip39Seed.fill(0);
    ed25519Seed.fill(0);
    return address;
}

class SeedManagerImpl {
    private async invalidateDerivedCaches(): Promise<void> {
        invalidateSeedDerivedCaches();
        await AsyncStorage.removeItem('provian_meter_message_key_published_v1');
        // Kept Commons drafts (plaintext) belong to the wallet that wrote them (pendingThreadDrafts.ts).
        await AsyncStorage.removeItem('provian_commons_pending_thread_drafts_v1');
    }

    /**
     * Generate a new 12-word BIP-39 mnemonic and store it.
     */
    async generate(action?: BiometricAction): Promise<string> {
        if (!action) return withBiometricAction(seedWritePrompt(), granted => this.generate(granted));
        assertBiometricAction(action);
        const mnemonic = generateMnemonic(wordlist, 128);
        securityLog.log('SeedManager', 'Generated new 12-word BIP-39 mnemonic');
        // Device-only, readable only while unlocked, never synced; cloud recovery
        // uses CloudBackupV2 (a separate, encrypted, opt-in blob).
        // [F14 / ] The OS enforces user authentication on every read of the
        // seed. The native store's ACL admits biometry-ANY or the device passcode,
        // so re-enrolling Face ID / a fingerprint never invalidates it and a
        // passcode-only device can create a wallet. The write is READ BACK and
        // compared before the wallet exists at all: a seed that cannot be read
        // back is never handed out as a wallet (SeedWriteVerificationError; the
        // unverified write is removed, leaving no wallet). The public address
        // getters read the AsyncStorage cache and never trip this ACL.
        await this.invalidateDerivedCaches();
        await vault.write(mnemonic, { fresh: true, prompt: seedWritePrompt(), actionId: action?.nativeId });
        securityLog.log('SeedManager', 'Mnemonic stored and read back verified');
        return mnemonic;
    }

    /**
     * Import an existing mnemonic (12 or 24 words).
     *
     * Refuses to overwrite an existing seed unless the caller passes
     * { force: true }, which signals that an overwrite-confirmation gate
     * (typed phrase + biometric) has already run. See
     * OverwriteConfirmationRequired.
     */
    async importMnemonic(mnemonic: string, options?: { force?: boolean }, action?: BiometricAction): Promise<void> {
        if (!action) return withBiometricAction(seedWritePrompt(), granted => this.importMnemonic(mnemonic, options, granted));
        assertBiometricAction(action);
        const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

        if (!validateMnemonic(normalized, wordlist)) {
            throw new Error('Invalid BIP-39 mnemonic: checksum failed');
        }

        const existed = await this.hasSeed();
        if (!options?.force && existed) {
            throw new OverwriteConfirmationRequired();
        }

        // [F14 / ] Same OS-enforced gate and verified read-back as generate().
        // The legacy F14 item (if any) is retired only after the new value reads back.
        await this.invalidateDerivedCaches();
        await vault.write(normalized, { fresh: !existed, prompt: seedWritePrompt(), actionId: action?.nativeId });
        securityLog.log('SeedManager', 'Imported and stored mnemonic (read back verified)');
    }

    /**
     * Get the stored mnemonic. Returns null if no wallet exists. Throws
     * SeedUnreadableError when this device knows the wallet but its seed cannot
     * be read (route to restore — never treat as "no wallet").
     *
     * Requires an explicit live BiometricAction. Throws BiometricSessionRequiredError
     * for missing, forged, ended or background-revoked approval.
     */
    async getMnemonic(action?: BiometricAction): Promise<string | null> {
        assertBiometricAction(action);
        const mnemonic = await vault.read(seedUnlockPrompt(), action.nativeId);
        assertBiometricAction(action);
        if (mnemonic && await vault.needsActionKeyUpgrade(action.nativeId)) {
            assertBiometricAction(action);
            try {
                await vault.write(mnemonic, { fresh: false, prompt: seedUnlockPrompt(), actionId: action.nativeId });
            } catch (err) {
                // An independently protected unidentified copy may occupy the staging slot.
                // Keep it; this verified old seed still works through the legacy-key exception.
                if (!(err instanceof SeedActionKeyUpgradeDeferredError)) throw err;
                securityLog.log('SeedManager', 'Android action-key migration deferred; unidentified copy retained');
            }
            assertBiometricAction(action);
        }
        return mnemonic;
    }

    /**
     * Check if a mnemonic string is valid BIP-39.
     */
    validate(mnemonic: string): boolean {
        const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
        return validateMnemonic(normalized, wordlist);
    }

    /**
     * Derive a key from the mnemonic. Returns the raw private key in the
     * DerivedKey shape.
     *
     * PRIVATE (audit 2026-06-10): every public method that returns private
     * key material enforces the biometric-session gate itself, so a future
     * call site cannot skip it. External callers use:
     *   - getEVMAddress()    - public material only, no gate
     *   - getEVMPrivateKey() - hex key, gated
     *   - getEVMKey()        - full DerivedKey, gated
     */
    private async deriveKey(path: string, chain: string, action: BiometricAction): Promise<DerivedKey> {
        assertBiometricAction(action);
        const mnemonic = await vault.read(seedUnlockPrompt(), action?.nativeId);
        assertBiometricAction(action);
        if (!mnemonic) {
            throw new Error('No mnemonic found: wallet not created');
        }

        const seed = mnemonicToSeedSync(mnemonic);
        const hdkey = HDKey.fromMasterSeed(seed);
        const derived = hdkey.derive(path);

        if (!derived.privateKey || !derived.publicKey) {
            throw new Error(`Key derivation failed for path: ${path}`);
        }

        const privateKeyHex = bytesToHex(derived.privateKey);

        const { secp256k1 } = await import('@noble/curves/secp256k1');
        try { assertBiometricAction(action); }
        catch (err) { seed.fill(0); derived.privateKey.fill(0); hdkey.wipePrivateData(); throw err; }
        const uncompressed = secp256k1.ProjectivePoint.fromHex(derived.publicKey).toRawBytes(false);
        const address = evmAddressFromPublicKey(uncompressed);

        const result: DerivedKey = {
            privateKey: derived.privateKey,
            privateKeyHex,
            publicKey: derived.publicKey,
            publicKeyHex: bytesToHex(derived.publicKey),
            address,
            chain,
            path,
        };

        // Wipe the 64-byte master seed and the HDKey's private material now that
        // the path key is derived. Only the returned derived.privateKey lives on
        // (the caller is responsible for wiping that). Previously the seed - from
        // which ALL keys derive - sat on the JS heap until GC on every signing
        // op, widening the memory-scrape window (review #28).
        seed.fill(0);
        try { (hdkey as { wipePrivateData?: () => void }).wipePrivateData?.(); } catch { /* best effort */ }

        return result;
    }

    /**
     * Get the EVM private key for transaction signing.
     *
     * Requires an explicit live BiometricAction. Throws BiometricSessionRequiredError
     * for missing, forged, ended or background-revoked approval. Signing callers pass their action capability.
     */
    async getEVMPrivateKey(action?: BiometricAction): Promise<string> {
        assertBiometricAction(action);
        const key = await this.deriveKey(DERIVATION_PATHS.EVM, 'evm', action);
        try { assertBiometricAction(action); } catch (err) { key.privateKey.fill(0); throw err; }
        const hex = '0x' + key.privateKeyHex;
        key.privateKey.fill(0);
        return hex;
    }

    /**
     * Get the full EVM DerivedKey (private key bytes + hex + address).
     *
     * Requires a valid biometric session - same gate as getEVMPrivateKey().
     * For callers that need more than the hex key (e.g. seed export UI).
     * The caller MUST wipe key.privateKey via .fill(0) as soon as it is done.
     */
    async getEVMKey(action?: BiometricAction): Promise<DerivedKey> {
        assertBiometricAction(action);
        const key = await this.deriveKey(DERIVATION_PATHS.EVM, 'evm', action);
        try { assertBiometricAction(action); return key; } catch (err) { key.privateKey.fill(0); throw err; }
    }

    /**
     * Write the F14 public-address cache for `mnemonic`. [] The seed store's identity record
     * is the authority (and is written atomically with every seed change); this cache only
     * identifies a wallet that has not moved to the native store yet.
     */
    async cachePublicAddresses(mnemonic: string): Promise<void> {
        const [evm, sol] = await Promise.all([
            deriveEvmAddressFromMnemonic(mnemonic),
            deriveSolanaAddressFromMnemonic(mnemonic),
        ]);
        await AsyncStorage.multiSet([
            [PUBLIC_ADDRESS_CACHE.EVM, evm],
            [PUBLIC_ADDRESS_CACHE.SOLANA, sol],
        ]);
    }

    /**
     * Get the EVM address. Public material only; no biometric required.
     *
     * [F14] Reads the persisted public-address cache and NEVER touches the
     * auth-gated mnemonic. Legacy wallets (created before F14, whose mnemonic
     * carries no auth ACL and whose cache is empty) fall back to a one-time seed
     * read + backfill — that read does not prompt because the legacy item has no
     * requireAuthentication ACL. New wallets always hit the cache.
     */
    async getEVMAddress(action?: BiometricAction): Promise<string> {
        // [] The seed store's identity names the wallet whose seed is stored — never a cache
        // that could lag it.
        const known = await vault.publicAddresses();
        if (known?.evm) return known.evm;
        assertBiometricAction(action);
        const mnemonic = await vault.read(seedUnlockPrompt(), action?.nativeId);
        assertBiometricAction(action);
        if (!mnemonic) {
            throw new Error('No mnemonic found: wallet not created');
        }
        const evm = await deriveEvmAddressFromMnemonic(mnemonic);
        await AsyncStorage.setItem(PUBLIC_ADDRESS_CACHE.EVM, evm).catch(() => {});
        return evm;
    }

    /**
     * Get the Solana address (base58). Public material only; no biometric required.
     * [F14] Cache-first, mirroring getEVMAddress().
     */
    async getSolanaAddress(action?: BiometricAction): Promise<string> {
        const known = await vault.publicAddresses();
        if (known?.sol) return known.sol;
        if (!known) {
            // A wallet that never moved to the native store: the F14 cache, as before.
            const cached = await AsyncStorage.getItem(PUBLIC_ADDRESS_CACHE.SOLANA);
            if (cached) return cached;
        }
        assertBiometricAction(action);
        const mnemonic = await vault.read(seedUnlockPrompt(), action?.nativeId);
        assertBiometricAction(action);
        if (!mnemonic) {
            throw new Error('No mnemonic found: wallet not created');
        }
        const sol = await deriveSolanaAddressFromMnemonic(mnemonic);
        await AsyncStorage.setItem(PUBLIC_ADDRESS_CACHE.SOLANA, sol).catch(() => {});
        return sol;
    }

    /**
     * Get the 32-byte ed25519 seed for the Solana account (the input to
     * @solana/web3.js Keypair.fromSeed). Requires a valid biometric session —
     * same gate as getEVMPrivateKey() — so no Solana signing path can obtain
     * key material without a fresh biometric, failing closed identically to EVM.
     *
     * The caller MUST wipe the returned Uint8Array via .fill(0) as soon as the
     * Keypair is built.
     */
    async getSolanaSeed(action?: BiometricAction): Promise<Uint8Array> {
        assertBiometricAction(action);
        assertBiometricAction(action);
        const mnemonic = await vault.read(seedUnlockPrompt(), action?.nativeId);
        assertBiometricAction(action);
        if (!mnemonic) {
            throw new Error('No mnemonic found: wallet not created');
        }
        const bip39Seed = mnemonicToSeedSync(mnemonic);
        const ed25519Seed = slip10DeriveEd25519Seed(bip39Seed, DERIVATION_PATHS.SOLANA);
        bip39Seed.fill(0);
        return ed25519Seed;
    }

    /**
     * Check if a wallet seed exists.
     *
     * [F14] Uses the public-address cache as the existence marker so a NEW wallet
     * never triggers the mnemonic's auth prompt here. Falls back to a mnemonic
     * read only when the cache is empty (a legacy wallet — no auth ACL, no prompt
     * — or the absent-wallet case, where the read simply returns null).
     */
    async hasSeed(): Promise<boolean> {
        if (await vault.publicAddresses()) return true;
        return vault.exists();
    }

    /**
     * Returns true if `candidate` derives the SAME EVM wallet as the seed
     * already stored on this device.
     *
     * Recovery flows (UX-1, 2026-06-13) use this to detect a no-op restore -
     * a returning user who rebuilt the app and is "restoring" the wallet
     * whose seed already survives in the Keychain. In that case the
     * destructive overwrite gate (B-1) is pointless friction: writing the
     * same wallet over itself loses nothing.
     *
     * Compares derived addresses, not raw strings, so two mnemonics that
     * differ only in whitespace/case still match. Does not require a
     * biometric session - it returns public material only (address
     * equality), never the seed itself, consistent with getEVMAddress().
     *
     * FAILS SAFE: returns false if no seed is stored, the candidate is not
     * valid BIP-39, or any read/derivation error occurs. A false result
     * routes the caller to the conservative overwrite-confirmation path, so
     * the worst case of any bug here is "showed the gate unnecessarily",
     * never "skipped the gate when the seeds differ".
     */
    async seedMatches(candidate: string, action?: BiometricAction): Promise<boolean> {
        try {
            const normalizedCandidate = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
            if (!validateMnemonic(normalizedCandidate, wordlist)) return false;

            // [F14] Compare the candidate's derived address to the STORED wallet's
            // PUBLIC address cache — never read the auth-gated mnemonic. Legacy
            // wallets (empty cache, no-auth-ACL mnemonic) fall back to a one-time
            // seed read (no prompt) that also backfills the cache.
            let storedAddress = (await vault.publicAddresses())?.evm ?? null;
            if (!storedAddress) {
                assertBiometricAction(action);
                const stored = await vault.read(seedUnlockPrompt(), action?.nativeId);
                if (!stored) return false;
                storedAddress = await deriveEvmAddressFromMnemonic(stored);
                await AsyncStorage.setItem(PUBLIC_ADDRESS_CACHE.EVM, storedAddress).catch(() => {});
            }

            const candidateAddress = await deriveEvmAddressFromMnemonic(normalizedCandidate);
            return storedAddress.toLowerCase() === candidateAddress.toLowerCase();
        } catch {
            return false;
        }
    }

    /** Approval belongs to the explicit action, never a timed or ambient session. */
    isBiometricSessionValid(action?: BiometricAction): boolean { return isBiometricActionValid(action); }
    clearBiometricSession(): void { revokeBiometricActions(); }
    withBiometricAction = withBiometricAction;

    /**
     * [] Move an existing wallet's seed from the F14 expo-secure-store
     * item to the re-enrollment-proof native store, if it is not there yet.
     * Called right after a successful unlock so installed wallets carry over
     * with no user step (only the OS prompts the ACLs themselves require). The
     * legacy item is deleted only after the new one reads back verified; any
     * failure leaves it untouched and this retries on the next unlock. Returns
     * 'unreadable' when the wallet is known but no seed can be read — the caller
     * routes to the restore flow.
     */
    migrateSeedStorageIfNeeded(action?: BiometricAction): Promise<MigrationOutcome> {
        if (!action) return withBiometricAction(seedUnlockPrompt(), granted => this.migrateSeedStorageIfNeeded(granted));
        assertBiometricAction(action);
        // Also the unlock-time readability check: a migrated wallet's live slot is probed without a
        // prompt (Android reports a permanently invalidated key); anything but "present" is verified
        // with a real read, and 'unreadable' routes to restore.
        return vault.migrateIfNeeded(seedUnlockPrompt(), action?.nativeId);
    }

    /**
     * [] Called by wallet creation BEFORE generating. 'generate' nothing usable is stored.
     * 'adopted' exactly one wallet is already stored (e.g. a creation killed during its read-back,
     * or bookkeeping wiped by a reinstall) and is now the committed wallet: continue with it; never
     * generate over it, never delete it. Throws when a KNOWN wallet's seed cannot be read (message
     * contains "already exists" → the restore / conflict UI), MultipleUnidentifiedWalletsError when
     * several different wallets are stored, and UnidentifiedStoredKeyError when ANY stored item could
     * not be read or identified (never generate or adopt beside it). 'generate' only when no seed item
     * of any kind exists. Nothing is ever deleted here.
     */
    async prepareNewWalletSeed(action?: BiometricAction): Promise<'generate' | 'adopted'> {
        if (!action) return withBiometricAction(seedUnlockPrompt(), granted => this.prepareNewWalletSeed(granted));
        assertBiometricAction(action);
        try {
            return (await vault.prepareForNewWallet(seedUnlockPrompt(), action?.nativeId)) === 'none' ? 'generate' : 'adopted';
        } catch (err) {
            if (err instanceof SeedUnreadableError) throw new SeedUnreadableExistingWalletError();
            throw err;
        }
    }

    /** [] True while this device knows the wallet but could not read its seed. */
    isSeedUnreadable(): Promise<boolean> {
        return vault.isMarkedUnreadable();
    }

    /**
     * [] An ACTUAL read of the stored seed (the OS prompts), classified: 'unreadable' means no
     * stored copy derives this wallet — definitive. A dismissed prompt rejects. The seed itself is
     * never returned. Cloud restore uses this to decide whether a same-wallet restore must repair.
     */
    verifySeedReadable(action?: BiometricAction): Promise<'readable' | 'unreadable' | 'no_wallet'> {
        if (!action) return withBiometricAction(seedUnlockPrompt(), granted => this.verifySeedReadable(granted));
        assertBiometricAction(action);
        return vault.verifyReadable(seedUnlockPrompt(), action?.nativeId);
    }

    /**
     * [] The public addresses of the wallet whose seed is stored (no prompt, no seed read), or
     * null when none is known. Screens reconcile their persisted address against this.
     */
    getPublicAddresses(): Promise<PublicAddresses | null> {
        return vault.publicAddresses();
    }

    /**
     * Delete all seed material (wallet deletion / reset).
     */
    async deleteAll(action?: BiometricAction): Promise<void> {
        if (action) assertBiometricAction(action);
        else this.clearBiometricSession();
        await this.invalidateDerivedCaches();
        if (action) assertBiometricAction(action);
        await vault.clear();
        await SecureStore.deleteItemAsync(KEYS.MASTER_SEED).catch(() => {});
        // [F14] Clear the public-address cache too, or a stale cache would make
        // hasSeed() report true after a wipe (and getEVMAddress return a dead addr).
        await AsyncStorage.multiRemove([PUBLIC_ADDRESS_CACHE.EVM, PUBLIC_ADDRESS_CACHE.SOLANA]).catch(() => {});
        if (action) assertBiometricAction(action);
        else this.clearBiometricSession();
        securityLog.log('SeedManager', 'All seed material deleted');
    }
}

/** A wallet is known on this device but its seed cannot be read: restore it, never create over it. */
export class SeedUnreadableExistingWalletError extends Error {
    readonly code = 'SEED_UNREADABLE_EXISTING_WALLET';

    constructor() {
        super('A wallet already exists on this device but its key cannot be read. Restore it from your cloud backup or recovery phrase.');
        this.name = 'SeedUnreadableExistingWalletError';
    }
}

/** Prompt shown if the OS must authenticate the read-back of a freshly written seed. */
const seedWritePrompt = (): string => translate('biometricPrompts.confirmNewWalletKey', 'Confirm your new wallet key');

const SeedManager = new SeedManagerImpl();

const vault = new SeedVault({
    native: loadNativeSeedStore,
    legacy: SecureStore,
    kv: defaultKeyValueStore,
    publicCacheKeys: { evm: PUBLIC_ADDRESS_CACHE.EVM, sol: PUBLIC_ADDRESS_CACHE.SOLANA },
    deriveEvmAddress: deriveEvmAddressFromMnemonic,
    deriveSolanaAddress: deriveSolanaAddressFromMnemonic,
    // Android Keystore keys can be permanently invalidated; iOS .userPresence items cannot.
    slotKeysCanBeInvalidated: () => Platform.OS === 'android',
    log: (message) => securityLog.log('SeedManager', message),
});

export default SeedManager;
