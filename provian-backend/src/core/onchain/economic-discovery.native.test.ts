/**
 * 2026-10-01 — `readAgreedBaseNativeTransfersTo`: plain native ETH transfers into
 * watched addresses, read from full blocks on BOTH operator legs. It only
 * discovers a pointer; the chain-record lane re-verifies the whole transaction.
 * Each RED case differs from the GREEN one in the one field the filter reads.
 */
import { describe, it, expect } from '@jest/globals';
import { readAgreedBaseNativeTransfersTo } from './economic-discovery';
import type { EconomicStateRpcLeg } from './economic-state';

const WATCHED = '0xa11ce00000000000000000000000000000000001';
const OTHER = '0x7000000000000000000000000000000000000007';
const SENDER = '0x5000000000000000000000000000000000000005';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number | bigint) => `0x${n.toString(16)}`;

type Tx = Record<string, unknown>;
const tx = (n: number, over: Partial<Tx> = {}): Tx => ({
  hash: h(n), from: SENDER, to: WATCHED, value: q(1000), input: '0x', nonce: '0x1', ...over,
});

function legsFor(blocks: (side: 'a' | 'b', n: number) => unknown): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const leg = (side: 'a' | 'b'): EconomicStateRpcLeg => ({
    operatorId: `operator-${side}`,
    send: async (method, params) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getBlockByNumber') {
        expect(params[1]).toBe(true); // full transactions
        return structuredClone(blocks(side, Number(BigInt(params[0] as string))));
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return [leg('a'), leg('b')];
}
const block = (n: number, transactions: unknown[]) => ({ number: q(n), hash: h(9_000 + n), transactions });
const opts = (legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]) => ({ rpcLegs: legs, disagreementRetry: { attempts: 2, delayMs: 0 } });

