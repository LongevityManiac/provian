import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE lookup primitives for cross-witness corroboration.
 *
 * Extracted from the now-deleted corroboration.ts placeholder (step 4a)
 * after step 4b's GATE 0 decision: corroboration writeback is folded
 * into the live CorroborationManager (single corroboration path), but the
 * commit-hash lookup remains a useful generic primitive that doesn't fit
 * inside the corroboration emitter. Kept here as a small, focused module.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { InputOrigin } from '../provenance/input-origins';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { mergeInputOrigins } from '../provenance/origin-capture';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import type { MeterActKeyDoc } from '../meter/meter-act-key';

// The IMMUTABLE envelope store is the source of truth for both the commit_sha
// metadata AND the canonical hash. The derived `pe_history` collection
// (writePEHistory) carries NEITHER a `metadata` map NOR a top-level `hash`
// field (its hash lives under `peHash`), so querying it here returned nothing
// in production - the bug this fixes.
const PROVENANCE_ENVELOPES = 'provenance_envelopes';

/**
 * One match returned by `findPEsByCommitSha`. Carries everything a
 * corroboration emitter needs about the target PE so callers do NOT have to
 * re-read the doc: the envelopeId (== PE id), the chain owner (`userId` /
 * `agentId`), and the canonical `hash`.
 */
export interface PECommitShaMatch {
  envelopeId: string;
  userId: string;
  agentId: string;
  /** Canonical PE hash from the immutable envelope. '' if absent. */
  hash: string;
}

/**
 * Find prior PEs whose metadata recorded the same commit hash. Powers
 * cross-witness corroboration: when a Witness 3 forge (GitHub/GitLab/Bitbucket)
 * webhook delivery arrives carrying a commit sha, any pre-existing Witness 1
 * device-path PE (e.g. an observer `coding_session` whose metadata captured the
 * commit hash) can be corroborated. Conversely the Witness 3 PE submitted from
 * the webhook is itself a match when a later device-path PE for the same commit
 * arrives.
 *
 * Reads from `provenance_envelopes` (the immutable envelope store written by the
 * PE batch buffer), which is the ONLY collection that carries both the
 * `metadata.commit_sha` field and the canonical `hash`. PEs emitted via
 * generatePE / the mobile + device submit endpoints all store custom metadata
 * under `metadata` here. (The earlier implementation read `pe_history`, whose
 * derived shape has no `metadata` map at all, so the query always returned [] in
 * production - cross-witness corroboration silently never fired.)
 *
 * Empty inputs are short-circuited to avoid scanning the entire collection.
 *
 * **Indexing.** This is an equality-only query on a single (nested) leaf field
 * with no orderBy/range, so Firestore's AUTOMATIC single-field index serves it -
 * no composite index or `firestore.indexes.json` entry is required, as long as
 * `metadata` is not single-field-exempted on `provenance_envelopes`
 * (`fieldOverrides` is currently empty, so it is not).
 */
export async function findPEsByCommitSha(
  db: Firestore,
  commitSha: string,
): Promise<PECommitShaMatch[]> {
  if (!commitSha) return [];
  // PE METER: a metered act's commit lives on its 31-day act key (the ruled cross-witness window);
  // pre-meter envelopes are read until the migration removes them.
  const [keys, legacy] = await Promise.all([
    privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).where('row.commit_sha', '==', commitSha).get(),
    db.collection(PROVENANCE_ENVELOPES).where('metadata.commit_sha', '==', commitSha).get(),
  ]);
  const metered = keys.docs.map((d) => {
    const key = d.data() as MeterActKeyDoc;
    return { envelopeId: d.id, userId: key.actor_id, agentId: key.actor_id, hash: key.pe_hash };
  });
  return [...metered, ...legacy.docs.map((d) => {
    const data = d.data() as {
      user_id?: string; agent_id?: string; hash?: string; peHash?: string;
    };
    const userId = data.user_id ?? '';
    return {
      envelopeId: d.id,
      userId,
      agentId: data.agent_id ?? userId,
      // `hash` is the envelope's canonical hash; `peHash` fallback covers any
      // derived-shaped doc that might be present in test fakes.
      hash: data.hash ?? data.peHash ?? '',
    };
  })];
}

/**
 * Prompt 2 — the order-independence origin union for a commit. Collect the
 * `input_origins` of every PRIOR PE that witnessed the same commit (e.g. a device
 * `coding_session` recorded before a forge webhook arrives) and union them. The
 * forge webhook calls this BEFORE sealing so the WINNING forge PE's canonical doc
 * carries the union of both witnesses' origins in the device-first arrival order
 * — rich device-side origins (parent, deps, files) are never stranded on the
 * demoted witness. The forge-first order is covered by the corroboration-time
 * union in `commit-takeover.ts`. Returns `[]` when no prior witness carried any.
 */
export async function findCommitOriginsBySha(
  db: Firestore,
  commitSha: string,
): Promise<InputOrigin[]> {
  if (!commitSha) return [];
  const [keys, snaps] = await Promise.all([
    privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).where('row.commit_sha', '==', commitSha).get(),
    db.collection(PROVENANCE_ENVELOPES).where('metadata.commit_sha', '==', commitSha).get(),
  ]);
  let union: InputOrigin[] = [];
  for (const d of keys.docs) {
    const normalized = normalizeInputOrigins((d.data() as MeterActKeyDoc).side?.commitOrigins ?? null);
    if (normalized !== null) union = mergeInputOrigins(union, normalized);
  }
  for (const d of snaps.docs) {
    const normalized = normalizeInputOrigins((d.data() as { input_origins?: unknown }).input_origins);
    if (normalized !== null) union = mergeInputOrigins(union, normalized);
  }
  return union;
}
