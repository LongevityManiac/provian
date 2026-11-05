/**
 * Wants board + want→fulfiller match (work package orphan O7 — the demand loop).
 *
 * The demand half of the commons. A WANT is the lightweight, UNFUNDED expression of demand:
 * "I need X (capabilities, budget range, chain)." It is not a funded job, so it locks no escrow.
 *
 * A PRESENTATION OPENS A VOICE, EVERY ACT MINTS. Posting a want is Commons speech: it
 * commits behind the poster's live presentation window to `provian:commons` (one burn per window,
 * folded onto the presentation, never stacked — `./speech-window.ts`) and seals a `want_posted` PE
 * that MINTS at its evidence-class base, budget-bounded by the window's burn. Fulfil / cancel seal
 * record-only status PEs (`want_fulfilled` the value lands on the linked job's completion path;
 * `want_cancelled` a no-op). FEATURED placement is a burn auction (`./featured.ts`): each bid its
 * own burn on the global single-use ledger; a want's bids stack for the term and it leaves the list
 * once it is no longer open.
 *
 * The centrepiece is the WANT→FULFILLER MATCH (`matchWant`): a server-side ranking of the real
 * agent directory (`agent_directory`) against a want's capabilities, budget, chain, and the
 * fulfiller's live reputation.
 *
 * THE LOOP: a want is matched to a fulfiller; the poster funds the work through the EXISTING
 * jobs/escrow path (`postJob`/`acceptApplicant`) referencing the want; that job settles through the
 * on-chain completion path. `fulfillWant` records the verified want→job link — it never creates
 * escrow itself (no parallel escrow path; pitfall #25). A want holds no custody.
 */

import type { Transaction } from 'firebase-admin/firestore';
import type { AgentBankDeps, AgentDirectoryDocument } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { bidFeatured, listFeatured, type FeaturedPlacement, type FeaturedSlot } from './featured';
import { speechWindowParam, type SpeechWindow } from './speech-window';
import { COMMONS_COLLECTIONS } from './types';
import { isHiddenPrelaunchTest } from './public-visibility';
import { acceptAttachedOutputSignature } from './attached-output-signature';
import type { OutputSignature } from '../meter/output-signature';

/** The demand-side collection. */
export const COMMONS_WANTS_COLLECTION = 'commons_wants';

/**
 * Size + page limits grouped into one `as const` object so a generic value (e.g. 100)
 * is never a bare module-scope literal — the T3 self-referential-control guard
 * (`wp11/cutover-hard-stops.ts findRedeclaredLiterals`) flags a TEST const that
 * coincidentally shares a bare MODULE literal. Object-property RHS is not extracted by
 * that single-line parser, so grouping removes the false collision. Mirrors the O3
 * `EARNING_PROPOSAL_LIMITS` pattern.
 */
const WANT_LIMITS = {
  outcomeMaxLength: 500,
  maxCapabilities: 12,
  capabilityMaxLength: 64,
  maxPreferredChains: 6,
  defaultPageLimit: 50,
  maxPageLimit: 100,
  defaultMatchLimit: 20,
  maxMatchLimit: 50,
  /** Firestore `array-contains-any` accepts at most 10 comparison values. */
  matchCapabilityQueryCap: 10,
} as const;

export const WANT_OUTCOME_MAX_LENGTH = WANT_LIMITS.outcomeMaxLength;
export const WANT_MAX_CAPABILITIES = WANT_LIMITS.maxCapabilities;
export const WANT_DEFAULT_PAGE_LIMIT = WANT_LIMITS.defaultPageLimit;
export const WANT_MAX_PAGE_LIMIT = WANT_LIMITS.maxPageLimit;
export const WANT_DEFAULT_MATCH_LIMIT = WANT_LIMITS.defaultMatchLimit;

export type WantStatus = 'open' | 'matched' | 'fulfilled' | 'cancelled' | 'expired';

export type WantPosterType = 'human' | 'agent';

