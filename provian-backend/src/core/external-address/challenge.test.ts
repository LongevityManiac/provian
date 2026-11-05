/**
 * External-address challenge store tests: issue, load (claim equality +
 * expiry), single-use consume, and fail-closed behaviour when the cache is
 * unavailable.
 */

import type { PopCacheDeps } from '../agent-wallet/proof-of-possession';
import {
  issueExternalAddressChallenge,
  loadExternalAddressChallenge,
  consumeExternalAddressChallenge,
  buildProofMessage,
} from './challenge';

function makeCache(opts: { enabled?: boolean } = {}): PopCacheDeps & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    isEnabled: () => opts.enabled ?? true,
    async set(key, value) { store.set(key, value); },
    async setNx(key, value) {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    async get<T>(key: string) { return (store.has(key) ? (store.get(key) as T) : null); },
    async del(key) { store.delete(key); },
  };
}

const AGENT = 'agent_test';
const ADDR = '0xAbC0000000000000000000000000000000000001';

describe('issueExternalAddressChallenge', () => {
  it('issues a bound, EIP-4361-style challenge and stores it', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR, now: 1_000 });
    expect(c.challenge_id).toBeTruthy();
    expect(c.expires_at - c.issued_at).toBe(600_000);
    expect(c.message).toContain('Provian proof of control');
    expect(c.message).toContain(`agent: ${AGENT}`);
    expect(c.message).toContain(`address: ${ADDR.toLowerCase()}`);
    expect(c.message).toContain(`nonce: ${c.nonce}`);
    expect(cache.store.size).toBe(1);
  });

  it('fails closed when the cache is unavailable', async () => {
    const cache = makeCache({ enabled: false });
    await expect(issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR })).rejects.toThrow('CACHE_UNAVAILABLE');
  });
});

describe('loadExternalAddressChallenge', () => {
  it('loads a fresh challenge for the exact (agent, address)', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR, now: 1_000 });
    const res = await loadExternalAddressChallenge(cache, { challengeId: c.challenge_id, agentId: AGENT, address: ADDR, now: 2_000 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toBe(c.message);
  });

  it('rejects a mismatched agent or address', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR, now: 1_000 });
    expect((await loadExternalAddressChallenge(cache, { challengeId: c.challenge_id, agentId: 'other', address: ADDR, now: 2_000 })).ok).toBe(false);
    expect((await loadExternalAddressChallenge(cache, { challengeId: c.challenge_id, agentId: AGENT, address: '0x0000000000000000000000000000000000000009', now: 2_000 })).ok).toBe(false);
  });

  it('rejects an expired challenge and purges it', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR, now: 1_000 });
    const res = await loadExternalAddressChallenge(cache, { challengeId: c.challenge_id, agentId: AGENT, address: ADDR, now: 1_000 + 600_001 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('challenge_expired');
    expect(cache.store.size).toBe(0);
  });

  it('rejects an unknown challenge id', async () => {
    const cache = makeCache();
    expect((await loadExternalAddressChallenge(cache, { challengeId: 'nope', agentId: AGENT, address: ADDR })).ok).toBe(false);
  });

  it('fails closed when the cache is unavailable', async () => {
    const cache = makeCache({ enabled: false });
    const res = await loadExternalAddressChallenge(cache, { challengeId: 'x', agentId: AGENT, address: ADDR });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('cache_unavailable');
  });
});

describe('consumeExternalAddressChallenge', () => {
  it('deletes the challenge (single-use)', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, { agentId: AGENT, address: ADDR, now: 1_000 });
    expect(cache.store.size).toBe(1);
    expect(await consumeExternalAddressChallenge(cache, c.challenge_id)).toBe(true);
    // The original is deleted and a redemption marker remains until its TTL.
    expect(cache.store.size).toBe(1);
    expect(await consumeExternalAddressChallenge(cache, c.challenge_id)).toBe(false);
    // A second load now fails (replay defense).
    expect((await loadExternalAddressChallenge(cache, { challengeId: c.challenge_id, agentId: AGENT, address: ADDR, now: 2_000 })).ok).toBe(false);
  });

  it('fails closed when atomic redemption ownership is unavailable', async () => {
    const cache = makeCache();
    const c = await issueExternalAddressChallenge(cache, {
      agentId: AGENT,
      address: ADDR,
      now: 1_000,
    });
    const withoutAtomicClaim = { ...cache, setNx: undefined };
    expect(await consumeExternalAddressChallenge(withoutAtomicClaim, c.challenge_id)).toBe(false);
  });
});

describe('buildProofMessage', () => {
  it('is deterministic and ordered', () => {
    const m = buildProofMessage({ agentId: 'a', address: '0x1', nonce: 'n', issuedIso: 'i', expiresIso: 'e' });
    expect(m.split('\n')).toEqual([
      'Provian proof of control',
      'agent: a',
      'address: 0x1',
      'nonce: n',
      'issued: i',
      'expires: e',
    ]);
  });
});
