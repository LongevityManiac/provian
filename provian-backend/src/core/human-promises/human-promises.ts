/**
 * Human P2P promise — relay business logic.
 *
 * The human IOU lifecycle (create / accept / counter / reject / close-out /
 * dispute / broken / expired) now lives on the relay under human wallet auth,
 * replacing the Firestore `promise_sync` side-channel. This module is the state
 * machine: it enforces the EXACT client transition table, authorizes every
 * transition by a PARTY's wallet, verifies REAL EIP-191 signatures over the
 * promise digest for the agreement phases (create / accept / counter / close-out),
 * and stores only opaque per-party terms ciphertext + the digest. Push is wired by
 * the router; earning is read off the close-out record by the completion verifier.
 *
 * INVARIANTS (the server-side re-expression of firestore.rules:100-144):
 * - a transition is authorized only by the wallet of a PARTY to that promise;
 * - a party writes only its OWN party/close-out record, never the counterparty's;
 * - at most two parties (creator + one acceptor) ever sign;
 * - `accepted` requires BOTH parties to have signed the CURRENT digest;
 * - `fulfilled` requires BOTH parties' close-out signatures (no unilateral close);
 * - only a terms-signer may post a close-out signature;
 * - terminal states are terminal.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import {
  HUMAN_PROMISES_COLLECTION,
  HUMAN_PROMISE_TTL_MS,
  HUMAN_PROMISE_TERMINAL_STATUSES,
  isValidHumanPromiseTransition,
  type HumanPromiseDocument,
  type HumanPromiseStatus,
  type HumanPromisePartyRecord,
} from './types';
import {
  verifyHumanPromiseSignature,
  type HumanPromiseSignaturePhase,
} from './promise-signing';

/** The authenticated caller, resolved by the router (never client-supplied). */
export interface HumanPromiseCaller {
  readonly userId: string;
  /** Lowercased first-party human EVM address (from resolveHumanWallet). */
  readonly address: string;
}

const PROMISE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Cap opaque ciphertext to keep a doc small; ~ generous for a short IOU. */
const MAX_CIPHERTEXT_LEN = 20_000;

function requireString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  if (value.length > maxLen) {
    throw new ValidationError(`${name} is too long`);
  }
  return value;
}

function requirePromiseId(value: unknown): string {
  const s = requireString(value, 'promise_id', 121);
  if (!PROMISE_ID_RE.test(s)) throw new ValidationError('promise_id has an invalid format');
  return s;
}

function requireDigest(value: unknown): string {
  const s = requireString(value, 'digest', 64);
  if (!DIGEST_RE.test(s)) throw new ValidationError('digest must be a lowercase hex sha256');
  return s;
}

function readDoc(data: FirebaseFirestore.DocumentData | undefined): HumanPromiseDocument | null {
  if (!data) return null;
  return data as HumanPromiseDocument;
}

/** True when `address` is the creator or the acceptor (an established party). */
function isEstablishedParty(doc: HumanPromiseDocument, address: string): boolean {
  return doc.creator_address === address || doc.acceptor_address === address;
}

// ---------------------------------------------------------------------------
// create → pending
// ---------------------------------------------------------------------------

export interface CreateHumanPromiseParams {
  promiseId: unknown;
  digest: unknown;
  signature: unknown;
  termsCiphertext: unknown;
}

export async function createHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  params: CreateHumanPromiseParams,
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(params.promiseId);
  const digest = requireDigest(params.digest);
  const signature = requireString(params.signature, 'signature', 512);
  const termsCiphertext = requireString(params.termsCiphertext, 'terms_ciphertext', MAX_CIPHERTEXT_LEN);

  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');
  if (!verifyHumanPromiseSignature({ phase: 'create', promiseId, digest, signature, expectedAddress: caller.address })) {
    throw new ValidationError('create signature does not recover to the creating wallet');
  }

  const now = Date.now();
  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);

  const partyRecord: HumanPromisePartyRecord = {
    address: caller.address,
    role: 'creator',
    signature,
    signed_digest: digest,
    signed_at: now,
    terms_ciphertext: termsCiphertext,
  };

  const doc: HumanPromiseDocument = {
    promise_id: promiseId,
    digest,
    status: 'pending',
    creator_address: caller.address,
    creator_user_id: caller.userId,
    acceptor_address: null,
    acceptor_user_id: null,
    parties: { [caller.address]: partyRecord },
    closeout: {},
    created_at: now,
    updated_at: now,
    expires_at: now + HUMAN_PROMISE_TTL_MS,
  };

  // Create-once. A replay by the SAME creator returns the existing doc
  // (idempotent); a different creator claiming the same id is a conflict.
  return db.runTransaction(async (tx) => {
    const existing = readDoc((await tx.get(docRef)).data());
    if (existing) {
      if (existing.creator_address === caller.address) return existing;
      throw new ValidationError('promise_id already exists');
    }
    tx.set(docRef, doc);
    return doc;
  });
}

