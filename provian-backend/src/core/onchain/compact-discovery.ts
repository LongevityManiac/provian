import { createHash } from 'crypto';
import { assertCompleteTraceTrees, type TraceTreeNode } from './trace-tree';
import { ethers } from 'ethers';
import { mapBounded, allSettledOrThrow } from '../net/map-bounded';
import { getOperatorBoundRpcLegs, type OperatorBoundRpcLeg } from './rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, ERC20_TRANSFER_TOPIC,
  readBaseInternalEthPointers,
  normalizeLog, BASE_GETLOGS_MAX_RANGE_BLOCKS,
  type BlockTransfers, type CanonicalEconomicLog, type InternalEthTransferPointer } from './economic-discovery';
import type { EconomicStateRpcLeg } from './economic-state';

interface Root {
  readonly hash: string;
  readonly block: number;
  readonly blockHash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly inputHash: string;
  readonly inputEmpty: boolean;
}
interface RootIdentity { readonly block: number; readonly blockHash: string; readonly hash: string }
interface TraceAddressFilter { readonly fromAddress?: readonly string[]; readonly toAddress?: readonly string[]; readonly mode?: 'union' }
export interface CompactDiscoveryWindow {
  readonly mode?: 'global-traces' | 'paired-blocks' | 'block-traces' | 'filtered-traces';
  readonly logs: readonly CanonicalEconomicLog[];
  readonly transfers: BlockTransfers;
  readonly internals: readonly InternalEthTransferPointer[];
}
export interface CompactDiscoveryOptions {
  readonly rootMode?: 'global-traces' | 'paired-blocks' | 'block-traces' | 'filtered-traces';
  /** Returns untrusted routing pointers only. The observation drain verifies both operators before any PE. */
  readonly primaryDiscoveryOnly?: boolean;
  readonly filteredTraceMode?: 'union' | 'separate';
  readonly traceRangeBlocks?: number;
  readonly pairedTraceRangeBlocks?: number;
  readonly chainId?: 8453 | 84532;
  readonly legs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
  readonly blockTraceSample?: { readonly block: number; readonly traces: readonly unknown[] };
  readonly readLogs?: typeof getAgreedBaseLogs;
  readonly readBlockHash?: typeof readAgreedBaseBlockHash;
}
function configuredLegs(): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const legs = getOperatorBoundRpcLegs('base');
  const wrap = (leg: OperatorBoundRpcLeg): EconomicStateRpcLeg => ({
    operatorId: leg.operatorId,
    send: async (method, params): Promise<unknown> => leg.provider.send(method, [...params]),
  });
  return selectDiscoveryRpcLegs([wrap(legs[0]), wrap(legs[1])], process.env.BASE_DISCOVERY_RPC_OPERATOR_ID);
}
/** Discovery preference only orders the same two independent operators. */
export function selectDiscoveryRpcLegs(legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg], preferred?: string): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('compact_discovery_operators_not_independent');
  if (preferred === undefined || preferred === legs[0].operatorId) return legs;
  if (preferred === legs[1].operatorId) return [legs[1], legs[0]];
  throw new Error('compact_discovery_preferred_operator_unavailable');
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('compact_discovery_object_invalid');
  return raw as Record<string, unknown>;
}
function number(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) ? Number(BigInt(raw)) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('compact_discovery_number_invalid');
  return n;
}
function traceQuantity(raw: unknown): number {
  return number(typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw);
}
function hash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error('compact_discovery_hash_invalid');
  return raw.toLowerCase();
}
function address(raw: unknown): string {
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) throw new Error('compact_discovery_address_invalid');
  return raw.toLowerCase();
}
function value(raw: unknown): string {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw new Error('compact_discovery_value_invalid');
  return BigInt(raw).toString();
}
/** Retain a byte commitment, not every watched transaction's calldata. */
function inputFacts(raw: unknown): Pick<Root, 'inputHash' | 'inputEmpty'> {
  if (typeof raw !== 'string' || raw.length % 2 !== 0 || !/^0x[0-9a-f]*$/i.test(raw)) throw new Error('compact_discovery_input_invalid');
  return { inputHash: createHash('sha256').update(raw.toLowerCase()).digest('hex'), inputEmpty: raw.length === 2 };
}
function sameRoots(left: readonly Root[], right: readonly Root[]): boolean {
  if (left.length !== right.length) return false;
  const order = (a: Root, b: Root) => a.block - b.block || a.hash.localeCompare(b.hash);
  const a = [...left].sort(order), b = [...right].sort(order);
  return a.every((root, i) => root.hash === b[i].hash && root.block === b[i].block && root.blockHash === b[i].blockHash
    && root.from === b[i].from && root.to === b[i].to && root.value === b[i].value
    && root.inputHash === b[i].inputHash && root.inputEmpty === b[i].inputEmpty);
}

