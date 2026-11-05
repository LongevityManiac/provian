import {prepareAgentDelivery} from './agent-delivery';
/**
 * COMMONS THREADS — bilateral communication.
 *
 * A THREAD is anchored to a job, a human job, a want, an escrow, a dispute, or a wallet's profile,
 * and has exactly two parties (agent or human, any mix). Every message is a PE
 * (`commons_thread_message`) with the content hash sealed in the author's chain; the CONTENT is
 * end-to-end ciphertext between the parties, relay-held, the Promises pattern — the relay cannot
 * read it (`./message-keys.ts`; the sealed-box format of the agent-recovery escrow).
 *
 * A PRESENTATION OPENS A VOICE, ONCE. Opening a thread on a shared artifact (a job you posted or applied
 * to, an escrow you are party to, a dispute, a want) IS an open relationship — nothing further is
 * required. Opening a thread with a wallet you have NO relationship with (a profile anchor)
 * requires a live presentation window opener → target (one burn-to-present presentation to that
 * wallet, folded, never stacked). Once a thread exists, messages both ways are free to send.
 *
 * A MESSAGE MINTS ONLY UNDER A LIVE PASS (, fact-base fixes item 1). Sending is
 * unchanged: inside an open relationship a message needs no pass. Minting is not: a message seals
 * `eligible` at the `relay_verified` class base only while its author holds a live PASS — a
 * presentation to `provian:commons` within its window — and its record points are reserved against
 * that pass's burn (`core/pvt/speech-window-budget.ts`), so "what a wallet mints from speech is
 * strictly less than the burn that opened its pass" holds for bilateral speech too. With no live
 * pass the message records and seals `record_only` (`speech_no_live_pass_record_only`). A
 * presentation to the COUNTERPARTY opens the relationship (sending); it is not the pass (minting).
 *
 * PRESENTATIONS TRAVEL INSIDE THREADS between ANY two wallets: a party requests (the relay composes
 * the audience = the requester's id and a fresh nonce), the other presents (verify-at-submit; the
 * relay's fresh verdict is authoritative), and both the request and the presentation are thread
 * messages. A presentation to the requester's id is, by construction, a live rail handshake
 * presenter → requester. The only verifiable fact in a thread is an attached presentation.
 *
 * DELIVERY: agents through the per-wallet inbox (`entity_type: 'thread'`) + targeted webhooks
 * (`thread_message`); humans through push (never content) + the attention center.
 */

import { signRequestChallenge } from '../pe/presentation-request-signing';
import { createHash, randomBytes } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import type { AgentBankDeps } from '../agent-bank/types';
import { enqueueAgentBankEvent } from '../agent-bank/event-outbox';
import { sendPushToUser } from '../notifications/pushDispatcher';
import { normalizePredicateRequests } from '../presentation/disclosure';
import { verifyFreshPresentationToken, type VerifyFreshDeps } from '../pe/presentation-submit-verify';
import {
  buildPartyPresentationRequest,
  presenterIdOf,
  requesterIdOf,
  type PresentationRequestRecord,
} from '../pe/presentation-request';
import {
  getPresentationRequest,
  listRequestsForParty,
  recordPresentationForRequest,
  recordVerdictForRequest,
  writePresentationRequest,
} from '../pe/presentation-request-store';
import { PVT_BURN_RECORDS_COLLECTION, parseAmountAtomic } from './burn-consumption';
import {
  findLiveSpeechWindow,
  hasOpenRelationship,
  openRelationshipBasis,
  isAgentPartyId,
  presenterWalletIdOf,
  resolveSpeechCommitter,
  speechWindowParam,
  SPEECH_AUDIENCE,
  SpeechWindowRequiredError,
  type PartyRef,
  type SpeechWindow,
} from './speech-window';
import { COMMONS_COLLECTIONS } from './types';

export type ThreadAnchorKind = 'job' | 'human_job' | 'want' | 'escrow' | 'dispute' | 'profile';
export const THREAD_ANCHOR_KINDS: readonly ThreadAnchorKind[] = Object.freeze(['job', 'human_job', 'want', 'escrow', 'dispute', 'profile']);

export type ThreadMessageKind = 'text' | 'presentation_request' | 'presentation' | 'deliverable';

/**
 * WHO wrote a message. A client (either party, through the thread routes,
 * the SDK, MCP or the app) may post only `text`. A `presentation_request`, a `presentation` and a
 * `deliverable` are posted ONLY by the relay's own functions (`requestPresentationInThread`,
 * `presentInThread`, `postDeliverableMessage`), which compose their attachment from state the relay
 * holds — so `origin: 'relay'` is the one fact a reader may rely on, and nothing a client sends can
 * set it. A message stored before has no `origin` and reads as a client message.
 */
export type ThreadMessageOrigin = 'client' | 'relay';

/** The kinds only the relay posts. A client body naming one is refused (400) before anything is written. */
export const RELAY_ONLY_THREAD_MESSAGE_KINDS: readonly ThreadMessageKind[] = Object.freeze(['presentation_request', 'presentation', 'deliverable']);

/** Bounds. Ciphertext is base64url; 64 KiB per recipient copy bounds abuse, not use. */
export const THREAD_LIMITS = {
  ciphertextMaxLen: 65_536,
  attachmentMaxKeys: 16,
  pageDefault: 50,
  pageMax: 200,
} as const;

export interface ThreadActor {
  walletId: string;
  agentId: string;
  actorAddress: string | null;
  isAgent: boolean;
}

/** What let the thread open: a shared artifact, or an open relationship (incl. a live handshake). */
export type ThreadBacking =
  | { kind: 'anchor' }
  | { kind: 'relationship' };

export interface ThreadDocument {
  thread_id: string;
  anchor_kind: ThreadAnchorKind;
  anchor_id: string;
  /** The two party ids, lexicographically ordered (the dedupe / query key). */
  party_a: string;
  party_b: string;
  parties: Record<string, PartyRef>;
  opened_by: string;
  backing: ThreadBacking;
  created_at: number;
  last_message_at: number;
  message_count: number;
  /** Per-party read cursor (ms of the last message the party read). */
  read_cursors: Record<string, number>;
  /**
   * set when a COLD contact opened this thread on a burn alone (the opener's talking
   * pass, or a live handshake with no standing relationship). If that burn never reaches finality the
   * thread is `revoked` it stops counting as a relationship, and a party writes to it again only
   * under a relationship or a live pass of their own.
   */
  opened_under_burn_id?: string;
  revoked?: boolean;
  revoked_at?: number;
}

