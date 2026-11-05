/**
 * `summarizeChainVerifiedActivity` — the public financial-activity summary, read from the actor's
 * running totals (`actor_meter_totals_v1`) on the PE meter.
 *
 * Every fixture goes through the PRODUCTION fold the meter commit runs at seal
 * (`actFactsOf` → `actorActIncrementOf` → `applyActorActIncrement`), so the test cannot assert a
 * property of a hand-built totals document. Each exclusion arm is a RED CONTROL — it is seeded
 * beside a counted act of the same shape, so an implementation that counted everything (or
 * nothing) fails it.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { actFactsOf } from '../meter/meter-act-key';
import {
  ACTOR_METER_TOTALS_COLLECTION,
  actorActIncrementOf,
  applyActorActIncrement,
  applyReleasedFinancialFact,
  coerceActorMeterTotals,
  financialFactCounts,
  type ActorMeterTotalsDoc,
} from '../meter/actor-meter-totals';
import { summarizeChainVerifiedActivity } from './financial-activity';

const AGENT_1 = 'agent_1';
const ADDR_A = '0xaaaa000000000000000000000000000000000001';
const ADDR_B = '0xbbbb000000000000000000000000000000000002';

interface ActInput {
  actionType: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  dispositionReasonCode?: string | null;
  actorAddress?: string | null;
  relayAuthored?: boolean;
  held?: boolean;
}

/** Fold one act into the agent's totals exactly as `meter-commit` does at seal. */
function fold(prior: ActorMeterTotalsDoc, act: ActInput): ActorMeterTotalsDoc {
  const facts = actFactsOf(
    { action_type: act.actionType, timestamp: act.timestamp, pricing: { metadata: act.metadata, actor_address: act.actorAddress ?? ADDR_A } },
    { actorId: AGENT_1, relayAuthored: act.relayAuthored ?? true },
  );
  const row: Record<string, unknown> = {
    userId: AGENT_1,
    actionType: act.actionType,
    timestamp: act.timestamp,
    attestationDepth: 'software',
    corroboration_status: 'none',
    disposition_reason_code: act.dispositionReasonCode ?? null,
  };
  const inc = actorActIncrementOf(row, facts, act.held === true);
  if (inc === null) throw new Error('fixture row must produce an increment');
  return applyActorActIncrement(prior, inc, act.timestamp);
}

