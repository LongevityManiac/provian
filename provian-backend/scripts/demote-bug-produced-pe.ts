/**
 * Dry-run-first single-PE bug demotion. See bug-demotion.ts for invariants.
 *
 * `--meter-manifest <file.json>` demotes METERED single-lane acts (rows on their batch's act page)
 * through `meter-act-bug-demotion.ts`: the file is a JSON array of
 * `{ relay_pe_id, batch_hash, detector, expected_snapshot_hash, evidence }`, each proved on its own.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import admin from 'firebase-admin';
import {
  demoteBugProducedPe,
  PRODUCTION_BUG_DETECTORS,
} from '../src/core/pvt/wp4/bug-demotion';
import {
  demoteBugProducedMeterActs,
  PRODUCTION_METER_ACT_BUG_DETECTORS,
} from '../src/core/pvt/wp4/meter-act-bug-demotion';
import { scriptDb } from './lib/script-db';

interface MeterManifestEntry {
  readonly relay_pe_id: string;
  readonly batch_hash: string;
  readonly detector: string;
  readonly expected_snapshot_hash: string;
  readonly evidence: unknown;
}

async function runMeterManifest(file: string, execute: boolean): Promise<void> {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as MeterManifestEntry[];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('the manifest must be a non-empty JSON array');
  if (admin.apps.length === 0) admin.initializeApp();
  const db = scriptDb();
  const counts: Record<string, number> = {};
  // One demotion hold over every claim the manifest's acts live in, for the whole run: no
  // settlement path can take those claims while the demotions are in flight.
  const holdId = `demotion_${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 24)}_${Date.now()}`;
  const outcome = await demoteBugProducedMeterActs({
    db, entries, execute, holdId,
    onResult: (e, result) => {
      counts[result.kind] = (counts[result.kind] ?? 0) + 1;
      console.log(JSON.stringify({
        relay_pe_id: e.relay_pe_id,
        kind: result.kind,
        ...(result.kind === 'refused' ? { reason: result.reason } : {}),
        ...('demotion_id' in result ? { demotion_id: result.demotion_id } : {}),
        ...('proof' in result ? { witnesses: result.proof.evidence.witnesses } : {}),
      }));
    },
  });
  if (outcome.kind === 'hold_refused') {
    console.log(JSON.stringify({ total: entries.length, hold_refused: outcome.reason }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ total: entries.length, ...(execute ? { claims_held: outcome.held } : {}), ...counts }));
  if ((counts.refused ?? 0) > 0) process.exitCode = 2;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === 'string' ? process.argv[index + 1] : null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--list-detectors')) {
    const ids = [...Object.keys(PRODUCTION_BUG_DETECTORS), ...Object.keys(PRODUCTION_METER_ACT_BUG_DETECTORS).map((id) => `${id} (metered act)`)];
    console.log(ids.length ? ids.join('\n') : '(no production bug detectors are currently shipped)');
    return;
  }
  const manifest = arg('--meter-manifest');
  if (manifest) {
    await runMeterManifest(manifest, process.argv.includes('--execute'));
    return;
  }
  const peId = arg('--pe-id');
  const detectorId = arg('--detector');
  const expectedSnapshotHash = arg('--expected-snapshot-hash');
  if (!peId || !detectorId || !expectedSnapshotHash) {
    throw new Error('required: --pe-id <id> --detector <checked-in-id> --expected-snapshot-hash <hash> [--execute]');
  }
  if (admin.apps.length === 0) admin.initializeApp();
  const result = await demoteBugProducedPe({
    db: scriptDb(),
    peId,
    detectorId,
    expectedSnapshotHash,
    execute: process.argv.includes('--execute'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'refused') process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
