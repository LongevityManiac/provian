import {
  ERC20_TRANSFER_TOPIC,
  hashBaseTransactionEvidence,
  type BaseTransactionEvidence,
  type CanonicalEconomicLog,
} from '../../onchain/economic-discovery';

export const TEST_BLOCK = 60_000_000;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;

export const topicOf = (address: string): string => `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;

/** A well-formed ERC-20 Transfer log in one test transaction. */
export function transferLog(
  txHash: string,
  token: string,
  from: string,
  to: string,
  amount: bigint,
  logIndex: number,
): CanonicalEconomicLog {
  return {
    address: token.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC, topicOf(from), topicOf(to)],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
    blockNumber: TEST_BLOCK,
    blockHash: BLOCK_HASH,
    transactionHash: txHash.toLowerCase(),
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

/** Whole-transaction evidence, hashed the way production hashes it. */
export function transactionEvidence(
  over: Partial<Omit<BaseTransactionEvidence, 'evidenceHash'>> & {
    readonly transactionHash: string;
    readonly fromAddress: string;
  },
): BaseTransactionEvidence {
  const base: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-transaction-evidence/v1',
    chainId: 8453,
    blockNumber: TEST_BLOCK,
    blockHash: BLOCK_HASH,
    blockTimestampMs: 0,
    confirmationFloor: 12,
    providerOperatorIds: ['op-a', 'op-b'],
    toAddress: null,
    valueWei: '0',
    inputEmpty: false,
    transactionSelector: null,
    logs: [],
    ...over,
  };
  const normalized = {
    ...base,
    transactionHash: base.transactionHash.toLowerCase(),
    fromAddress: base.fromAddress.toLowerCase(),
    toAddress: base.toAddress === null ? null : base.toAddress.toLowerCase(),
  };
  return { ...normalized, evidenceHash: hashBaseTransactionEvidence(normalized) };
}
