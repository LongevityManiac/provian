import crypto from 'crypto';
import { readCommonCanonicalHead } from './common-canonical-head';
import { ethers } from 'ethers';

import {
  getOperatorBoundRpcLegs,
  type OperatorBoundRpcLeg,
} from './rpc-provider';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from './economic-constants';
import { rpcChainFactsEqual } from './rpc-chain-facts';

export const BASE_ECONOMIC_STATE_CHAIN_ID = 8453;
export const PVT_EPOCH_HISTORY_SIZE = 12;
export const PVT_COMBINED_CAP_MULTIPLIER_PERCENT = 200n;

const BYTES32 = /^0x[a-fA-F0-9]{64}$/;

const PVT_ECONOMIC_STATE_ABI = [
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
  'event MintRateUpdated(uint256 oldRate,uint256 newRate)',
  'event PEWeightUpdated(bytes32 indexed actionType,uint256 oldWeight,uint256 newWeight)',
  'event RegistryUpdated(address indexed oldRegistry,address indexed newRegistry)',
  'event CircuitBreakerTripped(uint256 epochMinted,uint256 trailingAvg,uint256 threshold)',
  'event CircuitBreakerHalted(address indexed guardian)',
  'event CircuitBreakerReset(address indexed resetter)',
  'event AgentFoundationBPSUpdated(uint256 oldBps,uint256 newBps,string track)',
  'event BaselinePoked(uint256 oldBaselineBps,uint256 newBaselineBps)',
  'event BaselineParamUpdated(string param,uint256 oldValue,uint256 newValue)',
  'event CompositionScheduleUpdated()',
] as const;

const REGISTRY_ECONOMIC_STATE_ABI = [
  'function isHumanBeneficiaryChain(address wallet) view returns (bool)',
] as const;

const pvtInterface = new ethers.Interface(PVT_ECONOMIC_STATE_ABI);
const registryInterface = new ethers.Interface(REGISTRY_ECONOMIC_STATE_ABI);

export interface BaseEconomicStateSnapshot {
  readonly schemaVersion: 'base-economic-state/v2';
  readonly chainId: typeof BASE_ECONOMIC_STATE_CHAIN_ID;
  readonly contractAddress: string;
  /** Canonical finalized economic state block H-(confirmations-1). */
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTimestamp: number;
  readonly agreedHeadBlockNumber: number;
  readonly agreedHeadBlockHash: string;
  readonly agreedHeadBlockTimestamp: number;
  readonly confirmationDepth: typeof BASE_ECONOMIC_FINALITY_CONFIRMATIONS;
  readonly providerOperatorIds: readonly [string, string];
  readonly canonicalityEvidence: {
    readonly schemaVersion: 'base-economic-state-canonicality/v1';
    readonly finalizedBlockRecheckedAfterCalls: true;
    readonly agreedHeadRecheckedAfterTipReads: true;
    readonly eip1898BlockHash: string;
    readonly eip1898RequireCanonical: true;
  };
  readonly restrictiveTipEvidence: {
    readonly schemaVersion: 'base-economic-state-tip-restriction/v1';
    readonly fromBlockNumber: number;
    readonly throughBlockNumber: number;
    readonly throughBlockHash: string;
    readonly batchMintedTotalAtomic: bigint;
    readonly observedCurrentEpochMinted: bigint;
    readonly requestedBatchMinted: boolean | null;
    readonly pvtEconomicLogCount: number;
    readonly registryLogCount: 0;
    readonly onlyRestrictive: true;
  };
  readonly circuitBreakerTripped: boolean;
  readonly currentEpoch: bigint;
  readonly currentEpochMinted: bigint;
  readonly epochMintHistory: readonly bigint[];
  readonly genesisEpochHardCap: bigint;
  readonly effectiveMintRate: bigint;
  readonly stakeRatioBps: bigint;
  readonly currentAgentFoundationBps: bigint;
  /** Effective PVTv8 weight for the ZeroHash selector (raw zero means 10_000). */
  readonly zeroHashPeWeightBps: bigint;
  readonly registryAddress: string;
  readonly epochDuration: bigint;
  readonly currentEpochStartTime: bigint;
  readonly batchId: string | null;
  readonly batchMinted: boolean | null;
  readonly humanBeneficiaryClassifications: readonly {
    readonly address: string;
    readonly isHuman: boolean;
  }[];
  readonly snapshotHash: string;
  readonly observedAtMs: number;
}

export interface EconomicStateRpcLeg {
  readonly operatorId: string;
  readonly send: (method: string, params: readonly unknown[]) => Promise<unknown>;
}

