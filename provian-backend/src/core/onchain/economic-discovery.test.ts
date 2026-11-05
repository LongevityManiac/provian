import {
  BASE_GETLOGS_MAX_RANGE_BLOCKS,
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  getAgreedBaseLogs,
  normalizeProviderReply,
  PROVIDER_ANNOTATION_FIELDS,
  readAgreedBaseBlockHash,
  readAgreedBaseHead,
  readAgreedBaseSafeHead,
  verifyBaseUsdcTransferEvidence,
} from './economic-discovery';
import type { EconomicStateRpcLeg } from './economic-state';

const TX = `0x${'11'.repeat(32)}`;
const BLOCK = `0x${'22'.repeat(32)}`;
const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUBMITTER = '0xcccccccccccccccccccccccccccccccccccccccc';

function topic(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function quantity(value: number): string {
  return `0x${value.toString(16)}`;
}

function responses(head = 111): Record<string, unknown> {
  const log = {
    address: BASE_USDC_ADDRESS,
    topics: [ERC20_TRANSFER_TOPIC, topic(FROM), topic(TO)],
    data: quantity(5_000_000),
    blockNumber: quantity(100),
    blockHash: BLOCK,
    transactionHash: TX,
    transactionIndex: '0x1',
    logIndex: '0x2',
    removed: false,
  };
  return {
    eth_chainId: quantity(8453),
    eth_blockNumber: quantity(head),
    eth_getLogs: [log],
    eth_getTransactionReceipt: {
      transactionHash: TX,
      blockNumber: quantity(100),
      blockHash: BLOCK,
      status: '0x1',
      logs: [log],
    },
    eth_getTransactionByHash: {
      hash: TX,
      from: SUBMITTER,
      to: BASE_USDC_ADDRESS,
      input: `0xe3ee160e${'00'.repeat(32)}`,
      blockNumber: quantity(100),
      blockHash: BLOCK,
    },
    eth_getBlockByHash: {
      hash: BLOCK,
      number: quantity(100),
      timestamp: quantity(1_700_000_000),
    },
    eth_getBlockByNumber: {
      hash: BLOCK,
      number: quantity(100),
      timestamp: quantity(1_700_000_000),
    },
  };
}

function legs(
  left: Record<string, unknown>,
  right: Record<string, unknown> = structuredClone(left),
): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  return [
    { operatorId: 'operator-a', send: async (method) => structuredClone(left[method]) },
    { operatorId: 'operator-b', send: async (method) => structuredClone(right[method]) },
  ];
}

