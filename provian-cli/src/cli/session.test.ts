/**
 * Regression tests for session file mode hardening.
 *
 * Pre-fix the session file was created without an explicit mode and
 * defaulted to umask, typically 0644 (world-readable). The session file
 * holds a live relay session token; world-readable storage lets any local
 * user impersonate the agent against the relay.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, mkdirSync, chmodSync, writeFileSync, existsSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

// We pin os.homedir() to a per-test temp directory so each run gets a
// pristine .provian/ tree without touching the real user home. The mock
// must be installed before the session module is first imported because it
// reads homedir() at module evaluation, so we resetModules() between tests.
let tmpRoot: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => tmpRoot,
  };
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'provian-session-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadSession() {
  vi.resetModules();
  return await import('./session');
}

const sample = {
  sessionId: 'sess_test_abc',
  relayUrl: 'https://relay.test',
  agentId: 'provian-agent',
  serverAgentId: 'agent_test_123',
  userId: 'user_test_456',
  connectedAt: '2026-05-05T00:00:00.000Z',
};

describe('session file mode', () => {
  it('writes the session file with mode 0600 on POSIX', async () => {
    if (platform() === 'win32') {
      // POSIX permission bits do not apply on Windows; skip the assertion.
      expect(true).toBe(true);
      return;
    }
    const { writeSession } = await loadSession();
    writeSession(sample);
    const sessionPath = join(tmpRoot, '.provian', 'session.json');
    const mode = statSync(sessionPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the .provian directory with mode 0700 on POSIX', async () => {
    if (platform() === 'win32') {
      expect(true).toBe(true);
      return;
    }
    const { writeSession } = await loadSession();
    writeSession(sample);
    const dirPath = join(tmpRoot, '.provian');
    const mode = statSync(dirPath).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('refuses to write when the .provian directory is more permissive than 0755', async () => {
    if (platform() === 'win32') {
      expect(true).toBe(true);
      return;
    }
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true });
    chmodSync(join(tmpRoot, '.provian'), 0o777);
    const { writeSession } = await loadSession();
    expect(() => writeSession(sample)).toThrow(/more permissive than/);
  });

  it('tightens an existing world-readable session file on overwrite', async () => {
    if (platform() === 'win32') {
      expect(true).toBe(true);
      return;
    }
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const sessionPath = join(tmpRoot, '.provian', 'session.json');
    writeFileSync(sessionPath, '{"stale": true}', { mode: 0o644 });
    chmodSync(sessionPath, 0o644);

    const { writeSession } = await loadSession();
    writeSession(sample);
    const mode = statSync(sessionPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('session file migration (legacy ~/.provian/session)', () => {
  it('migrates a legacy snake_case session forward and removes the legacy file', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const legacy = join(tmpRoot, '.provian', 'session');
    writeFileSync(legacy, JSON.stringify({
      session_id: 'sess_legacy',
      agent_id: 'agent_legacy',
      user_id: 'user_legacy',
      agent_wallet_id: 'wallet_aw_legacy',
      relay_url: 'https://relay.legacy',
      connected_at: 1750000000000,
    }), { mode: 0o600 });

    const { readSession } = await loadSession();
    expect(readSession()).toEqual({
      sessionId: 'sess_legacy',
      relayUrl: 'https://relay.legacy',
      agentId: 'agent_legacy',
      serverAgentId: 'agent_legacy',
      userId: 'user_legacy',
      connectedAt: new Date(1750000000000).toISOString(),
      agentWalletId: 'wallet_aw_legacy',
    });
    // One-time: forward-written to session.json, legacy removed.
    expect(existsSync(join(tmpRoot, '.provian', 'session.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('keeps the legacy file when the forward write fails, rather than orphaning the session', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const legacy = join(tmpRoot, '.provian', 'session');
    writeFileSync(legacy, JSON.stringify({
      session_id: 'sess_legacy', agent_id: 'agent_legacy', relay_url: 'https://relay.legacy', connected_at: 1750000000000,
    }), { mode: 0o600 });
    // Make ~/.provian too permissive so writeSession()'s ensureSessionDir refuses.
    chmodSync(join(tmpRoot, '.provian'), 0o777);

    const { readSession } = await loadSession();
    const migrated = readSession();
    expect(migrated?.sessionId).toBe('sess_legacy');                           // in-memory value still returned
    expect(existsSync(legacy)).toBe(true);                                     // legacy preserved (not orphaned)
    expect(existsSync(join(tmpRoot, '.provian', 'session.json'))).toBe(false); // forward write failed, nothing written
  });

  it('reads an SDK-shape session.json (camelCase + agentWalletId) directly', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const sdkShape = {
      sessionId: 'sess_sdk', relayUrl: 'https://relay.test', agentId: 'atlas',
      serverAgentId: 'agent_srv', userId: 'user_1', connectedAt: '2026-06-17T00:00:00.000Z',
      agentWalletId: 'wallet_aw_2',
    };
    writeFileSync(join(tmpRoot, '.provian', 'session.json'), JSON.stringify(sdkShape), { mode: 0o600 });
    const { readSession } = await loadSession();
    expect(readSession()).toEqual(sdkShape);
  });

  it('deleteSession removes a lingering legacy file too', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    const { writeSession, deleteSession } = await loadSession();
    writeSession(sample);
    writeFileSync(join(tmpRoot, '.provian', 'session'), '{}', { mode: 0o600 });
    deleteSession();
    expect(existsSync(join(tmpRoot, '.provian', 'session.json'))).toBe(false);
    expect(existsSync(join(tmpRoot, '.provian', 'session'))).toBe(false);
  });
});

// Cross-tool interop (@provian/agent-sdk <-> @provian/cli) is proven by the
// shared session.json contract, exercised from BOTH sides:
//   - CLI reads an SDK-written shape: the "reads an SDK-shape session.json
//     directly" test above (SDK output -> CLI reader).
//   - SDK reads a CLI-written shape: "reads a CLI-written session.json verbatim"
//     in provian-agent-sdk/src/session-file.test.ts (CLI output -> SDK reader),
//     alongside a test pinning the exact camelCase key set both tools use.
// A live cross-import here is deliberately avoided: vitest's os mock does not
// reach the prebuilt SDK dist, so calling the SDK writer from this suite would
// resolve the real home and write to the developer's actual ~/.provian.
