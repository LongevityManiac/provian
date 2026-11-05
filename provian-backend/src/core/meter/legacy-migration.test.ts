/**
 * PE METER — the legacy migration retires a stored PE only when nothing earned can be lost:
 * terminal acts retire, a registered-and-unsettled legacy claim waits, a hand-back owner with no
 * key waits, and what is handed back opens with the owner's key to the exact envelope.
 */
import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { CLAIM_LEDGER_COLLECTION, claimKeyOf } from '../pvt/wp4/durable-settlement-store';
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../pvt/wp-ev/eligibility';
import { COUNTERPARTY_PAIRS_COLLECTION, counterpartyPairDocId } from './counterparty-pairs';
import {
  classifyLegacyPe,
  legacyMailboxId,
  retireLegacyPe,
  type HandBackOwner,
} from './legacy-migration';
import { ACTOR_METER_TOTALS_COLLECTION, type ActorMeterTotalsDoc } from './actor-meter-totals';
import { LEGACY_IDENTITY_PES_COLLECTION, METER_HELD_ACTS_COLLECTION, PE_MAILBOX_COLLECTION } from './meter-store';
import { fromB64u, openWithKey, toB64u } from './sealed-box';

const NOW = 1_790_000_000_000;
const AFTER_CUT = PVT9_ELIGIBILITY_CUT_LINE_MS + 86_400_000;
const PEER = '0x2222222222222222222222222222222222222222';

function keyPair(): { secret: Buffer; pubB64u: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const secret = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { secret, pubB64u: toB64u(pub) };
}

function seed(store: Map<string, Record<string, unknown>>, peId: string, row: Record<string, unknown> | null, envelope: Record<string, unknown>) {
  if (row !== null) store.set(`pe_history/${peId}`, row);
  store.set(`provenance_envelopes/${peId}`, envelope);
}

function envelopeOf(peId: string, actionType: string, userId: string, extra: Record<string, unknown> = {}) {
  return {
    id: peId, user_id: userId, wallet_id: 'w1', action_type: actionType, actor_address: '0x1111111111111111111111111111111111111111',
    timestamp: AFTER_CUT, prev_hash: 'genesis', hash: 'ab'.repeat(32), metadata: {}, ...extra,
  };
}

const opts = (handBack: ReadonlyMap<string, HandBackOwner>, apply = true) => ({
  nowMs: NOW, apply, handBack, identityPinned: new Set<string>(),
});

