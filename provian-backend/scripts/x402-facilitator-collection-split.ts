/**
 * One-off (2026-10-05): copy the x402 facilitator SERVICE's settlement records out of
 * `x402_facilitator_settlements_v1` (which the relay's witness lane also uses, with a different
 * schema) into the service's own `x402_facilitator_service_settlements_v1`. A service record is one
 * carrying `key` and `witness_status`; relay pointers carry `schema_version`. Copy-only and
 * idempotent (`create`, an existing copy is left alone); nothing is deleted.
 *
 *   FIRESTORE_DATABASE_ID=relay npx ts-node --transpile-only scripts/x402-facilitator-collection-split.ts [--execute]
 */
import { scriptDb } from './lib/script-db';

const FROM = 'x402_facilitator_settlements_v1';
const TO = 'x402_facilitator_service_settlements_v1';

(async () => {
  const execute = process.argv.includes('--execute');
  const db = scriptDb();
  const snap = await db.collection(FROM).get();
  let service = 0; let copied = 0; let present = 0; let relay = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const isService = typeof d.key === 'string' && 'witness_status' in d && !('schema_version' in d);
    if (!isService) { relay += 1; continue; }
    service += 1;
    const target = db.collection(TO).doc(doc.id);
    if ((await target.get()).exists) { present += 1; continue; }
    if (execute) { await target.create(d); copied += 1; }
  }
  console.log(JSON.stringify({ execute, scanned: snap.size, relay_pointers: relay, service_records: service, copied, already_present: present }));
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