export interface ReadBaseEconomicStateOptions {
  readonly batchId?: string;
  readonly beneficiaryAddresses?: readonly string[];
  readonly now?: () => number;
  /** Test-only injection. Production always uses the configured operator-bound legs. */
  readonly rpcLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
  /** A prior admission head that must remain canonical. Later heads may advance,
   * but a shallow replacement of this exact block fails closed. */
  readonly requiredCanonicalHead?: Readonly<{ blockNumber: number; blockHash: string }>;
}

interface RpcBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly timestamp?: unknown;
}

interface RpcLog {
  readonly address?: unknown;
  readonly blockNumber?: unknown;
  readonly blockHash?: unknown;
  readonly transactionHash?: unknown;
  readonly logIndex?: unknown;
  readonly topics?: unknown;
  readonly data?: unknown;
  readonly removed?: unknown;
}

const TIP_ECONOMIC_EVENT_NAMES = Object.freeze([
  'BatchMinted',
  'EpochAdvanced',
  'MintRateUpdated',
  'PEWeightUpdated',
  'RegistryUpdated',
  'CircuitBreakerTripped',
  'CircuitBreakerHalted',
  'CircuitBreakerReset',
  'AgentFoundationBPSUpdated',
  'BaselinePoked',
  'BaselineParamUpdated',
  'CompositionScheduleUpdated',
] as const);
const TIP_ECONOMIC_EVENT_TOPICS = Object.freeze(TIP_ECONOMIC_EVENT_NAMES.map((name) => {
  const event = pvtInterface.getEvent(name);
  if (!event) throw new Error(`economic_state_event_missing:${name}`);
  return event.topicHash;
}));

const BASE_ECONOMIC_STATE_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'chainId',
  'contractAddress',
  'blockNumber',
  'blockHash',
  'blockTimestamp',
  'agreedHeadBlockNumber',
  'agreedHeadBlockHash',
  'agreedHeadBlockTimestamp',
  'confirmationDepth',
  'providerOperatorIds',
  'canonicalityEvidence',
  'restrictiveTipEvidence',
  'circuitBreakerTripped',
  'currentEpoch',
  'currentEpochMinted',
  'epochMintHistory',
  'genesisEpochHardCap',
  'effectiveMintRate',
  'stakeRatioBps',
  'currentAgentFoundationBps',
  'zeroHashPeWeightBps',
  'registryAddress',
  'epochDuration',
  'currentEpochStartTime',
  'batchId',
  'batchMinted',
  'humanBeneficiaryClassifications',
  'snapshotHash',
  'observedAtMs',
] as const);

const CANONICALITY_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'finalizedBlockRecheckedAfterCalls',
  'agreedHeadRecheckedAfterTipReads',
  'eip1898BlockHash',
  'eip1898RequireCanonical',
] as const);

const RESTRICTIVE_TIP_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'fromBlockNumber',
  'throughBlockNumber',
  'throughBlockHash',
  'batchMintedTotalAtomic',
  'observedCurrentEpochMinted',
  'requestedBatchMinted',
  'pvtEconomicLogCount',
  'registryLogCount',
  'onlyRestrictive',
] as const);

const BENEFICIARY_CLASSIFICATION_KEYS = Object.freeze([
  'address',
  'isHuman',
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalSnapshotPayload(
  value: Omit<BaseEconomicStateSnapshot, 'snapshotHash'>,
): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    chainId: value.chainId,
    contractAddress: value.contractAddress,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    blockTimestamp: value.blockTimestamp,
    agreedHeadBlockNumber: value.agreedHeadBlockNumber,
    agreedHeadBlockHash: value.agreedHeadBlockHash,
    agreedHeadBlockTimestamp: value.agreedHeadBlockTimestamp,
    confirmationDepth: value.confirmationDepth,
    providerOperatorIds: [...value.providerOperatorIds],
    canonicalityEvidence: value.canonicalityEvidence,
    restrictiveTipEvidence: {
      ...value.restrictiveTipEvidence,
      batchMintedTotalAtomic: value.restrictiveTipEvidence.batchMintedTotalAtomic.toString(),
      observedCurrentEpochMinted: value.restrictiveTipEvidence.observedCurrentEpochMinted.toString(),
    },
    circuitBreakerTripped: value.circuitBreakerTripped,
    currentEpoch: value.currentEpoch.toString(),
    currentEpochMinted: value.currentEpochMinted.toString(),
    epochMintHistory: value.epochMintHistory.map((item) => item.toString()),
    genesisEpochHardCap: value.genesisEpochHardCap.toString(),
    effectiveMintRate: value.effectiveMintRate.toString(),
    stakeRatioBps: value.stakeRatioBps.toString(),
    currentAgentFoundationBps: value.currentAgentFoundationBps.toString(),
    zeroHashPeWeightBps: value.zeroHashPeWeightBps.toString(),
    registryAddress: value.registryAddress,
    epochDuration: value.epochDuration.toString(),
    currentEpochStartTime: value.currentEpochStartTime.toString(),
    batchId: value.batchId,
    batchMinted: value.batchMinted,
    humanBeneficiaryClassifications: value.humanBeneficiaryClassifications.map((item) => ({
      address: item.address,
      isHuman: item.isHuman,
    })),
    observedAtMs: value.observedAtMs,
  };
}

