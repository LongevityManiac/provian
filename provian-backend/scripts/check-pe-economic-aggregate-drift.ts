/**
 * check-pe-economic-aggregate-drift — reconcile accrual-time economic
 * aggregates against the paged reference fold, by hand (M5 close-out).
 *
 * The same reconciliation the scheduled sweep runs
 * (`POST /v1/internal/scheduler/pe-aggregate-drift`), invokable from an
 * operator shell for a named identity or a sample. Reports every field that
 * differs; with --repair, rewrites the aggregate under a version CAS (an
 * identity that accrued during the fold reports `identity_active_retry_later`
 * rather than clobbering a live increment). Exit code 1 when drift was found
 * and not repaired, so it can gate a deploy step.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/check-pe-economic-aggregate-drift.ts --identity=user_abc
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/check-pe-economic-aggregate-drift.ts --sample=50
 * … --repair
 */

import admin from 'firebase-admin';
import {
  detectIdentityAggregateDrift,
  type IdentityDriftReport,
} from '../src/core/pvt/policy/economic-aggregate-maintenance';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

function parseArgs(argv: readonly string[]): { repair: boolean; identities: string[] | null; sample: number } {
  const repair = argv.includes('--repair');
  const identityArg = argv.find((a) => a.startsWith('--identity='));
  const identities = identityArg
    ? identityArg.slice('--identity='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const sampleArg = argv.find((a) => a.startsWith('--sample='));
  const sample = sampleArg ? Number(sampleArg.slice('--sample='.length)) : 25;
  return { repair, identities, sample: Number.isFinite(sample) && sample > 0 ? Math.floor(sample) : 25 };
}

function print(report: IdentityDriftReport): void {
  const roles = report.roles
    .map((r) => `${r.role}: rows=${r.evaluatedRows} unmarked=${r.unmarkedRows} mismatches=[${r.mismatches.join(',')}]`)
    .join(' | ');
  console.log(`  ${report.identity}: present=${report.aggregatePresent} drift=${report.drift} repair=${report.repair} ${roles}`);
}

async function main(): Promise<void> {
  const { repair, identities, sample } = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  console.log(`Mode: ${repair ? 'REPAIR (live writes on drift)' : 'REPORT ONLY'}\n`);

  let reports: IdentityDriftReport[];
  if (identities !== null) {
    reports = [];
    for (const identity of identities) {
      reports.push(await detectIdentityAggregateDrift(db, identity, { nowMs, repair }));
    }
  } else {
    // PE METER: the sampled sweep is retired (aggregates are applied once per fresh act in the
    // meter's batch commit; there is no PE history to sweep). Only a named pre-meter identity can
    // still be checked against its legacy rows until the migration.
    console.error(`--sample=${sample} is retired with the drift sweep; pass --identity=<id>`);
    process.exitCode = 2;
    return;
  }

  for (const report of reports) print(report);

  const unresolved = reports.filter((r) => r.drift
    && r.repair !== 'repaired' && r.repair !== 'aggregate_missing_backfilled');
  console.log(`\nDrifted: ${reports.filter((r) => r.drift).length} / ${reports.length}; unresolved: ${unresolved.length}`);
  if (unresolved.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
