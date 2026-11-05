/**
 * A person's message key is published under their Commons party id (`user_id`); the PE meter and
 * the app look it up by their `wallets/{doc}` id. `readMessageKey` resolves the wallet doc id to its
 * single user — found live 2026-10-04, when nothing could be sealed to the operator.
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { COMMONS_COLLECTIONS } from './types';
import { readMessageKey } from './message-keys';

const KEY = { party_id: 'user_frank', kind: 'human', pubkey_b64u: 'pk_frank', key_version: 1, published_at: 1 };

function seeded() {
  const fake = createFakeFirestore();
  fake.store.set(`${COMMONS_COLLECTIONS.MESSAGE_KEYS}/user_frank`, KEY);
  fake.store.set('wallets/wallet_frank', { user_id: 'user_frank' });
  fake.store.set('wallets/wallet_other', { user_id: 'user_other' });
  return fake as unknown as Firestore;
}

describe('readMessageKey', () => {
  it('reads a key by the id it was published under', async () => {
    expect(await readMessageKey(seeded(), 'user_frank')).toMatchObject({ pubkey_b64u: 'pk_frank' });
  });
  it("resolves a person's wallets doc id to their user's key", async () => {
    expect(await readMessageKey(seeded(), 'wallet_frank')).toMatchObject({ pubkey_b64u: 'pk_frank' });
  });
  it("RED: another person's wallet doc never resolves to the operator’s key", async () => {
    expect(await readMessageKey(seeded(), 'wallet_other')).toBeNull();
  });
  it('RED: an agent wallet id is never resolved through `wallets`', async () => {
    const db = seeded();
    (db as unknown as { store: Map<string, unknown> }).store.set('wallets/wallet_aw_x', { user_id: 'user_frank' });
    expect(await readMessageKey(db, 'wallet_aw_x')).toBeNull();
  });
});
