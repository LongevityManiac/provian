/**
 * — the swap screen's submission record (swapSubmission.ts).
 *
 * The defect: while a swap was in flight the pair controls stayed enabled and the 0x re-quote
 * set its fresh quote straight into the screen, past the quote-sequence guard. A user who
 * flipped USDC → ETH to ETH → USDC while the approval confirmed got the stale USDC → ETH
 * re-quote under ETH → USDC badges, and the next tap executed the opposite of what was shown.
 */
import { describe, expect, it } from 'vitest';
import type { Asset } from '../../../store/walletStore';
import type { SwapQuote } from '../SwapService';
import { beginSubmission, requoteApplies, submittedPairText } from '../swapSubmission';

const asset = (symbol: string, chain: Asset['chain'] = 'Base'): Asset => ({
    symbol, name: symbol, balance: '0', price: 0, chain, decimals: symbol === 'ETH' ? 18 : 6,
});
const USDC = asset('USDC');
const ETH = asset('ETH');
const quote = (fromToken: string, toToken: string, over: Partial<SwapQuote> = {}): SwapQuote => ({
    id: 'q', fromToken, toToken, fromAmount: '20', toAmount: '0.007', rate: 0, priceImpact: 0, fee: '', feeUsd: 0,
    provianFee: '0.05', provianFeeToken: fromToken, provianFeeUsd: 0, netToAmount: '0.007', estimatedGas: '', route: [],
    provider: '0x', validUntil: 0, ...over,
});
/** The screen's old behaviour: every re-quote replaced the quote on screen. */
const oldRequoteApplies = (): boolean => true;

describe('swapSubmission — what executes, what a re-quote may replace, what the result names', () => {
    const sub = beginSubmission(USDC, ETH, '20', 5, { id: 'quote-on-screen' });

    it('the submission is the swap on screen when Swap was tapped', () => {
        expect(sub).toEqual({ fromAsset: USDC, toAsset: ETH, amount: '20', seq: 5, quoteId: 'quote-on-screen' });
        const on = (a: Asset) => `${a.symbol} on ${a.chain}`;
        expect(submittedPairText(sub, on)).toEqual({ from: 'USDC on Base', to: 'ETH on Base' });
    });

    it('control: a re-quote for the submitted pair, with nothing moved on screen, replaces the quote', () => {
        expect(requoteApplies(sub, 5, quote('USDC', 'ETH'))).toBe(true);
    });

    it("RED : the pair flipped to ETH → USDC while the swap was in flight — the stale USDC → ETH re-quote is dropped", () => {
        // Flipping the pair runs the quote effect, which bumps the sequence to 6.
        const fresh = quote('USDC', 'ETH');
        expect(oldRequoteApplies()).toBe(true); // before: set under the ETH → USDC badges
        expect(requoteApplies(sub, 6, fresh)).toBe(false);
    });

    it('RED: a re-quote for another pair, a cross-chain quote, or a mock is never put on screen', () => {
        expect(requoteApplies(sub, 5, quote('ETH', 'USDC'))).toBe(false);
        expect(requoteApplies(sub, 5, quote('USDC', 'DAI'))).toBe(false);
        expect(requoteApplies(sub, 5, quote('USDC', 'ETH', { crossChain: true }))).toBe(false);
        expect(requoteApplies(sub, 5, quote('USDC', 'ETH', { isMock: true }))).toBe(false);
    });
});
