/**
 * 2026-10-01 — ETH that arrives inside a transaction (the operator: an internal transfer
 * mints on the same terms as a plain ETH receive).
 *
 * * `readAgreedBaseInternalEth` the effective ETH movements of one transaction,
 * agreed by BOTH independently operated trace legs. Nothing mints from one
 * operator's trace.
 * * `readBaseInternalEthPointers` discovery pointers from `trace_filter` on the
 * primary trace leg.
 *
 * Each RED case differs from its GREEN twin in the one field the reader reads.
 */
import { describe, it, expect } from '@jest/globals';
import { readAgreedBaseInternalEth, readBaseInternalEthPointers } from './economic-discovery';
import type { EconomicStateRpcLeg } from './economic-state';

const WALLET = '0xa11ce00000000000000000000000000000000001';
const SMART_WALLET = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const BUNDLER = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const OTHER = '0x7000000000000000000000000000000000000007';
const IMPL = '0x1111111111111111111111111111111111111111';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number | bigint) => `0x${n.toString(16)}`;
const TX = h(1);
const BLOCK_HASH = h(9001);

type Entry = Record<string, unknown>;
const call = (traceAddress: number[], from: string, to: string, value: bigint, over: Partial<Entry> = {}, callType = 'call'): Entry => ({
  type: 'call',
  action: { from, to, value: q(value), callType, gas: '0x1', input: '0x' },
  traceAddress,
  subtraces: 0,
  transactionHash: TX,
  blockHash: BLOCK_HASH,
  blockNumber: 500,
  result: { gasUsed: '0x1', output: '0x' },
  ...over,
});

/** A Coinbase-style smart wallet sending its owner's ETH to WALLET inside a bundler's transaction. */
const smartWalletSend = (): Entry[] => [
  call([], BUNDLER, ENTRY_POINT, 0n, { subtraces: 1 }),
  call([0], ENTRY_POINT, SMART_WALLET, 0n, { subtraces: 1 }),
  call([0, 0], SMART_WALLET, IMPL, 0n, { subtraces: 1 }, 'delegatecall'),
  call([0, 0, 0], SMART_WALLET, WALLET, 7n * 10n ** 15n),
];

