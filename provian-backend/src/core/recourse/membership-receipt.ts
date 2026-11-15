import { hasRecourseConfirmations } from './transaction-finality';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { MEMBERSHIP_AUTHORIZATION_ABI } from './membership-authorization';
import { MEMBERSHIP_ISSUANCE_ABI } from './issuance-ticket';

const POINTER = new Interface(['function revision() view returns(uint256)',
  'function current() view returns(uint256,bytes32,address[10],bytes32[10])',
  'event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
export const MEMBERSHIP_BATCH_ABI = new Interface(['function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
export const MEMBERSHIP_RECEIPT_ABI = new Interface([
  ...MEMBERSHIP_AUTHORIZATION_ABI.fragments.filter(f => f.type === 'event'),
  ...MEMBERSHIP_ISSUANCE_ABI.fragments.filter(f => f.type === 'event'),
]);
export interface MembershipReceiptEvent {
  readonly name: 'AddressConsentChanged' | 'AddressConsentRenewed' | 'MembershipDebitExecuted' | 'MembershipDebitCancelled'
    | 'IssuanceTicketConsumed' | 'IssuanceBatchCancelled';
  readonly logIndex: number; readonly topics: readonly string[]; readonly data: string;
  readonly kernel: string; readonly pool: string; readonly revision: string; readonly manifestHash: string;
  readonly settlement?: { readonly batchId: string; readonly lane: number; readonly epoch: string;
    readonly policyHash: string; readonly settlementDigest: string };
}
export interface VerifiedMembershipReceipt {
  readonly pointer: string; readonly chainId: '8453';
  readonly transactionHash: string; readonly block: number; readonly blockHash: string;
  readonly timestamp: number; readonly events: readonly MembershipReceiptEvent[];
}
const authentic = new WeakSet<object>();
export function assertMembershipReceipt(receipt: VerifiedMembershipReceipt): void {
  if (!authentic.has(receipt)) throw Error('recourse_membership_receipt_unverified');
}
const invalid = (reason = 'invalid'): never => { throw Error(`recourse_membership_receipt_${reason}`); };
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function hash(value: unknown): string {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : invalid();
}
function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return invalid();
  const n = Number(BigInt(value));
  return Number.isSafeInteger(n) ? n : invalid();
}
function address(value: unknown): string {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : invalid();
}
interface Log {
  readonly address: string; readonly topics: string[]; readonly data: string;
  readonly logIndex: number; readonly transactionHash: string;
}
function logAt(value: unknown, block: number, blockHash: string): Log {
  const l = object(value);
  if (l.removed !== false || quantity(l.blockNumber) !== block || l.blockHash !== blockHash
    || !Array.isArray(l.topics) || typeof l.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(l.data)) return invalid();
  return { address: address(l.address), topics: l.topics.map(hash), data: l.data,
    logIndex: quantity(l.logIndex), transactionHash: hash(l.transactionHash) };
}

/** Verify actual finalized pool effects, including nested account calls. A status
 * bit, a caller-supplied verification flag, or today's deployment is insufficient.
 * Publication events establish the manifest at the exact log position, including
 * multiple pointer changes within one block. No owner portfolio enters this proof. */
export async function readMembershipReceipt(transactionHash: string, poolAddress: string): Promise<VerifiedMembershipReceipt> {
  hash(transactionHash); const pool = address(poolAddress);
  const pointer = PROTOCOL_POINTER_PIN.address;
  const runtimeHash = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !runtimeHash) return invalid('pointer_missing');
  const configured = getOperatorBoundRpcLegs('base');
  const legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] = [
    { operatorId: configured[0].operatorId, send: (m, p) => configured[0].provider.send(m, [...p]) },
    { operatorId: configured[1].operatorId, send: (m, p) => configured[1].provider.send(m, [...p]) },
  ];
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) return invalid('operators');
  const agreed = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const [a, b] = await Promise.all(legs.map(l => l.send(method, params)));
    if (!rpcChainFactsEqual(a, b)) return invalid('disagreement');
    return a;
  };
  if (quantity(await agreed('eth_chainId', [])) !== 8453) return invalid('chain');
  const raw = object(await agreed('eth_getTransactionReceipt', [transactionHash]));
  if (raw.transactionHash !== transactionHash || quantity(raw.status) !== 1 || !Array.isArray(raw.logs)) return invalid();
  const block = quantity(raw.blockNumber), blockHash = hash(raw.blockHash), tag = `0x${block.toString(16)}`;
  const pin = { blockHash, requireCanonical: true };
  const header = object(await agreed('eth_getBlockByNumber', [tag, false]));
  if (header.hash !== blockHash || quantity(header.number) !== block || !Array.isArray(header.transactions)
    || !header.transactions.includes(transactionHash)) return invalid('reorg');
  const timestamp = quantity(header.timestamp);
  for (const leg of legs) if (!hasRecourseConfirmations(BigInt(block), BigInt(quantity(await leg.send('eth_blockNumber', []))))) return invalid('pending');
  const pointerCode = await agreed('eth_getCode', [pointer, pin]);
  if (typeof pointerCode !== 'string' || keccak256(pointerCode) !== runtimeHash) return invalid('pointer_runtime');
  const logs = raw.logs.map(l => logAt(l, block, blockHash));
  let previous = -1;
  for (const l of logs) {
    if (l.transactionHash !== transactionHash || l.logIndex <= previous) return invalid('log_order');
    previous = l.logIndex;
  }
  const publicationsRaw = await agreed('eth_getLogs', [{ address: pointer,
    topics: [POINTER.getEvent('DeploymentChanged')!.topicHash], blockHash }]);
  if (!Array.isArray(publicationsRaw)) return invalid();
  const publications = publicationsRaw.map(l => logAt(l, block, blockHash));
  previous = -1;
  for (const l of publications) {
    if (l.address !== pointer.toLowerCase() || l.logIndex <= previous
      || !header.transactions.includes(l.transactionHash)) return invalid('publication');
    previous = l.logIndex;
  }
  if (block === 0) return invalid('publication');
  const priorHeader = object(await agreed('eth_getBlockByNumber', [`0x${(block - 1).toString(16)}`, false]));
  if (quantity(priorHeader.number) !== block - 1 || hash(header.parentHash) !== priorHeader.hash) return invalid('publication');
  const priorHash = hash(priorHeader.hash), priorPin = { blockHash: priorHash, requireCanonical: true };
  const priorCode = await agreed('eth_getCode', [pointer, priorPin]);
  if (typeof priorCode !== 'string' || (priorCode !== '0x' && keccak256(priorCode) !== runtimeHash)) return invalid('pointer_runtime');
  const pointerRead = async (getter: 'current' | 'revision', at: typeof pin) => {
    const encoded = await agreed('eth_call', [{ to: pointer, data: POINTER.encodeFunctionData(getter) }, at]);
    if (typeof encoded !== 'string') return invalid('publication');
    return POINTER.decodeFunctionResult(getter, encoded);
  };
  const priorRevision = priorCode === '0x' ? 0n : BigInt((await pointerRead('revision', priorPin))[0]);
  const end = await pointerRead('current', pin);
  let expectedRevision = priorRevision;
  for (const publication of publications) {
    const changed = POINTER.parseLog(publication); if (!changed) return invalid('publication');
    if (BigInt(changed.args.revision) !== ++expectedRevision || keccak256(AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
      [8453, pointer, expectedRevision, changed.args.components, changed.args.runtimeHashes])) !== changed.args.manifestHash) return invalid('publication_gap');
  }
  if (BigInt(end[0]) !== expectedRevision) return invalid('publication_gap');
  const last = publications.at(-1);
  const expectedEnd = last ? POINTER.parseLog(last)!.args : await pointerRead('current', priorPin);
  if (AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32', 'address[10]', 'bytes32[10]'], Array.from(end))
    !== AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32', 'address[10]', 'bytes32[10]'], Array.from(expectedEnd))) return invalid('publication_gap');
  for (const l of logs.filter(l => l.address === pointer.toLowerCase() && l.topics[0] === POINTER.getEvent('DeploymentChanged')!.topicHash)) {
    if (!publications.some(p => JSON.stringify(p) === JSON.stringify(l))) return invalid('publication_gap');
  }
  const rpcs: readonly [PointerRpc, PointerRpc] = [
    { request: (m, p) => legs[0].send(m, p) }, { request: (m, p) => legs[1].send(m, p) },
  ];
  const before = async () => {
    if (block === 0) return invalid('publication');
    const d = await resolveHistoricalProtocolDeployment(rpcs, pointer, runtimeHash, block - 1, priorHash);
    return { revision: String(d.revision), manifestHash: d.manifestHash, kernel: d.addresses.kernel.toLowerCase(),
      pool: d.addresses.recoursePool.toLowerCase() };
  };
  let priorManifest: ReturnType<typeof before> | undefined;
  const manifests = new Map<number, { revision: string; manifestHash: string; kernel: string; pool: string }>();
  const settlements = new Map<string, NonNullable<MembershipReceiptEvent['settlement']>>();
  const events: MembershipReceiptEvent[] = [];
  for (const l of logs) {
    if (l.address !== pool) continue;
    const event = MEMBERSHIP_RECEIPT_ABI.parseLog(l); if (!event) continue;
    const publication = publications.filter(p => p.logIndex < l.logIndex).at(-1);
    let manifest;
    if (!publication) manifest = await (priorManifest ??= before());
    else {
      manifest = manifests.get(publication.logIndex);
      if (!manifest) {
        const changed = POINTER.parseLog(publication); if (!changed) return invalid('publication');
        const targets = Array.from(changed.args.components, address), hashes = Array.from(changed.args.runtimeHashes, hash);
        const revision = BigInt(changed.args.revision), manifestHash = hash(changed.args.manifestHash);
        if (revision === 0n || new Set(targets).size !== 10 || keccak256(AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'], [8453, pointer, revision, targets, hashes])) !== manifestHash) return invalid('manifest');
        // The authentic pointer event pins all runtime bytes. Validate the money
        // path's immutable wiring at this canonical block as well.
        for (const slot of [0, 8, 9]) {
          const code = await agreed('eth_getCode', [targets[slot], pin]);
          if (typeof code !== 'string' || code === '0x' || keccak256(code) !== hashes[slot]) return invalid('component_runtime');
        }
        for (const [slot, getter, target] of [[0, 'protocolPointer', pointer], [8, 'pointer', pointer], [8, 'token', targets[0]],
          [8, 'settlement', targets[9]], [9, 'pointer', pointer], [9, 'kernel', targets[0]], [9, 'pool', targets[8]]] as const) {
          const abi = new Interface([`function ${getter}() view returns(address)`]);
          const encoded = await agreed('eth_call', [{ to: targets[slot], data: abi.encodeFunctionData(getter) }, pin]);
          if (typeof encoded !== 'string' || address(abi.decodeFunctionResult(getter, encoded)[0]) !== target.toLowerCase()) return invalid('component_binding');
        }
        manifest = { revision: String(revision), manifestHash, kernel: targets[0], pool: targets[8] };
        manifests.set(publication.logIndex, manifest);
      }
    }
    if (manifest.pool !== pool) return invalid('retired_pool');
    let settlement: MembershipReceiptEvent['settlement'];
    if (event.name === 'IssuanceTicketConsumed') {
      const batchId = hash(event.args.batchId), key = `${manifest.kernel}:${batchId}`;
      settlement = settlements.get(key);
      if (!settlement) {
        const encoded = await agreed('eth_call', [{ to: manifest.kernel, data: MEMBERSHIP_BATCH_ABI.encodeFunctionData('getBatchRecord', [batchId]) }, pin]);
        if (typeof encoded !== 'string') return invalid('batch');
        const r = MEMBERSHIP_BATCH_ABI.decodeFunctionResult('getBatchRecord', encoded)[0];
        if (r.settled !== true || (r.lane !== 0n && r.lane !== 1n)) return invalid('batch');
        settlement = Object.freeze({ batchId, lane: Number(r.lane), epoch: String(r.epoch),
          policyHash: hash(r.policyHash), settlementDigest: hash(r.settlementDigest) });
        settlements.set(key, settlement);
      }
    }
    events.push(Object.freeze({ ...manifest, name: event.name as MembershipReceiptEvent['name'],
      logIndex: l.logIndex, topics: Object.freeze([...l.topics]), data: l.data, ...(settlement ? { settlement } : {}) }));
  }
  if (events.length === 0) return invalid('no_effect');
  if (object(await agreed('eth_getBlockByNumber', [tag, false])).hash !== blockHash) return invalid('reorg');
  const result = Object.freeze({ pointer: pointer.toLowerCase(), chainId: '8453' as const,
    transactionHash, block, blockHash, timestamp, events: Object.freeze(events) });
  authentic.add(result); return result;
}
