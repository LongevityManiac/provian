/**
 * Fix run 2026-10-24 (CC launch audit C1 + M1) — against the Firestore EMULATOR, on the real phone
 * batch path (`ingestMeterBatch` + `mobileActToAccrualParams` + `recordPEAccrual`, unmocked).
 * Skipped unless FIRESTORE_EMULATOR_HOST is set:
 *
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 npx firebase emulators:start --only firestore --project demo-meter
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx jest src/core/meter/meter-phone-replay.emulator.test.ts
 *
 * What it pins:
 *   - a `human_approval` request mints exactly once across batches: an act re-submitted in a later
 *     batch under the same client pe_id (the app resolved the request with it), or under the relay
 *     id the first seal stamped, earns nothing; the request carries `sealed_by_pe_id`;
 *   - a phone chain belongs to the wallet that opened it: another wallet naming the same device id
 *     cannot extend it (403 `batch_device_not_owned`), and the owner's next batch still lands.
 * RED controls: each first batch mints / lands, so the zeros and refusals below are not defaults.
 * The lane is built exactly as server.ts builds `POST /v1/meter/batch/mobile`'s.
 */
import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import { createHash, randomUUID } from 'crypto';

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

const RUN = `p${Date.now().toString(36)}`;
const NOW = Date.now();
const BATCH_GAP_MS = 6 * 60_000; // past the 5-minute batch interval
// After the seal-stamp line (human-approval-earning.ts), so the request is a live, unsealed one.
const REQUEST_CREATED_AT_MS = 1_792_929_600_000;

type Wire = typeof import('./meter-wire');
let db: FirebaseFirestore.Firestore;
let wire: Wire;

interface Phone {
  readonly userId: string;
  readonly walletDoc: string;
  readonly address: string;
  readonly deviceId: string;
  chainTip: string;
  seq: number;
  prevBatch: string;
}

async function newPhone(tag: string, deviceId?: string): Promise<Phone> {
  const p: Phone = {
    userId: `user_${tag}_${RUN}`,
    walletDoc: `wallet_${tag}_${RUN}`,
    address: `0x${createHash('sha256').update(`${tag}${RUN}`).digest('hex').slice(0, 40)}`,
    deviceId: deviceId ?? `device_${createHash('sha256').update(`dev${tag}${RUN}`).digest('hex').slice(0, 32)}`,
    chainTip: 'genesis', seq: 0, prevBatch: 'genesis',
  };
  await db.collection('wallets').doc(p.walletDoc).set({ id: p.walletDoc, type: 'human', user_id: p.userId, address: p.address, status: 'active' });
  return p;
}

/** The lane exactly as server.ts builds it for `POST /v1/meter/batch/mobile`. */
async function phoneLane(p: Phone, nowMs: number, deviceId = p.deviceId): Promise<import('./meter-ingest').MeterLane> {
  const { mobileActToAccrualParams } = await import('./mobile-act');
  const mobileLane: import('./mobile-act').MobileBatchLane = {
    db, userId: p.userId, deviceId, attestationTier: 'software', deviceAttestationId: null,
    actorAddress: p.address, humanWalletDocId: p.walletDoc, receivedAtMs: nowMs, appleAssertion: null,
    hooks: [], afterCommit: [],
  };
  return {
    deviceId, actorId: p.userId, resolveSealedRecipient: () => null,
    mapAct: (act, relayPeId) => mobileActToAccrualParams(mobileLane, act, relayPeId),
    singleLaneCut: true,
    ownerBoundChain: true,
    extraWrites: () => [], txnHooks: () => mobileLane.hooks,
  } as import('./meter-ingest').MeterLane;
}

function pe(p: Phone, fields: Record<string, unknown>, deviceId = p.deviceId): import('./meter-wire').PeV2 {
  const out = { schema: wire.PE_V2_SCHEMA, device_id: deviceId, prev_hash: p.chainTip, ...fields } as import('./meter-wire').PeV2;
  p.chainTip = wire.peHashOf(out);
  return out;
}

function chat(p: Phone, seed: string, timestamp: number): import('./meter-wire').PeV2 {
  return pe(p, {
    pe_id: `pe_${seed}_${RUN}`, timestamp, action_type: 'ai_conversation',
    ai_conversation_metadata: {
      provider: 'claude', surface: 'mobile_wrapper', duration_ms: 60_000, active_duration_ms: 30_000,
      turn_count: 4, char_count: 900, image_count: 0, video_seconds: 0,
      session_fingerprint_hash: createHash('sha256').update(`${RUN}:${seed}`).digest('hex'), input_fidelity: 'full',
    },
  });
}

