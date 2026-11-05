/**
 * reclassify-test-genesis-pes — consign the stuck TEST `genesis_signup` PEs
 * (the probes d294-loop0..7 / d294-A / d294-B plus the
 * settle-e2e probe — eleven rows verified in production 2026-08-16) from
 * mint_status 'eligible' to TERMINAL 'record_only'.
 *
 * WHY (2026-08-16 production-effect audit, item 3): the cleanup deleted
 * these probes' reservations and outbox rows, and consignment marked
 * their agent wallets platform:'test', so the rows are UNREACHABLE by any
 * settlement (the Genesis inlet reads only complete outbox rows; the standard
 * inlet skips is_genesis_grant rows) — yet they sit permanently
 * mint_status 'eligible', re-scanned by every scheduled standard-inlet page and
 * displaying 75-PVT estimates on any surface that reads mint_status.
 *
 * LAWFULNESS: eligible → record_only is an explicitly permitted transition in
 * the system's own disposition matrix (monetary-accounting.ts
 * MINT_DISPOSITION_TRANSITIONS / canTransitionMintDisposition), record_only is
 * terminal (no out-transitions), and 'policy_record_only' is an existing
 * record_only reason code (no enum widening). The write mirrors the record_only
 * invalidation shape of the PVTv8 minting engine (minting-engine.ts, since deleted). This
 * deliberately does NOT use 'ineligible'/'ineligible_terminal' test
 * consignment is not a compliance verdict (pitfall 45 terminality untouched).
 *
 * GUARDS — ALL required per row, fail-closed (a row failing ANY guard is
 * refused, never coerced):
 * 1. actionType === 'genesis_signup' and mint_status/mint_disposition both
 * currently 'eligible' (a minted, minting, or otherwise-transitioned row
 * is refused);
 * 2. is_genesis_grant === true;
 * 3. the actor's agent wallet(s) (agent_wallets where agent_id == userId)
 * exist and are ALL platform:'test' (the consignment marker);
 * 4. no pvt9_claim_ledger_v1 row `${peId}#sole` exists (never touched by
 * settlement);
 * 5. no genesis_qualification_outbox_v2 row names the pe_id (any status);
 * 6. no genesis_reservations_v2 row names the pe_id.
 *
 * DRY-RUNS by default; writes only with --apply. Expected population: exactly
 * the eleven enumerated probe rows. Review the dry-run before applying.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/reclassify-test-genesis-pes.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/reclassify-test-genesis-pes.ts --apply # LIVE
 */

import { claimKeyOf } from '../src/core/pvt/wp4/durable-settlement-store';
import { canTransitionMintDisposition } from '../src/core/pvt/policy/monetary-accounting';

// =============================================================================
// PURE GUARD — exported for the in-suite unit tests (watcher-enumeration.test.ts)
// =============================================================================

/** Everything the verdict depends on, gathered read-only per row. */
export interface ReclassifyRowFacts {
  readonly peId: string;
  readonly actionType: unknown;
  readonly mintStatus: unknown;
  readonly mintDisposition: unknown;
  readonly isGenesisGrant: unknown;
  /** platform of every agent_wallets doc matching agent_id == userId. */
  readonly actorWalletPlatforms: readonly unknown[];
  readonly claimLedgerRowExists: boolean;
  readonly outboxRowCount: number;
  readonly reservationRowCount: number;
}

export type ReclassifyVerdict =
  | { readonly verdict: 'demote' }
  | { readonly verdict: 'refuse'; readonly reason: string };

export function judgeReclassification(facts: ReclassifyRowFacts): ReclassifyVerdict {
  if (facts.actionType !== 'genesis_signup') {
    return { verdict: 'refuse', reason: `not_genesis_signup:${String(facts.actionType)}` };
  }
  if (facts.mintStatus !== 'eligible') {
    return { verdict: 'refuse', reason: `mint_status_not_eligible:${String(facts.mintStatus)}` };
  }
  if (facts.mintDisposition !== 'eligible') {
    return {
      verdict: 'refuse',
      reason: `mint_disposition_not_eligible:${String(facts.mintDisposition)}`,
    };
  }
  // The system's own transition matrix must permit the demotion (it does:
  // eligible → record_only; asserted rather than assumed so a future matrix
  // change refuses here instead of writing an unlawful transition).
  if (!canTransitionMintDisposition('eligible', 'record_only')) {
    return { verdict: 'refuse', reason: 'transition_not_permitted' };
  }
  if (facts.isGenesisGrant !== true) {
    return { verdict: 'refuse', reason: 'not_genesis_grant' };
  }
  if (facts.actorWalletPlatforms.length === 0) {
    return { verdict: 'refuse', reason: 'actor_wallet_not_found' };
  }
  if (!facts.actorWalletPlatforms.every((platform) => platform === 'test')) {
    return { verdict: 'refuse', reason: 'actor_wallet_not_test_platform' };
  }
  if (facts.claimLedgerRowExists) {
    return { verdict: 'refuse', reason: 'claim_ledger_row_exists' };
  }
  if (facts.outboxRowCount !== 0) {
    return { verdict: 'refuse', reason: `outbox_row_names_pe:${facts.outboxRowCount}` };
  }
  if (facts.reservationRowCount !== 0) {
    return { verdict: 'refuse', reason: `reservation_names_pe:${facts.reservationRowCount}` };
  }
  return { verdict: 'demote' };
}

