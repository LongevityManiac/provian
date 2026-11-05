/**
 * genesis-human-signup-address-marker-backfill — review defect 1.
 *
 * The Genesis human-signup grant is ONE per ADDRESS. New grants seal
 * `genesis_human_signup_by_address_v1/<address>` in the registration transaction; a grant sealed
 * before the marker existed is still found at registration time by an unbounded action-type-
 * filtered query (and the marker materialized then). This script writes the markers for every
 * existing grant in bulk, so the per-registration fallback query is rarely needed, and REPORTS any
 * address that already carries more than one human-signup grant (outbox or retained) — which would
 * be a double grant to investigate before settlement.
 *
 * Reads the outbox (`GENESIS_QUALIFICATION_COLLECTION`, action_type == genesis_human_signup)
 * and the retention collection (`GENESIS_QUALIFICATION_RETENTION_COLLECTION`,
 * qualification.action_type == genesis_human_signup). The marker points at the EARLIEST grant for the address.
 *
 * DRY-RUNS by default; writes markers only with --apply (create-only: an existing marker is never
 * overwritten). It never touches a grant, an outbox row, a reservation or a claim.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/genesis-human-signup-address-marker-backfill.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/genesis-human-signup-address-marker-backfill.ts --apply # LIVE
 */

import admin from 'firebase-admin';
import {
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
} from '../src/core/pvt/genesis-award-state-machine';
import {
  GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION,
  genesisHumanSignupAddressMarkerId,
} from '../src/core/pvt/genesis-ingress';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

interface Grant { readonly docId: string; readonly address: string; readonly atMs: number; readonly source: 'outbox' | 'retention' }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const [outbox, retention] = await Promise.all([
    db.collection(GENESIS_QUALIFICATION_COLLECTION).where('action_type', '==', 'genesis_human_signup').get(),
    db.collection(GENESIS_QUALIFICATION_RETENTION_COLLECTION).where('qualification.action_type', '==', 'genesis_human_signup').get(),
  ]);
  const grants: Grant[] = [];
  for (const d of outbox.docs) {
    const data = d.data();
    if (typeof data.actor_address !== 'string') continue;
    grants.push({ docId: d.id, address: data.actor_address.toLowerCase(), atMs: num(data.qualifying_act_evidence?.qualifying_act_at_ms), source: 'outbox' });
  }
  for (const d of retention.docs) {
    const q = d.data().qualification ?? {};
    if (typeof q.actor_address !== 'string') continue;
    // A promoted retained grant is the SAME grant as its outbox row (same doc id): count it once.
    if (outbox.docs.some((o) => o.id === d.id)) continue;
    grants.push({ docId: d.id, address: q.actor_address.toLowerCase(), atMs: num(q.qualifying_act_evidence?.qualifying_act_at_ms), source: 'retention' });
  }
  const byAddress = new Map<string, Grant[]>();
  for (const g of grants) byAddress.set(g.address, [...(byAddress.get(g.address) ?? []), g]);

  const multi = [...byAddress.entries()].filter(([, gs]) => gs.length > 1);
  console.log(`Human-signup grants: ${grants.length} across ${byAddress.size} addresses`);
  console.log(`Addresses with MORE THAN ONE human-signup grant: ${multi.length}`);
  for (const [address, gs] of multi) {
    console.log(`  ${address}: ${gs.map((g) => `${g.docId} (${g.source})`).join(', ')}`);
  }

  const toCreate: { id: string; doc: Record<string, unknown> }[] = [];
  for (const [address, gs] of byAddress) {
    const id = genesisHumanSignupAddressMarkerId(address);
    const existing = await db.collection(GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION).doc(id).get();
    if (existing.exists) continue;
    const earliest = [...gs].sort((a, b) => (a.atMs - b.atMs) || (a.docId < b.docId ? -1 : 1))[0];
    toCreate.push({
      id,
      doc: {
        schema_version: 'genesis-human-signup-by-address/v1',
        address,
        qualification_doc_id: earliest.docId,
        source: `backfill_${earliest.source}`,
        created_at_ms: Date.now(),
      },
    });
  }
  console.log(`Markers to create: ${toCreate.length}`);
  for (const m of toCreate) console.log(`  ${m.id} → ${String(m.doc.qualification_doc_id)}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }
  let created = 0;
  for (const m of toCreate) {
    try {
      await db.collection(GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION).doc(m.id).create(m.doc);
      created += 1;
    } catch (err) {
      console.log(`  ${m.id} already exists (a registration materialized it) — skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`Done. Created ${created} markers.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
