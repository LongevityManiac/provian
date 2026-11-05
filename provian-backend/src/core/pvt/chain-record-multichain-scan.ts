/**
 * DISCOVERY ON ARBITRUM ONE AND OP MAINNET for the chain-record lane.
 *
 * The rule holds on every chain the wallet transacts on. On Base the lane is fed
 * by the app's and agents' records, the inbound scan and the proven-address
 * outbound scan. On Arbitrum One and OP Mainnet the app's and agents' records are
 * queued the same way, and this scan finds the rest: every transfer into or out of
 * a watched address there (a receive, a proven address's own send or swap, a
 * native wallet's send the app did not record). It only FINDS a transaction hash
 * and queues it as a pointer (`source: 'multichain_scan'`). The lane re-reads the
 * whole transaction through that chain's two operator-bound legs at the
 * confirmation floor and the agreed safe head, derives the act from the receipt
 * alone, and emits through the unchanged fences. A pointer this scan misreads can
 * cost a wasted read, never a mint.
 *
 * WHO IS WATCHED. Every address in the watch registry (`watch_registry_v1`): native
 * wallets (resolved to their wallet through the canonical address index) and
 * proven addresses, a person's or an agent's, proven by an EOA signature (queued
 * under `proven:<address>`). A contract (EIP-1271) proof shows control on Base
 * only — the same address on another chain can be someone else's contract — so
 * such an address is not watched here, and the lane refuses it off Base.
 *
 * HOW. `alchemy_getAssetTransfers` (external and ERC-20 transfers, both
 * directions) on the chain's Alchemy leg, from a per-(chain, address) block
 * cursor, up to that leg's SAFE block (nothing the lane could not yet verify is
 * passed). A new address starts at the chain's landing block (the first block at
 * or after `MULTICHAIN_COMMERCE_CUT_LINE_MS`), so nothing between the landing and
 * first sight is skipped; the lane's own fence decides what can mint. The scan
 * runs at most every `MULTICHAIN_SCAN_RUN_INTERVAL_MS`, each address at most once
 * per `MULTICHAIN_SCAN_INTERVAL_MS` per chain, and a run resolves and scans at most
 * `maxAddresses` addresses, taken in rotation through the registry, so the reads
 * and calls are bounded and every address is reached. A failed read leaves that
 * address's cursor where it was.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { enqueueChainRecordObservation, provenObservationWalletId, type ChainRecordOwnerType } from './chain-record-watcher';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId, parseCanonicalNativeAddressIndex } from './native-wallet-registration';
import { readWatchRegistry, watchRegistryAddresses, type WatchRegistryKind } from './watch-registry';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { MULTICHAIN_COMMERCE_CUT_LINE_MS, type ChainRecordChainName } from './chain-record-chains';

export const MULTICHAIN_SCAN_CURSORS_COLLECTION = 'chain_record_multichain_cursors';
export const MULTICHAIN_SCAN_META_DOC = 'rotation';
/** Each address, per chain, at most this often. */
export const MULTICHAIN_SCAN_INTERVAL_MS = 60 * 60 * 1000;
/** The whole scan at most this often (the chain-record job ticks every 5 minutes). */
export const MULTICHAIN_SCAN_RUN_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ADDRESSES = 40;
const MAX_PAGES_PER_DIRECTION = 5;
/** A block holding more transactions than this cannot be passed by listing it (refused, never skipped). */
export const MAX_FLOODED_BLOCK_TRANSACTIONS = 5_000;

type OtherChain = Exclude<ChainRecordChainName, 'base'>;

export const MULTICHAIN_SCAN_CHAINS: readonly { readonly chain: OtherChain; readonly chainId: 42161 | 10 }[] = Object.freeze([
  { chain: 'arbitrum', chainId: 42161 },
  { chain: 'optimism', chainId: 10 },
]);

/** One registry address, before resolution. */
export interface MultichainRegistryEntry {
  readonly address: string; // lowercased
  readonly kinds: ReadonlySet<WatchRegistryKind>;
}

/** One watched address the scan can queue for. */
export interface MultichainWatchedAddress {
  readonly address: string; // lowercased
  readonly walletId: string;
  readonly ownerType: ChainRecordOwnerType;
}

/** One transfer a discovery read returned (a pointer). */
export interface DiscoveredTransfer {
  readonly hash: string;
  readonly blockNumber: number;
}

