/**
 * the PVT9 claim-ledger LEG-SUM AUDIT. Read-only by default.
 *
 * npx tsx scripts/pvt9-leg-sum-audit.ts # dry run: classify every PE, write nothing
 * npx tsx scripts/pvt9-leg-sum-audit.ts --apply # apply the planned corrections
 * npx tsx scripts/pvt9-leg-sum-audit.ts --out report.json
 *
 * Scans `pvt9_claim_ledger_v1`, groups the ACT rows of every standard-lane PE (top-up rows,
 * `#attestation_topup`, are counted apart and never summed), and compares them with the splits
 * the inlet's own arithmetic could have produced for that PE (`leg-sum-audit.ts`). Prints one
 * JSON report: counts per status, every PE whose legs do not sum to exactly 100% on which a
 * leg already SETTLED (with its tx hashes and amounts — those cannot be un-minted), and the
 * correction planned (dry run) or applied (`--apply`) for every non-conforming PE.
 *
 * `--apply` is idempotent and transactional per PE: each correction re-reads every row it
 * relies on and refuses `state_changed` if any moved, and a PE already frozen is left alone,
 * so a second `--apply` changes nothing.
 */

import { writeFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { runLegSumAudit, type AuditDb } from '../src/core/pvt/wp4/leg-sum-audit';
import { scriptDb } from './lib/script-db';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === 'string' ? process.argv[index + 1] : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const out = arg('--out');
  if (admin.apps.length === 0) admin.initializeApp();
  const report = await runLegSumAudit(scriptDb() as unknown as AuditDb, {
    apply,
    nowMs: Date.now(),
  });
  const json = JSON.stringify(report, null, 2);
  if (out !== null) writeFileSync(out, `${json}\n`);
  console.log(json);
  console.error(
    `[leg-sum-audit] mode=${report.mode} standard_pes=${report.standard_pes} `
    + `counts=${JSON.stringify(report.counts)} settled_mismatches=${report.settled_mismatches.length}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
