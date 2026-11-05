/** Real-pricing emulator controls for rowless single-lane batches, actor-wide replay
 * membership, minimal output trust keys, delayed settlement and reorg retention.
 * Run with FIRESTORE_EMULATOR_HOST set to a local Firestore emulator.
 */
import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import { createHash } from 'crypto';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;

const memory = new Map<string, unknown>();
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: async () => 0,
    getUserActionTypeCountStrict: async () => 0,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async () => ({ idempotent: false }),
    checkRateLimit: async () => ({ allowed: true }),
    get: async (k: string) => memory.get(k) ?? null,
    set: async (k: string, v: unknown) => { memory.set(k, v); },
    del: async (k: string) => { memory.delete(k); },
    setBeneficiaryStatus: async () => {},
    getBeneficiaryStatus: async () => null,
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }), queueInitialMembershipGrants: async () => {},
}));

jest.setTimeout(60_000);

const RUN = `s${Date.now().toString(36)}`;
const NOW = Date.now();

function fp(seed: string): string {
  return createHash('sha256').update(`${RUN}:${seed}`).digest('hex');
}

type Wire = typeof import('./meter-wire');
let db: FirebaseFirestore.Firestore;
let wire: Wire;

async function seedUnlinkedAgent(walletId: string, agentId: string, address: string): Promise<void> {
  await db.collection('agent_wallets').doc(walletId).set({
    id: walletId, agent_id: agentId, address, status: 'active', created_at: NOW - 86_400_000,
    operational_reserve_ratio: null, parent_wallet_id: null,
    linked_human_wallet_id: null, linked_human_user_id: null, linked_human_address: null,
  });
  const { canonicalAgentPeHash } = await import('../agent-wallet/canonical-agent-pe-chain');
  const rel = {
    state: 'unlinked', human_wallet_id: null, human_user_id: null, human_address: null,
    operational_reserve_ratio: null, parent_wallet_id: null, revision: 1,
  };
  const sourcePeId = `pe_rel_${walletId}`;
  const canonical = {
    id: sourcePeId, wallet_id: walletId, agent_id: agentId, user_id: agentId, actor_address: address,
    action_type: 'agent_wallet_created', timestamp: 1, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { beneficiary_relationship: rel },
    compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
  };
  const hash = canonicalAgentPeHash(canonical);
  await db.collection('identity_pes_legacy_v1').doc(sourcePeId).set({
    ...canonical, hash, policy_action_type: 'wallet_created', integration_source: 'agent_bank_generate_pe',
    counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false,
    trust_level_at_creation: null, created_at: 1, durability: 'final',
  });
  await db.collection('agent_beneficiary_relationships_v1').doc(walletId).set({
    schema_version: 'agent-beneficiary-relationship/v1', wallet_id: walletId, agent_id: agentId, ...rel,
    source_action_type: 'agent_wallet_created', source_pe_id: sourcePeId, source_pe_hash: hash,
    created_at_ms: 1, updated_at_ms: 1,
  });
}

interface Device {
  readonly deviceId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly address: string;
  chainTip: string;
  seq: number;
  prevBatch: string;
  n: number;
}

async function newDevice(tag: string): Promise<Device> {
  const d: Device = {
    deviceId: `dev_${tag}_${RUN}`,
    agentId: `agent_${tag}_${RUN}`,
    walletId: `wallet_aw_${tag}${RUN}`,
    address: `0x${createHash('sha256').update(`${tag}${RUN}`).digest('hex').slice(0, 40)}`,
    chainTip: 'genesis', seq: 0, prevBatch: 'genesis', n: 0,
  };
  await seedUnlinkedAgent(d.walletId, d.agentId, d.address);
  await db.collection('devices').doc(d.deviceId).set(deviceDoc(d) as unknown as Record<string, unknown>);
  return d;
}

function deviceDoc(d: Device): import('../../routes/middleware/device-auth').DeviceDocument {
  return {
    device_id: d.deviceId, owner_type: 'agent', owner_user_id: d.agentId, owner_wallet_id: d.walletId,
    owner_address: d.address, signing_method: 'bearer', attestation_capability: 'software',
    platform: 'darwin', status: 'active',
  } as unknown as import('../../routes/middleware/device-auth').DeviceDocument;
}

