import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * SwapEngine - Consolidated swap service for multi-chain token swaps.
 * [Fix 9A] Merged SwapService.ts functionality into single canonical service.
 * [Fix 9B] Uses BigInt arithmetic to avoid floating-point precision loss.
 * [Fix 9C] Proper PE typing (no `as any`).
 * [Fix 9D] Per-chain router addresses.
 * [Fix 9E] Quote expiry cleanup.
 */

import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import ProvenanceEnvelopeManager, { EnvelopeContext } from '../provenance/ProvenanceEnvelopeManager';
import { assertWalletEnabled } from '../AppModeManager';
export interface AssetDescriptor {
    chainId: number;
    address: string;
    symbol: string;
    decimals: number;
}
import SimulationEngine from '../simulation/SimulationEngine';
import ProxyConfig from '../../services/ProxyConfig';
import {
    SwapRouteRefusedError,
    assertGenuineZeroXSettler,
    assertZeroXExecutionMatches,
    assertZeroXSpender,
    decodeZeroXAllowanceHolderTx,
} from './evmSwapGuard';
import { translate } from '../../i18n/translate';

// ============================================================================
// Types
// ============================================================================

// Same-chain 0x swaps run on the EVM L2s. Solana swaps route through
// CrossChainSwapEngine (Jupiter for Solana⇄Solana, LI.FI for cross-chain), not
// this 0x engine — but 'Solana' is part of the union so the swap UI can select
// it and the facade can route on it.
export type ChainType = 'Base' | 'Arbitrum' | 'Optimism' | 'Solana';

export interface SwapQuoteRequest {
    fromAsset: AssetDescriptor;
    toAsset: AssetDescriptor;
    amountIn: string;
    slippageTolerance: number; // Percentage (e.g., 0.5 for 0.5%)
    account: string;
}

/**
 * A cost the swap route charges that is NOT Provian's fee, shown under its own
 * name: 0x's own fee, LI.FI's own fee, a bridge's fees, or a Solana account-rent
 * deposit the route requires.
 */
export interface SwapCost {
    kind: 'zerox' | 'lifi' | 'bridge' | 'rent';
    /** Token amount in display units, when known. */
    amount?: string;
    /** Symbol of `amount`. */
    token?: string;
    /** USD value, when the route reports one. */
    usd?: number;
}

export interface SwapQuoteResult {
    quoteId: string;
    provider: string;
    amountOut: string;
    priceImpact: number;
    fee: string;              // Network fee amount (in feeToken), or a "$x.xx" string when only USD is known
    feeUsd: number;
    feeToken?: string;        // Native token the network fee is paid in (ETH / SOL)
    provianFee: string;       // Provian's 0.25% fee as charged, in provianFeeToken units
    provianFeeToken: string;  // Token the Provian fee is taken in
    provianFeeUsd: number;    // Fee in USD (stablecoin fee tokens only; 0 = unknown)
    otherFees?: SwapCost[];   // The route's own fees (0x / LI.FI / bridge), each under its true name
    netToAmount: string;      // What the user receives (estimate), after every fee
    route: string[];
    guaranteedAmount: string;
    /** The slippage (percent) this quote was requested at and whose floor its minimum meets. */
    slippagePercent?: number;
    expiresAt: number;
    isMock?: boolean;         // True when real DEX API was unavailable - TX will fail if submitted
    // Extended fields from SwapService
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    rate: number;
    estimatedGas: string;
    chainId: number;
}

export interface SwapExecutionRequest {
    quoteId: string;
    account: string;
}

export interface PreparedSwapTx {
    to: string;
    data: string;
    value: string;
    chainId: number;
    gasLimit: string;
}

export interface SwapResult {
    success: boolean;
    transactionHash?: string;
    error?: string;
    fromAmount: string;
    toAmount: string;
    fromToken: string;
    toToken: string;
    // [N3] Swap confirmed on-chain but its Provenance Envelope could not be
    // created (createEnvelope threw); it was durably queued for reconciliation.
    // The caller surfaces a "record pending" note instead of a clean success.
    peDeferred?: boolean;
    // [] Nothing was broadcast: the quote re-fetched after the approval confirmed
    // guarantees less than the minimum the user reviewed. `freshQuote` is that new quote, to be
    // shown again for a fresh review. The approval that was granted stays in place.
    requoteRequired?: boolean;
    freshQuote?: SwapQuoteResult;
}

// [Fix 9K] Fee comparison types for multi-aggregator comparison
export interface FeeComparison {
    provider: string;
    amountOut: string;
    priceImpact: number;
    networkFee: string;
    networkFeeUsd: number;
    protocolFee: string;
    protocolFeeUsd: number;
    totalFeeUsd: number;
    estimatedTimeSeconds: number;
    route: string[];
    score: number; // 0-100, higher is better (factors in output, fees, speed)
}

export interface FeeComparisonResult {
    fromToken: string;
    toToken: string;
    fromAmount: string;
    comparisons: FeeComparison[];
    bestProvider: string;
    generatedAt: number;
}

// ============================================================================
// Configuration
// ============================================================================

// [Fix 9D] Per-chain Uniswap Universal Router addresses
const SWAP_ROUTERS: Record<number, string> = {
    8453: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',   // Base
    42161: '0x5E325eDA8064b456f4781070C0738d849c824258',  // Arbitrum One
    10: '0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8',     // Optimism
    // Testnets
    11155111: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', // Sepolia
    84532: '0x050E797f3625EC8785265e1d9BDd4799b97528A1',    // Base Sepolia
    421614: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2',   // Arb Sepolia
    11155420: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2', // OP Sepolia
};

