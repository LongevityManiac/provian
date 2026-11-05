/**
 * swap-proxy routes — a request built WITHOUT a fee (or with a zero / foreign fee) still leaves the
 * relay fee-bearing on every route, and an upstream answer that is not fee-bearing never reaches
 * the client. The upstream is a stub that records exactly what the relay sent and replays the real
 * payloads captured 2026-09-25 (core/swap/__fixtures__).
 */
import fs from 'fs';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSwapProxyRouter } from './swap-proxy';
import {
  PROVIAN_SOLANA_TREASURY,
  PROVIAN_SOLANA_USDC_FEE_ACCOUNT,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
  LIFI_SOLANA_CHAIN_ID,
  decodeSolanaTransaction,
  encodeSolanaTransaction,
  addFeeAccountCreation,
  associatedTokenAddress,
  parseLookupTableAddresses,
  JUPITER_ROOM_MAX_ACCOUNTS,
  SOLANA_MAX_TX_BYTES,
  SOLANA_TOKEN_PROGRAM_ID,
} from '../core/swap/swap-fees';
import { resolveAccountKeys } from '../core/swap/solana-swap-costs';
import { ResponseTooLargeError } from '../core/net/bounded-fetch';

const fx = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../core/swap/__fixtures__', name), 'utf8'));

const TREASURY = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';
const ATTACKER = '0x1111111111111111111111111111111111111111';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USER_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function harness(opts: {
  env?: Record<string, string | undefined>;
  respond: (url: string, init?: Call['init']) => { status?: number; body: unknown };
}) {
  const calls: Call[] = [];
  const app = express();
  app.use(express.json());
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'user-1', device_id: 'dev-1' };
    next();
  };
  app.use(
    '/api/proxy',
    createSwapProxyRouter({
      authenticate,
      checkProxyRateLimit: async () => true,
      fetch: (async (url: string, init?: Call['init']) => {
        calls.push({ url, init });
        const r = opts.respond(url, init);
        const status = r.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => r.body };
      }) as never,
      forwardUpstreamResponse: (res, up, body) => res.status(up.status).json({ upstream: body }),
      isUpstreamTimeout: () => false,
      env: {
        ZEROX_API_KEY: 'zx-test',
        LIFI_API_KEY: 'lifi-test',
        SWAP_FEE_RECIPIENT: TREASURY,
        ...opts.env,
      },
    }),
  );
  return { app, calls };
}

/**
 * A Solana RPC stub answering each method the way mainnet does, from real captures where it
 * matters: mint accounts (jsonParsed), lookup tables, rent (5080 lamports per byte incl. the 128-byte
 * header — mainnet's schedule on 2026-09-25: 0 → 650,240, 165 → 1,488,440, 187 → 1,600,200).
 */
type Chain = {
  mints?: Record<string, { program: string; extensions?: string[]; frozen?: boolean }>;
  accounts?: Record<string, unknown>; // getAccountInfo / getMultipleAccounts(jsonParsed) value per key
  tables?: Record<string, { owner: string; data: string }>; // lookup-table accounts
  balances?: Record<string, number>;
  simulate?: (tx: string, call: number) => unknown; // value, or undefined → RPC error
  rpcDown?: boolean;
};
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
const rentFor = (size: number) => (128 + size) * 5080;
const sims: string[] = [];
function isRpc(url: string) {
  return url.includes('solana') || url.includes('alchemy');
}
function rpcAnswer(c: Chain, init?: Call['init']): { status?: number; body: unknown } {
  if (c.rpcDown) return { status: 503, body: { error: 'down' } };
  const { method, params } = JSON.parse(init!.body!);
  const ok = (result: unknown) => ({ body: { jsonrpc: '2.0', id: 1, result } });
  const mintValue = (m: string) => {
    const x = c.mints?.[m] ?? { program: TOKEN };
    const extensions = (x.extensions ?? []).map((e) => ({ extension: e, ...(e === 'defaultAccountState' ? { state: { accountState: x.frozen ? 'frozen' : 'initialized' } } : {}) }));
    return { owner: x.program, lamports: 1, space: 82, data: { parsed: { info: { decimals: 6, extensions } } } };
  };
  switch (method) {
    case 'getMultipleAccounts': {
      const keys = params[0] as string[];
      if (params[1].encoding === 'base64') {
        const t = c.tables ?? {};
        return ok({ value: keys.map((k) => (t[k] ? { owner: t[k].owner, data: [t[k].data, 'base64'] } : null)) });
      }
      return ok({ value: keys.map((k) => (k in (c.accounts ?? {}) ? c.accounts![k] : (c.mints?.[k] || KNOWN_MINTS.has(k)) ? mintValue(k) : null)) });
    }
    case 'getAccountInfo':
      return ok({ value: c.accounts?.[params[0]] ?? null });
    case 'getBalance':
      return ok({ value: c.balances?.[params[0]] ?? 5_000_000_000 });
    case 'getMinimumBalanceForRentExemption':
      return ok(rentFor(params[0]));
    case 'simulateTransaction': {
      sims.push(params[0]);
      const v = c.simulate?.(params[0], sims.length);
      return v === undefined ? { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'stub' } } } : ok({ value: v });
    }
    default:
      throw new Error(`unexpected RPC ${method}`);
  }
}
beforeEach(() => {
  sims.length = 0;
});
const KNOWN_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
]);