export interface ThreadMessage {
  message_id: string;
  thread_id: string;
  author_id: string;
  author_kind: 'agent' | 'human';
  kind: ThreadMessageKind;
  /** Per-party E2E ciphertext (base64url sealed box), keyed by party id. The relay cannot read it. */
  ciphertexts: Record<string, string>;
  /** sha256 of the plaintext (hex) — the fact sealed in the author's PE. Null for attachment-only messages. */
  content_sha256: string | null;
  /** Structured, non-secret attachment (a presentation request / outcome, a deliverable locator). */
  attachment: Record<string, unknown> | null;
  pe_id: string;
  /** Whether the message's PE sealed under the author's live pass (mint-bounded) or recorded without one. */
  minted_under_window: boolean;
  /** set by the relay on every message it writes; absent on messages stored before (= client). */
  origin?: ThreadMessageOrigin;
  created_at: number;
}

export interface OpenThreadInput {
  anchor: { kind: ThreadAnchorKind; id: string };
  /** Required for `profile`, and for a poster/depositor opening an anchor thread toward one counterparty. */
  counterparty?: string | null;
  message: MessageInput;
}

export interface MessageInput {
  /** A client may send only `text` (or omit it). The other kinds are relay-originated. */
  kind?: unknown;
  ciphertexts: unknown;
  content_sha256?: unknown;
  attachment?: unknown;
  /** Sender-scoped retry identity; one message and PE across concurrent retries. */
  idempotency_key?: unknown;
}

const HEX64 = /^[a-f0-9]{64}$/;
const B64U = /^[A-Za-z0-9_-]+$/;

export function partyKindOf(id: string): 'agent' | 'human' {
  return isAgentPartyId(id) ? 'agent' : 'human';
}

export function partyOf(actor: { walletId: string; isAgent: boolean }): PartyRef {
  return { kind: actor.isAgent ? 'agent' : 'human', id: actor.walletId };
}

function threadIdFor(anchorKind: ThreadAnchorKind, anchorId: string, a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `thr_${createHash('sha256').update(`${anchorKind}:${anchorId}:${x}:${y}`).digest('hex').slice(0, 32)}`;
}

async function partyExists(db: Firestore, party: PartyRef): Promise<boolean> {
  try {
    if (party.kind === 'agent') {
      const snap = await db.collection('agent_wallets').doc(party.id).get();
      return snap.exists && (snap.data() as { status?: unknown }).status === 'active';
    }
    const snap = await db.collection('users').doc(party.id).get();
    return snap.exists;
  } catch {
    return false;
  }
}

/** Resolve the two parties an anchor implies, given who is opening. */
async function resolveAnchorParties(
  db: Firestore,
  opener: PartyRef,
  anchor: { kind: ThreadAnchorKind; id: string },
  counterparty: string | null,
): Promise<{ other: PartyRef; backing: ThreadBacking; openerIsParty: boolean }> {
  // `openerIsParty` is true ONLY when BOTH the opener and the resolved counterparty are named
  // parties of the anchor — a shared anchor is a relationship; a one-sided anchor (a poster naming
  // any wallet on an unassigned job / want) is a cold contact and pays like one (round-2 defect 1).
  let openerIsParty = false;
  const pick = (ids: Array<string | null | undefined>): string | null => {
    const clean = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (clean.includes(opener.id)) {
      const others = clean.filter((x) => x !== opener.id);
      if (counterparty) {
        if (others.includes(counterparty)) { openerIsParty = true; return counterparty; }
        if (others.length > 0) throw new ForbiddenError('counterparty is not a party to this anchor');
        return counterparty; // the anchor names only the opener: reaching a stranger through it
      }
      if (others[0]) { openerIsParty = true; return others[0]; }
      return null;
    }
    // The opener is NOT a named party of the anchor: a stranger reaching the anchor's owner
    // (an applicant to a job, a fulfiller to a want) — the owner is the counterparty.
    return clean[0] ?? null;
  };

  switch (anchor.kind) {
    case 'job': {
      const snap = await db.collection('jobs').doc(anchor.id).get();
      if (!snap.exists) throw new NotFoundError('Job not found');
      const job = snap.data() as { poster_wallet_id?: string; assigned_wallet_id?: string | null; status?: string };
      const other = pick([job.poster_wallet_id, job.assigned_wallet_id]);
      if (!other) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(other), id: other }, backing: { kind: 'anchor' }, openerIsParty };
    }
    case 'human_job': {
      const snap = await db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(anchor.id).get();
      if (!snap.exists) throw new NotFoundError('Job not found');
      const job = snap.data() as { poster_wallet_id?: string; accepted_applicant_wallet_id?: string | null };
      const other = pick([job.poster_wallet_id, job.accepted_applicant_wallet_id]);
      if (!other) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(other), id: other }, backing: { kind: 'anchor' }, openerIsParty };
    }
    case 'want': {
      const snap = await db.collection('commons_wants').doc(anchor.id).get();
      if (!snap.exists) throw new NotFoundError('Want not found');
      const want = snap.data() as { poster_wallet_id?: string; matched_fulfiller_wallet_id?: string | null };
      const other = pick([want.poster_wallet_id, want.matched_fulfiller_wallet_id]);
      if (!other) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(other), id: other }, backing: { kind: 'anchor' }, openerIsParty };
    }
    case 'escrow': {
      const snap = await db.collection('escrows').doc(anchor.id).get();
      if (!snap.exists) throw new NotFoundError('Escrow not found');
      const e = snap.data() as { depositor_wallet_id?: string; recipient_wallet_id?: string };
      const ids = [e.depositor_wallet_id, e.recipient_wallet_id];
      if (!ids.includes(opener.id)) throw new ForbiddenError('Only an escrow party can open its thread');
      const other = pick(ids);
      if (!other) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(other), id: other }, backing: { kind: 'anchor' }, openerIsParty: true };
    }
    case 'dispute': {
      const snap = await db.collection('general_disputes').doc(anchor.id).get();
      if (!snap.exists) throw new NotFoundError('Dispute not found');
      const d = snap.data() as { filed_by?: string; respondent?: string };
      const ids = [d.filed_by, d.respondent];
      if (!ids.includes(opener.id)) throw new ForbiddenError('Only a dispute party can open its thread');
      const other = pick(ids);
      if (!other) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(other), id: other }, backing: { kind: 'anchor' }, openerIsParty: true };
    }
    case 'profile': {
      const target = counterparty ?? anchor.id;
      if (!target || target === opener.id) throw new ValidationError('counterparty is required');
      return { other: { kind: partyKindOf(target), id: target }, backing: { kind: 'relationship' }, openerIsParty: false };
    }
    default:
      throw new ValidationError('unknown anchor kind');
  }
}

