/**
 * POST /v1/agent/wallet/:wallet_id/swap — the agent route's 25 bps fee gates.
 *
 * The agent 0x route builds the quote with swapFeeRecipient/Bps/Token itself (agent-supplied fee
 * fields are never read), pins SWAP_FEE_RECIPIENT to the Provian treasury, and refuses a 0x answer
 * that does not carry the fee to the treasury (verifyZeroXQuoteFee). The 0x answer is a REAL quote
 * captured 2026-09-25 for this exact request shape (Base, 10 USDC → WETH, fee in WETH).
 *
 * RED controls: delete either gate in routes/agent-wallet.ts and the corresponding test below goes red
 * a fee-less or wrongly-paying 0x answer would be returned, or a non-treasury recipient would be
 * sent to 0x.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps } from '../core/agent-wallet/types';

const TREASURY = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';
const WETH = '0x4200000000000000000000000000000000000006';
const QUOTE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../core/swap/__fixtures__/zerox-quote-usdc-to-weth-with-fee.json'), 'utf8'),
);

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() {
        const d = col(name).get(id);
        return { exists: d !== undefined, id, data: () => d };
      },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore, allowRate = true): RouterDeps {
  return {
    db,
    cache: {
      checkRateLimit: async () => ({ allowed: allowRate, retryAfter: allowRate ? 0 : 30 }),
      checkRateLimitStrict: async () => ({ allowed: true, current: 0, limit: 10 }),
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    } as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

function seedWallet(col: (n: string) => Map<string, Doc>, id: string): string {
  const creds = generateApiCredentials();
  col('agent_wallets').set(id, {
    id, agent_id: `agent_${id}`, address: `0x${id}`,
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
    status: 'active',
  });
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: id });
  return `Bearer ${creds.api_key}:${creds.api_secret}`;
}

function buildApp(allowRate = true) {
  const { db, col } = makeFirestore();
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(makeDeps(db, allowRate)));
  return { app, col };
}

const BODY = { fromToken: 'USDC', toToken: 'WETH', amount: '10000000' };

describe('POST /:wallet_id/swap — the 25 bps fee gates', () => {
  const savedEnv = { ...process.env };
  let calls: string[];
  const stubFetch = (body: unknown, status = 200) => {
    calls = [];
    // A real Response (headers + streamable body): the route reads 0x through the
    // bounded fetch, which stream-reads the body under its byte cap.
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
  };
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.ZEROX_API_KEY = 'zx-test';
    process.env.SWAP_FEE_RECIPIENT = TREASURY;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    global.fetch = realFetch;
  });

  it('builds the 0x request with 25 bps in the buy token to the treasury, ignoring agent-sent fee fields, and returns the verified quote', async () => {
    stubFetch(QUOTE);
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app)
      .post('/v1/agent/wallet/wallet_A/swap')
      .set('Authorization', bearer)
      .send({ ...BODY, swapFeeBps: '0', swapFeeRecipient: '0x1111111111111111111111111111111111111111' });
    expect(res.status).toBe(200);
    const sent = new URL(calls[0]);
    expect(sent.origin + sent.pathname).toBe('https://api.0x.org/swap/allowance-holder/quote');
    expect(sent.searchParams.getAll('swapFeeRecipient')).toEqual([TREASURY]);
    expect(sent.searchParams.getAll('swapFeeBps')).toEqual(['25']);
    expect(sent.searchParams.getAll('swapFeeToken')).toEqual([WETH]);
    expect(res.body.affiliate_fee).toBe(QUOTE.fees.integratorFee.amount);
    expect(res.body.unsigned_tx.data).toBe(QUOTE.transaction.data);
  });

  it('RED : an oversized streamed 0x answer is cut off at the cap and refused 502 — never buffered whole', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.byteLength;
          if (pulled > 64 * 1024 * 1024) controller.close();
          else controller.enqueue(chunk);
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app).post('/v1/agent/wallet/wallet_A/swap').set('Authorization', bearer).send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_RESPONSE_TOO_LARGE');
    expect(res.body.unsigned_tx).toBeUndefined();
    expect(pulled).toBeLessThan(16 * 1024 * 1024);
  });

  it('RED: a 0x answer without the Provian fee is refused — no unsigned_tx', async () => {
    stubFetch({ ...QUOTE, fees: { ...QUOTE.fees, integratorFee: null, integratorFees: null } });
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app).post('/v1/agent/wallet/wallet_A/swap').set('Authorization', bearer).send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('swap_fee_missing');
    expect(res.body.unsigned_tx).toBeUndefined();
  });

  it('RED: a 0x answer whose calldata pays someone other than the treasury is refused', async () => {
    const t = TREASURY.toLowerCase().slice(2);
    const data = String(QUOTE.transaction.data).toLowerCase();
    expect(data).toContain(t);
    stubFetch({ ...QUOTE, transaction: { ...QUOTE.transaction, data: data.split(t).join('11'.repeat(20)) } });
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app).post('/v1/agent/wallet/wallet_A/swap').set('Authorization', bearer).send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('swap_fee_wrong_recipient');
    expect(res.body.unsigned_tx).toBeUndefined();
  });

  it('RED: a 0x fee at the wrong rate is refused', async () => {
    const half = (BigInt(QUOTE.fees.integratorFee.amount) / 2n).toString();
    stubFetch({ ...QUOTE, fees: { ...QUOTE.fees, integratorFee: { ...QUOTE.fees.integratorFee, amount: half }, integratorFees: [{ ...QUOTE.fees.integratorFee, amount: half }] } });
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app).post('/v1/agent/wallet/wallet_A/swap').set('Authorization', bearer).send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('swap_fee_wrong_rate');
  });

  it('RED: a SWAP_FEE_RECIPIENT that is not the treasury (and not the exposed EOA) is refused before any 0x call', async () => {
    process.env.SWAP_FEE_RECIPIENT = '0x2222222222222222222222222222222222222222';
    stubFetch(QUOTE);
    const { app, col } = buildApp();
    const bearer = seedWallet(col, 'wallet_A');
    const res = await request(app).post('/v1/agent/wallet/wallet_A/swap').set('Authorization', bearer).send(BODY);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SWAP_FEE_RECIPIENT_NOT_TREASURY');
    expect(calls).toHaveLength(0);
  });
});
