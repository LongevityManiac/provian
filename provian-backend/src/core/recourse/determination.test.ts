import { encodePrivateRecord, decodePrivateRecord, privateStorageId } from '../provenance/private-store';
import { packetFixture } from './__test-helpers__/determination-fixture';
import { AbiCoder, Interface, sha256 } from 'ethers';
import { determinationPlan, RESTORATION_EXECUTION_ABI, REVERSAL_TUPLE } from './determination-plan';
import { recoveryOperationHash } from './owner-operation';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { fixture, address, hash } from './__test-helpers__/restoration-evidence-fixture';
import { collectRestorationEvidence } from './restoration-evidence';
import { RESTORATION_REQUESTS } from './restoration-request';
import { prepareDetermination, assessRestoration, assertCheckedDetermination, type DeterminationPorts, type RestorationJudgment } from './determination';
import type { RecoursePoolState } from './pool-state';
test('unknown recipients remain unreachable; an operator finding is distinct from the recorded facts',async()=>{
  const f=await packetFixture();
  const accepted=assessRestoration(f.packet,f.judgment);
  expect(accepted.trace).toMatchObject({sources:[],shortfallAtomic:'100'});
  const recipientFinding={transactionHash:f.event.transactionHash,logIndex:f.event.logIndex,conclusion:'theft_taker' as const,
    evidenceHashes:[f.transaction.evidenceHash],reasoning:'Affirmative determination naming the first taking; not inferred by the transfer parser.'};
  const reversed=assessRestoration(f.packet,{...f.judgment,receipts:[recipientFinding]});
  expect(reversed.trace).toMatchObject({reversibleAtomic:'100',shortfallAtomic:'0'});
  expect(reversed.evidenceHash).not.toBe(accepted.evidenceHash);
  expect(()=>assertCheckedDetermination(reversed)).not.toThrow();
  expect(()=>assertCheckedDetermination({...reversed})).toThrow('unverified');
  expect(f.packet.evidence.checkpoint.transfers[0].receipt).toBe('unresolved');
});
test('unknown evidence, changed case hash, serialized packets and unmatched receipt findings are refused',async()=>{
  const f=await packetFixture();
  expect(()=>assessRestoration({...f.packet},f.judgment)).toThrow('judgment_invalid');
  expect(()=>assessRestoration(f.packet,{...f.judgment,packetHash:hash(999)})).toThrow('judgment_invalid');
  expect(()=>assessRestoration(f.packet,{...f.judgment,evidenceHashes:[hash(999)]})).toThrow('evidence_unknown');
  expect(()=>assessRestoration(f.packet,{...f.judgment,receipts:[{transactionHash:hash(999),logIndex:0,conclusion:'gratuitous',evidenceHashes:[f.transaction.evidenceHash],reasoning:'Unmatched'}]})).toThrow('receipt_invalid');
  const declined=assessRestoration(f.packet,{...f.judgment,finding:'declined_insufficient_evidence'});
  expect(declined.accepted).toBe(false);
});
test('a changed stored loss or on-chain ticket cannot authorize preparation',async()=>{
  const f=await packetFixture();
  await expect(prepareDetermination(f.db,f.ticket.request,{...f.ports,ticket:async()=>({...f.ticket,maximumLoss:'101'})})).rejects.toThrow('scope_mismatch');
  f.fake.store.set(f.path,{...f.fake.store.get(f.path),snapshot:{...f.snapshot,lossAtomic:'101'}});
  await expect(prepareDetermination(f.db,f.ticket.request,f.ports)).rejects.toThrow('scope_mismatch');
});

