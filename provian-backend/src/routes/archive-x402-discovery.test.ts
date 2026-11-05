/**
 * The PE Archive's agent pay route as an x402 resource an indexer can list (x402scan, Coinbase's
 * Bazaar), driven through the real router and the real agent key check with supertest.
 *
 * - Before the launch flip nothing changes: no credential is 401 from the agent key check, a payment
 * with no credential is 401, and `/openapi.json` answers exactly as an unknown path does.
 * - From the flip a caller with no credential and no payment gets the 402: a parseable x402 v2
 * challenge (header and body) with a non-empty `accepts`, the amount in atomic units, and the Bazaar
 * listing whose input states the API key is required — the same requirement and listing an agent
 * with its key gets. Nothing is read for it.
 * - MONEY SAFETY: a payment with no credential, or with an invalid one, is refused 401 and never
 * reaches the Archive, the payment check, the chain or the facilitator. The RED control runs the
 * same signed payment through the same route and harness with a key check that lets it through, and
 * shows the facilitator spy firing: the detector the GREEN cases rely on does see a settlement.
 * - `/openapi.json` describes exactly that one paid operation, with every payment term equal to the
 * runtime challenge's (read from the live 402, never restated here), and a broken copy of it is
 * reported by the same checks (RED).
 */
import { describe, it, expect, jest } from '@jest/globals';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { Wallet } from 'ethers';
import { createArchiveRouter } from './archive';
import { createX402DiscoveryRouter, usdFromUsdcAtomic, X402_OPENAPI_PATH } from './x402-discovery';
import { createAgentAuthMiddleware } from './middleware/agent-auth';
import { createMemoryArchiveObjectStore } from '../core/archive/archive-objects';
import type { ArchiveDeps } from '../core/archive/archive-service';
import { ARCHIVE_GB_FEE_USDC_ATOMIC } from '../core/archive/archive-terms';
import type { CdpFacilitator } from '../core/payments/cdp-facilitator';
import type { UsdcChargeChain, UsdcPaymentRequirement } from '../core/payments/usdc-charge';
import { signedPaymentHeader } from '../core/payout/payout-test-fixtures';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bazaar = require('@x402/extensions/bazaar') as typeof import('@x402/extensions/dist/cjs/bazaar');

const BASE = 'https://api.provian.ai';
const PAY = '/v1/archive/pay';

interface Spies {
  readonly settle: jest.Mock<CdpFacilitator['settle']>;
  readonly submitCharge: jest.Mock<UsdcChargeChain['submitCharge']>;
  readonly archiveDeps: jest.Mock<() => ArchiveDeps | null>;
  /** Every Firestore collection the request touched, in order. */
  readonly collections: string[];
}

/**
 * A Firestore with nothing in it: every document is absent, a create succeeds, a transaction
 * fails. Enough for the agent key check (no such key) and for the charge path to reach the
 * facilitator; every collection touched is recorded.
 */
function emptyFirestore(collections: string[]): Firestore {
  const doc = () => ({
    get: async () => ({ exists: false, id: 'x', data: () => undefined }),
    create: async () => undefined,
  });
  const db = {
    collection: (name: string) => {
      collections.push(name);
      return { doc, where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }) };
    },
    runTransaction: async () => { throw new Error('test_firestore_has_no_transactions'); },
  };
  return db as unknown as Firestore;
}

