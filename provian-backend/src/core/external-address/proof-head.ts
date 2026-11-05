/** Operator-bound, exact-block evidence for external-wallet proof fencing. */

import { ethers } from 'ethers';

import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from '../onchain/economic-constants';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const EIP1271_ABI = [
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
];
const EIP1271_INTERFACE = new ethers.Interface(EIP1271_ABI);
const PROOF_FENCE_KEYS = Object.freeze([
  'chainId',
  'minActivityConfirmations',
  'observedHeadBlock',
  'proofBlockHash',
  'proofBlockNumber',
  'provenAtBlock',
  'rpcOperatorIds',
  'schemaVersion',
] as const);

export interface ExternalProofFenceEvidence {
  readonly schemaVersion: 'external-proof-fence/v1';
  readonly chainId: 8453;
  /** Agreed latest head when the finalized proof block was selected. */
  readonly observedHeadBlock: number;
  /** Exact state block used for code, EIP-1271, and baseline nonce reads. */
  readonly proofBlockNumber: number;
  readonly proofBlockHash: string;
  /** Activity is eligible only after the agreed latest head. */
  readonly provenAtBlock: number;
  readonly minActivityConfirmations: typeof BASE_ECONOMIC_FINALITY_CONFIRMATIONS;
  readonly rpcOperatorIds: readonly [string, string];
}

export interface ExternalProofRpcOptions {
  readonly rpcLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg];
}

function legs(options: ExternalProofRpcOptions): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  if (options.rpcLegs) {
    if (options.rpcLegs[0].operatorId === options.rpcLegs[1].operatorId) {
      throw new Error('external_proof_operators_not_independent');
    }
    return options.rpcLegs;
  }
  const configured = getOperatorBoundRpcLegs('base');
  return [
    {
      operatorId: configured[0].operatorId,
      send: (method, params) => configured[0].provider.send(method, [...params]),
    },
    {
      operatorId: configured[1].operatorId,
      send: (method, params) => configured[1].provider.send(method, [...params]),
    },
  ];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function agreed(
  rpcLegs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  method: string,
  params: readonly unknown[],
  label: string,
): Promise<unknown> {
  const [left, right] = await Promise.all([
    rpcLegs[0].send(method, params),
    rpcLegs[1].send(method, params),
  ]);
  if (canonical(left) !== canonical(right)) {
    throw new Error(`external_proof_rpc_disagreement:${label}`);
  }
  return left;
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`external_proof_quantity_invalid:${label}`);
  }
  return BigInt(value);
}

function safeNumber(value: unknown, label: string): number {
  const parsed = quantity(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`external_proof_number_unsafe:${label}`);
  }
  return Number(parsed);
}

async function assertBaseChain(
  rpcLegs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
): Promise<void> {
  const chainId = quantity(await agreed(rpcLegs, 'eth_chainId', [], 'chain_id'), 'chain_id');
  if (chainId !== 8453n) throw new Error(`external_proof_chain_mismatch:${chainId}`);
}

interface ExactBlock {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly stateRoot: string;
}

async function exactBlock(
  rpcLegs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg],
  blockNumber: number,
): Promise<ExactBlock> {
  const params = [ethers.toQuantity(blockNumber), false] as const;
  const [leftRaw, rightRaw] = await Promise.all([
    rpcLegs[0].send('eth_getBlockByNumber', params),
    rpcLegs[1].send('eth_getBlockByNumber', params),
  ]);
  const left = parseExactBlock(leftRaw, blockNumber);
  const right = parseExactBlock(rightRaw, blockNumber);
  if (canonical(left) !== canonical(right)) {
    throw new Error(`external_proof_rpc_disagreement:block:${blockNumber}`);
  }
  return left;
}

function parseExactBlock(raw: unknown, blockNumber: number): ExactBlock {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('external_proof_block_unavailable');
  }
  const block = raw as Record<string, unknown>;
  if (safeNumber(block.number, 'block.number') !== blockNumber
    || typeof block.hash !== 'string' || !HASH.test(block.hash)
    || typeof block.parentHash !== 'string' || !HASH.test(block.parentHash)
    || typeof block.stateRoot !== 'string' || !HASH.test(block.stateRoot)) {
    throw new Error('external_proof_block_invalid');
  }
  return Object.freeze({
    number: blockNumber,
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    stateRoot: block.stateRoot.toLowerCase(),
  });
}

export function assertExternalProofFenceEvidence(
  value: ExternalProofFenceEvidence | undefined,
): ExternalProofFenceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('external_proof_fence_evidence_invalid');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...PROOF_FENCE_KEYS].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || value.schemaVersion !== 'external-proof-fence/v1'
    || value.chainId !== 8453
    || !Number.isSafeInteger(value.observedHeadBlock)
    || value.observedHeadBlock < BASE_ECONOMIC_FINALITY_CONFIRMATIONS
    || value.observedHeadBlock >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(value.proofBlockNumber)
    || value.proofBlockNumber < 1
    || value.proofBlockNumber
      !== value.observedHeadBlock - BASE_ECONOMIC_FINALITY_CONFIRMATIONS + 1
    || !HASH.test(value.proofBlockHash)
    || value.proofBlockHash !== value.proofBlockHash.toLowerCase()
    || !Number.isSafeInteger(value.provenAtBlock)
    || value.provenAtBlock !== value.observedHeadBlock + 1
    || value.minActivityConfirmations !== BASE_ECONOMIC_FINALITY_CONFIRMATIONS
    || !Array.isArray(value.rpcOperatorIds)
    || value.rpcOperatorIds.length !== 2
    || typeof value.rpcOperatorIds[0] !== 'string'
    || value.rpcOperatorIds[0].length === 0
    || typeof value.rpcOperatorIds[1] !== 'string'
    || value.rpcOperatorIds[1].length === 0
    || value.rpcOperatorIds[0] === value.rpcOperatorIds[1]) {
    throw new Error('external_proof_fence_evidence_invalid');
  }
  return value;
}

