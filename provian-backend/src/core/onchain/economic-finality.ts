import { ethers } from 'ethers';
import { timeBurnStep } from './burn-timing';
import { readCommonCanonicalHead } from './common-canonical-head';

import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from './economic-constants';
import { getOperatorBoundRpcLegs } from './rpc-provider';

export const BASE_ECONOMIC_CHAIN_ID = 8453;

export interface EconomicFinalityEvidence {
  readonly schemaVersion: 'base-economic-finality/v1';
  readonly chainId: typeof BASE_ECONOMIC_CHAIN_ID;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  /** Exact head agreed independently by both operator-bound RPC legs. */
  readonly headBlockNumber: number;
  readonly confirmations: number;
  readonly providerOperatorIds: readonly [string, string];
  readonly observedAtMs: number;
}

export interface EconomicFinalityResult {
  /** Minimal receipt surface used by exact event reconciliation. */
  readonly receipt: ethers.TransactionReceipt;
  readonly evidence: EconomicFinalityEvidence;
}

export interface EconomicFinalityRpcLeg {
  readonly operatorId: string;
  readonly send: (method: string, params: readonly unknown[]) => Promise<unknown>;
}

const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const BLOCK_HASH = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA = /^0x[a-fA-F0-9]*$/;
const ECONOMIC_FINALITY_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'chainId',
  'transactionHash',
  'blockNumber',
  'blockHash',
  'headBlockNumber',
  'confirmations',
  'providerOperatorIds',
  'observedAtMs',
] as const);

interface CanonicalLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly removed: boolean;
}

interface CanonicalReceipt {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: number;
  readonly status: number;
  readonly from: string;
  readonly to: string | null;
  readonly logs: readonly CanonicalLog[];
}

interface CanonicalBlock {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
}

function parseQuantity(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`economic_finality_quantity_invalid:${label}`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`economic_finality_quantity_unsafe:${label}`);
  }
  return Number(parsed);
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !BLOCK_HASH.test(value)) {
    throw new Error(`economic_finality_hash_invalid:${label}`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new Error(`economic_finality_address_invalid:${label}`);
  }
  return value.toLowerCase();
}

function normalizeLog(value: unknown, index: number): CanonicalLog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`economic_finality_log_invalid:${index}`);
  }
  const log = value as Record<string, unknown>;
  if (!Array.isArray(log.topics)
    || log.topics.some((topic) => typeof topic !== 'string' || !BLOCK_HASH.test(topic))
    || typeof log.data !== 'string'
    || !HEX_DATA.test(log.data)) {
    throw new Error(`economic_finality_log_invalid:${index}`);
  }
  return Object.freeze({
    address: normalizeAddress(log.address, `log.${index}.address`) as string,
    topics: Object.freeze(log.topics.map((topic) => String(topic).toLowerCase())),
    data: log.data.toLowerCase(),
    blockHash: normalizeHash(log.blockHash, `log.${index}.blockHash`),
    blockNumber: parseQuantity(log.blockNumber, `log.${index}.blockNumber`),
    transactionHash: normalizeHash(log.transactionHash, `log.${index}.transactionHash`),
    transactionIndex: parseQuantity(log.transactionIndex, `log.${index}.transactionIndex`),
    logIndex: parseQuantity(log.logIndex, `log.${index}.logIndex`),
    removed: log.removed === false ? false : (() => {
      throw new Error(`economic_finality_log_removed_invalid:${index}`);
    })(),
  });
}

