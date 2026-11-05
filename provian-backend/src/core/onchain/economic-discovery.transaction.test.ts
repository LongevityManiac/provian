/**
 * , defect 2 — `verifyBaseTransactionEvidence` is the chain-record
 * lane's ONLY finality / reorg gate, so every check it makes is shown FAILING here on
 * a violating input beside the GREEN read it differs from in exactly one field.
 * Driven through injected operator legs; the responder is parameter-aware so the
 * `safe` tag and the receipt-block tag answer independently.
 */
import { describe, it, expect } from '@jest/globals';
import {
  ERC20_TRANSFER_TOPIC,
  hashBaseTransactionEvidence,
  readAgreedBaseBlockTimestampMs,
  verifyBaseTransactionEvidence,
  verifyEvmTransactionEvidence,
} from './economic-discovery';
import type { EconomicStateRpcLeg } from './economic-state';

const TX = `0x${'11'.repeat(32)}`;
const BLOCK_HASH = `0x${'22'.repeat(32)}`;
const OTHER_HASH = `0x${'33'.repeat(32)}`;
const SAFE_HASH = `0x${'44'.repeat(32)}`;
const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2';
const q = (n: number) => `0x${n.toString(16)}`;
const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const BLOCK = 100;

interface World {
  head: number;
  safe: { number: number; hash: string } | null;
  status: string;
  canonicalHash: string;
  log: Record<string, unknown>;
  value: string;
  input: string;
  receipt?: unknown;
  /** Successive answers for the receipt-block tag (a reorg DURING verification). */
  canonicalSequence?: string[];
  /** Hashes of blocks above the receipt block, by height (the common safe height). */
  blocks?: Record<number, string>;
}

function world(over: Partial<World> = {}): World {
  return {
    head: BLOCK + 20,
    safe: { number: BLOCK + 5, hash: SAFE_HASH },
    status: '0x1',
    canonicalHash: BLOCK_HASH,
    value: q(0),
    input: `0xa9059cbb${'00'.repeat(64)}`,
    log: {
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, topic(FROM), topic(TO)],
      data: q(5),
      blockNumber: q(BLOCK),
      blockHash: BLOCK_HASH,
      transactionHash: TX,
      transactionIndex: '0x0',
      logIndex: '0x3',
      removed: false,
    },
    ...over,
  };
}

function respond(w: World, method: string, params: readonly unknown[]): unknown {
  switch (method) {
    case 'eth_chainId': return q(8453);
    case 'eth_blockNumber': return q(w.head);
    case 'eth_getTransactionReceipt':
      return w.receipt !== undefined ? w.receipt : {
        transactionHash: TX, blockNumber: q(BLOCK), blockHash: BLOCK_HASH, status: w.status, logs: [w.log],
      };
    case 'eth_getTransactionByHash':
      return { hash: TX, from: FROM, to: TOKEN, input: w.input, value: w.value, blockNumber: q(BLOCK), blockHash: BLOCK_HASH };
    case 'eth_getBlockByHash':
      return { hash: BLOCK_HASH, number: q(BLOCK), timestamp: q(1_800_000_000) };
    case 'eth_getBlockByNumber':
      if (params[0] === 'safe') return w.safe === null ? null : { number: q(w.safe.number), hash: w.safe.hash };
      if (typeof params[0] === 'string' && w.blocks) {
        const height = Number(BigInt(params[0]));
        if (height !== BLOCK && w.blocks[height] !== undefined) return { number: params[0], hash: w.blocks[height] };
      }
      return {
        hash: w.canonicalSequence ? (w.canonicalSequence.shift() ?? w.canonicalHash) : w.canonicalHash,
        number: q(BLOCK),
        timestamp: q(1_800_000_000),
      };
    default: throw new Error(`unexpected ${method}`);
  }
}

function legs(left: World, right: World = left): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  return [
    { operatorId: 'op-a', send: async (m, p) => structuredClone(respond(left, m, p)) },
    { operatorId: 'op-b', send: async (m, p) => structuredClone(respond(right, m, p)) },
  ];
}

const run = (l: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]) => verifyBaseTransactionEvidence(
  { transactionHash: TX },
  { rpcLegs: l, disagreementRetry: { attempts: 1, delayMs: 0 } },
);

