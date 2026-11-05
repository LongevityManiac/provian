import crypto from 'crypto';
import { readCommonCanonicalHead } from './common-canonical-head';
import { assertCompleteTraceTrees, traceChildCount, type TraceTreeNode } from './trace-tree';
import { ethers } from 'ethers';

import { allSettledOrThrow } from '../net/map-bounded';

import { getBaseTraceRpcLegs, getOperatorBoundRpcLegs } from './rpc-provider';
import { rpcChainFactsEqual } from './rpc-chain-facts';
import type { EconomicStateRpcLeg } from './economic-state';

export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const BASE_WATCHER_CONFIRMATION_FLOOR = 12;

const HASH = /^0x[a-fA-F0-9]{64}$/;
const BASE_USDC_EVIDENCE_KEYS = Object.freeze([
  'amountAtomic',
  'blockHash',
  'blockNumber',
  'blockTimestampMs',
  'chainId',
  'confirmationFloor',
  'evidenceHash',
  'fromAddress',
  'logIndex',
  'providerOperatorIds',
  'schemaVersion',
  'toAddress',
  'tokenAddress',
  'transactionHash',
  'transactionSelector',
  'transactionSubmitter',
  'transactionTo',
] as const);

export interface CanonicalEconomicLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly removed: boolean;
}

export interface BaseUsdcTransferEvidence {
  readonly schemaVersion: 'base-usdc-transfer-evidence/v2';
  readonly chainId: 8453;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestampMs: number;
  /** Stable protocol floor, not a retry-dependent live confirmation count. */
  readonly confirmationFloor: typeof BASE_WATCHER_CONFIRMATION_FLOOR;
  readonly providerOperatorIds: readonly [string, string];
  readonly tokenAddress: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountAtomic: string;
  /** Exact outer transaction selector, or null for calldata shorter than four
   * bytes. Classification must not infer EIP-3009 merely from a relayer. */
  readonly transactionSelector: string | null;
  readonly transactionSubmitter: string;
  readonly transactionTo: string | null;
  readonly evidenceHash: string;
}

export interface EconomicDiscoveryOptions {
  /** Test-only injection. Production uses the configured operator-bound legs. */
  readonly rpcLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
  /** Test-only injection: bound/pace the both-legs disagreement re-poll of
   * `agreed()`. Production always uses `DEFAULT_DISAGREEMENT_RETRY`. */
  readonly disagreementRetry?: Partial<DisagreementRetry>;
}

/**
 * Bounded BOTH-legs disagreement re-poll (2026-08-16 production-effect audit,
 * item 3). At Base's 2s block time the two operator-independent legs are
 * routinely one block apart for an instant, and the previous single-shot
 * compare turned that raggedness into a failed watcher cycle (~15-20/day
 * observed across the sibling watchers). On mismatch, BOTH legs are re-issued
 * together and only a byte-identical pair is ever returned — a disagreed
 * answer is NEVER accepted, so the two-operator agreement invariant is
 * untouched; only transient RPC raggedness is absorbed. A persistent split
 * still throws the identical `economic_discovery_rpc_disagreement:<label>`
 * after the bounded attempts. Leg errors are not retried here: a failed
 * provider propagates immediately, exactly as before.
 */
export interface DisagreementRetry {
  /** Total attempts (first poll included). */
  readonly attempts: number;
  /** Pause between attempts, milliseconds. */
  readonly delayMs: number;
}

const DEFAULT_DISAGREEMENT_RETRY: DisagreementRetry = Object.freeze({
  attempts: 4,
  delayMs: 300,
});

function retryOf(options: EconomicDiscoveryOptions): DisagreementRetry {
  const attempts = options.disagreementRetry?.attempts ?? DEFAULT_DISAGREEMENT_RETRY.attempts;
  const delayMs = options.disagreementRetry?.delayMs ?? DEFAULT_DISAGREEMENT_RETRY.delayMs;
  if (!Number.isSafeInteger(attempts) || attempts < 1
    || !Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('economic_discovery_retry_config_invalid');
  }
  return { attempts, delayMs };
}

function configuredLegs(): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = getOperatorBoundRpcLegs('base');
  return [
    {
      operatorId: legs[0].operatorId,
      send: (method, params) => legs[0].provider.send(method, [...params]),
    },
    {
      operatorId: legs[1].operatorId,
      send: (method, params) => legs[1].provider.send(method, [...params]),
    },
  ];
}

function configuredLegsFor(chain: 'arbitrum' | 'optimism'): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = getOperatorBoundRpcLegs(chain);
  return [
    { operatorId: legs[0].operatorId, send: (method, params) => legs[0].provider.send(method, [...params]) },
    { operatorId: legs[1].operatorId, send: (method, params) => legs[1].provider.send(method, [...params]) },
  ];
}

function useLegsFor(
  chain: 'arbitrum' | 'optimism',
  options: EconomicDiscoveryOptions,
): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = options.rpcLegs ?? configuredLegsFor(chain);
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_discovery_operators_not_independent');
  }
  return legs;
}

function useLegs(
  options: EconomicDiscoveryOptions,
): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = options.rpcLegs ?? configuredLegs();
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_discovery_operators_not_independent');
  }
  return legs;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fields a provider adds to a transaction or log object on its own initiative,
 * outside the JSON-RPC result each method is specified to return. One operator
 * serving `blockTimestamp` on `eth_getTransactionByHash` and the other not is a
 * difference in formatting, not in chain facts, and it split every
 * transaction read. Nothing here reads these fields (a block's timestamp comes
 * from the agreed block header), so they are removed from BOTH legs before the
 * comparison. Every specified field is still compared byte for byte, so a leg
 * that omits or changes one still disagrees.
 */
export const PROVIDER_ANNOTATION_FIELDS: readonly string[] = Object.freeze(['blockTimestamp']);

function withoutAnnotations(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of PROVIDER_ANNOTATION_FIELDS) delete copy[key];
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strip provider annotations from the transaction / log objects a method returns. */
export function normalizeProviderReply(method: string, value: unknown): unknown {
  switch (method) {
    case 'eth_getTransactionByHash':
      return isRecord(value) ? withoutAnnotations(value) : value;
    case 'eth_getTransactionReceipt':
      if (!isRecord(value)) return value;
      return Array.isArray(value.logs)
        ? { ...value, logs: value.logs.map((log) => (isRecord(log) ? withoutAnnotations(log) : log)) }
        : value;
    case 'eth_getLogs':
      return Array.isArray(value) ? value.map((log) => (isRecord(log) ? withoutAnnotations(log) : log)) : value;
    case 'eth_getBlockByHash':
    case 'eth_getBlockByNumber':
      if (!isRecord(value) || !Array.isArray(value.transactions)) return value;
      return {
        ...value,
        transactions: value.transactions.map((tx) => (isRecord(tx) ? withoutAnnotations(tx) : tx)),
      };
    default:
      return value;
  }
}

async function agreed(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  method: string,
  params: readonly unknown[],
  label: string,
  retry: DisagreementRetry = DEFAULT_DISAGREEMENT_RETRY,
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    if (method === 'eth_blockNumber') {
      const disagreement = `economic_discovery_rpc_disagreement:${label}`;
      try { return ethers.toQuantity(await readCommonCanonicalHead(legs, disagreement)); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== disagreement || attempt >= retry.attempts) throw error;
        if (retry.delayMs > 0) await new Promise(resolve => setTimeout(resolve, retry.delayMs));
        continue;
      }
    }
    const [left, right] = (await Promise.all([
      legs[0].send(method, params),
      legs[1].send(method, params),
    ])).map((reply) => normalizeProviderReply(method, reply));
    // Only a byte-identical pair is ever returned. A disagreed answer is never
    // accepted — on mismatch both legs are re-polled together, bounded, then
    // the identical disagreement error throws (see DisagreementRetry).
    if (rpcChainFactsEqual(left, right)) return left;
    if (attempt >= retry.attempts) {
      throw new Error(`economic_discovery_rpc_disagreement:${label}`);
    }
    if (retry.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    }
  }
}

async function assertAgreedChain(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  expectedChainId: bigint,
  retry: DisagreementRetry = DEFAULT_DISAGREEMENT_RETRY,
): Promise<void> {
  const chainId = quantity(await agreed(legs, 'eth_chainId', [], 'chain_id', retry), 'chain_id');
  if (chainId !== expectedChainId) throw new Error(`economic_discovery_chain_mismatch:${chainId}`);
}