function normalizeReceipt(value: unknown): CanonicalReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('economic_finality_receipt_invalid');
  }
  const receipt = value as Record<string, unknown>;
  if (!Array.isArray(receipt.logs)) throw new Error('economic_finality_receipt_logs_invalid');
  const status = parseQuantity(receipt.status, 'receipt.status');
  if (status !== 0 && status !== 1) throw new Error('economic_finality_receipt_status_invalid');
  const normalized = {
    transactionHash: normalizeHash(receipt.transactionHash, 'receipt.transactionHash'),
    blockHash: normalizeHash(receipt.blockHash, 'receipt.blockHash'),
    blockNumber: parseQuantity(receipt.blockNumber, 'receipt.blockNumber'),
    status,
    from: normalizeAddress(receipt.from, 'receipt.from') as string,
    to: normalizeAddress(receipt.to, 'receipt.to', true),
    logs: Object.freeze(receipt.logs.map(normalizeLog)),
  };
  for (const [index, log] of normalized.logs.entries()) {
    if (log.blockHash !== normalized.blockHash
      || log.blockNumber !== normalized.blockNumber
      || log.transactionHash !== normalized.transactionHash) {
      throw new Error(`economic_finality_log_receipt_mismatch:${index}`);
    }
  }
  return Object.freeze(normalized);
}

function normalizeBlock(value: unknown): CanonicalBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('economic_finality_block_invalid');
  }
  const block = value as Record<string, unknown>;
  return Object.freeze({
    number: parseQuantity(block.number, 'block.number'),
    hash: normalizeHash(block.hash, 'block.hash'),
    parentHash: normalizeHash(block.parentHash, 'block.parentHash'),
    timestamp: parseQuantity(block.timestamp, 'block.timestamp'),
  });
}

function exactAgreement<T>(left: T, right: T, label: string): T {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`economic_finality_rpc_disagreement:${label}`);
  }
  return left;
}

function configuredLegs(): readonly [EconomicFinalityRpcLeg, EconomicFinalityRpcLeg] {
  const legs = getOperatorBoundRpcLegs('base');
  return [
    { operatorId: legs[0].operatorId, send: (method, params) => legs[0].provider.send(method, [...params]) },
    { operatorId: legs[1].operatorId, send: (method, params) => legs[1].provider.send(method, [...params]) },
  ];
}

async function readBoth(
  legs: readonly [EconomicFinalityRpcLeg, EconomicFinalityRpcLeg],
  method: string,
  params: readonly unknown[],
): Promise<readonly [unknown, unknown]> {
  return Promise.all([
    timeBurnStep(`verify_${legs[0].operatorId}_${method}`, () => legs[0].send(method, params)),
    timeBurnStep(`verify_${legs[1].operatorId}_${method}`, () => legs[1].send(method, params)),
  ]);
}

function asConsumerReceipt(receipt: CanonicalReceipt, confirmations: number): ethers.TransactionReceipt {
  const logs = receipt.logs.map((log) => ({
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    index: log.logIndex,
    removed: log.removed,
  })) as unknown as readonly ethers.Log[];
  return Object.freeze({
    hash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    from: receipt.from,
    to: receipt.to,
    logs,
    confirmations: async () => confirmations,
  }) as unknown as ethers.TransactionReceipt;
}

export function assertBaseEconomicFinalityEvidence(
  value: EconomicFinalityEvidence | undefined,
  expectedTxHash?: string,
): EconomicFinalityEvidence {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== ECONOMIC_FINALITY_EVIDENCE_KEYS.length
    || ECONOMIC_FINALITY_EVIDENCE_KEYS.some((key) =>
      !Object.prototype.hasOwnProperty.call(value, key))
    || value.schemaVersion !== 'base-economic-finality/v1'
    || value.chainId !== BASE_ECONOMIC_CHAIN_ID
    || !TX_HASH.test(value.transactionHash)
    || (expectedTxHash !== undefined
      && value.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase())
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber < 0
    || !BLOCK_HASH.test(value.blockHash)
    || !Number.isSafeInteger(value.headBlockNumber)
    || value.headBlockNumber < value.blockNumber
    || !Number.isSafeInteger(value.confirmations)
    || value.confirmations !== value.headBlockNumber - value.blockNumber + 1
    || value.confirmations < BASE_ECONOMIC_FINALITY_CONFIRMATIONS
    || !Array.isArray(value.providerOperatorIds)
    || value.providerOperatorIds.length !== 2
    || value.providerOperatorIds.some((id) => !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id))
    || value.providerOperatorIds[0] === value.providerOperatorIds[1]
    || !Number.isSafeInteger(value.observedAtMs)
    || value.observedAtMs < 0) {
    throw new Error('base_economic_finality_evidence_invalid');
  }
  return value;
}

