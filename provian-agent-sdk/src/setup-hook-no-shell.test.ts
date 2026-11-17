/**
 * setup-hook hands git configuration values to git as arguments, never to a shell. The real
 * script is built and run against a throwaway HOME whose previous core.hooksPath is a shell
 * payload: the payload must come back as the literal configuration value and must not run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { isUsableGitConfigPath, realGit } from './hook-install';

const pkg = path.resolve(__dirname, '..');
let work: string;
let script: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-setup-hook-'));
  script = path.join(work, 'dist', 'scripts', 'setup-hook.js');
  buildSync({ entryPoints: [path.join(pkg, 'src/scripts/setup-hook.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  fs.mkdirSync(path.join(work, 'hooks'));
  fs.copyFileSync(path.join(pkg, 'hooks/post-commit.template'), path.join(work, 'hooks/post-commit.template'));
});
afterAll(() => { fs.rmSync(work, { recursive: true, force: true }); });

function machine(name: string) {
  const home = path.join(work, name);
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: path.join(home, '.config') };
  delete (env as Record<string, string | undefined>).GIT_CONFIG_GLOBAL;
  const git = (...args: string[]): string => execFileSync('git', args, { env, cwd: home, encoding: 'utf8' }).trim();
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env, cwd: home, encoding: 'utf8' });
  return { home, git, run };
}

describe('setup-hook never passes a git configuration value through a shell', () => {
  it('the script source starts no shell', () => {
    const source = fs.readFileSync(path.join(pkg, 'src/scripts/setup-hook.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toMatch(/\bexecSync\b|\bexec\(|shell:\s*true/);
    const shared = fs.readFileSync(path.join(pkg, 'src/hook-install.ts'), 'utf8');
    expect(shared).toMatch(/execFileSync\('git', \['config'/);
    expect(shared).not.toMatch(/\bexecSync\b|\bexec\(|shell:\s*true/);
  });

  for (const [label, payload] of [
    ['command substitution', (marker: string) => `/tmp/hooks$(touch ${marker})`],
    ['a closing quote and a second command', (marker: string) => `/tmp/hooks"; touch ${marker}; echo "`],
    ['backticks', (marker: string) => `/tmp/hooks\`touch ${marker}\``],
  ] as Array<[string, (marker: string) => string]>) {
    it(`restores a previous core.hooksPath containing ${label} verbatim, and nothing in it runs`, () => {
      const m = machine(label.replace(/\W+/g, '-'));
      const marker = path.join(m.home, 'INJECTED');
      const hostile = payload(marker);
      m.git('config', '--global', 'core.hooksPath', hostile);

      const install = m.run('--global', '--yes');
      expect(install.status, install.stderr).toBe(0);
      expect(m.git('config', '--global', 'core.hooksPath')).toBe(path.join(m.home, '.provian', 'hooks'));
      expect(fs.readFileSync(path.join(m.home, '.provian', '.prev-hooks-path'), 'utf8')).toBe(hostile);

      const remove = m.run('--remove', '--global');
      expect(remove.status, remove.stderr).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(m.git('config', '--global', 'core.hooksPath')).toBe(hostile);
    });
  }

  it('a saved previous path that is not a usable path is not restored', () => {
    const m = machine('unusable');
    expect(m.run('--global', '--yes').status).toBe(0);
    fs.writeFileSync(path.join(m.home, '.provian', '.prev-hooks-path'), '--file=/tmp/elsewhere');
    const remove = m.run('--remove', '--global');
    expect(remove.status, remove.stderr).toBe(0);
    expect(remove.stdout).toMatch(/not a usable path/);
    expect(() => m.git('config', '--global', 'core.hooksPath')).toThrow();
    expect(fs.existsSync('/tmp/elsewhere')).toBe(false);
  });

  it('only a path-shaped value is accepted as a configuration value', () => {
    for (const ok of ['/home/u/.provian/hooks', '.githooks', 'C:\\Users\\u\\hooks', '/tmp/odd $(name) "dir"']) expect(isUsableGitConfigPath(ok), ok).toBe(true);
    for (const bad of ['', '-x', '--global', 'a\nb', 'a\0b', 'a\rb', 'x'.repeat(4097), null, undefined, 7]) expect(isUsableGitConfigPath(bad), String(bad)).toBe(false);
    expect(() => realGit.set('global', 'core.hooksPath', '--unset-all')).toThrow(/not a usable path/);
    expect(() => realGit.set('global', 'core.hooksPath', 'a\nb')).toThrow(/not a usable path/);
  });
});
