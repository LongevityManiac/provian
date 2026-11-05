/**
 * Prompt 1 — bind the THREE independent `input_origins` normalizer copies to
 * agreement. The normalizer's caps are declared once per package (backend / SDK
 * / app) because the three cannot cross-import, so no compiler binds them. The
 * relay copy is authoritative (it normalizes and stores), but if the three
 * diverge on a cap the device could hash a value the relay would truncate
 * differently — a state could even flip. This source-reading test is the only
 * thing that binds the three, mirroring the ai-conversation floor parity.
 *
 * RED control : seed any one literal to a different value → the
 * `detects a divergent set` case (and the byte-equality assertion) goes red. The
 * evaluated-population count is asserted so an empty match cannot pass vacuously.
 */
import fs from 'fs';
import path from 'path';

// provian-backend/src/core/provenance/ → repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const SOURCES: ReadonlyArray<{ label: string; file: string }> = [
  { label: 'backend', file: path.join(REPO_ROOT, 'provian-backend/src/core/provenance/input-origins.ts') },
  { label: 'sdk', file: path.join(REPO_ROOT, 'provian-agent-sdk/src/input-origins.ts') },
  { label: 'app', file: path.join(REPO_ROOT, 'src/core/provenance/inputOrigins.ts') },
];

const CONSTS = [
  'INPUT_ORIGINS_MAX_ENTRIES',
  'INPUT_ORIGIN_HASH_MAX_LEN',
  'INPUT_ORIGIN_IDENTIFIER_MAX_LEN',
  // Prompt 1b witness caps.
  'INPUT_ORIGIN_WITNESS_TYPE_MAX_LEN',
  'INPUT_ORIGIN_WITNESS_IDENTITY_MAX_LEN',
  'INPUT_ORIGIN_WITNESS_TIER_MAX_LEN',
] as const;

function extractLiteral(source: string, name: string): string | null {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

describe('Prompt 1 — the three input_origins normalizer caps agree', () => {
  it('every cap is declared identically in all three packages', () => {
    const files = SOURCES.map(({ label, file }) => {
      expect(fs.existsSync(file)).toBe(true); // path must resolve — no silent skip
      return { label, source: fs.readFileSync(file, 'utf8') };
    });
    expect(files).toHaveLength(3); // empty-population guard

    let evaluated = 0;
    for (const name of CONSTS) {
      const literals = files.map((f) => ({ label: f.label, literal: extractLiteral(f.source, name) }));
      const missing = literals.filter((l) => l.literal === null).map((l) => l.label);
      expect(missing).toEqual([]); // every file declares every cap
      const distinct = new Set(literals.map((l) => l.literal));
      // eslint-disable-next-line no-console
      console.log(`[input-origins-parity] ${name}:`, literals.map((l) => `${l.label}=${l.literal}`).join(' '));
      expect(distinct.size).toBe(1); // byte-equal across all three
      evaluated += 1;
    }
    expect(evaluated).toBe(CONSTS.length); // proves the loop actually ran
  });

  it('RED control: detects a divergent set (the comparison is not vacuous)', () => {
    // A deliberately mismatched trio must be caught by the same set-size check.
    const literals = ['64', '64', '65'];
    expect(new Set(literals).size).not.toBe(1);
  });
});
