/**
 * PE METER cost pass (2026-10-04) — "index only queried fields".
 *
 * Every single-field index entry is storage that lives as long as its document, so the per-act
 * collections declare `indexes: []` exemptions (firestore.indexes.json `fieldOverrides`) for every
 * field no query filters or orders on. An exemption on a field some query DOES use makes that
 * query fail in production (FAILED_PRECONDITION), so this guard refuses one: for each exempted
 * field of a guarded collection, any non-test source file that names the collection (by literal
 * or by its constant) and contains `.where('<field>'` / `.orderBy('<field>'` is reported.
 *
 * File-level, so deliberately over-inclusive: a file that queries the field on a DIFFERENT
 * collection is reported too, and is cleared only by an entry in `KNOWN_OTHER_COLLECTION`
 * naming the file, the field and the collection it really queries.
 */

export interface FieldOverride {
  readonly collectionGroup: string;
  readonly fieldPath: string;
  readonly indexes?: readonly unknown[];
  readonly ttl?: boolean;
}

/** The per-act collections whose exemptions this guard checks, with the names code uses for them. */
export const GUARDED_EXEMPTION_COLLECTIONS: Readonly<Record<string, readonly string[]>> = {
  meter_act_keys_v1: ['METER_ACT_KEYS_COLLECTION'],
  meter_pending_claims_v1: ['METER_PENDING_CLAIMS_COLLECTION'],
  pvt9_claim_ledger_v1: ['CLAIM_LEDGER_COLLECTION'],
  artifact_novelty_claims: ['artifact_novelty'],
  device_occurrence_mint_claims: ['device_occurrence'],
  origin_reference_graph_v1: ['ORIGIN_REFERENCE_GRAPH_COLLECTION'],
  meter_pair_counts_v1: ['CITATION_PAIR_COUNTS_COLLECTION', 'METER_PAIR_COUNTS_COLLECTION'],
  pe_mailbox_v1: ['PE_MAILBOX_COLLECTION'],
  meter_batch_acts_v1: ['METER_BATCH_ACTS_COLLECTION'],
};

/** `${file}#${field}` → the collection that file really queries the field on. */
export const KNOWN_OTHER_COLLECTION: Readonly<Record<string, string>> = {
  'src/core/meter/pending-claim-index.ts#ready_at_ms': 'meter_pending_ready_v1',
  'src/core/meter/held-acts.ts#relay_pe_id': 'meter_held_acts_v1',
  'src/core/meter/meter-act-pages.ts#batch_hash': 'meter_batch_acts_v1',
  'src/core/meter/retire-demoted-meter-keys.ts#batch_hash': 'meter_pending_claims_v1 / meter_batches_v1',
  'src/core/meter/compact-relay-held.ts#batch_hash': 'pe_mailbox_v1',
  'src/core/meter/meter-relay-authored.ts#created_at_ms': 'meter_relay_acts_v1',
  'src/core/meter/held-acts.ts#held_reason': 'meter_held_acts_v1',
  'src/core/pvt/wp4/genesis-inlet-source.ts#pe_id': 'genesis_qualification_outbox_v2',
  'scripts/reclassify-test-genesis-pes.ts#pe_id': 'genesis_qualification_outbox_v2 / genesis_reservations_v2',
};

export interface SourceFile {
  /** Path relative to the backend root, `/`-separated. */
  readonly path: string;
  readonly text: string;
}

export interface QueriedExemption {
  readonly collection: string;
  readonly field: string;
  readonly file: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function guardedExemptions(overrides: readonly FieldOverride[]): FieldOverride[] {
  return overrides.filter((o) => GUARDED_EXEMPTION_COLLECTIONS[o.collectionGroup] !== undefined
    && o.ttl !== true
    && (o.indexes ?? []).length === 0);
}

export function findQueriedExemptions(
  overrides: readonly FieldOverride[],
  files: readonly SourceFile[],
  known: Readonly<Record<string, string>> = KNOWN_OTHER_COLLECTION,
): QueriedExemption[] {
  const out: QueriedExemption[] = [];
  for (const o of guardedExemptions(overrides)) {
    const names = [o.collectionGroup, ...(GUARDED_EXEMPTION_COLLECTIONS[o.collectionGroup] ?? [])];
    const query = new RegExp(`\\.(where|orderBy)\\(\\s*['"\`]${escapeRegExp(o.fieldPath)}['"\`]`);
    for (const file of files) {
      if (!names.some((n) => file.text.includes(n))) continue;
      if (!query.test(file.text)) continue;
      if (known[`${file.path}#${o.fieldPath}`] !== undefined) continue;
      out.push({ collection: o.collectionGroup, field: o.fieldPath, file: file.path });
    }
  }
  return out;
}
