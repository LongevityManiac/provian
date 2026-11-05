import { readCompactDiscoveryWindow, readAdaptiveDiscoveryWindow, readAdaptivePrimaryDiscoveryWindow, probeTraceFilterUnion, selectDiscoveryRpcLegs, cheaperDiscoveryMode, estimateDiscoveryCu, estimatePrimaryDiscoveryCu } from './compact-discovery';
import type { EconomicStateRpcLeg } from './economic-state';
const hex = (n: number) => `0x${n.toString(16)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
function fixture(count = 8, blocks = 20, options: { omit?: boolean; altered?: boolean; repeated?: boolean; page?: number; maxRange?: number } = {}) {
  const watched = new Set(Array.from({ length: count }, (_, n) => address(n + 100)));
  const transactions = Array.from({ length: blocks }, () => [] as Record<string, unknown>[]);
  const primaryTransactions = Array.from({ length: blocks }, () => [] as Record<string, unknown>[]);
  const traces = Array.from({ length: blocks }, () => [] as Record<string, unknown>[]);
  for (let i = 0; i < count; i++) {
    const height = Math.floor(i * blocks / count) + 1;
    const create = i % 13 === 0;
    const tx = { hash: hash(i + 1), from: address(i + 100), to: create ? null : address(1), value: '0x0', input: i % 7 === 0 ? '0x' : '0x1234' };
    transactions[height - 1].push(options.altered && i === 1 ? { ...tx, value: '0x1' } : tx);
    if (options.omit && i === 1) continue;
    primaryTransactions[height - 1].push(tx);
    traces[height - 1].push({ type: create ? 'create' : 'call', subtraces: 0, traceAddress: [], blockNumber: hex(height),
      blockHash: hash(height + 1_000_000), transactionHash: tx.hash,
      ...(i % 19 === 0 ? { error: 'Reverted' } : {}), action: { from: tx.from, to: tx.to, callType: 'call',
        value: tx.value, ...(create ? { init: tx.input } : { input: tx.input }) } });
  }
  // Both self-destruct spellings belong to a real outer transaction/tree.
  const parentBlock = Math.floor(2 * blocks / count) + 1;
  const parent = traces[parentBlock - 1].find(trace => trace.transactionHash === hash(3))!;
  parent.subtraces = 2;
  for (const [index, type] of ['suicide', 'selfdestruct'].entries()) {
    traces[parentBlock - 1].push({ type, subtraces: 0, traceAddress: [index], blockNumber: hex(parentBlock),
      blockHash: hash(parentBlock + 1_000_000), transactionHash: hash(3),
      action: { address: address(2), refundAddress: address(100), balance: '0x1' } });
  }
  const calls: { operator: string; method: string; params: readonly unknown[] }[] = [];
  const primary: EconomicStateRpcLeg = { operatorId: 'primary', send: async (method, params) => {
    calls.push({ operator: 'primary', method, params });
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') {
      const height = Number(params[0]);
      return { number: hex(height), hash: hash(height + 1_000_000), parentHash: hash(height + 999_999), transactions: primaryTransactions[height - 1] };
    }
    if (method === 'trace_block') return traces[Number(params[0]) - 1];
    if (method !== 'trace_filter') throw new Error(`unexpected ${method}`);
    const filter = params[0] as { fromBlock: string; toBlock: string; after: number; count: number };
    const from = Number(filter.fromBlock), through = Number(filter.toBlock);
    if (options.maxRange && through - from + 1 > options.maxRange) throw new Error('block range limit exceeded');
    const filterAddresses = params[0] as { toAddress?: string[]; fromAddress?: string[]; mode?: string };
    const frames = traces.slice(from - 1, through).flat().filter(t => {
      const action = t.action as Record<string, unknown>;
      const from = filterAddresses.fromAddress?.includes(String(action.from ?? action.address));
      const to = filterAddresses.toAddress?.includes(String(action.to ?? action.refundAddress));
      return !filterAddresses.fromAddress && !filterAddresses.toAddress || (filterAddresses.mode === 'union' ? from || to
        : (from ?? true) && (to ?? true));
    });
    const after = options.repeated ? 0 : filter.after;
    return frames.slice(after, after + (options.page ?? filter.count));
  } };
  const secondary: EconomicStateRpcLeg = { operatorId: 'independent', send: async (method, params) => {
    calls.push({ operator: 'secondary', method, params });
    if (method === 'eth_chainId') return '0x2105';
    if (method !== 'eth_getBlockByNumber' || params[1] !== true) throw new Error(`unexpected ${method}`);
    const height = Number(params[0]);
    return { number: hex(height), hash: hash(height + 1_000_000), parentHash: hash(height + 999_999), transactions: transactions[height - 1] };
  } };
  const read = (mode: 'global-traces' | 'paired-blocks' | 'block-traces' | 'auto' = 'global-traces', pairedTraceRangeBlocks = 100) => (mode === 'auto' ? readAdaptiveDiscoveryWindow : readCompactDiscoveryWindow)({ fromBlock: 1, toBlock: blocks, watched, assets: [] }, {
    pairedTraceRangeBlocks, rootMode: mode === 'auto' ? undefined : mode, legs: [primary, secondary], readLogs: async () => [], readBlockHash: async height => hash(height + 1_000_000),
  });
  const readPrimary = (rootMode?: 'global-traces' | 'block-traces' | 'filtered-traces', extra: Partial<Parameters<typeof readCompactDiscoveryWindow>[1]> = {}) =>
    (rootMode ? readCompactDiscoveryWindow : readAdaptivePrimaryDiscoveryWindow)({ fromBlock: 1, toBlock: blocks, watched, assets: [] }, {
      primaryDiscoveryOnly: true, rootMode, legs: [primary, secondary], readLogs: async () => [],
      readBlockHash: async height => hash(height + 1_000_000), ...extra,
    });
  return { read, readPrimary, calls, watched, traces, transactions, primaryTransactions, primary, secondary };
}

describe('primary discovery queues pointers for independent financial verification', () => {
  it('selects discovery independently without dropping or replacing either verifier', () => {
    const f = fixture();
    expect(selectDiscoveryRpcLegs([f.primary, f.secondary], 'independent')).toEqual([f.secondary, f.primary]);
    expect(() => selectDiscoveryRpcLegs([f.primary, f.secondary], 'missing')).toThrow('preferred_operator_unavailable');
    expect(() => selectDiscoveryRpcLegs([f.primary, f.primary], 'primary')).toThrow('operators_not_independent');
    expect(f.calls).toHaveLength(0);
  });
  it.each([150, 1500])('covers a full 100,000-agent burst across %i blocks without secondary full blocks', async blocks => {
    const f = fixture(100_000, blocks);
    const out = await f.readPrimary();
    expect(new Set(out.transfers.signed.map(tx => tx.fromAddress))).toEqual(f.watched);
    expect(out.transfers.signed).toHaveLength(100_000);
    expect(out.internals).toHaveLength(1); // duplicate pointer routes coalesce by transaction and recipient
    expect(f.calls.filter(call => call.operator === 'secondary').map(call => call.method)).toEqual(['eth_chainId']);
    expect(f.calls.filter(call => call.method === 'eth_getBlockByNumber')).toHaveLength(0);
  }, 30_000);
  it('separate and positively probed union filters preserve roots, creates, failures, and refunds', async () => {
    const f = fixture();
    const separate = await f.readPrimary('filtered-traces');
    const union = await f.readPrimary('filtered-traces', { filteredTraceMode: 'union' });
    expect(new Set(separate.transfers.signed.map(tx => tx.fromAddress))).toEqual(f.watched);
    expect(union).toEqual(separate);
    expect(union.internals).toHaveLength(1);
    expect(f.calls.filter(call => call.operator === 'secondary').every(call => call.method === 'eth_chainId')).toBe(true);
  });
  it('rejects a stale boundary, unavailable boundary, and contradictory primary trace hashes', async () => {
    const f = fixture();
    await expect(f.readPrimary('filtered-traces', { readBlockHash: async () => null })).rejects.toThrow('boundary_unavailable');
    // Put a watched root at the paired boundary height.
    const last = f.traces.flat().find(trace => (trace.traceAddress as number[]).length === 0)!;
    const moved = { ...last, transactionHash: hash(998), blockNumber: hex(20), blockHash: hash(1_000_020) };
    f.traces[19].push(moved);
    await expect(f.readPrimary('filtered-traces', { readBlockHash: async () => hash(999) })).rejects.toThrow('primary_inconsistent');
    f.traces[19].push({ ...moved, transactionHash: hash(999), blockHash: hash(999) });
    await expect(f.readPrimary('filtered-traces')).rejects.toThrow('primary_inconsistent');
  });
  it('union capability requires exact positive results exclusive to both directions', async () => {
    const f = fixture();
    const raw = f.traces.flat();
    // Probe a single block containing distinct FROM-only and TO-only frames.
    const block = 6;
    const sample: Record<string, unknown>[] = raw.map(trace => ({ ...trace, blockNumber: hex(block), blockHash: hash(1_000_006) }));
    const unionLeg: EconomicStateRpcLeg = { operatorId: 'primary', send: async (_method, params) => {
      const filter = params[0] as { fromAddress: string[]; toAddress: string[] };
      return sample.filter(trace => { const action = trace.action as Record<string, unknown>;
        return filter.fromAddress.includes(String(action.from ?? action.address)) || filter.toAddress.includes(String(action.to ?? action.refundAddress)); });
    } };
    expect(await probeTraceFilterUnion(unionLeg, block, sample)).toBe(true);
    expect(await probeTraceFilterUnion({ ...unionLeg, send: async () => [] }, block, sample)).toBe(false);
    expect(await probeTraceFilterUnion({ ...unionLeg, send: async () => { throw new Error('invalid params: mode'); } }, block, sample)).toBe(false);
    await expect(probeTraceFilterUnion({ ...unionLeg, send: async () => { throw new Error('connection timed out'); } }, block, sample)).rejects.toThrow('timed out');
    expect(await probeTraceFilterUnion(unionLeg, block, sample.slice(0, 1))).toBe(false);
    const sameTarget: Record<string, unknown>[] = [
      { type: 'call', transactionHash: hash(1001), traceAddress: [], blockHash: hash(block), action: { from: address(1), to: address(9) } },
      { type: 'create', transactionHash: hash(1002), traceAddress: [], blockHash: hash(block), action: { from: address(2), init: '0x' }, result: { address: address(9) } },
    ];
    // A TO-only backend returns both entries. Neither is FROM-only, so this
    // cannot prove union semantics, even though CREATE puts its target in result.
    expect(await probeTraceFilterUnion({ ...unionLeg, send: async () => sameTarget }, block, sameTarget)).toBe(false);
  });
  it('prices terminating pages for both filters and the union without assuming block seconds', () => {
    const separate = estimatePrimaryDiscoveryCu(1500, 5000, 2000, [1], [1]);
    const union = estimatePrimaryDiscoveryCu(1500, 5000, 2000, [1], [1], [1]);
    expect(union.filteredTraceCu).toBeLessThan(separate.filteredTraceCu);
    const flat = estimatePrimaryDiscoveryCu(1500, 5000, 2000, [1], [1], [1], 20);
    expect(flat.filteredTraceCu - 20).toBe((union.filteredTraceCu - 20) / 2);
    expect(() => estimatePrimaryDiscoveryCu(1500, 5000, 2000, [1], [1], [0])).toThrow('cost_sample_invalid');
  });
  it('splits primary log ranges at a lower provider limit and covers every requested height', async () => {
    const covered: number[] = [];
    const primary: EconomicStateRpcLeg = { operatorId: 'primary', send: async (method, params) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'trace_filter') return [];
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = Number(filter.fromBlock), to = Number(filter.toBlock);
      if (to - from + 1 > 200) throw new Error('eth_getLogs is limited to a 200 range');
      for (let height = from; height <= to; height++) covered.push(height);
      return [];
    } };
    const secondary: EconomicStateRpcLeg = { operatorId: 'independent', send: async method => {
      if (method !== 'eth_chainId') throw new Error('secondary must not download discovery logs or full blocks');
      return '0x2105';
    } };
    await readCompactDiscoveryWindow({ fromBlock: 1, toBlock: 500, watched: new Set([address(100)]), assets: [address(1)] }, {
      primaryDiscoveryOnly: true, rootMode: 'filtered-traces', legs: [primary, secondary], readBlockHash: async () => hash(500),
    });
    expect(covered).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  });
});
describe('global discovery with independent canonical transaction coverage', () => {
  it('covers 100,000 watched agents all transacting across 1,500 canonical 200ms blocks', async () => {
    const f = fixture(100_000, 1500);
    const result = await f.read('auto');
    expect(result.transfers.signed).toHaveLength(100_000);
    expect(new Set(result.transfers.signed.map(t => t.fromAddress))).toEqual(f.watched);
    expect(result.internals).toHaveLength(2);
    const primary = f.calls.filter(c => c.operator === 'primary' && c.method === 'trace_filter');
    const secondary = f.calls.filter(c => c.operator === 'secondary' && c.method === 'eth_getBlockByNumber');
    expect(secondary).toHaveLength(1500);
    expect(primary.length).toBeLessThan(150);
    expect(primary.every(c => !('fromAddress' in (c.params[0] as object)) && !('toAddress' in (c.params[0] as object)))).toBe(true);
    console.log(JSON.stringify({ evaluated_agents: f.watched.size, signed_transactions: result.transfers.signed.length,
      canonical_blocks: secondary.length, primary_trace_calls: primary.length, primary_trace_cu: primary.length * 40 }));
  }, 30_000);
  it.each([{ omit: true }, { altered: true }])('rejects omitted or changed watched chain facts: %j', async options => {
    await expect(fixture(8, 20, options).read()).rejects.toThrow('rpc_disagreement:roots');
  });
  it('a short page is not completion; reads to an empty page', async () => {
    const f = fixture(8, 20, { page: 2 });
    expect((await f.read()).transfers.signed).toHaveLength(8);
    expect(f.calls.filter(c => c.method === 'trace_filter')).toHaveLength(6);
  });
  it('a provider ignoring pagination cannot advance coverage', async () => {
    await expect(fixture(8, 20, { repeated: true, page: 2 }).read()).rejects.toThrow('pagination_stalled');
  });
  it('splits explicit provider range failures without retaining partial duplicate pages', async () => {
    expect((await fixture(8, 20, { maxRange: 5 }).read()).transfers.signed).toHaveLength(8);
  });
});


describe('cost selection preserves coverage on both sides of the cadence switch', () => {
  it('uses sampled frame density and watched-address fanout instead of assuming block seconds', () => {
    expect(cheaperDiscoveryMode(150, 100_000, 2230, Array(20).fill(0))).toBe('block-traces');
    expect(cheaperDiscoveryMode(1500, 100_000, 223, Array(20).fill(0))).toBe('global-traces');
    expect(cheaperDiscoveryMode(1500, 100_000, 10_000, Array(20).fill(0))).toBe('block-traces');
    expect(cheaperDiscoveryMode(1500, 100_000, 0, Array(20).fill(0))).toBe('global-traces');
  });
  it('dense watched traces include every page and can reverse the empty-page cost choice', () => {
    const matched = [10_000, ...Array(19).fill(0)];
    const cost = estimateDiscoveryCu(1500, 100_000, 10_000, matched);
    expect(cost.pairedBlockCu).toBeGreaterThan(cost.globalTraceCu);
    expect(cheaperDiscoveryMode(1500, 100_000, 10_000, matched)).toBe('block-traces');
    expect(() => estimateDiscoveryCu(10, 1, 1, [2])).toThrow('cost_sample_invalid');
  });
  it('paired blocks and global traces cover the same nonempty watched roots and internal movements', async () => {
    const f = fixture();
    const global = await f.read('global-traces'), paired = await f.read('paired-blocks');
    expect(global.transfers.signed.length).toBe(8);
    expect(paired.transfers).toEqual(global.transfers);
    expect(paired.internals).toEqual(global.internals);
    expect(paired.mode).toBe('paired-blocks');
  });
  it('paired mode retains independent refusal when one provider omits or changes a transaction', async () => {
    await expect(fixture(8, 20, { omit: true }).read('paired-blocks')).rejects.toThrow('rpc_disagreement:roots');
    await expect(fixture(8, 20, { altered: true }).read('paired-blocks')).rejects.toThrow('rpc_disagreement:roots');
  });
  it('per-block traces preserve every candidate and reuse the complete sampled block', async () => {
    const f = fixture(10_000, 20);
    const global = await f.read('global-traces'); f.calls.length = 0;
    const traced = await f.read('auto');
    expect(traced.mode).toBe('block-traces');
    // Parallel reads can finish in different orders; compare every complete fact.
    expect(new Map(traced.transfers.signed.map(t => [t.transactionHash, t])))
      .toEqual(new Map(global.transfers.signed.map(t => [t.transactionHash, t])));
    expect(traced.transfers.natives).toEqual(global.transfers.natives); expect(traced.internals).toEqual(global.internals);
    expect(traced.transfers.signed).toHaveLength(10_000);
    expect(f.calls.filter(c => c.operator === 'primary' && c.method === 'trace_block')).toHaveLength(20);
    expect(f.calls.filter(c => c.operator === 'primary' && ['trace_filter', 'eth_getBlockByNumber'].includes(c.method))).toHaveLength(0);
    expect(f.calls.filter(c => c.operator === 'secondary' && c.method === 'eth_getBlockByNumber')).toHaveLength(20);
  });
  it.each([{ omit: true }, { altered: true }])('block traces refuse independent changed or missing chain facts: %j', async options => {
    await expect(fixture(8, 20, options).read('block-traces')).rejects.toThrow('rpc_disagreement:roots');
  });
  it.each(['global-traces', 'block-traces'] as const)('all-root agreement protects an internal receive from an unwatched transaction in %s', async mode => {
    const f = fixture(), txHash = hash(999);
    const outer = { hash: txHash, from: address(2), to: address(3), value: '0x0', input: '0x1234' };
    f.transactions[0].push(outer); f.primaryTransactions[0].push(outer);
    const root = { type: 'call', subtraces: 1, traceAddress: [], blockNumber: '0x1', blockHash: hash(1_000_001), transactionHash: txHash,
      action: { from: outer.from, to: outer.to, value: '0x0', input: outer.input, callType: 'call' } };
    const payment = { type: 'call', subtraces: 0, traceAddress: [0], blockNumber: '0x1', blockHash: hash(1_000_001), transactionHash: txHash,
      action: { from: outer.to, to: address(100), value: '0x1', input: '0x', callType: 'call' } };
    f.traces[0].push(root, payment);
    expect((await f.read(mode)).internals).toHaveLength(3);
    // Both watched-root projections still contain the exact same eight roots.
    // Losing the unrelated outer transaction would silently lose its internal receive.
    f.traces[0] = f.traces[0].filter(trace => trace.transactionHash !== txHash);
    await expect(f.read(mode)).rejects.toThrow('rpc_disagreement:all_roots');
    f.traces[0].push(root);
    await expect(f.read(mode)).rejects.toThrow('trace_tree_incomplete');
    f.traces[0].push(payment);
    root.blockHash = hash(777); payment.blockHash = hash(777);
    await expect(f.read(mode)).rejects.toThrow('rpc_disagreement:all_roots');
  });
  it('accepts exact RPC integer encodings and refuses malformed or duplicated tree metadata', async () => {
    const f = fixture();
    for (const traces of f.traces) for (const trace of traces) trace.subtraces = String(trace.subtraces);
    expect((await f.read('block-traces')).transfers.signed).toHaveLength(8);
    const root = f.traces[0][0]; root.subtraces = 'not-a-count';
    await expect(f.read('block-traces')).rejects.toThrow('number_invalid');
    root.subtraces = '0'; f.traces[0].push(root);
    await expect(f.read('block-traces')).rejects.toThrow('trace_tree_duplicate');
  });
  it.each(['global-traces', 'paired-blocks', 'block-traces'] as const)('rejects a same-length calldata change in %s', async mode => {
    const f = fixture();
    const height = Math.floor(3 * 20 / 8) + 1;
    const index = f.transactions[height - 1].findIndex(tx => tx.hash === hash(4));
    expect(index).toBeGreaterThanOrEqual(0);
    // Replace only the independent provider's body; retain its transaction hash.
    f.transactions[height - 1][index] = { ...f.transactions[height - 1][index], input: '0xabcd' };
    await expect(f.read(mode)).rejects.toThrow('rpc_disagreement:roots');
  });
  it('derives native-transfer classification from validated empty input while normalizing hex casing', async () => {
    const f = fixture(), height = Math.floor(3 * 20 / 8) + 1;
    const body = f.transactions[height - 1].find(tx => tx.hash === hash(4))!;
    const trace = f.traces[height - 1].find(tx => tx.transactionHash === hash(4))!;
    const action = trace.action as Record<string, unknown>;
    Object.assign(body, { to: address(100), value: '0x1', input: '0X' });
    Object.assign(action, { to: address(100), value: '0x1', input: '0x' });
    expect((await f.read('block-traces')).transfers.natives).toContainEqual({ transactionHash: hash(4),
      blockNumber: height, fromAddress: address(103), toAddress: address(100), valueWei: '1' });
    body.input = '0x00'; action.input = '0X00';
    expect((await f.read('block-traces')).transfers.natives).toHaveLength(0);
  });
  it('the lowest-cost tested 100-block trace pieces retain the same coverage as 20-block pieces', async () => {
    const f = fixture(100, 150);
    const narrow = await f.read('paired-blocks', 20);
    const narrowCalls = f.calls.filter(c => c.operator === 'primary' && c.method === 'trace_filter').length;
    f.calls.length = 0;
    const wide = await f.read('paired-blocks', 100);
    const wideCalls = f.calls.filter(c => c.operator === 'primary' && c.method === 'trace_filter').length;
    expect(wide.transfers).toEqual(narrow.transfers);
    expect(wide.internals).toEqual(narrow.internals);
    expect(wide.transfers.signed).toHaveLength(100);
    expect(wideCalls).toBeLessThan(narrowCalls);
  });

});