async function assertAgreedBaseChain(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  retry: DisagreementRetry = DEFAULT_DISAGREEMENT_RETRY,
): Promise<void> {
  await assertAgreedChain(legs, 8453n, retry);
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`economic_discovery_quantity_invalid:${label}`);
  }
  return BigInt(value);
}

function safeNumber(value: unknown, label: string): number {
  const parsed = quantity(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`economic_discovery_number_unsafe:${label}`);
  }
  return Number(parsed);
}

export function normalizeLog(value: unknown): CanonicalEconomicLog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('economic_discovery_log_invalid');
  }
  const log = value as Record<string, unknown>;
  if (typeof log.address !== 'string' || !ethers.isAddress(log.address)
    || !Array.isArray(log.topics)
    || log.topics.some((topic) => typeof topic !== 'string' || !HASH.test(topic))
    || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(log.data)
    || typeof log.blockHash !== 'string' || !HASH.test(log.blockHash)
    || typeof log.transactionHash !== 'string' || !HASH.test(log.transactionHash)) {
    throw new Error('economic_discovery_log_invalid');
  }
  return Object.freeze({
    address: log.address.toLowerCase(),
    topics: Object.freeze((log.topics as string[]).map((topic) => topic.toLowerCase())),
    data: log.data.toLowerCase(),
    blockNumber: safeNumber(log.blockNumber, 'log.blockNumber'),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: safeNumber(log.transactionIndex, 'log.transactionIndex'),
    logIndex: safeNumber(log.logIndex, 'log.logIndex'),
    removed: log.removed === true,
  });
}

export async function readAgreedBaseHead(
  options: EconomicDiscoveryOptions = {},
): Promise<number> {
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);
  return safeNumber(await agreed(legs, 'eth_blockNumber', [], 'head', retry), 'head');
}

/** The safe head projected to the only two fields the reorg floor reads. */
export interface AgreedSafeHead {
  readonly number: number;
  readonly hash: string;
}

/**
 * Project ONE leg's `eth_getBlockByNumber('safe')` reply to `{number, hash}`,
 * or null when the leg reports no safe block yet.
 *
 * Validates the two fields the safe head is actually made of and NOTHING else:
 * a well-formed 32-byte hash and a safe-integer height. Every other field of
 * the block object is irrelevant to the reorg floor and is deliberately dropped
 * before the quorum comparison — see `readAgreedBaseSafeHead`.
 */
function projectSafeHead(block: unknown, label: string): AgreedSafeHead | null {
  if (block === null || block === undefined) return null;
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`economic_discovery_safe_head_invalid:${label}`);
  }
  const record = block as Record<string, unknown>;
  if (typeof record.hash !== 'string' || !HASH.test(record.hash)) {
    throw new Error(`economic_discovery_safe_head_invalid:${label}`);
  }
  return Object.freeze({
    number: safeNumber(record.number, `${label}.number`),
    hash: record.hash.toLowerCase(),
  });
}

/** Read both independent safe tips, then verify their common safe height.
 * Providers may derive L1 batches at different times. Only a different hash at
 * the common height is disagreement; missing/malformed reads remain unavailable.
 * No fallback to an unsafe head is permitted. */
export async function readAgreedBaseSafeHead(
  options: EconomicDiscoveryOptions = {},
): Promise<AgreedSafeHead | null> {
  const legs = useLegs(options);
  await assertAgreedBaseChain(legs, retryOf(options));
  return agreedSafeHeadOnLegs(legs);
}

/** The safe head both legs agree on at their common safe height (see `readAgreedBaseSafeHead`). */
async function agreedSafeHeadOnLegs(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
): Promise<AgreedSafeHead | null> {
  const [left, right] = await Promise.all([
    legs[0].send('eth_getBlockByNumber', ['safe', false]),
    legs[1].send('eth_getBlockByNumber', ['safe', false]),
  ]);
  const a = projectSafeHead(left, 'safe_head.a');
  const b = projectSafeHead(right, 'safe_head.b');
  if (a === null || b === null) return null;
  const height = Math.min(a.number, b.number);
  let commonA = a;
  let commonB = b;
  if (a.number !== b.number) {
    const tag = `0x${height.toString(16)}`;
    const blocks = await Promise.all(legs.map(leg => leg.send('eth_getBlockByNumber', [tag, false])));
    const first = projectSafeHead(blocks[0], 'common_safe_head.a');
    const second = projectSafeHead(blocks[1], 'common_safe_head.b');
    if (first === null || second === null || first.number !== height || second.number !== height) {
      throw new Error('economic_discovery_common_safe_block_unavailable');
    }
    commonA = first;
    commonB = second;
  }
  if (commonA.hash !== commonB.hash) throw new Error('economic_discovery_rpc_disagreement:safe_head');
  return commonA;
}

/**
 * the CANONICAL block hash at one height, quorum-2 on the hash only (the shape:
 * two operator-independent endpoints format block objects differently, so only the field read
 * is compared). The settlement runner reads it to decide whether a settle's receipt is still on
 * the canonical chain at safe depth. Null only when BOTH legs return no block at that height
 * (not yet produced); one leg with a block and one without, or two different hashes, throws —
 * a disagreement is never resolved by trusting either side.
 */
export async function readAgreedBaseBlockHash(
  blockNumber: number,
  options: EconomicDiscoveryOptions = {},
): Promise<string | null> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('economic_discovery_block_number_invalid');
  }
  const legs = useLegs(options);
  await assertAgreedBaseChain(legs, retryOf(options));
  const tag = `0x${blockNumber.toString(16)}`;
  const [left, right] = await Promise.all([
    legs[0].send('eth_getBlockByNumber', [tag, false]),
    legs[1].send('eth_getBlockByNumber', [tag, false]),
  ]);
  const a = projectSafeHead(left, 'block_hash.a');
  const b = projectSafeHead(right, 'block_hash.b');
  if (a === null && b === null) return null;
  if (a === null || b === null || a.number !== b.number || a.hash !== b.hash
    || a.number !== blockNumber) {
    throw new Error('economic_discovery_rpc_disagreement:block_hash');
  }
  return a.hash;
}

/**
 * The widest `eth_getLogs` block range (inclusive) any Base leg accepts. mainnet.base.org began
 * refusing wider ranges ("eth_getLogs is limited to a 500 range", HTTP 413) on 2026-10-05; the
 * watchers' configured chunk was 2,000, so the outbound USDC watcher failed every run and both
 * institution watchers held their cursors for ~40h. A wider request is split here, so no caller's
 * chunk setting (env or default) can exceed it. Providers can reduce the limit again; an explicit
 * smaller range refusal shrinks the next request without advancing the cursor or trusting one leg.
 */
export const BASE_GETLOGS_MAX_RANGE_BLOCKS = 500;

