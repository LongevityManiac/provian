import { randomUUID } from 'crypto';
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
import { scanQueryUnordered } from '../provenance/query-pages';

export const AUTOMATIC_MEMBERSHIP_SWEEP='recourse_private_membership_sweep_v1';
export type AutomaticMembershipResult='queued'|'settled'|'pending'|'approval_required'|'left'|'lapsed';
/** What `prepareMembershipDebit` answers for an owner whose protection has ended: nothing can be collected until the owner rejoins. */
const JOIN_REQUIRED='recourse_membership_debit_join_required';
/**
 * A member whose membership has ended — it left, or it lapsed past its month of grace — owes the
 * sweep nothing it can collect: only the owner's own rejoin (which first pays the unpaid protected
 * months) changes that. The sweep records that finding against the exact account it was read
 * from, and while the account is unchanged later visits answer from the record without reading
 * the chain. A rejoin opens a membership change on the owner and then a new episode generation,
 * either of which sets the record aside.
 */
const dormantId=(ownerIdentity:string)=>`dormant-${ownerIdentity}`;
interface DormantRecord { readonly ownerIdentity:string; readonly result:'left'|'lapsed'; readonly accountVersion:number; readonly generation:number; readonly pool:string; readonly recordedAtMs:number }
function dormantStillHolds(record:FirebaseFirestore.DocumentData|undefined,ownerIdentity:string,owner:FirebaseFirestore.DocumentSnapshot,
  account:PrivateMembershipAccount|undefined,pool:string):'left'|'lapsed'|null{
  if(!record||!account||record.ownerIdentity!==ownerIdentity||(record.result!=='left'&&record.result!=='lapsed'))return null;
  if(owner.get('membershipTransition')!=null||owner.get('membershipScanRequired')===true)return null;
  if(account.needsScan!==false||account.pendingReservation!==null||account.checkpoint?.pool!==pool||record.pool!==pool)return null;
  if(!Number.isSafeInteger(account.version)||record.accountVersion!==account.version)return null;
  if(!Number.isSafeInteger(account.episode?.generation)||record.generation!==account.episode.generation)return null;
  return record.result;
}
/** The private owner ledger reserves one exact obligation across the portfolio.
 * The standing mandate independently bounds the selected payer on chain. No
 * member presence, fresh owner signature, allowance transaction or ETH is used. */
