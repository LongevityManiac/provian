/**
 * — the relay's x402 facilitator surfaces, over HTTP.
 *
 * POST /v1/internal/x402/facilitator-settlement — every refusal path, each beside its GREEN:
 * the shared secret (unset / short / missing / wrong), the pointer shape, the asset allowlist,
 * a reverted receipt (status 0), a missing payment / fee Transfer, a wrong settler, a Solana
 * meta.err and a missing Solana fee delta; the identity filter; idempotency and the conflict;
 * a pending pointer kept and swept to recorded.
 * GET /v1/x402/sellers — active sellers only, public fields only, chain filter, keyset paging.
 *
 * The lane's emit is a recording stub here (the money outcome through the REAL accrual is
 * `core/pvt/x402-facilitator-lane.acceptance.test.ts`).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { transactionEvidence, transferLog, topicOf } from '../core/pvt/__test-helpers__/base-transaction-evidence';
import { BASE_USDC_ADDRESS, type BaseTransactionEvidence, type CanonicalEconomicLog } from '../core/onchain/economic-discovery';
import { FEE_SETTLED_TOPIC, SOLANA_USDC_MINT, type SolanaParsedTransaction } from '../core/pvt/x402-facilitator-settlement';
import {
  FACILITATOR_SETTLEMENTS_COLLECTION,
  runFacilitatorSettlementSweep,
  type FacilitatorEmitInput,
  type FacilitatorLaneDeps,
} from '../core/pvt/x402-facilitator-lane';
import type { ChainRecordWallet } from '../core/pvt/chain-record-watcher';
import { createFacilitatorSettlementRouter } from './x402-facilitator';
import { createX402SellersRouter } from './x402-sellers';

const SECRET = 's'.repeat(48);
const SETTLER = '0x5e77100000000000000000000000000000000b01';
const FEE = '0xa37fc594e98e951571c771c9e77cdc73f67d3efb';
const BUYER = '0xaaaa00000000000000000000000000000000000a';
const SELLER = '0xcccc00000000000000000000000000000000000c';
const TX = `0x${'7'.repeat(64)}`;
const NOW = Date.UTC(2026, 9, 4, 12);

function feeSettled(tx: string, value: bigint, fee: bigint): CanonicalEconomicLog {
  return {
    ...transferLog(tx, SETTLER, BUYER, SELLER, 0n, 3),
    topics: [FEE_SETTLED_TOPIC, topicOf(BUYER), topicOf(SELLER), topicOf(BASE_USDC_ADDRESS)],
    data: `0x${value.toString(16).padStart(64, '0')}${fee.toString(16).padStart(64, '0')}`,
  };
}

function baseTx(over: { to?: string; payment?: boolean; fee?: boolean } = {}): BaseTransactionEvidence {
  return transactionEvidence({
    transactionHash: TX, fromAddress: FEE, toAddress: over.to ?? SETTLER, blockTimestampMs: NOW,
    logs: [
      ...(over.payment === false ? [] : [transferLog(TX, BASE_USDC_ADDRESS, BUYER, SELLER, 1_000_000n, 1)]),
      ...(over.fee === false ? [] : [transferLog(TX, BASE_USDC_ADDRESS, SELLER, FEE, 300n, 2)]),
      feeSettled(TX, 1_000_000n, 300n),
    ],
  });
}

const BODY = {
  chain: 'base', tx_hash: TX, buyer: BUYER, seller: SELLER, asset: BASE_USDC_ADDRESS,
  amount: '1000000', fee: '300', scheme: 'eip3009',
};

const identity = (address: string, agentId: string): ChainRecordWallet => ({
  walletId: `w_${agentId}`, agentId, address, eligibilityStartBlock: 0, ownerType: 'agent',
});

interface Harness {
  app: Express;
  db: FakeFirestore;
  emitted: FacilitatorEmitInput[];
  chain: { base: BaseTransactionEvidence | Error | null; solana: SolanaParsedTransaction | null };
  env: Record<string, string | undefined>;
  identities: Map<string, ChainRecordWallet | null>;
  laneDeps: () => FacilitatorLaneDeps;
}

function harness(): Harness {
  const db = createFakeFirestore();
  const emitted: FacilitatorEmitInput[] = [];
  const h = {
    db,
    emitted,
    chain: { base: baseTx() as BaseTransactionEvidence | Error | null, solana: null as SolanaParsedTransaction | null },
    env: { FACILITATOR_RELAY_SECRET: SECRET, FACILITATOR_SETTLER_ADDRESS: SETTLER } as Record<string, string | undefined>,
    identities: new Map<string, ChainRecordWallet | null>([
      [BUYER, identity(BUYER, 'agent_buyer')],
      [SELLER, identity(SELLER, 'agent_seller')],
    ]),
  } as Omit<Harness, 'app' | 'laneDeps'>;
  const laneDeps = (): FacilitatorLaneDeps => ({
    db: db as unknown as Firestore,
    env: h.env,
    verifyBaseTransaction: async () => {
      if (h.chain.base === null) throw new Error('economic_evidence_pending:confirmations:3/12');
      if (h.chain.base instanceof Error) throw h.chain.base;
      return h.chain.base;
    },
    getSolanaTransaction: async () => h.chain.solana,
    emit: async (input) => {
      emitted.push(input);
      return { peId: `pe_x402fac_${input.role}` };
    },
    resolveBaseIdentity: async (_db, address) => h.identities.get(address) ?? null,
    now: () => NOW,
  });
  const app = express();
  app.use(express.json());
  app.use('/v1/internal/x402', createFacilitatorSettlementRouter({ laneDeps, env: h.env }));
  return { ...h, app, laneDeps };
}

const post = (h: Harness, body: unknown = BODY, auth: string | null = `Bearer ${SECRET}`) => {
  const r = request(h.app).post('/v1/internal/x402/facilitator-settlement').send(body as object);
  return auth === null ? r : r.set('Authorization', auth);
};

describe('POST /v1/internal/x402/facilitator-settlement — the shared secret', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('GREEN: the right secret reaches the lane (200, acts recorded)', async () => {
    const res = await post(h).expect(200);
    expect(res.body).toMatchObject({ status: 'recorded', chain: 'base', tx_hash: TX });
  });
  it('RED: env secret unset → 503, fail closed, nothing processed', async () => {
    delete h.env.FACILITATOR_RELAY_SECRET;
    await post(h).expect(503);
    expect(h.emitted).toHaveLength(0);
  });
  it('RED: a too-short env secret is treated as unset → 503', async () => {
    h.env.FACILITATOR_RELAY_SECRET = 'short';
    await post(h, BODY, 'Bearer short').expect(503);
  });
  it('RED: no Authorization header → 401', async () => {
    await post(h, BODY, null).expect(401);
    expect(h.emitted).toHaveLength(0);
  });
  it('RED: a wrong secret (same length, and a different length) → 401', async () => {
    await post(h, BODY, `Bearer ${'t'.repeat(48)}`).expect(401);
    await post(h, BODY, `Bearer ${SECRET}x`).expect(401);
    await post(h, BODY, SECRET).expect(401); // not a Bearer
    expect(h.emitted).toHaveLength(0);
  });
});

describe('POST /v1/internal/x402/facilitator-settlement — the relay re-reads the chain', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('GREEN: both Provian parties get their act', async () => {
    const res = await post(h).expect(200);
    expect(res.body.acts).toEqual([
      expect.objectContaining({ role: 'buyer', action_type: 'x402_payment', recorded: true, pe_id: 'pe_x402fac_buyer' }),
      expect.objectContaining({ role: 'seller', action_type: 'receive', recorded: true, pe_id: 'pe_x402fac_seller' }),
    ]);
    expect(h.emitted.map((e) => [e.role, e.counterparty, e.paymentLogIndex])).toEqual([
      ['buyer', SELLER, 1], ['seller', BUYER, 1],
    ]);
  });
  it('RED: a malformed body → 400 with the reason, nothing read', async () => {
    const res = await post(h, { ...BODY, amount: '-1' }).expect(400);
    expect(res.body).toEqual({ error: 'invalid_settlement', reason: 'amount_invalid' });
    expect((await post(h, [BODY]).expect(400)).body.reason).toBe('body_not_object');
  });
  it('RED: an asset that is neither USDC nor PVT → 400', async () => {
    const res = await post(h, { ...BODY, asset: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', scheme: 'permit2' }).expect(400);
    expect(res.body.reason).toBe('asset_not_allowed');
  });
  it('RED: a reverted transaction (receipt status 0) → 422 transaction_failed, recorded as refused', async () => {
    h.chain.base = new Error('economic_evidence_transaction_failed');
    const res = await post(h).expect(422);
    expect(res.body).toEqual({ error: 'settlement_not_verified', reason: 'transaction_failed' });
    expect(h.emitted).toHaveLength(0);
    expect(h.db.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`)).toMatchObject({ status: 'refused' });
  });
  it('RED: no payment Transfer log → 422', async () => {
    h.chain.base = baseTx({ payment: false });
    expect((await post(h).expect(422)).body.reason).toBe('payment_transfer_missing');
    expect(h.emitted).toHaveLength(0);
  });
  it('RED: no fee Transfer log → 422', async () => {
    h.chain.base = baseTx({ fee: false });
    expect((await post(h).expect(422)).body.reason).toBe('fee_transfer_missing');
  });
  it('RED: the transaction was not sent to the settler → 422', async () => {
    h.chain.base = baseTx({ to: BASE_USDC_ADDRESS });
    expect((await post(h).expect(422)).body.reason).toBe('settler_target_mismatch');
  });
  it('RED: no settler configured on the relay → 503, nothing read', async () => {
    delete h.env.FACILITATOR_SETTLER_ADDRESS;
    expect((await post(h).expect(503)).body.reason).toBe('facilitator_settler_not_configured');
    expect(h.db.store.has(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`)).toBe(false);
  });
  it('identity filter: a party that is not a Provian identity gets no act', async () => {
    h.identities.set(SELLER, null);
    const res = await post(h).expect(200);
    expect(res.body.acts[1]).toMatchObject({ role: 'seller', recorded: false, reason: 'not_a_provian_identity', pe_id: null });
    expect(h.emitted.map((e) => e.role)).toEqual(['buyer']);
  });
  it('identity filter: a party whose identity fence is after the block gets no act', async () => {
    h.identities.set(BUYER, { ...identity(BUYER, 'agent_buyer'), eligibilityStartBlock: Number.MAX_SAFE_INTEGER });
    const res = await post(h).expect(200);
    expect(res.body.acts[0]).toMatchObject({ role: 'buyer', recorded: false, reason: 'before_identity_fence' });
  });
});

describe('POST /v1/internal/x402/facilitator-settlement — idempotent, pending, conflict', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('the same report twice answers the same result and emits once', async () => {
    const first = await post(h).expect(200);
    const second = await post(h).expect(200);
    expect(second.body).toEqual(first.body);
    expect(h.emitted).toHaveLength(2); // buyer + seller, once
  });
  it('RED: the same transaction reported with different terms after it was recorded → 409', async () => {
    await post(h).expect(200);
    const res = await post(h, { ...BODY, fee: '301' }).expect(409);
    expect(res.body.error).toBe('settlement_conflict');
  });
  it('not yet final → 202 pending, kept; the relay\'s own sweep records it once it is final', async () => {
    h.chain.base = null;
    expect((await post(h).expect(202)).body).toMatchObject({ status: 'pending' });
    expect(h.emitted).toHaveLength(0);
    expect(h.db.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`)).toMatchObject({ status: 'pending' });
    h.chain.base = baseTx();
    const report = await runFacilitatorSettlementSweep({ ...h.laneDeps(), now: () => NOW + 3_600_000 });
    expect(report).toMatchObject({ scanned: 1, recorded: 1 });
    expect(h.db.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`)).toMatchObject({ status: 'recorded' });
    expect(h.emitted).toHaveLength(2);
    // A recorded pointer is never swept again.
    expect(await runFacilitatorSettlementSweep({ ...h.laneDeps(), now: () => NOW + 7_200_000 }))
      .toMatchObject({ scanned: 0 });
  });
  it('RED: a refused report naming different terms never displaces a queued pending pointer', async () => {
    h.chain.base = null;
    await post(h).expect(202);
    h.chain.base = baseTx();
    await post(h, { ...BODY, amount: '999' }).expect(422); // the chain does not show 999
    const doc = h.db.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`) as { status: string; claim: { amount: string } };
    expect(doc).toMatchObject({ status: 'pending', claim: { amount: '1000000' } });
    expect(await runFacilitatorSettlementSweep({ ...h.laneDeps(), now: () => NOW + 3_600_000 })).toMatchObject({ recorded: 1 });
  });
  it('the sweep refuses a pointer that never became final within the horizon', async () => {
    h.chain.base = null;
    await post(h).expect(202);
    const report = await runFacilitatorSettlementSweep({ ...h.laneDeps(), now: () => NOW + 8 * 24 * 3_600_000 });
    expect(report.refused).toBe(1);
    expect(h.db.store.get(`${FACILITATOR_SETTLEMENTS_COLLECTION}/base:${TX}`)).toMatchObject({ status: 'refused' });
  });
});

describe('POST /v1/internal/x402/facilitator-settlement — Solana', () => {
  const FEE_WALLET = 'DPB89TipwTCxFnQCdtvJE8cm8718jytvzyYEBfQP3t2';
  const SBUYER = 'B'.repeat(44);
  const SSELLER = 'C'.repeat(44);
  const SIG = '5'.repeat(88);
  const SOL_BODY = {
    chain: 'solana', tx_hash: SIG, buyer: SBUYER, seller: SSELLER, asset: SOLANA_USDC_MINT,
    amount: '1000000', fee: '50', scheme: 'svm_exact',
  };
  const bal = (accountIndex: number, owner: string, amount: string) => ({
    accountIndex, owner, mint: SOLANA_USDC_MINT, uiTokenAmount: { amount },
  });
  const solTx = (over: { err?: unknown; feeAmount?: string } = {}): SolanaParsedTransaction => ({
    slot: 1, blockTime: Math.floor(NOW / 1000),
    meta: {
      err: over.err ?? null,
      preTokenBalances: [bal(1, SBUYER, '5000000'), bal(2, SSELLER, '0'), bal(3, FEE_WALLET, '0')],
      postTokenBalances: [bal(1, SBUYER, '3999950'), bal(2, SSELLER, '1000000'), bal(3, FEE_WALLET, over.feeAmount ?? '50')],
    },
    transaction: { signatures: [SIG], message: { accountKeys: [{ pubkey: FEE_WALLET, signer: true }] } },
  });
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('GREEN: verified; neither Solana address holds a proof of control, so no act is sealed (said so per party)', async () => {
    h.chain.solana = solTx();
    const res = await post(h, SOL_BODY).expect(200);
    // An unproven Solana address is not a Provian identity (`solana_proven_addresses` is empty here);
    // the proven path is driven end to end in `x402-facilitator-lane.solana.acceptance.test.ts`.
    expect(res.body.acts).toEqual([
      expect.objectContaining({ role: 'buyer', recorded: false, reason: 'not_a_provian_identity' }),
      expect.objectContaining({ role: 'seller', recorded: false, reason: 'not_a_provian_identity' }),
    ]);
    expect(h.emitted).toHaveLength(0);
  });
  it('RED: meta.err set → 422 transaction_failed', async () => {
    h.chain.solana = solTx({ err: { InstructionError: [1, { Custom: 1 }] } });
    expect((await post(h, SOL_BODY).expect(422)).body.reason).toBe('transaction_failed');
  });
  it('RED: no fee delta to the facilitator fee wallet → 422 fee_credit_missing', async () => {
    h.chain.solana = solTx({ feeAmount: '0' });
    expect((await post(h, SOL_BODY).expect(422)).body.reason).toBe('fee_credit_missing');
  });
  it('not finalized yet → 202 pending', async () => {
    h.chain.solana = null;
    expect((await post(h, SOL_BODY).expect(202)).body.reason).toBe('solana_transaction_not_finalized');
  });
});

describe('GET /v1/x402/sellers', () => {
  let db: FakeFirestore;
  let app: Express;
  let allowed = true;
  const seller = (chain: 'base' | 'solana', address: string, over: Record<string, unknown> = {}) => ({
    seller_id: `${chain}:${address}`, chain,
    network: chain === 'base' ? 'eip155:8453' : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    address, display_name: `Seller ${address.slice(0, 6)}`, description: 'paid data',
    resource_urls: ['https://api.example.com/data', 'http://insecure.example.com/x'],
    require_presentation: null, pvt_prices: [], status: 'active',
    registered_at_ms: 1, updated_at_ms: 2, settlement_count: 3,
    strike_count: 9, signature: '0xdeadbeef', nonce: 'n-123456',
    ...over,
  });
  const put = (doc: Record<string, unknown>) => db.store.set(`x402_sellers_v1/${doc.seller_id as string}`, doc);
  const S1 = '0x1000000000000000000000000000000000000001';
  const S2 = '0x2000000000000000000000000000000000000002';
  const S3 = '0x3000000000000000000000000000000000000003';
  const SOL = 'D'.repeat(44);

  beforeEach(() => {
    db = createFakeFirestore();
    allowed = true;
    app = express();
    app.use('/v1/x402', createX402SellersRouter({
      db: db as unknown as Firestore,
      cache: { checkRateLimit: async () => ({ allowed, retryAfter: 30 }) } as never,
    }));
    put(seller('base', S1, { pvt_prices: [{ resource: '/data', amount_atomic: '1000000000000000000' }] }));
    put(seller('base', S2, { status: 'suspended' }));
    put(seller('base', S3, { require_presentation: { tier: 'reputation', predicates: [{ field: 'standing', op: 'gte', threshold: 2 }] } }));
    put(seller('solana', SOL));
  });

  it('lists ACTIVE sellers only, with public fields only', async () => {
    const res = await request(app).get('/v1/x402/sellers').expect(200);
    expect(res.body.sellers.map((s: { seller_id: string }) => s.seller_id)).toEqual([`base:${S1}`, `base:${S3}`, `solana:${SOL}`]);
    for (const s of res.body.sellers) {
      expect(s).not.toHaveProperty('strike_count');
      expect(s).not.toHaveProperty('signature');
      expect(s).not.toHaveProperty('nonce');
      expect(s.resource_urls).toEqual(['https://api.example.com/data']);
    }
    expect(res.body.sellers[0].pvt_prices).toEqual([{ resource: '/data', amount_atomic: '1000000000000000000' }]);
    expect(res.body.next_cursor).toBeNull();
  });
  it('RED: a suspended seller is never shown, even by its own cursor neighbourhood', async () => {
    const res = await request(app).get('/v1/x402/sellers').query({ chain: 'base' }).expect(200);
    expect(res.body.sellers.map((s: { address: string }) => s.address)).toEqual([S1, S3]);
  });
  it('a seller whose stored id does not match its chain/address is not shown', async () => {
    db.store.set('x402_sellers_v1/base:0x4000000000000000000000000000000000000004', seller('base', S1));
    const res = await request(app).get('/v1/x402/sellers').query({ chain: 'base' }).expect(200);
    expect(res.body.count).toBe(2);
  });
  it('pages by cursor with a limit', async () => {
    const first = await request(app).get('/v1/x402/sellers').query({ limit: '1' }).expect(200);
    expect(first.body.sellers).toHaveLength(1);
    expect(first.body.next_cursor).toBe(`base:${S1}`);
    const second = await request(app).get('/v1/x402/sellers').query({ limit: '1', cursor: first.body.next_cursor }).expect(200);
    // The suspended S2 is skipped by the query; the next active seller is S3.
    expect(second.body.sellers.map((s: { seller_id: string }) => s.seller_id)).toEqual([`base:${S3}`]);
  });
  it('RED: bad chain / limit / cursor → 400; rate limited → 429', async () => {
    await request(app).get('/v1/x402/sellers').query({ chain: 'eth' }).expect(400);
    await request(app).get('/v1/x402/sellers').query({ limit: '101' }).expect(400);
    await request(app).get('/v1/x402/sellers').query({ limit: '0' }).expect(400);
    await request(app).get('/v1/x402/sellers').query({ cursor: 'a/b' }).expect(400);
    allowed = false;
    await request(app).get('/v1/x402/sellers').expect(429);
  });
});
