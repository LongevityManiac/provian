import {
  assertBaseEconomicFinalityEvidence,
  verifyBaseEconomicTransactionFinality,
  type EconomicFinalityRpcLeg,
} from './economic-finality';

const TX_HASH = `0x${'a'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const PARENT_HASH = `0x${'c'.repeat(64)}`;
const CONTRACT = '0x1111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';

function rawReceipt(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: '0x64',
    status: '0x1',
    from: FROM,
    to: CONTRACT,
    logs: [],
    ...overrides,
  };
}

function rawBlock(overrides: Record<string, unknown> = {}) {
  return {
    number: '0x64',
    hash: BLOCK_HASH,
    parentHash: PARENT_HASH,
    timestamp: '0x1234',
    ...overrides,
  };
}

function leg(
  operatorId: string,
  options: {
    receipt?: unknown;
    block?: unknown;
    canonicalBlock?: unknown;
    heads?: readonly string[];
  } = {},
): EconomicFinalityRpcLeg {
  let headIndex = 0;
  return {
    operatorId,
    send: jest.fn(async (method: string) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getTransactionReceipt') return options.receipt ?? rawReceipt();
      if (method === 'eth_getBlockByHash') return options.block ?? rawBlock();
      if (method === 'eth_getBlockByNumber') return options.canonicalBlock ?? rawBlock();
      if (method === 'eth_blockNumber') {
        const heads = options.heads ?? ['0x6f']; // 111 - 100 + 1 = 12
        const value = heads[Math.min(headIndex, heads.length - 1)];
        headIndex += 1;
        return value;
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
}

describe('Base economic finality', () => {
  it('accepts exactly 12 confirmations from two exact operator-bound raw reads', async () => {
    const result = await verifyBaseEconomicTransactionFinality(TX_HASH, {
      expectedTo: CONTRACT,
      now: () => 1234,
      rpcLegs: [leg('operator-a'), leg('operator-b')],
    });
    expect(result.evidence).toMatchObject({
      blockNumber: 100,
      headBlockNumber: 111,
      confirmations: 12,
      providerOperatorIds: ['operator-a', 'operator-b'],
      observedAtMs: 1234,
    });
  });

  it('rejects the exact 11-confirmation boundary', async () => {
    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [leg('operator-a', { heads: ['0x6e'] }), leg('operator-b', { heads: ['0x6e'] })],
    })).rejects.toThrow('economic_finality_confirmations_pending:11/12');
  });

  it('does not let one forged +2 head turn an honest 11 confirmations into 12', async () => {
    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [leg('operator-a', { heads: ['0x6e'] }), leg('operator-b', { heads: ['0x70'] })],
    })).rejects.toThrow('economic_finality_rpc_disagreement:head');
  });

  it('rejects receipt disagreement and a reorged receipt block', async () => {
    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [
        leg('operator-a'),
        leg('operator-b', { receipt: rawReceipt({ status: '0x0' }) }),
      ],
    })).rejects.toThrow('economic_finality_rpc_disagreement:receipt');

    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [
        leg('operator-a', { block: rawBlock({ hash: `0x${'d'.repeat(64)}` }) }),
        leg('operator-b', { block: rawBlock({ hash: `0x${'d'.repeat(64)}` }) }),
      ],
    })).rejects.toThrow('economic_finality_receipt_block_mismatch');
  });

  it('rejects an orphaned receipt block after a temporal reorg', async () => {
    const replacement = rawBlock({ hash: `0x${'d'.repeat(64)}` });
    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [
        leg('operator-a', { canonicalBlock: replacement }),
        leg('operator-b', { canonicalBlock: replacement }),
      ],
    })).rejects.toThrow('economic_finality_receipt_block_not_canonical');
  });

  it('rejects a height-reducing reorg after the first agreed head', async () => {
    await expect(verifyBaseEconomicTransactionFinality(TX_HASH, {
      rpcLegs: [
        leg('operator-a', { heads: ['0x6f', '0x69'] }),
        leg('operator-b', { heads: ['0x6f', '0x69'] }),
      ],
    })).rejects.toThrow('economic_finality_head_regressed_during_verification');
  });

  it('polls the exact primitive for live waits and never needs transaction.wait()', async () => {
    const result = await verifyBaseEconomicTransactionFinality(TX_HASH, {
      waitForConfirmations: true,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      rpcLegs: [
        leg('operator-a', { heads: ['0x6e', '0x6e', '0x6f', '0x6f'] }),
        leg('operator-b', { heads: ['0x6e', '0x6e', '0x6f', '0x6f'] }),
      ],
    });
    expect(result.evidence.confirmations).toBe(12);
  });

  it('rejects same-operator evidence and arithmetically inconsistent evidence', () => {
    const base = {
      schemaVersion: 'base-economic-finality/v1' as const,
      chainId: 8453 as const,
      transactionHash: TX_HASH,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      headBlockNumber: 111,
      confirmations: 12,
      providerOperatorIds: ['operator-a', 'operator-b'] as const,
      observedAtMs: 1,
    };
    expect(() => assertBaseEconomicFinalityEvidence({
      ...base,
      providerOperatorIds: ['same-operator', 'same-operator'],
    })).toThrow('base_economic_finality_evidence_invalid');
    expect(() => assertBaseEconomicFinalityEvidence({
      ...base,
      headBlockNumber: 110,
    })).toThrow('base_economic_finality_evidence_invalid');
    expect(() => assertBaseEconomicFinalityEvidence({
      ...base,
      unexpected: true,
    } as typeof base)).toThrow('base_economic_finality_evidence_invalid');
  });
});
