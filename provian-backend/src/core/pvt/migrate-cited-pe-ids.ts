/**
 * migrate-cited-pe-ids — fold the RETIRED `cited_pe_ids` vocabulary into the ONE graph
 * (Trust Layer build, §2.1: "Existing `cited_pe_ids` are migrated into the graph
 * as `pe:` edges with zero mint effect").
 *
 * For every `pe_history` row carrying a non-empty `cited_pe_ids`, write one `pe:<cited>` edge from
 * the row's signer to `signer:<cited signer>` with reason `migrated_citation`. The edge is a DERIVED
 * BACKFILL: it is idempotent (deterministic edge id over PE + origin + hash), it never touches the
 * sealed PE or its economic snapshot, and it prices nothing — `counted:false` always. `witnessed`
 * is true only when the SOURCE PE was itself witnessed at record time (a device-bound submit, or a
 * relay-assigned non-actor witness class), so a Consumption count (which requires a witnessed edge)
 * never credits a bare self-report's citations. The cited PE's sealed hash is the edge `hash`;
 * a cited id that resolves to no PE is recorded as `unresolvable_owner` (never guessed).
 *
 * Pure over `db` so it is unit-tested against the fake; `scripts/migrate-cited-pe-ids-to-graph.ts`
 * is the CLI (dry run by default; `--apply` writes).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { recordOriginEdges, type CitedPeDetail } from './origin-reference-graph';
import type { SealedOriginRef } from './origin-independence';

const PE_ID_RE = /^pe_[A-Za-z0-9_-]{1,240}$/;
const WITNESSED_CLASSES = new Set(['device_tier', 'hardware_rooted', 'chain_witnessed', 'forge_witnessed', 'relay_verified']);
const DEVICE_SOURCES = new Set(['device_pe_submit', 'mobile_app']);

export interface MigrationSummary {
  readonly rows_scanned: number;
  readonly rows_with_citations: number;
  readonly edges_planned: number;
  readonly edges_written: number;
  readonly unresolvable_citations: number;
  readonly witnessed_edges: number;
}

interface PeRow {
  readonly id: string;
  readonly userId: string;
  readonly peActionType: string;
  readonly peHash: string | null;
  readonly timestamp: number;
  readonly witnessedAtRecord: boolean;
  readonly citedPeIds: readonly string[];
}

function readRow(id: string, d: Record<string, unknown>): PeRow | null {
  if (typeof d.userId !== 'string' || d.userId.length === 0) return null;
  const cited = Array.isArray(d.cited_pe_ids)
    ? d.cited_pe_ids.filter((x): x is string => typeof x === 'string' && PE_ID_RE.test(x) && x !== id)
    : [];
  const src = typeof d.integrationSource === 'string' ? d.integrationSource
    : typeof d.integration_source === 'string' ? d.integration_source : '';
  const cls = typeof d.witness_class === 'string' ? d.witness_class : '';
  return {
    id,
    userId: d.userId,
    peActionType: typeof d.actionType === 'string' ? d.actionType : '',
    peHash: typeof d.peHash === 'string' && d.peHash.length > 0 ? d.peHash : null,
    timestamp: typeof d.timestamp === 'number' ? d.timestamp : 0,
    witnessedAtRecord: WITNESSED_CLASSES.has(cls) || DEVICE_SOURCES.has(src),
    citedPeIds: [...new Set(cited)],
  };
}

/** Plan + (optionally) write the migrated edges. Reads `pe_history` where `cited_pe_ids != null`. */
export async function migrateCitedPeIdsToGraph(
  db: Firestore,
  opts: { apply: boolean; nowMs?: number; pageSize?: number; log?: (line: string) => void },
): Promise<MigrationSummary> {
  const log = opts.log ?? (() => {});
  const nowMs = opts.nowMs ?? Date.now();
  const pageSize = opts.pageSize ?? 500;
  let rowsScanned = 0;
  let rowsWithCitations = 0;
  let edgesPlanned = 0;
  let edgesWritten = 0;
  let unresolvable = 0;
  let witnessedEdges = 0;
  const citedCache = new Map<string, PeRow | null>();

  const readCited = async (peId: string): Promise<PeRow | null> => {
    if (citedCache.has(peId)) return citedCache.get(peId) ?? null;
    const snap = await db.collection('pe_history').doc(peId).get();
    const row = snap.exists ? readRow(peId, (snap.data() ?? {}) as Record<string, unknown>) : null;
    citedCache.set(peId, row);
    return row;
  };

  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('pe_history').where('cited_pe_ids', '!=', null).limit(pageSize);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    for (const doc of page.docs) {
      rowsScanned += 1;
      const row = readRow(doc.id, doc.data() as Record<string, unknown>);
      if (!row || row.citedPeIds.length === 0) continue;
      rowsWithCitations += 1;
      const origins: SealedOriginRef[] = [];
      const detail = new Map<string, CitedPeDetail>();
      for (const citedId of row.citedPeIds) {
        const cited = await readCited(citedId);
        const originId = `pe:${citedId}`;
        if (!cited) {
          unresolvable += 1;
          origins.push({
            origin_identifier: originId, hash: originId, owner: null,
            witnessed: false, witness: null, counted: false, reason: 'unresolvable_owner',
          });
          continue;
        }
        const sameParty = cited.userId === row.userId;
        if (row.witnessedAtRecord && !sameParty) witnessedEdges += 1;
        origins.push({
          origin_identifier: originId,
          hash: cited.peHash ?? originId,
          owner: `signer:${cited.userId}`,
          witnessed: row.witnessedAtRecord,
          witness: null,
          counted: false,
          reason: sameParty ? 'same_party' : 'migrated_citation',
        });
        detail.set(originId, { citedPeId: cited.id, citedSigner: cited.userId, citedActionType: cited.peActionType });
      }
      edgesPlanned += origins.length;
      if (opts.apply) {
        edgesWritten += await recordOriginEdges(db, {
          signer: row.userId, peId: row.id, origins, nowMs, citedPeDetail: detail,
        });
      }
      log(`${row.id} ${row.userId} → ${origins.map((o) => o.origin_identifier).join(',')}${opts.apply ? '' : ' (dry)'}`);
    }
    last = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }
  return {
    rows_scanned: rowsScanned,
    rows_with_citations: rowsWithCitations,
    edges_planned: edgesPlanned,
    edges_written: edgesWritten,
    unresolvable_citations: unresolvable,
    witnessed_edges: witnessedEdges,
  };
}
