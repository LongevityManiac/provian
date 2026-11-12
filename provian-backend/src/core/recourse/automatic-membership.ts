import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { prepareMembershipDebit } from './membership-debit-preparation';
import { queueMembershipDebit } from './membership-debit-operation';
import { reconcileCurrentPrivateMembership, prepareMembershipTransition } from './membership-preparation';
import { readRecoursePoolState } from './pool-state';
import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipWiring } from './membership-wiring';
import { STANDING_MEMBERSHIP_ABI } from './membership-authorization';

export const AUTOMATIC_MEMBERSHIP_SWEEP='recourse_private_membership_sweep_v1';
export type AutomaticMembershipResult='queued'|'settled'|'pending'|'approval_required'|'left';
/** The private owner ledger reserves one exact obligation across the portfolio.
 * The standing mandate independently bounds the selected payer on chain. No
 * member presence, fresh owner signature, allowance transaction or ETH is used. */
export async function collectAutomaticMembershipOwner(db:Firestore,ownerIdentity:string):Promise<AutomaticMembershipResult>{
  await reconcileCurrentPrivateMembership(db,ownerIdentity);
  const owner=await db.collection(R.owners).doc(ownerIdentity).get();
  if(!owner.exists||owner.get('ownerIdentity')!==ownerIdentity)throw Error('recourse_automatic_owner');
  const transition:unknown=owner.get('membershipTransition');
  if(typeof transition==='string'){await prepareMembershipTransition(db,ownerIdentity,{id:transition});return 'pending';}
  const binding:unknown=owner.get('primaryBinding');
  if(typeof binding!=='string'||!/^0x[0-9a-f]{64}$/.test(binding))return 'approval_required';
  const chain=breakDeploymentChain(),deployment=await chain.deployment();
  const state=await readRecoursePoolState(binding,deployment);
  if(!state.addressConsent)return 'left';
  const wiring=await readMembershipWiring(chain,deployment);
  const raw=await chain.agree('eth_call',[{to:wiring.standingMembership,
    data:STANDING_MEMBERSHIP_ABI.encodeFunctionData('standingMandate',[binding])},wiring.pin]);
  if(typeof raw!=='string')throw Error('recourse_automatic_state');
  const m=STANDING_MEMBERSHIP_ABI.decodeFunctionResult('standingMandate',raw);
  if(!m.active||String(m.consentNonce)!==state.consentNonce||BigInt(m.burnLimit)<BigInt(state.participationBurnAtomic)
    ||BigInt(m.reserveLimit)<BigInt(state.noEarningsContributionAtomic)||Number(m.earningsBpsLimit)<state.earningsBps)return 'approval_required';
  const prepared=await prepareMembershipDebit(db,ownerIdentity,state.currentAddress);
  if(prepared.status!=='ready')return prepared.status;
  const {reservationId,domain,debit}=prepared.challenge;
  await queueMembershipDebit(db,ownerIdentity,{reservationId,domain,debit});return 'queued';
}
/** A transport-sized page, under the existing scheduler's distributed lease.
 * Cursor progress is durable; failed or underfunded owners cannot starve later
 * members and will be revisited on the next complete pass. */
export async function runAutomaticMembershipSweep(db:Firestore):Promise<{visited:number;queued:number;pending:number;approvalRequired:number;retry:number}>{
  const cursorRef=db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc('cursor'),cursor=await cursorRef.get();
  const after:unknown=cursor.get('after');
  if(after!==undefined&&after!==null&&(typeof after!=='string'||!/^0x[0-9a-f]{64}$/.test(after)))throw Error('recourse_automatic_cursor');
  let query=db.collection(C.owners).orderBy('ownerIdentity').limit(10);
  if(typeof after==='string')query=query.startAfter(after);
  const page=await query.get();
  const result={visited:0,queued:0,pending:0,approvalRequired:0,retry:0};
  for(const row of page.docs){
    const owner:unknown=row.get('ownerIdentity');
    if(typeof owner!=='string'||!/^0x[0-9a-f]{64}$/.test(owner))throw Error('recourse_automatic_owner');
    ++result.visited;
    try{
      const state=await collectAutomaticMembershipOwner(db,owner);
      if(state==='queued')++result.queued;
      if(state==='pending')++result.pending;
      if(state==='approval_required')++result.approvalRequired;
    }catch{++result.retry;}
    await cursorRef.set({after:owner,updatedAtMs:Date.now()});
  }
  if(page.size<10)await cursorRef.set({after:null,updatedAtMs:Date.now()});
  return result;
}
