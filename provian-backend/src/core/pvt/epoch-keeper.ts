/**
 * Epoch keeper - off-chain automation for the on-chain epoch clock.
 *
 * PVTv8 epochs are time-boxed windows with an IMMUTABLE `epochDuration` (7 days
 * on the live Base deployment). `advanceEpoch()` (onlyMinter) resets
 * `currentEpochMinted`, rolls the 12-slot mint-history ring, and increments
 * `currentEpoch` - but it reverts `EpochNotReady()` until the current window has
 * fully elapsed (`block.timestamp >= epochs[currentEpoch].startTime +
 * epochDuration`). Nothing else in the system called it, so epoch 0 never ended
 * and the per-epoch `GENESIS_EPOCH_HARD_CAP` (10M PVT) behaved as a cumulative
 * wall. This keeper advances each ready window so the cap is what it was designed
 * to be - a per-epoch THROTTLE, with total supply uncapped.
 *
 * It is called by a Cloud Scheduler job hitting POST
 * /v1/internal/scheduler/advance-epoch, is minter-EOA-signed (the SAME
 * `PVT_MINTER_KEY` the pvt-mint scheduler uses - no new key or role), and is
 * self-guarding: a read-side readiness pre-check avoids sending a doomed
 * (gas-wasting) tx on the common not-yet-ready run, and an `EpochNotReady`
 * revert on send (a race) is swallowed as a no-op. Safe to run hourly/daily; it
 * sends at most one cheap advance tx per 7-day window.
 *
 * NO contract change is involved. Changing the epoch cadence (a different
 * `epochDuration`) or fill-triggered early advancement WOULD require a contract
 * change: `epochDuration` is immutable and lives at the version/redeploy tier. If
 * mint volume ever approaches the per-window ceiling (~100k+ continuously-active
 * participants - far beyond current reality), that is the signal to spec a future
 * PVT version with different epoch params via the Pass-3 redeploy pattern.
 * Explicitly out of scope here.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import {
  assertBaseEconomicStateSnapshot,
  canonicalHeadGuardFromEconomicState,
  readBaseEconomicStateSnapshot,
  type BaseEconomicStateSnapshot,
  type ReadBaseEconomicStateOptions,
} from '../onchain/economic-state';
import {
  BASE_ECONOMIC_CHAIN_ID,
  assertBaseEconomicFinalityEvidence,
  verifyBaseEconomicTransactionFinality,
  type EconomicFinalityResult,
} from '../onchain/economic-finality';
import {
  DEFAULT_ECONOMIC_TRANSACTION_BROADCASTER,
  assertPreparedEconomicContractCall,
  assertPreparedEconomicTransaction,
  type ExpectedEconomicContractCall,
  type EconomicTransactionBroadcaster,
  type PreparedEconomicTransaction,
} from '../onchain/prepared-economic-transaction';
import {
  EPOCH_KEEPER_STATE_COLLECTION,
  EPOCH_KEEPER_STATE_ID,
} from './economic-transition-coordination';
import {
  DEFAULT_MINT_WORKER_LEASE_TTL_MS,
  MINT_WORKER_LEASE_COLLECTION,
  MINT_WORKER_LEASE_ID,
  acquireMintWorkerLease,
  assertMintWorkerLeaseCurrent,
  hasPendingMintEpochCapacity,
  listOutstandingMintBatchClaims,
  releaseMintWorkerLease,
  renewMintWorkerLease,
  type MintWorkerLease,
} from './mint-worker-coordination';

/**
 * Minimal ABI for the keeper: read the epoch clock + advance it, plus the
 * EpochNotReady custom-error definition so ethers can decode a revert by name.
 * Kept separate from PVT_V8_ABI so the keeper depends only on the exact surface
 * it uses (currentEpoch/epochDuration/epochs are view getters; advanceEpoch is
 * the only state-changing call).
 */
export const EPOCH_KEEPER_ABI = [
  'function currentEpoch() view returns (uint256)',
  'function epochDuration() view returns (uint256)',
  'function epochs(uint256) view returns (uint256 startTime)',
  'function advanceEpoch() external',
  'event EpochAdvanced(uint256 indexed epoch, uint256 startTime, uint256 previousEpochMinted)',
  'error EpochNotReady()',
] as const;
const EPOCH_KEEPER_INTERFACE = new ethers.Interface(EPOCH_KEEPER_ABI);

export { EPOCH_KEEPER_STATE_COLLECTION, EPOCH_KEEPER_STATE_ID } from './economic-transition-coordination';
export const EPOCH_ADVANCEMENT_COLLECTION = 'pvt_epoch_advancements_v1';

interface EpochKeeperStateDocument {
  readonly schema_version: 'pvt-epoch-keeper-state/v1';
  readonly state: 'idle' | 'preparing' | 'prepared' | 'broadcast' | 'uncertain_no_hash';
  readonly pending_from_epoch: number | null;
  readonly pending_tx_hash: string | null;
  readonly pending_prepared_transaction: PreparedEconomicTransaction | null;
  readonly lease_owner_id: string | null;
  readonly lease_fencing_token: number | null;
  readonly broadcast_protocol: 'prepersisted_signed_bytes/v1' | null;
  readonly prepared_at_ms: number | null;
  readonly broadcast_at_ms: number | null;
  readonly last_finalized_from_epoch: number | null;
  readonly last_finalized_tx_hash: string | null;
  readonly updated_at_ms: number;
}

const EPOCH_KEEPER_STATE_KEYS = Object.freeze([
  'schema_version',
  'state',
  'pending_from_epoch',
  'pending_tx_hash',
  'pending_prepared_transaction',
  'lease_owner_id',
  'lease_fencing_token',
  'broadcast_protocol',
  'prepared_at_ms',
  'broadcast_at_ms',
  'last_finalized_from_epoch',
  'last_finalized_tx_hash',
  'updated_at_ms',
] as const);

