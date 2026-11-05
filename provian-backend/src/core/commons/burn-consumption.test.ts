/**
 * work package shared burn-consumption ledger + minimum-burn floor (Part 1,
 *) — unit tests + RED controls.
 *
 * The ledger's job is the GLOBAL single-use fence, the caller's-own-verified
 * burn fence, AND the per-action minimum-burn floor. Each is exercised with a
 * permanent RED control that a source mutation reddens :
 * - assertBurnRowUsable refuses a missing / pending / unverified / foreign burn,
 * refuses a SUB-FLOOR burn, and ACCEPTS a recorded+verified+owned+at-floor
 * one (non-vacuous).
 * - buildBurnConsumptionMarker always keys the marker to the burn_id (the field
 * that makes consumption global-single-use).
 * - resolveBurnFloorAtomic returns the launch literal by default, the scheduled
 * override when set and in-bound, and falls back on an out-of-bound override.
 * - scheduleBurnFloor refuses a floor above BURN_FLOOR_MAX_ATOMIC.
 * The atomic "second spend refuses" property is proven end-to-end in each
 * product's own suite (name-registry.test.ts, …), since it depends on the
 * product's transaction; here we prove the primitives the products share.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  assertBurnRowUsable,
  buildBurnConsumptionMarker,
  isBurnId,
  isBurnProduct,
  BurnConsumptionError,
  BURN_CONSUMPTIONS_COLLECTION,
  BURN_ID_RE,
  BURN_PRODUCTS,
  BURN_FLOOR_LAUNCH_LITERALS,
  BURN_FLOOR_MAX_ATOMIC,
  INSUFFICIENT_BURN_AMOUNT,
  parseAmountAtomic,
  isValidScheduledFloor,
  resolveBurnFloorAtomic,
  resolvePresentationFloorAtomic,
  PRESENTATION_FLOOR_BY_TIER,
  PRESENTATION_FLOOR_POLICY_DOC,
  scheduleBurnFloor,
} from './burn-consumption';

const ONE_PVT = 1_000_000_000_000_000_000n;
// A burn row at/above every launch floor (15 PVT), owned by aw1, verified.
const OK_BURN = {
  status: 'recorded',
  verified: true,
  wallet_id: 'aw1',
  chain: 'base',
  amount_atomic: (15n * ONE_PVT).toString(),
};

describe('assertBurnRowUsable', () => {
  it('accepts a recorded, verified, owned, at-floor burn (non-vacuous: no throw)', () => {
    expect(() => assertBurnRowUsable({ ...OK_BURN }, 'aw1', 15n * ONE_PVT)).not.toThrow();
  });

  it('RED missing burn → 404', () => {
    try { assertBurnRowUsable(undefined, 'aw1', 0n); throw new Error('should have thrown'); }
    catch (e) { expect(e).toBeInstanceOf(BurnConsumptionError); expect((e as BurnConsumptionError).status).toBe(404); }
  });

  it('RED pending / unverified burn → 409', () => {
    for (const bad of [
      { ...OK_BURN, status: 'pending' },
      { ...OK_BURN, verified: false },
      { ...OK_BURN, verified: undefined },
    ]) {
      try { assertBurnRowUsable(bad, 'aw1', 0n); throw new Error('should have thrown'); }
      catch (e) { expect(e).toBeInstanceOf(BurnConsumptionError); expect((e as BurnConsumptionError).status).toBe(409); }
    }
  });

  it('RED foreign burn (wrong owner) → 403', () => {
    try { assertBurnRowUsable({ ...OK_BURN, wallet_id: 'aw2' }, 'aw1', 0n); throw new Error('should have thrown'); }
    catch (e) { expect(e).toBeInstanceOf(BurnConsumptionError); expect((e as BurnConsumptionError).status).toBe(403); }
  });

  // ─── minimum-burn floor (Part 1) — the RED control for the floor check ───────
  it('RED sub-floor burn → 400 INSUFFICIENT_BURN_AMOUNT; at-floor and above pass', () => {
    const floor = 15n * ONE_PVT;
    // sub-floor (14.999… PVT) refuses
    try {
      assertBurnRowUsable({ ...OK_BURN, amount_atomic: (floor - 1n).toString() }, 'aw1', floor);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BurnConsumptionError);
      expect((e as BurnConsumptionError).status).toBe(400);
      expect((e as BurnConsumptionError).message).toBe(INSUFFICIENT_BURN_AMOUNT);
    }
    // exactly at floor passes (floor is a minimum, not a strict-greater bound)
    expect(() => assertBurnRowUsable({ ...OK_BURN, amount_atomic: floor.toString() }, 'aw1', floor)).not.toThrow();
    // above floor passes
    expect(() => assertBurnRowUsable({ ...OK_BURN, amount_atomic: (floor + ONE_PVT).toString() }, 'aw1', floor)).not.toThrow();
  });

  it('a missing/malformed amount fails a positive floor (fail-closed) but passes a 0 floor', () => {
    // fail-closed: no amount → parsed 0 → refused when a positive floor applies
    try {
      assertBurnRowUsable({ status: 'recorded', verified: true, wallet_id: 'aw1' }, 'aw1', ONE_PVT);
      throw new Error('should have thrown');
    } catch (e) { expect((e as BurnConsumptionError).status).toBe(400); }
    // a 0 floor (export/subscription) never rejects on amount
    expect(() => assertBurnRowUsable({ status: 'recorded', verified: true, wallet_id: 'aw1' }, 'aw1', 0n)).not.toThrow();
  });
});

describe('minimum-burn floor literals + bound', () => {
  it('launch literals: 15 PVT on name/vouch/pledge/presentation, 0 on export/subscription', () => {
    expect(BURN_FLOOR_LAUNCH_LITERALS.name_registry).toBe(15n * ONE_PVT);
    expect(BURN_FLOOR_LAUNCH_LITERALS.vouch).toBe(15n * ONE_PVT);
    expect(BURN_FLOOR_LAUNCH_LITERALS.pledge).toBe(15n * ONE_PVT);
    // burn-to-present: a presentation is a deliberate, costly disclosure act,
    // priced at the SAME nonzero filing-fee-family literal (15 PVT).
    expect(BURN_FLOOR_LAUNCH_LITERALS.presentation).toBe(15n * ONE_PVT);
    expect(BURN_FLOOR_LAUNCH_LITERALS.standing_export).toBe(0n);
    expect(BURN_FLOOR_LAUNCH_LITERALS.subscription).toBe(0n);
  });

  it('bounded max is 500 PVT (the BondPool filing-fee ceiling family)', () => {
    expect(BURN_FLOOR_MAX_ATOMIC).toBe(500n * ONE_PVT);
  });

  it('parseAmountAtomic parses integer strings/numbers/bigints, 0 on garbage', () => {
    expect(parseAmountAtomic('15000000000000000000')).toBe(15n * ONE_PVT);
    expect(parseAmountAtomic(5)).toBe(5n);
    expect(parseAmountAtomic(7n)).toBe(7n);
    expect(parseAmountAtomic('12.5')).toBe(0n);
    expect(parseAmountAtomic('0x10')).toBe(0n);
    expect(parseAmountAtomic(undefined)).toBe(0n);
    expect(parseAmountAtomic(-3)).toBe(0n);
  });

  it('isValidScheduledFloor accepts [0, MAX], rejects above MAX and negatives', () => {
    expect(isValidScheduledFloor(0n)).toBe(true);
    expect(isValidScheduledFloor(BURN_FLOOR_MAX_ATOMIC)).toBe(true);
    expect(isValidScheduledFloor(BURN_FLOOR_MAX_ATOMIC + 1n)).toBe(false);
    expect(isValidScheduledFloor(-1n)).toBe(false);
  });

  it('BURN_PRODUCTS + isBurnProduct cover exactly the eight products (added challenge_stake + featured_placement)', () => {
    expect([...BURN_PRODUCTS].sort()).toEqual(
      ['challenge_stake', 'featured_placement', 'name_registry', 'pledge', 'presentation', 'standing_export', 'subscription', 'vouch'],
    );
    expect(isBurnProduct('challenge_stake')).toBe(true);
    expect(isBurnProduct('featured_placement')).toBe(true);
    expect(isBurnProduct('vouch')).toBe(true);
    expect(isBurnProduct('presentation')).toBe(true);
    expect(isBurnProduct('nope')).toBe(false);
    expect(isBurnProduct(7)).toBe(false);
  });
});

// ─── resolveBurnFloorAtomic / scheduleBurnFloor round-trip (Firestore-backed) ──
type Row = Record<string, unknown>;
type Store = Map<string, Map<string, Row>>;
function coll(store: Store, name: string): Map<string, Row> {
  let c = store.get(name);
  if (!c) { c = new Map(); store.set(name, c); }
  return c;
}
class FakeDocRef {
  constructor(private store: Store, private collection: string, readonly id: string) {}
  async get(): Promise<{ exists: boolean; data: () => Row | undefined }> {
    const row = coll(this.store, this.collection).get(this.id);
    return { exists: row !== undefined, data: () => (row ? { ...row } : undefined) };
  }
  async set(data: Row, opts?: { merge?: boolean }): Promise<void> {
    const c = coll(this.store, this.collection);
    if (opts?.merge) c.set(this.id, { ...(c.get(this.id) ?? {}), ...data });
    else c.set(this.id, { ...data });
  }
}
function fakeDb(store: Store): { collection: (n: string) => { doc: (id: string) => FakeDocRef } } {
  return { collection: (name: string) => ({ doc: (id: string) => new FakeDocRef(store, name, id) }) };
}

describe('resolveBurnFloorAtomic / scheduleBurnFloor', () => {
  let store: Store;
  beforeEach(() => { store = new Map(); });

  it('returns the launch literal when no override is scheduled', async () => {
    const db = fakeDb(store) as never;
    expect(await resolveBurnFloorAtomic(db, 'name_registry')).toBe(15n * ONE_PVT);
    expect(await resolveBurnFloorAtomic(db, 'standing_export')).toBe(0n);
  });

  it('a scheduled in-bound override wins over the literal (ratchets without redeploy)', async () => {
    const db = fakeDb(store) as never;
    await scheduleBurnFloor(db, 'vouch', 30n * ONE_PVT, 'operator', 111);
    expect(await resolveBurnFloorAtomic(db, 'vouch')).toBe(30n * ONE_PVT);
    // isolation: another product still reads its literal
    expect(await resolveBurnFloorAtomic(db, 'pledge')).toBe(15n * ONE_PVT);
  });

  it('an override can lower a floor to 0, and raise export off 0', async () => {
    const db = fakeDb(store) as never;
    await scheduleBurnFloor(db, 'name_registry', 0n, 'operator', 1);
    expect(await resolveBurnFloorAtomic(db, 'name_registry')).toBe(0n);
    await scheduleBurnFloor(db, 'standing_export', 5n * ONE_PVT, 'operator', 2);
    expect(await resolveBurnFloorAtomic(db, 'standing_export')).toBe(5n * ONE_PVT);
  });

  it('scheduleBurnFloor REFUSES a floor above the bound (400), leaving the literal', async () => {
    const db = fakeDb(store) as never;
    await expect(
      scheduleBurnFloor(db, 'pledge', BURN_FLOOR_MAX_ATOMIC + 1n, 'operator', 1),
    ).rejects.toBeInstanceOf(BurnConsumptionError);
    expect(await resolveBurnFloorAtomic(db, 'pledge')).toBe(15n * ONE_PVT);
  });

  it('an out-of-bound stored value is ignored (falls back to the literal)', async () => {
    // simulate a corrupted/oversized stored floor written out-of-band
    coll(store, 'burn_floor_policy').set('vouch', { floor_atomic: (BURN_FLOOR_MAX_ATOMIC + 1n).toString() });
    const db = fakeDb(store) as never;
    expect(await resolveBurnFloorAtomic(db, 'vouch')).toBe(15n * ONE_PVT);
  });
});

describe('resolvePresentationFloorAtomic (per-tier, reconciled 2026-09-04)', () => {
  let store: Store;
  beforeEach(() => { store = new Map(); });

  it('per-tier launch defaults: pe_fact 5 PVT, reputation 15 PVT', async () => {
    const db = fakeDb(store) as never;
    expect(PRESENTATION_FLOOR_BY_TIER.pe_fact).toBe(5n * ONE_PVT);
    expect(PRESENTATION_FLOOR_BY_TIER.reputation).toBe(15n * ONE_PVT);
    expect(await resolvePresentationFloorAtomic(db, 'pe_fact')).toBe(5n * ONE_PVT);
    expect(await resolvePresentationFloorAtomic(db, 'reputation')).toBe(15n * ONE_PVT);
  });

  it('honors a per-tier scheduled override (config-driven, no redeploy)', async () => {
    coll(store, 'burn_floor_policy').set(PRESENTATION_FLOOR_POLICY_DOC.pe_fact, { floor_atomic: (8n * ONE_PVT).toString() });
    const db = fakeDb(store) as never;
    expect(await resolvePresentationFloorAtomic(db, 'pe_fact')).toBe(8n * ONE_PVT);
    // reputation untouched — separate doc
    expect(await resolvePresentationFloorAtomic(db, 'reputation')).toBe(15n * ONE_PVT);
  });

  it('RED: an out-of-bound override is ignored (falls back to the per-tier literal)', async () => {
    coll(store, 'burn_floor_policy').set(PRESENTATION_FLOOR_POLICY_DOC.reputation, { floor_atomic: (BURN_FLOOR_MAX_ATOMIC + 1n).toString() });
    const db = fakeDb(store) as never;
    expect(await resolvePresentationFloorAtomic(db, 'reputation')).toBe(15n * ONE_PVT);
  });
});

describe('buildBurnConsumptionMarker', () => {
  it('keys the marker to the burn_id and records product + ref + owner', () => {
    const burnId = 'a'.repeat(64);
    const m = buildBurnConsumptionMarker({ burnId, product: 'pledge', walletId: 'aw1', ref: 'pledge-7', nowMs: 42 });
    expect(m.burn_id).toBe(burnId);
    expect(m.product).toBe('pledge');
    expect(m.wallet_id).toBe('aw1');
    expect(m.ref).toBe('pledge-7');
    expect(m.consumed_at).toBe(42);
  });
});

describe('isBurnId / BURN_ID_RE', () => {
  it('accepts 64-char lowercase hex, rejects everything else', () => {
    expect(isBurnId('a'.repeat(64))).toBe(true);
    expect(isBurnId('A'.repeat(64))).toBe(false); // uppercase
    expect(isBurnId('a'.repeat(63))).toBe(false); // too short
    expect(isBurnId('0x' + 'a'.repeat(62))).toBe(false); // 0x prefix
    expect(isBurnId(123)).toBe(false);
    expect(BURN_ID_RE.test('f'.repeat(64))).toBe(true);
  });
});

describe('collection name is the one shared ledger', () => {
  it('is burn_consumptions', () => {
    expect(BURN_CONSUMPTIONS_COLLECTION).toBe('burn_consumptions');
  });
});
