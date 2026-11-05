/**
 * Chain registry tests. Wave J-bis (HIGH-13).
 *
 * Verifies:
 *   - assertSupportedAgentBankChain accepts only base/arbitrum/optimism.
 *   - Each per-chain address resolver reads the per-chain env var first
 *     and falls back to the legacy single-valued env var when the
 *     per-chain one is unset.
 *   - requireAddressOrThrow surfaces a useful error when neither var is set.
 *   - chainIdForName / chainNameForId round-trip correctly.
 */

import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import {
  SUPPORTED_AGENT_BANK_CHAINS,
  assertSupportedAgentBankChain,
  chainIdForName,
  chainNameForId,
  escrowUsdcAddressForChain,
  escrowV4AddressForChain,
  promiseUsdcAddressForChain,
  promiseV3AddressForChain,
  poolUsdcAddressForChain,
  poolV3AddressForChain,
  courtAddressForChain,
  requireAddressOrThrow,
} from './chain-registry';
import { ValidationError } from './errors';

const BASE = '0x000000000000000000000000000000000000B45E';
const ARB = '0x000000000000000000000000000000000000A4B0';
const OP = '0x00000000000000000000000000000000000000B0';
const LEGACY = '0x111111111111111111111111111111111111dead';

const ENV_KEYS = [
  'ESCROW_CONTRACT_ADDRESS',
  'ESCROW_CONTRACT_ADDRESS_BASE',
  'ESCROW_CONTRACT_ADDRESS_ARBITRUM',
  'ESCROW_CONTRACT_ADDRESS_OPTIMISM',
  'ESCROW_V4_CONTRACT_ADDRESS',
  'ESCROW_V4_CONTRACT_ADDRESS_BASE',
  'ESCROW_V4_CONTRACT_ADDRESS_ARBITRUM',
  'ESCROW_V4_CONTRACT_ADDRESS_OPTIMISM',
  'PROMISE_CONTRACT_ADDRESS',
  'PROMISE_CONTRACT_ADDRESS_BASE',
  'PROMISE_CONTRACT_ADDRESS_ARBITRUM',
  'PROMISE_CONTRACT_ADDRESS_OPTIMISM',
  'PROMISE_V3_CONTRACT_ADDRESS',
  'PROMISE_V3_CONTRACT_ADDRESS_BASE',
  'PROMISE_V3_CONTRACT_ADDRESS_ARBITRUM',
  'PROMISE_V3_CONTRACT_ADDRESS_OPTIMISM',
  'POOL_CONTRACT_ADDRESS',
  'POOL_CONTRACT_ADDRESS_BASE',
  'POOL_CONTRACT_ADDRESS_ARBITRUM',
  'POOL_CONTRACT_ADDRESS_OPTIMISM',
  'POOL_V2_CONTRACT_ADDRESS',
  'POOL_V2_CONTRACT_ADDRESS_BASE',
  'POOL_V2_CONTRACT_ADDRESS_ARBITRUM',
  'POOL_V2_CONTRACT_ADDRESS_OPTIMISM',
  'POOL_V3_CONTRACT_ADDRESS',
  'POOL_V3_CONTRACT_ADDRESS_BASE',
  'POOL_V3_CONTRACT_ADDRESS_ARBITRUM',
  'POOL_V3_CONTRACT_ADDRESS_OPTIMISM',
  'COURT_CONTRACT_ADDRESS',
  'COURT_CONTRACT_ADDRESS_BASE',
  'COURT_CONTRACT_ADDRESS_ARBITRUM',
  'COURT_CONTRACT_ADDRESS_OPTIMISM',
];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('SUPPORTED_AGENT_BANK_CHAINS', () => {
  it('contains exactly base, arbitrum, optimism (mainnets)', () => {
    expect([...SUPPORTED_AGENT_BANK_CHAINS]).toEqual(['base', 'arbitrum', 'optimism']);
  });
});

