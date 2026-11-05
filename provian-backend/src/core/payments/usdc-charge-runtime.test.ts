import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
let mockDb = createFakeFirestore();
jest.mock('../../firestore-db', () => ({ relayDb: () => mockDb }));
import { firestoreNonceStore } from '../onchain/canonical-wallet';
import type { NonceJournal } from '../onchain/canonical-nonce';
import { createUsdcChargeRuntime } from './usdc-charge-runtime';

const key = '0x' + '13'.repeat(32);
function runtime(prefix: string) {
  const result = createUsdcChargeRuntime({ db: mockDb as unknown as Firestore,
    env: { PAYOUT_BASE_GAS_KEY: key, BASE_RPC_URL: 'https://rpc.invalid' },
    readEthPrice: async () => ({ usd: 2000, as_of_ms: Date.now() }), leasePrefix: prefix });
  if (!result) throw Error('runtime_not_created');
  return result;
}
const held = (owner: string): NonceJournal => ({ version: 1, next: 0, attempts: [], owner, leaseUntil: Date.now() + 60_000 });
beforeEach(async () => {
  mockDb = createFakeFirestore();
  await mockDb.collection('evm_server_writer_cutovers_v1').doc('base_canonical_nonce').set({
    protocol: 'canonical-nonce-v1', active: true, old_writers_drained_at_ms: 0, activated_at_ms: 0,
  });
});
it('the production charge wrapper permits the canonical writer to acquire its signer lease (RED with the nested outer lease)', async () => {
  const charge = runtime('payout');
  const store = firestoreNonceStore(charge.chain.gasAddress);
  const journalKey = `8453_${charge.chain.gasAddress}`;
  const result = await charge.withGasKeyLease(() => store.transact(journalKey, () => held('canonical-charge')));
  expect(result).toMatchObject({ owner: 'canonical-charge' });
  expect((await mockDb.collection('pvt9_settlement_signer_leases_v1').doc(charge.chain.gasAddress).get()).get('owner')).toBe('canonical-charge');
});
it('payout and Archive still exclude another canonical writer using the same gas key', async () => {
  const payout = runtime('payout'), archive = runtime('archive');
  expect(payout.chain.gasAddress).toBe(archive.chain.gasAddress);
  const store = firestoreNonceStore(payout.chain.gasAddress), journalKey = `8453_${payout.chain.gasAddress}`;
  await payout.withGasKeyLease(() => store.transact(journalKey, () => held('payout-writer')));
  await expect(archive.withGasKeyLease(() => store.transact(journalKey, () => held('archive-writer')))).rejects.toThrow('nonce_settlement_signer_busy');
  await store.transact(journalKey, current => ({ ...current!, owner: null, leaseUntil: 0 }));
  await expect(archive.withGasKeyLease(() => store.transact(journalKey, () => held('archive-writer')))).resolves.toMatchObject({ owner: 'archive-writer' });
});
