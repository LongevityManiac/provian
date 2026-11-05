/**
 * the daemon's at-rest-secret health check.
 *
 * The property: a keystore that is PRESENT but whose at-rest secret is GONE (or
 * does not decrypt it) is `ok: false` the daemon refuses to earn and alarms.
 * Every failing assertion ships with its RED control (the same setup with the
 * decisive input flipped must flip the verdict).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkAtRestSecretHealth,
  describeAtRestSecretFailure,
  reportRecoveryAlarm,
  reportRecoveryHealthy,
} from './at-rest-secret-health';
import type { AgentKeystore } from './keystore';

const fakeKeystore = {} as AgentKeystore;

describe('checkAtRestSecretHealth', () => {
  it('is OK when the keystore decrypts under the present secret; RED: a missing secret is NOT ok', () => {
    const ok = checkAtRestSecretHealth({
      loadKeystore: () => fakeKeystore,
      readSecret: () => 'a'.repeat(64),
      tryDecrypt: () => { /* decrypts fine */ },
    });
    expect(ok).toEqual({ ok: true });

    // RED control: same keystore, secret GONE → the exact Atlas failure.
    const missing = checkAtRestSecretHealth({
      loadKeystore: () => fakeKeystore,
      readSecret: () => null,
      tryDecrypt: () => { /* unreached */ },
    });
    expect(missing).toEqual({ ok: false, reason: 'at_rest_secret_missing' });
  });

  it('is NOT ok when the secret is present but does not decrypt the keystore; RED: a decrypting secret IS ok', () => {
    const nondecrypting = checkAtRestSecretHealth({
      loadKeystore: () => fakeKeystore,
      readSecret: () => 'b'.repeat(64),
      tryDecrypt: () => { throw new Error('bad tag'); },
    });
    expect(nondecrypting).toEqual({ ok: false, reason: 'at_rest_secret_nondecrypting' });

    // RED control: same secret, but it DOES decrypt → ok.
    const good = checkAtRestSecretHealth({
      loadKeystore: () => fakeKeystore,
      readSecret: () => 'b'.repeat(64),
      tryDecrypt: () => { /* ok */ },
    });
    expect(good).toEqual({ ok: true });
  });

  it('is OK when there is NO keystore to protect (capture-only device — deliberate non-trigger)', () => {
    const noKeystore = checkAtRestSecretHealth({
      loadKeystore: () => null,
      readSecret: () => null, // even with no secret, a missing keystore is not the Atlas case
      tryDecrypt: () => { /* unreached */ },
    });
    expect(noKeystore).toEqual({ ok: true });
  });

  it('describes both failures without leaking any key material', () => {
    for (const reason of ['at_rest_secret_missing', 'at_rest_secret_nondecrypting'] as const) {
      const msg = describeAtRestSecretFailure(reason);
      expect(msg).toMatch(/will NOT earn/);
      expect(msg).not.toMatch(/[0-9a-f]{64}/); // never a raw key/secret
    }
  });
});

describe('reportRecoveryAlarm', () => {
  it('POSTs the alarm to the wallet-scoped route with agent auth and no key material', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    const posted = await reportRecoveryAlarm(
      { relayUrl: 'https://api.example', walletId: 'wallet_aw_x', apiKey: 'pvn_live_abc', apiSecret: 'pvns_secret', reason: 'at_rest_secret_missing' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/agent/wallet/wallet_aw_x/recovery-alarm');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pvn_live_abc:pvns_secret');
    const body = JSON.parse(String(init.body));
    expect(body.reason).toBe('at_rest_secret_missing');
    expect(String(init.body)).not.toContain('pvns_secret'); // secret is only in the header, never the body
  });

  it('never throws on a network failure (returns false)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const posted = await reportRecoveryAlarm(
      { relayUrl: 'https://api.example', walletId: 'w', apiKey: 'k', apiSecret: 's', reason: 'at_rest_secret_missing' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted).toBe(false);
  });
});

describe('reportRecoveryHealthy ', () => {
  it('POSTs to the clear route with agent auth and no key material; returns true only when an alarm was cleared', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ cleared: true }) }) as unknown as Response);
    const posted = await reportRecoveryHealthy(
      { relayUrl: 'https://api.example', walletId: 'wallet_aw_x', apiKey: 'pvn_live_abc', apiSecret: 'pvns_secret' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // RED control: this asserts the CLEAR route, not the alarm route — a copy-paste to
    // `/recovery-alarm` (which would re-raise, not clear) fails here.
    expect(url).toBe('https://api.example/v1/agent/wallet/wallet_aw_x/recovery-alarm/clear');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pvn_live_abc:pvns_secret');
    expect(String(init.body)).not.toContain('pvns_secret'); // secret only in the header
  });

  it('returns FALSE for an idempotent no-op (200 but cleared:false) so the daemon does not falsely log "cleared" (RED control)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ cleared: false }) }) as unknown as Response);
    const posted = await reportRecoveryHealthy(
      { relayUrl: 'https://api.example', walletId: 'w', apiKey: 'k', apiSecret: 's' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted).toBe(false);
  });

  it('never throws on a network failure (returns false)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const posted = await reportRecoveryHealthy(
      { relayUrl: 'https://api.example', walletId: 'w', apiKey: 'k', apiSecret: 's' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(posted).toBe(false);
  });
});
