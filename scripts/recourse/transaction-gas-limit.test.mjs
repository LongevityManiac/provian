import { test, expect } from 'vitest';
import { BASE_TRANSACTION_GAS_LIMIT, assertBaseTransactionGasLimit, boundedGasEstimate } from './transaction-gas-limit.mjs';
test('declared limit accepts the exact Base ceiling and refuses one gas above it', () => {
  expect(assertBaseTransactionGasLimit(16_777_216n)).toBe(BASE_TRANSACTION_GAS_LIMIT);
  for (const value of [0n, -1n, 16_777_217n, 33_350_272n, '16777216']) {
    expect(() => assertBaseTransactionGasLimit(value)).toThrow('changeover_transaction_gas_limit');
  }
});
test('execution headroom must fit too, even when the raw estimate fits', () => {
  expect(boundedGasEstimate(1_000_000n)).toBe(1_200_000n);
  expect(() => boundedGasEstimate(14_000_000n)).toThrow('changeover_transaction_gas_limit');
  expect(() => boundedGasEstimate(1_000_000n, 1_100_000n)).toThrow('changeover_transaction_gas_budget');
});
