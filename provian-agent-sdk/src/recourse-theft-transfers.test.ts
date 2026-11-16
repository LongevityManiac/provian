import { describe, expect, it } from 'vitest';
import { Interface, parseUnits } from 'ethers';
import { PROTOCOL_COMPONENTS, type PointerRpc, type ProtocolDeployment } from './protocol-pointer';
import { listTheftTransfers, resolveTheftTransfer, theftTransferChoices, verifyTheftTransfer, type RecourseChainNetwork } from './recourse-theft-transfers';

const TOKEN = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const KERNEL = '0x2af3a065dc3c0c51b054cb8c6baee7df76189e0e';
const OTHER_TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ME = '0x1111111111111111111111111111111111111111';
const THIEF = '0x2222222222222222222222222222222222222222';
const FRIEND = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const blockHash = (block: number): string => h(0xb000000 + block);

const deployment = (): ProtocolDeployment => ({ pointer: '0x619eae740ce56c5a8edbb2b047e58369281ddad7', revision: 1n, manifestHash: h(77),
  blockHash: h(1), runtimeHashes: [], addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map(c => [c, c === 'kernel' ? KERNEL : ZERO])) as ProtocolDeployment['addresses'] });

interface Log { address: string; from: string; to: string; value: bigint; tx: number; block: number; index: number }
function wire(l: Log): Record<string, unknown> {
  const encoded = TOKEN.encodeEventLog('Transfer', [l.from, l.to, l.value]);
  return { address: l.address, topics: encoded.topics, data: encoded.data, transactionHash: h(l.tx), blockHash: blockHash(l.block),
    blockNumber: `0x${l.block.toString(16)}`, logIndex: `0x${l.index.toString(16)}`, removed: false };
}

/** A fake Base RPC that answers getLogs from a fixed log set, as a real node would filter it. */
function fakeRpc(logs: Log[], opts: { finalized?: number; refuseLogs?: boolean; calls?: unknown[][] } = {}): PointerRpc {
  return { async request(method, params) {
    opts.calls?.push([method, ...params]);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return { number: `0x${(opts.finalized ?? 100_000).toString(16)}` };
      const n = Number(BigInt(String(params[0])));
      return { hash: blockHash(n), number: params[0], timestamp: `0x${(1_790_000_000 + n).toString(16)}` };
    }
    if (method === 'eth_getLogs') {
      if (opts.refuseLogs) throw new Error('block range too large');
      const q = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] };
      const from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
      return logs.filter(l => l.address === q.address && l.block >= from && l.block <= to
        && `0x${'00'.repeat(12)}${l.from.slice(2)}` === q.topics[1]).map(wire);
    }
    if (method === 'eth_getTransactionReceipt') {
      const tx = String(params[0]), mine = logs.filter(l => h(l.tx) === tx);
      if (mine.length === 0) return null;
      return { transactionHash: tx, status: '0x1', blockNumber: `0x${mine[0].block.toString(16)}`, blockHash: blockHash(mine[0].block), logs: mine.map(wire) };
    }
    throw new Error(`unexpected ${method}`);
  } };
}
const network = (a: PointerRpc, b: PointerRpc): RecourseChainNetwork => ({ rpcs: [a, b], deployment: async () => deployment() });
const PVT = (n: string): bigint => parseUnits(n, 18);

const HISTORY: Log[] = [
  { address: KERNEL, from: ME, to: THIEF, value: PVT('40'), tx: 1, block: 99_000, index: 0 },
  { address: KERNEL, from: ME, to: THIEF, value: PVT('2.5'), tx: 1, block: 99_000, index: 1 }, // same tx, same recipient: summed
  { address: KERNEL, from: ME, to: ZERO, value: PVT('5'), tx: 2, block: 98_000, index: 0 },    // burn: never a theft choice
  { address: KERNEL, from: ME, to: ME, value: PVT('1'), tx: 3, block: 97_000, index: 0 },      // to yourself
  { address: KERNEL, from: ME, to: FRIEND, value: 0n, tx: 4, block: 96_000, index: 0 },        // zero value
  { address: OTHER_TOKEN, from: ME, to: THIEF, value: PVT('9'), tx: 5, block: 95_000, index: 0 }, // another token
  { address: KERNEL, from: THIEF, to: ME, value: PVT('3'), tx: 6, block: 94_000, index: 0 },   // incoming
  { address: KERNEL, from: ME, to: FRIEND, value: PVT('7'), tx: 7, block: 80_000, index: 0 },  // an older outgoing transfer
];