describe('assertSupportedAgentBankChain', () => {
  it('accepts each supported chain', () => {
    expect(() => assertSupportedAgentBankChain('base')).not.toThrow();
    expect(() => assertSupportedAgentBankChain('arbitrum')).not.toThrow();
    expect(() => assertSupportedAgentBankChain('optimism')).not.toThrow();
  });

  it('rejects unknown chain with UNSUPPORTED_CHAIN message and supported list', () => {
    expect(() => assertSupportedAgentBankChain('solana')).toThrow(ValidationError);
    try {
      assertSupportedAgentBankChain('solana');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('UNSUPPORTED_CHAIN');
      expect(msg).toContain('base');
      expect(msg).toContain('arbitrum');
      expect(msg).toContain('optimism');
    }
  });

  it('rejects undefined chain', () => {
    expect(() => assertSupportedAgentBankChain(undefined)).toThrow(/UNSUPPORTED_CHAIN/);
  });

  it('rejects empty string', () => {
    expect(() => assertSupportedAgentBankChain('')).toThrow(/UNSUPPORTED_CHAIN/);
  });

  it('rejects testnet chain names (out of API scope)', () => {
    expect(() => assertSupportedAgentBankChain('base-sepolia')).toThrow(/UNSUPPORTED_CHAIN/);
  });
});

describe('chainIdForName / chainNameForId', () => {
  it('round-trips each supported chain', () => {
    for (const chain of SUPPORTED_AGENT_BANK_CHAINS) {
      const id = chainIdForName(chain);
      expect(chainNameForId(id)).toBe(chain);
    }
  });

  it('returns undefined for unknown chain id', () => {
    expect(chainNameForId(1)).toBeUndefined();
    expect(chainNameForId(137)).toBeUndefined();
  });

  it('maps to the canonical L2 mainnet chain ids', () => {
    expect(chainIdForName('base')).toBe(8453);
    expect(chainIdForName('arbitrum')).toBe(42161);
    expect(chainIdForName('optimism')).toBe(10);
  });
});

describe('per-chain address resolvers - Escrow USDC', () => {
  it('reads ESCROW_CONTRACT_ADDRESS_<CHAIN> when set', () => {
    process.env.ESCROW_CONTRACT_ADDRESS_BASE = BASE;
    process.env.ESCROW_CONTRACT_ADDRESS_ARBITRUM = ARB;
    process.env.ESCROW_CONTRACT_ADDRESS_OPTIMISM = OP;
    expect(escrowUsdcAddressForChain('base')).toBe(BASE);
    expect(escrowUsdcAddressForChain('arbitrum')).toBe(ARB);
    expect(escrowUsdcAddressForChain('optimism')).toBe(OP);
  });

  it('falls back to legacy ESCROW_CONTRACT_ADDRESS when per-chain unset', () => {
    process.env.ESCROW_CONTRACT_ADDRESS = LEGACY;
    expect(escrowUsdcAddressForChain('base')).toBe(LEGACY);
    expect(escrowUsdcAddressForChain('arbitrum')).toBe(LEGACY);
    expect(escrowUsdcAddressForChain('optimism')).toBe(LEGACY);
  });

  it('prefers per-chain over legacy', () => {
    process.env.ESCROW_CONTRACT_ADDRESS = LEGACY;
    process.env.ESCROW_CONTRACT_ADDRESS_ARBITRUM = ARB;
    expect(escrowUsdcAddressForChain('arbitrum')).toBe(ARB);
    expect(escrowUsdcAddressForChain('base')).toBe(LEGACY);
  });

  it('returns undefined when nothing is set', () => {
    expect(escrowUsdcAddressForChain('base')).toBeUndefined();
  });
});

describe('per-chain address resolvers - Escrow V4 PVT', () => {
  it('reads ESCROW_V4_CONTRACT_ADDRESS_<CHAIN> with legacy fallback', () => {
    process.env.ESCROW_V4_CONTRACT_ADDRESS_BASE = BASE;
    process.env.ESCROW_V4_CONTRACT_ADDRESS = LEGACY;
    expect(escrowV4AddressForChain('base')).toBe(BASE);
    expect(escrowV4AddressForChain('arbitrum')).toBe(LEGACY);
  });
});