function harness(opts: { readonly launch: boolean; readonly authenticateAgent?: RequestHandler; readonly archiveConfigured?: boolean }) {
  const env: NodeJS.ProcessEnv = { PUBLIC_LAUNCH: opts.launch ? 'true' : 'false' };
  const collections: string[] = [];
  const db = emptyFirestore(collections);
  const settle = jest.fn<CdpFacilitator['settle']>(async () => `0x${'ab'.repeat(32)}`);
  const submitCharge = jest.fn<UsdcChargeChain['submitCharge']>(async () => `0x${'cd'.repeat(32)}`);
  const chain: UsdcChargeChain = {
    gasAddress: `0x${'35'.repeat(20)}`,
    authorizationUsed: async () => false,
    usdcBalance: async () => 10n ** 12n,
    gasBalanceWei: async () => 10n ** 17n,
    gasPriceWei: async () => 6_000_000n,
    l1FeeUpperBoundWei: async () => 1_000_000_000n,
    submitCharge,
    confirmCharge: async () => 'confirmed',
    headBlock: async () => 1000,
    findCharge: async () => ({ txHash: null, windowClosed: false }),
  };
  const deps: ArchiveDeps = {
    db,
    objects: createMemoryArchiveObjectStore(),
    anchor: null,
    charge: { chain, ethUsd: async () => 4000, withGasKeyLease: async (fn) => fn(), now: () => Date.now(), sleep: async () => undefined },
    // From the flip the Archive settles through the CDP facilitator (archive-runtime.ts).
    settlement: { mode: () => (opts.launch ? 'cdp_facilitator' : 'relay_gas_key'), cdp: { settle } },
    now: () => Date.now(),
  };
  const archiveDeps = jest.fn<() => ArchiveDeps | null>(() => (opts.archiveConfigured === false ? null : deps));
  const app = express();
  app.use(express.json());
  app.use(createX402DiscoveryRouter({ publicBaseUrl: BASE, env }));
  app.use(createArchiveRouter({
    db,
    cache: {} as never,
    // The production key check, against a Firestore that holds no key: every credential is invalid.
    authenticateAgent: opts.authenticateAgent ?? createAgentAuthMiddleware(db),
    authenticateWallet: (_req: Request, res: Response) => { res.status(401).json({ error: 'Authentication required' }); },
    authenticateScheduler: async () => false,
    archiveDeps,
    publicBaseUrl: BASE,
    env,
  }));
  const spies: Spies = { settle, submitCharge, archiveDeps, collections };
  return { app, spies };
}

/** A key check that admits every caller as an active agent (the shape `req.agentWallet` has). */
const admitAnyAgent: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  Object.assign(req, { agentWallet: { id: 'wallet_aw_test', agent_id: 'agent_test', status: 'active' } });
  next();
};

async function signedArchivePayment(): Promise<string> {
  return signedPaymentHeader(Wallet.createRandom(), Math.floor(Date.now() / 1000), { value: ARCHIVE_GB_FEE_USDC_ATOMIC.toString(10) });
}

function expectUntouched(spies: Spies): void {
  expect(spies.settle).not.toHaveBeenCalled();
  expect(spies.submitCharge).not.toHaveBeenCalled();
  expect(spies.archiveDeps).not.toHaveBeenCalled();
  expect(spies.collections.filter((c) => c.startsWith('archive_'))).toEqual([]);
}

interface Challenge {
  readonly x402Version: number;
  readonly resource: { readonly url: string; readonly serviceName?: string };
  readonly accepts: readonly UsdcPaymentRequirement[];
  readonly extensions?: { readonly bazaar?: typeof import('../core/archive/archive-terms').ARCHIVE_BAZAAR_EXTENSION };
  readonly error?: string;
}

function decodeChallengeHeader(value: string | undefined): Challenge {
  expect(typeof value).toBe('string');
  return JSON.parse(Buffer.from(value as string, 'base64').toString('utf8')) as Challenge;
}

/** What an x402 indexer requires of a 402 (x402scan's discovery spec, endpoint registration). */
function challengeIssues(c: Challenge): string[] {
  const issues: string[] = [];
  if (c.x402Version !== 2) issues.push('x402Version');
  if (typeof c.resource?.url !== 'string' || c.resource.url.length === 0) issues.push('resource.url');
  if (!Array.isArray(c.accepts) || c.accepts.length === 0) issues.push('accepts empty');
  for (const [i, a] of (c.accepts ?? []).entries()) {
    for (const k of ['scheme', 'network', 'asset', 'payTo'] as const) if (typeof a[k] !== 'string' || a[k].length === 0) issues.push(`accepts[${i}].${k}`);
    if (typeof a.amount !== 'string' || !/^\d+$/.test(a.amount)) issues.push(`accepts[${i}].amount not atomic`);
    if (!(typeof a.maxTimeoutSeconds === 'number' && a.maxTimeoutSeconds > 0)) issues.push(`accepts[${i}].maxTimeoutSeconds`);
  }
  const schema = c.extensions?.bazaar?.schema?.properties;
  if (c.extensions?.bazaar?.info === undefined) issues.push('extensions.bazaar.info');
  if (schema?.input?.properties?.body === undefined) issues.push('bazaar input schema');
  if (schema?.output?.properties?.example === undefined) issues.push('bazaar output schema');
  return issues;
}

