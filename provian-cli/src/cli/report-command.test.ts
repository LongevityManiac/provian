/**
 * `provian report` REMOVED.
 *
 * "An agent declaring its own work has no path to a PE, minting or
 * record-only." `provian report --type <x> --success` was exactly that: the
 * agent's own description of its work, submitted as a PE under its device
 * credentials. The command is gone; invoking it is an error that names the
 * ruling, reads no credentials, and makes no network call. Work on a
 * registered machine is recorded by the observer daemon, which observes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadCredentialsMock = vi.fn();
vi.mock('@provian/agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@provian/agent-sdk')>();
  return { ...actual, loadCredentials: (...args: unknown[]) => loadCredentialsMock(...args) };
});
vi.mock('./session', () => ({ readSession: vi.fn(() => null) }));

import { run } from './commands';

const CREDS = {
  deviceKey: 'pdk_' + 'a'.repeat(32),
  deviceSecret: 'pds_' + 'b'.repeat(64),
  relayUrl: 'https://relay.test',
  deviceId: 'dev_' + 'c'.repeat(64),
};

describe('provian report (removed)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    loadCredentialsMock.mockReturnValue(CREDS);
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ pe_id: 'pe_should_not_exist' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuses with an error that says why (no decision ID) and makes no network call', async () => {
    const result = await run(['node', 'provian', 'report', '--type', 'deployment', '--success', '--description', 'Deployed v2.1']);
    expect(result?.status).toBe('error');
    expect(String(result?.error)).toContain('was removed');
    expect(String(result?.error)).not.toMatch(/\bD-\d{2,3}\b/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loadCredentialsMock).not.toHaveBeenCalled();
  });

  it('refuses the failure form too — no variant of the command submits', async () => {
    const result = await run(['node', 'provian', 'report', '--type', 'purchase', '--failure', '--error', 'x']);
    expect(result?.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the general help no longer lists a report command', async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    await run(['node', 'provian', '--help']);
    logSpy.mockRestore();
    const help = lines.join('\n');
    expect(help).toContain('Provenance commands:');
    expect(help).not.toMatch(/^\s+report\s/m);
    expect(help).not.toContain('provian report');
  });
});
