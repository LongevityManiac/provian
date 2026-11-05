/**
 * the hosted install downloads ONE file (dist-bundle/agent.js, staged byte-identical
 * at provian-backend/bootstrap-bundle/agent.js) onto a box that has no repository and no
 * deployments/ directory. A module that reads a deployment artifact at import time crashes
 * every install there — the v33 bundle did (evm-bond resolved the BondPool address eagerly).
 * This runs the committed bundle from an empty directory with an empty HOME.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bootstrap bundle runs stand-alone (no repo, no deployments/)', () => {
  it('`agent.js help` exits 0 and lists the act verbs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provian-bundle-'));
    const bundle = join(dir, 'agent.js');
    copyFileSync(resolve(__dirname, '..', 'dist-bundle', 'agent.js'), bundle);
    const out = execFileSync(process.execPath, [bundle, 'help'], {
      cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir }, encoding: 'utf8', timeout: 60_000,
    });
    expect(out).toMatch(/act through Provian from your shell/);
    expect(out).toMatch(/bond-post/);
  });
});
