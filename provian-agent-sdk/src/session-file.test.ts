/**
 * Tests for the canonical ~/.provian/session.json module.
 *
 * This file is the shared contract between @provian/agent-sdk and @provian/cli:
 * one filename (session.json), one camelCase shape. These tests pin the shape
 * the CLI consumes, prove the SDK reads a CLI-written file, and prove the
 * one-time migration off the legacy ~/.provian/session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

// Pin os.homedir() to a per-test temp dir so each run gets a pristine
// ~/.provian tree without touching the real home. The module reads homedir()
// at evaluation, so resetModules() + dynamic import inside each test.
let tmpRoot: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpRoot };
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'provian-sdk-session-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import('./session-file.js');
}

const sample = {
  sessionId: 'sess_abc',
  relayUrl: 'https://relay.test',
  agentId: 'atlas',
  serverAgentId: 'agent_srv_123',
  userId: 'user_456',
  connectedAt: '2026-06-17T00:00:00.000Z',
  agentWalletId: 'wallet_aw_1',
};

function sessionJsonPath(): string {
  return join(tmpRoot, '.provian', 'session.json');
}

describe('session-file (SDK canonical ~/.provian/session.json)', () => {
  it('writes session.json with mode 0600 in a 0700 dir', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    const { writeSessionFile } = await loadModule();
    writeSessionFile(sample);
    expect(statSync(sessionJsonPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmpRoot, '.provian')).mode & 0o777).toBe(0o700);
  });

  it('round-trips write -> read', async () => {
    const { writeSessionFile, readSessionFile } = await loadModule();
    writeSessionFile(sample);
    expect(readSessionFile()).toEqual(sample);
  });

  it('persists exactly the camelCase keys the CLI SessionData expects', async () => {
    const { writeSessionFile } = await loadModule();
    writeSessionFile(sample);
    const onDisk = JSON.parse(readFileSync(sessionJsonPath(), 'utf-8'));
    expect(Object.keys(onDisk).sort()).toEqual(
      ['agentId', 'agentWalletId', 'connectedAt', 'relayUrl', 'serverAgentId', 'sessionId', 'userId'],
    );
  });

  it('reads a CLI-written session.json (camelCase, no wallet) verbatim', async () => {
    const { readSessionFile } = await loadModule();
    const cliShape = {
      sessionId: 'sess_cli', relayUrl: 'https://relay.test', agentId: 'cli-agent',
      serverAgentId: 'agent_cli', userId: 'user_cli', connectedAt: '2026-06-17T01:02:03.000Z',
    };
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    writeFileSync(sessionJsonPath(), JSON.stringify(cliShape), { mode: 0o600 });
    expect(readSessionFile()).toEqual(cliShape);
  });

  it('migrates the legacy ~/.provian/session (snake_case + epoch ms) forward, then removes it', async () => {
    const { readSessionFile } = await loadModule();
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const legacyPath = join(tmpRoot, '.provian', 'session');
    writeFileSync(legacyPath, JSON.stringify({
      session_id: 'sess_legacy',
      agent_id: 'agent_legacy',
      user_id: 'user_legacy',
      agent_wallet_id: 'wallet_aw_legacy',
      relay_url: 'https://relay.legacy',
      connected_at: 1750000000000,
    }), { mode: 0o600 });

    const migrated = readSessionFile();
    expect(migrated).toEqual({
      sessionId: 'sess_legacy',
      relayUrl: 'https://relay.legacy',
      agentId: 'agent_legacy',
      serverAgentId: 'agent_legacy',
      userId: 'user_legacy',
      connectedAt: new Date(1750000000000).toISOString(),
      agentWalletId: 'wallet_aw_legacy',
    });
    // Forward-written to the canonical file; legacy removed (one-time).
    expect(existsSync(sessionJsonPath())).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('keeps the legacy file when the forward write fails, rather than orphaning the session', async () => {
    if (platform() === 'win32') { expect(true).toBe(true); return; }
    const { readSessionFile } = await loadModule();
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true, mode: 0o700 });
    const legacy = join(tmpRoot, '.provian', 'session');
    writeFileSync(legacy, JSON.stringify({
      session_id: 'sess_legacy', agent_id: 'agent_legacy', relay_url: 'https://relay.legacy', connected_at: 1750000000000,
    }), { mode: 0o600 });
    // Too-permissive dir makes writeSessionFile()'s ensureProvianDir refuse.
    chmodSync(join(tmpRoot, '.provian'), 0o777);

    const migrated = readSessionFile();
    expect(migrated?.sessionId).toBe('sess_legacy');           // in-memory value still returned
    expect(existsSync(legacy)).toBe(true);                     // legacy preserved (not orphaned)
    expect(existsSync(sessionJsonPath())).toBe(false);         // forward write failed, nothing written
  });

  it('deleteSessionFile removes both the canonical and legacy files', async () => {
    const { writeSessionFile, deleteSessionFile } = await loadModule();
    writeSessionFile(sample);
    mkdirSync(join(tmpRoot, '.provian'), { recursive: true });
    writeFileSync(join(tmpRoot, '.provian', 'session'), '{}', { mode: 0o600 });
    deleteSessionFile();
    expect(existsSync(sessionJsonPath())).toBe(false);
    expect(existsSync(join(tmpRoot, '.provian', 'session'))).toBe(false);
  });
});
