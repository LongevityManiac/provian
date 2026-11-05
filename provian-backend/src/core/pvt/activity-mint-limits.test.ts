import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  ACTION_TYPE_MINT_RULES,
  activityMintReservationId,
  assertActivityMintReservationEvidence,
  dailyDocId,
  decideActivityMintIdentityWithoutSlot,
  financialIdentityFromMetadata,
  getActionTypeMintRule,
  hashActivityMintReservation,
  reserveActivityMintCaps,
  utcDayKey,
  type ActivityMintReservationDocument,
  type ReservationInput,
} from './activity-mint-limits';
import { decideFinancialEconomicCaps } from './economics/financial-economic-authority';

const USER = 'agent1';
const CP = '0xcccc000000000000000000000000000000000001';
const TS = Date.UTC(2026, 6, 4, 12, 0);
const NEXT_DAY = TS + 24 * 60 * 60 * 1000;
const RESERVATION_PATH = (peId: string) =>
  `activity_mint_reservations/${activityMintReservationId(peId)}`;
const freshAddress = (index: number) => `0x${(index + 1).toString(16).padStart(40, '0')}`;

describe('identity/count-only financial authority', () => {
  it('the per-actor daily ceiling is the only count ', () => {
    // The four ceilings the design requires stay byte-for-byte; the per-pair caps and
    // the vacuous stake ceiling are gone.
    expect(ACTION_TYPE_MINT_RULES).toEqual({
      send: { requiresVerifiedCounterparty: true, dailyMintCeiling: 25 },
      x402_payment: { requiresVerifiedCounterparty: true, dailyMintCeiling: 50 },
      swap: { dailyMintCeiling: 25 },
      receive: { dailyMintCeiling: 50 },
    });
    expect(getActionTypeMintRule('stake')).toBeUndefined();
    expect(getActionTypeMintRule('agent_authorization')).toBeUndefined();
    for (const rule of Object.values(ACTION_TYPE_MINT_RULES)) {
      expect(Object.keys(rule).filter((key) => /counterpart/i.test(key) && key !== 'requiresVerifiedCounterparty'))
        .toEqual([]);
    }
    expect(JSON.stringify(ACTION_TYPE_MINT_RULES)).not.toMatch(/amount|value|price|quote|fiat|exchange/i);
  });

  it('extracts identity while ignoring amount and quote fields regardless of names', () => {
    const a = financialIdentityFromMetadata('send', {
      to_address: CP,
      amount_usd: 0.000001,
      fiatQuote: 1,
      exchangeRatio: 2,
      tokenPrice: 3,
      renamedProviderResult: 4,
    });
    const b = financialIdentityFromMetadata('send', {
      to_address: CP,
      amount_usd: 9_999_999,
      fiatQuote: 100,
      exchangeRatio: 200,
      tokenPrice: 300,
      renamedProviderResult: 400,
    });
    expect(a).toEqual({ counterparty: CP });
    expect(b).toEqual(a);
    expect(financialIdentityFromMetadata('receive', { from: CP, anything: 123 }))
      .toEqual({ counterparty: CP });
    // stake lost its (vacuous) ceiling, NOT its identity: its counterparty still
    // feeds same-owner detection exactly as before.
    expect(financialIdentityFromMetadata('stake', { to: CP })).toEqual({ counterparty: CP });
    expect(financialIdentityFromMetadata('agent_authorization', { to: CP }))
      .toEqual({ counterparty: null });
  });

  it('is behaviorally invariant under differently named external-value inputs', () => {
    const base = {
      counterpartyRequired: true,
      counterpartyVerified: true,
      dailyCount: 3,
      dailyCeiling: 25,
    };
    const low = decideFinancialEconomicCaps({
      ...base,
      arbitraryConvertedMeasure: 0.00001,
    } as Parameters<typeof decideFinancialEconomicCaps>[0]);
    const high = decideFinancialEconomicCaps({
      ...base,
      arbitraryConvertedMeasure: 1_000_000_000,
      anotherVendorMetric: -999,
    } as Parameters<typeof decideFinancialEconomicCaps>[0]);
    expect(high).toEqual(low);
    expect(low).toEqual({ capped: false, reason: null });
  });

  it('no longer reads a per-pair count, even when one is supplied', () => {
    // RED control for a re-introduced pair branch: the retired input names, at
    // and past the retired cap, must not cap.
    const decision = decideFinancialEconomicCaps({
      counterpartyRequired: true,
      counterpartyVerified: true,
      dailyCount: 0,
      dailyCeiling: 25,
      counterpartyCount: 1_000,
      counterpartyCap: 2,
    } as Parameters<typeof decideFinancialEconomicCaps>[0]);
    expect(decision).toEqual({ capped: false, reason: null });
    expect(decideFinancialEconomicCaps({
      counterpartyRequired: true, counterpartyVerified: true, dailyCount: 25, dailyCeiling: 25,
    })).toEqual({ capped: true, reason: 'daily_ceiling' });
  });
});

