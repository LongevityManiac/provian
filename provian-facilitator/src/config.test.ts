import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const noChains = { PORT: '8080' } as Record<string, string>;
const addr = () => 'unused';

describe('refill swap minimum ', () => {
  it('defaults to $1 on both chains', () => {
    const c = loadConfig(noChains, addr);
    expect(c.refill.baseMinSwapUsdc).toBe(1_000_000n);
    expect(c.refill.solanaMinSwapUsdc).toBe(1_000_000n);
  });
  it('an operator may lower it per chain', () => {
    expect(loadConfig({ ...noChains, FACILITATOR_BASE_MIN_SWAP_USDC: '5000' }, addr).refill.baseMinSwapUsdc).toBe(5_000n);
  });
  it('RED: zero is refused at startup (a zero would swap dust)', () => {
    expect(() => loadConfig({ ...noChains, FACILITATOR_BASE_MIN_SWAP_USDC: '0' }, addr)).toThrow('FACILITATOR_BASE_MIN_SWAP_USDC must be at least 1');
    expect(() => loadConfig({ ...noChains, FACILITATOR_SOLANA_MIN_SWAP_USDC: '0' }, addr)).toThrow('FACILITATOR_SOLANA_MIN_SWAP_USDC must be at least 1');
  });
});