/**
 * the kind a message may carry for its origin. A client may send only `text` (or omit the
 * field); a presentation request, a presentation or a deliverable is refused, because only the relay's
 * own functions compose those from state it holds. Before a client could post
 * `{kind:'presentation', attachment:{verdict:'valid'}}` and it sealed `verified: true`.
 */
function messageKindFor(rawKind: unknown, origin: ThreadMessageOrigin): ThreadMessageKind {
  if (rawKind === undefined || rawKind === null || rawKind === 'text') return 'text';
  const relayOnly = typeof rawKind === 'string' && (RELAY_ONLY_THREAD_MESSAGE_KINDS as readonly string[]).includes(rawKind);
  if (relayOnly && origin === 'relay') return rawKind as ThreadMessageKind;
  if (relayOnly) throw new ValidationError(`kind '${String(rawKind)}' is posted by the relay only; a client message must be kind 'text'`);
  throw new ValidationError("kind must be 'text'");
}

function normalizeMessageInput(input: MessageInput, parties: readonly string[], origin: ThreadMessageOrigin): {
  kind: ThreadMessageKind; ciphertexts: Record<string, string>; contentSha256: string | null; attachment: Record<string, unknown> | null;
} {
  const kind = messageKindFor(input?.kind, origin);
  const ciphertexts: Record<string, string> = {};
  if (input.ciphertexts !== undefined && input.ciphertexts !== null) {
    if (typeof input.ciphertexts !== 'object' || Array.isArray(input.ciphertexts)) {
      throw new ValidationError('ciphertexts must be an object keyed by party id');
    }
    for (const [party, blob] of Object.entries(input.ciphertexts as Record<string, unknown>)) {
      if (!parties.includes(party)) throw new ValidationError(`ciphertext addressed to a non-party: ${party}`);
      if (typeof blob !== 'string' || blob.length === 0 || blob.length > THREAD_LIMITS.ciphertextMaxLen || !B64U.test(blob)) {
        throw new ValidationError('each ciphertext must be a non-empty base64url string within the size bound');
      }
      ciphertexts[party] = blob;
    }
  }
  let contentSha256: string | null = null;
  if (input.content_sha256 !== undefined && input.content_sha256 !== null) {
    if (typeof input.content_sha256 !== 'string' || !HEX64.test(input.content_sha256)) {
      throw new ValidationError('content_sha256 must be 64 lowercase hex chars');
    }
    contentSha256 = input.content_sha256;
  }
  let attachment: Record<string, unknown> | null = null;
  if (input.attachment !== undefined && input.attachment !== null) {
    if (typeof input.attachment !== 'object' || Array.isArray(input.attachment)) throw new ValidationError('attachment must be an object');
    const entries = Object.entries(input.attachment as Record<string, unknown>);
    if (entries.length > THREAD_LIMITS.attachmentMaxKeys) throw new ValidationError('attachment has too many keys');
    attachment = Object.fromEntries(entries);
  }
  if (kind === 'text') {
    const hasCipher = Object.keys(ciphertexts).length > 0;
    if (hasCipher && !contentSha256) throw new ValidationError('a text message needs content_sha256');
    if (!hasCipher && !attachment) throw new ValidationError('a text message needs a ciphertext (E2E) or an attachment');
  }
  return { kind, ciphertexts, contentSha256, attachment };
}

/**
 * The author's live PASS — a presentation to `provian:commons` within its window — or null. The pass
 * is what a message mints under (and is budgeted against); a presentation to the counterparty opens
 * the relationship for sending but is not the pass.
 */
async function authorPass(db: Firestore, author: ThreadActor): Promise<SpeechWindow | null> {
  const committer = await resolveSpeechCommitter(db, author);
  return findLiveSpeechWindow(db, committer, SPEECH_AUDIENCE, Date.now());
}

function otherParty(thread: ThreadDocument, partyId: string): PartyRef {
  const other = thread.party_a === partyId ? thread.party_b : thread.party_a;
  return thread.parties[other];
}

function assertParty(thread: ThreadDocument, partyId: string): void {
  if (thread.party_a !== partyId && thread.party_b !== partyId) {
    throw new ForbiddenError('Not a party to this thread');
  }
}

// ─── Open / read ────────────────────────────────────────────────────────────

/** Open (or reuse) a thread with a CLIENT first message — which may only be `text`. */
export async function openThread(
  deps: AgentBankDeps,
  actor: ThreadActor,
  input: OpenThreadInput,
): Promise<{ thread: ThreadDocument; message: ThreadMessage; created: boolean }> {
  return openThreadAs(deps, actor, input, 'client');
}

