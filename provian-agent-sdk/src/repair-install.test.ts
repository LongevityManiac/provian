/**
 * repair-install — the restore verb, and its negative controls.
 *
 * The property under test is narrow and load-bearing: a repair must VERIFY what
 * it wrote, and must report failure when the paths it baked still do not
 * resolve. A repair that reports success without re-reading is the same mistake
 * as the install that caused the outage.
 */

import { describe, it, expect } from 'vitest';
import {
  readBakedPaths,
  renderRepairOutcome,
  installedArtifactPaths,
  type RepairOutcome,
} from './repair-install';

const PLIST = `<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/Users/a/.provian/agent.js</string>
  <string>observe</string>
</array>`;

const HOOK = 'node "/Users/a/.provian/agent.js" report-pe --type coding_session';

describe('readBakedPaths', () => {
  it('collects every script path the installed artifacts name, de-duplicated', () => {
    const paths = readBakedPaths(
      ['/x/plist', '/x/hook'],
      (p) => (p === '/x/plist' ? PLIST : HOOK),
    );
    expect(paths).toEqual(['/Users/a/.provian/agent.js']);
  });

  it('NEGATIVE CONTROL — an artifact that does not exist contributes nothing, and does not throw', () => {
    expect(readBakedPaths(['/nope'], () => null)).toEqual([]);
  });

  it('names the three artifacts that decide whether a machine can capture', () => {
    const a = installedArtifactPaths('/home/x');
    expect(a).toHaveLength(3);
    expect(a.some((p) => p.endsWith('ai.provian.observer.plist'))).toBe(true);
    expect(a.some((p) => p.endsWith('provian-observer.service'))).toBe(true);
    expect(a.some((p) => p.endsWith('hooks/post-commit'))).toBe(true);
  });
});

describe('renderRepairOutcome', () => {
  const base: RepairOutcome = {
    runtimeKind: 'bundle',
    runtimeRoot: '/Users/a/.provian/agent.js',
    serviceMethod: 'launchd',
    hookPath: '/Users/a/.provian/hooks/post-commit',
    hookAction: 'updated',
    stillBroken: [],
    otelExporter: 'already_enabled',
    grokHooks: 'absent',
    notes: [],
  };

  it('a clean repair exits 0 and says both hooks can fire', () => {
    const v = renderRepairOutcome(base);
    expect(v.exitCode).toBe(0);
    expect(v.lines.join('\n')).toMatch(/Every baked path resolves/);
  });

  it('THE CONTROL — a repair that left a dangling path exits 1 and names it', () => {
    const v = renderRepairOutcome({ ...base, stillBroken: ['/gone/start-observer.js'] });
    expect(v.exitCode).toBe(1);
    expect(v.lines.join('\n')).toMatch(/STILL BROKEN/);
    expect(v.lines.join('\n')).toContain('/gone/start-observer.js');
  });

  it('a repair that could not install the hook says so rather than implying success', () => {
    const v = renderRepairOutcome({ ...base, hookPath: null, hookAction: null, notes: ['git hook not installed: EACCES'] });
    expect(v.lines.join('\n')).toMatch(/git commit hook: not installed/);
    expect(v.lines.join('\n')).toMatch(/EACCES/);
  });
});