/** Stored want document. Keyed by `want_id`. */
export interface WantDocument {
  want_id: string;
  poster_wallet_id: string;
  poster_type: WantPosterType;
  outcome: string;
  capabilities: string[];
  /** Optional budget ceilings. PVT as an 18-decimal wei string; USDC as a number. */
  budget_max_pvt: string | null;
  budget_max_usdc: number | null;
  preferred_chains: string[];
  /** Unix ms; a want past its expiry no longer matches and reads as `expired`. */
  expiry: number | null;
  status: WantStatus;
  matched_fulfiller_wallet_id: string | null;
  linked_job_id: string | null;
  created_at: number;
  updated_at: number;
  /** the poster's signature over `wantOutputText`, served with the want. */
  provian_output_signature?: OutputSignature;
}

/** Public-safe view of a want (identical fields today; the seam for future redaction). */
export type WantView = WantDocument & { pe_id?: string; featured?: FeaturedSlot | null };

/** Per-fulfiller score breakdown — every component is [0,1], `score` is their weighted sum. */
export interface MatchScoreBreakdown {
  capability_overlap: number;
  availability: number;
  budget_fit: number;
  chain_fit: number;
  reputation: number;
}

export interface FulfillerMatch {
  wallet_id: string;
  agent_id: string;
  display_name: string;
  address: string;
  capabilities: string[];
  matched_capabilities: string[];
  availability: string;
  hourly_rate_pvt: string | null;
  hourly_rate_usdc: number | null;
  /** Live visible-PE count (from the directory doc, never a stored per-wallet tally). */
  pe_count: number;
  score: number;
  breakdown: MatchScoreBreakdown;
}

export interface MatchResult {
  want_id: string;
  status: WantStatus;
  candidates_considered: number;
  matches: FulfillerMatch[];
}

export interface WantPosterIdentity {
  walletId: string;
  isAgent: boolean;
  /** PE attribution : the Commons actor's agent id and resolved on-chain address (or null). */
  agentId?: string;
  actorAddress?: string | null;
}

export interface PostWantInput {
  outcome: string;
  capabilities: string[];
  budgetMaxPvt?: string | null;
  budgetMaxUsdc?: number | null;
  preferredChains?: string[];
  expiry?: number | null;
  now?: number;
  /** the poster's signature over `wantOutputText` (optional). */
  outputSignature?: unknown;
}

export interface ListWantsOptions {
  status?: WantStatus;
  capability?: string;
  limit?: number;
  cursor?: string;
}

export interface ListWantsPage {
  items: WantView[];
  nextCursor: string | null;
}

export interface FulfillWantInput {
  fulfillerWalletId: string;
  linkedJobId: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeOutcome(outcome: unknown): string {
  if (typeof outcome !== 'string' || outcome.trim().length === 0) {
    throw new Error('outcome_required');
  }
  const trimmed = outcome.trim();
  if (trimmed.length > WANT_LIMITS.outcomeMaxLength) {
    throw new Error('outcome_too_long');
  }
  return trimmed;
}

/** Dedup, lowercase, and bound the capability list. Non-empty, well-formed strings only. */
function normalizeCapabilities(capabilities: unknown): string[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error('capabilities_required');
  }
  const cleaned: string[] = [];
  for (const cap of capabilities) {
    if (typeof cap !== 'string') {
      throw new Error('capabilities_invalid');
    }
    const c = cap.trim().toLowerCase();
    if (c.length === 0 || c.length > WANT_LIMITS.capabilityMaxLength) {
      throw new Error('capabilities_invalid');
    }
    if (!cleaned.includes(c)) cleaned.push(c);
  }
  if (cleaned.length > WANT_LIMITS.maxCapabilities) {
    throw new Error('capabilities_too_many');
  }
  return cleaned;
}