function legsFor(traces: (side: 'a' | 'b', attempt: number) => unknown): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const attempts = { a: 0, b: 0 };
  const leg = (side: 'a' | 'b'): EconomicStateRpcLeg => ({
    operatorId: `operator-${side}`,
    send: async (method, params) => {
      if (method === 'trace_transaction') {
        expect(params[0]).toBe(TX);
        attempts[side] += 1;
        return structuredClone(traces(side, attempts[side]));
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return [leg('a'), leg('b')];
}
const opts = (legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]) => ({ traceLegs: legs, disagreementRetry: { attempts: 2, delayMs: 0 } });

describe('readAgreedBaseInternalEth', () => {
  it('returns the smart wallet\'s ETH movement into the wallet, agreed on both trace legs', async () => {
    const out = await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => smartWalletSend())));
    expect(out).toMatchObject({
      schemaVersion: 'base-internal-eth-evidence/v1',
      transactionHash: TX,
      blockNumber: 500,
      blockHash: BLOCK_HASH,
      providerOperatorIds: ['operator-a', 'operator-b'],
      frames: [{ traceAddress: [0, 0, 0], kind: 'call', fromAddress: SMART_WALLET, toAddress: WALLET, valueWei: (7n * 10n ** 15n).toString() }],
    });
    expect(out.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('RED: a movement under a reverted frame never happened, and is not returned', async () => {
    const reverted = smartWalletSend().map((e) => (JSON.stringify(e.traceAddress) === '[0]' ? { ...e, error: 'Reverted' } : e));
    const out = await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => reverted)));
    expect(out.frames).toEqual([]);
    // A reverted SIBLING does not touch it (GREEN twin).
    const sibling = [...smartWalletSend(), call([1], ENTRY_POINT, OTHER, 0n, { error: 'Reverted' })];
    sibling[0] = { ...sibling[0], subtraces: 2 };
    expect((await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => sibling)))).frames).toHaveLength(1);
  });

  it('RED: a delegatecall, staticcall or callcode carrying a value, a zero value and a self-call move no ETH', async () => {
    const entries = [
      call([], BUNDLER, ENTRY_POINT, 0n, { subtraces: 5 }),
      call([0], SMART_WALLET, WALLET, 5n, {}, 'delegatecall'),
      call([1], SMART_WALLET, WALLET, 5n, {}, 'staticcall'),
      call([2], SMART_WALLET, WALLET, 5n, {}, 'callcode'),
      call([3], SMART_WALLET, WALLET, 0n),
      call([4], WALLET, WALLET, 5n),
    ];
    expect((await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => entries)))).frames).toEqual([]);
    // GREEN twin: a plain call with the same value does.
    const green = [call([], BUNDLER, ENTRY_POINT, 0n, { subtraces: 1 }), call([0], SMART_WALLET, WALLET, 5n)];
    expect((await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => green)))).frames).toHaveLength(1);
  });

  it('a selfdestruct refund into the wallet is ETH arriving, from the destroyed contract', async () => {
    const entries: Entry[] = [
      call([], BUNDLER, OTHER, 0n, { subtraces: 1 }),
      { type: 'suicide', action: { address: OTHER, refundAddress: WALLET, balance: q(9n) }, traceAddress: [0], subtraces: 0, transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: 500, result: null },
    ];
    const out = await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => entries)));
    expect(out.frames).toEqual([{ traceAddress: [0], kind: 'selfdestruct', fromAddress: OTHER, toAddress: WALLET, valueWei: '9' }]);
  });

  it('a top-level call with calldata into the wallet is a movement too (traceAddress [])', async () => {
    const entries = [call([], OTHER, WALLET, 3n, { action: { from: OTHER, to: WALLET, value: q(3n), callType: 'call', gas: '0x1', input: '0xdeadbeef' } })];
    expect((await readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => entries)))).frames)
      .toEqual([{ traceAddress: [], kind: 'call', fromAddress: OTHER, toAddress: WALLET, valueWei: '3' }]);
  });

  it('RED: the legs disagree on the amount — never accepted; a transient split that agrees on re-poll is', async () => {
    const forged = (side: 'a' | 'b') => smartWalletSend().map((e) => (side === 'b' && JSON.stringify(e.traceAddress) === '[0,0,0]'
      ? { ...e, action: { ...(e.action as object), value: q(8n * 10n ** 15n) } }
      : e));
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor((side) => forged(side)))))
      .rejects.toThrow('economic_discovery_rpc_disagreement:internal_eth');
    const transient = legsFor((side, attempt) => (attempt === 1 ? forged(side) : smartWalletSend()));
    expect((await readAgreedBaseInternalEth({ transactionHash: TX }, opts(transient))).frames).toHaveLength(1);
  });

  it('RED: one leg cannot trace the transaction (empty or null) — unavailable, never one leg\'s word', async () => {
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor((side) => (side === 'b' ? [] : smartWalletSend())))))
      .rejects.toThrow('economic_discovery_trace_unavailable');
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor((side) => (side === 'a' ? null : smartWalletSend())))))
      .rejects.toThrow('economic_discovery_trace_unavailable');
  });

  it('RED: an entry of another transaction, or entries naming two blocks, are integrity faults', async () => {
    const foreign = [...smartWalletSend(), call([1], ENTRY_POINT, WALLET, 1n, { transactionHash: h(2) })];
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => foreign))))
      .rejects.toThrow('economic_discovery_trace_invalid:foreign_entry');
    const mixed = [...smartWalletSend(), call([1], ENTRY_POINT, WALLET, 1n, { blockHash: h(9002) })];
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => mixed))))
      .rejects.toThrow('economic_discovery_trace_invalid:mixed_blocks');
  });

  it('RED: two legs run by the same operator are refused before any read', async () => {
    const [a] = legsFor(() => smartWalletSend());
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, { traceLegs: [a, a] }))
      .rejects.toThrow('economic_discovery_trace_operators_not_independent');
  });

  it.each([
    ['missing root', () => smartWalletSend().slice(1)],
    ['omitted reverted parent', () => smartWalletSend().filter((entry) => JSON.stringify(entry.traceAddress) !== '[0]')],
    ['duplicate path', () => [...smartWalletSend(), smartWalletSend()[3]]],
    ['missing last child', () => smartWalletSend().slice(0, -1)],
    ['incorrect child count', () => smartWalletSend().map((entry, index) => index === 0 ? { ...entry, subtraces: 2 } : entry)],
    ['out-of-range child index', () => [call([], OTHER, WALLET, 0n, { subtraces: 1 }), call([1], OTHER, WALLET, 1n)]],
    ['malformed child count', () => smartWalletSend().map((entry, index) => index === 0 ? { ...entry, subtraces: '1.5' } : entry)],
    ['malformed path', () => smartWalletSend().map((entry, index) => index === 3 ? { ...entry, traceAddress: [0, 0, -1] } : entry)],
    ['execution without call/create root', () => [{ type: 'suicide', action: { address: OTHER, refundAddress: WALLET, balance: q(9n) }, traceAddress: [], subtraces: 0, transactionHash: TX, blockHash: BLOCK_HASH, blockNumber: 500 }]],
  ] satisfies Array<[string, () => Entry[]]>)('refuses matching incomplete or malformed traces on both providers: %s', async (_name, traces) => {
    await expect(readAgreedBaseInternalEth({ transactionHash: TX }, opts(legsFor(() => traces())))).rejects.toThrow();
  });
});