function batchOf(p: Phone, pes: import('./meter-wire').PeV2[], createdAt: number, deviceId = p.deviceId): import('./meter-wire').PeBatch {
  return wire.buildBatch({ device_id: deviceId, seq: p.seq + 1, prev_batch_hash: p.prevBatch, created_at_ms: createdAt, pes });
}

function accept(p: Phone, batch: import('./meter-wire').PeBatch): void {
  p.seq = batch.seq;
  p.prevBatch = wire.batchHashOf(batch);
}

const SUBJECT = `sha256:${'d'.repeat(64)}`;

async function seedRequest(humanUserId: string, agentWalletId: string): Promise<string> {
  const { HUMAN_APPROVAL_REQUESTS_COLLECTION } = await import('../pe/human-approval-request');
  const requestId = `apr_${createHash('sha256').update(`${RUN}${randomUUID()}`).digest('hex').slice(0, 32)}`;
  await db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(requestId).set({
    request_id: requestId, agent_wallet_id: agentWalletId, human_user_id: humanUserId,
    action_description: 'Pay 12 USDC to the plumber', action_description_sha256: SUBJECT,
    subject_pe_id: null, status: 'pending', created_at_ms: REQUEST_CREATED_AT_MS,
    expires_at_ms: NOW + 7 * 86_400_000, satisfied_by_pe_id: null, decision: null,
  });
  return requestId;
}

function approvalPe(p: Phone, peId: string, requestId: string, agentWalletId: string, timestamp: number): import('./meter-wire').PeV2 {
  return pe(p, {
    pe_id: peId, timestamp, action_type: 'human_approval',
    approval_metadata: { agent_wallet_id: agentWalletId, decision: 'approved', subject_hash: SUBJECT, request_id: requestId },
  });
}

function minted(r: import('./meter-store').MeterActReceipt): boolean {
  return r.disposition === 'eligible' && BigInt(r.record_points_atomic) > 0n;
}

async function requestDoc(requestId: string): Promise<Record<string, unknown>> {
  const { HUMAN_APPROVAL_REQUESTS_COLLECTION } = await import('../pe/human-approval-request');
  return (await db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(requestId).get()).data() ?? {};
}