async function verifyOnce(
  transactionHash: string,
  options: {
    readonly expectedTo?: string;
    readonly now?: () => number;
    readonly rpcLegs?: readonly [EconomicFinalityRpcLeg, EconomicFinalityRpcLeg];
  },
): Promise<EconomicFinalityResult> {
  const legs = options.rpcLegs ?? configuredLegs();
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_finality_rpc_operators_not_independent');
  }
  const [leftChainRaw, rightChainRaw] = await readBoth(legs, 'eth_chainId', []);
  const chainId = exactAgreement(
    parseQuantity(leftChainRaw, 'chain.left'),
    parseQuantity(rightChainRaw, 'chain.right'),
    'chain_id',
  );
  if (chainId !== BASE_ECONOMIC_CHAIN_ID) {
    throw new Error(`economic_finality_chain_mismatch:${chainId}`);
  }
  const [leftRaw, rightRaw] = await readBoth(
    legs,
    'eth_getTransactionReceipt',
    [transactionHash],
  );
  if (leftRaw === null || rightRaw === null) throw new Error('economic_finality_receipt_pending');
  const receipt = exactAgreement(
    normalizeReceipt(leftRaw),
    normalizeReceipt(rightRaw),
    'receipt',
  );
  if (receipt.transactionHash !== transactionHash.toLowerCase()) {
    throw new Error('economic_finality_transaction_hash_mismatch');
  }
  if (receipt.status !== 1) throw new Error('economic_finality_transaction_failed');
  if (options.expectedTo !== undefined
    && receipt.to?.toLowerCase() !== options.expectedTo.toLowerCase()) {
    throw new Error('economic_finality_contract_mismatch');
  }

  const [leftBlockRaw, rightBlockRaw] = await readBoth(
    legs,
    'eth_getBlockByHash',
    [receipt.blockHash, false],
  );
  if (leftBlockRaw === null || rightBlockRaw === null) {
    throw new Error('economic_finality_receipt_block_missing');
  }
  const block = exactAgreement(
    normalizeBlock(leftBlockRaw),
    normalizeBlock(rightBlockRaw),
    'receipt_block',
  );
  if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) {
    throw new Error('economic_finality_receipt_block_mismatch');
  }

  const headBlockNumber = Number(await readCommonCanonicalHead(legs, 'economic_finality_rpc_disagreement:head'));
  if (headBlockNumber < receipt.blockNumber) {
    throw new Error('economic_finality_head_before_receipt');
  }
  // A hash lookup can still return an orphaned block after a reorg. Re-read
  // the canonical block at the receipt height *after* the agreed head and bind
  // it back to the receipt hash. This also detects a reorg that occurs between
  // the earlier receipt/hash lookup and confirmation calculation.
  const canonicalBlockTag = ethers.toQuantity(receipt.blockNumber);
  const [leftCanonicalRaw, rightCanonicalRaw] = await readBoth(
    legs,
    'eth_getBlockByNumber',
    [canonicalBlockTag, false],
  );
  if (leftCanonicalRaw === null || rightCanonicalRaw === null) {
    throw new Error('economic_finality_canonical_receipt_block_missing');
  }
  const canonicalBlock = exactAgreement(
    normalizeBlock(leftCanonicalRaw),
    normalizeBlock(rightCanonicalRaw),
    'canonical_receipt_block',
  );
  if (canonicalBlock.number !== receipt.blockNumber
    || canonicalBlock.hash !== receipt.blockHash) {
    throw new Error('economic_finality_receipt_block_not_canonical');
  }

  // Confirmation arithmetic must be later than the canonical-height check.
  // Otherwise a height-reducing reorg could leave us holding an old head=111,
  // observe block 100 canonical on the replacement chain at head=105, and
  // incorrectly persist 12 confirmations. A decreasing sandwich fails closed.
  const postCanonicalHeadBlockNumber = Number(await readCommonCanonicalHead(legs, 'economic_finality_rpc_disagreement:post_canonical_head'));
  if (postCanonicalHeadBlockNumber < headBlockNumber) {
    throw new Error('economic_finality_head_regressed_during_verification');
  }
  if (postCanonicalHeadBlockNumber < receipt.blockNumber) {
    throw new Error('economic_finality_head_before_receipt');
  }
  const [leftFinalCanonicalRaw, rightFinalCanonicalRaw] = await readBoth(
    legs,
    'eth_getBlockByNumber',
    [canonicalBlockTag, false],
  );
  if (leftFinalCanonicalRaw === null || rightFinalCanonicalRaw === null) {
    throw new Error('economic_finality_canonical_receipt_block_missing');
  }
  const finalCanonicalBlock = exactAgreement(
    normalizeBlock(leftFinalCanonicalRaw),
    normalizeBlock(rightFinalCanonicalRaw),
    'final_canonical_receipt_block',
  );
  if (finalCanonicalBlock.number !== receipt.blockNumber
    || finalCanonicalBlock.hash !== receipt.blockHash) {
    throw new Error('economic_finality_receipt_block_not_canonical');
  }
  const confirmations = postCanonicalHeadBlockNumber - receipt.blockNumber + 1;
  if (confirmations < BASE_ECONOMIC_FINALITY_CONFIRMATIONS) {
    throw new Error(
      `economic_finality_confirmations_pending:${confirmations}/${BASE_ECONOMIC_FINALITY_CONFIRMATIONS}`,
    );
  }
  const evidence: EconomicFinalityEvidence = {
    schemaVersion: 'base-economic-finality/v1',
    chainId: BASE_ECONOMIC_CHAIN_ID,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    headBlockNumber: postCanonicalHeadBlockNumber,
    confirmations,
    providerOperatorIds: [legs[0].operatorId, legs[1].operatorId],
    observedAtMs: (options.now ?? Date.now)(),
  };
  assertBaseEconomicFinalityEvidence(evidence, transactionHash);
  return Object.freeze({
    receipt: asConsumerReceipt(receipt, confirmations),
    evidence: Object.freeze(evidence),
  });
}