describe('readBaseInternalEthPointers', () => {
  const filterLegs = (result: (args: Record<string, unknown>) => unknown, calls: Array<Record<string, unknown>> = []) => {
    const leg = (side: 'a' | 'b'): EconomicStateRpcLeg => ({
      operatorId: `operator-${side}`,
      send: async (method, params) => {
        if (side === 'b') throw new Error('the secondary trace leg is not used for discovery');
        expect(method).toBe('trace_filter');
        const args = params[0] as Record<string, unknown>;
        calls.push(args);
        return structuredClone(Number(args.after)>0?[]:result(args));
      },
    });
    return [leg('a'), leg('b')] as const;
  };
  const at = (block: number, e: Entry): Entry => ({ ...e, blockNumber: block, transactionHash: h(block) });

  it('returns each ETH movement into a watched address in the range, filtered by recipient on the primary leg', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const legs = filterLegs(() => [
      at(101, call([0, 0, 0], SMART_WALLET, WALLET, 7n)),
      at(102, call([0], OTHER, SMART_WALLET, 7n)), // to an unwatched address
    ], calls);
    const out = await readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: [WALLET] }, { traceLegs: legs });
    expect(out).toEqual([{ transactionHash: h(101), blockNumber: 101, fromAddress: SMART_WALLET, toAddress: WALLET, valueWei: '7' }]);
    expect(calls).toEqual([{ fromBlock:'0x64',toBlock:'0x6d',toAddress:[WALLET],after:0,count:1000 },{ fromBlock:'0x64',toBlock:'0x6d',toAddress:[WALLET],after:2,count:1000 }]);
  });

  it('RED: a frame that itself reverted, a delegatecall and a zero value are not pointers', async () => {
    const legs = filterLegs(() => [
      at(101, call([0], SMART_WALLET, WALLET, 7n, { error: 'Reverted' })),
      at(102, call([0], SMART_WALLET, WALLET, 7n, {}, 'delegatecall')),
      at(103, call([0], SMART_WALLET, WALLET, 0n)),
    ]);
    expect(await readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: [WALLET] }, { traceLegs: legs })).toEqual([]);
  });

  it('RED: a pointer outside the window, or a malformed address, stops the read', async () => {
    const legs = filterLegs(() => [at(150, call([0], SMART_WALLET, WALLET, 7n))]);
    await expect(readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: [WALLET] }, { traceLegs: legs }))
      .rejects.toThrow('economic_discovery_trace_out_of_range');
    await expect(readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: ['0xABC'] }, { traceLegs: legs }))
      .rejects.toThrow('economic_discovery_trace_address_invalid');
    const broken = filterLegs(() => ({ not: 'an array' }));
    await expect(readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: [WALLET] }, { traceLegs: broken }))
      .rejects.toThrow('economic_discovery_trace_unavailable');
  });

  it('an empty watched set asks nothing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const legs = filterLegs(() => [], calls);
    expect(await readBaseInternalEthPointers({ fromBlock: 100, toBlock: 109, toAddresses: [] }, { traceLegs: legs })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
