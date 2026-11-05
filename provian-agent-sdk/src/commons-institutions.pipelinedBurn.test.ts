import {openTestPrivateRequest} from './private-request.test-support';
/**
 * pipelined burn flows. The SDK broadcasts the burn (`sendBurn`) and hands its tx to the ONE
 * `/present` call; the relay records the burn at Base finality inside that call and issues only once
 * it is final. These tests pin the SDK half: which calls fire, in what shape, and that every "no burn"
 * branch really moves nothing (each is paired with the positive case that DOES burn, so an assertion
 * of "not called" cannot pass on a path that never burns at all).
 */
import { describe, it, expect, vi } from 'vitest';
import { CommonsInstitutions, BURN_RECORD_ATTEMPTS, BurnNotPresentedError, type CommonsInstitutionsConfig } from './commons-institutions';
import { burnIdForTx } from './presentation';

const KEY = 'a'.repeat(64);
const RPC = 'https://base-rpc.test';
const WALLET = 'wallet_aw_me';
const BURN_TX = '0x' + 'be'.repeat(32);
const BURN_ID = burnIdForTx('base', BURN_TX);
const fakeSendBurn = async (p: { amountAtomic: string | bigint }) =>
  ({ txHash: BURN_TX, burnId: BURN_ID, amountAtomic: String(p.amountAtomic), chain: 'base' as const });

interface Call { url: string; method: string; body: Record<string, unknown> | undefined }
type Route = unknown | ((call: Call, n: number) => Response);

function makeInstitutions(routes: Record<string, Route>): { institutions: CommonsInstitutions; calls: Call[] } {
  const calls: Call[] = [];
  const hits: Record<string, number> = {};
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, method: String(init?.method ?? 'GET'), body: init?.body ? openTestPrivateRequest(JSON.parse(String(init.body)),String(input),init?.headers) : undefined };
    calls.push(call);
    const path = url.replace('https://relay.test', '').split('?')[0];
    const key = `${call.method} ${path}`;
    if(path.endsWith('/present/preflight')) return new Response(JSON.stringify({ok:true}));
    const route = routes[key];
    if (route === undefined) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    hits[key] = (hits[key] ?? 0) + 1;
    if (typeof route === 'function') return (route as (c: Call, n: number) => Response)(call, hits[key]);
    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;
  const config: CommonsInstitutionsConfig = { relayUrl: 'https://relay.test', walletId: WALLET, apiKey: 'pvn_live_abc', apiSecret: 'pvns_' + 'x'.repeat(64), fetch: f };
  return { institutions: new CommonsInstitutions(config), calls };
}

const PRESENT = `POST /v1/agent/wallet/${WALLET}/present`;
const HANDSHAKE = `GET /v1/agent/wallet/${WALLET}/rail-handshake`;
const presentOk = { tier: 'pe_fact', presentation: { payload: { jti: 'pres_1', burn_id: BURN_ID } }, token: 'TOKEN' };
const posts = (calls: Call[], suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.split('?')[0].endsWith(suffix));

describe('ensureRailHandshake / ensureSpeechWindow — burn only when no handshake is live', () => {
  it('a LIVE handshake is a read: no floor read, no burn, no /present', async () => {
    const { institutions, calls } = makeInstitutions({ [HANDSHAKE]: { state: 'live' } });
    const burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const out = await institutions.ensureRailHandshake({ counterparty: 'wallet_aw_other', privateKeyHex: KEY, burn: { rpcUrl: RPC } });
    expect(out.presented).toBe(false);
    expect(burnSpy).not.toHaveBeenCalled();
    expect(posts(calls, '/present')).toHaveLength(0);
  });

  it('no live handshake + `burn` → burns the tier floor ONCE and presents it in the same call (no /burn/record)', async () => {
    let state = 'none';
    const { institutions, calls } = makeInstitutions({
      [HANDSHAKE]: () => new Response(JSON.stringify({ state }), { status: 200 }),
      [PRESENT]: () => { state = 'live'; return new Response(JSON.stringify(presentOk), { status: 200 }); },
      'GET /v1/present/floor': { floors: { pe_fact: { floor_atomic: '5000000000000000000' } } },
    });
    const burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const out = await institutions.ensureRailHandshake({ counterparty: 'wallet_aw_other', privateKeyHex: KEY, burn: { rpcUrl: RPC } });
    expect(burnSpy).toHaveBeenCalledTimes(1);
    expect(burnSpy).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: 5n * 10n ** 18n, rpcUrl: RPC }));
    const [post] = posts(calls, '/present');
    expect(post.body).toMatchObject({ burn_id: BURN_ID, burn: { tx_hash: BURN_TX, amount_atomic: '5000000000000000000', chain: 'base' }, audience: 'wallet_aw_other' });
    expect(posts(calls, '/burn/record')).toHaveLength(0);
    expect(out).toMatchObject({ presented: true, burnId: BURN_ID, txHash: BURN_TX, state: { state: 'live' } });
  });

  it('RED: no live handshake and no burn source → refused before anything is burned', async () => {
    const { institutions, calls } = makeInstitutions({ [HANDSHAKE]: { state: 'none' } });
    const burnSpy = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    await expect(institutions.ensureRailHandshake({ counterparty: 'wallet_aw_other', privateKeyHex: KEY })).rejects.toThrow(/burnId|burnTx|burn:/);
    expect(burnSpy).not.toHaveBeenCalled();
    expect(posts(calls, '/present')).toHaveLength(0);
  });

  it('ensureSpeechWindow passes `burn` through: opens the window to provian:commons in one pipelined present', async () => {
    let state = 'none';
    const { institutions, calls } = makeInstitutions({
      [HANDSHAKE]: () => new Response(JSON.stringify({ state }), { status: 200 }),
      [PRESENT]: () => { state = 'live'; return new Response(JSON.stringify(presentOk), { status: 200 }); },
      'GET /v1/present/floor': { floors: { pe_fact: { floor_atomic: '5000000000000000000' } } },
    });
    vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const out = await institutions.ensureSpeechWindow({ privateKeyHex: KEY, burn: { rpcUrl: RPC } });
    expect(out).toMatchObject({ live: true, presented: true, burnId: BURN_ID, txHash: BURN_TX });
    expect(posts(calls, '/present')[0].body).toMatchObject({ audience: 'provian:commons', burn: { tx_hash: BURN_TX } });
  });
});