export async function getAgreedBaseLogs(
  filter: {
    // A single address (the USDC watchers) OR an array (the institution watcher,
    // one getLogs across all three contracts). `eth_getLogs` accepts both.
    readonly address: string | readonly string[];
    readonly topics: readonly (string | readonly string[] | null)[];
    readonly fromBlock: number;
    readonly toBlock: number;
  },
  options: EconomicDiscoveryOptions = {},
): Promise<readonly CanonicalEconomicLog[]> {
  const addressList: readonly string[] = typeof filter.address === 'string'
    ? [filter.address]
    : filter.address;
  if (addressList.length === 0
    || !addressList.every((a) => ethers.isAddress(a))
    || !Number.isSafeInteger(filter.fromBlock)
    || !Number.isSafeInteger(filter.toBlock)
    || filter.fromBlock < 0
    || filter.toBlock < filter.fromBlock) {
    throw new Error('economic_discovery_log_filter_invalid');
  }
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);
  // Preserve the single-address wire shape exactly (the USDC watchers); only the
  // array case sends an array. Both legs still receive identical params, so the
  // quorum agreement property is unchanged.
  const rpcAddress: string | string[] = typeof filter.address === 'string'
    ? filter.address.toLowerCase()
    : filter.address.map((a) => a.toLowerCase());
  // Each sub-range is agreed across both legs on its own; a disagreement on any one throws.
  const logs: CanonicalEconomicLog[] = [];
  let rangeBlocks = BASE_GETLOGS_MAX_RANGE_BLOCKS;
  for (let from = filter.fromBlock; from <= filter.toBlock;) {
    const to = Math.min(from + rangeBlocks - 1, filter.toBlock);
    let raw: unknown;
    try {
      raw = await agreed(legs, 'eth_getLogs', [{
        address: rpcAddress,
        topics: filter.topics,
        fromBlock: ethers.toQuantity(from),
        toBlock: ethers.toQuantity(to),
      }], 'logs', retry);
    } catch (error: unknown) {
      // Only the provider's explicit log-range limit is retriable here. A timeout, generic 413,
      // invalid reply or quorum disagreement still refuses the complete read, exactly as before.
      const message = error instanceof Error ? error.message : '';
      const match = /eth_getLogs is limited to (?:a )?(\d+) (?:block )?range/i.exec(message);
      const limit = match ? Number(match[1]) : NaN;
      // A broad known-token stream can hit a result cap even within the allowed
      // height range. Split the SAME range; never treat a capped reply as empty.
      if (/too many (?:results|logs)|query returned more than|response size exceeded/i.test(message)
        && to > from) {
        rangeBlocks = Math.max(1, Math.floor((to - from + 1) / 2));
        continue;
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit >= to - from + 1) throw error;
      rangeBlocks = Math.min(rangeBlocks, limit);
      continue;
    }
    if (!Array.isArray(raw)) throw new Error('economic_discovery_logs_invalid');
    logs.push(...raw.map(normalizeLog));
    from = to + 1;
  }
  logs.sort((a, b) => (a.blockNumber - b.blockNumber)
    || (a.transactionIndex - b.transactionIndex)
    || (a.logIndex - b.logIndex)
    || a.transactionHash.localeCompare(b.transactionHash));
  return Object.freeze(logs);
}

function addressTopic(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
}

export function hashBaseUsdcTransferEvidence(
  value: Omit<BaseUsdcTransferEvidence, 'evidenceHash'>,
): string {
  return `0x${crypto.createHash('sha256').update(canonical({
    ...value,
    providerOperatorIds: [...value.providerOperatorIds],
  }), 'utf8').digest('hex')}`;
}

export function assertBaseUsdcTransferEvidence(
  value: BaseUsdcTransferEvidence | undefined,
  expected?: {
    readonly transactionHash?: string;
    readonly logIndex?: number;
    readonly fromAddress?: string;
    readonly toAddress?: string;
    readonly amountAtomic?: string;
  },
): BaseUsdcTransferEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('base_usdc_transfer_evidence_invalid');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...BASE_USDC_EVIDENCE_KEYS].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || value.schemaVersion !== 'base-usdc-transfer-evidence/v2'
    || value.chainId !== 8453
    || !HASH.test(value.transactionHash)
    || value.transactionHash !== value.transactionHash.toLowerCase()
    || !Number.isSafeInteger(value.logIndex)
    || value.logIndex < 0
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber < 0
    || !HASH.test(value.blockHash)
    || value.blockHash !== value.blockHash.toLowerCase()
    || !Number.isSafeInteger(value.blockTimestampMs)
    || value.blockTimestampMs < 0
    || value.confirmationFloor !== BASE_WATCHER_CONFIRMATION_FLOOR
    || !Array.isArray(value.providerOperatorIds)
    || value.providerOperatorIds.length !== 2
    || typeof value.providerOperatorIds[0] !== 'string'
    || value.providerOperatorIds[0].length === 0
    || typeof value.providerOperatorIds[1] !== 'string'
    || value.providerOperatorIds[1].length === 0
    || value.providerOperatorIds[0] === value.providerOperatorIds[1]
    || !ethers.isAddress(value.tokenAddress)
    || value.tokenAddress !== BASE_USDC_ADDRESS
    || !ethers.isAddress(value.fromAddress)
    || value.fromAddress !== value.fromAddress.toLowerCase()
    || !ethers.isAddress(value.toAddress)
    || value.toAddress !== value.toAddress.toLowerCase()
    || !/^(0|[1-9][0-9]*)$/.test(value.amountAtomic)
    || (value.transactionSelector !== null
      && !/^0x[a-f0-9]{8}$/.test(value.transactionSelector))
    || !ethers.isAddress(value.transactionSubmitter)
    || value.transactionSubmitter !== value.transactionSubmitter.toLowerCase()
    || (value.transactionTo !== null && !ethers.isAddress(value.transactionTo))
    || (value.transactionTo !== null
      && value.transactionTo !== value.transactionTo.toLowerCase())
    || !HASH.test(value.evidenceHash)
    || value.evidenceHash !== value.evidenceHash.toLowerCase()
    || (expected?.transactionHash !== undefined
      && value.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase())
    || (expected?.logIndex !== undefined && value.logIndex !== expected.logIndex)
    || (expected?.fromAddress !== undefined
      && value.fromAddress.toLowerCase() !== expected.fromAddress.toLowerCase())
    || (expected?.toAddress !== undefined
      && value.toAddress.toLowerCase() !== expected.toAddress.toLowerCase())
    || (expected?.amountAtomic !== undefined && value.amountAtomic !== expected.amountAtomic)) {
    throw new Error('base_usdc_transfer_evidence_invalid');
  }
  const { evidenceHash: _hash, ...withoutHash } = value;
  if (hashBaseUsdcTransferEvidence(withoutHash).toLowerCase() !== value.evidenceHash.toLowerCase()) {
    throw new Error('base_usdc_transfer_evidence_hash_mismatch');
  }
  return value;
}

/**
 * Verify the exact USDC log and every transaction field used by watcher
 * classification through two independently operated sources. Confirmation
 * growth is deliberately excluded from the committed evidence.
 */