describe('readAgreedBaseNativeTransfersTo', () => {
  it('returns every plain ETH transfer into a watched address across the range, agreed on both legs', async () => {
    const legs = legsFor((_side, n) => block(n, n === 101 ? [tx(1), tx(2, { to: OTHER })] : n === 102 ? [tx(3, { value: q(5n * 10n ** 18n) })] : []));
    const out = await readAgreedBaseNativeTransfersTo({ fromBlock: 100, toBlock: 103, toAddresses: new Set([WATCHED]) }, opts(legs));
    expect(out).toEqual([
      { transactionHash: h(1), blockNumber: 101, fromAddress: SENDER, toAddress: WATCHED, valueWei: '1000' },
      { transactionHash: h(3), blockNumber: 102, fromAddress: SENDER, toAddress: WATCHED, valueWei: (5n * 10n ** 18n).toString() },
    ]);
  });

  it('RED: calldata, a zero value, another recipient and a contract creation are not plain transfers into the address', async () => {
    const legs = legsFor((_s, n) => block(n, [
      tx(10, { input: '0xa9059cbb' }),
      tx(11, { value: '0x0' }),
      tx(12, { to: OTHER }),
      tx(13, { to: null }),
    ]));
    const out = await readAgreedBaseNativeTransfersTo({ fromBlock: 5, toBlock: 5, toAddresses: new Set([WATCHED]) }, opts(legs));
    expect(out).toEqual([]);
    // GREEN twin: the same transaction with no calldata IS found.
    const green = legsFor((_s, n) => block(n, [tx(10)]));
    expect(await readAgreedBaseNativeTransfersTo({ fromBlock: 5, toBlock: 5, toAddresses: new Set([WATCHED]) }, opts(green))).toHaveLength(1);
  });

  it('matches addresses case-insensitively on the transaction side (providers checksum `to`)', async () => {
    const legs = legsFor((_s, n) => block(n, [tx(20, { to: '0xA11CE00000000000000000000000000000000001' })]));
    expect(await readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(legs))).toHaveLength(1);
  });

  it('agreement is on the projection only: legs formatting unrelated fields differently still agree', async () => {
    const legs = legsFor((side, n) => ({ ...block(n, [tx(21, side === 'a' ? { gas: '0x5208' } : { gas: '21000', extra: true })]), size: side }));
    expect(await readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(legs))).toHaveLength(1);
  });

  it('RED: the legs disagree on a watched transfer → throws (a cursor never passes the block)', async () => {
    const legs = legsFor((side, n) => block(n, side === 'a' ? [tx(30)] : []));
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(legs)))
      .rejects.toThrow('economic_discovery_rpc_disagreement:native_transfers');
  });

  it('RED: a block one leg cannot return, or a block without full transactions, throws', async () => {
    const missing = legsFor((side, n) => (side === 'b' ? null : block(n, [])));
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(missing)))
      .rejects.toThrow('economic_discovery_block_unavailable');
    const hashesOnly = legsFor((_s, n) => block(n, [h(40)]));
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(hashesOnly)))
      .rejects.toThrow('economic_discovery_block_transactions_not_full');
  });

  it('RED: a leg answering for a different block number throws', async () => {
    const legs = legsFor((side, n) => block(side === 'a' ? n : n + 1, []));
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set([WATCHED]) }, opts(legs)))
      .rejects.toThrow('economic_discovery_block_invalid');
  });

  it('RED: a bad range or a non-lowercase watched address is refused before any read', async () => {
    const legs = legsFor((_s, n) => block(n, []));
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 5, toBlock: 4, toAddresses: new Set([WATCHED]) }, opts(legs)))
      .rejects.toThrow('economic_discovery_native_range_invalid');
    await expect(readAgreedBaseNativeTransfersTo({ fromBlock: 1, toBlock: 1, toAddresses: new Set(['0xA11CE00000000000000000000000000000000001']) }, opts(legs)))
      .rejects.toThrow('economic_discovery_native_address_invalid');
  });

  it('relay heap OOM 2026-10-17: a failed leg never leaves the other leg\'s full block running after the read returns', async () => {
    let releaseSlow: () => void = () => {};
    let slowSettled = false;
    const slow = new Promise<unknown>((resolve) => { releaseSlow = () => resolve(block(7, [])); });
    const legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] = [
      { operatorId: 'operator-a', send: async (method) => (method === 'eth_chainId' ? '0x2105' : slow.finally(() => { slowSettled = true; })) },
      { operatorId: 'operator-b', send: async (method) => { if (method === 'eth_chainId') return '0x2105'; throw new Error('leg_b_down'); } },
    ];
    let rejectedWhileSlowInFlight: boolean | null = null;
    const read = readAgreedBaseNativeTransfersTo({ fromBlock: 7, toBlock: 7, toAddresses: new Set([WATCHED]) }, opts(legs))
      .catch((e: Error) => { rejectedWhileSlowInFlight = !slowSettled; throw e; });
    await new Promise((r) => setTimeout(r, 20));
    expect(rejectedWhileSlowInFlight).toBeNull(); // still waiting on leg a (RED before the fix: rejected already)
    releaseSlow();
    await expect(read).rejects.toThrow('leg_b_down');
    expect(rejectedWhileSlowInFlight).toBe(false);
  });

  it('review r1: a block that fails fast never leaves a sibling block\'s reads running after the read returns', async () => {
    let releaseHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    let heldSettled = false;
    const leg = (side: 'a' | 'b'): EconomicStateRpcLeg => ({
      operatorId: `operator-${side}`,
      send: async (method, params) => {
        if (method === 'eth_chainId') return '0x2105';
        const n = Number(BigInt(params[0] as string));
        if (n === 20) throw new Error('block_20_down');
        if (n === 21) { await held; heldSettled = true; }
        return block(n, []);
      },
    });
    let rejectedWhileSiblingRunning: boolean | null = null;
    const read = readAgreedBaseNativeTransfersTo({ fromBlock: 20, toBlock: 23, toAddresses: new Set([WATCHED]) }, opts([leg('a'), leg('b')]))
      .catch((e: Error) => { rejectedWhileSiblingRunning = !heldSettled; throw e; });
    await new Promise((r) => setTimeout(r, 20));
    expect(rejectedWhileSiblingRunning).toBeNull(); // RED with Promise.all over the batch: rejected already
    releaseHeld();
    await expect(read).rejects.toThrow('block_20_down');
    expect(rejectedWhileSiblingRunning).toBe(false);
  });
});