test('execution calldata fixes the ticket, exact trace, membership generation and independent attestation domain',async()=>{
  const f=await packetFixture();
  const determination=assessRestoration(f.packet,f.judgment);
  const plan=determinationPlan(determination,{revision:2n,registry:address(80),bindingLogIndex:0});
  expect(plan.accepted).toBe(true);if(!plan.accepted)throw Error('expected acceptance');
  expect(plan.record.membershipGeneration).toBe(1);
  expect(plan.reversal.sources).toHaveLength(0);
  expect(plan.reversal.observationAccounts).toEqual(f.packet.evidence.checkpoint.accounts.map(row=>row.address).sort());
  expect(plan.reversal.observationAccounts.length).toBeGreaterThan(1);
  expect(plan.reversal.observationSequences).toHaveLength(plan.reversal.observationAccounts.length);
  expect(plan.poolCall).toBeNull(); // positive shortfalls join one pro-rata batch
  expect(RECOURSE_POOL_ABI.parseTransaction({data:plan.deliveryCall!})!.args.identity).toBe(f.ticket.identity);
  const scope=recoveryOperationHash(f.ticket.identity,f.ticket.destination,{request:f.ticket.request,lossHash:f.ticket.lossHash,maximumLoss:f.ticket.maximumLoss});
  const operation=sha256(AbiCoder.defaultAbiCoder().encode(['string','bytes32',REVERSAL_TUPLE],['Provian scoped theft reversal',scope,plan.reversal]));
  expect(plan.operation).toBe(operation);
  expect(RESTORATION_EXECUTION_ABI.parseTransaction({data:plan.reversalCall})!.args.reversal.poolShortfall).toBe(100n);
  expect(Object.isFrozen(determination.trace)).toBe(true);expect(Object.isFrozen(f.packet.snapshot)).toBe(true);
  expect(()=>determinationPlan({...determination},{revision:2n,registry:address(80),bindingLogIndex:0})).toThrow('unverified');
});

test('later independent owner recovery changes the destination but never the original authorized loss scope',async()=>{
  const f=await packetFixture(),currentDestination=address(60);
  const packet=await prepareDetermination(f.db,f.ticket.request,{...f.ports,ticket:async()=>({...f.ticket,currentDestination})});
  expect(()=>assessRestoration(packet,f.judgment)).toThrow('judgment_invalid');
  const value=assessRestoration(packet,{...f.judgment,packetHash:packet.packetHash});
  const plan=determinationPlan(value,{revision:2n,registry:address(80),bindingLogIndex:0});
  if(!plan.accepted)throw Error('expected acceptance');
  expect(plan.reversal.destination).toBe(currentDestination);
  expect(packet.ticket.destination).toBe(f.ticket.destination);
  const originalScope=recoveryOperationHash(f.ticket.identity,f.ticket.destination,{request:f.ticket.request,lossHash:f.ticket.lossHash,maximumLoss:f.ticket.maximumLoss});
  expect(plan.operation).toBe(sha256(AbiCoder.defaultAbiCoder().encode(['string','bytes32',REVERSAL_TUPLE],['Provian scoped theft reversal',originalScope,plan.reversal])));
});

test('encrypted map ordering preserves the exact loss evidence and determination packet',async()=>{
 const f=await packetFixture(),prior=process.env.RELAY_SIGNING_KEY;
 try{
  process.env.RELAY_SIGNING_KEY='public-test-determination-evidence-key';
  const encoded=encodePrivateRecord(RESTORATION_REQUESTS,f.ticket.request,f.fake.store.get(f.path)!);
  const decoded=decodePrivateRecord(RESTORATION_REQUESTS,privateStorageId(RESTORATION_REQUESTS,f.ticket.request),encoded,f.db).data;
  expect(JSON.stringify(decoded.snapshot)).not.toBe(JSON.stringify(f.snapshot));f.fake.store.set(f.path,decoded);
  const packet=await prepareDetermination(f.db,f.ticket.request,f.ports);
  expect(packet.packetHash).toBe(f.packet.packetHash);
  f.fake.store.set(f.path,{...decoded,evidence:JSON.stringify({snapshot:decoded.snapshot,membership:decoded.membership})});
  await expect(prepareDetermination(f.db,f.ticket.request,f.ports)).rejects.toThrow('scope_mismatch');
 }finally{if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;}
});