// [Fix 9A] Token addresses - fixed DAI typo (was ...EescdeCB... with invalid 's')
const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
    Base: {
        ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    },
    Arbitrum: {
        ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    },
    Optimism: {
        ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        OP: '0x4200000000000000000000000000000000000042',
        DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    },
};

const CHAIN_IDS: Record<string, number> = {
    Base: 8453,
    Arbitrum: 42161,
    Optimism: 10,
};

const TOKEN_DECIMALS: Record<string, number> = {
    ETH: 18,
    WETH: 18,
    USDC: 6,
    USDT: 6,
    DAI: 18,
    ARB: 18,
    OP: 18,
};

// API endpoints for DEX aggregators.
// 0x v1 was deprecated in early 2025; the client uses v2 via the backend proxy.
// v2 endpoints live under /swap/permit2/ (ERC-20 sells) or /swap/allowance-holder/.
// DEX APIs - 0x v2 is proxied through the backend; no client-side endpoints needed.
// This engine handles SAME-CHAIN EVM swaps only. Solana⇄Solana (Jupiter) and
// Solana⇄EVM (LI.FI) swaps route through CrossChainSwapEngine, not here. The
// relay sets Provian's 0.25% fee on every route (routes/swap-proxy.ts).

// API keys are now proxied through the backend - no client-side keys needed

// ============================================================================
// SwapEngine Class
// ============================================================================

class SwapEngine {
    private static instance: SwapEngine;
    private quotes: Map<string, SwapQuoteResult> = new Map();
    // Cached on-chain execution data for each quote.
    //   to       - the contract to call (the 0x v2 settler)
    //   data     - execution-ready calldata (no EIP-712 sig needed for allowance-holder flow)
    //   value    - wei to send with the tx (non-zero only when sellToken is native ETH)
    //   spender  - the address that needs ERC-20 allowance from the user (sellToken approval target)
    //   gas      - recommended gas limit from 0x
    //   minBuyAtomic - the minimum the Settler call guarantees: what the review shows
    //   slippage - the slippage (percent) the quote was fetched with; a re-quote reuses it
    private callDataCache: Map<string, {
        to: string;
        data: string;
        value: string;
        spender: string;
        gas: string;
        minBuyAtomic: bigint;
        slippage: number;
    }> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    private constructor() {
        // [Fix 9E] Start quote expiry cleanup
        this.startQuoteCleanup();
    }

