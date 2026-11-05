import type { Firestore } from 'firebase-admin/firestore';
import {createFakeFirestore} from '../pvt/__test-helpers__/fake-firestore';
import {deleteMeterBatchForCleanup} from './meter-cleanup';
import {METER_BATCHES_COLLECTION,METER_ANCHOR_DAYS_COLLECTION} from './meter-store';

it('refuses to purge selected or unanchored batches, including partial proof completion',async()=>{
 const db=createFakeFirestore() as unknown as Firestore;
 const batch=db.collection(METER_BATCHES_COLLECTION).doc('batch');
 const day=db.collection(METER_ANCHOR_DAYS_COLLECTION).doc('2026-10-23');
 await batch.set({day:'2026-10-23',anchored:false});
 await expect(deleteMeterBatchForCleanup(db,'batch')).rejects.toThrow('batch_not_anchored');
 await batch.update({anchored:true});
 await day.set({status:'anchored',proofs_complete:true,selection:{count:48,root:'frozen'}});
 await expect(deleteMeterBatchForCleanup(db,'batch')).rejects.toThrow('anchor_incomplete');
 expect((await batch.get()).exists).toBe(true);
 await day.set({status:'anchored',proofs_complete:false,selection:null});
 await expect(deleteMeterBatchForCleanup(db,'batch')).rejects.toThrow('anchor_incomplete');
 await day.update({proofs_complete:true});
 expect(await deleteMeterBatchForCleanup(db,'batch')).toBe(true);
 expect(await deleteMeterBatchForCleanup(db,'batch')).toBe(false);
});
