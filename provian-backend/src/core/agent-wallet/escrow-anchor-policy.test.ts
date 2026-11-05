/**
 * checkEscrowAnchor (gate hardening): an escrow is accepted only when sealed to an anchor the
 * relay names for the agent. Each acceptance basis has its RED twin (the same anchor without the
 * fact that names it is refused), and an unreadable state refuses (503), never accepts.
 */

import { describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION,
  checkEscrowAnchor,
  recordBirthRecoveryAnchorIfAbsent,
} from './escrow-anchor-policy';

const W = 'wallet_aw_policy-agent';
const A = 'A'.repeat(43);
const B = 'B'.repeat(43);
const H = 'user_policy_human';

function db(seed: Record<string, Record<string, unknown>>) {
  const fake = createFakeFirestore();
  for (const [k, v] of Object.entries(seed)) fake.store.set(k, v);
  return { fake, db: fake as unknown as Firestore };
}

describe('checkEscrowAnchor', () => {
  it('birth anchor → ok; RED twin: a different anchor with the same birth record → 403', async () => {
    const { db: d } = db({ [`${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${W}`]: { recovery_anchor_pubkey: A } });
    expect(await checkEscrowAnchor(d, W, A)).toEqual({ ok: true, basis: 'birth' });
    expect(await checkEscrowAnchor(d, W, B)).toMatchObject({ ok: false, status: 403, error: 'recovery_anchor_not_recognized' });
  });

  it('linked human\'s published anchor → ok; RED twins: the link inactive, or the anchor of a human it is not linked to → 403', async () => {
    const linked = db({
      [`agent_wallets/${W}`]: { status: 'active', linked_human_user_id: H },
      [`human_recovery_anchors/${H}`]: { recovery_anchor_pubkey: A },
    });
    expect(await checkEscrowAnchor(linked.db, W, A)).toEqual({ ok: true, basis: 'linked_human_published' });
    const inactive = db({
      [`agent_wallets/${W}`]: { status: 'suspended', linked_human_user_id: H },
      [`human_recovery_anchors/${H}`]: { recovery_anchor_pubkey: A },
    });
    expect((await checkEscrowAnchor(inactive.db, W, A)).ok).toBe(false);
    const unlinked = db({
      [`agent_wallets/${W}`]: { status: 'active', linked_human_user_id: null },
      [`human_recovery_anchors/${H}`]: { recovery_anchor_pubkey: A },
    });
    expect((await checkEscrowAnchor(unlinked.db, W, A)).ok).toBe(false);
  });

  it('existing escrow\'s anchor → ok (a re-seal); RED twin: moving it elsewhere → 403', async () => {
    const { db: d } = db({ [`agent_recovery_escrows/${W}`]: { wallet_id: W, recovery_anchor_pubkey: A } });
    expect(await checkEscrowAnchor(d, W, A)).toEqual({ ok: true, basis: 'existing_escrow' });
    expect((await checkEscrowAnchor(d, W, B)).ok).toBe(false);
  });

  it('nothing names an anchor → 403 for any key', async () => {
    const { db: d } = db({ [`agent_wallets/${W}`]: { status: 'active' } });
    expect(await checkEscrowAnchor(d, W, A)).toMatchObject({ ok: false, status: 403 });
  });

  it('FAIL-CLOSED: a read error refuses with 503 — never an accept', async () => {
    const throwing = {
      collection: () => ({ doc: () => ({ get: async () => { throw new Error('down'); } }) }),
    } as unknown as Firestore;
    expect(await checkEscrowAnchor(throwing, W, A)).toMatchObject({
      ok: false, status: 503, error: 'recovery_anchor_check_unavailable',
    });
  });
});

describe('recordBirthRecoveryAnchorIfAbsent', () => {
  it('records once; a later call never moves it', async () => {
    const { fake, db: d } = db({});
    await recordBirthRecoveryAnchorIfAbsent(d, { walletId: W, pubkey: A, source: 'connection_code', now: 1 });
    await recordBirthRecoveryAnchorIfAbsent(d, { walletId: W, pubkey: B, source: 'code_issuer_published', now: 2 });
    expect(fake.store.get(`${AGENT_BIRTH_RECOVERY_ANCHOR_COLLECTION}/${W}`)).toMatchObject({
      recovery_anchor_pubkey: A, source: 'connection_code', created_at: 1,
    });
  });
});
