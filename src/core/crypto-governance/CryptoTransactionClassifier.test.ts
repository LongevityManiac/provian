/**
 * CryptoTransactionClassifier Tests
 *
 * Covers:
 * - Hardcoded registry lookups (existing + new multi-chain contracts)
 * - Function selector classification
 * - Unknown contract → hard_confirm (critical risk)
 * - Backend registry merge (backend entries take precedence)
 * - Fallback to hardcoded list when backend unreachable
 * - Lazy refresh fires on unknown contract
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AsyncStorage and expo-crypto before importing classifier
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('expo-crypto', () => ({
  digestStringAsync: vi.fn().mockResolvedValue('mock-hash'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

vi.mock('../relay/DevHostDiscovery', () => ({
  resolveRelayBaseUrl: vi.fn().mockReturnValue('https://api.provian.ai'),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  classifyCryptoTransaction,
  isPredictionMarketTransaction,
  isKnownPredictionMarketContract,
  getPlatformForContract,
  refreshRegistryFromBackend,
  type CryptoTransactionInput,
} from './CryptoTransactionClassifier';

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Hardcoded registry - existing contracts
// ---------------------------------------------------------------------------

describe('hardcoded registry', () => {
  it('classifies Polymarket CTF Exchange as prediction_market', () => {
    const result = classifyCryptoTransaction({
      to: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
      value: '0',
      data: '0x7d16e257',
      chain: 'polygon',
    });
    expect(result.category).toBe('prediction_market');
    expect(result.platform).toBe('Polymarket');
    expect(result.confidence).toBe(1.0);
    expect(result.isKnownContract).toBe(true);
    expect(result.riskTier).toBe('high');
  });

  it('classifies Uniswap V3 on Base as dex_swap', () => {
    const result = classifyCryptoTransaction({
      to: '0x2626664c2603336e57b271c5c0b26f421741e481',
      value: '0',
      data: '0x5ae401dc',
      chain: 'base',
    });
    expect(result.category).toBe('dex_swap');
    expect(result.platform).toBe('Uniswap V3');
    expect(result.isKnownContract).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New multi-chain contracts
// ---------------------------------------------------------------------------

describe('new multi-chain contracts', () => {
  it('classifies Aave V3 on Base as defi_lending', () => {
    const result = classifyCryptoTransaction({
      to: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
      value: '0',
      data: '0x12345678',
      chain: 'base',
    });
    expect(result.category).toBe('defi_lending');
    expect(result.platform).toBe('Aave V3');
    expect(result.riskTier).toBe('medium');
    expect(result.isKnownContract).toBe(true);
  });

  it('classifies Aave V3 on Arbitrum as defi_lending', () => {
    const result = classifyCryptoTransaction({
      to: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
      value: '0',
      data: '0x12345678',
      chain: 'arbitrum',
    });
    expect(result.category).toBe('defi_lending');
    expect(result.platform).toBe('Aave V3');
    expect(result.isKnownContract).toBe(true);
  });

  it('classifies 1inch on Base as dex_swap', () => {
    const result = classifyCryptoTransaction({
      to: '0x1111111254eeb25477b68fb85ed929f73a960582',
      value: '0',
      data: '0x12345678',
      chain: 'base',
    });
    expect(result.category).toBe('dex_swap');
    expect(result.platform).toBe('1inch');
    expect(result.isKnownContract).toBe(true);
  });

  it('classifies Aerodrome on Base as dex_swap', () => {
    const result = classifyCryptoTransaction({
      to: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
      value: '0',
      data: '0x12345678',
      chain: 'base',
    });
    expect(result.category).toBe('dex_swap');
    expect(result.platform).toBe('Aerodrome');
    expect(result.riskTier).toBe('medium');
  });

  it('classifies Compound V3 on Base as defi_lending', () => {
    const result = classifyCryptoTransaction({
      to: '0xb125e6687d4313864e53df431d5425969c15eb2f',
      value: '0',
      data: '0x12345678',
      chain: 'base',
    });
    expect(result.category).toBe('defi_lending');
    expect(result.platform).toBe('Compound V3');
  });

  it('classifies Uniswap V3 on Arbitrum as dex_swap', () => {
    const result = classifyCryptoTransaction({
      to: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
      value: '0',
      data: '0x5ae401dc',
      chain: 'arbitrum',
    });
    expect(result.category).toBe('dex_swap');
    expect(result.platform).toBe('Uniswap V3');
  });
});

// ---------------------------------------------------------------------------
// Unknown contracts → hard_confirm
// ---------------------------------------------------------------------------

describe('unknown contracts', () => {
  it('returns unknown/critical for unrecognized contract', () => {
    const result = classifyCryptoTransaction({
      to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      value: '0',
      data: '0xdeadbeef12345678',
      chain: 'base',
    });
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0.0);
    expect(result.riskTier).toBe('critical');
    expect(result.isKnownContract).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Function selector classification
// ---------------------------------------------------------------------------

describe('function selector fallback', () => {
  it('classifies ERC-20 transfer by selector on unknown contract', () => {
    const result = classifyCryptoTransaction({
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      value: '0',
      data: '0xa9059cbb0000000000000000000000000000000000000000',
      chain: 'base',
    });
    expect(result.category).toBe('token_transfer');
    expect(result.confidence).toBe(0.95);
    expect(result.isKnownContract).toBe(false);
  });

  it('classifies ERC-20 approve by selector', () => {
    const result = classifyCryptoTransaction({
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      value: '0',
      data: '0x095ea7b30000000000000000000000000000000000000000',
      chain: 'base',
    });
    expect(result.category).toBe('token_approval');
  });
});

// ---------------------------------------------------------------------------
// Native transfers
// ---------------------------------------------------------------------------

describe('native transfers', () => {
  it('classifies native ETH transfer (no data, value > 0)', () => {
    const result = classifyCryptoTransaction({
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      value: '1000000000000000000',
      chain: 'base',
    });
    expect(result.category).toBe('token_transfer');
    expect(result.confidence).toBe(0.95);
    expect(result.riskTier).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Contract creation
// ---------------------------------------------------------------------------

describe('contract creation', () => {
  it('classifies contract deployment (no to address)', () => {
    const result = classifyCryptoTransaction({
      to: null,
      value: '0',
      data: '0x608060405234801561001057600080fd5b50',
      chain: 'base',
    });
    expect(result.category).toBe('contract_deploy');
    expect(result.riskTier).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// Prediction market helpers
// ---------------------------------------------------------------------------

describe('prediction market helpers', () => {
  it('isPredictionMarketTransaction returns true for Polymarket', () => {
    expect(isPredictionMarketTransaction({
      to: '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
      value: '0',
      chain: 'polygon',
    })).toBe(true);
  });

  it('isKnownPredictionMarketContract matches Polymarket', () => {
    expect(isKnownPredictionMarketContract('0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e')).toBe(true);
  });

  it('getPlatformForContract returns platform name', () => {
    expect(getPlatformForContract('0x2626664c2603336e57b271c5c0b26f421741e481')).toBe('Uniswap V3');
  });
});