/**
 * Read one global stream instead of one stream per watched-address batch.
 * Primary traces and independent secondary blocks must agree on EVERY watched
 * root transaction, including failed/zero-value calls and creates. The primary
 * also supplies internal-ETH pointers; monetary verification of those still
 * requires both independent trace operators in the existing observation lane.
 */
export async function readCompactDiscoveryWindow(args: {
  readonly fromBlock: number; readonly toBlock: number;
  readonly watched: ReadonlySet<string>; readonly assets: readonly string[];
}, options: CompactDiscoveryOptions = {}): Promise<CompactDiscoveryWindow> {
  if (!Number.isSafeInteger(args.fromBlock) || !Number.isSafeInteger(args.toBlock)
    || args.fromBlock < 0 || args.toBlock < args.fromBlock) throw new Error('compact_discovery_range_invalid');
  const configured = options.legs ?? configuredLegs();
  if (configured[0].operatorId === configured[1].operatorId) throw new Error('compact_discovery_operators_not_independent');
  const ids = await Promise.all(configured.map((leg) => leg.send('eth_chainId', [])));
  if (ids.some((id) => typeof id !== 'string' || BigInt(id) !== BigInt(options.chainId ?? 8453))) throw new Error('compact_discovery_chain_mismatch');
  const heights = Array.from({ length: args.toBlock - args.fromBlock + 1 }, (_, i) => args.fromBlock + i);
  const roots: Root[] = [];
  const allRoots: RootIdentity[] = [];
  const internals: InternalEthTransferPointer[] = [];
  const observedBlockHashes = new Map<number, string>();
  const observeBlock = (height: number, blockHash: string): void => {
    const previous = observedBlockHashes.get(height);
    if (previous && previous !== blockHash) throw new Error('compact_discovery_primary_inconsistent');
    observedBlockHashes.set(height, blockHash);
  };
  const traceRange = options.traceRangeBlocks ?? 100;
  if (!Number.isSafeInteger(traceRange) || traceRange < 1 || traceRange > 100) throw new Error('compact_discovery_trace_piece_invalid');
  const traceRanges = heights.filter((_, i) => i % traceRange === 0);
  const parseTraces = (raw: readonly unknown[], from: number, through: number) => {
    const parsedRoots: Root[] = [], parsedInternals: InternalEthTransferPointer[] = [];
    const identities: RootIdentity[] = [];
    const tree: TraceTreeNode[] = [];
    for (const entry of raw) {
      const t = object(entry);
      const block = number(t.blockNumber);
      if (block < from || block > through) throw new Error('compact_discovery_trace_out_of_range');
      if (options.primaryDiscoveryOnly) observeBlock(block, hash(t.blockHash));
      const action = object(t.action);
      if (!Array.isArray(t.traceAddress)) throw new Error('compact_discovery_trace_path_invalid');
      if (t.type !== 'reward') {
        const path = t.traceAddress.map(traceQuantity);
        const childCount = traceQuantity(t.subtraces);
        const transaction = hash(t.transactionHash);
        tree.push({ key: `${transaction}:${path.join('.')}`,
          parent: path.length ? `${transaction}:${path.slice(0, -1).join('.')}` : null,
          index: path.length ? path[path.length - 1] : 0, children: childCount,
          block, blockHash: hash(t.blockHash) });
      }
      const root = t.traceAddress.length === 0;
      if (root && (t.type === 'call' || t.type === 'create')) {
        identities.push({ block, blockHash: hash(t.blockHash), hash: hash(t.transactionHash) });
        const fromAddress = address(action.from);
        const to = t.type === 'create' ? null : address(action.to);
        if (args.watched.has(fromAddress) || (to !== null && args.watched.has(to))) {
          parsedRoots.push({ hash: hash(t.transactionHash), block, blockHash: hash(t.blockHash),
            from: fromAddress, to, value: value(action.value), ...inputFacts(t.type === 'create' ? action.init : action.input) });
        }
      }
      if (t.error !== undefined) continue;
      let fromAddress: string; let to: string; let amount: string;
      if (t.type === 'call' && action.callType === 'call') {
        if (typeof action.to !== 'string' || !args.watched.has(action.to.toLowerCase())) continue;
        fromAddress = address(action.from); to = address(action.to); amount = value(action.value);
      } else if ((t.type === 'suicide' || t.type === 'selfdestruct')) {
        if (typeof action.refundAddress !== 'string' || !args.watched.has(action.refundAddress.toLowerCase())) continue;
        fromAddress = address(action.address); to = address(action.refundAddress); amount = value(action.balance);
      } else continue;
      if (BigInt(amount) > 0n) parsedInternals.push({ transactionHash: hash(t.transactionHash), blockNumber: block,
        fromAddress, toAddress: to, valueWei: amount });
    }
    return { roots: parsedRoots, internals: parsedInternals, identities, tree };
  };
  const readTraceRange = async (from: number, through: number, addressFilter?: TraceAddressFilter): Promise<void> => {
    const localRoots: Root[] = [];
    const localInternals: InternalEthTransferPointer[] = [];
    const localIdentities: RootIdentity[] = [];
    const localTree: TraceTreeNode[] = [];
    try {
      let after = 0;
      const pages = new Set<string>();
      for (;;) {
        const raw = await configured[0].send('trace_filter', [{ fromBlock: ethers.toQuantity(from),
          toBlock: ethers.toQuantity(through), ...addressFilter, after, count: 1000 }]);
        if (!Array.isArray(raw)) throw new Error('compact_discovery_trace_unavailable');
        if (raw.length === 0) break;
        const digest = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
        if (pages.has(digest)) throw new Error('compact_discovery_trace_pagination_stalled');
        pages.add(digest);
        after += raw.length;
        const parsed = parseTraces(raw, from, through);
        localRoots.push(...parsed.roots); localInternals.push(...parsed.internals);
        localIdentities.push(...parsed.identities);
        localTree.push(...parsed.tree);
      }
      if (!addressFilter) assertCompleteTraceTrees(localTree);
      else if (new Set(localTree.map(node => node.key)).size !== localTree.length) throw new Error('compact_discovery_trace_tree_duplicate');
      roots.push(...localRoots);
      internals.push(...localInternals);
      allRoots.push(...localIdentities);
    } catch (error) {
      // Retry bounded pieces without retaining any partial pages from this range.
      if (from >= through || !/timeout|timed out|block range|too many|result.*limit|response.*size|query.*more|limit.*exceed/i.test(String(error))) throw error;
      const middle = from + Math.floor((through - from) / 2);
      await readTraceRange(from, middle, addressFilter);
      await readTraceRange(middle + 1, through, addressFilter);
    }
  };
  const globalTraces = async () => mapBounded(traceRanges, 16, from => readTraceRange(from, Math.min(from + traceRange - 1, args.toBlock)));
  const blocks = async (leg: EconomicStateRpcLeg) => mapBounded(heights, 16, async (height) => {
    const b = object(await leg.send('eth_getBlockByNumber', [ethers.toQuantity(height), true]));
    if (number(b.number) !== height || !Array.isArray(b.transactions)) throw new Error('compact_discovery_block_unavailable');
    const blockHash = hash(b.hash);
    const selected: Root[] = [];
    for (const tx of b.transactions) {
      const t = object(tx);
      const from = address(t.from);
      const to = t.to === null ? null : address(t.to);
      if (!args.watched.has(from) && (to === null || !args.watched.has(to))) continue;
      selected.push({ hash: hash(t.hash), block: height, blockHash, from, to, value: value(t.value), ...inputFacts(t.input) });
    }
    return { height, hash: blockHash, parent: hash(b.parentHash), roots: selected,
      transactionHashes: b.transactions.map(tx => hash(object(tx).hash)) };
  });
  const traces = async (): Promise<void> => {
    if (options.rootMode === 'filtered-traces') {
      if (!options.primaryDiscoveryOnly) throw new Error('compact_discovery_filtered_requires_pointer_mode');
      const addresses = [...args.watched];
      const batches = Array.from({ length: Math.ceil(addresses.length / 5000) }, (_, i) => addresses.slice(i * 5000, (i + 1) * 5000));
      const work = batches.flatMap(batch => heights.filter((_, i) => i % 100 === 0).flatMap<{ from: number; filter: TraceAddressFilter }>(from =>
        options.filteredTraceMode === 'union' ? [{ from, filter: { fromAddress: batch, toAddress: batch, mode: 'union' as const } }]
          : [{ from, filter: { fromAddress: batch } }, { from, filter: { toAddress: batch } }]));
      await mapBounded(work, 16, task => readTraceRange(task.from, Math.min(task.from + 99, args.toBlock), task.filter));
      return;
    }
    if (options.rootMode === 'block-traces') {
      // Complete traces are much larger than blocks. Bound their in-flight
      // payloads separately; this changes latency, never calls or coverage.
      await mapBounded(heights, 4, async height => {
        const raw = options.blockTraceSample?.block === height ? options.blockTraceSample.traces
          : await configured[0].send('trace_block', [ethers.toQuantity(height)]);
        if (!Array.isArray(raw)) throw new Error('compact_discovery_trace_unavailable');
        const parsed = parseTraces(raw, height, height);
        assertCompleteTraceTrees(parsed.tree);
        roots.push(...parsed.roots); internals.push(...parsed.internals);
        allRoots.push(...parsed.identities);
      });
      return;
    }
    if (options.rootMode !== 'paired-blocks') { await globalTraces(); return; }
    const addresses = [...args.watched];
    const batches = Array.from({ length: Math.ceil(addresses.length / 5000) }, (_, i) => addresses.slice(i * 5000, (i + 1) * 5000));
    const pairedRange = options.pairedTraceRangeBlocks ?? 100;
    if (!Number.isSafeInteger(pairedRange) || pairedRange < 1 || pairedRange > 100) throw new Error('compact_discovery_trace_piece_invalid');
    const pieces = batches.flatMap(toAddresses => Array.from({ length: Math.ceil(heights.length / pairedRange) }, (_, i) => ({
      toAddresses, fromBlock: args.fromBlock + i * pairedRange, toBlock: Math.min(args.fromBlock + (i + 1) * pairedRange - 1, args.toBlock),
    })));
    const [primary, movements] = await allSettledOrThrow([
      blocks(configured[0]), mapBounded(pieces, 16, piece => readBaseInternalEthPointers(piece, { traceLegs: configured })).then(rows => rows.flat()),
    ] as const);
    roots.push(...primary.flatMap(b => b.roots));
    internals.push(...movements);
  };
  if (options.primaryDiscoveryOnly) {
    const [, rawLogs] = await allSettledOrThrow([
      traces(), options.readLogs ? options.readLogs({ address: [...args.assets], topics: [ERC20_TRANSFER_TOPIC],
        fromBlock: args.fromBlock, toBlock: args.toBlock }, { rpcLegs: configured }) : readPrimaryLogs(args, configured[0]),
    ] as const);
    // From/to filters can return the same root. They are routing hints, never
    // financial authority; contradictory primary replies still stop this window.
    const uniqueRoots = new Map<string, Root>();
    for (const root of roots) {
      const previous = uniqueRoots.get(root.hash);
      if (previous && !sameRoots([previous], [root])) throw new Error('compact_discovery_primary_inconsistent');
      uniqueRoots.set(root.hash, root);
    }
    const selected = [...uniqueRoots.values()];
    const uniqueInternal = new Map<string, InternalEthTransferPointer>();
    for (const pointer of internals) uniqueInternal.set(`${pointer.transactionHash}:${pointer.toAddress}`, pointer);
    const logs = rawLogs.filter(log => log.topics.length >= 3 && args.watched.has(`0x${log.topics[2].slice(-40)}`));
    for (const log of rawLogs) observeBlock(log.blockNumber, log.blockHash);
    // Compare the sparse paired boundary with any primary facts at that height.
    // The primary supplies discovery coverage; both operators verify each queued
    // transaction before its facts can authorize a PE or payment.
    const boundaryHash = await (options.readBlockHash ?? readAgreedBaseBlockHash)(args.toBlock, { rpcLegs: configured });
    if (boundaryHash === null) throw new Error('compact_discovery_boundary_unavailable');
    observeBlock(args.toBlock, boundaryHash);
    return { mode: options.rootMode ?? 'global-traces', logs,
      transfers: {
        natives: selected.filter(r => r.to !== null && args.watched.has(r.to) && BigInt(r.value) > 0n && r.inputEmpty)
          .map(r => ({ transactionHash: r.hash, blockNumber: r.block, fromAddress: r.from, toAddress: r.to!, valueWei: r.value })),
        signed: selected.filter(r => args.watched.has(r.from))
          .map(r => ({ transactionHash: r.hash, blockNumber: r.block, fromAddress: r.from })),
      }, internals: [...uniqueInternal.values()] };
  }
  const [, secondary, logs] = await allSettledOrThrow([
    traces(), blocks(configured[1]), (options.readLogs ?? getAgreedBaseLogs)({ address: [...args.assets],
      topics: [ERC20_TRANSFER_TOPIC], fromBlock: args.fromBlock, toBlock: args.toBlock }, { rpcLegs: configured }),
  ] as const);
  if (!sameRoots(roots, secondary.flatMap((b) => b.roots))) throw new Error('compact_discovery_rpc_disagreement:roots');
  if (options.rootMode !== 'paired-blocks') {
    // An unwatched outer transaction can pay a watched address internally.
    // Bind ALL traced roots to independent canonical blocks before trusting the
    // pointer stream; comparing watched roots alone cannot detect its omission.
    const byBlock = new Map<number, RootIdentity[]>();
    for (const root of allRoots) {
      const group = byBlock.get(root.block) ?? []; group.push(root); byBlock.set(root.block, group);
    }
    for (const block of secondary) {
      const traced = byBlock.get(block.height) ?? [];
      if (traced.some(root => root.blockHash !== block.hash)
        || JSON.stringify(traced.map(root => root.hash).sort()) !== JSON.stringify([...block.transactionHashes].sort())) {
        throw new Error('compact_discovery_rpc_disagreement:all_roots');
      }
    }
  }
  for (let i = 1; i < secondary.length; i++) {
    if (secondary[i].parent !== secondary[i - 1].hash) throw new Error('compact_discovery_block_chain_changed');
  }
  const endHash = await (options.readBlockHash ?? readAgreedBaseBlockHash)(args.toBlock, { rpcLegs: configured });
  if (endHash !== secondary[secondary.length - 1].hash) throw new Error('compact_discovery_boundary_changed');
  const transfers: BlockTransfers = {
    natives: roots.filter((r) => r.to !== null && args.watched.has(r.to) && BigInt(r.value) > 0n && r.inputEmpty)
      .map((r) => ({ transactionHash: r.hash, blockNumber: r.block, fromAddress: r.from, toAddress: r.to!, valueWei: r.value })),
    signed: roots.filter((r) => args.watched.has(r.from))
      .map((r) => ({ transactionHash: r.hash, blockNumber: r.block, fromAddress: r.from })),
  };
  return { logs, transfers, internals, mode: options.rootMode ?? 'global-traces' };
}