export function hashBaseEconomicStateSnapshot(
  value: Omit<BaseEconomicStateSnapshot, 'snapshotHash'>,
): string {
  return `0x${crypto.createHash('sha256')
    .update(JSON.stringify(canonicalSnapshotPayload(value)), 'utf8')
    .digest('hex')}`;
}

export function economicFactorFingerprint(snapshot: BaseEconomicStateSnapshot): string {
  return `0x${crypto.createHash('sha256').update(JSON.stringify({
    effectiveMintRate: snapshot.effectiveMintRate.toString(),
    currentAgentFoundationBps: snapshot.currentAgentFoundationBps.toString(),
    zeroHashPeWeightBps: snapshot.zeroHashPeWeightBps.toString(),
    registryAddress: snapshot.registryAddress,
    humanBeneficiaryClassifications: snapshot.humanBeneficiaryClassifications,
  }), 'utf8').digest('hex')}`;
}

export function canonicalHeadGuardFromEconomicState(
  snapshot: BaseEconomicStateSnapshot,
): Readonly<{ blockNumber: number; blockHash: string }> {
  const state = assertBaseEconomicStateSnapshot(snapshot);
  return Object.freeze({
    blockNumber: state.agreedHeadBlockNumber,
    blockHash: state.agreedHeadBlockHash,
  });
}

export function restrictiveCurrentEpochMinted(snapshot: BaseEconomicStateSnapshot): bigint {
  const state = assertBaseEconomicStateSnapshot(snapshot);
  return state.restrictiveTipEvidence.observedCurrentEpochMinted;
}

export function isBatchMintedAtOrBeforeAgreedHead(
  snapshot: BaseEconomicStateSnapshot,
): boolean | null {
  const state = assertBaseEconomicStateSnapshot(snapshot);
  if (state.batchMinted === null) return null;
  return state.batchMinted || state.restrictiveTipEvidence.requestedBatchMinted === true;
}

/** Exact atomic accounting combined ceiling derived only from an operator-agreed snapshot. */
export function computeCombinedCapThreshold(snapshot: BaseEconomicStateSnapshot): bigint {
  assertBaseEconomicStateSnapshot(snapshot);
  if (snapshot.currentEpoch < BigInt(PVT_EPOCH_HISTORY_SIZE)) {
    return snapshot.genesisEpochHardCap;
  }
  const sum = snapshot.epochMintHistory
    .reduce((total, amount) => total + amount, 0n);
  const trailingAverage = sum / BigInt(PVT_EPOCH_HISTORY_SIZE);
  return (trailingAverage * PVT_COMBINED_CAP_MULTIPLIER_PERCENT) / 100n;
}

