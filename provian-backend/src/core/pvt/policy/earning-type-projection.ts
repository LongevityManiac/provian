import {createQueryPager} from '../../provenance/query-pages';
/**
 * The PUBLIC earning-type projection behind GET /v1/pe/earning-proposals and the
 * provian.ai/proposals page. It JOINS three sources and NOTHING ELSE:
 *
 * 1. the SERVED matrix — the compiled `PROPOSED_ACTION_POLICY_ENTRIES` of the
 * running revision (the only place "does this type earn, and at what weight"
 * is authoritative);
 * 2. the pending-policy QUEUE (`pvt_pending_policy_queue`) — every identifier a
 * submitter's envelope ever surfaced;
 * 3. the policy-classification sidecar (`pvt_policy_rulings`) — declined / alias /
 * building triage.
 *
 * "Live" is computed from the served code AND `system_status/monetary_activation
 *.digest_match === true` (the served code matches the signed activation) — NEVER
 * from `pvt_action_policies`, which is why the old `classified_prospective`
 * "accepted" state is GONE (decision 8): under the no-unsigned-tier rule an
 * admin write can never mean "earns." A type earns only on a signed matrix row.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  PROPOSED_ACTION_POLICY_ENTRIES,
  PROPOSED_ACTION_POLICY_MANIFEST,
} from './proposed-action-policy';
import { hashProposedMonetaryPolicyTemplate } from './proposed-monetary-policy';
import {
  MONETARY_STATUS_COLLECTION,
  MONETARY_STATUS_DOCUMENT,
} from './monetary-activation-status';
import {
  listPendingPolicyActionItemsPage,
  getPendingPolicyAction,
  type PendingPolicyQueueDocument,
} from './pending-policy-queue';
import {
  listPolicyRulings,
  getPolicyRuling,
  type PolicyRulingDoc,
} from './policy-rulings';
import type { MintDisposition } from './monetary-accounting';
import type { ProposedActionPolicyEntry } from './types';

/** Published verbatim (decision 3). */
export const EARNING_TYPE_REVIEW_PROMISE =
  'Ruling within 3 business days. Approved types go live at the next weekly signing cut, at most '
  + '7 days after merge. Envelopes earn from the go-live timestamp, never before.';

const MINTABLE: ReadonlySet<MintDisposition> = new Set<MintDisposition>([
  'eligible', 'pending_evidence', 'pending_review',
]);

export type EarningTypeStatus = 'live' | 'building' | 'queued' | 'declined';

export interface EarningTypeView {
  readonly action_type: string;
  readonly status: EarningTypeStatus;
  readonly mint_disposition?: MintDisposition;
  readonly weight_bps?: number;
  readonly effective_at_ms?: number | null;
  readonly reason_code?: string | null;
  readonly canonical_type?: string | null;
  readonly issue_url?: string | null;
  readonly first_seen_at?: number;
  readonly last_seen_at?: number;
  readonly observation_count?: number;
  readonly age_ms?: number;
  /** For queued types: first_seen + 3 business days (the published promise). */
  readonly review_deadline_ms?: number;
  readonly past_review_promise?: boolean;
}

export interface EarningTypeProjection {
  readonly generated_at_ms: number;
  readonly review_promise: string;
  readonly footer: {
    readonly template_digest: string;
    readonly digest_match: boolean;
    readonly matrix_policy_version: string;
    readonly matrix_entry_count: number;
  };
  readonly counts: Readonly<Record<EarningTypeStatus, number>>;
  readonly types: readonly EarningTypeView[];
}

