import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { PAYEE_SETTLEMENT_CLOCK_COLLECTION, STANDARD_INTERVAL_ENV, payeeSettlementDue, standardSettlementIntervalDays } from './payee-settlement-interval';

const DAY = 86_400_000;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
describe('standard per-payee settlement interval', () => {
  it('uses each payee’s own last settlement and applies a changed N immediately', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(A).set({ last_settled_at_ms: DAY, batch_id: 'a' });
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(B).set({ last_settled_at_ms: 29 * DAY, batch_id: 'b' });
    expect(await payeeSettlementDue(db, 1, 30 * DAY)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 1, 30 * DAY)(B)).toBe(true);
    // RED: a global 30-day clock would select both; neither has reached its own 30 days.
    const thirty = payeeSettlementDue(db, 30, 30 * DAY);
    expect(await thirty(A)).toBe(false);
    expect(await thirty(B)).toBe(false);
    expect(await payeeSettlementDue(db, 30, 31 * DAY)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 30, 31 * DAY)(B)).toBe(false);
    expect(await payeeSettlementDue(db, 1, 31 * DAY)(B)).toBe(true);
  });
  it('snapshots due eligibility for a whole run, so another batch can finish the same payee', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(A).set({ last_settled_at_ms: DAY });
    const due = payeeSettlementDue(db, 1, 2 * DAY);
    expect(await due(A)).toBe(true);
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(A).set({ last_settled_at_ms: 2 * DAY });
    expect(await due(A)).toBe(true);
    // RED: a new run cannot pay this payee again before the next interval.
    expect(await payeeSettlementDue(db, 1, 2 * DAY + 1)(A)).toBe(false);
  });
  it('compatibility reads the last standard payment, never a Genesis grant', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection('pvt9_claim_ledger_v1').doc('standard').set({ contributor: A, lane: 'standard', settled: true, settled_at: DAY });
    await fake.collection('pvt9_claim_ledger_v1').doc('genesis').set({ contributor: A, lane: 'genesis', settled: true, settled_at: 30 * DAY });
    expect(await payeeSettlementDue(db, 30, 31 * DAY)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 30, 30 * DAY)(A)).toBe(false);
    expect(await payeeSettlementDue(db, 30, DAY)(B)).toBe(true);
  });
  it('uses UTC dates despite confirmation jitter and refuses a second scheduled run that day', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(A).set({ last_settled_at_ms: DAY + 12 * 3_600_000 + 45_000 });
    expect(await payeeSettlementDue(db, 1, 2 * DAY + 12 * 3_600_000)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 1, 2 * DAY - 1)(A)).toBe(false);
    expect(await payeeSettlementDue(db, 30, 31 * DAY)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 30, 31 * DAY - 1)(A)).toBe(false);
  });
  it('refuses malformed settings and clocks; the configured default is thirty days', async () => {
    expect(standardSettlementIntervalDays({})).toBe(30);
    expect(standardSettlementIntervalDays({ [STANDARD_INTERVAL_ENV]: '30' })).toBe(30);
    for (const value of ['0', '-1', '1.5', 'NaN', '30days', '999999999999999999']) {
      expect(() => standardSettlementIntervalDays({ [STANDARD_INTERVAL_ENV]: value })).toThrow('standard_settlement_interval_invalid');
    }
    const fake = createFakeFirestore();
    await fake.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(A).set({ last_settled_at_ms: 'yesterday' });
    await expect(payeeSettlementDue(fake as unknown as Firestore, 1, DAY)(A)).rejects.toThrow('payee_settlement_clock_invalid');
  });
});