describe('verifyBaseTransactionEvidence — the chain-record lane\'s finality gate', () => {
  it('GREEN: a successful, canonical, final, safe transaction yields hashed evidence of every log', async () => {
    const e = await run(legs(world()));
    expect(e).toMatchObject({
      transactionHash: TX, blockNumber: BLOCK, fromAddress: FROM, toAddress: TOKEN,
      valueWei: '0', inputEmpty: false, transactionSelector: '0xa9059cbb',
      providerOperatorIds: ['op-a', 'op-b'], confirmationFloor: 12,
    });
    expect(e.logs).toHaveLength(1);
    const { evidenceHash, ...rest } = e;
    expect(evidenceHash).toBe(hashBaseTransactionEvidence(rest));
  });

  it('GREEN: a plain value transfer reads as input-empty with its value', async () => {
    const e = await run(legs(world({ input: '0x', value: q(1000), receipt: {
      transactionHash: TX, blockNumber: q(BLOCK), blockHash: BLOCK_HASH, status: '0x1', logs: [],
    } })));
    expect(e).toMatchObject({ inputEmpty: true, valueWei: '1000', logs: [] });
  });

  it('RED: a reverted transaction is refused as failed (terminal)', async () => {
    await expect(run(legs(world({ status: '0x0' })))).rejects.toThrow('economic_evidence_transaction_failed');
  });

  it('RED: an unknown transaction is pending, never evidence', async () => {
    await expect(run(legs(world({ receipt: null })))).rejects.toThrow('economic_evidence_pending:transaction_unavailable');
  });

  it('RED: under the 12-confirmation floor is pending', async () => {
    await expect(run(legs(world({ head: BLOCK + 10 })))).rejects.toThrow(/economic_evidence_pending:confirmations:11\/12/);
  });

  it('RED: above the agreed safe head is pending ', async () => {
    await expect(run(legs(world({ safe: { number: BLOCK - 1, hash: SAFE_HASH } }))))
      .rejects.toThrow(/economic_evidence_pending:safe_head/);
  });

  it('RED: no safe head on either leg is pending, never a fallback to the unsafe head', async () => {
    await expect(run(legs(world({ safe: null })))).rejects.toThrow('economic_evidence_pending:safe_head_unavailable');
  });

  it('RED: the two legs naming different safe heads is a disagreement', async () => {
    await expect(run(legs(world(), world({ safe: { number: BLOCK + 5, hash: OTHER_HASH } }))))
      .rejects.toThrow('economic_discovery_rpc_disagreement:safe_head');
  });

  it('GREEN: safe tips a block or two apart agree at their common safe height (the production split)', async () => {
    const left = world({ safe: { number: BLOCK + 5, hash: SAFE_HASH }, blocks: { [BLOCK + 5]: SAFE_HASH } });
    const right = world({ safe: { number: BLOCK + 7, hash: OTHER_HASH }, blocks: { [BLOCK + 5]: SAFE_HASH } });
    const e = await run(legs(left, right));
    expect(e.blockNumber).toBe(BLOCK);
  });

  it('RED: safe tips a block apart whose COMMON block hashes differ is a disagreement', async () => {
    const left = world({ safe: { number: BLOCK + 5, hash: SAFE_HASH }, blocks: { [BLOCK + 5]: SAFE_HASH } });
    const right = world({ safe: { number: BLOCK + 7, hash: OTHER_HASH }, blocks: { [BLOCK + 5]: OTHER_HASH } });
    await expect(run(legs(left, right))).rejects.toThrow('economic_discovery_rpc_disagreement:safe_head');
  });

  it('RED: a common safe height below the receipt block is pending, even when one leg is ahead', async () => {
    const left = world({ safe: { number: BLOCK - 1, hash: SAFE_HASH }, blocks: { [BLOCK - 1]: SAFE_HASH } });
    const right = world({ safe: { number: BLOCK + 7, hash: OTHER_HASH }, blocks: { [BLOCK - 1]: SAFE_HASH } });
    await expect(run(legs(left, right))).rejects.toThrow(/economic_evidence_pending:safe_head/);
  });

  it('RED: one leg without a safe block yet is pending, never a fallback', async () => {
    await expect(run(legs(world(), world({ safe: null })))).rejects.toThrow('economic_evidence_pending:safe_head_unavailable');
  });

  it('RED: a receipt block that is no longer canonical (reorged) is refused', async () => {
    await expect(run(legs(world({ canonicalHash: OTHER_HASH })))).rejects.toThrow('economic_evidence_receipt_block_not_canonical');
  });

  it('RED: a reorg that lands DURING verification (canonical at the first read, gone at the re-read) is refused', async () => {
    const w = world({ canonicalSequence: [BLOCK_HASH, OTHER_HASH] });
    const v = world({ canonicalSequence: [BLOCK_HASH, OTHER_HASH] });
    await expect(run(legs(w, v))).rejects.toThrow('economic_evidence_receipt_block_not_canonical');
  });

  it('RED: a removed log, or a log from another block, is refused', async () => {
    const w = world();
    await expect(run(legs(world({ log: { ...w.log, removed: true } })))).rejects.toThrow('economic_evidence_receipt_log_invalid');
    await expect(run(legs(world({ log: { ...w.log, blockHash: OTHER_HASH } })))).rejects.toThrow('economic_evidence_receipt_log_invalid');
  });

  it('RED: the two legs disagreeing on the receipt is a disagreement, never either answer', async () => {
    await expect(run(legs(world(), world({ status: '0x0' })))).rejects.toThrow('economic_discovery_rpc_disagreement:receipt');
  });
});

