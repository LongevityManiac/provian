import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PRIVATE_LOOKUP_EXEMPTIONS } from './private-index-exemptions.generated';
import { privateRecordLookup } from './private-store';
it('binds encrypted lookup exemptions to the actual Firestore index configuration', () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, '../../../firestore.indexes.json'), 'utf8')) as { fieldOverrides: { collectionGroup: string; fieldPath: string; indexes?: unknown[] }[] };
  const expected: Record<string, string[]> = {};
  for (const rule of config.fieldOverrides) if (Array.isArray(rule.indexes) && rule.indexes.length === 0) (expected[rule.collectionGroup] ??= []).push(rule.fieldPath);
  for (const key of Object.keys(expected)) expected[key] = [...new Set(expected[key])].sort();
  expect(Object.keys(expected).length).toBeGreaterThan(0); expect(PRIVATE_LOOKUP_EXEMPTIONS).toEqual(expected);
});
it('RED same bare fingerprints never create one lookup entry per member or an index over their blob', () => {
  const oldSecret = process.env.RELAY_SIGNING_KEY; process.env.RELAY_SIGNING_KEY = 'public-index-exemption-control';
  try {
    const data = { actor_id: 'actor', fingerprints: Buffer.alloc(32 * 1000, 7) };
    const old = privateRecordLookup(data); // old generic behavior indexed the fingerprint blob
    const compact = privateRecordLookup(data, 'meter_occurrence_sets_v1');
    expect(Object.keys(old)).toHaveLength(2); expect(Object.keys(compact)).toHaveLength(1);
  } finally { if (oldSecret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = oldSecret; }
});
