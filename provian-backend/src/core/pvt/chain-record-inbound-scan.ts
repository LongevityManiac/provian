import { readAdaptivePrimaryDiscoveryWindow, type CompactDiscoveryWindow } from '../onchain/compact-discovery';
import {allSettledOrThrow, mapBounded} from '../net/map-bounded';
import {BASE_GETLOGS_MAX_RANGE_BLOCKS} from '../onchain/economic-discovery';
/**
 * the INBOUND SCAN for known non-USDC assets.
 *
 * the invariant: a chain-verified receive from a counterparty the
 * recipient has dealt with mints, for humans and agents alike, and a first
 * receive from a stranger records only. The inbound USDC watcher has done this
 * for USDC since; nothing watched PVT, USDT, DAI or WETH arriving. This
 * scan closes that, WITHOUT a second minting path: it only FINDS the
 * transaction and queues it into the chain-record lane (`chain-record-watcher.ts`)
 * as a pointer. The lane re-reads the whole transaction through the two operator
 * legs at the confirmation floor and the safe head, derives the `receive` from
 * the receipt alone, waits on the USDC watchers' PEs for the same transaction
 * (one transaction mints once), and emits through the unchanged fences: receive
 * authorship (`pvt-accrual.ts` → `receive-authorship.ts`), same-owner /
 * shared-owner, novelty, the financial-settlement mint-once claim
 * and the `receive` ceiling (50 per actor per UTC day).
 *
 * WHAT IT SCANS. `eth_getLogs` for ERC-20 `Transfer` on the known non-USDC Base
 * assets (`BASE_NON_USDC_ASSETS`) whose `to` topic is a native wallet — EVERY
 * agent and human address in the canonical index (`native_wallet_address_index_v1`),
 * read directly, with no per-wallet document read ( , defect
 * 2): one global cursor must never pass a block for an address it did not ask
 * about, so the scan never drops an address for a transient or repairable fault
 * on its wallet. The lane validates the wallet when it processes the observation
 * (and retries a wallet it cannot resolve). An index read that fails stops the
 * run before any window is scanned, so the cursor never advances past it.
 *
 * A MALFORMED ROW NEVER STOPS THE SCAN FOR EVERYONE (; the
 * open item). A row that does not parse, or an address two rows claim, is
 * SET ASIDE: it is recorded in `chain_record_scan_set_aside/{key}` with the
 * block range the scan passed without it (`held_from_block`..`held_through_block`),
 * named in the run report and logged, counted by the Command Center's data-health
 * collector (attention `data.chain_record_scan.set_aside`), and every other
 * wallet's receives keep flowing. Once the row parses again, the scan BACKFILLS
 * exactly the held range for that address (its own cursor, `backfill_next_block`,
 * within the same call budget) before deleting the set-aside record, so a
 * repaired row loses no receive. A held row whose address left the index is
 * released without a backfill (nothing can be attributed to it). A log from an
 * excluded counterparty (the zero address — every PVT settlement and Genesis
 * mint arrives from it — the PVT9 kernels, the migration distributor, an
 * institution) is not queued; the lane re-checks everything anyway.
 *
 * FROM THE LANDING FORWARD. The durable block cursor starts a short lookback
 * behind the finalized head on its first run; the lane refuses any receive mined
 * before `VERIFIED_COMMERCE_CUT_LINE_MS`. The cursor advances only through windows
 * whose every log was queued, so a crash re-scans (the queue is idempotent by
 * (tx, wallet)).
 *
 * NATIVE ETH (The native-asset policy carves out no
 * asset). A native ETH transfer emits no log, so each scanned window also reads
 * its blocks' full transactions on BOTH legs (`readAgreedBaseNativeTransfersTo`)
 * and queues every PLAIN native transfer into a watched address: the address is
 * the transaction's recipient, the value is non-zero, there is no calldata, and
 * the sender is someone else and not an excluded counterparty. It rides the same
 * cursor, budget, set-aside and backfill as the token logs, so a window is
 * passed only once both its logs and its native transfers were read. The lane
 * derives and gates the `receive` exactly as for a token.
 *
 * ETH THAT ARRIVES INSIDE A TRANSACTION (2026-10-01, the operator: an internal transfer
 * mints on the same terms as a plain ETH receive). ETH a smart wallet (Coinbase's,
 * for one) or any contract sends inside some other transaction has no transaction
 * or log of its own, so each window also reads the trace (`trace_filter`, filtered
 * to the watched addresses; `readBaseInternalEthPointers`) and queues every ETH
 * movement into a watched address from someone else. It rides the same cursor,
 * budget, set-aside and backfill, and is read beside the native blocks before
 * anything in the window is queued. The lane verifies the movement on BOTH trace
 * legs (`readAgreedBaseInternalEth`) before anything can mint.
 *
 * SCOPE. Base only. Every native Provian wallet AND, from 2026-10-01 (the operator’s
 * 09-23 commerce ruling, reinstated 09-30), every PROVEN external address — an
 * agent's (`proven_addresses`) or a person's (`human_proven_addresses`) — from
 * its proof's exact H+1 fence, queued under `proven:<address>` so the lane
 * attributes it to its owner. A proven row that does not validate is set aside
 * like a malformed index row. (A proven EOA's OWN transactions are found by
 * `chain-record-proven-outbound-scan.ts`.)
 */

import { firstBlockAtOrAfter } from '../onchain/block-time-search';
import type { Firestore } from 'firebase-admin/firestore';
import {
  BASE_WATCHER_CONFIRMATION_FLOOR,
  ERC20_TRANSFER_TOPIC,
  getAgreedBaseLogs,
  readAgreedBaseHead,
  readAgreedBaseBlockTimestampMs,
  readAgreedBaseBlockTransfers,
  readAgreedBaseNativeTransfersTo,
  readBaseInternalEthPointers,
  type BlockTransfers,
  type CanonicalEconomicLog,
  type InternalEthTransferPointer,
  type NativeTransferPointer,
} from '../onchain/economic-discovery';
import {
  CHAIN_RECORD_EXCLUDED_COUNTERPARTIES,
  enqueueChainRecordObservation,
  provenObservationWalletId,
  type ChainRecordOwnerType,
} from './chain-record-watcher';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESS_SCHEMA,
  isEconomicallyActiveProvenAddress,
} from '../external-address/link';
import { isEconomicallyActiveHumanProvenAddress } from '../external-address/human-link';
import { withRateLimitRetry } from './outbound-usdc-watcher';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseCanonicalNativeAddressIndex,
} from './native-wallet-registration';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  parseWatcherAddressAdmission,
  watcherAddressAdmissionDocIdFor,
} from './watcher-address-admission';
import {
  clearLateRecord,
  readPendingLateRecords,
  readWatchMarks,
  seedWatchMarks,
  watchRegistryAddresses,
  writeWatchMarks,
} from './watch-registry';
import { ensureWatchRegistrySeeded } from './watch-registry-reconcile';
import {
  CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION,
  PROVEN_OUTBOUND_FLOOR_BLOCK,
  fixFullBlockSince,
  openProvenOutboundRange,
} from './proven-outbound-ranges';
import { BASE_NON_USDC_ASSETS, addressTopic, movesValue } from './wallet-exchange';

export { CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION };
export const CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID = 'base_inbound_non_usdc';
const CHECKPOINT_SCHEMA = 'chain-record-inbound-scan-checkpoint/v1';

/** The initial window spans thirty minutes of observed canonical chain time. */
export const CHAIN_RECORD_SCAN_INITIAL_LOOKBACK_SECONDS = 1800;
/** The paid operators accept 500-block windows; the agreed read splits smaller provider
 * limits itself. Wider windows change discovery cost, never verification or confirmations. */
const DEFAULT_BLOCK_CHUNK = BASE_GETLOGS_MAX_RANGE_BLOCKS;
/** The call budget per run. A log window costs one call per address batch; a
 * legacy native window costs one call per block; compact discovery costs one
 * logical unit per complete window. Physical RPC work is counted separately by
 * the adaptive planner, including pagination and both independent operators. */
const DEFAULT_MAX_LOG_CALLS = 600;
/** Budget three 500-block windows at the measured ~85s/window, covering one
 * five-minute interval at 200ms. Stop before starting further catch-up work;
 * the drain and other chains retain time inside the request deadline. */
const DEFAULT_MAX_SCAN_MS = 240_000;
/** both economic legs answer 20,000-address log filters (measured); trace pieces stay 100 blocks. */
const DEFAULT_ADDRESS_BATCH = 5_000;
/** Bounded Firestore work; RPC reads use their own independent limits. */
export const CHAIN_RECORD_OWNER_CONCURRENCY = 128;

export const CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION = 'chain_record_scan_set_aside';
const SET_ASIDE_SCHEMA = 'chain-record-scan-set-aside/v1';

export interface ChainRecordScanWallet {
  readonly address: string; // lowercased
  readonly walletId: string;
  readonly ownerType: ChainRecordOwnerType;
  readonly eligibilityStartBlock: number;
  /** The source row's key (the index document id), so a repaired row finds its
   * set-aside record. Optional for listings that cannot be set aside. */
  readonly key?: string;
  /** a proven row's proof method (only an EOA signature proof signs its own transactions). */
  readonly proofMethod?: 'eip191_eoa' | 'eip1271_contract';
}

/** A row the scan cannot watch this run: it is held, never guessed at. */
export interface ChainRecordScanSetAsideRow {
  readonly setAside: true;
  readonly key: string;
  readonly reason: string;
  /** The address, when the row names a well-formed one (for the operator). */
  readonly address: string | null;
}

export type ChainRecordScanListing = ChainRecordScanWallet | ChainRecordScanSetAsideRow;

function isSetAside(row: ChainRecordScanListing): row is ChainRecordScanSetAsideRow {
  return (row as ChainRecordScanSetAsideRow).setAside === true;
}

export interface ChainRecordInboundScanDeps {
  readonly initialFromBlock?: (head: number) => Promise<number>;
  readonly getCompactWindow?: (args: { readonly fromBlock: number; readonly toBlock: number; readonly watched: ReadonlySet<string> }) => Promise<CompactDiscoveryWindow>;
  readonly db: Firestore;
  readonly getHead: () => Promise<number>;
  /** Transfer logs on the known non-USDC assets whose `to` is one of `toAddresses`. */
  readonly getLogs: (args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: readonly string[];
  }) => Promise<readonly CanonicalEconomicLog[]>;
  /** Every watched row. A row that cannot be watched is returned SET ASIDE, never
   * thrown; only a read of the whole list may throw (which stops the run). */
  readonly listWallets: () => Promise<readonly ChainRecordScanListing[]>;
  /** 2026-10-01: plain native ETH transfers into one of `toAddresses` in the
   * window, read from full blocks on both legs. Absent = no native discovery. */
  readonly getNativeTransfers?: (args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: ReadonlySet<string>;
  }) => Promise<readonly NativeTransferPointer[]>;
  /** 2026-10-01: ETH movements into one of `toAddresses` found in the trace
   * (internal transfers included). Absent = no trace discovery. */
  readonly getInternalTransfers?: (args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: readonly string[];
  }) => Promise<readonly InternalEthTransferPointer[]>;
  readonly now?: () => number;
  /** Elapsed-time clock for the wall-clock guard (defaults to Date.now). */
  readonly clock?: () => number;
  /** read the watch registry instead of listing every source row (production). */
  readonly useRegistry?: boolean;
  /** the full-block read that also returns transactions the `fromAddresses` signed.
   * Used in registry mode in place of `getNativeTransfers` for the main pass. */
  readonly getBlockTransfers?: (args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly toAddresses: ReadonlySet<string>;
    readonly fromAddresses: ReadonlySet<string>;
  }) => Promise<BlockTransfers>;
}

export interface ChainRecordInboundScanOptions {
  readonly blockChunk?: number;
  readonly maxLogCalls?: number;
  readonly addressBatch?: number;
  readonly maxScanMs?: number;
}

export interface ChainRecordInboundScanReport {
  from_block: number;
  to_block: number;
  watched_wallets: number;
  logs_seen: number;
  /** 2026-10-01: plain native ETH transfers into watched addresses seen. */
  native_transfers_seen: number;
  /** 2026-10-01: ETH movements into watched addresses seen in the trace. */
  internal_transfers_seen: number;
  queued: number;
  already_queued: number;
  skipped: number;
  log_calls_used: number;
  budget_stopped: boolean;
  /** Rows held this run (key + reason). Every other wallet was scanned. */
  set_aside: Array<{ key: string; reason: string; address: string | null }>;
  /** Backfill windows scanned for repaired rows, and rows fully released. */
  backfill_windows: number;
  released: number;
  error: string | null;
  /** transactions signed by watched proven EOAs seen in the full blocks, and those queued. */
  signed_transactions_seen: number;
  proven_outbound_queued: number;
}

interface SetAsideRecord {
  schema_version: typeof SET_ASIDE_SCHEMA;
  key: string;
  reason: string;
  address: string | null;
  held_from_block: number;
  /** Last block the main scan passed while the row was held; `held_from_block - 1` when none. */
  held_through_block: number;
  /** Next block of the held range to backfill once the row is repaired. */
  backfill_next_block: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
}

