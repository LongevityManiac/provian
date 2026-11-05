import type { Firestore } from 'firebase-admin/firestore';

import { countingFirestore } from './__test-helpers__/counting-firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { baseEconomicEvidence, testTxHash } from './__test-helpers__/base-economic-evidence';
import { hashBaseUsdcTransferEvidence, type BaseUsdcTransferEvidence } from '../onchain/economic-discovery';
import {
  createWatcherClaim,
  freezeWatcherClaimEvidence,
  leaseWatcherRecoveryClaims,
  markWatcherClaimComplete,
  markWatcherClaimPending,
  WATCHER_RECOVERY_FULL_PASS_INTERVAL_MS,
  WATCHER_RECOVERY_INTEGRITY_COLLECTION,
  watcherClaimDocumentId,
  type WatcherClaimBinding,
} from './watcher-recovery';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

function fixture(index: number): {
  binding: WatcherClaimBinding;
  payload: Record<string, unknown>;
} {
  const transactionHash = testTxHash(`watcher-claim-${index}`);
  const binding: WatcherClaimBinding = {
    chainId: 8453,
    transactionHash,
    logIndex: index,
    fromAddress: FROM,
    toAddress: TO,
    amountAtomic: String(index + 1),
  };
  return {
    binding,
    payload: {
      chainId: 8453,
      chainName: 'base',
      addr: {
        address: FROM,
        walletId: 'wallet-1',
        agentId: 'agent-1',
        provenAtBlock: 1,
      },
      event: {
        txHash: transactionHash,
        logIndex: index,
        blockNumber: 100 + index,
        toAddress: TO,
        amountUsd: (index + 1) / 1_000_000,
        amountAtomic: String(index + 1),
        observedAtMs: 0,
      },
    },
  };
}