function chatPe(d: Device, fingerprint: string, timestamp: number): import('./meter-wire').PeV2 {
  const pe = {
    schema: wire.PE_V2_SCHEMA, pe_id: `pe_${d.deviceId}_${d.n++}`, device_id: d.deviceId, prev_hash: d.chainTip,
    timestamp, action_type: 'ai_conversation',
    metadata: { session_fingerprint_hash: fingerprint, surface: 'claude_code' },
  };
  d.chainTip = wire.peHashOf(pe);
  return pe;
}

/**
 * A `compute_session` the daemon saw produce nothing, under its attested observer session (the
 * lineage claim the SDK mints, ordinal = the device's next session): it seals `skipped_no_output`.
 */
async function skippedComputePe(d: Device, timestamp: number, ordinal: number): Promise<import('./meter-wire').PeV2> {
  const { deriveEconomicSessionLineageId, ECONOMIC_SESSION_LINEAGE_VERSION } = await import('../pvt/economic-session-lineage');
  const nonce = createHash('sha256').update(`${RUN}:${d.deviceId}:${ordinal}`).digest('hex').slice(0, 32);
  const lineage = {
    v: ECONOMIC_SESSION_LINEAGE_VERSION,
    id: deriveEconomicSessionLineageId({ attestedDeviceId: d.deviceId, sessionStartedAtMs: timestamp - 1_000, sessionNonce: nonce, sessionOrdinal: ordinal }),
    session_nonce: nonce,
    session_started_at_ms: timestamp - 1_000,
    session_ordinal: ordinal,
  };
  const pe = {
    schema: wire.PE_V2_SCHEMA, pe_id: `pe_${d.deviceId}_${d.n++}`, device_id: d.deviceId, prev_hash: d.chainTip,
    timestamp, action_type: 'compute_session',
    metadata: { null_state_flags: ['no_observable_output'] },
    economic_session_lineage: lineage,
  };
  d.chainTip = wire.peHashOf(pe);
  return pe;
}

async function laneFor(d: Device, singleLaneCut: boolean, nowMs: number): Promise<import('./meter-ingest').MeterLane> {
  const deviceAct = await import('./device-act');
  const cache = (await import('../../cache')).cache;
  const dl = await deviceAct.openDeviceBatchLane({
    db, cache, device: deviceDoc(d), signatureAuthenticated: false, bodyBound: true, receivedAtMs: nowMs,
  });
  return {
    deviceId: d.deviceId, actorId: dl.ownerId, resolveSealedRecipient: () => null,
    mapAct: (act, relayPeId) => deviceAct.deviceActToAccrualParams(dl, act, relayPeId),
    extraWrites: () => { const w = deviceAct.laneLineageWrite(dl); return w ? [w] : []; },
    singleLaneCut,
  };
}

function batchOf(d: Device, pes: import('./meter-wire').PeV2[], createdAt: number): import('./meter-wire').PeBatch {
  return wire.buildBatch({ device_id: d.deviceId, seq: d.seq + 1, prev_batch_hash: d.prevBatch, created_at_ms: createdAt, pes });
}

function accept(d: Device, batch: import('./meter-wire').PeBatch): void {
  d.seq = batch.seq;
  d.prevBatch = wire.batchHashOf(batch);
}

async function claimDocCount(collection: string, userId: string): Promise<number> {
  // Mint-once / novelty claim docs carry the subject; any doc for this run's actor counts.
  const snap = await db.collection(collection).get();
  return snap.docs.filter((doc) => JSON.stringify(doc.data()).includes(userId)).length;
}

