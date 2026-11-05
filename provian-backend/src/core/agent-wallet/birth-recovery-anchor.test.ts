/**
 * resolveBirthRecoveryAnchor (/ OPEN_ITEMS L381) — the PUBLIC key a new agent seals its key
 * to at birth, per creation path.
 *
 * Every positive case has its RED twin in-suite : the same input with the one fact the
 * positive case depends on removed resolves to NO anchor — so a resolver hard-wired to return an
 * anchor, or one that falls back to a key nobody in the link can open, fails here.
 */

import { describe, expect, it } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { HUMAN_RECOVERY_ANCHOR_COLLECTION } from '../human-recovery-anchor';
import { resolveBirthRecoveryAnchor } from './birth-recovery-anchor';

const HUMAN = 'user_human_a';
const OTHER_HUMAN = 'user_human_b';
const HUMAN_ANCHOR = 'H'.repeat(43);
const OTHER_ANCHOR = 'O'.repeat(43);
const INVITE_ANCHOR = 'I'.repeat(43);
const CODE = 'PROV-ABCD-EFGH';

function db(seed: Record<string, Record<string, unknown>> = {}) {
  const fake = createFakeFirestore();
  for (const [k, v] of Object.entries(seed)) fake.store.set(k, v);
  return fake as unknown as Firestore;
}

const published = (user: string, pub: string) => ({
  [`${HUMAN_RECOVERY_ANCHOR_COLLECTION}/${user}`]: { user_id: user, recovery_anchor_pubkey: pub },
});

describe('resolveBirthRecoveryAnchor — a parent-spawned child', () => {
  it('seals to the INHERITED human\'s published anchor', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db(published(HUMAN, HUMAN_ANCHOR)) }, {
      connectionToken: null, isChild: true, inheritedHumanUserId: HUMAN,
    });
    expect(r).toEqual({ pubkey: HUMAN_ANCHOR, source: 'inherited_human_published' });
  });

  it('RED CONTROL: the inherited human has not published → no anchor (the child waits for escrow)', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db(published(OTHER_HUMAN, OTHER_ANCHOR)) }, {
      connectionToken: null, isChild: true, inheritedHumanUserId: HUMAN,
    });
    expect(r).toEqual({ pubkey: null, source: 'none' });
  });

  it('a code the linked child also carried never overrides its custodian (a different human\'s code anchor is ignored)', async () => {
    const seeded = {
      ...published(HUMAN, HUMAN_ANCHOR),
      [`connection_tokens/${CODE}`]: { user_id: OTHER_HUMAN, recovery_anchor_pubkey: OTHER_ANCHOR },
    };
    const r = await resolveBirthRecoveryAnchor({ db: db(seeded) }, {
      connectionToken: CODE, isChild: true, inheritedHumanUserId: HUMAN,
    });
    expect(r.pubkey).toBe(HUMAN_ANCHOR);
    // RED twin: with the custodian unpublished it does NOT fall back to the other human's code anchor.
    const unpublished = await resolveBirthRecoveryAnchor({ db: db({
      [`connection_tokens/${CODE}`]: { user_id: OTHER_HUMAN, recovery_anchor_pubkey: OTHER_ANCHOR },
    }) }, { connectionToken: CODE, isChild: true, inheritedHumanUserId: HUMAN });
    expect(unpublished.pubkey).toBeNull();
  });

  it('a child of an UNLINKED parent is resolved like any other agent (by its code), and with none gets none', async () => {
    const withCode = await resolveBirthRecoveryAnchor({ db: db({
      [`connection_tokens/${CODE}`]: { user_id: HUMAN, recovery_anchor_pubkey: INVITE_ANCHOR },
    }) }, { connectionToken: CODE, isChild: true, inheritedHumanUserId: null });
    expect(withCode.pubkey).toBe(INVITE_ANCHOR);
    const bare = await resolveBirthRecoveryAnchor({ db: db(published(HUMAN, HUMAN_ANCHOR)) }, {
      connectionToken: null, isChild: true, inheritedHumanUserId: null,
    });
    expect(bare).toEqual({ pubkey: null, source: 'none' });
  });
});

describe('resolveBirthRecoveryAnchor — a connection code (human or fleet)', () => {
  it('the code\'s own anchor wins (the pre-existing behaviour, byte-for-byte the same key)', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db({
      ...published(HUMAN, HUMAN_ANCHOR),
      [`connection_tokens/${CODE}`]: { user_id: HUMAN, recovery_anchor_pubkey: INVITE_ANCHOR },
    }) }, { connectionToken: CODE, isChild: false, inheritedHumanUserId: null });
    expect(r).toEqual({ pubkey: INVITE_ANCHOR, source: 'connection_code' });
  });

  it('a fleet code minted before its human published falls back to the ISSUER\'s published anchor', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db({
      ...published(HUMAN, HUMAN_ANCHOR),
      [`connection_tokens/${CODE}`]: { user_id: HUMAN, kind: 'fleet', issued_by_agent_wallet_id: 'wallet_aw_issuer' },
    }) }, { connectionToken: CODE, isChild: false, inheritedHumanUserId: null });
    expect(r).toEqual({ pubkey: HUMAN_ANCHOR, source: 'code_issuer_published' });
  });

  it('RED CONTROL: no anchor on the code AND the issuer unpublished → none (never another human\'s anchor)', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db({
      ...published(OTHER_HUMAN, OTHER_ANCHOR),
      [`connection_tokens/${CODE}`]: { user_id: HUMAN, kind: 'fleet' },
    }) }, { connectionToken: CODE, isChild: false, inheritedHumanUserId: null });
    expect(r).toEqual({ pubkey: null, source: 'none' });
  });

  it('a malformed anchor on the code is not echoed; the issuer\'s published anchor is used instead', async () => {
    const r = await resolveBirthRecoveryAnchor({ db: db({
      ...published(HUMAN, HUMAN_ANCHOR),
      [`connection_tokens/${CODE}`]: { user_id: HUMAN, recovery_anchor_pubkey: 'not-a-key' },
    }) }, { connectionToken: CODE, isChild: false, inheritedHumanUserId: null });
    expect(r.pubkey).toBe(HUMAN_ANCHOR);
  });

  it('unknown / malformed codes and no code resolve to none', async () => {
    const base = db(published(HUMAN, HUMAN_ANCHOR));
    for (const connectionToken of [null, 'PROV-ZZZZ-ZZZZ', 'not a code']) {
      expect(await resolveBirthRecoveryAnchor({ db: base }, {
        connectionToken, isChild: false, inheritedHumanUserId: null,
      })).toEqual({ pubkey: null, source: 'none' });
    }
  });

  it('FAIL-SOFT: a read error resolves to none (the agent waits for escrow; never a guessed anchor)', async () => {
    const throwing = {
      collection: () => ({ doc: () => ({ get: async () => { throw new Error('firestore down'); } }) }),
    } as unknown as Firestore;
    expect(await resolveBirthRecoveryAnchor({ db: throwing }, {
      connectionToken: CODE, isChild: false, inheritedHumanUserId: null,
    })).toEqual({ pubkey: null, source: 'none' });
    expect(await resolveBirthRecoveryAnchor({ db: throwing }, {
      connectionToken: null, isChild: true, inheritedHumanUserId: HUMAN,
    })).toEqual({ pubkey: null, source: 'none' });
  });
});