function setAsideDocId(key: string): string {
  // Firestore ids may not contain '/'; keys are index doc ids or `contested_<address>`.
  return key.replace(/\//g, '_');
}

function parseSetAside(raw: Record<string, unknown> | undefined): SetAsideRecord | null {
  if (!raw || raw.schema_version !== SET_ASIDE_SCHEMA || typeof raw.key !== 'string') return null;
  for (const field of ['held_from_block', 'held_through_block', 'backfill_next_block'] as const) {
    if (!Number.isSafeInteger(raw[field])) return null;
  }
  return raw as unknown as SetAsideRecord;
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readCheckpoint(db: Firestore): Promise<number | null> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION)
    .doc(CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID).get();
  if (!snap.exists) return null;
  const data = snap.data() as { schema_version?: unknown; next_block?: unknown };
  if (data.schema_version !== CHECKPOINT_SCHEMA
    || typeof data.next_block !== 'number' || !Number.isSafeInteger(data.next_block) || data.next_block < 0) {
    // A malformed cursor is an integrity fault, never a guess at where to resume.
    throw new Error('chain_record_scan_checkpoint_invalid');
  }
  return data.next_block;
}

async function writeCheckpoint(db: Firestore, nextBlock: number, now: number): Promise<void> {
  await db.collection(CHAIN_RECORD_SCAN_CHECKPOINT_COLLECTION)
    .doc(CHAIN_RECORD_INBOUND_SCAN_CHECKPOINT_ID)
    .set({ schema_version: CHECKPOINT_SCHEMA, next_block: nextBlock, updated_at_ms: now });
}

/** Is this log a candidate receive for `wallet`? The lane decides; this only
 * avoids queueing what can never be one. */
function isCandidate(log: CanonicalEconomicLog, wallet: ChainRecordScanWallet): boolean {
  return !log.removed
    && log.topics.length === 3
    && log.topics[0] === ERC20_TRANSFER_TOPIC
    && /^0x[0-9a-f]{64}$/.test(log.data)
    && log.address in BASE_NON_USDC_ASSETS
    && log.topics[2] === addressTopic(wallet.address)
    && movesValue(log)
    && !CHAIN_RECORD_EXCLUDED_COUNTERPARTIES.has(topicAddress(log.topics[1]))
    && log.blockNumber >= wallet.eligibilityStartBlock;
}

/** Is this plain native transfer a candidate receive for `wallet`? (2026-10-01) */
function isNativeCandidate(transfer: NativeTransferPointer | InternalEthTransferPointer, wallet: ChainRecordScanWallet): boolean {
  let value: bigint;
  try {
    value = BigInt(transfer.valueWei);
  } catch {
    return false;
  }
  return transfer.toAddress === wallet.address
    && value > 0n
    && transfer.fromAddress !== wallet.address
    && !CHAIN_RECORD_EXCLUDED_COUNTERPARTIES.has(transfer.fromAddress)
    && transfer.blockNumber >= wallet.eligibilityStartBlock;
}

/**
 * What one run watches and how it resolves an address. The legacy listing builds it
 * from every source row; the registry builds it from the watch registry and resolves only the
 * addresses the chain shows activity for (plus pending and held ones), with the same per-row
 * rules either way.
 */
interface ChainRecordWatchSet {
  /** Addresses to ask the chain about (log `to`, native `to`, trace recipient). */
  readonly filter: readonly string[];
  /** Proven EOAs whose own transactions the full-block read projects (empty in legacy mode). */
  readonly signers: ReadonlySet<string>;
  /** The run's set-aside rows (grows when a resolution finds a row it cannot watch). */
  readonly setAside: Map<string, ChainRecordScanSetAsideRow>;
  /** Set-aside rows found since the last drain (held records still to create). */
  drainNew(): ChainRecordScanSetAsideRow[];
  wallet(address: string): Promise<ChainRecordScanWallet | undefined>;
  /** The watched proven EOA a signed transaction belongs to (proof by EOA signature only). */
  signer(address: string): Promise<ChainRecordScanWallet | undefined>;
  releaseTarget(record: SetAsideRecord): Promise<ChainRecordScanWallet | null>;
  /** True when the address a held record releases to (resolved exactly as `releaseTarget` resolves
   *  it) still has source rows (registry mode); false in legacy mode, where a held row that
   *  resolves to no wallet has left the listing. */
  stillHasRows(record: SetAsideRecord): Promise<boolean>;
  /** B_F: blocks at or after it are the full-block read's to find for proven EOAs. */
  readonly fullBlockSince: number | null;
}

/** Group listing rows: a single valid row per address is watched; two is a contest; the rest are held. */
function classifyListing(rows: readonly ChainRecordScanListing[]): {
  wallets: Map<string, ChainRecordScanWallet>;
  setAside: Map<string, ChainRecordScanSetAsideRow>;
} {
  const wallets = new Map<string, ChainRecordScanWallet>();
  const setAside = new Map<string, ChainRecordScanSetAsideRow>();
  const contested = new Set<string>();
  for (const row of rows) {
    if (isSetAside(row)) {
      setAside.set(row.key, row);
      continue;
    }
    const address = row.address.toLowerCase();
    // The index is keyed by address, so two rows for one address is an integrity
    // fault: never guess which wallet a transfer belongs to. Hold the address.
    if (wallets.has(address) || contested.has(address)) {
      contested.add(address);
      wallets.delete(address);
      continue;
    }
    wallets.set(address, { ...row, address });
  }
  for (const address of contested) {
    const key = `contested_${address}`;
    setAside.set(key, { setAside: true, key, reason: 'chain_record_scan_wallet_contested', address });
  }
  return { wallets, setAside };
}

/** The pre- watch set: every source row, listed once per run. */
async function listedWatchSet(deps: ChainRecordInboundScanDeps): Promise<ChainRecordWatchSet> {
  // An index READ that fails throws BEFORE a window is scanned: the cursor stays
  // put and the next run asks again. A row that cannot be watched is set aside.
  const { wallets, setAside } = classifyListing(await deps.listWallets());
  const fresh = [...setAside.values()];
  return {
    filter: [...wallets.keys()],
    signers: new Set(),
    setAside,
    drainNew: () => fresh.splice(0, fresh.length),
    wallet: async (address) => wallets.get(address),
    signer: async () => undefined,
    releaseTarget: async (record) => {
      for (const wallet of wallets.values()) if (wallet.key !== undefined && wallet.key === record.key) return wallet;
      return record.address === null ? null : wallets.get(record.address) ?? null;
    },
    stillHasRows: async () => false,
    fullBlockSince: null,
  };
}

