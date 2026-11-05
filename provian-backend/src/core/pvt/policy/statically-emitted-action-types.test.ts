/**
 * Binds `STATICALLY_EMITTED_ACTION_TYPES` (the runtime copy new-type intake rule (ii) reads) to its
 * single source: the signed action-policy matrix's `maintained_sources.static_emitter_files`. The
 * relay image does not ship `docs/audit/`, so the runtime cannot read the matrix; this suite is
 * what keeps the copy from lagging. RED control: a copy missing one emitted type, or carrying an
 * extra one, is reported by the same comparison.
 */
import fs from 'fs';
import path from 'path';
import { STATICALLY_EMITTED_ACTION_TYPES } from './statically-emitted-action-types';

const MATRIX = path.resolve(__dirname, '../../../../../docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json');

interface MatrixRow { action_type: string; maintained_sources?: { static_emitter_files?: string[] } }

function emittedInMatrix(): string[] {
  const matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8')) as { rows: MatrixRow[] };
  return matrix.rows
    .filter((row) => (row.maintained_sources?.static_emitter_files ?? []).length > 0)
    .map((row) => row.action_type)
    .sort();
}

function drift(copy: readonly string[], source: readonly string[]): { missing: string[]; extra: string[] } {
  const c = new Set(copy);
  const s = new Set(source);
  return { missing: source.filter((t) => !c.has(t)), extra: copy.filter((t) => !s.has(t)) };
}

describe('STATICALLY_EMITTED_ACTION_TYPES is the signed matrix\'s static-emitter set', () => {
  it('equals the matrix exactly (update the list in the same change as the matrix)', () => {
    const source = emittedInMatrix();
    expect(source.length).toBeGreaterThan(100); // never a pass over an empty population
    expect(drift(STATICALLY_EMITTED_ACTION_TYPES, source)).toEqual({ missing: [], extra: [] });
    expect(new Set(STATICALLY_EMITTED_ACTION_TYPES).size).toBe(STATICALLY_EMITTED_ACTION_TYPES.length);
  });

  it('RED — a copy that drops one type or adds one is caught', () => {
    const source = emittedInMatrix();
    expect(drift(source.slice(1), source).missing).toEqual([source[0]]);
    expect(drift([...source, 'not_an_emitted_type'], source).extra).toEqual(['not_an_emitted_type']);
  });
});
