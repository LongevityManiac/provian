import { currentProtocolDeployment } from '../protocol/runtime';
import { utcCalendarMonth } from './calendar-month';
import type { PrivateMembershipAccount } from './private-membership-reservation';
import { advanceMembershipDeparture } from './membership-departure';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { prepareMembershipDebit } from './membership-debit-preparation';
import { queueMembershipDebit } from './membership-debit-operation';
import { reconcileCurrentPrivateMembership, prepareMembershipTransition } from './membership-preparation';
import { readRecoursePoolState } from './pool-state';
import { breakDeploymentChain } from './break-deployment-queue';

export const AUTOMATIC_MEMBERSHIP_SWEEP='recourse_private_membership_sweep_v1';
export type AutomaticMembershipResult='queued'|'settled'|'pending'|'approval_required'|'left';
/** The private owner ledger reserves one exact obligation across the portfolio.
 * The standing mandate independently bounds the selected payer on chain. No
 * member presence, fresh owner signature, allowance transaction or ETH is used. */
export async function collectAutomaticMembershipOwner(db:Firestore,ownerIdentity:string):Promise<AutomaticMembershipResult>{
  let owner=await db.collection(R.owners).doc(ownerIdentity).get();
  if(!owner.exists||owner.get('ownerIdentity')!==ownerIdentity)throw Error('recourse_automatic_owner');
  const saved = await db.collection(C.owners).doc(ownerIdentity).get();
  const account = saved.exists ? saved.data() as PrivateMembershipAccount : undefined;
  const pool = (await currentProtocolDeployment()).addresses.recoursePool.toLowerCase();
  const month = utcCalendarMonth(Math.floor(Date.now() / 1000));
  if (account && account.checkpoint?.pool === pool && account.needsScan === false && account.pendingReservation === null
    && owner.get('membershipTransition') == null && owner.get('membershipScanRequired') !== true
    && account.episode && account.episode.observedMonth <= month
    && (account.episode.joined === false || (account.episode.joined === true && account.episode.invoices[String(month)]
      && account.episode.observedMonth === month && account.episode.lastAssessedMonth === month))
    && Object.values(account.episode.invoices).every(invoice =>
      BigInt(invoice.burnPaidAtomic) >= BigInt(invoice.burnDueAtomic)
      && BigInt(invoice.reservePaidAtomic) >= BigInt(invoice.month < month && BigInt(invoice.earnings.grossAtomic) === 0n
        ? invoice.noEarningsContributionAtomic : invoice.reserveDueAtomic))) return 'settled';
  await reconcileCurrentPrivateMembership(db,ownerIdentity);
  owner = await db.collection(R.owners).doc(ownerIdentity).get();
  if (!owner.exists || owner.get('ownerIdentity') !== ownerIdentity) throw Error('recourse_automatic_owner');
  const transition:unknown=owner.get('membershipTransition');
  if(typeof transition==='string'){
    const view=await prepareMembershipTransition(db,ownerIdentity,{id:transition});
    if(view.kind==='leave')await advanceMembershipDeparture(db,ownerIdentity,transition);
    return 'pending';
  }
  const binding:unknown=owner.get('membershipFixedDebitBinding');
  if(typeof binding!=='string'||!/^0x[0-9a-f]{64}$/.test(binding))return 'approval_required';
  const chain=breakDeploymentChain(),deployment=await chain.deployment();
  const state=await readRecoursePoolState(binding,deployment);
  if(!state.addressConsent)return 'left';
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
  // A first join may never have opened a membership account. Its retained
  // departure still needs unattended reconciliation after the app closes.
  const departureCursor=db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc('departures'), saved=await departureCursor.get();
  const departureAfter:unknown=saved.get('after');
  if(departureAfter!=null&&(typeof departureAfter!=='string'||!/^0x[0-9a-f]{64}$/.test(departureAfter)))throw Error('recourse_automatic_cursor');
  let departures=db.collection(T).where('departureRequested','==',true).where('status','in',['preparing','consenting']).orderBy('id').limit(10);
  if(typeof departureAfter==='string')departures=departures.startAfter(departureAfter);
  const rows=await departures.get();
  for(const row of rows.docs){
    const id:unknown=row.get('id'),ownerIdentity:unknown=row.get('ownerIdentity');
    if(typeof id!=='string'||typeof ownerIdentity!=='string'||!/^0x[0-9a-f]{64}$/.test(id)||!/^0x[0-9a-f]{64}$/.test(ownerIdentity))throw Error('recourse_automatic_owner');
    try{await advanceMembershipDeparture(db,ownerIdentity,id);}catch{++result.retry;}
    await departureCursor.set({after:id,updatedAtMs:Date.now()});
  }
  if(rows.size<10)await departureCursor.set({after:null,updatedAtMs:Date.now()});
  return result;
}