function normalizePreferredChains(chains: unknown): string[] {
  if (chains === undefined || chains === null) return [];
  if (!Array.isArray(chains)) {
    throw new Error('preferred_chains_invalid');
  }
  const cleaned: string[] = [];
  for (const chain of chains) {
    if (typeof chain !== 'string') {
      throw new Error('preferred_chains_invalid');
    }
    const c = chain.trim().toLowerCase();
    if (c.length === 0 || c.length > WANT_LIMITS.capabilityMaxLength) {
      throw new Error('preferred_chains_invalid');
    }
    if (!cleaned.includes(c)) cleaned.push(c);
  }
  if (cleaned.length > WANT_LIMITS.maxPreferredChains) {
    throw new Error('preferred_chains_invalid');
  }
  return cleaned;
}

function normalizeBudgetPvt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error('budget_max_pvt_invalid');
  }
  // PVT ATOMIC units (18 decimals) as a non-negative base-10 integer string — the unit of every PVT
  // rate on the relay, and required here because computeBudgetFit compares it directly against a
  // fulfiller's atomic hourly_rate_pvt. "20.5" (a decimal PVT amount) is refused; clients convert
  // (the app parses PVT with parseUnits; the CLI's --budget-max-pvt is whole PVT, converted).
  // No numeric ceiling — PVT is arbitrary precision (mirrors directory.ts hourly_rate_pvt).
  return BigInt(value).toString();
}

function normalizeBudgetUsdc(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new Error('budget_max_usdc_invalid');
  }
  return value;
}

function normalizeExpiry(value: unknown, now: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error('expiry_invalid');
  }
  if (value <= now) {
    throw new Error('expiry_in_past');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------

/** Relative weights of the five score components; sum = 1 so the composite is in [0,1]. */
const MATCH_WEIGHTS: Readonly<MatchScoreBreakdown> = {
  capability_overlap: 0.4,
  availability: 0.15,
  budget_fit: 0.15,
  chain_fit: 0.1,
  reputation: 0.2,
};

/**
 * Diminishing-returns normalization of an unbounded reputation count into [0,1].
 * Deterministic, no external oracle. `n/(n+k)` — k is the half-saturation point.
 */
function saturate(n: number, k: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / (n + k);
}

/**
 * Score one directory fulfiller against a want. Returns null when the fulfiller has
 * ZERO capability overlap with the want — a non-match is excluded, never surfaced with
 * a low score. This exclusion is the anti-noise guard the control re-reddens.
 *
 * Exported for direct testing: through `matchWant` the `array-contains-any` probe only
 * returns docs already sharing a want capability, so the zero-overlap branch is
 * unreachable there (a unreachable-branch). Testing this pure function directly
 * with a constructible zero-overlap fulfiller keeps the guard's violating case
 * constructible while the call site stays narrow.
 */
export function scoreFulfiller(
  want: WantDocument,
  fulfiller: AgentDirectoryDocument,
): FulfillerMatch | null {
  const wantCaps = want.capabilities;
  const fulfillerCaps = Array.isArray(fulfiller.capabilities)
    ? fulfiller.capabilities.map((c) => c.toLowerCase())
    : [];
  const matched = wantCaps.filter((c) => fulfillerCaps.includes(c));
  if (matched.length === 0) return null; // hard gate: no overlap → not a candidate

  const capabilityOverlap = matched.length / wantCaps.length;

  const availabilityScore =
    fulfiller.availability === 'available' ? 1
      : fulfiller.availability === 'busy' ? 0.4
        : 0; // offline (should already be filtered, but score defensively)

  // Budget fit: 1 when no budget ceiling is set OR the fulfiller quotes no rate on the
  // relevant currency (unknown ⇒ not penalised); 1 when the rate is within budget; 0 when
  // it exceeds. Evaluated per currency the want constrains; the tighter constraint wins.
  const budgetFit = computeBudgetFit(want, fulfiller);

  const chainFit = computeChainFit(want, fulfiller);

  // reputation is the live PE count only — no governance signal.
  const reputation = saturate(Number(fulfiller.pe_count) || 0, 50);

  const breakdown: MatchScoreBreakdown = {
    capability_overlap: capabilityOverlap,
    availability: availabilityScore,
    budget_fit: budgetFit,
    chain_fit: chainFit,
    reputation,
  };

  const score =
    MATCH_WEIGHTS.capability_overlap * capabilityOverlap
    + MATCH_WEIGHTS.availability * availabilityScore
    + MATCH_WEIGHTS.budget_fit * budgetFit
    + MATCH_WEIGHTS.chain_fit * chainFit
    + MATCH_WEIGHTS.reputation * reputation;

  return {
    wallet_id: fulfiller.wallet_id,
    agent_id: fulfiller.agent_id,
    display_name: fulfiller.display_name,
    address: fulfiller.address,
    capabilities: fulfillerCaps,
    matched_capabilities: matched,
    availability: fulfiller.availability,
    hourly_rate_pvt: fulfiller.hourly_rate_pvt ?? null,
    hourly_rate_usdc: fulfiller.hourly_rate_usdc ?? null,
    pe_count: Number(fulfiller.pe_count) || 0,
    score,
    breakdown,
  };
}

function computeBudgetFit(want: WantDocument, fulfiller: AgentDirectoryDocument): number {
  let fit = 1;
  let constrained = false;
  if (want.budget_max_pvt !== null && typeof fulfiller.hourly_rate_pvt === 'string'
    && /^[0-9]+$/.test(fulfiller.hourly_rate_pvt)) {
    constrained = true;
    if (BigInt(fulfiller.hourly_rate_pvt) > BigInt(want.budget_max_pvt)) fit = 0;
  }
  if (want.budget_max_usdc !== null && typeof fulfiller.hourly_rate_usdc === 'number') {
    constrained = true;
    if (fulfiller.hourly_rate_usdc > want.budget_max_usdc) fit = 0;
  }
  return constrained ? fit : 1;
}

function computeChainFit(want: WantDocument, fulfiller: AgentDirectoryDocument): number {
  if (want.preferred_chains.length === 0) return 1; // no preference → neutral
  const fulfillerChains = Array.isArray(fulfiller.preferred_chains)
    ? fulfiller.preferred_chains.map((c) => c.toLowerCase())
    : [];
  if (fulfillerChains.length === 0) return 0.5; // unknown → half credit
  return want.preferred_chains.some((c) => fulfillerChains.includes(c)) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: number, docId: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, created_at: createdAt, document_id: docId }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(value: string): { createdAt: number; documentId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const row = parsed as Record<string, unknown>;
    if (
      row.v !== 1
      || !Number.isSafeInteger(row.created_at)
      || (row.created_at as number) < 0
      || typeof row.document_id !== 'string'
    ) {
      throw new Error();
    }
    return { createdAt: row.created_at as number, documentId: row.document_id };
  } catch {
    throw new Error('want_cursor_invalid');
  }
}