/** Estimate both complete paginated read strategies from one canonical block. */
export function estimateDiscoveryCu(blocks: number, watched: number, sampleFrames: number, batchMatches: readonly number[]): {
  globalTraceCu: number; pairedBlockCu: number; blockTraceCu: number;
} {
  if (![blocks, watched, sampleFrames].every(Number.isSafeInteger) || blocks < 1 || watched < 0 || sampleFrames < 0
    || batchMatches.length !== Math.ceil(watched / 5000)
    || batchMatches.some(n => !Number.isSafeInteger(n) || n < 0)
    || batchMatches.reduce((sum, n) => sum + n, 0) > sampleFrames) throw new Error('compact_discovery_cost_sample_invalid');
  const range = Math.max(1, Math.min(100, Math.floor(20_000 / Math.max(1, sampleFrames))));
  const pages = (density: number, width: number): number => {
    let count = 0;
    for (let from = 0; from < blocks; from += width) count += Math.ceil(density * Math.min(width, blocks - from) / 1000) + 1;
    return count;
  };
  return { globalTraceCu: 20 + 40 * pages(sampleFrames, range),
    pairedBlockCu: 20 + 20 * blocks + 40 * batchMatches.reduce((sum, density) => sum + pages(density, 100), 0),
    blockTraceCu: 20 * blocks };
}
export function cheaperDiscoveryMode(blocks: number, watched: number, sampleFrames: number, batchMatches: readonly number[]): 'global-traces' | 'paired-blocks' | 'block-traces' {
  const cost = estimateDiscoveryCu(blocks, watched, sampleFrames, batchMatches);
  if (cost.globalTraceCu < Math.min(cost.pairedBlockCu, cost.blockTraceCu)) return 'global-traces';
  return cost.blockTraceCu <= cost.pairedBlockCu ? 'block-traces' : 'paired-blocks';
}
/** Cost choice changes reads, never coverage, independent operators or confirmation depth. */
export async function readAdaptiveDiscoveryWindow(args: Parameters<typeof readCompactDiscoveryWindow>[0], options: CompactDiscoveryOptions = {}): Promise<CompactDiscoveryWindow> {
  const legs = options.legs ?? configuredLegs();
  const width = args.toBlock - args.fromBlock + 1;
  const sample = args.fromBlock + Math.floor((width - 1) / 2);
  // One complete trace_block costs less than even one trace_filter page and
  // is reused when block traces are selected. Never sample a truncated page.
  const raw: unknown = await legs[0].send('trace_block', [ethers.toQuantity(sample)]);
  if (!Array.isArray(raw)) throw new Error('compact_discovery_trace_unavailable');
  const frames = raw.length;
  const addressBatch = new Map([...args.watched].map((address, index) => [address.toLowerCase(), Math.floor(index / 5000)]));
  const batchMatches = Array.from({ length: Math.ceil(args.watched.size / 5000) }, () => 0);
  for (const frame of raw) {
    const trace = object(frame), action = object(trace.action);
    const target = action.to ?? action.refundAddress ?? (trace.type === 'create' && trace.result ? object(trace.result).address : undefined);
    const batch = typeof target === 'string' ? addressBatch.get(target.toLowerCase()) : undefined;
    if (batch !== undefined) batchMatches[batch]++;
  }
  return readCompactDiscoveryWindow(args, { ...options, legs, blockTraceSample: { block: sample, traces: raw },
    rootMode: cheaperDiscoveryMode(width, args.watched.size, frames, batchMatches),
    // Bound serial pagination to about twenty pages without assuming block seconds.
    traceRangeBlocks: Math.max(1, Math.min(100, Math.floor(20_000 / Math.max(1, frames)))),
  });
}


