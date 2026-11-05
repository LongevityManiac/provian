/**
 * Firestore + push for the remote presentation-request channel (; generalized to any two
 * parties by). The pure rules live in./presentation-request; this is the thin IO layer the
 * routers use.
 *
 * Every transition helper is TRANSACTIONAL, OWNERSHIP-GUARDED, and IDEMPOTENT:
 * - not found → { ok:false, status:404 }
 * - wrong party → { ok:false, status:403 }
 * - wrong source status → { ok:false, status:409 } (unless already AT the target
 * status, in which case the call is a no-op idempotent ok)
 *
 * Ownership is by ROLE: the requester composes/verifies/declines, the presenter presents. Legacy
 * rows (no `requester_id`/`presenter_id`) resolve the roles from `human_user_id` /
 * `agent_wallet_id`, so nothing already stored changes behavior.
 *
 * The Tier-3 `note` is written to the request row (the requester reads it) and is NEVER placed
 * in a push payload.
 */
import { signRequestChallenge } from './presentation-request-signing';
import { normalizePredicateRequests } from '../presentation/disclosure';
import type { ChallengeEnvelope } from '../presentation/challenge';
import type { Firestore } from 'firebase-admin/firestore';
import { sendPush, pruneUserTokens } from '../notifications/pushDispatcher';
import {
  PRESENTATION_REQUESTS_COLLECTION,
  applyComposedChallenge,
  applyPresentation,
  applyVerdict,
  applyDecline,
  presenterIdOf,
  requesterIdOf,
  type PresentationRequestRecord,
} from './presentation-request';

export async function writePresentationRequest(
  db: Pick<Firestore, 'collection'>,
  record: PresentationRequestRecord,
): Promise<void> {
  await db.collection(PRESENTATION_REQUESTS_COLLECTION).doc(record.request_id).set(record);
}

export async function getPresentationRequest(
  db: Pick<Firestore, 'collection'>,
  requestId: string,
): Promise<PresentationRequestRecord | null> {
  const snap = await db.collection(PRESENTATION_REQUESTS_COLLECTION).doc(requestId).get();
  return snap.exists ? (snap.data() as PresentationRequestRecord) : null;
}

/**
 * Unexpired requests for the linked human that NEED the human's action:
 * `requested` (compose a challenge) or `presented` (record a verdict). Includes
 * the Tier-3 note (this human only). The route applies `toHumanFacingRequest`.
 */
export async function listPendingRequestsForHuman(
  db: Pick<Firestore, 'collection'>,
  humanUserId: string,
  nowMs: number,
): Promise<PresentationRequestRecord[]> {
  const snap = await db.collection(PRESENTATION_REQUESTS_COLLECTION)
    .where('human_user_id', '==', humanUserId)
    .where('status', 'in', ['requested', 'presented'])
    .get();
  return snap.docs
    .map((d) => d.data() as PresentationRequestRecord)
    .filter((r) => r.expires_at_ms > nowMs)
    .sort((a, b) => b.created_at_ms - a.created_at_ms);
}

/** An agent polling its own requests (the route applies `toAgentFacingRequest`). */
export async function listRequestsForAgent(
  db: Pick<Firestore, 'collection'>,
  agentWalletId: string,
  status?: PresentationRequestRecord['status'],
): Promise<PresentationRequestRecord[]> {
  let q = db.collection(PRESENTATION_REQUESTS_COLLECTION).where('agent_wallet_id', '==', agentWalletId);
  if (status) q = q.where('status', '==', status);
  const snap = await q.get();
  return snap.docs
    .map((d) => d.data() as PresentationRequestRecord)
    .sort((a, b) => b.created_at_ms - a.created_at_ms);
}