describe('reserveActivityMintCaps', () => {
  const healthy = (peId: string, overrides: Partial<ReservationInput> = {}): ReservationInput => ({
    peId,
    userId: USER,
    actionType: 'send',
    counterpartyAddress: CP,
    timestampMs: TS,
    ...overrides,
  });

  it('creates value-free evidence for a healthy identity/count decision', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    const result = await reserveActivityMintCaps(db, healthy('pe-healthy'));
    expect(result).toMatchObject({ capped: false, reason: null, idempotent: false });
    expect(result.reservation).not.toHaveProperty('value_usd');
    expect(result.reservation).toMatchObject({
      counterparty: CP, counterparty_slot_consumed: false, daily_slot_consumed: true,
    });
    expect(result.reservationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(assertActivityMintReservationEvidence(result.reservation, {
      peId: 'pe-healthy',
      userId: USER,
      actionType: 'send',
      timestampMs: TS,
      reservationHash: result.reservationHash,
    })).toBe(result.reservation);
  });

  it('fails closed only when required counterparty identity is unverifiable', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    for (const actionType of ['send', 'x402_payment']) {
      await expect(reserveActivityMintCaps(db, {
        ...healthy(`pe-no-counterparty-${actionType}`, { actionType }), counterpartyAddress: null,
      })).resolves.toMatchObject({ capped: true, reason: 'unverifiable_counterparty' });
      await expect(reserveActivityMintCaps(db, {
        ...healthy(`pe-bad-counterparty-${actionType}`, { actionType }), counterpartyAddress: 'not-an-address',
      })).resolves.toMatchObject({ capped: true, reason: 'unverifiable_counterparty' });
    }
    for (const actionType of ['swap', 'receive']) {
      await expect(reserveActivityMintCaps(db, {
        ...healthy(`pe-optional-counterparty-${actionType}`, { actionType }), counterpartyAddress: null,
      })).resolves.toMatchObject({ capped: false, reason: null });
    }
  });

  it('the honest heavy pair mints every act up to the per-actor daily ceiling ', async () => {
    // RED control for the retired pair caps: before the THIRD send and the
    // FOURTH x402_payment to one counterparty were capped `counterparty_cap` for life.
    for (const [actionType, ceiling] of [['send', 25], ['x402_payment', 50]] as const) {
      const fake = createFakeFirestore();
      const db = fake as unknown as Firestore;
      for (let index = 0; index < ceiling; index += 1) {
        await expect(reserveActivityMintCaps(db, healthy(`pe-${actionType}-pair-${index}`, {
          actionType, timestampMs: TS + index,
        }))).resolves.toMatchObject({ capped: false, reason: null });
      }
      await expect(reserveActivityMintCaps(db, healthy(`pe-${actionType}-pair-over`, {
        actionType, timestampMs: TS + ceiling,
      }))).resolves.toMatchObject({ capped: true, reason: 'daily_ceiling' });
      // The same pair mints again the next UTC day: no lifetime count exists.
      await expect(reserveActivityMintCaps(db, healthy(`pe-${actionType}-pair-next-day`, {
        actionType, timestampMs: NEXT_DAY,
      }))).resolves.toMatchObject({ capped: false, reason: null });
      expect([...fake.store.keys()].filter((path) => path.startsWith('activity_mint_counterparty/')))
        .toEqual([]);
    }
  });

  it('bounds one-directional sends to fresh addresses by the per-actor daily count', async () => {
    const db = createFakeFirestore() as unknown as Firestore;
    for (let index = 0; index < 25; index += 1) {
      await expect(reserveActivityMintCaps(db, healthy(`pe-fresh-${index}`, {
        counterpartyAddress: freshAddress(index), timestampMs: TS + index,
      }))).resolves.toMatchObject({ capped: false });
    }
    await expect(reserveActivityMintCaps(db, healthy('pe-fresh-over', {
      counterpartyAddress: freshAddress(25), timestampMs: TS + 25,
    }))).resolves.toMatchObject({ capped: true, reason: 'daily_ceiling' });
  });

  it('keeps each ruled daily ceiling exactly', async () => {
    for (const [actionType, ceiling] of [['send', 25], ['receive', 50], ['swap', 25], ['x402_payment', 50]] as const) {
      const byDay = createFakeFirestore();
      byDay.collection('activity_mint_daily')
        .doc(dailyDocId(USER, actionType, utcDayKey(TS))).set({
          user_id: USER,
          action_type: actionType,
          day_key: utcDayKey(TS),
          count: ceiling - 1,
          updated_at: TS,
        });
      const db = byDay as unknown as Firestore;
      await expect(reserveActivityMintCaps(db, healthy(`pe-${actionType}-last`, { actionType })))
        .resolves.toMatchObject({ capped: false });
      await expect(reserveActivityMintCaps(db, healthy(`pe-${actionType}-over`, { actionType })))
        .resolves.toMatchObject({ capped: true, reason: 'daily_ceiling' });
    }
  });

  it('ignores amount/fiat/exchange/token-quote extras and replays idempotently', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const low = {
      ...healthy('pe-invariant'),
      amount: '1', fiatQuote: 0.01, exchangeRate: 1, tokenQuote: 2,
    } as unknown as ReservationInput;
    const high = {
      ...healthy('pe-invariant'),
      amount: '999999999999', fiatQuote: 999, exchangeRate: 888, tokenQuote: 777,
    } as unknown as ReservationInput;
    const first = await reserveActivityMintCaps(db, low);
    const replay = await reserveActivityMintCaps(db, high);
    expect(replay).toMatchObject({ capped: false, idempotent: true });
    expect(replay.reservationHash).toBe(first.reservationHash);
    expect(fake.store.get(
      `activity_mint_daily/${dailyDocId(USER, 'send', utcDayKey(TS))}`,
    )).toMatchObject({ count: 1 });
  });

  it('serializes concurrent reservations at the daily ceiling', async () => {
    const fake = createFakeFirestore();
    fake.collection('activity_mint_daily')
      .doc(dailyDocId(USER, 'send', utcDayKey(TS))).set({
        user_id: USER, action_type: 'send', day_key: utcDayKey(TS), count: 23, updated_at: TS,
      });
    const db = fake as unknown as Firestore;
    const decisions = await Promise.all([0, 1, 2].map((index) =>
      reserveActivityMintCaps(db, healthy(`pe-concurrent-${index}`, {
        counterpartyAddress: freshAddress(index),
      }))));
    expect(decisions.filter((decision) => !decision.capped)).toHaveLength(2);
    expect(decisions.filter((decision) => decision.reason === 'daily_ceiling')).toHaveLength(1);
  });

  it('replays a reservation sealed capped under the retired pair cap unchanged', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await reserveActivityMintCaps(db, healthy('pe-legacy-capped'));
    const path = RESERVATION_PATH('pe-legacy-capped');
    fake.store.set(path, {
      ...(fake.store.get(path) as Record<string, unknown>),
      decision: 'capped',
      reason: 'counterparty_cap',
      counterparty_slot_consumed: false,
      daily_slot_consumed: false,
    });
    await expect(reserveActivityMintCaps(db, healthy('pe-legacy-capped')))
      .resolves.toMatchObject({ capped: true, reason: 'counterparty_cap', idempotent: true });
  });

  it('is a no-op for non-financial action types and for stake, and fails on corrupt counters', async () => {
    for (const actionType of ['agent_authorization', 'stake']) {
      const noOp = await reserveActivityMintCaps(
        createFakeFirestore() as unknown as Firestore,
        { ...healthy(`pe-nocap-${actionType}`), actionType },
      );
      expect(noOp).toEqual({
        capped: false, reason: null, reservation: null, reservationHash: null, idempotent: false,
      });
    }

    for (const corrupt of [
      { user_id: 'different-user', action_type: 'send', day_key: utcDayKey(TS), count: 0, updated_at: TS },
      // A retired pair-counter shape can never be read as a daily counter.
      { user_id: USER, action_type: 'send', day_key: utcDayKey(TS), counterparty: CP, count: 0, updated_at: TS },
    ]) {
      const fake = createFakeFirestore();
      fake.store.set(`activity_mint_daily/${dailyDocId(USER, 'send', utcDayKey(TS))}`, corrupt);
      await expect(reserveActivityMintCaps(
        fake as unknown as Firestore,
        healthy('pe-corrupt-counter'),
      )).rejects.toThrow('activity_mint_counter_binding_invalid');
      expect(fake.store.has(RESERVATION_PATH('pe-corrupt-counter'))).toBe(false);
    }
  });
});

