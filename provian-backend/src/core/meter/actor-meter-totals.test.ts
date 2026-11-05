/**
 * The PE meter's per-actor running totals (`actor_meter_totals_v1`), day counters and network
 * hour counters: the pure fold the meter commit applies at seal, and the fixed-size readers.
 *
 * RED controls, each beside its positive twin: a device-authored act never yields a financial
 * fact; an unsolicited or undecided receive never counts; a held act's fact waits for release;
 * an act never credits its own actor as beneficiary; the readers never reach outside their
 * window.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { actFactsOf } from './meter-act-key';
import {
  ACTOR_METER_DAYS_COLLECTION,
  ACTOR_METER_TOTALS_COLLECTION,
  HOUR_MS,
  NETWORK_METER_HOURS_COLLECTION,
  NETWORK_METER_HOUR_SHARDS,
  actorActIncrementOf,
  actorDayIncrementOf,
  actorMeterDayDocId,
  applyActorActIncrement,
  applyBeneficiaryAct,
  applyFinancialFact,
  beneficiaryOf,
  coerceActorMeterTotals,
  emptyFinancialTotals,
  financialFactCounts,
  financialFactOf,
  networkMeterHourDocId,
  readActorMeterTotals,
  readActorMeterWindow,
  readNetworkMeter24h,
  utcDay,
} from './actor-meter-totals';

const ADDR = '0xAbC0000000000000000000000000000000000001';
const T = Date.parse('2026-10-02T10:00:00Z');

describe('financialFactOf — relay-stamped flags only', () => {
  it('maps each watcher/transfer kind', () => {
    expect(financialFactOf('receive', { activity_mapped: true, amount_usd: 5 }, ADDR)).toMatchObject({ kind: 'usdc_inbound', amount_usd: 5, actor_address: ADDR.toLowerCase() });
    expect(financialFactOf('x402_payment', { chain_verified: true, amount_usd: 1 }, null)).toMatchObject({ kind: 'x402', actor_address: null });
    for (const t of ['send', 'swap', 'stake']) {
      expect(financialFactOf(t, { chain_verified: true, amount_usd: 2 }, ADDR)?.kind).toBe('usdc_outbound');
    }
    expect(financialFactOf('agent_token_transfer', { verified: true, currency: 'USDC', amount_atomic: '1500000' }, ADDR))
      .toMatchObject({ kind: 'verified_transfer', currency: 'usdc', amount_usd: 1.5 });
    expect(financialFactOf('agent_native_transfer', { verified: true }, ADDR)).toMatchObject({ currency: 'eth', amount_usd: 0 });
  });

  // RED CONTROL: without the relay's stamp there is no fact; a negative or non-finite figure is 0.
  it('refuses unstamped, unknown, or malformed acts', () => {
    expect(financialFactOf('receive', { amount_usd: 5 }, ADDR)).toBeNull();
    expect(financialFactOf('send', { chain_verified: 'true', amount_usd: 5 }, ADDR)).toBeNull();
    expect(financialFactOf('agent_token_transfer', { verified: false }, ADDR)).toBeNull();
    expect(financialFactOf('coding_session', { chain_verified: true }, ADDR)).toBeNull();
    expect(financialFactOf('receive', { activity_mapped: true, amount_usd: -9 }, ADDR)?.amount_usd).toBe(0);
    expect(financialFactOf('receive', { activity_mapped: true, amount_usd: Number.POSITIVE_INFINITY }, ADDR)?.amount_usd).toBe(0);
  });

  // RED CONTROL: the lane gate — a device's metadata is never trusted for a financial fact.
  it('actFactsOf attaches a fact only to a relay-authored act', () => {
    const act = { action_type: 'x402_payment', timestamp: T, pricing: { metadata: { chain_verified: true, amount_usd: 3 }, actor_address: ADDR } };
    expect(actFactsOf(act, { actorId: 'a', relayAuthored: true }).financial?.kind).toBe('x402');
    expect(actFactsOf(act, { actorId: 'a' }).financial).toBeUndefined();
    expect(actFactsOf(act, { actorId: 'a', relayAuthored: false }).financial).toBeUndefined();
  });
});

describe(' counting and the fold', () => {
  const inbound = financialFactOf('receive', { activity_mapped: true, amount_usd: 40 }, ADDR)!;

  it('a receive counts only with a known, non-unsolicited disposition', () => {
    expect(financialFactCounts(inbound, { disposition_reason_code: 'policy_eligible' })).toBe(true);
    expect(financialFactCounts(inbound, { disposition_reason_code: 'unsolicited_receive_record_only' })).toBe(false);
    expect(financialFactCounts(inbound, { disposition_reason_code: '' })).toBe(false);
    expect(financialFactCounts(inbound, {})).toBe(false);
    const x402 = financialFactOf('x402_payment', { chain_verified: true }, ADDR)!;
    expect(financialFactCounts(x402, {})).toBe(true);
  });

  it('actorActIncrementOf withholds the fact while held and when unsolicited', () => {
    const row = { userId: 'a', timestamp: T, attestationDepth: 'software', corroboration_status: 'none', disposition_reason_code: 'policy_eligible' };
    expect(actorActIncrementOf(row, { financial: inbound }, false)?.financial).toBe(inbound);
    expect(actorActIncrementOf(row, { financial: inbound }, true)?.financial).toBeNull();
    expect(actorActIncrementOf({ ...row, disposition_reason_code: 'unsolicited_receive_record_only' }, { financial: inbound }, false)?.financial).toBeNull();
    expect(actorActIncrementOf({ ...row, userId: '' }, null, false)).toBeNull();
  });

  it('applyActorActIncrement counts tiers, corroboration and per-address totals', () => {
    let doc = coerceActorMeterTotals('a', null);
    const row = { userId: 'a', timestamp: T, attestationDepth: 'hardware_full', corroboration_status: 'on_chain_verified', disposition_reason_code: 'policy_eligible' };
    doc = applyActorActIncrement(doc, actorActIncrementOf(row, { financial: inbound }, false)!, T);
    doc = applyActorActIncrement(doc, actorActIncrementOf({ ...row, attestationDepth: 'software', corroboration_status: 'none', timestamp: T - 1000 }, null, false)!, T);
    expect(doc.by_attestation_tier).toEqual({ hardware_full: 1, software: 1 });
    expect(doc.corroborated).toBe(1);
    expect(doc.financial.inbound_count).toBe(1);
    expect(doc.financial.inbound_usd).toBe(40);
    expect(doc.financial_by_address[ADDR.toLowerCase()].inbound_count).toBe(1);
    expect(doc.financial.first_at_ms).toBe(T);
  });

  it('an x402 settlement is also an outbound transfer; first/last bracket the acts', () => {
    const x402 = financialFactOf('x402_payment', { chain_verified: true, amount_usd: 2 }, null)!;
    let t = applyFinancialFact(emptyFinancialTotals(), x402, 2000);
    t = applyFinancialFact(t, x402, 1000);
    expect(t).toMatchObject({ x402_count: 2, outbound_count: 2, outbound_usd: 4, first_at_ms: 1000, last_at_ms: 2000 });
  });

  it('beneficiary acts accrue to the human per agent; an act never credits its own actor (RED)', () => {
    expect(beneficiaryOf({ userId: 'agent', beneficiary_wallet_id: 'human' })).toEqual({ humanId: 'human', agentId: 'agent' });
    expect(beneficiaryOf({ userId: 'human', beneficiary_wallet_id: 'human' })).toBeNull();
    expect(beneficiaryOf({ userId: 'agent', beneficiary_wallet_id: null })).toBeNull();
    let human = coerceActorMeterTotals('human', null);
    human = applyBeneficiaryAct(applyBeneficiaryAct(human, 'agent', T), 'agent', T);
    expect(human.beneficiary_acts_by_agent).toEqual({ agent: 2 });
  });

  it('coerce discards malformed stored values (never NaN, never negative)', () => {
    const doc = coerceActorMeterTotals('a', {
      by_attestation_tier: { software: 'x', hardware: 2 },
      corroborated: -4,
      financial: { inbound_count: Number.NaN, outbound_usd: 3 },
      financial_by_address: { [ADDR.toLowerCase()]: 'junk' },
    });
    expect(doc.by_attestation_tier).toEqual({ hardware: 2 });
    expect(doc.corroborated).toBe(0);
    expect(doc.financial.inbound_count).toBe(0);
    expect(doc.financial.outbound_usd).toBe(3);
    expect(doc.financial_by_address[ADDR.toLowerCase()]).toEqual(emptyFinancialTotals());
  });
});

describe('day and hour counters', () => {
  it('actorDayIncrementOf counts participation agent actions and corroborated acts only', () => {
    expect(actorDayIncrementOf({ userId: 'a', timestamp: T, actionType: 'agent_action', corroboration_status: 'none' }))
      .toMatchObject({ day: utcDay(T), agentActions: 1, corroborated: 0 });
    expect(actorDayIncrementOf({ userId: 'a', timestamp: T, actionType: 'coding_session', corroboration_status: 'peer_verified' }))
      .toMatchObject({ agentActions: 0, corroborated: 1 });
    expect(actorDayIncrementOf({ userId: 'a', timestamp: T, actionType: 'coding_session', corroboration_status: 'none' })).toBeNull();
    expect(actorDayIncrementOf({ userId: 'a', actionType: 'agent_action' })).toBeNull();
    expect(actorDayIncrementOf({ userId: 'a', timestamp: T, actionType: 'agent_task_completed', corroboration_status: 'none' })).toBeNull();
  });

  it('readActorMeterWindow sums exactly the last N days (RED: day N+1 is not read)', async () => {
    const fake = createFakeFirestore();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 32; i += 1) {
      fake.store.set(`${ACTOR_METER_DAYS_COLLECTION}/${actorMeterDayDocId('a', utcDay(T - i * day))}`, { agent_actions: 1, corroborated: 2 });
    }
    fake.store.set(`${ACTOR_METER_DAYS_COLLECTION}/${actorMeterDayDocId('b', utcDay(T))}`, { agent_actions: 50, corroborated: 50 });
    expect(await readActorMeterWindow(fake as unknown as Firestore, 'a', T, 30)).toEqual({ agentActions: 30, corroborated: 60 });
    expect(await readActorMeterWindow(fake as unknown as Firestore, 'a', T, 7)).toEqual({ agentActions: 7, corroborated: 14 });
    // Clamped to the 31-day act-key window.
    expect(await readActorMeterWindow(fake as unknown as Firestore, 'a', T, 400)).toEqual({ agentActions: 31, corroborated: 62 });
  });

  it('readNetworkMeter24h sums every shard of the current and previous 23 hours only', async () => {
    const fake = createFakeFirestore();
    const hour = Math.floor(T / HOUR_MS);
    for (let h = 0; h < 25; h += 1) {
      for (let s = 0; s < NETWORK_METER_HOUR_SHARDS; s += 1) {
        fake.store.set(`${NETWORK_METER_HOURS_COLLECTION}/${networkMeterHourDocId(hour - h, s)}`, { hour: hour - h, count: 1 });
      }
    }
    // 24 hours × 16 shards; the 25th hour back is outside the window (RED).
    expect(await readNetworkMeter24h(fake as unknown as Firestore, T)).toBe(24 * NETWORK_METER_HOUR_SHARDS);
  });

  it('readActorMeterTotals answers an empty document for an unknown actor', async () => {
    const fake = createFakeFirestore();
    fake.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/known`, { corroborated: 3 });
    expect((await readActorMeterTotals(fake as unknown as Firestore, 'known')).corroborated).toBe(3);
    const unknown = await readActorMeterTotals(fake as unknown as Firestore, 'unknown');
    expect(unknown.corroborated).toBe(0);
    expect(unknown.financial).toEqual(emptyFinancialTotals());
  });
});