describe('0x proxy', () => {
  const clientQuery = {
    chainId: '8453',
    sellToken: ETH,
    buyToken: USDC_BASE,
    sellAmount: '10000000000000000',
    taker: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    slippageBps: '50',
  };

  it('a request with no fee reaches 0x fee-bearing and the verified quote is returned', async () => {
    const { app, calls } = harness({ respond: () => ({ body: fx('zerox-quote-with-fee.json') }) });
    const res = await request(app).get('/api/proxy/zerox/allowance-holder/quote').query(clientQuery);
    expect(res.status).toBe(200);
    const sent = new URL(calls[0].url);
    expect(sent.origin + sent.pathname).toBe('https://api.0x.org/swap/allowance-holder/quote');
    expect(sent.searchParams.get('swapFeeRecipient')).toBe(TREASURY);
    expect(sent.searchParams.get('swapFeeBps')).toBe('25');
    expect(sent.searchParams.get('swapFeeToken')).toBe(USDC_BASE);
    expect(res.body.provian_fee).toEqual({ bps: 25, amount: '67895', token: USDC_BASE.toLowerCase() });
  });

  it('a request carrying swapFeeBps=0 and a foreign recipient still goes out at 25 bps to the treasury', async () => {
    const { app, calls } = harness({ respond: () => ({ body: fx('zerox-quote-with-fee.json') }) });
    await request(app)
      .get('/api/proxy/zerox/allowance-holder/quote')
      .query({ ...clientQuery, swapFeeBps: '0', swapFeeRecipient: ATTACKER });
    const sent = new URL(calls[0].url);
    expect(sent.searchParams.getAll('swapFeeBps')).toEqual(['25']);
    expect(sent.searchParams.getAll('swapFeeRecipient')).toEqual([TREASURY]);
  });

  it('RED: an upstream quote without the fee is refused, not forwarded', async () => {
    const q = fx('zerox-quote-with-fee.json');
    const { app } = harness({ respond: () => ({ body: { ...q, fees: { ...q.fees, integratorFee: null, integratorFees: null } } }) });
    const res = await request(app).get('/api/proxy/zerox/allowance-holder/quote').query(clientQuery);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('swap_fee_missing');
    expect(res.body.transaction).toBeUndefined();
  });

  it('RED: a relay configured with a non-treasury recipient refuses before calling 0x', async () => {
    const { app, calls } = harness({ env: { SWAP_FEE_RECIPIENT: ATTACKER }, respond: () => ({ body: {} }) });
    const res = await request(app).get('/api/proxy/zerox/allowance-holder/quote').query(clientQuery);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('swap_fee_recipient_not_treasury');
    expect(calls).toHaveLength(0);
  });

  // production deps.fetch is the bounded read (core/net/bounded-fetch.ts); an upstream
  // answer past its byte cap surfaces as ResponseTooLargeError and must map to a 502, not a 500.
  it('an upstream answer over the bounded-read cap is 502 UPSTREAM_RESPONSE_TOO_LARGE', async () => {
    const { app } = harness({ respond: () => { throw new ResponseTooLargeError(5 * 1024 * 1024); } });
    const res = await request(app).get('/api/proxy/zerox/allowance-holder/quote').query(clientQuery);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_RESPONSE_TOO_LARGE');
  });

  it('every other 0x path (the old fee-free pass-through) is refused', async () => {
    const { app, calls } = harness({ respond: () => ({ body: {} }) });
    for (const p of ['/api/proxy/zerox/allowance-holder/price', '/api/proxy/zerox/permit2/quote', '/api/proxy/zerox/anything']) {
      const res = await request(app).get(p).query(clientQuery);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ZEROX_PATH_REFUSED');
    }
    const post = await request(app).post('/api/proxy/zerox/allowance-holder/quote').send({});
    expect(post.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('LI.FI proxy', () => {
  const clientQuery = {
    fromChain: '8453',
    toChain: String(LIFI_SOLANA_CHAIN_ID),
    fromToken: USDC_BASE,
    toToken: SOLANA_USDC_MINT,
    fromAmount: '20000000',
    fromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    toAddress: USER_SOL,
    slippage: '0.005',
  };

  it('a request with no fee reaches LI.FI with integrator=provian fee=0.0025 and the API key', async () => {
    const { app, calls } = harness({ respond: () => ({ body: fx('lifi-quote-base-usdc-to-solana.json') }) });
    const res = await request(app).get('/api/proxy/lifi/quote').query(clientQuery);
    expect(res.status).toBe(200);
    const sent = new URL(calls[0].url);
    expect(sent.origin + sent.pathname).toBe('https://li.quest/v1/quote');
    expect(sent.searchParams.get('integrator')).toBe('provian');
    expect(sent.searchParams.get('fee')).toBe('0.0025');
    expect(calls[0].init?.headers?.['x-lifi-api-key']).toBe('lifi-test');
    expect(res.body.provian_fee).toMatchObject({ bps: 25, amount: '50000', token: USDC_BASE });
    expect(res.body.lifi_fee).toMatchObject({ amount: '50000' });
  });

  it('a request carrying integrator=evil&fee=0 still goes out as provian at 0.0025', async () => {
    const { app, calls } = harness({ respond: () => ({ body: fx('lifi-quote-base-usdc-to-solana.json') }) });
    await request(app).get('/api/proxy/lifi/quote').query({ ...clientQuery, integrator: 'evil', fee: '0' });
    const sent = new URL(calls[0].url);
    expect(sent.searchParams.getAll('integrator')).toEqual(['provian']);
    expect(sent.searchParams.getAll('fee')).toEqual(['0.0025']);
  });

  it('a Solana-source quote is verified against the decoded transaction and carries its SOL costs', async () => {
    const existing = { owner: TOKEN, lamports: 2_039_280, space: 165, data: { parsed: { info: { state: 'initialized' } } } };
    const { app } = harness({
      respond: (url, init) => (isRpc(url)
        ? rpcAnswer({ accounts: new Proxy({}, { has: () => true, get: () => existing }) as Record<string, unknown> }, init)
        : { body: fx('lifi-quote-solana-usdc-to-base.json') }),
    });
    const res = await request(app)
      .get('/api/proxy/lifi/quote')
      .query({ ...clientQuery, fromChain: String(LIFI_SOLANA_CHAIN_ID), toChain: '8453', fromToken: SOLANA_USDC_MINT, toToken: USDC_BASE, fromAddress: USER_SOL, toAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' });
    expect(res.status).toBe(200);
    expect(res.body.provian_fee.amount).toBe('50000');
    // Every account the transaction would open already exists: only the network fee is due.
    expect(res.body.solana_costs).toMatchObject({ sol_swapped_lamports: '0', treasury_fee_account_lamports: '0', other_accounts_lamports: '0', measured: false });
    expect(res.body.solana_costs.spend_lamports).toBe(res.body.solana_costs.network_fee_lamports);
  });

  describe('native SOL source, 0.1 SOL (LI.FI raises the treasury transfer to the rent-exempt minimum)', () => {
    const quote = fx('lifi-quote-solana-sol-to-base-small.json');
    const sim = fx('sim-lifi-sol-to-base.json');
    const query = { ...clientQuery, fromChain: String(LIFI_SOLANA_CHAIN_ID), toChain: '8453', fromToken: SYSTEM, toToken: USDC_BASE, fromAmount: '100000000', fromAddress: USER_SOL, toAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' };
    const chain = (c: Chain) => (url: string, init?: Call['init']) => (isRpc(url) ? rpcAnswer({ tables: sim.alts, ...c }, init) : { body: quote });

    it('empty treasury: accepted; the 400,240 excess is shown as the treasury deposit, the bridge\'s accounts as other', async () => {
      const { app } = harness({
        respond: chain({
          balances: { [PROVIAN_SOLANA_TREASURY]: 0, [USER_SOL]: sim.preLamports },
          simulate: (_tx, n) => (n === 1 ? sim.simulation : undefined),
        }),
      });
      const res = await request(app).get('/api/proxy/lifi/quote').query(query);
      expect(res.status).toBe(200);
      expect(res.body.provian_fee.amount).toBe('250000');
      expect(res.body.solana_costs).toMatchObject({
        treasury_fee_account_lamports: '400240',
        other_accounts_lamports: '3220720',
        sol_swapped_lamports: '100000000',
        measured: true,
      });
    });

    it('RED: a funded treasury gets exactly the fee — the raised transfer is refused', async () => {
      const { app } = harness({ respond: chain({ balances: { [PROVIAN_SOLANA_TREASURY]: 650240 } }) });
      const res = await request(app).get('/api/proxy/lifi/quote').query(query);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('swap_fee_wrong_recipient');
    });

    it('RED: a Solana transaction not paid by the sender is refused', async () => {
      const { app } = harness({ respond: chain({ balances: { [PROVIAN_SOLANA_TREASURY]: 0 } }) });
      const res = await request(app).get('/api/proxy/lifi/quote').query({ ...query, fromAddress: PROVIAN_SOLANA_TREASURY });
      expect(res.body.code).toBe('lifi_tx_wrong_payer');
    });
  });

  it('RED: same-chain is refused before any upstream call; a fee-less upstream answer is refused', async () => {
    const { app, calls } = harness({ respond: () => ({ body: fx('lifi-quote-base-usdc-to-solana.json') }) });
    const same = await request(app).get('/api/proxy/lifi/quote').query({ ...clientQuery, toChain: '8453' });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('same_chain_not_lifi');
    expect(calls).toHaveLength(0);

    const q = fx('lifi-quote-base-usdc-to-solana.json');
    q.estimate.feeCosts[0].feeSplit = { lifiFee: '50000', integratorFee: '0', recipients: [{ name: 'lifi', fee: '50000' }] };
    const { app: app2 } = harness({ respond: () => ({ body: q }) });
    const res = await request(app2).get('/api/proxy/lifi/quote').query(clientQuery);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('swap_fee_missing');
  });

  it('RED: no LIFI_API_KEY → 503, no upstream call', async () => {
    const { app, calls } = harness({ env: { LIFI_API_KEY: undefined }, respond: () => ({ body: {} }) });
    const res = await request(app).get('/api/proxy/lifi/quote').query(clientQuery);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('Jupiter proxy', () => {
  const order = { inputMint: SOLANA_WSOL_MINT, outputMint: SOLANA_USDC_MINT, amount: '100000000', slippageBps: 50, userPublicKey: USER_SOL };
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
  const USDG = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
  const PY_HOLDER = 'fr6yQkDmWy6R6pecbUsxXaw6EvRJznZ2HsK5frQgud8';
  const TREASURY_WSOL = 'Fs42KbAkah3agwXi57LTEeNL1FncDZg3JEce4yJ9eAjd';
  const TREASURY_BONK = '7L2gemgzqeMTYvkVFeBQD2m3iwmA3zzseAwjPB57W9ZF';
  const TREASURY_PYUSD = '7ajFcXZt2Zk5fpkNXdCYX5ykQJfhXd74rd7iHABySmG6';
  const SECOND_FUNDER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
  /** The real PYUSD / USDG mint extensions (jsonParsed, 2026-09-25). */
  const T22_EXT = ['mintCloseAuthority', 'permanentDelegate', 'transferFeeConfig', 'confidentialTransferMint', 'confidentialTransferFeeConfig', 'transferHook', 'metadataPointer', 'tokenMetadata'];
  const feeAccountInfo = (mint = SOLANA_USDC_MINT, owner = PROVIAN_SOLANA_TREASURY, state = 'initialized', program = TOKEN) =>
    ({ owner: program, lamports: 2_039_280, space: 165, data: { parsed: { info: { owner, mint, state } } } });
  const withAlts = (...names: string[]) => Object.assign({}, ...names.map((n) => fx(`jupiter-alts-${n}.json`)));

  type Upstream = { quote?: unknown; swap?: unknown };
  const respond = (c: Chain = {}, u: Upstream = {}) =>
    (url: string, init?: Call['init']) => {
      if (isRpc(url)) {
        return rpcAnswer({ accounts: { [PROVIAN_SOLANA_USDC_FEE_ACCOUNT]: feeAccountInfo() }, tables: withAlts('sol-to-usdc', 'usdc-to-sol', 'sol-to-bonk', 'bonk-to-jup', 'jup-to-sol', 'pyusd-to-usdg'), ...c }, init);
      }
      if (url.includes('/quote')) return { body: u.quote ?? fx('jupiter-quote-sol-to-usdc.json') };
      return { body: u.swap ?? fx('jupiter-swap-sol-to-usdc.json') };
    };
  const allTables = () => Object.fromEntries(
    Object.entries(withAlts('sol-to-usdc', 'usdc-to-sol', 'sol-to-bonk', 'bonk-to-jup', 'jup-to-sol', 'pyusd-to-usdg') as Record<string, { owner: string; data: string }>)
      .map(([k, v]) => [k, parseLookupTableAddresses(v.owner, v.data)]),
  );
  const firstIx = (b64: string) => {
    const tx = decodeSolanaTransaction(Buffer.from(b64, 'base64'));
    const keys = resolveAccountKeys(tx, allTables());
    const ix = tx.instructions[0];
    return { program: keys[ix.programIdIndex], accounts: ix.accounts.map((a) => keys[a]) };
  };

  it('an order with no fee is quoted at platformFeeBps=25 and swapped with the treasury fee account', async () => {
    const { app, calls } = harness({ respond: respond() });
    const res = await request(app).post('/api/proxy/jupiter/order').send(order);
    expect(res.status).toBe(200);
    const quoteCall = calls.find((c) => c.url.includes('/quote'))!;
    expect(new URL(quoteCall.url).searchParams.get('platformFeeBps')).toBe('25');
    expect(new URL(quoteCall.url).searchParams.has('instructionVersion')).toBe(false);
    const body = JSON.parse(calls.find((c) => c.url.endsWith('/swap'))!.init!.body!);
    expect(body.feeAccount).toBe(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
    expect(body.userPublicKey).toBe(USER_SOL);
    expect(res.body.provian_fee).toEqual({
      bps: 25,
      amount: fx('jupiter-quote-sol-to-usdc.json').platformFee.amount,
      mint: SOLANA_USDC_MINT,
      side: 'output',
      account: PROVIAN_SOLANA_USDC_FEE_ACCOUNT,
      token_program: TOKEN,
    });
    expect(res.body.swapTransaction).toBe(fx('jupiter-swap-sol-to-usdc.json').swapTransaction);
    expect(res.body.fee_account_created).toBeUndefined();
    expect(res.body.solana_costs).toMatchObject({ sol_swapped_lamports: '100000000', treasury_fee_account_lamports: '0' });
  });

  it('an order carrying platformFeeBps=0 and its own feeAccount is still built at 25 bps to the treasury', async () => {
    const { app, calls } = harness({ respond: respond() });
    await request(app).post('/api/proxy/jupiter/order').send({ ...order, platformFeeBps: 0, feeAccount: USER_SOL });
    expect(new URL(calls.find((c) => c.url.includes('/quote'))!.url).searchParams.get('platformFeeBps')).toBe('25');
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/swap'))!.init!.body!).feeAccount).toBe(PROVIAN_SOLANA_USDC_FEE_ACCOUNT);
  });

  it.each([
    ['SOL→BONK', SOLANA_WSOL_MINT, BONK, 'sol-to-bonk', SOLANA_WSOL_MINT, TREASURY_WSOL, 'input'],
    ['BONK→JUP', BONK, JUP, 'bonk-to-jup', BONK, TREASURY_BONK, 'input'],
    ['JUP→SOL', JUP, SOLANA_WSOL_MINT, 'jup-to-sol', SOLANA_WSOL_MINT, TREASURY_WSOL, 'output'],
  ])('%s with no USDC leg, zero fee requested: 25 bps into the treasury account for the fee mint, created in the same transaction',
    async (_l, inputMint, outputMint, name, feeMint, feeAccount, side) => {
      const quote = fx(`jupiter-quote-${name}.json`);
      const { app, calls } = harness({ respond: respond({}, { quote, swap: fx(`jupiter-swap-${name}.json`) }) });
      const res = await request(app).post('/api/proxy/jupiter/order')
        .send({ ...order, inputMint, outputMint, amount: quote.inAmount, platformFeeBps: 0, feeAccount: USER_SOL });
      expect(res.status).toBe(200);
      expect(new URL(calls.find((c) => c.url.includes('/quote'))!.url).searchParams.get('platformFeeBps')).toBe('25');
      expect(JSON.parse(calls.find((c) => c.url.endsWith('/swap'))!.init!.body!).feeAccount).toBe(feeAccount);
      expect(res.body.provian_fee).toMatchObject({ bps: 25, mint: feeMint, side, account: feeAccount, token_program: TOKEN });
      // The deposit is the chain's rent-exempt minimum for a 165-byte account (simulation stubbed off → top-level figures).
      expect(res.body.fee_account_created).toEqual({ account: feeAccount, rent_lamports: String(rentFor(165)) });
      expect(res.body.solana_costs).toMatchObject({ treasury_fee_account_lamports: String(rentFor(165)), measured: false });
      expect(firstIx(res.body.swapTransaction).program).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    });

  it('a Token-2022 pair (PYUSD→USDG), zero fee requested: V2 route, 25 bps into the treasury\'s Token-2022 PYUSD account', async () => {
    const quote = fx('jupiter-quote-pyusd-to-usdg.json');
    const t22 = { program: TOKEN_2022, extensions: T22_EXT };
    const { app, calls } = harness({
      respond: respond({ mints: { [PYUSD]: t22, [USDG]: t22 } }, { quote, swap: fx('jupiter-swap-pyusd-to-usdg.json') }),
    });
    const res = await request(app).post('/api/proxy/jupiter/order')
      .send({ ...order, inputMint: PYUSD, outputMint: USDG, amount: quote.inAmount, userPublicKey: PY_HOLDER, platformFeeBps: 0, feeAccount: PY_HOLDER });
    expect(res.status).toBe(200);
    const q = new URL(calls.find((c) => c.url.includes('/quote'))!.url).searchParams;
    expect(q.get('instructionVersion')).toBe('V2');
    expect(q.get('platformFeeBps')).toBe('25');
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/swap'))!.init!.body!).feeAccount).toBe(TREASURY_PYUSD);
    expect(res.body.provian_fee).toMatchObject({ amount: '25000', mint: PYUSD, side: 'input', account: TREASURY_PYUSD, token_program: TOKEN_2022 });
    // 187-byte Token-2022 account → 1,600,200 lamports on the mainnet schedule.
    expect(res.body.fee_account_created).toEqual({ account: TREASURY_PYUSD, rent_lamports: String(rentFor(187)) });
    expect(firstIx(res.body.swapTransaction)).toEqual({
      program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      accounts: [PY_HOLDER, TREASURY_PYUSD, PROVIAN_SOLANA_TREASURY, PYUSD, SYSTEM, TOKEN_2022],
    });
  });

  it('a fee mint whose new accounts start frozen is skipped for the next mint in the order', async () => {
    const quote = fx('jupiter-quote-pyusd-to-usdg.json');
    const { app, calls } = harness({
      respond: respond({
        mints: {
          [PYUSD]: { program: TOKEN_2022, extensions: [...T22_EXT, 'defaultAccountState'], frozen: true },
          [USDG]: { program: TOKEN_2022, extensions: T22_EXT },
        },
      }, { quote, swap: fx('jupiter-swap-pyusd-to-usdg.json') }),
    });
    await request(app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: PYUSD, outputMint: USDG, amount: quote.inAmount, userPublicKey: PY_HOLDER });
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/swap'))!.init!.body!).feeAccount;
    expect(sent).not.toBe(TREASURY_PYUSD);
    expect(sent).toBe(associatedTokenAddress(PROVIAN_SOLANA_TREASURY, USDG, TOKEN_2022));
  });

  it('an existing treasury account for a non-USDC fee mint is used as is (no creation step)', async () => {
    const quote = fx('jupiter-quote-bonk-to-jup.json');
    const { app } = harness({
      respond: respond({ accounts: { [TREASURY_BONK]: feeAccountInfo(BONK) } }, { quote, swap: fx('jupiter-swap-bonk-to-jup.json') }),
    });
    const res = await request(app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: BONK, outputMint: JUP, amount: quote.inAmount });
    expect(res.status).toBe(200);
    expect(res.body.fee_account_created).toBeUndefined();
    expect(res.body.swapTransaction).toBe(fx('jupiter-swap-bonk-to-jup.json').swapTransaction);
  });

  it('an address someone pre-funded with SOL (System-owned, no data) is still created in-tx; the deposit shown is net of it', async () => {
    const quote = fx('jupiter-quote-sol-to-bonk.json');
    const prefunded = { owner: SYSTEM, lamports: 650240, space: 0, data: ['', 'base64'] };
    const { app } = harness({ respond: respond({ accounts: { [TREASURY_WSOL]: prefunded } }, { quote, swap: fx('jupiter-swap-sol-to-bonk.json') }) });
    const res = await request(app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: SOLANA_WSOL_MINT, outputMint: BONK, amount: quote.inAmount });
    expect(res.status).toBe(200);
    expect(res.body.fee_account_created).toEqual({ account: TREASURY_WSOL, rent_lamports: String(rentFor(165) - 650240) });
    expect(firstIx(res.body.swapTransaction).program).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  });

  describe('no room for the fee-account create: a route with fewer accounts is asked for', () => {
    const quote = fx('jupiter-quote-sol-to-bonk.json');
    const body = { ...order, inputMint: SOLANA_WSOL_MINT, outputMint: BONK, amount: quote.inAmount };
    const normal = fx('jupiter-swap-sol-to-bonk.json');
    // The same Jupiter transaction padded (an extra no-account instruction) so that it still fits
    // 1232 bytes on its own but not once the relay prepends the treasury account's create.
    const padded = (() => {
      const tx = decodeSolanaTransaction(Buffer.from(normal.swapTransaction, 'base64'));
      const grown = addFeeAccountCreation(normal.swapTransaction, allTables(), {
        userPublicKey: USER_SOL, feeMint: SOLANA_WSOL_MINT, feeAccount: TREASURY_WSOL, tokenProgram: SOLANA_TOKEN_PROGRAM_ID,
      });
      const room = SOLANA_MAX_TX_BYTES - Buffer.from(grown, 'base64').length; // what the create leaves free
      const pad = (n: number) => encodeSolanaTransaction({
        ...tx, instructions: [...tx.instructions, { programIdIndex: tx.instructions.at(-1)!.programIdIndex, accounts: [], data: new Uint8Array(n) }],
      });
      let n = room;
      while (pad(n).length - encodeSolanaTransaction(tx).length < room + 1) n++;
      const out = pad(n);
      expect(out.length).toBeLessThanOrEqual(SOLANA_MAX_TX_BYTES); // valid on its own
      return { ...normal, swapTransaction: Buffer.from(out).toString('base64') };
    })();
    const sequenced = (swaps: unknown[]) => {
      let n = 0;
      const base = respond({}, { quote });
      return (url: string, init?: Call['init']) => (!isRpc(url) && !url.includes('/quote') ? { body: swaps[Math.min(n++, swaps.length - 1)] } : base(url, init));
    };

    it('first route too large → re-quoted at maxAccounts 40; the fitting route carries the create and the fee', async () => {
      const { app, calls } = harness({ respond: sequenced([padded, normal]) });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(res.status).toBe(200);
      const quotes = calls.filter((c) => c.url.includes('/quote')).map((c) => new URL(c.url).searchParams);
      expect(quotes.map((q) => q.get('maxAccounts'))).toEqual([null, String(JUPITER_ROOM_MAX_ACCOUNTS[0])]);
      expect(quotes.every((q) => q.get('platformFeeBps') === '25')).toBe(true);
      expect(firstIx(res.body.swapTransaction).program).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      expect(res.body.fee_account_created.account).toBe(TREASURY_WSOL);
    });

    it('RED: when no route leaves room, the order is refused (never sent without the fee account)', async () => {
      const { app, calls } = harness({ respond: sequenced([padded]) });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(res.status).toBe(503);
      expect(res.body.code ?? res.body.error).toMatch(/jupiter_tx_too_large|no room/);
      expect(calls.filter((c) => c.url.includes('/quote'))).toHaveLength(1 + JUPITER_ROOM_MAX_ACCOUNTS.length);
    });

    it('an existing fee account never re-quotes (one route, no maxAccounts)', async () => {
      const { app, calls } = harness({
        respond: (url, init) => respond({ accounts: { [TREASURY_WSOL]: feeAccountInfo(SOLANA_WSOL_MINT) } }, { quote, swap: normal })(url, init),
      });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(res.status).toBe(200);
      const quotes = calls.filter((c) => c.url.includes('/quote'));
      expect(quotes).toHaveLength(1);
      expect(new URL(quotes[0].url).searchParams.get('maxAccounts')).toBeNull();
    });
  });

  describe('SOL costs from simulating the user\'s transaction', () => {
    const quote = fx('jupiter-quote-sol-to-bonk.json');
    const body = { ...order, inputMint: SOLANA_WSOL_MINT, outputMint: BONK, amount: quote.inAmount };
    const up = { quote, swap: fx('jupiter-swap-sol-to-bonk.json') };
    // The treasury's wSOL account the relay's create opens (an inner createAccount of that create).
    const treasuryCreate = { program: 'system', parsed: { type: 'createAccount', info: { source: USER_SOL, newAccount: TREASURY_WSOL, lamports: rentFor(165), space: 165, owner: TOKEN } } };
    const simOk = (post: number) => ({ err: null, accounts: [{ lamports: post }], innerInstructions: [{ index: 0, instructions: [treasuryCreate] }] });

    it('the user\'s own transaction first: measured, and anything beyond the named costs is shown as other', async () => {
      const balance = 5_000_000_000;
      let named = 0;
      // First learn the named total (top-level figures), then simulate a wallet change 777 above it.
      const probe = harness({ respond: respond({ balances: { [USER_SOL]: balance } }, up) });
      const r0 = await request(probe.app).post('/api/proxy/jupiter/order').send(body);
      named = Number(r0.body.solana_costs.spend_lamports);
      sims.length = 0;
      const { app: app2 } = harness({ respond: respond({ balances: { [USER_SOL]: balance }, simulate: () => simOk(balance - named - 777) }, up) });
      const res = await request(app2).post('/api/proxy/jupiter/order').send(body);
      expect(res.body.solana_costs).toMatchObject({ measured: true, other_accounts_lamports: '777', spend_lamports: String(named + 777) });
      expect(sims).toHaveLength(1);
      expect(decodeSolanaTransaction(Buffer.from(sims[0], 'base64')).staticKeys[0]).toBe(USER_SOL); // the user's own tx
    });

    it('a wallet that cannot yet afford it: the funded copy (another funder, since the user is the default one) measures it', async () => {
      const { app } = harness({
        respond: respond({
          balances: { [USER_SOL]: 0 },
          simulate: (_tx, n) => (n === 1 ? undefined : simOk(10_000_000_000 + Number(quote.inAmount) - 5_000_000)),
        }, up),
      });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(sims).toHaveLength(2);
      const funded = decodeSolanaTransaction(Buffer.from(sims[1], 'base64'));
      expect(funded.staticKeys.slice(0, 2)).toEqual([SECOND_FUNDER, USER_SOL]);
      const c = res.body.solana_costs;
      expect(c.measured).toBe(true);
      expect(c.sufficient).toBe(false);
      expect(BigInt(c.shortfall_lamports)).toBe(BigInt(c.required_lamports)); // balance 0: needs all of it
    });

    it('funded copy, exact: the funder paid the fee in the copy, so the user\'s spend is their change plus the network fee', async () => {
      const probe = harness({ respond: respond({ balances: { [USER_SOL]: 0 } }, up) });
      const r0 = await request(probe.app).post('/api/proxy/jupiter/order').send(body);
      const named = BigInt(r0.body.solana_costs.spend_lamports);
      const fee = BigInt(r0.body.solana_costs.network_fee_lamports);
      sims.length = 0;
      const credit = 10_000_000_000n + BigInt(quote.inAmount);
      // In the copy the user is credited, then loses everything but the fee (which the funder paid), plus 555.
      const post = credit - (named - fee) - 555n;
      const { app } = harness({
        respond: respond({ balances: { [USER_SOL]: 0 }, simulate: (_tx, n) => (n === 1 ? undefined : simOk(Number(post))) }, up),
      });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(res.body.solana_costs).toMatchObject({
        measured: true, other_accounts_lamports: '555', spend_lamports: String(named + 555n), network_fee_lamports: String(fee),
      });
    });

    it('RED: when neither simulation runs, the top-level figures stand and say so', async () => {
      const { app } = harness({ respond: respond({ balances: { [USER_SOL]: 1000 } }, up) });
      const res = await request(app).post('/api/proxy/jupiter/order').send(body);
      expect(res.body.solana_costs).toMatchObject({ measured: false, sufficient: false, balance_lamports: '1000' });
      expect(BigInt(res.body.solana_costs.shortfall_lamports)).toBe(BigInt(res.body.solana_costs.required_lamports) - 1000n);
    });

    it('RED: a Token-2022 extension the relay cannot size refuses the order rather than state a wrong deposit', async () => {
      const q = fx('jupiter-quote-pyusd-to-usdg.json');
      const { app } = harness({
        respond: respond({ mints: { [PYUSD]: { program: TOKEN_2022, extensions: ['someFutureExtension'] }, [USDG]: { program: TOKEN_2022, extensions: T22_EXT } } },
          { quote: q, swap: fx('jupiter-swap-pyusd-to-usdg.json') }),
      });
      const res = await request(app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: PYUSD, outputMint: USDG, amount: q.inAmount, userPublicKey: PY_HOLDER });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('unsupported_mint');
    });
  });

  it('RED: a foreign or frozen fee account, or an unreadable chain, refuses before any Jupiter call', async () => {
    for (const [acct, code] of [
      [feeAccountInfo(SOLANA_USDC_MINT, USER_SOL), 'swap_fee_wrong_recipient'],
      [feeAccountInfo(SOLANA_WSOL_MINT), 'swap_fee_wrong_recipient'],
      [feeAccountInfo(SOLANA_USDC_MINT, PROVIAN_SOLANA_TREASURY, 'initialized', TOKEN_2022), 'swap_fee_wrong_recipient'],
      [{ owner: SYSTEM, lamports: 650240, space: 8, data: ['AAAAAAAAAAA=', 'base64'] }, 'swap_fee_wrong_recipient'],
      [feeAccountInfo(SOLANA_USDC_MINT, PROVIAN_SOLANA_TREASURY, 'frozen'), 'solana_fee_account_frozen'],
    ] as const) {
      const h = harness({ respond: respond({ accounts: { [PROVIAN_SOLANA_USDC_FEE_ACCOUNT]: acct } }) });
      const r = await request(h.app).post('/api/proxy/jupiter/order').send(order);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe(code);
      expect(h.calls.some((c) => c.url.includes('jup.ag'))).toBe(false);
    }
    const down = harness({ respond: respond({ rpcDown: true }) });
    const r = await request(down.app).post('/api/proxy/jupiter/order').send(order);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('solana_rpc_unavailable');
    expect(down.calls.some((c) => c.url.includes('jup.ag'))).toBe(false);
  });

  it('RED: a mint no SPL token program owns is refused before any Jupiter call', async () => {
    const h = harness({ respond: respond({ mints: { [JUP]: { program: SYSTEM } } }) });
    const r = await request(h.app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: BONK, outputMint: JUP });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('unsupported_mint');
    expect(h.calls.some((c) => c.url.includes('jup.ag'))).toBe(false);
  });

  it('RED: a quote without the fee, or a transaction not paying the fee account, never reaches the client', async () => {
    const q = fx('jupiter-quote-sol-to-usdc.json');
    const noFee = harness({ respond: respond({}, { quote: { ...q, platformFee: null } }) });
    const r1 = await request(noFee.app).post('/api/proxy/jupiter/order').send(order);
    expect(r1.body.code).toBe('swap_fee_missing');
    expect(r1.body.swapTransaction).toBeUndefined();

    const wrongUser = harness({ respond: respond() });
    const r2 = await request(wrongUser.app).post('/api/proxy/jupiter/order').send({ ...order, userPublicKey: PROVIAN_SOLANA_TREASURY });
    expect(r2.body.code).toBe('jupiter_tx_wrong_payer');
    expect(r2.body.swapTransaction).toBeUndefined();

    const quote = fx('jupiter-quote-bonk-to-jup.json');
    const wrongAcct = harness({ respond: respond({}, { quote, swap: fx('jupiter-swap-sol-to-usdc.json') }) });
    const r3 = await request(wrongAcct.app).post('/api/proxy/jupiter/order').send({ ...order, inputMint: BONK, outputMint: JUP, amount: quote.inAmount });
    expect(r3.body.code).toBe('swap_fee_wrong_recipient');
    expect(r3.body.swapTransaction).toBeUndefined();
  });
});
