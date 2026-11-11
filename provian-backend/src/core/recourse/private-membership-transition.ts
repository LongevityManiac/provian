import { createHash, randomUUID } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { joinPrivateMembership, leavePrivateMembership, privateMembershipStatus } from './private-membership-calendar';
import { readHistoricalRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { MEMBERSHIP_RECEIPT_ABI, assertMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';
import type { AddressMembershipConsent } from './membership-authorization';
import { utcCalendarMonth } from './calendar-month';
import { createRecourseChainPort } from './chain-ledger';

export const PRIVATE_MEMBERSHIP_TRANSITIONS = 'recourse_private_membership_transitions_v1';
interface Position { readonly block: number; readonly blockHash: string; readonly logIndex: number; readonly timestamp: number }
interface RequiredConsent {
  readonly binding: string; readonly address: string; readonly nonce: string; readonly generation: string;
  readonly initiallyJoined: boolean;
  readonly recoveryGeneration: number;
  readonly departure: Position | null; readonly admission: Position | null;
}
export interface PrivateMembershipTransition {
  readonly id: string; readonly ownerIdentity: string; readonly kind: 'join' | 'leave';
  readonly status: 'preparing' | 'consenting' | 'complete';
  readonly bindingSetVersion: number; readonly portfolioHash: string;
  readonly pool: string; readonly kernel: string; readonly checkpoint: Position;
  readonly bindings: readonly RequiredConsent[];
  readonly closure: Position | null;
}
const fail = (reason: string): never => { throw Error(`recourse_membership_transition_${reason}`); };
const digest = (value: unknown): string => `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function portfolio(rows: readonly { data(): FirebaseFirestore.DocumentData | undefined }[]): readonly unknown[] {
  return rows.map(row => {
    const r = row.data();
    if (!r || !/^0x[0-9a-f]{64}$/.test(r.identity) || !/^0x[0-9a-f]{40}$/.test(r.address)
      || !Number.isSafeInteger(r.recoveryGeneration)) return fail('portfolio');
    return [r.address, r.identity, r.kernel, r.recoveryGeneration, r.chainBindingStatus];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
function version(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('version');
  return value;
}
async function checkedPortfolio(tx: Transaction, db: Firestore, operation: PrivateMembershipTransition,
  historicalReceipt = false): Promise<void> {
  const owner = await tx.get(db.collection(R.owners).doc(operation.ownerIdentity));
  const rows = await tx.get(db.collection(R.addresses).where('ownerIdentity', '==', operation.ownerIdentity));
  if (!owner.exists || owner.get('membershipTransition') !== operation.id) return fail('portfolio_changed');
  const ids = [...new Set(rows.docs.map(r => String(r.get('identity'))))].sort();
  if (JSON.stringify(ids) !== JSON.stringify(operation.bindings.map(b => b.binding).sort())) return fail('portfolio_changed');
  const identities = await Promise.all(operation.bindings.map(b => tx.get(db.collection(R.identities).doc(b.binding))));
  let recovered = false;
  for (let i = 0; i < identities.length; i++) {
    const r = identities[i], generation: unknown = r.get('recoveryGeneration');
    if (!r.exists || r.get('ownerIdentity') !== operation.ownerIdentity || typeof generation !== 'number'
      || !Number.isSafeInteger(generation) || generation < operation.bindings[i].recoveryGeneration) return fail('recovery_changed');
    if (generation > operation.bindings[i].recoveryGeneration) recovered = true;
  }
  // A finalized historical consent remains attributable to the same private
  // owner after key recovery. Record it before refreshing current signing
  // addresses; otherwise an executed-but-unrecorded consent would deadlock both.
  if (!(historicalReceipt && recovered) && (recovered
    || version(owner.get('bindingSetVersion')) !== operation.bindingSetVersion
    || digest(portfolio(rows.docs)) !== operation.portfolioHash)) return fail('portfolio_changed');
}

/** Authentication is resolved by the route before calling this private method.
 * No operation ID or sibling list is put in an address consent or transaction.
 * Existing signed money operations remain reserved; the new transition freezes
 * new signatures immediately while those old operations are reconciled. */
export async function beginPrivateMembershipTransition(db: Firestore, ownerIdentity: string,
  kind: 'join' | 'leave'): Promise<PrivateMembershipTransition> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity) || (kind !== 'join' && kind !== 'leave')) return fail('input');
  const ownerRef = db.collection(R.owners).doc(ownerIdentity), owner = await ownerRef.get();
  if (!owner.exists) return fail('owner');
  const existing: unknown = owner.get('membershipTransition');
  if (typeof existing === 'string') {
    const row = await db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(existing).get();
    const operation = row.data() as PrivateMembershipTransition;
    if (!row.exists || operation.ownerIdentity !== ownerIdentity || operation.kind !== kind || operation.status === 'complete') return fail('busy');
    return operation;
  }
  const rows = await db.collection(R.addresses).where('ownerIdentity', '==', ownerIdentity).get();
  const rawPortfolio = portfolio(rows.docs), ids = [...new Set(rows.docs.map(row => String(row.get('identity'))))];
  if (ids.length === 0) return fail('empty_portfolio');
  const chain = createRecourseChainPort(), block = await chain.finalizedBlock(), blockHash = await chain.blockHash(block);
  if (!blockHash) return fail('checkpoint');
  const publicStates = await Promise.all(ids.map(id => readHistoricalRecoursePoolState(id, { block, blockHash })));
  const first = publicStates[0];
  const priorRow = await db.collection(C.owners).doc(ownerIdentity).get();
  const prior = priorRow.exists ? priorRow.data() as PrivateMembershipAccount : null;
  if (kind === 'join' && prior && privateMembershipStatus(prior.episode, utcCalendarMonth(first.timestamp),
    await readPrivateCalendarRules(db, { pool: first.pool, block: first.block, blockHash: first.blockHash })).protectedNow) return fail('already_joined');

  const selected: RequiredConsent[] = [];
  for (let i = 0; i < ids.length; i++) {
    const state = publicStates[i];
    if (state.pool !== first.pool || state.kernel !== first.kernel || state.blockHash !== first.blockHash || state.block !== first.block) return fail('checkpoint_changed');
    const row = rows.docs.find(r => r.get('address') === state.currentAddress);
    if (!row || row.get('identity') !== ids[i] || row.get('kernel') !== state.kernel || row.get('chainBindingStatus') !== 'confirmed') return fail('binding_pending');
    const identity = await db.collection(R.identities).doc(ids[i]).get();
    if (!identity.exists || identity.get('ownerIdentity') !== ownerIdentity || identity.get('recoveryGeneration') !== row.get('recoveryGeneration')) return fail('binding_pending');
    selected.push({ binding: ids[i], address: state.currentAddress, nonce: state.consentNonce,
      generation: state.consentGeneration, recoveryGeneration: Number(row.get('recoveryGeneration')),
      initiallyJoined: state.addressConsent, departure: null, admission: null });
  }
  // The public reader independently authenticates this canonical block. The
  // timestamp is used only for the private calendar, never the local clock.
  const operation: PrivateMembershipTransition = { id: digest([ownerIdentity, randomUUID()]), ownerIdentity, kind,
    status: 'preparing', bindingSetVersion: version(owner.get('bindingSetVersion')), portfolioHash: digest(rawPortfolio),
    pool: first.pool, kernel: first.kernel, checkpoint: { block: first.block, blockHash: first.blockHash, logIndex: -1,
      timestamp: first.timestamp }, bindings: selected, closure: null };
  await db.runTransaction(async tx => {
    const [currentOwner, account, currentRows] = await Promise.all([tx.get(ownerRef), tx.get(db.collection(C.owners).doc(ownerIdentity)),
      tx.get(db.collection(R.addresses).where('ownerIdentity', '==', ownerIdentity))]);
    if (!currentOwner.exists || currentOwner.get('membershipTransition') != null
      || version(currentOwner.get('bindingSetVersion')) !== operation.bindingSetVersion || digest(portfolio(currentRows.docs)) !== operation.portfolioHash) return fail('concurrent');
    if (account.exists !== priorRow.exists || (account.exists && account.get('version') !== prior?.version)) return fail('concurrent');
    if (kind === 'leave' && !account.exists) return fail('not_joined');
    tx.create(db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(operation.id), operation);
    tx.update(ownerRef, { membershipTransition: operation.id });
  });
  return operation;
}

/** Called after the reservation worker has settled or permanently cancelled
 * every retained debit/issuance and a complete scan has caught up. Closing the
 * private episode precedes public departures, so no half-left portfolio can
 * receive a new eligibility or issuance signature. */
export async function openPrivateMembershipConsents(db: Firestore, id: string): Promise<PrivateMembershipTransition> {
  const ref = db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(id), initial = await ref.get();
  if (!initial.exists) return fail('missing');
  const op = initial.data() as PrivateMembershipTransition;
  if (op.status !== 'preparing') return op;
  const accountRow = await db.collection(C.owners).doc(op.ownerIdentity).get();
  const initialAccount = accountRow.exists ? accountRow.data() as PrivateMembershipAccount : null;
  const checkpoint = initialAccount?.checkpoint ?? { pool: op.pool, block: op.checkpoint.block, blockHash: op.checkpoint.blockHash };
  const rules = await readPrivateCalendarRules(db, checkpoint);
  // Read a canonical timestamp for the exact checkpoint, not scanner arrival.
  const pool = await readHistoricalRecoursePoolState(op.bindings[0].binding, checkpoint);
  if (pool.pool !== op.pool || pool.kernel !== op.kernel) return fail('retired');
  const month = utcCalendarMonth(pool.timestamp);
  return db.runTransaction(async tx => {
    const [row, accountRow] = await Promise.all([tx.get(ref), tx.get(db.collection(C.owners).doc(op.ownerIdentity))]);
    const operation = row.data() as PrivateMembershipTransition;
    if (!row.exists || operation.status !== 'preparing') return fail('concurrent');
    await checkedPortfolio(tx, db, operation);
    const account = accountRow.exists ? accountRow.data() as PrivateMembershipAccount : null;
    if (account && (account.pendingReservation !== null || account.needsScan || account.checkpoint.pool !== op.pool
      || account.checkpoint.block < operation.checkpoint.block
      || (account.checkpoint.block === operation.checkpoint.block && account.checkpoint.blockHash !== operation.checkpoint.blockHash)
      || account.version !== initialAccount?.version || account.checkpoint.block !== pool.block || account.checkpoint.blockHash !== pool.blockHash)) return fail('reconciliation_pending');
    if (operation.kind === 'leave' && !account) return fail('not_joined');
    if (operation.kind === 'join' && account) joinPrivateMembership(account.episode, month, rules);
    const closure = operation.kind === 'leave' ? { block: pool.block, blockHash: pool.blockHash, logIndex: Number.MAX_SAFE_INTEGER, timestamp: pool.timestamp } : null;
    const complete = operation.kind === 'leave' && operation.bindings.every(b => !b.initiallyJoined);
    const next: PrivateMembershipTransition = { ...operation, closure, status: complete ? 'complete' : 'consenting' };
    if (account && operation.kind === 'leave') {
      const episode = leavePrivateMembership(account.episode, month, rules);
      tx.create(db.collection(C.receipts).doc(digest([id, 'private-closure'])), { ownerIdentity: op.ownerIdentity, transitionId: id,
        status: 'closed', position: closure, previousEpisode: account.episode, episode, previousVersion: account.version });
      tx.update(db.collection(C.owners).doc(op.ownerIdentity), { episode, closure, version: account.version + 1 });
    }
    tx.update(ref, { status: next.status, closure });
    if (complete) tx.update(db.collection(R.owners).doc(operation.ownerIdentity), { membershipTransition: null });
    return next;
  });
}

/** Individual signing payload. Owner keys never authorize an opaque portfolio
 * digest. A previous episode's public consent is closed before fresh admission. */
export function nextPrivateAddressConsent(operation: PrivateMembershipTransition, binding: string,
  current: { readonly revision: string; readonly ruleHash: string; readonly timestamp: number }): AddressMembershipConsent | null {
  if (operation.status !== 'consenting') return fail('not_ready');
  const row = operation.bindings.find(r => r.binding === binding);
  if (!row) return fail('binding');
  if (row.initiallyJoined && !row.departure) return { binding, account: row.address, nonce: row.nonce, joined: false,
    revision: current.revision, ruleHash: current.ruleHash, expiresAt: String(current.timestamp + 300) };
  if (operation.kind === 'leave' || row.admission) return null;
  return { binding, account: row.address, nonce: String(BigInt(row.nonce) + (row.initiallyJoined ? 1n : 0n)), joined: true,
    revision: current.revision, ruleHash: current.ruleHash, expiresAt: String(current.timestamp + 300) };
}

/** Receipts, not signatures, advance an operation. Admission is the LAST
 * required consent's canonical position. Every receipt is retained privately
 * and every public effect is consumed globally exactly once. */
export async function recordPrivateMembershipConsent(db: Firestore, id: string, receipt: VerifiedMembershipReceipt): Promise<PrivateMembershipTransition> {
  assertMembershipReceipt(receipt);
  const ref = db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(id), initial = await ref.get();
  if (!initial.exists) return fail('missing');
  const initialOp = initial.data() as PrivateMembershipTransition;
  const latest = [ { block: receipt.block, blockHash: receipt.blockHash }, ...initialOp.bindings.flatMap(b => b.admission ? [b.admission] : []) ]
    .sort((a, b) => b.block - a.block)[0];
  const rules = await readPrivateCalendarRules(db, { pool: initialOp.pool, block: latest.block, blockHash: latest.blockHash });
  return db.runTransaction(async tx => {
    const [row, accountRow] = await Promise.all([tx.get(ref), tx.get(db.collection(C.owners).doc(initialOp.ownerIdentity))]);
    if (!row.exists) return fail('missing');
    const operation = row.data() as PrivateMembershipTransition;
    const receiptRef = db.collection(C.receipts).doc(digest([id, receipt.transactionHash]));
    const existing = await tx.get(receiptRef);
    if (existing.exists) {
      if (existing.get('receiptHash') !== digest(receipt)) return fail('receipt_conflict');
      return operation;
    }
    if (digest(operation.bindings) !== digest(initialOp.bindings)) return fail('concurrent');
    if (operation.status !== 'consenting' || receipt.block <= operation.checkpoint.block) return fail('not_ready');
    await checkedPortfolio(tx, db, operation, true);
    const bindings = operation.bindings.map(r => ({ ...r }));
    const consumed: number[] = [];
    for (const event of receipt.events) {
      if (event.pool !== operation.pool || event.kernel !== operation.kernel) return fail('domain');
      if (event.name !== 'AddressConsentChanged') continue;
      const decoded = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data })!;
      const i = bindings.findIndex(r => r.binding === decoded.args.binding);
      if (i < 0) continue;
      const b = bindings[i], departure = b.initiallyJoined && !b.departure;
      if (!departure && (operation.kind === 'leave' || b.admission)) return fail('duplicate');
      const expectedNonce = BigInt(b.nonce) + (!departure && b.initiallyJoined ? 1n : 0n);
      if (decoded.args.joined !== !departure || BigInt(decoded.args.nonce) !== expectedNonce
        || BigInt(decoded.args.generation) !== BigInt(b.generation) + (departure ? 0n : 1n)) return fail('consent_mismatch');
      const position = { block: receipt.block, blockHash: receipt.blockHash, logIndex: event.logIndex, timestamp: receipt.timestamp };
      bindings[i] = { ...b, [departure ? 'departure' : 'admission']: position }; consumed.push(event.logIndex);
    }
    if (consumed.length === 0) return fail('missing_consent');
    const effects = consumed.map(logIndex => db.collection(C.effects).doc(digest([operation.kernel, operation.pool, receipt.transactionHash, logIndex])));
    if ((await Promise.all(effects.map(r => tx.get(r)))).some(r => r.exists)) return fail('effect_replay');
    const complete = bindings.every(b => operation.kind === 'join' ? b.admission !== null : !b.initiallyJoined || b.departure !== null);
    const next: PrivateMembershipTransition = { ...operation, bindings, status: complete ? 'complete' : 'consenting' };
    const account = accountRow.exists ? accountRow.data() as PrivateMembershipAccount : null;
    if (account?.pendingReservation != null) return fail('reconciliation_pending');
    let episode = account?.episode;
    let admission = account?.admission ?? null;
    if (complete && operation.kind === 'join') {
      const last = bindings.map(b => b.admission!).sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)[0];
      episode = joinPrivateMembership(account?.episode ?? null, utcCalendarMonth(last.timestamp), rules);
      admission = last;
    }
    tx.create(receiptRef, { ownerIdentity: operation.ownerIdentity, transitionId: id, receiptHash: digest(receipt), receipt,
      previousEpisode: account?.episode ?? null, episode: episode ?? null, previousVersion: account?.version ?? null,
      previousAdmission: account?.admission ?? null, previousClosure: account?.closure ?? null, admission });
    effects.forEach((ref, i) => tx.create(ref, { ownerIdentity: operation.ownerIdentity, transitionId: id,
      transactionHash: receipt.transactionHash, logIndex: consumed[i], block: receipt.block, blockHash: receipt.blockHash }));
    tx.update(ref, { bindings, status: next.status });
    if (complete) {
      tx.update(db.collection(R.owners).doc(operation.ownerIdentity), { membershipTransition: null });
      if (episode) {
        const state: PrivateMembershipAccount = { ownerIdentity: operation.ownerIdentity, version: (account?.version ?? -1) + 1,
          episode, checkpoint: account?.checkpoint ?? { pool: operation.pool, block: operation.checkpoint.block, blockHash: operation.checkpoint.blockHash },
          pendingReservation: null, needsScan: true, admission, closure: operation.kind === 'join' ? null : operation.closure };
        tx.set(db.collection(C.owners).doc(operation.ownerIdentity), state);
      }
    }
    return next;
  });
}

/** Recovery invalidates the old account's signatures without changing private
 * ownership. Resume the same operation with its independently recovered
 * replacement, after proving the consent nonce has not advanced unseen. */
export async function refreshRecoveredMembershipTransition(db: Firestore, id: string): Promise<PrivateMembershipTransition> {
  const ref = db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(id), row = await ref.get();
  if (!row.exists) return fail('missing');
  const operation = row.data() as PrivateMembershipTransition;
  if (operation.status === 'complete') return operation;
  const rows = await db.collection(R.addresses).where('ownerIdentity', '==', operation.ownerIdentity).get();
  const owner = await db.collection(R.owners).doc(operation.ownerIdentity).get();
  const ids = [...new Set(rows.docs.map(r => String(r.get('identity'))))].sort();
  if (JSON.stringify(ids) !== JSON.stringify(operation.bindings.map(b => b.binding).sort())) return fail('portfolio_changed');
  const chain = createRecourseChainPort(), block = await chain.finalizedBlock(), blockHash = await chain.blockHash(block);
  if (!blockHash || block < operation.checkpoint.block) return fail('checkpoint');
  const refreshed: RequiredConsent[] = [];
  for (const b of operation.bindings) {
    const current = await readHistoricalRecoursePoolState(b.binding, { block, blockHash });
    const addressRow = rows.docs.find(r => r.get('address') === current.currentAddress);
    const identity = await db.collection(R.identities).doc(b.binding).get();
    const expectedNonce = BigInt(b.nonce) + (b.departure ? 1n : 0n) + (b.admission ? 1n : 0n);
    if (current.pool !== operation.pool || current.kernel !== operation.kernel || BigInt(current.consentNonce) !== expectedNonce
      || current.addressConsent !== (b.admission ? true : b.departure ? false : b.initiallyJoined)
      || BigInt(current.consentGeneration) !== BigInt(b.generation) + (b.admission ? 1n : 0n)) return fail('reconciliation_pending');
    const generation = identity.get('recoveryGeneration');
    if (!addressRow || !identity.exists || identity.get('ownerIdentity') !== operation.ownerIdentity
      || addressRow.get('identity') !== b.binding || addressRow.get('kernel') !== current.kernel
      || addressRow.get('chainBindingStatus') !== 'confirmed' || addressRow.get('recoveryGeneration') !== generation
      || !Number.isSafeInteger(generation) || generation < b.recoveryGeneration
      || (current.currentAddress !== b.address && generation <= b.recoveryGeneration)) return fail('recovery_unconfirmed');
    refreshed.push({ ...b, address: current.currentAddress, recoveryGeneration: generation });
  }
  const next: PrivateMembershipTransition = { ...operation, bindings: refreshed, portfolioHash: digest(portfolio(rows.docs)),
    bindingSetVersion: version(owner.get('bindingSetVersion')) };
  await db.runTransaction(async tx => {
    const [latest, currentOwner, currentRows] = await Promise.all([tx.get(ref), tx.get(db.collection(R.owners).doc(operation.ownerIdentity)),
      tx.get(db.collection(R.addresses).where('ownerIdentity', '==', operation.ownerIdentity))]);
    const identities = await Promise.all(next.bindings.map(b => tx.get(db.collection(R.identities).doc(b.binding))));
    if (!latest.exists || digest(latest.data()) !== digest(operation) || currentOwner.get('membershipTransition') !== id
      || version(currentOwner.get('bindingSetVersion')) !== next.bindingSetVersion || digest(portfolio(currentRows.docs)) !== next.portfolioHash
      || identities.some((r, i) => r.get('ownerIdentity') !== operation.ownerIdentity || r.get('recoveryGeneration') !== next.bindings[i].recoveryGeneration)) return fail('concurrent');
    tx.update(ref, { bindings: next.bindings, portfolioHash: next.portfolioHash, bindingSetVersion: next.bindingSetVersion });
  });
  return next;
}
