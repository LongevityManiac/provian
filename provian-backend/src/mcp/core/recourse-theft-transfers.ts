/**
 * The theft-report transfer picker for an agent: its outgoing PVT transfers,
 * read from Base logs of the live PVT kernel that the protocol pointer names.
 *
 * Carried byte-identical in `provian-agent-sdk/src/` and `provian-mcp/src/core/`
 * (scripts/check-mcp-tool-parity.mjs). Edit both copies together.
 *
 * History supplies the selection, never restoration authority. A listed
 * transfer must appear identically on both independent RPCs, at or below each
 * one's finalized block. Before a report is submitted the chosen transaction is
 * resolved again from both RPCs (`verifyTheftTransfer`). Burns, incoming
 * transfers, transfers to yourself and transfers of any other token are never
 * offered. An RPC that refuses or disagrees ends the read with an error; it is
 * never treated as "no transfers".
 */
import { Interface, ZeroAddress, formatUnits } from 'ethers';
import type { PointerRpc, ProtocolDeployment } from './protocol-pointer';

export interface RecourseChainNetwork {
  readonly rpcs: readonly [PointerRpc, PointerRpc];
  deployment(): Promise<ProtocolDeployment>;
}
export interface TheftTransferRow {
  readonly chain: string; readonly status: string; readonly hash: string; readonly from: string; readonly to: string;
  readonly amount: string; readonly timestamp: number; readonly contractAddress?: string | null; readonly isRetiredPvt?: boolean;
}
export interface TheftTransfer {
  readonly transactionHash: string; readonly from: string; readonly to: string;
  readonly amount: string; readonly timestamp: number;
}
export interface VerifiedTheftTransfer extends TheftTransfer { readonly block: number; readonly blockHash: string }
export interface ListedTheftTransfer extends TheftTransfer { readonly block: number }
export interface TheftTransferPage {
  readonly account: string; readonly kernel: string;
  /** Lowest and highest block scanned (inclusive). */
  readonly fromBlock: number; readonly toBlock: number;
  readonly transfers: readonly ListedTheftTransfer[];
  /** Pass as `beforeBlock` to read older transfers; null when block 0 was reached. */
  readonly nextBeforeBlock: number | null;
}
export interface TheftTransferScan {
  /** Read only blocks below this one (the previous page's nextBeforeBlock). */
  readonly beforeBlock?: number;
  /** Blocks per eth_getLogs request (default 5,000). */
  readonly windowBlocks?: number;
  /** Most requests per RPC in one call (default 12). */
  readonly windows?: number;
  /** Stop reading older windows once this many transfers are found (default 20).
   * Every transfer in the windows already read is returned, so paging never skips one. */
  readonly limit?: number;
}

const TOKEN = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const TRANSFER_TOPIC = TOKEN.getEvent('Transfer')!.topicHash;
const HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, QUANTITY = /^0x[0-9a-f]+$/i;
export const THEFT_TRANSFER_DEFAULTS = Object.freeze({ windowBlocks: 5_000, windows: 12, limit: 20 });
const MAX_WINDOW_BLOCKS = 50_000, MAX_WINDOWS = 50, MAX_LIMIT = 100;
const fail = (detail?: string): never => {
  throw Error(detail ? `recourse_transfer_history_unavailable: ${detail}` : 'recourse_transfer_history_unavailable');
};

/** Burn, incoming, pending and retired-token entries cannot masquerade as an
 * outgoing PVT loss. One choice per (transaction, recipient). */
export function theftTransferChoices(rows: readonly TheftTransferRow[], account: string, kernel: string): readonly TheftTransfer[] {
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (row.chain !== 'Base' || row.status !== 'confirmed' || row.isRetiredPvt
      || row.contractAddress?.toLowerCase() !== kernel.toLowerCase() || row.from.toLowerCase() !== account.toLowerCase()
      || row.to.toLowerCase() === account.toLowerCase() || row.to.toLowerCase() === ZeroAddress
      || !/^0x[0-9a-f]{64}$/i.test(row.hash) || !/^0x[0-9a-f]{40}$/i.test(row.to)
      || !Number.isFinite(row.timestamp) || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(row.amount)
      || !/[1-9]/.test(row.amount)) return [];
    const key = `${row.hash.toLowerCase()}:${row.to.toLowerCase()}`;
    if (seen.has(key)) return []; seen.add(key);
    return [{ transactionHash: row.hash.toLowerCase(), from: account.toLowerCase(), to: row.to.toLowerCase(), amount: row.amount, timestamp: row.timestamp }];
  });
}