export interface MultichainScanDeps {
  readonly db: Firestore;
  /** Every registry address with its kinds, in a stable order (one registry read). */
  readonly listRegistry: () => Promise<readonly MultichainRegistryEntry[]>;
  /** The wallet an address is queued under, or null when it is not watched here
   * (a malformed row, a contract-proven address). Called only for the run's slice. */
  readonly resolve: (entry: MultichainRegistryEntry) => Promise<MultichainWatchedAddress | null>;
  /** The chain's safe block (the scan never passes it). */
  readonly getSafeHead: (chain: OtherChain) => Promise<number>;
  /** The first block at or after `timestampMs` on the chain. */
  readonly blockAtOrAfter: (chain: OtherChain, timestampMs: number, safeHead: number) => Promise<number>;
  /** Transfers into (`direction: 'to'`) or out of the address from `fromBlock`, read
   * completely through `throughBlock` (≤ `toBlock`; lower when the page bound cut the read). */
  readonly getTransfers: (args: {
    readonly chain: OtherChain;
    readonly address: string;
    readonly direction: 'to' | 'from';
    readonly fromBlock: number;
    readonly toBlock: number;
  }) => Promise<{ readonly transfers: readonly DiscoveredTransfer[]; readonly throughBlock: number }>;
  /** Every transaction hash in one block (read only when the page bound filled inside that block). */
  readonly blockTransactions: (chain: OtherChain, blockNumber: number) => Promise<readonly string[]>;
  readonly now?: () => number;
}

export interface MultichainScanReport {
  skipped?: 'ran_recently';
  watched: number;
  resolved: number;
  scanned: number;
  queued: number;
  already_queued: number;
  errors: Array<{ chain: string; address: string; error: string }>;
}

