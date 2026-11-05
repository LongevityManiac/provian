/**
 * READ-ONLY replay audit. Before the relay/action lane (`sealActionPE`) keyed a
 * hardware-witnessed PE's canonical event on `<type>:<peHash>`, new for every PE, so an identical
 * body replayed under the SAME hardware report (the report binds the body digest, so it verifies
 * again) sealed eligible again. This finds every such duplicate in production.
 *
 * Query:
 * provenance_envelopes WHERE witness_class == 'hardware_rooted'
 * → keep type == 'action_report' (the relay/action lane's stored shape)
 * → group by (action_type, hardware_witness.report_digest, hardware_witness.scheme,
 * sha256(stableStringify({description, success, metadata minus hardware_witness})))
 * A report's nonce IS the body digest (`nonce_bound`), so one report_digest can only ever admit
 * one body; the body key is recomputed anyway as a belt-and-braces check.
 * For each group of >1, read pe_history/<pe_id> (mint_status, estimated_pvt_atomic) and
 * pvt9_claim_ledger_v1 WHERE pe_key == <pe_id> (settled, settled_tx_hash, reserved_batch_id).
 * A duplicate is every eligible member after the FIRST eligible seal (by created_at).
 *
 * Also reports the same grouping for every OTHER lane that stores hardware_rooted PEs, so the
 * result states the lane population it was measured over (never a pass over zero).
 *
 * Usage: npx ts-node scripts/audit-relay-action-hardware-replays.ts --project provian-ai
 */
import crypto from 'crypto';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import stableStringify from 'json-stable-stringify';
import { scriptDb } from './lib/script-db';

function argument(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && typeof process.argv[i + 1] === 'string' ? process.argv[i + 1] : null;
}

function bodyKey(doc: Record<string, unknown>): string {
  const report = (doc.action_report ?? {}) as Record<string, unknown>;
  const metadata = typeof report.metadata === 'object' && report.metadata !== null
    ? { ...(report.metadata as Record<string, unknown>) }
    : null;
  if (metadata) delete metadata.hardware_witness;
  return crypto.createHash('sha256').update(stableStringify({
    description: report.description ?? null,
    success: report.success ?? null,
    metadata,
  }) || '').digest('hex');
}

async function main(): Promise<void> {
  const projectId = argument('--project');
  if (!projectId) throw new Error('required: --project <gcp-project>');
  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId });
  const db = scriptDb();

  const snap = await db.collection('provenance_envelopes').where('witness_class', '==', 'hardware_rooted').get();
  const byLane = new Map<string, number>();
  const groups = new Map<string, Array<{ id: string; doc: Record<string, unknown> }>>();
  for (const d of snap.docs) {
    const doc = d.data() as Record<string, unknown>;
    const lane = typeof doc.type === 'string' ? doc.type : '(no type)';
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
    // relay/action stores the sealed report top-level; the device and mobile lanes under metadata.
    const meta = (doc.metadata ?? {}) as Record<string, unknown>;
    const hw = (doc.hardware_witness ?? meta.hardware_witness ?? {}) as Record<string, unknown>;
    const key = [
      lane,
      String(doc.action_type ?? ''),
      String(hw.scheme ?? ''),
      String(hw.report_digest ?? `(none:${d.id})`),
      lane === 'action_report' ? bodyKey(doc) : '',
    ].join('|');
    const list = groups.get(key) ?? [];
    list.push({ id: d.id, doc });
    groups.set(key, list);
  }

  // The whole relay/action population (stored `type: 'action_report'`), whatever its witness class,
  // so a zero below is measured over a stated lane population, not an empty one.
  const lanePop = await db.collection('provenance_envelopes').where('type', '==', 'action_report').get();
  const laneRows = lanePop.docs.map((d) => {
    const x = d.data() as Record<string, unknown>;
    const hw = (x.hardware_witness ?? null) as Record<string, unknown> | null;
    return {
      pe_id: d.id,
      action_type: x.action_type ?? null,
      witness_class: x.witness_class ?? null,
      hardware_witness: hw ? { admitted: hw.admitted ?? null, scheme: hw.scheme ?? null, reason: hw.reason ?? null } : null,
      created_at: x.created_at ?? null,
    };
  });
  console.log(JSON.stringify({
    query_lane: "provenance_envelopes WHERE type == 'action_report'",
    relay_action_total: lanePop.size,
    relay_action_with_hardware_witness_present: laneRows.filter((r) => r.hardware_witness !== null).length,
    relay_action_rows: laneRows,
  }, null, 2));

  console.log(JSON.stringify({
    query: "provenance_envelopes WHERE witness_class == 'hardware_rooted'",
    hardware_rooted_total: snap.size,
    by_lane: Object.fromEntries(byLane),
    all_lane_groups_with_more_than_one_member: [...groups.values()].filter((v) => v.length > 1).length,
    relay_action_distinct_reports: [...groups.keys()].filter((k) => k.startsWith('action_report|')).length,
  }, null, 2));

  const duplicates: Array<Record<string, unknown>> = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    members.sort((a, b) => Number(a.doc.created_at ?? 0) - Number(b.doc.created_at ?? 0));
    const rows = [];
    for (const m of members) {
      const hist = await db.collection('pe_history').doc(m.id).get();
      const h = (hist.exists ? hist.data() : null) as Record<string, unknown> | null;
      const claims = await db.collection('pvt9_claim_ledger_v1').where('pe_key', '==', m.id).get();
      rows.push({
        pe_id: m.id,
        user_id: m.doc.user_id ?? null,
        agent_id: m.doc.agent_id ?? null,
        action_type: m.doc.action_type ?? null,
        created_at: m.doc.created_at ?? null,
        mint_status: h?.mint_status ?? null,
        estimated_pvt_atomic: h?.estimated_pvt_atomic ?? null,
        neutralized_reason: h?.neutralized_reason ?? null,
        claims: claims.docs.map((c) => {
          const cd = c.data();
          return {
            claim_key: c.id,
            settled: cd.settled ?? null,
            settled_tx_hash: cd.settled_tx_hash ?? null,
            reserved_batch_id: cd.reserved_batch_id ?? null,
            record_points_atomic: cd.record_points_atomic ?? null,
          };
        }),
      });
    }
    const eligible = rows.filter((r) => r.mint_status === 'eligible' || r.claims.length > 0);
    console.log(JSON.stringify({ group: key, members: rows }, null, 2));
    if (key.startsWith('action_report|') && eligible.length > 1) {
      for (const dup of eligible.slice(1)) duplicates.push({ group: key, ...dup });
    }
  }

  console.log(JSON.stringify({
    relay_action_groups_with_more_than_one_member: [...groups.entries()]
      .filter(([k, v]) => k.startsWith('action_report|') && v.length > 1).length,
    relay_action_duplicate_eligible_seals: duplicates.length,
    duplicates,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
