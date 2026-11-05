import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../../security/biometricAction';
/**
 * SolanaTransactionService — native SOL and SPL-token transfers.
 *
 * The Solana analogue of TransactionService.sendETH / sendERC20. It holds the
 * SAME money-safety bar as the EVM send path (CLAUDE.md pitfall #13):
 *   - assertWalletEnabled() (wallet-lockout gate) first,
 *   - an explicit BiometricAction before any key material is read,
 *   - the ed25519 key is obtained ONLY via SeedManager.getSolanaSeed(), which
 *     itself throws without a valid biometric session — so every Solana signing
 *     path fails closed identically to EVM.
 * The SendScreen additionally forces a fresh one-shot requireBiometric() at
 * confirm, chain-agnostically, so the on-screen gate is unchanged.
 *
 * The decrypted seed and the Keypair's secret key are wiped immediately after
 * signing. No key ever leaves the device; the relay never sees a Solana key.
 */

import { Buffer } from 'buffer';
import {
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync,
    createTransferCheckedInstruction,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { assertWalletEnabled } from '../../AppModeManager';
import SeedManager from '../../wallet/SeedManager';
import solanaRpc from './SolanaRpc';
import { parseAtomicAmount } from './amounts';
import { getSolanaTxExplorerUrl, SOL_DECIMALS } from './config';
import { translate } from '../../../i18n/translate';

/** Solana base fee: 5000 lamports per signature (one signer here). */
export const SOLANA_BASE_FEE_LAMPORTS = 5000;
/** Rent-exempt minimum for an SPL token account (165 bytes). */
export const SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
/**
 * Rent-exempt minimum for a plain (0-byte) system account. After paying, the sender's own
 * account must end at exactly 0 or at least this much, or the node rejects the transaction
 * with "insufficient funds for rent".
 */
export const SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS = 890_880;

/**
 * The SOL an SPL send needs from the sender. `spend` is the fee plus, when the recipient has
 * no token account, its rent. The send is valid when it leaves the sender at exactly 0 or at
 * least the rent-exempt minimum; `neededLamports` reports the amount that keeps the wallet
 * open (spend + minimum), the figure a user should hold.
 */
/**
 * Bytes of the associated token account the ATA program opens for a Token-2022 mint with these
 * extensions: the 165-byte base, the account-type byte, ImmutableOwner (4-byte header, no
 * data), and each account extension a mint extension implies (4-byte header + data). Mirrors
 * the relay's `tokenAccountSize` (provian-backend core/swap/swap-fees.ts), checked live on
 * PYUSD (187 bytes). An extension this table does not know is refused, never guessed.
 */
export function token2022AccountSize(mintExtensions: readonly string[]): number {
    let size = 165 + 1 + 4;
    for (const ext of mintExtensions) {
        if (!Object.prototype.hasOwnProperty.call(TOKEN_2022_ACCOUNT_EXTENSION_BYTES, ext)) {
            throw new Error(`Unrecognised Token-2022 extension ${ext}`);
        }
        const bytes = TOKEN_2022_ACCOUNT_EXTENSION_BYTES[ext];
        if (bytes !== null) size += 4 + bytes;
    }
    return size;
}

/** Mint extension → bytes of the account extension it adds at creation (null = adds none). */
const TOKEN_2022_ACCOUNT_EXTENSION_BYTES: Readonly<Record<string, number | null>> = {
    transferFeeConfig: 8,
    transferHook: 1,
    nonTransferable: 0,
    pausableConfig: 0,
    mintCloseAuthority: null,
    confidentialTransferMint: null,
    confidentialTransferFeeConfig: null,
    confidentialMintBurn: null,
    defaultAccountState: null,
    interestBearingConfig: null,
    permanentDelegate: null,
    metadataPointer: null,
    tokenMetadata: null,
    groupPointer: null,
    tokenGroup: null,
    groupMemberPointer: null,
    tokenGroupMember: null,
    scaledUiAmountConfig: null,
};

export function splSendFunding(
    recipientAccountExists: boolean,
    haveLamports: number,
    tokenAccountRentLamports: number = SPL_TOKEN_ACCOUNT_RENT_LAMPORTS,
): SplSendFunding {
    const spend = SOLANA_BASE_FEE_LAMPORTS + (recipientAccountExists ? 0 : tokenAccountRentLamports);
    const neededLamports = spend + SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS;
    return {
        createsTokenAccount: !recipientAccountExists,
        neededLamports,
        haveLamports,
        sufficient: haveLamports === spend || haveLamports >= neededLamports,
    };
}

export interface SplSendFunding {
    createsTokenAccount: boolean;
    neededLamports: number;
    haveLamports: number;
    sufficient: boolean;
}

/**
 * The SOL a NATIVE send needs from the sender: the amount plus the network fee, leaving the
 * sender's account at exactly 0 or at least the rent-exempt minimum — otherwise the node rejects
 * the transaction with "insufficient funds for rent", which until 2026-10-17 surfaced as a raw
 * node error after Face ID. `neededLamports` is the figure that keeps the wallet open.
 */
export function solSendFunding(amountLamports: number, haveLamports: number): SolSendFunding {
    const spend = amountLamports + SOLANA_BASE_FEE_LAMPORTS;
    const neededLamports = spend + SOLANA_ACCOUNT_RENT_EXEMPT_MIN_LAMPORTS;
    return { neededLamports, haveLamports, sufficient: haveLamports === spend || haveLamports >= neededLamports };
}

export interface SolSendFunding {
    neededLamports: number;
    haveLamports: number;
    sufficient: boolean;
}

/** The sender holds too little SOL to pay the fee (and account rent) for an SPL send. */
export class InsufficientSolForFeesError extends Error {
    readonly code = 'INSUFFICIENT_SOL_FOR_FEES';
    constructor(
        readonly neededLamports: number,
        readonly haveLamports: number,
        readonly createsTokenAccount: boolean,
    ) {
        super(`Needs ${neededLamports / 1e9} SOL for network fees; wallet holds ${haveLamports / 1e9} SOL`);
        this.name = 'InsufficientSolForFeesError';
    }
}

export interface SolanaSendResult {
    txHash: string;
    explorerUrl: string;
}

export interface SendSolParams {
    to: string;
    /** SOL amount as a decimal string, e.g. "0.01". */
    amount: string;
}

export interface SendSplParams {
    to: string;
    /** Token amount as a decimal string. */
    amount: string;
    /** SPL mint (base58). */
    mint: string;
    /** Token decimals (6 for USDC). */
    decimals: number;
}

/**
 * True for an address a wallet-to-wallet send can target: base58, 32 bytes, on the ed25519
 * curve. A token-account address (off-curve, often shown by explorers) is false.
 */
export function isSolanaWalletAddress(address: string): boolean {
    try {
        return PublicKey.isOnCurve(new PublicKey(address).toBytes());
    } catch {
        return false;
    }
}

function assertValidSolanaAddress(address: string, label: string): PublicKey {
    let pubkey: PublicKey;
    try {
        pubkey = new PublicKey(address);
    } catch {
        throw new Error(`Invalid Solana ${label} address`);
    }
    // Reject an address that is not a valid ed25519 point (e.g. a PDA passed as
    // a wallet). Wallet-to-wallet transfers target on-curve system accounts.
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
        throw new Error(`Solana ${label} address is not a valid wallet address`);
    }
    return pubkey;
}

