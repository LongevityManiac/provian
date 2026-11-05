import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { emptyAggregateDocument, type EconomicAggregateDocument } from '../pvt/policy/economic-aggregate';
import { noteBatchClaimSettlement } from './batch-economics';

describe('compact batch economics lifecycle', () => {
  it('moves pending economics once after every payee leg, retains unacked transit, and restores pending after reorg', async () => {
    const fake = createFakeFirestore(), db = fake as unknown as Firestore;
    const batch = fake.collection('meter_batches_v1').doc('batch');
    const agg = emptyAggregateDocument('actor');
    agg.roles.contributor.pes_by_mint_status.eligible = 2;
    agg.roles.contributor.batch_pending_rated_atomic = '100';
    agg.roles.contributor.batch_pending_rated_by_category_atomic = { compute: '100' };
    agg.roles.contributor.batch_pending_fixed_by_category_atomic = { compute: '0' };
    await fake.collection('pe_economic_aggregates').doc('actor').set(agg as unknown as Record<string, unknown>);
    await batch.set({ per_batch_pricing: true, anchored: true, economic_settled: false, settlement_complete: false,
      economic_claim_keys: ['agent', 'human'], economic_paid_claim_keys: [],
      economic_totals: [{ identity: 'actor', role: 'contributor', category: 'compute', count: 2, rated: '100', fixed: '0' }], expire_at: null });
    const mailbox = fake.collection('pe_mailbox_v1').doc('waiting');
    await mailbox.set({ batch_hash: 'batch', items: [{ box: 'ciphertext' }] });
    const claim = (claim_key: string) => ({ unit: 'batch' as const, batch_hash: 'batch', claim_key });
    expect(await noteBatchClaimSettlement(db, claim('agent'), true, 1000)).toBe(0);
    expect((await batch.get()).data()?.economic_settled).toBe(false);
    expect(await noteBatchClaimSettlement(db, claim('human'), true, 2000)).toBe(2);
    expect((await batch.get()).data()?.expire_at).toBeNull();
    expect(await noteBatchClaimSettlement(db, claim('human'), true, 3000)).toBe(0);
    let role = ((await fake.collection('pe_economic_aggregates').doc('actor').get()).data() as unknown as EconomicAggregateDocument).roles.contributor;
    expect(role.pes_by_mint_status.eligible ?? 0).toBe(0);
    expect(role.pes_by_mint_status.minted).toBe(2);
    expect(role.batch_pending_rated_atomic).toBe('0');
    await mailbox.delete();
    await noteBatchClaimSettlement(db, claim('human'), false, 4000);
    role = ((await fake.collection('pe_economic_aggregates').doc('actor').get()).data() as unknown as EconomicAggregateDocument).roles.contributor;
    expect(role.pes_by_mint_status.eligible).toBe(2);
    expect(role.pes_by_mint_status.minted ?? 0).toBe(0);
    expect(role.batch_pending_rated_atomic).toBe('100');
    expect((await batch.get()).data()?.expire_at).toBeNull();
    expect(await noteBatchClaimSettlement(db, claim('human'), true, 5000)).toBe(2);
    expect((await batch.get()).data()?.expire_at).not.toBeNull();
  });
});