describe('verifyEvmTransactionEvidence — the same gate on Arbitrum One / OP Mainnet', () => {
  const chainLegs = (chainId: number, over: Partial<World> = {}): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] => {
    const w = world(over);
    const send = async (m: string, p: readonly unknown[]) => (m === 'eth_chainId' ? q(chainId) : structuredClone(respond(w, m, p)));
    return [{ operatorId: 'op-a', send }, { operatorId: 'op-b', send }];
  };
  const runOn = (chain: 'arbitrum' | 'optimism', l: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]) =>
    verifyEvmTransactionEvidence(chain, { transactionHash: TX }, { rpcLegs: l, disagreementRetry: { attempts: 1, delayMs: 0 } });

  it('GREEN: an Arbitrum transaction yields evm-transaction-evidence/v1 with chain id 42161', async () => {
    const e = await runOn('arbitrum', chainLegs(42161));
    expect(e).toMatchObject({ schemaVersion: 'evm-transaction-evidence/v1', chainId: 42161, blockNumber: BLOCK });
    const { evidenceHash, ...body } = e;
    expect(evidenceHash).toBe(hashBaseTransactionEvidence(body));
  });

  it('RED: legs that answer for a different chain are refused (an Optimism read of Base)', async () => {
    await expect(runOn('optimism', chainLegs(8453))).rejects.toThrow('economic_discovery_chain_mismatch:8453');
  });

  it('RED: the same operator on both legs is refused', async () => {
    const [a] = chainLegs(42161);
    await expect(runOn('arbitrum', [a, { ...a }])).rejects.toThrow('economic_discovery_operators_not_independent');
  });

  it('RED: above the agreed safe head is pending on another chain too', async () => {
    await expect(runOn('arbitrum', chainLegs(42161, { safe: { number: BLOCK - 1, hash: SAFE_HASH } })))
      .rejects.toThrow(/economic_evidence_pending:safe_head/);
  });
});

describe('readAgreedBaseBlockTimestampMs — a registration fence read as a time', () => {
  const blockLegs = (left: unknown, right: unknown = left): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] => [
    { operatorId: 'op-a', send: async (m) => (m === 'eth_chainId' ? q(8453) : structuredClone(left)) },
    { operatorId: 'op-b', send: async (m) => (m === 'eth_chainId' ? q(8453) : structuredClone(right)) },
  ];
  const read = (l: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]) =>
    readAgreedBaseBlockTimestampMs(BLOCK, { rpcLegs: l, disagreementRetry: { attempts: 1, delayMs: 0 } });
  const block = (over: Record<string, unknown> = {}) => ({ number: q(BLOCK), hash: BLOCK_HASH, timestamp: q(1_800_000_000), miner: '0x1', ...over });

  it('GREEN: both legs agree on number, hash and timestamp (other fields may differ)', async () => {
    expect(await read(blockLegs(block(), block({ miner: '0x2' })))).toBe(1_800_000_000_000);
  });
  it('RED: one leg\'s different timestamp is a disagreement, never either leg\'s answer', async () => {
    await expect(read(blockLegs(block(), block({ timestamp: q(1_800_000_001) }))))
      .rejects.toThrow('economic_discovery_rpc_disagreement:block_timestamp');
  });
  it('RED: a block at another height is invalid', async () => {
    await expect(read(blockLegs(block({ number: q(BLOCK + 1) })))).rejects.toThrow(/economic_discovery_block_invalid/);
  });
  it('RED: one leg without the block is a disagreement; neither is pending', async () => {
    await expect(read(blockLegs(block(), null))).rejects.toThrow('economic_discovery_rpc_disagreement:block_timestamp');
    await expect(read(blockLegs(null))).rejects.toThrow('economic_evidence_pending:block_unavailable');
  });
});
