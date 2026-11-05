/**
 * read-only probe of the standard-lane reconciliation gate.
 *
 * Runs the EXACT production judgment (`judgeStandardLaneAdmission` over the
 * published report and this tree's deploy stamp) and prints the verdict.
 * Touches nothing: one Firestore read, no key, no transaction. This is the
 * operator's pre-settlement check and the recorded RED/GREEN evidence tool.
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import {
  judgeStandardLaneAdmission,
  readPublishedReconciliationReport,
} from '../src/core/pvt/wp4/standard-lane-recon-gate';
import { DEPLOYED_TREE_GIT_HEAD } from '../src/core/pvt/tree-stamp.generated';
import type { SettlementDb } from '../src/core/pvt/wp4/durable-settlement-store';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const db = scriptDb() as unknown as SettlementDb;

  const loaded = await readPublishedReconciliationReport(db);
  console.log(`published report : ${loaded.kind}`);
  console.log(`tree stamp       : ${DEPLOYED_TREE_GIT_HEAD ?? 'null (unstamped)'}`);

  const verdict = judgeStandardLaneAdmission(loaded, DEPLOYED_TREE_GIT_HEAD);
  if (verdict.admitted) {
    console.log('VERDICT          : ADMITTED');
    console.log(`  report_sha256  : ${verdict.basis.report_sha256}`);
    console.log(`  git_head       : ${verdict.basis.git_head}`);
    console.log(`  C1=${verdict.basis.c1} C3=${verdict.basis.c3} C6=${verdict.basis.c6}`);
  } else {
    console.log(`VERDICT          : REFUSED (${verdict.reason})`);
    console.log(`  ${verdict.detail}`);
  }
  process.exit(verdict.admitted ? 0 : 1);
}

main().catch((err) => {
  console.error('[wp4-standard-lane-gate-probe] failed:', err);
  process.exit(1);
});