export async function selectExternalProofFence(
  options: ExternalProofRpcOptions = {},
): Promise<ExternalProofFenceEvidence> {
  const rpcLegs = legs(options);
  await assertBaseChain(rpcLegs);
  const observedHeadBlock = safeNumber(
    await agreed(rpcLegs, 'eth_blockNumber', [], 'latest_head'),
    'latest_head',
  );
  const proofBlockNumber = observedHeadBlock - BASE_ECONOMIC_FINALITY_CONFIRMATIONS + 1;
  if (proofBlockNumber < 1) throw new Error('external_proof_head_not_final');
  const block = await exactBlock(rpcLegs, proofBlockNumber);
  const evidence: ExternalProofFenceEvidence = {
    schemaVersion: 'external-proof-fence/v1',
    chainId: 8453,
    observedHeadBlock,
    proofBlockNumber,
    proofBlockHash: block.hash,
    provenAtBlock: observedHeadBlock + 1,
    minActivityConfirmations: BASE_ECONOMIC_FINALITY_CONFIRMATIONS,
    rpcOperatorIds: [rpcLegs[0].operatorId, rpcLegs[1].operatorId],
  };
  return Object.freeze(assertExternalProofFenceEvidence(evidence));
}

function boundLegs(
  evidence: ExternalProofFenceEvidence,
  options: ExternalProofRpcOptions,
): readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] {
  const verified = assertExternalProofFenceEvidence(evidence);
  const rpcLegs = legs(options);
  if (rpcLegs[0].operatorId !== verified.rpcOperatorIds[0]
    || rpcLegs[1].operatorId !== verified.rpcOperatorIds[1]) {
    throw new Error('external_proof_operator_binding_changed');
  }
  return rpcLegs;
}

function proofBlockReference(
  evidence: ExternalProofFenceEvidence,
): Readonly<{ blockHash: string; requireCanonical: true }> {
  const verified = assertExternalProofFenceEvidence(evidence);
  return Object.freeze({
    blockHash: verified.proofBlockHash.toLowerCase(),
    requireCanonical: true as const,
  });
}

export async function revalidateExternalProofFence(
  evidence: ExternalProofFenceEvidence,
  options: ExternalProofRpcOptions = {},
): Promise<void> {
  const rpcLegs = boundLegs(evidence, options);
  await assertBaseChain(rpcLegs);
  const latest = safeNumber(
    await agreed(rpcLegs, 'eth_blockNumber', [], 'latest_head'),
    'latest_head',
  );
  if (latest < evidence.observedHeadBlock
    || latest - evidence.proofBlockNumber + 1 < BASE_ECONOMIC_FINALITY_CONFIRMATIONS) {
    throw new Error('external_proof_head_not_final');
  }
  const block = await exactBlock(rpcLegs, evidence.proofBlockNumber);
  if (block.hash !== evidence.proofBlockHash.toLowerCase()) {
    throw new Error('external_proof_block_reorged');
  }
}

export async function readExternalProofCode(
  address: string,
  evidence: ExternalProofFenceEvidence,
  options: ExternalProofRpcOptions = {},
): Promise<string> {
  if (!ethers.isAddress(address)) throw new Error('external_proof_address_invalid');
  const rpcLegs = boundLegs(evidence, options);
  const code = await agreed(rpcLegs, 'eth_getCode', [
    address.toLowerCase(),
    proofBlockReference(evidence),
  ], 'get_code');
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) {
    throw new Error('external_proof_code_invalid');
  }
  return code.toLowerCase();
}

export async function readExternalProofNonce(
  address: string,
  evidence: ExternalProofFenceEvidence,
  options: ExternalProofRpcOptions = {},
): Promise<number> {
  if (!ethers.isAddress(address)) throw new Error('external_proof_address_invalid');
  const rpcLegs = boundLegs(evidence, options);
  return safeNumber(await agreed(rpcLegs, 'eth_getTransactionCount', [
    address.toLowerCase(),
    proofBlockReference(evidence),
  ], 'baseline_nonce'), 'baseline_nonce');
}

export async function callExternalProofEip1271(
  address: string,
  digest: string,
  signature: string,
  evidence: ExternalProofFenceEvidence,
  options: ExternalProofRpcOptions = {},
): Promise<string> {
  if (!ethers.isAddress(address) || !HASH.test(digest)
    || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('external_proof_eip1271_input_invalid');
  }
  const rpcLegs = boundLegs(evidence, options);
  const data = EIP1271_INTERFACE.encodeFunctionData('isValidSignature', [digest, signature]);
  const raw = await agreed(rpcLegs, 'eth_call', [{
    to: address.toLowerCase(),
    data,
  }, proofBlockReference(evidence)], 'eip1271');
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) {
    throw new Error('external_proof_eip1271_result_invalid');
  }
  const decoded = EIP1271_INTERFACE.decodeFunctionResult('isValidSignature', raw);
  return String(decoded[0]).toLowerCase();
}