export async function runChainRecordInboundScan(
  deps: ChainRecordInboundScanDeps,
  options: ChainRecordInboundScanOptions = {},
): Promise<ChainRecordInboundScanReport> {
  const now = (deps.now ?? Date.now)();
  const blockChunk = options.blockChunk ?? envPositiveInt('CHAIN_RECORD_SCAN_BLOCK_CHUNK', DEFAULT_BLOCK_CHUNK);
  const maxLogCalls = options.maxLogCalls ?? envPositiveInt('CHAIN_RECORD_SCAN_MAX_LOG_CALLS', DEFAULT_MAX_LOG_CALLS);
  const addressBatch = Math.max(1, options.addressBatch ?? DEFAULT_ADDRESS_BATCH);
  const maxScanMs = options.maxScanMs ?? envPositiveInt('CHAIN_RECORD_SCAN_MAX_MS', DEFAULT_MAX_SCAN_MS);
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const outOfTime = (): boolean => clock() - startedAt > maxScanMs;
  const native = deps.getNativeTransfers;
  const internal = deps.getInternalTransfers;
  const report: ChainRecordInboundScanReport = {
    from_block: 0, to_block: 0, watched_wallets: 0, logs_seen: 0, native_transfers_seen: 0, internal_transfers_seen: 0, queued: 0,
    already_queued: 0, skipped: 0, log_calls_used: 0, budget_stopped: false,
    set_aside: [], backfill_windows: 0, released: 0, error: null,
    signed_transactions_seen: 0, proven_outbound_queued: 0,
  };

  const head = await deps.getHead();
  const finalizedThrough = head - BASE_WATCHER_CONFIRMATION_FLOOR;
  const stored = await readCheckpoint(deps.db);
  if (stored === null && !deps.initialFromBlock) throw new Error('chain_record_scan_initial_time_unavailable');
  const fromBlock = stored ?? await deps.initialFromBlock!(finalizedThrough);
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || fromBlock > finalizedThrough + 1) throw new Error('chain_record_scan_initial_range_invalid');
  report.from_block = fromBlock;
  report.to_block = fromBlock - 1;
  // Caught up (nothing new is final): the main pass scans nothing, but held rows
  // are still refreshed and repaired rows still backfill below.
  const held = await readSetAsideRecords(deps.db);
  const watchSet = deps.useRegistry
    ? await registryWatchSet(deps, fromBlock, held, now)
    : await listedWatchSet(deps);
  const blockTransfers = deps.useRegistry ? deps.getBlockTransfers : undefined;
  // Records the run's held rows from `fromBlock` on (or refreshes them).
  const holdNew = async (rows: readonly ChainRecordScanSetAsideRow[], heldFrom: number): Promise<void> => {
    for (const row of rows) {
      const existing = held.get(setAsideDocId(row.key));
      const record: SetAsideRecord = existing
        ? { ...existing, reason: row.reason, address: row.address ?? existing.address, last_seen_at_ms: now }
        : {
          schema_version: SET_ASIDE_SCHEMA, key: row.key, reason: row.reason, address: row.address,
          held_from_block: heldFrom, held_through_block: heldFrom - 1, backfill_next_block: heldFrom,
          first_seen_at_ms: now, last_seen_at_ms: now,
        };
      held.set(setAsideDocId(row.key), record);
      await writeSetAside(deps.db, record);
    }
  };
  await holdNew(watchSet.drainNew(), fromBlock);
  const reportSetAside = (): void => {
    report.set_aside = [...watchSet.setAside.values()].map(({ key, reason, address }) => ({ key, reason, address }));
  };
  reportSetAside();
  if (watchSet.setAside.size > 0) {
    console.error('[chain-record-scan] index rows set aside; every other wallet keeps scanning', report.set_aside);
  }

  report.watched_wallets = watchSet.filter.length;
  if (watchSet.filter.length === 0) {
    for (const [id, record] of held) {
      if (watchSet.setAside.has(record.key)) {
        if (finalizedThrough > record.held_through_block) await writeSetAside(deps.db, { ...record, held_through_block: finalizedThrough });
      } else {
        // With no watchable wallet, no held row resolves: its address left the index.
        await deleteSetAside(deps.db, id);
        report.released += 1;
      }
    }
    const next = Math.max(fromBlock, finalizedThrough + 1);
    await writeCheckpoint(deps.db, next, now);
    report.to_block = next - 1;
    return report;
  }
  const batches: string[][] = [];
  const addresses = [...watchSet.filter];
  for (let i = 0; i < addresses.length; i += addressBatch) batches.push(addresses.slice(i, i + addressBatch));

  // A growing watch set must still fit at least one complete configured window. Explicit
  // caller budgets retain their stop semantics; the production default scales with fanout.
  const compact = deps.getCompactWindow;
  const perBlock = !compact && (native || blockTransfers);
  const overhead = compact ? 1 : batches.length * (internal ? 2 : 1);
  const callBudget = options.maxLogCalls !== undefined || process.env.CHAIN_RECORD_SCAN_MAX_LOG_CALLS
    ? maxLogCalls
    : Math.max(maxLogCalls, overhead + (perBlock ? Math.min(blockChunk, finalizedThrough - fromBlock + 1) : 0));
  let processedThrough = fromBlock - 1;
  let calls = 0;
  const queue = async (txHash: string, wallet: ChainRecordScanWallet): Promise<void> => {
    const created = await enqueueChainRecordObservation(deps.db, {
      txHash,
      walletId: wallet.walletId,
      source: 'inbound_scan',
      ownerType: wallet.ownerType,
    }, now);
    if (created) report.queued += 1;
    else report.already_queued += 1;
  };
  try {
    const watchedSet: ReadonlySet<string> = new Set(watchSet.filter);
    let cursor = fromBlock;
    while (cursor <= finalizedThrough) {
      const available = callBudget - calls - overhead;
      const width = Math.min(blockChunk, finalizedThrough - cursor + 1, perBlock ? available : Infinity);
      const end = cursor + width - 1;
      // Whole windows only: a window is scanned iff the budget covers every
      // address batch in it (and, with native discovery, every block of it), so
      // the cursor never passes a block some watched wallet was not asked about.
      const windowCost = compact ? 1 : batches.length + (perBlock ? end - cursor + 1 : 0) + (internal ? batches.length : 0);
      if (width < 1 || calls + windowCost > callBudget || outOfTime()) {
        report.budget_stopped = true;
        break;
      }
      // The logs, the native transfers and the trace are read BEFORE anything in
      // this window is queued, side by side, so a failed read leaves the whole
      // window for the next run.
      calls += windowCost;
      // Every read settles before the window is used or its failure thrown: a
      // read that failed fast must not leave the others running on after this
      // scan returns (relay heap OOM, 2026-10-17).
      const [logs, transfers, internals] = compact
        ? await compact({ fromBlock: cursor, toBlock: end, watched: watchedSet })
          .then((window) => [window.logs, window.transfers, window.internals] as const)
        : await allSettledOrThrow<[
        CanonicalEconomicLog[], BlockTransfers, InternalEthTransferPointer[],
      ]>([
        mapBounded(batches, 4, batch => deps.getLogs({ fromBlock: cursor, toBlock: end, toAddresses: batch })).then(lists => lists.flat()),
        blockTransfers
          ? blockTransfers({ fromBlock: cursor, toBlock: end, toAddresses: watchedSet, fromAddresses: watchSet.signers })
          : native
            ? native({ fromBlock: cursor, toBlock: end, toAddresses: watchedSet }).then((natives) => ({ natives, signed: [] }))
            : Promise.resolve({ natives: [], signed: [] }),
        internal
          ? mapBounded(batches, 4, batch => internal({ fromBlock: cursor, toBlock: end, toAddresses: batch }))
            .then((lists) => lists.flat())
          : Promise.resolve([]),
      ]);
      report.logs_seen += logs.length;
      await mapBounded(logs, CHAIN_RECORD_OWNER_CONCURRENCY, async (log) => {
        if (log.blockNumber < cursor || log.blockNumber > end) throw new Error('chain_record_scan_log_out_of_range');
        const recipient = log.topics.length === 3 ? topicAddress(log.topics[2]) : null;
        // Compact discovery reads a global log stream. Resolve only members of
        // the snapshotted watch set, just as the address-filtered RPC path does.
        if (recipient === null || !watchedSet.has(recipient)) {
          report.skipped += 1;
          return;
        }
        const wallet = recipient === null ? undefined : await watchSet.wallet(recipient);
        if (!wallet || !isCandidate(log, wallet)) {
          report.skipped += 1;
          return;
        }
        await queue(log.transactionHash, wallet);
      });
      report.native_transfers_seen += transfers.natives.length;
      await mapBounded(transfers.natives, CHAIN_RECORD_OWNER_CONCURRENCY, async (transfer) => {
        if (transfer.blockNumber < cursor || transfer.blockNumber > end) throw new Error('chain_record_scan_native_out_of_range');
        const wallet = await watchSet.wallet(transfer.toAddress);
        if (!wallet || !isNativeCandidate(transfer, wallet)) {
          report.skipped += 1;
          return;
        }
        await queue(transfer.transactionHash, wallet);
      });
      report.internal_transfers_seen += internals.length;
      await mapBounded(internals, CHAIN_RECORD_OWNER_CONCURRENCY, async (transfer) => {
        if (transfer.blockNumber < cursor || transfer.blockNumber > end) throw new Error('chain_record_scan_internal_out_of_range');
        const wallet = await watchSet.wallet(transfer.toAddress);
        if (!wallet || !isNativeCandidate(transfer, wallet)) {
          report.skipped += 1;
          return;
        }
        await queue(transfer.transactionHash, wallet);
      });
      // a proven EOA's own transactions, from the same full blocks (replacing
      // the nonce scanner from B_F on). The lane re-verifies the whole transaction.
      report.signed_transactions_seen += transfers.signed.length;
      await mapBounded(transfers.signed, CHAIN_RECORD_OWNER_CONCURRENCY, async (signed) => {
        if (signed.blockNumber < cursor || signed.blockNumber > end) throw new Error('chain_record_scan_signed_out_of_range');
        const signer = (await watchSet.signer(signed.fromAddress)) ?? (compact ? await watchSet.wallet(signed.fromAddress) : null);
        const floor = signer?.key !== undefined && isProvenKey(signer.key) ? PROVEN_OUTBOUND_FLOOR_BLOCK : CHAIN_RECORD_SCAN_NATIVE_FLOOR_BLOCK;
        if (!signer || watchSet.fullBlockSince === null
          || signed.blockNumber < Math.max(signer.eligibilityStartBlock, floor, watchSet.fullBlockSince)) {
          report.skipped += 1;
          return;
        }
        const created = await enqueueChainRecordObservation(deps.db, {
          txHash: signed.transactionHash,
          walletId: signer.walletId,
          source: signer.key !== undefined && isProvenKey(signer.key) ? 'proven_outbound_scan' : 'inbound_scan',
          ownerType: signer.ownerType,
        }, now);
        if (created) report.proven_outbound_queued += 1;
        else report.already_queued += 1;
      });
      // A row this window found it cannot watch is held from this window on.
      await holdNew(watchSet.drainNew(), cursor);
      processedThrough = end;
      cursor = end + 1;
      // Progress is durable per window, not per run (relay heap OOM, 2026-10-17:
      // a run that died mid-way kept its cursor where it started, so the next run
      // re-read the same window). Held rows advance first: the cursor never passes
      // a block that a held row's range does not cover.
      for (const record of held.values()) {
        if (watchSet.setAside.has(record.key) && processedThrough > record.held_through_block) {
          record.held_through_block = processedThrough;
          await writeSetAside(deps.db, record);
        }
      }
      await writeCheckpoint(deps.db, cursor, now);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  reportSetAside();
  // Rows still held: the main scan passed these blocks without them.
  for (const record of held.values()) {
    if (watchSet.setAside.has(record.key) && processedThrough > record.held_through_block) {
      record.held_through_block = processedThrough;
      await writeSetAside(deps.db, record);
    }
  }

  // Repaired rows: backfill exactly the held range for the address, then release.
  if (report.error === null) {
    try {
      for (const [id, record] of held) {
        if (watchSet.setAside.has(record.key)) continue;
        const wallet = await watchSet.releaseTarget(record);
        if (!wallet) {
          // Its address still has rows that cannot be watched now (malformed, contested): the
          // range stays held and resumes from where it stopped once they are repaired.
          if (await watchSet.stillHasRows(record)) continue;
          // The row left the index: nothing can be attributed to it.
          await deleteSetAside(deps.db, id);
          report.released += 1;
          continue;
        }
        let next = record.backfill_next_block;
        while (next <= record.held_through_block) {
          const width = Math.min(blockChunk, record.held_through_block - next + 1,
            native ? callBudget - calls - 1 - (internal ? 1 : 0) : Infinity);
          const end = next + width - 1;
          if (width < 1 || calls + 1 + (native ? width : 0) + (internal ? 1 : 0) > callBudget || outOfTime()) {
            report.budget_stopped = true;
            break;
          }
          calls += 1;
          const logs = await deps.getLogs({ fromBlock: next, toBlock: end, toAddresses: [wallet.address] });
          if (native) calls += end - next + 1;
          if (internal) calls += 1;
          const [natives, internals] = await allSettledOrThrow<[
            readonly NativeTransferPointer[], readonly InternalEthTransferPointer[],
          ]>([
            native ? native({ fromBlock: next, toBlock: end, toAddresses: new Set([wallet.address]) }) : Promise.resolve([]),
            internal ? internal({ fromBlock: next, toBlock: end, toAddresses: [wallet.address] }) : Promise.resolve([]),
          ]);
          report.logs_seen += logs.length;
          for (const log of logs) {
            if (log.blockNumber < next || log.blockNumber > end) throw new Error('chain_record_scan_log_out_of_range');
            if (!isCandidate(log, wallet)) {
              report.skipped += 1;
              continue;
            }
            await queue(log.transactionHash, wallet);
          }
          report.native_transfers_seen += natives.length;
          for (const transfer of natives) {
            if (transfer.blockNumber < next || transfer.blockNumber > end) throw new Error('chain_record_scan_native_out_of_range');
            if (!isNativeCandidate(transfer, wallet)) {
              report.skipped += 1;
              continue;
            }
            await queue(transfer.transactionHash, wallet);
          }
          report.internal_transfers_seen += internals.length;
          for (const transfer of internals) {
            if (transfer.blockNumber < next || transfer.blockNumber > end) throw new Error('chain_record_scan_internal_out_of_range');
            if (!isNativeCandidate(transfer, wallet)) {
              report.skipped += 1;
              continue;
            }
            await queue(transfer.transactionHash, wallet);
          }
          report.backfill_windows += 1;
          next = end + 1;
          await writeSetAside(deps.db, { ...record, backfill_next_block: next, last_seen_at_ms: now });
        }
        if (next > record.held_through_block) {
          // the full-block read skipped this proven EOA's own transactions
          // while it was held; the nonce scanner backfills exactly that range.
          if (deps.useRegistry && wallet.proofMethod === 'eip191_eoa' && watchSet.fullBlockSince !== null) {
            const from = Math.max(record.held_from_block, wallet.eligibilityStartBlock,
              PROVEN_OUTBOUND_FLOOR_BLOCK, watchSet.fullBlockSince);
            await openProvenOutboundRange(deps.db, {
              address: wallet.address, ownerType: wallet.ownerType, fromBlock: from, throughBlock: record.held_through_block,
            }, now);
          }
          await deleteSetAside(deps.db, id);
          report.released += 1;
        }
        if (report.budget_stopped) break;
      }
      // A row the release found it cannot watch is held from the first block the main pass did
      // not cover for it (every earlier block was asked about while it was watchable).
      await holdNew(watchSet.drainNew(), processedThrough + 1);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  }

  report.log_calls_used = calls;
  report.to_block = processedThrough;
  if (processedThrough >= fromBlock) await writeCheckpoint(deps.db, processedThrough + 1, now);
  else if (stored === null) await writeCheckpoint(deps.db, fromBlock, now);
  return report;
}

/** Before the commerce cut line (2026-10-01T04:00Z, block ~52,019,000): the earliest
 * block a native address's held or late range starts at when its own fence is unreadable. The
 * lane refuses anything before the cut line anyway, so a lower floor only costs scan work. */
export const CHAIN_RECORD_SCAN_NATIVE_FLOOR_BLOCK = 52_010_000;

function isProvenKey(key: string | undefined): boolean {
  return key !== undefined && (key.startsWith('proven_') || key.startsWith('person_proven_'));
}

/** Every listing row from the given source documents, under today's per-row rules. */
export function listingRowsFromDocs(
  nativeDocs: ReadonlyArray<{ readonly id: string; data(): unknown }>,
  agentProvenDocs: ReadonlyArray<{ readonly id: string; data(): unknown }>,
  personProvenDocs: ReadonlyArray<{ readonly id: string; data(): unknown }>,
): ChainRecordScanListing[] {
  // Straight from the canonical index: no per-wallet read can drop an address
  // (review r1, defect 2). A row `parseCanonicalNativeAddressIndex`
  // refuses is SET ASIDE (held and backfilled once repaired), never thrown, so
  // one bad row cannot stop every other wallet's receives. The wallet's
  // registration fence is checked by the lane, so the scan pre-filters on none.
  const listed: ChainRecordScanListing[] = nativeDocs.map((doc): ChainRecordScanListing => {
    const raw = doc.data() as Record<string, unknown>;
    try {
      const row = parseCanonicalNativeAddressIndex(raw, doc.id);
      return {
        address: row.address,
        walletId: row.wallet_id,
        ownerType: row.owner_type,
        eligibilityStartBlock: 0,
        key: doc.id,
      };
    } catch (error) {
      const address = typeof raw?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw.address)
        ? raw.address.toLowerCase()
        : null;
      return {
        setAside: true,
        key: doc.id,
        reason: error instanceof Error ? error.message : String(error),
        address,
      };
    }
  });
  // 2026-10-01 — proven external addresses, an agent's and a person's, from
  // their proof's exact H+1 fence. A legacy (pre-v2) agent row has no economic
  // authority and is skipped, as `listProvenAddresses` skips it.
  const provenAddress = (id: string): string | null => (/^0x[0-9a-f]{40}$/.test(id) ? id : null);
  for (const doc of agentProvenDocs) {
    const raw: unknown = doc.data();
    const key = `proven_${doc.id}`;
    if ((raw as { schema_version?: unknown } | undefined)?.schema_version !== PROVEN_ADDRESS_SCHEMA) continue;
    if (!isEconomicallyActiveProvenAddress(raw, doc.id)) {
      listed.push({ setAside: true, key, reason: `proven_address_invalid:${doc.id}`, address: provenAddress(doc.id) });
      continue;
    }
    listed.push({
      address: raw.address,
      walletId: provenObservationWalletId(raw.address),
      ownerType: 'agent',
      eligibilityStartBlock: raw.proven_at_block,
      key,
      proofMethod: raw.proof_method,
    });
  }
  for (const doc of personProvenDocs) {
    const raw: unknown = doc.data();
    const key = `person_proven_${doc.id}`;
    if (!isEconomicallyActiveHumanProvenAddress(raw, doc.id)) {
      listed.push({ setAside: true, key, reason: `person_proven_address_invalid:${doc.id}`, address: provenAddress(doc.id) });
      continue;
    }
    listed.push({
      address: raw.address,
      walletId: provenObservationWalletId(raw.address),
      ownerType: 'human',
      eligibilityStartBlock: raw.proven_at_block,
      key,
      proofMethod: raw.proof_method,
    });
  }
  return listed;
}

/** The listing rows for ONE address: every index row naming it, and its two proven rows. */
async function loadListingRowsFor(db: Firestore, address: string): Promise<ChainRecordScanListing[]> {
  // A fresh collection reference per query: a query is never built on a shared reference.
  const index = () => db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION);
  const [byId, byAddress, agentProven, personProven] = await Promise.all([
    index().doc(nativeWalletAddressIndexId(address)).get(),
    index().where('address', '==', address).get(),
    db.collection(PROVEN_ADDRESSES_COLLECTION).doc(address).get(),
    db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(address).get(),
  ]);
  const native = new Map<string, { readonly id: string; data(): unknown }>();
  if (byId.exists) native.set(byId.id, byId);
  for (const doc of byAddress.docs) if (!native.has(doc.id)) native.set(doc.id, doc);
  return listingRowsFromDocs(
    [...native.values()],
    agentProven.exists ? [agentProven] : [],
    personProven.exists ? [personProven] : [],
  );
}

