/** Base's per-transaction ceiling applies to the declared limit, not gas used.
 * Keep this independent of block limits, fee budgets and simulator settings. */
export const BASE_TRANSACTION_GAS_LIMIT = 16_777_216n;
export function assertBaseTransactionGasLimit(value) {
  if (typeof value !== 'bigint' || value <= 0n || value > BASE_TRANSACTION_GAS_LIMIT) {
    throw Error('changeover_transaction_gas_limit');
  }
  return value;
}
export function boundedGasEstimate(estimate, approvedMaximum = BASE_TRANSACTION_GAS_LIMIT) {
  assertBaseTransactionGasLimit(approvedMaximum);
  const limit = assertBaseTransactionGasLimit((estimate * 120n + 99n) / 100n);
  if (limit > approvedMaximum) throw Error('changeover_transaction_gas_budget');
  return limit;
}