export function assertBaseEconomicStateSnapshot(
  value: BaseEconomicStateSnapshot | undefined,
  expected?: { contractAddress?: string; batchId?: string | null },
): BaseEconomicStateSnapshot {
  if (!value
    || !isRecord(value)
    || !hasExactKeys(value, BASE_ECONOMIC_STATE_SNAPSHOT_KEYS)
    || value.schemaVersion !== 'base-economic-state/v2'
    || value.chainId !== BASE_ECONOMIC_STATE_CHAIN_ID
    || !ethers.isAddress(value.contractAddress)
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber < 0
    || !BYTES32.test(value.blockHash)
    || !Number.isSafeInteger(value.blockTimestamp)
    || value.blockTimestamp < 0
    || !Number.isSafeInteger(value.agreedHeadBlockNumber)
    || value.agreedHeadBlockNumber < value.blockNumber
    || value.agreedHeadBlockNumber - value.blockNumber
      !== BASE_ECONOMIC_FINALITY_CONFIRMATIONS - 1
    || !BYTES32.test(value.agreedHeadBlockHash)
    || !Number.isSafeInteger(value.agreedHeadBlockTimestamp)
    || value.agreedHeadBlockTimestamp < value.blockTimestamp
    || value.confirmationDepth !== BASE_ECONOMIC_FINALITY_CONFIRMATIONS
    || !Array.isArray(value.providerOperatorIds)
    || value.providerOperatorIds.length !== 2
    || value.providerOperatorIds[0] === value.providerOperatorIds[1]
    || value.providerOperatorIds.some((id) => !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id))
    || !isRecord(value.canonicalityEvidence)
    || !hasExactKeys(value.canonicalityEvidence, CANONICALITY_EVIDENCE_KEYS)
    || value.canonicalityEvidence.schemaVersion !== 'base-economic-state-canonicality/v1'
    || value.canonicalityEvidence.finalizedBlockRecheckedAfterCalls !== true
    || value.canonicalityEvidence.agreedHeadRecheckedAfterTipReads !== true
    || typeof value.canonicalityEvidence.eip1898BlockHash !== 'string'
    || !BYTES32.test(value.canonicalityEvidence.eip1898BlockHash)
    || value.canonicalityEvidence.eip1898BlockHash.toLowerCase() !== value.blockHash.toLowerCase()
    || value.canonicalityEvidence.eip1898RequireCanonical !== true
    || !isRecord(value.restrictiveTipEvidence)
    || !hasExactKeys(value.restrictiveTipEvidence, RESTRICTIVE_TIP_EVIDENCE_KEYS)
    || value.restrictiveTipEvidence.schemaVersion !== 'base-economic-state-tip-restriction/v1'
    || value.restrictiveTipEvidence.fromBlockNumber !== value.blockNumber + 1
    || value.restrictiveTipEvidence.throughBlockNumber !== value.agreedHeadBlockNumber
    || typeof value.restrictiveTipEvidence.throughBlockHash !== 'string'
    || !BYTES32.test(value.restrictiveTipEvidence.throughBlockHash)
    || value.restrictiveTipEvidence.throughBlockHash.toLowerCase()
      !== value.agreedHeadBlockHash.toLowerCase()
    || typeof value.restrictiveTipEvidence.batchMintedTotalAtomic !== 'bigint'
    || value.restrictiveTipEvidence.batchMintedTotalAtomic < 0n
    || typeof value.restrictiveTipEvidence.observedCurrentEpochMinted !== 'bigint'
    || value.restrictiveTipEvidence.observedCurrentEpochMinted < value.currentEpochMinted
    || (value.restrictiveTipEvidence.requestedBatchMinted !== null
      && typeof value.restrictiveTipEvidence.requestedBatchMinted !== 'boolean')
    || (value.batchId === null) !== (value.restrictiveTipEvidence.requestedBatchMinted === null)
    || !Number.isSafeInteger(value.restrictiveTipEvidence.pvtEconomicLogCount)
    || value.restrictiveTipEvidence.pvtEconomicLogCount < 0
    || value.restrictiveTipEvidence.registryLogCount !== 0
    || value.restrictiveTipEvidence.onlyRestrictive !== true
    || typeof value.circuitBreakerTripped !== 'boolean'
    || typeof value.currentEpoch !== 'bigint'
    || value.currentEpoch < 0n
    || typeof value.currentEpochMinted !== 'bigint'
    || value.currentEpochMinted < 0n
    || !Array.isArray(value.epochMintHistory)
    || value.epochMintHistory.length !== PVT_EPOCH_HISTORY_SIZE
    || value.epochMintHistory.some((item) => typeof item !== 'bigint' || item < 0n)
    || typeof value.genesisEpochHardCap !== 'bigint'
    || value.genesisEpochHardCap < 0n
    || typeof value.effectiveMintRate !== 'bigint'
    || value.effectiveMintRate < 0n
    || typeof value.stakeRatioBps !== 'bigint'
    || value.stakeRatioBps < 0n
    || typeof value.currentAgentFoundationBps !== 'bigint'
    || value.currentAgentFoundationBps < 50n
    || value.currentAgentFoundationBps > 9_950n
    || typeof value.zeroHashPeWeightBps !== 'bigint'
    || value.zeroHashPeWeightBps < 5_000n
    || value.zeroHashPeWeightBps > 30_000n
    || !ethers.isAddress(value.registryAddress)
    || typeof value.epochDuration !== 'bigint'
    || value.epochDuration <= 0n
    || typeof value.currentEpochStartTime !== 'bigint'
    || value.currentEpochStartTime < 0n
    || (value.batchId !== null && !BYTES32.test(value.batchId))
    || (value.batchId === null) !== (value.batchMinted === null)
    || (value.batchMinted !== null && typeof value.batchMinted !== 'boolean')
    || !Array.isArray(value.humanBeneficiaryClassifications)
    || value.humanBeneficiaryClassifications.some((item) =>
      !isRecord(item)
      || !hasExactKeys(item, BENEFICIARY_CLASSIFICATION_KEYS)
      || !ethers.isAddress(item.address)
      || item.address !== item.address.toLowerCase()
      || typeof item.isHuman !== 'boolean')
    || value.humanBeneficiaryClassifications.some((item, index, items) =>
      index > 0 && items[index - 1].address >= item.address)
    || !BYTES32.test(value.snapshotHash)
    || !Number.isSafeInteger(value.observedAtMs)
    || value.observedAtMs < 0
    || (expected?.contractAddress !== undefined
      && value.contractAddress.toLowerCase() !== expected.contractAddress.toLowerCase())
    || (expected?.batchId !== undefined
      && (value.batchId?.toLowerCase() ?? null) !== (expected.batchId?.toLowerCase() ?? null))) {
    throw new Error('base_economic_state_snapshot_invalid');
  }
  const { snapshotHash: _snapshotHash, ...withoutHash } = value;
  if (hashBaseEconomicStateSnapshot(withoutHash).toLowerCase() !== value.snapshotHash.toLowerCase()) {
    throw new Error('base_economic_state_snapshot_hash_mismatch');
  }
  return value;
}