async function openThreadAs(
  deps: AgentBankDeps,
  actor: ThreadActor,
  input: OpenThreadInput,
  origin: ThreadMessageOrigin,
): Promise<{ thread: ThreadDocument; message: ThreadMessage; created: boolean }> {
  // refuse a relay-only kind BEFORE the thread document is written.
  messageKindFor(input?.message?.kind, origin);
  const anchorKind = input?.anchor?.kind;
  const anchorId = typeof input?.anchor?.id === 'string' ? input.anchor.id.trim() : '';
  if (!THREAD_ANCHOR_KINDS.includes(anchorKind)) throw new ValidationError('anchor.kind must be job|human_job|want|escrow|dispute|profile');
  if (!anchorId) throw new ValidationError('anchor.id is required');
  const opener = partyOf(actor);
  const counterparty = typeof input.counterparty === 'string' && input.counterparty.trim() ? input.counterparty.trim() : null;

  const { other, backing: anchorBacking, openerIsParty } = await resolveAnchorParties(deps.db, opener, { kind: anchorKind, id: anchorId }, counterparty);
  if (other.id === opener.id) throw new ValidationError('cannot open a thread with yourself');
  if (!(await partyExists(deps.db, other))) throw new NotFoundError('counterparty not found');

  const now = Date.now();
  const threadId = threadIdFor(anchorKind, anchorId, opener.id, other.id);
  const threadRef = deps.db.collection(COMMONS_COLLECTIONS.THREADS).doc(threadId);
  const existing = await threadRef.get();
  if (existing.exists) {
    const thread = existing.data() as ThreadDocument;
    const message = await postMessageAs(deps, actor, thread, input.message, origin);
    return { thread: { ...thread, last_message_at: message.created_at, message_count: thread.message_count + 1 }, message, created: false };
  }

  // The gate: a shared anchor the opener is a NAMED PARTY of IS the relationship. Every other
  // opener is a COLD CONTACT — a profile anchor, or a stranger reaching a job / want owner (an
  // applicant, a would-be fulfiller) — and needs an open relationship, which a live presentation
  // window opener → target (one burn-to-present) IS (`hasOpenRelationship` counts a live handshake
  // in either direction), or the opener's live Commons speech window (the one burn that prices
  // every Commons write, §1.1). Neither → 428 naming the target the opener must present to.
  // (negative control: the anchor path was wider than the relationship it stood in for.)
  const backing: ThreadBacking = anchorBacking;
  const coldContact = anchorKind === 'profile' || !openerIsParty;
  // the burn a cold open stands on, when it stands on a burn alone.
  let openedUnderBurnId: string | null = null;
  if (coldContact) {
    const basis = await openRelationshipBasis(deps.db, opener, other, now);
    if (basis === null) {
      const committer = await resolveSpeechCommitter(deps.db, actor);
      const commonsWindow = await findLiveSpeechWindow(deps.db, committer, SPEECH_AUDIENCE, now);
      if (!commonsWindow) {
        const cp = await resolveSpeechCommitter(deps.db, { walletId: other.id, isAgent: other.kind === 'agent' });
        throw new SpeechWindowRequiredError(cp.audienceId);
      }
      openedUnderBurnId = commonsWindow.burnId;
    } else if (basis.kind === 'handshake') {
      openedUnderBurnId = basis.burnId;
    }
  }

  const [a, b] = [opener.id, other.id].sort();
  const thread: ThreadDocument = {
    thread_id: threadId,
    anchor_kind: anchorKind,
    anchor_id: anchorId,
    party_a: a,
    party_b: b,
    parties: { [opener.id]: opener, [other.id]: other },
    opened_by: opener.id,
    backing,
    created_at: now,
    last_message_at: now,
    message_count: 0,
    read_cursors: { [opener.id]: now, [other.id]: 0 },
    ...(openedUnderBurnId ? { opened_under_burn_id: openedUnderBurnId } : {}),
  };
  try {
    await threadRef.create(thread as unknown as FirebaseFirestore.DocumentData);
  } catch (err) {
    if ((err as { code?: number }).code === 6) {
      const again = (await threadRef.get()).data() as ThreadDocument;
      const message = await postMessageAs(deps, actor, again, input.message, origin);
      return { thread: again, message, created: false };
    }
    throw err;
  }
  const message = await postMessageAs(deps, actor, thread, input.message, origin);
  return { thread: { ...thread, message_count: 1, last_message_at: message.created_at }, message, created: true };
}

export async function getThread(deps: AgentBankDeps, threadId: string, viewerId: string): Promise<ThreadDocument> {
  const snap = await deps.db.collection(COMMONS_COLLECTIONS.THREADS).doc(threadId).get();
  if (!snap.exists) throw new NotFoundError('Thread not found');
  const thread = snap.data() as ThreadDocument;
  assertParty(thread, viewerId);
  return thread;
}

/** A thread as a READ returns it: the stored document plus the parties' published names (never stored). */
export type ThreadView<T extends ThreadDocument = ThreadDocument> = T & {
  /** (read-time only): each party's PUBLISHED Commons profile `display_name`, blank → null. */
  display_names: Record<string, string | null>;
};

/**
 * One party's PUBLISHED Commons display name, or null. The profile document is keyed by the party's
 * Commons wallet id — the agent wallet id, or the human's user id (the id every Commons write and
 * every thread party carries). A human whose profile is keyed by their first-party `wallets/{doc}`
 * id instead is resolved through that id. Only `display_name` is read; a failure is null, never an
 * error.
 */
async function publishedDisplayName(db: Firestore, party: PartyRef): Promise<string | null> {
  const nameOf = (data: unknown): string | null => {
    const name = (data as { display_name?: unknown } | undefined)?.display_name;
    return typeof name === 'string' && name.trim().length > 0 ? name : null;
  };
  try {
    const direct = await db.collection(COMMONS_COLLECTIONS.PROFILES).doc(party.id).get();
    if (direct.exists) return nameOf(direct.data());
    if (party.kind !== 'human') return null;
    const walletDocId = await presenterWalletIdOf(db, party);
    if (!walletDocId || walletDocId === party.id) return null;
    const viaWallet = await db.collection(COMMONS_COLLECTIONS.PROFILES).doc(walletDocId).get();
    return viaWallet.exists ? nameOf(viaWallet.data()) : null;
  } catch {
    return null; // a name is cosmetic — the thread still reads
  }
}

/** Attach `display_names` (read-time, never stored) to threads; one profile read per distinct party. */
export async function withThreadDisplayNames<T extends ThreadDocument>(deps: AgentBankDeps, threads: T[]): Promise<Array<ThreadView<T>>> {
  const parties = new Map<string, PartyRef>();
  for (const t of threads) {
    for (const id of [t.party_a, t.party_b]) {
      if (typeof id !== 'string' || id.length === 0 || parties.has(id)) continue;
      const stored = t.parties?.[id];
      parties.set(id, stored && (stored.kind === 'agent' || stored.kind === 'human') ? { kind: stored.kind, id } : { kind: partyKindOf(id), id });
    }
  }
  const names = new Map<string, string | null>();
  await Promise.all([...parties.values()].map(async (party) => {
    names.set(party.id, await publishedDisplayName(deps.db, party));
  }));
  return threads.map((t) => ({
    ...t,
    display_names: Object.fromEntries([t.party_a, t.party_b].map((id) => [id, names.get(id) ?? null])),
  }));
}

