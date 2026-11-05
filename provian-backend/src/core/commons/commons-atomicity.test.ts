/**
 * WS4 — Commons PE + entity write atomicity (forum / human-jobs / vouching).
 *
 * Each Commons writer used to commit its entity document SEPARATELY from the PE
 * (the PE was only buffered), so a crash could leave an entity referencing a PE
 * whose document never landed. WS4 threads the entity write through generatePE's
 * atomicEntityWrite hook so the PE document + entity document commit in ONE
 * Firestore transaction.
 *
 * These tests run the REAL writers against the fake Firestore (which buffers
 * transaction writes and rolls them back on failure). For each writer:
 *   - happy path: the entity AND the (provisional) PE document both land, and the
 *     entity references the exact PE committed with it;
 *   - injected failure: the entity write inside the transaction fails, and BOTH
 *     the entity and the PE are absent — neither lands.
 */
import { describe, it, expect } from '@jest/globals';
import { createPost as createPostRaw } from './forum';
import { TEST_WINDOW, actorOf } from './__test-helpers__/speech';
const createPost = (deps: Parameters<typeof createPostRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof createPostRaw>[2]) => createPostRaw(deps, actorOf(w, a, addr), body, TEST_WINDOW);
import { postHumanJob as postHumanJobRaw } from './human-jobs';
const postHumanJob = (deps: Parameters<typeof postHumanJobRaw>[0], w: string, a: string, addr: string | null, body: Parameters<typeof postHumanJobRaw>[4]) => postHumanJobRaw(deps, w, a, addr, body, TEST_WINDOW);
import { vouchForParticipant } from './vouching';
import { COMMONS_COLLECTIONS } from './types';
import type { CommonsDeps } from './types';
import {
  createFakeFirestore,
  type FakeFirestore,
} from '../pvt/__test-helpers__/fake-firestore';
import { METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from '../meter/meter-relay-authored';

// PE METER (2026-10-03): the relay keeps no readable PE. What commits with the entity in the
// chain-tip transaction is the act's transient intake (act record + accrual inputs + the PE sealed
// to its owner) — the replay source that makes the act durable. With the stub accrual here it is
// never priced, so it stays staged and is what these tests observe.
const PE_COLL = METER_RELAY_ACTS_COLLECTION;
const intakeOf = (db: FakeFirestore, peId: string): RelayActIntake | undefined =>
  db.store.get(`${PE_COLL}/${peId}`) as RelayActIntake | undefined;
const DAY = 24 * 60 * 60 * 1000;

function makeDeps(db: FakeFirestore): CommonsDeps {
  return {
    db,
    cache: { checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }) },
    // Never flushes: the provisional in-txn write is the durability proof.
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
  } as unknown as CommonsDeps;
}

function docsIn(db: FakeFirestore, collection: string): string[] {
  return [...db.store.keys()].filter((k) => k.startsWith(`${collection}/`));
}

// ─── Forum ────────────────────────────────────────────────────────────────────