function record(value: unknown, detail: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(detail);
  return value as Record<string, unknown>;
}
function quantity(value: unknown, detail: string): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) return fail(detail);
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) return fail(detail);
  return n;
}
function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`recourse_transfer_scan_invalid: ${name} must be a whole number from 1 to ${max}`);
  return value;
}
const topicAddress = (address: string): string => `0x${'00'.repeat(12)}${address.slice(2)}`;

interface OutgoingLog { readonly hash: string; readonly logIndex: number; readonly block: number; readonly blockHash: string; readonly to: string; readonly value: string }

async function finalizedBlock(rpc: PointerRpc, which: number): Promise<number> {
  let raw: unknown;
  try { raw = await rpc.request('eth_getBlockByNumber', ['finalized', false]); }
  catch (error) { return fail(`RPC ${which} did not return its finalized block (${(error as Error).message})`); }
  return quantity(record(raw, `RPC ${which} returned no finalized block`).number, `RPC ${which} returned an invalid finalized block`);
}

async function outgoingLogs(rpc: PointerRpc, which: number, kernel: string, account: string, from: number, to: number): Promise<OutgoingLog[]> {
  let raw: unknown;
  try {
    raw = await rpc.request('eth_getLogs', [{ address: kernel, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
      topics: [TRANSFER_TOPIC, topicAddress(account)] }]);
  } catch (error) {
    return fail(`RPC ${which} refused the log range ${from}-${to} (${(error as Error).message}); retry with a smaller window`);
  }
  if (!Array.isArray(raw)) return fail(`RPC ${which} returned no log list for blocks ${from}-${to}`);
  const out: OutgoingLog[] = [];
  for (const value of raw) {
    const log = record(value, `RPC ${which} returned an invalid log`);
    if (log.removed === true) return fail(`RPC ${which} returned a removed log`);
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== kernel || !Array.isArray(log.topics)
      || log.topics.length !== 3 || !log.topics.every(t => typeof t === 'string')
      || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC || String(log.topics[1]).toLowerCase() !== topicAddress(account)) {
      return fail(`RPC ${which} returned a log outside the requested filter`);
    }
    const hash = typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : '';
    const blockHash = typeof log.blockHash === 'string' ? log.blockHash.toLowerCase() : '';
    if (!HASH.test(hash) || !HASH.test(blockHash) || typeof log.data !== 'string') return fail(`RPC ${which} returned an incomplete log`);
    const block = quantity(log.blockNumber, `RPC ${which} returned a log without a block number`);
    const logIndex = quantity(log.logIndex, `RPC ${which} returned a log without an index`);
    if (block < from || block > to) return fail(`RPC ${which} returned a log outside blocks ${from}-${to}`);
    const parsed = TOKEN.parseLog({ data: log.data, topics: log.topics as string[] });
    if (!parsed) return fail(`RPC ${which} returned an unreadable transfer`);
    out.push({ hash, logIndex, block, blockHash, to: String(parsed.args.to).toLowerCase(), value: BigInt(parsed.args.value).toString() });
  }
  return out.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
}

