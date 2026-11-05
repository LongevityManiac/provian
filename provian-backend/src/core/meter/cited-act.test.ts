/**
 * PE METER — a cited act's facts come from the act key, an identity act, or a presented proof;
 * never from `pe_history` / `provenance_envelopes`. Each source has a RED control.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { parsePresentedPeProofs, resolveCitedAct } from './cited-act';
import { buildIdentityAct, IDENTITY_ACTS_COLLECTION } from './identity-acts';
import { METER_ACT_KEYS_COLLECTION, meterRelayPeId, relayDeviceId } from './meter-store';
import { actRecordOf, PE_V2_SCHEMA, type PeV2 } from './meter-wire';
import { presentedPeFixture } from './__test-helpers__/presented-pe';

const noChain = { anchorContract: null };

function db(fs: FakeFirestore): Firestore {
  return fs as unknown as Firestore;
}

function seedActKey(fs: FakeFirestore, peId: string, extra: Record<string, unknown> = {}): void {
  fs.store.set(`${METER_ACT_KEYS_COLLECTION}/${peId}`, {
    relay_pe_id: peId,
    actor_id: 'agent_1',
    action_type: 'escrow_completed',
    timestamp: 1_700_000_000_000,
    facts: {
      action_type: 'escrow_completed',
      wallet_id: 'wallet_1',
      user_id: 'agent_1',
      timestamp: 1_700_000_000_000,
      counterparty_address: '0xAbC',
      actor_address: '0xdef',
      job_id: null,
      promise_id: null,
    },
    ...extra,
  });
}

function identityActDoc(actorId: string, walletId: string) {
  const pe: PeV2 = {
    schema: PE_V2_SCHEMA,
    pe_id: 'pe_identity_1',
    device_id: relayDeviceId(actorId),
    prev_hash: '0'.repeat(64),
    timestamp: 1_690_000_000_000,
    action_type: 'agent_linked_to_human',
    wallet_id: walletId,
    agent_id: actorId,
    actor_address: '0x1111111111111111111111111111111111111111',
    metadata: { linked_human_user_id: 'human_1' },
  };
  return buildIdentityAct({ actorId, walletId, policyActionType: pe.action_type, act: actRecordOf(pe), nowMs: 1 });
}

describe('resolveCitedAct', () => {
  it('reads the act key facts for an act inside its 31 days', async () => {
    const fs = createFakeFirestore();
    seedActKey(fs, 'pe_relay_1');
    const r = await resolveCitedAct(db(fs), 'pe_relay_1', null, noChain);
    expect(r).toEqual({
      status: 'found',
      facts: expect.objectContaining({
        relay_pe_id: 'pe_relay_1', user_id: 'agent_1', wallet_id: 'wallet_1', counterparty_address: '0xAbC', source: 'act_key',
      }),
    });
  });

  it('an act key sealed before facts still names its actor, and nothing else', async () => {
    const fs = createFakeFirestore();
    seedActKey(fs, 'pe_relay_old', { facts: null });
    const r = await resolveCitedAct(db(fs), 'pe_relay_old', null, noChain);
    expect(r.status === 'found' && r.facts).toMatchObject({ user_id: 'agent_1', wallet_id: null, counterparty_address: null });
  });

  it('reads an identity act whose hash re-derives; RED: a tampered one is refused, never believed', async () => {
    const fs = createFakeFirestore();
    const doc = identityActDoc('agent_9', 'wallet_9');
    fs.store.set(`${IDENTITY_ACTS_COLLECTION}/pe_identity_1`, { ...doc });
    const ok = await resolveCitedAct(db(fs), 'pe_identity_1', null, noChain);
    expect(ok.status === 'found' && ok.facts).toMatchObject({ user_id: 'agent_9', wallet_id: 'wallet_9', source: 'identity_act' });

    fs.store.set(`${IDENTITY_ACTS_COLLECTION}/pe_identity_1`, {
      ...doc,
      act: { ...doc.act, pricing: { ...doc.act.pricing, wallet_id: 'wallet_forged' } },
    });
    expect(await resolveCitedAct(db(fs), 'pe_identity_1', null, noChain))
      .toEqual({ status: 'refused', http: 500, reason: 'identity_act_integrity' });
  });

  it('RED: a legacy pe_history / provenance_envelopes copy is NOT a source (the relay keeps no PE)', async () => {
    const fs = createFakeFirestore();
    fs.store.set('provenance_envelopes/pe_legacy', { user_id: 'agent_1', wallet_id: 'wallet_1' });
    fs.store.set('pe_history/pe_legacy', { userId: 'agent_1', peHash: 'f'.repeat(64) });
    expect(await resolveCitedAct(db(fs), 'pe_legacy', null, noChain)).toEqual({ status: 'not_found' });
  });

  it('proves a presented PE against the anchored root and takes its facts from the proven PE', async () => {
    const fs = createFakeFirestore();
    const fx = presentedPeFixture({
      actorId: 'agent_old',
      fields: { wallet_id: 'wallet_old', counterparty_address: '0xCAFE' },
    });
    const r = await resolveCitedAct(db(fs), fx.pe.pe_id, fx.proof, { anchorContract: fx.anchorContract });
    expect(r).toEqual({
      status: 'found',
      facts: expect.objectContaining({
        relay_pe_id: meterRelayPeId(fx.peHash),
        user_id: 'agent_old',
        wallet_id: 'wallet_old',
        counterparty_address: '0xCAFE',
        source: 'presented',
      }),
    });
    // The relay's own id for it resolves the same proof.
    const byRelayId = await resolveCitedAct(db(fs), meterRelayPeId(fx.peHash), fx.proof, { anchorContract: fx.anchorContract });
    expect(byRelayId.status).toBe('found');
  });

  it('RED: a presented proof never stands in for a different cited PE, nor proves unanchored', async () => {
    const fs = createFakeFirestore();
    const fx = presentedPeFixture({ actorId: 'agent_old' });
    expect(await resolveCitedAct(db(fs), 'pe_someone_elses', fx.proof, { anchorContract: fx.anchorContract }))
      .toEqual({ status: 'refused', http: 409, reason: 'presented_pe_is_not_the_cited_pe' });
    expect(await resolveCitedAct(db(fs), fx.pe.pe_id, fx.proof, { anchorContract: { verifyPE: async () => false } }))
      .toEqual({ status: 'refused', http: 409, reason: 'pe_not_anchored' });
    const edited = { ...fx.proof, pe: { ...fx.pe, wallet_id: 'wallet_forged' } };
    expect(await resolveCitedAct(db(fs), fx.pe.pe_id, edited, { anchorContract: fx.anchorContract }))
      .toEqual({ status: 'refused', http: 409, reason: 'pe_hash_mismatch' });
  });

  it('an act the relay still sees never needs (or uses) a presented proof', async () => {
    const fs = createFakeFirestore();
    seedActKey(fs, 'pe_relay_1');
    const fx = presentedPeFixture({ actorId: 'someone_else' });
    const r = await resolveCitedAct(db(fs), 'pe_relay_1', { ...fx.proof, pe_id: 'pe_relay_1' }, { anchorContract: null });
    expect(r.status === 'found' && r.facts.source).toBe('act_key');
  });
});

describe('parsePresentedPeProofs', () => {
  it('maps entries by cited id; RED: a malformed entry refuses the whole body', () => {
    const fx = presentedPeFixture({ actorId: 'a' });
    expect(parsePresentedPeProofs(undefined, 5)?.size).toBe(0);
    expect(parsePresentedPeProofs([fx.proof], 5)?.get(fx.pe.pe_id)?.envelope_hash).toBe(fx.peHash);
    expect(parsePresentedPeProofs([{ pe_id: 'x', envelope_hash: 'nothex' }], 5)).toBeNull();
    expect(parsePresentedPeProofs('nope', 5)).toBeNull();
    expect(parsePresentedPeProofs([fx.proof, fx.proof], 1)).toBeNull();
  });
});
