import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * WalletCreationService - BIP-39 EVM EOA Wallet Creation
 *
 * Creates a wallet by generating a BIP-39 mnemonic and deriving the EVM
 * key at the canonical BIP-44 path:
 *
 *   BIP-39 Mnemonic (12 words)
 *     → Master Seed (PBKDF2)
 *       → m/44'/60'/0'/0/0  → secp256k1 → EVM EOA address (Base/Arb/Op)
 *
 * The same EOA address is valid on Base, Arbitrum, and Optimism - there is
 * no per-chain wallet, no smart contract account, no CREATE2 derivation.
 *
 * The same single BIP-39 seed also derives the wallet's Solana address
 * (ed25519, SLIP-0010 path m/44'/501'/0'/0'), persisted alongside the EVM
 * address. One seed, one backup, one recovery covers every chain including
 * Solana. (Solana is a hold/send/receive/swap surface only; PVT and PE
 * minting remain on Base.)
 *
 * SIGNING:
 * - All transactions are standard EOA secp256k1 ECDSA signed by SeedManager
 * - Mnemonic is stored encrypted in expo-secure-store
 * - The Secure Enclave P-256 key (KeyManager) is INDEPENDENT - used only for
 *   PE attestation, not wallet ownership
 *
 * RECOVERY:
 * - Cloud backup stores the mnemonic encrypted with the user's PIN
 *   (PBKDF2 + AES-256-GCM via CloudBackupV2)
 * - On a new device: pull blob, enter PIN, decrypt mnemonic,
 *   `SeedManager.importMnemonic()`, restore wallet
 * - The 12 words are also exportable in Settings for users who want a
 *   self-sovereign offline backup
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import SeedManager from './SeedManager';
import KeyManager from '../security/KeyManager';
import securityLog from '../security/securityLogger';
import { ARCHIVE_PENDING_PURCHASE_KEY } from '../meter/archivePurchase';
import { translate } from '../../i18n/translate';

// =============================================================================
// STORAGE KEYS
// =============================================================================

const STORAGE_KEYS = {
    WALLET_ADDRESS: 'provian_wallet_address',
    WALLET_CREATED_AT: 'provian_wallet_created_at',
    KEY_SOURCE: 'provian_key_source',
    EVM_ADDRESS: 'provian_evm_address',
    // The Solana (ed25519) address derived from the SAME seed as the EVM key.
    SOLANA_ADDRESS: 'provian_solana_address',
} as const;

// =============================================================================
// TYPES
// =============================================================================

export interface WalletCreationResult {
    /** The EVM EOA address (same on Base, Arbitrum, Optimism) */
    walletAddress: string;
    /** The Solana address (ed25519, base58) derived from the same seed */
    solanaAddress: string;
    /** Attestation tier of the device's PE signing key (independent of the wallet key) */
    attestationTier: string;
}

export interface StoredWalletState {
    walletAddress: string;
    /** Solana address; optional for wallets created before Solana support (lazily backfilled). */
    solanaAddress?: string;
    createdAt: string;
    keySource: 'bip39_seed';
}

// =============================================================================
// WALLET CREATION SERVICE
// =============================================================================

class WalletCreationService {
    private static instance: WalletCreationService;

    private constructor() {}

    static getInstance(): WalletCreationService {
        if (!WalletCreationService.instance) {
            WalletCreationService.instance = new WalletCreationService();
        }
        return WalletCreationService.instance;
    }