export async function verifyBaseUsdcTransferEvidence(
  params: {
    readonly transactionHash: string;
    readonly logIndex: number;
    readonly expectedFrom: string;
    readonly expectedTo: string;
    readonly expectedAmountAtomic: string;
  },
  options: EconomicDiscoveryOptions = {},
): Promise<BaseUsdcTransferEvidence> {
  if (!HASH.test(params.transactionHash)
    || !Number.isSafeInteger(params.logIndex)
    || params.logIndex < 0
    || !ethers.isAddress(params.expectedFrom)
    || !ethers.isAddress(params.expectedTo)
    || !/^(0|[1-9][0-9]*)$/.test(params.expectedAmountAtomic)) {
    throw new Error('base_usdc_transfer_request_invalid');
  }
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);
  const head = safeNumber(await agreed(legs, 'eth_blockNumber', [], 'head', retry), 'head');
  const [receiptRaw, transactionRaw] = await Promise.all([
    agreed(legs, 'eth_getTransactionReceipt', [params.transactionHash], 'receipt', retry),
    agreed(legs, 'eth_getTransactionByHash', [params.transactionHash], 'transaction', retry),
  ]);
  if (!receiptRaw || typeof receiptRaw !== 'object' || Array.isArray(receiptRaw)
    || !transactionRaw || typeof transactionRaw !== 'object' || Array.isArray(transactionRaw)) {
    throw new Error('economic_evidence_pending:transaction_unavailable');
  }
  const receipt = receiptRaw as Record<string, unknown>;
  const transaction = transactionRaw as Record<string, unknown>;
  if (quantity(receipt.status, 'receipt.status') !== 1n) {
    throw new Error('economic_evidence_transaction_failed');
  }
  const blockNumber = safeNumber(receipt.blockNumber, 'receipt.blockNumber');
  if (head < blockNumber) throw new Error('economic_evidence_head_before_transaction');
  if (typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash)
    || typeof receipt.transactionHash !== 'string' || !HASH.test(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== params.transactionHash.toLowerCase()
    || !Array.isArray(receipt.logs)) {
    throw new Error('economic_evidence_receipt_invalid');
  }
  const receiptBlockHash = receipt.blockHash.toLowerCase();
  const transfer = receipt.logs.map(normalizeLog).find((log) => log.logIndex === params.logIndex);
  if (!transfer
    || transfer.removed
    || transfer.address !== BASE_USDC_ADDRESS
    || transfer.transactionHash !== params.transactionHash.toLowerCase()
    || transfer.blockNumber !== blockNumber
    || transfer.blockHash !== receiptBlockHash
    || transfer.topics.length !== 3
    || transfer.topics[0] !== ERC20_TRANSFER_TOPIC
    || transfer.topics[1] !== addressTopic(params.expectedFrom)
    || transfer.topics[2] !== addressTopic(params.expectedTo)
    || BigInt(transfer.data).toString() !== params.expectedAmountAtomic) {
    throw new Error('economic_evidence_transfer_mismatch');
  }
  if (typeof transaction.hash !== 'string' || !HASH.test(transaction.hash)
    || transaction.hash.toLowerCase() !== params.transactionHash.toLowerCase()
    || typeof transaction.from !== 'string' || !ethers.isAddress(transaction.from)
    || typeof transaction.blockHash !== 'string' || !HASH.test(transaction.blockHash)
    || transaction.blockHash.toLowerCase() !== receiptBlockHash
    || safeNumber(transaction.blockNumber, 'transaction.blockNumber') !== blockNumber
    || typeof transaction.input !== 'string'
    || !/^0x[0-9a-fA-F]*$/.test(transaction.input)
    || (transaction.input.length % 2) !== 0
    || (transaction.to !== null
      && (typeof transaction.to !== 'string' || !ethers.isAddress(transaction.to)))) {
    throw new Error('economic_evidence_transaction_invalid');
  }
  const blockRaw = await agreed(
    legs,
    'eth_getBlockByHash',
    [receiptBlockHash, false],
    'block',
    retry,
  );
  if (!blockRaw || typeof blockRaw !== 'object' || Array.isArray(blockRaw)) {
    throw new Error('economic_evidence_block_invalid');
  }
  const block = blockRaw as Record<string, unknown>;
  if (typeof block.hash !== 'string'
    || block.hash.toLowerCase() !== receiptBlockHash
    || safeNumber(block.number, 'block.number') !== blockNumber) {
    throw new Error('economic_evidence_block_invalid');
  }
  const timestampSec = quantity(block.timestamp, 'block.timestamp');
  if (timestampSec > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))) {
    throw new Error('economic_evidence_timestamp_unsafe');
  }

  const canonicalTag = ethers.toQuantity(blockNumber);
  const assertCanonicalBlock = async (label: string): Promise<void> => {
    const raw = await agreed(
      legs,
      'eth_getBlockByNumber',
      [canonicalTag, false],
      label,
      retry,
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('economic_evidence_canonical_block_invalid');
    }
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.hash !== 'string'
      || candidate.hash.toLowerCase() !== receiptBlockHash
      || safeNumber(candidate.number, `${label}.number`) !== blockNumber
      || quantity(candidate.timestamp, `${label}.timestamp`) !== timestampSec) {
      throw new Error('economic_evidence_receipt_block_not_canonical');
    }
  };
  await assertCanonicalBlock('canonical_receipt_block');
  const postCanonicalHead = safeNumber(
    await agreed(legs, 'eth_blockNumber', [], 'post_canonical_head', retry),
    'post_canonical_head',
  );
  if (postCanonicalHead < head) {
    throw new Error('economic_evidence_head_regressed_during_verification');
  }
  await assertCanonicalBlock('final_canonical_receipt_block');
  const confirmations = postCanonicalHead - blockNumber + 1;
  if (confirmations < BASE_WATCHER_CONFIRMATION_FLOOR) {
    throw new Error(
      `economic_evidence_pending:confirmations:${confirmations}/${BASE_WATCHER_CONFIRMATION_FLOOR}`,
    );
  }
  const withoutHash: Omit<BaseUsdcTransferEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-usdc-transfer-evidence/v2',
    chainId: 8453,
    transactionHash: params.transactionHash.toLowerCase(),
    logIndex: params.logIndex,
    blockNumber,
    blockHash: receiptBlockHash,
    blockTimestampMs: Number(timestampSec) * 1_000,
    confirmationFloor: BASE_WATCHER_CONFIRMATION_FLOOR,
    providerOperatorIds: [legs[0].operatorId, legs[1].operatorId],
    tokenAddress: BASE_USDC_ADDRESS,
    fromAddress: params.expectedFrom.toLowerCase(),
    toAddress: params.expectedTo.toLowerCase(),
    amountAtomic: params.expectedAmountAtomic,
    transactionSelector: transaction.input.length >= 10
      ? transaction.input.slice(0, 10).toLowerCase()
      : null,
    transactionSubmitter: transaction.from.toLowerCase(),
    transactionTo: typeof transaction.to === 'string' ? transaction.to.toLowerCase() : null,
  };
  return Object.freeze({
    ...withoutHash,
    evidenceHash: hashBaseUsdcTransferEvidence(withoutHash),
  });
}

// =============================================================================
// whole-transaction evidence for the chain-record lane
// =============================================================================

/**
 * The timestamp (ms) of the Base block at `blockNumber`, agreed by both legs on
 * {number, hash, timestamp} (the projection; providers format the rest of a
 * block differently). A block either leg does not have yet throws pending.
 */
export async function readAgreedBaseBlockTimestampMs(
  blockNumber: number,
  options: EconomicDiscoveryOptions = {},
): Promise<number> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('economic_discovery_block_request_invalid');
  }
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);
  const tag = ethers.toQuantity(blockNumber);
  const project = (raw: unknown, label: string): string | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`economic_discovery_block_invalid:${label}`);
    const block = raw as Record<string, unknown>;
    if (typeof block.hash !== 'string' || !HASH.test(block.hash)
      || safeNumber(block.number, `${label}.number`) !== blockNumber) {
      throw new Error(`economic_discovery_block_invalid:${label}`);
    }
    return `${block.hash.toLowerCase()}:${quantity(block.timestamp, `${label}.timestamp`).toString()}`;
  };
  for (let attempt = 1; ; attempt += 1) {
    const [left, right] = await Promise.all([
      legs[0].send('eth_getBlockByNumber', [tag, false]),
      legs[1].send('eth_getBlockByNumber', [tag, false]),
    ]);
    const a = project(left, 'block.a');
    const b = project(right, 'block.b');
    if (a === null && b === null) throw new Error('economic_evidence_pending:block_unavailable');
    if (a !== null && a === b) {
      const seconds = BigInt(a.split(':')[1]);
      if (seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))) {
        throw new Error('economic_evidence_timestamp_unsafe');
      }
      return Number(seconds) * 1_000;
    }
    if (attempt >= retry.attempts) throw new Error('economic_discovery_rpc_disagreement:block_timestamp');
    if (retry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
  }
}

/**
 * One Base transaction as two independently operated sources agree on it, at
 * the watcher confirmation floor AND at or below the agreed L1-derived safe
 * head. The chain-record lane (`core/pvt/chain-record-watcher.ts`)
 * derives an act ONLY from these facts: the sender, the target, the native
 * value, whether calldata was empty, and every log the receipt carries. Nothing
 * an actor submitted (amounts, recipients, tokens) is read.
 */
export interface BaseTransactionEvidence {
  readonly schemaVersion: 'base-transaction-evidence/v1';
  readonly chainId: 8453;
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestampMs: number;
  readonly confirmationFloor: typeof BASE_WATCHER_CONFIRMATION_FLOOR;
  readonly providerOperatorIds: readonly [string, string];
  /** The EOA that submitted (and signed) the transaction, lowercased. */
  readonly fromAddress: string;
  /** The call target, lowercased; null for a contract creation. */
  readonly toAddress: string | null;
  /** Native value in wei, decimal string. */
  readonly valueWei: string;
  /** True only when the transaction carried no calldata at all (`0x`). */
  readonly inputEmpty: boolean;
  readonly transactionSelector: string | null;
  /** Every receipt log, normalized, in log-index order. */
  readonly logs: readonly CanonicalEconomicLog[];
  readonly evidenceHash: string;
}

/**
 * The same facts for a transaction on another EVM chain the wallet transacts on
 * (Arbitrum One, OP Mainnet), read through that chain's two operator-bound legs
 * at the same floor and safe head. Its own schema, so a Base evidence hash never
 * changes.
 */
export const EVM_CHAIN_IDS = Object.freeze({ arbitrum: 42161, optimism: 10 } as const);
export type OtherEvmChain = keyof typeof EVM_CHAIN_IDS;

export interface EvmTransactionEvidence extends Omit<BaseTransactionEvidence, 'schemaVersion' | 'chainId'> {
  readonly schemaVersion: 'evm-transaction-evidence/v1';
  readonly chainId: (typeof EVM_CHAIN_IDS)[OtherEvmChain];
}