/** A native address's registration fence, from its inbound admission (null when unreadable). */
async function nativeFenceOf(db: Firestore, address: string): Promise<number | null> {
  const snap = await db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
    .doc(watcherAddressAdmissionDocIdFor('inbound', 8453, address)).get();
  if (!snap.exists) return null;
  try {
    return parseWatcherAddressAdmission(snap.data() as Record<string, unknown>).eligibility_start_block;
  } catch {
    return null;
  }
}

/** A set-aside row's fence as far as it can be read (its proof block, or its native admission). */
async function heldRowFenceOf(db: Firestore, row: ChainRecordScanSetAsideRow): Promise<number | null> {
  if (row.address === null) return null;
  if (isProvenKey(row.key)) {
    const collection = row.key.startsWith('person_proven_') ? HUMAN_PROVEN_ADDRESSES_COLLECTION : PROVEN_ADDRESSES_COLLECTION;
    const raw = (await db.collection(collection).doc(row.address).get()).data() as { proven_at_block?: unknown } | undefined;
    return Number.isSafeInteger(raw?.proven_at_block) ? raw!.proven_at_block as number : null;
  }
  return nativeFenceOf(db, row.address);
}

/**
 * the registry-driven watch set. The filter is the watch registry (written in the
 * same transaction as every source row, add-only). Rows are resolved only for addresses with
 * work this run: a log, transfer or signed transaction naming them, a held record, or a PENDING
 * address — one this scan has not yet asked about since its fence. A pending address whose fence
 * this cursor has already passed (it entered the registry after the scan passed its fence, or
 * the reconcile found it late) gets a held range from its fence, which the repaired-row backfill
 * drains this run, and — for a proven EOA — a nonce-scanner range for its own transactions.
 */
