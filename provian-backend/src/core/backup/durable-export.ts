export const RESTORE_DRILLS_COLLECTION = 'ops_restore_drills_v1';
/**
 * The relay's backups: point-in-time recovery for 7 days on the database itself, plus ONE WEEKLY
 * export of the DURABLE data to Archive-class Cloud Storage, each export kept one year (bucket
 * lifecycle). No full scheduled backups. ( ran it daily over the whole database;
 * weekly, and only the collections needed to rebuild the relay.)
 *
 * ONE SNAPSHOT : every export reads every collection at ONE point-in-time-recovery
 * timestamp (`snapshotTime`, a whole minute in the past), so an export is a consistent view of the
 * database at that instant. Without it Firestore reads each collection whenever it gets to it, and
 * a settlement or ledger write landing mid-export could appear in one collection and not its
 * partner. PITR must be on for the database (it is, and the Command Center alarms if it is not);
 * if it is off Firestore refuses the request and the export alarms — never a silent unpinned export.
 *
 * Durable = everything the relay would need to stand back up: identity, links, escrows, Commons,
 * Genesis, settlement ledgers and cursors, policy, running totals, the 31-day act state, held acts,
 * pending claims. The export names its collections: every TOP-LEVEL collection the live database
 * lists at export time, minus the named LEGACY pre-meter and TRANSIENT lists (subtractive, so a
 * collection added tomorrow is kept: unknown = keep), plus the subcollection groups the relay
 * writes (`DURABLE_SUBCOLLECTION_GROUPS`). `listCollections` returns only top-level ids, so the
 * subcollection list is hand-kept — and `durable-export.test.ts` scans the relay's source for every
 * `.doc(…).collection(…)` / `collectionGroup(…)` name and fails if one is missing from it, so a new
 * subcollection cannot go unexported silently.
 */
import { randomUUID } from 'node:crypto';
import type { GcpRestClient } from '../cloud/google-rest';

export const RELAY_EXPORT_BUCKET = 'provian-ai-relay-exports';

/**
 * Pre-meter PE storage, its indexes, and orphans no live code reads (the relay keeps no
 * PEs; the operator: pre-meter PEs are expendable). Verified 2026-10-04 against every live reader in
 * `src/` `pe_history` and `provenance_envelopes` hold 0 rows; everything else here is read only
 * behind a pre-meter row that no longer exists, read by nothing, or (origin_reference_graph_v1)
 * superseded by the meter pair counts once `meter_pair_counts_state_v1/citation_backfill` is
 * complete (it is). NOT here on purpose — they must be kept: `pe_history_index_shard_migration`
 * (switches the sharded readers on), `identity_pes_legacy_v1`, `meter_pair_counts_state_v1`,
 * `pe_anchor_state`. The database move copies everything EXCEPT this list, and the weekly export
 * leaves it out too.
 */
export const LEGACY_PRE_METER_COLLECTIONS: readonly string[] = Object.freeze([
  'pe_history',
  'provenance_envelopes',
  'pe_hash_index',
  'pe_submit_idempotency',
  'pvt_accrual_effects',
  'pvt_ordinary_accrual_intake_v1',
  'pvt_ordinary_accrual_replay_state_v1',
  'pvt_ordinary_accrual_replay_cursor_v1',
  'actor_stats_applied',
  'origin_reference_graph_v1',
  'pvt9_pe_split_v1',
  'pe_daily_anchor_batches',
  'ops_pe_bug_signals_v1',
  'pe_economic_aggregate_drift_sweep',
  'activity_mint_counterparty',
  'chat_sessions',
  'voice_balances',
  'agent_policy',
  'genesis_signup_claimed',
  'genesis_device_link_claimed',
  'genesis_human_signup_claimed',
]);

/** The database move : every top-level collection except the legacy list, plus subcollections. */
export function cutoverCollectionIds(topLevel: readonly string[]): string[] {
  const dropped = new Set<string>(LEGACY_PRE_METER_COLLECTIONS);
  return [...new Set([...topLevel.filter((id) => !dropped.has(id)), ...DURABLE_SUBCOLLECTION_GROUPS])].sort();
}

/** Rebuildable or short-lived state: losing it costs a retry, never a record. */
export const TRANSIENT_COLLECTIONS: readonly string[] = Object.freeze([
  'rate_limits',
  'consumed_nonces',
  'connection_tokens',
  'setup_tokens',
  'network_meter_hours_v1',
  'pvt9_settlement_signer_leases_v1',
  'ops_snapshots',
  'ops_snapshots_v1',
  'webhook_deliveries',
  'witness_webhook_deliveries',
  'github_webhook_inbox_v1',
]);