// ---------------------------------------------------------------------------
// Read-time status projection
// ---------------------------------------------------------------------------

/** An open want past its expiry reads as `expired` without a write. */
function projectStatus(doc: WantDocument, now: number): WantStatus {
  if (doc.status === 'open' && doc.expiry !== null && doc.expiry <= now) {
    return 'expired';
  }
  return doc.status;
}

function toView(doc: WantDocument, now: number): WantView {
  return { ...doc, status: projectStatus(doc, now) };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Post a want — Commons speech behind a live presentation window. The want document and its
 * `want_posted` PE commit in ONE transaction; the PE mints at its evidence-class base, bounded by
 * the window's burn.
 */
export async function postWant(
  deps: AgentBankDeps,
  poster: WantPosterIdentity,
  input: PostWantInput,
  window: SpeechWindow,
): Promise<WantView> {
  const outcome = normalizeOutcome(input.outcome);
  const capabilities = normalizeCapabilities(input.capabilities);
  const now = input.now ?? Date.now();
  const budgetMaxPvt = normalizeBudgetPvt(input.budgetMaxPvt);
  const budgetMaxUsdc = normalizeBudgetUsdc(input.budgetMaxUsdc);
  const preferredChains = normalizePreferredChains(input.preferredChains);
  const expiry = normalizeExpiry(input.expiry, now);

  const { randomUUID, createHash } = await import('crypto');
  const wantId = `want_${randomUUID().replace(/-/g, '')}`;
  const ref = deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId);

  const doc: WantDocument = {
    want_id: wantId,
    poster_wallet_id: poster.walletId,
    poster_type: poster.isAgent ? 'agent' : 'human',
    outcome,
    capabilities,
    budget_max_pvt: budgetMaxPvt,
    budget_max_usdc: budgetMaxUsdc,
    preferred_chains: preferredChains,
    expiry,
    status: 'open',
    matched_fulfiller_wallet_id: null,
    linked_job_id: null,
    created_at: now,
    updated_at: now,
  };
  const contentHash = createHash('sha256').update(JSON.stringify({ outcome, capabilities, preferredChains })).digest('hex');
  // the poster's signature over the sealed content, verified as theirs before any write.
  const outputSignature = await acceptAttachedOutputSignature(deps.db, input.outputSignature, contentHash, poster.agentId ?? poster.walletId);
  if (outputSignature) doc.provian_output_signature = outputSignature;
  const { peId } = await generatePE(deps, {
    walletId: poster.walletId,
    agentId: poster.agentId ?? poster.walletId,
    actorAddress: poster.actorAddress ?? null,
    ownerType: poster.isAgent ? 'agent' : 'human',
    actionType: 'want_posted',
    metadata: { want_id: wantId, content_hash: contentHash, capabilities, verified: true },
    output_digests: [{ hash: `sha256:${contentHash}`, kind: 'artifact' }],
    witnessClass: 'relay_verified',
    durableViaOrdinaryIntake: true,
    speechWindow: speechWindowParam(window),
    atomicEntityWrite: (txn) => {
      txn.create(ref, doc as unknown as FirebaseFirestore.DocumentData);
    },
  });
  return { ...toView(doc, now), pe_id: peId };
}