async function registryWatchSet(
  deps: ChainRecordInboundScanDeps,
  fromBlock: number,
  held: Map<string, SetAsideRecord>,
  now: number,
): Promise<ChainRecordWatchSet> {
  const db = deps.db;
  const registry = await ensureWatchRegistrySeeded(db, now);
  const candidates = watchRegistryAddresses(registry);
  const signers = new Set(watchRegistryAddresses(registry, ['agent_proven', 'human_proven']));
  let marked = await readWatchMarks(db, 'chain_record');
  if (marked === null) {
    // First run over this database: the old listing asked about every source row on
    // every run, so every registry address is covered through the current cursor.
    await seedWatchMarks(db, 'chain_record', candidates, now);
    marked = new Set(candidates);
  }
  const late = await readPendingLateRecords(db, 'chain_record');
  const fullBlockSince = await fixFullBlockSince(db, fromBlock, now);

  const setAside = new Map<string, ChainRecordScanSetAsideRow>();
  const fresh: ChainRecordScanSetAsideRow[] = [];
  const register = (rows: readonly ChainRecordScanSetAsideRow[]): void => {
    for (const row of rows) {
      if (setAside.has(row.key)) continue;
      setAside.set(row.key, row);
      fresh.push(row);
    }
  };
  // Retain the small classification, not every source document/proof snapshot.
  const classifiedCache = new Map<string, Promise<{ wallet: ChainRecordScanWallet | undefined;
    setAside: ChainRecordScanSetAsideRow[]; hasRows: boolean }>>();
  const classifyFor = (address: string) => {
    const cached = classifiedCache.get(address);
    if (cached) return cached;
    const loaded = loadListingRowsFor(db, address).then(rows => {
      const classified = classifyListing(rows);
      return { wallet: classified.wallets.get(address), setAside: [...classified.setAside.values()], hasRows: rows.length > 0 };
    });
    classifiedCache.set(address, loaded);
    return loaded;
  };
  const wallet = async (address: string): Promise<ChainRecordScanWallet | undefined> => {
    const lower = address.toLowerCase();
    const classified = await classifyFor(lower);
    register(classified.setAside);
    return classified.wallet;
  };

  // Held records: still held when the row they name still cannot be watched.
  const heldAddress = new Map<string, string | null>();
  for (const record of held.values()) {
    if (record.key.startsWith('late_')) {
      heldAddress.set(record.key, record.address);
      continue;
    }
    let address = record.address;
    if (address === null && !record.key.startsWith('contested_') && !isProvenKey(record.key)) {
      const snap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(record.key).get();
      if (snap.exists) {
        try {
          address = parseCanonicalNativeAddressIndex(snap.data() as Record<string, unknown>, snap.id).address;
        } catch (error) {
          register([{ setAside: true, key: record.key, reason: error instanceof Error ? error.message : String(error), address: null }]);
          continue;
        }
      }
    }
    heldAddress.set(record.key, address);
    if (address !== null) register((await classifyFor(address)).setAside);
  }

  // Pending addresses: never asked about by this scan since their fence.
  const pending = [...new Set([...candidates.filter((a) => !marked!.has(a)), ...late.keys()])].sort();
  const toMark: string[] = [];
  await mapBounded(pending, CHAIN_RECORD_OWNER_CONCURRENCY, async (address) => {
    const classified = await classifyFor(address);
    for (const row of classified.setAside) {
      if (setAside.has(row.key)) continue;
      // Never scanned for this address: hold from its own fence (or the floor), so a repair loses nothing.
      const floor = isProvenKey(row.key) ? PROVEN_OUTBOUND_FLOOR_BLOCK : CHAIN_RECORD_SCAN_NATIVE_FLOOR_BLOCK;
      const heldFrom = Math.min(fromBlock, Math.max(floor, (await heldRowFenceOf(db, row)) ?? floor));
      if (!held.has(setAsideDocId(row.key))) {
        const record: SetAsideRecord = {
          schema_version: SET_ASIDE_SCHEMA, key: row.key, reason: row.reason, address: row.address,
          held_from_block: heldFrom, held_through_block: heldFrom - 1, backfill_next_block: heldFrom,
          first_seen_at_ms: now, last_seen_at_ms: now,
        };
        held.set(setAsideDocId(row.key), record);
        await writeSetAside(db, record);
      }
      register([row]);
    }
    const found = classified.wallet;
    if (found) {
      const proven = isProvenKey(found.key);
      const fence = proven ? found.eligibilityStartBlock : await nativeFenceOf(db, address);
      if (fence === null) {
        // Unknown fence = not yet covered: leave it pending (it is in this run's filter anyway).
        console.error('[chain-record-scan] pending address has no readable fence; retried next run', address);
        return;
      }
      if (late.has(address) || fence <= fromBlock - 1) {
        const floor = proven ? PROVEN_OUTBOUND_FLOOR_BLOCK : CHAIN_RECORD_SCAN_NATIVE_FLOOR_BLOCK;
        const heldFrom = Math.max(fence, floor);
        const key = `late_${address}`;
        if (heldFrom <= fromBlock - 1 && !held.has(setAsideDocId(key))) {
          const record: SetAsideRecord = {
            schema_version: SET_ASIDE_SCHEMA, key, reason: 'chain_record_scan_late_entry', address,
            held_from_block: heldFrom, held_through_block: fromBlock - 1, backfill_next_block: heldFrom,
            first_seen_at_ms: now, last_seen_at_ms: now,
          };
          held.set(setAsideDocId(key), record);
          heldAddress.set(key, address);
          await writeSetAside(db, record);
        }
        if (proven && found.proofMethod === 'eip191_eoa') {
          await openProvenOutboundRange(db, {
            address, ownerType: found.ownerType,
            fromBlock: Math.max(fence, PROVEN_OUTBOUND_FLOOR_BLOCK), throughBlock: fromBlock - 1,
          }, now);
        }
      }
    }
    if (late.has(address)) await clearLateRecord(db, 'chain_record', address);
    toMark.push(address);
  });
  await writeWatchMarks(db, 'chain_record', toMark, now);

  return {
    filter: [...new Set([...candidates, ...pending])],
    signers,
    setAside,
    drainNew: () => fresh.splice(0, fresh.length),
    wallet,
    signer: async (address) => {
      const found = await wallet(address);
      return found && isProvenKey(found.key) && found.proofMethod === 'eip191_eoa' ? found : undefined;
    },
    stillHasRows: async (record) => {
      const address = heldAddress.get(record.key) ?? record.address;
      return typeof address === 'string' && (await classifyFor(address.toLowerCase())).hasRows;
    },
    releaseTarget: async (record) => {
      const address = heldAddress.get(record.key) ?? record.address;
      if (address === null || address === undefined) return null;
      const found = await wallet(address);
      return found ?? null;
    },
    fullBlockSince,
  };
}