interface EpochAdvancementRecoveryFence {
  readonly fromEpoch: number;
  readonly transactionHash: string;
  readonly canonicalHead: Readonly<{ blockNumber: number; blockHash: string }>;
  readonly epochStartTime: bigint;
  readonly epochDuration: bigint;
}

const EPOCH_ADVANCEMENT_PREPARED_KEYS = Object.freeze([
  'schema_version',
  'from_epoch',
  'tx_hash',
  'raw_transaction',
  'nonce',
  'lease_owner_id',
  'lease_fencing_token',
  'economic_state_snapshot_hash',
  'economic_state_block_number',
  'economic_state_block_hash',
  'economic_state_agreed_head_number',
  'economic_state_agreed_head_hash',
  'economic_state_confirmation_depth',
  'economic_state_operator_ids',
  'economic_state_epoch_start_time',
  'economic_state_epoch_duration',
  'state',
  'prepared_at_ms',
  'updated_at_ms',
] as const);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function readEpochAdvancementRecoveryFence(
  value: unknown,
  expectedFromEpoch: number,
  expectedTransactionHash: string,
  expectedPrepared: PreparedEconomicTransaction,
): EpochAdvancementRecoveryFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('epoch_keeper_recovery_economic_fence_invalid');
  }
  const doc = value as Record<string, unknown>;
  const expectedKeys = doc.state === 'broadcast'
    ? [...EPOCH_ADVANCEMENT_PREPARED_KEYS, 'broadcast_at_ms']
    : EPOCH_ADVANCEMENT_PREPARED_KEYS;
  if (!hasExactKeys(doc, expectedKeys)
    || doc.schema_version !== 'pvt-epoch-advancement/v1'
    || doc.from_epoch !== expectedFromEpoch
    || typeof doc.tx_hash !== 'string'
    || doc.tx_hash.toLowerCase() !== expectedTransactionHash.toLowerCase()
    || doc.tx_hash.toLowerCase() !== expectedPrepared.transactionHash.toLowerCase()
    || doc.raw_transaction !== expectedPrepared.rawTransaction
    || doc.nonce !== expectedPrepared.nonce
    || (doc.state !== 'prepared' && doc.state !== 'broadcast')
    || typeof doc.lease_owner_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(doc.lease_owner_id)
    || !Number.isSafeInteger(doc.lease_fencing_token)
    || (doc.lease_fencing_token as number) <= 0
    || typeof doc.economic_state_snapshot_hash !== 'string'
    || !/^0x[a-fA-F0-9]{64}$/.test(doc.economic_state_snapshot_hash)
    || !Number.isSafeInteger(doc.economic_state_block_number)
    || (doc.economic_state_block_number as number) < 0
    || typeof doc.economic_state_block_hash !== 'string'
    || !/^0x[a-fA-F0-9]{64}$/.test(doc.economic_state_block_hash)
    || !Number.isSafeInteger(doc.economic_state_agreed_head_number)
    || doc.economic_state_agreed_head_number
      !== (doc.economic_state_block_number as number) + 11
    || typeof doc.economic_state_agreed_head_hash !== 'string'
    || !/^0x[a-fA-F0-9]{64}$/.test(doc.economic_state_agreed_head_hash)
    || doc.economic_state_confirmation_depth !== 12
    || !Array.isArray(doc.economic_state_operator_ids)
    || doc.economic_state_operator_ids.length !== 2
    || doc.economic_state_operator_ids.some((id) =>
      typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id))
    || doc.economic_state_operator_ids[0] === doc.economic_state_operator_ids[1]
    || typeof doc.economic_state_epoch_start_time !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(doc.economic_state_epoch_start_time)
    || typeof doc.economic_state_epoch_duration !== 'string'
    || !/^[1-9][0-9]*$/.test(doc.economic_state_epoch_duration)
    || !Number.isSafeInteger(doc.prepared_at_ms)
    || (doc.prepared_at_ms as number) < 0
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms as number) < (doc.prepared_at_ms as number)
    || (doc.state === 'broadcast'
      && (!Number.isSafeInteger(doc.broadcast_at_ms)
        || (doc.broadcast_at_ms as number) < (doc.prepared_at_ms as number)
        || (doc.updated_at_ms as number) < (doc.broadcast_at_ms as number)))) {
    throw new Error('epoch_keeper_recovery_economic_fence_invalid');
  }
  return Object.freeze({
    fromEpoch: expectedFromEpoch,
    transactionHash: expectedTransactionHash,
    canonicalHead: Object.freeze({
      blockNumber: doc.economic_state_agreed_head_number as number,
      blockHash: doc.economic_state_agreed_head_hash,
    }),
    epochStartTime: BigInt(doc.economic_state_epoch_start_time),
    epochDuration: BigInt(doc.economic_state_epoch_duration),
  });
}

export type EpochAdvanceResult =
  | {
    readonly status: 'not_ready';
    readonly fromEpoch: number;
    readonly readyAt: string;
    readonly observedAt: string;
    readonly economicStateSnapshotHash: string;
  }
  | {
    readonly status: 'pending_finality';
    readonly fromEpoch: number;
    readonly transactionHash: string;
  }
  | {
    readonly status: 'blocked_missing_hash';
    readonly fromEpoch: number;
  }
  | {
    readonly status: 'finalized';
    readonly fromEpoch: number;
    readonly toEpoch: number;
    readonly transactionHash: string;
    readonly recovered: boolean;
  }
  | {
    readonly status: 'epoch_not_ready_race';
    readonly fromEpoch: number;
  }
  | {
    readonly status: 'economic_mutation_lease_busy';
  }
  | {
    readonly status: 'mint_state_pending';
    readonly outstandingClaims: number;
  };

