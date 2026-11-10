import { Interface, Transaction } from 'ethers';
import { estimateBaseTransactionFees, BASE_GAS_PRICE_ORACLE, type BaseFeeReader } from './base-transaction-fees';
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)',
  'function getL1FeeUpperBound(uint256) view returns(uint256)', 'function getOperatorFee(uint256) view returns(uint256)']);
const blockHash = `0x${'11'.repeat(32)}`;
const transaction = { type: 2, chainId: 8453, nonce: 3, to: `0x${'22'.repeat(20)}`, value: 0,
  data: '0x1234', gasLimit: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
function fixture() {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const request = jest.fn(async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls.push({ method, params }); if (method === 'eth_chainId') return '0x2105';
    const call = params[0] as { to: string; data: string };
    expect(call.to).toBe(BASE_GAS_PRICE_ORACLE); expect(params[1]).toEqual({ blockHash, requireCanonical: true });
    const parsed = oracle.parseTransaction({ data: call.data })!;
    if (parsed.name === 'getL1Fee') {
      expect(parsed.args[0]).toBe(Transaction.from(transaction).unsignedSerialized);
      return oracle.encodeFunctionResult(parsed.name, [500n]);
    }
    if (parsed.name === 'getL1FeeUpperBound') {
      expect(parsed.args[0]).toBe(BigInt((Transaction.from(transaction).unsignedSerialized.length - 2) / 2));
      return oracle.encodeFunctionResult(parsed.name, [700n]);
    }
    expect(parsed.name).toBe('getOperatorFee'); expect(parsed.args[0]).toBe(transaction.gasLimit);
    return oracle.encodeFunctionResult(parsed.name, [100n]);
  });
  const readers: BaseFeeReader[] = [{ operatorId: 'one', request }, { operatorId: 'two', request }];
  return { readers, request, calls };
}
test('quotes execution, L1 publication and operator costs for exact unsigned bytes at one canonical block', async () => {
  const f = fixture(), quote = await estimateBaseTransactionFees(f.readers, transaction, blockHash);
  expect(quote).toMatchObject({ executionFeeMaxWei: 200000n, l1FeeEstimateWei: 700n,
    operatorFeeEstimateWei: 100n, totalEstimateWei: 200800n });
  expect(f.calls.filter(call => call.method === 'eth_call')).toHaveLength(6);
  expect(quote.totalEstimateWei).toBeGreaterThan(transaction.gasLimit * transaction.maxFeePerGas);
});
test('independent operators, chain, canonical hash, oracle availability and agreement all fail closed', async () => {
  const f = fixture();
  await expect(estimateBaseTransactionFees([f.readers[0], f.readers[0]], transaction, blockHash)).rejects.toThrow('configuration_invalid');
  await expect(estimateBaseTransactionFees(f.readers, transaction, 'latest')).rejects.toThrow('configuration_invalid');
  await expect(estimateBaseTransactionFees(f.readers, { ...transaction, chainId: 1 }, blockHash)).rejects.toThrow('transaction_invalid');
  f.request.mockResolvedValueOnce('0x1');
  await expect(estimateBaseTransactionFees(f.readers, transaction, blockHash)).rejects.toThrow('chain_invalid');
  const bad: BaseFeeReader = { operatorId: 'bad', request: async method => method === 'eth_chainId' ? '0x2105' : '0x' };
  await expect(estimateBaseTransactionFees([f.readers[0], bad], transaction, blockHash)).rejects.toThrow('oracle_invalid');
  bad.request = async method => method === 'eth_chainId' ? '0x2105' : oracle.encodeFunctionResult('getL1Fee', [999n]);
  await expect(estimateBaseTransactionFees([f.readers[0], bad], transaction, blockHash)).rejects.toThrow('rpc_disagreement');
  bad.request = async () => { throw Error('canonical block unavailable'); };
  await expect(estimateBaseTransactionFees([f.readers[0], bad], transaction, blockHash)).rejects.toThrow('canonical block unavailable');
});