/**
 * a source row that names no watchable address (found by the registry's daily reconcile)
 * is set aside here, as the full listing used to on every run, so it is visible in the data-health
 * view and backfilled from where it was first held once repaired.
 */
export async function setAsideUnwatchableSourceRow(
  db: Firestore,
  row: { readonly collection: string; readonly id: string },
  now: number,
): Promise<void> {
  // A proven document is keyed by its address: one whose id is no address can never be
  // watched, so only an index row (keyed by a hash) is held for a later repair.
  if (row.collection !== NATIVE_WALLET_ADDRESS_INDEX_COLLECTION) return;
  const key = row.id;
  const ref = db.collection(CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION).doc(setAsideDocId(key));
  if ((await ref.get()).exists) return;
  const from = (await readCheckpoint(db)) ?? 0;
  await writeSetAside(db, {
    schema_version: SET_ASIDE_SCHEMA, key, reason: `chain_record_scan_source_row_unwatchable:${row.collection}`,
    address: null, held_from_block: from, held_through_block: from - 1, backfill_next_block: from,
    first_seen_at_ms: now, last_seen_at_ms: now,
  });
}

async function readSetAsideRecords(db: Firestore): Promise<Map<string, SetAsideRecord>> {
  const snap = await db.collection(CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION).get();
  const out = new Map<string, SetAsideRecord>();
  for (const doc of snap.docs) {
    const record = parseSetAside(doc.data() as Record<string, unknown>);
    // A set-aside record is the scan's own bookkeeping; a malformed one is an
    // integrity fault, never a reason to silently drop a held range.
    if (!record) throw new Error(`chain_record_scan_set_aside_invalid:${doc.id}`);
    out.set(doc.id, record);
  }
  return out;
}