describe('watcher recovery pagination', () => {
  it('reaches claims beyond the first 100 even when every first-page claim keeps failing', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const allIds: string[] = [];
    for (let index = 0; index < 150; index += 1) {
      const { binding, payload } = fixture(index);
      const id = watcherClaimDocumentId(binding);
      allIds.push(id);
      const handle = await createWatcherClaim(
        db,
        db.collection('watcher_claims').doc(id),
        binding,
        payload,
        1_000,
      );
      if (!handle) throw new Error('test_claim_create_failed');
      await markWatcherClaimPending(db, handle, new Error('retry'), 1_001);
    }

    const first = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000, 100);
    expect(first.issues).toEqual([]);
    expect(first.handles).toHaveLength(100);
    for (const handle of first.handles) {
      await markWatcherClaimPending(db, handle, new Error('permanent_failure'), 2_001);
    }

    const second = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 3_000, 100);
    expect(second.issues).toEqual([]);
    const ids = second.handles.map((handle) => handle.ref.id);
    expect(ids).toHaveLength(100);
    const firstIds = new Set(first.handles.map((handle) => handle.ref.id));
    const untouchedIds = allIds.filter((id) => !firstIds.has(id)).sort();
    expect(untouchedIds).toHaveLength(50);
    expect(ids.slice(0, 50)).toEqual(untouchedIds);
  });

  it('treats only an exact transactionally revalidated existing claim as a duplicate', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const { binding, payload } = fixture(500);
    const ref = db.collection('watcher_claims').doc(watcherClaimDocumentId(binding));
    await expect(createWatcherClaim(db, ref, binding, payload, 1_000))
      .resolves.toMatchObject({ binding });
    await expect(createWatcherClaim(db, ref, binding, payload, 2_000))
      .resolves.toBeNull();

    await expect(createWatcherClaim(db, ref, binding, {
      ...payload,
      chainName: 'mutated-chain-label',
    }, 3_000)).rejects.toThrow('watcher_claim_existing_binding_mismatch');
  });

  it('surfaces malformed claims while continuing to lease valid later work', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await db.collection('watcher_claims').doc('malformed-row').set({
      schema_version: 'economic-watcher-claim/v1',
      state: 'pending_reverification',
      payload: { attacker: true },
    });
    const { binding, payload } = fixture(501);
    const validRef = db.collection('watcher_claims').doc(watcherClaimDocumentId(binding));
    const handle = await createWatcherClaim(db, validRef, binding, payload, 1_000);
    if (!handle) throw new Error('valid claim missing');
    await markWatcherClaimPending(db, handle, new Error('retry'), 1_001);

    const recovery = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000, 100);
    expect(recovery.issues).toEqual([expect.objectContaining({
      documentId: 'malformed-row',
      code: 'watcher_claim_malformed',
    })]);
    expect(recovery.handles.map((candidate) => candidate.ref.id))
      .toEqual([validRef.id]);
  });

  it('skips a pre-durable genesis_inbound_seen marker without blocking the lane ', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    // Verbatim shape of the five production markers that made
    // `structurallyBlocked` wedge every inbound scan from the durable layer's
    // landing until exactly these five fields, nothing else.
    await db.collection('watcher_claims').doc('8453_0xlegacy_169').set({
      chain_id: 8453,
      tx_hash: `0x${'51'.repeat(32)}`,
      log_index: 169,
      wallet_id: 'wallet_f9942e64-9905-43e6-9813-92a139dbe630',
      claimed_at: 1_783_484_114_039,
    });
    const { binding, payload } = fixture(503);
    const validRef = db.collection('watcher_claims').doc(watcherClaimDocumentId(binding));
    const handle = await createWatcherClaim(db, validRef, binding, payload, 1_000);
    if (!handle) throw new Error('valid claim missing');
    await markWatcherClaimPending(db, handle, new Error('retry'), 1_001);

    const recovery = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000, 100);
    expect(recovery.issues).toEqual([]);
    expect(recovery.legacyMarkersSkipped).toBe(1);
    expect(recovery.handles.map((candidate) => candidate.ref.id)).toEqual([validRef.id]);
  });

  it.each([
    ['an extra key', (row: Record<string, unknown>) => { row.note = 'x'; }],
    ['a stringly log_index', (row: Record<string, unknown>) => { row.log_index = '169'; }],
    ['a missing wallet_id', (row: Record<string, unknown>) => { delete row.wallet_id; }],
    ['a non-Base chain_id', (row: Record<string, unknown>) => { row.chain_id = 1; }],
  ])('NEGATIVE CONTROL — a near-legacy marker with %s still fails closed as malformed', async (_name, mutate) => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const row: Record<string, unknown> = {
      chain_id: 8453,
      tx_hash: `0x${'51'.repeat(32)}`,
      log_index: 169,
      wallet_id: 'wallet_f9942e64-9905-43e6-9813-92a139dbe630',
      claimed_at: 1_783_484_114_039,
    };
    mutate(row);
    await db.collection('watcher_claims').doc('8453_0xnearlegacy_169').set(row);

    const recovery = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000, 100);
    expect(recovery.legacyMarkersSkipped).toBe(0);
    expect(recovery.issues).toEqual([
      expect.objectContaining({ documentId: '8453_0xnearlegacy_169', code: 'watcher_claim_malformed' }),
    ]);
  });

  it('rejects a malformed existing row instead of converting it to a duplicate', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const { binding, payload } = fixture(502);
    const ref = db.collection('watcher_claims').doc(watcherClaimDocumentId(binding));
    await ref.set({ schema_version: 'economic-watcher-claim/v1', payload });

    await expect(createWatcherClaim(db, ref, binding, payload, 2_000))
      .rejects.toThrow('watcher_claim_existing_malformed');
  });

  it.each([
    ['unknown field', (row: Record<string, unknown>) => { row.unknown = true; }],
    ['negative claim time', (row: Record<string, unknown>) => { row.claimed_at_ms = -1; }],
    ['reversed update time', (row: Record<string, unknown>) => { row.updated_at_ms = 999; }],
    ['noncanonical payload hash', (row: Record<string, unknown>) => {
      row.payload_hash = String(row.payload_hash).toUpperCase();
    }],
  ])('surfaces %s as malformed durable state', async (_name, mutate) => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const { binding, payload } = fixture(600);
    const id = watcherClaimDocumentId(binding);
    const handle = await createWatcherClaim(
      db,
      db.collection('watcher_claims').doc(id),
      binding,
      payload,
      1_000,
    );
    if (!handle) throw new Error('test claim missing');
    await markWatcherClaimPending(db, handle, new Error('retry'), 1_001);
    mutate(fake.store.get(`watcher_claims/${id}`)!);

    const recovery = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000);
    expect(recovery.handles).toEqual([]);
    expect(recovery.issues).toEqual([
      expect.objectContaining({ documentId: id, code: 'watcher_claim_malformed' }),
    ]);
  });

  it('fails closed on lease time and attempt-counter overflow', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const { binding, payload } = fixture(601);
    const id = watcherClaimDocumentId(binding);
    await expect(createWatcherClaim(
      db,
      db.collection('watcher_claims').doc(id),
      binding,
      payload,
      Number.MAX_SAFE_INTEGER,
    )).rejects.toThrow('watcher_claim_time_invalid');

    const handle = await createWatcherClaim(
      db,
      db.collection('watcher_claims').doc(id),
      binding,
      payload,
      1_000,
    );
    if (!handle) throw new Error('test claim missing');
    await markWatcherClaimPending(db, handle, new Error('retry'), 1_001);
    fake.store.get(`watcher_claims/${id}`)!.attempts = Number.MAX_SAFE_INTEGER;
    const recovery = await leaseWatcherRecoveryClaims(db, 'watcher_claims', 2_000);
    expect(recovery.handles).toEqual([]);
    expect(recovery.issues).toEqual([
      expect.objectContaining({
        documentId: id,
        reason: 'watcher_claim_attempts_exhausted',
      }),
    ]);
  });
});

