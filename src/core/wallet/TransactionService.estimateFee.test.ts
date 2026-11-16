import { describe, it, expect, vi } from 'vitest';
import { formatEther } from 'ethers';
import TransactionService from './TransactionService';
import { builderCodeGas } from '../protocol/builder-code';

// WS7: estimateFee used a hardcoded 21,000-gas constant — correct for a native
// ETH transfer but a 2-3x under-estimate for an ERC-20 transfer (~45-70k). The
// fix asks the node for real gas when calldata is supplied. These tests inject a
// fake provider into the singleton's provider cache so the REAL estimateFee path
// runs without network.

const CHAIN = 8453;
const ONE_GWEI = 1_000_000_000n;

function injectProvider(p: unknown, chain: number = CHAIN): void {
  (TransactionService as unknown as { providers: Map<number, unknown> }).providers.set(chain, p);
}
// A Base transaction carries Provian's Builder Code suffix, whose calldata gas the fee includes.
const fee = (gas: bigint, data?: string): string => `~${formatEther((gas + builderCodeGas(data)) * ONE_GWEI)} ETH`;

describe('WS7: TransactionService.estimateFee gas accuracy', () => {
  it('prices a bare native transfer at 21k gas and never calls estimateGas', async () => {
    const estimateGas = vi.fn();
    injectProvider({
      getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }),
      estimateGas,
    });

    const quoted = await TransactionService.estimateFee(CHAIN);
    // (21000 + suffix gas) * 1 gwei
    expect(quoted).toBe(fee(21_000n));
    expect(builderCodeGas()).toBeGreaterThan(0n);
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it('prices another chain without the suffix (RED control: attribution is Base-only)', async () => {
    injectProvider({ getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }), estimateGas: vi.fn() }, 1);
    expect(await TransactionService.estimateFee(1)).toBe('~0.000021 ETH');
  });

  it('asks the node for real gas on an ERC-20 transfer (calldata present)', async () => {
    const estimateGas = vi.fn().mockResolvedValue(52_000n);
    injectProvider({
      getFeeData: async () => ({ maxFeePerGas: ONE_GWEI }),
      estimateGas,
    });

    const data = '0xa9059cbb' + '0'.repeat(128); // transfer(to,amount) selector + args
    const quoted = await TransactionService.estimateFee(CHAIN, { to: '0xToken', data });
    // 52000 (+ suffix gas) * 1 gwei — NOT the 0.000021 the old constant produced.
    expect(quoted).toBe(fee(52_000n, data));
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
    const quoted = await TransactionService.estimateFee(CHAIN, { to: '0xToken', data });
    // 65000 (+ suffix gas) * 1 gwei
    expect(quoted).toBe(fee(65_000n, data));
  });
});
