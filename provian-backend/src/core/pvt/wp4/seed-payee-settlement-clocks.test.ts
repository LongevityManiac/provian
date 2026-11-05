import { Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { KERNEL_SETTLEMENT_ABI } from './settlement-cycle-runner';
import { seedPayeeSettlementClocks } from './seed-payee-settlement-clocks';
import { payeeSettlementDue } from './payee-settlement-interval';
const DAY = 86_400_000;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const hash = (n: number): string => '0x' + n.toString(16).padStart(64, '0');
const abi = new Interface(KERNEL_SETTLEMENT_ABI as unknown as string[]);
function batch(n: number, payee: string): Record<string, unknown> {
  return { batch_id: hash(n), lane: 'standard', status: 'confirmed', applied: true,
    confirmed_tx_hash: hash(100 + n), calldata: abi.encodeFunctionData('settleStandardPEBatch', [hash(n), 0, hash(99), n - 1, n,
      [[payee, 1, 1]], [[hash(200 + n), 1]]]) };
}
describe('initial standard settlement clocks', () => {
  it('preserves quiet payees whose ledger expired, retained application times, and newer concurrent clocks', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection('pvt9_settlement_batches_v1').doc('old').set(batch(1, A));
    await fake.collection('pvt9_settlement_batches_v1').doc('recent').set(batch(2, B));
    await fake.collection('pvt9_claim_ledger_v1').doc('recent').set({ lane: 'standard', settled: true, settled_batch_id: hash(2), settled_at: 20 * DAY });
    const time = jest.fn(async () => 5 * DAY);
    expect(await seedPayeeSettlementClocks(db, time, 30 * DAY)).toEqual({ payees: 2, added: 2 });
    expect(time).toHaveBeenCalledTimes(2); // both receipt targets verified, including the old payment whose ledger expired
    expect(await payeeSettlementDue(db, 365, 30 * DAY)(A)).toBe(false);
    expect(await payeeSettlementDue(db, 30, 35 * DAY)(A)).toBe(true);
    expect(await payeeSettlementDue(db, 30, 35 * DAY)(B)).toBe(false);
    await fake.collection('pvt9_payee_settlement_clocks_v1').doc(A).set({ last_settled_at_ms: 29 * DAY, batch_id: 'new-payment' });
    expect((await seedPayeeSettlementClocks(db, time, 30 * DAY)).added).toBe(0);
    expect((await fake.collection('pvt9_payee_settlement_clocks_v1').doc(A).get()).data()?.last_settled_at_ms).toBe(29 * DAY);
    expect((await fake.collection('pvt9_settlement_batches_v1').doc('old').get()).data()).toEqual(batch(1, A));
  });
  it('does not let preserved superseded-kernel history set a live-token due date', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection('pvt9_settlement_batches_v1').doc('historical').set(batch(1, A));
    expect(await seedPayeeSettlementClocks(db, async () => null, 30 * DAY)).toEqual({ payees: 0, added: 0 });
    expect((await fake.collection('pvt9_payee_settlement_clocks_v1').doc(A).get()).exists).toBe(false);
  });
  it('refuses unverifiable history instead of inventing a due date', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    await fake.collection('pvt9_settlement_batches_v1').doc('old').set(batch(1, A));
    await expect(seedPayeeSettlementClocks(db, async () => { throw new Error('receipt unavailable'); }, 30 * DAY)).rejects.toThrow('receipt unavailable');
    expect((await fake.collection('pvt9_payee_settlement_clocks_v1').doc(A).get()).exists).toBe(false);
  });
});
