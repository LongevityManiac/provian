/**
 * settlement runtime — the epoch keeper's COMMAND-LINE entrypoint.
 *
 * The same `runEpochKeeperRuntime` the scheduled route calls, so a hand run and a timer run
 * cannot behave differently. Safe to run at any time and any number of times: it re-reads the
 * chain before every call and does nothing when nothing is owed.
 *
 * Exit code 2 when the keeper's own verdict ALARMS — an epoch that should be open is still
 * closed after the run. That is what makes a cron wrapper or a CI probe able to page without
 * parsing the log.
 */

import * as admin from 'firebase-admin';
import { OperatorRefusal, runEpochKeeperRuntime } from '../src/core/pvt/wp4/operator-runtime';
import type { SettlementDb } from '../src/core/pvt/wp4/durable-settlement-store';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  if (admin.apps.length === 0) admin.initializeApp();
  const db = scriptDb() as unknown as SettlementDb;

  const { keeper, capClock, signer } = await runEpochKeeperRuntime({ db, log: console.log });
  console.log(JSON.stringify({
    signer,
    outcome: keeper.outcome,
    stopReason: keeper.stopReason,
    opened: keeper.opened,
    stillOwed: keeper.stillOwed,
    detail: keeper.detail,
    lag: keeper.lag,
    capClock: { level: capClock.level, alarm: capClock.alarm, message: capClock.message },
  }, null, 2));

  if (keeper.lag.alarm) process.exit(2);
}

main().catch((error) => {
  if (error instanceof OperatorRefusal) {
    console.error(`REFUSED (${error.reason}): ${error.message}`);
    process.exit(1);
  }
  console.error('epoch keeper failed:', error);
  process.exit(1);
});