describe('presentInThread — the delivered request saves the re-read', () => {
  const THREAD = 'th_1';
  const LIST = `GET /v1/threads/${THREAD}/presentation-requests`;
  const THREAD_PRESENT = `POST /v1/threads/${THREAD}/presentation-requests/r1/present`;
  const REQ = { request_id: 'r1', audience: 'wallet_aw_requester', challenge: 'c'.repeat(64), tier: 'pe_fact' as const };

  it('a request whose id matches is used as delivered: no list GET; burnTx rides to /present', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: presentOk, [THREAD_PRESENT]: { ok: true }, [LIST]: { requests: [REQ] } });
    await institutions.presentInThread(THREAD, 'r1', { privateKeyHex: KEY, burnTx: { txHash: BURN_TX, amountAtomic: '5000000000000000000' }, request: REQ });
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith(`/threads/${THREAD}/presentation-requests`))).toBe(false);
    expect(posts(calls, `/wallet/${WALLET}/present`)[0].body).toMatchObject({ burn_id: BURN_ID, burn: { tx_hash: BURN_TX } });
    expect(posts(calls, '/presentation-requests/r1/present')[0].body).toMatchObject({ burn_id: BURN_ID, presentation_token: 'TOKEN' });
  });

  it('a request for a DIFFERENT id is ignored — the thread is re-read', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: presentOk, [THREAD_PRESENT]: { ok: true }, [LIST]: { requests: [REQ] } });
    await institutions.presentInThread(THREAD, 'r1', { privateKeyHex: KEY, burnId: BURN_ID, request: { ...REQ, request_id: 'r2' } });
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith(`/threads/${THREAD}/presentation-requests`))).toBe(true);
  });

  it('RED: a burnId that does not match burnTx is refused before /present', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: presentOk, [THREAD_PRESENT]: { ok: true }, [LIST]: { requests: [REQ] } });
    await expect(institutions.presentInThread(THREAD, 'r1', {
      privateKeyHex: KEY, burnId: 'f'.repeat(64), burnTx: { txHash: BURN_TX, amountAtomic: '5000000000000000000' }, request: REQ,
    })).rejects.toThrow(/burn/i);
    expect(posts(calls, '/present')).toHaveLength(0);
  });
});

describe('present — a dropped pipelined call is re-sent (same burn, same binding)', () => {
  it('with burnTx: a 503 then success → two identical POSTs, one token', async () => {
    const { institutions, calls } = makeInstitutions({
      [PRESENT]: (_c: Call, n: number) => n === 1
        ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
        : new Response(JSON.stringify(presentOk), { status: 200 }),
    });
    vi.useFakeTimers();
    try {
      const p = institutions.present({ privateKeyHex: KEY, tier: 'pe_fact', burnTx: { txHash: BURN_TX, amountAtomic: '5000000000000000000' }, audience: 'wallet_aw_x', challenge: 'd'.repeat(64) });
      await vi.runAllTimersAsync();
      expect((await p).token).toBe('TOKEN');
    } finally {
      vi.useRealTimers();
    }
    const sent = posts(calls, '/present');
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(BURN_RECORD_ATTEMPTS).toBeGreaterThan(1);
  });

  it('RED: without burnTx a 503 is NOT retried (no burn is pending acceptance)', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }) });
    await expect(institutions.present({ privateKeyHex: KEY, tier: 'pe_fact', burnId: BURN_ID, audience: 'wallet_aw_x', challenge: 'd'.repeat(64) })).rejects.toThrow();
    expect(posts(calls, '/present')).toHaveLength(1);
  });
});

