/**
 * The one place the swap screen gets a quote. A swap delivers exactly the token the user
 * picked, on exactly the chain the user picked:
 *
 * same-chain EVM (Base, Arbitrum or Optimism) → 0x (SwapService / SwapEngine)
 * Solana ⇄ Solana → Jupiter (CrossChainSwapEngine)
 * any pair across chains (Solana ⇄ EVM, EVM ⇄ EVM) → LI.FI / Mayan Swift (CrossChainSwapEngine)
 *
 * The route is decided by chain INEQUALITY. Before the screen asked "does either side
 * touch Solana?", so a Base → Arbitrum pick went to 0x with the destination chain dropped: 0x
 * resolved the buy token by symbol on the SOURCE chain and executed Base USDC → Base ETH, while
 * the screen showed "ETH". A same-token pick got 0x's 400 and a mock 1:1 "estimated" quote.
 *
 * Never a mock: a quote that is not a live answer for the exact pair picked is no quote.
 */

import type { Asset } from '../../store/walletStore';
import SwapService, { type SwapQuote } from './SwapService';
import CrossChainSwapEngine from './CrossChainSwapEngine';

export interface SwapQuoteRequest {
    fromAsset: Asset;
    toAsset: Asset;
    amount: string;
    /** Percent, e.g. 0.5. */
    slippage: number;
    evmAddress: string;
    solanaAddress: string;
}

/** Which engine quotes and executes a pair. */
export type SwapRouteKind = 'zerox' | 'crosschain';

export function swapRouteKind(fromAsset: Pick<Asset, 'chain'>, toAsset: Pick<Asset, 'chain'>): SwapRouteKind {
    return CrossChainSwapEngine.handlesPair(fromAsset, toAsset) ? 'crosschain' : 'zerox';
}

/** A live quote for exactly the pair picked, or null (no route, refused, or unreachable). */
export async function quoteSwap(req: SwapQuoteRequest): Promise<SwapQuote | null> {
    const { fromAsset, toAsset, amount, slippage, evmAddress, solanaAddress } = req;
    const quote: SwapQuote | null = swapRouteKind(fromAsset, toAsset) === 'crosschain'
        ? await CrossChainSwapEngine.getQuote({ fromAsset, toAsset, amount, slippage, evmAddress, solanaAddress })
        : await SwapService.getQuote(
            fromAsset.chain,
            fromAsset.symbol,
            toAsset.symbol,
            amount,
            slippage,
            evmAddress, // 0x v2 requires the taker address
            toAsset.chain,
        );
    if (!quote || quote.isMock) return null;
    return quote;
}