    /**
     * Create a new BIP-39 EOA wallet.
     *
     * 1. Generate a 12-word mnemonic via SeedManager
     * 2. Derive the EVM key at m/44'/60'/0'/0/0
     * 3. Store the address as the user's wallet address
     */
    async createWallet(biometricAction?: BiometricAction): Promise<WalletCreationResult> {
        if (!biometricAction) return await withBiometricAction(translate('biometricPrompts.createWallet', 'Create your wallet'), action => this.createWallet(action));
        if (await AsyncStorage.getItem(STORAGE_KEYS.WALLET_ADDRESS)) {
            throw new Error(
                'Wallet already exists. Delete existing wallet first with deleteWallet().',
            );
        }

        securityLog.log('WalletCreation', 'Starting BIP-39 wallet creation');

        // Step 1: Generate the BIP-39 mnemonic and store it — unless a seed is already stored.
        // [] A creation killed during its read-back prompt (or a reinstall that wiped the
        // bookkeeping but not the keychain) leaves exactly one stored phrase: ADOPT it and continue
        // (it may be someone's only copy of real funds). Never generate over it, never delete it.
        // Several different stored phrases, or a known wallet whose key cannot be read, throw an
        // "already exists" error — the screen's conflict panel offers Restore.
        const plan = await SeedManager.prepareNewWalletSeed(biometricAction);
        if (plan === 'generate') {
            await SeedManager.generate(biometricAction);
            securityLog.log('WalletCreation', 'BIP-39 mnemonic generated');
        } else {
            securityLog.log('WalletCreation', 'Adopted the seed already stored on this device');
        }

        // Step 2: Derive the EVM EOA address from the seed. getEVMAddress()
        // returns public material only and wipes the derived private key
        // internally - no key bytes cross this module boundary.
        const walletAddress = await SeedManager.getEVMAddress(biometricAction);

        securityLog.log('WalletCreation', 'EVM EOA address derived');

        // Step 2b: Derive the Solana address from the SAME seed (public material
        // only; the derived key bytes are wiped internally). No new seed, no
        // separate backup — one mnemonic restores both chains identically.
        const solanaAddress = await SeedManager.getSolanaAddress(biometricAction);

        securityLog.log('WalletCreation', 'Solana address derived');

        // Step 3: Read the device's PE attestation tier (independent of wallet keys).
        // This is the SE / StrongBox / TEE capability check used to stamp PEs at
        // the right attestation depth - it does not generate or use wallet keys.
        const attestation = await KeyManager.getKeyAttestation();

        // Step 4: Persist wallet state.
        await this.persistWalletState({
            walletAddress,
            solanaAddress,
            createdAt: new Date().toISOString(),
            keySource: 'bip39_seed',
        });

        securityLog.log('WalletCreation', 'Wallet state persisted');

        return {
            walletAddress,
            solanaAddress,
            attestationTier: attestation.tier,
        };
    }

    /**
     * Get the stored wallet state, or null if no wallet exists.
     */
    async getStoredWallet(biometricAction?: BiometricAction): Promise<StoredWalletState | null> {
        const storedAddress = await AsyncStorage.getItem(STORAGE_KEYS.WALLET_ADDRESS);
        if (!storedAddress) return null;

        // [] The address shown (Receive) must be the wallet whose seed is stored.
        const known = await this.reconcileStoredAddresses();
        const walletAddress = known?.evm ?? storedAddress;
        const createdAt = await AsyncStorage.getItem(STORAGE_KEYS.WALLET_CREATED_AT);
        const solanaAddress = known?.sol || (await this.getSolanaAddress(biometricAction));

        return {
            walletAddress,
            solanaAddress: solanaAddress ?? undefined,
            createdAt: createdAt || '',
            keySource: 'bip39_seed',
        };
    }

