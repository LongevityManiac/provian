import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../../pvt/__test-helpers__/fake-firestore';
import { fixture,address,hash } from './restoration-evidence-fixture';
import { collectRestorationEvidence } from '../restoration-evidence';
import { RESTORATION_REQUESTS } from '../restoration-request';
import { prepareDetermination,type DeterminationPorts,type RestorationJudgment } from '../determination';
import type { RecoursePoolState } from '../pool-state';
export async function packetFixture() {
  const f = fixture(), fake = createFakeFirestore();
  const membership = { active:true, periodIndex:0, unpaidAtomic:'0', completedNonissuanceMonths:[], evidenceHash:hash(90), lossTimestamp:100 };
  const ticket = { request:f.snapshot.occurrence, identity:f.snapshot.identity, destination:address(50), currentDestination:address(50), maximumLoss:'100',
    lossHash:`0x${createHash('sha256').update(JSON.stringify({snapshot:f.snapshot,membership})).digest('hex')}` };
  const path = `${RESTORATION_REQUESTS}/${ticket.request}`;
  fake.store.set(path,{identity:ticket.identity,destination:ticket.destination,snapshot:f.snapshot,membership,evidence:JSON.stringify({snapshot:f.snapshot,membership}),status:'awaiting_determination'});
  const ports:DeterminationPorts={ticket:async()=>ticket,evidence:snapshot=>collectRestorationEvidence(snapshot,f.port),pool:async()=>({outcomeRevision:'0'} as RecoursePoolState)};
  const db = fake as unknown as Firestore;
  const packet = await prepareDetermination(db,ticket.request,ports);
  const judgment:RestorationJudgment={packetHash:packet.packetHash,finding:'accepted_theft',reasoning:'Operator finding from the recorded evidence; intent remains an inference.',evidenceHashes:[f.snapshot.evidenceHash],receipts:[]};
  return {...f,fake,db,path,ports,ticket,packet,judgment};
}
