import { readRestorationLineage } from './restoration-lineage';
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { Interface } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { RESTORATION_REQUESTS } from './restoration-request';
import { parseRestorationScope, type RestorationScope } from './owner-operation';
import { collectRestorationEvidence, restorationEvidencePort, assertRestorationEvidence, type CheckedRestorationEvidence } from './restoration-evidence';
import { traceRestoration, type TracedTransfer, type RestorationTrace } from './restoration-trace';
import { readRecoursePoolState, type RecoursePoolState } from './pool-state';
import type { LossSnapshot } from './loss-snapshot';
import type { LossMembershipEvidence } from './membership-at-loss';
const digest = (value: unknown): string => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
export interface RestorationTicket extends RestorationScope { readonly identity: string; readonly destination: string; readonly currentDestination:string; }
const abi = new Interface([
  'function ownerAuthorization() view returns(address)',
  'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
  'function reversalExecuted(bytes32) view returns(bool)', 'function recoveredDestination(bytes32) view returns(address)',
]);
async function readTicket(kernel: string, request: string): Promise<RestorationTicket> {
  const deployment = await currentProtocolDeployment();
  const lineage=await readRestorationLineage(kernel);
  if(lineage.manifestHash!==deployment.manifestHash)throw Error('recourse_determination_checkpoint_changed');
  kernel=lineage.kernel;
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const call = async (target: string, method: string, args: readonly unknown[]) => {
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: target,
      data: abi.encodeFunctionData(method, args) }, { blockHash: deployment.blockHash, requireCanonical: true }])));
    if (typeof values[0] !== 'string' || !rpcChainFactsEqual(values[0], values[1])) throw new Error('recourse_determination_rpc_disagreement');
    return abi.decodeFunctionResult(method, values[0]);
  };
  const executor = String((await call(kernel, 'ownerAuthorization', []))[0]).toLowerCase();
  const row = (await call(executor, 'restorationIntent', [request]))[0];
  const scope = parseRestorationScope({ request: String(row.request), lossHash: String(row.lossHash), maximumLoss: String(row.maximumLoss) });
  const identity = String(row.identity).toLowerCase(), destination = String(row.destination).toLowerCase();
  const currentDestination=String((await call(executor,'recoveredDestination',[identity]))[0]).toLowerCase();
  if (scope.request !== request || (await call(executor, 'reversalExecuted', [request]))[0]
    || !/^0x[0-9a-f]{40}$/.test(currentDestination)||/^0x0+$/.test(currentDestination)) throw new Error('recourse_determination_ticket_unavailable');
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_determination_checkpoint_changed');
  return { ...scope, identity, destination, currentDestination };
}
export interface DeterminationPorts {
  ticket(kernel: string, request: string): Promise<RestorationTicket>;
  evidence(snapshot: LossSnapshot): Promise<CheckedRestorationEvidence>;
  pool(identity: string): Promise<RecoursePoolState>;
}
export interface DeterminationPacket {
  readonly request: string; readonly ticket: RestorationTicket; readonly snapshot: LossSnapshot;
  readonly membership: LossMembershipEvidence & { readonly lossTimestamp: number };
  readonly evidence: CheckedRestorationEvidence; readonly poolRevision: string; readonly packetHash: string;
}
const packets = new WeakSet<DeterminationPacket>();
/** The operator reviews independently observed facts. A request or a missing
 * signing-device record is not itself a theft finding. */