/** Primary discovery records no chain facts: only the unchanged observation
 * queue can receive these pointers, and its two-provider verifier owns PE creation. */
async function readPrimaryLogs(
  args: { readonly fromBlock: number; readonly toBlock: number; readonly assets: readonly string[]; readonly watched: ReadonlySet<string> },
  primary: EconomicStateRpcLeg,
): Promise<readonly CanonicalEconomicLog[]> {
  if (args.assets.length === 0) return [];
  if (!args.assets.every(asset => ethers.isAddress(asset))) throw new Error('compact_discovery_assets_invalid');
  const assets = new Set(args.assets.map(asset => asset.toLowerCase()));
  // One request costs the same with a recipient filter. Larger watch sets use
  // the global stream to avoid multiplying paid requests by address batches.
  const topics: readonly (string | null | readonly string[])[] = args.watched.size > 0 && args.watched.size <= 5000
    ? [ERC20_TRANSFER_TOPIC, null, [...args.watched].map(wallet => ethers.zeroPadValue(wallet, 32))] : [ERC20_TRANSFER_TOPIC];
  const logs: CanonicalEconomicLog[] = []; let width = BASE_GETLOGS_MAX_RANGE_BLOCKS;
  for (let from = args.fromBlock; from <= args.toBlock;) {
    const through = Math.min(from + width - 1, args.toBlock);
    let raw: unknown;
    try {
      raw = await primary.send('eth_getLogs', [{ address: [...assets], topics,
        fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(through) }]);
    } catch (error) {
      if (through > from && /too many (?:results|logs)|query returned more than|response size exceeded|block.*range.*limit|eth_getLogs is limited to a \d+ range/i.test(String(error))) {
        width = Math.max(1, Math.floor((through - from + 1) / 2)); continue;
      }
      throw error;
    }
    if (!Array.isArray(raw)) throw new Error('compact_discovery_logs_invalid');
    for (const item of raw) {
      const log = normalizeLog(item);
      if (!assets.has(log.address) || log.blockNumber < from || log.blockNumber > through
        || log.removed || log.topics.length < 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) throw new Error('compact_discovery_log_filter_mismatch');
      logs.push(log);
    }
    from = through + 1;
  }
  return logs;
}

