import { Interface, Transaction, type TransactionLike } from 'ethers';

export const BASE_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
const oracle = new Interface([
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)',
]);
export interface BaseFeeReader {
  readonly operatorId: string;
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}
export interface BaseTransactionFeeEstimate {
  readonly blockHash: string; readonly unsignedBytes: number;
  readonly executionFeeMaxWei: bigint; readonly l1FeeEstimateWei: bigint;
  readonly operatorFeeEstimateWei: bigint; readonly totalEstimateWei: bigint;
}
/** Quote every fee component at one canonical block through independent
 * operators. L1 and operator fees can change before inclusion; the quote is
 * not an EIP-1559 ceiling on the total transaction cost. Never treat an absent
 * oracle method or failed/disagreeing read as a zero fee. */
export async function estimateBaseTransactionFees(readers: readonly BaseFeeReader[], transaction: TransactionLike,
  blockHash: string): Promise<BaseTransactionFeeEstimate> {
  if (readers.length !== 2 || !readers[0].operatorId || !readers[1].operatorId
    || readers[0].operatorId === readers[1].operatorId || !/^0x[0-9a-f]{64}$/.test(blockHash)) {
    throw Error('recourse_fee_configuration_invalid');
  }
  const tx = Transaction.from(transaction);
  if (tx.chainId !== 8453n || tx.type !== 2 || tx.gasLimit <= 0n || tx.maxFeePerGas === null
    || tx.maxPriorityFeePerGas === null || tx.maxFeePerGas < tx.maxPriorityFeePerGas) {
    throw Error('recourse_fee_transaction_invalid');
  }
  for (const chain of await Promise.all(readers.map(reader => reader.request('eth_chainId', [])))) {
    if (chain !== '0x2105') throw Error('recourse_fee_chain_invalid');
  }
  const at = { blockHash, requireCanonical: true }, unsigned = tx.unsignedSerialized;
  const read = async (method: string, args: readonly unknown[]): Promise<bigint> => {
    const data = oracle.encodeFunctionData(method, args);
    const replies = await Promise.all(readers.map(reader => reader.request('eth_call', [{ to: BASE_GAS_PRICE_ORACLE, data }, at])));
    if (replies.some(value => typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))) {
      throw Error('recourse_fee_oracle_invalid');
    }
    const values = replies.map(reply => BigInt(oracle.decodeFunctionResult(method, String(reply))[0]));
    if (values[0] !== values[1]) throw Error('recourse_fee_rpc_disagreement');
    return values[0];
  };
  const unsignedBytes = (unsigned.length - 2) / 2;
  const [l1Exact, l1Upper, operatorFeeEstimateWei] = await Promise.all([
    read('getL1Fee', [unsigned]), read('getL1FeeUpperBound', [unsignedBytes]), read('getOperatorFee', [tx.gasLimit]),
  ]);
  const l1FeeEstimateWei = l1Exact > l1Upper ? l1Exact : l1Upper;
  const executionFeeMaxWei = tx.gasLimit * tx.maxFeePerGas;
  return { blockHash, unsignedBytes, executionFeeMaxWei, l1FeeEstimateWei, operatorFeeEstimateWei,
    totalEstimateWei: executionFeeMaxWei + l1FeeEstimateWei + operatorFeeEstimateWei };
}