export interface EpochKeeperDeps {
  readonly db: Firestore;
  readonly pvtContract: ethers.Contract;
  readonly now?: () => number;
  readonly readEconomicState?: (
    contractAddress: string,
    options?: ReadBaseEconomicStateOptions,
  ) => Promise<BaseEconomicStateSnapshot>;
  readonly verifyEconomicFinality?: (
    transactionHash: string,
    options: { readonly expectedTo: string; readonly waitForConfirmations: boolean },
  ) => Promise<EconomicFinalityResult>;
  readonly economicTransactionBroadcaster?: EconomicTransactionBroadcaster;
  readonly leaseOwnerId?: string;
  readonly leaseTtlMs?: number;
  /** Test-only crash seam after exact bytes/hash are durable but before send. */
  readonly afterPreparedPersisted?: () => Promise<void>;
}

function emptyEpochKeeperState(now: number): EpochKeeperStateDocument {
  return {
    schema_version: 'pvt-epoch-keeper-state/v1',
    state: 'idle',
    pending_from_epoch: null,
    pending_tx_hash: null,
    pending_prepared_transaction: null,
    lease_owner_id: null,
    lease_fencing_token: null,
    broadcast_protocol: null,
    prepared_at_ms: null,
    broadcast_at_ms: null,
    last_finalized_from_epoch: null,
    last_finalized_tx_hash: null,
    updated_at_ms: now,
  };
}

function readEpochKeeperState(value: unknown, now: number): EpochKeeperStateDocument {
  if (value === undefined) return emptyEpochKeeperState(now);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('epoch_keeper_state_invalid');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== EPOCH_KEEPER_STATE_KEYS.length
    || EPOCH_KEEPER_STATE_KEYS.some((key) =>
      !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('epoch_keeper_state_invalid');
  }
  const doc = value as Partial<EpochKeeperStateDocument>;
  const leaseOwnerId = doc.lease_owner_id;
  const leaseFencingToken = doc.lease_fencing_token;
  let prepared: PreparedEconomicTransaction | null = null;
  try {
    prepared = doc.pending_prepared_transaction === undefined
      || doc.pending_prepared_transaction === null
      ? null
      : assertPreparedEconomicTransaction(doc.pending_prepared_transaction);
  } catch {
    throw new Error('epoch_keeper_state_invalid');
  }
  if (doc.schema_version !== 'pvt-epoch-keeper-state/v1'
    || !['idle', 'preparing', 'prepared', 'broadcast', 'uncertain_no_hash'].includes(doc.state ?? '')
    || (doc.pending_from_epoch !== null
      && (!Number.isSafeInteger(doc.pending_from_epoch) || (doc.pending_from_epoch ?? -1) < 0))
    || (doc.pending_tx_hash !== null
      && (typeof doc.pending_tx_hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(doc.pending_tx_hash)))
    || (doc.broadcast_protocol !== undefined
      && doc.broadcast_protocol !== null
      && doc.broadcast_protocol !== 'prepersisted_signed_bytes/v1')
    || (doc.prepared_at_ms !== null
      && (!Number.isSafeInteger(doc.prepared_at_ms) || (doc.prepared_at_ms ?? -1) < 0))
    || (doc.broadcast_at_ms !== null
      && (!Number.isSafeInteger(doc.broadcast_at_ms) || (doc.broadcast_at_ms ?? -1) < 0))
    || (doc.last_finalized_from_epoch !== null
      && (!Number.isSafeInteger(doc.last_finalized_from_epoch)
        || (doc.last_finalized_from_epoch ?? -1) < 0))
    || (doc.last_finalized_tx_hash !== null
      && (typeof doc.last_finalized_tx_hash !== 'string'
        || !/^0x[a-fA-F0-9]{64}$/.test(doc.last_finalized_tx_hash)))
    || ((doc.last_finalized_from_epoch === null) !== (doc.last_finalized_tx_hash === null))
    || (leaseOwnerId !== null
      && (typeof leaseOwnerId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(leaseOwnerId)))
    || (leaseFencingToken !== null
      && (typeof leaseFencingToken !== 'number'
        || !Number.isSafeInteger(leaseFencingToken)
        || leaseFencingToken <= 0))
    || ((leaseOwnerId === null) !== (leaseFencingToken === null))
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < 0
    || (typeof doc.prepared_at_ms === 'number'
      && (doc.updated_at_ms ?? -1) < doc.prepared_at_ms)
    || (typeof doc.broadcast_at_ms === 'number'
      && (doc.updated_at_ms ?? -1) < doc.broadcast_at_ms)) {
    throw new Error('epoch_keeper_state_invalid');
  }
  const noPendingIdentity = doc.pending_from_epoch === null
    && doc.pending_tx_hash === null
    && prepared === null
    && leaseOwnerId === null
    && leaseFencingToken === null
    && doc.broadcast_protocol === null
    && doc.prepared_at_ms === null
    && doc.broadcast_at_ms === null;
  const ownedPending = doc.pending_from_epoch !== null
    && leaseOwnerId !== null
    && leaseFencingToken !== null
    && doc.broadcast_protocol === 'prepersisted_signed_bytes/v1'
    && doc.prepared_at_ms !== null;
  const hashAndBytesBound = doc.pending_tx_hash !== null
    && prepared !== null
    && doc.pending_tx_hash.toLowerCase() === prepared.transactionHash.toLowerCase();
  const stateValid = (doc.state === 'idle' && noPendingIdentity)
    || (doc.state === 'preparing'
      && ownedPending
      && doc.pending_tx_hash === null
      && prepared === null
      && doc.broadcast_at_ms === null)
    || (doc.state === 'prepared'
      && ownedPending
      && hashAndBytesBound
      && doc.broadcast_at_ms === null)
    || (doc.state === 'broadcast'
      && ownedPending
      && hashAndBytesBound
      && typeof doc.broadcast_at_ms === 'number'
      && typeof doc.prepared_at_ms === 'number'
      && doc.broadcast_at_ms >= doc.prepared_at_ms)
    || (doc.state === 'uncertain_no_hash'
      && doc.pending_from_epoch !== null
      && doc.pending_tx_hash === null
      && prepared === null
      && leaseOwnerId === null
      && leaseFencingToken === null
      && doc.broadcast_protocol === null
      && doc.prepared_at_ms !== null);
  if (!stateValid) throw new Error('epoch_keeper_state_invalid');
  return {
    ...doc,
    pending_prepared_transaction: prepared,
    lease_owner_id: leaseOwnerId,
    lease_fencing_token: leaseFencingToken,
    broadcast_protocol: doc.broadcast_protocol,
  } as EpochKeeperStateDocument;
}

