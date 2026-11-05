import { ethers } from 'ethers';

import { BASE_ECONOMIC_CHAIN_ID } from './economic-finality';

const HASH = /^0x[a-fA-F0-9]{64}$/;
const RAW_TRANSACTION = /^0x[a-fA-F0-9]+$/;
const MAX_RAW_TRANSACTION_HEX_LENGTH = 1_000_000;

export interface PreparedEconomicTransaction {
  readonly schemaVersion: 'prepared-base-economic-transaction/v1';
  readonly transactionHash: string;
  readonly rawTransaction: string;
  readonly nonce: number;
  readonly to: string;
  readonly dataHash: string;
  readonly chainId: typeof BASE_ECONOMIC_CHAIN_ID;
}

/**
 * Independently derived intent for a signed economic transaction.
 *
 * This is deliberately the full calldata, not only a selector or hash. The
 * caller derives it from the canonical ABI plus durable authoritative state;
 * the prepared transaction is then required to match it byte-for-byte.
 */
export interface ExpectedEconomicContractCall {
  readonly chainId: typeof BASE_ECONOMIC_CHAIN_ID;
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
  readonly nonce?: number;
  readonly transactionHash?: string;
}

export interface EconomicTransactionBroadcaster {
  readonly prepare: (
    contract: ethers.Contract,
    functionName: string,
    args: readonly unknown[],
  ) => Promise<PreparedEconomicTransaction>;
  readonly broadcast: (
    contract: ethers.Contract,
    prepared: PreparedEconomicTransaction,
    expectedCall: ExpectedEconomicContractCall,
  ) => Promise<void>;
}

export function assertPreparedEconomicTransaction(
  value: PreparedEconomicTransaction | undefined,
): PreparedEconomicTransaction {
  if (!value
    || value.schemaVersion !== 'prepared-base-economic-transaction/v1'
    || !HASH.test(value.transactionHash)
    || !RAW_TRANSACTION.test(value.rawTransaction)
    || value.rawTransaction.length > MAX_RAW_TRANSACTION_HEX_LENGTH
    || !Number.isSafeInteger(value.nonce)
    || value.nonce < 0
    || !ethers.isAddress(value.to)
    || !HASH.test(value.dataHash)
    || value.chainId !== BASE_ECONOMIC_CHAIN_ID) {
    throw new Error('prepared_economic_transaction_invalid');
  }
  let decoded: ethers.Transaction;
  try {
    decoded = ethers.Transaction.from(value.rawTransaction);
  } catch {
    throw new Error('prepared_economic_transaction_invalid');
  }
  if (!decoded.hash
    || decoded.hash.toLowerCase() !== value.transactionHash.toLowerCase()
    || decoded.nonce !== value.nonce
    || decoded.chainId !== BigInt(BASE_ECONOMIC_CHAIN_ID)
    || decoded.to?.toLowerCase() !== value.to.toLowerCase()
    || ethers.keccak256(decoded.data).toLowerCase() !== value.dataHash.toLowerCase()
    || decoded.signature === null) {
    throw new Error('prepared_economic_transaction_binding_invalid');
  }
  return value;
}

/**
 * Bind self-consistent signed bytes to the independently intended operation.
 * This must run before persistence, every broadcast/rebroadcast, and economic
 * finalization. A correctly signed transaction for a different call is still
 * rejected.
 */