/** `getThread` for a READ response: party-checked, with `display_names`. */
export async function getThreadView(deps: AgentBankDeps, threadId: string, viewerId: string): Promise<ThreadView> {
  const thread = await getThread(deps, threadId, viewerId);
  return (await withThreadDisplayNames(deps, [thread]))[0];
}

export async function listThreads(deps: AgentBankDeps, partyId: string): Promise<Array<ThreadView<ThreadDocument & { unread: boolean }>>> {
  const [asA, asB] = await Promise.all([
    deps.db.collection(COMMONS_COLLECTIONS.THREADS).where('party_a', '==', partyId).get(),
    deps.db.collection(COMMONS_COLLECTIONS.THREADS).where('party_b', '==', partyId).get(),
  ]);
  const rows = [...asA.docs, ...asB.docs].map((d) => d.data() as ThreadDocument);
  return withThreadDisplayNames(deps, rows
    .sort((x, y) => y.last_message_at - x.last_message_at)
    .map((t) => ({ ...t, unread: t.last_message_at > (t.read_cursors?.[partyId] ?? 0) })));
}

export async function listMessages(
  deps: AgentBankDeps,
  thread: ThreadDocument,
  opts: { limit?: number; before?: number; beforeId?: string } = {},
): Promise<ThreadMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? THREAD_LIMITS.pageDefault, 1), THREAD_LIMITS.pageMax);
  const { FieldPath } = await import('firebase-admin/firestore');
  let q = deps.db.collection(COMMONS_COLLECTIONS.THREAD_MESSAGES)
    .where('thread_id', '==', thread.thread_id)
    .orderBy('created_at', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(limit) as FirebaseFirestore.Query;
  const hasBefore = typeof opts.before === 'number' && Number.isFinite(opts.before);
  if (hasBefore && opts.beforeId) q = q.startAfter(opts.before, opts.beforeId);
  if (hasBefore && !opts.beforeId) q = q.where('created_at', '<', opts.before);
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as ThreadMessage).reverse();
}

/**
 * Mark a thread read for `partyId`. With no `upTo` the cursor moves to now (everything in the thread is
 * read). With `upTo` the `created_at` of the newest message the reader was actually shown — it moves
 * to that moment only, never past now and never backwards, so a message that arrived after the reader
 * fetched, or one older than the page it was shown, stays unread (the read loop,).
 */
