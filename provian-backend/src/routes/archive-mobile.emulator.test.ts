/**
 * PE Archive human path — the person's routes against the Firestore EMULATOR, with a
 * fake chain. Skipped unless FIRESTORE_EMULATOR_HOST is set.
 *
 * the operator’s first purchase died because his wallet held $0.945 USDC: the relay refused the signed
 * payment (402 payment_insufficient_funds) before recording anything, and the app had let him reach
 * Face ID first. The quote now carries the payer's balance and whether gas is covered, so the app
 * can stop before Face ID. Proves: the quote says insufficient for $0.945 and sufficient for $5;
 * a value the chain cannot give is null (never a guess); the quote charges nothing; the purchases
 * list returns only the caller's payments, newest first, with the transaction.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { UsdcChargeChain } from '../core/payments/usdc-charge';
import { createMemoryArchiveObjectStore } from '../core/archive/archive-objects';
import type { ArchiveDeps, ArchiveSettlement } from '../core/archive/archive-service';
import type { CdpFacilitator, CdpSettlementListing } from '../core/payments/cdp-facilitator';
import { archiveAgentListing } from '../core/archive/archive-terms';
import { signedPaymentHeader } from '../core/payout/payout-test-fixtures';
import { Wallet } from 'ethers';
import { createArchiveRouter } from './archive';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const suite = EMULATOR ? describe : describe.skip;
const RUN = `m${Date.now().toString(36)}`;

let db: FirebaseFirestore.Firestore;

interface AppOptions {
  readonly settlement?: ArchiveSettlement;
  readonly agentWallet?: Record<string, unknown>;
}

function appWith(balance: () => Promise<bigint>, userId: string, opts: AppOptions = {}) {
  const submitted: unknown[] = [];
  const chain: UsdcChargeChain = {
    gasAddress: '0x' + '35'.repeat(20),
    authorizationUsed: async () => false,
    usdcBalance: async () => balance(),
    gasBalanceWei: async () => 10n ** 17n,
    gasPriceWei: async () => 6_000_000n,
    l1FeeUpperBoundWei: async () => 1_000_000_000n,
    submitCharge: async (p) => { submitted.push(p); return '0x' + '01'.padStart(64, '0'); },
    confirmCharge: async () => 'confirmed',
    headBlock: async () => 1000,
    findCharge: async () => ({ txHash: null, windowClosed: false }),
  };
  const deps: ArchiveDeps = {
    db,
    objects: createMemoryArchiveObjectStore(),
    anchor: null,
    charge: { chain, ethUsd: async () => 4000, withGasKeyLease: async (fn) => fn(), now: () => Date.now(), sleep: async () => undefined },
    settlement: opts.settlement ?? { mode: () => 'relay_gas_key', cdp: null },
    now: () => Date.now(),
  };
  const app = express();
  app.use(express.json());
  app.use(createArchiveRouter({
    db,
    cache: {} as never,
    authenticateAgent: (req: Request, res: Response, next: NextFunction) => {
      if (opts.agentWallet === undefined) { res.status(401).end(); return; }
      Object.assign(req, { agentWallet: opts.agentWallet });
      next();
    },
    authenticateWallet: (req: Request, _res: Response, next: NextFunction) => { (req as Request & { user: unknown }).user = { id: userId, device_id: 'dev_phone' }; next(); },
    authenticateScheduler: async () => false,
    archiveDeps: () => deps,
    publicBaseUrl: 'https://api.provian.ai',
  }));
  return { app, submitted };
}

suite('PE Archive person routes (emulator)', () => {
  const userId = `user_${RUN}`;
  const walletDoc = `wallet_${RUN}`;
  const address = '0xe326648bdf12a802c8b811037c527ada833f5d77';

  beforeAll(async () => {
    const admin = await import('firebase-admin');
    if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-meter' });
    db = admin.firestore();
    // The shape the relay writes (`WalletDocument` in server.ts — pinned below), never a field name
    // of this test's own choosing: the first version of this test seeded `wallet_address`, the
    // preflight read the same wrong name, both passed, and the operator’s phone showed "Couldn't check".
    await db.collection('wallets').doc(walletDoc).set({ id: walletDoc, type: 'human', user_id: userId, address, public_key: address });
    await db.collection('wallets').doc(`${walletDoc}_legacy`).set({ id: `${walletDoc}_legacy`, type: 'human', user_id: `${userId}_legacy`, wallet_address: address });
  });

  it('the seeded field is the one the relay writes: server.ts WalletDocument declares `address: string`', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    const block = server.slice(server.indexOf('interface WalletDocument {'), server.indexOf('}', server.indexOf('interface WalletDocument {')));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/\n\s+address: string;/);
    expect(block).not.toMatch(/wallet_address/);
  });

  it('RED: a wallet document without `address` gives no payer address (the preflight reads the real field only)', async () => {
    const { app } = appWith(async () => 945_000n, `${userId}_legacy`);
    const res = await request(app).post('/v1/archive/mobile/pay').send({});
    expect(res.status).toBe(402);
    expect(res.body.payer).toEqual({ address: null, usdc_balance_atomic: null, sufficient: null });
  });

  it('the quote says INSUFFICIENT for $0.945 before any signature, and charges nothing', async () => {
    const { app, submitted } = appWith(async () => 945_000n, userId);
    const res = await request(app).post('/v1/archive/mobile/pay').send({});
    expect(res.status).toBe(402);
    expect(res.body.accepts?.[0]?.amount).toBe('5000000');
    expect(res.body.payer).toEqual({ address, usdc_balance_atomic: '945000', sufficient: false });
    expect(res.body.gas_covered).toBe(true);
    expect(submitted).toHaveLength(0);
  });

  it('GREEN beside it: $5.00 exactly is sufficient', async () => {
    const { app } = appWith(async () => 5_000_000n, userId);
    const res = await request(app).post('/v1/archive/mobile/pay').send({});
    expect(res.body.payer).toMatchObject({ usdc_balance_atomic: '5000000', sufficient: true });
  });

  it('a balance the chain cannot give is null, never a guess', async () => {
    const { app } = appWith(async () => { throw new Error('rpc down'); }, userId);
    const res = await request(app).post('/v1/archive/mobile/pay').send({});
    expect(res.status).toBe(402);
    expect(res.body.payer).toEqual({ address, usdc_balance_atomic: null, sufficient: null });
  });

  it("the purchases list holds only the caller's payments, newest first", async () => {
    const mk = (id: string, wallet: string, at: number, tx: string | null) => db.collection('archive_payments_v1').doc(id).set({
      schema: 'provian.pe-archive-payment.v1', request_id: id, wallet, owner_kind: 'human', actor_id: userId, requested_by: userId,
      payer: address, authorization_nonce: '0x' + '00'.repeat(32), fee_usdc_atomic: '5000000', state: tx ? 'charged' : 'charge_failed',
      credited: tx !== null, credited_bytes: tx ? 1e9 : 0, created_at_ms: at, updated_at_ms: at, charge_tx_hash: tx, charged_at_ms: tx ? at : null,
      last_error: tx ? null : 'transfer_reverted', payment: {},
    });
    await mk(`ap_${RUN}a`.padEnd(43, '0'), walletDoc, 1000, '0x' + 'aa'.repeat(32));
    await mk(`ap_${RUN}b`.padEnd(43, '0'), walletDoc, 2000, null);
    await mk(`ap_${RUN}c`.padEnd(43, '0'), `${walletDoc}_other`, 3000, '0x' + 'cc'.repeat(32));
    const { app } = appWith(async () => 0n, userId);
    const res = await request(app).get('/v1/archive/mobile/payments');
    expect(res.status).toBe(200);
    expect(res.body.payments.map((p: { created_at_ms: number }) => p.created_at_ms)).toEqual([2000, 1000]);
    expect(res.body.payments[0]).toMatchObject({ state: 'charge_failed', last_error: 'transfer_reverted', charge_tx_hash: null });
    expect(res.body.payments[1]).toMatchObject({ state: 'charged', credited: true, charge_tx_hash: '0x' + 'aa'.repeat(32) });
  });

  describe('the CDP listing each route sends ', () => {
    const tx = '0x' + 'cd'.repeat(32);
    function cdpSpy() {
      const calls: { listing: CdpSettlementListing }[] = [];
      const cdp: CdpFacilitator = { settle: async (_p, _r, listing) => { calls.push({ listing }); return tx; } };
      return { cdp, calls };
    }
    const viaCdp = (cdp: CdpFacilitator | null): ArchiveSettlement => ({ mode: () => 'cdp_facilitator', cdp });
    const agent = { id: `agentw_${RUN}`, agent_id: `agent_${RUN}`, status: 'active' };

    it('a quote with CDP the settler but its key absent says gas is NOT covered (nothing can be charged now)', async () => {
      const { app } = appWith(async () => 10_000_000n, userId, { settlement: viaCdp(null) });
      const res = await request(app).post('/v1/archive/mobile/pay').send({});
      expect(res.status).toBe(402);
      expect(res.body.gas_covered).toBe(false);
    });

    it('GREEN beside it: a configured CDP covers the gas', async () => {
      const { cdp } = cdpSpy();
      const { app } = appWith(async () => 10_000_000n, userId, { settlement: viaCdp(cdp) });
      const res = await request(app).post('/v1/archive/mobile/pay').send({});
      expect(res.body.gas_covered).toBe(true);
    });

    it("the agent route's 402 carries the Bazaar extension; the person's does not", async () => {
      const { app } = appWith(async () => 0n, userId, { agentWallet: agent });
      const a = await request(app).post('/v1/archive/pay').send({});
      expect(a.status).toBe(402);
      expect(a.body.extensions).toHaveProperty('bazaar');
      const m = await request(app).post('/v1/archive/mobile/pay').send({});
      expect(m.status).toBe(402);
      expect(m.body.extensions).toBeUndefined();
    });

    it('the agent route settles with the public listing', async () => {
      const { cdp, calls } = cdpSpy();
      const { app, submitted } = appWith(async () => 10_000_000n, userId, { agentWallet: agent, settlement: viaCdp(cdp) });
      const header = await signedPaymentHeader(Wallet.createRandom(), Math.floor(Date.now() / 1000), { value: '5000000' });
      const res = await request(app).post('/v1/archive/pay').set('payment-signature', header).send({});
      expect(calls).toHaveLength(1);
      expect(calls[0].listing).toEqual(archiveAgentListing('https://api.provian.ai/v1/archive/pay'));
      expect(submitted).toHaveLength(0);
      expect(res.body.settled_via ?? res.body.payment?.settled_via).toBe('cdp_facilitator');
    });

    it("the person's route settles with no listing extension, at its own URL", async () => {
      const { cdp, calls } = cdpSpy();
      const { app } = appWith(async () => 10_000_000n, userId, { settlement: viaCdp(cdp) });
      const header = await signedPaymentHeader(Wallet.createRandom(), Math.floor(Date.now() / 1000), { value: '5000000' });
      await request(app).post('/v1/archive/mobile/pay').send({ payment: header });
      expect(calls).toHaveLength(1);
      expect(calls[0].listing.extensions).toBeUndefined();
      expect(calls[0].listing.resource.url).toBe('https://api.provian.ai/v1/archive/mobile/pay');
    });

  });
});