    static getInstance(): SwapEngine {
        if (!SwapEngine.instance) {
            SwapEngine.instance = new SwapEngine();
        }
        return SwapEngine.instance;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    isSwapSupported(chain: ChainType): boolean {
        // Solana is swappable via CrossChainSwapEngine (Jupiter same-chain,
        // LI.FI cross-chain); the EVM L2s via 0x. All four are supported at the UI level.
        return ['Base', 'Arbitrum', 'Optimism', 'Solana'].includes(chain);
    }

    getUnsupportedReason(_chain: ChainType): string {
        return 'Swaps not supported on this chain';
    }

    getSwappableTokens(chain: ChainType): string[] {
        const tokens = TOKEN_ADDRESSES[chain];
        return tokens ? Object.keys(tokens) : [];
    }

    getPopularPairs(chain: ChainType): Array<{ from: string; to: string }> {
        switch (chain) {
            case 'Base':
            case 'Arbitrum':
            case 'Optimism':
                // USDT is intentionally absent: it has no entry in
                // TOKEN_ADDRESSES on any chain, so any USDT leg fails to quote
                // (review #23). DAI is a real, addressable pair on all 3 chains.
                return [
                    { from: 'ETH', to: 'USDC' },
                    { from: 'USDC', to: 'ETH' },
                    { from: 'ETH', to: 'DAI' },
                    { from: 'USDC', to: 'DAI' },
                ];
            default:
                return [];
        }
    }

    /**
     * Get a live 0x swap quote for a SAME-CHAIN EVM pair, or null. Never a mock.
     * [Fix 9B] Uses BigInt for precise amount handling.
     *
     * [] `toChain` is the chain the user picked the destination token on, and it is
     * required: 0x swaps within one chain, and it resolves the buy token by symbol on `chain`,
     * so a destination on any other chain (or a call that does not name one) is refused here
     * rather than quoted — and executed — as the same symbol on the source chain.
     */
    async getQuote(
        chain: ChainType,
        fromToken: string,
        toToken: string,
        amount: string,
        slippageTolerance: number,
        takerAddress: string | undefined,
        toChain: ChainType,
    ): Promise<SwapQuoteResult | null> {
        if (!this.isSwapSupported(chain)) {
            return null;
        }
        if (toChain !== chain) {
            console.warn(`[SwapEngine] Refused a ${chain} → ${String(toChain)} pair: 0x swaps within one chain only`);
            return null;
        }

        try {
            return await this.getEVMQuote(chain, fromToken, toToken, amount, slippageTolerance, takerAddress);
        } catch (error) {
            console.error('[SwapEngine] Quote error:', error);
            return null;
        }
    }

    /**
     * Get quote using AssetDescriptor interface (for integration with ChainRegistry).
     */
    async getSwapQuote(request: SwapQuoteRequest, biometricAction?: BiometricAction): Promise<SwapQuoteResult> {
        const chainName = this.chainIdToName(request.fromAsset.chainId);
        // [] 0x is same-chain only: a destination on another chain is never quoted here.
        if (request.toAsset.chainId !== request.fromAsset.chainId) {
            throw new Error(`Cross-chain pair ${request.fromAsset.chainId} → ${request.toAsset.chainId} is not a 0x swap`);
        }
        const quote = await this.getQuote(
            chainName,
            request.fromAsset.symbol,
            request.toAsset.symbol,
            request.amountIn,
            request.slippageTolerance,
            undefined,
            chainName,
        );

        if (!quote) {
            throw new Error(`Failed to get quote for ${request.fromAsset.symbol} -> ${request.toAsset.symbol}`);
        }

        // [Fix 9C] Proper PE typing
        const peInput: EnvelopeContext = {
            actionType: 'swap',
            intentText: `Swap Quote: ${request.amountIn} ${request.fromAsset.symbol} -> ${quote.amountOut} ${request.toAsset.symbol}`,
            assetSymbol: request.fromAsset.symbol,
            amount: request.amountIn,
            chainId: request.fromAsset.chainId,
            riskScore: 0,
            riskCategory: 'low',
            policyDecision: 'allow',
        };
        await ProvenanceEnvelopeManager.createEnvelope(peInput, biometricAction);

        return quote;
    }

    /**
     * Build swap transaction for signing.
     * [Fix 9D] Uses per-chain router addresses.
     */
    async buildSwapTransaction(request: SwapExecutionRequest, biometricAction?: BiometricAction): Promise<PreparedSwapTx> {
        const quote = this.quotes.get(request.quoteId);
        if (!quote) throw new Error('Quote expired or not found');

        // Check expiry
        if (Date.now() > quote.expiresAt) {
            this.quotes.delete(request.quoteId);
            throw new Error('Quote has expired');
        }

        // Use cached calldata from 0x response if available, otherwise fall back to router
        const cached = this.callDataCache.get(request.quoteId);
        const targetAddress = cached?.to || SWAP_ROUTERS[quote.chainId];
        if (!targetAddress) {
            throw new Error(`No router configured for chain ${quote.chainId}`);
        }

        const tx: PreparedSwapTx = {
            to: targetAddress,
            data: this.buildSwapCallData(quote),
            value: quote.fromToken === 'ETH' ? ethers.parseEther(quote.fromAmount).toString() : '0',
            chainId: quote.chainId,
            gasLimit: quote.estimatedGas || '250000',
        };

        // Simulate transaction
        const simResult = await SimulationEngine.simulateTransaction({
            from: request.account,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chainId: tx.chainId,
        });

        // [Fix 9C] Proper PE typing
        const peInput: EnvelopeContext = {
            actionType: 'swap',
            intentText: `Executing Swap: ${quote.fromAmount} ${quote.fromToken} -> ${quote.toAmount} ${quote.toToken} via ${quote.provider}`,
            assetSymbol: quote.fromToken,
            amount: quote.fromAmount,
            chainId: tx.chainId,
            contract: tx.to,
            riskScore: simResult.riskFactors.length * 10,
            riskCategory: simResult.riskFactors.length > 0 ? 'medium' : 'low',
            policyDecision: 'allow',
        };
        await ProvenanceEnvelopeManager.createEnvelope(peInput, biometricAction);

        return tx;
    }

    /**
     * Execute a real on-chain swap.
     *
     * Replaces the prior `setTimeout + UUID hash` stub. Uses the same signing
     * primitives as TransactionService.sendETH (BIP-44 derived secp256k1 EOA
     * key from SeedManager). Two on-chain steps for ERC-20 inputs:
     *   1. Approve the 0x allowance-holder spender for max uint256 if the
     *      current allowance is < sellAmount. Skipped for native ETH input.
     *   2. Send the swap transaction with the cached calldata, value, and gas
     *      from the 0x v2 quote response. Wait for the receipt and verify
     *      success before returning.
     *
     * For native ETH input the value is non-zero and no approval is needed.
     * For ERC-20 input the value is 0; the settler pulls funds via the prior
     * approval.
     *
     * The Provenance Envelope is created AFTER the broadcast succeeds with the
     * real on-chain tx hash, not before. Refusing to write a PE for a tx that
     * hasn't actually happened is a security invariant - historically the
     * stub was logging fake PEs that polluted the chain.
     */
    async executeSwap(
        quote: SwapQuoteResult,
        walletAddress: string,
        chain: ChainType, biometricAction?: BiometricAction
    ): Promise<SwapResult> {
        // [WALLET LOCKOUT] Block wallet operations when wallet is disabled
        assertWalletEnabled('executeSwap');

        const baseResult = {
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            fromToken: quote.fromToken,
            toToken: quote.toToken,
        };

        if (!walletAddress || walletAddress === '0x0000000000000000000000000000000000000000') {
            return { success: false, error: 'Invalid wallet address', ...baseResult };
        }

        if (quote.isMock) {
            return {
                success: false,
                error: 'Cannot execute a mock quote - live DEX API was unavailable when the quote was fetched.',
                ...baseResult,
            };
        }

        const cached = this.callDataCache.get(quote.quoteId);
        if (!cached) {
            return {
                success: false,
                error: 'Quote expired or has no execution data. Please refresh and try again.',
                ...baseResult,
            };
        }

        // Quote has a 60-second expiry; refuse to send stale calldata.
        if (Date.now() > quote.expiresAt) {
            this.quotes.delete(quote.quoteId);
            this.callDataCache.delete(quote.quoteId);
            return { success: false, error: 'Quote has expired. Please request a new quote.', ...baseResult };
        }

        const chainId = CHAIN_IDS[chain];
        if (!chainId) {
            return { success: false, error: `Unsupported EVM chain: ${chain}`, ...baseResult };
        }
        // [] The quote was fetched for exactly one chain; it is executed on that chain only.
        const recorded = this.quotes.get(quote.quoteId);
        if (!recorded || recorded.chainId !== chainId) {
            return { success: false, error: `This quote was not fetched for ${chain}. Nothing was signed.`, ...baseResult };
        }

        // [Audit #32/#33] Track ERC-20 allowances we grant during this swap so any
        // ABORT / REVERT path can revoke the orphaned (never-consumed) allowance
        // instead of leaving a standing approval to a 0x settler. Hoisted so the
        // outer catch can also clean up. `signer` is hoisted for the same reason.
        let signer: ethers.Wallet | null = null;
        let approvedTokenAddress: string | null = null;
        const approvedSpenders: string[] = [];

        try {
            return await withBiometricAction(translate('swap.approveSwapBiometric', 'Approve swap'), async (biometricAction) => {

                // Resolve the chain RPC URL from the EVM config.
                const chainConfig = await this.getEVMChainConfig(chainId);
                if (!chainConfig) {
                    return { success: false, error: `No RPC configured for chain ${chainId}`, ...baseResult };
                }
                const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);

                // [] Nothing is signed until the route is known: AllowanceHolder → a Settler
                // 0x's own registry names, pulling exactly the reviewed sell amount of the reviewed
                // token and paying this wallet at least the reviewed minimum. Checked before the
                // biometric prompt and before the key is read.
                const sellToken = quote.fromToken === 'ETH' ? 'native' : TOKEN_ADDRESSES[chain]?.[quote.fromToken];
                const buyToken = quote.toToken === 'ETH' ? 'native' : TOKEN_ADDRESSES[chain]?.[quote.toToken];
                if (!sellToken || !buyToken) {
                    return { success: false, error: `No address known for ${quote.fromToken}/${quote.toToken} on ${chain}`, ...baseResult };
                }
                const sellAmount = this.parseAmount(quote.fromAmount, this.getDecimals(quote.fromToken));
                const verifyRoute = async (route: { to: string; data: string; value: string; spender: string }): Promise<bigint> => {
                    const exec = decodeZeroXAllowanceHolderTx(chainId, route);
                    assertZeroXExecutionMatches(exec, {
                        sellToken, sellAmount, buyToken, recipient: walletAddress, value: BigInt(route.value),
                    });
                    if (sellToken !== 'native') assertZeroXSpender(chainId, route.spender);
                    await assertGenuineZeroXSettler(exec.settler, (tx) => provider.call(tx));
                    return exec.minAmountOut;
                };
                try {
                    const enforced = await verifyRoute(cached);
                    if (enforced < cached.minBuyAtomic) {
                        throw new SwapRouteRefusedError('zerox_below_reviewed_minimum', 'swap transaction enforces less than the minimum reviewed');
                    }
                } catch (routeErr) {
                    if (routeErr instanceof SwapRouteRefusedError) {
                        console.warn(`[SwapEngine] Swap route refused (${routeErr.code}): ${routeErr.message}`);
                        return { success: false, error: `Swap refused: ${routeErr.message}. Nothing was signed.`, ...baseResult };
                    }
                    throw routeErr;
                }

                // Lazy import to avoid bundling SeedManager into modules that don't need it.
                const { default: SeedManager } = await import('../wallet/SeedManager');
                // [Group 1 / M-2] Establish biometric session before reading seed.
                assertBiometricAction(biometricAction);
                const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);

                signer = new ActionWallet(privateKey, biometricAction, provider);

                // Step 1: Ensure ERC-20 allowance for ERC-20 inputs. Native ETH skips this.
                // Tracks whether we needed to send an approval - used below to decide
                // whether the cached calldata is still safe to use as-is or if we need
                // to refresh the quote to avoid the slippage race.
                let approvalSent = false;
                if (sellToken !== 'native') {
                    const tokenAddress = sellToken;

                    const erc20Iface = new ethers.Interface([
                        'function allowance(address owner, address spender) view returns (uint256)',
                        'function approve(address spender, uint256 amount) returns (bool)',
                    ]);
                    const tokenContract = new ethers.Contract(tokenAddress, erc20Iface, signer);

                    // cached.spender is this chain's 0x AllowanceHolder (verified above).
                    const currentAllowance: bigint = await tokenContract.allowance(walletAddress, cached.spender);
                    if (currentAllowance < sellAmount) {
                        // Chunk-J J-24: Use exact sell-amount approval instead of
                        // ethers.MaxUint256 so a failed swap doesn't leave a permanent
                        // infinite approval to the 0x spender. [Audit #32/#33] The
                        // exact-amount approval is consumed ONLY by a SUCCESSFUL swap;
                        // it does NOT "self-clear" on an aborted/reverted swap (the
                        // swap never pulls the tokens), so every abort/revert path
                        // below explicitly revokes it via revokeAllowance() — except a
                        // re-quote shown for review, which keeps it for the next attempt.
                        console.log(`[SwapEngine] Approving ${quote.fromToken} (exact ${sellAmount}) → spender ${cached.spender.slice(0, 10)}…`);
                        const approveTx = await tokenContract.approve(cached.spender, sellAmount);
                        const approveReceipt = await approveTx.wait();
                        if (!approveReceipt || approveReceipt.status === 0) {
                            return {
                                success: false,
                                error: 'Token approval transaction reverted on-chain.',
                                ...baseResult,
                            };
                        }
                        approvalSent = true;
                        // Record the standing allowance so an abort/revert can revoke it.
                        approvedTokenAddress = tokenAddress;
                        approvedSpenders.push(cached.spender);
                        console.log(`[SwapEngine] Approval confirmed: ${approveReceipt.hash}`);
                    }
                }

                // [SLIPPAGE RACE FIX] If we just sent an approval, several seconds
                // have passed since the original quote was fetched and the price
                // has likely moved. The cached calldata is block-pinned and would
                // revert on slippage. Re-fetch a fresh quote so the swap reflects
                // current market state. Always done for ERC-20 inputs that needed
                // approval; native ETH inputs and pre-approved ERC-20 swaps reuse
                // the original cached calldata directly.
                let execTo = cached.to;
                let execData = cached.data;
                let execValue = cached.value;
                let execGas = cached.gas;
                if (approvalSent) {
                    console.log('[SwapEngine] Refreshing quote post-approval to avoid slippage race...');
                    // [] The re-quote uses the slippage the user reviewed, never a fixed one.
                    const fresh = await this.getEVMQuote(
                        chain,
                        quote.fromToken,
                        quote.toToken,
                        quote.fromAmount,
                        cached.slippage,
                        walletAddress,
                    );
                    if (!fresh || fresh.isMock) {
                        // [Audit #33] The swap never ran, so the exact-amount approval
                        // we just granted is NOT consumed and does NOT self-clear.
                        // Revoke it before returning rather than leave a standing
                        // allowance to the 0x settler.
                        await this.revokeApprovedAllowances(signer, approvedTokenAddress, approvedSpenders);
                        return {
                            success: false,
                            error: 'Approval succeeded but failed to refresh quote post-approval. Your approval was rolled back; please try the swap again.',
                            ...baseResult,
                        };
                    }
                    const freshCached = this.callDataCache.get(fresh.quoteId);
                    if (!freshCached) {
                        // [Audit #33] Same orphaned-approval cleanup as above.
                        await this.revokeApprovedAllowances(signer, approvedTokenAddress, approvedSpenders);
                        return {
                            success: false,
                            error: 'Approval succeeded but the refreshed quote had no execution data. Your approval was rolled back.',
                            ...baseResult,
                        };
                    }

                    // [] The fresh route passes the same checks as the reviewed one. Its
                    // spender is the same AllowanceHolder the approval went to (both are pinned), so
                    // the approval just granted is the one it spends.
                    let freshMin: bigint;
                    try {
                        freshMin = await verifyRoute(freshCached);
                    } catch (routeErr) {
                        await this.revokeApprovedAllowances(signer, approvedTokenAddress, approvedSpenders);
                        if (routeErr instanceof SwapRouteRefusedError) {
                            console.warn(`[SwapEngine] Refreshed swap route refused (${routeErr.code}): ${routeErr.message}`);
                            return {
                                success: false,
                                error: `Swap refused: ${routeErr.message}. Nothing was swapped; your approval was rolled back.`,
                                ...baseResult,
                            };
                        }
                        throw routeErr;
                    }

                    // [] Never sign a re-quote worse than what the user reviewed. A fresh
                    // minimum below the reviewed minimum is not broadcast: the fresh quote goes back
                    // to the screen for a new review. The exact-amount approval to AllowanceHolder
                    // stays: only an exec this wallet sends itself can spend it, and it lets the
                    // re-reviewed swap run without a second approval (and so without a second
                    // re-quote race).
                    if (freshMin < cached.minBuyAtomic) {
                        console.warn(`[SwapEngine] Re-quote guarantees ${freshMin} < reviewed ${cached.minBuyAtomic}; not broadcasting`);
                        this.quotes.delete(quote.quoteId);
                        this.callDataCache.delete(quote.quoteId);
                        return {
                            success: false,
                            requoteRequired: true,
                            freshQuote: fresh,
                            error: 'The price moved while your approval confirmed. Nothing was swapped. Review the new quote to continue.',
                            ...baseResult,
                        };
                    }

                    execTo = freshCached.to;
                    execData = freshCached.data;
                    execValue = freshCached.value;
                    execGas = freshCached.gas;
                }

                // Step 2: Send the swap transaction.
                console.log(`[SwapEngine] Broadcasting swap: ${quote.fromAmount} ${quote.fromToken} → ${quote.toAmount} ${quote.toToken} via ${execTo.slice(0, 10)}…`);
                const swapTx = await signer.sendTransaction({
                    to: execTo,
                    data: execData,
                    value: BigInt(execValue),
                    gasLimit: BigInt(execGas),
                });
                console.log(`[SwapEngine] Swap tx broadcast: ${swapTx.hash}`);

                const swapReceipt = await swapTx.wait();
                if (!swapReceipt || swapReceipt.status === 0) {
                    // [Audit #32] A reverted swap consumes NO allowance, so any
                    // allowance we granted this call is orphaned. Revoke it.
                    await this.revokeApprovedAllowances(signer, approvedTokenAddress, approvedSpenders);
                    return {
                        success: false,
                        error: `Swap reverted on-chain. Tx: ${swapTx.hash}`,
                        transactionHash: swapTx.hash,
                        ...baseResult,
                    };
                }
                console.log(`[SwapEngine] Swap confirmed in block ${swapReceipt.blockNumber}`);

                // Quote is now consumed - clear the cache.
                this.quotes.delete(quote.quoteId);
                this.callDataCache.delete(quote.quoteId);

                // Record the PE only AFTER on-chain success, with the real tx hash.
                // [N3] createEnvelope failing must NOT be silently swallowed: the swap
                // confirmed on-chain, so a swallowed PE leaves a confirmed action with
                // no provenance record. Durably queue the params for reconciliation
                // and flag the result degraded rather than reporting a clean success.
                let peDeferred = false;
                const peInput: EnvelopeContext = {
                    actionType: 'swap',
                    intentText: `Swap ${quote.fromAmount} ${quote.fromToken} for ${quote.toAmount} ${quote.toToken}`,
                    assetSymbol: quote.fromToken,
                    amount: quote.fromAmount,
                    chainId,
                    riskScore: 20,
                    riskCategory: 'low',
                    policyDecision: 'allow',
                    // the confirmed swap transaction. The relay re-reads it from
                    // the chain it ran on and mints the swap there.
                    txHash: swapReceipt.hash,
                };
                try {
                    await ProvenanceEnvelopeManager.createEnvelope(peInput, biometricAction);
                } catch (peErr) {
                    console.error('[SwapEngine] PE creation failed (swap confirmed) - deferring for reconciliation:', peErr);
                    await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(peInput).catch((qErr) => {
                        console.error('[SwapEngine] Failed to queue deferred PE:', qErr);
                    });
                    peDeferred = true;
                }

                return {
                    success: true,
                    transactionHash: swapReceipt.hash,
                    ...(peDeferred && { peDeferred: true }),
                    ...baseResult,
                };

            }, biometricAction);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[SwapEngine] executeSwap failed:', err);
            // [Audit #32/#33] A throw during execution (RPC error, biometric
            // cancel after an approve, etc.) can leave allowances we granted
            // standing. Best-effort revoke any we tracked.
            if (signer && approvedSpenders.length > 0) {
                await this.revokeApprovedAllowances(signer, approvedTokenAddress, approvedSpenders);
            }
            return { success: false, error: message, ...baseResult };
        }
    }

    /**
     * [Audit #32/#33] Best-effort revoke of every ERC-20 allowance granted during
     * a swap that aborted or reverted. Never throws — a failed revoke leaves a
     * bounded, exact-amount allowance the caller was told about, and a retried
     * swap consumes it or the user can revoke manually.
     */
    private async revokeApprovedAllowances(
        signer: ethers.Wallet,
        tokenAddress: string | null,
        spenders: string[],
    ): Promise<void> {
        if (!tokenAddress || spenders.length === 0) return;
        // Copy so callers can safely mutate the source array.
        for (const spender of [...spenders]) {
            await this.revokeAllowance(signer, tokenAddress, spender);
        }
    }

    /** Best-effort `approve(spender, 0)`. Never throws. */
    private async revokeAllowance(
        signer: ethers.Wallet,
        tokenAddress: string,
        spender: string,
    ): Promise<void> {
        try {
            const iface = new ethers.Interface([
                'function approve(address spender, uint256 amount) returns (bool)',
            ]);
            const token = new ethers.Contract(tokenAddress, iface, signer);
            const tx = await token.approve(spender, 0n);
            await tx.wait();
            console.log(`[SwapEngine] Revoked orphaned allowance to spender ${spender.slice(0, 10)}…`);
        } catch (revokeErr) {
            console.warn(`[SwapEngine] Failed to revoke orphaned allowance to ${spender.slice(0, 10)}…:`, revokeErr);
        }
    }

    /**
     * Lazy lookup of EVM chain config (RPC URL etc.) without creating a hard
     * import dependency on the chains module at the top of the file.
     */
    private async getEVMChainConfig(chainId: number): Promise<{ rpcUrl: string; name: string } | null> {
        const { ALL_CHAINS } = await import('../chains/evm/config');
        const c = ALL_CHAINS.find((x: { chainId: number }) => x.chainId === chainId);
        return c ? { rpcUrl: c.rpcUrl, name: c.name } : null;
    }

    /**
     * Compare fees across multiple DEX aggregators.
     *
     * NOT YET IMPLEMENTED. The previous implementation returned hardcoded
     * Math.random() data for 4 fake providers, which misled users into
     * believing they had real quote comparisons. Throws explicitly so any
     * caller is forced to handle the unimplemented state instead of
     * silently rendering fake data.
     *
     * Real implementation would fetch quotes from 0x, 1inch, Paraswap,
     * and CowSwap in parallel via the backend proxy and rank them by
     * effective output (amountOut − totalFees).
     */
    async compareFees(
        _chain: ChainType,
        _fromToken: string,
        _toToken: string,
        _amount: string
    ): Promise<FeeComparisonResult> {
        throw new Error('compareFees is not yet implemented - no aggregator-comparison feature is wired up.');
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    /**
     * [Fix 9B] Parse amount to smallest unit using BigInt.
     */
    private parseAmount(amount: string, decimals: number): bigint {
        return ethers.parseUnits(amount, decimals);
    }

    /**
     * [Fix 9B] Format amount from smallest unit using BigInt.
     */
    private formatAmount(amountWei: string | bigint, decimals: number): string {
        return ethers.formatUnits(amountWei, decimals);
    }

    private getDecimals(symbol: string): number {
        return TOKEN_DECIMALS[symbol] || 18;
    }

    private chainIdToName(chainId: number): ChainType {
        const mapping: Record<number, ChainType> = {
            8453: 'Base',
            42161: 'Arbitrum',
            10: 'Optimism',
        };
        return mapping[chainId] || 'Base';
    }

    /**
     * Get EVM quote from 0x v2 API (allowance-holder flow). Any failure is no quote: the mock
     * fallback that once stood in for an unreachable API is gone, because a mock is a
     * price the user could read as live.
     *
     * Why allowance-holder and not permit2:
     * The permit2 flow requires the client to sign an EIP-712 typed-data
     * message and append the 65-byte signature to the calldata. The
     * allowance-holder flow uses a traditional ERC-20 approval pattern:
     * the user approves 0x's settler contract once per token, after which
     * the calldata returned by /quote is execution-ready as-is. Simpler
     * to implement correctly and harder to break.
     *
     * v2 differences from v1:
     * - Endpoint: /swap/allowance-holder/quote (was /swap/v1/quote)
     * - Required header: 0x-version: v2 (added by backend proxy)
     * - Required parameter: taker (the wallet that will execute the swap)
     * - Response: transaction.{to,data,gas,gasPrice,value} (was top-level)
     * - Response: route.fills[].source (was sources[].name)
     * - Response: no `price` field - derive rate from buyAmount/sellAmount
     * - Response: issues.allowance.{actual,spender} for ERC-20 inputs
     * - Native ETH is represented as 0xeeee...eeee (sentinel address)
     */
    private async getEVMQuote(
        chain: ChainType,
        fromToken: string,
        toToken: string,
        amount: string,
        slippageTolerance: number,
        takerAddress?: string,
    ): Promise<SwapQuoteResult | null> {
        const chainId = CHAIN_IDS[chain];
        const tokens = TOKEN_ADDRESSES[chain];

        if (!chainId || !tokens) return null;

        // 0x v2 represents native ETH as the sentinel 0xeeee...eeee, not the symbol "ETH".
        //
        // Chunk-J J-6: Previously this code fell through to the raw
        // `fromToken` string when a symbol wasn't in the canonical token
        // table, relying on 0x to reject the unknown token with an error.
        // That is not acceptable - 0x accepts arbitrary contract addresses,
        // and an attacker who can influence `fromToken`/`toToken` (e.g. via
        // a malicious asset list imported from an external source) could
        // steer the user into approving and swapping a fake/drainer token.
        // Enforce a strict whitelist: only the contracts in the canonical
        // TOKEN_ADDRESSES table for this chain are swappable.
        const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        let sellToken: string;
        if (fromToken === 'ETH') {
            sellToken = NATIVE_SENTINEL;
        } else if (tokens[fromToken]) {
            sellToken = tokens[fromToken];
        } else {
            console.warn(`[SwapEngine] Rejected non-canonical sell token "${fromToken}" on ${chain}`);
            return null;
        }
        let buyToken: string;
        if (toToken === 'ETH') {
            buyToken = NATIVE_SENTINEL;
        } else if (tokens[toToken]) {
            buyToken = tokens[toToken];
        } else {
            console.warn(`[SwapEngine] Rejected non-canonical buy token "${toToken}" on ${chain}`);
            return null;
        }

        const decimals = this.getDecimals(fromToken);
        const sellAmount = this.parseAmount(amount, decimals).toString();
        const slippageBps = Math.round(slippageTolerance * 100); // 0.5% → 50 bps

        // The taker is required by 0x v2. If the caller didn't provide one, we
        // can still get an indicative quote by passing the zero address - the
        // calldata won't be executable but the price/route info is still useful
        // for display. Real swaps must pass the actual wallet address.
        const taker = takerAddress || '0x0000000000000000000000000000000000000000';

        try {
            const params = new URLSearchParams({
                chainId: String(chainId),
                sellToken,
                buyToken,
                sellAmount,
                taker,
                slippageBps: String(slippageBps),
            });
            const proxyUrl = await ProxyConfig.getZeroXUrl(`allowance-holder/quote?${params.toString()}`);
            const proxyHeaders = await ProxyConfig.getProxyHeaders('GET', new URL(proxyUrl).pathname, undefined, 'zerox');

            const response = await fetch(proxyUrl, { headers: proxyHeaders });

            if (!response.ok) {
                let errBody = '';
                try { errBody = JSON.stringify(await response.json()).slice(0, 300); } catch { /* ignore */ }
                console.warn(`[SwapEngine] 0x v2 API returned ${response.status} (${errBody}); no quote`);
                return null; // never a mock price
            }

            const data = await response.json();

            if (data.liquidityAvailable === false) {
                console.warn('[SwapEngine] 0x v2: no liquidity available for this pair');
                return null; // never a mock price
            }

            // The relay sets Provian's 25 bps fee on this request and verifies 0x's
            // answer before returning it (provian_fee). A response without it did not
            // come through a fee-verifying relay: never show it as a live quote.
            const relayFee = data.provian_fee as { amount?: string; token?: string } | undefined;
            if (!relayFee || typeof relayFee.amount !== 'string' || !/^[0-9]+$/.test(relayFee.amount)) {
                console.warn('[SwapEngine] 0x quote carried no relay-verified Provian fee; not shown');
                return null; // never a mock price
            }

            const toDecimals = this.getDecimals(toToken);
            // 0x v2 `buyAmount` is already NET of every fee it takes (Provian's and
            // 0x's own), so it is exactly what the user receives.
            const buyAmountWei = BigInt(data.buyAmount);
            const sellAmountWei = BigInt(data.sellAmount);
            const provianFeeWei = BigInt(relayFee.amount);
            const zx = data.fees?.zeroExFee as { amount?: string; token?: string } | null | undefined;
            const otherFees: SwapCost[] = [];
            if (zx && typeof zx.amount === 'string' && /^[0-9]+$/.test(zx.amount) && BigInt(zx.amount) > 0n
                && (zx.token ?? '').toLowerCase() === buyToken.toLowerCase()) {
                otherFees.push({ kind: 'zerox', amount: this.formatAmount(BigInt(zx.amount), toDecimals), token: toToken });
            }
            const stable = ['USDC', 'USDT', 'DAI', 'USDC.e'].includes(toToken);
            const provianFeeDisplay = this.formatAmount(provianFeeWei, toDecimals);

            // Derive rate as toAmount/fromAmount in display units. v2 doesn't return a `price` field.
            const fromAmountFloat = parseFloat(this.formatAmount(sellAmountWei, decimals));
            const toAmountFloat = parseFloat(this.formatAmount(buyAmountWei, toDecimals));
            const rate = fromAmountFloat > 0 ? toAmountFloat / fromAmountFloat : 0;

            // Network fee comes from totalNetworkFee (in wei of the chain's native token)
            const networkFeeWei = data.totalNetworkFee ? BigInt(data.totalNetworkFee) : 0n;

            // Route extraction - v2's route.fills[].source replaces v1's sources[].name
            const route: string[] = Array.isArray(data.route?.fills)
                ? data.route.fills.map((f: { source?: string }) => f.source || 'Unknown')
                : ['Direct'];

            const tx = data.transaction || {};

            // [] The minimum shown is the one the transaction itself enforces: the Settler
            // call's minAmountOut. A route that is not a 0x AllowanceHolder → Settler call, or
            // whose enforced minimum is below the minimum 0x reports, is not a quote this wallet
            // can sign, so it is not shown at all (never as a mock: a mock looks like a price).
            if (typeof tx.to !== 'string' || typeof tx.data !== 'string') {
                console.warn('[SwapEngine] 0x quote carried no executable transaction; not shown');
                return null;
            }
            let enforcedMin: bigint;
            try {
                enforcedMin = decodeZeroXAllowanceHolderTx(chainId, { to: tx.to, data: tx.data }).minAmountOut;
                assertZeroXSpender(chainId, data.issues?.allowance?.spender || tx.to);
            } catch (e) {
                console.warn('[SwapEngine] 0x route refused at quote time:', e instanceof Error ? e.message : e);
                return null;
            }
            if (typeof data.minBuyAmount === 'string' && /^[0-9]+$/.test(data.minBuyAmount)
                && enforcedMin < BigInt(data.minBuyAmount)) {
                console.warn('[SwapEngine] 0x transaction enforces less than the minimum 0x reports; not shown');
                return null;
            }
            // [ round 2] The enforced minimum must also meet the slippage the user chose,
            // measured from the output this quote shows: floor(buyAmount × (10000 − bps) / 10000).
            // A relay can report any minBuyAmount; it cannot make this floor lower without also
            // lowering the output the review shows.
            if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
                console.warn('[SwapEngine] slippage out of range; not quoting');
                return null;
            }
            const slippageFloor = (buyAmountWei * BigInt(10_000 - slippageBps)) / 10_000n;
            if (enforcedMin < slippageFloor) {
                console.warn(`[SwapEngine] 0x transaction enforces ${enforcedMin}, below the ${slippageBps} bps floor ${slippageFloor}; not shown`);
                return null;
            }

            const quote: SwapQuoteResult = {
                quoteId: uuidv4(),
                provider: '0x',
                fromToken,
                toToken,
                fromAmount: amount,
                toAmount: this.formatAmount(buyAmountWei, toDecimals),
                amountOut: this.formatAmount(buyAmountWei, toDecimals),
                rate,
                priceImpact: 0, // v2 doesn't expose this directly; the UI derives it from USD values
                fee: this.formatAmount(networkFeeWei, 18),
                // The network fee is an ETH quantity; we have no USD oracle here.
                // Leave feeUsd at 0 (review #10) and let the UI render `fee` as an
                // ETH amount instead of mislabeling the ETH quantity as dollars.
                feeUsd: 0,
                feeToken: 'ETH',
                provianFee: provianFeeDisplay,
                provianFeeToken: toToken,
                provianFeeUsd: stable ? parseFloat(provianFeeDisplay) : 0,
                otherFees,
                netToAmount: this.formatAmount(buyAmountWei, toDecimals),
                estimatedGas: tx.gas || '250000',
                route,
                guaranteedAmount: this.formatAmount(enforcedMin, toDecimals),
                slippagePercent: slippageTolerance,
                expiresAt: Date.now() + 60000,
                chainId,
            };

            this.quotes.set(quote.quoteId, quote);

            // Cache execution-ready transaction data plus the spender address for
            // ERC-20 approval. For native ETH input the spender field is unused.
            // 0x's allowance-holder spender is returned in issues.allowance.spender;
            // for native ETH the issues object may not contain an allowance entry.
            this.callDataCache.set(quote.quoteId, {
                to: tx.to,
                data: tx.data,
                value: tx.value || '0',
                spender: data.issues?.allowance?.spender || tx.to,
                gas: tx.gas || '500000',
                minBuyAtomic: enforcedMin,
                slippage: slippageTolerance,
            });

            return quote;
        } catch (error) {
            console.error('[SwapEngine] 0x v2 API error:', error);
            return null; // never a mock price
        }
    }

    /**
     * Build swap call data from cached 0x response, or fallback placeholder for mock quotes.
     */
    private buildSwapCallData(quote: SwapQuoteResult): string {
        const cached = this.callDataCache.get(quote.quoteId);
        if (cached) {
            return cached.data;
        }

        console.warn('[SwapEngine] No cached calldata for quote, using placeholder');
        return '0x';
    }

    /**
     * [Fix 9E] Start periodic cleanup of expired quotes.
     */
    private startQuoteCleanup(): void {
        // Run cleanup every 30 seconds
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [quoteId, quote] of this.quotes.entries()) {
                if (now > quote.expiresAt) {
                    this.quotes.delete(quoteId);
                    this.callDataCache.delete(quoteId);
                }
            }
        }, 30000);
    }

    /**
     * Stop quote cleanup (for testing).
     */
    stopQuoteCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

export default SwapEngine.getInstance();
