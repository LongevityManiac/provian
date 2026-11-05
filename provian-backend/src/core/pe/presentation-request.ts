/**
 * REMOTE PRESENTATION-REQUEST CHANNEL (, Trust Layer; generalized by).
 *
 * The QR two-QR flow is the IN-PERSON burn-to-present path. This is the remote analogue: two
 * parties run the EXISTING burn-to-present primitive when NOT physically co-present, over a
 * relay-delivered request channel. There is NO new tier and NO burn-free path — the presenter still
 * burns via the existing `/present` routes; this only carries the handshake (request → composed
 * challenge → presented token → recorded verdict) between the two parties.
 *
 * It mirrors the human_approval_requests channel EXACTLY ({@link./human-approval-request}): a PURE
 * module (build / apply-transition / projection, no Firestore, no FCM, no clock beyond an injected
 * `nowMs`) so every rule is unit-tested with its RED control; the store wires storage +
 * push, and the routes wire auth + ownership.
 *
 * PARTIES : a request has a REQUESTER (who composes the challenge and reads the verdict)
 * and a PRESENTER (who burns and presents). Either may be an agent or a human, so presentation
 * requests travel inside threads between ANY two wallets. The agent → own-linked-human
 * request is now ONE case of this record (presenter = the agent, requester = its linked human);
 * the legacy `agent_wallet_id` / `human_user_id` fields stay populated for that case so the
 * existing routes and queries keep working unchanged.
 *
 * PRIVACY (§3): the optional `note` is Tier-3 — shown ONLY to the requester on their authenticated
 * channel. It is NEVER in a push payload and NEVER in a PE. The presenter-facing projection omits
 * it entirely (along with the requester's identity beyond the audience string).
 */
import type { ChallengeEnvelope } from '../presentation/challenge';
import { randomBytes } from 'crypto';

export const PRESENTATION_REQUESTS_COLLECTION = 'presentation_requests_v1';

/** How long a request stays actionable before it expires (7 days — the handshake window, mirrors the approval channel). */
export const PRESENTATION_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PartyKind = 'agent' | 'human';
export type PresentationRequestDirection =
  | 'agent_presents_to_human'
  | 'human_presents_to_agent'
  | 'agent_presents_to_agent'
  | 'human_presents_to_human';
/** `agent` is the legacy value (the presenter agent initiated); the values name the role. */
export type PresentationRequestInitiator = 'agent' | 'requester' | 'presenter';
export type PresentationTier = 'pe_fact' | 'reputation';
export type PresentationRequestStatus =
  | 'requested'   // presenter offered / requester asked; awaiting the requester's composed challenge
  | 'challenged'  // requester composed audience/challenge/predicates; awaiting the presenter's presentation
  | 'presented'   // presenter burned + posted a token back; awaiting the requester's recorded verdict
  | 'verified'    // a verdict (valid|invalid) is recorded — terminal
  | 'declined'    // the requester declined — terminal
  | 'expired';    // TTL elapsed — terminal

/** Bounds on the optional Tier-3 note (shown only to the requester; kept off every public surface and every PE). */
const NOTE_MAX = 240;