/** A verified transaction on any chain the chain-record lane reads. */
export type ChainTransactionEvidence = BaseTransactionEvidence | EvmTransactionEvidence;

export function hashBaseTransactionEvidence(
  value: Omit<BaseTransactionEvidence, 'evidenceHash'> | Omit<EvmTransactionEvidence, 'evidenceHash'>,
): string {
  return `0x${crypto.createHash('sha256').update(canonical({
    ...value,
    providerOperatorIds: [...value.providerOperatorIds],
    logs: value.logs.map((log) => ({ ...log, topics: [...log.topics] })),
  }), 'utf8').digest('hex')}`;
}

/**
 * Verify a whole Base transaction through the two operator-bound legs, the
 * same shape as `verifyBaseUsdcTransferEvidence`: agreed receipt + transaction
 * + block, a successful status, the receipt block canonical before and after a
 * head re-read, at least `BASE_WATCHER_CONFIRMATION_FLOOR` confirmations, and
 * additionally the block at or below the agreed safe head. A not-yet-final
 * transaction throws `economic_evidence_pending:*` (retry later); a reverted
 * one throws `economic_evidence_transaction_failed` (terminal).
 */
export async function verifyBaseTransactionEvidence(
  params: { readonly transactionHash: string },
  options: EconomicDiscoveryOptions = {},
): Promise<BaseTransactionEvidence> {
  if (!HASH.test(params.transactionHash)) {
    throw new Error('base_transaction_request_invalid');
  }
  const facts = await verifyTransactionOnLegs(
    useLegs(options), retryOf(options), params.transactionHash.toLowerCase(), 8453n,
  );
  const withoutHash: Omit<BaseTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'base-transaction-evidence/v1',
    chainId: 8453,
    ...facts,
  };
  return Object.freeze({
    ...withoutHash,
    evidenceHash: hashBaseTransactionEvidence(withoutHash),
  });
}

/**
 * The same verification for a transaction on Arbitrum One or OP Mainnet,
 * through that chain's two operator-bound legs: agreed chain id, receipt,
 * transaction and block, success, canonical before and after a head re-read,
 * the confirmation floor and the agreed safe head.
 */
export async function verifyEvmTransactionEvidence(
  chain: OtherEvmChain,
  params: { readonly transactionHash: string },
  options: EconomicDiscoveryOptions = {},
): Promise<EvmTransactionEvidence> {
  if (!HASH.test(params.transactionHash)) {
    throw new Error('evm_transaction_request_invalid');
  }
  const chainId = EVM_CHAIN_IDS[chain];
  if (chainId === undefined) throw new Error('evm_transaction_chain_unsupported');
  const facts = await verifyTransactionOnLegs(
    useLegsFor(chain, options), retryOf(options), params.transactionHash.toLowerCase(), BigInt(chainId),
  );
  const withoutHash: Omit<EvmTransactionEvidence, 'evidenceHash'> = {
    schemaVersion: 'evm-transaction-evidence/v1',
    chainId,
    ...facts,
  };
  return Object.freeze({
    ...withoutHash,
    evidenceHash: hashBaseTransactionEvidence(withoutHash),
  });
}

type TransactionFacts = Omit<BaseTransactionEvidence, 'evidenceHash' | 'schemaVersion' | 'chainId'>;

async function verifyTransactionOnLegs(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  retry: DisagreementRetry,
  txHash: string,
  expectedChainId: bigint,
): Promise<TransactionFacts> {
  await assertAgreedChain(legs, expectedChainId, retry);
  const head = safeNumber(await agreed(legs, 'eth_blockNumber', [], 'head', retry), 'head');
  const [receiptRaw, transactionRaw] = await Promise.all([
    agreed(legs, 'eth_getTransactionReceipt', [txHash], 'receipt', retry),
    agreed(legs, 'eth_getTransactionByHash', [txHash], 'transaction', retry),
  ]);
  if (!receiptRaw || typeof receiptRaw !== 'object' || Array.isArray(receiptRaw)
    || !transactionRaw || typeof transactionRaw !== 'object' || Array.isArray(transactionRaw)) {
    throw new Error('economic_evidence_pending:transaction_unavailable');
  }
  const receipt = receiptRaw as Record<string, unknown>;
  const transaction = transactionRaw as Record<string, unknown>;
  if (quantity(receipt.status, 'receipt.status') !== 1n) {
    throw new Error('economic_evidence_transaction_failed');
  }
  const blockNumber = safeNumber(receipt.blockNumber, 'receipt.blockNumber');
  if (head < blockNumber) throw new Error('economic_evidence_head_before_transaction');
  if (typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash)
    || typeof receipt.transactionHash !== 'string' || !HASH.test(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== txHash
    || !Array.isArray(receipt.logs)) {
    throw new Error('economic_evidence_receipt_invalid');
  }
  const receiptBlockHash = receipt.blockHash.toLowerCase();
  const logs = receipt.logs.map(normalizeLog);
  for (const log of logs) {
    if (log.removed
      || log.transactionHash !== txHash
      || log.blockNumber !== blockNumber
      || log.blockHash !== receiptBlockHash) {
      throw new Error('economic_evidence_receipt_log_invalid');
    }
  }
  logs.sort((a, b) => a.logIndex - b.logIndex);
  if (typeof transaction.hash !== 'string' || !HASH.test(transaction.hash)
    || transaction.hash.toLowerCase() !== txHash
    || typeof transaction.from !== 'string' || !ethers.isAddress(transaction.from)
    || typeof transaction.blockHash !== 'string' || !HASH.test(transaction.blockHash)
    || transaction.blockHash.toLowerCase() !== receiptBlockHash
    || safeNumber(transaction.blockNumber, 'transaction.blockNumber') !== blockNumber
    || typeof transaction.input !== 'string'
    || !/^0x[0-9a-fA-F]*$/.test(transaction.input)
    || (transaction.input.length % 2) !== 0
    || (transaction.to !== null
      && (typeof transaction.to !== 'string' || !ethers.isAddress(transaction.to)))) {
    throw new Error('economic_evidence_transaction_invalid');
  }
  const valueWei = quantity(transaction.value, 'transaction.value');
  const blockRaw = await agreed(legs, 'eth_getBlockByHash', [receiptBlockHash, false], 'block', retry);
  if (!blockRaw || typeof blockRaw !== 'object' || Array.isArray(blockRaw)) {
    throw new Error('economic_evidence_block_invalid');
  }
  const block = blockRaw as Record<string, unknown>;
  if (typeof block.hash !== 'string'
    || block.hash.toLowerCase() !== receiptBlockHash
    || safeNumber(block.number, 'block.number') !== blockNumber) {
    throw new Error('economic_evidence_block_invalid');
  }
  const timestampSec = quantity(block.timestamp, 'block.timestamp');
  if (timestampSec > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))) {
    throw new Error('economic_evidence_timestamp_unsafe');
  }
  const canonicalTag = ethers.toQuantity(blockNumber);
  const assertCanonicalBlock = async (label: string): Promise<void> => {
    const raw = await agreed(legs, 'eth_getBlockByNumber', [canonicalTag, false], label, retry);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('economic_evidence_canonical_block_invalid');
    }
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.hash !== 'string'
      || candidate.hash.toLowerCase() !== receiptBlockHash
      || safeNumber(candidate.number, `${label}.number`) !== blockNumber
      || quantity(candidate.timestamp, `${label}.timestamp`) !== timestampSec) {
      throw new Error('economic_evidence_receipt_block_not_canonical');
    }
  };
  await assertCanonicalBlock('canonical_receipt_block');
  const postCanonicalHead = safeNumber(
    await agreed(legs, 'eth_blockNumber', [], 'post_canonical_head', retry),
    'post_canonical_head',
  );
  if (postCanonicalHead < head) {
    throw new Error('economic_evidence_head_regressed_during_verification');
  }
  await assertCanonicalBlock('final_canonical_receipt_block');
  const confirmations = postCanonicalHead - blockNumber + 1;
  if (confirmations < BASE_WATCHER_CONFIRMATION_FLOOR) {
    throw new Error(
      `economic_evidence_pending:confirmations:${confirmations}/${BASE_WATCHER_CONFIRMATION_FLOOR}`,
    );
  }
  // twelve L2 confirmations sit inside the sequencer's unsafe window;
  // the block must also be at or below the L1-derived safe head, agreed by
  // both legs on {number, hash} (the projection). The two operators derive L1
  // batches at slightly different times, so their safe tips are routinely a
  // block or two apart: they are compared at their COMMON safe height, and only a
  // different hash there is a disagreement. A leg with no safe block yet is
  // pending, never a fallback to the unsafe head.
  const safe = await agreedSafeHeadOnLegs(legs);
  if (safe === null) {
    throw new Error('economic_evidence_pending:safe_head_unavailable');
  }
  if (safe.number < blockNumber) {
    throw new Error(`economic_evidence_pending:safe_head:${safe.number}/${blockNumber}`);
  }
  const facts: TransactionFacts = {
    transactionHash: txHash,
    blockNumber,
    blockHash: receiptBlockHash,
    blockTimestampMs: Number(timestampSec) * 1_000,
    confirmationFloor: BASE_WATCHER_CONFIRMATION_FLOOR,
    providerOperatorIds: [legs[0].operatorId, legs[1].operatorId],
    fromAddress: transaction.from.toLowerCase(),
    toAddress: typeof transaction.to === 'string' ? transaction.to.toLowerCase() : null,
    valueWei: valueWei.toString(),
    inputEmpty: transaction.input === '0x',
    transactionSelector: transaction.input.length >= 10
      ? transaction.input.slice(0, 10).toLowerCase()
      : null,
    logs: Object.freeze(logs),
  };
  return facts;
}

