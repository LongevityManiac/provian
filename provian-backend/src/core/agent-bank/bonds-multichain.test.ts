/**
 * Bonds: per-chain BondPool address resolver tests.
 *
 * Verifies that bond operations route on-chain verification to the right
 * BondPool address per chain (Base, Arbitrum, Optimism), and that the legacy
 * single-chain BOND_POOL_CONTRACT_ADDRESS env var still works as a fallback
 * for deployments that have not yet adopted per-chain configuration.
 *
 * See GitHub issue #41.
 */

import { bondPoolAddressForChain } from './bonds';

const BASE_ADDRESS = '0x469A90cE8837E0dC87e1aa0fc22D490A74f20477';
const ARBITRUM_ADDRESS = '0x55A1e082cFf86c83b2147202ed86E952be3f2243';
const OPTIMISM_ADDRESS = '0x55A1e082cFf86c83b2147202ed86E952be3f2243';
const LEGACY_ADDRESS = '0x111111111111111111111111111111111111dead';

describe('bondPoolAddressForChain', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BOND_POOL_CONTRACT_ADDRESS;
    delete process.env.BOND_POOL_CONTRACT_ADDRESS_BASE;
    delete process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM;
    delete process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('resolves Base from BOND_POOL_CONTRACT_ADDRESS_BASE', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = BASE_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM = ARBITRUM_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM = OPTIMISM_ADDRESS;

    expect(bondPoolAddressForChain('base')).toBe(BASE_ADDRESS);
  });

  it('resolves Arbitrum from BOND_POOL_CONTRACT_ADDRESS_ARBITRUM', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = BASE_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM = ARBITRUM_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM = OPTIMISM_ADDRESS;

    expect(bondPoolAddressForChain('arbitrum')).toBe(ARBITRUM_ADDRESS);
  });

  it('resolves Optimism from BOND_POOL_CONTRACT_ADDRESS_OPTIMISM', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = BASE_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM = ARBITRUM_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM = OPTIMISM_ADDRESS;

    expect(bondPoolAddressForChain('optimism')).toBe(OPTIMISM_ADDRESS);
  });

  it('keeps each chain isolated: Arbitrum address does not leak to Optimism', () => {
    const distinctOptimism = '0x222222222222222222222222222222222222beef';
    process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM = ARBITRUM_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM = distinctOptimism;

    expect(bondPoolAddressForChain('arbitrum')).toBe(ARBITRUM_ADDRESS);
    expect(bondPoolAddressForChain('optimism')).toBe(distinctOptimism);
  });

  it('falls back to legacy BOND_POOL_CONTRACT_ADDRESS when per-chain env is unset', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS = LEGACY_ADDRESS;

    expect(bondPoolAddressForChain('base')).toBe(LEGACY_ADDRESS);
    expect(bondPoolAddressForChain('arbitrum')).toBe(LEGACY_ADDRESS);
    expect(bondPoolAddressForChain('optimism')).toBe(LEGACY_ADDRESS);
  });

  it('prefers per-chain env over legacy fallback', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS = LEGACY_ADDRESS;
    process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM = ARBITRUM_ADDRESS;

    expect(bondPoolAddressForChain('arbitrum')).toBe(ARBITRUM_ADDRESS);
    // Base falls through to legacy because no per-chain Base env is set.
    expect(bondPoolAddressForChain('base')).toBe(LEGACY_ADDRESS);
  });

  it('returns undefined when nothing is configured', () => {
    expect(bondPoolAddressForChain('base')).toBeUndefined();
    expect(bondPoolAddressForChain('arbitrum')).toBeUndefined();
    expect(bondPoolAddressForChain('optimism')).toBeUndefined();
  });

  it('returns undefined for unknown chain strings without legacy fallback', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = BASE_ADDRESS;
    expect(bondPoolAddressForChain('solana')).toBeUndefined();
  });

  it('returns legacy fallback for unknown chain when legacy is set', () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS = LEGACY_ADDRESS;
    expect(bondPoolAddressForChain('zksync')).toBe(LEGACY_ADDRESS);
  });
});