describe('operator-bound Base economic discovery', () => {
  it('commits an exact two-operator transfer snapshot whose hash ignores rising confirmations', async () => {
    const first = await verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(responses(111)) });
    const later = await verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(responses(150)) });

    expect(first).toEqual(later);
    expect(first).toMatchObject({
      confirmationFloor: 12,
      transactionSelector: '0xe3ee160e',
      transactionSubmitter: SUBMITTER,
      blockTimestampMs: 1_700_000_000_000,
      providerOperatorIds: ['operator-a', 'operator-b'],
    });
  });

  it('rejects one forged transaction field before economic classification', async () => {
    const left = responses();
    const right = structuredClone(left);
    (right.eth_getTransactionByHash as Record<string, unknown>).from = FROM;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, {
      rpcLegs: legs(left, right),
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow(
      'economic_discovery_rpc_disagreement:transaction',
    );
  });

  it('agrees when only one operator annotates the transaction and logs with blockTimestamp (the production split)', async () => {
    const left = responses();
    const right = structuredClone(left);
    // One operator serves `blockTimestamp` on transaction and log objects; the other does not.
    (left.eth_getTransactionByHash as Record<string, unknown>).blockTimestamp = quantity(1_700_000_000);
    for (const log of (left.eth_getTransactionReceipt as { logs: Record<string, unknown>[] }).logs) {
      log.blockTimestamp = quantity(1_700_000_000);
    }
    (left.eth_getLogs as Record<string, unknown>[])[0].blockTimestamp = quantity(1_700_000_000);
    // The population is not empty: the raw replies really differ before normalization.
    expect(JSON.stringify(left.eth_getTransactionByHash)).not.toEqual(JSON.stringify(right.eth_getTransactionByHash));
    const evidence = await verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(left, right), disagreementRetry: { attempts: 1, delayMs: 0 } });
    const plain = await verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(right) });
    expect(evidence).toEqual(plain);
  });

  it('RED CONTROL — the annotation is the only field forgiven: a leg omitting a specified field still disagrees', async () => {
    const left = responses();
    const right = structuredClone(left);
    (left.eth_getTransactionByHash as Record<string, unknown>).blockTimestamp = quantity(1_700_000_000);
    delete (right.eth_getTransactionByHash as Record<string, unknown>).to;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(left, right), disagreementRetry: { attempts: 1, delayMs: 0 } })).rejects.toThrow(
      'economic_discovery_rpc_disagreement:transaction',
    );
  });

  it('normalizeProviderReply strips only the annotation fields, on every shape that carries transactions or logs', () => {
    expect(PROVIDER_ANNOTATION_FIELDS).toEqual(['blockTimestamp']);
    const tx = { hash: TX, to: TO, blockTimestamp: '0x1' };
    const log = { logIndex: '0x2', blockTimestamp: '0x1' };
    expect(normalizeProviderReply('eth_getTransactionByHash', tx)).toEqual({ hash: TX, to: TO });
    expect(normalizeProviderReply('eth_getTransactionReceipt', { status: '0x1', logs: [log] }))
      .toEqual({ status: '0x1', logs: [{ logIndex: '0x2' }] });
    expect(normalizeProviderReply('eth_getLogs', [log])).toEqual([{ logIndex: '0x2' }]);
    expect(normalizeProviderReply('eth_getBlockByNumber', { number: '0x1', transactions: [tx] }))
      .toEqual({ number: '0x1', transactions: [{ hash: TX, to: TO }] });
    // A block header's own `timestamp` is a specified field and is never touched.
    expect(normalizeProviderReply('eth_getBlockByHash', { timestamp: '0x5', transactions: [TX] }))
      .toEqual({ timestamp: '0x5', transactions: [TX] });
    expect(normalizeProviderReply('eth_blockNumber', '0x10')).toBe('0x10');
    expect(normalizeProviderReply('eth_getTransactionByHash', null)).toBeNull();
    // The input is never mutated (both legs' raw replies stay as they arrived).
    expect(tx.blockTimestamp).toBe('0x1');
  });

  it('rejects selector disagreement before a relayed transfer can receive x402 economics', async () => {
    const left = responses();
    const right = structuredClone(left);
    (right.eth_getTransactionByHash as Record<string, unknown>).input =
      `0x23b872dd${'00'.repeat(32)}`;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, {
      rpcLegs: legs(left, right),
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow(
      'economic_discovery_rpc_disagreement:transaction',
    );
  });

  it('rejects discovery-log disagreement from one compromised operator', async () => {
    const left = responses();
    const right = structuredClone(left);
    ((right.eth_getLogs as Array<Record<string, unknown>>)[0]).data = quantity(5_000_001);
    await expect(getAgreedBaseLogs({
      address: BASE_USDC_ADDRESS,
      topics: [ERC20_TRANSFER_TOPIC],
      fromBlock: 90,
      toBlock: 100,
    }, {
      rpcLegs: legs(left, right),
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow(
      'economic_discovery_rpc_disagreement:logs',
    );
  });

  it('rejects stale head disagreement and a failed provider leg', async () => {
    const left = responses(111);
    const right = responses(110);
    await expect(readAgreedBaseHead({
      rpcLegs: legs(left, right),
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow(
      'economic_discovery_rpc_disagreement:head',
    );
    const failing: EconomicStateRpcLeg = {
      operatorId: 'operator-b',
      send: async () => { throw new Error('provider_unavailable'); },
    };
    await expect(readAgreedBaseHead({
      rpcLegs: [legs(left)[0], failing],
    })).rejects.toThrow('provider_unavailable');
  });

  it('rejects an absent transaction and a reorged block hash', async () => {
    const absent = responses();
    absent.eth_getTransactionByHash = null;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(absent) })).rejects.toThrow('economic_evidence_pending:transaction_unavailable');

    const reorged = responses();
    (reorged.eth_getTransactionByHash as Record<string, unknown>).blockHash = `0x${'33'.repeat(32)}`;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(reorged) })).rejects.toThrow('economic_evidence_transaction_invalid');
  });

  it('rejects an orphaned receipt block and a height-regressing temporal reorg', async () => {
    const orphaned = responses();
    (orphaned.eth_getBlockByNumber as Record<string, unknown>).hash = `0x${'44'.repeat(32)}`;
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: legs(orphaned) })).rejects.toThrow(
      'economic_evidence_receipt_block_not_canonical',
    );

    const base = responses();
    const temporalLeg = (operatorId: string): EconomicStateRpcLeg => {
      let headReads = 0;
      return {
        operatorId,
        send: async (method) => {
          if (method === 'eth_blockNumber') {
            headReads += 1;
            return headReads === 1 ? quantity(111) : quantity(105);
          }
          return structuredClone(base[method]);
        },
      };
    };
    await expect(verifyBaseUsdcTransferEvidence({
      transactionHash: TX,
      logIndex: 2,
      expectedFrom: FROM,
      expectedTo: TO,
      expectedAmountAtomic: '5000000',
    }, { rpcLegs: [temporalLeg('operator-a'), temporalLeg('operator-b')] })).rejects.toThrow(
      'economic_evidence_head_regressed_during_verification',
    );
  });
});