export interface PresentationRequestRecord {
  readonly request_id: string;
  readonly direction: PresentationRequestDirection;
  /** LEGACY : the agent party's wallet id when exactly one party is an agent, else ''. */
  readonly agent_wallet_id: string;
  /** LEGACY : the human party's user id when exactly one party is a human, else ''. */
  readonly human_user_id: string;
  /** party refs (the authoritative ownership fields). */
  readonly requester_id: string;
  readonly requester_kind: PartyKind;
  readonly presenter_id: string;
  readonly presenter_kind: PartyKind;
  /** The thread this request travels in (null for the legacy linked-pair channel). */
  readonly thread_id: string | null;
  readonly initiator: PresentationRequestInitiator;
  readonly tier: PresentationTier;
  /** Tier-3: optional short note, readable ONLY by the requester; never in a push or a PE. */
  readonly note: string | null;
  readonly status: PresentationRequestStatus;
  /** Composed by the requester (verifier role) at the `challenged` transition. */
  readonly audience: string | null;
  readonly challenge: string | null;
  readonly predicates: unknown[] | null;
  /** the relay-SIGNED challenge envelope (wallet requester). Absent on pre- rows. */
  readonly challenge_envelope?: ChallengeEnvelope | null;
  /** Filled by the presenter at the `presented` transition. */
  readonly burn_id: string | null;
  readonly presentation_token: string | null;
  /** Filled by the requester (or relay) at the `verified` transition. */
  readonly verdict: 'valid' | 'invalid' | null;
  readonly predicate_results: unknown[] | null;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly challenged_at_ms: number | null;
  readonly presented_at_ms: number | null;
  readonly verified_at_ms: number | null;
}

export interface BuildPresentationRequestInput {
  readonly agentWalletId: string;
  readonly humanUserId: string;
  readonly tier?: unknown;
  readonly note?: unknown;
  readonly nowMs: number;
}

export interface PartyRefInput {
  readonly kind: PartyKind;
  readonly id: string;
}

export interface BuildPartyPresentationRequestInput {
  readonly requester: PartyRefInput;
  readonly presenter: PartyRefInput;
  readonly threadId: string | null;
  readonly initiator: 'requester' | 'presenter';
  readonly tier?: unknown;
  readonly note?: unknown;
  readonly nowMs: number;
}

export type BuildPresentationRequestResult =
  | { readonly ok: true; readonly record: PresentationRequestRecord }
  | { readonly ok: false; readonly error: string };

export type ApplyResult =
  | { readonly ok: true; readonly record: PresentationRequestRecord }
  | { readonly ok: false; readonly error: string };

function isValidTier(t: unknown): t is PresentationTier {
  return t === 'pe_fact' || t === 'reputation';
}

function normalizeNote(raw: unknown): { ok: true; note: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, error: 'note must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length > NOTE_MAX) return { ok: false, error: `note exceeds ${NOTE_MAX} chars` };
  return { ok: true, note: trimmed.length > 0 ? trimmed : null };
}

export function directionOf(presenter: PartyKind, requester: PartyKind): PresentationRequestDirection {
  return `${presenter}_presents_to_${requester}` as PresentationRequestDirection;
}

/** The general builder: any two parties, either initiator. Fails CLOSED on a bad party/tier/note. */
export function buildPartyPresentationRequest(input: BuildPartyPresentationRequestInput): BuildPresentationRequestResult {
  const rId = typeof input.requester?.id === 'string' ? input.requester.id.trim() : '';
  const pId = typeof input.presenter?.id === 'string' ? input.presenter.id.trim() : '';
  if (!rId) return { ok: false, error: 'requester is required' };
  if (!pId) return { ok: false, error: 'presenter is required' };
  if (rId === pId) return { ok: false, error: 'requester and presenter must differ' };
  const rKind = input.requester.kind;
  const pKind = input.presenter.kind;
  if ((rKind !== 'agent' && rKind !== 'human') || (pKind !== 'agent' && pKind !== 'human')) {
    return { ok: false, error: 'party kind must be agent|human' };
  }
  if (input.initiator !== 'requester' && input.initiator !== 'presenter') {
    return { ok: false, error: 'initiator must be requester|presenter' };
  }

  let tier: PresentationTier = 'reputation';
  if (input.tier !== undefined && input.tier !== null && input.tier !== '') {
    if (!isValidTier(input.tier)) return { ok: false, error: 'tier must be pe_fact|reputation' };
    tier = input.tier;
  }
  const note = normalizeNote(input.note);
  if (!note.ok) return note;

  const agentIds = [rKind === 'agent' ? rId : null, pKind === 'agent' ? pId : null].filter((x): x is string => x !== null);
  const humanIds = [rKind === 'human' ? rId : null, pKind === 'human' ? pId : null].filter((x): x is string => x !== null);

  return {
    ok: true,
    record: {
      request_id: `preq_${randomBytes(16).toString('hex')}`,
      direction: directionOf(pKind, rKind),
      agent_wallet_id: agentIds.length === 1 ? agentIds[0] : (pKind === 'agent' ? pId : ''),
      human_user_id: humanIds.length === 1 ? humanIds[0] : (rKind === 'human' ? rId : ''),
      requester_id: rId,
      requester_kind: rKind,
      presenter_id: pId,
      presenter_kind: pKind,
      thread_id: typeof input.threadId === 'string' && input.threadId.length > 0 ? input.threadId : null,
      initiator: input.initiator,
      tier,
      note: note.note,
      status: 'requested',
      audience: null,
      challenge: null,
      predicates: null,
      burn_id: null,
      presentation_token: null,
      verdict: null,
      predicate_results: null,
      created_at_ms: input.nowMs,
      expires_at_ms: input.nowMs + PRESENTATION_REQUEST_TTL_MS,
      challenged_at_ms: null,
      presented_at_ms: null,
      verified_at_ms: null,
    },
  };
}