function seedTotals(db: FakeFirestore, acts: ActInput[]): ActorMeterTotalsDoc {
  let totals = coerceActorMeterTotals(AGENT_1, null);
  for (const act of acts) totals = fold(totals, act);
  db.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/${AGENT_1}`, totals as unknown as Record<string, unknown>);
  return totals;
}

const receive = (amountUsd: number, timestamp: number, code: string | null, extra: Partial<ActInput> = {}): ActInput => ({
  actionType: 'receive',
  metadata: { activity_mapped: true, amount_usd: amountUsd },
  timestamp,
  dispositionReasonCode: code,
  ...extra,
});

const summarize = (db: FakeFirestore, options?: { addressFilter?: string }) =>
  summarizeChainVerifiedActivity(db as unknown as Firestore, AGENT_1, options);

describe('summarizeChainVerifiedActivity — read from running totals', () => {
  it('an identity with no totals document reports the empty summary', async () => {
    const db = createFakeFirestore();
    const summary = await summarize(db);
    expect(summary.usdc.inbound_count).toBe(0);
    expect(summary.first_activity_at).toBeNull();
    expect(summary.chain_verified_only).toBe(true);
  });

  it('counts a receive whose disposition is NOT the unsolicited reason code', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [receive(50, 1000, 'policy_eligible')]);
    const summary = await summarize(db);
    expect(summary.usdc.inbound_count).toBe(1);
    expect(summary.usdc.inbound_volume_bucket).toBe('10_100');
    expect(summary.first_activity_at).toBe(1000);
  });

  // RED CONTROL : beside a counted receive, an unsolicited one adds nothing — not its
  // count, not its $5000 volume, not its timestamp.
  it('excludes a receive whose disposition IS unsolicited_receive_record_only', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [
      receive(20, 1000, 'policy_eligible'),
      receive(5000, 2000, 'unsolicited_receive_record_only'),
    ]);
    const summary = await summarize(db);
    expect(summary.usdc.inbound_count).toBe(1);
    expect(summary.usdc.inbound_volume_bucket).toBe('10_100');
    expect(summary.last_activity_at).toBe(1000);
  });

  // RED CONTROL: fail closed on a missing disposition.
  it('excludes a receive with NO disposition (fail closed, not counted)', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [receive(75, 1000, null)]);
    expect((await summarize(db)).usdc.inbound_count).toBe(0);
  });

  // RED CONTROL: a held receive is not counted while held; it is counted once when it leaves the
  // hold with a non-unsolicited disposition (the `held-acts.ts` release path), never twice.
  it('a HELD receive counts only when released, exactly once', async () => {
    const db = createFakeFirestore();
    const held = seedTotals(db, [receive(30, 1000, 'policy_eligible', { held: true })]);
    expect((await summarize(db)).usdc.inbound_count).toBe(0);

    const facts = actFactsOf(
      { action_type: 'receive', timestamp: 1000, pricing: { metadata: { activity_mapped: true, amount_usd: 30 }, actor_address: ADDR_A } },
      { actorId: AGENT_1, relayAuthored: true },
    );
    const fact = facts.financial;
    if (fact === undefined) throw new Error('relay-authored receive must carry a financial fact');
    expect(financialFactCounts(fact, { disposition_reason_code: 'policy_eligible' })).toBe(true);
    expect(financialFactCounts(fact, { disposition_reason_code: 'unsolicited_receive_record_only' })).toBe(false);
    const released = applyReleasedFinancialFact(held, fact, 1000, 2000);
    db.store.set(`${ACTOR_METER_TOTALS_COLLECTION}/${AGENT_1}`, released as unknown as Record<string, unknown>);
    expect((await summarize(db)).usdc.inbound_count).toBe(1);
  });

  // RED CONTROL: a DEVICE-authored act carrying the same metadata flags never becomes a financial
  // fact — the flags are trusted only on the relay's own acts.
  it('a device-authored act with chain_verified metadata is NOT counted', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [
      { actionType: 'x402_payment', metadata: { chain_verified: true, amount_usd: 3 }, timestamp: 1000, relayAuthored: false },
      receive(5, 1100, 'policy_eligible', { relayAuthored: false }),
    ]);
    const summary = await summarize(db);
    expect(summary.x402.settlements_observed).toBe(0);
    expect(summary.usdc.inbound_count).toBe(0);
    expect(summary.first_activity_at).toBeNull();
  });

  it('an x402 settlement counts as an x402 settlement AND an outbound USDC transfer', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [{ actionType: 'x402_payment', metadata: { chain_verified: true, amount_usd: 3 }, timestamp: 1000 }]);
    const summary = await summarize(db);
    expect(summary.x402.settlements_observed).toBe(1);
    expect(summary.x402.volume_bucket).toBe('under_10');
    expect(summary.usdc.outbound_count).toBe(1);
  });

  it('verified transfers are counted by currency; an unverified one is not', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [
      { actionType: 'agent_token_transfer', metadata: { verified: true, currency: 'USDC', amount_atomic: '250000000' }, timestamp: 1000 },
      { actionType: 'agent_native_transfer', metadata: { verified: true }, timestamp: 1100 },
      { actionType: 'agent_token_transfer', metadata: { verified: false, currency: 'USDC', amount_atomic: '1' }, timestamp: 1200 },
    ]);
    const summary = await summarize(db);
    expect(summary.verified_transfers.count).toBe(2);
    expect(summary.verified_transfers.by_currency).toEqual({ usdc: 1, eth: 1 });
    expect(summary.usdc.outbound_volume_bucket).toBe('100_1k');
    expect(summary.last_activity_at).toBe(1100);
  });

  // RED CONTROL: the address filter returns only the named address's events, and an address
  // with none reports empty (never the all-address totals).
  it('the address filter reads the per-address totals only', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [
      receive(20, 1000, 'policy_eligible', { actorAddress: ADDR_A }),
      receive(500, 2000, 'policy_eligible', { actorAddress: ADDR_B }),
    ]);
    expect((await summarize(db)).usdc.inbound_count).toBe(2);
    const a = await summarize(db, { addressFilter: ADDR_A.toUpperCase().replace('0X', '0x') });
    expect(a.usdc.inbound_count).toBe(1);
    expect(a.usdc.inbound_volume_bucket).toBe('10_100');
    const b = await summarize(db, { addressFilter: ADDR_B });
    expect(b.usdc.inbound_volume_bucket).toBe('100_1k');
    const none = await summarize(db, { addressFilter: '0xcccc000000000000000000000000000000000003' });
    expect(none.usdc.inbound_count).toBe(0);
  });

  it('a totals read failure reports the empty summary (never a guess)', async () => {
    const db = createFakeFirestore();
    seedTotals(db, [receive(20, 1000, 'policy_eligible')]);
    const realCollection = db.collection.bind(db);
    jest.spyOn(db, 'collection').mockImplementation(((name: string) => {
      if (name === ACTOR_METER_TOTALS_COLLECTION) {
        return { doc: () => ({ get: async () => { throw new Error('firestore_unavailable_test'); } }) } as never;
      }
      return realCollection(name);
    }) as never);
    expect((await summarize(db)).usdc.inbound_count).toBe(0);
  });

  it('never reads pe_history or provenance_envelopes (a planted legacy receive is ignored)', async () => {
    const db = createFakeFirestore();
    db.store.set('provenance_envelopes/pe_legacy', {
      user_id: AGENT_1, action_type: 'receive', timestamp: 1000, metadata: { activity_mapped: true, amount_usd: 50 },
    });
    db.store.set('pe_history/pe_legacy', { disposition_reason_code: 'policy_eligible' });
    expect((await summarize(db)).usdc.inbound_count).toBe(0);
  });
});