describe('per-chain address resolvers - Promise V2 USDC and V3 PVT', () => {
  it('Promise USDC - per-chain + legacy fallback', () => {
    process.env.PROMISE_CONTRACT_ADDRESS_OPTIMISM = OP;
    process.env.PROMISE_CONTRACT_ADDRESS = LEGACY;
    expect(promiseUsdcAddressForChain('optimism')).toBe(OP);
    expect(promiseUsdcAddressForChain('base')).toBe(LEGACY);
  });

  it('Promise V3 PVT - per-chain + legacy fallback', () => {
    process.env.PROMISE_V3_CONTRACT_ADDRESS_ARBITRUM = ARB;
    process.env.PROMISE_V3_CONTRACT_ADDRESS = LEGACY;
    expect(promiseV3AddressForChain('arbitrum')).toBe(ARB);
    expect(promiseV3AddressForChain('optimism')).toBe(LEGACY);
  });
});

describe('per-chain address resolvers - Pool V2 USDC and V3 PVT', () => {
  it('Pool USDC - POOL_V2_CONTRACT_ADDRESS_<CHAIN> wins over POOL_CONTRACT_ADDRESS', () => {
    process.env.POOL_V2_CONTRACT_ADDRESS_BASE = BASE;
    process.env.POOL_CONTRACT_ADDRESS = LEGACY;
    expect(poolUsdcAddressForChain('base')).toBe(BASE);
    // Per-chain V2 overrides legacy V2 - and legacy V2 overrides legacy POOL_CONTRACT_ADDRESS.
    process.env.POOL_V2_CONTRACT_ADDRESS = '0x222222222222222222222222222222222222Beef';
    expect(poolUsdcAddressForChain('arbitrum')).toBe('0x222222222222222222222222222222222222Beef');
  });

  it('Pool USDC - falls all the way back to POOL_CONTRACT_ADDRESS when neither V2 var set', () => {
    process.env.POOL_CONTRACT_ADDRESS = LEGACY;
    expect(poolUsdcAddressForChain('arbitrum')).toBe(LEGACY);
  });

  it('Pool V3 PVT - per-chain + legacy fallback', () => {
    process.env.POOL_V3_CONTRACT_ADDRESS_BASE = BASE;
    expect(poolV3AddressForChain('base')).toBe(BASE);
    expect(poolV3AddressForChain('optimism')).toBeUndefined();
  });
});

describe('per-chain address resolvers - Court V2', () => {
  it('reads COURT_CONTRACT_ADDRESS_<CHAIN> with legacy fallback', () => {
    process.env.COURT_CONTRACT_ADDRESS_ARBITRUM = ARB;
    process.env.COURT_CONTRACT_ADDRESS = LEGACY;
    expect(courtAddressForChain('arbitrum')).toBe(ARB);
    expect(courtAddressForChain('base')).toBe(LEGACY);
  });
});

describe('isolation: per-chain address does not leak to other chains', () => {
  it('Arbitrum-only configuration does not satisfy Optimism resolution', () => {
    process.env.ESCROW_V4_CONTRACT_ADDRESS_ARBITRUM = ARB;
    expect(escrowV4AddressForChain('arbitrum')).toBe(ARB);
    expect(escrowV4AddressForChain('optimism')).toBeUndefined();
    expect(escrowV4AddressForChain('base')).toBeUndefined();
  });
});

describe('requireAddressOrThrow', () => {
  it('returns the address when set', () => {
    expect(requireAddressOrThrow(BASE, 'ESCROW', 'base')).toBe(BASE);
  });

  it('throws ValidationError listing the env var when undefined', () => {
    expect(() => requireAddressOrThrow(undefined, 'PROMISE_V3', 'arbitrum')).toThrow(ValidationError);
    try {
      requireAddressOrThrow(undefined, 'PROMISE_V3', 'arbitrum');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PROMISE_V3');
      expect(msg).toContain('arbitrum');
      expect(msg).toContain('PROMISE_V3_CONTRACT_ADDRESS_ARBITRUM');
    }
  });
});
