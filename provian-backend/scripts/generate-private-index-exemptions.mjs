import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('firestore.indexes.json', root), 'utf8'));
const byCollection = {};
for (const rule of config.fieldOverrides) if (Array.isArray(rule.indexes) && rule.indexes.length === 0) {
  (byCollection[rule.collectionGroup] ??= []).push(rule.fieldPath);
}
const sorted = Object.fromEntries(Object.keys(byCollection).sort().map(key => [key, [...new Set(byCollection[key])].sort()]));
writeFileSync(fileURLToPath(new URL('src/core/provenance/private-index-exemptions.generated.ts', root)),
  '// Generated from firestore.indexes.json; run scripts/generate-private-index-exemptions.mjs.\n' +
  'export const PRIVATE_LOOKUP_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = ' + JSON.stringify(sorted, null, 2) + ';\n');