function asRpcLeg(leg: OperatorBoundRpcLeg): EconomicStateRpcLeg {
  return {
    operatorId: leg.operatorId,
    send: (method, params) => leg.provider.send(method, [...params]),
  };
}

function canonicalRpcValue(value: unknown): string {
  return JSON.stringify(value);
}

async function readAgreedRaw(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  method: string,
  params: readonly unknown[],
  label: string,
): Promise<unknown> {
  const [left, right] = await Promise.all([
    legs[0].send(method, params),
    legs[1].send(method, params),
  ]);
  if (!rpcChainFactsEqual(left, right)) {
    throw new Error(`economic_state_rpc_disagreement:${label}`);
  }
  return left;
}

function parseRpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`economic_state_rpc_quantity_invalid:${label}`);
  }
  return BigInt(value);
}

async function agreedContractCall(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  address: string,
  iface: ethers.Interface,
  functionName: string,
  args: readonly unknown[],
  blockReference: Readonly<{ blockHash: string; requireCanonical: true }>,
): Promise<ethers.Result> {
  const data = iface.encodeFunctionData(functionName, [...args]);
  const raw = await readAgreedRaw(
    legs,
    'eth_call',
    [{ to: address, data }, blockReference],
    functionName,
  );
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) {
    throw new Error(`economic_state_call_result_invalid:${functionName}`);
  }
  return iface.decodeFunctionResult(functionName, raw);
}

async function readRestrictiveTipEvidence(
  legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  params: {
    contractAddress: string;
    registryAddress: string;
    finalizedBlockNumber: number;
    agreedHeadBlockNumber: number;
    agreedHeadBlockHash: string;
    currentEpoch: bigint;
    currentEpochMinted: bigint;
    batchId: string | null;
  },
): Promise<BaseEconomicStateSnapshot['restrictiveTipEvidence']> {
  const fromBlock = params.finalizedBlockNumber + 1;
  const filter = {
    address: params.contractAddress,
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(params.agreedHeadBlockNumber),
    topics: [[...TIP_ECONOMIC_EVENT_TOPICS]],
  };
  const rawPvtLogs = await readAgreedRaw(
    legs,
    'eth_getLogs',
    [filter],
    'restrictive_tip_pvt_logs',
  );
  if (!Array.isArray(rawPvtLogs)) throw new Error('economic_state_tip_logs_invalid');

  // Shallow BatchMinted totals are diagnostic evidence only. They must never
  // be folded into finalized H-11 capacity or composition authority: every
  // mint changes the human/agent epoch composition and can therefore change
  // the Foundation/contributor split of a later agent mint.
  let batchMintedTotalAtomic = 0n;
  let requestedBatchMinted = params.batchId === null ? null : false;
  let unrelatedBatchMintedCount = 0;
  for (const raw of rawPvtLogs as RpcLog[]) {
    if (raw.removed === true
      || typeof raw.address !== 'string'
      || raw.address.toLowerCase() !== params.contractAddress.toLowerCase()
      || typeof raw.blockHash !== 'string'
      || !BYTES32.test(raw.blockHash)
      || typeof raw.transactionHash !== 'string'
      || !BYTES32.test(raw.transactionHash)
      || !Array.isArray(raw.topics)
      || raw.topics.some((topic) => typeof topic !== 'string' || !BYTES32.test(topic))
      || typeof raw.data !== 'string'
      || !/^0x[0-9a-fA-F]*$/.test(raw.data)) {
      throw new Error('economic_state_tip_log_invalid');
    }
    const blockNumber = parseRpcQuantity(raw.blockNumber, 'tip_log.blockNumber');
    if (blockNumber < BigInt(fromBlock)
      || blockNumber > BigInt(params.agreedHeadBlockNumber)) {
      throw new Error('economic_state_tip_log_range_invalid');
    }
    parseRpcQuantity(raw.logIndex, 'tip_log.logIndex');
    const parsed = pvtInterface.parseLog({
      topics: raw.topics as string[],
      data: raw.data,
    });
    if (!parsed) throw new Error('economic_state_tip_log_unparseable');
    if (parsed.name !== 'BatchMinted') {
      // The finalized snapshot remains the only permissive authority. Any
      // shallow mutation to epoch, breaker, rate, PE weight, registry, or
      // beneficiary economics can only stop this attempt.
      throw new Error(`economic_state_unfinalized_mutation_detected:${parsed.name}`);
    }
    batchMintedTotalAtomic += BigInt(parsed.args[2]);
    if (params.batchId !== null
      && String(parsed.args[0]).toLowerCase() === params.batchId.toLowerCase()) {
      requestedBatchMinted = true;
    } else {
      // Track every unrelated batch independently from the requested batch.
      // Finding the exact requested event must never mask another shallow
      // mint, regardless of log order or whether both operators agree on the
      // same mixed evidence.
      unrelatedBatchMintedCount += 1;
    }
  }

  if (unrelatedBatchMintedCount > 0) {
    // An unrelated shallow batch is never a harmless headroom-only mutation.
    // Defer until it reaches finalized economic state and H-11 is reread.
    throw new Error('economic_state_unfinalized_batch_minted_detected');
  }

  const rawRegistryLogs = await readAgreedRaw(
    legs,
    'eth_getLogs',
    [{
      address: params.registryAddress,
      fromBlock: ethers.toQuantity(fromBlock),
      toBlock: ethers.toQuantity(params.agreedHeadBlockNumber),
    }],
    'restrictive_tip_registry_logs',
  );
  if (!Array.isArray(rawRegistryLogs)) throw new Error('economic_state_tip_registry_logs_invalid');
  if (rawRegistryLogs.length > 0) {
    throw new Error('economic_state_unfinalized_registry_mutation_detected');
  }

  return Object.freeze({
    schemaVersion: 'base-economic-state-tip-restriction/v1',
    fromBlockNumber: fromBlock,
    throughBlockNumber: params.agreedHeadBlockNumber,
    throughBlockHash: params.agreedHeadBlockHash.toLowerCase(),
    batchMintedTotalAtomic,
    // Finalized H-11 remains the sole permissive economic authority. The exact
    // requested shallow batch, when present, is exposed only through
    // requestedBatchMinted so its owning claim enters recovery and cannot be
    // submitted again.
    observedCurrentEpochMinted: params.currentEpochMinted,
    requestedBatchMinted,
    pvtEconomicLogCount: rawPvtLogs.length,
    registryLogCount: 0,
    onlyRestrictive: true,
  });
}