/** Subcollection group ids the relay uses (listCollections() only returns top-level ids). */
export const DURABLE_SUBCOLLECTION_GROUPS: readonly string[] = Object.freeze([
  'shards',
  'rotation_history',
  'inbox_v1',
  'flags',
  'benefits',
  'selections',
  'purged_members',
]);

export function durableCollectionIds(topLevel: readonly string[]): string[] {
  const excluded = new Set<string>([...LEGACY_PRE_METER_COLLECTIONS, ...TRANSIENT_COLLECTIONS]);
  const ids = new Set<string>();
  for (const id of topLevel) if (!excluded.has(id)) ids.add(id);
  for (const id of DURABLE_SUBCOLLECTION_GROUPS) ids.add(id);
  return [...ids].sort();
}

export interface ExportPart {
  readonly collectionIds: readonly string[];
  readonly outputUriPrefix: string;
  readonly operation: string | null;
  readonly status: number;
  readonly detail: unknown;
}

export interface ExportStart {
  readonly parts: readonly ExportPart[];
  readonly collectionIds: readonly string[];
  readonly manifestUri: string;
  readonly ok: boolean;
  readonly status: number;
  readonly operation: string | null;
  readonly outputUriPrefix: string;
  /** The single PITR instant every collection is read at (ISO, whole minute). */
  readonly snapshotTime: string;
  readonly detail: unknown;
}

/**
 * The PITR instant an export started at `nowMs` reads: the whole minute before the current one, so
 * it is always in the past and minute-rounded (both required by `exportDocuments`), 60–120 s ago.
 */
export function exportSnapshotTimeMs(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000 - 60_000;
}

/** Start every part at one PITR snapshot; persist the full plan before issuing any export. */
export async function startDurableExport(params: {
  readonly rest: GcpRestClient;
  readonly projectId: string;
  readonly databaseId: string;
  readonly nowMs: number;
  /** `durableCollectionIds(<the live top-level listing>)`. An empty list exports nothing and is refused. */
  readonly collectionIds: readonly string[];
  readonly bucket?: string;
  /** Store immutable plan/operation manifests beside the exported parts. Failure refuses success. */
  readonly persistManifest: (uri: string, manifest: unknown) => Promise<void>;
  readonly runId?: string;
}): Promise<ExportStart> {
  const snapshotTime = new Date(exportSnapshotTimeMs(params.nowMs)).toISOString();
  const db = params.databaseId === '(default)' ? 'default' : params.databaseId;
  const outputUriPrefix = `gs://${params.bucket ?? RELAY_EXPORT_BUCKET}/${db}/${snapshotTime.slice(0, 10)}/${snapshotTime.slice(11, 13)}${snapshotTime.slice(14, 16)}Z/${params.runId ?? randomUUID()}`;
  const manifestUri = `${outputUriPrefix}/manifest.json`;
  const collectionIds = [...new Set(params.collectionIds)].sort();
  const parts: ExportPart[] = [];
  for (let at = 0; at < collectionIds.length; at += 100) {
    parts.push({collectionIds:collectionIds.slice(at,at+100),outputUriPrefix:`${outputUriPrefix}/part-${String(parts.length+1).padStart(5,'0')}`,operation:null,status:0,detail:'not_started'});
  }
  const base = {outputUriPrefix, snapshotTime, collectionIds, manifestUri};
  // Firestore interprets [] as the whole database: never submit it.
  if (parts.length === 0) return {...base, parts, ok:false,status:0,operation:null,detail:'no_collection_ids'};
  await params.persistManifest(`${outputUriPrefix}/plan.json`, {schema:'provian.durable-export.v1',...base,parts});
  const url = `https://firestore.googleapis.com/v1/projects/${params.projectId}/databases/${encodeURIComponent(params.databaseId)}:exportDocuments`;
  // Sequential submission stays below Firestore's concurrent export quota for the ordinary set.
  // Every part is accounted for even if one submission fails; the manifest never claims completion.
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const res = await params.rest.postJson(url, {outputUriPrefix:part.outputUriPrefix,collectionIds:part.collectionIds,snapshotTime});
    const data = res.data as { name?: unknown } | null;
    const operation = typeof data?.name === 'string' ? data.name : null;
    parts[i] = {...part,operation,status:res.status,detail:res.status === 200 && operation ? null : res.data};
    // A per-part receipt survives a process dying before the final manifest write.
    await params.persistManifest(`${outputUriPrefix}/part-${String(i+1).padStart(5,'0')}.json`, {...base,...parts[i]});
  }
  const failure = parts.find(p=>p.status !== 200 || !p.operation);
  const result: ExportStart = {...base,parts,ok:!failure,status:failure?.status ?? 200,operation:parts.length===1?parts[0].operation:null,detail:failure? 'export_parts_not_started':null};
  await params.persistManifest(manifestUri, {schema:'provian.durable-export.v1',...result});
  return result;
}