export async function markRead(deps: AgentBankDeps, thread: ThreadDocument, partyId: string, nowMs: number = Date.now(), upTo?: number): Promise<void> {
  assertParty(thread, partyId);
  const ref = deps.db.collection(COMMONS_COLLECTIONS.THREADS).doc(thread.thread_id);
  if (upTo === undefined) {
    await ref.update({ [`read_cursors.${partyId}`]: nowMs });
    return;
  }
  if (!Number.isSafeInteger(upTo) || upTo < 0) throw new ValidationError('up_to must be a message created_at (unix ms)');
  const target = Math.min(upTo, nowMs);
  await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const current = (snap.data() as ThreadDocument | undefined)?.read_cursors?.[partyId] ?? 0;
    if (target > current) txn.update(ref, { [`read_cursors.${partyId}`]: target });
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * Post a CLIENT message: seal its `commons_thread_message` PE (content hash only) in the same
 * transaction as the message document, bump the thread, and deliver to the counterparty. A client
 * message may only be `text`; the relay-only kinds go through `postMessageAs(…, 'relay')`,
 * reachable only from this module's own relay functions.
 */
export async function postMessage(
  deps: AgentBankDeps,
  actor: ThreadActor,
  thread: ThreadDocument,
  input: MessageInput,
): Promise<ThreadMessage> {
  return postMessageAs(deps, actor, thread, input, 'client');
}

async function postMessageAs(
  deps: AgentBankDeps,
  actor: ThreadActor,
  thread: ThreadDocument,
  input: MessageInput,
  origin: ThreadMessageOrigin,
): Promise<ThreadMessage> {
  assertParty(thread, actor.walletId);
  const parties = [thread.party_a, thread.party_b];
  const { kind, ciphertexts, contentSha256, attachment } = normalizeMessageInput(input, parties, origin);
  const relayOriginated = origin === 'relay';
  const counterparty = otherParty(thread, actor.walletId);
  const window = await authorPass(deps.db, actor);
  const now = Date.now();
  // a thread revoked because the burn it was opened on never reached finality is no
  // relationship. Writing to it again needs a relationship or a live pass of the author's own.
  if (thread.revoked === true && !window && !(await hasOpenRelationship(deps.db, thread.parties[actor.walletId], counterparty, now))) {
    const cp = await resolveSpeechCommitter(deps.db, { walletId: counterparty.id, isAgent: counterparty.kind === 'agent' });
    throw new SpeechWindowRequiredError(cp.audienceId);
  }
  const retryKey = input.idempotency_key;
  if (retryKey !== undefined && (typeof retryKey !== 'string' || !/^[A-Za-z0-9_:-]{1,160}$/.test(retryKey))) throw new ValidationError('Invalid idempotency_key');
  const messageId = typeof retryKey === 'string'
    ? `msg_${createHash('sha256').update(JSON.stringify([actor.walletId, thread.thread_id, retryKey])).digest('hex').slice(0,24)}`
    : `msg_${randomBytes(12).toString('hex')}`;
  const msgRef = deps.db.collection(COMMONS_COLLECTIONS.THREAD_MESSAGES).doc(messageId);
  const threadRef = deps.db.collection(COMMONS_COLLECTIONS.THREADS).doc(thread.thread_id);
  const { FieldValue } = await import('firebase-admin/firestore');

  let appendDelivery: (Awaited<ReturnType<typeof prepareAgentDelivery>>) | undefined;
  let messageCreatedAt = now;
  const build = (peId: string): ThreadMessage => ({
    message_id: messageId,
    thread_id: thread.thread_id,
    author_id: actor.walletId,
    author_kind: actor.isAgent ? 'agent' : 'human',
    kind,
    ciphertexts,
    content_sha256: contentSha256,
    attachment,
    pe_id: peId,
    minted_under_window: window !== null,
    origin,
    created_at: messageCreatedAt,
    ...(appendDelivery ? { notification_sequence: appendDelivery.sequence } : {}),
  });

  if (retryKey !== undefined) {
    const existing = (await msgRef.get()).data() as ThreadMessage | undefined;
    if (existing) return existing;
  }
  class MessageAlreadyCommitted extends Error { constructor(readonly committed: ThreadMessage) { super('Message already committed'); } }
  let senderWasCaughtUp = false;
  let lastMessageAt = now;
  let senderCursor = now;
  let peId: string;
  try { ({ peId } = await generatePE(deps, {
    walletId: actor.walletId,
    agentId: actor.agentId,
    actorAddress: actor.actorAddress,
    ownerType: actor.isAgent ? 'agent' : 'human',
    actionType: 'commons_thread_message',
    metadata: {
      thread_id: thread.thread_id,
      message_id: messageId,
      kind,
      anchor_kind: thread.anchor_kind,
      anchor_id: thread.anchor_id,
      content_sha256: contentSha256,
      origin,
      // `verified` is the relay's claim about the message's CONTENT. It holds only for a
      // message the relay composed itself (a request it signed, a verdict it computed, a delivery it
      // recorded); a client message is the author's speech and carries no such claim. Pricing is
      // unmoved: this row's evidence is the relay_verified witness class, never this flag.
      ...(relayOriginated ? { verified: true } : {}),
      ...(relayOriginated && attachment?.request_id ? { request_id: attachment.request_id } : {}),
    },
    ...(contentSha256 ? { output_digests: [{ hash: `sha256:${contentSha256}`, kind: 'artifact' }] } : {}),
    witnessClass: 'relay_verified',
    // (fact-base fixes item 1): a message mints ONLY under the author's live pass
    // and only inside that pass's budget. With no pass it still records — durable, so the accrual
    // seals it `record_only` under its own reason (`speech_no_live_pass_record_only`) — and sending
    // is never gated inside a relationship. Supersedes the 2026-09-22 "mints at its base with no
    // window" carry.
    durableViaOrdinaryIntake: true,
    ...(window ? { speechWindow: speechWindowParam(window) } : {}),
    atomicEntityPrecondition: async (txn: Transaction) => {
      if (retryKey !== undefined) {
        const existing = (await txn.get(msgRef)).data() as ThreadMessage | undefined;
        if (existing) throw new MessageAlreadyCommitted(existing);
      }
      const current = (await txn.get(threadRef)).data() as ThreadDocument | undefined;
      // Sending only covers the author's own new message. A concurrent incoming message
      // must remain unread until an explicit bounded read acknowledges it.
      appendDelivery = counterparty.kind === 'agent' ? await prepareAgentDelivery(deps.db, txn, counterparty.id) : undefined;
      const previousCursor = current?.read_cursors?.[actor.walletId] ?? 0;
      senderWasCaughtUp = !!current && previousCursor >= current.last_message_at;
      messageCreatedAt = Math.max(now, current?.message_count ? current.last_message_at + 1 : now);
      lastMessageAt = messageCreatedAt;
      senderCursor = Math.max(messageCreatedAt, previousCursor);
    },
    atomicEntityWrite: (txn: Transaction, generatedPeId: string) => {
      txn.create(msgRef, build(generatedPeId));
      appendDelivery?.(thread.thread_id, messageId);
      txn.update(threadRef, {
        last_message_at: lastMessageAt,
        message_count: FieldValue.increment(1),
        ...(senderWasCaughtUp ? { [`read_cursors.${actor.walletId}`]: senderCursor } : {}),
      });
    },
  })); } catch (error) {
    if (error instanceof MessageAlreadyCommitted) return error.committed;
    throw error;
  }
  const message = build(peId);
  await deliverThreadMessage(deps, thread, message, counterparty).catch((err) => {
    console.error('[Threads] delivery failed (message is durable):', err);
  });
  return message;
}

/** Deliver a message to the counterparty: agent → inbox + webhook; human → push (never content). */
async function deliverThreadMessage(
  deps: AgentBankDeps,
  thread: ThreadDocument,
  message: ThreadMessage,
  counterparty: PartyRef,
): Promise<void> {
  const data: Record<string, unknown> = {
    thread_id: thread.thread_id,
    message_id: message.message_id,
    kind: message.kind,
    anchor_kind: thread.anchor_kind,
    anchor_id: thread.anchor_id,
    content_sha256: message.content_sha256,
    origin: message.origin ?? 'client',
    ...(message.origin === 'relay' && message.attachment?.request_id ? { request_id: message.attachment.request_id } : {}),
  };
  if (counterparty.kind === 'agent') {
    await enqueueAgentBankEvent(deps.db, {
      walletId: message.author_id,
      eventType: 'thread_message',
      transactionAmount: 0,
      amountUnit: 'pvt_whole',
      recipients: [counterparty.id],
      entityId: thread.thread_id,
      entityType: 'thread',
      counterparties: { [counterparty.id]: message.author_id },
      data,
      notifyOnly: true,
    });
  } else {
    await sendPushToUser(deps.db, counterparty.id, {
      title: message.kind === 'presentation_request' ? 'Presentation requested'
        : message.kind === 'presentation' ? 'A presentation arrived'
          : message.kind === 'deliverable' ? 'A deliverable arrived'
            : 'New message',
      body: 'Open the thread in Provian to read it.',
      data: { type: 'thread_message', thread_id: thread.thread_id, message_id: message.message_id, kind: message.kind },
    });
  }
}

/** Unread thread count + the unread threads for a human's attention center. */
export async function unreadThreadsFor(deps: AgentBankDeps, partyId: string): Promise<Array<ThreadView<ThreadDocument & { unread: boolean }>>> {
  const all = await listThreads(deps, partyId);
  return all.filter((t) => t.unread);
}

// ─── Presentations inside a thread ──────────────────────────────────────────

export interface RequestPresentationInThreadInput {
  tier?: unknown;
  predicates?: unknown;
  note?: unknown;
  /** Optional E2E note for the presenter (kept off the request record). */
  ciphertexts?: unknown;
  content_sha256?: unknown;
}

/**
 * The caller REQUESTS the other party to present. The relay composes the binding (audience = the
 * requester's id, a fresh 32-byte nonce, the requester's predicates) so the request is immediately
 * `challenged`; the request rides the thread as a `presentation_request` message.
 */
export async function requestPresentationInThread(
  deps: AgentBankDeps,
  actor: ThreadActor,
  thread: ThreadDocument,
  input: RequestPresentationInThreadInput,
): Promise<{ request: PresentationRequestRecord; message: ThreadMessage }> {
  assertParty(thread, actor.walletId);
  const requester = partyOf(actor);
  const presenter = otherParty(thread, actor.walletId);
  const predicates = normalizePredicateRequests(input.predicates ?? []);
  if (predicates === null) throw new ValidationError('predicates must be an array of { field, op, threshold | set }');
  const tier = input.tier === 'pe_fact' ? 'pe_fact' : 'reputation';
  if (tier === 'pe_fact' && predicates.length > 0) throw new ValidationError('pe_fact presentations carry no predicates');
  const now = Date.now();
  const built = buildPartyPresentationRequest({
    requester, presenter, threadId: thread.thread_id, initiator: 'requester', tier, note: input.note, nowMs: now,
  });
  if (!built.ok) throw new ValidationError(built.error);
  const requesterCommitter = await resolveSpeechCommitter(deps.db, actor);
  // the relay SIGNS the challenge it composes, as the authenticated requester wallet
  // (audience = the requester's party id — the id the rail handshake keys on), so the presenter
  // verifies who is asking before it burns.
  const signed = await signRequestChallenge(deps.db, {
    requester_kind: built.record.requester_kind, requester_id: requesterCommitter.audienceId,
    presenter_kind: built.record.presenter_kind, presenter_id: built.record.presenter_id,
    expires_at_ms: built.record.expires_at_ms,
  }, { challenge: randomBytes(32).toString('hex'), predicates, nowMs: now });
  if (!signed.ok) throw new ValidationError(signed.error);
  const record: PresentationRequestRecord = {
    ...built.record,
    status: 'challenged',
    audience: signed.envelope.audience,
    challenge: signed.envelope.challenge,
    predicates,
    challenge_envelope: signed.envelope,
    challenged_at_ms: now,
  };
  await writePresentationRequest(deps.db, record);
  const message = await postMessageAs(deps, actor, thread, {
    kind: 'presentation_request',
    ciphertexts: input.ciphertexts ?? {},
    content_sha256: input.content_sha256,
    attachment: {
      request_id: record.request_id,
      tier: record.tier,
      audience: record.audience,
      challenge: record.challenge,
      predicates,
      expires_at_ms: record.expires_at_ms,
      challenge_envelope: signed.envelope,
    },
  }, 'relay');
  return { request: record, message };
}

/**
 * The PRESENTER answers a thread request with a fresh presentation token (verify-at-submit). The
 * relay's fresh verdict is authoritative and the request goes straight to `verified`; the outcome
 * rides the thread as a `presentation` message. The presentation (audience = the requester's id)
 * is a live rail handshake presenter → requester by construction.
 */
export async function presentInThread(
  deps: AgentBankDeps,
  actor: ThreadActor,
  thread: ThreadDocument,
  requestId: string,
  body: { burn_id?: unknown; presentation_token?: unknown; ciphertexts?: unknown; content_sha256?: unknown },
  verifyDeps: VerifyFreshDeps,
): Promise<{ request: PresentationRequestRecord; message: ThreadMessage }> {
  assertParty(thread, actor.walletId);
  const current = await getPresentationRequest(deps.db, requestId);
  if (!current || current.thread_id !== thread.thread_id) throw new NotFoundError('presentation request not found in this thread');
  if (presenterIdOf(current) !== actor.walletId) throw new ForbiddenError('Only the requested presenter can present');
  if (current.status !== 'challenged') throw new ValidationError(`cannot present from status '${current.status}'`);
  if (current.expires_at_ms <= Date.now()) throw new ValidationError('the request has expired');
  const token = typeof body.presentation_token === 'string' ? body.presentation_token : '';
  if (!token) throw new ValidationError('presentation_token is required');
  const fresh = await verifyFreshPresentationToken(
    { token, audience: current.audience, challenge: current.challenge, predicates: current.predicates, challengeEnvelope: current.challenge_envelope ?? null },
    verifyDeps,
  );
  // nonce-gap control: the verified token must describe THE PRESENTER — not a third party's
  // record handed in by the party the request named.
  if (fresh.verdict === 'valid') {
    const committer = await resolveSpeechCommitter(deps.db, actor);
    const ownIds = new Set([actor.walletId, committer.presenterWalletId].filter((x): x is string => typeof x === 'string' && x.length > 0));
    if (!fresh.presenter || !ownIds.has(fresh.presenter.sub)) {
      throw new ForbiddenError('The presentation must be the presenter\'s own — it describes another wallet');
    }
    if (actor.actorAddress && fresh.presenter.presenter_address && fresh.presenter.presenter_address !== actor.actorAddress.toLowerCase()) {
      throw new ForbiddenError('The presentation must be the presenter\'s own — its address is not the presenter\'s');
    }
  }
  const now = Date.now();
  const presented = await recordPresentationForRequest(deps.db, {
    requestId, presenterId: actor.walletId, burnId: body.burn_id, presentationToken: token,
    verdict: fresh.verdict, predicateResults: fresh.predicate_results, nowMs: now,
  });
  if (!presented.ok) {
    if (presented.status === 404) throw new NotFoundError(presented.error);
    if (presented.status === 403) throw new ForbiddenError(presented.error);
    throw new ValidationError(presented.error);
  }
  // The relay's fresh verdict is authoritative (applyVerdict keeps it); record it for the requester.
  const verified = await recordVerdictForRequest(deps.db, {
    requestId, requesterId: requesterIdOf(current), verdict: fresh.verdict, predicateResults: fresh.predicate_results, nowMs: now,
  });
  const record = verified.ok ? verified.record : presented.record;
  const message = await postMessageAs(deps, actor, thread, {
    kind: 'presentation',
    ciphertexts: body.ciphertexts ?? {},
    content_sha256: body.content_sha256,
    attachment: {
      request_id: requestId,
      tier: record.tier,
      verdict: record.verdict,
      predicate_results: record.predicate_results ?? [],
      burn_id: record.burn_id,
      // a pe_fact verdict is valid only after the canonical PEAnchor check ran.
      onchain_checked: fresh.onchain_checked === true,
    },
  }, 'relay');
  return { request: record, message };
}

export async function listThreadPresentationRequests(
  deps: AgentBankDeps,
  thread: ThreadDocument,
  viewerId: string,
): Promise<PresentationRequestRecord[]> {
  assertParty(thread, viewerId);
  return listRequestsForParty(deps.db, viewerId, { threadId: thread.thread_id });
}

/**
 * (item 9, the bell): every thread presentation request waiting on THIS party to present —
 * inside a thread, addressed to the viewer, still `challenged`, not expired. An unread thread leaves
 * the bell once it is read, but a request inside it still waits on the presenter until it is
 * presented (→ `verified`) or expires; this is what keeps it on the bell until then. Newest first.
 */
export async function pendingThreadPresentationRequestsFor(
  deps: AgentBankDeps,
  viewerId: string,
  nowMs: number,
): Promise<PresentationRequestRecord[]> {
  const rows = await listRequestsForParty(deps.db, viewerId, { status: 'challenged' });
  return rows.filter((r) => typeof r.thread_id === 'string' && r.thread_id.length > 0
    && presenterIdOf(r) === viewerId && r.expires_at_ms > nowMs);
}

// ─── Deliverables (jobs) ────────────────────────────────────────────────────

export interface DeliverableInput {
  deliverable_uri?: unknown;
  deliverable_body?: unknown;
}

export interface NormalizedDeliverable {
  uri: string | null;
  body: string | null;
  sha256: string;
}

const URI_RE = /^(https?:\/\/[^\s]+|ipfs:\/\/[^\s]+|ar:\/\/[^\s]+|git:[^\s]+)$/i;

/** A deliverable is a URI and/or a body (≤ 20 KB); its sha256 is what the delivery PE seals. */
export function normalizeDeliverable(input: DeliverableInput | undefined | null): NormalizedDeliverable | null {
  const uri = typeof input?.deliverable_uri === 'string' ? input.deliverable_uri.trim() : '';
  const body = typeof input?.deliverable_body === 'string' ? input.deliverable_body : '';
  if (!uri && !body) return null;
  if (uri && (uri.length > 2048 || !URI_RE.test(uri))) throw new ValidationError('deliverable_uri must be an http(s)/ipfs/ar/git locator');
  if (body.length > 20_000) throw new ValidationError('deliverable_body must be at most 20,000 characters');
  const sha256 = createHash('sha256').update(body || uri).digest('hex');
  return { uri: uri || null, body: body || null, sha256 };
}

/**
 * what a DELIVERY PE may say about its deliverable. A PE is a public record (PE history, the
 * wallet export, the proof read), so it carries the deliverable's sha256 and — when there is a
 * locator — the locator's sha256, never the locator itself (a private URL, a signed link, a token in a
 * query string) and never a `locator` on its output digest. The body and the locator reach the two
 * parties only: the job read for a party and the job's thread. Already-sealed PEs are never rewritten.
 */
export function deliverablePeMetadata(d: NormalizedDeliverable): { deliverable_sha256: string; deliverable_uri_sha256?: string } {
  return {
    deliverable_sha256: d.sha256,
    ...(d.uri ? { deliverable_uri_sha256: createHash('sha256').update(d.uri).digest('hex') } : {}),
  };
}

/** The delivery PE's output digest: the deliverable's hash only (no locator). */
export function deliverableOutputDigests(d: NormalizedDeliverable): Array<{ hash: string; kind: 'artifact' }> {
  return [{ hash: `sha256:${d.sha256}`, kind: 'artifact' }];
}

/** The job's thread between poster and worker (null if none was ever opened). */
export async function findAnchorThread(
  deps: AgentBankDeps,
  anchorKind: ThreadAnchorKind,
  anchorId: string,
  a: string,
  b: string,
): Promise<ThreadDocument | null> {
  const snap = await deps.db.collection(COMMONS_COLLECTIONS.THREADS).doc(threadIdFor(anchorKind, anchorId, a, b)).get();
  return snap.exists ? (snap.data() as ThreadDocument) : null;
}

/** Post the delivery into the job's thread (creates it if the parties never talked). */
export async function postDeliverableMessage(
  deps: AgentBankDeps,
  actor: ThreadActor,
  anchorKind: 'job' | 'human_job',
  anchorId: string,
  counterpartyId: string,
  deliverable: NormalizedDeliverable,
  deliveryPeId: string,
): Promise<ThreadMessage | null> {
  try {
    let thread = await findAnchorThread(deps, anchorKind, anchorId, actor.walletId, counterpartyId);
    const attachment = { deliverable_uri: deliverable.uri, deliverable_sha256: deliverable.sha256, delivery_pe_id: deliveryPeId };
    if (!thread) {
      const opened = await openThreadAs(deps, actor, {
        anchor: { kind: anchorKind, id: anchorId },
        counterparty: counterpartyId,
        message: { kind: 'deliverable', ciphertexts: {}, attachment },
      }, 'relay');
      return opened.message;
    }
    return await postMessageAs(deps, actor, thread, { kind: 'deliverable', ciphertexts: {}, attachment }, 'relay');
  } catch (err) {
    console.error('[Threads] deliverable message failed (delivery is already recorded):', err);
    return null;
  }
}

/** Reads a burn row's verified amount (for callers that budget a PE under a presentation burn). */
export async function burnAmountAtomicOf(db: Firestore, burnId: string): Promise<string> {
  const snap = await db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId).get();
  return snap.exists ? parseAmountAtomic((snap.data() as Record<string, unknown>).amount_atomic).toString() : '0';
}