    /**
     * [] Bring the persisted display addresses in line with the wallet whose seed is stored
     * (the seed store's identity record, read without a prompt). They are written by the screens
     * AFTER a create/import returns, so an app killed in between would otherwise keep showing — and
     * receiving to — the previous wallet. Returns the stored wallet's addresses, or null if unknown.
     */
    async reconcileStoredAddresses(): Promise<{ evm: string; sol: string } | null> {
        const known = await SeedManager.getPublicAddresses().catch(() => null);
        if (!known) return null;
        try {
            const [evm, sol] = await Promise.all([
                AsyncStorage.getItem(STORAGE_KEYS.WALLET_ADDRESS),
                AsyncStorage.getItem(STORAGE_KEYS.SOLANA_ADDRESS),
            ]);
            const pairs: [string, string][] = [];
            if (evm && evm.toLowerCase() !== known.evm.toLowerCase()) {
                pairs.push([STORAGE_KEYS.WALLET_ADDRESS, known.evm], [STORAGE_KEYS.EVM_ADDRESS, known.evm]);
            }
            if (known.sol && sol !== null && sol !== known.sol) pairs.push([STORAGE_KEYS.SOLANA_ADDRESS, known.sol]);
            if (pairs.length > 0) {
                await AsyncStorage.multiSet(pairs);
                securityLog.log('WalletCreation', 'Persisted wallet address reconciled with the stored seed');
            }
        } catch {
            // Display cache only; the returned identity is still authoritative for this call.
        }
        return known;
    }

    /**
     * Get the wallet address, or null if no wallet exists.
     */
    async getWalletAddress(): Promise<string | null> {
        const stored = await AsyncStorage.getItem(STORAGE_KEYS.WALLET_ADDRESS);
        if (!stored) return null;
        return (await this.reconcileStoredAddresses())?.evm ?? stored;
    }

    /**
     * Get the Solana address, or null if no wallet exists.
     *
     * Backwards-compatible: wallets created before Solana support have no
     * persisted Solana address. In that case it is derived on demand from the
     * resident seed (public material only) and backfilled to storage, so the
     * address is stable and appears identically to a freshly-created wallet.
     */
    async getSolanaAddress(biometricAction?: BiometricAction): Promise<string | null> {
        const stored = await AsyncStorage.getItem(STORAGE_KEYS.SOLANA_ADDRESS);
        if (stored) return stored;

        if (!(await SeedManager.hasSeed())) return null;
        try {
            const derived = await SeedManager.getSolanaAddress(biometricAction);
            await AsyncStorage.setItem(STORAGE_KEYS.SOLANA_ADDRESS, derived);
            securityLog.log('WalletCreation', 'Solana address backfilled from seed');
            return derived;
        } catch {
            return null;
        }
    }

    /**
     * Check if a wallet has been created.
     */
    async hasWallet(): Promise<boolean> {
        return SeedManager.hasSeed();
    }

    /**
     * Delete the wallet and all associated keys.
     *
     * WARNING: This permanently destroys the BIP-39 seed on this device. If
     * the user has not backed up the mnemonic (cloud or paper), funds will
     * be inaccessible.
     */
    async deleteWallet(action?: BiometricAction): Promise<void> {
        await SeedManager.deleteAll(action);

        await AsyncStorage.multiRemove([
            STORAGE_KEYS.WALLET_ADDRESS,
            STORAGE_KEYS.WALLET_CREATED_AT,
            STORAGE_KEYS.KEY_SOURCE,
            STORAGE_KEYS.EVM_ADDRESS,
            STORAGE_KEYS.SOLANA_ADDRESS,
            // A PE Archive purchase still being followed up belongs to the deleted wallet.
            ARCHIVE_PENDING_PURCHASE_KEY,
        ]);

        securityLog.log('WalletCreation', 'Wallet deleted - BIP-39 seed wiped');
    }

    /**
     * Persist wallet state to AsyncStorage.
     */
    private async persistWalletState(state: StoredWalletState): Promise<void> {
        const pairs: [string, string][] = [
            [STORAGE_KEYS.WALLET_ADDRESS, state.walletAddress],
            [STORAGE_KEYS.WALLET_CREATED_AT, state.createdAt],
            [STORAGE_KEYS.KEY_SOURCE, state.keySource],
            [STORAGE_KEYS.EVM_ADDRESS, state.walletAddress],
        ];
        if (state.solanaAddress) {
            pairs.push([STORAGE_KEYS.SOLANA_ADDRESS, state.solanaAddress]);
        }

        await AsyncStorage.multiSet(pairs);
    }
}

export const walletCreationService = WalletCreationService.getInstance();
export default WalletCreationService;
