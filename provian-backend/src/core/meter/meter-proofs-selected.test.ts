import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { listMeterProofs, selectedProofHashes } from './meter-proofs';
it('reads owner-known batch hashes directly, stops at an unanchored batch, and never reveals another device', async () => {
  const fake = createFakeFirestore(), db = fake as unknown as Firestore;
  const hashes = ['a', 'b', 'c'].map(c => c.repeat(64));
  for (let i = 0; i < 3; i++) await fake.collection('meter_batches_v1').doc(hashes[i]).set({ device_id: i === 2 ? 'other' : 'own', actor_id: 'actor', seq: i + 1,
    anchored: i !== 1, anchor: i !== 1 ? { day: '2026-10-30' } : null, batch_leaf: hashes[i], acts_root: hashes[i] });
  const getAll = jest.spyOn(fake, 'getAll');
  const answer = await listMeterProofs(db, 'own', 0, 200, hashes);
  expect(answer.proofs.map(p => p.batch_hash)).toEqual([hashes[0]]);
  expect(getAll).toHaveBeenCalledTimes(1);
  expect((await listMeterProofs(db, 'own', 0, 200, [hashes[2]])).proofs).toEqual([]);
  expect((await listMeterProofs(db, 'own', 0, 200, [])).proofs).toEqual([]);
});
it('refuses malformed known-hash selections without falling back to a history scan', () => {
  expect(selectedProofHashes(undefined)).toBeUndefined(); expect(selectedProofHashes('')).toEqual([]);
  for (const bad of ['x', ['a'.repeat(64)], Array(33).fill('a'.repeat(64)).join(','), ['a'.repeat(64),'a'.repeat(64)].join(',')]) expect(() => selectedProofHashes(bad)).toThrow('batch_hashes_invalid');
});