suite('fix run 2026-10-24 — human_approval mints once; a phone chain is its wallet\'s (Firestore emulator)', () => {
  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-meter';
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
    try { db.settings((await import('../../firestore-settings')).RELAY_FIRESTORE_SETTINGS); } catch { /* already set */ }
    wire = await import('./meter-wire');
  });

  it('C1: a request the app resolved with its client pe_id mints once; the same pe_id in a later batch earns nothing', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { resolveApprovalRequest } = await import('../pe/human-approval-request-store');
    const h = await newPhone('h1');
    const agentWallet = `wallet_aw_h1${RUN}`;
    const requestId = await seedRequest(h.userId, agentWallet);
    const clientPeId = randomUUID();
    const resolved = await resolveApprovalRequest(db, { requestId, humanUserId: h.userId, approvalPeId: clientPeId, decision: 'approved', nowMs: NOW });
    expect(resolved.ok).toBe(true);

    const first = batchOf(h, [approvalPe(h, clientPeId, requestId, agentWallet, NOW - 60_000)], NOW);
    const r1 = await ingestMeterBatch(db, await phoneLane(h, NOW), first, NOW);
    expect(r1.status).toBe(201);
    const a1 = (r1.body as import('./meter-store').MeterBatchReceipt).acts[0];
    console.log('[phone-replay] client-id first', JSON.stringify([a1.disposition, a1.reason, a1.record_points_atomic]));
    expect(minted(a1)).toBe(true); // RED control: the first seal mints
    accept(h, first);

    const t2 = NOW + BATCH_GAP_MS;
    const replay = batchOf(h, [approvalPe(h, clientPeId, requestId, agentWallet, t2 - 60_000)], t2);
    const r2 = await ingestMeterBatch(db, await phoneLane(h, t2), replay, t2);
    console.log('[phone-replay] client-id replay', r2.status, JSON.stringify((r2.body as import('./meter-store').MeterBatchReceipt).acts?.map((a) => [a.disposition, a.reason, a.record_points_atomic])));
    expect(r2.status).toBe(201);
    expect(minted((r2.body as import('./meter-store').MeterBatchReceipt).acts[0])).toBe(false);
    expect((await requestDoc(requestId)).sealed_by_pe_id).toBe(a1.relay_pe_id);
  });

  it('C1: a request a batch claimed while pending mints once; an act naming the stamped relay id in a later batch earns nothing', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const h = await newPhone('h2');
    const agentWallet = `wallet_aw_h2${RUN}`;
    const requestId = await seedRequest(h.userId, agentWallet);

    const first = batchOf(h, [approvalPe(h, randomUUID(), requestId, agentWallet, NOW - 60_000)], NOW);
    const r1 = await ingestMeterBatch(db, await phoneLane(h, NOW), first, NOW);
    expect(r1.status).toBe(201);
    const a1 = (r1.body as import('./meter-store').MeterBatchReceipt).acts[0];
    console.log('[phone-replay] pending first', JSON.stringify([a1.disposition, a1.reason, a1.record_points_atomic]));
    expect(minted(a1)).toBe(true);
    accept(h, first);
    const doc = await requestDoc(requestId);
    expect(doc.satisfied_by_pe_id).toBe(a1.relay_pe_id);

    const t2 = NOW + BATCH_GAP_MS;
    const replay = batchOf(h, [approvalPe(h, a1.relay_pe_id, requestId, agentWallet, t2 - 60_000)], t2);
    const r2 = await ingestMeterBatch(db, await phoneLane(h, t2), replay, t2);
    console.log('[phone-replay] relay-id replay', r2.status, JSON.stringify((r2.body as import('./meter-store').MeterBatchReceipt).acts?.map((a) => [a.disposition, a.reason, a.record_points_atomic])));
    expect(r2.status).toBe(201);
    expect(minted((r2.body as import('./meter-store').MeterBatchReceipt).acts[0])).toBe(false);
  });

  /** A batch whose single act claims a pe_hash the client chose (the relay never recomputes it). */
  function forgedHashBatch(p: Phone, pes: import('./meter-wire').PeV2[], createdAt: number, forgedPeHash: string): import('./meter-wire').PeBatch {
    const acts = pes.map(wire.actRecordOf).map((a, i) => (i === 0 ? { ...a, pe_hash: forgedPeHash } : a));
    p.chainTip = forgedPeHash;
    return { ...wire.buildBatch({ device_id: p.deviceId, seq: p.seq + 1, prev_batch_hash: p.prevBatch, created_at_ms: createdAt, pes }), acts, acts_root: wire.actsRootOf(acts) };
  }

  it('C1 ( ): a later act reproducing the SAME relay id (from a chosen pe_hash) earns nothing', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const h = await newPhone('h3');
    const agentWallet = `wallet_aw_h3${RUN}`;
    const requestId = await seedRequest(h.userId, agentWallet);
    const first = batchOf(h, [approvalPe(h, randomUUID(), requestId, agentWallet, NOW - 60_000)], NOW);
    const firstHash = first.acts[0].pe_hash;
    const r1 = await ingestMeterBatch(db, await phoneLane(h, NOW), first, NOW);
    const a1 = (r1.body as import('./meter-store').MeterBatchReceipt).acts[0];
    expect(minted(a1)).toBe(true);
    accept(h, first);

    const t2 = NOW + BATCH_GAP_MS;
    const sameRelayId = `${firstHash.slice(0, 48)}${'f'.repeat(16)}`;
    const replay = forgedHashBatch(h, [approvalPe(h, randomUUID(), requestId, agentWallet, t2 - 60_000)], t2, sameRelayId);
    const r2 = await ingestMeterBatch(db, await phoneLane(h, t2), replay, t2);
    expect(r2.status).toBe(201);
    const a2 = (r2.body as import('./meter-store').MeterBatchReceipt).acts[0];
    console.log('[phone-replay] same-relay-id replay', JSON.stringify([a2.relay_pe_id === a1.relay_pe_id, a2.disposition, a2.reason, a2.record_points_atomic]));
    expect(a2.relay_pe_id).toBe(a1.relay_pe_id);
    expect(minted(a2)).toBe(false);
  });

  it('C1 ( ): the same wallet re-sending the identical act on a second chain earns nothing', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const h = await newPhone('h4');
    const agentWallet = `wallet_aw_h4${RUN}`;
    const requestId = await seedRequest(h.userId, agentWallet);
    const act = approvalPe(h, randomUUID(), requestId, agentWallet, NOW - 60_000);
    const first = batchOf(h, [act], NOW);
    const r1 = await ingestMeterBatch(db, await phoneLane(h, NOW), first, NOW);
    expect(minted((r1.body as import('./meter-store').MeterBatchReceipt).acts[0])).toBe(true);

    const second: Phone = { ...h, deviceId: `device_${createHash('sha256').update(`second${RUN}`).digest('hex').slice(0, 32)}`, chainTip: 'genesis', seq: 0, prevBatch: 'genesis' };
    const again = batchOf(second, [{ ...act, device_id: second.deviceId }], NOW, second.deviceId);
    const r2 = await ingestMeterBatch(db, await phoneLane(second, NOW), again, NOW);
    expect(r2.status).toBe(201);
    const a2 = (r2.body as import('./meter-store').MeterBatchReceipt).acts[0];
    console.log('[phone-replay] second-chain replay', JSON.stringify([a2.disposition, a2.reason, a2.record_points_atomic]));
    expect(minted(a2)).toBe(false);
  });

  it('C1 ( ): two approvals for one request in one batch — one mints, and the stamp names it', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const h = await newPhone('h5');
    const agentWallet = `wallet_aw_h5${RUN}`;
    const requestId = await seedRequest(h.userId, agentWallet);
    const batch = batchOf(h, [
      approvalPe(h, randomUUID(), requestId, agentWallet, NOW - 60_000),
      approvalPe(h, randomUUID(), requestId, agentWallet, NOW - 30_000),
    ], NOW);
    const r = await ingestMeterBatch(db, await phoneLane(h, NOW), batch, NOW);
    expect(r.status).toBe(201);
    const acts = (r.body as import('./meter-store').MeterBatchReceipt).acts;
    console.log('[phone-replay] two in one batch', JSON.stringify(acts.map((a) => [a.relay_pe_id.slice(0, 12), a.disposition, a.record_points_atomic])));
    const winners = acts.filter(minted);
    expect(winners).toHaveLength(1);
    const doc = await requestDoc(requestId);
    expect(doc.sealed_by_pe_id).toBe(winners[0].relay_pe_id);
    expect(doc.satisfied_by_pe_id).toBe(winners[0].relay_pe_id);
  });

  it('M1: another wallet naming the same device id cannot extend the chain; the owner\'s next batch still lands', async () => {
    const { ingestMeterBatch } = await import('./meter-ingest');
    const { METER_DEVICE_TIPS_COLLECTION } = await import('./meter-store');
    const owner = await newPhone('own');
    const first = batchOf(owner, [chat(owner, 'own-1', NOW - 60_000)], NOW);
    const r1 = await ingestMeterBatch(db, await phoneLane(owner, NOW), first, NOW);
    expect(r1.status).toBe(201); // RED control: the owner's batch lands
    accept(owner, first);

    // The intruder learned the device id (a presentation's proof leaf) and the tip; it builds a
    // batch that correctly continues the owner's chain, under its OWN wallet.
    const intruder = await newPhone('intr', owner.deviceId);
    intruder.chainTip = owner.chainTip;
    intruder.seq = owner.seq;
    intruder.prevBatch = owner.prevBatch;
    const t2 = NOW + BATCH_GAP_MS;
    const forged = batchOf(intruder, [chat(intruder, 'intr-1', t2 - 60_000)], t2, owner.deviceId);
    const r2 = await ingestMeterBatch(db, await phoneLane(intruder, t2, owner.deviceId), forged, t2);
    console.log('[phone-replay] cross-user extension', r2.status, JSON.stringify(r2.body).slice(0, 200));
    expect(r2.status).toBe(403);
    expect((r2.body as Record<string, unknown>).error).toBe('batch_device_not_owned');
    const tip = (await db.collection(METER_DEVICE_TIPS_COLLECTION).doc(owner.deviceId).get()).data();
    expect(tip?.actor_id).toBe(owner.userId);
    expect(tip?.seq).toBe(1);

    const own2 = batchOf(owner, [chat(owner, 'own-2', t2 - 30_000)], t2);
    const r3 = await ingestMeterBatch(db, await phoneLane(owner, t2), own2, t2);
    expect(r3.status).toBe(201);
  });
});
