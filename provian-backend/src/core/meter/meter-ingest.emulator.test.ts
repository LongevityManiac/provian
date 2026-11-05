/**
 * PE METER — end-to-end ingest against the Firestore EMULATOR (real transactions, getAll,
 * BulkWriter, Timestamp TTL fields). Skipped unless FIRESTORE_EMULATOR_HOST is set:
 *
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 npx firebase emulators:start --only firestore --project demo-meter
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx jest src/core/meter/meter-ingest.emulator.test.ts
 *
 * What it pins, on the real pricing path (`recordPEAccrual`, unmocked):
 *   - a body-bound witnessed act mints (eligible, nonzero points) and leaves NO pe_history row;
 *   - the batch commits act keys (TTL), a pending batch claim, the device tip and a batch record;
 *   - the same batch re-sent is answered 200 with the identical receipt and writes nothing new;
 *   - a stale batch (seq already accepted) is 409 batch_replay;
 *   - an act that does not continue the device's PE chain is 409 act_chain_broken;
 *   - the same occurrence (same session fingerprint) in a later batch earns 0 (mint-once);
 *   - an act older than 30 days goes into totals and does not mint;
 *   - an actor-declared act (not an observation type) is refused and earns nothing;
 *   - the commit keeps the user-facing running totals (`actor_meter_totals_v1`: tiers, a human's
 *     beneficiary acts by agent, chain-verified financial facts — a held receive only on release,
 *     an unsolicited one never; the network hour counter).
 * RED controls are the duplicate/too-old/refused/unbound cases: each asserts a zero that the
 * eligible case above shows is not the default.
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

type Mods = {
  db: FirebaseFirestore.Firestore;
  wire: typeof import('./meter-wire');
  ingest: typeof import('./meter-ingest');
  deviceAct: typeof import('./device-act');
  store: typeof import('./meter-store');
  cache: typeof import('../../cache')['cache'];
};
let m: Mods;

const RUN = `r${Date.now().toString(36)}`;
const AGENT_ID = `agent_${RUN}`;
const WALLET_ID = `wallet_aw_${RUN}`;
const DEVICE_ID = `dev_${RUN}`;
const AGENT_ADDRESS = `0x${createHash('sha256').update(RUN).digest('hex').slice(0, 40)}`;
const NOW = Date.now();

function fp(seed: string): string {
  return createHash('sha256').update(`${RUN}:${seed}`).digest('hex');
}

const device = () => ({
  device_id: DEVICE_ID,
  owner_type: 'agent',
  owner_user_id: AGENT_ID,
  owner_wallet_id: WALLET_ID,
  owner_address: AGENT_ADDRESS,
  signing_method: 'bearer',
  attestation_capability: 'software',
  platform: 'darwin',
  status: 'active',
}) as unknown as import('../../routes/middleware/device-auth').DeviceDocument;


const HUMAN_USER = `user_${RUN}`;
const HUMAN_WALLET = `wallet_h_${RUN}`;
const HUMAN_ADDRESS = `0x${createHash('sha256').update(`h${RUN}`).digest('hex').slice(0, 40)}`;

/** An agent wallet + its pinned beneficiary relationship, exactly as registration / link-human write them. */
async function seedAgent(
  db: FirebaseFirestore.Firestore,
  a: { walletId: string; agentId: string; address: string; linked?: boolean },
): Promise<void> {
  const linked = a.linked === true;
  const share = linked ? 2_000 : null;
  await db.collection('agent_wallets').doc(a.walletId).set({
    id: a.walletId, agent_id: a.agentId, address: a.address, status: 'active', created_at: NOW - 86_400_000,
    ...(linked ? { operational_reserve_bps: share } : { operational_reserve_ratio: null }),
    parent_wallet_id: null,
    linked_human_wallet_id: linked ? HUMAN_WALLET : null,
    linked_human_user_id: linked ? HUMAN_USER : null,
    linked_human_address: linked ? HUMAN_ADDRESS : null,
  });
  if (linked) {
    await db.collection('wallets').doc(HUMAN_WALLET).set({
      id: HUMAN_WALLET, type: 'human', user_id: HUMAN_USER, address: HUMAN_ADDRESS, status: 'active',
    });
  }
  const { canonicalAgentPeHash } = await import('../agent-wallet/canonical-agent-pe-chain');
  const shareKey = linked ? 'agent_share_bps' : 'operational_reserve_ratio';
  const rel = {
    state: linked ? 'linked' : 'unlinked',
    human_wallet_id: linked ? HUMAN_WALLET : null,
    human_user_id: linked ? HUMAN_USER : null,
    human_address: linked ? HUMAN_ADDRESS : null,
    [shareKey]: share,
    parent_wallet_id: null,
    revision: 1,
  };
  const sourcePeId = `pe_rel_${a.walletId}`;
  const sourceAction = linked ? 'agent_linked_to_human' : 'agent_wallet_created';
  const canonical = {
    id: sourcePeId, wallet_id: a.walletId, agent_id: a.agentId, user_id: a.agentId, actor_address: a.address,
    action_type: sourceAction, timestamp: 1, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { beneficiary_relationship: rel },
    compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null,
  };
  const hash = canonicalAgentPeHash(canonical);
  await db.collection('identity_pes_legacy_v1').doc(sourcePeId).set({
    ...canonical, hash, policy_action_type: linked ? 'agent_linked' : 'wallet_created',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false,
    trust_level_at_creation: null, created_at: 1, durability: 'final',
  });
  await db.collection('agent_beneficiary_relationships_v1').doc(a.walletId).set({
    schema_version: linked ? 'agent-beneficiary-relationship/v2' : 'agent-beneficiary-relationship/v1',
    wallet_id: a.walletId, agent_id: a.agentId, ...rel,
    source_action_type: sourceAction, source_pe_id: sourcePeId, source_pe_hash: hash,
    created_at_ms: 1, updated_at_ms: 1,
  });
}

let chainTip = 'genesis';
let peSeq = 0;
function chatPe(fingerprint: string, timestamp: number): import('./meter-wire').PeV2 {
  const pe = {
    schema: m.wire.PE_V2_SCHEMA,
    pe_id: `pe_${RUN}_${peSeq++}`,
    device_id: DEVICE_ID,
    prev_hash: chainTip,
    timestamp,
    action_type: 'ai_conversation',
    description: 'a conversation the daemon observed',
    metadata: { session_fingerprint_hash: fingerprint, surface: 'claude_code' },
  };
  chainTip = m.wire.peHashOf(pe);
  return pe;
}
function declaredPe(timestamp: number): import('./meter-wire').PeV2 {
  const pe = {
    schema: m.wire.PE_V2_SCHEMA,
    pe_id: `pe_${RUN}_${peSeq++}`,
    device_id: DEVICE_ID,
    prev_hash: chainTip,
    timestamp,
    action_type: 'agent_work_product_code',
    metadata: {},
  };
  chainTip = m.wire.peHashOf(pe);
  return pe;
}

async function lane(bodyBound = true, nowMs = NOW): Promise<import('./meter-ingest').MeterLane> {
  const dl = await m.deviceAct.openDeviceBatchLane({
    db: m.db, cache: m.cache, device: device(), signatureAuthenticated: false, bodyBound, receivedAtMs: nowMs,
  });
  return {
    deviceId: DEVICE_ID,
    actorId: dl.ownerId,
    resolveSealedRecipient: () => null,
    mapAct: (act, relayPeId) => m.deviceAct.deviceActToAccrualParams(dl, act, relayPeId),
    extraWrites: () => {
      const w = m.deviceAct.laneLineageWrite(dl);
      return w ? [w] : [];
    },
  };
}

let seq = 0;
let prevBatch = 'genesis';
function nextBatch(pes: import('./meter-wire').PeV2[], createdAt: number) {
  const batch = m.wire.buildBatch({ device_id: DEVICE_ID, seq: seq + 1, prev_batch_hash: prevBatch, created_at_ms: createdAt, pes });
  return batch;
}
function accept(batch: import('./meter-wire').PeBatch) {
  seq = batch.seq;
  prevBatch = m.wire.batchHashOf(batch);
}

