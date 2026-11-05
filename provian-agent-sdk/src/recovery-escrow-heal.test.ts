/**
 * Item 11 : an installed agent with no escrow seals its OWN key to the
 * human's published anchor and escrows the ciphertext — only the anchor's secret (the
 * phone's) opens it.
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { ensureRecoveryEscrow } from './recovery-escrow-heal';
import { encryptKeystore } from './keystore';
import { generateAnchorKeyPair, openWithAnchor, toB64u, fromB64u } from './agent-key-recovery';
import { startRecoveryEscrowHeal } from './observer/run-daemon';

const priv = bytesToHex(secp256k1.utils.randomPrivateKey());
const pub = bytesToHex(secp256k1.getPublicKey(priv, false)).slice(2);
const PASS = 'at-rest-secret-at-rest-secret-01';
const keystore = encryptKeystore({ privateKey: priv, address: '0x' + '1'.repeat(40), publicKey: pub, walletId: 'wallet_aw_fleet', passphrase: PASS, kdfParams: { N: 1 << 10, r: 8, p: 1 } });
const INPUT = { relayUrl: 'https://relay.test', walletId: 'wallet_aw_fleet', apiKey: 'pvn_live_k', apiSecret: 'pvns_s' };

function relay(target: Record<string, unknown>) {
  const posts: Array<{ url: string; body: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ stored: true }), { status: 200 });
    }
    return new Response(JSON.stringify(target), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

describe('ensureRecoveryEscrow', () => {
  it('seals this agent\'s key to the human\'s published anchor; the phone\'s secret opens it to the exact key', async () => {
    const anchor = generateAnchorKeyPair();
    const r = relay({ escrowed: false, recovery_anchor_pubkey: toB64u(anchor.publicKey) });
    const out = await ensureRecoveryEscrow(INPUT, { fetchImpl: r.fetchImpl, loadKeystore: () => keystore, readSecret: () => PASS });
    expect(out).toBe('escrowed_now');
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].url).toBe('https://relay.test/v1/agent/wallet/wallet_aw_fleet/recovery-escrow');
    expect(r.posts[0].body.recovery_anchor_pubkey).toBe(toB64u(anchor.publicKey));
    expect(JSON.stringify(r.posts[0].body)).not.toContain(priv); // ciphertext only leaves
    expect(bytesToHex(openWithAnchor(anchor.secretKey, fromB64u(r.posts[0].body.sealed_key_blob)))).toBe(priv);
    // RED control: any other key (another agent's, the relay's) cannot open it.
    expect(() => openWithAnchor(generateAnchorKeyPair().secretKey, fromB64u(r.posts[0].body.sealed_key_blob))).toThrow();
  });

  it('already escrowed, or no anchor published: nothing is decrypted or sent', async () => {
    let decrypts = 0;
    for (const target of [{ escrowed: true, recovery_anchor_pubkey: null }, { escrowed: false, recovery_anchor_pubkey: null, reason: 'human_anchor_not_published' }, { escrowed: false, recovery_anchor_pubkey: null, reason: 'not_linked' }]) {
      const r = relay(target);
      const out = await ensureRecoveryEscrow(INPUT, { fetchImpl: r.fetchImpl, loadKeystore: () => { decrypts++; return keystore; }, readSecret: () => PASS });
      expect(['already_escrowed', 'human_anchor_not_published', 'not_linked']).toContain(out);
      expect(r.posts).toHaveLength(0);
    }
    expect(decrypts).toBe(0);
  });

  it('a keystore for a different wallet, or no at-rest secret, is never sealed under this wallet', async () => {
    const anchor = generateAnchorKeyPair();
    const other = encryptKeystore({ privateKey: priv, address: '0x' + '1'.repeat(40), publicKey: pub, walletId: 'wallet_aw_other', passphrase: PASS, kdfParams: { N: 1 << 10, r: 8, p: 1 } });
    const r = relay({ escrowed: false, recovery_anchor_pubkey: toB64u(anchor.publicKey) });
    expect(await ensureRecoveryEscrow(INPUT, { fetchImpl: r.fetchImpl, loadKeystore: () => other, readSecret: () => PASS })).toBe('no_keystore');
    expect(await ensureRecoveryEscrow(INPUT, { fetchImpl: r.fetchImpl, loadKeystore: () => keystore, readSecret: () => null })).toBe('no_keystore');
    expect(r.posts).toHaveLength(0);
  });
});

describe('startRecoveryEscrowHeal (daemon loop)', () => {
  it('retries while the anchor is unpublished and stops once escrowed', async () => {
    const outcomes = ['human_anchor_not_published', 'human_anchor_not_published', 'escrowed_now'] as const;
    let i = 0;
    const lines: string[] = [];
    const h = startRecoveryEscrowHeal(INPUT, { heal: async () => outcomes[Math.min(i++, outcomes.length - 1)], intervalMs: 1, log: (l) => lines.push(l) });
    await h.done;
    expect(i).toBe(3);
    expect(lines).toHaveLength(2); // logged on change only
    expect(lines[1]).toContain('sealed to your human');
  });
});
