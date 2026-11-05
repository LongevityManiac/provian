/** Real ingest, accrual, seal, Firestore commit and counter effects. Stateful Redis counters
 * reproduce delayed batch writes. This MUST fail on pre-fix master: [60] repeats ordinal 25
 * while [1,...] crosses ordinal 50. Run with FIRESTORE_EMULATOR_HOST set. */
import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import { createHash } from 'crypto';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;

const memory = new Map<string, unknown>();
const readBarriers = new Map<string, () => Promise<void>>();
jest.mock('../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: async (u: string) => {
      const count = memory.get(`daily:${u}`) ?? 24;
      await readBarriers.get(u)?.();
      return count;
    },
    getUserActionTypeCountStrict: async (u: string, a: string) => memory.get(`occ:${u}:${a}`) ?? 24,
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: async () => 1,
    incrementHourlyPECount: async () => {},
    commitPEAccountingCountersOnce: async (p: { peId: string; userId: string; actionType: string }) => {
      const claim = `claimed:${p.peId}`;
      if (memory.has(claim)) return { idempotent: true };
      memory.set(claim, true);
      for (const key of [`daily:${p.userId}`, `occ:${p.userId}:${p.actionType}`]) memory.set(key, Number(memory.get(key) ?? 24) + 1);
      return { idempotent: false };
    },
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
const committedRows = new Map<string, Record<string, unknown>>();

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