/**
 * The LEGACY builder: an agent offers to present to its linked human. Fails CLOSED on a
 * missing agent wallet / linked human, a bad tier, or an oversized note. Tier defaults to
 * `reputation`. One case of {@link buildPartyPresentationRequest} (presenter = agent, requester =
 * human, initiator = the presenter), keeping the legacy `initiator: 'agent'` value.
 */
export function buildPresentationRequest(input: BuildPresentationRequestInput): BuildPresentationRequestResult {
  const agentWalletId = typeof input.agentWalletId === 'string' ? input.agentWalletId.trim() : '';
  const humanUserId = typeof input.humanUserId === 'string' ? input.humanUserId.trim() : '';
  if (!agentWalletId) return { ok: false, error: 'agent_wallet_id is required' };
  if (!humanUserId) return { ok: false, error: 'no linked human to present to' };
  const built = buildPartyPresentationRequest({
    requester: { kind: 'human', id: humanUserId },
    presenter: { kind: 'agent', id: agentWalletId },
    threadId: null,
    initiator: 'presenter',
    tier: input.tier,
    note: input.note,
    nowMs: input.nowMs,
  });
  if (!built.ok) return built;
  return { ok: true, record: { ...built.record, initiator: 'agent' } };
}

/** The party ids that may act in each role (legacy rows carry only the fields). */
export function requesterIdOf(r: PresentationRequestRecord): string {
  return r.requester_id ?? r.human_user_id;
}
export function presenterIdOf(r: PresentationRequestRecord): string {
  return r.presenter_id ?? r.agent_wallet_id;
}
export function isParty(r: PresentationRequestRecord, partyId: string): boolean {
  return requesterIdOf(r) === partyId || presenterIdOf(r) === partyId;
}

/**
 * The requester composes the challenge (audience/challenge/predicates).
 * Only valid from `requested`. `audience` and `challenge` must be non-empty
 * strings; `predicates` must be an array or null. Fails CLOSED otherwise.
 */