/** every request a party is on either side of, optionally scoped to one thread. */
export async function listRequestsForParty(
  db: Pick<Firestore, 'collection'>,
  partyId: string,
  opts: { threadId?: string | null; status?: PresentationRequestRecord['status'] } = {},
): Promise<PresentationRequestRecord[]> {
  const [asRequester, asPresenter] = await Promise.all([
    db.collection(PRESENTATION_REQUESTS_COLLECTION).where('requester_id', '==', partyId).get(),
    db.collection(PRESENTATION_REQUESTS_COLLECTION).where('presenter_id', '==', partyId).get(),
  ]);
  const seen = new Set<string>();
  const out: PresentationRequestRecord[] = [];
  for (const d of [...asRequester.docs, ...asPresenter.docs]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const r = d.data() as PresentationRequestRecord;
    if (opts.threadId !== undefined && (r.thread_id ?? null) !== opts.threadId) continue;
    if (opts.status && r.status !== opts.status) continue;
    out.push(r);
  }
  return out.sort((a, b) => b.created_at_ms - a.created_at_ms);
}

export type TransitionResult =
  | { ok: true; record: PresentationRequestRecord }
  | { ok: false; status: number; error: string };

export type TransitionRole = 'requester' | 'presenter' | 'either';

function roleAllows(rec: PresentationRequestRecord, role: TransitionRole, partyId: string): boolean {
  const requester = requesterIdOf(rec);
  const presenter = presenterIdOf(rec);
  if (role === 'requester') return requester === partyId;
  if (role === 'presenter') return presenter === partyId;
  return requester === partyId || presenter === partyId;
}

/**
 * Shared transactional transition runner: load the row inside a txn, run the
 * role guard, run the pure transition, and persist. Idempotent: a repeat
 * that lands on an already-target status is a no-op ok; a genuine wrong-status
 * transition is 409.
 */
async function runTransition(
  db: FirebaseFirestore.Firestore,
  requestId: string,
  owner: { role: TransitionRole; partyId: string; denyError: string },
  targetStatus: PresentationRequestRecord['status'],
  apply: (record: PresentationRequestRecord) => { ok: true; record: PresentationRequestRecord } | { ok: false; error: string },
): Promise<TransitionResult> {
  const ref = db.collection(PRESENTATION_REQUESTS_COLLECTION).doc(requestId);
  let out: TransitionResult = { ok: false, status: 404, error: 'presentation request not found' };
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) { out = { ok: false, status: 404, error: 'presentation request not found' }; return; }
    const rec = snap.data() as PresentationRequestRecord;
    if (!roleAllows(rec, owner.role, owner.partyId)) { out = { ok: false, status: 403, error: owner.denyError }; return; }
    const applied = apply(rec);
    if (!applied.ok) {
      // Idempotent: a repeat that finds the row already at the target status is a no-op ok.
      if (rec.status === targetStatus) { out = { ok: true, record: rec }; return; }
      out = { ok: false, status: 409, error: applied.error };
      return;
    }
    txn.set(ref, applied.record);
    out = { ok: true, record: applied.record };
  });
  return out;
}

/**
 * Requester composes the challenge. Requester-owned; only from `requested`. the relay SIGNS
 * the composed challenge as the authenticated requester wallet (audience = the requester's party
 * id, the requester's nonce kept when well-formed, deadline = the request's delivery expiry), so the
 * presenter verifies who is asking before it burns. The client-supplied audience is superseded.
 */
export async function challengePresentationRequest(
  db: FirebaseFirestore.Firestore,
  params: { requestId: string; humanUserId?: string; requesterId?: string; audience: unknown; challenge: unknown; predicates?: unknown; nowMs: number },
): Promise<TransitionResult> {
  const partyId = params.requesterId ?? params.humanUserId ?? '';
  const predicates = normalizePredicateRequests(params.predicates ?? []);
  if (predicates === null) return { ok: false, status: 400, error: 'predicates must be an array of { field, op, threshold | set }' };
  const snap = await db.collection(PRESENTATION_REQUESTS_COLLECTION).doc(params.requestId).get();
  if (!snap.exists) return { ok: false, status: 404, error: 'presentation request not found' };
  const current = snap.data() as PresentationRequestRecord;
  if (requesterIdOf(current) !== partyId) return { ok: false, status: 403, error: 'not your presentation request' };
  if (current.tier === 'pe_fact' && predicates.length > 0) return { ok: false, status: 400, error: 'pe_fact presentations carry no predicates' };
  let envelope: ChallengeEnvelope | undefined;
  if (current.status === 'requested') {
    const signed = await signRequestChallenge(db, {
      requester_kind: current.requester_kind ?? 'human', requester_id: requesterIdOf(current),
      presenter_kind: current.presenter_kind ?? 'agent', presenter_id: presenterIdOf(current),
      expires_at_ms: current.expires_at_ms,
    }, { challenge: params.challenge, predicates, nowMs: params.nowMs });
    if (!signed.ok) return signed;
    envelope = signed.envelope;
  }
  return runTransition(
    db, params.requestId,
    { role: 'requester', partyId, denyError: 'not your presentation request' },
    'challenged',
    (rec) => applyComposedChallenge(rec, { audience: params.audience, challenge: params.challenge, predicates, nowMs: params.nowMs, envelope }),
  );
}

