/**
 * PE METER cost pass — an index exemption may cover only a field no query uses.
 * Negative controls: a planted query on an exempted field is named; a known-other-collection
 * entry clears only its own file and field.
 */
import fs from 'fs';
import path from 'path';
import {
  findQueriedExemptions,
  guardedExemptions,
  type FieldOverride,
  type SourceFile,
} from './index-exemption-guard';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__test-helpers__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function sources(): SourceFile[] {
  return [...walk(path.join(BACKEND_ROOT, 'src')), ...walk(path.join(BACKEND_ROOT, 'scripts'))]
    .map((f) => ({ path: path.relative(BACKEND_ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
}

function overrides(): FieldOverride[] {
  return (JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'firestore.indexes.json'), 'utf8')) as {
    fieldOverrides: FieldOverride[];
  }).fieldOverrides;
}

describe('index exemptions on the per-act collections', () => {
  it('no exempted field is filtered or ordered on by any query in the tree', () => {
    const exempt = guardedExemptions(overrides());
    const files = sources();
    console.log(`[index-exemption-guard] ${exempt.length} exemptions checked against ${files.length} files`);
    expect(exempt.length).toBeGreaterThan(50);
    expect(files.length).toBeGreaterThan(500);
    expect(findQueriedExemptions(overrides(), files)).toEqual([]);
  });

  it('the fields the meter does query stay indexed', () => {
    const exempt = new Set(guardedExemptions(overrides()).map((o) => `${o.collectionGroup}.${o.fieldPath}`));
    for (const kept of [
      'meter_act_keys_v1.actor_id', 'meter_act_keys_v1.beneficiary_id', 'meter_act_keys_v1.timestamp',
      'meter_act_keys_v1.action_type', 'meter_pending_claims_v1.state', 'meter_pending_claims_v1.claim_key',
      'pvt9_claim_ledger_v1.claim_id', 'pvt9_claim_ledger_v1.claim_key', 'pvt9_claim_ledger_v1.created_at',
      'pvt9_claim_ledger_v1.settled', 'pvt9_claim_ledger_v1.pe_key', 'pvt9_claim_ledger_v1.held',
      'pvt9_claim_ledger_v1.settled_batch_id',
    ]) expect(exempt.has(kept)).toBe(false);
  });

  it('RED: a planted query on an exempted field is named', () => {
    const planted: SourceFile = {
      path: 'src/planted.ts',
      text: "db.collection(METER_PENDING_CLAIMS_COLLECTION).where('ready_at_ms', '<=', now).get();",
    };
    expect(findQueriedExemptions(overrides(), [planted])).toEqual([
      { collection: 'meter_pending_claims_v1', field: 'ready_at_ms', file: 'src/planted.ts' },
    ]);
  });

  it('RED: a known-other-collection entry clears only its own file and field', () => {
    const text = "db.collection(METER_ACT_KEYS_COLLECTION); db.collection(METER_HELD_ACTS_COLLECTION).where('held_reason', '==', r);";
    const cleared = findQueriedExemptions(overrides(), [{ path: 'src/core/meter/held-acts.ts', text }]);
    expect(cleared).toEqual([]);
    const elsewhere = findQueriedExemptions(overrides(), [{ path: 'src/other.ts', text }]);
    expect(elsewhere).toEqual([{ collection: 'meter_act_keys_v1', field: 'held_reason', file: 'src/other.ts' }]);
  });
});