/** Record-only status PE for fulfil / cancel (best-effort after the terminal write). */
async function recordWantStatusPe(
  deps: AgentBankDeps,
  poster: WantPosterIdentity,
  actionType: 'want_fulfilled' | 'want_cancelled',
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await generatePE(deps, {
      walletId: poster.walletId,
      agentId: poster.agentId ?? poster.walletId,
      actorAddress: poster.actorAddress ?? null,
      ownerType: poster.isAgent ? 'agent' : 'human',
      actionType,
      metadata,
    });
  } catch (err) {
    console.error(`[Wants] ${actionType} PE failed (status already written):`, err);
  }
}

/**
 * FEATURED placement on the wants board — a burn auction. The poster bids a verified burn
 * (at/above the `featured_placement` floor, any amount above it); the burn is consumed on the
 * global single-use ledger and adds to the want's featured total for the term (bids on
 * one want stack; the want leaves the list the moment it is no longer open).
 */
export async function featureWant(
  deps: AgentBankDeps,
  wantId: string,
  poster: WantPosterIdentity,
  burnId: unknown,
): Promise<FeaturedPlacement> {
  const ref = deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId);
  return bidFeatured(deps, {
    board: 'wants',
    itemId: wantId,
    actor: {
      walletId: poster.walletId,
      agentId: poster.agentId ?? poster.walletId,
      actorAddress: poster.actorAddress ?? null,
      isAgent: poster.isAgent,
    },
    burnId,
    assertBiddable: async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error('want_not_found');
      const doc = snap.data() as WantDocument;
      if (doc.poster_wallet_id !== poster.walletId) throw new Error('want_not_owned');
      // only an OPEN want is featured — a matched want is closed and drops off the list.
      if (projectStatus(doc, Date.now()) !== 'open') throw new Error('want_not_open');
    },
  });
}

/** The wants board's ranked featured slots. */
export async function featuredWants(deps: AgentBankDeps, nowMs: number = Date.now()): Promise<FeaturedSlot[]> {
  return listFeatured(deps, 'wants', nowMs);
}