function cursorId(chainId: number, address: string): string {
  return `${chainId}_${address}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runChainRecordMultichainScan(
  deps: MultichainScanDeps,
  options: { readonly maxAddresses?: number } = {},
): Promise<MultichainScanReport> {
  const now = (deps.now ?? Date.now)();
  const report: MultichainScanReport = { watched: 0, resolved: 0, scanned: 0, queued: 0, already_queued: 0, errors: [] };
  const metaRef = deps.db.collection(MULTICHAIN_SCAN_CURSORS_COLLECTION).doc(MULTICHAIN_SCAN_META_DOC);
  const meta = await metaRef.get();
  const metaData = meta.exists ? meta.data() as Record<string, unknown> : {};
  const lastRun = typeof metaData.last_run_ms === 'number' ? metaData.last_run_ms : 0;
  if (now - lastRun < MULTICHAIN_SCAN_RUN_INTERVAL_MS) return { ...report, skipped: 'ran_recently' };

  const registry = await deps.listRegistry();
  report.watched = registry.length;
  if (registry.length === 0) {
    await metaRef.set({ ...metaData, last_run_ms: now }, { merge: true });
    return report;
  }
  const offsetRaw = metaData.offset;
  const offset = Number.isSafeInteger(offsetRaw) && (offsetRaw as number) >= 0 ? (offsetRaw as number) % registry.length : 0;
  const max = Math.max(1, Math.min(options.maxAddresses ?? DEFAULT_MAX_ADDRESSES, registry.length));
  const slice: MultichainWatchedAddress[] = [];
  for (let i = 0; i < max; i += 1) {
    const entry = registry[(offset + i) % registry.length];
    try {
      const watched = await deps.resolve(entry);
      if (watched) slice.push(watched);
    } catch (error) {
      report.errors.push({ chain: '*', address: entry.address, error: `resolve:${errorText(error)}` });
    }
  }
  report.resolved = slice.length;

  for (const { chain, chainId } of MULTICHAIN_SCAN_CHAINS) {
    let safeHead: number;
    let landingBlock: number;
    try {
      safeHead = await deps.getSafeHead(chain);
      const landingKey = `landing_block_${chainId}`;
      const cached = metaData[landingKey];
      landingBlock = typeof cached === 'number'
        ? cached
        : await deps.blockAtOrAfter(chain, MULTICHAIN_COMMERCE_CUT_LINE_MS, safeHead);
      if (typeof cached !== 'number') {
        metaData[landingKey] = landingBlock;
        await metaRef.set({ [landingKey]: landingBlock }, { merge: true });
      }
    } catch (error) {
      report.errors.push({ chain, address: '*', error: `head:${errorText(error)}` });
      continue;
    }
    for (const entry of slice) {
      const ref = deps.db.collection(MULTICHAIN_SCAN_CURSORS_COLLECTION).doc(cursorId(chainId, entry.address));
      const snap = await ref.get();
      const cursor = snap.exists ? snap.data() as Record<string, unknown> : null;
      // First sight starts at the landing: nothing between the landing and first sight is skipped.
      const nextBlock = typeof cursor?.next_block === 'number' ? cursor.next_block : landingBlock;
      const scannedAt = typeof cursor?.scanned_at_ms === 'number' ? cursor.scanned_at_ms : 0;
      if (now - scannedAt < MULTICHAIN_SCAN_INTERVAL_MS || nextBlock > safeHead) continue;
      try {
        const reads = [];
        for (const direction of ['to', 'from'] as const) {
          reads.push(await deps.getTransfers({ chain, address: entry.address, direction, fromBlock: nextBlock, toBlock: safeHead }));
        }
        // The window passed is only what BOTH directions read completely. A read whose page bound
        // filled inside its first block (one transaction can emit thousands of transfers) can never
        // pass that block by paging, so the block's every transaction is queued instead — the lane
        // re-reads each and derives nothing where the address has no act — and the block is passed.
        const hashes = new Set<string>();
        const passed = reads.map((r) => r.throughBlock);
        if (passed.some((b) => b < nextBlock)) {
          const inBlock = await deps.blockTransactions(chain, nextBlock);
          if (inBlock.length > MAX_FLOODED_BLOCK_TRANSACTIONS) throw new Error('multichain_flooded_block_too_large');
          for (const hash of inBlock) {
            if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('multichain_block_transaction_invalid');
            hashes.add(hash);
          }
          for (let i = 0; i < passed.length; i += 1) passed[i] = Math.max(passed[i], nextBlock);
        }
        const through = Math.min(safeHead, ...passed);
        for (const read of reads) {
          for (const t of read.transfers) {
            if (/^0x[0-9a-f]{64}$/.test(t.hash) && t.blockNumber >= nextBlock && t.blockNumber <= through) hashes.add(t.hash);
          }
        }
        for (const hash of [...hashes].sort()) {
          const created = await enqueueChainRecordObservation(deps.db, {
            txHash: hash, walletId: entry.walletId, source: 'multichain_scan', ownerType: entry.ownerType, chainId,
          }, now);
          if (created) report.queued += 1;
          else report.already_queued += 1;
        }
        // Only after every pointer in the window was queued. A cut read keeps the
        // address due (scanned_at unchanged) so the rest is read on the next run.
        await ref.set({
          chain_id: chainId,
          address: entry.address,
          next_block: Math.max(nextBlock, through + 1),
          scanned_at_ms: through >= safeHead ? now : scannedAt,
        });
        report.scanned += 1;
      } catch (error) {
        report.errors.push({ chain, address: entry.address, error: errorText(error) });
      }
    }
  }
  await metaRef.set({ offset: (offset + max) % registry.length, last_run_ms: now, updated_at_ms: now }, { merge: true });
  return report;
}

// =============================================================================
// PRODUCTION DEPS
// =============================================================================

/** The wallet an entry is queued under (exported for tests). */
export async function resolveMultichainEntry(
  db: Firestore,
  entry: MultichainRegistryEntry,
): Promise<MultichainWatchedAddress | null> {
  const { address, kinds } = entry;
  if (kinds.has('native')) {
    const id = nativeWalletAddressIndexId(address);
    const snap = await db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    // A malformed index row is the Base inbound scan's set-aside; nothing is guessed here.
    const row = parseCanonicalNativeAddressIndex(snap.data() as Record<string, unknown>, id);
    return { address: row.address, walletId: row.wallet_id, ownerType: row.owner_type };
  }
  for (const [kind, collection, ownerType] of [
    ['human_proven', HUMAN_PROVEN_ADDRESSES_COLLECTION, 'human'],
    ['agent_proven', PROVEN_ADDRESSES_COLLECTION, 'agent'],
  ] as const) {
    if (!kinds.has(kind)) continue;
    const snap = await db.collection(collection).doc(address).get();
    const proofMethod = snap.exists ? (snap.data() as Record<string, unknown>).proof_method : undefined;
    // Only an EOA signature proves control of the same address on every chain.
    if (proofMethod !== 'eip191_eoa') return null;
    return { address, walletId: provenObservationWalletId(address), ownerType };
  }
  return null;
}

/** A JSON-RPC sender (the Alchemy leg in production; a fake in tests). */
export type RpcSend = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** Every transfer into / out of `address` in [fromBlock, toBlock], paged and bounded. */
export async function readAlchemyTransfers(
  send: RpcSend,
  args: { readonly address: string; readonly direction: 'to' | 'from'; readonly fromBlock: number; readonly toBlock: number },
  maxPages: number = MAX_PAGES_PER_DIRECTION,
): Promise<{ readonly transfers: readonly DiscoveredTransfer[]; readonly throughBlock: number }> {
  const out: DiscoveredTransfer[] = [];
  let pageKey: string | undefined;
  let lastBlock = args.fromBlock - 1;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await send('alchemy_getAssetTransfers', [{
      fromBlock: `0x${args.fromBlock.toString(16)}`,
      toBlock: `0x${args.toBlock.toString(16)}`,
      [args.direction === 'to' ? 'toAddress' : 'fromAddress']: args.address,
      category: ['external', 'erc20'],
      excludeZeroValue: true,
      withMetadata: false,
      order: 'asc',
      maxCount: '0x3e8',
      ...(pageKey ? { pageKey } : {}),
    }]) as { transfers?: Array<{ hash?: unknown; blockNum?: unknown }>; pageKey?: unknown } | null;
    if (!result || !Array.isArray(result.transfers)) throw new Error('multichain_discovery_reply_invalid');
    for (const t of result.transfers) {
      if (typeof t.hash !== 'string' || typeof t.blockNum !== 'string' || !/^0x[0-9a-fA-F]+$/.test(t.blockNum)) {
        throw new Error('multichain_discovery_transfer_invalid');
      }
      const blockNumber = Number(BigInt(t.blockNum));
      out.push({ hash: t.hash.toLowerCase(), blockNumber });
      lastBlock = Math.max(lastBlock, blockNumber);
    }
    if (typeof result.pageKey !== 'string') return { transfers: out, throughBlock: args.toBlock };
    pageKey = result.pageKey;
  }
  // More pages than the bound: results arrive in block order, so everything
  // before the last block seen was read completely; that block is read again.
  return { transfers: out, throughBlock: lastBlock - 1 };
}

/** The first block whose timestamp is at or after `timestampMs` (binary search on block headers). */
export async function findBlockAtOrAfter(send: RpcSend, timestampMs: number, high: number): Promise<number> {
  const timestampOf = async (n: number): Promise<number> => {
    const block = await send('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]) as { timestamp?: unknown } | null;
    if (!block || typeof block.timestamp !== 'string') throw new Error('multichain_block_unavailable');
    return Number(BigInt(block.timestamp)) * 1_000;
  };
  if (await timestampOf(high) < timestampMs) return high + 1;
  let lo = 0;
  let hi = high;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await timestampOf(mid) >= timestampMs) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function alchemySend(chain: OtherChain): RpcSend {
  const leg = getOperatorBoundRpcLegs(chain).find((l) => l.operatorId === 'alchemy');
  if (!leg) throw new Error(`multichain_discovery_unavailable:${chain}`);
  return (method, params) => leg.provider.send(method, [...params]);
}

export function buildChainRecordMultichainScanDeps(db: Firestore): MultichainScanDeps {
  return {
    db,
    listRegistry: async () => {
      const snapshot = await readWatchRegistry(db);
      if (snapshot === null) return [];
      return watchRegistryAddresses(snapshot).map((address) => ({ address, kinds: snapshot.entries.get(address) ?? new Set() }));
    },
    resolve: (entry) => resolveMultichainEntry(db, entry),
    getSafeHead: async (chain) => {
      const block = await alchemySend(chain)('eth_getBlockByNumber', ['safe', false]) as { number?: unknown } | null;
      if (!block || typeof block.number !== 'string') throw new Error('multichain_safe_head_unavailable');
      return Number(BigInt(block.number));
    },
    blockAtOrAfter: (chain, timestampMs, safeHead) => findBlockAtOrAfter(alchemySend(chain), timestampMs, safeHead),
    getTransfers: ({ chain, ...args }) => readAlchemyTransfers(alchemySend(chain), args),
    blockTransactions: async (chain, blockNumber) => {
      const block = await alchemySend(chain)('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]) as
        { transactions?: unknown } | null;
      if (!block || !Array.isArray(block.transactions) || !block.transactions.every((h) => typeof h === 'string')) {
        throw new Error('multichain_block_unavailable');
      }
      return (block.transactions as string[]).map((h) => h.toLowerCase());
    },
  };
}