export function estimatePrimaryDiscoveryCu(
  blocks: number, watched: number, sampleFrames: number,
  fromMatches: readonly number[], toMatches: readonly number[], unionMatches?: readonly number[], tracePageCu: 20 | 40 = 40,
): { readonly globalTraceCu: number; readonly blockTraceCu: number; readonly filteredTraceCu: number } {
  // Reuse all range/density validation, including terminating empty pages.
  const global = estimateDiscoveryCu(blocks, watched, sampleFrames, toMatches);
  estimateDiscoveryCu(blocks, watched, sampleFrames, fromMatches);
  if (unionMatches) {
    if (unionMatches.length !== fromMatches.length || unionMatches.some((n, i) => !Number.isSafeInteger(n)
      || n < Math.max(fromMatches[i], toMatches[i]) || n > fromMatches[i] + toMatches[i])) throw new Error('compact_discovery_cost_sample_invalid');
  }
  const pages = (density: number): number => {
    let count = 0;
    for (let from = 0; from < blocks; from += 100) count += Math.ceil(density * Math.min(100, blocks - from) / 1000) + 1;
    return count;
  };
  return { globalTraceCu: 20 + (global.globalTraceCu - 20) * tracePageCu / 40, blockTraceCu: global.blockTraceCu,
    filteredTraceCu: 20 + tracePageCu * (unionMatches ?? [...fromMatches, ...toMatches]).reduce((sum, density) => sum + pages(density), 0) };
}