class SolanaTransactionService {
    private static instance: SolanaTransactionService;
    private constructor() {}

    static getInstance(): SolanaTransactionService {
        if (!SolanaTransactionService.instance) {
            SolanaTransactionService.instance = new SolanaTransactionService();
        }
        return SolanaTransactionService.instance;
    }

    /**
     * Load the wallet's Keypair from the biometric-gated seed. Caller MUST call
     * wipeKeypair(kp) when done to scrub the secret key from memory.
     */
    private async loadKeypair(reason: string, biometricAction?: BiometricAction): Promise<Keypair> {
        return await withBiometricAction(reason, async (biometricAction) => {
            assertBiometricAction(biometricAction);
            const seed = await SeedManager.getSolanaSeed(biometricAction);
            try {
                return Keypair.fromSeed(seed);
            } finally {
                seed.fill(0);
            }

        }, biometricAction);
    }

    private wipeKeypair(kp: Keypair): void {
        try {
            kp.secretKey.fill(0);
        } catch {
            /* best effort */
        }
    }

    /** Send native SOL. */
    async sendSOL(params: SendSolParams, biometricAction?: BiometricAction): Promise<SolanaSendResult> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.approveSolanaSend', 'Approve Solana send'), action => this.sendSOL(params, action));
        assertBiometricAction(biometricAction);
        assertWalletEnabled('sendSOL');