// =============================================================================
// THE SAFE HEAD — quorum on {number, hash} only
//
// was found by probing live Base before the 1e deploy: two
// operator-independent endpoints return the SAME safe block with cosmetically
// different field formatting, and the original whole-object `canonical()`
// comparison would have thrown on every call — permanently disabling the
// watcher (fail-closed, but a dead feature). The read now compares only the two
// fields the reorg floor uses. These lock that in, and the "cosmetic drift" case
// is the negative control for the old behaviour: it is exactly the input that
// used to throw and must now agree.
// =============================================================================
describe('readAgreedBaseSafeHead — quorum on {number, hash} only ', () => {
  const CHAIN = quantity(8453);
  const SAFE_HASH = `0x${'5e'.repeat(32)}`;
  // A realistic OP-Stack safe block: many fields beyond number+hash, all of
  // which the reorg floor ignores.
  const safeBlock = (over: Record<string, unknown> = {}) => ({
    number: quantity(49_498_893),
    hash: SAFE_HASH,
    parentHash: `0x${'ab'.repeat(32)}`,
    timestamp: quantity(1_700_000_000),
    gasUsed: quantity(12_345_678),
    size: quantity(0x2ba),
    baseFeePerGas: quantity(1_000),
    withdrawalsRoot: `0x${'cd'.repeat(32)}`,
    ...over,
  });
  const chainLeg = (block: unknown): Record<string, unknown> => ({
    eth_chainId: CHAIN,
    eth_getBlockByNumber: block,
  });

  it('AGREES on the SAME block whose other fields are formatted differently (the case)', async () => {
    // Same number, same hash — but the secondary drops leading zeros, omits a
    // field and adds one of its own. the pre- whole-object compare
    // this threw; now it must return the projection.
    const left = chainLeg(safeBlock());
    const right = chainLeg(safeBlock({
      size: quantity(0x02ba as unknown as number), // cosmetic; different string
      gasUsed: quantity(12_345_679), // a value the floor never reads
      totalDifficulty: quantity(0), // a field the primary did not send
    }));
    delete (right.eth_getBlockByNumber as Record<string, unknown>).withdrawalsRoot;
    const safe = await readAgreedBaseSafeHead({ rpcLegs: legs(left, right) });
    expect(safe).toEqual({ number: 49_498_893, hash: SAFE_HASH });
  });

  it.each([false, true])('agrees at the lower safe height regardless of which operator is ahead (%s)', async (reverse) => {
    const requests: (readonly unknown[])[] = [];
    const lower = 49_498_893;
    const pair = [lower, lower + 35].map((height): EconomicStateRpcLeg => ({
      operatorId: `operator-${height}`,
      send: async (method, params) => {
        if (method === 'eth_chainId') return CHAIN;
        requests.push(params);
        return safeBlock({ number: quantity(params[0] === 'safe' ? height : lower),
          hash: params[0] === 'safe' && height > lower ? `0x${'aa'.repeat(32)}` : SAFE_HASH });
      },
    }));
    if (reverse) pair.reverse();
    await expect(readAgreedBaseSafeHead({ rpcLegs: pair as [EconomicStateRpcLeg, EconomicStateRpcLeg] }))
      .resolves.toEqual({ number: lower, hash: SAFE_HASH });
    expect(requests.filter((p) => p[0] === quantity(lower))).toHaveLength(2);
  });

  it.each(['mismatch', 'missing', 'wrong-height'])('refuses an unsafe common-height read: %s', async (fault) => {
    const lower = 49_498_893;
    const pair = [lower, lower + 35].map((height, index): EconomicStateRpcLeg => ({
      operatorId: `operator-${height}`,
      send: async (method, params) => {
        if (method === 'eth_chainId') return CHAIN;
        if (params[0] === 'safe') return safeBlock({ number: quantity(height) });
        if (index === 1 && fault === 'missing') return null;
        return safeBlock({ number: quantity(fault === 'wrong-height' && index === 1 ? lower + 1 : lower),
          hash: fault === 'mismatch' && index === 1 ? `0x${'aa'.repeat(32)}` : SAFE_HASH });
      },
    }));
    await expect(readAgreedBaseSafeHead({ rpcLegs: pair as [EconomicStateRpcLeg, EconomicStateRpcLeg] }))
      .rejects.toThrow(fault === 'mismatch' ? 'economic_discovery_rpc_disagreement:safe_head' : 'economic_discovery_common_safe_block_unavailable');
  });

  it('THROWS when the height matches but the HASH differs — one endpoint names a different block', async () => {
    const left = chainLeg(safeBlock());
    const right = chainLeg(safeBlock({ hash: `0x${'9d'.repeat(32)}` }));
    await expect(readAgreedBaseSafeHead({ rpcLegs: legs(left, right) }))
      .rejects.toThrow('economic_discovery_rpc_disagreement:safe_head');
  });

  it('returns unavailable when either operator has no safe block', async () => {
    // Trusting the single answer would defeat the quorum.
    const left = chainLeg(safeBlock());
    const right = chainLeg(null);
    await expect(readAgreedBaseSafeHead({ rpcLegs: legs(left, right) })).resolves.toBeNull();
  });

  it('returns null ONLY when BOTH legs report no safe block yet (initial sync)', async () => {
    const both = chainLeg(null);
    await expect(readAgreedBaseSafeHead({ rpcLegs: legs(both, structuredClone(both)) }))
      .resolves.toBeNull();
  });

  it('THROWS on a malformed hash rather than trusting it', async () => {
    const bad = chainLeg(safeBlock({ hash: '0xdeadbeef' }));
    await expect(readAgreedBaseSafeHead({ rpcLegs: legs(bad, structuredClone(bad)) }))
      .rejects.toThrow('economic_discovery_safe_head_invalid');
  });

  it('still enforces the chain guard before reading the safe head', async () => {
    const wrongChain = { eth_chainId: quantity(1), eth_getBlockByNumber: safeBlock() };
    await expect(readAgreedBaseSafeHead({ rpcLegs: legs(wrongChain, structuredClone(wrongChain)) }))
      .rejects.toThrow('economic_discovery_chain_mismatch');
  });
});

