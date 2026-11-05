import { describe, it, expect } from 'vitest';
import { swapFailureKey } from './swapFailureText';

describe('a failed swap is described in plain words', () => {
    it("ethers' raw INSUFFICIENT_FUNDS (an empty wallet) reads as not enough ETH for the fee", () => {
        expect(swapFailureKey('insufficient funds for intrinsic transaction cost (transaction="0x02f8", info={ "error": { "code": -32000 } }, code=INSUFFICIENT_FUNDS, version=6.13.4)')).toBe('swap.errorInsufficientGas');
    });
    it('price movement, cancellation and network failures each have their own words', () => {
        expect(swapFailureKey('execution reverted: Too little received')).toBe('swap.errorPriceMoved');
        expect(swapFailureKey('user rejected action (code=ACTION_REJECTED)')).toBe('swap.errorCancelled');
        expect(swapFailureKey('request timeout (code=TIMEOUT)')).toBe('swap.errorNetwork');
    });
    it('anything else is the generic failure, never the raw text', () => {
        expect(swapFailureKey('0x8baa579f')).toBe('swap.errorGeneric');
        expect(swapFailureKey(undefined)).toBe('swap.errorGeneric');
    });
});