/** Prove OR semantics with positive matches exclusive to each direction. Empty
 * replies and single-direction samples cannot establish union support. */
export async function probeTraceFilterUnion(leg: EconomicStateRpcLeg, block: number, raw: readonly unknown[]): Promise<boolean> {
  const rows = raw.filter(frame => object(frame).type !== 'reward').map(frame => {
    const trace = object(frame), action = object(trace.action);
    return { trace, from: action.from ?? action.address,
      to: action.to ?? action.refundAddress ?? (trace.type === 'create' && trace.result ? object(trace.result).address : undefined) };
  });
  const sources = [...new Set(rows.map(row => row.from).filter((item): item is string => typeof item === 'string'))].slice(0, 16);
  const targets = [...new Set(rows.map(row => row.to).filter((item): item is string => typeof item === 'string'))].slice(0, 16);
  const identity = (trace: Record<string, unknown>): string => `${hash(trace.transactionHash)}:${JSON.stringify(trace.traceAddress)}:${hash(trace.blockHash)}`;
  for (const from of sources) for (const to of targets) {
    const expected = rows.filter(row => row.from === from || row.to === to);
    if (expected.length >= 1000 || !expected.some(row => row.from === from && row.to !== to)
      || !expected.some(row => row.to === to && row.from !== from)) continue;
    let reply: unknown;
    try {
      reply = await leg.send('trace_filter', [{ fromBlock: ethers.toQuantity(block), toBlock: ethers.toQuantity(block),
        fromAddress: [from], toAddress: [to], mode: 'union', after: 0, count: 1000 }]);
    } catch (error) {
      if (/invalid (?:params|argument)|unsupported.*mode|unknown.*(?:field|mode)|mode.*(?:unsupported|invalid)/i.test(String(error))) return false;
      throw error;
    }
    if (!Array.isArray(reply) || reply.length !== expected.length) return false;
    const wanted = expected.map(row => identity(row.trace)).sort();
    const received = reply.map(frame => identity(object(frame))).sort();
    return wanted.every((item, index) => item === received[index]);
  }
  return false;
}