async function blockTimestamp(network: RecourseChainNetwork, block: number, blockHash: string): Promise<number> {
  const values = await Promise.all(network.rpcs.map(async (rpc, i) => {
    let raw: unknown;
    try { raw = await rpc.request('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]); }
    catch (error) { return fail(`RPC ${i + 1} did not return block ${block} (${(error as Error).message})`); }
    const row = record(raw, `RPC ${i + 1} returned no block ${block}`);
    if (typeof row.hash !== 'string' || row.hash.toLowerCase() !== blockHash) return fail(`block ${block} is not canonical on RPC ${i + 1}`);
    return quantity(row.timestamp, `RPC ${i + 1} returned block ${block} without a timestamp`);
  }));
  if (values[0] !== values[1]) return fail(`the RPCs disagree on block ${block}`);
  return values[0] * 1000;
}

/** Newest first, a bounded page of the account's finalized outgoing kernel transfers. */
export async function listTheftTransfers(account: string, network: RecourseChainNetwork, scan: TheftTransferScan = {}): Promise<TheftTransferPage> {
  const self = account.toLowerCase();
  if (!ADDRESS.test(self)) throw Error('recourse_transfer_account_invalid');
  const windowBlocks = bounded(scan.windowBlocks, THEFT_TRANSFER_DEFAULTS.windowBlocks, MAX_WINDOW_BLOCKS, 'window');
  const windows = bounded(scan.windows, THEFT_TRANSFER_DEFAULTS.windows, MAX_WINDOWS, 'windows');
  const limit = bounded(scan.limit, THEFT_TRANSFER_DEFAULTS.limit, MAX_LIMIT, 'limit');
  if (scan.beforeBlock !== undefined && (!Number.isSafeInteger(scan.beforeBlock) || scan.beforeBlock < 1)) throw Error('recourse_transfer_scan_invalid: before must be a block number above 0');
  const deployment = await network.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const finalized = Math.min(...await Promise.all(network.rpcs.map((rpc, i) => finalizedBlock(rpc, i + 1))));
  const top = scan.beforeBlock === undefined ? finalized : Math.min(finalized, scan.beforeBlock - 1);
  const found: OutgoingLog[] = [];
  let to = top, lowest = top + 1;
  for (let i = 0; i < windows && to >= 0 && found.length < limit; i++) {
    const from = Math.max(0, to - windowBlocks + 1);
    const [a, b] = await Promise.all(network.rpcs.map((rpc, j) => outgoingLogs(rpc, j + 1, kernel, self, from, to)));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw Error(`recourse_transfer_history_disagreement: the two RPCs return different transfers for blocks ${from}-${to}`);
    }
    found.push(...a);
    lowest = from; to = from - 1;
  }
  // One row per (transaction, recipient), summing several transfers in one transaction.
  const grouped = new Map<string, OutgoingLog>();
  for (const log of found) {
    const key = `${log.hash}:${log.to}`, prior = grouped.get(key);
    grouped.set(key, prior ? { ...prior, value: (BigInt(prior.value) + BigInt(log.value)).toString() } : log);
  }
  const candidates = [...grouped.values()].filter(log => log.to !== self && log.to !== ZeroAddress && BigInt(log.value) > 0n);
  const times = new Map<string, number>();
  for (const log of candidates) if (!times.has(log.blockHash)) times.set(log.blockHash, await blockTimestamp(network, log.block, log.blockHash));
  const rows: TheftTransferRow[] = candidates.map(log => ({ chain: 'Base', status: 'confirmed', hash: log.hash, from: self, to: log.to,
    amount: formatUnits(log.value, 18), timestamp: times.get(log.blockHash) ?? NaN, contractAddress: kernel }));
  const blocks = new Map(candidates.map(log => [`${log.hash}:${log.to}`, log.block]));
  const transfers = theftTransferChoices(rows, self, kernel).map(t => ({ ...t, block: blocks.get(`${t.transactionHash}:${t.to}`) ?? 0 }));
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) return fail('the protocol deployment changed during the read; retry');
  return { account: self, kernel, fromBlock: Math.min(lowest, top), toBlock: top, transfers,
    nextBeforeBlock: lowest > 0 && lowest <= top ? lowest : null };
}

/** Resolve the block and actual transfer from two canonical chain views. No
 * block number is ever requested from the member. */
