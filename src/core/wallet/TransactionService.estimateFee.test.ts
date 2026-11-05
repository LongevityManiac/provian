import { describe, it, expect, vi } from 'vitest';
import TransactionService from './TransactionService';

// WS7: estimateFee used a hardcoded 21,000-gas constant — correct for a native
// ETH transfer but a 2-3x under-estimate for an ERC-20 transfer (~45-70k). The
// fix asks the node for real gas when calldata is supplied. These tests inject a
// fake provider into the singleton's provider cache so the REAL estimateFee path
// runs without network.

const CHAIN = 8453;
const ONE_GWEI = 1_000_000_000n;

function injectProvider(p: unknown): void {
  (TransactionService as unknown as { providers: Map<number, unknown> }).providers.set(CHAIN, p);
}

describe('WS7: TransactionService.estimateFee gas accuracy', () => {
  it('prices a bare native transfer at 21k gas and never calls estimateGas', async () => {
    const estimateGas = vi.fn();
    injectProvider({
      getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }),
      estimateGas,
    });

    const fee = await TransactionService.estimateFee(CHAIN);
    // 21000 * 1 gwei = 0.000021 ETH
    expect(fee).toBe('~0.000021 ETH');
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it('asks the node for real gas on an ERC-20 transfer (calldata present)', async () => {
    const estimateGas = vi.fn().mockResolvedValue(52_000n);
    injectProvider({
      getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }),
      estimateGas,
    });

    const data = '0xa9059cbb' + '0'.repeat(128); // transfer(to,amount) selector + args
    const fee = await TransactionService.estimateFee(CHAIN, { to: '0xToken', data });
    // 52000 * 1 gwei = 0.000052 ETH — NOT the 0.000021 the old constant produced.
    expect(fee).toBe('~0.000052 ETH');
    expect(estimateGas).toHaveBeenCalledOnce();
  });

  it('falls back to a conservative 65k (not native 21k) when the node refuses to simulate', async () => {
    injectProvider({
      getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }),
      estimateGas: async () => {
        throw new Error('insufficient funds for probe');
      },
    });

    const data = '0xa9059cbb' + '0'.repeat(128);
    const fee = await TransactionService.estimateFee(CHAIN, { to: '0xToken', data });
    // 65000 * 1 gwei = 0.000065 ETH
    expect(fee).toBe('~0.000065 ETH');
  });
});
