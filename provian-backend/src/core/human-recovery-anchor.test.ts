/**
 * Item 11 — the human's published recovery anchor. The relay keeps the
 * public half only, and only when the human's own wallet key signed it (a stolen device
 * auth token must not be able to point future agent escrows at another key).
 */
import { describe, it, expect } from '@jest/globals';
import { ethers } from 'ethers';
import {
  publishHumanRecoveryAnchor, readHumanRecoveryAnchor, humanRecoveryAnchorMessage, HUMAN_RECOVERY_ANCHOR_COLLECTION,
} from './human-recovery-anchor';

const PUB = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';

function memDb() {
  const store = new Map<string, Record<string, unknown>>();
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() { const d = store.get(`${name}/${id}`); return { exists: d !== undefined, data: () => d }; },
        async set(data: Record<string, unknown>) { store.set(`${name}/${id}`, { ...data }); },
      }),
    }),
  } as unknown as import('firebase-admin/firestore').Firestore;
  return { db, store };
}

describe('publishHumanRecoveryAnchor', () => {
  const human = ethers.Wallet.createRandom();

  it('stores the public key when the human\'s wallet signed it; readable back; a repeat is a no-op', async () => {
    const { db, store } = memDb();
    const signature = await human.signMessage(humanRecoveryAnchorMessage(PUB));
    const r = await publishHumanRecoveryAnchor(db, { userId: 'user_h', walletAddress: human.address, pubkey: PUB, signature, now: 1 });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await readHumanRecoveryAnchor(db, 'user_h')).toBe(PUB);
    const rec = store.get(`${HUMAN_RECOVERY_ANCHOR_COLLECTION}/user_h`)!;
    expect(Object.keys(rec).sort()).toEqual(['created_at', 'recovery_anchor_pubkey', 'signature', 'signer_address', 'updated_at', 'user_id']);
    expect(await publishHumanRecoveryAnchor(db, { userId: 'user_h', walletAddress: human.address, pubkey: PUB, signature, now: 2 })).toEqual({ ok: true, changed: false });
  });

  it('RED CONTROL: a signature from any other key is refused and nothing is stored', async () => {
    const { db } = memDb();
    const attacker = ethers.Wallet.createRandom();
    const signature = await attacker.signMessage(humanRecoveryAnchorMessage(PUB));
    const r = await publishHumanRecoveryAnchor(db, { userId: 'user_h', walletAddress: human.address, pubkey: PUB, signature, now: 1 });
    expect(r).toEqual({ ok: false, status: 403, error: 'signature_not_from_your_wallet' });
    expect(await readHumanRecoveryAnchor(db, 'user_h')).toBeNull();
  });

  it('RED CONTROL: the signature binds the key — a valid signature over a DIFFERENT key does not publish this one', async () => {
    const { db } = memDb();
    const other = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const signature = await human.signMessage(humanRecoveryAnchorMessage(other));
    const r = await publishHumanRecoveryAnchor(db, { userId: 'user_h', walletAddress: human.address, pubkey: PUB, signature, now: 1 });
    expect(r.ok).toBe(false);
  });

  it('malformed key or signature → 400', async () => {
    const { db } = memDb();
    expect(await publishHumanRecoveryAnchor(db, { userId: 'u', walletAddress: human.address, pubkey: 'short', signature: '0x00', now: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(await publishHumanRecoveryAnchor(db, { userId: 'u', walletAddress: human.address, pubkey: PUB, signature: 'nope', now: 1 })).toMatchObject({ ok: false, status: 400 });
  });
});