/** Add `n` business days (skipping Sat/Sun) to a UTC instant. */
export function addBusinessDays(startMs: number, n: number): number {
  let ms = startMs;
  let added = 0;
  while (added < n) {
    ms += 24 * 60 * 60 * 1000;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return ms;
}

function effectiveWeightBps(entry: ProposedActionPolicyEntry): number {
  return entry.policy_override_bps ?? entry.base_action_weight_bps;
}

interface ActivationFacts {
  digestMatch: boolean;
  effectiveAtMs: number | null;
}

async function readActivationFacts(db: Firestore): Promise<ActivationFacts> {
  try {
    const snap = await db.collection(MONETARY_STATUS_COLLECTION).doc(MONETARY_STATUS_DOCUMENT).get();
    if (!snap.exists) return { digestMatch: false, effectiveAtMs: null };
    const data = snap.data() as { digest_match?: boolean; effective_at_ms?: number };
    return {
      digestMatch: data.digest_match === true,
      effectiveAtMs: typeof data.effective_at_ms === 'number' ? data.effective_at_ms : null,
    };
  } catch {
    return { digestMatch: false, effectiveAtMs: null };
  }
}

/** The view for a type PRESENT on the served matrix. */
function matrixView(
  entry: ProposedActionPolicyEntry,
  activation: ActivationFacts,
): EarningTypeView {
  const mintable = MINTABLE.has(entry.mint_disposition);
  if (mintable && activation.digestMatch) {
    return {
      action_type: entry.action_type,
      status: 'live',
      mint_disposition: entry.mint_disposition,
      weight_bps: effectiveWeightBps(entry),
      effective_at_ms: activation.effectiveAtMs,
    };
  }
  if (mintable) {
    // In code, but the running revision's template does not match the signed
    // activation — not yet earning. Shown as building (awaiting activation).
    return {
      action_type: entry.action_type,
      status: 'building',
      mint_disposition: entry.mint_disposition,
      weight_bps: effectiveWeightBps(entry),
      reason_code: 'awaiting_activation',
    };
  }
  // A signed record_only / ineligible_terminal row: a deliberate "records, never
  // earns" decision.
  return {
    action_type: entry.action_type,
    status: 'declined',
    mint_disposition: entry.mint_disposition,
    weight_bps: 0,
    reason_code: entry.reason_code,
  };
}

/** The view for a RULING with no matrix row. */
function rulingView(ruling: PolicyRulingDoc): EarningTypeView {
  if (ruling.ruling === 'building') {
    return {
      action_type: ruling.action_type,
      status: 'building',
      issue_url: ruling.issue_url,
      reason_code: ruling.reason_code,
    };
  }
  // declined or alias
  return {
    action_type: ruling.action_type,
    status: 'declined',
    reason_code: ruling.ruling === 'alias' ? (ruling.reason_code ?? 'alias') : ruling.reason_code,
    canonical_type: ruling.canonical_type,
  };
}

/** The view for a QUEUE row with no matrix row and no ruling. */
function queueView(row: PendingPolicyQueueDocument, nowMs: number): EarningTypeView {
  if (row.policy_review_state === 'rejected') {
    return {
      action_type: row.action_type,
      status: 'declined',
      reason_code: row.rejection_reason_code ?? 'rejected',
      first_seen_at: row.first_seen_at,
      observation_count: row.observation_count,
    };
  }
  if (row.policy_review_state === 'classified_prospective') {
    // Post- classify only writes record_only, so this is a record_only
    // decline; it is NEVER "accepted" and never earns.
    return {
      action_type: row.action_type,
      status: 'declined',
      reason_code: row.proposed_reason_code ?? 'classified_record_only',
      first_seen_at: row.first_seen_at,
      observation_count: row.observation_count,
    };
  }
  if (row.policy_review_state === 'resolved_signed_matrix') {
    // Reached only if the type later LEFT the matrix (a present matrix row wins
    // in resolveView). It is no longer awaiting review either way.
    return {
      action_type: row.action_type,
      status: 'declined',
      reason_code: row.resolved_matrix_reason_code ?? 'resolved_signed_matrix',
      first_seen_at: row.first_seen_at,
      observation_count: row.observation_count,
    };
  }
  const deadline = addBusinessDays(row.first_seen_at, 3);
  return {
    action_type: row.action_type,
    status: 'queued',
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    observation_count: row.observation_count,
    age_ms: Math.max(0, nowMs - row.first_seen_at),
    review_deadline_ms: deadline,
    past_review_promise: nowMs > deadline,
  };
}

/** Build one type's view from whichever sources know about it (matrix wins). */
function resolveView(
  actionType: string,
  matrix: Map<string, ProposedActionPolicyEntry>,
  rulings: Map<string, PolicyRulingDoc>,
  queue: Map<string, PendingPolicyQueueDocument>,
  activation: ActivationFacts,
  nowMs: number,
): EarningTypeView {
  const entry = matrix.get(actionType);
  if (entry) return matrixView(entry, activation);
  const ruling = rulings.get(actionType);
  if (ruling) return rulingView(ruling);
  const row = queue.get(actionType);
  if (row) return queueView(row, nowMs);
  // Should not happen (the union is built from these three maps).
  return { action_type: actionType, status: 'queued' };
}

/** The queue's own page ceiling (`listPendingPolicyActionPage` clamps to 200). */
export const EARNING_TYPE_QUEUE_PAGE_SIZE = 200;

/**
 * EVERY pending-policy queue row, paged by the queue's own keyset cursor until it is exhausted.
 *
 * The projection used to read one default page (`listPendingPolicyActions(db)` = the first 100
 * rows by first_seen_at), so with more than 100 queued identifiers every later one silently
 * vanished from the public /proposals page, its counts, and the Command Center mint/trust views.
 * The read is bounded by the real queue size (one page per 200 rows); a cursor that does not
 * advance is refused loudly rather than looped on or truncated.
 */
export async function listAllPendingPolicyActions(
  db: Firestore,
): Promise<PendingPolicyQueueDocument[]> {
  const rows: PendingPolicyQueueDocument[] = [];
  const seenCursors = new Set<string>();
  const readPage = createQueryPager();
  let cursor: string | undefined;
  for (;;) {
    const page = await listPendingPolicyActionItemsPage(db, {
      limit: EARNING_TYPE_QUEUE_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    },readPage);
    rows.push(...page.items);
    if (page.nextCursor === null) return rows;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('earning_type_queue_cursor_did_not_advance');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function projectEarningTypes(
  db: Firestore,
  nowMs: number = Date.now(),
): Promise<EarningTypeProjection> {
  const [activation, queueRows, rulings] = await Promise.all([
    readActivationFacts(db),
    listAllPendingPolicyActions(db),
    listPolicyRulings(db),
  ]);
  const matrixMap = new Map(PROPOSED_ACTION_POLICY_ENTRIES.map((e) => [e.action_type, e]));
  const rulingMap = new Map(rulings.map((r) => [r.action_type, r]));
  const queueMap = new Map(queueRows.map((r) => [r.action_type, r]));

  const allTypes = new Set<string>([
    ...matrixMap.keys(),
    ...rulingMap.keys(),
    ...queueMap.keys(),
  ]);

  const views: EarningTypeView[] = [];
  for (const actionType of allTypes) {
    views.push(resolveView(actionType, matrixMap, rulingMap, queueMap, activation, nowMs));
  }
  views.sort((a, b) => a.action_type.localeCompare(b.action_type));

  const counts: Record<EarningTypeStatus, number> = { live: 0, building: 0, queued: 0, declined: 0 };
  for (const v of views) counts[v.status] += 1;

  return {
    generated_at_ms: nowMs,
    review_promise: EARNING_TYPE_REVIEW_PROMISE,
    footer: {
      template_digest: hashProposedMonetaryPolicyTemplate(),
      digest_match: activation.digestMatch,
      matrix_policy_version: PROPOSED_ACTION_POLICY_MANIFEST.policy_version,
      matrix_entry_count: PROPOSED_ACTION_POLICY_ENTRIES.length,
    },
    counts,
    types: views,
  };
}

/** Single-type status for the pull path (route + SDK/MCP). Null if unknown everywhere. */
export async function projectEarningType(
  db: Firestore,
  actionType: string,
  nowMs: number = Date.now(),
): Promise<EarningTypeView | null> {
  const entry = PROPOSED_ACTION_POLICY_ENTRIES.find((e) => e.action_type === actionType);
  if (entry) return matrixView(entry, await readActivationFacts(db));
  const ruling = await getPolicyRuling(db, actionType);
  if (ruling) return rulingView(ruling);
  const row = await getPendingPolicyAction(db, actionType);
  if (row) return queueView(row, nowMs);
  return null;
}