describe('WS4 atomicity — forum.createPost', () => {
  const WALLET = 'wallet_forum';
  const seed = (db: FakeFirestore) => {
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${WALLET}`, {
      status: 'active',
      commons_join_date: Date.now() - 40 * DAY, // established account → no daily cap
      pe_count: 100,
      participant_type: 'human',
    });
    db.store.set(`${COMMONS_COLLECTIONS.FORUM_CHANNELS}/general`, { channel_id: 'general' });
  };

  it('post + PE both land in one transaction', async () => {
    const db = createFakeFirestore();
    seed(db);
    const post = await createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
      channel: 'general',
      title: 'Hello',
      content: 'first post',
    });

    const postDoc = db.store.get(`${COMMONS_COLLECTIONS.FORUM_POSTS}/${post.post_id}`);
    const peDoc = intakeOf(db, post.pe_id);
    expect(postDoc).toBeDefined();
    expect(peDoc).toBeDefined();
    expect(peDoc!.schema).toBe('provian.meter-relay-act.v1');
    // The staged act is the one the chain tip advanced to in that same transaction.
    expect(peDoc!.act.pe_hash).toBe(db.store.get(`pe_chain_tips/${WALLET}`)!.hash);
    expect(postDoc!.pe_id).toBe(post.pe_id);
  });

  it('neither post nor PE lands when the post write fails inside the txn', async () => {
    const db = createFakeFirestore({ failTxnWriteTo: COMMONS_COLLECTIONS.FORUM_POSTS });
    seed(db);
    await expect(
      createPost(makeDeps(db), WALLET, WALLET, '0xFORUM', {
        channel: 'general',
        content: 'doomed post',
      }),
    ).rejects.toThrow(/Injected transaction write failure/);

    expect(docsIn(db, COMMONS_COLLECTIONS.FORUM_POSTS)).toHaveLength(0);
    expect(docsIn(db, PE_COLL)).toHaveLength(0);
  });
});

// ─── Human jobs ────────────────────────────────────────────────────────────────

describe('runtime boundary quarantine — human-jobs.postHumanJob', () => {
  const WALLET = 'wallet_hjob';
  const body = {
    title: 'Translate a document',
    description: 'Need a careful human translation.',
    category: 'professional_services' as const,
    skills_required: [],
    location: { type: 'remote' as const },
    compensation_type: 'pvt' as const,
    budget_pvt: '1000000000000000000',
    requires_identity_verification: false,
    requires_pe_history: false,
    deadline_hours: 24,
  };
  const seed = (db: FakeFirestore) => {
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${WALLET}`, {
      participant_type: 'human',
      attestation_tier: 'software',
    });
  };

  it('fails closed before either a job or PE document is written', async () => {
    const db = createFakeFirestore();
    seed(db);
    await expect(
      postHumanJob(makeDeps(db), WALLET, WALLET, '0xJOB', body),
    ).rejects.toThrow(/no PVT-principal chain is configured/);

    expect(docsIn(db, COMMONS_COLLECTIONS.HUMAN_JOBS)).toHaveLength(0);
    expect(docsIn(db, PE_COLL)).toHaveLength(0);
  });
});

// ─── Vouching ──────────────────────────────────────────────────────────────────

