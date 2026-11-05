/**
 * Standard-lane settlement admissibility probe — READ-ONLY.
 *
 * The production-effect proof for the 2026-08-16 seam ruling (fix-everything run,
 * item 1): every post-cut `mint_status='eligible'` STANDARD-lane row in production
 * must evaluate SETTLEABLE — `evaluateEligibility` says `eligible` AND
 * `resolvePayee` resolves — through the exact projection the settlement inlet and
 * the batch-approval gate share (`buildEligibilityCandidate` → `projectEligibility`
 * → `evaluateEligibility`). At the time of the audit that population was 12 rows
 * (10 `service:github_commit` + 2 `wallet_created`) and every one refused
 * (`ghost_pe_no_work_evidence`; `wallet_created` also `signature_not_verified` +
 * `chain_not_verified`).
 *
 * It writes NOTHING: every Firestore access is a `.get()`. No claim is registered,
 * no ledger row is touched, nothing is consumed — the real settlement remains the
 * daily runner (`provian-pvt9-settlement`, `0 12 * * *`) with a 30-day interval per payee.
 *
 * The pre-cut legacy rows are reported as their own bucket and EXPECTED to refuse
 * (`pre_cut_line` the fence, deliberately unchanged). A probe that only
 * printed green would prove nothing: the pre-cut refusals are the in-run RED
 * control that the evaluator still refuses what it must.
 *
 * cd provian-backend && npx tsx scripts/probe-standard-settlement-admissibility.ts
 */
import * as admin from 'firebase-admin';
import {
  buildEligibilityCandidate,
  NO_GENESIS_ANCHORS,
  PE_HISTORY_COLLECTION,
  resolvePayee,
} from '../src/core/pvt/wp4/claim-inlet-source';
import type { SettlementDb } from '../src/core/pvt/wp4/durable-settlement-store';
import { corroborationLiftedRecordPointsAtomic } from '../src/core/pvt/policy/economic-projection';
import type { PEHistoryDocument } from '../src/pe-history';
import {
  evaluateEligibility,
  PVT9_ELIGIBILITY_CUT_LINE_MS,
} from '../src/core/pvt/wp-ev/eligibility';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
  const db = scriptDb() as unknown as SettlementDb;

  const page = await db.collection(PE_HISTORY_COLLECTION)
    .where('mint_status', '==', 'eligible')
    .orderBy('peId', 'asc')
    .limit(500)
    .get();

  let postCutSettleable = 0;
  let postCutRefused = 0;
  let preCutRefusedAsExpected = 0;
  let preCutAdmitted = 0;
  let genesisSkipped = 0;
  const refusals: string[] = [];

  for (const doc of page.docs) {
    const history = doc.data() ?? {};
    const peId = typeof history.peId === 'string' && history.peId !== '' ? history.peId : doc.id;
    if (history.is_genesis_grant === true) {
      genesisSkipped += 1;
      continue;
    }
    const timestamp = typeof history.timestamp === 'number' ? history.timestamp : 0;
    const postCut = timestamp > PVT9_ELIGIBILITY_CUT_LINE_MS;

    const candidate = await buildEligibilityCandidate(db, peId, NO_GENESIS_ANCHORS);
    const verdict = candidate === null
      ? null
      : evaluateEligibility(candidate);
    const points = corroborationLiftedRecordPointsAtomic(
      history as unknown as PEHistoryDocument,
    );
    const payee = await resolvePayee(db, history, points, peId);

    const eligible = verdict !== null && verdict.kind === 'eligible';
    const paid = payee.kind === 'resolved';
    const settleable = eligible && paid;
    const reasons = verdict === null
      ? ['candidate_unbuildable']
      : verdict.kind === 'ineligible' ? [...verdict.reasons] : [];
    if (!paid) reasons.push(`payee:${payee.kind === 'refused' ? payee.reason : 'unknown'}`);

    const line = `${postCut ? 'POST-CUT' : 'pre-cut '} ${settleable ? 'SETTLEABLE' : 'refused  '} `
      + `${peId} ${String(history.actionType ?? '?')} `
      + `evidence=${eligible && verdict.kind === 'eligible' ? verdict.evidence.join('+') : '-'} `
      + `${reasons.length > 0 ? `reasons=${reasons.join(',')}` : ''}`;
    console.log(line);

    if (postCut && settleable) postCutSettleable += 1;
    if (postCut && !settleable) { postCutRefused += 1; refusals.push(line); }
    if (!postCut && !settleable) preCutRefusedAsExpected += 1;
    if (!postCut && settleable) { preCutAdmitted += 1; refusals.push(line); }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`post-cut standard rows SETTLEABLE : ${postCutSettleable}`);
  console.log(`post-cut standard rows refused    : ${postCutRefused}`);
  console.log(`pre-cut legacy rows refused (RED control holds) : ${preCutRefusedAsExpected}`);
  console.log(`pre-cut legacy rows ADMITTED (must be 0)        : ${preCutAdmitted}`);
  console.log(`genesis rows skipped (own lane)   : ${genesisSkipped}`);

  if (postCutRefused > 0 || preCutAdmitted > 0) {
    console.error('\nPROBE RED — the seam is not closed (or the cut-line fence moved):');
    for (const line of refusals) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPROBE GREEN — every post-cut eligible standard row evaluates settleable; '
    + 'the legacy fence still refuses.');
}

main().catch((error) => {
  console.error('probe failed:', error);
  process.exitCode = 1;
});
