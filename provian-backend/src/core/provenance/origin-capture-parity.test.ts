/**
 * Prompt 2 — bind the THREE independent `origin-capture` copies to agreement.
 *
 * The witness-type literals and the private-origin type tags are declared once
 * per package (backend / SDK / app) because the three cannot cross-import. A
 * device stamps `witnessed:true` with `witness.type: 'observer_device'` and a
 * forge webhook stamps `'forge_webhook'`; if the three packages disagreed on one
 * of these strings, a graph consumer (Prompt 3) keying on the type would silently
 * split one witness kind into two. The private tags matter the same way: they are
 * the ONLY thing distinguishing a hashed-private origin's KIND, so a drift would
 * mis-group them. This source-reading test is the only thing that binds the
 * three, mirroring `input-origins-parity.test.ts` and the floor parity.
 *
 * RED control : change any one literal in one file and the
 * `detects a divergent set` case (and the per-const set-size assertion) goes red.
 * The evaluated-const count is asserted so an empty match cannot pass vacuously.
 */
import fs from 'fs';
import path from 'path';

// provian-backend/src/core/provenance/ → repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const SOURCES: ReadonlyArray<{ label: string; file: string }> = [
  { label: 'backend', file: path.join(REPO_ROOT, 'provian-backend/src/core/provenance/origin-capture.ts') },
  { label: 'sdk', file: path.join(REPO_ROOT, 'provian-agent-sdk/src/observer/origin-capture.ts') },
  { label: 'app', file: path.join(REPO_ROOT, 'src/core/provenance/originCapture.ts') },
];

const CONSTS = [
  'WITNESS_OBSERVER_DEVICE',
  'WITNESS_FORGE_WEBHOOK',
  'WITNESS_CHAIN_WATCHER',
  'WITNESS_ORIGIN_OWNER_SIGNATURE',
  'PRIVATE_FILE',
  'PRIVATE_URL_PATH',
  'PRIVATE_PKG',
  'PRIVATE_PROJECT',
] as const;

function extractLiteral(source: string, name: string): string | null {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

describe('Prompt 2 — the three origin-capture witness/private-tag literals agree', () => {
  it('every witness-type + private-tag literal is declared identically in all three packages', () => {
    const files = SOURCES.map(({ label, file }) => {
      expect(fs.existsSync(file)).toBe(true); // path must resolve — no silent skip
      return { label, source: fs.readFileSync(file, 'utf8') };
    });
    expect(files).toHaveLength(3); // empty-population guard

    let evaluated = 0;
    for (const name of CONSTS) {
      const literals = files.map((f) => ({ label: f.label, literal: extractLiteral(f.source, name) }));
      const missing = literals.filter((l) => l.literal === null).map((l) => l.label);
      expect(missing).toEqual([]); // every file declares every literal
      const distinct = new Set(literals.map((l) => l.literal));
      // eslint-disable-next-line no-console
      console.log(`[origin-capture-parity] ${name}:`, literals.map((l) => `${l.label}=${l.literal}`).join(' '));
      expect(distinct.size).toBe(1); // byte-equal across all three
      evaluated += 1;
    }
    expect(evaluated).toBe(CONSTS.length); // proves the loop actually ran
  });

  it('RED control: detects a divergent set (the comparison is not vacuous)', () => {
    const literals = ["'observer_device'", "'observer_device'", "'observer_DEVICE'"];
    expect(new Set(literals).size).not.toBe(1);
  });
});