export function assertPreparedEconomicContractCall(
  value: PreparedEconomicTransaction | undefined,
  expected: ExpectedEconomicContractCall,
): PreparedEconomicTransaction {
  const prepared = assertPreparedEconomicTransaction(value);
  if (expected.chainId !== BASE_ECONOMIC_CHAIN_ID
    || !ethers.isAddress(expected.to)
    || !ethers.isHexString(expected.data)
    || typeof expected.value !== 'bigint'
    || expected.value < 0n
    || (expected.nonce !== undefined
      && (!Number.isSafeInteger(expected.nonce) || expected.nonce < 0))
    || (expected.transactionHash !== undefined && !HASH.test(expected.transactionHash))) {
    throw new Error('expected_economic_contract_call_invalid');
  }
  const decoded = ethers.Transaction.from(prepared.rawTransaction);
  const expectedDataHash = ethers.keccak256(expected.data);
  if (prepared.chainId !== expected.chainId
    || decoded.chainId !== BigInt(expected.chainId)
    || prepared.to.toLowerCase() !== expected.to.toLowerCase()
    || decoded.to?.toLowerCase() !== expected.to.toLowerCase()
    || decoded.data.toLowerCase() !== expected.data.toLowerCase()
    || decoded.value !== expected.value
    || prepared.dataHash.toLowerCase() !== expectedDataHash.toLowerCase()
    || (expected.nonce !== undefined
      && (prepared.nonce !== expected.nonce || decoded.nonce !== expected.nonce))
    || (expected.transactionHash !== undefined
      && (prepared.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase()
        || decoded.hash?.toLowerCase() !== expected.transactionHash.toLowerCase()))) {
    throw new Error('prepared_economic_transaction_intent_mismatch');
  }
  return prepared;
}

export async function prepareSignedEconomicContractCall(
  contract: ethers.Contract,
  functionName: string,
  args: readonly unknown[],
): Promise<PreparedEconomicTransaction> {
  const runner = contract.runner as ethers.Signer | null;
  if (!runner
    || typeof runner.populateTransaction !== 'function'
    || typeof runner.signTransaction !== 'function') {
    throw new Error('economic_transaction_signer_unavailable');
  }
  const to = await contract.getAddress();
  if (!ethers.isAddress(to)) throw new Error('economic_transaction_contract_invalid');
  const data = contract.interface.encodeFunctionData(functionName, [...args]);
  // Current mint, anchor, and epoch operations are non-payable. Make the value
  // explicit in the signed preimage; callers independently expect the same 0n.
  const populated = await runner.populateTransaction({ to, data, value: 0n });
  const rawTransaction = await runner.signTransaction(populated);
  const decoded = ethers.Transaction.from(rawTransaction);
  if (!decoded.hash || decoded.chainId !== BigInt(BASE_ECONOMIC_CHAIN_ID)) {
    throw new Error('economic_transaction_wrong_chain_or_hash_missing');
  }
  const prepared: PreparedEconomicTransaction = Object.freeze({
    schemaVersion: 'prepared-base-economic-transaction/v1',
    transactionHash: decoded.hash.toLowerCase(),
    rawTransaction,
    nonce: decoded.nonce,
    to: to.toLowerCase(),
    dataHash: ethers.keccak256(data),
    chainId: BASE_ECONOMIC_CHAIN_ID,
  });
  return assertPreparedEconomicTransaction(prepared);
}

export async function broadcastPreparedEconomicTransaction(
  contract: ethers.Contract,
  preparedInput: PreparedEconomicTransaction,
  expectedCall: ExpectedEconomicContractCall,
): Promise<void> {
  const prepared = assertPreparedEconomicContractCall(preparedInput, expectedCall);
  const expectedAddress = await contract.getAddress();
  if (prepared.to.toLowerCase() !== expectedAddress.toLowerCase()
    || expectedCall.to.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('prepared_economic_transaction_contract_mismatch');
  }
  const provider = contract.runner?.provider;
  if (!provider) throw new Error('economic_transaction_provider_unavailable');
  const response = await provider.broadcastTransaction(prepared.rawTransaction);
  if (response.hash.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
    throw new Error('economic_transaction_broadcast_hash_mismatch');
  }
}

export const DEFAULT_ECONOMIC_TRANSACTION_BROADCASTER: EconomicTransactionBroadcaster =
  Object.freeze({
    prepare: prepareSignedEconomicContractCall,
    broadcast: broadcastPreparedEconomicTransaction,
  });