        const toPubkey = assertValidSolanaAddress(params.to, 'recipient');
        const lamports = parseAtomicAmount(params.amount, SOL_DECIMALS);
        if (lamports <= 0n) {
            throw new Error('Amount must be greater than zero');
        }
        if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Amount too large');
        }

        const keypair = await this.loadKeypair(translate('biometricPrompts.approveSendSol', `Approve send of ${params.amount} SOL`, { amount: params.amount }), biometricAction);
        try {
            // Fee + rent preflight (the Send screen asks the same question before Face ID).
            const funding = solSendFunding(Number(lamports), await solanaRpc.getBalanceLamports(keypair.publicKey.toBase58()));
            if (!funding.sufficient) {
                throw new InsufficientSolForFeesError(funding.neededLamports, funding.haveLamports, false);
            }
            const { blockhash } = await solanaRpc.getLatestBlockhash();
            const tx = new Transaction();
            tx.add(
                SystemProgram.transfer({
                    fromPubkey: keypair.publicKey,
                    toPubkey,
                    lamports: Number(lamports),
                }),
            );
            tx.feePayer = keypair.publicKey;
            tx.recentBlockhash = blockhash;
            assertBiometricAction(biometricAction);
            tx.sign(keypair);
            assertBiometricAction(biometricAction);
            const signature = await this.broadcast(tx);
            return { txHash: signature, explorerUrl: getSolanaTxExplorerUrl(signature) };
        } finally {
            this.wipeKeypair(keypair);
        }
    }

    /**
     * The SOL an SPL send needs from the SENDER (see splSendFunding): the base network fee,
     * plus rent for the recipient's associated token account when it does not exist yet (the
     * sender pays to create it), while leaving the sender's own account rent-exempt. An SPL
     * token pays nothing toward fees — they are always paid in SOL.
     * Fails closed: an unknown recipient-account state throws.
     */
    /** The SOL a native send needs from `from` (see solSendFunding); the Send screen's preflight. */
    async solSendSolRequirement(params: { from: string; amount: string }): Promise<SolSendFunding> {
        const lamports = parseAtomicAmount(params.amount, SOL_DECIMALS);
        if (lamports <= 0n) throw new Error('Amount must be greater than zero');
        if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large');
        return solSendFunding(Number(lamports), await solanaRpc.getBalanceLamports(params.from));
    }

    async splSendSolRequirement(params: { from: string; to: string; mint: string }): Promise<SplSendFunding> {
        const owner = assertValidSolanaAddress(params.to, 'recipient');
        const mint = new PublicKey(params.mint);
        const token = await this.readTokenMint(mint);
        const toAta = getAssociatedTokenAddressSync(mint, owner, false, token.programId);
        const exists = await solanaRpc.accountExists(toAta.toBase58());
        if (exists === null) {
            throw new Error('Could not verify recipient token account; aborting for safety');
        }
        return splSendFunding(exists, await solanaRpc.getBalanceLamports(params.from), token.accountRentLamports);
    }

    /**
     * Which token program owns `mint`, and the rent the recipient's account for it costs. A
     * classic SPL mint keeps the fixed figure; a Token-2022 mint's account is sized by its
     * extensions and priced from chain, never below the classic figure. A Token-2022 mint with
     * an active transfer hook needs accounts this wallet does not add, so it is refused rather
     * than sent into a transaction the network rejects. Anything else is not a token: refused.
     */
    private async readTokenMint(mint: PublicKey): Promise<{ programId: PublicKey; accountRentLamports: number }> {
        const info = await solanaRpc.getMintParsed(mint.toBase58());
        if (!info) throw new Error('Token mint not found on Solana');
        if (info.owner === TOKEN_PROGRAM_ID.toBase58()) {
            return { programId: TOKEN_PROGRAM_ID, accountRentLamports: SPL_TOKEN_ACCOUNT_RENT_LAMPORTS };
        }
        if (info.owner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
            throw new Error('Not a Solana token mint');
        }
        const hook = info.extensions.find((e) => e.extension === 'transferHook');
        if (hook && hook.state?.programId != null) {
            throw new Error('Tokens with a transfer hook cannot be sent from this wallet yet');
        }
        const rent = await solanaRpc.getMinimumBalanceForRentExemption(token2022AccountSize(info.extensions.map((e) => e.extension)));
        return { programId: TOKEN_2022_PROGRAM_ID, accountRentLamports: Math.max(rent, SPL_TOKEN_ACCOUNT_RENT_LAMPORTS) };
    }

    /** Send an SPL token (e.g. USDC on Solana). */
    async sendSPL(params: SendSplParams, biometricAction?: BiometricAction): Promise<SolanaSendResult> {
        if (!biometricAction) return withBiometricAction(translate('biometricPrompts.approveSolanaSend', 'Approve Solana send'), action => this.sendSPL(params, action));
        assertBiometricAction(biometricAction);
        assertWalletEnabled('sendSPL');

        const ownerTo = assertValidSolanaAddress(params.to, 'recipient');
        const mint = (() => {
            try {
                return new PublicKey(params.mint);
            } catch {
                throw new Error('Invalid SPL mint address');
            }
        })();
        const atomic = parseAtomicAmount(params.amount, params.decimals);
        if (atomic <= 0n) {
            throw new Error('Amount must be greater than zero');
        }

        const token = await this.readTokenMint(mint);
        const keypair = await this.loadKeypair(translate('biometricPrompts.approveTokenTransfer', `Approve token transfer of ${params.amount}`, { amount: params.amount }), biometricAction);
        try {
            const fromAta = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, token.programId);
            const toAta = getAssociatedTokenAddressSync(mint, ownerTo, false, token.programId);

            const { blockhash } = await solanaRpc.getLatestBlockhash();
            const tx = new Transaction();

            // If the recipient has no associated token account for this mint,
            // create it (payer = sender). Unknown existence (RPC failure) fails
            // closed: we refuse rather than risk a doomed transfer.
            const exists = await solanaRpc.accountExists(toAta.toBase58());
            if (exists === null) {
                throw new Error('Could not verify recipient token account; aborting for safety');
            }
            // Refuse before signing when the sender cannot pay the SOL this send needs —
            // otherwise the RPC rejects it with a cryptic "no record of a prior credit".
            const funding = splSendFunding(
                exists,
                await solanaRpc.getBalanceLamports(keypair.publicKey.toBase58()),
                token.accountRentLamports,
            );
            if (!funding.sufficient) {
                throw new InsufficientSolForFeesError(funding.neededLamports, funding.haveLamports, funding.createsTokenAccount);
            }
            if (!exists) {
                tx.add(
                    createAssociatedTokenAccountInstruction(
                        keypair.publicKey, // payer
                        toAta,
                        ownerTo, // owner
                        mint,
                        token.programId,
                    ),
                );
            }

            tx.add(
                createTransferCheckedInstruction(
                    fromAta,
                    mint,
                    toAta,
                    keypair.publicKey, // owner / authority
                    atomic,
                    params.decimals,
                    [],
                    token.programId,
                ),
            );
            tx.feePayer = keypair.publicKey;
            tx.recentBlockhash = blockhash;
            assertBiometricAction(biometricAction);
            tx.sign(keypair);
            assertBiometricAction(biometricAction);
            const signature = await this.broadcast(tx);
            return { txHash: signature, explorerUrl: getSolanaTxExplorerUrl(signature) };
        } finally {
            this.wipeKeypair(keypair);
        }
    }

    private async broadcast(tx: Transaction): Promise<string> {
        const raw = tx.serialize(); // requires a fully-signed tx; throws otherwise
        const base64 = Buffer.from(raw).toString('base64');
        return solanaRpc.sendRawTransaction(base64);
    }

    /**
     * Estimate the SOL network fee for display. Solana's base fee is 5000
     * lamports per signature; SPL transfers that must create the recipient's
     * token account also pay rent (~0.00204 SOL). Returns a decimal SOL string.
     * This is display-only; the real fee is deducted on-chain.
     */
    estimateFeeSol(opts?: { createsTokenAccount?: boolean }): string {
        const baseLamports = SOLANA_BASE_FEE_LAMPORTS;
        const rentLamports = opts?.createsTokenAccount ? SPL_TOKEN_ACCOUNT_RENT_LAMPORTS : 0;
        const sol = (baseLamports + rentLamports) / 1e9;
        return sol.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
    }
}

export default SolanaTransactionService.getInstance();
