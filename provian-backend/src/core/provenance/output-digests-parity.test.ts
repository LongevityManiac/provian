/**
 * Trust Layer build §2.3 — bind the THREE independent `output_digests` normalizer copies to
 * agreement (relay / SDK / app cannot cross-import). Mirrors `input-origins-parity.test.ts`: the
 * caps AND the hash grammar must be byte-identical, the evaluated-population count is asserted so
 * an empty match cannot pass vacuously, and a RED control proves the set-size check bites.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const SOURCES = [
  { label: 'backend', file: path.join(REPO_ROOT, 'provian-backend/src/core/provenance/output-digests.ts') },
  { label: 'sdk', file: path.join(REPO_ROOT, 'provian-agent-sdk/src/output-digests.ts') },
  { label: 'app', file: path.join(REPO_ROOT, 'src/core/provenance/outputDigests.ts') },
];

const CONSTS = [
  'OUTPUT_DIGESTS_MAX_ENTRIES',
  'OUTPUT_DIGEST_HASH_MAX_LEN',
  'OUTPUT_DIGEST_LOCATOR_MAX_LEN',
  'OUTPUT_DIGEST_HASH_RE',
] as const;

function extractLiteral(source: string, name: string): string | null {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

describe('§2.3 — the three output_digests normalizer copies agree', () => {
  it('every cap and the hash grammar is declared identically in all three packages', () => {
    const files = SOURCES.map(({ label, file }) => {
      expect(fs.existsSync(file)).toBe(true);
      return { label, source: fs.readFileSync(file, 'utf8') };
    });
    expect(files).toHaveLength(3);
    let evaluated = 0;
    for (const name of CONSTS) {
      const literals = files.map((f) => ({ label: f.label, literal: extractLiteral(f.source, name) }));
      expect(literals.filter((l) => l.literal === null).map((l) => l.label)).toEqual([]);
      const distinct = new Set(literals.map((l) => l.literal));
      // eslint-disable-next-line no-console
      console.log(`[output-digests-parity] ${name}:`, literals.map((l) => `${l.label}=${l.literal}`).join(' '));
      expect(distinct.size).toBe(1);
      evaluated += 1;
    }
    expect(evaluated).toBe(CONSTS.length);
  });
  it('the KIND vocabulary is identical across the three (a kind one copy drops would be REFUSED by the relay)', () => {
    const kinds = SOURCES.map(({ file }) => {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/export const OUTPUT_DIGEST_KINDS = \[([\s\S]*?)\] as const;/);
      return m ? m[1].replace(/\s+/g, '') : null;
    });
    expect(kinds.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(kinds).size).toBe(1);
  });
  it('RED control: detects a divergent set (the comparison is not vacuous)', () => {
    expect(new Set(['64', '64', '65']).size).not.toBe(1);
  });
});
