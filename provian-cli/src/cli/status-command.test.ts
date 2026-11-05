/**
 * `provian status` a LOCAL read of this machine's Provian identity.
 *
 * The wallet no longer governs agents and the relay session is gone: status
 * reports whether device credentials exist (+ device id, relay URL) and the
 * agent wallet id recorded in the identity locator. It never calls the relay
 * and never surfaces a governance field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadCredentialsMock = vi.fn();
const readSessionMock = vi.fn();
vi.mock('@provian/agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@provian/agent-sdk')>();
  return { ...actual, loadCredentials: (...args: unknown[]) => loadCredentialsMock(...args) };
});
vi.mock('./session', () => ({ readSession: (...args: unknown[]) => readSessionMock(...args) }));

import { run } from './commands';

const CREDS = { deviceKey: 'pdk_' + 'a'.repeat(32), deviceSecret: 'pds_' + 'b'.repeat(64), relayUrl: 'https://relay.test', deviceId: 'dev_1' };

describe('provian status - local identity only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadCredentialsMock.mockReturnValue(CREDS);
    readSessionMock.mockReturnValue({ relayUrl: 'https://relay.test', agentId: 'a', serverAgentId: 'a', userId: '', connectedAt: 'x', agentWalletId: 'wallet_aw_1' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports the device registration + agent wallet id without a relay round-trip', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await run(['node', 'provian', 'status']) as Record<string, unknown>;
    expect(result).toEqual({ connected: true, relayUrl: 'https://relay.test', deviceId: 'dev_1', agentWalletId: 'wallet_aw_1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never surfaces a governance or session field', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await run(['node', 'provian', 'status']) as Record<string, unknown>;
    for (const k of ['killSwitchActive', 'dailyBudgetRemaining', 'sessionId', 'connectedAt']) {
      expect(k in result).toBe(false);
    }
  });

  it('reports connected:false when there are no device credentials', async () => {
    loadCredentialsMock.mockReturnValue(null);
    readSessionMock.mockReturnValue(null);
    expect(await run(['node', 'provian', 'status'])).toEqual({ connected: false });
  });
});

describe('retired verbs', () => {
  it('connect --token, init, disconnect and check are unknown commands', async () => {
    for (const argv of [['connect', '--token', 'PROV-X'], ['init'], ['disconnect'], ['check']]) {
      const result = await run(['node', 'provian', ...argv]) as Record<string, unknown>;
      expect(result.status).toBe('error');
      expect(String(result.error)).toMatch(/Unknown command|Missing/);
    }
  });
});