export async function prepareDetermination(db: Firestore, request: string, supplied?: DeterminationPorts, checkpointBlock?:number): Promise<DeterminationPacket> {
  if (!/^0x[0-9a-f]{64}$/.test(request)) throw new Error('recourse_determination_request_invalid');
  const ports = supplied ?? { ticket: readTicket, evidence: (snapshot: LossSnapshot) => collectRestorationEvidence(snapshot, restorationEvidencePort(db),checkpointBlock), pool: readRecoursePoolState };
  const record = await db.collection(RESTORATION_REQUESTS).doc(request).get();
  if (!record.exists || !['awaiting_determination', 'under_determination'].includes(String(record.get('status')))) throw new Error('recourse_determination_not_authorized');
  const snapshot = record.get('snapshot') as LossSnapshot;
  const membership = record.get('membership') as DeterminationPacket['membership'];
  if (!snapshot || !membership || snapshot.occurrence !== request || snapshot.identity !== record.get('identity')
    || !membership.active || membership.periodIndex === null) throw new Error('recourse_determination_record_invalid');
  const ticket = await ports.ticket(snapshot.kernel, request);
  if (ticket.identity !== snapshot.identity || ticket.destination !== record.get('destination')
    || ticket.maximumLoss !== snapshot.lossAtomic || ticket.lossHash !== digest({ snapshot, membership })) throw new Error('recourse_determination_scope_mismatch');
  const [evidence, pool] = await Promise.all([ports.evidence(snapshot), ports.pool(ticket.identity)]);
  assertRestorationEvidence(evidence);
  const content = { request, ticket, snapshot, membership, evidence, poolRevision: pool.outcomeRevision };
  // The pool's concurrency nonce is execution state, not evidence about the
  // reported loss. Another determination may advance it during review without
  // changing this adjudication's facts or requiring another owner signature.
  const packet = { ...content, packetHash: digest({ request, ticket, snapshot, membership, evidence }) };
  freeze(packet); packets.add(packet); return packet;
}
export interface ReceiptFinding {
  readonly transactionHash: string; readonly logIndex: number;
  readonly conclusion: 'theft_taker' | 'gratuitous' | 'witnessed_exchange';
  readonly evidenceHashes: readonly string[]; readonly reasoning: string;
}
export interface RestorationJudgment {
  readonly packetHash: string;
  readonly finding: 'accepted_theft' | 'declined_not_theft' | 'declined_insufficient_evidence';
  /** The adjudicator's discretionary inference, distinct from the chain facts. */
  readonly reasoning: string; readonly evidenceHashes: readonly string[]; readonly receipts: readonly ReceiptFinding[];
}
export interface CheckedDetermination {
  readonly packet: DeterminationPacket; readonly judgment: RestorationJudgment;
  readonly trace: RestorationTrace; readonly accepted: boolean; readonly evidenceHash: string;
}
const determinations = new WeakSet<CheckedDetermination>();
export function assertCheckedDetermination(value: CheckedDetermination): void {
  if (!determinations.has(value)) throw new Error('recourse_determination_unverified');
}
/** This is an operator adjudication boundary, never a member request body.
 * Existing exchange evidence cannot be overridden. Positive recipient findings
 * must name the occurrence, its chain witness and the adjudicator's reasoning;
 * absence of an exchange record is never automatically a gift finding. */
export function assessRestoration(packet: DeterminationPacket, judgment: RestorationJudgment): CheckedDetermination {
  if (!packets.has(packet) || judgment.packetHash !== packet.packetHash || typeof judgment.reasoning !== 'string' || !judgment.reasoning.trim()
    || !['accepted_theft', 'declined_not_theft', 'declined_insufficient_evidence'].includes(judgment.finding)) throw new Error('recourse_determination_judgment_invalid');
  const hashes = new Set([packet.snapshot.evidenceHash, packet.membership.evidenceHash,
    ...packet.evidence.checkpoint.transfers.map(event => event.witnessHash), ...packet.evidence.checkpoint.ownerAliases.map(alias => alias.evidenceHash)]);
  const referencesValid = (refs: readonly string[]) => Array.isArray(refs) && refs.length > 0 && refs.every(ref => hashes.has(ref));
  if (!referencesValid(judgment.evidenceHashes) || !Array.isArray(judgment.receipts)) throw new Error('recourse_determination_evidence_unknown');
  const findings = new Map<string, ReceiptFinding>();
  const losses = new Set(packet.snapshot.outflows.map(event => `${event.transactionHash}:${event.logIndex}`));
  for (const finding of judgment.receipts) {
    const key = `${finding.transactionHash}:${finding.logIndex}`;
    const event = packet.evidence.checkpoint.transfers.find(event => event.transactionHash === finding.transactionHash && event.logIndex === finding.logIndex);
    if (!event || event.receipt === 'custody_succession' || findings.has(key) || typeof finding.reasoning !== 'string' || !finding.reasoning.trim() || !referencesValid(finding.evidenceHashes)
      || !finding.evidenceHashes.includes(event.witnessHash) || !['theft_taker','gratuitous','witnessed_exchange'].includes(finding.conclusion)
      || (finding.conclusion === 'theft_taker' && !losses.has(key))
      || (event.receipt === 'witnessed_exchange' && finding.conclusion !== 'witnessed_exchange')) throw new Error('recourse_determination_receipt_invalid');
    findings.set(key, finding);
  }
  const transfers: TracedTransfer[] = packet.evidence.checkpoint.transfers.map(event => {
    const finding = findings.get(`${event.transactionHash}:${event.logIndex}`);
    return finding ? { ...event, receipt: finding.conclusion === 'theft_taker' ? 'gratuitous' : finding.conclusion } : event;
  });
  const trace = traceRestoration(packet.snapshot, { ...packet.evidence.checkpoint, transfers });
  if (BigInt(trace.reversibleAtomic) + BigInt(trace.shortfallAtomic) > BigInt(packet.ticket.maximumLoss)) throw new Error('recourse_determination_loss_exceeded');
  const accepted = judgment.finding === 'accepted_theft';
  if (!accepted && judgment.receipts.length !== 0) throw new Error('recourse_determination_decline_has_sources');
  const determination = { packet, judgment, trace, accepted,
    evidenceHash: digest({ rule: 'provian discretionary restoration', packetHash: packet.packetHash, judgment, trace, accepted }) };
  freeze(determination); determinations.add(determination); return determination;
}