describe('PE Archive agent pay route — before the launch flip, unchanged', () => {
  it('no credential: 401 from the agent key check, nothing read', async () => {
    const { app, spies } = harness({ launch: false });
    const res = await request(app).post(PAY).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid Authorization header' });
    expect(res.headers['payment-required']).toBeUndefined();
    expectUntouched(spies);
  });

  it('a payment with no credential: 401, nothing verified or settled', async () => {
    const { app, spies } = harness({ launch: false });
    const res = await request(app).post(PAY).set('PAYMENT-SIGNATURE', await signedArchivePayment()).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing or invalid Authorization header' });
    expectUntouched(spies);
  });

  it('/openapi.json answers exactly as an unknown path does', async () => {
    const { app } = harness({ launch: false });
    const doc = await request(app).get(X402_OPENAPI_PATH);
    const unknown = await request(app).get('/no-such-path.json');
    expect(doc.status).toBe(404);
    expect(doc.text).toBe(unknown.text.replace('/no-such-path.json', X402_OPENAPI_PATH));
  });
});

describe('PE Archive agent pay route — from the launch flip, the unauthenticated probe gets the 402', () => {
  it('no credential, no payment: a parseable x402 v2 challenge with the Bazaar listing, nothing read', async () => {
    const { app, spies } = harness({ launch: true });
    const res = await request(app).post(PAY);
    expect(res.status).toBe(402);
    const header = decodeChallengeHeader(res.headers['payment-required']);
    expect(header).toEqual(res.body);
    expect(challengeIssues(res.body as Challenge)).toEqual([]);
    const c = res.body as Challenge;
    expect(c.resource.url).toBe(`${BASE}${PAY}`);
    expect(c.error).toBeUndefined();
    // The listing's input states the agent's API key is required.
    expect(c.extensions!.bazaar!.info.input.headers).toHaveProperty('Authorization');
    expect(c.extensions!.bazaar!.schema.properties.input.properties.headers.required).toContain('Authorization');
    expect(bazaar.validateDiscoveryExtension(JSON.parse(JSON.stringify(c.extensions!.bazaar)))).toEqual({ valid: true });
    expect(spies.archiveDeps).toHaveBeenCalledTimes(1); // only to ask whether the Archive is configured
    expect(spies.collections).toEqual([]);
    expect(spies.settle).not.toHaveBeenCalled();
    expect(spies.submitCharge).not.toHaveBeenCalled();
  });

  it('a probe with a JSON body is not refused before the 402', async () => {
    const { app } = harness({ launch: true });
    const res = await request(app).post(PAY).set('Content-Type', 'application/json').send({});
    expect(res.status).toBe(402);
    expect(challengeIssues(res.body as Challenge)).toEqual([]);
  });

  it('the same requirement and listing an agent with its key gets', async () => {
    const anonymous = await request(harness({ launch: true }).app).post(PAY);
    const keyed = await request(harness({ launch: true, authenticateAgent: admitAnyAgent }).app).post(PAY);
    expect(keyed.status).toBe(402);
    // The keyed 402 also reports the caller's Archive (absent here: no account yet).
    const { archive: _account, ...keyedChallenge } = keyed.body as Record<string, unknown>;
    expect(anonymous.body).toEqual(keyedChallenge);
    expect(decodeChallengeHeader(anonymous.headers['payment-required'])).toEqual(decodeChallengeHeader(keyed.headers['payment-required']));
  });

  it('an Archive that is not configured: unchanged (the key check answers 401)', async () => {
    const { app } = harness({ launch: true, archiveConfigured: false });
    const res = await request(app).post(PAY);
    expect(res.status).toBe(401);
  });

  it('the people\'s route stays unlisted: no credential is refused by wallet auth, never a 402', async () => {
    const { app } = harness({ launch: true });
    const res = await request(app).post('/v1/archive/mobile/pay').send({});
    expect(res.status).toBe(401);
    expect(res.headers['payment-required']).toBeUndefined();
  });
});

