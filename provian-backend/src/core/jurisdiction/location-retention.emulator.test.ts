jest.unmock('./mint-compliance');
jest.unmock('./jurisdiction-policy');
jest.unmock('./sdn');
import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import { privateFirestore, privateStorageId } from '../provenance/private-store';
import { PRIVATE_RETENTION_STATE_COLLECTION, PRIVATE_RETENTION_STATE_DOC } from '../provenance/private-retention';
import { writePEHistory } from '../../pe-history';
import { observeActorSession, SESSION_COLLECTION } from './mint-compliance';
import { COMPLIANCE_EVENTS_COLLECTION, complianceRetentionDeadline, deleteWalletLocation, purgeExpiredWalletLocations } from './location-retention';
const local = process.env.FIRESTORE_EMULATOR_HOST;
const suite = local && /^(127\.0\.0\.1|localhost):\d+$/.test(local) ? describe : describe.skip;
suite('location retention with real Firestore transactions and encrypted storage', () => {
  let raw: Firestore, db: Firestore;
  const address = `0x${'aB'.repeat(20)}`;
  const key = address.toLowerCase();
  beforeAll(async () => {
    raw = new Firestore({ projectId: 'demo-meter', databaseId: `retention-${randomUUID().slice(0, 8)}`, ignoreUndefinedProperties: true });
    db = privateFirestore(raw);
    await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC)
      .set({ opaque_ids_ready: true, opaque_records_complete: true, range_lookup_version: 1 });
    await db.collection('wallets').doc('human').set({ user_id: 'person', type: 'human', address });
    await db.collection('jurisdiction_policy').doc('IR').set({ policy: 'blocked' });
    await db.collection('jurisdiction_screening_v1').doc('ofac_sdn').set({ checked_at_ms: Date.now(),
      published: '10/28/2026', sha256: 'a'.repeat(64), addresses: Array.from({ length: 101 }, (_, i) => `test-${i}`) });
    await db.collection(SESSION_COLLECTION).doc(key).set({ address: key, country: 'IR', region: 'IR-Tehran', database: 'dbip', observed_at_ms: Date.now() - 1000 });
  });
  afterAll(async () => { await raw.terminate(); });
  it('the actual legacy seal co-writes retention, retries do not extend it, and indexed expiry erases it', async () => {
    const before = Date.now();
    const params = { peId: 'pe_real_hold', userId: 'person', actionType: 'wallet_created', timestamp: before - 86_400_000,
      jurisdiction_context: 'IR', category: 'wallet' as const, attestationDepth: 'software' as const, estimatedPVT: 10, peHash: 'b'.repeat(64), compliance_db: db };
    expect(await writePEHistory(params, db)).toBe(true);
    const stored = (await db.collection('pe_history').doc(params.peId).get()).data()!;
    expect(stored.mint_status).toBe('pending_compliance');
    const events = await db.collection(COMPLIANCE_EVENTS_COLLECTION).get();
    expect(events.size).toBe(1);
    const heldAt = events.docs[0].data().held_at_ms as number;
    expect(heldAt).toBeGreaterThanOrEqual(before);
    expect(heldAt).toBeLessThanOrEqual(Date.now());
    const until = complianceRetentionDeadline(heldAt);
    expect((await db.collection(SESSION_COLLECTION).doc(key).get()).data()?.retention_until_ms).toBe(until);
    expect(await writePEHistory(params, db)).toBe(false);
    expect(await deleteWalletLocation(db, address, heldAt + 1)).toBe(false);
    expect(await purgeExpiredWalletLocations(db, until - 1)).toEqual({ scanned: 0, deleted: 0, erased_copy_events: 0 });
    const physical = await raw.collection(SESSION_COLLECTION).doc(privateStorageId(SESSION_COLLECTION, key)).get();
    expect(physical.data()?.country).toBeUndefined();
    expect(physical.data()?.expire_at.toMillis()).toBe(until);
    expect(await purgeExpiredWalletLocations(db, until)).toEqual({ scanned: 1, deleted: 1, erased_copy_events: 1 });
    expect((await db.collection(SESSION_COLLECTION).doc(key).get()).exists).toBe(false);
  });
  it('ordinary deletion and the authenticated checksum-address release fence leave no location', async () => {
    await observeActorSession(db, { ip: '8.8.8.8' }, 'person');
    expect((await db.collection(SESSION_COLLECTION).doc(key).get()).data()?.country).toBe('US');
    await db.collection('wallets').doc('human').update({ released_at_ms: Date.now() });
    expect(await deleteWalletLocation(db, address, Date.now())).toBe(true);
    await observeActorSession(db, { ip: '8.8.8.8' }, 'person');
    expect((await db.collection(SESSION_COLLECTION).doc(key).get()).exists).toBe(false);
  });
});