// =============================================================================
// 2026-10-01 — OUTBOUND DISCOVERY FOR PROVEN EXTERNAL ADDRESSES
// =============================================================================
//
// A proven external EOA's own transactions are not recorded by any Provian route,
// so the chain-record lane FINDS them from its nonce: the account nonce at a block
// counts the transactions it signed through that block. Both reads are quorum-2.
// They only DISCOVER a transaction hash; the lane then re-verifies the whole
// transaction (`verifyBaseTransactionEvidence`) before anything can mint.

/** The account nonce of `address` at `blockNumber`, agreed by both operator legs. */
export async function readAgreedBaseNonce(
  address: string,
  blockNumber: number,
  options: EconomicDiscoveryOptions = {},
): Promise<number> {
  if (!ethers.isAddress(address) || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('economic_discovery_nonce_request_invalid');
  }
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);
  return safeNumber(await agreed(
    legs,
    'eth_getTransactionCount',
    [address.toLowerCase(), ethers.toQuantity(blockNumber)],
    'nonce',
    retry,
  ), 'nonce');
}

/**
 * The hash of the transaction `address` signed with `nonce`, read from block
 * `blockNumber` (full transactions) on both legs and compared on that one
 * projected field (the shape: providers format block objects differently).
 * Null when neither leg's block holds such a transaction; a disagreement throws.
 */
export async function readAgreedBaseTransactionByNonce(
  address: string,
  nonce: number,
  blockNumber: number,
  options: EconomicDiscoveryOptions = {},
): Promise<string | null> {
  if (!ethers.isAddress(address) || !Number.isSafeInteger(nonce) || nonce < 0
    || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('economic_discovery_nonce_request_invalid');
  }
  const signer = address.toLowerCase();
  const legs = useLegs(options);
  await assertAgreedBaseChain(legs, retryOf(options));
  const tag = ethers.toQuantity(blockNumber);
  const project = (raw: unknown): string | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('economic_discovery_block_invalid');
    }
    const block = raw as Record<string, unknown>;
    if (safeNumber(block.number, 'block.number') !== blockNumber || !Array.isArray(block.transactions)) {
      throw new Error('economic_discovery_block_invalid');
    }
    const matches: string[] = [];
    for (const tx of block.transactions as unknown[]) {
      if (!tx || typeof tx !== 'object') throw new Error('economic_discovery_block_transactions_not_full');
      const t = tx as Record<string, unknown>;
      if (typeof t.from !== 'string' || t.from.toLowerCase() !== signer) continue;
      if (safeNumber(t.nonce, 'tx.nonce') !== nonce) continue;
      if (typeof t.hash !== 'string' || !HASH.test(t.hash)) throw new Error('economic_discovery_transaction_invalid');
      matches.push(t.hash.toLowerCase());
    }
    if (matches.length > 1) throw new Error('economic_discovery_nonce_duplicated');
    return matches[0] ?? null;
  };
  const [left, right] = await Promise.all([
    legs[0].send('eth_getBlockByNumber', [tag, true]),
    legs[1].send('eth_getBlockByNumber', [tag, true]),
  ]);
  const a = project(left);
  const b = project(right);
  if (a !== b) throw new Error('economic_discovery_rpc_disagreement:transaction_by_nonce');
  return a;
}

// =============================================================================
// 2026-10-01 — INBOUND DISCOVERY FOR NATIVE ETH
// =============================================================================
//
// A native ETH transfer emits no log, so `eth_getLogs` cannot find it. This read
// finds every PLAIN native transfer into a watched address — a transaction whose
// recipient (`to`) is the address, with non-zero value and no calldata — from the
// full transactions of each block, on BOTH legs, compared on the projected field
// set only (the shape). It only DISCOVERS a transaction hash; the
// chain-record lane re-verifies the whole transaction (`verifyBaseTransactionEvidence`)
// before anything can mint. ETH that arrives inside some other transaction (an
// internal transfer) has no transaction of its own to find: the trace reads
// below discover and verify it.

/** One plain native transfer into a watched address (a discovery pointer). */
export interface NativeTransferPointer {
  readonly transactionHash: string; // lowercased
  readonly blockNumber: number;
  readonly fromAddress: string; // lowercased
  readonly toAddress: string; // lowercased, one of the watched addresses
  readonly valueWei: string; // decimal
}

/** one transaction a watched proven EOA signed (a discovery pointer; contract creations included). */
export interface SignedTransactionPointer {
  readonly transactionHash: string; // lowercased
  readonly blockNumber: number;
  readonly fromAddress: string; // lowercased, one of the watched signers
}

export interface BlockTransfers {
  readonly natives: readonly NativeTransferPointer[];
  readonly signed: readonly SignedTransactionPointer[];
}

/**
 * Every plain native ETH transfer into one of `toAddresses` in blocks
 * `fromBlock..toBlock` inclusive, agreed by both operator legs block by block.
 * A block either leg cannot return, a non-full transaction list, or a
 * disagreement on the projection (after the bounded re-poll) throws, so a caller
 * advancing a cursor never passes a block it did not read on both legs.
 */
export async function readAgreedBaseNativeTransfersTo(
  args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: ReadonlySet<string>;
    /** Blocks read in parallel (each read hits both legs). Default 4. */
    readonly concurrency?: number;
  },
  options: EconomicDiscoveryOptions = {},
): Promise<readonly NativeTransferPointer[]> {
  return (await readAgreedBaseBlockTransfers({ ...args, fromAddresses: new Set() }, options)).natives;
}

/**
 * the same full-block read, projecting BOTH the plain native transfers into
 * `toAddresses` and every transaction whose sender is one of `fromAddresses` (a
 * proven EOA's own transactions: sends, swaps, contract calls and creations). One
 * read per block on each leg serves both; the two legs must agree on the whole
 * projection, so a cursor never passes a block either list was not agreed for.
 */
