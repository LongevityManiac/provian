import { ethers } from 'ethers';

import {
  assertPreparedEconomicContractCall,
  assertPreparedEconomicTransaction,
  broadcastPreparedEconomicTransaction,
  type ExpectedEconomicContractCall,
  type PreparedEconomicTransaction,
} from './prepared-economic-transaction';

const CONTRACT = '0x000000000000000000000000000000000000aaaa';
const OTHER_CONTRACT = '0x000000000000000000000000000000000000bbbb';
const INTERFACE = new ethers.Interface([
  'function intended(bytes32 first, bytes32 second)',
  'function other(bytes32 first, bytes32 second)',
]);
const FIRST = ethers.id('first');
const SECOND = ethers.id('second');
const INTENDED_DATA = INTERFACE.encodeFunctionData('intended', [FIRST, SECOND]);

function fixture(
  data = INTENDED_DATA,
  to = CONTRACT,
  nonce = 4,
  value = 0n,
): PreparedEconomicTransaction {
  const wallet = new ethers.Wallet(`0x${'1'.repeat(64)}`);
  const tx = ethers.Transaction.from({
    type: 0,
    chainId: 8453,
    nonce,
    gasPrice: 1n,
    gasLimit: 100_000n,
    to,
    value,
    data,
  });
  tx.signature = wallet.signingKey.sign(tx.unsignedHash);
  return {
    schemaVersion: 'prepared-base-economic-transaction/v1',
    transactionHash: tx.hash!,
    rawTransaction: tx.serialized,
    nonce: tx.nonce,
    to: tx.to!,
    dataHash: ethers.keccak256(tx.data),
    chainId: 8453,
  };
}

function expectedCall(
  overrides: Partial<ExpectedEconomicContractCall> = {},
): ExpectedEconomicContractCall {
  return {
    chainId: 8453,
    to: CONTRACT,
    data: INTENDED_DATA,
    value: 0n,
    ...overrides,
  };
}

describe('pre-persisted signed Base economic transactions', () => {
  it('binds raw bytes, hash, nonce, chain, target, and calldata before broadcast', () => {
    const prepared = fixture();
    expect(assertPreparedEconomicTransaction(prepared)).toBe(prepared);
    expect(() => assertPreparedEconomicTransaction({
      ...prepared,
      transactionHash: `0x${'f'.repeat(64)}`,
    })).toThrow('prepared_economic_transaction_binding_invalid');
    expect(() => assertPreparedEconomicTransaction({
      ...prepared,
      nonce: prepared.nonce + 1,
    })).toThrow('prepared_economic_transaction_binding_invalid');
  });

  it.each([
    ['wrong selector', INTERFACE.encodeFunctionData('other', [FIRST, SECOND]), CONTRACT],
    ['wrong argument', INTERFACE.encodeFunctionData('intended', [FIRST, ethers.id('wrong')]), CONTRACT],
    ['reordered arguments', INTERFACE.encodeFunctionData('intended', [SECOND, FIRST]), CONTRACT],
    ['wrong target', INTENDED_DATA, OTHER_CONTRACT],
    ['unintended signed bytes', '0x12345678', CONTRACT],
  ])('rejects self-consistent signed bytes for the %s', (_label, data, to) => {
    const prepared = fixture(data, to);
    expect(assertPreparedEconomicTransaction(prepared)).toBe(prepared);
    expect(() => assertPreparedEconomicContractCall(prepared, expectedCall()))
      .toThrow('prepared_economic_transaction_intent_mismatch');
  });

  it('optionally binds the durable nonce and transaction hash', () => {
    const prepared = fixture();
    expect(assertPreparedEconomicContractCall(prepared, expectedCall({
      nonce: prepared.nonce,
      transactionHash: prepared.transactionHash,
    }))).toBe(prepared);
    expect(() => assertPreparedEconomicContractCall(prepared, expectedCall({
      nonce: prepared.nonce + 1,
    }))).toThrow('prepared_economic_transaction_intent_mismatch');
  });

  it('rejects correct target and calldata when the signed transaction carries one wei', () => {
    const prepared = fixture(INTENDED_DATA, CONTRACT, 4, 1n);
    expect(assertPreparedEconomicTransaction(prepared)).toBe(prepared);
    expect(() => assertPreparedEconomicContractCall(prepared, expectedCall()))
      .toThrow('prepared_economic_transaction_intent_mismatch');
  });

  it('requires the provider response to preserve the precomputed hash', async () => {
    const prepared = fixture();
    const broadcastTransaction = jest.fn(async () => ({ hash: prepared.transactionHash }));
    const contract = {
      getAddress: async () => CONTRACT,
      runner: { provider: { broadcastTransaction } },
    } as unknown as ethers.Contract;
    await expect(broadcastPreparedEconomicTransaction(contract, prepared, expectedCall()))
      .resolves.toBeUndefined();
    expect(broadcastTransaction).toHaveBeenCalledWith(prepared.rawTransaction);

    broadcastTransaction.mockResolvedValueOnce({ hash: `0x${'e'.repeat(64)}` });
    await expect(broadcastPreparedEconomicTransaction(contract, prepared, expectedCall()))
      .rejects.toThrow('economic_transaction_broadcast_hash_mismatch');
  });
});