describe('listTheftTransfers', () => {
  it('lists only finalized outgoing PVT kernel transfers to another address, newest first, amounts summed per recipient', async () => {
    const page = await listTheftTransfers(ME, network(fakeRpc(HISTORY), fakeRpc(HISTORY)), { windowBlocks: 10_000, windows: 3 });
    console.log(`[recourse] picker evaluated ${HISTORY.length} logs -> ${page.transfers.length} choices`);
    expect(page.transfers.map(t => [t.transactionHash, t.to, t.amount, t.block])).toEqual([
      [h(1), THIEF, '42.5', 99_000],
      [h(7), FRIEND, '7.0', 80_000],
    ]);
    expect(page.transfers[0].timestamp).toBe((1_790_000_000 + 99_000) * 1000);
    expect(page.toBlock).toBe(100_000);
    expect(page.fromBlock).toBe(70_001);
    expect(page.nextBeforeBlock).toBe(70_001);
  });

  it('reads at or below the LOWER of the two finalized blocks and stops at the limit, giving a cursor for older transfers', async () => {
    const calls: unknown[][] = [];
    const page = await listTheftTransfers(ME, network(fakeRpc(HISTORY, { finalized: 99_500, calls }), fakeRpc(HISTORY, { finalized: 120_000 })),
      { windowBlocks: 1_000, windows: 50, limit: 1 });
    expect(page.toBlock).toBe(99_500);
    expect(page.transfers.map(t => t.transactionHash)).toEqual([h(1)]);
    expect(page.nextBeforeBlock).toBe(98_501);
    const older = await listTheftTransfers(ME, network(fakeRpc(HISTORY), fakeRpc(HISTORY)), { beforeBlock: page.nextBeforeBlock ?? 0, windowBlocks: 20_000, windows: 1 });
    expect(older.toBlock).toBe(98_500);
    expect(older.transfers.map(t => t.transactionHash)).toEqual([h(7)]);
  });

  it('RED: refuses when the two RPCs disagree (never picks one)', async () => {
    const tampered = HISTORY.map(l => (l.tx === 1 && l.index === 0 ? { ...l, to: FRIEND } : l));
    await expect(listTheftTransfers(ME, network(fakeRpc(HISTORY), fakeRpc(tampered)), { windowBlocks: 10_000, windows: 1 }))
      .rejects.toThrow(/recourse_transfer_history_disagreement/);
  });

  it('RED: an RPC that refuses the range is an error, never an empty list', async () => {
    await expect(listTheftTransfers(ME, network(fakeRpc(HISTORY), fakeRpc(HISTORY, { refuseLogs: true })), { windows: 1 }))
      .rejects.toThrow(/recourse_transfer_history_unavailable: RPC 2 refused the log range .* smaller window/);
  });

  it('RED: a log outside the requested filter (another sender) is refused', async () => {
    const leaky: PointerRpc = { async request(method, params) {
      if (method === 'eth_getLogs') return [wire({ address: KERNEL, from: THIEF, to: FRIEND, value: 1n, tx: 9, block: 99_999, index: 0 })];
      return fakeRpc(HISTORY).request(method, params);
    } };
    await expect(listTheftTransfers(ME, network(leaky, leaky), { windows: 1 })).rejects.toThrow(/outside the requested filter/);
  });

  it('refuses invalid scan bounds', async () => {
    await expect(listTheftTransfers(ME, network(fakeRpc([]), fakeRpc([])), { windowBlocks: 0 })).rejects.toThrow(/recourse_transfer_scan_invalid/);
    await expect(listTheftTransfers('not-an-address', network(fakeRpc([]), fakeRpc([])))).rejects.toThrow(/recourse_transfer_account_invalid/);
  });
});

describe('theftTransferChoices (ported from the app picker)', () => {
  const row = { chain: 'Base', status: 'confirmed', hash: h(1), from: ME, to: THIEF, amount: '1.0', timestamp: 1, contractAddress: KERNEL };
  it('keeps an outgoing confirmed kernel transfer', () => {
    expect(theftTransferChoices([row], ME, KERNEL)).toHaveLength(1);
  });
  it('RED: burn, incoming, pending, other-token and zero rows are each excluded', () => {
    const rejected = [{ ...row, to: ZERO }, { ...row, from: THIEF, to: ME }, { ...row, status: 'pending' },
      { ...row, contractAddress: OTHER_TOKEN }, { ...row, amount: '0.0' }, { ...row, isRetiredPvt: true }];
    expect(rejected.map(r => theftTransferChoices([r], ME, KERNEL).length)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('resolveTheftTransfer / verifyTheftTransfer', () => {
  it('resolves the block and summed amount from both RPCs', async () => {
    const t = await resolveTheftTransfer(h(1).toUpperCase().replace('0X', '0x'), ME, network(fakeRpc(HISTORY), fakeRpc(HISTORY)));
    expect(t).toMatchObject({ transactionHash: h(1), to: THIEF, amount: '42.5', block: 99_000, blockHash: blockHash(99_000) });
  });
  it('asks for a recipient when one transaction sent PVT to several', async () => {
    const split: Log[] = [{ address: KERNEL, from: ME, to: THIEF, value: 5n, tx: 8, block: 90_000, index: 0 },
      { address: KERNEL, from: ME, to: FRIEND, value: 6n, tx: 8, block: 90_000, index: 1 }];
    const net = network(fakeRpc(split), fakeRpc(split));
    await expect(resolveTheftTransfer(h(8), ME, net)).rejects.toThrow(/recourse_transfer_recipient_ambiguous/);
    expect((await resolveTheftTransfer(h(8), ME, net, FRIEND)).to).toBe(FRIEND);
  });
  it('RED: a burn or an incoming transfer cannot be reported', async () => {
    const net = network(fakeRpc(HISTORY), fakeRpc(HISTORY));
    await expect(resolveTheftTransfer(h(2), ME, net)).rejects.toThrow(/recourse_transfer_not_outgoing/);
    await expect(resolveTheftTransfer(h(6), ME, net)).rejects.toThrow(/recourse_transfer_not_outgoing/);
  });
  it('RED: verification refuses an unfinalized transaction and an RPC disagreement', async () => {
    const selected = { transactionHash: h(1), from: ME, to: THIEF, amount: '0', timestamp: 0 };
    await expect(verifyTheftTransfer(selected, ME, network(fakeRpc(HISTORY, { finalized: 98_000 }), fakeRpc(HISTORY))))
      .rejects.toThrow(/not yet finalized/);
    const tampered = HISTORY.map(l => (l.tx === 1 && l.index === 1 ? { ...l, value: PVT('3') } : l));
    await expect(verifyTheftTransfer(selected, ME, network(fakeRpc(HISTORY), fakeRpc(tampered)))).rejects.toThrow(/disagree/);
  });
});
