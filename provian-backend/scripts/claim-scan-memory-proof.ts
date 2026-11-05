/** Disposable loopback emulator proof, including a naive unbounded-read RED control.
 * Run Node with --max-old-space-size=256; never runs against a real Firestore project. */
import {Firestore} from 'firebase-admin/firestore';
import {randomUUID,createHash} from 'crypto';
import {encodePrivateRecord,privateFirestore,privateStorageId} from '../src/core/provenance/private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION as STATE,PRIVATE_RETENTION_STATE_DOC as DOC} from '../src/core/provenance/private-retention';
import {METER_PENDING_CLAIMS_COLLECTION as CLAIMS} from '../src/core/meter/meter-store';
import {buildPendingClaim,meterBatchClaimId,meterBatchClaimKey} from '../src/core/meter/meter-claims';
import {runMeterClaimInlet} from '../src/core/meter/meter-settlement';
async function main():Promise<void>{
 if(!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??''))throw new Error('local emulator required');
 process.env.RELAY_SIGNING_KEY='public-local-held-memory-proof';
 const raw=new Firestore({projectId:'demo-cost-cut',databaseId:process.env.COST_MEMORY_DB??'memory-'+randomUUID().slice(0,8)}),db=privateFirestore(raw);
 const count=6000,nowMs=1800000000000;let logicalBytes=0;
 if(!process.env.COST_MEMORY_DB){await raw.collection(STATE).doc(DOC).set({opaque_ids_ready:true,opaque_records_complete:true});
  for(let start=0;start<count;start+=200){const batch=raw.batch();for(let i=start;i<Math.min(start+200,count);i++){
   const id={batch_hash:createHash('sha256').update('memory-'+i).digest('hex'),leg:'sole' as const,contributor:'0x'+'1'.repeat(40),beneficiary_class:1};
   const claim=buildPendingClaim({...id,claim_key:meterBatchClaimKey(id),claim_id:meterBatchClaimId(id),unit:'batch',device_id:'local-device',actor_id:'local-agent',record_points_atomic:'500',acts:Array.from({length:500},(_,j)=>({relay_pe_id:'pe_local_'+i+'_'+j+'_'+('x'.repeat(100)),points_atomic:'1'})),created_at_ms:1,ready_at_ms:nowMs+1000});
   logicalBytes+=Buffer.byteLength(JSON.stringify(claim));batch.create(raw.collection(CLAIMS).doc(privateStorageId(CLAIMS,claim.claim_key)),encodePrivateRecord(CLAIMS,claim.claim_key,claim));
  }await batch.commit();}
 }
 const result=process.argv.includes('--red-unbounded')?(await db.collection(CLAIMS).where('state','==','pending').get()).size:await runMeterClaimInlet(db,{nowMs});
 if(typeof result!=='number'&&(result.scanned!==count||result.notReady!==count||result.registered!==0||result.payouts!==0))throw new Error('held scan result changed');
 console.log(JSON.stringify({database:raw.databaseId,logicalBytes,claims:count,heap_limit_MiB:256,result,heapUsed:process.memoryUsage().heapUsed,records_repriced:0}));await raw.terminate();
}
void main().catch(e=>{console.error(e instanceof Error?e.message:'memory proof failed');process.exitCode=1;});