export async function readAdaptivePrimaryDiscoveryWindow(
  args: Parameters<typeof readCompactDiscoveryWindow>[0], options: CompactDiscoveryOptions = {},
): Promise<CompactDiscoveryWindow> {
  const legs = options.legs ?? configuredLegs(), width = args.toBlock - args.fromBlock + 1;
  const sample = args.fromBlock + Math.floor((width - 1) / 2);
  const raw: unknown = await legs[0].send('trace_block', [ethers.toQuantity(sample)]);
  if (!Array.isArray(raw)) throw new Error('compact_discovery_trace_unavailable');
  const batches = new Map([...args.watched].map((address, i) => [address.toLowerCase(), Math.floor(i / 5000)]));
  const fromMatches = Array.from({ length: Math.ceil(args.watched.size / 5000) }, () => 0), toMatches = [...fromMatches], unionMatches = [...fromMatches];
  for (const frame of raw) {
    const trace = object(frame), action = object(trace.action);
    const from = action.from ?? action.address;
    const to = action.to ?? action.refundAddress ?? (trace.type === 'create' && trace.result ? object(trace.result).address : undefined);
    const source = typeof from === 'string' ? batches.get(from.toLowerCase()) : undefined;
    const target = typeof to === 'string' ? batches.get(to.toLowerCase()) : undefined;
    if (source !== undefined) fromMatches[source]++;
    if (target !== undefined) toMatches[target]++;
    if (source !== undefined) unionMatches[source]++;
    if (target !== undefined && target !== source) unionMatches[target]++;
  }
  const tracePageCu = legs[0].operatorId === 'drpc' ? 20 : 40;
  let cost = estimatePrimaryDiscoveryCu(width, args.watched.size, raw.length, fromMatches, toMatches, undefined, tracePageCu);
  const unionCost = estimatePrimaryDiscoveryCu(width, args.watched.size, raw.length, fromMatches, toMatches, unionMatches, tracePageCu);
  const useUnion = unionCost.filteredTraceCu + tracePageCu < Math.min(cost.globalTraceCu, cost.blockTraceCu)
    && await probeTraceFilterUnion(legs[0], sample, raw);
  if (useUnion) cost = unionCost;
  const rootMode = cost.filteredTraceCu < Math.min(cost.globalTraceCu, cost.blockTraceCu) ? 'filtered-traces'
    : cost.globalTraceCu < cost.blockTraceCu ? 'global-traces' : 'block-traces';
  return readCompactDiscoveryWindow(args, { ...options, legs, primaryDiscoveryOnly: true, rootMode, filteredTraceMode: useUnion ? 'union' : 'separate',
    blockTraceSample: { block: sample, traces: raw },
    traceRangeBlocks: Math.max(1, Math.min(100, Math.floor(20_000 / Math.max(1, raw.length)))),
  });
}
