import { AbiCoder, Interface, sha256 } from 'ethers';
import { assertCheckedDetermination, type CheckedDetermination } from './determination';
import { utcCalendarMonth } from './calendar-month';
import { RECOURSE_POOL_ABI } from './pool-abi';
export const REVERSAL_TUPLE = 'tuple(bytes32 request,bytes32 identity,address destination,address[] sources,uint256[] amounts,uint256[] sourceSequences,address[] observationAccounts,uint256[] observationSequences,uint256 poolShortfall,bytes32 evidenceHash)';
export const THEFT_EVIDENCE_TUPLE = 'tuple(address kernel,bytes32 operation,bytes32 identity,address lossAccount,uint256 lossBlock,bytes32 checkpointHash,bytes32 membershipHash,uint256 revision,uint256 bindingLogIndex,uint256 lossLogIndex)';
export const RESTORATION_EXECUTION_ABI = new Interface([
  `function executeRestorationIntent(${REVERSAL_TUPLE} reversal,uint256 revision)`,
  `function admitTheftEvidence(${THEFT_EVIDENCE_TUPLE} evidence,bytes signature)`,
  `function evidenceDigest(${THEFT_EVIDENCE_TUPLE} evidence) view returns(bytes32)`,
]);
/** Calldata derivation only; it has no signing or broadcast capability. Each
 * worker step independently revalidates the current pointer and chain state. */
export function determinationPlan(value: CheckedDetermination, execution: {
  readonly revision: bigint; readonly registry: string; readonly bindingLogIndex: number;
}) {
  assertCheckedDetermination(value);
  if (execution.revision < 1n || !/^0x[0-9a-f]{40}$/.test(execution.registry)
    || !Number.isSafeInteger(execution.bindingLogIndex) || execution.bindingLogIndex < 0) throw new Error('recourse_determination_domain_invalid');
  const { packet, trace } = value, coder = AbiCoder.defaultAbiCoder();
  const record = { request: packet.request, identity: packet.ticket.identity, occurrence: packet.snapshot.occurrence,
    shortfall: value.accepted ? trace.shortfallAtomic : '0', evidenceHash: value.evidenceHash,
    expectedRevision: packet.poolRevision, membershipGeneration: packet.membership.periodIndex! + 1,
    lossBlock: packet.snapshot.block, lossMonth: utcCalendarMonth(packet.membership.lossTimestamp) };
  if (!value.accepted) return { accepted: false as const, record, poolCall: RECOURSE_POOL_ABI.encodeFunctionData('decline',[record]) };
  const observations = [...packet.evidence.checkpoint.accounts].sort((a,b)=>a.address.localeCompare(b.address));
  const reversal = { request:packet.request, identity:packet.ticket.identity, destination:packet.ticket.currentDestination,
    sources:trace.sources.map(source=>source.address), amounts:trace.sources.map(source=>source.amountAtomic),
    sourceSequences:trace.sources.map(source=>source.outgoingSequence),
    observationAccounts:observations.map(row=>row.address), observationSequences:observations.map(row=>row.outgoingSequence), poolShortfall:trace.shortfallAtomic, evidenceHash:value.evidenceHash };
  const scopeHash = sha256(coder.encode(['string','tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss)'],
    ['Provian bounded restoration intent', packet.ticket]));
  const operation = sha256(coder.encode(['string','bytes32',REVERSAL_TUPLE],['Provian scoped theft reversal',scopeHash,reversal]));
  const first = packet.snapshot.outflows[0];
  if (!first) throw new Error('recourse_determination_loss_missing');
  const evidence = { kernel:packet.evidence.executionKernel, operation, identity:packet.ticket.identity, lossAccount:first.from,
    lossBlock:packet.snapshot.block, checkpointHash:packet.evidence.checkpoint.blockHash, membershipHash:packet.membership.evidenceHash,
    revision:execution.revision, bindingLogIndex:execution.bindingLogIndex, lossLogIndex:packet.snapshot.firstOutflowLogIndex };
  // Sign the 32-byte value, never its textual hex representation. The registry
  // adds the EIP-191 prefix and verifies the independent attestor itself.
  const attestationMessage = sha256(coder.encode(['string','uint256','address',THEFT_EVIDENCE_TUPLE],
    ['Provian theft evidence',8453,execution.registry,evidence]));
  return { accepted:true as const, record, reversal, operation, evidence, attestationMessage,
    reversalCall:RESTORATION_EXECUTION_ABI.encodeFunctionData('executeRestorationIntent',[reversal,execution.revision]),
    poolCall:trace.shortfallAtomic==='0' ? RECOURSE_POOL_ABI.encodeFunctionData('recordReversalOnly',[record]) : null,
    deliveryCall:trace.shortfallAtomic==='0' ? null : RECOURSE_POOL_ABI.encodeFunctionData('deliverRestoration',[packet.request,packet.ticket.identity]) };
}