describe('decideActivityMintIdentityWithoutSlot (a row that can never mint in place)', () => {
  it('fails closed on a send with no verifiable counterparty, exactly as the reservation does', () => {
    expect(decideActivityMintIdentityWithoutSlot({ actionType: 'send', counterpartyAddress: null }))
      .toEqual({ capped: true, reason: 'unverifiable_counterparty' });
    expect(decideActivityMintIdentityWithoutSlot({ actionType: 'send', counterpartyAddress: 'not-an-address' }).capped)
      .toBe(true);
  });
  it('passes a verified counterparty and a swap (no identity requirement), with no slot to book', () => {
    expect(decideActivityMintIdentityWithoutSlot({ actionType: 'send', counterpartyAddress: CP }))
      .toEqual({ capped: false, reason: null });
    expect(decideActivityMintIdentityWithoutSlot({ actionType: 'swap', counterpartyAddress: null }))
      .toEqual({ capped: false, reason: null });
    expect(decideActivityMintIdentityWithoutSlot({ actionType: 'ai_conversation' }))
      .toEqual({ capped: false, reason: null });
  });
});

describe('assertActivityMintReservationEvidence across the boundary', () => {
  const legacy = (actionType: string, slots: { counterparty: boolean; daily: boolean }) => {
    const reservation: ActivityMintReservationDocument = {
      schema_version: 'activity-mint-reservation/v2',
      reservation_id: activityMintReservationId(`pe-legacy-${actionType}`),
      pe_id: `pe-legacy-${actionType}`,
      user_id: USER,
      action_type: actionType,
      timestamp_ms: TS,
      day_key: utcDayKey(TS),
      counterparty: CP,
      input_sha256: 'a'.repeat(64),
      decision: 'reserved',
      reason: null,
      counterparty_slot_consumed: slots.counterparty,
      daily_slot_consumed: slots.daily,
      created_at_ms: TS,
    };
    return () => assertActivityMintReservationEvidence(reservation, {
      peId: reservation.pe_id,
      userId: USER,
      actionType,
      timestampMs: TS,
      reservationHash: hashActivityMintReservation(reservation),
    });
  };

  it('still settles a send/x402 reserved before with its pair slot consumed', () => {
    for (const actionType of ['send', 'x402_payment']) {
      expect(legacy(actionType, { counterparty: true, daily: true })).not.toThrow();
      expect(legacy(actionType, { counterparty: false, daily: true })).not.toThrow();
    }
  });

  it('refuses a pair slot on a type that never had one, and a missing daily slot', () => {
    for (const actionType of ['receive', 'swap']) {
      expect(legacy(actionType, { counterparty: true, daily: true }))
        .toThrow('activity_mint_reservation_slot_mismatch');
    }
    expect(legacy('send', { counterparty: false, daily: false }))
      .toThrow('activity_mint_reservation_slot_mismatch');
    expect(legacy('stake', { counterparty: false, daily: true }))
      .toThrow('activity_mint_reservation_slot_mismatch');
  });
});