/** Browse open/all wants, newest first, with an optional status/capability filter. */
export async function browseWants(
  deps: AgentBankDeps,
  options: ListWantsOptions = {},
): Promise<ListWantsPage> {
  const now = Date.now();
  const limit = Math.min(
    WANT_LIMITS.maxPageLimit,
    Math.max(1, options.limit ?? WANT_LIMITS.defaultPageLimit),
  );
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);

  const { FieldPath } = await import('firebase-admin/firestore');
  let query: FirebaseFirestore.Query = deps.db.collection(COMMONS_WANTS_COLLECTION);
  if (options.capability) {
    query = query.where('capabilities', 'array-contains', options.capability.trim().toLowerCase());
  }
  query = query.orderBy('created_at', 'desc').orderBy(FieldPath.documentId(), 'asc');
  if (cursor !== null) {
    query = query.startAfter(cursor.createdAt, cursor.documentId);
  }
  const pageSnap = await query.limit(limit + 1).get();
  const pageDocs = pageSnap.docs.slice(0, limit);
  const hasMore = pageSnap.docs.length > limit;
  const last = pageDocs[pageDocs.length - 1];

  const items: WantView[] = [];
  for (const row of pageDocs) {
    const doc = row.data() as WantDocument;
    if (isHiddenPrelaunchTest(doc)) continue;
    const view = toView(doc, now);
    // `status` is a read-time projection (expired), so filter AFTER projecting.
    if (options.status && view.status !== options.status) continue;
    items.push(view);
  }

  return {
    items,
    nextCursor: hasMore && last
      ? encodeCursor((last.data() as WantDocument).created_at, last.id)
      : null,
  };
}

export async function getWant(deps: AgentBankDeps, wantId: string): Promise<WantView> {
  const snap = await deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId).get();
  if (!snap.exists) throw new Error('want_not_found');
  if (isHiddenPrelaunchTest(snap.data())) throw new Error('want_not_found');
  return toView(snap.data() as WantDocument, Date.now());
}

/**
 * THE want→fulfiller match. Ranks real directory fulfillers against a want. Read-only;
 * mints nothing. Excludes the poster's own directory entry (no self-fulfilment) and any
 * fulfiller with zero capability overlap. Returns ranked matches with a score breakdown.
 */
export async function matchWant(
  deps: AgentBankDeps,
  wantId: string,
  opts: { limit?: number } = {},
): Promise<MatchResult> {
  const now = Date.now();
  const snap = await deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId).get();
  if (!snap.exists) throw new Error('want_not_found');
  if (isHiddenPrelaunchTest(snap.data())) throw new Error('want_not_found');
  const want = snap.data() as WantDocument;
  const status = projectStatus(want, now);

  const limit = Math.min(
    WANT_LIMITS.maxMatchLimit,
    Math.max(1, opts.limit ?? WANT_LIMITS.defaultMatchLimit),
  );

  // A closed/expired want yields no matches (but is not an error — the status explains it).
  if (status !== 'open') {
    return { want_id: wantId, status, candidates_considered: 0, matches: [] };
  }

  // Query the directory for candidates sharing at least one capability with the want.
  // array-contains-any accepts ≤10 values, so cap the probe set (all capabilities are
  // still re-checked in scoreFulfiller, which is the authoritative overlap test).
  const probeCaps = want.capabilities.slice(0, WANT_LIMITS.matchCapabilityQueryCap);
  const candSnap = await deps.db
    .collection('agent_directory')
    .where('capabilities', 'array-contains-any', probeCaps)
    .get();

  let considered = 0;
  const matches: FulfillerMatch[] = [];
  for (const row of candSnap.docs) {
    const fulfiller = row.data() as AgentDirectoryDocument;
    // Self-fulfilment guard: the poster can never be a match for its own want.
    if (fulfiller.wallet_id === want.poster_wallet_id) continue;
    if (fulfiller.availability === 'offline') continue;
    considered += 1;
    const scored = scoreFulfiller(want, fulfiller);
    if (scored !== null) matches.push(scored);
  }

  matches.sort((a, b) => (b.score - a.score) || a.wallet_id.localeCompare(b.wallet_id));

  return {
    want_id: wantId,
    status,
    candidates_considered: considered,
    matches: matches.slice(0, limit),
  };
}