describe('MONEY SAFETY — a payment that credits nobody is never taken', () => {
  const variants: ReadonlyArray<{ name: string; send: (r: request.Test, payment: string) => request.Test }> = [
    { name: 'PAYMENT-SIGNATURE, no credential', send: (r, p) => r.set('PAYMENT-SIGNATURE', p).send({}) },
    { name: 'X-PAYMENT, no credential', send: (r, p) => r.set('X-PAYMENT', p).send({}) },
    { name: 'body payment, no credential', send: (r, p) => r.send({ payment: p }) },
    { name: 'empty PAYMENT-SIGNATURE, no credential', send: (r) => r.set('PAYMENT-SIGNATURE', '').send({}) },
    { name: 'PAYMENT-SIGNATURE, unknown API key', send: (r, p) => r.set('Authorization', 'Bearer pvn_live_00000000000000000000:pvns_nope').set('PAYMENT-SIGNATURE', p).send({}) },
    { name: 'PAYMENT-SIGNATURE, malformed credential', send: (r, p) => r.set('Authorization', 'Bearer not-a-key').set('PAYMENT-SIGNATURE', p).send({}) },
    { name: 'PAYMENT-SIGNATURE, empty Authorization', send: (r, p) => r.set('Authorization', '').set('PAYMENT-SIGNATURE', p).send({}) },
  ];

  it.each(variants)('$name: 401, and nothing reads the Archive, verifies, submits or settles', async ({ send }) => {
    const { app, spies } = harness({ launch: true });
    const res = await send(request(app).post(PAY), await signedArchivePayment());
    expectUntouched(spies); // the money assertion first: it names what ran if this ever fails
    expect(res.status).toBe(401);
    expect(res.headers['payment-required']).toBeUndefined();
    expect(res.headers['payment-response']).toBeUndefined();
  });

  it('RED control: the same signed payment through a key check that lets it through IS settled by the facilitator', async () => {
    const { app, spies } = harness({ launch: true, authenticateAgent: admitAnyAgent });
    await request(app).post(PAY)
      .set('Authorization', 'Bearer pvn_live_00000000000000000000:pvns_nope')
      .set('PAYMENT-SIGNATURE', await signedArchivePayment())
      .send({});
    expect(spies.settle).toHaveBeenCalledTimes(1);
    expect(spies.collections).toContain('archive_payments_v1');
  });
});

/** What x402scan's discovery spec requires of `/openapi.json` (OpenAPI-first discovery). */
function openApiIssues(doc: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const info = doc.info as { title?: unknown; version?: unknown } | undefined;
  if (typeof doc.openapi !== 'string') issues.push('openapi');
  if (typeof info?.title !== 'string') issues.push('info.title');
  if (typeof info?.version !== 'string') issues.push('info.version');
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (typeof paths !== 'object' || paths === null) { issues.push('paths'); return issues; }
  const schemes = ((doc.components as { securitySchemes?: Record<string, { type?: string }> } | undefined)?.securitySchemes) ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      const where = `${method.toUpperCase()} ${path}`;
      const pay = op['x-payment-info'] as { protocols?: unknown[]; price?: { mode?: string; currency?: string; amount?: string } } | undefined;
      if (pay === undefined) { issues.push(`${where}: x-payment-info`); continue; }
      if (!(op.responses as Record<string, unknown> | undefined)?.['402']) issues.push(`${where}: 402 response`);
      const names = (pay.protocols ?? []).map((p) => (typeof p === 'string' ? p : Object.keys(p as object)[0]));
      if (!names.includes('x402')) issues.push(`${where}: protocols x402`);
      const price = pay.price;
      if (price?.mode !== 'fixed' || price.currency !== 'USD' || typeof price.amount !== 'string' || !/^\d+\.\d+$/.test(price.amount)) {
        issues.push(`${where}: fixed USD price`);
      }
      for (const req of (op.security as Record<string, unknown>[] | undefined) ?? []) {
        for (const name of Object.keys(req)) if (schemes[name] === undefined) issues.push(`${where}: security scheme ${name}`);
      }
    }
  }
  return issues;
}

