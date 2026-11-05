/**
 * The retained mint-worker coordination surface: the shared economic-mutation
 * lease and the legacy claim/capacity fence the epoch keeper reads.
 *
 * The claim/authorize/prepare/reconcile/anchor mint-flow suites that used to live
 * here were deleted with the retired PVTv8 mint engine (PE meter migration,
 * 2026-10-03). The lease assertions they carried (fence increment on expiry,
 * malformed lease rows, expiry overflow) are kept below against the lease API
 * directly; the epoch keeper's own use of the fence is pinned in
 * epoch-keeper.test.ts.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  MINT_BATCH_CLAIM_COLLECTION,
  MINT_EPOCH_CAPACITY_COLLECTION,
  MINT_WORKER_LEASE_COLLECTION,
  MINT_WORKER_LEASE_ID,
  acquireMintWorkerLease,
  assertMintWorkerLeaseCurrent,
  hasPendingMintEpochCapacity,
  listOutstandingMintBatchClaims,
  releaseMintWorkerLease,
  renewMintWorkerLease,
  type MintBatchClaimDocument,
  type MintWorkerLease,
} from './mint-worker-coordination';

const LEASE_KEY = `${MINT_WORKER_LEASE_COLLECTION}/${MINT_WORKER_LEASE_ID}`;

function bytes32(label: string): string {
  return `0x${crypto.createHash('sha256').update(label).digest('hex')}`;
}

async function acquire(
  db: Firestore,
  ownerId: string,
  now: number,
  ttlMs: number,
): Promise<MintWorkerLease> {
  const lease = await acquireMintWorkerLease(db, { ownerId, now, ttlMs });
  if (!lease) throw new Error('fixture lease unavailable');
  return lease;
}

function claim(index: number, state: MintBatchClaimDocument['state'] = 'claimed'): MintBatchClaimDocument {
  return {
    schema_version: 'pvt-mint-claim/v1',
    claim_id: `0x${index.toString(16).padStart(64, '0')}`,
    batch_id: bytes32(`coordination-batch-${index}`),
    lease_owner_id: 'coordination-worker',
    fencing_token: 1,
    epoch: 0,
    pe_ids: [`pe_${index}`],
    combined_reserved_atomic: '1',
    genesis_reserved_atomic: '0',
    genesis_settlement_reservation_id: null,
    economic_contract_address: '0x1111111111111111111111111111111111111111',
    anchor_contract_address: '0x2222222222222222222222222222222222222222',
    economic_state_snapshot_hash: bytes32(`snapshot-${index}`),
    economic_state_block_number: 100,
    economic_state_block_hash: bytes32('block'),
    economic_state_agreed_head_number: 111,
    economic_state_agreed_head_hash: bytes32('head'),
    economic_state_confirmation_depth: 12,
    economic_state_operator_ids: ['operator-a', 'operator-b'],
    economic_factor_fingerprint: bytes32(`factor-${index}`),
    badge_projection_input_commitment: 'a'.repeat(64),
    authorization_economic_state_snapshot_hash: null,
    mint_broadcast_protocol: null,
    mint_payload_hash: null,
    anchor_payload_hash: bytes32(`anchor-payload-${index}`),
    state,
    submission_authorized_until_ms: null,
    mint_tx_hash: null,
    mint_prepared_transaction: null,
    anchor_tx_hash: null,
    anchor_prepared_transaction: null,
    mint_finality: null,
    anchor_finality: null,
    anchor_event: null,
    actual_minted_atomic: null,
    reservation_delta_atomic: null,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

function capacity(epoch: number, pendingReservedAtomic: string): Record<string, unknown> {
  return {
    schema_version: 'pvt-mint-epoch-capacity/v1',
    epoch,
    threshold_atomic: '1000',
    safety_bps: 9_500,
    last_observed_onchain_atomic: '0',
    pending_reserved_atomic: pendingReservedAtomic,
    committed_atomic: '0',
    last_observed_block_number: 100,
    last_observed_block_hash: bytes32('capacity-block'),
    last_observed_snapshot_hash: bytes32('capacity-snapshot'),
    revision: 1,
    cap_breach_detected: false,
    updated_at_ms: 1,
  };
}

describe('shared economic-mutation lease', () => {
  test('a live lease excludes another owner; expiry increments the fence for the successor', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const first = await acquire(db, 'worker-first', 0, 10);
    expect(first.fencingToken).toBe(1);
    await expect(acquireMintWorkerLease(db, { ownerId: 'worker-other', now: 5, ttlMs: 10 }))
      .resolves.toBeNull();
    const successor = await acquire(db, 'worker-successor', 11, 10);
    expect(successor.fencingToken).toBe(first.fencingToken + 1);
  });

  test('a stale lease cannot renew or pass the transaction fence check after a successor takes over', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const stale = await acquire(db, 'worker-stale', 0, 10);
    const successor = await acquire(db, 'worker-successor', 11, 10);

    await expect(renewMintWorkerLease(db, stale, { now: 12, ttlMs: 10 }))
      .rejects.toMatchObject({ code: 'mint_worker_lease_lost' });
    expect(() => assertMintWorkerLeaseCurrent(fake.store.get(LEASE_KEY), stale, 12))
      .toThrow(expect.objectContaining({ code: 'mint_worker_lease_lost' }));
    // GREEN control: the current holder passes the same check.
    expect(() => assertMintWorkerLeaseCurrent(fake.store.get(LEASE_KEY), successor, 12))
      .not.toThrow();
  });

  test('a released lease is reacquirable under a new fence and no longer current', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const lease = await acquire(db, 'worker-release', 0, 100);
    await expect(releaseMintWorkerLease(db, lease, 5)).resolves.toBe(true);
    expect(() => assertMintWorkerLeaseCurrent(fake.store.get(LEASE_KEY), lease, 6))
      .toThrow(expect.objectContaining({ code: 'mint_worker_lease_lost' }));
    const next = await acquire(db, 'worker-next', 6, 100);
    expect(next.fencingToken).toBe(lease.fencingToken + 1);
  });

  test.each([
    ['an unknown field', (row: Record<string, unknown>) => ({ ...row, unexpected: true })],
    ['a negative acquisition time', (row: Record<string, unknown>) => ({
      ...row,
      acquired_at_ms: -1,
    })],
    ['a renewal before acquisition', (row: Record<string, unknown>) => ({
      ...row,
      acquired_at_ms: 5,
      renewed_at_ms: 4,
    })],
    ['an active expiry at renewal', (row: Record<string, unknown>) => ({
      ...row,
      expires_at_ms: row.renewed_at_ms,
    })],
  ])('a worker lease with %s is refused', async (_label, mutate) => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const lease = await acquire(db, 'worker-malformed-lease', 1, 100);
    fake.store.set(LEASE_KEY, mutate(fake.store.get(LEASE_KEY)!));

    await expect(renewMintWorkerLease(db, lease, { now: 2, ttlMs: 100 }))
      .rejects.toMatchObject({ code: 'invalid_worker_lease' });
    await expect(acquireMintWorkerLease(db, { ownerId: 'worker-other', now: 2, ttlMs: 100 }))
      .rejects.toMatchObject({ code: 'invalid_worker_lease' });
  });

  test('lease-expiry arithmetic overflow fails before creating durable state', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await expect(acquireMintWorkerLease(db, {
      ownerId: 'worker-overflow',
      now: Number.MAX_SAFE_INTEGER - 5,
      ttlMs: 10,
    })).rejects.toMatchObject({ code: 'invalid_lease_expiry' });
    expect(fake.store.size).toBe(0);
  });
});

describe('legacy epoch-capacity fence', () => {
  test('no capacity rows, or only zero-reserved rows, is not pending', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await expect(hasPendingMintEpochCapacity(db)).resolves.toBe(false);
    fake.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/0`, capacity(0, '0'));
    await expect(hasPendingMintEpochCapacity(db)).resolves.toBe(false);
  });

  test('RED control: any reserved capacity is pending', async () => {
    const fake = createFakeFirestore();
    fake.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/0`, capacity(0, '0'));
    fake.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/1`, capacity(1, '1'));
    await expect(hasPendingMintEpochCapacity(fake as unknown as Firestore)).resolves.toBe(true);
  });

  test('a capacity row filed under the wrong epoch, or malformed, fails closed', async () => {
    const misfiled = createFakeFirestore();
    misfiled.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/7`, capacity(0, '0'));
    await expect(hasPendingMintEpochCapacity(misfiled as unknown as Firestore))
      .rejects.toMatchObject({ code: 'invalid_epoch_capacity' });

    const malformed = createFakeFirestore();
    malformed.store.set(`${MINT_EPOCH_CAPACITY_COLLECTION}/0`, { ...capacity(0, '0'), extra: 1 });
    await expect(hasPendingMintEpochCapacity(malformed as unknown as Firestore))
      .rejects.toMatchObject({ code: 'invalid_epoch_capacity' });
  });
});

describe('legacy outstanding-claim fence', () => {
  test('lists outstanding claims and ignores terminal ones', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await expect(listOutstandingMintBatchClaims(db, { strict: true })).resolves.toEqual([]);

    const outstanding = claim(1);
    const terminal = claim(2, 'released');
    fake.store.set(`${MINT_BATCH_CLAIM_COLLECTION}/${outstanding.claim_id}`, outstanding as unknown as Record<string, unknown>);
    fake.store.set(`${MINT_BATCH_CLAIM_COLLECTION}/${terminal.claim_id}`, terminal as unknown as Record<string, unknown>);

    const listed = await listOutstandingMintBatchClaims(db, { strict: true });
    expect(listed.map((row) => row.claim_id)).toEqual([outstanding.claim_id]);
  });

  test('strict listing throws on a malformed outstanding claim; non-strict skips it', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const valid = claim(1);
    const malformed = { ...claim(2), badge_projection_input_commitment: 'not-a-commitment' };
    fake.store.set(`${MINT_BATCH_CLAIM_COLLECTION}/${valid.claim_id}`, valid as unknown as Record<string, unknown>);
    fake.store.set(`${MINT_BATCH_CLAIM_COLLECTION}/${malformed.claim_id}`, malformed as unknown as Record<string, unknown>);

    await expect(listOutstandingMintBatchClaims(db, { strict: true }))
      .rejects.toMatchObject({ code: 'invalid_mint_claim' });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const listed = await listOutstandingMintBatchClaims(db);
      expect(listed.map((row) => row.claim_id)).toEqual([valid.claim_id]);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
