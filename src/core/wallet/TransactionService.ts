import { listWalletRecoveryTransactions, type RecoverableWalletTransaction } from '../security/ActionWallet';
import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * TransactionService - Standard EOA Transaction Signing & Submission
 *
 * Orchestrates the full send lifecycle:
 * 1. Get secp256k1 private key from SeedManager (BIP-44 derived)
 * 2. Create ethers.Wallet for the EOA
 * 3. Sign and send standard EVM transaction
 *
 * All EVM transactions use the BIP-44 derived secp256k1 key at m/44'/60'/0'/0/0.
 * No UserOperations, no EntryPoint, no bundler - standard EOA transactions.
 */

import { ethers } from 'ethers';
import { assertWalletEnabled } from '../AppModeManager';
import { ALL_CHAINS, PVT9_TOKEN } from '../chains/evm/config';
import SeedManager from './SeedManager';
import { translate } from '../../i18n/translate';

// =============================================================================
// CONSTANTS
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

export interface SendParams {
    to: string;
    /** ETH amount as a decimal string, e.g. "0.001" */
    amount: string;
    /** Chain ID (defaults to Base mainnet 8453) */
    chainId?: number;
    /** Optional calldata for contract interactions */
    data?: string;
}

export interface SendERC20Params {
    to: string;
    /** Token amount as a decimal string, e.g. "10.5" */
    amount: string;
    /** ERC-20 token contract address */
    tokenAddress: string;
    /** Token decimals (e.g. 6 for USDC, 18 for DAI) */
    decimals: number;
    /** Chain ID (defaults to Base mainnet 8453) */
    chainId?: number;
}

export interface SendResult {
    /** Transaction hash */
    txHash: string;
    /** Explorer URL */
    explorerUrl: string;
}

// =============================================================================
// HELPERS
// =============================================================================

// =============================================================================
// TRANSACTION SERVICE
// =============================================================================

class TransactionService {
    private static instance: TransactionService;
    private providers: Map<number, ethers.JsonRpcProvider> = new Map();

    private constructor() {}

    static getInstance(): TransactionService {
        if (!TransactionService.instance) {
            TransactionService.instance = new TransactionService();
        }
        return TransactionService.instance;
    }

    private getProvider(chainId: number): ethers.JsonRpcProvider {
        if (!this.providers.has(chainId)) {
            const chain = ALL_CHAINS.find(c => c.chainId === chainId);
            if (!chain) throw new Error(`No RPC for chain ${chainId}`);
            this.providers.set(chainId, new ethers.JsonRpcProvider(chain.rpcUrl));
        }
        return this.providers.get(chainId)!;
    }

    /**
     * Get a JSON-RPC provider for the given chain.
     * Public read-only helper - does not require a wallet key. Used by
     * AgentExecutionGate and other modules that need to make read-only
     * on-chain queries (e.g. token decimals lookup).
     */
    providerFor(chainId: number): ethers.JsonRpcProvider {
        return this.getProvider(chainId);
    }