/**
 * Verify one exact Base transaction using raw reads from two independently
 * operated RPC legs. Receipt, receipt block, and head must agree exactly; the
 * confirmation count is calculated from that agreed uncached head. Live waits
 * poll this same primitive and never use FallbackProvider.waitForTransaction()
 * or receipt.confirmations().
 */
export async function verifyBaseEconomicTransactionFinality(
  transactionHash: string,
  options: {
    readonly expectedTo?: string;
    readonly waitForConfirmations?: boolean;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly now?: () => number;
    readonly rpcLegs?: readonly [EconomicFinalityRpcLeg, EconomicFinalityRpcLeg];
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<EconomicFinalityResult> {
  if (!TX_HASH.test(transactionHash)) throw new Error('economic_finality_tx_hash_invalid');
  if (options.expectedTo !== undefined && !ethers.isAddress(options.expectedTo)) {
    throw new Error('economic_finality_expected_contract_invalid');
  }
  const wait = options.waitForConfirmations === true;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('economic_finality_wait_options_invalid');
  }
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return await verifyOnce(transactionHash, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!wait
        || message.includes('transaction_failed')
        || message.includes('contract_mismatch')
        || message.includes('transaction_hash_mismatch')) {
        throw error;
      }
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw lastError ?? new Error('economic_finality_wait_timeout');
}

export interface BaseInclusionResult {
  /** The receipt both operator-bound legs returned, in exact agreement. */
  readonly receipt: ethers.TransactionReceipt;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly providerOperatorIds: readonly [string, string];
}

/**
 * accept a Base transaction at INCLUSION in one block.
 *
 * Inclusion means MINED: both operator-bound legs return the same receipt, and both return the same
 * canonical block at the receipt's height, whose hash is the receipt's block hash. A pending or
 * mempool transaction has no receipt, so it is never accepted — a same-nonce replacement can never
 * buy anything. A transaction whose receipt reverted is refused.
 *
 * the two-provider check stays. Each pair of reads is issued to both legs concurrently
 * (`readBoth`, one Promise.all), and the chain-id read runs beside the receipt read, so the check is
 * two round trips — the same depth as one leg. Either leg disagreeing, or answering null while the
 * other answers, refuses (`economic_inclusion_receipt_pending` / `economic_finality_rpc_disagreement`).
 *
 * This is NOT finality. Every caller that accepts at inclusion must still run
 * {@link verifyBaseEconomicTransactionFinality} (12 confirmations) on the same transaction and undo
 * what it granted when that check fails. `economic_inclusion_receipt_absent` is reported only when BOTH
 * legs say the transaction has no receipt — the one answer a caller may treat as "not on chain".
 */
export async function verifyBaseTransactionInclusion(
  transactionHash: string,
  options: {
    readonly expectedTo?: string;
    readonly rpcLegs?: readonly [EconomicFinalityRpcLeg, EconomicFinalityRpcLeg];
  } = {},
): Promise<BaseInclusionResult> {
  if (!TX_HASH.test(transactionHash)) throw new Error('economic_finality_tx_hash_invalid');
  if (options.expectedTo !== undefined && !ethers.isAddress(options.expectedTo)) {
    throw new Error('economic_finality_expected_contract_invalid');
  }
  const legs = options.rpcLegs ?? configuredLegs();
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_finality_rpc_operators_not_independent');
  }
  const [[leftChainRaw, rightChainRaw], [leftRaw, rightRaw]] = await Promise.all([
    readBoth(legs, 'eth_chainId', []),
    readBoth(legs, 'eth_getTransactionReceipt', [transactionHash]),
  ]);
  const chainId = exactAgreement(
    parseQuantity(leftChainRaw, 'chain.left'),
    parseQuantity(rightChainRaw, 'chain.right'),
    'chain_id',
  );
  if (chainId !== BASE_ECONOMIC_CHAIN_ID) {
    throw new Error(`economic_finality_chain_mismatch:${chainId}`);
  }
  if (leftRaw === null && rightRaw === null) throw new Error('economic_inclusion_receipt_absent');
  if (leftRaw === null || rightRaw === null) throw new Error('economic_inclusion_receipt_pending');
  const receipt = exactAgreement(
    normalizeReceipt(leftRaw),
    normalizeReceipt(rightRaw),
    'receipt',
  );
  if (receipt.transactionHash !== transactionHash.toLowerCase()) {
    throw new Error('economic_finality_transaction_hash_mismatch');
  }
  if (receipt.status !== 1) throw new Error('economic_finality_transaction_failed');
  if (options.expectedTo !== undefined
    && receipt.to?.toLowerCase() !== options.expectedTo.toLowerCase()) {
    throw new Error('economic_finality_contract_mismatch');
  }
  // The receipt must sit in the block each leg holds canonical at that height — a receipt from a
  // block already reorged out is refused, never accepted.
  const [leftCanonicalRaw, rightCanonicalRaw] = await readBoth(
    legs,
    'eth_getBlockByNumber',
    [ethers.toQuantity(receipt.blockNumber), false],
  );
  if (leftCanonicalRaw === null || rightCanonicalRaw === null) {
    throw new Error('economic_inclusion_receipt_pending');
  }
  const canonicalBlock = exactAgreement(
    normalizeBlock(leftCanonicalRaw),
    normalizeBlock(rightCanonicalRaw),
    'canonical_receipt_block',
  );
  if (canonicalBlock.number !== receipt.blockNumber
    || canonicalBlock.hash !== receipt.blockHash) {
    throw new Error('economic_finality_receipt_block_not_canonical');
  }
  return Object.freeze({
    receipt: asConsumerReceipt(receipt, 1),
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    providerOperatorIds: Object.freeze([legs[0].operatorId, legs[1].operatorId]) as readonly [string, string],
  });
}