/**
 * The restrictive demotion write — the retired PVTv8 minting engine's record_only
 * invalidation shape plus the consignment audit stamp.
 */
export function reclassifyWrite(nowMs: number): Record<string, unknown> {
  return {
    mint_status: 'record_only',
    mint_disposition: 'record_only',
    disposition_reason_code: 'policy_record_only',
    estimatedPVT: 0,
    estimated_pvt_atomic: '0',
    economic_eligibility_projection: null,
    mint_status_updated_at: nowMs,
    test_consignment_outcome: 'd294_d295_probe_consigned',
    test_consignment_audit: 'reclassify-test-genesis-pes (2026-08-16 production-effect'
      + ' audit item 3): / probe debris consigned per actor agent'
      + ' wallet platform=test, no claim-ledger row, no outbox row, no reservation',
  };
}

// =============================================================================
// OPERATOR ENTRYPOINT (never runs on import — jest imports the guards above)
// =============================================================================

async function main(): Promise<void> {
  // Deferred so importing the pure guards never initializes firebase-admin.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = (await import('firebase-admin')).default;
  const { scriptDb } = await import('./lib/script-db');
  admin.initializeApp();
  const db = scriptDb();

  const apply = process.argv.includes('--apply');
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const snap = await db.collection('pe_history')
    .where('actionType', '==', 'genesis_signup')
    .where('mint_status', '==', 'eligible')
    .get();
  console.log(`pe_history rows with actionType=genesis_signup, mint_status=eligible: ${snap.docs.length}\n`);

  const plan: Array<{ peId: string; userId: string; verdict: ReclassifyVerdict }> = [];
  for (const doc of snap.docs) {
    const row = doc.data() as Record<string, unknown>;
    const peId = typeof row.peId === 'string' && row.peId.length > 0 ? row.peId : doc.id;
    const userId = typeof row.userId === 'string' ? row.userId : '';

    const [walletSnap, ledgerSnap, outboxSnap, reservationSnap] = await Promise.all([
      userId.length > 0
        ? db.collection('agent_wallets').where('agent_id', '==', userId).get()
        : Promise.resolve({ docs: [] as Array<{ data: () => Record<string, unknown> }> }),
      db.collection('pvt9_claim_ledger_v1').doc(claimKeyOf(peId, 'sole')).get(),
      db.collection('genesis_qualification_outbox_v2').where('pe_id', '==', peId).limit(2).get(),
      db.collection('genesis_reservations_v2').where('pe_id', '==', peId).limit(2).get(),
    ]);

    const verdict = judgeReclassification({
      peId,
      actionType: row.actionType,
      mintStatus: row.mint_status,
      mintDisposition: row.mint_disposition,
      isGenesisGrant: row.is_genesis_grant,
      actorWalletPlatforms: walletSnap.docs.map((wallet) => wallet.data()?.platform),
      claimLedgerRowExists: ledgerSnap.exists,
      outboxRowCount: outboxSnap.docs.length,
      reservationRowCount: reservationSnap.docs.length,
    });
    plan.push({ peId, userId, verdict });
  }

  console.log('pe_id (first 24)          | userId                | verdict');
  console.log('-'.repeat(90));
  for (const p of plan) {
    const verdictLabel = p.verdict.verdict === 'demote'
      ? 'DEMOTE eligible -> record_only'
      : `refuse (${p.verdict.reason})`;
    console.log(`${p.peId.slice(0, 24).padEnd(25)} | ${p.userId.padEnd(21)} | ${verdictLabel}`);
  }
  const demote = plan.filter((p) => p.verdict.verdict === 'demote');
  const refused = plan.length - demote.length;
  console.log(`\nSummary: demote=${demote.length} refused=${refused} (expected demote population: the 11 / probe rows)`);

  if (!apply) {
    console.log('\nDry run only. Review the plan above, then re-run with --apply to execute.');
    return;
  }

  const nowMs = Date.now();
  for (const p of demote) {
    await db.collection('pe_history').doc(p.peId).update(reclassifyWrite(nowMs));
    console.log(`written: ${p.peId}`);
  }
  console.log(`\nDone: ${demote.length} rows demoted to terminal record_only.`
    + ' Re-run without --apply to verify the selection is now empty.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