export async function verifyTheftTransfer(selected: TheftTransfer, account: string, network: RecourseChainNetwork): Promise<VerifiedTheftTransfer> {
  if (selected.from !== account.toLowerCase() || !HASH.test(selected.transactionHash)) return fail('the selected transfer is not from this account');
  const deployment = await network.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const facts = await Promise.all(network.rpcs.map(async rpc => {
    const receipt = record(await rpc.request('eth_getTransactionReceipt', [selected.transactionHash]), 'no receipt');
    if (receipt.transactionHash !== selected.transactionHash || receipt.status !== '0x1'
      || typeof receipt.blockNumber !== 'string' || !QUANTITY.test(receipt.blockNumber)
      || typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs)) return fail('the receipt is not a successful transaction');
    const block = Number(BigInt(receipt.blockNumber));
    const finalized = record(await rpc.request('eth_getBlockByNumber', ['finalized', false]), 'no finalized block');
    if (typeof finalized.number !== 'string' || !QUANTITY.test(finalized.number)
      || !Number.isSafeInteger(block) || block < 1 || BigInt(block) > BigInt(finalized.number)) return fail('the transaction is not yet finalized');
    const canonical = record(await rpc.request('eth_getBlockByNumber', [receipt.blockNumber, false]), 'no block');
    if (canonical.hash !== receipt.blockHash || typeof canonical.timestamp !== 'string' || !QUANTITY.test(canonical.timestamp)) return fail('the block is not canonical');
    let amount = 0n;
    for (const raw of receipt.logs) {
      const log = record(raw, 'invalid log');
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== kernel || !Array.isArray(log.topics)
        || log.topics[0] !== TRANSFER_TOPIC) continue;
      if (log.removed === true || log.transactionHash !== selected.transactionHash || log.blockHash !== receipt.blockHash
        || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) return fail('invalid transfer log');
      const transfer = TOKEN.parseLog({ data: log.data, topics: log.topics as string[] });
      if (transfer?.args.from.toLowerCase() === account.toLowerCase() && transfer.args.to.toLowerCase() === selected.to) amount += BigInt(transfer.args.value);
    }
    if (amount <= 0n) return fail('no PVT left this account to that recipient in this transaction');
    const timestamp = Number(BigInt(canonical.timestamp)) * 1000;
    if (!Number.isSafeInteger(timestamp)) return fail('invalid block time');
    return { ...selected, block, blockHash: receipt.blockHash, timestamp, amount: formatUnits(amount, 18) };
  }));
  if (JSON.stringify(facts[0]) !== JSON.stringify(facts[1])) return fail('the two RPCs disagree on this transaction');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) return fail('the protocol deployment changed during the read; retry');
  return facts[0];
}

/** Choose a transfer by its transaction hash (and recipient, when it sent PVT to
 * several), then verify it on both RPCs. */
export async function resolveTheftTransfer(transactionHash: string, account: string, network: RecourseChainNetwork,
  recipient?: string): Promise<VerifiedTheftTransfer> {
  const hash = transactionHash.toLowerCase(), self = account.toLowerCase(), to = recipient?.toLowerCase();
  if (!HASH.test(hash)) throw Error('recourse_transfer_hash_invalid');
  if (to !== undefined && !ADDRESS.test(to)) throw Error('recourse_transfer_recipient_invalid');
  const deployment = await network.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const receipt = record(await network.rpcs[0].request('eth_getTransactionReceipt', [hash]), 'no receipt for that transaction');
  if (!Array.isArray(receipt.logs)) return fail('the receipt carries no logs');
  const recipients = new Set<string>();
  for (const raw of receipt.logs) {
    const log = record(raw, 'invalid log');
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== kernel || !Array.isArray(log.topics)
      || log.topics[0] !== TRANSFER_TOPIC || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) continue;
    const transfer = TOKEN.parseLog({ data: log.data, topics: log.topics as string[] });
    if (!transfer || String(transfer.args.from).toLowerCase() !== self) continue;
    const dest = String(transfer.args.to).toLowerCase();
    if (dest !== self && dest !== ZeroAddress && BigInt(transfer.args.value) > 0n) recipients.add(dest);
  }
  if (recipients.size === 0) throw Error('recourse_transfer_not_outgoing: that transaction moved no PVT from this account to another address');
  if (to !== undefined && !recipients.has(to)) throw Error('recourse_transfer_not_outgoing: that transaction sent no PVT from this account to that recipient');
  if (to === undefined && recipients.size > 1) {
    throw Error(`recourse_transfer_recipient_ambiguous: that transaction sent PVT to ${[...recipients].sort().join(', ')}; choose one recipient`);
  }
  const chosen = to ?? [...recipients][0];
  return verifyTheftTransfer({ transactionHash: hash, from: self, to: chosen, amount: '0', timestamp: 0 }, self, network);
}
