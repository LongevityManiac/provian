import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRecourseBinding, recordBindingAttempt, relayReportsBound, BINDING_REPORT_GRACE_MS, RECOURSE_BINDING_STATE_FILE } from './recourse-binding-heal';
import { startRecourseBindingHeal, RECOURSE_BINDING_LOCKED_INTERVAL_MS } from './observer/run-daemon';
import type { AgentKeystore } from './keystore';

const address = `0x${'ab'.repeat(20)}`;
const config = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_1', apiKey: 'k', apiSecret: 's' };
const keystore = { wallet_id: 'wallet_aw_1', address } as unknown as AgentKeystore;
let dir = '';
let keystorePath = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-heal-')); keystorePath = path.join(dir, 'agent-keystore.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const unbound = { addresses: [{ address, chainBindingStatus: 'pending' }] };
const bound = { addresses: [{ address, chainBindingStatus: 'confirmed' }] };

describe('the agent re-signs its Recourse binding on its own', () => {
  it('reports bound only for this exact address confirmed on chain', () => {
    expect(relayReportsBound(bound, address)).toBe(true);
    expect(relayReportsBound(unbound, address)).toBe(false);
    expect(relayReportsBound({ addresses: [{ address: `0x${'cd'.repeat(20)}`, chainBindingStatus: 'confirmed' }] }, address)).toBe(false);
    expect(relayReportsBound(null, address)).toBe(false);
  });
  it('a bound address does nothing', async () => {
    const bind = vi.fn();
    expect(await ensureRecourseBinding(config, { keystorePath, loadKeystore: () => keystore, readOwnership: async () => bound, bind })).toBe('bound');
    expect(bind).not.toHaveBeenCalled();
  });
  it('waits while the last signature is live or just expired, then signs again without waiting', async () => {
    let now = 1_000_000;
    const bind = vi.fn(async (_c: unknown, _i: unknown, options?: { wait?: boolean; onSigned?: (b: { expiresAtMs: number }) => void }) => {
      options?.onSigned?.({ expiresAtMs: now + 300_000 }); return {};
    });
    const deps = { keystorePath, now: () => now, loadKeystore: () => keystore, readSecret: () => 'secret', readOwnership: async () => unbound,
      bind: bind as never };
    recordBindingAttempt(keystorePath, address, () => now)({ expiresAtMs: now + 300_000 });
    expect(await ensureRecourseBinding(config, deps)).toBe('pending');
    now += 300_000 + BINDING_REPORT_GRACE_MS - 1;
    expect(await ensureRecourseBinding(config, deps)).toBe('pending');
    expect(bind).not.toHaveBeenCalled();
    now += 1;
    expect(await ensureRecourseBinding(config, deps)).toBe('signed');
    expect(bind).toHaveBeenCalledOnce();
    expect(bind.mock.calls[0][2]).toMatchObject({ wait: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, RECOURSE_BINDING_STATE_FILE), 'utf8'))).toEqual({ address, expiresAtMs: now + 300_000, signedAtMs: now });
    // The fresh signature is now the live one.
    expect(await ensureRecourseBinding(config, deps)).toBe('pending');
    expect(bind).toHaveBeenCalledOnce();
  });
  it('never signs with no keystore or another wallet, and reports relay or signing failure for retry', async () => {
    const bind = vi.fn(async () => { throw new Error('recourse_request_refused:503'); });
    expect(await ensureRecourseBinding(config, { keystorePath, loadKeystore: () => null, bind: bind as never })).toBe('no_keystore');
    expect(await ensureRecourseBinding(config, { keystorePath, loadKeystore: () => ({ ...keystore, wallet_id: 'other' }), bind: bind as never })).toBe('no_keystore');
    expect(await ensureRecourseBinding(config, { keystorePath, loadKeystore: () => keystore, readOwnership: async () => { throw new Error('down'); }, bind: bind as never })).toBe('failed');
    expect(bind).not.toHaveBeenCalled();
    expect(await ensureRecourseBinding(config, { keystorePath, loadKeystore: () => keystore, readSecret: () => 'secret', readOwnership: async () => unbound, bind: bind as never })).toBe('failed');
  });
  it('a key that cannot be unlocked is reported, never treated as having no wallet', async () => {
    const bind = vi.fn();
    expect(await ensureRecourseBinding(config, { keystorePath, statePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heal-')), 'b.json'),
      loadKeystore: () => keystore, readSecret: () => null, readOwnership: async () => unbound, bind: bind as never })).toBe('no_passphrase');
    expect(bind).not.toHaveBeenCalled();
  });
  it('the daemon loop says so when the key cannot be unlocked and keeps checking', async () => {
    const outcomes = ['no_passphrase', 'no_passphrase', 'bound'] as const;
    const heal = vi.fn(async () => outcomes[heal.mock.calls.length - 1]);
    const log = vi.fn();
    vi.useFakeTimers();
    try {
      const loop = startRecourseBindingHeal(config, { heal, intervalMs: 1, log });
      await vi.advanceTimersByTimeAsync(RECOURSE_BINDING_LOCKED_INTERVAL_MS * 2 + 10);
      await loop.done;
    } finally { vi.useRealTimers(); }
    expect(heal).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0][0]).toMatch(/cannot be unlocked.*PROVIAN_KEYSTORE_PASSPHRASE/);
    expect(log).toHaveBeenCalledTimes(2);
  });
  it('the daemon loop keeps checking until bound, then stops', async () => {
    const outcomes = ['failed', 'signed', 'pending', 'bound', 'signed'] as const;
    const heal = vi.fn(async () => outcomes[heal.mock.calls.length - 1]);
    const log = vi.fn();
    const loop = startRecourseBindingHeal(config, { heal, intervalMs: 1, log });
    await loop.done;
    expect(heal).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.map(c => c[0])).toEqual(['[observer] Recourse binding check failed; retrying',
      '[observer] Recourse binding signed; the relay is sending it', '[observer] Recourse binding confirmed on Base']);
  });
});