describe('frozen claim evidence across RPC operator pairs (round 2)', () => {
  function evidenceFor(
    binding: WatcherClaimBinding,
    over: Partial<Omit<BaseUsdcTransferEvidence, 'evidenceHash'>> = {},
  ): BaseUsdcTransferEvidence {
    const { evidenceHash: _hash, ...base } = baseEconomicEvidence({
      transactionHash: binding.transactionHash,
      logIndex: binding.logIndex,
      blockNumber: 101,
      fromAddress: binding.fromAddress,
      toAddress: binding.toAddress,
      amountAtomic: binding.amountAtomic,
    });
    const withoutHash = { ...base, ...over };
    return { ...withoutHash, evidenceHash: hashBaseUsdcTransferEvidence(withoutHash) };
  }

  it('RED: a claim frozen under one operator pair completes under another; a differing chain fact still conflicts', async () => {
    const db = createFakeFirestore();
    const { binding, payload } = fixture(1);
    const ref = (db as unknown as Firestore).collection('genesis_inbound_seen')
      .doc(watcherClaimDocumentId(binding));
    const handle = await createWatcherClaim(db as unknown as Firestore, ref, binding, payload, 1_000);
    expect(handle).not.toBeNull();
    // First attempt (e.g. an operator shell): frozen under ITS agreed pair.
    const shell = evidenceFor(binding, { providerOperatorIds: ['shell-public-base', 'shell-alchemy'] });
    const frozen = await freezeWatcherClaimEvidence(db as unknown as Firestore, handle!, shell, 1_001);
    expect(frozen.evidenceSnapshot?.evidenceHash).toBe(shell.evidenceHash);

    // The relay re-reads the SAME chain facts through ITS pair: accepted, and the
    // frozen snapshot (the one the sealed PE embeds) stays authoritative.
    // Old code: `watcher_claim_evidence_conflict` (the hash covers the operators).
    const relay = evidenceFor(binding, { providerOperatorIds: ['relay-alchemy', 'relay-publicnode'] });
    expect(relay.evidenceHash).not.toBe(shell.evidenceHash);
    const again = await freezeWatcherClaimEvidence(db as unknown as Firestore, frozen, relay, 1_002);
    expect(again.evidenceSnapshot?.evidenceHash).toBe(shell.evidenceHash);

    // A different chain fact (a reorged block) still refuses.
    const reorged = evidenceFor(binding, {
      providerOperatorIds: ['relay-alchemy', 'relay-publicnode'],
      blockHash: `0x${'ee'.repeat(32)}`,
    });
    await expect(freezeWatcherClaimEvidence(db as unknown as Firestore, again, reorged, 1_003))
      .rejects.toThrow('watcher_claim_evidence_conflict');
  });
});