suite(' — single-lane acts keep no per-act document (Firestore emulator)', () => {
  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-meter';
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
    try { db.settings((await import('../../firestore-settings')).RELAY_FIRESTORE_SETTINGS); } catch { /* already set */ }
    wire = await import('./meter-wire');
  });

  it('control: on a lane that does not opt in, the same act keeps its act key and mint-once claim', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { METER_ACT_KEYS_COLLECTION } = await import('./meter-store');
    const d = await newDevice('ctl');
    const batch = batchOf(d, [chatPe(d, fp('ctl'), NOW - 60_000)], NOW);
    const res = await ingestMeterBatch(db, await laneFor(d, false, NOW), batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[single-lane] control receipt', JSON.stringify(receipt.acts.map((a) => [a.disposition, a.reason])));
    expect(receipt.acts[0].disposition).toBe('eligible');
    expect((await db.collection(METER_ACT_KEYS_COLLECTION).doc(receipt.acts[0].relay_pe_id).get()).exists).toBe(true);
    expect(await claimDocCount('device_occurrence_mint_claims', d.agentId)).toBe(1);
  });

  it('a single-lane act mints from batch totals with no act key, per-act occurrence document or act page', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { METER_ACT_KEYS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, METER_BATCHES_COLLECTION } = await import('./meter-store');
    const { readBatchActPages } = await import('./meter-act-pages');
    const { settleMeterClaims } = await import('./meter-settlement');
    const { listRecentActKeys } = await import('./owner-reads');
    const d = await newDevice('one');

    const first = chatPe(d, fp('one-a'), NOW - 60_000);
    const sameInBatch = chatPe(d, fp('one-a'), NOW - 50_000); // the same occurrence, same batch
    const other = chatPe(d, fp('one-b'), NOW - 40_000);
    const batch = batchOf(d, [first, sameInBatch, other], NOW);
    const lane = await laneFor(d, true, NOW);
    const res = await ingestMeterBatch(db, lane, batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[single-lane] receipt', JSON.stringify(receipt.acts.map((a) => [a.disposition, a.reason, a.record_points_atomic])));
    const [rFirst, rSame, rOther] = receipt.acts;
    expect(rFirst.disposition).toBe('eligible');
    expect(BigInt(rFirst.record_points_atomic)).toBeGreaterThan(0n);
    expect(rOther.disposition).toBe('eligible');
    // The in-batch second sighting earns nothing (the first sighting above earned: RED control).
    expect(rSame.disposition === 'eligible' && BigInt(rSame.record_points_atomic) > 0n).toBe(false);
    accept(d, batch);

    // No act key; the one per-occurrence record is its mint-once claim (fix run 2026-10-24): one per
    // distinct occurrence (the in-batch duplicate takes none), and no artifact-novelty claim.
    for (const r of receipt.acts) {
      expect((await db.collection(METER_ACT_KEYS_COLLECTION).doc(r.relay_pe_id).get()).exists).toBe(false);
    }
    expect(await claimDocCount('device_occurrence_mint_claims', d.agentId)).toBe(0);
    expect(await claimDocCount('artifact_novelty_claims', d.agentId)).toBe(0);
    // The rows are on the batch's act page; the batch record says how many pages.
    const pages = await readBatchActPages(db, receipt.batch_hash);
    expect(pages).toHaveLength(0);
    const batchRecord = (await db.collection(METER_BATCHES_COLLECTION).doc(receipt.batch_hash).get()).data()!;
    expect(batchRecord.act_pages).toBe(0);
    expect(batchRecord.per_batch_pricing).toBe(true);
    expect(batchRecord.economic_totals).toHaveLength(1);
    expect(batchRecord.economic_totals[0].count).toBe(2);
    expect(batchRecord.economic_totals[0].rated).toBe(receipt.totals.eligible_points_atomic);
    const claims = await db.collection(METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', receipt.batch_hash).get();
    expect(claims.size).toBe(1);
    expect(claims.docs[0].data().record_points_atomic).toBe(receipt.totals.eligible_points_atomic);

    // The same batch re-sent: the same receipt. A replayed (stale) batch: refused.
    const again = await ingestMeterBatch(db, lane, batch, NOW + 1_000);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(receipt);
    const replay = wire.buildBatch({
      device_id: d.deviceId, seq: 1, prev_batch_hash: 'genesis', created_at_ms: NOW + 2_000,
      pes: [{ ...first, metadata: { ...(first.metadata as Record<string, unknown>), surface: 'replayed' } }],
    });
    const refused = await ingestMeterBatch(db, await laneFor(d, true, NOW + 10 * 60_000), replay, NOW + 10 * 60_000);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toBe('batch_replay');

    // The owner's 31-day history lists the acts from the page.
    const history = await listRecentActKeys(db, [d.agentId], { limit: 10 });
    expect(history.acts).toHaveLength(0);

    // Settlement flips the eligible rows on the page to minted (the in-batch duplicate stays).
    const tally = await settleMeterClaims(db, {
      claimKeys: claims.docs.map((c) => c.id), batchId: '0xbatch', txHash: '0xtx', nowMs: NOW + 60_000,
    });
    expect(tally.claims_settled).toBe(1);
    expect(tally.acts_minted).toBe(2);
    expect(tally.acts_without_key).toBe(0);
    const after = (await db.collection(METER_BATCHES_COLLECTION).doc(receipt.batch_hash).get()).data()!;
    expect(after.economic_settled).toBe(true);
    expect(await readBatchActPages(db, receipt.batch_hash)).toHaveLength(0);
    const aggregate = (await db.collection('pe_economic_aggregates').doc(d.agentId).get()).data()!;
    expect(aggregate.roles.contributor.pes_by_mint_status.minted).toBe(2);
    expect(aggregate.roles.contributor.batch_pending_rated_atomic).toBe('0');
  });

  it('retains only output trust economics while a long interval is unpaid, then preserves reorg retention', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { privateRetentionCollection } = await import('../provenance/private-retention');
    const { settleMeterClaims, revertMeterClaimsSettled } = await import('./meter-settlement');
    const d = await newDevice('output-trust');
    const plain = chatPe(d, fp('output-trust'), NOW - 60_000);
    const output = { ...plain, description: 'OWNER ONLY BODY', output_digests: [{ hash: 'sha256:' + fp('output-artifact'), kind: 'file' }] };
    d.chainTip = wire.peHashOf(output);
    const batch = batchOf(d, [output], NOW);
    const result = await ingestMeterBatch(db, await laneFor(d, true, NOW), batch, NOW);
    expect(result.status).toBe(201);
    const receipt = result.body as import('./meter-store').MeterBatchReceipt;
    expect(receipt.acts[0].disposition).toBe('eligible');
    const ref = privateRetentionCollection(db, 'meter_act_keys_v1').doc(receipt.acts[0].relay_pe_id);
    const before = (await ref.get()).data()!;
    expect(before.pending_retention_v1).toBe(true); expect(before.expire_at).toBeNull();
    expect(before.row.metadata).toBeUndefined(); expect(JSON.stringify(before)).not.toContain('OWNER ONLY BODY');
    expect(before.facts).toBeNull();
    const claims = await db.collection('meter_pending_claims_v1').where('batch_hash', '==', receipt.batch_hash).get();
    const delayed = NOW + 60 * 86_400_000;
    await settleMeterClaims(db, { claimKeys: claims.docs.map(c => c.id), batchId: 'delayed', txHash: 'tx', nowMs: delayed });
    const after = (await ref.get()).data()!;
    expect(after.row.mint_status).toBe('minted');
    expect(after.expire_at.toMillis()).toBeGreaterThanOrEqual(delayed + 30 * 86_400_000);
    await revertMeterClaimsSettled(db, { claimKeys: claims.docs.map(c => c.id), nowMs: delayed + 1000 });
    expect((await ref.get()).data()!.expire_at).toBeNull();
  });

  it('the same occurrence from a second device of one actor never mints twice', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const firstDevice = await newDevice('same-owner');
    const secondDevice: Device = { ...firstDevice, deviceId: firstDevice.deviceId + '_second', chainTip: 'genesis', seq: 0, prevBatch: 'genesis', n: 0 };
    await db.collection('devices').doc(secondDevice.deviceId).set(deviceDoc(secondDevice) as unknown as Record<string, unknown>);
    const first = batchOf(firstDevice, [chatPe(firstDevice, fp('shared-device-occurrence'), NOW - 60_000)], NOW);
    const accepted = await ingestMeterBatch(db, await laneFor(firstDevice, true, NOW), first, NOW);
    expect(accepted.status).toBe(201);
    expect((accepted.body as import('./meter-store').MeterBatchReceipt).acts[0].disposition).toBe('eligible');
    const next = batchOf(secondDevice, [chatPe(secondDevice, fp('shared-device-occurrence'), NOW - 40_000), chatPe(secondDevice, fp('new-device-occurrence'), NOW - 30_000)], NOW);
    const result = await ingestMeterBatch(db, await laneFor(secondDevice, true, NOW), next, NOW);
    expect(result.status).toBe(201);
    const [duplicate, fresh] = (result.body as import('./meter-store').MeterBatchReceipt).acts;
    expect(duplicate.record_points_atomic).toBe('0');
    expect(duplicate.disposition).not.toBe('eligible');
    expect(fresh.disposition).toBe('eligible');
    expect(BigInt(fresh.record_points_atomic)).toBeGreaterThan(0n);
    expect(await claimDocCount('device_occurrence_mint_claims', firstDevice.agentId)).toBe(0);
  });

  it('fix run 2026-10-24: the same occurrence in a LATER batch earns nothing (cross-batch mint-once on the single-lane cut)', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const d = await newDevice('xb');
    const first = batchOf(d, [chatPe(d, fp('xb-a'), NOW - 60_000)], NOW);
    const r1 = await ingestMeterBatch(db, await laneFor(d, true, NOW), first, NOW);
    expect(r1.status).toBe(201);
    const a1 = (r1.body as import('./meter-store').MeterBatchReceipt).acts[0];
    expect(a1.disposition).toBe('eligible'); // RED control: the first sighting mints
    expect(BigInt(a1.record_points_atomic)).toBeGreaterThan(0n);
    accept(d, first);

    const t2 = NOW + 6 * 60_000;
    const resent = chatPe(d, fp('xb-a'), t2 - 60_000); // the same occurrence, re-witnessed
    const fresh = chatPe(d, fp('xb-b'), t2 - 30_000);
    const second = batchOf(d, [resent, fresh], t2);
    const r2 = await ingestMeterBatch(db, await laneFor(d, true, t2), second, t2);
    expect(r2.status).toBe(201);
    const [aResent, aFresh] = (r2.body as import('./meter-store').MeterBatchReceipt).acts;
    console.log('[single-lane] cross-batch', JSON.stringify([[aResent.disposition, aResent.reason, aResent.record_points_atomic], [aFresh.disposition, aFresh.record_points_atomic]]));
    expect(aResent.disposition === 'eligible' && BigInt(aResent.record_points_atomic) > 0n).toBe(false);
    expect(aFresh.disposition).toBe('eligible');
    expect(BigInt(aFresh.record_points_atomic)).toBeGreaterThan(0n);
  });

  it('fix run 2026-10-24 ( ): a later act reproducing the SAME relay id (from a chosen pe_hash) earns nothing', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const d = await newDevice('sameid');
    const first = batchOf(d, [chatPe(d, fp('sameid-a'), NOW - 60_000)], NOW);
    const r1 = await ingestMeterBatch(db, await laneFor(d, true, NOW), first, NOW);
    const a1 = (r1.body as import('./meter-store').MeterBatchReceipt).acts[0];
    expect(a1.disposition).toBe('eligible');
    accept(d, first);

    // The relay never recomputes pe_hash: a forged one sharing the first 48 hex chars reuses the relay id.
    const t2 = NOW + 6 * 60_000;
    const pe = chatPe(d, fp('sameid-a'), t2 - 60_000);
    const forged = `${first.acts[0].pe_hash.slice(0, 48)}${'f'.repeat(16)}`;
    const acts = [{ ...wire.actRecordOf(pe), pe_hash: forged }];
    const second = { ...batchOf(d, [pe], t2), acts, acts_root: wire.actsRootOf(acts) };
    const r2 = await ingestMeterBatch(db, await laneFor(d, true, t2), second, t2);
    expect(r2.status).toBe(201);
    const a2 = (r2.body as import('./meter-store').MeterBatchReceipt).acts[0];
    expect(a2.relay_pe_id).toBe(a1.relay_pe_id);
    expect(a2.disposition === 'eligible' && BigInt(a2.record_points_atomic) > 0n).toBe(false);
  });

  it('fix run 2026-10-24: an occurrence claim taken after pricing read it absent forces a reprice, never a second claim', async () => {
    const { prepareDeviceOccurrenceMintClaim, singleLaneOccurrenceClaimHook } = await import('../pvt/device-occurrence-claim');
    const { NoveltyCounterConflictError } = await import('./batch-pricing-counters');
    const user = `race_${RUN}`;
    const hash = fp('race');
    const mine = await prepareDeviceOccurrenceMintClaim(db, user, hash, 'pe_m_mine');
    expect(mine.evidence.relation).toBe('owner');
    const hook = singleLaneOccurrenceClaimHook(db, mine, NOW);
    // Another batch commits the same occurrence first.
    const theirs = await prepareDeviceOccurrenceMintClaim(db, user, hash, 'pe_m_theirs');
    await db.runTransaction(async (txn) => {
      const h = singleLaneOccurrenceClaimHook(db, theirs, NOW);
      await h.inspect(txn);
      h.commit(txn);
    });
    await expect(db.runTransaction(async (txn) => { await hook.inspect(txn); hook.commit(txn); }))
      .rejects.toBeInstanceOf(NoveltyCounterConflictError);
    const claim = (await db.collection(mine.claim_collection).doc(mine.evidence.claim.claim_id).get()).data();
    expect(claim?.owner_pe_id).toBe('pe_m_theirs');
    // It expires with every meter mint-once claim (occurrence + 31 days), never accumulating forever.
    expect(claim?.expire_at?.toMillis()).toBe(NOW + 31 * 86_400_000);
    // Repriced, the occurrence reads as a duplicate.
    expect((await prepareDeviceOccurrenceMintClaim(db, user, hash, 'pe_m_mine')).evidence.relation).toBe('duplicate');
  });

  it('a compute_session sealed skipped_no_output leaves no per-act record, stays in the chain, and moves no other act', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { METER_ACT_KEYS_COLLECTION, METER_BATCHES_COLLECTION, METER_DEVICE_TIPS_COLLECTION } = await import('./meter-store');
    const { readBatchActPages } = await import('./meter-act-pages');
    const { actLeafOf } = await import('./meter-wire');
    const d = await newDevice('skip');
    const ctl = await newDevice('skipctl');

    // Control: the same chat acts with no skipped act between them.
    const ctlBatch = batchOf(ctl, [chatPe(ctl, fp('skipctl-a'), NOW - 60_000), chatPe(ctl, fp('skipctl-b'), NOW - 40_000)], NOW);
    const ctlRes = await ingestMeterBatch(db, await laneFor(ctl, true, NOW), ctlBatch, NOW);
    expect(ctlRes.status).toBe(201);
    const ctlReceipt = ctlRes.body as import('./meter-store').MeterBatchReceipt;

    const chatA = chatPe(d, fp('skip-a'), NOW - 60_000);
    const skipped = await skippedComputePe(d, NOW - 50_000, 1);
    const chatB = chatPe(d, fp('skip-b'), NOW - 40_000);
    const batch = batchOf(d, [chatA, skipped, chatB], NOW);
    const res = await ingestMeterBatch(db, await laneFor(d, true, NOW), batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[] receipt', JSON.stringify(receipt.acts.map((a) => [a.disposition, a.reason, a.mint_status, a.record_points_atomic])));
    const [rA, rSkip, rB] = receipt.acts;
    expect(rSkip.mint_status).toBe('skipped_no_output');
    expect(rSkip.disposition).toBe('ineligible');
    expect(rSkip.record_points_atomic).toBe('0');
    accept(d, batch);

    // No change to how any other act seals or prices: the chats match the control exactly.
    expect([rA, rB].map((r) => [r.disposition, r.reason, r.mint_status, r.record_points_atomic]))
      .toEqual(ctlReceipt.acts.map((r) => [r.disposition, r.reason, r.mint_status, r.record_points_atomic]));
    expect(receipt.totals.eligible_points_atomic).toBe(ctlReceipt.totals.eligible_points_atomic);

    // No per-act record of the skipped act: no act key, no claim document, no act-page row. The
    // eligible acts' rows ARE on the page (RED control: the page mechanism ran for this batch).
    expect((await db.collection(METER_ACT_KEYS_COLLECTION).doc(rSkip.relay_pe_id).get()).exists).toBe(false);
    // The two chats each hold their occurrence claim; the skipped act holds none.
    expect(await claimDocCount('device_occurrence_mint_claims', d.agentId)).toBe(0);
    expect(await claimDocCount('artifact_novelty_claims', d.agentId)).toBe(0);
    const pages = await readBatchActPages(db, receipt.batch_hash);
    expect(pages).toHaveLength(0);
    const summary = (await db.collection(METER_BATCHES_COLLECTION).doc(receipt.batch_hash).get()).data()!;
    expect(summary.economic_totals[0].count).toBe(2);

    // It stays in the device's chain: its leaf is in the anchored batch record.
    const batchDoc = (await db.collection(METER_BATCHES_COLLECTION).doc(receipt.batch_hash).get()).data();
    expect(batchDoc?.act_count).toBe(3);
    expect(batchDoc?.act_leaves).toEqual(batch.acts.map(actLeafOf));

    // A batch of ONLY a skipped act: accepted, no act page at all; the tip ends on its hash, and
    // the next batch chains off it (chain verification passes).
    const t2 = NOW + 10 * 60_000;
    const lone = await skippedComputePe(d, t2 - 1_000, 2);
    const loneBatch = batchOf(d, [lone], t2);
    const loneRes = await ingestMeterBatch(db, await laneFor(d, true, t2), loneBatch, t2);
    expect(loneRes.status).toBe(201);
    accept(d, loneBatch);
    const loneHash = (loneRes.body as import('./meter-store').MeterBatchReceipt).batch_hash;
    expect(await readBatchActPages(db, loneHash)).toHaveLength(0);
    expect((await db.collection(METER_BATCHES_COLLECTION).doc(loneHash).get()).data()?.act_pages).toBe(0);
    expect((await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(d.deviceId).get()).data()?.last_pe_hash).toBe(wire.peHashOf(lone));

    const t3 = t2 + 10 * 60_000;
    const next = batchOf(d, [chatPe(d, fp('skip-c'), t3 - 1_000)], t3);
    const nextRes = await ingestMeterBatch(db, await laneFor(d, true, t3), next, t3);
    expect(nextRes.status).toBe(201);
    expect((nextRes.body as import('./meter-store').MeterBatchReceipt).acts[0].disposition).toBe('eligible');
    accept(d, next);

    // RED control for the chain check itself: an act that links back past the last act is refused.
    const t4 = t3 + 10 * 60_000;
    const broken = batchOf(d, [{ ...chatPe(d, fp('skip-d'), t4 - 1_000), prev_hash: wire.peHashOf(lone) }], t4);
    const brokenRes = await ingestMeterBatch(db, await laneFor(d, true, t4), broken, t4);
    expect(brokenRes.status).toBe(409);
    expect((brokenRes.body as { error: string }).error).toBe('act_chain_broken');
  });

  it('off the single-lane cut a skipped compute_session fails closed (no act key would guard its replay)', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { METER_DEVICE_TIPS_COLLECTION, METER_ACT_KEYS_COLLECTION } = await import('./meter-store');
    const { meterRelayPeId } = await import('./meter-store');
    const d = await newDevice('skipoff');
    const skipped = await skippedComputePe(d, NOW - 30_000, 1);
    const batch = batchOf(d, [skipped], NOW);
    let thrown: unknown = null;
    try {
      await ingestMeterBatch(db, await laneFor(d, false, NOW), batch, NOW);
    } catch (error) {
      thrown = error;
    }
    console.log('[] off-lane refusal', String(thrown));
    expect(String(thrown)).toMatch(/meter_chain_continuity_record_off_single_lane:compute_session/);
    // Nothing committed: no tip, no act key.
    expect((await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(d.deviceId).get()).exists).toBe(false);
    expect((await db.collection(METER_ACT_KEYS_COLLECTION).doc(meterRelayPeId(wire.peHashOf(skipped))).get()).exists).toBe(false);
  });
});