describe('/openapi.json — the one paid operation, from the launch flip', () => {
  async function liveDocAndChallenge() {
    const { app } = harness({ launch: true });
    const doc = await request(app).get(X402_OPENAPI_PATH);
    const challenge = (await request(app).post(PAY)).body as Challenge;
    return { doc, challenge };
  }

  it('GREEN: meets the discovery spec and describes exactly POST /v1/archive/pay', async () => {
    const { doc } = await liveDocAndChallenge();
    expect(doc.status).toBe(200);
    expect(doc.headers['content-type']).toMatch(/application\/json/);
    const body = doc.body as Record<string, unknown>;
    expect(openApiIssues(body)).toEqual([]);
    const paths = body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths)).toEqual([PAY]);
    expect(Object.keys(paths[PAY])).toEqual(['post']);
    expect((body.servers as { url: string }[])[0].url).toBe(BASE);
    expect(JSON.stringify(body)).not.toContain('/v1/archive/mobile');
  });

  it('every payment term equals the runtime challenge (read from the live 402, never restated)', async () => {
    const { doc, challenge } = await liveDocAndChallenge();
    const op = (doc.body.paths as Record<string, Record<string, Record<string, unknown>>>)[PAY].post;
    const pay = op['x-payment-info'] as { price: { amount: string }; protocols: { x402: Record<string, unknown> }[] };
    const accept = challenge.accepts[0];
    expect(pay.price.amount).toBe(usdFromUsdcAtomic(accept.amount));
    expect(pay.protocols[0].x402).toEqual({
      version: challenge.x402Version,
      scheme: accept.scheme,
      network: accept.network,
      asset: accept.asset,
      payTo: accept.payTo,
      amount: accept.amount,
    });
    // The request body and the 200 schema are the listing's own.
    const input = challenge.extensions!.bazaar!.schema.properties.input.properties.body;
    const output = challenge.extensions!.bazaar!.schema.properties.output.properties.example;
    expect((op.requestBody as { content: Record<string, { schema: unknown }> }).content['application/json'].schema).toEqual(input);
    expect((op.responses as Record<string, { content?: Record<string, { schema: unknown }> }>)['200'].content!['application/json'].schema).toEqual(output);
    expect((doc.body.info as { title: string }).title).toBe(challenge.resource.serviceName);
  });

  it('the agent API key is the declared security (an apiKey scheme in the Authorization header)', async () => {
    const { doc } = await liveDocAndChallenge();
    const op = (doc.body.paths as Record<string, Record<string, Record<string, unknown>>>)[PAY].post;
    const [requirement] = op.security as Record<string, unknown>[];
    const scheme = (doc.body.components as { securitySchemes: Record<string, Record<string, string>> }).securitySchemes[Object.keys(requirement)[0]];
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'Authorization' });
  });

  it('RED: a document missing x-payment-info, the 402, x402, a fixed USD price or its scheme is reported', async () => {
    const { doc } = await liveDocAndChallenge();
    const mutate = (fn: (op: Record<string, unknown>, d: Record<string, unknown>) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(doc.body)) as Record<string, unknown>;
      fn((copy.paths as Record<string, Record<string, Record<string, unknown>>>)[PAY].post, copy);
      return openApiIssues(copy);
    };
    expect(mutate((op) => { delete op['x-payment-info']; })).toEqual([`POST ${PAY}: x-payment-info`]);
    expect(mutate((op) => { delete (op.responses as Record<string, unknown>)['402']; })).toEqual([`POST ${PAY}: 402 response`]);
    expect(mutate((op) => { (op['x-payment-info'] as { protocols: unknown[] }).protocols = [{ mpp: {} }]; })).toEqual([`POST ${PAY}: protocols x402`]);
    expect(mutate((op) => { (op['x-payment-info'] as { price: { amount: string } }).price.amount = '5000000'; })).toEqual([`POST ${PAY}: fixed USD price`]);
    expect(mutate((_op, d) => { delete (d.components as { securitySchemes: Record<string, unknown> }).securitySchemes.ApiKeyAuth; })).toEqual([`POST ${PAY}: security scheme ApiKeyAuth`]);
    expect(mutate((_op, d) => { delete (d.info as Record<string, unknown>).version; })).toEqual(['info.version']);
  });

  it('RED: the challenge checks report an empty accepts and a decimal amount', async () => {
    const { challenge } = await liveDocAndChallenge();
    expect(challengeIssues({ ...challenge, accepts: [] })).toEqual(['accepts empty']);
    expect(challengeIssues({ ...challenge, accepts: [{ ...challenge.accepts[0], amount: '5.00' }] })).toEqual(['accepts[0].amount not atomic']);
  });
});

describe('usdFromUsdcAtomic', () => {
  it.each([['5000000', '5.00'], ['10000', '0.01'], ['1234567', '1.234567'], ['0', '0.00'], ['1500000000', '1500.00']])('%s → %s', (atomic, usd) => {
    expect(usdFromUsdcAtomic(atomic)).toBe(usd);
  });
  it.each(['5.00', '-1', '', '1e6'])('refuses %p', (bad) => {
    expect(() => usdFromUsdcAtomic(bad)).toThrow('usdc_amount_not_atomic');
  });
});