describe('respondToChallenge — explicit `confirmations` keeps the record-then-present path', () => {
  it('burns via burnPvt (records first) and sends no burn tx on /present', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: presentOk, 'GET /v1/present/floor': { floors: { pe_fact: { floor_atomic: '5000000000000000000' } } } });
    const burnPvt = vi.spyOn(institutions, 'burnPvt').mockResolvedValue({ txHash: BURN_TX, burnId: BURN_ID, verified: true });
    const sendBurn = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    await institutions.respondToChallenge({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }, { privateKeyHex: KEY, rpcUrl: RPC, confirmations: 12 });
    expect(burnPvt).toHaveBeenCalledWith(expect.objectContaining({ confirmations: 12 }));
    expect(sendBurn).not.toHaveBeenCalled();
    const body = posts(calls, '/present')[0].body!;
    expect(body.burn_id).toBe(BURN_ID);
    expect(body.burn).toBeUndefined();
  });
});

// a burn a pipelined flow BROADCAST must never be lost — a failure after
// the broadcast surfaces the tx (BurnNotPresentedError), and presenting it again never re-burns.
describe('a broadcast burn is never lost when its present fails', () => {
  const refusedAfterRecord = () => new Response(JSON.stringify({ error: 'presentation expired', reason: 'presentation_expired', burn_id: BURN_ID, burn_recorded: true }), { status: 400 });
  const floor = { floors: { pe_fact: { floor_atomic: '5000000000000000000' } } };

  it('RED: ensureRailHandshake({ burn }) whose present is refused throws BurnNotPresentedError carrying the tx', async () => {
    const { institutions } = makeInstitutions({ [HANDSHAKE]: { state: 'none' }, [PRESENT]: refusedAfterRecord, 'GET /v1/present/floor': floor });
    vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const err = await institutions.ensureRailHandshake({ counterparty: 'wallet_aw_other', privateKeyHex: KEY, burn: { rpcUrl: RPC } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurnNotPresentedError);
    expect(err).toMatchObject({ code: 'BURN_NOT_PRESENTED', txHash: BURN_TX, burnId: BURN_ID, amountAtomic: '5000000000000000000', recorded: true });
    expect((err as Error).message).toContain(BURN_TX);
  });

  it('RED: respondToChallenge whose present is refused after the broadcast throws BurnNotPresentedError', async () => {
    const { institutions } = makeInstitutions({ [PRESENT]: refusedAfterRecord, 'GET /v1/present/floor': floor });
    vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const err = await institutions.respondToChallenge({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }, { privateKeyHex: KEY, rpcUrl: RPC }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BurnNotPresentedError);
    expect(err).toMatchObject({ txHash: BURN_TX, burnId: BURN_ID });
  });

  it('respondToChallenge({ burnTx }) resumes that burn: no sendBurn, the same tx rides to /present', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: presentOk, 'GET /v1/present/floor': floor });
    const sendBurn = vi.spyOn(institutions, 'sendBurn').mockImplementation(fakeSendBurn);
    const out = await institutions.respondToChallenge({ audience: 'gate.example.com', challenge: 'a'.repeat(64) }, {
      privateKeyHex: KEY, rpcUrl: RPC, burnTx: { txHash: BURN_TX, amountAtomic: '5000000000000000000' },
    });
    expect(sendBurn).not.toHaveBeenCalled();
    expect(out).toMatchObject({ txHash: BURN_TX, burnId: BURN_ID });
    expect(posts(calls, '/present')[0].body).toMatchObject({ burn_id: BURN_ID, burn: { tx_hash: BURN_TX } });
  });

  it("present retries the relay's transient burn refusal (not yet mined / insufficient_confirmations) when it carries the burn", async () => {
    const { institutions, calls } = makeInstitutions({
      [PRESENT]: (_c: Call, n: number) => n === 1
        ? new Response(JSON.stringify({ error: 'On-chain PVT burn verification failed', reason: 'insufficient_confirmations: 11/12' }), { status: 400 })
        : new Response(JSON.stringify(presentOk), { status: 200 }),
    });
    vi.useFakeTimers();
    try {
      const p = institutions.present({ privateKeyHex: KEY, tier: 'pe_fact', burnTx: { txHash: BURN_TX, amountAtomic: '5' }, audience: 'wallet_aw_x', challenge: 'd'.repeat(64) });
      await vi.runAllTimersAsync();
      expect((await p).token).toBe('TOKEN');
    } finally {
      vi.useRealTimers();
    }
    expect(posts(calls, '/present')).toHaveLength(2);
  });

  it('RED: a burn the relay reports reverted (tx_failed) is NOT retried', async () => {
    const { institutions, calls } = makeInstitutions({ [PRESENT]: () => new Response(JSON.stringify({ error: 'On-chain PVT burn verification failed', reason: 'tx_failed' }), { status: 400 }) });
    await expect(institutions.present({ privateKeyHex: KEY, tier: 'pe_fact', burnTx: { txHash: BURN_TX, amountAtomic: '5' }, audience: 'wallet_aw_x', challenge: 'd'.repeat(64) })).rejects.toThrow();
    expect(posts(calls, '/present')).toHaveLength(1);
  });
});
