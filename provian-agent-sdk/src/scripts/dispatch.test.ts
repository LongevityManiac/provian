/**
 * agent-sdk dispatcher tests.
 *
 * The dispatcher exists because npx resolves `npx @provian/agent-sdk <cmd>`
 * through a bin named after the unscoped package name ("agent-sdk"); without
 * it, every documented npx invocation (docs, README help strings, and the
 * relay's device-invite / connect-agent email templates) fails with npm's
 * "could not determine executable to run". These tests pin:
 *   1. the pure resolution logic (command -> script path + args), and
 *   2. the REAL package.json contract: the `agent-sdk` bin exists, points at
 *      the dispatcher, and every emailed/documented command is dispatchable.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  DISPATCHER_BIN,
  buildUsage,
  dispatchableBins,
  loadManifest,
  resolveDispatch,
} from './dispatch';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

const FAKE_MANIFEST = {
  name: '@provian/agent-sdk',
  version: '9.9.9',
  bin: {
    'agent-sdk': 'dist/scripts/dispatch.js',
    'register-device': 'dist/scripts/register-device.js',
    'create-agent-wallet': 'dist/scripts/create-agent-wallet.js',
  },
};

describe('resolveDispatch (pure)', () => {
  it('maps a known command to its script with the remaining args forwarded', () => {
    const r = resolveDispatch(FAKE_MANIFEST, '/pkg', [
      'register-device',
      '--agent-token',
      'tok123',
    ]);
    expect(r).toEqual({
      kind: 'run',
      command: 'register-device',
      scriptPath: path.resolve('/pkg', 'dist/scripts/register-device.js'),
      args: ['--agent-token', 'tok123'],
    });
  });

  it('prints usage and exits 1 with no command', () => {
    const r = resolveDispatch(FAKE_MANIFEST, '/pkg', []);
    expect(r.kind).toBe('exit');
    if (r.kind === 'exit') {
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain('register-device');
      expect(r.message).toContain('create-agent-wallet');
    }
  });

  it('prints usage and exits 0 for help / --help / -h', () => {
    for (const h of ['help', '--help', '-h']) {
      const r = resolveDispatch(FAKE_MANIFEST, '/pkg', [h]);
      expect(r).toMatchObject({ kind: 'exit', exitCode: 0 });
    }
  });

  it('prints the package version for --version / -v', () => {
    for (const v of ['--version', '-v']) {
      const r = resolveDispatch(FAKE_MANIFEST, '/pkg', [v]);
      expect(r).toMatchObject({ kind: 'exit', exitCode: 0, message: '9.9.9' });
    }
  });

  it('rejects an unknown command with exit 1 and the usage list', () => {
    const r = resolveDispatch(FAKE_MANIFEST, '/pkg', ['does-not-exist', '--flag']);
    expect(r.kind).toBe('exit');
    if (r.kind === 'exit') {
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain('Unknown command: does-not-exist');
      expect(r.message).toContain('register-device');
    }
  });

  it('never dispatches to itself (agent-sdk is not a command)', () => {
    expect(dispatchableBins(FAKE_MANIFEST)).not.toHaveProperty(DISPATCHER_BIN);
    const r = resolveDispatch(FAKE_MANIFEST, '/pkg', ['agent-sdk']);
    expect(r).toMatchObject({ kind: 'exit', exitCode: 1 });
  });

  it('usage names the scoped package so the printed example is copy-pasteable', () => {
    expect(buildUsage(FAKE_MANIFEST)).toContain('npx @provian/agent-sdk register-device --help');
  });
});

describe('the real package.json contract (what npx will actually resolve)', () => {
  const manifest = loadManifest(PACKAGE_ROOT);

  it('declares the name-matching dispatcher bin npx requires for a multi-bin package', () => {
    // libnpmexec picks bin[name-without-scope]; for @provian/agent-sdk that is "agent-sdk".
    expect((manifest.name ?? '').replace(/^@[^/]+\//, '')).toBe(DISPATCHER_BIN);
    expect(manifest.bin?.[DISPATCHER_BIN]).toBe('dist/scripts/dispatch.js');
  });

  it('every command the docs and relay emails send is dispatchable', () => {
    const bins = dispatchableBins(manifest);
    // register-device rides in relay email templates (connect-agent was retired by)
    // (provian-backend server.ts email-command, agent-wallet device-invite);
    // the rest appear throughout QUICK_START / READMEs / help strings.
    for (const cmd of ['onboard', 'register-device', 'invite-device', 'create-agent-wallet', 'report-pe']) {
      expect(bins, `bin "${cmd}" missing — emailed/documented npx commands would break`).toHaveProperty(cmd);
    }
  });

  it('resolves a real command to a script path inside dist/', () => {
    const r = resolveDispatch(manifest, PACKAGE_ROOT, ['create-agent-wallet', '--help']);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') {
      expect(r.scriptPath).toBe(path.join(PACKAGE_ROOT, 'dist', 'scripts', 'create-agent-wallet.js'));
      expect(r.args).toEqual(['--help']);
    }
  });
});