/** Presenter posts its produced presentation token back. Presenter-owned; only from `challenged`. */
export async function recordPresentationForRequest(
  db: FirebaseFirestore.Firestore,
  params: {
    requestId: string; agentWalletId?: string; presenterId?: string; burnId: unknown; presentationToken: unknown; nowMs: number;
    // verify-at-submit: the fresh verdict the relay computed against this request's
    // audience/challenge/predicates the instant the token arrived (while it is still valid).
    // Stored so the absent requester reads it instead of re-verifying an expired token.
    verdict?: unknown; predicateResults?: unknown;
  },
): Promise<TransitionResult> {
  return runTransition(
    db, params.requestId,
    { role: 'presenter', partyId: params.presenterId ?? params.agentWalletId ?? '', denyError: 'not your presentation request' },
    'presented',
    (rec) => applyPresentation(rec, {
      burn_id: params.burnId, presentation_token: params.presentationToken, nowMs: params.nowMs,
      verdict: params.verdict, predicate_results: params.predicateResults,
    }),
  );
}

/** Requester records the verdict after running the existing /v1/present/verify. Requester-owned; only from `presented`. */
export async function recordVerdictForRequest(
  db: FirebaseFirestore.Firestore,
  params: { requestId: string; humanUserId?: string; requesterId?: string; verdict: unknown; predicateResults?: unknown; nowMs: number },
): Promise<TransitionResult> {
  return runTransition(
    db, params.requestId,
    { role: 'requester', partyId: params.requesterId ?? params.humanUserId ?? '', denyError: 'not your presentation request' },
    'verified',
    (rec) => applyVerdict(rec, { verdict: params.verdict, predicate_results: params.predicateResults, nowMs: params.nowMs }),
  );
}

/** Requester declines the request. Requester-owned; from any non-terminal status. */
export async function declinePresentationRequest(
  db: FirebaseFirestore.Firestore,
  params: { requestId: string; humanUserId?: string; requesterId?: string },
): Promise<TransitionResult> {
  return runTransition(
    db, params.requestId,
    { role: 'requester', partyId: params.requesterId ?? params.humanUserId ?? '', denyError: 'not your presentation request' },
    'declined',
    (rec) => applyDecline(rec),
  );
}

/** Best-effort FCM to the human requester. Never throws — the app also polls the pending list. NEVER the note text. */
export async function pushPresentationRequestToHuman(
  db: FirebaseFirestore.Firestore,
  humanUserId: string,
  record: PresentationRequestRecord,
): Promise<void> {
  try {
    const userSnap = await db.collection('users').doc(humanUserId).get();
    const tokens = (userSnap.exists ? (userSnap.data()?.fcm_tokens as string[] | undefined) : undefined) ?? [];
    if (tokens.length === 0) return;
    const result = await sendPush(tokens, {
      tokenLanguages: userSnap.data()?.push_languages,
      title: 'Presentation requested',
      // Never the Tier-3 note in a push payload — only that a request exists.
      body: 'An agent is asking to present to you. Tap to compose the challenge.',
      data: { type: 'presentation_request', request_id: record.request_id, agent_wallet_id: record.agent_wallet_id },
    });
    await pruneUserTokens(db, humanUserId, result.invalidTokens);
  } catch (err) {
    console.error('[PresentationRequest] push failed (non-fatal):', err);
  }
}
