import { ethers } from 'ethers';

import {
  assertBaseEconomicStateSnapshot,
  computeCombinedCapThreshold,
  hashBaseEconomicStateSnapshot,
  isBatchMintedAtOrBeforeAgreedHead,
  readBaseEconomicStateSnapshot,
  restrictiveCurrentEpochMinted,
  type EconomicStateRpcLeg,
} from './economic-state';

const PVT = '0x0000000000000000000000000000000000001000';
const REGISTRY = '0x0000000000000000000000000000000000002000';
const BENEFICIARY = '0x0000000000000000000000000000000000003000';
const BATCH = `0x${'a'.repeat(64)}`;
const OTHER_BATCH = `0x${'9'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const HEAD_HASH = `0x${'c'.repeat(64)}`;
const REPLACEMENT_HEAD_HASH = `0x${'d'.repeat(64)}`;
const UNIT = 10n ** 18n;

const pvt = new ethers.Interface([
  'function circuitBreakerTripped() view returns (bool)',
  'function currentEpoch() view returns (uint256)',
  'function currentEpochMinted() view returns (uint256)',
  'function epochMintHistory(uint256) view returns (uint256)',
  'function GENESIS_EPOCH_HARD_CAP() view returns (uint256)',
  'function effectiveMintRate() view returns (uint256)',
  'function stakeRatioBps() view returns (uint256)',
  'function getCurrentAgentFoundationBPS() view returns (uint256)',
  'function peWeights(bytes32) view returns (uint256)',
  'function registry() view returns (address)',
  'function batchMinted(bytes32) view returns (bool)',
  'function epochDuration() view returns (uint256)',
  'function epochs(uint256) view returns (uint256 startTime)',
  'event BatchMinted(bytes32 indexed batchId,uint256 indexed epoch,uint256 totalMinted,uint256 contributorTotal,uint256 provianShare,uint256 foundationShare,bytes32 merkleRoot,uint256 effectiveMintRate,uint256 supplyScaler,uint256 humanSharePortion,uint256 agentSharePortion)',
  'event EpochAdvanced(uint256 indexed epoch,uint256 startTime,uint256 previousEpochMinted)',
  'event CompositionScheduleUpdated()',
]);
const registry = new ethers.Interface([
  'function isHumanBeneficiaryChain(address wallet) view returns (bool)',
]);

interface LegOverrides {
  readonly head?: bigint;
  readonly minted?: bigint;
  readonly batchMinted?: boolean;
  readonly effectiveRate?: bigint;
  readonly foundationBps?: bigint;
  readonly zeroHashWeight?: bigint;
  readonly failMethod?: string;
  readonly headHash?: string;
  readonly finalizedHash?: string;
  readonly blockHashAt?: (blockNumber: bigint) => string;
  readonly blockTimestampAt?: (blockNumber: bigint) => string;
  readonly pvtLogs?: readonly unknown[];
  readonly registryLogs?: readonly unknown[];
}

function rpcLeg(operatorId: string, overrides: LegOverrides = {}): {
  leg: EconomicStateRpcLeg;
  calls: Array<{ method: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ method: string; params: readonly unknown[] }> = [];
  const leg: EconomicStateRpcLeg = {
    operatorId,
    send: async (method, params) => {
      calls.push({ method, params });
      if (overrides.failMethod === method) throw new Error(`${operatorId}:${method}:failed`);
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_blockNumber') return ethers.toQuantity(overrides.head ?? 100n);
      if (method === 'eth_getBlockByNumber') {
        const requested = BigInt(params[0] as string);
        const head = overrides.head ?? 100n;
        const finalized = head - 11n;
        return {
          number: params[0],
          hash: overrides.blockHashAt?.(requested)
            ?? (requested === head
              ? overrides.headHash ?? HEAD_HASH
              : requested === finalized
                ? overrides.finalizedHash ?? BLOCK_HASH
                : BLOCK_HASH),
          timestamp: overrides.blockTimestampAt?.(requested) ?? (requested === head ? '0x3e8' : '0x384'),
        };
      }
      if (method === 'eth_getLogs') {
        const filter = params[0] as { address?: string };
        return filter.address?.toLowerCase() === PVT.toLowerCase()
          ? [...(overrides.pvtLogs ?? [])]
          : [...(overrides.registryLogs ?? [])];
      }
      if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
      const request = params[0] as { to: string; data: string };
      if (request.to.toLowerCase() === REGISTRY.toLowerCase()) {
        const parsed = registry.parseTransaction({ data: request.data });
        if (parsed?.name !== 'isHumanBeneficiaryChain') throw new Error('unexpected registry call');
        return registry.encodeFunctionResult(parsed.name, [true]);
      }
      const parsed = pvt.parseTransaction({ data: request.data });
      if (!parsed) throw new Error('unparseable PVT call');
      const values: Record<string, readonly unknown[]> = {
        circuitBreakerTripped: [false],
        currentEpoch: [0n],
        currentEpochMinted: [overrides.minted ?? 1n * UNIT],
        GENESIS_EPOCH_HARD_CAP: [10_000_000n * UNIT],
        effectiveMintRate: [overrides.effectiveRate ?? UNIT],
        stakeRatioBps: [10_000n],
        getCurrentAgentFoundationBPS: [overrides.foundationBps ?? 50n],
        peWeights: [overrides.zeroHashWeight ?? 0n],
        registry: [REGISTRY],
        batchMinted: [overrides.batchMinted ?? false],
        epochDuration: [604_800n],
        epochs: [1n],
        epochMintHistory: [0n],
      };
      return pvt.encodeFunctionResult(parsed.name, values[parsed.name]);
    },
  };
  return { leg, calls };
}

describe('operator-bound exact-block economic state', () => {
  it('uses one agreed EIP-1898 block hash for every economic call and returns a committed snapshot', async () => {
    const left = rpcLeg('operator-a');
    const right = rpcLeg('operator-b');
    const snapshot = await readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      beneficiaryAddresses: [BENEFICIARY],
      now: () => 123,
      rpcLegs: [left.leg, right.leg],
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 'base-economic-state/v2',
      blockNumber: 89,
      blockHash: BLOCK_HASH,
      blockTimestamp: 900,
      agreedHeadBlockNumber: 100,
      agreedHeadBlockHash: HEAD_HASH,
      agreedHeadBlockTimestamp: 1000,
      confirmationDepth: 12,
      providerOperatorIds: ['operator-a', 'operator-b'],
      batchId: BATCH,
      batchMinted: false,
      observedAtMs: 123,
      zeroHashPeWeightBps: 10_000n,
      canonicalityEvidence: {
        schemaVersion: 'base-economic-state-canonicality/v1',
        finalizedBlockRecheckedAfterCalls: true,
        agreedHeadRecheckedAfterTipReads: true,
        eip1898BlockHash: BLOCK_HASH,
        eip1898RequireCanonical: true,
      },
      restrictiveTipEvidence: {
        schemaVersion: 'base-economic-state-tip-restriction/v1',
        fromBlockNumber: 90,
        throughBlockNumber: 100,
        throughBlockHash: HEAD_HASH,
        batchMintedTotalAtomic: 0n,
        observedCurrentEpochMinted: 1n * UNIT,
        requestedBatchMinted: false,
        pvtEconomicLogCount: 0,
        registryLogCount: 0,
        onlyRestrictive: true,
      },
    });
    expect(snapshot.humanBeneficiaryClassifications).toEqual([
      { address: BENEFICIARY, isHuman: true },
    ]);
    expect(computeCombinedCapThreshold(snapshot)).toBe(10_000_000n * UNIT);
    for (const call of [...left.calls, ...right.calls].filter((item) => item.method === 'eth_call')) {
      expect(call.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    }
  });

  it('sets the actual post-flat combined cap to zero for twelve zero epochs', async () => {
    const left = rpcLeg('operator-a');
    const right = rpcLeg('operator-b');
    const snapshot = await readBaseEconomicStateSnapshot(PVT, {
      beneficiaryAddresses: [BENEFICIARY],
      rpcLegs: [left.leg, right.leg],
    });
    const { snapshotHash: _snapshotHash, ...base } = snapshot;
    const zeroHistory = {
      ...base,
      currentEpoch: 12n,
      epochMintHistory: Array.from({ length: 12 }, () => 0n),
    };
    expect(computeCombinedCapThreshold({
      ...zeroHistory,
      snapshotHash: hashBaseEconomicStateSnapshot(zeroHistory),
    })).toBe(0n);
  });

  it('rejects unknown fields in every authenticated snapshot layer', async () => {
    const left = rpcLeg('operator-a');
    const right = rpcLeg('operator-b');
    const snapshot = await readBaseEconomicStateSnapshot(PVT, {
      beneficiaryAddresses: [BENEFICIARY],
      rpcLegs: [left.leg, right.leg],
    });
    const mutations = [
      { ...snapshot, unexpected: true },
      {
        ...snapshot,
        canonicalityEvidence: { ...snapshot.canonicalityEvidence, unexpected: true },
      },
      {
        ...snapshot,
        restrictiveTipEvidence: { ...snapshot.restrictiveTipEvidence, unexpected: true },
      },
      {
        ...snapshot,
        humanBeneficiaryClassifications: [
          { ...snapshot.humanBeneficiaryClassifications[0], unexpected: true },
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(() => assertBaseEconomicStateSnapshot(
        mutation as unknown as Parameters<typeof assertBaseEconomicStateSnapshot>[0],
      )).toThrow('base_economic_state_snapshot_invalid');
    }
  });

  it('requires H-11 header agreement and rejects a mismatched finalized hash', async () => {
    const left = rpcLeg('operator-a', { finalizedHash: BLOCK_HASH });
    const right = rpcLeg('operator-b', { finalizedHash: REPLACEMENT_HEAD_HASH });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_rpc_disagreement:finalized_block_header');
  });

  function shallowBatchMintedLog(args: {
    batchId: string;
    totalMinted: bigint;
    humanSharePortion: bigint;
    agentSharePortion: bigint;
    epoch?: bigint;
    logIndex?: number;
    transactionNibble?: string;
  }) {
    const event = pvt.getEvent('BatchMinted');
    if (!event) throw new Error('BatchMinted event missing');
    const encoded = pvt.encodeEventLog(event, [
      args.batchId,
      args.epoch ?? 0n,
      args.totalMinted,
      (args.totalMinted * 99n) / 100n,
      args.totalMinted / 200n,
      args.totalMinted / 200n,
      `0x${'e'.repeat(64)}`,
      UNIT,
      UNIT,
      args.humanSharePortion,
      args.agentSharePortion,
    ]);
    return {
      address: PVT,
      blockNumber: '0x5f',
      blockHash: `0x${'f'.repeat(64)}`,
      transactionHash: `0x${(args.transactionNibble ?? '1').repeat(64)}`,
      logIndex: ethers.toQuantity(args.logIndex ?? 0),
      topics: encoded.topics,
      data: encoded.data,
      removed: false,
    };
  }

  it('treats a human-heavy shallow BatchMinted that lowers the agent Foundation rate as deny/defer', async () => {
    const tipLog = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 9_000_000n * UNIT,
      humanSharePortion: 8_900_000n * UNIT,
      agentSharePortion: 100_000n * UNIT,
    });
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');
  });

  it('treats an agent-heavy shallow BatchMinted as deny/defer in the other composition direction', async () => {
    const tipLog = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 9_000_000n * UNIT,
      humanSharePortion: 100_000n * UNIT,
      agentSharePortion: 8_900_000n * UNIT,
      transactionNibble: '2',
    });
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');
  });

  it('does not let an exact requested batch conceal a later human-heavy unrelated batch', async () => {
    const exact = shallowBatchMintedLog({
      batchId: BATCH,
      totalMinted: 1n,
      humanSharePortion: 0n,
      agentSharePortion: 1n,
      epoch: 0n,
      logIndex: 0,
      transactionNibble: '5',
    });
    const unrelated = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 9_000_000n * UNIT,
      humanSharePortion: 8_999_999n * UNIT,
      agentSharePortion: 1n * UNIT,
      epoch: 99n,
      logIndex: 1,
      transactionNibble: '6',
    });
    const left = rpcLeg('operator-a', { pvtLogs: [exact, unrelated] });
    const right = rpcLeg('operator-b', { pvtLogs: [exact, unrelated] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');
  });

  it('does not let a later exact batch conceal an earlier agent-heavy unrelated batch', async () => {
    const unrelated = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 1n,
      humanSharePortion: 0n,
      agentSharePortion: 1n,
      epoch: 77n,
      logIndex: 0,
      transactionNibble: '7',
    });
    const exact = shallowBatchMintedLog({
      batchId: BATCH,
      totalMinted: 5_000_000n * UNIT,
      humanSharePortion: 5_000_000n * UNIT,
      agentSharePortion: 0n,
      epoch: 0n,
      logIndex: 1,
      transactionNibble: '8',
    });
    const left = rpcLeg('operator-a', { pvtLogs: [unrelated, exact] });
    const right = rpcLeg('operator-b', { pvtLogs: [unrelated, exact] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');
  });

  it('blocks an unrelated shallow batch even when no requested batch id is supplied', async () => {
    const tipLog = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 1n * UNIT,
      humanSharePortion: 1n * UNIT,
      agentSharePortion: 0n,
      transactionNibble: '3',
    });
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');
  });

  it('exposes only the exact requested shallow batch for recovery and never for replay or capacity expansion', async () => {
    const tipLog = shallowBatchMintedLog({
      batchId: BATCH,
      totalMinted: 9_000_000n * UNIT,
      humanSharePortion: 0n,
      agentSharePortion: 9_000_000n * UNIT,
    });
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    const snapshot = await readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [left.leg, right.leg],
    });
    expect(snapshot.currentEpochMinted).toBe(1n * UNIT); // Finalized H-11 value.
    expect(restrictiveCurrentEpochMinted(snapshot)).toBe(1n * UNIT);
    expect(isBatchMintedAtOrBeforeAgreedHead(snapshot)).toBe(true);
    expect(snapshot.restrictiveTipEvidence).toMatchObject({
      batchMintedTotalAtomic: 9_000_000n * UNIT,
      requestedBatchMinted: true,
      onlyRestrictive: true,
    });
  });

  it('authorizes only after the shallow batch becomes finalized and composition economics are reread', async () => {
    const shallow = shallowBatchMintedLog({
      batchId: OTHER_BATCH,
      totalMinted: 5n * UNIT,
      humanSharePortion: 5n * UNIT,
      agentSharePortion: 0n,
      transactionNibble: '4',
    });
    const shallowLeft = rpcLeg('operator-a', { pvtLogs: [shallow] });
    const shallowRight = rpcLeg('operator-b', { pvtLogs: [shallow] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [shallowLeft.leg, shallowRight.leg],
    })).rejects.toThrow('economic_state_unfinalized_batch_minted_detected');

    const finalizedLeft = rpcLeg('operator-a', {
      head: 111n,
      minted: 6n * UNIT,
      foundationBps: 60n,
    });
    const finalizedRight = rpcLeg('operator-b', {
      head: 111n,
      minted: 6n * UNIT,
      foundationBps: 60n,
    });
    const finalized = await readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [finalizedLeft.leg, finalizedRight.leg],
    });
    expect(finalized.currentEpochMinted).toBe(6n * UNIT);
    expect(finalized.currentAgentFoundationBps).toBe(60n);
    expect(finalized.restrictiveTipEvidence.pvtEconomicLogCount).toBe(0);
    expect(isBatchMintedAtOrBeforeAgreedHead(finalized)).toBe(false);
  });

  it('denies a shallow epoch mutation instead of using it as permissive authority', async () => {
    const event = pvt.getEvent('EpochAdvanced');
    if (!event) throw new Error('EpochAdvanced event missing');
    const encoded = pvt.encodeEventLog(event, [1n, 1_001n, 1n * UNIT]);
    const tipLog = {
      address: PVT,
      blockNumber: '0x5f',
      blockHash: `0x${'f'.repeat(64)}`,
      transactionHash: `0x${'1'.repeat(64)}`,
      logIndex: '0x0',
      topics: encoded.topics,
      data: encoded.data,
      removed: false,
    };
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_unfinalized_mutation_detected:EpochAdvanced');
  });

  it('denies a shallow composition-policy mutation that could change beneficiary economics', async () => {
    const event = pvt.getEvent('CompositionScheduleUpdated');
    if (!event) throw new Error('CompositionScheduleUpdated event missing');
    const encoded = pvt.encodeEventLog(event, []);
    const tipLog = {
      address: PVT,
      blockNumber: '0x5f',
      blockHash: `0x${'f'.repeat(64)}`,
      transactionHash: `0x${'2'.repeat(64)}`,
      logIndex: '0x0',
      topics: encoded.topics,
      data: encoded.data,
      removed: false,
    };
    const left = rpcLeg('operator-a', { pvtLogs: [tipLog] });
    const right = rpcLeg('operator-b', { pvtLogs: [tipLog] });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow(
      'economic_state_unfinalized_mutation_detected:CompositionScheduleUpdated',
    );
  });

  it('rejects a finalized block replacement detected after the exact-hash calls', async () => {
    let leftFinalizedReads = 0;
    let rightFinalizedReads = 0;
    const blockHashAt = (count: () => number) => (blockNumber: bigint) => {
      if (blockNumber !== 89n) return blockNumber === 100n ? HEAD_HASH : BLOCK_HASH;
      return count() === 1 ? BLOCK_HASH : REPLACEMENT_HEAD_HASH;
    };
    const left = rpcLeg('operator-a', {
      blockHashAt: blockHashAt(() => ++leftFinalizedReads),
    });
    const right = rpcLeg('operator-b', {
      blockHashAt: blockHashAt(() => ++rightFinalizedReads),
    });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_finalized_block_not_canonical');
  });

  it('allows head advancement only while a required prior head remains canonical', async () => {
    const canonicalAt100 = (blockNumber: bigint) =>
      blockNumber === 100n ? HEAD_HASH : BLOCK_HASH;
    const left = rpcLeg('operator-a', { head: 101n, blockHashAt: canonicalAt100 });
    const right = rpcLeg('operator-b', { head: 101n, blockHashAt: canonicalAt100 });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      requiredCanonicalHead: { blockNumber: 100, blockHash: HEAD_HASH },
      rpcLegs: [left.leg, right.leg],
    })).resolves.toMatchObject({ agreedHeadBlockNumber: 101, blockNumber: 90 });

    const replacedAt100 = (blockNumber: bigint) =>
      blockNumber === 100n ? REPLACEMENT_HEAD_HASH : BLOCK_HASH;
    const replacedLeft = rpcLeg('operator-a', { head: 101n, blockHashAt: replacedAt100 });
    const replacedRight = rpcLeg('operator-b', { head: 101n, blockHashAt: replacedAt100 });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      requiredCanonicalHead: { blockNumber: 100, blockHash: HEAD_HASH },
      rpcLegs: [replacedLeft.leg, replacedRight.leg],
    })).rejects.toThrow('economic_state_required_head_not_canonical');
  });

  it('rejects one compromised provider forging the minted counter', async () => {
    const honest = rpcLeg('operator-a', { minted: 9_000_000n * UNIT });
    const forged = rpcLeg('operator-b', { minted: 0n });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      batchId: BATCH,
      rpcLegs: [honest.leg, forged.leg],
    })).rejects.toThrow('economic_state_rpc_disagreement:currentEpochMinted');
  });

  it('rejects different canonical hashes at the common provider height', async () => {
    const current = rpcLeg('operator-a', { head: 100n });
    const stale = rpcLeg('operator-b', { head: 99n });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [current.leg, stale.leg],
    })).rejects.toThrow('economic_state_rpc_disagreement:head');
  });

  it('keeps the same twelve-deep economic snapshot when one canonical provider tip is ahead', async () => {
    const history = { blockHashAt: (height: bigint) => ethers.zeroPadValue(ethers.toBeHex(height), 32),
      blockTimestampAt: (height: bigint) => ethers.toQuantity(900n + height) };
    const current = rpcLeg('operator-a', { ...history, head: 100n });
    const behind = rpcLeg('operator-b', { ...history, head: 99n });
    const mixed = await readBaseEconomicStateSnapshot(PVT, { rpcLegs: [current.leg, behind.leg], now: () => 123 });
    const aligned = await readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [rpcLeg('operator-a', { ...history, head: 99n }).leg, rpcLeg('operator-b', { ...history, head: 99n }).leg], now: () => 123,
    });
    expect(mixed).toEqual(aligned);
    expect(mixed).toMatchObject({ agreedHeadBlockNumber: 99, blockNumber: 88, confirmationDepth: 12 });
  });

  it('rejects a forged effective rate and an unavailable leg', async () => {
    const honest = rpcLeg('operator-a');
    const forged = rpcLeg('operator-b', { effectiveRate: 2n * UNIT });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [honest.leg, forged.leg],
    })).rejects.toThrow('economic_state_rpc_disagreement:effectiveMintRate');

    const failed = rpcLeg('operator-b', { failMethod: 'eth_call' });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [honest.leg, failed.leg],
    })).rejects.toThrow('operator-b:eth_call:failed');
  });

  it('binds the ZeroHash PE weight and rejects one forged weight', async () => {
    const honest = rpcLeg('operator-a', { zeroHashWeight: 10_000n });
    const forged = rpcLeg('operator-b', { zeroHashWeight: 30_000n });
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [honest.leg, forged.leg],
    })).rejects.toThrow('economic_state_rpc_disagreement:peWeights');
  });

  it('rejects equal operator identities even when both endpoints agree', async () => {
    const left = rpcLeg('same-operator');
    const right = rpcLeg('same-operator');
    await expect(readBaseEconomicStateSnapshot(PVT, {
      rpcLegs: [left.leg, right.leg],
    })).rejects.toThrow('economic_state_rpc_operators_not_independent');
  });
});