export async function collectAutomaticMembershipOwner(db:Firestore,ownerIdentity:string):Promise<AutomaticMembershipResult>{
  const owner=await db.collection(R.owners).doc(ownerIdentity).get();
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
  const dormantRef=db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc(dormantId(ownerIdentity)),dormantRow=await dormantRef.get();
  const dormant=dormantStillHolds(dormantRow.data(),ownerIdentity,owner,account,pool);
  if(dormant)return dormant;
  const result=await collectFromChain(db,ownerIdentity);
  if(result==='left'||result==='lapsed'){
    // Recorded against the account as it stands after this visit's reconciliation.
    const current=await db.collection(C.owners).doc(ownerIdentity).get(),now=current.exists?current.data() as PrivateMembershipAccount:undefined;
    if(now&&Number.isSafeInteger(now.version)&&Number.isSafeInteger(now.episode?.generation)){
      const record:DormantRecord={ownerIdentity,result,accountVersion:now.version,generation:now.episode.generation,pool,recordedAtMs:Date.now()};
      await dormantRef.set(record);
    }else if(dormantRow.exists)await dormantRef.delete();
  }else if(dormantRow.exists)await dormantRef.delete();
  return result;
}
/** The full visit: reconcile against the chain, then collect whatever is due and approved. */
async function collectFromChain(db:Firestore,ownerIdentity:string):Promise<AutomaticMembershipResult>{
  await reconcileCurrentPrivateMembership(db,ownerIdentity);
  const owner=await db.collection(R.owners).doc(ownerIdentity).get();
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
  let prepared:Awaited<ReturnType<typeof prepareMembershipDebit>>;
  try{prepared=await prepareMembershipDebit(db,ownerIdentity,state.currentAddress);}
  catch(error){
    // Protection has ended with the address still consenting on chain: lapsed, not a failure to retry.
    if(error instanceof Error&&error.message===JOIN_REQUIRED)return 'lapsed';
    throw error;
  }
  if(prepared.status!=='ready')return prepared.status;
  const {reservationId,domain,debit}=prepared.challenge;
  await queueMembershipDebit(db,ownerIdentity,{reservationId,domain,debit});return 'queued';
}
export const AUTOMATIC_MEMBERSHIP_FOLLOWUPS = 'recourse_private_membership_followups_v1';
const OWNER = /^0x[0-9a-f]{64}$/;
/** Members per snapshot chunk document. */
export const SWEEP_CHUNK_SIZE = 2_000;
/** Chunk documents are named by their pass, so two snapshots can never mix. */
const sweepChunkId = (pass: string, index: number) => `pass-${pass}-chunk-${index}`;
interface SweepCursor { readonly pass: string | null; readonly chunks: number; readonly chunk: number; readonly offset: number; readonly restUntilMs: number; }
function readSweepCursor(data: Record<string, unknown> | undefined): SweepCursor {
  const value = data ?? {}, pass = value.pass, rest = Number(value.restUntilMs ?? 0);
  // A cursor written before snapshots (an `after` owner) restarts as a fresh pass.
  if (typeof pass !== 'string') return { pass: null, chunks: 0, chunk: 0, offset: 0, restUntilMs: Number.isSafeInteger(rest) ? rest : 0 };
  const [chunks, chunk, offset] = [value.chunks, value.chunk, value.offset].map(Number);
  // A cursor that cannot be read restarts the pass rather than stopping the sweep.
  if (![chunks, chunk, offset].every(n => Number.isSafeInteger(n) && n >= 0) || chunk > chunks) return { pass: null, chunks: 0, chunk: 0, offset: 0, restUntilMs: 0 };
  return { pass, chunks, chunk, offset, restUntilMs: 0 };
}
/** One read of every membership account, kept as ordered chunks of owner identities. */
async function snapshotMembers(db: Firestore, now: () => number, renew: () => Promise<boolean>): Promise<{ id: string; chunks: number }> {
  const owners: string[] = [], started = now();
  let renewedAt = started;
  await scanQueryUnordered(db.collection(C.owners), 500, async row => {
    // A long scan keeps the sweep's lease well inside its lifetime; a lost lease abandons it to the new holder.
    if (now() - renewedAt >= SWEEP_LEASE_TTL_MS / 3) {
      if (!(await renew())) throw Error('recourse_automatic_sweep_lease_lost');
      renewedAt = now();
    }
    const owner: unknown = row.get('ownerIdentity');
    if (typeof owner !== 'string' || !OWNER.test(owner) || row.id !== owner) throw Error('recourse_automatic_owner');
    owners.push(owner);
  });
  owners.sort();
  const id = `${started}-${randomUUID()}`, chunks = Math.ceil(owners.length / SWEEP_CHUNK_SIZE);
  for (let i = 0; i < chunks; i++) {
    await db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc(sweepChunkId(id, i)).set({ pass: id, owners: owners.slice(i * SWEEP_CHUNK_SIZE, (i + 1) * SWEEP_CHUNK_SIZE) });
  }
  return { id, chunks };
}
export interface AutomaticMembershipSweepOptions {
  readonly deadlineMs: number;
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly collect?: (db: Firestore, ownerIdentity: string) => Promise<AutomaticMembershipResult>;
  /** Unsent debits already waiting for the lane. Above `maxBacklog` the sweep queues no more this run,
   * so a debit authorization (valid five minutes) is never queued faster than the lane sends it. */
  readonly backlog?: () => Promise<number>;
  readonly maxBacklog?: number;
}
export interface AutomaticMembershipSweepResult {
  skipped?: 'sweep_busy';
  backpressure?: true;
  visited: number; queued: number; pending: number; approvalRequired: number; retry: number; passes: number; followups: number;
}
const SWEEP_LEASE_TTL_MS = 120_000;
const FOLLOWUP_FIRST_MS = 2 * 60_000, FOLLOWUP_MAX_MS = 60 * 60_000;
/** Next UTC midnight. A completed full pass rests until then. */
export function nextUtcDayMs(nowMs: number): number { return (Math.floor(nowMs / 86_400_000) + 1) * 86_400_000; }
/** One full pass over every member each UTC day, several members at a time,
 * under the sweep's own lease, deadline-bounded with durable cursor progress.
 * A member whose collection was queued, is pending or failed goes on a small
 * follow-up list that is revisited with backoff until it settles, so one
 * member in flight never makes the sweep re-read everyone. */