describe('recovery reads unfinished claims; a full integrity pass runs daily', () => {
  const COLLECTION = 'watcher_claims';
  async function seed(fake: ReturnType<typeof createFakeFirestore>, settled: number, pending: number): Promise<string[]> {
    const db = fake as unknown as Firestore;
    const pendingIds: string[] = [];
    for (let index = 0; index < settled + pending; index += 1) {
      const { binding, payload } = fixture(index);
      const id = watcherClaimDocumentId(binding);
      const handle = await createWatcherClaim(db, db.collection(COLLECTION).doc(id), binding, payload, 1_000);
      if (!handle) throw new Error('test_claim_create_failed');
      if (index < settled) {
        const { evidenceHash: _hash, ...base } = baseEconomicEvidence({
          transactionHash: binding.transactionHash, logIndex: binding.logIndex, blockNumber: 101,
          fromAddress: binding.fromAddress, toAddress: binding.toAddress, amountAtomic: binding.amountAtomic,
        });
        const frozen = await freezeWatcherClaimEvidence(db, handle, { ...base, evidenceHash: hashBaseUsdcTransferEvidence(base) }, 1_001);
        await markWatcherClaimComplete(db, frozen, `pe-${index}`, 1_002);
      }
      else { await markWatcherClaimPending(db, handle, new Error('retry'), 1_001); pendingIds.push(id); }
    }
    return pendingIds;
  }

  it('the first run does a full pass and records it; the next run reads only the unfinished claims', async () => {
    const fake = createFakeFirestore();
    const pendingIds = await seed(fake, 120, 3);
    const first = countingFirestore(fake as unknown as Firestore, COLLECTION);
    const firstRun = await leaseWatcherRecoveryClaims(first.db, COLLECTION, 2_000, 100);
    expect(first.docsRead()).toBe(123);
    expect(firstRun.handles.map((h) => h.ref.id).sort()).toEqual([...pendingIds].sort());
    expect(fake.store.get(`${WATCHER_RECOVERY_INTEGRITY_COLLECTION}/${COLLECTION}`)).toMatchObject({ last_clean_full_pass_ms: 2_000 });
    for (const handle of firstRun.handles) await markWatcherClaimPending(fake as unknown as Firestore, handle, new Error('retry'), 2_001);

    const second = countingFirestore(fake as unknown as Firestore, COLLECTION);
    // Past the lease expiry, so the same claims are leasable again.
    const later = 2_000 + 60 * 60 * 1000;
    const secondRun = await leaseWatcherRecoveryClaims(second.db, COLLECTION, later, 100);
    expect(secondRun.handles.map((h) => h.ref.id).sort()).toEqual([...pendingIds].sort());
    // NEGATIVE CONTROL: the pre- scan read all 123 claims on every run.
    expect(second.docsRead()).toBe(3);
  });

  it('a malformed unfinished claim still blocks between full passes', async () => {
    const fake = createFakeFirestore();
    const pendingIds = await seed(fake, 5, 2);
    await leaseWatcherRecoveryClaims(fake as unknown as Firestore, COLLECTION, 2_000, 100);
    const key = `${COLLECTION}/${pendingIds[0]}`;
    const broken = { ...fake.store.get(key)! };
    delete broken.payload_hash;
    fake.store.set(key, broken);
    const run = await leaseWatcherRecoveryClaims(fake as unknown as Firestore, COLLECTION, 2_000 + 60 * 60 * 1000, 100);
    expect(run.issues.map((i) => i.documentId)).toContain(pendingIds[0]);
  });

  it('RED: a full pass that finds a malformed claim is not recorded, so every run repeats it until repaired', async () => {
    const fake = createFakeFirestore();
    await seed(fake, 5, 0);
    const settledKey = [...fake.store.keys()].find((k) => k.startsWith(`${COLLECTION}/`))!;
    const broken = { ...fake.store.get(settledKey)! };
    delete broken.payload_hash;
    fake.store.set(settledKey, broken);
    const first = await leaseWatcherRecoveryClaims(fake as unknown as Firestore, COLLECTION, 2_000, 100);
    expect(first.issues).toHaveLength(1);
    expect(fake.store.get(`${WATCHER_RECOVERY_INTEGRITY_COLLECTION}/${COLLECTION}`)).toBeUndefined();
    const second = await leaseWatcherRecoveryClaims(fake as unknown as Firestore, COLLECTION, 2_000 + 60_000, 100);
    expect(second.issues).toHaveLength(1);
  });

  it('a clean pass older than a day forces the next full pass', async () => {
    const fake = createFakeFirestore();
    await seed(fake, 10, 0);
    await leaseWatcherRecoveryClaims(fake as unknown as Firestore, COLLECTION, 2_000, 100);
    const counting = countingFirestore(fake as unknown as Firestore, COLLECTION);
    await leaseWatcherRecoveryClaims(counting.db, COLLECTION, 2_000 + WATCHER_RECOVERY_FULL_PASS_INTERVAL_MS, 100);
    expect(counting.docsRead()).toBe(10);
  });
});