describe('WS4 atomicity — vouching.vouchForParticipant', () => {
  const VOUCHER = 'wallet_voucher';
  const VOUCHEE = 'wallet_vouchee';
  const seed = (db: FakeFirestore) => {
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${VOUCHER}`, {
      commons_join_date: Date.now() - 60 * DAY, // tenure ≥ 30 days
    });
    db.store.set(`agent_wallets/${VOUCHER}`, { governance_score: 100 }); // ≥ min score
    db.store.set(`${COMMONS_COLLECTIONS.PROFILES}/${VOUCHEE}`, {
      identity_verification_level: 'device_attested',
    });
  };

  // Find provisional PE docs by their action_type (helper for two-chain checks).
  const pesByAction = (db: FakeFirestore, action: string) =>
    [...db.store.entries()]
      .filter(([k]) => k.startsWith(`${PE_COLL}/`))
      .map(([, v]) => v as unknown as RelayActIntake)
      .filter((v) => v.act.action_type === action);

  it('vouch + voucher PE both land in one transaction', async () => {
    const db = createFakeFirestore();
    seed(db);
    const vouch = await vouchForParticipant(makeDeps(db), VOUCHER, VOUCHER, '0xVOUCH', {
      vouchee_wallet_id: VOUCHEE,
      statement: 'reliable counterparty',
    });

    const vouchDoc = db.store.get(`${COMMONS_COLLECTIONS.VOUCHES}/${vouch.vouch_id}`);
    const peDoc = intakeOf(db, vouch.pe_id);
    expect(vouchDoc).toBeDefined();
    expect(peDoc).toBeDefined();
    expect(peDoc!.schema).toBe('provian.meter-relay-act.v1');
    expect(peDoc!.actor_id).toBe(VOUCHER);
    expect(vouchDoc!.pe_id).toBe(vouch.pe_id);
  });

  it('voucher and vouchee PEs land on TWO distinct, independent chains', async () => {
    const db = createFakeFirestore();
    seed(db);
    const vouch = await vouchForParticipant(makeDeps(db), VOUCHER, VOUCHER, '0xVOUCH', {
      vouchee_wallet_id: VOUCHEE,
      statement: 'reliable counterparty',
    });

    // The voucher PE is on the voucher's chain; the vouchee PE (commons_vouch_received)
    // is a SEPARATE generatePE on the vouchee's own chain.
    const voucherPe = intakeOf(db, vouch.pe_id)!;
    const voucheePes = pesByAction(db, 'commons_vouch_received');
    expect(voucherPe.actor_id).toBe(VOUCHER);
    expect(voucheePes).toHaveLength(1);
    expect(voucheePes[0].actor_id).toBe(VOUCHEE);

    // Two distinct chain-tip documents advanced independently; the vouchee PE
    // links to ITS OWN genesis, never to the voucher's hash (no cross-chain fork).
    const voucherTip = db.store.get(`pe_chain_tips/${VOUCHER}`)!;
    const voucheeTip = db.store.get(`pe_chain_tips/${VOUCHEE}`)!;
    expect(voucherTip).toBeDefined();
    expect(voucheeTip).toBeDefined();
    expect(voucherTip.hash).not.toBe(voucheeTip.hash);
    expect(voucheePes[0].act.prev_hash).toBe('0x0000');
    expect(voucheePes[0].act.prev_hash).not.toBe(voucherPe.act.pe_hash);
    expect(voucherPe.act.pe_hash).toBe(voucherTip.hash);
    expect(voucheePes[0].act.pe_hash).toBe(voucheeTip.hash);
  });

  it('drives the peer_vouched upgrade (3rd vouch) and emits the verification-upgrade PE', async () => {
    const db = createFakeFirestore();
    seed(db);
    // Two pre-existing vouches for the vouchee from OTHER vouchers (so this call
    // is the 3rd → reaches VOUCHES_FOR_UPGRADE). Distinct vouchers so neither the
    // duplicate-vouch nor reciprocal-vouch guards trip.
    for (const i of [1, 2]) {
      db.store.set(`${COMMONS_COLLECTIONS.VOUCHES}/seed_vouch_${i}`, {
        vouch_id: `seed_vouch_${i}`,
        voucher_wallet_id: `other_voucher_${i}`,
        vouchee_wallet_id: VOUCHEE,
        created_at: Date.now() - (i + 1) * DAY,
      });
    }

    await vouchForParticipant(makeDeps(db), VOUCHER, VOUCHER, '0xVOUCH', {
      vouchee_wallet_id: VOUCHEE,
      statement: 'third voucher',
    });

    // The vouchee profile was upgraded...
    const voucheeProfile = db.store.get(`${COMMONS_COLLECTIONS.PROFILES}/${VOUCHEE}`)!;
    expect(voucheeProfile.identity_verification_level).toBe('peer_vouched');
    // ...and the verification-upgrade PE landed on the vouchee's chain.
    const upgradePes = pesByAction(db, 'commons_verification_upgraded');
    expect(upgradePes).toHaveLength(1);
    expect(upgradePes[0].actor_id).toBe(VOUCHEE);
    expect(upgradePes[0].schema).toBe('provian.meter-relay-act.v1');
  });

  it('neither vouch nor voucher PE lands when the vouch write fails inside the txn', async () => {
    const db = createFakeFirestore({ failTxnWriteTo: COMMONS_COLLECTIONS.VOUCHES });
    seed(db);
    await expect(
      vouchForParticipant(makeDeps(db), VOUCHER, VOUCHER, '0xVOUCH', {
        vouchee_wallet_id: VOUCHEE,
        statement: 'doomed vouch',
      }),
    ).rejects.toThrow(/Injected transaction write failure/);

    expect(docsIn(db, COMMONS_COLLECTIONS.VOUCHES)).toHaveLength(0);
    // The voucher PE rolled back with the vouch; the vouchee PE never ran.
    expect(docsIn(db, PE_COLL)).toHaveLength(0);
  });
});