async function contractAddress(contract: ethers.Contract): Promise<string> {
  const address = await contract.getAddress();
  if (!ethers.isAddress(address)) throw new Error('epoch_keeper_contract_address_invalid');
  return address;
}

function expectedEpochAdvanceCall(
  expectedAddress: string,
  prepared: PreparedEconomicTransaction,
): ExpectedEconomicContractCall {
  return Object.freeze({
    chainId: BASE_ECONOMIC_CHAIN_ID,
    to: expectedAddress,
    data: EPOCH_KEEPER_INTERFACE.encodeFunctionData('advanceEpoch', []),
    value: 0n,
    nonce: prepared.nonce,
    transactionHash: prepared.transactionHash,
  });
}

function assertEpochStateOwnedByLease(
  state: EpochKeeperStateDocument,
  lease: MintWorkerLease,
): void {
  if (state.lease_owner_id !== lease.ownerId
    || state.lease_fencing_token !== lease.fencingToken) {
    throw new Error('epoch_keeper_state_fence_mismatch');
  }
}

async function renewEpochKeeperLease(
  deps: EpochKeeperDeps,
  lease: MintWorkerLease,
): Promise<MintWorkerLease> {
  return renewMintWorkerLease(deps.db, lease, {
    now: (deps.now ?? Date.now)(),
    ttlMs: deps.leaseTtlMs ?? DEFAULT_MINT_WORKER_LEASE_TTL_MS,
  });
}

/** Atomically move recoverable state to the current successor fence. */
async function adoptEpochStateForLease(
  deps: EpochKeeperDeps,
  stateRef: DocumentReference,
  lease: MintWorkerLease,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  await deps.db.runTransaction(async (txn) => {
    const [leaseSnap, stateSnap] = await Promise.all([
      txn.get(leaseRef),
      txn.get(stateRef),
    ]);
    assertMintWorkerLeaseCurrent(leaseSnap.data(), lease, now);
    const state = readEpochKeeperState(stateSnap.data(), now);
    if (state.pending_from_epoch === null || state.state === 'uncertain_no_hash') {
      throw new Error('epoch_keeper_state_not_adoptable');
    }
    if (state.lease_fencing_token !== null
      && state.lease_fencing_token > lease.fencingToken) {
      throw new Error('epoch_keeper_state_fence_regression');
    }
    if (state.lease_owner_id === lease.ownerId
      && state.lease_fencing_token === lease.fencingToken) return;
    txn.set(stateRef, {
      ...state,
      lease_owner_id: lease.ownerId,
      lease_fencing_token: lease.fencingToken,
      updated_at_ms: now,
    } satisfies EpochKeeperStateDocument);
  });
}

async function assertEpochStateLeaseCurrent(
  deps: EpochKeeperDeps,
  stateRef: DocumentReference,
  lease: MintWorkerLease,
): Promise<EpochKeeperStateDocument> {
  const now = (deps.now ?? Date.now)();
  const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  return deps.db.runTransaction(async (txn) => {
    const [leaseSnap, stateSnap] = await Promise.all([
      txn.get(leaseRef),
      txn.get(stateRef),
    ]);
    assertMintWorkerLeaseCurrent(leaseSnap.data(), lease, now);
    const state = readEpochKeeperState(stateSnap.data(), now);
    assertEpochStateOwnedByLease(state, lease);
    return state;
  });
}

async function assertEpochPreparedStateCurrent(
  deps: EpochKeeperDeps,
  stateRef: DocumentReference,
  lease: MintWorkerLease,
  fromEpoch: number,
  transactionHash: string,
  prepared: PreparedEconomicTransaction,
): Promise<{
  state: EpochKeeperStateDocument;
  recoveryFence: EpochAdvancementRecoveryFence;
}> {
  const now = (deps.now ?? Date.now)();
  const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  const advancementRef = deps.db.collection(EPOCH_ADVANCEMENT_COLLECTION).doc(String(fromEpoch));
  return deps.db.runTransaction(async (txn) => {
    const [leaseSnap, stateSnap, advancementSnap] = await Promise.all([
      txn.get(leaseRef),
      txn.get(stateRef),
      txn.get(advancementRef),
    ]);
    assertMintWorkerLeaseCurrent(leaseSnap.data(), lease, now);
    const state = readEpochKeeperState(stateSnap.data(), now);
    assertEpochStateOwnedByLease(state, lease);
    if ((state.state !== 'prepared' && state.state !== 'broadcast')
      || state.pending_from_epoch !== fromEpoch
      || state.pending_tx_hash?.toLowerCase() !== transactionHash.toLowerCase()
      || state.pending_prepared_transaction?.rawTransaction !== prepared.rawTransaction) {
      throw new Error('epoch_keeper_prepared_state_binding_invalid');
    }
    return {
      state,
      recoveryFence: readEpochAdvancementRecoveryFence(
        advancementSnap.data(),
        fromEpoch,
        transactionHash,
        prepared,
      ),
    };
  });
}

