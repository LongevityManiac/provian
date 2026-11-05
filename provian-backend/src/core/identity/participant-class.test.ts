import type {Firestore} from 'firebase-admin/firestore';
import {createFakeFirestore} from '../pvt/__test-helpers__/fake-firestore';
import {ownerParticipantClass,participantClass,newMobileDeviceRegistration} from './participant-class';
it('uses server-stored identity class and defaults only new unknown identities to external',async()=>{
 const db=createFakeFirestore() as unknown as Firestore;
 for(const c of ['operator','canary','fixture','external']) {
  await db.collection('wallets').doc(c).set({network_class:c,user_id:c+'user',platform:'test'});
  expect(await ownerParticipantClass(db,c)).toBe(c);
  expect(await ownerParticipantClass(db,c+'user')).toBe(c);
 }
 expect(await ownerParticipantClass(db,'fixture-named-real-user')).toBe('external');
 expect(participantClass('test')).toBeNull();
});
it('inherits the frozen owner class while migration is running and refuses ambiguous ownership',async()=>{
 const db=createFakeFirestore() as unknown as Firestore;
 await db.collection('ops_participant_migrations_v1').doc('launch').set({status:'planned',owner_classes:{owner:'operator'}});
 expect(await ownerParticipantClass(db,'owner')).toBe('operator');
 await db.collection('wallets').doc('a').set({user_id:'ambiguous',network_class:'operator'});
 await db.collection('wallets').doc('b').set({user_id:'ambiguous',network_class:'external'});
 await expect(ownerParticipantClass(db,'ambiguous')).rejects.toThrow('ambiguous');
});

it('timestamps a newly registered phone at its own birth, not its older account birth',()=>{
 const device=newMobileDeviceRegistration('new-phone','Recovered Device',200);
 expect(device).toEqual({id:'new-phone',name:'Recovered Device',created_at:200,last_seen:200});
 device.last_seen=300;expect(device.created_at).toBe(200);
});