// ---------------------------------------------------------------------------
// accept → accepted
// ---------------------------------------------------------------------------

export interface AcceptHumanPromiseParams {
  promiseId: unknown;
  digest: unknown;
  signature: unknown;
  termsCiphertext: unknown;
}

export async function acceptHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  params: AcceptHumanPromiseParams,
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(params.promiseId);
  const digest = requireDigest(params.digest);
  const signature = requireString(params.signature, 'signature', 512);
  const termsCiphertext = requireString(params.termsCiphertext, 'terms_ciphertext', MAX_CIPHERTEXT_LEN);
  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');

  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);
  return db.runTransaction(async (tx) => {
    const doc = readDoc((await tx.get(docRef)).data());
    if (!doc) throw new NotFoundError('Promise not found');
    if (HUMAN_PROMISE_TERMINAL_STATUSES.has(doc.status)) {
      throw new ValidationError(`Promise is ${doc.status} and cannot be accepted`);
    }
    if (doc.status !== 'pending' && doc.status !== 'offered' && doc.status !== 'countered') {
      throw new ValidationError(`Promise status is ${doc.status}; cannot accept`);
    }
    // Accepting the CURRENT terms — the digest must match what is on record.
    if (digest !== doc.digest) throw new ValidationError('digest does not match the current promise terms');

    // Role: the creator accepting a counter, or the recipient accepting the offer.
    let role: 'creator' | 'acceptor';
    let acceptorAddress = doc.acceptor_address;
    let acceptorUserId = doc.acceptor_user_id;
    if (caller.address === doc.creator_address) {
      role = 'creator';
    } else {
      role = 'acceptor';
      if (doc.acceptor_address !== null && doc.acceptor_address !== caller.address) {
        throw new ForbiddenError('another wallet is already the acceptor of this promise');
      }
      acceptorAddress = caller.address;
      acceptorUserId = caller.userId;
    }

    if (!verifyHumanPromiseSignature({ phase: 'accept', promiseId, digest, signature, expectedAddress: caller.address })) {
      throw new ValidationError('accept signature does not recover to the accepting wallet');
    }

    const now = Date.now();
    const parties = { ...doc.parties };
    parties[caller.address] = {
      address: caller.address,
      role,
      signature,
      signed_digest: digest,
      signed_at: now,
      terms_ciphertext: termsCiphertext,
    };

    // `accepted` is valid only once BOTH parties exist AND both signed THIS digest.
    const bothPresent = doc.creator_address !== null && acceptorAddress !== null
      && acceptorAddress !== doc.creator_address;
    const creatorSigned = parties[doc.creator_address]?.signed_digest === doc.digest;
    const acceptorSigned = acceptorAddress !== null && parties[acceptorAddress]?.signed_digest === doc.digest;
    if (!bothPresent || !creatorSigned || !acceptorSigned) {
      // Should not happen on a well-formed accept; refuse rather than write a
      // half-agreed 'accepted'. (A self-accept — acceptor == creator — lands here.)
      throw new ValidationError('accept does not complete a two-party agreement on the current terms');
    }
    if (!isValidHumanPromiseTransition(doc.status, 'accepted')) {
      throw new ValidationError(`Invalid transition ${doc.status} → accepted`);
    }

    const updated: HumanPromiseDocument = {
      ...doc,
      status: 'accepted',
      acceptor_address: acceptorAddress,
      acceptor_user_id: acceptorUserId,
      parties,
      updated_at: now,
      // An accepted promise lives 30 days from the ACCEPTANCE, not from its creation: one
      // accepted on day 29 used to be purged the next day, before it could be closed out, and
      // every later close-out 404'd (2026-10-17 bug check).
      expires_at: now + HUMAN_PROMISE_TTL_MS,
    };
    tx.set(docRef, updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// counter → countered
// ---------------------------------------------------------------------------

export interface CounterHumanPromiseParams {
  promiseId: unknown;
  /** The digest of the NEW proposed terms. */
  digest: unknown;
  signature: unknown;
  termsCiphertext: unknown;
}

export async function counterHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  params: CounterHumanPromiseParams,
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(params.promiseId);
  const newDigest = requireDigest(params.digest);
  const signature = requireString(params.signature, 'signature', 512);
  const termsCiphertext = requireString(params.termsCiphertext, 'terms_ciphertext', MAX_CIPHERTEXT_LEN);
  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');

  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);
  return db.runTransaction(async (tx) => {
    const doc = readDoc((await tx.get(docRef)).data());
    if (!doc) throw new NotFoundError('Promise not found');
    if (doc.status !== 'pending' && doc.status !== 'offered' && doc.status !== 'countered') {
      throw new ValidationError(`Promise status is ${doc.status}; cannot counter`);
    }

    // The countering party: creator re-proposing, or the recipient countering.
    let role: 'creator' | 'acceptor';
    let acceptorAddress = doc.acceptor_address;
    let acceptorUserId = doc.acceptor_user_id;
    if (caller.address === doc.creator_address) {
      role = 'creator';
    } else {
      role = 'acceptor';
      if (doc.acceptor_address !== null && doc.acceptor_address !== caller.address) {
        throw new ForbiddenError('another wallet is already the acceptor of this promise');
      }
      acceptorAddress = caller.address;
      acceptorUserId = caller.userId;
    }
    if (acceptorAddress === doc.creator_address) {
      throw new ValidationError('cannot counter your own promise as the sole party');
    }

    if (!verifyHumanPromiseSignature({ phase: 'counter', promiseId, digest: newDigest, signature, expectedAddress: caller.address })) {
      throw new ValidationError('counter signature does not recover to the countering wallet');
    }
    if (!isValidHumanPromiseTransition(doc.status, 'countered')) {
      throw new ValidationError(`Invalid transition ${doc.status} → countered`);
    }

    const now = Date.now();
    const parties = { ...doc.parties };
    parties[caller.address] = {
      address: caller.address,
      role,
      signature,
      signed_digest: newDigest,
      signed_at: now,
      terms_ciphertext: termsCiphertext,
    };
    // The digest MOVES; the other party's prior signature is now over stale
    // terms, so they must re-sign (via accept) before `accepted` is valid again.
    const updated: HumanPromiseDocument = {
      ...doc,
      status: 'countered',
      digest: newDigest,
      acceptor_address: acceptorAddress,
      acceptor_user_id: acceptorUserId,
      parties,
      closeout: {},
      updated_at: now,
    };
    tx.set(docRef, updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// reject → rejected
// ---------------------------------------------------------------------------

export async function rejectHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  promiseIdRaw: unknown,
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(promiseIdRaw);
  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');
  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);
  return db.runTransaction(async (tx) => {
    const doc = readDoc((await tx.get(docRef)).data());
    if (!doc) throw new NotFoundError('Promise not found');
    if (doc.status !== 'pending' && doc.status !== 'offered' && doc.status !== 'countered') {
      throw new ValidationError(`Promise status is ${doc.status}; cannot reject`);
    }
    // A reject is a DECLINE, not an agreement — no digest signature. Authz: the
    // creator declining a counter, or the recipient declining the offer (who
    // thereby becomes the party of record). An established DIFFERENT acceptor
    // cannot be displaced by a stranger.
    let acceptorAddress = doc.acceptor_address;
    let acceptorUserId = doc.acceptor_user_id;
    if (caller.address !== doc.creator_address) {
      if (doc.acceptor_address !== null && doc.acceptor_address !== caller.address) {
        throw new ForbiddenError('another wallet is already the acceptor of this promise');
      }
      acceptorAddress = caller.address;
      acceptorUserId = caller.userId;
    }
    if (!isValidHumanPromiseTransition(doc.status, 'rejected')) {
      throw new ValidationError(`Invalid transition ${doc.status} → rejected`);
    }
    const now = Date.now();
    const updated: HumanPromiseDocument = {
      ...doc,
      status: 'rejected',
      acceptor_address: acceptorAddress,
      acceptor_user_id: acceptorUserId,
      updated_at: now,
    };
    tx.set(docRef, updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// close-out → fulfilled (requires BOTH parties' close-out signatures)
// ---------------------------------------------------------------------------

export interface CloseOutHumanPromiseParams {
  promiseId: unknown;
  signature: unknown;
}

export interface CloseOutResult {
  promise: HumanPromiseDocument;
  mode: 'fulfilled' | 'awaiting_counterparty';
}

export async function closeOutHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  params: CloseOutHumanPromiseParams,
): Promise<CloseOutResult> {
  const promiseId = requirePromiseId(params.promiseId);
  const signature = requireString(params.signature, 'signature', 512);
  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');

  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);
  return db.runTransaction(async (tx) => {
    const doc = readDoc((await tx.get(docRef)).data());
    if (!doc) throw new NotFoundError('Promise not found');
    if (doc.status !== 'accepted' && doc.status !== 'disputed') {
      throw new ValidationError(`Promise status is ${doc.status}; cannot close out`);
    }
    // Only a party (a terms-signer) may post a close-out signature.
    if (!isEstablishedParty(doc, caller.address) || !(caller.address in doc.parties)) {
      throw new ForbiddenError('only a party to this promise may close it out');
    }
    if (doc.acceptor_address === null) {
      throw new ValidationError('promise has no counterparty; cannot close out');
    }
    // The close-out signature covers the CURRENT agreed digest.
    if (!verifyHumanPromiseSignature({ phase: 'closeout', promiseId, digest: doc.digest, signature, expectedAddress: caller.address })) {
      throw new ValidationError('close-out signature does not recover to your wallet');
    }

    const now = Date.now();
    const closeout = { ...doc.closeout };
    closeout[caller.address] = { address: caller.address, signature, signed_at: now };

    // Fulfilled only once BOTH parties have posted a close-out signature — no
    // unilateral close (the firestore.rules two-closeout invariant, server-side).
    const bothClosed = doc.creator_address in closeout && doc.acceptor_address in closeout;
    let status: HumanPromiseStatus = doc.status;
    if (bothClosed) {
      if (!isValidHumanPromiseTransition(doc.status, 'fulfilled')) {
        throw new ValidationError(`Invalid transition ${doc.status} → fulfilled`);
      }
      status = 'fulfilled';
    }

    // a `fulfilled` promise is the EARNING WITNESS the completion verifier
    // reads to promote the `promise_fulfilled` PE (pending_evidence → eligible). If
    // the promise was closed near the end of its life, the original
    // `created_at + 30d` expiry could purge the record before the pending-evidence
    // resolver's next pass, stranding the PE at 0 mint. Reset the 30-day clock from
    // the CLOSE so a fulfilled record always outlives promotion by a wide margin;
    // non-fulfilled transitions keep the original expiry.
    const expiresAt = bothClosed ? now + HUMAN_PROMISE_TTL_MS : doc.expires_at;
    const updated: HumanPromiseDocument = { ...doc, status, closeout, updated_at: now, expires_at: expiresAt };
    tx.set(docRef, updated);
    return { promise: updated, mode: bothClosed ? 'fulfilled' as const : 'awaiting_counterparty' as const };
  });
}

// ---------------------------------------------------------------------------
// dispute → disputed  /  broken → broken
// ---------------------------------------------------------------------------

async function partyStatusTransition(
  db: Firestore,
  caller: HumanPromiseCaller,
  promiseIdRaw: unknown,
  target: 'disputed' | 'broken',
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(promiseIdRaw);
  if (!ADDRESS_RE.test(caller.address)) throw new ValidationError('caller has no valid EVM address');
  const docRef = db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId);
  return db.runTransaction(async (tx) => {
    const doc = readDoc((await tx.get(docRef)).data());
    if (!doc) throw new NotFoundError('Promise not found');
    if (!isEstablishedParty(doc, caller.address)) {
      throw new ForbiddenError('only a party to this promise may change its status');
    }
    if (!isValidHumanPromiseTransition(doc.status, target)) {
      throw new ValidationError(`Invalid transition ${doc.status} → ${target}`);
    }
    const updated: HumanPromiseDocument = { ...doc, status: target, updated_at: Date.now() };
    tx.set(docRef, updated);
    return updated;
  });
}

export function disputeHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  promiseIdRaw: unknown,
): Promise<HumanPromiseDocument> {
  return partyStatusTransition(db, caller, promiseIdRaw, 'disputed');
}

export function brokenHumanPromise(
  db: Firestore,
  caller: HumanPromiseCaller,
  promiseIdRaw: unknown,
): Promise<HumanPromiseDocument> {
  return partyStatusTransition(db, caller, promiseIdRaw, 'broken');
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Read one promise by id. Possession of the unguessable id is the read
 * capability (as the retired promise_sync get()-by-id was), so any authenticated
 * wallet that holds the id may read the opaque doc — needed so a recipient can
 * read a pending promise BEFORE they are a party in order to accept it.
 */
export async function getHumanPromise(
  db: Firestore,
  promiseIdRaw: unknown,
): Promise<HumanPromiseDocument> {
  const promiseId = requirePromiseId(promiseIdRaw);
  const snap = await db.collection(HUMAN_PROMISES_COLLECTION).doc(promiseId).get();
  const doc = readDoc(snap.exists ? snap.data() : undefined);
  if (!doc) throw new NotFoundError('Promise not found');
  return doc;
}

/**
 * Every promise the caller is a party to (creator OR acceptor). Drives wallet
 * recovery — a restored device rebuilds its promises and decrypts its own terms
 * copy — and the foreground sync that replaces the onSnapshot listener.
 */
export async function listMyHumanPromises(
  db: Firestore,
  caller: HumanPromiseCaller,
  limit = 200,
): Promise<HumanPromiseDocument[]> {
  // A fresh collection reference per query — a Query is built from a
  // CollectionReference, so the two filters must not share one builder.
  const [asCreator, asAcceptor] = await Promise.all([
    db.collection(HUMAN_PROMISES_COLLECTION).where('creator_address', '==', caller.address).limit(limit).get(),
    db.collection(HUMAN_PROMISES_COLLECTION).where('acceptor_address', '==', caller.address).limit(limit).get(),
  ]);
  const seen = new Set<string>();
  const out: HumanPromiseDocument[] = [];
  for (const d of [...asCreator.docs, ...asAcceptor.docs]) {
    const doc = readDoc(d.data());
    if (!doc || seen.has(doc.promise_id)) continue;
    seen.add(doc.promise_id);
    out.push(doc);
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// expiry / purge (30 days, as the retired Firestore TTL)
// ---------------------------------------------------------------------------

/**
 * DELETE every doc past its `expires_at` (terminal or not) — the server-side
 * equivalent of the promise_sync 30-day Firestore TTL auto-delete. No status is
 * written first: a doc is never flipped to `expired` on the relay, it is simply
 * removed. Returns `purged` (docs deleted) and `expired` (how many of those were
 * still non-terminal at deletion — a count only). Bounded per run.
 */
export async function processHumanPromiseExpiry(
  db: Firestore,
  nowMs: number = Date.now(),
  limit = 500,
): Promise<{ expired: number; purged: number }> {
  const col = db.collection(HUMAN_PROMISES_COLLECTION);
  const snap = await col.where('expires_at', '<=', nowMs).limit(limit).get();
  if (snap.empty) return { expired: 0, purged: 0 };
  let expired = 0;
  let purged = 0;
  const batch = db.batch();
  for (const d of snap.docs) {
    const doc = readDoc(d.data());
    if (!doc) continue;
    // Count a still-open promise as `expired` for the run report. Nothing is
    // written to it: the doc is deleted outright below, so a device that polls
    // afterwards finds it gone (never a relay-side `expired` status).
    if (!HUMAN_PROMISE_TERMINAL_STATUSES.has(doc.status) && doc.status !== 'expired') {
      expired++;
    }
    batch.delete(d.ref);
    purged++;
  }
  await batch.commit();
  return { expired, purged };
}