function parseEpochAdvanced(
  receipt: ethers.TransactionReceipt,
  contract: ethers.Contract,
  expectedAddress: string,
  fromEpoch: number,
): { toEpoch: number; startTime: bigint; previousEpochMinted: bigint } {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expectedAddress.toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'EpochAdvanced') continue;
      const toEpoch = Number(parsed.args.epoch);
      if (!Number.isSafeInteger(toEpoch) || toEpoch !== fromEpoch + 1) {
        throw new Error('epoch_advanced_event_epoch_mismatch');
      }
      return {
        toEpoch,
        startTime: BigInt(parsed.args.startTime),
        previousEpochMinted: BigInt(parsed.args.previousEpochMinted),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'epoch_advanced_event_epoch_mismatch') {
        throw error;
      }
    }
  }
  throw new Error('epoch_advanced_event_missing');
}

async function finalizeEpochAdvance(
  deps: EpochKeeperDeps,
  params: {
    fromEpoch: number;
    transactionHash: string;
    expectedAddress: string;
    prepared: PreparedEconomicTransaction;
    lease: MintWorkerLease;
    waitForConfirmations: boolean;
    recovered: boolean;
  },
): Promise<EpochAdvanceResult> {
  let currentLease = await renewEpochKeeperLease(deps, params.lease);
  const expectedCall = expectedEpochAdvanceCall(params.expectedAddress, params.prepared);
  assertPreparedEconomicContractCall(params.prepared, expectedCall);
  const verify = deps.verifyEconomicFinality ?? verifyBaseEconomicTransactionFinality;
  let finality: EconomicFinalityResult;
  try {
    finality = await verify(params.transactionHash, {
      expectedTo: params.expectedAddress,
      waitForConfirmations: params.waitForConfirmations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('pending') || message.includes('confirmations')) {
      return {
        status: 'pending_finality',
        fromEpoch: params.fromEpoch,
        transactionHash: params.transactionHash,
      };
    }
    throw error;
  }
  const event = parseEpochAdvanced(
    finality.receipt,
    deps.pvtContract,
    params.expectedAddress,
    params.fromEpoch,
  );
  assertPreparedEconomicContractCall(params.prepared, expectedCall);
  assertBaseEconomicFinalityEvidence(finality.evidence, params.transactionHash);
  currentLease = await renewEpochKeeperLease(deps, currentLease);
  const now = (deps.now ?? Date.now)();
  const stateRef = deps.db.collection(EPOCH_KEEPER_STATE_COLLECTION).doc(EPOCH_KEEPER_STATE_ID);
  const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  const advanceRef = deps.db.collection(EPOCH_ADVANCEMENT_COLLECTION).doc(String(params.fromEpoch));
  await deps.db.runTransaction(async (txn) => {
    const [leaseSnap, stateSnap, advancementSnap] = await Promise.all([
      txn.get(leaseRef),
      txn.get(stateRef),
      txn.get(advanceRef),
    ]);
    assertMintWorkerLeaseCurrent(leaseSnap.data(), currentLease, now);
    const state = readEpochKeeperState(stateSnap.data(), now);
    assertEpochStateOwnedByLease(state, currentLease);
    if (state.pending_from_epoch !== params.fromEpoch
      || state.pending_tx_hash?.toLowerCase() !== params.transactionHash.toLowerCase()
      || state.pending_prepared_transaction?.rawTransaction !== params.prepared.rawTransaction) {
      throw new Error('epoch_keeper_finality_ownership_mismatch');
    }
    readEpochAdvancementRecoveryFence(
      advancementSnap.data(),
      params.fromEpoch,
      params.transactionHash,
      params.prepared,
    );
    txn.set(advanceRef, {
      schema_version: 'pvt-epoch-advancement/v1',
      from_epoch: params.fromEpoch,
      to_epoch: event.toEpoch,
      tx_hash: params.transactionHash,
      event_start_time: event.startTime.toString(),
      event_previous_epoch_minted: event.previousEpochMinted.toString(),
      finality: finality.evidence,
      lease_owner_id: currentLease.ownerId,
      lease_fencing_token: currentLease.fencingToken,
      state: 'finalized',
      finalized_at_ms: now,
      updated_at_ms: now,
    }, { merge: true });
    txn.set(stateRef, {
      ...state,
      state: 'idle',
      pending_from_epoch: null,
      pending_tx_hash: null,
      pending_prepared_transaction: null,
      lease_owner_id: null,
      lease_fencing_token: null,
      broadcast_protocol: null,
      prepared_at_ms: null,
      broadcast_at_ms: null,
      last_finalized_from_epoch: params.fromEpoch,
      last_finalized_tx_hash: params.transactionHash,
      updated_at_ms: now,
    } satisfies EpochKeeperStateDocument);
  });
  return {
    status: 'finalized',
    fromEpoch: params.fromEpoch,
    toEpoch: event.toEpoch,
    transactionHash: params.transactionHash,
    recovered: params.recovered,
  };
}

/**
 * Advance at most one epoch. Readiness is derived from one exact-block
 * operator-agreed state snapshot. Success is durable only after the exact
 * broadcast hash has a matching EpochAdvanced event at quorum-two,
 * 12-confirmation finality.
 */
export async function advanceEpochWithFinality(
  deps: EpochKeeperDeps,
): Promise<EpochAdvanceResult> {
  const leaseNow = (deps.now ?? Date.now)();
  const lease = await acquireMintWorkerLease(deps.db, {
    ownerId: deps.leaseOwnerId ?? `epoch-keeper:${crypto.randomUUID()}`,
    now: leaseNow,
    ttlMs: deps.leaseTtlMs ?? DEFAULT_MINT_WORKER_LEASE_TTL_MS,
  });
  if (!lease) return { status: 'economic_mutation_lease_busy' };
  try {
    return await advanceEpochUnderSharedLease(deps, lease);
  } finally {
    await releaseMintWorkerLease(deps.db, lease, (deps.now ?? Date.now)());
  }
}

async function advanceEpochUnderSharedLease(
  deps: EpochKeeperDeps,
  lease: MintWorkerLease,
): Promise<EpochAdvanceResult> {
  let currentLease = await renewEpochKeeperLease(deps, lease);
  const now = (deps.now ?? Date.now)();
  const expectedAddress = await contractAddress(deps.pvtContract);
  const stateRef = deps.db.collection(EPOCH_KEEPER_STATE_COLLECTION).doc(EPOCH_KEEPER_STATE_ID);
  const stateSnap = await stateRef.get();
  let state = readEpochKeeperState(stateSnap.data(), now);
  const outstandingClaims = await listOutstandingMintBatchClaims(deps.db, { strict: true });
  if (outstandingClaims.length > 0 || await hasPendingMintEpochCapacity(deps.db)) {
    return { status: 'mint_state_pending', outstandingClaims: outstandingClaims.length };
  }
  const broadcaster = deps.economicTransactionBroadcaster
    ?? DEFAULT_ECONOMIC_TRANSACTION_BROADCASTER;
  const readState = deps.readEconomicState ?? readBaseEconomicStateSnapshot;

  if (state.pending_from_epoch !== null) {
    if (!state.pending_tx_hash) {
      if (state.state !== 'preparing'
        || state.broadcast_protocol !== 'prepersisted_signed_bytes/v1') {
        return { status: 'blocked_missing_hash', fromEpoch: state.pending_from_epoch };
      }
      // New-protocol `preparing` proves that no broadcast may occur until the
      // signed bytes/hash are persisted. It is therefore safe to resume below.
      currentLease = await renewEpochKeeperLease(deps, currentLease);
      await adoptEpochStateForLease(deps, stateRef, currentLease);
      state = await assertEpochStateLeaseCurrent(deps, stateRef, currentLease);
    } else {
      currentLease = await renewEpochKeeperLease(deps, currentLease);
      await adoptEpochStateForLease(deps, stateRef, currentLease);
      state = await assertEpochStateLeaseCurrent(deps, stateRef, currentLease);
      const pendingFromEpoch = state.pending_from_epoch;
      const pendingTransactionHash = state.pending_tx_hash;
      if (pendingFromEpoch === null || pendingTransactionHash === null) {
        throw new Error('epoch_keeper_recovery_binding_missing');
      }
      const pendingPrepared = state.pending_prepared_transaction;
      if (pendingPrepared) {
        const expectedCall = expectedEpochAdvanceCall(
          expectedAddress,
          pendingPrepared,
        );
        assertPreparedEconomicContractCall(pendingPrepared, expectedCall);
        const preparedState = await assertEpochPreparedStateCurrent(
          deps,
          stateRef,
          currentLease,
          pendingFromEpoch,
          pendingTransactionHash,
          pendingPrepared,
        );
        state = preparedState.state;
        const recoveryFence = preparedState.recoveryFence;
        let rebroadcastAuthorized = false;
        try {
          const recoveryState = assertBaseEconomicStateSnapshot(
            await readState(expectedAddress, {
              requiredCanonicalHead: recoveryFence.canonicalHead,
            }),
            { contractAddress: expectedAddress, batchId: null },
          );
          rebroadcastAuthorized = !recoveryState.circuitBreakerTripped
            && recoveryState.currentEpoch === BigInt(recoveryFence.fromEpoch)
            && recoveryState.currentEpochStartTime === recoveryFence.epochStartTime
            && recoveryState.epochDuration === recoveryFence.epochDuration
            && isEpochAdvanceReady(
              recoveryState.currentEpochStartTime,
              recoveryState.epochDuration,
              BigInt(recoveryState.blockTimestamp),
            );
        } catch (error) {
          console.warn(
            `[PVT Epoch] Recovery rebroadcast ${pendingTransactionHash} denied by economic head fence:`,
            error,
          );
        }
        if (rebroadcastAuthorized) {
          try {
            await assertEpochPreparedStateCurrent(
              deps,
              stateRef,
              currentLease,
              pendingFromEpoch,
              pendingTransactionHash,
              pendingPrepared,
            );
            await broadcaster.broadcast(
              deps.pvtContract,
              pendingPrepared,
              expectedCall,
            );
          } catch (error) {
            console.warn(
              `[PVT Epoch] Exact rebroadcast ${pendingTransactionHash} was ambiguous:`,
              error,
            );
          }
        }
      } else {
        throw new Error('epoch_keeper_prepared_transaction_missing');
      }
      return finalizeEpochAdvance(deps, {
        fromEpoch: pendingFromEpoch,
        transactionHash: pendingTransactionHash,
        expectedAddress,
        prepared: pendingPrepared,
        lease: currentLease,
        waitForConfirmations: false,
        recovered: true,
      });
    }
  }

  const economicState = assertBaseEconomicStateSnapshot(
    await readState(expectedAddress),
    { contractAddress: expectedAddress, batchId: null },
  );
  const fromEpoch = Number(economicState.currentEpoch);
  if (!Number.isSafeInteger(fromEpoch)) throw new Error('epoch_keeper_epoch_unsafe');
  if (state.pending_from_epoch !== null && state.pending_from_epoch !== fromEpoch) {
    return { status: 'blocked_missing_hash', fromEpoch: state.pending_from_epoch };
  }
  const nowSec = BigInt(economicState.blockTimestamp);
  if (!isEpochAdvanceReady(
    economicState.currentEpochStartTime,
    economicState.epochDuration,
    nowSec,
  )) {
    return {
      status: 'not_ready',
      fromEpoch,
      readyAt: (economicState.currentEpochStartTime + economicState.epochDuration).toString(),
      observedAt: nowSec.toString(),
      economicStateSnapshotHash: economicState.snapshotHash,
    };
  }
  const admissionCanonicalHead = canonicalHeadGuardFromEconomicState(economicState);
  const advancementRef = deps.db.collection(EPOCH_ADVANCEMENT_COLLECTION).doc(String(fromEpoch));

  if (state.pending_from_epoch === null) {
    currentLease = await renewEpochKeeperLease(deps, currentLease);
    const claimAt = (deps.now ?? Date.now)();
    const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
    const claimed = await deps.db.runTransaction(async (txn) => {
      const [leaseSnap, currentSnap, advancementSnap] = await Promise.all([
        txn.get(leaseRef),
        txn.get(stateRef),
        txn.get(advancementRef),
      ]);
      assertMintWorkerLeaseCurrent(leaseSnap.data(), currentLease, claimAt);
      const current = readEpochKeeperState(currentSnap.data(), claimAt);
      if (advancementSnap.exists) throw new Error('epoch_advancement_id_collision');
      if (current.state !== 'idle') return false;
      txn.set(stateRef, {
        ...current,
        state: 'preparing',
        pending_from_epoch: fromEpoch,
        pending_tx_hash: null,
        pending_prepared_transaction: null,
        lease_owner_id: currentLease.ownerId,
        lease_fencing_token: currentLease.fencingToken,
        broadcast_protocol: 'prepersisted_signed_bytes/v1',
        prepared_at_ms: claimAt,
        broadcast_at_ms: null,
        updated_at_ms: claimAt,
      } satisfies EpochKeeperStateDocument);
      return true;
    });
    if (!claimed) throw new Error('epoch_keeper_claim_race');
  }

  let prepared: PreparedEconomicTransaction;
  try {
    currentLease = await renewEpochKeeperLease(deps, currentLease);
    await assertEpochStateLeaseCurrent(deps, stateRef, currentLease);
    const preparationState = assertBaseEconomicStateSnapshot(
      await readState(expectedAddress, { requiredCanonicalHead: admissionCanonicalHead }),
      { contractAddress: expectedAddress, batchId: null },
    );
    if (preparationState.circuitBreakerTripped
      || preparationState.currentEpoch !== economicState.currentEpoch
      || preparationState.currentEpochStartTime !== economicState.currentEpochStartTime
      || preparationState.epochDuration !== economicState.epochDuration
      || !isEpochAdvanceReady(
        preparationState.currentEpochStartTime,
        preparationState.epochDuration,
        BigInt(preparationState.blockTimestamp),
      )) {
      throw new Error('epoch_keeper_economic_authorization_changed');
    }
    prepared = await broadcaster.prepare(deps.pvtContract, 'advanceEpoch', []);
    const expectedCall = expectedEpochAdvanceCall(expectedAddress, prepared);
    assertPreparedEconomicContractCall(prepared, expectedCall);
    currentLease = await renewEpochKeeperLease(deps, currentLease);
    const preparedAt = (deps.now ?? Date.now)();
    const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
    await deps.db.runTransaction(async (txn) => {
      const [leaseSnap, currentSnap] = await Promise.all([
        txn.get(leaseRef),
        txn.get(stateRef),
      ]);
      assertMintWorkerLeaseCurrent(leaseSnap.data(), currentLease, preparedAt);
      const current = readEpochKeeperState(currentSnap.data(), preparedAt);
      assertEpochStateOwnedByLease(current, currentLease);
      if (current.state !== 'preparing'
        || current.pending_from_epoch !== fromEpoch
        || current.pending_tx_hash !== null) {
        throw new Error('epoch_keeper_prepare_ownership_mismatch');
      }
      txn.set(stateRef, {
        ...current,
        state: 'prepared',
        pending_tx_hash: prepared.transactionHash,
        pending_prepared_transaction: prepared,
        lease_owner_id: currentLease.ownerId,
        lease_fencing_token: currentLease.fencingToken,
        broadcast_protocol: 'prepersisted_signed_bytes/v1',
        updated_at_ms: preparedAt,
      } satisfies EpochKeeperStateDocument);
      txn.create(advancementRef, {
        schema_version: 'pvt-epoch-advancement/v1',
        from_epoch: fromEpoch,
        tx_hash: prepared.transactionHash,
        raw_transaction: prepared.rawTransaction,
        nonce: prepared.nonce,
        lease_owner_id: currentLease.ownerId,
        lease_fencing_token: currentLease.fencingToken,
        economic_state_snapshot_hash: economicState.snapshotHash,
        economic_state_block_number: economicState.blockNumber,
        economic_state_block_hash: economicState.blockHash,
        economic_state_agreed_head_number: economicState.agreedHeadBlockNumber,
        economic_state_agreed_head_hash: economicState.agreedHeadBlockHash,
        economic_state_confirmation_depth: economicState.confirmationDepth,
        economic_state_operator_ids: [...economicState.providerOperatorIds],
        economic_state_epoch_start_time: economicState.currentEpochStartTime.toString(),
        economic_state_epoch_duration: economicState.epochDuration.toString(),
        state: 'prepared',
        prepared_at_ms: preparedAt,
        updated_at_ms: preparedAt,
      });
    });
  } catch (error) {
    // Preparation never broadcasts. Resetting this owned state is safe and a
    // retry may choose a new nonce; no transaction hash exists on chain.
    const failedAt = (deps.now ?? Date.now)();
    const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
    await deps.db.runTransaction(async (txn) => {
      const [leaseSnap, currentSnap] = await Promise.all([
        txn.get(leaseRef),
        txn.get(stateRef),
      ]);
      assertMintWorkerLeaseCurrent(leaseSnap.data(), currentLease, failedAt);
      const current = readEpochKeeperState(currentSnap.data(), failedAt);
      assertEpochStateOwnedByLease(current, currentLease);
      if (current.state !== 'preparing' || current.pending_tx_hash !== null) {
        throw new Error('epoch_keeper_failed_prepare_reset_not_owned');
      }
      txn.set(stateRef, {
        ...emptyEpochKeeperState(failedAt),
        last_finalized_from_epoch: current.last_finalized_from_epoch,
        last_finalized_tx_hash: current.last_finalized_tx_hash,
      } satisfies EpochKeeperStateDocument);
    });
    if (isEpochNotReadyError(error)) return { status: 'epoch_not_ready_race', fromEpoch };
    throw error;
  }

  await deps.afterPreparedPersisted?.();

  currentLease = await renewEpochKeeperLease(deps, currentLease);
  await assertEpochPreparedStateCurrent(
    deps,
    stateRef,
    currentLease,
    fromEpoch,
    prepared.transactionHash,
    prepared,
  );
  const broadcastState = assertBaseEconomicStateSnapshot(
    await readState(expectedAddress, { requiredCanonicalHead: admissionCanonicalHead }),
    { contractAddress: expectedAddress, batchId: null },
  );
  if (broadcastState.circuitBreakerTripped
    || broadcastState.currentEpoch !== economicState.currentEpoch
    || broadcastState.currentEpochStartTime !== economicState.currentEpochStartTime
    || broadcastState.epochDuration !== economicState.epochDuration
    || !isEpochAdvanceReady(
      broadcastState.currentEpochStartTime,
      broadcastState.epochDuration,
      BigInt(broadcastState.blockTimestamp),
    )) {
    throw new Error('epoch_keeper_immediate_broadcast_authorization_changed');
  }
  const expectedCall = expectedEpochAdvanceCall(expectedAddress, prepared);
  assertPreparedEconomicContractCall(prepared, expectedCall);
  await assertEpochPreparedStateCurrent(
    deps,
    stateRef,
    currentLease,
    fromEpoch,
    prepared.transactionHash,
    prepared,
  );
  try {
    await broadcaster.broadcast(deps.pvtContract, prepared, expectedCall);
  } catch (error) {
    console.warn(`[PVT Epoch] Broadcast ${prepared.transactionHash} was ambiguous:`, error);
  }
  currentLease = await renewEpochKeeperLease(deps, currentLease);
  const broadcastAt = (deps.now ?? Date.now)();
  const leaseRef = deps.db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  await deps.db.runTransaction(async (txn) => {
    const [leaseSnap, currentSnap, advancementSnap] = await Promise.all([
      txn.get(leaseRef),
      txn.get(stateRef),
      txn.get(advancementRef),
    ]);
    assertMintWorkerLeaseCurrent(leaseSnap.data(), currentLease, broadcastAt);
    const current = readEpochKeeperState(currentSnap.data(), broadcastAt);
    assertEpochStateOwnedByLease(current, currentLease);
    if (current.pending_from_epoch !== fromEpoch
      || current.pending_tx_hash?.toLowerCase() !== prepared.transactionHash.toLowerCase()) {
      throw new Error('epoch_keeper_broadcast_ownership_mismatch');
    }
    readEpochAdvancementRecoveryFence(
      advancementSnap.data(),
      fromEpoch,
      prepared.transactionHash,
      prepared,
    );
    txn.set(stateRef, {
      ...current,
      state: 'broadcast',
      lease_owner_id: currentLease.ownerId,
      lease_fencing_token: currentLease.fencingToken,
      broadcast_at_ms: broadcastAt,
      updated_at_ms: broadcastAt,
    } satisfies EpochKeeperStateDocument);
    txn.set(advancementRef, {
      state: 'broadcast',
      broadcast_at_ms: broadcastAt,
      updated_at_ms: broadcastAt,
    }, { merge: true });
  });
  return finalizeEpochAdvance(deps, {
    fromEpoch,
    transactionHash: prepared.transactionHash,
    expectedAddress,
    prepared,
    lease: currentLease,
    waitForConfirmations: true,
    recovered: false,
  });
}

/**
 * Mirror of the on-chain gate advanceEpoch enforces: an epoch is ready to advance
 * iff the current block time has reached `startTime + epochDuration`. All values
 * are seconds (uint256 → bigint). Used as a read-side pre-check to avoid sending
 * a doomed EpochNotReady tx.
 */
export function isEpochAdvanceReady(
  startTimeSec: bigint,
  epochDurationSec: bigint,
  nowSec: bigint,
): boolean {
  return nowSec >= startTimeSec + epochDurationSec;
}

/** 4-byte selector of the EpochNotReady() custom error. */
export const EPOCH_NOT_READY_SELECTOR = ethers.id('EpochNotReady()').slice(0, 10);

/**
 * True when a failed advanceEpoch reverted with `EpochNotReady()`. After the
 * read-side readiness pre-check this can only be a benign race (another run or
 * caller advanced the epoch between our read and our send), so the caller
 * swallows it as a no-op rather than erroring. Matches ethers v6's decoded
 * custom-error name, the raw revert selector (several shapes ethers surfaces it
 * in), or the error text as a last resort.
 */
export function isEpochNotReadyError(err: unknown): boolean {
  const e = err as {
    revert?: { name?: string } | null;
    data?: unknown;
    info?: { error?: { data?: unknown } };
    error?: { data?: unknown };
    message?: string;
    shortMessage?: string;
  };
  if (e?.revert?.name === 'EpochNotReady') return true;
  const sel = EPOCH_NOT_READY_SELECTOR.toLowerCase();
  const dataCandidates: unknown[] = [e?.data, e?.info?.error?.data, e?.error?.data];
  for (const d of dataCandidates) {
    if (typeof d === 'string' && d.toLowerCase().startsWith(sel)) return true;
  }
  const msg = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  return msg.includes('EpochNotReady');
}