/**
 * Read every mint-admission economic field from two independently operated RPC
 * sources at one exact, agreed Base block. A stale head, forged field, missing
 * result, code/registry disagreement, or block-hash disagreement aborts the
 * entire snapshot.
 */
export async function readBaseEconomicStateSnapshot(
  contractAddress: string,
  options: ReadBaseEconomicStateOptions = {},
): Promise<BaseEconomicStateSnapshot> {
  if (!ethers.isAddress(contractAddress)) throw new Error('economic_state_contract_invalid');
  if (options.batchId !== undefined && !BYTES32.test(options.batchId)) {
    throw new Error('economic_state_batch_id_invalid');
  }
  if (options.requiredCanonicalHead !== undefined
    && (!Number.isSafeInteger(options.requiredCanonicalHead.blockNumber)
      || options.requiredCanonicalHead.blockNumber < 0
      || !BYTES32.test(options.requiredCanonicalHead.blockHash))) {
    throw new Error('economic_state_required_head_invalid');
  }
  const normalizedBeneficiaries = [...new Set((options.beneficiaryAddresses ?? [])
    .map((address) => {
      if (!ethers.isAddress(address)) throw new Error('economic_state_beneficiary_invalid');
      return address.toLowerCase();
    }))].sort();
  const legs = options.rpcLegs ?? (() => {
    const configured = getOperatorBoundRpcLegs('base');
    return [asRpcLeg(configured[0]), asRpcLeg(configured[1])] as const;
  })();
  if (legs[0].operatorId === legs[1].operatorId) {
    throw new Error('economic_state_rpc_operators_not_independent');
  }

  const chainId = parseRpcQuantity(
    await readAgreedRaw(legs, 'eth_chainId', [], 'chain_id'),
    'chain_id',
  );
  if (chainId !== BigInt(BASE_ECONOMIC_STATE_CHAIN_ID)) {
    throw new Error(`economic_state_chain_mismatch:${chainId.toString()}`);
  }
  const agreedHeadBlockNumberBig = await readCommonCanonicalHead(legs, 'economic_state_rpc_disagreement:head');
  if (agreedHeadBlockNumberBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('economic_state_block_number_unsafe');
  }
  if (agreedHeadBlockNumberBig < BigInt(BASE_ECONOMIC_FINALITY_CONFIRMATIONS - 1)) {
    throw new Error('economic_state_head_not_finalizable');
  }
  const agreedHeadTag = ethers.toQuantity(agreedHeadBlockNumberBig);
  const agreedHeadBlock = await readAgreedRaw(
    legs,
    'eth_getBlockByNumber',
    [agreedHeadTag, false],
    'head_block_header',
  ) as RpcBlock | null;
  if (!agreedHeadBlock
    || parseRpcQuantity(agreedHeadBlock.number, 'head_block.number')
      !== agreedHeadBlockNumberBig
    || typeof agreedHeadBlock.hash !== 'string'
    || !BYTES32.test(agreedHeadBlock.hash)) {
    throw new Error('economic_state_head_block_invalid');
  }
  const agreedHeadTimestampBig = parseRpcQuantity(
    agreedHeadBlock.timestamp,
    'head_block.timestamp',
  );
  if (agreedHeadTimestampBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('economic_state_head_block_timestamp_unsafe');
  }
  if (options.requiredCanonicalHead !== undefined) {
    if (BigInt(options.requiredCanonicalHead.blockNumber) > agreedHeadBlockNumberBig) {
      throw new Error('economic_state_required_head_ahead_of_latest');
    }
    const required = await readAgreedRaw(
      legs,
      'eth_getBlockByNumber',
      [ethers.toQuantity(options.requiredCanonicalHead.blockNumber), false],
      'required_canonical_head',
    ) as RpcBlock | null;
    if (!required
      || parseRpcQuantity(required.number, 'required_head.number')
        !== BigInt(options.requiredCanonicalHead.blockNumber)
      || typeof required.hash !== 'string'
      || required.hash.toLowerCase() !== options.requiredCanonicalHead.blockHash.toLowerCase()) {
      throw new Error('economic_state_required_head_not_canonical');
    }
  }

  const blockNumberBig = agreedHeadBlockNumberBig
    - BigInt(BASE_ECONOMIC_FINALITY_CONFIRMATIONS - 1);
  const blockTag = ethers.toQuantity(blockNumberBig);
  const block = await readAgreedRaw(
    legs,
    'eth_getBlockByNumber',
    [blockTag, false],
    'finalized_block_header',
  ) as RpcBlock | null;
  if (!block
    || parseRpcQuantity(block.number, 'finalized_block.number') !== blockNumberBig
    || typeof block.hash !== 'string'
    || !BYTES32.test(block.hash)) {
    throw new Error('economic_state_finalized_block_invalid');
  }
  const blockTimestampBig = parseRpcQuantity(block.timestamp, 'finalized_block.timestamp');
  if (blockTimestampBig > BigInt(Number.MAX_SAFE_INTEGER)
    || blockTimestampBig > agreedHeadTimestampBig) {
    throw new Error('economic_state_block_timestamp_unsafe');
  }

  // EIP-1898 binds every call to the exact agreed canonical block hash. A
  // number tag would permit a reorg between the header read and eth_call to
  // commit state from block B under block A's hash.
  const blockReference = Object.freeze({
    blockHash: block.hash.toLowerCase(),
    requireCanonical: true as const,
  });
  const call = (name: string, args: readonly unknown[] = []) => agreedContractCall(
    legs,
    contractAddress,
    pvtInterface,
    name,
    args,
    blockReference,
  );
  const [
    breakerResult,
    epochResult,
    mintedResult,
    hardCapResult,
    rateResult,
    stakeResult,
    foundationResult,
    zeroHashWeightResult,
    registryResult,
    durationResult,
    ...historyResults
  ] = await Promise.all([
    call('circuitBreakerTripped'),
    call('currentEpoch'),
    call('currentEpochMinted'),
    call('GENESIS_EPOCH_HARD_CAP'),
    call('effectiveMintRate'),
    call('stakeRatioBps'),
    call('getCurrentAgentFoundationBPS'),
    call('peWeights', [ethers.ZeroHash]),
    call('registry'),
    call('epochDuration'),
    ...Array.from({ length: PVT_EPOCH_HISTORY_SIZE }, (_, index) =>
      call('epochMintHistory', [index])),
  ]);
  const currentEpoch = BigInt(epochResult[0]);
  const rawZeroHashWeight = BigInt(zeroHashWeightResult[0]);
  const zeroHashPeWeightBps = rawZeroHashWeight === 0n ? 10_000n : rawZeroHashWeight;
  if (zeroHashPeWeightBps < 5_000n || zeroHashPeWeightBps > 30_000n) {
    throw new Error('economic_state_zero_hash_pe_weight_invalid');
  }
  const epochStartResult = await call('epochs', [currentEpoch]);
  const registryAddress = String(registryResult[0]).toLowerCase();
  if (!ethers.isAddress(registryAddress) || registryAddress === ethers.ZeroAddress) {
    throw new Error('economic_state_registry_invalid');
  }

  const beneficiaryResults = await Promise.all(normalizedBeneficiaries.map(async (address) => {
    const result = await agreedContractCall(
      legs,
      registryAddress,
      registryInterface,
      'isHumanBeneficiaryChain',
      [address],
      blockReference,
    );
    return Object.freeze({ address, isHuman: Boolean(result[0]) });
  }));
  const batchMintedResult = options.batchId === undefined
    ? null
    : await call('batchMinted', [options.batchId]);

  const restrictiveTipEvidence = await readRestrictiveTipEvidence(legs, {
    contractAddress: contractAddress.toLowerCase(),
    registryAddress,
    finalizedBlockNumber: Number(blockNumberBig),
    agreedHeadBlockNumber: Number(agreedHeadBlockNumberBig),
    agreedHeadBlockHash: agreedHeadBlock.hash,
    currentEpoch,
    currentEpochMinted: BigInt(mintedResult[0]),
    batchId: options.batchId?.toLowerCase() ?? null,
  });

  const headCanonicalRecheck = await readAgreedRaw(
    legs,
    'eth_getBlockByNumber',
    [agreedHeadTag, false],
    'agreed_head_canonical_recheck',
  ) as RpcBlock | null;
  if (!headCanonicalRecheck
    || parseRpcQuantity(headCanonicalRecheck.number, 'head_recheck.number')
      !== agreedHeadBlockNumberBig
    || typeof headCanonicalRecheck.hash !== 'string'
    || headCanonicalRecheck.hash.toLowerCase() !== agreedHeadBlock.hash.toLowerCase()
    || parseRpcQuantity(headCanonicalRecheck.timestamp, 'head_recheck.timestamp')
      !== agreedHeadTimestampBig) {
    throw new Error('economic_state_agreed_head_not_canonical');
  }

  const canonicalRecheck = await readAgreedRaw(
    legs,
    'eth_getBlockByNumber',
    [blockTag, false],
    'finalized_block_canonical_recheck',
  ) as RpcBlock | null;
  if (!canonicalRecheck
    || parseRpcQuantity(canonicalRecheck.number, 'canonical_recheck.number') !== blockNumberBig
    || typeof canonicalRecheck.hash !== 'string'
    || canonicalRecheck.hash.toLowerCase() !== block.hash.toLowerCase()
    || parseRpcQuantity(canonicalRecheck.timestamp, 'canonical_recheck.timestamp')
      !== blockTimestampBig) {
    throw new Error('economic_state_finalized_block_not_canonical');
  }

  const withoutHash: Omit<BaseEconomicStateSnapshot, 'snapshotHash'> = {
    schemaVersion: 'base-economic-state/v2',
    chainId: BASE_ECONOMIC_STATE_CHAIN_ID,
    contractAddress: contractAddress.toLowerCase(),
    blockNumber: Number(blockNumberBig),
    blockHash: block.hash.toLowerCase(),
    blockTimestamp: Number(blockTimestampBig),
    agreedHeadBlockNumber: Number(agreedHeadBlockNumberBig),
    agreedHeadBlockHash: agreedHeadBlock.hash.toLowerCase(),
    agreedHeadBlockTimestamp: Number(agreedHeadTimestampBig),
    confirmationDepth: BASE_ECONOMIC_FINALITY_CONFIRMATIONS,
    providerOperatorIds: [legs[0].operatorId, legs[1].operatorId],
    canonicalityEvidence: Object.freeze({
      schemaVersion: 'base-economic-state-canonicality/v1',
      finalizedBlockRecheckedAfterCalls: true,
      agreedHeadRecheckedAfterTipReads: true,
      eip1898BlockHash: block.hash.toLowerCase(),
      eip1898RequireCanonical: true,
    }),
    restrictiveTipEvidence,
    circuitBreakerTripped: Boolean(breakerResult[0]),
    currentEpoch,
    currentEpochMinted: BigInt(mintedResult[0]),
    epochMintHistory: Object.freeze(historyResults.map((result) => BigInt(result[0]))),
    genesisEpochHardCap: BigInt(hardCapResult[0]),
    effectiveMintRate: BigInt(rateResult[0]),
    stakeRatioBps: BigInt(stakeResult[0]),
    currentAgentFoundationBps: BigInt(foundationResult[0]),
    zeroHashPeWeightBps,
    registryAddress,
    epochDuration: BigInt(durationResult[0]),
    currentEpochStartTime: BigInt(epochStartResult[0]),
    batchId: options.batchId?.toLowerCase() ?? null,
    batchMinted: batchMintedResult === null ? null : Boolean(batchMintedResult[0]),
    humanBeneficiaryClassifications: Object.freeze(beneficiaryResults),
    observedAtMs: (options.now ?? Date.now)(),
  };
  const snapshot = Object.freeze({
    ...withoutHash,
    snapshotHash: hashBaseEconomicStateSnapshot(withoutHash),
  });
  return assertBaseEconomicStateSnapshot(snapshot, {
    contractAddress,
    batchId: options.batchId ?? null,
  });
}
