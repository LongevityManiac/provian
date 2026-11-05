/**
 * Generate the published PE schema snapshot (Trust Layer pass 2, §2.10) from the
 * relay's own constants and write it into the SDK package, where it ships to
 * builders and is served on /developers. The relay serves the LIVE schema at
 * GET /v1/schema/pe (buildPeSchema() directly, always current); this snapshot is
 * the offline copy, and `pe-schema-drift.test.ts` (§2.12) refuses to let it lag.
 *
 *   npx tsx scripts/generate-pe-schema.ts          # write the snapshot
 *   npx tsx scripts/generate-pe-schema.ts --check   # exit 1 if it would change
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildPeSchema } from '../src/core/schema/pe-schema';

export const SDK_SCHEMA_PATH = join(__dirname, '..', '..', 'provian-agent-sdk', 'schema', 'pe-schema.json');

/** Deterministic serialization the route, the SDK snapshot, and the drift test all share. */
export function serializePeSchema(): string {
  return JSON.stringify(buildPeSchema(), null, 2) + '\n';
}

function main(): void {
  const check = process.argv.includes('--check');
  const next = serializePeSchema();
  if (check) {
    const current = existsSync(SDK_SCHEMA_PATH) ? readFileSync(SDK_SCHEMA_PATH, 'utf8') : '';
    if (current !== next) {
      console.error('[pe-schema] DRIFT: the SDK snapshot lags the relay types. Run: npx tsx scripts/generate-pe-schema.ts');
      process.exit(1);
    }
    console.log('[pe-schema] snapshot is current.');
    return;
  }
  writeFileSync(SDK_SCHEMA_PATH, next);
  console.log(`[pe-schema] wrote ${SDK_SCHEMA_PATH} (schema_version ${buildPeSchema().schema_version}).`);
}

if (require.main === module) main();
