/**
 * §3 item 5 — the curl line is canonical and its quirks are bugs. On
 * the hosted path no string names an npx or npm command (npm is unpublished; `npx @provian/agent-sdk
 * …` E404s there), and every command the hosted path names is one its own dispatcher runs.
 *
 * Reads the COMMITTED bundle (dist-bundle/agent.js, staged byte-identical at
 * provian-backend/bootstrap-bundle/agent.js) — the exact bytes a hosted box downloads.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_VERBS, MAINTENANCE_HELP } from './scripts/bootstrap';
import { ACT_VERBS } from './act-verbs';
import { cliCommand, cliPrefix, HOSTED_BUNDLE, HOSTED_CLI_PREFIX, sdkUpgradeHint } from './cli-command';

const BUNDLE = resolve(__dirname, '..', 'dist-bundle', 'agent.js');

/** The npm command shapes the hosted path must never name. */
const NPM_COMMAND = /npx |npm install|npm i |npm run|npm exec/g;

export function npmCommandHits(text: string): string[] {
  return [...text.matchAll(NPM_COMMAND)].map((m) => text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 50));
}

/** Every verb the hosted bundle dispatches: its own verbs, the act verbs, and help. */
const HOSTED_VERBS: ReadonlySet<string> = new Set<string>([
  ...BOOTSTRAP_VERBS, ...ACT_VERBS.map((v) => v.name), 'help',
]);

/** The first token of every `cliCommand('<verb> …')` call in the SDK source (the one renderer). */
function renderedVerbsInSource(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('cli-command.ts')) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(/cliCommand\('([a-z0-9-]+)/g)) {
        out.set(m[1], [...(out.get(m[1]) ?? []), p]);
      }
    }
  };
  walk(resolve(__dirname));
  return out;
}

/**
 * A verb the hosted dispatcher does not run may appear in source only on an npm-side branch, which
 * the bundle build folds away — so the rendered call must be ABSENT from the bundle bytes.
 */
export function unrunnableHostedCommands(bundle: string, verbs: Iterable<string>): string[] {
  const bad: string[] = [];
  for (const v of verbs) {
    if (HOSTED_VERBS.has(v)) continue;
    if (bundle.includes(`("${v}")`) || bundle.includes(`("${v} `)) bad.push(v);
  }
  return bad;
}

describe('the hosted bundle names no npx / npm command', () => {
  const bundle = readFileSync(BUNDLE, 'utf8');

  it('scans the whole committed bundle and finds zero npx / npm command strings', () => {
    // Non-vacuous: the population is the full bundle, printed.
    expect(bundle.length).toBeGreaterThan(500_000);
    console.log(`[] bundle-no-npm: scanned ${bundle.length} bytes of dist-bundle/agent.js`);
    expect(npmCommandHits(bundle)).toEqual([]);
  });

  it('RED control: the scan lists the exact strings the pre- bundle carried', () => {
    // Verbatim shapes from the master bundle before this change (33 hits there).
    const legacyDaemonBundle = [
      'hint:"A harness is installed here but the watcher found nothing it can read. If the harness changed where it keeps sessions, point the watcher at it with `npx @provian/agent-sdk configure --watch-transcripts <dir>`."',
      'x4="npx @provian/agent-sdk help"',
      '$G="npm i @provian/agent-sdk@latest"',
      'console.log("    npx @provian/agent-sdk doctor")',
    ].join(';');
    expect(npmCommandHits(legacyDaemonBundle)).toHaveLength(4);
  });

  it('every command the hosted path renders is a verb the bundle dispatches (npm-only verbs are folded out)', () => {
    const rendered = renderedVerbsInSource();
    expect(rendered.size).toBeGreaterThan(5);
    console.log(`[] rendered CLI verbs in source: ${[...rendered.keys()].sort().join(', ')}`);
    expect(unrunnableHostedCommands(bundle, rendered.keys())).toEqual([]);
  });

  it('RED control: a hosted-rendered call of a verb the bundle does not run is flagged', () => {
    expect(unrunnableHostedCommands('let a=se("start"),b=se("run -- <cmd>"),c=se("doctor");', ['start', 'run', 'doctor']))
      .toEqual(['start', 'run']);
  });

  it('the maintenance help names only dispatcher verbs', () => {
    for (const m of MAINTENANCE_HELP) expect(BOOTSTRAP_VERBS as readonly string[]).toContain(m.verb);
  });
});

describe('cli-command renders for the runtime it is in', () => {
  it('the npm package (tests run unbundled) renders npx; the hosted rendering is the wrapper', () => {
    expect(HOSTED_BUNDLE).toBe(false);
    expect(cliCommand('doctor')).toBe('npx @provian/agent-sdk doctor');
    expect(cliCommand('doctor', true)).toBe('"$HOME/.provian/bin/provian" doctor');
    expect(cliPrefix(true)).toBe(HOSTED_CLI_PREFIX);
    expect(sdkUpgradeHint(true)).not.toMatch(NPM_COMMAND);
    expect(sdkUpgradeHint(false)).toBe('npm i @provian/agent-sdk@latest');
  });
});

describe('the hosted bundle runs doctor as an installed command (never an invite code)', () => {
  const run = (args: string[]): { status: number | null; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'provian-bundle-doctor-'));
    const bundle = join(dir, 'agent.js');
    copyFileSync(BUNDLE, bundle);
    const r = spawnSync(process.execPath, [bundle, ...args], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir }, encoding: 'utf8', timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };

  it('`agent.js doctor --help` prints the doctor usage with the installed command', () => {
    const r = run(['doctor', '--help']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Usage: "$HOME/.provian/bin/provian" doctor [--json]');
    expect(r.out).not.toMatch(/invite code/i);
  });

  it('`agent.js doctor --json` on an unregistered box answers with a hosted next step, no npx', () => {
    const r = run(['doctor', '--json']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('"status": "red"');
    expect(r.out).toContain('paste the install line again');
    expect(r.out).not.toMatch(/invite code\. Generate/i);
    expect(npmCommandHits(r.out)).toEqual([]);
  });

  it('an unknown command is refused as such, never read as an invite code', () => {
    const r = run(['not-a-verb']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('Unknown command: not-a-verb');
    expect(r.out).not.toMatch(/reading your invite code/);
  });

  it('`agent.js help` lists the act verbs and the maintenance commands', () => {
    const out = execFileSync(process.execPath, [BUNDLE, 'help'], { env: { PATH: process.env.PATH ?? '', HOME: tmpdir() }, encoding: 'utf8' });
    expect(out).toMatch(/Maintenance:/);
    expect(out).toMatch(/doctor \[--json\]/);
    expect(npmCommandHits(out)).toEqual([]);
  });
});