describe('classifyLegacyPe', () => {
  const row = (extra: Record<string, unknown>) => ({ mint_status: 'eligible', timestamp: AFTER_CUT, record_points_atomic: '1000', ...extra });
  it('terminal statuses retire; held statuses become held acts; live eligible converts', () => {
    expect(classifyLegacyPe({ row: { mint_status: 'minted' }, ledger: 'none' })).toEqual({ kind: 'retire' });
    expect(classifyLegacyPe({ row: { mint_status: 'pending_review' }, ledger: 'none' })).toEqual({ kind: 'hold', heldReason: 'pending_review' });
    expect(classifyLegacyPe({ row: row({}), ledger: 'none' })).toEqual({ kind: 'convert' });
    expect(classifyLegacyPe({ row: row({}), ledger: 'all_settled' })).toEqual({ kind: 'retire' });
  });
  it('pre-cut-line and zero-point eligible rows retire (never mintable)', () => {
    expect(classifyLegacyPe({ row: row({ timestamp: PVT9_ELIGIBILITY_CUT_LINE_MS - 1 }), ledger: 'none' })).toEqual({ kind: 'retire' });
    expect(classifyLegacyPe({ row: row({ record_points_atomic: '0' }), ledger: 'none' })).toEqual({ kind: 'retire' });
  });
  it('RED: an unsettled legacy claim, a live Genesis grant, or an unknown status waits', () => {
    expect(classifyLegacyPe({ row: { mint_status: 'minted' }, ledger: 'unsettled' }).kind).toBe('wait');
    expect(classifyLegacyPe({ row: row({ is_genesis_grant: true }), ledger: 'none' }).kind).toBe('wait');
    expect(classifyLegacyPe({ row: { mint_status: 'mystery' }, ledger: 'none' }).kind).toBe('wait');
    expect(classifyLegacyPe({ row: { mint_status: 'genesis_epoch_deferred' }, ledger: 'none' })).toEqual({ kind: 'wait', reason: 'mint_in_flight:genesis_epoch_deferred' });
  });
  it('a pre-cut-line deferral retires; RED: a deferral after the cut line waits', () => {
    const before = PVT9_ELIGIBILITY_CUT_LINE_MS - 1;
    expect(classifyLegacyPe({ row: { mint_status: 'genesis_epoch_deferred', timestamp: before }, ledger: 'none' })).toEqual({ kind: 'retire' });
    expect(classifyLegacyPe({ row: { mint_status: 'genesis_epoch_deferred', timestamp: AFTER_CUT }, ledger: 'none' }))
      .toEqual({ kind: 'wait', reason: 'mint_in_flight:genesis_epoch_deferred' });
  });

  it('a Genesis grant whose qualification was denied retires; RED: one not denied waits', () => {
    const row = { mint_status: 'eligible', is_genesis_grant: true, timestamp: AFTER_CUT, record_points_atomic: '75000000000000000000' };
    expect(classifyLegacyPe({ row, ledger: 'none', genesisDenied: true })).toEqual({ kind: 'retire' });
    expect(classifyLegacyPe({ row, ledger: 'none' })).toEqual({ kind: 'wait', reason: 'genesis_unsettled' });
    // An unsettled legacy claim still wins over a denial.
    expect(classifyLegacyPe({ row, ledger: 'unsettled', genesisDenied: true })).toEqual({ kind: 'wait', reason: 'legacy_claim_unsettled' });
  });

  it('terminal no-mint statuses retire (duplicate witness, no output, farm cap, unverified x402)', () => {
    for (const s of ['corroborated_duplicate', 'skipped_no_output', 'farm_capped', 'x402_unverified']) {
      expect(classifyLegacyPe({ row: { mint_status: s }, ledger: 'none' })).toEqual({ kind: 'retire' });
    }
  });
});