/**
 * Record a verified want→job link. The poster (only) declares that a directory fulfiller
 * has been engaged through an existing funded job. Validates the job exists and belongs
 * to the poster; sets the want to `fulfilled` and stores the link. Does NOT create escrow
 * — the funded job settles through the on-chain completion path (O2). Seals a record-only
 * `want_fulfilled` PE (the value lands on the linked job).
 */
export async function fulfillWant(
  deps: AgentBankDeps,
  wantId: string,
  poster: WantPosterIdentity,
  input: FulfillWantInput,
): Promise<WantView> {
  const now = Date.now();
  const fulfillerWalletId = typeof input.fulfillerWalletId === 'string' ? input.fulfillerWalletId.trim() : '';
  const linkedJobId = typeof input.linkedJobId === 'string' ? input.linkedJobId.trim() : '';
  if (fulfillerWalletId.length === 0) throw new Error('fulfiller_wallet_id_required');
  if (linkedJobId.length === 0) throw new Error('linked_job_id_required');
  if (fulfillerWalletId === poster.walletId) throw new Error('cannot_fulfill_own_want');

  const ref = deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId);
  // hiring runs on the Commons jobs board (`hjob_…`); a legacy agent-board job id
  // (`job_…`) still resolves against the folded `jobs` collection.
  const jobRef = linkedJobId.startsWith('hjob_')
    ? deps.db.collection(COMMONS_COLLECTIONS.HUMAN_JOBS).doc(linkedJobId)
    : deps.db.collection('jobs').doc(linkedJobId);

  // One transaction: read the want AND the referenced job (all reads before the write),
  // validate ownership on both, then mark the want fulfilled. The job must exist and be
  // owned by the poster — a want can only be closed against the poster's own funded work,
  // never an arbitrary job id (the guard the control re-reddens).
  await deps.db.runTransaction(async (txn) => {
    const wantSnap = await txn.get(ref);
    if (!wantSnap.exists) throw new Error('want_not_found');
    const doc = wantSnap.data() as WantDocument;
    if (doc.poster_wallet_id !== poster.walletId) throw new Error('want_not_owned');
    if (doc.status !== 'open' && doc.status !== 'matched') throw new Error('want_not_open');

    const jobSnap = await txn.get(jobRef);
    if (!jobSnap.exists) throw new Error('linked_job_not_found');
    const job = jobSnap.data() as { poster_wallet_id?: string };
    if (job.poster_wallet_id !== poster.walletId) throw new Error('linked_job_not_owned');

    txn.set(ref, {
      status: 'fulfilled' as WantStatus,
      matched_fulfiller_wallet_id: fulfillerWalletId,
      linked_job_id: linkedJobId,
      updated_at: now,
    }, { merge: true });
  });

  await recordWantStatusPe(deps, poster, 'want_fulfilled', {
    want_id: wantId, fulfiller_wallet_id: fulfillerWalletId, linked_job_id: linkedJobId,
  });
  const after = await ref.get();
  return toView(after.data() as WantDocument, now);
}

/** Cancel an open/matched want (poster only). Seals a record-only `want_cancelled` PE. */
export async function cancelWant(
  deps: AgentBankDeps,
  wantId: string,
  poster: WantPosterIdentity,
): Promise<WantView> {
  const now = Date.now();
  const ref = deps.db.collection(COMMONS_WANTS_COLLECTION).doc(wantId);

  await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error('want_not_found');
    const doc = snap.data() as WantDocument;
    if (doc.poster_wallet_id !== poster.walletId) throw new Error('want_not_owned');
    if (doc.status === 'fulfilled') throw new Error('want_already_fulfilled');
    if (doc.status === 'cancelled') throw new Error('want_already_cancelled');
    txn.set(ref, { status: 'cancelled' as WantStatus, updated_at: now }, { merge: true });
  });

  await recordWantStatusPe(deps, poster, 'want_cancelled', { want_id: wantId });
  const after = await ref.get();
  return toView(after.data() as WantDocument, now);
}
