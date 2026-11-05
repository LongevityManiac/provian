/**
 * Epoch keeper pure-helper tests: the readiness gate (mirror of the on-chain
 * EpochNotReady time check) and the revert detector (swallow EpochNotReady as a
 * benign race after the pre-check).
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, it, expect, jest } from '@jest/globals';
import {
  hashBaseEconomicStateSnapshot,
  type BaseEconomicStateSnapshot,
} from '../onchain/economic-state';
import type { PreparedEconomicTransaction } from '../onchain/prepared-economic-transaction';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  MINT_EPOCH_CAPACITY_COLLECTION,
  acquireMintWorkerLease,
} from './mint-worker-coordination';
import {
  advanceEpochWithFinality,
  EPOCH_ADVANCEMENT_COLLECTION,
  EPOCH_KEEPER_ABI,
  EPOCH_KEEPER_STATE_COLLECTION,
  EPOCH_KEEPER_STATE_ID,
  type EpochKeeperDeps,
  isEpochAdvanceReady,
  isEpochNotReadyError,
  EPOCH_NOT_READY_SELECTOR,
} from './epoch-keeper';

const PVT_ADDRESS = '0x000000000000000000000000000000000000aaaa';
const WRONG_ADDRESS = '0x000000000000000000000000000000000000bbbb';
const BLOCK_HASH = `0x${crypto.createHash('sha256').update('epoch-block').digest('hex')}`;
const EPOCH_INTERFACE = new ethers.Interface(EPOCH_KEEPER_ABI);

function preparedEpochTransaction(
  data = EPOCH_INTERFACE.encodeFunctionData('advanceEpoch', []),
  to = PVT_ADDRESS,
  value = 0n,
): PreparedEconomicTransaction {
  const wallet = new ethers.Wallet(`0x${'1'.repeat(64)}`);
  const tx = ethers.Transaction.from({
    type: 0,
    chainId: 8453,
    nonce: 7,
    gasPrice: 1n,
    gasLimit: 100_000n,
    to,
    value,
    data,
  });
  tx.signature = wallet.signingKey.sign(tx.unsignedHash);
  return {
    schemaVersion: 'prepared-base-economic-transaction/v1',
    transactionHash: tx.hash!,
    rawTransaction: tx.serialized,
    nonce: tx.nonce,
    to: tx.to!,
    dataHash: ethers.keccak256(tx.data),
    chainId: 8453,
  };
}

const PREPARED_EPOCH = preparedEpochTransaction();
const TX_HASH = PREPARED_EPOCH.transactionHash;
type EpochBroadcaster = NonNullable<EpochKeeperDeps['economicTransactionBroadcaster']>;

function state(ready = true): BaseEconomicStateSnapshot {
  const withoutHash: Omit<BaseEconomicStateSnapshot, 'snapshotHash'> = {
    schemaVersion: 'base-economic-state/v2',
    chainId: 8453,
    contractAddress: PVT_ADDRESS,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    blockTimestamp: ready ? 700 : 599,
    agreedHeadBlockNumber: 111,
    agreedHeadBlockHash: `0x${'c'.repeat(64)}`,
    agreedHeadBlockTimestamp: ready ? 711 : 610,
    confirmationDepth: 12,
    providerOperatorIds: ['operator-a', 'operator-b'],
    canonicalityEvidence: Object.freeze({
      schemaVersion: 'base-economic-state-canonicality/v1',
      finalizedBlockRecheckedAfterCalls: true,
      agreedHeadRecheckedAfterTipReads: true,
      eip1898BlockHash: BLOCK_HASH,
      eip1898RequireCanonical: true,
    }),
    restrictiveTipEvidence: Object.freeze({
      schemaVersion: 'base-economic-state-tip-restriction/v1',
      fromBlockNumber: 101,
      throughBlockNumber: 111,
      throughBlockHash: `0x${'c'.repeat(64)}`,
      batchMintedTotalAtomic: 0n,
      observedCurrentEpochMinted: 5n,
      requestedBatchMinted: null,
      pvtEconomicLogCount: 0,
      registryLogCount: 0,
      onlyRestrictive: true,
    }),
    circuitBreakerTripped: false,
    currentEpoch: 7n,
    currentEpochMinted: 5n,
    epochMintHistory: Object.freeze(Array.from({ length: 12 }, () => 0n)),
    genesisEpochHardCap: 10_000_000n * 10n ** 18n,
    effectiveMintRate: 10n ** 18n,
    stakeRatioBps: 10_000n,
    currentAgentFoundationBps: 50n,
    zeroHashPeWeightBps: 10_000n,
    registryAddress: '0x000000000000000000000000000000000000bbbb',
    epochDuration: 500n,
    currentEpochStartTime: 100n,
    batchId: null,
    batchMinted: null,
    humanBeneficiaryClassifications: Object.freeze([]),
    observedAtMs: 1,
  };
  return Object.freeze({
    ...withoutHash,
    snapshotHash: hashBaseEconomicStateSnapshot(withoutHash),
  });
}

function finality(confirmations = 12, toEpoch = 8) {
  const contract = new ethers.Contract(PVT_ADDRESS, EPOCH_KEEPER_ABI);
  const event = contract.interface.getEvent('EpochAdvanced')!;
  const encoded = contract.interface.encodeEventLog(event, [toEpoch, 700n, 5n]);
  return {
    receipt: {
      hash: TX_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: 100,
      status: 1,
      to: PVT_ADDRESS,
      logs: [{ address: PVT_ADDRESS, topics: encoded.topics, data: encoded.data }],
      confirmations: async () => confirmations,
    } as unknown as ethers.TransactionReceipt,
    evidence: {
      schemaVersion: 'base-economic-finality/v1' as const,
      chainId: 8453 as const,
      transactionHash: TX_HASH,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      headBlockNumber: 100 + confirmations - 1,
      confirmations,
      providerOperatorIds: ['operator-a', 'operator-b'] as const,
      observedAtMs: 2,
    },
  };
}

function serviceDeps(options: {
  ready?: boolean;
  verify?: NonNullable<EpochKeeperDeps['verifyEconomicFinality']>;
  advance?: jest.Mock;
  prepare?: EpochBroadcaster['prepare'];
  broadcast?: EpochBroadcaster['broadcast'];
  readEconomicState?: NonNullable<EpochKeeperDeps['readEconomicState']>;
  afterPreparedPersisted?: () => Promise<void>;
  now?: () => number;
  leaseTtlMs?: number;
} = {}) {
  const fake = createFakeFirestore();
  const waitTripwire = jest.fn(() => {
    throw new Error('default wait must never be called');
  });
  const advance = options.advance ?? jest.fn(async () => ({ hash: TX_HASH, wait: waitTripwire }));
  const prepare = options.prepare ?? jest.fn<EpochBroadcaster['prepare']>(async () => PREPARED_EPOCH);
  const broadcast = options.broadcast ?? jest.fn<EpochBroadcaster['broadcast']>(async () => undefined);
  const verify: NonNullable<EpochKeeperDeps['verifyEconomicFinality']> =
    options.verify ?? jest.fn(async () => finality());
  const contract = new ethers.Contract(PVT_ADDRESS, EPOCH_KEEPER_ABI);
  return {
    fake,
    waitTripwire,
    advance,
    prepare,
    broadcast,
    verify,
    deps: {
      db: fake as unknown as Firestore,
      pvtContract: {
        getAddress: async () => PVT_ADDRESS,
        interface: contract.interface,
        advanceEpoch: advance,
      } as unknown as ethers.Contract,
      readEconomicState: options.readEconomicState
        ?? jest.fn(async () => state(options.ready ?? true)),
      verifyEconomicFinality: verify,
      economicTransactionBroadcaster: { prepare, broadcast },
      leaseOwnerId: 'epoch-keeper-test',
      leaseTtlMs: options.leaseTtlMs,
      afterPreparedPersisted: options.afterPreparedPersisted,
      now: options.now ?? (() => 10),
    } satisfies EpochKeeperDeps,
  };
}

describe('isEpochAdvanceReady', () => {
  const start = 1_782_529_711n; // epoch 0 startTime (live)
  const dur = 604_800n; // 7 days
  const readyAt = start + dur;

  it('false strictly before the window elapses', () => {
    expect(isEpochAdvanceReady(start, dur, readyAt - 1n)).toBe(false);
    expect(isEpochAdvanceReady(start, dur, start)).toBe(false);
  });
  it('true exactly at and after startTime + epochDuration (mirrors the >= gate)', () => {
    expect(isEpochAdvanceReady(start, dur, readyAt)).toBe(true);
    expect(isEpochAdvanceReady(start, dur, readyAt + 100_000n)).toBe(true);
  });
  it('matches the live-state observation (epoch 0 was ready on 2026-07-05)', () => {
    // chain `now` at the time of investigation
    expect(isEpochAdvanceReady(start, dur, 1_783_292_345n)).toBe(true);
  });
});

describe('EPOCH_NOT_READY_SELECTOR', () => {
  it('is the 4-byte selector of EpochNotReady()', () => {
    expect(EPOCH_NOT_READY_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe('isEpochNotReadyError', () => {
  const sel = EPOCH_NOT_READY_SELECTOR;

  it('detects the ethers v6 decoded custom-error name', () => {
    expect(isEpochNotReadyError({ revert: { name: 'EpochNotReady' } })).toBe(true);
  });
  it('detects the raw revert selector in the several shapes ethers surfaces it', () => {
    expect(isEpochNotReadyError({ data: sel })).toBe(true);
    expect(isEpochNotReadyError({ data: sel + '00' })).toBe(true); // selector + padding
    expect(isEpochNotReadyError({ info: { error: { data: sel } } })).toBe(true);
    expect(isEpochNotReadyError({ error: { data: sel } })).toBe(true);
    expect(isEpochNotReadyError({ data: sel.toUpperCase() })).toBe(true); // case-insensitive
  });
  it('detects it from the error text as a last resort', () => {
    expect(isEpochNotReadyError(new Error('execution reverted: EpochNotReady()'))).toBe(true);
    expect(isEpochNotReadyError({ shortMessage: 'reverted with custom error EpochNotReady()' })).toBe(true);
  });
  it('does NOT match unrelated reverts/errors (a real failure must surface)', () => {
    expect(isEpochNotReadyError(new Error('nonce too low'))).toBe(false);
    expect(isEpochNotReadyError({ revert: { name: 'CircuitBreakerActive' } })).toBe(false);
    expect(isEpochNotReadyError({ data: '0xdeadbeef' })).toBe(false);
    expect(isEpochNotReadyError(undefined)).toBe(false);
    expect(isEpochNotReadyError(null)).toBe(false);
  });
});

describe('durable epoch advancement finality', () => {
  it('does not prepare while the shared mutation lease or mint capacity is occupied', async () => {
    const busy = serviceDeps();
    await acquireMintWorkerLease(busy.deps.db, {
      ownerId: 'mint-worker-busy',
      now: 10,
      ttlMs: 100,
    });
    await expect(advanceEpochWithFinality(busy.deps)).resolves.toEqual({
      status: 'economic_mutation_lease_busy',
    });
    expect(busy.prepare).not.toHaveBeenCalled();

    const pending = serviceDeps();
    pending.fake.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/7`, {
      schema_version: 'pvt-mint-epoch-capacity/v1',
      epoch: 7,
      threshold_atomic: '10000000',
      safety_bps: 9_500,
      last_observed_onchain_atomic: '0',
      pending_reserved_atomic: '1',
      committed_atomic: '0',
      last_observed_block_number: 100,
      last_observed_block_hash: BLOCK_HASH,
      last_observed_snapshot_hash: `0x${'d'.repeat(64)}`,
      revision: 1,
      cap_breach_detected: false,
      updated_at_ms: 1,
    });
    await expect(advanceEpochWithFinality(pending.deps)).resolves.toEqual({
      status: 'mint_state_pending',
      outstandingClaims: 0,
    });
    expect(pending.prepare).not.toHaveBeenCalled();
  });

  it('does not broadcast before the exact-block readiness boundary', async () => {
    const built = serviceDeps({ ready: false });
    await expect(advanceEpochWithFinality(built.deps)).resolves.toMatchObject({
      status: 'not_ready',
      fromEpoch: 7,
    });
    expect(built.advance).not.toHaveBeenCalled();
    expect(built.prepare).not.toHaveBeenCalled();
  });

  it('persists the exact broadcast hash and never calls transaction.wait()', async () => {
    const verify = jest.fn(async () => {
      throw new Error('economic_finality_confirmations_pending:1/12');
    });
    const built = serviceDeps({ verify });
    await expect(advanceEpochWithFinality(built.deps)).resolves.toEqual({
      status: 'pending_finality',
      fromEpoch: 7,
      transactionHash: TX_HASH,
    });
    expect(built.waitTripwire).not.toHaveBeenCalled();
    expect(built.advance).not.toHaveBeenCalled();
    expect(built.prepare).toHaveBeenCalledTimes(1);
    expect(built.broadcast).toHaveBeenCalledTimes(1);
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({ state: 'broadcast', pending_from_epoch: 7, pending_tx_hash: TX_HASH });
    expect(built.fake.store.get(`${EPOCH_ADVANCEMENT_COLLECTION}/7`))
      .toMatchObject({ state: 'broadcast', tx_hash: TX_HASH });
  });

  it('recovers the same hash after a crash following broadcast and finalizes once', async () => {
    const verify = jest.fn<NonNullable<EpochKeeperDeps['verifyEconomicFinality']>>()
      .mockRejectedValueOnce(new Error('process crashed after durable broadcast'))
      .mockResolvedValueOnce(finality());
    const built = serviceDeps({ verify });
    await expect(advanceEpochWithFinality(built.deps)).rejects.toThrow(
      'process crashed after durable broadcast',
    );
    await expect(advanceEpochWithFinality(built.deps)).resolves.toEqual({
      status: 'finalized',
      fromEpoch: 7,
      toEpoch: 8,
      transactionHash: TX_HASH,
      recovered: true,
    });
    expect(built.advance).not.toHaveBeenCalled();
    expect(built.prepare).toHaveBeenCalledTimes(1);
    expect(built.broadcast).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenNthCalledWith(2, TX_HASH, {
      expectedTo: PVT_ADDRESS,
      waitForConfirmations: false,
    });
    expect(built.fake.store.get(`${EPOCH_ADVANCEMENT_COLLECTION}/7`))
      .toMatchObject({ state: 'finalized', tx_hash: TX_HASH, to_epoch: 8 });
  });

  it('does not recovery-rebroadcast across a replaced admission head but still verifies exact finality', async () => {
    let replacementObserved = false;
    const readEconomicState = jest.fn<NonNullable<EpochKeeperDeps['readEconomicState']>>(
      async (_address, options) => {
        if (replacementObserved && options?.requiredCanonicalHead) {
          throw new Error('economic_state_required_head_reorg');
        }
        return state(true);
      },
    );
    const verify = jest.fn<NonNullable<EpochKeeperDeps['verifyEconomicFinality']>>()
      .mockRejectedValueOnce(new Error('process crashed after durable broadcast'))
      .mockResolvedValueOnce(finality());
    const built = serviceDeps({ verify, readEconomicState });
    await expect(advanceEpochWithFinality(built.deps)).rejects.toThrow(
      'process crashed after durable broadcast',
    );
    replacementObserved = true;
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(advanceEpochWithFinality(built.deps)).resolves.toMatchObject({
        status: 'finalized',
        recovered: true,
      });
      expect(built.broadcast).toHaveBeenCalledTimes(1);
      expect(readEconomicState).toHaveBeenLastCalledWith(PVT_ADDRESS, {
        requiredCanonicalHead: {
          blockNumber: 111,
          blockHash: `0x${'c'.repeat(64)}`,
        },
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('denied by economic head fence'),
        expect.objectContaining({ message: 'economic_state_required_head_reorg' }),
      );
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('does not first-broadcast prepared epoch bytes after the admission head is replaced', async () => {
    let replacementObserved = false;
    const readEconomicState = jest.fn<NonNullable<EpochKeeperDeps['readEconomicState']>>(
      async (_address, options) => {
        if (replacementObserved && options?.requiredCanonicalHead) {
          throw new Error('economic_state_required_head_reorg');
        }
        return state(true);
      },
    );
    const built = serviceDeps({
      readEconomicState,
      afterPreparedPersisted: async () => { replacementObserved = true; },
    });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('economic_state_required_head_reorg');
    expect(built.prepare).toHaveBeenCalledTimes(1);
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({ state: 'prepared', pending_tx_hash: TX_HASH });
  });

  it('recovers exact signed bytes after a crash between durable prepare and broadcast', async () => {
    let crash = true;
    const built = serviceDeps({
      afterPreparedPersisted: async () => {
        if (crash) {
          crash = false;
          throw new Error('crash_after_prepared_persist');
        }
      },
    });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('crash_after_prepared_persist');
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({
        state: 'prepared',
        pending_tx_hash: TX_HASH,
        pending_prepared_transaction: {
          rawTransaction: PREPARED_EPOCH.rawTransaction,
        },
      });
    await expect(advanceEpochWithFinality(built.deps)).resolves.toMatchObject({
      status: 'finalized',
      transactionHash: TX_HASH,
      recovered: true,
    });
    expect(built.prepare).toHaveBeenCalledTimes(1);
    expect(built.broadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawTransaction: PREPARED_EPOCH.rawTransaction }),
      expect.objectContaining({
        to: PVT_ADDRESS,
        data: EPOCH_INTERFACE.encodeFunctionData('advanceEpoch', []),
      }),
    );
  });

  it('rejects unknown durable keeper fields before recovery broadcast or finality', async () => {
    let crash = true;
    const built = serviceDeps({
      afterPreparedPersisted: async () => {
        if (crash) {
          crash = false;
          throw new Error('crash_before_keeper_schema_mutation');
        }
      },
    });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('crash_before_keeper_schema_mutation');
    const stateKey = `${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`;
    built.fake.store.set(stateKey, { ...built.fake.store.get(stateKey)!, unexpected: true });

    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('epoch_keeper_state_invalid');
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field', (row: Record<string, unknown>) => ({ ...row, unexpected: true })],
    ['same RPC operator', (row: Record<string, unknown>) => ({
      ...row,
      economic_state_operator_ids: ['operator-a', 'operator-a'],
    })],
    ['non-H-11 finalized block', (row: Record<string, unknown>) => ({
      ...row,
      economic_state_block_number: 99,
    })],
    ['different raw bytes', (row: Record<string, unknown>) => ({
      ...row,
      raw_transaction: preparedEpochTransaction(undefined, WRONG_ADDRESS).rawTransaction,
    })],
  ])('rejects a prepared advancement with %s before recovery broadcast', async (_label, mutate) => {
    let crash = true;
    const built = serviceDeps({
      afterPreparedPersisted: async () => {
        if (crash) {
          crash = false;
          throw new Error('crash_before_advancement_schema_mutation');
        }
      },
    });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('crash_before_advancement_schema_mutation');
    const advancementKey = `${EPOCH_ADVANCEMENT_COLLECTION}/7`;
    built.fake.store.set(advancementKey, mutate(built.fake.store.get(advancementKey)!));

    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('epoch_keeper_recovery_economic_fence_invalid');
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
  });

  it('an existing epoch advancement blocks before economic signing', async () => {
    const built = serviceDeps();
    built.fake.store.set(`${EPOCH_ADVANCEMENT_COLLECTION}/7`, { collision: true });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('epoch_advancement_id_collision');
    expect(built.prepare).not.toHaveBeenCalled();
    expect(built.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong calldata', preparedEpochTransaction('0x12345678')],
    ['nonzero transaction value', preparedEpochTransaction(undefined, PVT_ADDRESS, 1n)],
  ])('rejects durable epoch bytes with %s before a recovery rebroadcast', async (
    _label,
    unintended,
  ) => {
    let crash = true;
    const built = serviceDeps({
      afterPreparedPersisted: async () => {
        if (crash) {
          crash = false;
          throw new Error('crash_before_epoch_recovery_corruption');
        }
      },
    });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('crash_before_epoch_recovery_corruption');
    const stateKey = `${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`;
    built.fake.store.set(stateKey, {
      ...built.fake.store.get(stateKey)!,
      pending_tx_hash: unintended.transactionHash,
      pending_prepared_transaction: unintended,
    });

    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('prepared_economic_transaction_intent_mismatch');
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
    expect(built.fake.store.get(stateKey)).toMatchObject({
      state: 'prepared',
      pending_tx_hash: unintended.transactionHash,
    });
  });

  it('fences an expired keeper before broadcast and lets only the successor recover', async () => {
    let now = 10;
    let built: ReturnType<typeof serviceDeps>;
    built = serviceDeps({
      now: () => now,
      leaseTtlMs: 5,
      afterPreparedPersisted: async () => {
        now = 16;
        const successor = await acquireMintWorkerLease(built.deps.db, {
          ownerId: 'epoch-keeper-successor',
          now,
          ttlMs: 5,
        });
        expect(successor?.fencingToken).toBe(2);
      },
    });

    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toMatchObject({ code: 'mint_worker_lease_lost' });
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({
        state: 'prepared',
        lease_owner_id: 'epoch-keeper-test',
        lease_fencing_token: 1,
      });

    await expect(advanceEpochWithFinality({
      ...built.deps,
      leaseOwnerId: 'epoch-keeper-successor',
    })).resolves.toMatchObject({ status: 'finalized', recovered: true });
    expect(built.prepare).toHaveBeenCalledTimes(1);
    expect(built.broadcast).toHaveBeenCalledTimes(1);
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({ state: 'idle', lease_owner_id: null, lease_fencing_token: null });
  });

  it('fences an expired keeper during finality and prevents its stale commit', async () => {
    let now = 10;
    let built: ReturnType<typeof serviceDeps>;
    const verify = jest.fn<NonNullable<EpochKeeperDeps['verifyEconomicFinality']>>(async () => {
      if (verify.mock.calls.length === 1) {
        now = 16;
        const successor = await acquireMintWorkerLease(built.deps.db, {
          ownerId: 'epoch-finality-successor',
          now,
          ttlMs: 5,
        });
        expect(successor?.fencingToken).toBe(2);
      }
      return finality();
    });
    built = serviceDeps({ now: () => now, leaseTtlMs: 5, verify });

    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toMatchObject({ code: 'mint_worker_lease_lost' });
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({ state: 'broadcast', lease_fencing_token: 1 });
    expect(built.fake.store.get(`${EPOCH_ADVANCEMENT_COLLECTION}/7`))
      .toMatchObject({ state: 'broadcast' });

    await expect(advanceEpochWithFinality({
      ...built.deps,
      leaseOwnerId: 'epoch-finality-successor',
    })).resolves.toMatchObject({ status: 'finalized', recovered: true });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong selector', preparedEpochTransaction('0x12345678')],
    ['wrong target', preparedEpochTransaction(undefined, WRONG_ADDRESS)],
    ['nonzero transaction value', preparedEpochTransaction(undefined, PVT_ADDRESS, 1n)],
  ])('rejects a self-consistent signed %s before persistence or broadcast', async (
    _label,
    unintended,
  ) => {
    const built = serviceDeps({ prepare: jest.fn(async () => unintended) });
    await expect(advanceEpochWithFinality(built.deps))
      .rejects.toThrow('prepared_economic_transaction_intent_mismatch');
    expect(built.broadcast).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
    expect(built.fake.store.get(`${EPOCH_ADVANCEMENT_COLLECTION}/7`)).toBeUndefined();
    expect(built.fake.store.get(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`))
      .toMatchObject({ state: 'idle', pending_tx_hash: null });
  });

  it('fails closed on an in-flight state with no exact hash', async () => {
    const built = serviceDeps();
    built.fake.store.set(`${EPOCH_KEEPER_STATE_COLLECTION}/${EPOCH_KEEPER_STATE_ID}`, {
      schema_version: 'pvt-epoch-keeper-state/v1',
      state: 'uncertain_no_hash',
      pending_from_epoch: 7,
      pending_tx_hash: null,
      pending_prepared_transaction: null,
      lease_owner_id: null,
      lease_fencing_token: null,
      broadcast_protocol: null,
      prepared_at_ms: 1,
      broadcast_at_ms: null,
      last_finalized_from_epoch: null,
      last_finalized_tx_hash: null,
      updated_at_ms: 1,
    });
    await expect(advanceEpochWithFinality(built.deps)).resolves.toEqual({
      status: 'blocked_missing_hash',
      fromEpoch: 7,
    });
    expect(built.advance).not.toHaveBeenCalled();
    expect(built.prepare).not.toHaveBeenCalled();
    expect(built.verify).not.toHaveBeenCalled();
  });

  it('rejects 11-confirmation evidence and a mismatched epoch event', async () => {
    const eleven = serviceDeps({ verify: jest.fn(async () => finality(11)) });
    await expect(advanceEpochWithFinality(eleven.deps)).rejects.toThrow(
      'base_economic_finality_evidence_invalid',
    );
    expect(eleven.fake.store.get(`${EPOCH_ADVANCEMENT_COLLECTION}/7`))
      .toMatchObject({ state: 'broadcast', tx_hash: TX_HASH });

    const wrongEvent = serviceDeps({ verify: jest.fn(async () => finality(12, 9)) });
    await expect(advanceEpochWithFinality(wrongEvent.deps)).rejects.toThrow(
      'epoch_advanced_event_epoch_mismatch',
    );
  });
});