describe('retireLegacyPe', () => {
  it('a minted send of a hand-back owner: handed back sealed, its pair folded, both records gone — once', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const frank = keyPair();
    const env = envelopeOf('pe_send', 'send', 'user_frank', { counterparty_address: PEER });
    seed(fake.store, 'pe_send', { mint_status: 'minted', userId: 'user_frank', timestamp: AFTER_CUT }, env);
    const owners = new Map([['user_frank', { actorId: 'user_frank', recipient: 'human:user_frank', pubkeyB64u: frank.pubB64u }]]);

    const out = await retireLegacyPe(db, 'pe_send', opts(owners));
    expect(out).toMatchObject({ kind: 'retired', handedBack: true });
    expect(fake.store.has('pe_history/pe_send')).toBe(false);
    expect(fake.store.has('provenance_envelopes/pe_send')).toBe(false);
    const item = fake.store.get(`${PE_MAILBOX_COLLECTION}/${legacyMailboxId('pe_send', 'human:user_frank')}`) as { box: string; to: string };
    expect(item.to).toBe('human:user_frank');
    expect(JSON.parse(openWithKey(frank.secret, fromB64u(item.box)).toString('utf8'))).toEqual(env);
    expect(fake.store.get(`${COUNTERPARTY_PAIRS_COLLECTION}/${counterpartyPairDocId('user_frank', PEER)}`)).toBeDefined();
    // A re-run finds nothing: no second fold, no second hand-back.
    expect(await retireLegacyPe(db, 'pe_send', opts(owners))).toEqual({ kind: 'gone' });
  });

  it('RED: a hand-back owner with no published key keeps their PE in place', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_k', { mint_status: 'minted', userId: 'user_frank' }, envelopeOf('pe_k', 'coding_session', 'user_frank'));
    const owners = new Map([['user_frank', { actorId: 'user_frank', recipient: 'human:user_frank', pubkeyB64u: null }]]);
    expect(await retireLegacyPe(db, 'pe_k', opts(owners))).toEqual({ kind: 'waiting', reason: 'hand_back_key_missing' });
    expect(fake.store.has('pe_history/pe_k')).toBe(true);
    expect(fake.store.has('provenance_envelopes/pe_k')).toBe(true);
  });

  it('RED: a registered, unsettled legacy claim keeps the PE its approver reads', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_reg', { mint_status: 'eligible', userId: 'agent_x', timestamp: AFTER_CUT, record_points_atomic: '5' }, envelopeOf('pe_reg', 'coding_session', 'agent_x'));
    fake.store.set(`${CLAIM_LEDGER_COLLECTION}/${claimKeyOf('pe_reg', 'sole')}`, { settled: false });
    expect(await retireLegacyPe(db, 'pe_reg', opts(new Map()))).toEqual({ kind: 'waiting', reason: 'legacy_claim_unsettled' });
    expect(fake.store.has('pe_history/pe_reg')).toBe(true);
  });

  it('an eligible act whose payee cannot resolve is kept as a held act (its earning waits, never lost)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_live', { mint_status: 'eligible', userId: 'agent_x', timestamp: AFTER_CUT, record_points_atomic: '7' }, envelopeOf('pe_live', 'coding_session', 'agent_x'));
    const out = await retireLegacyPe(db, 'pe_live', opts(new Map()));
    expect(out).toMatchObject({ kind: 'retired', held: true, converted: 0 });
    const held = fake.store.get(`${METER_HELD_ACTS_COLLECTION}/pe_live`) as { held_reason: string; key: { row: Record<string, unknown>; pe_hash: string } };
    expect(held.held_reason).toMatch(/^payee_/);
    expect(held.key.row.record_points_atomic).toBe('7');
    expect(held.key.pe_hash).toBe('ab'.repeat(32));
    expect(fake.store.has('pe_history/pe_live')).toBe(false);
  });

  it('an identity-bearing PE moves verbatim to the legacy identity store before its envelope goes', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const env = envelopeOf('pe_birth', 'agent_wallet_created', 'agent_x');
    seed(fake.store, 'pe_birth', { mint_status: 'record_only', userId: 'agent_x' }, env);
    expect(await retireLegacyPe(db, 'pe_birth', opts(new Map()))).toMatchObject({ kind: 'retired', identity: true });
    expect(fake.store.get(`${LEGACY_IDENTITY_PES_COLLECTION}/pe_birth`)).toEqual(env);
    expect(fake.store.has('provenance_envelopes/pe_birth')).toBe(false);
  });

  it('an actor-less envelope whose wallet no longer exists is dropped with nothing folded; RED: one whose wallet exists waits', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const gone = { ...envelopeOf('pe_gone', 'wallet_created', 'x', { wallet_id: 'wallet_wiped' }), user_id: undefined };
    delete (gone as Record<string, unknown>).user_id;
    seed(fake.store, 'pe_gone', null, gone);
    expect(await retireLegacyPe(db, 'pe_gone', opts(new Map()))).toMatchObject({ kind: 'retired', handedBack: false, converted: 0 });
    expect(fake.store.has('provenance_envelopes/pe_gone')).toBe(false);
    expect([...fake.store.keys()].some((k) => k.startsWith(`${ACTOR_METER_TOTALS_COLLECTION}/`))).toBe(false);

    const live = { ...gone, id: 'pe_live', wallet_id: 'wallet_alive' };
    seed(fake.store, 'pe_live', null, live);
    fake.store.set('agent_wallets/wallet_alive', { status: 'active' });
    expect(await retireLegacyPe(db, 'pe_live', opts(new Map()))).toEqual({ kind: 'waiting', reason: 'actor_unknown' });
    expect(fake.store.get('provenance_envelopes/pe_live')).toEqual(live);
  });

  it('a dry run decides and writes nothing', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_dry', { mint_status: 'minted', userId: 'agent_x' }, envelopeOf('pe_dry', 'coding_session', 'agent_x'));
    const before = new Map(fake.store);
    expect(await retireLegacyPe(db, 'pe_dry', opts(new Map(), false))).toMatchObject({ kind: 'retired' });
    expect(new Map(fake.store)).toEqual(before);
  });

  it('an open challenge answered by a pre-meter PE gets the answer\'s outcome on its claim before the envelope goes', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    fake.store.set('commons_challenges/ch_1', {
      challenge_id: 'ch_1', status: 'open',
      answer_claim: { presentation_jti: 'j', claimed_at: 1, answer_pe_id: 'pe_ans' },
    });
    seed(fake.store, 'pe_ans', { mint_status: 'record_only', userId: 'agent_x' }, envelopeOf('pe_ans', 'commons_challenge_answered', 'agent_x', {
      metadata: { challenge_id: 'ch_1', predicate_true: false, presentation_burn_id: 'burn_9' },
    }));
    expect(await retireLegacyPe(db, 'pe_ans', opts(new Map()))).toMatchObject({ kind: 'retired' });
    expect((fake.store.get('commons_challenges/ch_1') as { answer_claim: Record<string, unknown> }).answer_claim)
      .toMatchObject({ answer_pe_id: 'pe_ans', predicate_true: false, answer_burn_id: 'burn_9' });
    expect(fake.store.has('provenance_envelopes/pe_ans')).toBe(false);
  });

  it('RED: an open challenge whose pre-meter answer carries no readable outcome keeps the envelope', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    fake.store.set('commons_challenges/ch_2', {
      challenge_id: 'ch_2', status: 'open',
      answer_claim: { presentation_jti: 'j', claimed_at: 1, answer_pe_id: 'pe_ans2' },
    });
    seed(fake.store, 'pe_ans2', { mint_status: 'record_only', userId: 'agent_x' }, envelopeOf('pe_ans2', 'commons_challenge_answered', 'agent_x', {
      metadata: { challenge_id: 'ch_2' },
    }));
    expect(await retireLegacyPe(db, 'pe_ans2', opts(new Map()))).toEqual({ kind: 'waiting', reason: 'challenge_answer_unreadable' });
    expect(fake.store.has('provenance_envelopes/pe_ans2')).toBe(true);
  });

  it('folds a retired act into its actor\'s and beneficiary\'s running totals once — and RED: a re-run adds nothing', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_x', {
      mint_status: 'minted', userId: 'agent_x', timestamp: AFTER_CUT, attestationDepth: 'hardware_full',
      corroboration_status: 'on_chain', beneficiary_wallet_id: 'user_h',
    }, envelopeOf('pe_x', 'x402_payment', 'agent_x', { metadata: { chain_verified: true, amount_usd: 3 } }));
    await retireLegacyPe(db, 'pe_x', opts(new Map()));
    await retireLegacyPe(db, 'pe_x', opts(new Map()));
    const actor = fake.store.get(`${ACTOR_METER_TOTALS_COLLECTION}/agent_x`) as unknown as ActorMeterTotalsDoc;
    expect(actor.by_attestation_tier).toEqual({ hardware_full: 1 });
    expect(actor.corroborated).toBe(1);
    expect(actor.financial).toMatchObject({ x402_count: 1 });
    const human = fake.store.get(`${ACTOR_METER_TOTALS_COLLECTION}/user_h`) as unknown as ActorMeterTotalsDoc;
    expect(human.beneficiary_acts_by_agent).toEqual({ agent_x: 1 });
  });

  it('RED: the predecessor of a PE with an unsettled legacy claim waits (the approver re-checks the link)', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    seed(fake.store, 'pe_prev', { mint_status: 'minted', userId: 'agent_x' }, envelopeOf('pe_prev', 'coding_session', 'agent_x', { hash: 'cd'.repeat(32) }));
    const out = await retireLegacyPe(db, 'pe_prev', { ...opts(new Map()), predecessorPinned: new Set(['cd'.repeat(32)]) });
    expect(out).toEqual({ kind: 'waiting', reason: 'predecessor_of_unsettled_claim' });
    expect(fake.store.has('provenance_envelopes/pe_prev')).toBe(true);
    expect(await retireLegacyPe(db, 'pe_prev', opts(new Map()))).toMatchObject({ kind: 'retired' });
  });
});