export async function readAgreedBaseBlockTransfers(
  args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: ReadonlySet<string>;
    readonly fromAddresses: ReadonlySet<string>;
    /** Blocks read in parallel (each read hits both legs). Default 4. */
    readonly concurrency?: number;
  },
  options: EconomicDiscoveryOptions = {},
): Promise<BlockTransfers> {
  const { fromBlock, toBlock } = args;
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
    throw new Error('economic_discovery_native_range_invalid');
  }
  for (const address of [...args.toAddresses, ...args.fromAddresses]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('economic_discovery_native_address_invalid');
  }
  const concurrency = Math.max(1, Math.min(args.concurrency ?? 4, 16));
  const legs = useLegs(options);
  const retry = retryOf(options);
  await assertAgreedBaseChain(legs, retry);

  const byHash = <T extends { readonly transactionHash: string }>(a: T, b: T): number =>
    (a.transactionHash < b.transactionHash ? -1 : a.transactionHash > b.transactionHash ? 1 : 0);
  const project = (raw: unknown, blockNumber: number): BlockTransfers => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('economic_discovery_block_unavailable');
    }
    const block = raw as Record<string, unknown>;
    if (safeNumber(block.number, 'block.number') !== blockNumber || !Array.isArray(block.transactions)) {
      throw new Error('economic_discovery_block_invalid');
    }
    const natives: NativeTransferPointer[] = [];
    const signed: SignedTransactionPointer[] = [];
    for (const tx of block.transactions as unknown[]) {
      if (!tx || typeof tx !== 'object') throw new Error('economic_discovery_block_transactions_not_full');
      const t = tx as Record<string, unknown>;
      if (args.fromAddresses.size > 0 && typeof t.from === 'string' && args.fromAddresses.has(t.from.toLowerCase())) {
        if (typeof t.hash !== 'string' || !HASH.test(t.hash)) throw new Error('economic_discovery_transaction_invalid');
        signed.push({ transactionHash: t.hash.toLowerCase(), blockNumber, fromAddress: t.from.toLowerCase() });
      }
      if (typeof t.to !== 'string') continue; // contract creation
      const to = t.to.toLowerCase();
      if (!args.toAddresses.has(to)) continue;
      if (typeof t.input !== 'string' || t.input !== '0x') continue; // a plain transfer carries no calldata
      const value = quantity(t.value, 'tx.value');
      if (value <= 0n) continue;
      if (typeof t.hash !== 'string' || !HASH.test(t.hash)
        || typeof t.from !== 'string' || !ethers.isAddress(t.from)) {
        throw new Error('economic_discovery_transaction_invalid');
      }
      natives.push({
        transactionHash: t.hash.toLowerCase(),
        blockNumber,
        fromAddress: t.from.toLowerCase(),
        toAddress: to,
        valueWei: value.toString(),
      });
    }
    return { natives: natives.sort(byHash), signed: signed.sort(byHash) };
  };

  const readBlock = async (blockNumber: number): Promise<BlockTransfers> => {
    const tag = ethers.toQuantity(blockNumber);
    for (let attempt = 1; ; attempt += 1) {
      // Both legs settle before either result is used or either failure thrown:
      // a full block is the largest read the relay makes, and none may run on
      // after this read returns (relay heap OOM, 2026-10-17).
      const [left, right] = await allSettledOrThrow<[unknown, unknown]>([
        legs[0].send('eth_getBlockByNumber', [tag, true]),
        legs[1].send('eth_getBlockByNumber', [tag, true]),
      ]);
      const a = project(left, blockNumber);
      const b = project(right, blockNumber);
      if (canonical(a) === canonical(b)) return a;
      if (attempt >= retry.attempts) throw new Error('economic_discovery_rpc_disagreement:native_transfers');
      if (retry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    }
  };

  const natives: NativeTransferPointer[] = [];
  const signed: SignedTransactionPointer[] = [];
  for (let start = fromBlock; start <= toBlock; start += concurrency) {
    const blocks: number[] = [];
    for (let n = start; n <= Math.min(start + concurrency - 1, toBlock); n += 1) blocks.push(n);
    const results = await allSettledOrThrow<BlockTransfers[]>(blocks.map(readBlock));
    for (const result of results) {
      natives.push(...result.natives);
      signed.push(...result.signed);
    }
  }
  return { natives, signed };
}

// =============================================================================
// 2026-10-01 — ETH THAT ARRIVES INSIDE A TRANSACTION (the operator: an internal
// transfer mints on the same terms as a plain ETH receive)
// =============================================================================
//
// ETH a smart wallet (Coinbase's, for one) or any contract sends inside some
// other transaction has no transaction and no log of its own: only a TRACE shows
// it. Two reads, two roles:
//
//   * DISCOVERY (`readBaseInternalEthPointers`): `trace_filter` on the primary
//     trace leg, filtered by recipient. It only finds a transaction hash. The
//     public Base endpoint serves no trace methods and the second trace operator's
//     free tier refuses `trace_filter`, so discovery is one leg; a leg that
//     omitted a transfer could only lose a mint, never make one.
//   * VERIFICATION (`readAgreedBaseInternalEth`): `trace_transaction` on BOTH
//     independently operated trace legs, compared on the projected field set
// (the shape), after the transaction itself was verified on the
//     verifier pair. Nothing mints from a trace one operator alone reported.
//
// A frame moves ETH only when it is a plain `call` (not a delegatecall,
// staticcall or callcode, which move no value to their target) or a
// selfdestruct, with a non-zero value between two different addresses, and when
// neither it nor any frame above it reverted. A contract creation is not a
// receive (a fresh contract cannot be a watched address past its fence).

/** One ETH movement into a watched address seen in a trace (a discovery pointer). */
export interface InternalEthTransferPointer {
  readonly transactionHash: string; // lowercased
  readonly blockNumber: number;
  readonly fromAddress: string; // lowercased
  readonly toAddress: string; // lowercased, one of the watched addresses
  readonly valueWei: string; // decimal
}

/** One effective ETH movement inside a transaction, in execution order. */
export interface InternalEthFrame {
  readonly traceAddress: readonly number[];
  readonly kind: 'call' | 'selfdestruct';
  readonly fromAddress: string; // lowercased
  readonly toAddress: string; // lowercased
  readonly valueWei: string; // decimal, > 0
}

export interface BaseInternalEthEvidence {
  readonly schemaVersion: 'base-internal-eth-evidence/v1';
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly providerOperatorIds: readonly [string, string];
  /** Every effective ETH movement in the transaction, top-level call included. */
  readonly frames: readonly InternalEthFrame[];
  readonly evidenceHash: string;
}

export interface TraceDiscoveryOptions {
  /** Test-only injection. Production uses `getBaseTraceRpcLegs()`. */
  readonly traceLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
  readonly disagreementRetry?: Partial<DisagreementRetry>;
}

function configuredTraceLegs(): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = getBaseTraceRpcLegs();
  return [
    { operatorId: legs[0].operatorId, send: (method, params) => legs[0].provider.send(method, [...params]) },
    { operatorId: legs[1].operatorId, send: (method, params) => legs[1].provider.send(method, [...params]) },
  ];
}

function useTraceLegs(options: TraceDiscoveryOptions): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = options.traceLegs ?? configuredTraceLegs();
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_discovery_trace_operators_not_independent');
  }
  return legs;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

function traceAddressOf(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('economic_discovery_trace_invalid:trace_address');
  return value.map((n) => {
    if (!Number.isSafeInteger(n) || (n as number) < 0) throw new Error('economic_discovery_trace_invalid:trace_address');
    return n as number;
  });
}

function traceBlockNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') return safeNumber(value, 'trace.blockNumber');
  throw new Error('economic_discovery_trace_invalid:block_number');
}

function traceAddressField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ethers.isAddress(value)) throw new Error(`economic_discovery_trace_invalid:${label}`);
  return value.toLowerCase();
}

/**
 * The ETH movement a single trace entry makes, ignoring whether an ancestor
 * reverted (the caller decides that), or null when it moves none.
 */
function traceEthMovement(entry: Record<string, unknown>): Omit<InternalEthFrame, 'traceAddress'> | null {
  const action = entry.action;
  if (!action || typeof action !== 'object') throw new Error('economic_discovery_trace_invalid:action');
  const a = action as Record<string, unknown>;
  if (entry.type === 'call') {
    if (a.callType !== 'call') return null; // delegatecall / staticcall / callcode move no value to `to`
    const value = quantity(a.value, 'trace.value');
    if (value <= 0n) return null;
    const from = traceAddressField(a.from, 'from');
    const to = traceAddressField(a.to, 'to');
    if (from === to) return null;
    return { kind: 'call', fromAddress: from, toAddress: to, valueWei: value.toString() };
  }
  if (entry.type === 'suicide' || entry.type === 'selfdestruct') {
    const value = quantity(a.balance, 'trace.balance');
    if (value <= 0n) return null;
    const from = traceAddressField(a.address, 'address');
    const to = traceAddressField(a.refundAddress, 'refund_address');
    if (from === to) return null;
    return { kind: 'selfdestruct', fromAddress: from, toAddress: to, valueWei: value.toString() };
  }
  return null; // create / reward: not a receive
}

