import { type BiometricAction } from '../security/biometricAction';
/**
 * SwapService - DEPRECATED: Use SwapEngine instead.
 * [Fix 9A] This file now re-exports from SwapEngine for backwards compatibility.
 * All new code should import from SwapEngine directly.
 *
 * @deprecated Use SwapEngine from './SwapEngine' instead
 */

import type { SolanaCostSummary } from './solanaCosts';
import SwapEngine, {
    SwapQuoteResult,
    SwapResult,
    ChainType,
    SwapCost,
} from './SwapEngine';

// Re-export types with legacy names for backwards compatibility
export interface SwapQuote {
    id: string;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    rate: number;
    priceImpact: number;
    fee: string;
    feeUsd: number;
    /** Native token the network fee is paid in (ETH / SOL). Absent when only USD is known. */
    feeToken?: string;
    /** Provian's 0.25% fee exactly as charged, in `provianFeeToken` units. */
    provianFee: string;
    provianFeeToken: string;
    provianFeeUsd: number;
    /** The route's own fees (0x / LI.FI / bridge), each shown under its true name. */
    otherFees?: SwapCost[];
    /** What the user receives (estimate) after every fee. */
    netToAmount: string;
    estimatedGas: string;
    route: string[];
    provider: string;
    validUntil: number;
    /** Worst-case amount out after slippage (0x minBuyAmount). For display. */
    guaranteedAmount?: string;
    /** The slippage (percent) the quote was requested at — the one the review shows. */
    slippagePercent?: number;
    isMock?: boolean;
    /** The SOL a swap starting on Solana needs, each cost by name (CrossChainSwapEngine). */
    solanaCosts?: SolanaCostSummary;
    /**
     * True when this quote executes in CrossChainSwapEngine: any swap with a Solana
     * leg (Jupiter for Solana⇄Solana, LI.FI for Solana⇄EVM).
     */
    crossChain?: boolean;
}

export { SwapResult };

/**
 * [] SwapEngine.executeSwap refuses to broadcast a re-quote worse than the quote the user
 * reviewed; it hands the fresh quote back instead, here in the screen's own quote shape.
 */
export type SwapServiceResult = Omit<SwapResult, 'freshQuote'> & { freshQuote?: SwapQuote };

/** Convert an engine quote to the legacy SwapQuote shape the screen uses. */
function toSwapQuote(result: SwapQuoteResult): SwapQuote {
    return {
        id: result.quoteId,
        fromToken: result.fromToken,
        toToken: result.toToken,
        fromAmount: result.fromAmount,
        toAmount: result.toAmount,
        rate: result.rate,
        priceImpact: result.priceImpact,
        fee: result.fee,
        feeUsd: result.feeUsd,
        feeToken: result.feeToken,
        provianFee: result.provianFee,
        provianFeeToken: result.provianFeeToken,
        provianFeeUsd: result.provianFeeUsd,
        otherFees: result.otherFees,
        netToAmount: result.netToAmount,
        estimatedGas: result.estimatedGas,
        route: result.route,
        provider: result.provider,
        validUntil: result.expiresAt,
        guaranteedAmount: result.guaranteedAmount,
        slippagePercent: result.slippagePercent,
        // WS6: propagate the mock flag. Dropping it made SwapScreen show
        // fallback mock rates as a live quote (the "estimated rates only"
        // banner and pre-execute mock guard never fired).
        isMock: result.isMock,
    };
}

/**
 * @deprecated Use SwapEngine instead
 */
class SwapService {
    private static instance: SwapService;

    private constructor() {}

    static getInstance(): SwapService {
        if (!SwapService.instance) {
            SwapService.instance = new SwapService();
        }
        return SwapService.instance;
    }

    isSwapSupported(chain: ChainType): boolean {
        return SwapEngine.isSwapSupported(chain);
    }

    getUnsupportedReason(chain: ChainType): string {
        return SwapEngine.getUnsupportedReason(chain);
    }

    /**
     * A live same-chain 0x quote, or null. [] `toChain` the chain the destination token
     * was picked on — is required: a pair across chains is never a 0x swap, and a mock is never
     * returned as a price.
     */
    async getQuote(
        chain: ChainType,
        fromToken: string,
        toToken: string,
        amount: string,
        slippageTolerance: number,
        takerAddress: string | undefined,
        toChain: ChainType,
    ): Promise<SwapQuote | null> {
        const result = await SwapEngine.getQuote(chain, fromToken, toToken, amount, slippageTolerance, takerAddress, toChain);
        return result && !result.isMock ? toSwapQuote(result) : null;
    }

    async executeSwap(
        quote: SwapQuote,
        walletAddress: string,
        chain: ChainType, biometricAction?: BiometricAction
    ): Promise<SwapServiceResult> {
        const { freshQuote, ...rest } = await this.executeEngineSwap(quote, walletAddress, chain, biometricAction);
        return freshQuote ? { ...rest, freshQuote: toSwapQuote(freshQuote) } : rest;
    }

    private async executeEngineSwap(
        quote: SwapQuote,
        walletAddress: string,
        chain: ChainType, biometricAction?: BiometricAction
    ): Promise<SwapResult> {
        // Convert legacy SwapQuote to SwapQuoteResult. The engine reads the reviewed minimum
        // and slippage from its own record of this quote id, never from these fields.
        const engineQuote: SwapQuoteResult = {
            quoteId: quote.id,
            provider: quote.provider,
            amountOut: quote.toAmount,
            priceImpact: quote.priceImpact,
            fee: quote.fee,
            feeUsd: quote.feeUsd,
            provianFee: quote.provianFee,
            provianFeeToken: quote.provianFeeToken,
            provianFeeUsd: quote.provianFeeUsd,
            netToAmount: quote.netToAmount,
            route: quote.route,
            guaranteedAmount: quote.guaranteedAmount ?? quote.toAmount,
            expiresAt: quote.validUntil,
            fromToken: quote.fromToken,
            toToken: quote.toToken,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            rate: quote.rate,
            estimatedGas: quote.estimatedGas,
            chainId: 0,
            // WS6: carry isMock so SwapEngine.executeSwap's mock guard
            // ('Cannot execute a mock quote') fires instead of a confusing
            // generic failure.
            isMock: quote.isMock,
        };

        return SwapEngine.executeSwap(engineQuote, walletAddress, chain, biometricAction);
    }

    getPopularPairs(chain: ChainType): Array<{ from: string; to: string }> {
        return SwapEngine.getPopularPairs(chain);
    }

    getSwappableTokens(chain: ChainType): string[] {
        return SwapEngine.getSwappableTokens(chain);
    }
}

export default SwapService.getInstance();