export function applyComposedChallenge(
  record: PresentationRequestRecord,
  input: { audience: unknown; challenge: unknown; predicates?: unknown; nowMs: number; envelope?: ChallengeEnvelope },
): ApplyResult {
  if (record.status !== 'requested') {
    return { ok: false, error: `cannot compose a challenge from status '${record.status}'` };
  }
  // a relay-signed envelope is authoritative — its audience (the requester's id), nonce and
  // predicates are what the presenter will verify and bind to.
  if (input.envelope) {
    const env = input.envelope;
    return {
      ok: true,
      record: {
        ...record,
        status: 'challenged',
        audience: env.audience,
        challenge: env.challenge,
        predicates: env.predicates ? [...env.predicates] : [],
        challenge_envelope: env,
        challenged_at_ms: input.nowMs,
      },
    };
  }
  const audience = typeof input.audience === 'string' ? input.audience.trim() : '';
  const challenge = typeof input.challenge === 'string' ? input.challenge.trim() : '';
  if (!audience) return { ok: false, error: 'audience must be a non-empty string' };
  if (!challenge) return { ok: false, error: 'challenge must be a non-empty string' };
  let predicates: unknown[] | null = null;
  if (input.predicates !== undefined && input.predicates !== null) {
    if (!Array.isArray(input.predicates)) return { ok: false, error: 'predicates must be an array or null' };
    predicates = input.predicates;
  }
  return {
    ok: true,
    record: { ...record, status: 'challenged', audience, challenge, predicates, challenged_at_ms: input.nowMs },
  };
}

/**
 * The presenter posts the presentation token it produced via the EXISTING
 * `/present` route back to the request. Only valid from `challenged`.
 * `burn_id` and `presentation_token` must be non-empty strings.
 */
export function applyPresentation(
  record: PresentationRequestRecord,
  input: {
    burn_id: unknown; presentation_token: unknown; nowMs: number;
    // verify-at-submit: a presentation token can only be verified while it is
    // FRESH (≤ PRESENTATION_MAX_TTL_SECONDS = 15 min), and in the REMOTE channel the
    // absent requester returns long after that. So the relay verifies the fresh token at
    // the moment the presenter submits it and stores the authoritative verdict here; the
    // requester later READS this verdict instead of re-verifying an expired token.
    // Optional so the in-person immediate flow (requester verifies fresh) is unchanged.
    verdict?: unknown; predicate_results?: unknown;
  },
): ApplyResult {
  if (record.status !== 'challenged') {
    return { ok: false, error: `cannot post a presentation from status '${record.status}'` };
  }
  const burnId = typeof input.burn_id === 'string' ? input.burn_id.trim() : '';
  const token = typeof input.presentation_token === 'string' ? input.presentation_token.trim() : '';
  if (!burnId) return { ok: false, error: 'burn_id must be a non-empty string' };
  if (!token) return { ok: false, error: 'presentation_token must be a non-empty string' };
  const freshVerdict: 'valid' | 'invalid' | null =
    input.verdict === 'valid' || input.verdict === 'invalid' ? input.verdict : null;
  const freshResults: unknown[] | null = Array.isArray(input.predicate_results) ? input.predicate_results : null;
  return {
    ok: true,
    record: {
      ...record,
      status: 'presented',
      burn_id: burnId,
      presentation_token: token,
      presented_at_ms: input.nowMs,
      verdict: freshVerdict,
      predicate_results: freshResults,
    },
  };
}

/**
 * The requester (or relay) records the verdict after running the EXISTING
 * `/v1/present/verify`. Only valid from `presented`. `verdict` ∈ valid|invalid.
 */
export function applyVerdict(
  record: PresentationRequestRecord,
  input: { verdict: unknown; predicate_results?: unknown; nowMs: number },
): ApplyResult {
  if (record.status !== 'presented') {
    return { ok: false, error: `cannot record a verdict from status '${record.status}'` };
  }
  // verify-at-submit: when the relay already verified the FRESH token at submit
  // time (`record.verdict` populated), that verdict is authoritative — the requester is
  // acknowledging a proof they cannot re-run (the token is expired by now), so a
  // client-supplied verdict can neither upgrade nor downgrade it. Only trust the
  // client's verdict for the in-person immediate flow, where no fresh verdict was
  // pre-recorded and the requester genuinely verified the still-fresh token themselves.
  const hasFreshVerdict = record.verdict === 'valid' || record.verdict === 'invalid';
  if (hasFreshVerdict) {
    return {
      ok: true,
      record: { ...record, status: 'verified', verified_at_ms: input.nowMs },
    };
  }
  if (input.verdict !== 'valid' && input.verdict !== 'invalid') {
    return { ok: false, error: 'verdict must be valid|invalid' };
  }
  let predicateResults: unknown[] | null = null;
  if (input.predicate_results !== undefined && input.predicate_results !== null) {
    if (!Array.isArray(input.predicate_results)) return { ok: false, error: 'predicate_results must be an array or null' };
    predicateResults = input.predicate_results;
  }
  return {
    ok: true,
    record: {
      ...record,
      status: 'verified',
      verdict: input.verdict,
      predicate_results: predicateResults,
      verified_at_ms: input.nowMs,
    },
  };
}