async function writeSetAside(db: Firestore, record: SetAsideRecord): Promise<void> {
  await db.collection(CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION).doc(setAsideDocId(record.key)).set({ ...record });
}

async function deleteSetAside(db: Firestore, id: string): Promise<void> {
  await db.collection(CHAIN_RECORD_SCAN_SET_ASIDE_COLLECTION).doc(id).delete();
}

/** Production deps: the agreed two-leg Base reads and the canonical native enumeration. */
export function buildChainRecordInboundScanDeps(db: Firestore): ChainRecordInboundScanDeps {
  const assets = Object.keys(BASE_NON_USDC_ASSETS);
  return {
    db,
    initialFromBlock: async (head) => {
      const time = await readAgreedBaseBlockTimestampMs(head);
      return firstBlockAtOrAfter(async (number) => ({ number,
        timestamp: Math.floor((await readAgreedBaseBlockTimestampMs(number)) / 1000) }), { number: head, timestamp: Math.floor(time / 1000) }, Math.floor(time / 1000) - CHAIN_RECORD_SCAN_INITIAL_LOOKBACK_SECONDS);
    },
    getCompactWindow: ({ fromBlock, toBlock, watched }) => withRateLimitRetry(
      () => readAdaptivePrimaryDiscoveryWindow({ fromBlock, toBlock, watched, assets }),
    ),
    getHead: () => withRateLimitRetry(() => readAgreedBaseHead()),
    getLogs: ({ fromBlock, toBlock, toAddresses }) => withRateLimitRetry(() => getAgreedBaseLogs({
      address: assets,
      topics: [ERC20_TRANSFER_TOPIC, null, toAddresses.map(addressTopic)],
      fromBlock,
      toBlock,
    })),
    // 2026-10-01: plain native ETH transfers, read from full blocks on both legs.
    getNativeTransfers: ({ fromBlock, toBlock, toAddresses }) => withRateLimitRetry(
      () => readAgreedBaseNativeTransfersTo({ fromBlock, toBlock, toAddresses }),
    ),
    // 2026-10-01: ETH that arrives inside a transaction, from the trace.
    getInternalTransfers: ({ fromBlock, toBlock, toAddresses }) => withRateLimitRetry(
      () => readBaseInternalEthPointers({ fromBlock, toBlock, toAddresses }),
    ),
    listWallets: async () => {
      const [snap, agentProven, personProven] = await Promise.all([
        db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).get(),
        db.collection(PROVEN_ADDRESSES_COLLECTION).get(),
        db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).get(),
      ]);
      return listingRowsFromDocs(snap.docs, agentProven.docs, personProven.docs);
    },
    // production reads the watch registry and resolves only addresses with work.
    useRegistry: true,
    // one full-block read per block finds both the plain ETH receives and
    // every transaction a watched proven EOA signed.
    getBlockTransfers: ({ fromBlock, toBlock, toAddresses, fromAddresses }) => withRateLimitRetry(
      () => readAgreedBaseBlockTransfers({ fromBlock, toBlock, toAddresses, fromAddresses }),
    ),
  };
}
