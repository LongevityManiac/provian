/**
 * (A) — no module inside the hosted bundle may self-execute.
 *
 * THE DEFECT. In the single-file esbuild bundle every module shares the
 * bundle's own `module`, so a classic `if (require.main === module) main()` is
 * TRUE in every bundled submodule. `register-device` carried that guard; the
 * bootstrap imports it (for the OTel profile writer), so its `main()` ran
 * concurrently with onboarding, found the credentials onboarding had just
 * written, refused on a non-TTY stdin and called `process.exit(0)` killing
 * every `curl | sh` install mid-link with a success exit code (present since
 * 2026-08-17, d289f739; §1.4).
 *
 * The rule: only the bundle entry (`bootstrap.ts`) may test `require.main`
 * directly; every other CLI uses `isDirectCliEntry(module)`, which is false for
 * any module reached through the dispatcher.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';

const SRC = path.resolve(__dirname, '..');
const ALLOWED = new Set([path.join(SRC, 'scripts', 'bootstrap.ts'), path.join(SRC, 'scripts', 'cli-entry.ts')]);
const RAW_GUARD = /^\s*if\s*\(\s*require\.main\s*===\s*module\s*\)/m;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Files that self-execute with the raw guard (exported so the RED control below drives the same check). */
export function rawGuardOffenders(files: { file: string; text: string }[]): string[] {
  return files.filter(({ file, text }) => !ALLOWED.has(file) && RAW_GUARD.test(text)).map(({ file }) => file);
}

describe('bundle self-exec guard (A)', () => {
  const files = sourceFiles(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.file.endsWith(path.join('scripts', 'register-device.ts')))).toBe(true);
  });

  it('no module except the bundle entry tests require.main === module', () => {
    expect(rawGuardOffenders(files)).toEqual([]);
  });

  it('RED control: the pre-fix register-device guard is caught', () => {
    const regDev = files.find((f) => f.file.endsWith(path.join('scripts', 'register-device.ts')))!;
    const reverted = regDev.text.replace('if (isDirectCliEntry(module)) {', 'if (require.main === module) {');
    expect(reverted).not.toBe(regDev.text);
    expect(rawGuardOffenders([{ file: regDev.file, text: reverted }])).toEqual([regDev.file]);
  });

  it('the built bundle carries exactly one raw require.main check — the entry', async () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-guard-'));
    await build({
      entryPoints: [path.join(SRC, 'scripts', 'bootstrap.ts')],
      bundle: true, platform: 'node', target: 'node20', format: 'cjs',
      outfile: path.join(outdir, 'agent.js'), minify: true, legalComments: 'none',
      external: ['@solana/web3.js'], logLevel: 'silent',
    });
    const text = fs.readFileSync(path.join(outdir, 'agent.js'), 'utf8');
    // Exactly ONE literal `require.main===module` — the entry's own guard.
    // (isDirectCliEntry compares against its minified parameter, not `module`.)
    // The pre-fix served bundle (a943cb9b…) carried TWO: the entry and register-device's.
    const hits = text.match(/require\.main===module/g) ?? [];
    expect(hits.length).toBe(1);
    expect(text).toMatch(/__PROVIAN_CLI_DISPATCHED__/);
  }, 60_000);
});