    /**
     * Send ETH/native token as a standard EOA transaction.
     *
     * Uses the BIP-44 derived secp256k1 private key from SeedManager.
     * Standard ECDSA signing - no UserOperations, no EntryPoint, no bundler.
     */
    async sendETH(params: SendParams, biometricAction?: BiometricAction): Promise<SendResult> {
        // [WALLET LOCKOUT] Block wallet operations when wallet is disabled
        assertWalletEnabled('sendETH');

        const chainId = params.chainId || 8453; // Default to Base mainnet
        const provider = this.getProvider(chainId);

        // [Group 1 / M-2] Establish or refresh biometric session before
        // touching seed material. SendScreen prompts at screen entry, so
        // this is usually a no-op; the gate is here as defense-in-depth
        // for any future caller that bypasses the screen-level prompt.
        return await withBiometricAction(translate('biometricPrompts.approveSendEth', `Approve send of ${params.amount} ETH`, { amount: params.amount }), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            // Get secp256k1 private key from BIP-44 derivation
            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);

            // Create standard EOA wallet
            const wallet = new ActionWallet(privateKey, biometricAction, provider);

            console.log(`[TransactionService] Sending ${params.amount} ETH to ${params.to.slice(0, 10)}… from EOA ${wallet.address.slice(0, 10)}…`);

            // Build and send standard transaction
            const tx = await wallet.sendTransaction({
                to: params.to,
                value: ethers.parseEther(params.amount),
                data: params.data || '0x',
            });

            console.log(`[TransactionService] Transaction sent: ${tx.hash}`);

            // Wait for confirmation
            const receipt = await tx.wait();
            if (!receipt || receipt.status === 0) {
                throw new Error('Transaction reverted on-chain');
            }

            console.log(`[TransactionService] Transaction confirmed in block ${receipt.blockNumber}`);

            const chain = ALL_CHAINS.find((c: { chainId: number; explorerUrl: string }) => c.chainId === chainId);
            const explorerUrl = chain
                ? `${chain.explorerUrl}/tx/${tx.hash}`
                : tx.hash;

            return {
                txHash: tx.hash,
                explorerUrl,
            };

        }, biometricAction);
    }

    /**
     * Send an ERC-20 token as a standard EOA transaction.
     *
     * Builds `transfer(address,uint256)` calldata and sends with value=0.
     */
    async sendERC20(params: SendERC20Params, biometricAction?: BiometricAction): Promise<SendResult> {
        assertWalletEnabled('sendERC20');

        const chainId = params.chainId || 8453;
        const provider = this.getProvider(chainId);

        // [Group 1 / M-2] Establish or refresh biometric session.
        return await withBiometricAction(translate('biometricPrompts.approveTokenTransfer', `Approve token transfer of ${params.amount}`, { amount: params.amount }), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction, provider);

            const tokenContract = new ethers.Contract(
                params.tokenAddress,
                ['function transfer(address to, uint256 amount) returns (bool)'],
                wallet,
            );

            // Convert decimal amount to token units using the correct decimals
            const tokenAmount = ethers.parseUnits(params.amount, params.decimals);

            console.log(`[TransactionService] Sending ${params.amount} (${params.tokenAddress.slice(0, 10)}…) to ${params.to.slice(0, 10)}… on chain ${chainId}`);

            const tx = await tokenContract.transfer(params.to, tokenAmount);

            console.log(`[TransactionService] ERC-20 transfer sent: ${tx.hash}`);

            const receipt = await tx.wait();
            if (!receipt || receipt.status === 0) {
                throw new Error('ERC-20 transfer reverted on-chain');
            }

            console.log(`[TransactionService] ERC-20 transfer confirmed in block ${receipt.blockNumber}`);

            const chain = ALL_CHAINS.find((c: { chainId: number; explorerUrl: string }) => c.chainId === chainId);
            const explorerUrl = chain
                ? `${chain.explorerUrl}/tx/${tx.hash}`
                : tx.hash;

            return {
                txHash: tx.hash,
                explorerUrl,
            };

        }, biometricAction);
    }

    /**
     * F-A5-1 — Burn PVT from the human's OWN first-party wallet (burn-to-present,
     * human side). Calls the PVT9 kernel's public `burn(uint256)`, which
     * `_burn(msg.sender, amount)` → emits `Transfer(holder, 0x0, amount)` the
     * exact event `verifyEvmPvtBurn` re-checks server-side. A plain transfer to
     * 0x0 would revert (OZ ERC-20), so the burn MUST go through this function.
     * Base-only (PVT9 is Base). Biometric-gated like every first-party spend.
     * Returns the tx hash + the atomic amount the caller records via
     * `RelayAPIService.recordFirstPartyBurn` (or hands to a pipelined present).
     *
     * returns at BROADCAST — no local confirmation wait. The relay holds the record /
     * present until the burn is mined (one Base block) and reports a mined-but-reverted burn as
     * `tx_failed`; a call that would revert is refused before broadcast by the gas estimate.
     */
    async burnPVT(params: { amount: string; operationId?: string }, biometricAction?: BiometricAction): Promise<SendResult & { amountAtomic: string; nonce: number }> {
        assertWalletEnabled('burnPVT');

        const chainId = PVT9_TOKEN.chainId;
        const provider = this.getProvider(chainId);

        return await withBiometricAction(translate('biometricPrompts.approveBurnPvt', `Approve burn of ${params.amount} PVT`, { amount: params.amount }), async (biometricAction) => {
            assertBiometricAction(biometricAction);

            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction, provider, params.operationId);

            const pvt = new ethers.Contract(
                PVT9_TOKEN.address,
                ['function burn(uint256 amount)'],
                wallet,
            );

            const amountAtomic = ethers.parseUnits(params.amount, PVT9_TOKEN.decimals);

            console.log(`[TransactionService] Burning ${params.amount} PVT (${PVT9_TOKEN.address.slice(0, 10)}…) on chain ${chainId}`);

            const tx = await pvt.burn(amountAtomic);

            console.log(`[TransactionService] PVT burn broadcast: ${tx.hash}`);

            const chain = ALL_CHAINS.find((c: { chainId: number; explorerUrl: string }) => c.chainId === chainId);
            const explorerUrl = chain ? `${chain.explorerUrl}/tx/${tx.hash}` : tx.hash;

            return { txHash: tx.hash, explorerUrl, amountAtomic: amountAtomic.toString(), nonce: tx.nonce };

        }, biometricAction);
    }

    /**
     * the chain's view of a PVT burn tx this phone broadcast — `mined` (a receipt exists),
     * `pending` (the node still holds it), or `unknown` (dropped / never propagated). an unknown response never authorizes a second burn.
     */
    async burnTxStatus(txHash: string): Promise<'mined' | 'pending' | 'unknown'> {
        const provider = this.getProvider(PVT9_TOKEN.chainId);
        const [receipt, tx] = await Promise.all([provider.getTransactionReceipt(txHash), provider.getTransaction(txHash)]);
        if (receipt) return 'mined';
        return tx ? 'pending' : 'unknown';
    }

    async listRecoveryTransactions(address: string): Promise<RecoverableWalletTransaction[]> {
        const rows = await Promise.all([8453, 42161, 10].map(chainId =>
            listWalletRecoveryTransactions(address, this.getProvider(chainId))));
        return rows.flat();
    }

    async recoverTransaction(saved: RecoverableWalletTransaction): Promise<string> {
        assertWalletEnabled('recoverTransaction');
        // Connected-app requests use WalletConnectService's existing policy/review route.
        if (saved.operationId.startsWith('wc_')) throw new Error('walletconnect_recovery_requires_governance');
        return withBiometricAction(translate('walletRecovery.approve', 'Approve recovery of the saved transaction'), async action => {
            const wallet = new ActionWallet(await SeedManager.getEVMPrivateKey(action), action, this.getProvider(saved.chainId));
            const result = await wallet.recoverOperation(saved.operationId);
            if (result.hash !== saved.hash) throw new Error('nonce_recovery_hash_changed');
            return result.hash;
        });
    }

    /**
     * Estimate the gas cost of a send in ETH.
     * Returns a human-readable string like "~0.000012 ETH".
     *
     * For a bare native (ETH) transfer, the 21,000-gas constant is exact. For an
     * ERC-20 or contract call, pass `{ to, data }` so the node prices the REAL
     * gas — a token `transfer` costs ~45k-70k, so the native 21k constant would
     * under-report the fee by 2-3x. When the node refuses to simulate (e.g. the
     * probe has insufficient balance), we fall back to a conservative ERC-20
     * default (65k) rather than the misleadingly-low native figure.
     */
    async estimateFee(
        chainId: number = 8453,
        tx?: { to?: string; data?: string; value?: bigint },
    ): Promise<string> {
        const provider = this.getProvider(chainId);
        const feeData = await provider.getFeeData();
        const maxFee = feeData.maxFeePerGas || 100_000_000n;

        let gas = 21_000n; // bare native EOA transfer
        if (tx?.data && tx.data !== '0x') {
            try {
                gas = await provider.estimateGas({
                    to: tx.to,
                    data: tx.data,
                    value: tx.value ?? 0n,
                });
            } catch {
                gas = 65_000n; // conservative ERC-20 fallback (not native 21k)
            }
        }
        const estimated = maxFee * gas;
        return `~${ethers.formatEther(estimated)} ETH`;
    }
}

export default TransactionService.getInstance();