suite('PE meter ingest (Firestore emulator)', () => {
  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-meter';
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    const db = admin.firestore();
    try { db.settings((await import('../../firestore-settings')).RELAY_FIRESTORE_SETTINGS); } catch { /* already set */ }
    m = {
      db,
      wire: await import('./meter-wire'),
      ingest: await import('./meter-ingest'),
      deviceAct: await import('./device-act'),
      store: await import('./meter-store'),
      cache: (await import('../../cache')).cache,
    };
    await seedAgent(db, { walletId: WALLET_ID, agentId: AGENT_ID, address: AGENT_ADDRESS });
    await db.collection('devices').doc(DEVICE_ID).set(device() as unknown as Record<string, unknown>);
  });

  let firstReceipt: import('./meter-store').MeterBatchReceipt;
  let firstBatch: import('./meter-wire').PeBatch;
  let firstBatchPes: import('./meter-wire').PeV2[];

  it('mints a body-bound witnessed act and keeps no pe_history row', async () => {
    firstBatchPes = [chatPe(fp('s1'), NOW - 60_000)];
    const batch = nextBatch(firstBatchPes, NOW);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(), batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[meter-emulator] first receipt', JSON.stringify(receipt.acts));
    expect(receipt.acts).toHaveLength(1);
    if (receipt.acts[0].disposition !== 'eligible') {
      const k = await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(receipt.acts[0].relay_pe_id).get();
      const row = k.data()?.row ?? {};
      console.log('[meter-emulator] DEBUG row', JSON.stringify({
        mint_status: row.mint_status, reason: row.disposition_reason_code, factors: row.economic_snapshot?.recordTimeFactors,
        policy: row.policy_disposition ?? null, keys: Object.keys(row),
      }, null, 1));
    }
    expect(receipt.acts[0].disposition).toBe('eligible');
    expect(BigInt(receipt.acts[0].record_points_atomic)).toBeGreaterThan(0n);
    expect(BigInt(receipt.totals.eligible_points_atomic)).toBeGreaterThan(0n);
    firstReceipt = receipt;
    firstBatch = batch;
    accept(batch);

    const relayPeId = receipt.acts[0].relay_pe_id;
    expect((await m.db.collection('pe_history').doc(relayPeId).get()).exists).toBe(false);
    const key = await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(relayPeId).get();
    expect(key.exists).toBe(true);
    expect(key.data()?.expire_at).toBeNull(); // Unpaid earnings keep their trust evidence.
    const tip = await m.db.collection(m.store.METER_DEVICE_TIPS_COLLECTION).doc(DEVICE_ID).get();
    expect(tip.data()?.seq).toBe(1);
    expect(tip.data()?.batch_hash).toBe(receipt.batch_hash);
    const claims = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION)
      .where('batch_hash', '==', receipt.batch_hash).get();
    expect(claims.size).toBeGreaterThan(0);
    const record = await m.db.collection(m.store.METER_BATCHES_COLLECTION).doc(receipt.batch_hash).get();
    expect(record.exists).toBe(true);
    // PE export: the batch record keeps every act leaf, in batch order, and they recompute acts_root.
    expect(batch.acts.length).toBeGreaterThan(0);
    expect(record.data()?.act_leaves).toEqual(batch.acts.map(m.wire.actLeafOf));
    expect(m.wire.merkleRootOf(record.data()?.act_leaves as string[])).toBe(batch.acts_root);
    // ...and the owner-facing read returns them through a real getAll (anchor null until anchored).
    const { readBatchProofs } = await import('./batch-proofs');
    const proofs = await readBatchProofs(m.db, [receipt.batch_hash, 'f'.repeat(64)]);
    if (!proofs.ok) throw new Error('batch-proofs refused a well-formed request');
    expect(proofs.value.missing).toEqual(['f'.repeat(64)]);
    expect(proofs.value.batches).toHaveLength(1);
    expect(proofs.value.batches[0]).toMatchObject({
      batch_hash: receipt.batch_hash, device_id: DEVICE_ID, seq: 1, acts_root: batch.acts_root,
      anchored: false, anchor: null, act_leaves: batch.acts.map(m.wire.actLeafOf),
    });
    expect(proofs.value.batches[0]).not.toHaveProperty('claim_keys');
  });

  it('answers the same batch re-sent with the identical receipt', async () => {
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(), firstBatch, NOW + 1_000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(firstReceipt);
  });

  it('refuses a stale batch (replay) with 409 batch_replay', async () => {
    const replay = m.wire.buildBatch({
      device_id: DEVICE_ID, seq: 1, prev_batch_hash: 'genesis', created_at_ms: NOW + 2_000,
      pes: [{ ...chatPe(fp('replay'), NOW - 50_000), prev_hash: 'genesis' }],
    });
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(), replay, NOW + 10 * 60_000);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('batch_replay');
    chainTip = firstReceipt.acts[0].pe_hash; // undo the scratch PE above
  });

  it('refuses an act that does not continue the device PE chain', async () => {
    const broken = m.wire.buildBatch({
      device_id: DEVICE_ID, seq: seq + 1, prev_batch_hash: prevBatch, created_at_ms: NOW + 3_000,
      pes: [{ ...chatPe(fp('broken'), NOW - 40_000), prev_hash: 'f'.repeat(64) }],
    });
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(), broken, NOW + 10 * 60_000);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('act_chain_broken');
    chainTip = firstReceipt.acts[0].pe_hash;
  });

  it('refuses a batch inside 5 minutes of the last one', async () => {
    const soon = nextBatch([chatPe(fp('soon'), NOW - 30_000)], NOW + 4_000);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(), soon, NOW + 60_000);
    expect(res.status).toBe(429);
    chainTip = firstReceipt.acts[0].pe_hash;
  });

  it('mints a repeated occurrence once, records a too-old act, refuses a declared act', async () => {
    const at = NOW + 10 * 60_000;
    const dup = chatPe(fp('s1'), NOW - 20_000); // the SAME session as the first batch
    const fresh = chatPe(fp('s2'), NOW - 10_000);
    const old = chatPe(fp('s3'), NOW - 31 * 86_400_000);
    const declared = declaredPe(NOW - 5_000);
    const batch = nextBatch([dup, fresh, old, declared], at);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(true, at), batch, at);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[meter-emulator] second receipt', JSON.stringify(receipt.acts));
    accept(batch);
    const [rDup, rFresh, rOld, rDeclared] = receipt.acts;
    expect(BigInt(rFresh.record_points_atomic)).toBeGreaterThan(0n);
    expect(rFresh.disposition).toBe('eligible');
    // Mint-once: the duplicate session earns nothing.
    expect(rDup.disposition === 'eligible' && BigInt(rDup.record_points_atomic) > 0n).toBe(false);
    // Older than 30 days: in totals, not minted.
    expect(rOld.disposition).not.toBe('eligible');
    expect(rOld.reason).toBe('meter_act_older_than_30_days');
    // an actor's own claim is never a PE that mints.
    expect(rDeclared.disposition).toBe('refused');
    expect(rDeclared.reason).toMatch(/^actor_declared/);
    expect(BigInt(receipt.totals.eligible_points_atomic)).toBe(BigInt(rFresh.record_points_atomic));
  });

  it('seals an unbound (bearer, no body HMAC) act as not minting', async () => {
    const at = NOW + 20 * 60_000;
    const batch = nextBatch([chatPe(fp('unbound'), NOW - 1_000)], at);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(false, at), batch, at);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    accept(batch);
    expect(receipt.acts[0].disposition).toBe('refused');
    expect(BigInt(receipt.totals.eligible_points_atomic)).toBe(0n);
  });
  it('splits a linked agent\'s act into two legs and files the sealed copy for the linked human', async () => {
    const walletId = `wallet_aw_L${RUN}`;
    const agentId = `agentL_${RUN}`;
    const address = `0x${createHash('sha256').update(`L${RUN}`).digest('hex').slice(0, 40)}`;
    const deviceId = `devL_${RUN}`;
    await seedAgent(m.db, { walletId, agentId, address, linked: true });
    const dev = { ...device(), device_id: deviceId, owner_user_id: agentId, owner_wallet_id: walletId, owner_address: address } as unknown as import('../../routes/middleware/device-auth').DeviceDocument;
    await m.db.collection('devices').doc(deviceId).set(dev as unknown as Record<string, unknown>);
    const pe = {
      schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_L_${RUN}`, device_id: deviceId, prev_hash: 'genesis',
      timestamp: NOW - 60_000, action_type: 'ai_conversation',
      metadata: { session_fingerprint_hash: fp('linked'), surface: 'claude_code' },
    };
    const batch = m.wire.buildBatch({
      device_id: deviceId, seq: 1, prev_batch_hash: 'genesis', created_at_ms: NOW, pes: [pe],
      sealed: [{ pe_id: pe.pe_id, to: 'linked_human', box: 'c2VhbGVkLWJveA' }],
    });
    const dl = await m.deviceAct.openDeviceBatchLane({
      db: m.db, cache: m.cache, device: dev, signatureAuthenticated: false, bodyBound: true, receivedAtMs: NOW,
    });
    const laneL: import('./meter-ingest').MeterLane = {
      deviceId, actorId: dl.ownerId,
      resolveSealedRecipient: (to) => (to === 'linked_human' ? `human:${HUMAN_USER}` : null),
      mapAct: (act, relayPeId) => m.deviceAct.deviceActToAccrualParams(dl, act, relayPeId),
      extraWrites: () => [],
    };
    const { readNetworkMeter24h, readActorMeterTotals } = await import('./actor-meter-totals');
    const networkBefore = await readNetworkMeter24h(m.db, NOW);
    const res = await m.ingest.ingestMeterBatch(m.db, laneL, batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[meter-emulator] linked receipt', JSON.stringify(receipt.acts));
    // The commit's running totals: the act's tier on the agent, the act on its human beneficiary
    // (per agent), and one more network act this hour.
    const keyDoc = (await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(receipt.acts[0].relay_pe_id).get()).data()!;
    const beneficiary = keyDoc.row?.beneficiary_wallet_id as string;
    expect(typeof beneficiary).toBe('string');
    expect(keyDoc.beneficiary_id).toBe(beneficiary);
    const agentTotals = await readActorMeterTotals(m.db, dl.ownerId);
    expect(Object.values(agentTotals.by_attestation_tier).reduce((a, b) => a + b, 0)).toBe(1);
    expect((await readActorMeterTotals(m.db, beneficiary)).beneficiary_acts_by_agent[dl.ownerId]).toBe(1);
    expect(await readNetworkMeter24h(m.db, NOW)).toBe(networkBefore + 1);
    expect(receipt.acts[0].disposition).toBe('eligible');
    const eligible = BigInt(receipt.totals.eligible_points_atomic);
    expect(eligible).toBeGreaterThan(0n);
    const claims = (await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION)
      .where('batch_hash', '==', receipt.batch_hash).get()).docs.map((d) => d.data() as import('./meter-store').MeterPendingClaim);
    console.log('[meter-emulator] linked claims', JSON.stringify(claims.map((c) => [c.leg, c.contributor, c.record_points_atomic])));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((c) => c.contributor))).toEqual(new Set([address, HUMAN_ADDRESS]));
    expect(claims.reduce((t, c) => t + BigInt(c.record_points_atomic), 0n)).toBe(eligible);
    const mail = await (await import('./pe-mailbox')).listMailbox(m.db, `human:${HUMAN_USER}`, { limit: 10 });
    expect(mail.items.map((i) => i.pe_id)).toEqual([pe.pe_id]);
    expect(mail.items[0].box).toBe('c2VhbGVkLWJveA');
  });
  it('prices a phone batch like the mobile route: chat mints, a Base send queues its tx hash', async () => {
    const userId = `userP_${RUN}`;
    const walletDoc = `wallet_p_${RUN}`;
    const address = `0x${createHash('sha256').update(`P${RUN}`).digest('hex').slice(0, 40)}`;
    const phoneDevice = `phone_${RUN}`;
    await m.db.collection('wallets').doc(walletDoc).set({ id: walletDoc, type: 'human', user_id: userId, address, status: 'active' });
    const txHash = `0x${createHash('sha256').update(`tx${RUN}`).digest('hex')}`;
    const chat = {
      schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_P1_${RUN}`, device_id: phoneDevice, prev_hash: 'genesis',
      timestamp: NOW - 60_000, action_type: 'ai_conversation',
      ai_conversation_metadata: {
        provider: 'claude', surface: 'mobile_wrapper', duration_ms: 60_000, active_duration_ms: 30_000,
        turn_count: 4, char_count: 900, image_count: 0, video_seconds: 0,
        session_fingerprint_hash: fp('phone-chat'), input_fidelity: 'full',
      },
    };
    const send = {
      schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_P2_${RUN}`, device_id: phoneDevice, prev_hash: m.wire.peHashOf(chat),
      timestamp: NOW - 30_000, action_type: 'send', tx_hash: txHash, chain_id: 8453,
      description: 'paid the plumber',
    };
    const batch = m.wire.buildBatch({ device_id: phoneDevice, seq: 1, prev_batch_hash: 'genesis', created_at_ms: NOW, pes: [chat, send] });
    const { mobileActToAccrualParams } = await import('./mobile-act');
    const mobileLane: import('./mobile-act').MobileBatchLane = {
      db: m.db, userId, deviceId: phoneDevice, attestationTier: 'software', deviceAttestationId: null,
      actorAddress: address, humanWalletDocId: walletDoc, receivedAtMs: NOW, appleAssertion: null,
      hooks: [], afterCommit: [],
    };
    const res = await m.ingest.ingestMeterBatch(m.db, {
      deviceId: phoneDevice, actorId: userId, resolveSealedRecipient: () => null,
      mapAct: (act, relayPeId) => mobileActToAccrualParams(mobileLane, act, relayPeId),
      extraWrites: () => [], txnHooks: () => mobileLane.hooks,
    }, batch, NOW);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    console.log('[meter-emulator] phone receipt', JSON.stringify(receipt.acts));
    expect(receipt.acts[0].disposition).toBe('eligible');
    expect(BigInt(receipt.acts[0].record_points_atomic)).toBeGreaterThan(0n);
    // The send itself records (it mints through the chain-record lane, once).
    expect(receipt.acts[1].disposition).not.toBe('eligible');
    const { CHAIN_RECORD_OBSERVATIONS_COLLECTION, chainRecordObservationId } = await import('../pvt/chain-record-watcher');
    const obs = await m.db.collection(CHAIN_RECORD_OBSERVATIONS_COLLECTION).doc(chainRecordObservationId(txHash, walletDoc)).get();
    expect(obs.exists).toBe(true);
    expect(JSON.stringify(obs.data())).toContain(receipt.acts[1].relay_pe_id);
  });
  it('anchors the day over every batch and proves an act in two hops against the anchored root', async () => {
    const { anchorMeterDay, meterAnchorBatchId } = await import('./meter-anchor');
    const { listMeterProofs } = await import('./meter-proofs');
    const { hashEnvelopeHashLeaf, verifyMerkleProof } = await import('../pvt/merkle');
    const roots = new Map<string, string>();
    const contract = {
      getBatch: async (id: string) => ({ exists: roots.has(id), merkleRoot: roots.get(id) ?? '0x' }),
      anchorBatch: async (id: string, root: string) => {
        if (roots.has(id)) throw new Error('BatchAlreadyAnchored');
        roots.set(id, root);
        return { hash: '0xfeed', wait: async () => ({ hash: '0xfeed' }) };
      },
    } as unknown as import('ethers').Contract;
    const day = new Date(NOW).toISOString().slice(0, 10);
    const later = Date.parse(`${day}T00:00:00Z`) + 86_400_000 + 3_600_000;
    const result = await anchorMeterDay({ db: m.db, peAnchorContract: contract, now: () => later }, day);
    expect(result.status).toBe('anchored');
    expect(roots.get(meterAnchorBatchId(day))).toBe(result.merkle_root);
    // Idempotent: a second run finds the root on chain and sends nothing.
    const again = await anchorMeterDay({ db: m.db, peAnchorContract: contract, now: () => later }, day);
    expect(again.status).toBe('already_anchored');

    // The first batch of this suite's device: fetch its proof the way the daemon will.
    const { proofs } = await listMeterProofs(m.db, DEVICE_ID, 0);
    const first = proofs.find((p) => p.seq === 1)!;
    expect(first.batch_hash).toBe(firstReceipt.batch_hash);
    // Hop 2: batch leaf → the anchored day root.
    expect(first.anchor.leaf_hash).toBe(hashEnvelopeHashLeaf(first.batch_leaf));
    expect(verifyMerkleProof(first.anchor.leaf_hash, [...first.anchor.proof], roots.get(meterAnchorBatchId(day))!)).toBe(true);
    // Hop 1: the PE the device kept → the batch's acts_root → the same batch leaf.
    const pe = firstBatchPes[0];
    const acts = firstBatch.acts;
    const actIndex = acts.findIndex((a) => a.pe_id === pe.pe_id);
    const act = m.wire.verifyActInclusion(pe, {
      act_index: actIndex,
      act_proof: m.wire.merkleProofOf(acts.map((a) => m.wire.actLeafOf(a)), actIndex),
      acts_root: first.acts_root,
      batch: { device_id: DEVICE_ID, actor_id: first.actor_id, seq: 1, batch_hash: first.batch_hash },
    });
    expect(act).toEqual({ ok: true, batch_leaf: first.batch_leaf });
    // RED: an edited PE does not prove.
    const edited = m.wire.verifyActInclusion({ ...pe, description: 'not what happened' }, {
      act_index: actIndex,
      act_proof: m.wire.merkleProofOf(acts.map((a) => m.wire.actLeafOf(a)), actIndex),
      acts_root: first.acts_root,
      batch: { device_id: DEVICE_ID, actor_id: first.actor_id, seq: 1, batch_hash: first.batch_hash },
    });
    expect(edited.ok).toBe(false);
  });
  it(' carried: a rejected session-lineage claim prices the act without it and tells the device', async () => {
    const at = NOW + 30 * 60_000;
    const pe = { ...chatPe(fp('lineage'), NOW - 2_000) };
    // Rebuild with a malformed lineage claim (and re-chain).
    chainTip = pe.prev_hash;
    const withClaim = { ...pe, economic_session_lineage: { id: 'not-a-lineage' } };
    chainTip = m.wire.peHashOf(withClaim);
    const batch = nextBatch([withClaim], at);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(true, at), batch, at);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    accept(batch);
    expect(receipt.acts[0].disposition).toBe('eligible');
    expect(receipt.acts[0].note).toMatch(/^lineage_rejected:/);
  });

  // ── Relay-authored PEs (item 6) ────────────────────────────────────────────────────────────
  const x25519Pair = () => {
    const { privateKey, publicKey } = require('crypto').generateKeyPairSync('x25519') as import('crypto').KeyPairKeyObjectResult;
    return {
      secret: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32),
      pub: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32),
    };
  };
  async function relayDeps() {
    const { recordPEAccrual } = await import('../../pvt-accrual');
    return { db: m.db, peBuffer: { enqueue: () => { throw new Error('a readable PE was enqueued'); } }, recordPEAccrual } as unknown as import('../agent-bank/pe-utils').PeGenerationDeps;
  }
  async function untilPriced(peId: string): Promise<FirebaseFirestore.DocumentData> {
    for (let i = 0; i < 100; i += 1) {
      const snap = await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(peId).get();
      const intake = await m.db.collection('meter_relay_acts_v1').doc(peId).get();
      if (snap.exists && !intake.exists) return snap.data()!;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`relay act ${peId} was not priced`);
  }
  const forgeCommit = (walletId: string, agentId: string, address: string, sha: string) => ({
    walletId, agentId, actorAddress: address,
    actionType: 'service:github_commit',
    durableViaOrdinaryIntake: true,
    witnessClass: 'forge_witnessed' as const,
    metadata: {
      commit_sha: sha, repo: 'provian/meter-test', branch: 'main', commits_in_push: 1,
      files_added: 0, files_removed: 0, files_modified: 1, files_changed: 1,
      synthesized_description: `push ${sha.slice(0, 7)} to provian/meter-test/main: 1 commit(s) across 1 files`,
      verified: true, delivery_id: `d_${sha.slice(0, 8)}`, installation_id: '1', witness: 'github_webhook',
    },
  });

  it('a relay-authored act mints, keeps no envelope, and reaches the agent and its linked human sealed', async () => {
    const walletId = `wallet_aw_R${RUN}`;
    const agentId = `agentR_${RUN}`;
    const address = `0x${createHash('sha256').update(`R${RUN}`).digest('hex').slice(0, 40)}`;
    await seedAgent(m.db, { walletId, agentId, address, linked: true });
    const agentKey = x25519Pair();
    const humanKey = x25519Pair();
    const { toB64u, fromB64u, openWithKey } = await import('./sealed-box');
    await m.db.collection('commons_message_keys').doc(walletId).set({ pubkey_b64u: toB64u(agentKey.pub) });
    await m.db.collection('commons_message_keys').doc(HUMAN_WALLET).set({ pubkey_b64u: toB64u(humanKey.pub) });

    const { generatePE } = await import('../agent-bank/pe-utils');
    const sha = createHash('sha1').update(`commitR${RUN}`).digest('hex');
    const res = await generatePE(await relayDeps(), forgeCommit(walletId, agentId, address, sha));
    const key = await untilPriced(res.peId);
    console.log('[meter-emulator] relay act', JSON.stringify({ status: key.row.mint_status, points: key.row.record_points_atomic, unit: key.unit, legs: key.legs?.length }));

    expect(key.pe_hash).toBe(res.peHash);
    expect(key.device_id).toBe(`relay:${agentId}`);
    expect(key.row.mint_status).toBe('eligible');
    expect(BigInt(key.row.record_points_atomic)).toBeGreaterThan(0n);
    // A commit is takeover-capable: its legs sit in its batch's WINDOW claims , each
    // carrying the act with the instant its 72 h takeover window closes.
    expect(key.unit).toBe('window');
    const { meterWindowClaimKey } = await import('./meter-claims');
    const { CROSS_WITNESS_TAKEOVER_WINDOW_MS } = await import('../pvt/policy/monetary-accounting');
    const claims = await Promise.all((key.legs as { leg: 'sole' | 'agent' | 'beneficiary'; contributor: string; beneficiary_class: number }[]).map((l) =>
      m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(meterWindowClaimKey({
        batch_hash: key.batch_hash, leg: l.leg, contributor: l.contributor, beneficiary_class: l.beneficiary_class, part: 0,
      })).get()));
    expect(claims.every((c) => c.exists && c.data()?.unit === 'window'
      && c.data()?.acts?.length === 1 && c.data()?.acts?.[0]?.relay_pe_id === res.peId
      && c.data()?.acts?.[0]?.ready_at_ms === key.timestamp + CROSS_WITNESS_TAKEOVER_WINDOW_MS)).toBe(true);
    expect(claims.reduce((t, c) => t + BigInt(c.data()!.record_points_atomic), 0n)).toBe(BigInt(key.row.record_points_atomic));
    // No readable PE anywhere on the relay.
    expect((await m.db.collection('provenance_envelopes').doc(res.peId).get()).exists).toBe(false);
    expect((await m.db.collection('pe_history').doc(res.peId).get()).exists).toBe(false);

    // Both parties' mailboxes hold the PE sealed to them; each opens to the exact PE.
    const { listMailbox } = await import('./pe-mailbox');
    for (const [recipient, secret] of [[`agent:${agentId}`, agentKey.secret], [`human:${HUMAN_USER}`, humanKey.secret]] as const) {
      const mail = await listMailbox(m.db, recipient, { limit: 10 });
      const item = mail.items.find((i) => i.pe_id === res.peId)!;
      expect(item).toBeDefined();
      const pe = JSON.parse(openWithKey(secret, fromB64u(item.box)).toString('utf8'));
      expect(m.wire.peHashOf(pe)).toBe(res.peHash);
      expect(pe.metadata.commit_sha).toBe(sha);
      // RED: the other party's key does not open it.
      const other = secret === agentKey.secret ? humanKey.secret : agentKey.secret;
      expect(() => openWithKey(other, fromB64u(item.box))).toThrow();
    }

    // The act is anchored like any batch: its one-act relay batch record exists.
    const batchRecord = await m.db.collection(m.store.METER_BATCHES_COLLECTION).doc(key.batch_hash).get();
    expect(batchRecord.data()?.device_id).toBe(`relay:${agentId}`);

    // Re-pricing the same act (a replay sweep racing the emitter) changes nothing.
    const { priceRelayAct } = await import('./meter-relay-authored');
    const before = (await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', key.batch_hash).get()).size;
    await expect(priceRelayAct(m.db, {
      schema: 'provian.meter-relay-act.v1', pe_id: res.peId, actor_id: agentId,
      act: { pe_id: res.peId, pe_hash: res.peHash, prev_hash: res.prevHash, timestamp: key.timestamp, action_type: key.action_type, pricing: {} },
      accrual: { peId: res.peId, userId: agentId, actionType: key.action_type, integrationSource: 'agent_bank_generate_pe', attestationDepth: 'software', peHash: res.peHash, timestamp: key.timestamp },
      durable: false, sealed: [], created_at_ms: NOW, expire_at: m.store.expireAt(NOW),
    })).resolves.toBeDefined();
    expect((await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', key.batch_hash).get()).size).toBe(before);
  });

  it('a commit seen by both the daemon and the forge webhook mints once', async () => {
    const sha = createHash('sha1').update(`commitX${RUN}`).digest('hex');
    const at = NOW + 40 * 60_000;
    // The daemon's git lane sees the commit first.
    const devicePe = {
      schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_${RUN}_${peSeq++}`, device_id: DEVICE_ID, prev_hash: chainTip,
      timestamp: NOW - 3_000, action_type: 'coding_session',
      metadata: { commit_sha: sha, repo: 'provian/meter-test', files_changed: 1, session_fingerprint_hash: fp('commitX') },
    };
    chainTip = m.wire.peHashOf(devicePe);
    const batch = nextBatch([devicePe], at);
    const res = await m.ingest.ingestMeterBatch(m.db, await lane(true, at), batch, at);
    expect(res.status).toBe(201);
    accept(batch);
    const deviceReceipt = (res.body as import('./meter-store').MeterBatchReceipt).acts[0];
    console.log('[meter-emulator] device commit', JSON.stringify(deviceReceipt));

    // Then the forge webhook witnesses the same commit for the same agent.
    const { generatePE } = await import('../agent-bank/pe-utils');
    const forge = await generatePE(await relayDeps(), forgeCommit(WALLET_ID, AGENT_ID, AGENT_ADDRESS, sha));
    const forgeKey = await untilPriced(forge.peId);
    console.log('[meter-emulator] forge commit', JSON.stringify({ status: forgeKey.row.mint_status, points: forgeKey.row.record_points_atomic }));

    // Exactly one act holds live (pending/registered) claims for this commit.
    const liveFor = async (relayPeId: string, batchHash: string): Promise<bigint> => {
      const snaps = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', batchHash).get();
      return snaps.docs
        .map((d) => d.data())
        .filter((c) => c.state !== 'void' && (c.acts as { relay_pe_id: string }[]).some((a) => a.relay_pe_id === relayPeId))
        .reduce((t, c) => t + BigInt(c.record_points_atomic), 0n);
    };
    const deviceLive = await liveFor(deviceReceipt.relay_pe_id, (res.body as import('./meter-store').MeterBatchReceipt).batch_hash);
    const forgeLive = await liveFor(forge.peId, forgeKey.batch_hash);
    console.log('[meter-emulator] commit live points', deviceLive.toString(), forgeLive.toString());
    expect([deviceLive > 0n, forgeLive > 0n].filter(Boolean)).toHaveLength(1);
  });

  it(' on the meter: a commit a run has taken is corroborated, never taken over; one still waiting is taken over (its share leaves the window claim)', async () => {
    // Its own agent and device, so the settlement run below takes only this agent's earnings.
    const walletId = `wallet_aw_T${RUN}`;
    const agentId = `agentT_${RUN}`;
    const address = `0x${createHash('sha256').update(`T${RUN}`).digest('hex').slice(0, 40)}`;
    await seedAgent(m.db, { walletId, agentId, address });
    const deviceId = `devT_${RUN}`;
    const dev = { ...device(), device_id: deviceId, owner_user_id: agentId, owner_wallet_id: walletId, owner_address: address } as unknown as import('../../routes/middleware/device-auth').DeviceDocument;
    await m.db.collection('devices').doc(deviceId).set(dev as unknown as Record<string, unknown>);
    const at = NOW + 2 * 60_000;
    const dl = await m.deviceAct.openDeviceBatchLane({ db: m.db, cache: m.cache, device: dev, signatureAuthenticated: false, bodyBound: true, receivedAtMs: at });
    const tLane: import('./meter-ingest').MeterLane = {
      deviceId,
      actorId: dl.ownerId,
      resolveSealedRecipient: () => null,
      mapAct: (act, relayPeId) => m.deviceAct.deviceActToAccrualParams(dl, act, relayPeId),
      extraWrites: () => { const w = m.deviceAct.laneLineageWrite(dl); return w ? [w] : []; },
    };
    const shaTaken = createHash('sha1').update(`commitTaken${RUN}`).digest('hex');
    const shaWaiting = createHash('sha1').update(`commitWaiting${RUN}`).digest('hex');
    const commit = (sha: string, ts: number, prev: string) => ({
      schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_T_${sha.slice(0, 8)}`, device_id: deviceId, prev_hash: prev, timestamp: ts,
      action_type: 'coding_session', metadata: { commit_sha: sha, repo: 'provian/meter-test', files_changed: 1, session_fingerprint_hash: fp(`T${sha}`) },
    }) as import('./meter-wire').PeV2;
    // One commit four days old (its takeover window closed), one an hour old (still inside it).
    const taken = commit(shaTaken, NOW - 4 * 86_400_000, 'genesis');
    const waiting = commit(shaWaiting, NOW - 3_600_000, m.wire.peHashOf(taken));
    const batch = m.wire.buildBatch({ device_id: deviceId, seq: 1, prev_batch_hash: 'genesis', created_at_ms: at, pes: [taken, waiting] });
    const res = await m.ingest.ingestMeterBatch(m.db, tLane, batch, at);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    const [takenId, waitingId] = receipt.acts.map((a) => a.relay_pe_id);
    expect(receipt.acts.map((a) => a.disposition)).toEqual(['eligible', 'eligible']);

    // The settlement run takes the commit whose window has closed (and only it) into a payout.
    const { runMeterClaimInlet } = await import('./meter-settlement');
    const inlet = await runMeterClaimInlet(m.db, { nowMs: at + 60_000, contributor: address });
    expect(inlet.payouts).toBe(1);

    const live = async (relayPeId: string, batchHash: string): Promise<bigint> => {
      const snaps = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', batchHash).get();
      return snaps.docs.map((d) => d.data())
        .filter((c) => c.state !== 'void' && (c.acts as { relay_pe_id: string }[]).some((a) => a.relay_pe_id === relayPeId))
        .reduce((t, c) => t + BigInt((c.acts as { relay_pe_id: string; points_atomic: string }[]).find((a) => a.relay_pe_id === relayPeId)!.points_atomic), 0n);
    };
    const rowOf = async (id: string) => (await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(id).get()).data()!.row as Record<string, unknown>;
    const { generatePE } = await import('../agent-bank/pe-utils');

    // RED : the forge webhook for the TAKEN commit arrives — a higher base, but the incumbent
    // is committed to settle, so it is corroborated (and topped up), never demoted.
    const forgeTaken = await generatePE(await relayDeps(), forgeCommit(walletId, agentId, address, shaTaken));
    const forgeTakenKey = await untilPriced(forgeTaken.peId);
    const takenRow = await rowOf(takenId);
    expect(takenRow.mint_status).toBe('eligible');
    expect(takenRow.commit_takeover_demoted_by_pe_id).toBeUndefined();
    expect(await live(takenId, receipt.batch_hash)).toBeGreaterThan(0n);
    expect(await live(forgeTaken.peId, forgeTakenKey.batch_hash)).toBe(0n);
    expect(takenRow.corroboration_status).toBe('service_grant_attested');
    const topup = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(`mt_${takenId}_sole`).get();
    expect(topup.exists && BigInt(topup.data()!.record_points_atomic) > 0n).toBe(true);

    // The forge webhook for the WAITING commit: the incumbent has not registered — the forge act
    // takes it over, and the daemon act's points leave its batch's window claim with the takeover.
    const waitingLiveBefore = await live(waitingId, receipt.batch_hash);
    expect(waitingLiveBefore).toBeGreaterThan(0n);
    const forgeWaiting = await generatePE(await relayDeps(), forgeCommit(walletId, agentId, address, shaWaiting));
    const forgeWaitingKey = await untilPriced(forgeWaiting.peId);
    expect((await rowOf(waitingId)).mint_status).toBe('corroborated_duplicate');
    expect(await live(waitingId, receipt.batch_hash)).toBe(0n);
    expect(await live(forgeWaiting.peId, forgeWaitingKey.batch_hash)).toBeGreaterThan(0n);
    const { pendingClaimIntact } = await import('./meter-claims');
    const parents = (await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', receipt.batch_hash).get()).docs
      .map((d) => d.data() as import('./meter-store').MeterPendingClaim);
    expect(parents.length).toBeGreaterThan(0);
    expect(parents.every((c) => pendingClaimIntact(c))).toBe(true);
  });

  /** A fresh agent and device whose daemon git lane witnessed one batch of commits (one per time). */
  async function commitAgent(tag: string, commitTimes: readonly number[]) {
    const walletId = `wallet_aw_${tag}${RUN}`;
    const agentId = `agent${tag}_${RUN}`;
    const address = `0x${createHash('sha256').update(`${tag}${RUN}`).digest('hex').slice(0, 40)}`;
    await seedAgent(m.db, { walletId, agentId, address });
    const deviceId = `dev${tag}_${RUN}`;
    const dev = { ...device(), device_id: deviceId, owner_user_id: agentId, owner_wallet_id: walletId, owner_address: address } as unknown as import('../../routes/middleware/device-auth').DeviceDocument;
    await m.db.collection('devices').doc(deviceId).set(dev as unknown as Record<string, unknown>);
    const at = NOW + 2 * 60_000;
    const dl = await m.deviceAct.openDeviceBatchLane({ db: m.db, cache: m.cache, device: dev, signatureAuthenticated: false, bodyBound: true, receivedAtMs: at });
    const agentLane: import('./meter-ingest').MeterLane = {
      deviceId,
      actorId: dl.ownerId,
      resolveSealedRecipient: () => null,
      mapAct: (act, relayPeId) => m.deviceAct.deviceActToAccrualParams(dl, act, relayPeId),
      extraWrites: () => { const w = m.deviceAct.laneLineageWrite(dl); return w ? [w] : []; },
    };
    const shas = commitTimes.map((_, i) => createHash('sha1').update(`commit${tag}${i}${RUN}`).digest('hex'));
    let prev = 'genesis';
    const pes = shas.map((sha, i) => {
      const pe = {
        schema: m.wire.PE_V2_SCHEMA, pe_id: `pe_${tag}_${sha.slice(0, 8)}`, device_id: deviceId, prev_hash: prev, timestamp: commitTimes[i],
        action_type: 'coding_session', metadata: { commit_sha: sha, repo: 'provian/meter-test', files_changed: 1, session_fingerprint_hash: fp(`${tag}${sha}`) },
      } as import('./meter-wire').PeV2;
      prev = m.wire.peHashOf(pe);
      return pe;
    });
    const batch = m.wire.buildBatch({ device_id: deviceId, seq: 1, prev_batch_hash: 'genesis', created_at_ms: at, pes });
    const res = await m.ingest.ingestMeterBatch(m.db, agentLane, batch, at);
    expect(res.status).toBe(201);
    const receipt = res.body as import('./meter-store').MeterBatchReceipt;
    expect(receipt.acts.map((a) => a.disposition)).toEqual(commitTimes.map(() => 'eligible'));
    return { walletId, agentId, address, shas, at, batchHash: receipt.batch_hash, ids: receipt.acts.map((a) => a.relay_pe_id) };
  }
  /** The act's points across the live (non-void) claims of its batch. */
  async function liveOf(relayPeId: string, batchHash: string): Promise<bigint> {
    const snaps = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', batchHash).get();
    return snaps.docs.map((d) => d.data())
      .filter((c) => c.state !== 'void' && (c.acts as { relay_pe_id: string }[]).some((a) => a.relay_pe_id === relayPeId))
      .reduce((t, c) => t + BigInt((c.acts as { relay_pe_id: string; points_atomic: string }[]).find((a) => a.relay_pe_id === relayPeId)!.points_atomic), 0n);
  }
  async function actRowOf(id: string): Promise<Record<string, unknown>> {
    return (await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(id).get()).data()!.row as Record<string, unknown>;
  }
  async function topupsOf(id: string): Promise<FirebaseFirestore.DocumentData[]> {
    return (await Promise.all(['sole', 'agent', 'beneficiary'].map((leg) =>
      m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(`mt_${id}_${leg}`).get())))
      .filter((d) => d.exists).map((d) => d.data()!);
  }
  async function claimsOfBatch(batchHash: string): Promise<Map<string, string>> {
    const snaps = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('batch_hash', '==', batchHash).get();
    return new Map(snaps.docs.map((d) => [d.id, JSON.stringify(d.data())]));
  }

  for (const variant of ['whole', 'slice'] as const) {
    it(`a seal race: a run takes the incumbent (${variant}) between the takeover pre-check and its transaction — the takeover is refused, nothing it carried moves, the incumbent is corroborated`, async () => {
      const { CROSS_WITNESS_TAKEOVER_WINDOW_MS: W } = await import('../pvt/policy/monetary-accounting');
      const { runMeterClaimInlet } = await import('./meter-settlement');
      const { pendingClaimIntact } = await import('./meter-claims');
      const actClaims = await import('./act-claims');
      const targetAt = NOW - 3 * 3_600_000;
      // `whole`: the incumbent is its batch's only act, so the run takes its window claim whole.
      // `slice`: a second act still waits, so the run cuts the incumbent into a slice.
      const agent = await commitAgent(variant === 'whole' ? 'Rw' : 'Rs', variant === 'whole' ? [targetAt] : [targetAt, NOW - 3_600_000]);
      const target = agent.ids[0];
      const cutAt = targetAt + W + 60_000;
      const real = actClaims.meterActUnregistered;
      let raced = 0;
      let takenClaims = new Map<string, string>();
      const spy = jest.spyOn(actClaims, 'meterActUnregistered').mockImplementation(async (db, id) => {
        const verdict = await real(db, id);
        if (id === target && raced === 0) {
          raced += 1;
          // The pre-check read the incumbent's window claim as pending…
          expect(verdict).toBe(true);
          // …and a settlement run takes it into a payout before the takeover transaction runs.
          const run = await runMeterClaimInlet(m.db, { nowMs: cutAt, contributor: agent.address });
          expect(run.payouts).toBe(1);
          takenClaims = await claimsOfBatch(agent.batchHash);
        }
        return verdict;
      });
      let forge: { peId: string };
      let forgeKey: FirebaseFirestore.DocumentData;
      try {
        const { generatePE } = await import('../agent-bank/pe-utils');
        forge = await generatePE(await relayDeps(), forgeCommit(agent.walletId, agent.agentId, agent.address, agent.shas[0]));
        forgeKey = await untilPriced(forge.peId);
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(1);
      const carrying = [...takenClaims.values()].map((c) => JSON.parse(c) as import('./meter-store').MeterPendingClaim)
        .filter((c) => c.acts.some((a) => a.relay_pe_id === target));
      expect(carrying.length).toBeGreaterThan(0);
      expect(carrying.every((c) => c.state === 'aggregated' && c.unit === 'window')).toBe(true);
      if (variant === 'slice') expect(carrying.every((c) => (c.window_part ?? 0) === cutAt)).toBe(true);
      // No demotion; the taker is not minted as the winner.
      const row = await actRowOf(target);
      expect(row.mint_status).toBe('eligible');
      expect(row.commit_takeover_demoted_by_pe_id).toBeUndefined();
      expect(await liveOf(forge!.peId, forgeKey!.batch_hash)).toBe(0n);
      // No claim the run took (or any other claim of the batch) was trimmed or voided.
      const after = await claimsOfBatch(agent.batchHash);
      for (const [key, before] of takenClaims) expect(after.get(key)).toBe(before);
      expect(carrying.every((c) => pendingClaimIntact(c))).toBe(true);
      // The retry saw a registered incumbent and corroborated it, as for any taken incumbent.
      expect(row.corroboration_status).toBe('service_grant_attested');
    });
  }

  it('a seal race on a top-up: a run takes the incumbent\'s corroboration top-up between the takeover pre-check and its transaction — the takeover is refused, the top-up and its payout stay exactly as the run left them, the incumbent is corroborated', async () => {
    const { recordMeterIncumbentCorroboration } = await import('./meter-corroboration');
    const { runMeterClaimInlet } = await import('./meter-settlement');
    const { pendingClaimIntact } = await import('./meter-claims');
    const actClaims = await import('./act-claims');
    const agent = await commitAgent('Rt', [NOW - 3_600_000]);
    const target = agent.ids[0];
    // A lower-base witness corroborates the incumbent: its lift is a pending top-up.
    const lift = await recordMeterIncumbentCorroboration(m.db, { incumbentPeId: target, corroboratingPeId: `pe_corr_Rt${RUN}`, nowMs: NOW, status: 'service_grant_attested' });
    expect(lift.topups).toBeGreaterThan(0);
    const real = actClaims.meterActUnregistered;
    const verdicts: boolean[] = [];
    let taken = new Map<string, string>();
    const spy = jest.spyOn(actClaims, 'meterActUnregistered').mockImplementation(async (db, id) => {
      const verdict = await real(db, id);
      if (id === target) {
        verdicts.push(verdict === true);
        if (verdicts.length === 1) {
          // The pre-check read the top-up (and the window claim) as pending…
          expect(verdict).toBe(true);
          expect((await topupsOf(target)).every((t) => t.state === 'pending')).toBe(true);
          // …and a settlement run takes the top-up (ready at once) into a payout before the
          // takeover transaction runs. The incumbent's window claim still waits, pending.
          const run = await runMeterClaimInlet(m.db, { nowMs: agent.at + 60_000, contributor: agent.address });
          expect(run.payouts).toBe(1);
          const topups = await topupsOf(target);
          expect(topups.every((t) => t.state === 'aggregated')).toBe(true);
          const payoutKeys = [...new Set(topups.map((t) => String(t.payout_key)))];
          const docs = await Promise.all([
            ...topups.map((t) => m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(String(t.claim_key)).get()),
            ...payoutKeys.map((k) => m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(k).get()),
          ]);
          expect(docs.every((d) => d.exists)).toBe(true);
          taken = new Map(docs.map((d) => [d.id, JSON.stringify(d.data())]));
          for (const [key, c] of await claimsOfBatch(agent.batchHash)) if (!taken.has(key)) taken.set(key, c);
        }
      }
      return verdict;
    });
    let forge: { peId: string };
    let forgeKey: FirebaseFirestore.DocumentData;
    try {
      const { generatePE } = await import('../agent-bank/pe-utils');
      forge = await generatePE(await relayDeps(), forgeCommit(agent.walletId, agent.agentId, agent.address, agent.shas[0]));
      forgeKey = await untilPriced(forge.peId);
    } finally {
      spy.mockRestore();
    }
    // The race happened once; the retry's pre-check saw the incumbent registered and corroborated it.
    expect(verdicts).toEqual([true, false]);
    // No demotion; the taker is not minted as the winner.
    const row = await actRowOf(target);
    expect(row.mint_status).toBe('eligible');
    expect(row.commit_takeover_demoted_by_pe_id).toBeUndefined();
    expect(await liveOf(target, agent.batchHash)).toBeGreaterThan(0n);
    expect(await liveOf(forge!.peId, forgeKey!.batch_hash)).toBe(0n);
    // The aggregated top-up, its payout and every claim of the batch are byte-identical to what
    // the run left (never voided, never trimmed).
    expect(taken.size).toBeGreaterThan(lift.topups);
    for (const [key, before] of taken) {
      const after = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(key).get();
      expect(JSON.stringify(after.data())).toBe(before);
    }
    expect([...taken.values()].every((c) => pendingClaimIntact(JSON.parse(c)))).toBe(true);
  });

  it('a takeover voids the incumbent\'s pending corroboration top-up with the demotion (the occurrence mints the taker\'s base once, never plus the incumbent\'s lift)', async () => {
    const { recordMeterIncumbentCorroboration } = await import('./meter-corroboration');
    const agent = await commitAgent('P', [NOW - 3_600_000]);
    const incumbent = agent.ids[0];
    // A lower-base witness corroborates the incumbent first: its lift is a pending top-up.
    const lift = await recordMeterIncumbentCorroboration(m.db, { incumbentPeId: incumbent, corroboratingPeId: `pe_corr_P${RUN}`, nowMs: NOW, status: 'service_grant_attested' });
    expect(lift.topups).toBeGreaterThan(0);
    expect((await topupsOf(incumbent)).every((t) => t.state === 'pending' && BigInt(t.record_points_atomic) > 0n)).toBe(true);
    // The higher-base forge witness takes the occurrence over.
    const { generatePE } = await import('../agent-bank/pe-utils');
    const forge = await generatePE(await relayDeps(), forgeCommit(agent.walletId, agent.agentId, agent.address, agent.shas[0]));
    const forgeKey = await untilPriced(forge.peId);
    expect((await actRowOf(incumbent)).mint_status).toBe('corroborated_duplicate');
    expect(await liveOf(incumbent, agent.batchHash)).toBe(0n);
    expect(await liveOf(forge.peId, forgeKey.batch_hash)).toBeGreaterThan(0n);
    // RED (before the fix the top-up stayed pending and was paid beside the taker's base).
    const topups = await topupsOf(incumbent);
    expect(topups.length).toBe(lift.topups);
    expect(topups.map((t) => [t.state, t.voided_by])).toEqual(topups.map(() => ['void', `demotion:${incumbent}`]));
  });

  it('RED: an incumbent whose top-up a run has taken is registered — the higher-base witness corroborates it, never takes it over', async () => {
    const { recordMeterIncumbentCorroboration } = await import('./meter-corroboration');
    const { runMeterClaimInlet } = await import('./meter-settlement');
    const agent = await commitAgent('A', [NOW - 3_600_000]);
    const incumbent = agent.ids[0];
    const lift = await recordMeterIncumbentCorroboration(m.db, { incumbentPeId: incumbent, corroboratingPeId: `pe_corr_A${RUN}`, nowMs: NOW, status: 'service_grant_attested' });
    expect(lift.topups).toBeGreaterThan(0);
    // A run takes the top-up (ready at once); the incumbent's window claim still waits, pending.
    const run = await runMeterClaimInlet(m.db, { nowMs: agent.at + 60_000, contributor: agent.address });
    expect(run.payouts).toBe(1);
    const taken = await topupsOf(incumbent);
    expect(taken.every((t) => t.state === 'aggregated')).toBe(true);
    const before = await claimsOfBatch(agent.batchHash);
    expect([...before.values()].map((c) => JSON.parse(c) as { unit: string; state: string })
      .filter((c) => c.unit === 'window').every((c) => c.state === 'pending')).toBe(true);
    const { generatePE } = await import('../agent-bank/pe-utils');
    const forge = await generatePE(await relayDeps(), forgeCommit(agent.walletId, agent.agentId, agent.address, agent.shas[0]));
    const forgeKey = await untilPriced(forge.peId);
    const row = await actRowOf(incumbent);
    expect(row.mint_status).toBe('eligible');
    expect(row.commit_takeover_demoted_by_pe_id).toBeUndefined();
    expect(await liveOf(incumbent, agent.batchHash)).toBeGreaterThan(0n);
    expect(await liveOf(forge.peId, forgeKey.batch_hash)).toBe(0n);
    const after = await claimsOfBatch(agent.batchHash);
    for (const [key, c] of before) expect(after.get(key)).toBe(c);
  });

  it('a corroboration landing on a taken-over incumbent is recorded and lifts nothing; RED: the same corroboration on its live sibling commit lifts', async () => {
    const { recordMeterIncumbentCorroboration } = await import('./meter-corroboration');
    const agent = await commitAgent('D', [NOW - 2 * 3_600_000, NOW - 3_600_000]);
    const incumbent = agent.ids[0];
    const { generatePE } = await import('../agent-bank/pe-utils');
    const forge = await generatePE(await relayDeps(), forgeCommit(agent.walletId, agent.agentId, agent.address, agent.shas[0]));
    await untilPriced(forge.peId);
    expect((await actRowOf(incumbent)).mint_status).toBe('corroborated_duplicate');
    const onDemoted = await recordMeterIncumbentCorroboration(m.db, { incumbentPeId: incumbent, corroboratingPeId: `pe_corr_D${RUN}`, nowMs: NOW, status: 'on_chain_verified' });
    expect(onDemoted.topups).toBe(0);
    expect(await topupsOf(incumbent)).toEqual([]);
    expect((await actRowOf(incumbent)).corroboration_status).toBe('on_chain_verified');
    const onLive = await recordMeterIncumbentCorroboration(m.db, { incumbentPeId: agent.ids[1], corroboratingPeId: `pe_corr_D2${RUN}`, nowMs: NOW, status: 'on_chain_verified' });
    expect(onLive.topups).toBeGreaterThan(0);
  });

  it('the take is conditioned on the version the scan read: a claim changed in between leaves the take to the next run (RED), unchanged it lands', async () => {
    const { aggregateWindowClaims, withoutAct } = await import('./meter-claims');
    const { runMeterClaimInlet } = await import('./meter-settlement');
    const payee = `0x${createHash('sha256').update(`take${RUN}`).digest('hex').slice(0, 40)}`;
    const batchHash = createHash('sha256').update(`takebatch${RUN}`).digest('hex');
    const [parent] = aggregateWindowClaims({
      batch_hash: batchHash, device_id: `dev_take_${RUN}`, actor_id: `agent_take_${RUN}`, created_at_ms: NOW,
      acts: [1, 2].map((i) => ({
        relay_pe_id: `pe_m_take${i}${RUN}`,
        legs: [{ leg: 'sole' as const, contributor: payee, beneficiary_class: 0, bps: 10_000, points_atomic: `${i}000` }],
        ready_at_ms: NOW - i * 60_000,
      })),
    });
    const ref = m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(parent.claim_key);
    await ref.set({ ...parent });
    // A takeover trims an act out of the claim after the scan read it, before the take commits.
    const racing = new Proxy(m.db, {
      get(target, prop) {
        if (prop === 'batch') {
          return () => {
            const write = target.batch();
            const commit = write.commit.bind(write);
            return Object.assign(write, {
              commit: async () => {
                await ref.update({ ...withoutAct(parent, parent.acts[1].relay_pe_id, NOW)! });
                return commit();
              },
            });
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const raced = await runMeterClaimInlet(racing, { nowMs: NOW, contributor: payee });
    expect(raced.rejected.map((r) => r.reason)).toEqual(['payout_members_changed']);
    expect(raced.payouts).toBe(0);
    const afterRace = (await ref.get()).data()!;
    expect(afterRace.state).toBe('pending');
    expect(afterRace.acts.map((a: { relay_pe_id: string }) => a.relay_pe_id)).toEqual([parent.acts[0].relay_pe_id]);
    // Unchanged since the scan, the next run's take lands.
    const next = await runMeterClaimInlet(m.db, { nowMs: NOW + 1, contributor: payee });
    expect(next.payouts).toBe(1);
    expect((await ref.get()).data()!.state).toBe('aggregated');
  });

  it('a metered send records the pair, so a receive from that counterparty is authored (on the meter)', async () => {
    const { resolveReceiveAuthorship } = await import('../pvt/policy/receive-authorship');
    const counterparty = `0x${createHash('sha256').update(`cp${RUN}`).digest('hex').slice(0, 40)}`;
    const stranger = `0x${createHash('sha256').update(`st${RUN}`).digest('hex').slice(0, 40)}`;
    const before = await resolveReceiveAuthorship(m.db, { economicActorId: AGENT_ID, walletAddress: AGENT_ADDRESS, counterpartyAddress: counterparty });
    expect(before.authored).toBe(false);

    const { generatePE } = await import('../agent-bank/pe-utils');
    const sent = await generatePE(await relayDeps(), {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS,
      actionType: 'send', counterpartyAddress: counterparty, durableViaOrdinaryIntake: true,
      metadata: { tx_hash: `0x${createHash('sha256').update(`send${RUN}`).digest('hex')}`, chain_id: 8453, asset: 'PVT' },
    });
    await untilPriced(sent.peId);
    const pair = await m.db.collection('counterparty_pairs_v1').doc(`${AGENT_ID}__${counterparty}`).get();
    expect(pair.data()).toMatchObject({ actor_id: AGENT_ID, counterparty, outbound_count: 1 });

    const after = await resolveReceiveAuthorship(m.db, { economicActorId: AGENT_ID, walletAddress: AGENT_ADDRESS, counterpartyAddress: counterparty });
    expect(after.authored).toBe(true);
    // RED: a counterparty this actor never paid is still unsolicited.
    const strangerVerdict = await resolveReceiveAuthorship(m.db, { economicActorId: AGENT_ID, walletAddress: AGENT_ADDRESS, counterpartyAddress: stranger });
    expect(strangerVerdict.authored).toBe(false);
  });

  it('relay-authored financial acts fold into the actor’s running totals; an unsolicited receive does not ', async () => {
    const { generatePE } = await import('../agent-bank/pe-utils');
    const { readActorMeterTotals } = await import('./actor-meter-totals');
    const counterparty = `0x${createHash('sha256').update(`cp${RUN}`).digest('hex').slice(0, 40)}`;
    const stranger = `0x${createHash('sha256').update(`st2${RUN}`).digest('hex').slice(0, 40)}`;
    const before = await readActorMeterTotals(m.db, AGENT_ID);
    const tx = (s: string) => `0x${createHash('sha256').update(`${s}${RUN}`).digest('hex')}`;

    const x402 = await generatePE(await relayDeps(), {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS, actionType: 'x402_payment',
      counterpartyAddress: counterparty, durableViaOrdinaryIntake: true,
      metadata: { chain_verified: true, amount_usd: 3, tx_hash: tx('x402'), chain_id: 8453 },
    });
    const authored = await generatePE(await relayDeps(), {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS, actionType: 'receive',
      counterpartyAddress: counterparty, durableViaOrdinaryIntake: true,
      metadata: { activity_mapped: true, amount_usd: 40, tx_hash: tx('rcv'), chain_id: 8453 },
    });
    // RED: a receive from a stranger this actor never dealt with is unsolicited and never counts.
    const unsolicited = await generatePE(await relayDeps(), {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS, actionType: 'receive',
      counterpartyAddress: stranger, durableViaOrdinaryIntake: true,
      metadata: { activity_mapped: true, amount_usd: 9000, tx_hash: tx('rcv2'), chain_id: 8453 },
    });
    const rows = await Promise.all([x402, authored, unsolicited].map((r) => untilPriced(r.peId)));
    console.log('[meter-emulator] financial rows', JSON.stringify(rows.map((k) => [k.action_type, k.row?.mint_status, k.row?.disposition_reason_code, k.facts?.financial?.kind ?? null, k.row?.userId, k.actor_id, k.held_reason])));
    for (const key of rows) expect(key.facts?.financial).toBeDefined();
    expect(rows[2].row?.disposition_reason_code).toBe('unsolicited_receive_record_only');

    const after = await readActorMeterTotals(m.db, AGENT_ID);
    expect(after.financial.x402_count - before.financial.x402_count).toBe(1);
    expect(after.financial.outbound_usd - before.financial.outbound_usd).toBe(3);
    // The authored receive waits for evidence (held): it is not counted while held…
    expect(rows[1].held_reason).toBe('pending_evidence');
    expect(after.financial.inbound_count - before.financial.inbound_count).toBe(0);
    // …and is counted exactly once when it leaves the hold with a non-unsolicited disposition.
    const { resolveHeldAct } = await import('./held-acts');
    const released = await resolveHeldAct(m.db, authored.peId, { mint_status: 'eligible', mint_disposition: 'eligible', disposition_reason_code: 'policy_eligible' }, {
      nowMs: NOW, expect: (row) => row.mint_status === 'pending_evidence',
    });
    expect(released.outcome).toBe('promoted');
    const final = await readActorMeterTotals(m.db, AGENT_ID);
    expect(final.financial.inbound_count - before.financial.inbound_count).toBe(1);
    expect(final.financial.inbound_usd - before.financial.inbound_usd).toBe(40);
    expect(final.financial_by_address[AGENT_ADDRESS.toLowerCase()]?.inbound_count ?? 0)
      .toBe((before.financial_by_address[AGENT_ADDRESS.toLowerCase()]?.inbound_count ?? 0) + 1);
    // The 9,000 unsolicited receive never entered the totals.
    expect(final.financial.inbound_usd - before.financial.inbound_usd).toBeLessThan(9000);
  });

  it('a backend corroboration on a metered act pays a top-up; self or wrong-hash corroboration pays nothing', async () => {
    const { generatePE } = await import('../agent-bank/pe-utils');
    const { emitBackendCorroboration } = await import('../corroboration/CorroborationManager');
    const deps = await relayDeps();
    const topupsOf = async (peId: string) => (await Promise.all(['sole', 'agent', 'beneficiary'].map((leg) =>
      m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(`mt_${peId}_${leg}`).get())))
      .filter((d) => d.exists).map((d) => d.data()!);
    const fresh = async (tag: string) => {
      const sha = createHash('sha1').update(`corr${tag}${RUN}`).digest('hex');
      const res = await generatePE(deps, forgeCommit(WALLET_ID, AGENT_ID, AGENT_ADDRESS, sha));
      await untilPriced(res.peId);
      return res;
    };
    const signal = (target: { peId: string; peHash: string }, party: string, hash = target.peHash) => emitBackendCorroboration(
      deps as unknown as import('../agent-bank/types').AgentBankDeps,
      { targetPeId: target.peId, targetPeHash: hash, signalType: 'on_chain_confirmation', corroboratingParty: party,
        evidence: `tx=${target.peId}`, evidenceRef: `ref_${target.peId}`, walletId: 'system', agentId: 'system_corroborator', actorAddress: '' },
    );

    const ok = await fresh('ok');
    await signal(ok, 'chain_watcher');
    const topups = await topupsOf(ok.peId);
    console.log('[meter-emulator] corroboration topups', JSON.stringify(topups.map((t) => [t.leg, t.record_points_atomic])));
    expect(topups.length).toBeGreaterThan(0);
    expect(topups.every((t) => t.act_identity?.hash === ok.peHash && BigInt(t.record_points_atomic) > 0n)).toBe(true);
    // One top-up per leg, ever: a second signal adds nothing.
    await signal(ok, 'chain_watcher');
    expect((await topupsOf(ok.peId)).length).toBe(topups.length);

    // RED: the act's own author cannot corroborate it.
    const self = await fresh('self');
    await signal(self, AGENT_ID);
    expect(await topupsOf(self.peId)).toEqual([]);
    // RED: a signal that does not carry the act's hash is refused.
    const wrong = await fresh('wrong');
    await signal(wrong, 'chain_watcher', 'f'.repeat(64));
    expect(await topupsOf(wrong.peId)).toEqual([]);
  });

  it('a held act outlives its key and, once promoted, gets its own act claims (on the meter)', async () => {
    const { generatePE } = await import('../agent-bank/pe-utils');
    const { resolveHeldAct, listHeldActs } = await import('./held-acts');
    // An institution lifecycle act with no verified evidence waits as pending_evidence.
    const res = await generatePE(await relayDeps(), {
      walletId: WALLET_ID, agentId: AGENT_ID, actorAddress: AGENT_ADDRESS,
      actionType: 'escrow_funded', durableViaOrdinaryIntake: true,
      metadata: { escrow_id: `esc_${RUN}`, tx_hash: `0x${createHash('sha256').update(`esc${RUN}`).digest('hex')}` },
    });
    const key = await untilPriced(res.peId);
    console.log('[meter-emulator] held act', JSON.stringify({ status: key.row.mint_status, held: key.held_reason, points: key.row.record_points_atomic }));
    expect(key.held_reason).toBe('pending_evidence');
    const held = await m.db.collection(m.store.METER_HELD_ACTS_COLLECTION).doc(res.peId).get();
    expect(held.exists).toBe(true);
    expect(held.data()?.key?.expire_at).toBeNull();
    const page = await listHeldActs(m.db, 'pending_evidence', { limit: 500 });
    expect(page.rows.some((r) => r.relayPeId === res.peId)).toBe(true);

    // The 31-day key lapses; the hold does not.
    await m.db.collection(m.store.METER_ACT_KEYS_COLLECTION).doc(res.peId).delete();

    // RED: a precondition the row does not meet changes nothing.
    const refused = await resolveHeldAct(m.db, res.peId, { mint_status: 'eligible' }, { nowMs: NOW, expect: (row) => row.mint_status === 'deferred' });
    expect(refused.outcome).toBe('precondition_failed');
    expect((await m.db.collection(m.store.METER_HELD_ACTS_COLLECTION).doc(res.peId).get()).exists).toBe(true);

    const promoted = await resolveHeldAct(m.db, res.peId, { mint_status: 'eligible', mint_disposition: 'eligible' }, {
      nowMs: NOW, expect: (row) => row.mint_status === 'pending_evidence',
    });
    expect(promoted.outcome).toBe('promoted');
    expect((await m.db.collection(m.store.METER_HELD_ACTS_COLLECTION).doc(res.peId).get()).exists).toBe(false);
    const claim = await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(`ma_${res.peId}_sole`).get();
    expect(claim.exists).toBe(true);
    expect(claim.data()?.act_identity?.hash).toBe(res.peHash);
    expect(claim.data()?.record_points_atomic).toBe(key.row.record_points_atomic);
    // Verifiable at settlement with the key gone: the claim carries its own identity.
    const { verifyMeterClaimMembers } = await import('./meter-settlement');
    await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(`ma_${res.peId}_sole`).update({ state: 'registered' });
    const verdicts = await verifyMeterClaimMembers(m.db, [{ pe_id: `ma_${res.peId}_sole`, leg: 'sole', claim_id: claim.data()!.claim_id }]);
    expect(verdicts.get(`ma_${res.peId}_sole`)).toMatchObject({ ok: true });
    // Once resolved, a second resolution finds nothing to do.
    expect((await resolveHeldAct(m.db, res.peId, { mint_status: 'eligible' }, { nowMs: NOW })).outcome).toBe('missing');
  });

  it('item 10: a pre-meter eligible act migrates to act claims with its legacy claim ids, verifiable with no PE row left', async () => {
    const { generatePE } = await import('../agent-bank/pe-utils');
    const { retireLegacyPe } = await import('./legacy-migration');
    const { deriveLegClaimId } = await import('../pvt/wp-ev/claim-id');
    const { verifyMeterClaimMembers } = await import('./meter-settlement');
    // A real priced act, then the pre-meter state it would have had: its priced row in
    // pe_history, its sealed identity in an envelope, and no meter records.
    const sha = createHash('sha1').update(`legacy${RUN}`).digest('hex');
    const res = await generatePE(await relayDeps(), forgeCommit(WALLET_ID, AGENT_ID, AGENT_ADDRESS, sha));
    const key = await untilPriced(res.peId);
    expect(key.row.mint_status).toBe('eligible');
    const legacyId = `pe_legacy_${RUN}`;
    const envelope = { id: legacyId, user_id: AGENT_ID, wallet_id: WALLET_ID, action_type: key.action_type, actor_address: AGENT_ADDRESS,
      timestamp: key.timestamp, prev_hash: key.prev_hash, hash: key.pe_hash, metadata: { commit_sha: sha } };
    await m.db.collection('pe_history').doc(legacyId).set({ ...key.row, peId: legacyId, userId: AGENT_ID });
    await m.db.collection('provenance_envelopes').doc(legacyId).set(envelope);

    const out = await retireLegacyPe(m.db, legacyId, { nowMs: NOW, apply: true, handBack: new Map(), identityPinned: new Set() });
    console.log('[meter-emulator] legacy migration', JSON.stringify(out));
    expect(out).toMatchObject({ kind: 'retired', held: false });
    expect((out as { converted: number }).converted).toBeGreaterThan(0);
    expect((await m.db.collection('pe_history').doc(legacyId).get()).exists).toBe(false);
    expect((await m.db.collection('provenance_envelopes').doc(legacyId).get()).exists).toBe(false);
    const claims = (await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).where('acts', '!=', null).get()).docs
      .map((d) => d.data()).filter((c) => c.acts?.[0]?.relay_pe_id === legacyId);
    expect(claims.length).toBe((out as { converted: number }).converted);
    let total = 0n;
    for (const claim of claims) {
      // The same claim id the legacy inlet would have registered: the kernel's mint-once spans both.
      const legacy = deriveLegClaimId({ id: legacyId, prev_hash: key.prev_hash, hash: key.pe_hash, timestamp: key.timestamp, action_type: key.action_type, user_id: AGENT_ID }, claim.leg);
      expect(legacy).toMatchObject({ kind: 'derived', claimId: claim.claim_id });
      await m.db.collection(m.store.METER_PENDING_CLAIMS_COLLECTION).doc(claim.claim_key).update({ state: 'registered' });
      const verdicts = await verifyMeterClaimMembers(m.db, [{ pe_id: claim.claim_key, leg: claim.leg, claim_id: claim.claim_id }]);
      expect(verdicts.get(claim.claim_key)).toMatchObject({ ok: true });
      total += BigInt(claim.record_points_atomic);
    }
    // Every earned point carried: the claims sum to the row's sealed points.
    expect(total.toString()).toBe(String(key.row.record_points_atomic));
  });

  it('a past act is presented from the PE its owner holds and proven against the anchored root (item 9)', async () => {
    const { proveMeterFact, checkMeterFactLeaf } = await import('./meter-fact-proof');
    const { verifyMerkleProof } = await import('../pvt/merkle');
    const { listMeterProofs } = await import('./meter-proofs');
    const { proofs } = await listMeterProofs(m.db, DEVICE_ID, 0);
    const first = proofs.find((p) => p.seq === 1)!;
    expect(first).toBeDefined();
    // The contract read: the anchored day root, exactly as PEAnchor.verifyPE checks it.
    const anchorContract = {
      verifyPE: async (batchId: string, leaf: string, proof: string[]) =>
        batchId === first.anchor.anchor_batch_id && verifyMerkleProof(leaf, proof, first.anchor.merkle_root),
    };
    const pe = firstBatchPes[0];
    const acts = firstBatch.acts;
    const actIndex = acts.findIndex((a) => a.pe_id === pe.pe_id);
    const inclusion = {
      act_index: actIndex,
      act_proof: m.wire.merkleProofOf(acts.map((a) => m.wire.actLeafOf(a)), actIndex),
      acts_root: first.acts_root,
      batch: { device_id: DEVICE_ID, actor_id: first.actor_id, seq: 1, batch_hash: first.batch_hash },
      anchor: { day: first.anchor.day, proof: [...first.anchor.proof] },
    };
    const claim = { pe_id: pe.pe_id, envelope_hash: m.wire.peHashOf(pe) };
    const proven = await proveMeterFact({ claim, pe, inclusion, presenterOwnerId: AGENT_ID, anchorContract });
    expect(proven.status).toBe('proven');
    if (proven.status !== 'proven') return;
    // The counterparty repeats hop 1 from the embedded act and gets the anchored leaf for hop 2.
    const leaf = checkMeterFactLeaf(claim.envelope_hash, proven.proof.leaf);
    expect(leaf).toBe(first.anchor.leaf_hash);
    expect(await anchorContract.verifyPE(proven.proof.anchor.batch_id as string, leaf!, proven.proof.merkle_proof)).toBe(true);

    // RED: an edited PE does not prove (its hash is not the claimed one, and as claimed it is not in the batch).
    const edited = { ...pe, description: 'not what happened' };
    expect((await proveMeterFact({ claim, pe: edited, inclusion, presenterOwnerId: AGENT_ID, anchorContract })).status).toBe('refused');
    const editedClaim = { pe_id: pe.pe_id, envelope_hash: m.wire.peHashOf(edited) };
    expect(await proveMeterFact({ claim: editedClaim, pe: edited, inclusion, presenterOwnerId: AGENT_ID, anchorContract }))
      .toEqual({ status: 'refused', http: 409, reason: 'act_not_in_batch' });
    // RED: someone else cannot present this actor's act.
    expect(await proveMeterFact({ claim, pe, inclusion, presenterOwnerId: 'someone_else', anchorContract }))
      .toEqual({ status: 'refused', http: 403, reason: 'pe_not_owned' });
    // RED: a batch the chain never anchored does not prove.
    const unanchored = { verifyPE: async () => false };
    expect(await proveMeterFact({ claim, pe, inclusion, presenterOwnerId: AGENT_ID, anchorContract: unanchored }))
      .toEqual({ status: 'refused', http: 409, reason: 'pe_not_anchored' });
    // RED: the counterparty refuses a leaf whose act was swapped after the fact.
    const swapped = { ...proven.proof.leaf, act: { ...(proven.proof.leaf.act as Record<string, unknown>), pricing: { forged: true } } };
    expect(checkMeterFactLeaf(claim.envelope_hash, swapped)).toBeNull();
  });

  it('shutdown coverage: an act received at or after the accrual end line is counted, never minted, and the receipt says why', async () => {
    const at = NOW + 24 * 3_600_000;
    const saved = process.env.PVT_ACCRUAL_END_MS;
    process.env.PVT_ACCRUAL_END_MS = String(at);
    try {
      const batch = nextBatch([chatPe(fp('after-end-line'), NOW - 2_000)], at);
      const res = await m.ingest.ingestMeterBatch(m.db, await lane(true, at), batch, at);
      expect(res.status).toBe(201);
      accept(batch);
      const receipt = res.body as import('./meter-store').MeterBatchReceipt;
      console.log('[meter-emulator] after end line', JSON.stringify(receipt.acts));
      expect(receipt.acts[0].disposition).not.toBe('eligible');
      expect(receipt.acts[0].reason).toBe('service_accrual_ended');
      expect(BigInt(receipt.totals.eligible_points_atomic)).toBe(0n);
    } finally {
      if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = saved;
    }
  });
});
