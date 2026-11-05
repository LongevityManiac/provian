import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveCodingSessionOrigins } from './report-pe';

describe('deriveCodingSessionOrigins never hands the commit sha to a shell (2026-10-17 bug check)', () => {
  it('a sha carrying shell metacharacters derives nothing and runs nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pe-exec-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    const sentinel = path.join(dir, 'injected');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      // RED control: the former execSync interpolation ran `… log -1 --pretty=%s HEAD; touch '<sentinel>'`.
      const origins = deriveCodingSessionOrigins(`HEAD; touch '${sentinel}'`, { deviceKey: 'k', deviceSecret: 's', relayUrl: 'http://x' });
      expect(origins).toEqual([]);
      expect(fs.existsSync(sentinel)).toBe(false);
      // A real object name still derives the parent commit as a resolvable origin.
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'second');
      const head = git('rev-parse', 'HEAD');
      const parent = git('rev-parse', 'HEAD^');
      const real = deriveCodingSessionOrigins(head, { deviceKey: 'k', deviceSecret: 's', relayUrl: 'http://x' });
      expect(real.map((o) => o.origin_identifier)).toContain(`commit:${parent}`);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