/**
 * The requester declines the request. Valid from any non-terminal status
 * (requested|challenged|presented). Fails CLOSED from a terminal status.
 */
export function applyDecline(record: PresentationRequestRecord): ApplyResult {
  if (record.status !== 'requested' && record.status !== 'challenged' && record.status !== 'presented') {
    return { ok: false, error: `cannot decline from status '${record.status}'` };
  }
  return { ok: true, record: { ...record, status: 'declined' } };
}

export function isExpired(record: Pick<PresentationRequestRecord, 'expires_at_ms'>, nowMs: number): boolean {
  return record.expires_at_ms <= nowMs;
}

/** The fields every projection shares (no note, no requester identity beyond the audience). */
function projectCommon(r: PresentationRequestRecord) {
  return {
    request_id: r.request_id,
    direction: r.direction,
    agent_wallet_id: r.agent_wallet_id,
    presenter_id: presenterIdOf(r),
    presenter_kind: r.presenter_kind ?? 'agent',
    requester_kind: r.requester_kind ?? 'human',
    thread_id: r.thread_id ?? null,
    tier: r.tier,
    status: r.status,
    audience: r.audience,
    challenge: r.challenge,
    predicates: r.predicates,
    // the signed challenge the presenter verifies BEFORE burning (it names the requester —
    // the standing rule that a presenter must know whom it presents to supersedes withholding it).
    challenge_envelope: r.challenge_envelope ?? null,
    burn_id: r.burn_id,
    presentation_token: r.presentation_token,
    verdict: r.verdict,
    predicate_results: r.predicate_results,
    created_at_ms: r.created_at_ms,
    expires_at_ms: r.expires_at_ms,
    challenged_at_ms: r.challenged_at_ms,
    presented_at_ms: r.presented_at_ms,
    verified_at_ms: r.verified_at_ms,
  };
}

/**
 * The PRESENTER-facing projection — WITHOUT `note` and WITHOUT the requester's identity. The
 * presenter needs `audience`/`challenge`/`predicates` to present, so those ARE included; the
 * Tier-3 note and the requester's id are NOT. (Named for the legacy agent-presenter case.)
 */
export function toAgentFacingRequest(r: PresentationRequestRecord): ReturnType<typeof projectCommon> {
  return projectCommon(r);
}

/**
 * The REQUESTER-facing projection — INCLUDES the Tier-3 `note` (this one requester reads it)
 * and the request's status/timestamps. The requester composes the challenge, so the echoed
 * audience/challenge/predicates are informational. (Named for the legacy human-requester case.)
 */
export function toHumanFacingRequest(r: PresentationRequestRecord): ReturnType<typeof projectCommon> & { note: string | null; requester_id: string } {
  return { ...projectCommon(r), note: r.note, requester_id: requesterIdOf(r) };
}

/** The projection for a viewer by ROLE (threads): the requester sees the note, the presenter does not. */
export function toPartyFacingRequest(r: PresentationRequestRecord, viewerPartyId: string) {
  return requesterIdOf(r) === viewerPartyId ? toHumanFacingRequest(r) : toAgentFacingRequest(r);
}