export async function runAutomaticMembershipSweep(db: Firestore, options: AutomaticMembershipSweepOptions = { deadlineMs: Date.now() + 30_000 }):
Promise<AutomaticMembershipSweepResult> {
  const now = options.now ?? Date.now, collect = options.collect ?? collectAutomaticMembershipOwner;
  const concurrency = Math.max(1, options.concurrency ?? 8), worker = `sweep-${randomUUID()}`;
  const result: AutomaticMembershipSweepResult = { visited: 0, queued: 0, pending: 0, approvalRequired: 0, retry: 0, passes: 0, followups: 0 };
  const leaseRef = db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc('lease');
  const held = await db.runTransaction(async tx => {
    const lease = await tx.get(leaseRef);
    if (typeof lease.get('owner') === 'string' && Number(lease.get('expires_at_ms')) > now()) return false;
    tx.set(leaseRef, { owner: worker, expires_at_ms: now() + SWEEP_LEASE_TTL_MS });
    return true;
  });
  if (!held) { result.skipped = 'sweep_busy'; return result; }
  const followRef = (owner: string) => db.collection(AUTOMATIC_MEMBERSHIP_FOLLOWUPS).doc(owner);
  /** Visit one member; keep it on the follow-up list until a visit finds nothing left to do. */
  const visit = async (owner: string, attempts: number) => {
    ++result.visited;
    let state: AutomaticMembershipResult | 'retry';
    try { state = await collect(db, owner); } catch { state = 'retry'; }
    if (state === 'queued') ++result.queued;
    if (state === 'pending') ++result.pending;
    if (state === 'approval_required') ++result.approvalRequired;
    if (state === 'retry') ++result.retry;
    if (state === 'queued' || state === 'pending' || state === 'retry') {
      const delay = Math.min(FOLLOWUP_MAX_MS, FOLLOWUP_FIRST_MS * 2 ** Math.min(attempts, 10));
      await followRef(owner).set({ ownerIdentity: owner, attempts: attempts + 1, dueAtMs: now() + delay });
    } else if (attempts > 0) await followRef(owner).delete();
  };
  const inBatches = async (owners: readonly { owner: string; attempts: number }[]) => {
    for (let i = 0; i < owners.length; i += concurrency) {
      await Promise.all(owners.slice(i, i + concurrency).map(row => visit(row.owner, row.attempts)));
    }
  };
  try {
    // Follow-ups first: they are members with a collection in flight.
    const due = await db.collection(AUTOMATIC_MEMBERSHIP_FOLLOWUPS).where('dueAtMs', '<=', now()).orderBy('dueAtMs').limit(concurrency * 8).get();
    const followups = due.docs.map(row => {
      const owner: unknown = row.get('ownerIdentity'), attempts = Number(row.get('attempts') ?? 1);
      if (typeof owner !== 'string' || !OWNER.test(owner) || row.id !== owner) throw Error('recourse_automatic_owner');
      return { owner, attempts: Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1 };
    });
    result.followups = followups.length;
    await inBatches(followups);
    // The day's pass walks a snapshot of every member, taken once at its start: the
    // accounts live in the private store, where paging the collection itself would
    // read every account for every page.
    const cursorRef = db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc('cursor');
    const chunks = new Map<number, readonly string[]>();
    let lost = false;
    /** Renew the lease only while this run still holds it. */
    const renew = () => db.runTransaction(async tx => {
      if ((await tx.get(leaseRef)).get('owner') !== worker) return false;
      tx.set(leaseRef, { owner: worker, expires_at_ms: now() + SWEEP_LEASE_TTL_MS });
      return true;
    });
    /** Move the cursor and renew the lease together, only while this run holds it. */
    const advance = (next: Record<string, unknown>) => db.runTransaction(async tx => {
      if ((await tx.get(leaseRef)).get('owner') !== worker) return false;
      tx.set(cursorRef, { ...next, updatedAtMs: now() });
      tx.set(leaseRef, { owner: worker, expires_at_ms: now() + SWEEP_LEASE_TTL_MS });
      return true;
    });
    while (now() < options.deadlineMs) {
      if (options.backlog && await options.backlog() >= (options.maxBacklog ?? 40)) { result.backpressure = true; break; }
      const cursor = readSweepCursor((await cursorRef.get()).data());
      if (cursor.pass === null) {
        if (cursor.restUntilMs > now()) break;
        const pass = await snapshotMembers(db, now, renew);
        if (!(await advance({ pass: pass.id, chunks: pass.chunks, chunk: 0, offset: 0, restUntilMs: 0 }))) { lost = true; break; }
        continue;
      }
      if (cursor.chunk >= cursor.chunks) {
        if (!(await advance({ pass: null, restUntilMs: nextUtcDayMs(now()) }))) { lost = true; break; }
        for (let i = 0; i < cursor.chunks; i++) await db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc(sweepChunkId(cursor.pass, i)).delete();
        ++result.passes; break;
      }
      let ids = chunks.get(cursor.chunk);
      if (!ids) {
        const row = await db.collection(AUTOMATIC_MEMBERSHIP_SWEEP).doc(sweepChunkId(cursor.pass, cursor.chunk)).get();
        const owners: unknown = row.get('owners');
        if (row.get('pass') !== cursor.pass || !Array.isArray(owners) || !owners.every(owner => typeof owner === 'string' && OWNER.test(owner))) {
          // A missing or foreign chunk restarts the pass; members already visited are only visited again.
          if (!(await advance({ pass: null, restUntilMs: 0 }))) { lost = true; break; }
          continue;
        }
        ids = owners as string[]; chunks.set(cursor.chunk, ids);
      }
      const page = ids.slice(cursor.offset, cursor.offset + concurrency * 2);
      await inBatches(page.map(owner => ({ owner, attempts: 0 })));
      const offset = cursor.offset + page.length, ended = offset >= ids.length;
      if (!(await advance({ ...cursor, chunk: ended ? cursor.chunk + 1 : cursor.chunk, offset: ended ? 0 : offset }))) { lost = true; break; }
    }
    // Another run holds the sweep now; it continues from the cursor.
    if (lost) return result;
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
  } finally {
    await db.runTransaction(async tx => {
      const lease = await tx.get(leaseRef);
      if (lease.get('owner') === worker) tx.set(leaseRef, { owner: null, expires_at_ms: 0 });
    });
  }
  return result;
}
