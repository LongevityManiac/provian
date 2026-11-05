/** Index-only repair of missing Archive anchor segments. No object or PE is read or rewritten.
 * FIRESTORE_DATABASE_ID=relay RELAY_SIGNING_KEY=<existing runtime secret> npx tsx scripts/repair-archive-segments.ts [--apply]
 */
import { ethers } from 'ethers';
import { scriptDb } from './lib/script-db';
import { visitQueryDocuments } from '../src/core/provenance/private-store';
import { canonicalJson } from '../src/core/meter/meter-wire';
import { METER_ANCHOR_DAYS_COLLECTION } from '../src/core/meter/meter-store';
import type { ArchiveDayDoc } from '../src/core/archive/archive-service';
import { ARCHIVE_DAYS_COLLECTION } from '../src/core/archive/archive-terms';
import { repairArchiveDaySegments } from '../src/core/archive/segment-repair';

async function main(): Promise<void> {
  if (process.env.FIRESTORE_DATABASE_ID !== 'relay') throw new Error('requires_named_relay_database');
  const apply = process.argv.includes('--apply');
  const db = scriptDb();
  const provider = new ethers.JsonRpcProvider(process.env.ARCHIVE_REPAIR_RPC_URL || 'https://mainnet.base.org', 8453, { staticNetwork: true });
  const contract = new ethers.Contract('0x889A59A847e490c5Cc91f281468AbAacc100a9fD', ['function verifyPE(bytes32,bytes32,bytes32[]) view returns (bool)'], provider);
  const anchor = { verifyPE: async (id: string, leaf: string, proof: string[]) => Boolean(await contract.verifyPE(id, leaf, proof)) };
  const report = { mode: apply ? 'apply' : 'dry_run', days_scanned: 0, records_found: 0, records_repaired: 0,
    records_verified_after_repair: 0, existing_segment_records_verified: 0, affected_pes: 0, objects_rewritten: 0 };
  const catalogs = new Map<string, Record<string, unknown>>();
  await visitQueryDocuments(db.collection(ARCHIVE_DAYS_COLLECTION), async snap => {
    const day = snap.data() as ArchiveDayDoc;
    report.days_scanned++;
    let catalog = catalogs.get(day.day);
    if (!catalog) { catalog = (await db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(day.day).get()).data() ?? {}; catalogs.set(day.day, catalog); }
    const result = await repairArchiveDaySegments(day, catalog, anchor);
    report.records_found += result.found;
    report.affected_pes += result.affectedPes;
    report.existing_segment_records_verified += result.verified - result.repaired;
    if (!apply || result.repaired === 0) return;
    await db.runTransaction(async txn => {
      const current = await txn.get(snap.ref);
      if (!current.exists || canonicalJson(current.data()!.parts) !== canonicalJson(day.parts)) throw new Error('archive_index_changed_retry');
      txn.update(snap.ref, { parts: result.parts, updated_at_ms: Date.now(), segment_repair_version: 1 });
    });
    const current = (await snap.ref.get()).data() as ArchiveDayDoc;
    const checked = await repairArchiveDaySegments(current, catalog, anchor);
    if (checked.found || checked.repaired || checked.verified !== result.verified) throw new Error('archive_repair_readback_failed');
    report.records_repaired += result.repaired;
    report.records_verified_after_repair += result.repaired;
  });
  console.log(JSON.stringify(report));
  provider.destroy();
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