suite('novelty ordinals are independent of batch partition (native Firestore)', () => {
  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = 'demo-meter';
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    process.env.FIRESTORE_DATABASE_ID = 'novelty-' + RUN;
    const raw = (await import('firebase-admin/firestore')).getFirestore(admin.app(),process.env.FIRESTORE_DATABASE_ID);
    db = (await import('../../firestore-db')).relayDb();
    const {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} = await import('../provenance/private-retention');
    await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_ids_ready:true,opaque_records_complete:true});
    wire = await import('./meter-wire');
    const commits = await import('./meter-commit');
    const commit = commits.commitMeterBatch;
    jest.spyOn(commits, 'commitMeterBatch').mockImplementation(async (database, input) => {
      const receipt = await commit(database, input);
      for (const act of input.acts) if (act.kind === 'priced') committedRows.set(act.outcome.relayPeId, act.outcome.row);
      return receipt;
    });
  });

  async function sequence(tag: string, partitions: number[], single: boolean, mobile = false) {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { readBatchActPages } = await import('./meter-act-pages');
    const d = await newDevice(tag);
    if (mobile) await db.collection('wallets').doc(d.walletId).set({ user_id: d.agentId, address: d.address });
    const all = [];
    let index = 0;
    for (let b = 0; b < partitions.length; b++) {
      const now = NOW + b * ((await import('./meter-constants')).METER_MIN_BATCH_INTERVAL_MS + 1);
      const pes = Array.from({ length: partitions[b] }, () => {
        const fingerprint = fp(`${tag}:${index++}`);
        if (!mobile) return chatPe(d, fingerprint, NOW - 60_000);
        const pe = { schema: wire.PE_V2_SCHEMA, pe_id: `pe_${d.deviceId}_${d.n++}`, device_id: d.deviceId,
          prev_hash: d.chainTip, timestamp: NOW - 60_000, action_type: 'ai_conversation',
          ai_conversation_metadata: { provider: 'chatgpt', surface: 'mobile_wrapper', duration_ms: 1,
            active_duration_ms: 1, turn_count: 1, char_count: 1, image_count: 0, video_seconds: 0,
            session_fingerprint_hash: fingerprint, input_fidelity: 'full' } };
        d.chainTip = wire.peHashOf(pe);
        return pe;
      });
      const batch = batchOf(d, pes, now);
      let lane = await laneFor(d, single, now);
      if (mobile) {
        const { mobileActToAccrualParams } = await import('./mobile-act');
        const ml: import('./mobile-act').MobileBatchLane = { db, userId: d.agentId, deviceId: d.deviceId,
          attestationTier: 'software', deviceAttestationId: null, actorAddress: d.address,
          humanWalletDocId: d.walletId, receivedAtMs: now, appleAssertion: null, hooks: [], afterCommit: [] };
        lane = { deviceId: d.deviceId, actorId: d.agentId, resolveSealedRecipient: () => null,
          mapAct: (a, id) => mobileActToAccrualParams(ml, a, id), extraWrites: () => [], singleLaneCut: single };
      }
      const result = await ingestMeterBatch(db, lane, batch, now);
      expect(result.status).toBe(201);
      const receipt = result.body as import('./meter-store').MeterBatchReceipt;
      const pages = await readBatchActPages(db, receipt.batch_hash);
      for (const a of receipt.acts) {
        expect(a.disposition).toBe('eligible');
        expect(BigInt(a.record_points_atomic)).toBeGreaterThan(0n);
        const pageAct = pages.flatMap(p => Object.values(p.doc.acts)).find(r => r.relay_pe_id === a.relay_pe_id);
        const row = single ? committedRows.get(a.relay_pe_id) : (await (await import('../provenance/private-retention')).privateRetentionCollection(db, 'meter_act_keys_v1').doc(a.relay_pe_id).get()).data()?.row;
        expect(row).toBeDefined();
        const snapshot = row?.economic_snapshot as import('../pvt/policy/monetary-accounting').RecordEconomicSnapshot;
        all.push({ occurrence: snapshot.recordTimeFactors.occurrenceOrdinal, daily: snapshot.recordTimeFactors.dailyOrdinal,
          novelty: snapshot.recordTimeFactors.noveltyBps, points: a.record_points_atomic });
      }
      const again = await ingestMeterBatch(db, lane, batch, now + 1);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(receipt);
      accept(d, batch);
    }
    expect(all).toHaveLength(60);
    expect(memory.get(`occ:${d.agentId}:ai_conversation`)).toBe(84);
    return all;
  }

  it.each([[true, false], [false, false], [true, true]])('large = split = one-at-a-time (single %s mobile %s)', async (single, mobile) => {
    const tag = `${single}${mobile}`;
    const large = await sequence(`${tag}large`, [60], single, mobile);
    const split = await sequence(`${tag}split`, [7, 19, 1, 33], single, mobile);
    const ones = await sequence(`${tag}ones`, Array(60).fill(1), single, mobile);
    expect(large).toEqual(ones);
    expect(split).toEqual(ones);
    expect(large.map(a => a.occurrence)).toEqual(Array.from({ length: 60 }, (_, i) => 25 + i));
    expect(large.map(a => a.daily)).toEqual(Array.from({ length: 60 }, (_, i) => 25 + i));
    expect(large[25].novelty).toBe(6000);
    expect(large[26].novelty).toBe(3000);
    console.log('[novelty partition]', JSON.stringify({single, mobile, acts: large.length, first: large[0], last: large[59]}));
  });
  it.each([[true, false], [false, false], [true, true]])('concurrent devices allocate one continuous sequence (single %s mobile %s)', async (single, mobile) => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { readBatchActPages } = await import('./meter-act-pages');
    const root = await newDevice(`concurrent${single}${mobile}`);
    if (mobile) await db.collection('wallets').doc(root.walletId).set({ user_id: root.agentId, address: root.address });
    const devices = Array.from({ length: 3 }, (_, i) => ({ ...root, deviceId: `${root.deviceId}_${i}` }));
    let arrived = 0;
    let release!: () => void;
    const allRead = new Promise<void>((resolve) => { release = resolve; });
    readBarriers.set(root.agentId, async () => { if (++arrived === 3) release(); await allRead; });
    const jobs = await Promise.all(devices.map(async (d, i) => {
      await db.collection('devices').doc(d.deviceId).set(deviceDoc(d) as unknown as Record<string, unknown>);
      const pes = Array.from({ length: 20 }, (_, n) => {
        const fingerprint = fp(`${d.deviceId}:${n}`);
        if (!mobile) return chatPe(d, fingerprint, NOW - 60_000);
        const pe = { schema: wire.PE_V2_SCHEMA, pe_id: `pe_${d.deviceId}_${d.n++}`, device_id: d.deviceId,
          prev_hash: d.chainTip, timestamp: NOW - 60_000, action_type: 'ai_conversation',
          ai_conversation_metadata: { provider: 'chatgpt', surface: 'mobile_wrapper', duration_ms: 1,
            active_duration_ms: 1, turn_count: 1, char_count: 1, image_count: 0, video_seconds: 0,
            session_fingerprint_hash: fingerprint, input_fidelity: 'full' } };
        d.chainTip = wire.peHashOf(pe); return pe;
      });
      const batch = batchOf(d, pes, NOW + i);
      let lane = await laneFor(d, single, NOW);
      if (mobile) {
        const { mobileActToAccrualParams } = await import('./mobile-act');
        const ml: import('./mobile-act').MobileBatchLane = { db, userId: d.agentId, deviceId: d.deviceId,
          attestationTier: 'software', deviceAttestationId: null, actorAddress: d.address,
          humanWalletDocId: d.walletId, receivedAtMs: NOW, appleAssertion: null, hooks: [], afterCommit: [] };
        lane = { deviceId: d.deviceId, actorId: d.agentId, resolveSealedRecipient: () => null,
          mapAct: (a, id) => mobileActToAccrualParams(ml, a, id), extraWrites: () => [], singleLaneCut: single };
      }
      return { batch, lane };
    }));
    const results = await Promise.all(jobs.map(j => ingestMeterBatch(db, j.lane, j.batch, NOW)));
    readBarriers.delete(root.agentId);
    const seals = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      expect(result.status).toBe(201);
      const receipt = result.body as import('./meter-store').MeterBatchReceipt;
      const pages = await readBatchActPages(db, receipt.batch_hash);
      for (const a of receipt.acts) {
        expect(a.disposition).toBe('eligible');
        const row = single ? committedRows.get(a.relay_pe_id)
          : (await (await import('../provenance/private-retention')).privateRetentionCollection(db, 'meter_act_keys_v1').doc(a.relay_pe_id).get()).data()?.row;
        expect(row).toBeDefined();
        const snapshot = row?.economic_snapshot as import('../pvt/policy/monetary-accounting').RecordEconomicSnapshot;
        seals.push({ ordinal: snapshot.recordTimeFactors.occurrenceOrdinal, daily: snapshot.recordTimeFactors.dailyOrdinal,
          novelty: snapshot.recordTimeFactors.noveltyBps, points: a.record_points_atomic });
      }
      const replay = await ingestMeterBatch(db, jobs[i].lane, jobs[i].batch, NOW + 1);
      expect(replay.status).toBe(200); expect(replay.body).toEqual(receipt);
    }
    seals.sort((a,b) => a.ordinal - b.ordinal);
    console.log('[novelty concurrent]', JSON.stringify({ single, mobile, acts: seals.length,
      distinct: new Set(seals.map(s => s.ordinal)).size, first: seals[0], last: seals.at(-1) }));
    expect(seals).toHaveLength(60);
    expect(seals.map(s => s.ordinal)).toEqual(Array.from({length: 60}, (_, i) => 25 + i));
    expect(seals.map(s => s.daily).sort((a,b) => a-b)).toEqual(Array.from({length: 60}, (_, i) => 25 + i));
    expect(seals.filter(s => s.novelty === 6000)).toHaveLength(26);
    expect(seals.filter(s => s.novelty === 3000)).toHaveLength(34);
    expect(memory.get(`occ:${root.agentId}:ai_conversation`)).toBe(84);
  });

  it('a paused cutover rejects the batch without initializing counters or advancing its tip', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { NOVELTY_COUNTERS_COLLECTION } = await import('./batch-pricing-counters');
    const d = await newDevice('cutover-pause');
    const b = batchOf(d, [chatPe(d, fp('cutover-pause'), NOW - 60_000)], NOW);
    const lane = await laneFor(d, true, NOW);
    const before = (await db.collection(NOVELTY_COUNTERS_COLLECTION).get()).size;
    process.env.PVT_NOVELTY_SEALS_PAUSED = 'true';
    try { await expect(ingestMeterBatch(db, lane, b, NOW)).rejects.toThrow('novelty_seals_paused'); }
    finally { delete process.env.PVT_NOVELTY_SEALS_PAUSED; }
    expect((await db.collection(NOVELTY_COUNTERS_COLLECTION).get()).size).toBe(before);
    expect((await db.collection('meter_device_tips_v1').doc(d.deviceId).get()).exists).toBe(false);
    const result = await ingestMeterBatch(db, lane, b, NOW);
    expect(result.status).toBe(201);
    expect(BigInt((result.body as import('./meter-store').MeterBatchReceipt).acts[0].record_points_atomic)).toBeGreaterThan(0n);
  });
  it('a failed seal consumes no ordinal; concurrent replay consumes it exactly once', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { readBatchActPages } = await import('./meter-act-pages');
    const d = await newDevice('aborted-seal');
    const b = batchOf(d, [chatPe(d, fp('aborted-seal'), NOW - 60_000)], NOW);
    const lane = await laneFor(d, true, NOW);
    const refused = { ...lane, txnHooks: () => [{ read: async () => { throw new Error('forced seal abort'); }, write: () => {} }] };
    await expect(ingestMeterBatch(db, refused, b, NOW)).rejects.toThrow('forced seal abort');
    expect((await db.collection('meter_device_tips_v1').doc(d.deviceId).get()).exists).toBe(false);
    const results = await Promise.all([ingestMeterBatch(db, lane, b, NOW), ingestMeterBatch(db, await laneFor(d, true, NOW), b, NOW)]);
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.every(r => [200,201,409].includes(r.status))).toBe(true);
    const receipt = results.find(r => r.status === 201)!.body as import('./meter-store').MeterBatchReceipt;
    const replay = await ingestMeterBatch(db, await laneFor(d,true,NOW), b,NOW+1);
    expect(replay.status).toBe(200);expect(replay.body).toEqual(receipt);
    const pages = await readBatchActPages(db, receipt.batch_hash);
    const row = committedRows.get(receipt.acts[0].relay_pe_id)!;
    expect((row.economic_snapshot as import('../pvt/policy/monetary-accounting').RecordEconomicSnapshot).recordTimeFactors.occurrenceOrdinal).toBe(25);
    expect(memory.get(`occ:${d.agentId}:ai_conversation`)).toBe(25);
    accept(d,b);
    const after = NOW + (await import('./meter-constants')).METER_MIN_BATCH_INTERVAL_MS + 1;
    const next = batchOf(d,[chatPe(d,fp('after-abort'),NOW-30_000)],after);
    const accepted = await ingestMeterBatch(db,await laneFor(d,true,after),next,after);
    expect(accepted.status).toBe(201);
    const nextPages=await readBatchActPages(db,(accepted.body as import('./meter-store').MeterBatchReceipt).batch_hash);
    const nextRow=committedRows.get((accepted.body as import('./meter-store').MeterBatchReceipt).acts[0].relay_pe_id)!;
    expect((nextRow.economic_snapshot as import('../pvt/policy/monetary-accounting').RecordEconomicSnapshot).recordTimeFactors.occurrenceOrdinal).toBe(26);
  });

  it('relay-only acts compact, concurrent replay counts once, and an expired batch cannot mint again', async () => {
    const { buildRelayActIntake, priceRelayAct, relayBatchOf } = await import('./meter-relay-authored');
    const { privateRetentionCollection } = await import('../provenance/private-retention');
    const { readBatchActPages } = await import('./meter-act-pages');
    const d = await newDevice('relay-compaction');
    const lane = await laneFor(d, true, NOW);
    const pe = chatPe(d, fp('relay-compaction'), NOW - 60_000);
    const mapping = await lane.mapAct(wire.actRecordOf(pe), pe.pe_id);
    if (!mapping.ok) throw new Error('relay fixture refused');
    const intake = buildRelayActIntake({ pe, actorId: d.agentId, accrual: mapping.params, sealed: [], nowMs: NOW });
    const receipts = await Promise.all([priceRelayAct(db, intake, {nowMs: NOW}), priceRelayAct(db, intake, {nowMs: NOW})]);
    expect(receipts[0]).not.toBeNull();
    expect(receipts[1]).toEqual(receipts[0]);
    const receipt = receipts[0]!;
    expect(BigInt(receipt.acts[0].record_points_atomic)).toBeGreaterThan(0n);
    expect(memory.get(`occ:${d.agentId}:ai_conversation`)).toBe(25);
    expect((await privateRetentionCollection(db,'meter_act_keys_v1').doc(pe.pe_id).get()).exists).toBe(false);
    expect(await readBatchActPages(db, receipt.batch_hash)).toEqual([]);
    const batchRef = db.collection('meter_batches_v1').doc(receipt.batch_hash);
    const batch = (await batchRef.get()).data()!;
    expect(batch).toMatchObject({ relay_single_lane: true, retained_act_ids: [], settlement_complete: false });
    expect(batch.economic_totals.length).toBeGreaterThan(0);
    expect(batch.claim_keys.length).toBeGreaterThan(0);
    const claims = await Promise.all(batch.claim_keys.map((id: string) => db.collection('meter_pending_claims_v1').doc(id).get()));
    expect(claims.every(c => c.exists && c.data()?.unit === 'batch')).toBe(true);
    await batchRef.update({ anchored: true, anchor_tx: 'preserved' });
    expect(await priceRelayAct(db, intake, {nowMs: NOW + 1})).toEqual(receipt);
    expect((await batchRef.get()).data()?.anchor_tx).toBe('preserved');
    await batchRef.delete(); // model its eventual TTL; the permanent digest must still win
    expect(await priceRelayAct(db, intake, {nowMs: NOW + 40 * 86_400_000})).toBeNull();
    const changedPe = { ...pe, timestamp: NOW + 40 * 86_400_000 };
    const changed = buildRelayActIntake({ pe: changedPe, actorId: d.agentId, accrual: mapping.params, sealed: [], nowMs: changedPe.timestamp });
    expect(await priceRelayAct(db, changed, {nowMs: changedPe.timestamp})).toBeNull();
    expect((await db.collection('meter_batches_v1').doc(wire.batchHashOf(relayBatchOf(d.agentId,changed.act))).get()).exists).toBe(false);
    expect(memory.get(`occ:${d.agentId}:ai_conversation`)).toBe(25);
    expect(await Promise.all(batch.claim_keys.map((id: string) => db.collection('meter_pending_claims_v1').doc(id).get()))).toHaveLength(claims.length);
  });

  it('device, relay-authored and ordinary seals share the actor counter concurrently', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { readBatchActPages } = await import('./meter-act-pages');
    const { buildRelayActIntake, priceRelayAct } = await import('./meter-relay-authored');
    const { recordPEAccrual } = await import('../../pvt-accrual');
    const d = await newDevice('mixed-paths');
    const lane = await laneFor(d, true, NOW);
    const pes = Array.from({length:3}, (_,i) => chatPe(d, fp(`mixed-${i}`), NOW-60_000));
    const batch = batchOf(d, [pes[0]], NOW);
    const mappings = await Promise.all(pes.slice(1).map(pe => lane.mapAct(wire.actRecordOf(pe),pe.pe_id)));
    if (!mappings[0].ok || !mappings[1].ok) throw new Error('mixed fixture mapping refused');
    const intake = buildRelayActIntake({pe:pes[1],actorId:d.agentId,accrual:mappings[0].params,sealed:[],nowMs:NOW});
    const {buildOrdinaryAccrualIntake,ORDINARY_ACCRUAL_INTAKE_COLLECTION} = await import('../pvt/wp11/ordinary-accrual-intake');
    const ordinaryParams = {...mappings[1].params,throwOnError:false};
    await db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(pes[2].pe_id).set(buildOrdinaryAccrualIntake({prevHash:pes[2].prev_hash,peHash:wire.peHashOf(pes[2]),accrualParams:ordinaryParams}));
    let arrived=0;let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const {BatchPricingCounters} = await import('./batch-pricing-counters');
    const counts = BatchPricingCounters.prototype.counts;
    const pricing = jest.spyOn(BatchPricingCounters.prototype,'counts').mockImplementation(async function(this: import('./batch-pricing-counters').BatchPricingCounters,...args: Parameters<typeof counts>) {
      const result = await counts.apply(this,args);
      if (++arrived <= 3) { if(arrived === 3)release();await barrier; }
      return result;
    });
    const [device,relay] = await Promise.all([
      ingestMeterBatch(db,lane,batch,NOW), priceRelayAct(db,intake,{nowMs:NOW}),
      recordPEAccrual(ordinaryParams),
    ]);
    pricing.mockRestore();
    expect(device.status).toBe(201);expect(relay).not.toBeNull();
    const snapshots=[];
    for(const receipt of [device.body as import('./meter-store').MeterBatchReceipt,relay!]) {
      const pages=await readBatchActPages(db,receipt.batch_hash);
      const keyed=(await db.collection('meter_act_keys_v1').doc(receipt.acts[0].relay_pe_id).get()).data();
      const row=committedRows.get(receipt.acts[0].relay_pe_id)??pages.flatMap(p=>Object.values(p.doc.acts))[0]?.row??keyed?.row;
      expect(row).toBeDefined();snapshots.push(row.economic_snapshot);
    }
    const ordinary=(await db.collection('pe_history').doc(pes[2].pe_id).get()).data();
    expect(ordinary).toBeDefined();snapshots.push(ordinary!.economic_snapshot);
    expect(snapshots.map(s=>s.recordTimeFactors.occurrenceOrdinal).sort((a,b)=>a-b)).toEqual([25,26,27]);
  });

});
