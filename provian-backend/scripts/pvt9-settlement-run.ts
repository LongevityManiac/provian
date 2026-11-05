/**
 * settlement runtime — the operator's COMMAND-LINE settlement entrypoint.
 *
 * inlet (qualifying acts -> durable claims) -> runSettlementCycle (claims -> PVT)
 *
 * Every decision, gate, and key read lives in `core/pvt/wp4/operator-runtime.ts`. This file is
 * argv, logging, and an exit code, and it must stay that way: the relay route
 * (`POST /v1/internal/settlement/pvt9-run`) calls the SAME `runSettlement`, and a second
 * implementation here would be a second set of gates that can disagree with the first. When
 * two paths can mint, the weaker one is the one that mints.
 *
 * ARMING. The run REFUSES unless `PVT9_SETTLEMENT_ARMED` is exactly `yes-settle-real-pvt`.
 * `--dry-run` runs both inlets and reports what WOULD settle, without arming and without
 * touching a key.
 *
 * WHAT IT DOES NOT DO. It does not advance the epoch — that is the keeper
 * (`scripts/pvt9-epoch-keeper.ts`, and the scheduled route) — does not schedule policy, and
 * does not close Genesis admission. It settles the backlog that exists under the policy
 * already in force.
 */

import * as admin from 'firebase-admin';
import {
  OperatorRefusal,
  runSettlement,
  summarizeSettlementRun,
} from '../src/core/pvt/wp4/operator-runtime';
import type { SettlementDb } from '../src/core/pvt/wp4/durable-settlement-store';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (admin.apps.length === 0) admin.initializeApp();
  const db = scriptDb() as unknown as SettlementDb;

  const result = await runSettlement({ db, dryRun, log: console.log });
  console.log(JSON.stringify(summarizeSettlementRun(result), null, 2));
}

main().catch((error) => {
  if (error instanceof OperatorRefusal) {
    console.error(`REFUSED (${error.reason}): ${error.message}`);
    process.exit(1);
  }
  console.error('settlement run failed:', error);
  process.exit(1);
});