// =============================================================================
// Bounded canonical disagreement re-poll. Tip-height skew is allowed only when
// both operators agree on the canonical hash at their common numeric height.
// A conflicting hash re-polls both legs together; persistent conflicting facts
// fail after the bounded attempts. These fixtures model conflicting hashes.
// =============================================================================
describe('agreed() bounded both-legs disagreement re-poll', () => {
  function countingLeg(
    operatorId: string,
    heads: readonly number[],
  ): { leg: EconomicStateRpcLeg; calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    let headIndex = 0;
    const leg: EconomicStateRpcLeg = {
      operatorId,
      send: async (method, params) => {
        calls[method] = (calls[method] ?? 0) + 1;
        if (method === 'eth_chainId') return quantity(8453);
        if (method === 'eth_blockNumber') {
          const value = heads[Math.min(headIndex, heads.length - 1)];
          headIndex += 1;
          return quantity(value);
        }
        if (method === 'eth_getBlockByNumber') return { number: params[0], hash: `0x${heads[Math.min(heads.length - 1, Math.max(0, headIndex - 1))].toString(16).padStart(64, '0')}` };
        throw new Error(`unexpected_method:${method}`);
      },
    };
    return { leg, calls };
  }

  it('absorbs a transient canonical hash split: both legs re-polled together', async () => {
    const a = countingLeg('operator-a', [111, 112]);
    const b = countingLeg('operator-b', [112, 112]);
    await expect(readAgreedBaseHead({
      rpcLegs: [a.leg, b.leg],
      disagreementRetry: { delayMs: 0 },
    })).resolves.toBe(112);
    // BOTH legs were re-issued on the retry — a disagreed answer is never
    // accepted from one side.
    expect(a.calls.eth_blockNumber).toBe(2);
    expect(b.calls.eth_blockNumber).toBe(2);
  });

  it('a persistent canonical hash split throws after exactly the bounded attempts', async () => {
    const a = countingLeg('operator-a', [111]);
    const b = countingLeg('operator-b', [110]);
    await expect(readAgreedBaseHead({
      rpcLegs: [a.leg, b.leg],
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow('economic_discovery_rpc_disagreement:head');
    expect(a.calls.eth_blockNumber).toBe(4);
    expect(b.calls.eth_blockNumber).toBe(4);
  });

  it('RED CONTROL — attempts pinned to 1 reproduces the single-shot failure the retry absorbs', async () => {
    // Identical transient input as the absorption test above; with the
    // re-poll disabled the first mismatch throws. This is exactly what
    // production did before the fix, proving the retry (not the input) is
    // what absorbs the transient — the assertion cannot pass vacuously.
    const a = countingLeg('operator-a', [111, 112]);
    const b = countingLeg('operator-b', [112, 112]);
    await expect(readAgreedBaseHead({
      rpcLegs: [a.leg, b.leg],
      disagreementRetry: { attempts: 1, delayMs: 0 },
    })).rejects.toThrow('economic_discovery_rpc_disagreement:head');
    expect(a.calls.eth_blockNumber).toBe(1);
    expect(b.calls.eth_blockNumber).toBe(1);
  });

  it('a failed provider leg is NOT retried — it propagates immediately', async () => {
    const a = countingLeg('operator-a', [111]);
    let failedCalls = 0;
    const failing: EconomicStateRpcLeg = {
      operatorId: 'operator-b',
      send: async (method) => {
        if (method === 'eth_chainId') return quantity(8453);
        failedCalls += 1;
        throw new Error('provider_unavailable');
      },
    };
    await expect(readAgreedBaseHead({
      rpcLegs: [a.leg, failing],
      disagreementRetry: { delayMs: 0 },
    })).rejects.toThrow('provider_unavailable');
    expect(failedCalls).toBe(1);
  });
});

// =============================================================================
// the canonical block hash at a height, quorum-2 on the hash (settlement finality).
// =============================================================================
describe('readAgreedBaseBlockHash — quorum on the canonical hash at one height ', () => {
  const CHAIN = quantity(8453);
  const HASH_A = `0x${'a1'.repeat(32)}`;
  const HASH_B = `0x${'b2'.repeat(32)}`;
  const at = (block: unknown): Record<string, unknown> => ({ eth_chainId: CHAIN, eth_getBlockByNumber: block });

  it('returns the agreed hash (other fields may be formatted differently)', async () => {
    const left = at({ number: quantity(100), hash: HASH_A, size: quantity(0x2ba) });
    const right = at({ number: '0x64', hash: HASH_A });
    expect(await readAgreedBaseBlockHash(100, { rpcLegs: legs(left, right) })).toBe(HASH_A);
  });

  it('THROWS when the legs name different blocks at the height — never trusts either side', async () => {
    const left = at({ number: quantity(100), hash: HASH_A });
    const right = at({ number: quantity(100), hash: HASH_B });
    await expect(readAgreedBaseBlockHash(100, { rpcLegs: legs(left, right) }))
      .rejects.toThrow('economic_discovery_rpc_disagreement:block_hash');
  });

  it('THROWS when one leg has the block and the other does not', async () => {
    await expect(readAgreedBaseBlockHash(100, {
      rpcLegs: legs(at({ number: quantity(100), hash: HASH_A }), at(null)),
    })).rejects.toThrow('economic_discovery_rpc_disagreement:block_hash');
  });

  it('THROWS when the agreed block is not at the height asked for', async () => {
    const block = at({ number: quantity(101), hash: HASH_A });
    await expect(readAgreedBaseBlockHash(100, { rpcLegs: legs(block, block) }))
      .rejects.toThrow('economic_discovery_rpc_disagreement:block_hash');
  });

  it('returns null only when NEITHER leg has a block at the height yet', async () => {
    expect(await readAgreedBaseBlockHash(100, { rpcLegs: legs(at(null), at(null)) })).toBeNull();
  });
});

describe('getAgreedBaseLogs — the provider range cap (2026-10-07)', () => {
  it('adapts to a provider reducing its range to 200 while agreeing EVERY block on both legs', async () => {
    const base = responses();
    const accepted: Array<Array<[number, number]>> = [[], []];
    const l = [0, 1].map((i) => ({ operatorId: `operator-${i}`, send: async (method: string, params: readonly unknown[]) => {
      if (method !== 'eth_getLogs') return structuredClone(base[method]);
      const f = params[0] as { fromBlock: string; toBlock: string };
      const from = Number(f.fromBlock); const to = Number(f.toBlock);
      if (i === 1 && to - from + 1 > 200) throw new Error('eth_getLogs is limited to a 200 range');
      if (to - from + 1 <= 200) accepted[i].push([from, to]);
      return [{ ...(base.eth_getLogs as Array<Record<string, unknown>>)[0], blockNumber: quantity(from) }];
    } })) as unknown as readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
    const logs = await getAgreedBaseLogs({ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC], fromBlock: 1000, toBlock: 2199 }, { rpcLegs: l });
    expect(accepted[0]).toEqual([[1000, 1199], [1200, 1399], [1400, 1599], [1600, 1799], [1800, 1999], [2000, 2199]]);
    expect(accepted[1]).toEqual(accepted[0]);
    expect(logs.map(x => x.blockNumber)).toEqual(accepted[0].map(x => x[0]));
  });

  it('never adapts around provider disagreement or a generic failure', async () => {
    const base = responses();
    for (const message of ['economic_discovery_rpc_disagreement:logs', 'request timeout', '413 Payload Too Large']) {
      let calls = 0;
      const bad = async (method: string) => { if (method === 'eth_getLogs') { calls += 1; throw new Error(message); } return structuredClone(base[method]); };
      await expect(getAgreedBaseLogs({ address: BASE_USDC_ADDRESS, topics: [], fromBlock: 1000, toBlock: 2199 }, { rpcLegs: [{ operatorId: 'a', send: bad }, { operatorId: 'b', send: bad }] })).rejects.toThrow(message);
      expect(calls).toBe(2);
    }
  });

  function recordingLegs(): { legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]; ranges: Array<[number, number]> } {
    const base = responses();
    const ranges: Array<[number, number]> = [];
    const send = (record: boolean) => async (method: string, params?: unknown) => {
      if (method !== 'eth_getLogs') return structuredClone(base[method]);
      const f = (params as Array<{ fromBlock: string; toBlock: string }>)[0];
      const from = Number(f.fromBlock); const to = Number(f.toBlock);
      if (to - from + 1 > BASE_GETLOGS_MAX_RANGE_BLOCKS) throw new Error('eth_getLogs is limited to a 500 range');
      if (record) ranges.push([from, to]);
      return [{ ...(base.eth_getLogs as Array<Record<string, unknown>>)[0], blockNumber: quantity(from) }];
    };
    return { legs: [{ operatorId: 'operator-a', send: send(true) }, { operatorId: 'operator-b', send: send(false) }], ranges };
  }

  it('splits a 1,200-block range into ≤500-block requests and returns every sub-range\'s logs in order', async () => {
    const { legs: l, ranges } = recordingLegs();
    const logs = await getAgreedBaseLogs({ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC], fromBlock: 1_000, toBlock: 2_199 },
      { rpcLegs: l, disagreementRetry: { delayMs: 0 } });
    expect(ranges).toEqual([[1_000, 1_499], [1_500, 1_999], [2_000, 2_199]]);
    expect(logs.map((x) => x.blockNumber)).toEqual([1_000, 1_500, 2_000]);
  });

  it('a range at the cap is one request (RED control for the split: a 2,000-block chunk threw before)', async () => {
    const { legs: l, ranges } = recordingLegs();
    await getAgreedBaseLogs({ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC], fromBlock: 0, toBlock: BASE_GETLOGS_MAX_RANGE_BLOCKS - 1 },
      { rpcLegs: l, disagreementRetry: { delayMs: 0 } });
    expect(ranges).toEqual([[0, BASE_GETLOGS_MAX_RANGE_BLOCKS - 1]]);
  });
});
