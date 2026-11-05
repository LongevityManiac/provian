/**
 * The swap screen's record of what the user tapped Swap on ( ).
 *
 * The screen's pair and amount could change while a swap was in flight (the badges and the flip
 * stayed enabled), and the 0x re-quote path set its fresh quote straight into the screen state,
 * past the quote-sequence guard: a stale USDC → ETH re-quote could land under ETH → USDC badges,
 * and the next tap would execute the opposite of what was shown. So the screen snapshots the
 * swap when it is submitted, executes exactly that snapshot (CrossChainSwapEngine refuses a
 * route that is not it), lets a re-quote replace the quote only while that snapshot is still
 * what the screen shows, and names the snapshot's pair in the result. The controls are disabled
 * while a swap is in flight.
 */

import type { Asset } from '../../store/walletStore';
import type { SwapQuote } from './SwapService';
import type { DisplayedSwap } from './CrossChainSwapEngine';

/** The swap on screen when Swap was tapped. */
export interface SwapSubmission extends DisplayedSwap {
    fromAsset: Asset;
    toAsset: Asset;
    amount: string;
    /** The quote request that produced the quote on screen (SwapScreen's quoteSeq). */
    seq: number;
    /** The quote on screen. */
    quoteId: string;
}

export function beginSubmission(
    fromAsset: Asset,
    toAsset: Asset,
    amount: string,
    seq: number,
    quote: Pick<SwapQuote, 'id'>,
): SwapSubmission {
    return { fromAsset, toAsset, amount, seq, quoteId: quote.id };
}

/**
 * A fresh quote returned by the engine replaces the one on screen only when nothing on screen
 * moved since the swap was submitted (no newer quote request: `currentSeq` is the submission's)
 * and it quotes the submitted pair. Otherwise it is dropped: the screen re-quotes the pair it
 * now shows on its own.
 */
export function requoteApplies(sub: SwapSubmission, currentSeq: number, fresh: SwapQuote): boolean {
    if (sub.seq !== currentSeq) return false;
    if (fresh.isMock || fresh.crossChain) return false;
    return fresh.fromToken === sub.fromAsset.symbol && fresh.toToken === sub.toAsset.symbol;
}

/** "<symbol> on <chain> → <symbol> on <chain>" for the submitted swap, with the screen's formatter. */
export function submittedPairText(sub: SwapSubmission, onChain: (a: Asset) => string): { from: string; to: string } {
    return { from: onChain(sub.fromAsset), to: onChain(sub.toAsset) };
}