/**
 * Every ETH movement into one of `toAddresses` in blocks `fromBlock..toBlock`
 * inclusive, from `trace_filter` on the primary trace leg. Pointers only: the
 * lane verifies each on both trace legs before anything can mint. A malformed
 * entry or one outside the range throws, so a caller advancing a cursor never
 * passes a window it did not read whole.
 */
export async function readBaseInternalEthPointers(
  args: { readonly fromBlock: number; readonly toBlock: number; readonly toAddresses: readonly string[] },
  options: TraceDiscoveryOptions = {},
): Promise<readonly InternalEthTransferPointer[]> {
  const { fromBlock, toBlock } = args;
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
    throw new Error('economic_discovery_trace_range_invalid');
  }
  const watched = new Set<string>();
  for (const address of args.toAddresses) {
    if (!ADDRESS.test(address)) throw new Error('economic_discovery_trace_address_invalid');
    watched.add(address);
  }
  if (watched.size === 0) return [];
  const [primary] = useTraceLegs(options);
  // The paid primary currently limits trace_filter to100blocks. Logs may use500;
  // trace discovery covers every subrange independently and never drops a provider-capped page.
  const out: InternalEthTransferPointer[] = [];
  let rangeBlocks=100;
  for(let from=fromBlock;from<=toBlock;){
    const to=Math.min(from+rangeBlocks-1,toBlock);
    let after=0,retryRange=false;
    const seenPages=new Set<string>();
    for(;;){
      let raw:unknown;
      try{
        raw=await primary.send('trace_filter',[{
          fromBlock:ethers.toQuantity(from),toBlock:ethers.toQuantity(to),
          toAddress:[...watched],after,count:1000,
        }]);
      }catch(error:unknown){
        const message=error instanceof Error?error.message:'';
        const match=/Block range too large; currently limited to (\d+) blocks/i.exec(message);
        const limit=match?Number(match[1]):NaN;
        // A range of heavy blocks can outlast the RPC timeout (100 blocks of the
        // 2026-10-10 spam took over 30 s, so the scan retried the same window every
        // five minutes for a week). A timed-out first page halves the range, down to
        // one block; a timeout past the first page, or on one block, still throws.
        const timedOut=(error as {code?:unknown}|null)?.code==='TIMEOUT';
        if(after===0&&timedOut&&to>from){rangeBlocks=Math.max(1,Math.floor((to-from+1)/2));retryRange=true;break;}
        if(after!==0||!Number.isSafeInteger(limit)||limit<1||limit>=to-from+1)throw error;
        rangeBlocks=Math.min(rangeBlocks,limit);retryRange=true;break;
      }
      if(!Array.isArray(raw))throw new Error('economic_discovery_trace_unavailable');
      if(raw.length===0)break;
      const pageHash=crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
      if(seenPages.has(pageHash))throw new Error('economic_discovery_trace_pagination_stalled');
      seenPages.add(pageHash);
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== 'object') throw new Error('economic_discovery_trace_invalid:entry');
    const entry = item as Record<string, unknown>;
    if (entry.error !== undefined) continue; // the frame itself reverted
    const movement = traceEthMovement(entry);
    if (!movement || !watched.has(movement.toAddress)) continue;
    const blockNumber = traceBlockNumber(entry.blockNumber);
    if (blockNumber < from || blockNumber > to) throw new Error('economic_discovery_trace_out_of_range');
    if (typeof entry.transactionHash !== 'string' || !HASH.test(entry.transactionHash)) {
      throw new Error('economic_discovery_trace_invalid:transaction_hash');
    }
    out.push({
      transactionHash: entry.transactionHash.toLowerCase(),
      blockNumber,
      fromAddress: movement.fromAddress,
      toAddress: movement.toAddress,
      valueWei: movement.valueWei,
    });
  }
      // Advance by every raw frame, including rejected/reverted/zero-value frames.
      // Only an empty page proves completion; a short page may be a provider cap.
      after+=raw.length;
    }
    if(!retryRange)from=to+1;
  }
  return out;
}

/**
 * The effective ETH movements of one transaction, agreed by BOTH trace legs.
 * A transaction either leg cannot trace, a malformed or foreign entry, or a
 * disagreement on the projection (after the bounded re-poll) throws, and the
 * lane retries; it never mints from one operator's trace.
 */
export async function readAgreedBaseInternalEth(
  args: { readonly transactionHash: string },
  options: TraceDiscoveryOptions = {},
): Promise<BaseInternalEthEvidence> {
  if (!HASH.test(args.transactionHash)) throw new Error('economic_discovery_trace_transaction_invalid');
  const transactionHash = args.transactionHash.toLowerCase();
  const legs = useTraceLegs(options);
  const retry = retryOf(options);

  const project = (raw: unknown): { blockHash: string; blockNumber: number; frames: InternalEthFrame[] } => {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('economic_discovery_trace_unavailable');
    let blockHash: string | null = null;
    let blockNumber: number | null = null;
    const reverted: string[] = [];
    const tree: TraceTreeNode[] = [];
    const entries: Array<{ address: number[]; entry: Record<string, unknown> }> = [];
    for (const item of raw as unknown[]) {
      if (!item || typeof item !== 'object') throw new Error('economic_discovery_trace_invalid:entry');
      const entry = item as Record<string, unknown>;
      if (typeof entry.transactionHash !== 'string' || entry.transactionHash.toLowerCase() !== transactionHash) {
        throw new Error('economic_discovery_trace_invalid:foreign_entry');
      }
      if (typeof entry.blockHash !== 'string' || !HASH.test(entry.blockHash)) {
        throw new Error('economic_discovery_trace_invalid:block_hash');
      }
      const hash = entry.blockHash.toLowerCase();
      const number = traceBlockNumber(entry.blockNumber);
      if ((blockHash !== null && blockHash !== hash) || (blockNumber !== null && blockNumber !== number)) {
        throw new Error('economic_discovery_trace_invalid:mixed_blocks');
      }
      blockHash = hash;
      blockNumber = number;
      const address = traceAddressOf(entry.traceAddress);
      tree.push({ key: `${transactionHash}:${address.join('.')}`, parent: address.length ? `${transactionHash}:${address.slice(0, -1).join('.')}` : null,
        index: address.length ? address[address.length - 1] : 0, children: traceChildCount(entry.subtraces), block: number, blockHash: hash });
      if (entry.error !== undefined) reverted.push(address.join('.'));
      entries.push({ address, entry });
    }
    assertCompleteTraceTrees(tree);
    if (tree.filter(node => node.parent === null).length !== 1) throw new Error('economic_discovery_trace_invalid:root');
    const root = entries.find(({ address }) => address.length === 0)?.entry;
    if (!root || (root.type !== 'call' && root.type !== 'create')) throw new Error('economic_discovery_trace_invalid:root');
    // A frame is effective only when neither it nor any frame above it reverted.
    const revertedUnder = (address: readonly number[]): boolean => {
      for (let depth = 0; depth <= address.length; depth += 1) {
        if (reverted.includes(address.slice(0, depth).join('.'))) return true;
      }
      return false;
    };
    const frames: InternalEthFrame[] = [];
    for (const { address, entry } of entries) {
      const movement = traceEthMovement(entry);
      if (!movement || revertedUnder(address)) continue;
      frames.push({ traceAddress: address, ...movement });
    }
    return { blockHash: blockHash as string, blockNumber: blockNumber as number, frames };
  };

  for (let attempt = 1; ; attempt += 1) {
    const [left, right] = await Promise.all([
      legs[0].send('trace_transaction', [transactionHash]),
      legs[1].send('trace_transaction', [transactionHash]),
    ]);
    const a = project(left);
    const b = project(right);
    if (canonical(a) === canonical(b)) {
      const body = {
        schemaVersion: 'base-internal-eth-evidence/v1' as const,
        transactionHash,
        blockNumber: a.blockNumber,
        blockHash: a.blockHash,
        providerOperatorIds: [legs[0].operatorId, legs[1].operatorId] as const,
        frames: a.frames,
      };
      const evidenceHash = `0x${crypto.createHash('sha256').update(canonical({
        ...body, providerOperatorIds: [...body.providerOperatorIds],
      }), 'utf8').digest('hex')}`;
      return { ...body, evidenceHash };
    }
    if (attempt >= retry.attempts) throw new Error('economic_discovery_rpc_disagreement:internal_eth');
    if (retry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
  }
}
