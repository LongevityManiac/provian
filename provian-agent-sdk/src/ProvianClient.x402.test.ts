/**
 * Tests for ProvianClient.wrapFetchWithX402 — the agent pays an HTTP 402 with
 * its OWN wallet: detect 402 -> sign EIP-3009 locally with the agent's key ->
 * replay with the X-PAYMENT header. Governance-free (no relay sign/settle, no
 * phone). no x402_payment PE is recorded by the SDK — the chain watcher
 * witnesses the settlement — so every test asserts the relay is never called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { ProvianClient } from './ProvianClient';

// Deterministic test wallet (NOT real). Same key as link-signing.test.ts.
const WALLET = {
  privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
};
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RESOURCE = 'https://api.test/resource';

function paymentRequired(network = 'eip155:8453', asset = BASE_USDC) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: [{ scheme: 'exact', network, amount: '10000', asset, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
  };
}

function r402(network?: string, asset?: string): Response {
  return new Response(JSON.stringify(paymentRequired(network, asset)), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}

function r200WithReceipt(): Response {
  const receipt = { success: true, payer: WALLET.address, transaction: '0xdeadbeef', network: 'eip155:8453' };
  return new Response('ok', {
    status: 200,
    headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(receipt)).toString('base64') },
  });
}

// "connected" now means DEVICE mode (deviceKey + deviceSecret). even a device-mode
// client records no x402_payment PE.
function connectedClient(): ProvianClient {
  const c = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1', deviceKey: 'pdk_test', deviceSecret: 'pds_test' });
  (c as unknown as { connected: boolean }).connected = true;
  return c;
}

// The canonical standalone x402 agent: configured but never connect()ed. x402
// needs no relay session, so this is the common case for an agent that only
// pays APIs with its own wallet.
function unconnectedClient(): ProvianClient {
  return new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1' });
}

function xPaymentHeader(init: RequestInit | undefined): string | null {
  // v2 paying header (X-PAYMENT is the v1 name live sellers ignore).
  return new Headers(init?.headers).get('PAYMENT-SIGNATURE');
}

/** stub the global fetch (the relay channel) and return the relay calls it saw. */
function stubRelay(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ pe_id: 'pe_should_not_exist' }), { status: 201 });
  }));
  return calls;
}

describe('wrapFetchWithX402', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('pays a 402 locally and replays with a valid X-PAYMENT header', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();

    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return xPaymentHeader(init) ? r200WithReceipt() : r402();
    });

    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    const res = await wrapped(RESOURCE, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);

    // The retry carried a well-formed signed payment + redirect:'manual'.
    const retryInit = targetFetch.mock.calls[1][1] as RequestInit;
    expect(retryInit.redirect).toBe('manual');
    const xpay = xPaymentHeader(retryInit)!;
    const decoded = JSON.parse(Buffer.from(xpay, 'base64').toString('utf8'));
    expect(decoded.accepted.scheme).toBe('exact');
    expect(decoded.accepted.network).toBe('eip155:8453');
    expect(decoded.payload.authorization.from).toBe(WALLET.address);
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);

    // no x402_payment PE — the relay is never called.
    expect(relayCalls).toEqual([]);
  });

  it('preserves the original Request method/headers/body on the paid retry (Request input, no init arg)', async () => {
    const c = connectedClient();
    stubRelay();

    const bodyText = JSON.stringify({ hello: 'world' });

    // Capture the retry body as text (the first call has no X-PAYMENT, the
    // second is the paid retry).
    const seenBodies: Array<string> = [];
    const targetFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // init.body may be an ArrayBuffer (cloned Request body) or a string.
      const raw = init?.body;
      let asText = '';
      if (typeof raw === 'string') asText = raw;
      else if (raw instanceof ArrayBuffer) asText = Buffer.from(raw).toString('utf8');
      else if (raw instanceof Uint8Array) asText = Buffer.from(raw).toString('utf8');
      seenBodies.push(asText);
      return xPaymentHeader(init) ? r200WithReceipt() : r402();
    });

    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });

    // Idiomatic fetch: a Request with method/headers/body and NO second init.
    const req = new Request(RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'keepme' },
      body: bodyText,
    });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);

    // The paid retry must be POST, carry X-PAYMENT, AND preserve the original
    // headers + body.
    const retryInit = targetFetch.mock.calls[1][1] as RequestInit;
    expect(retryInit.method).toBe('POST');
    expect(xPaymentHeader(retryInit)).toBeTruthy();
    const retryHeaders = new Headers(retryInit.headers);
    expect(retryHeaders.get('content-type')).toBe('application/json');
    expect(retryHeaders.get('x-custom')).toBe('keepme');
    expect(seenBodies[1]).toBe(bodyText);
  });

  it('passes non-402 responses straight through (no signing, no PE)', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();
    const targetFetch = vi.fn(async () => new Response('hi', { status: 200 }));

    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    const res = await wrapped(RESOURCE);

    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(1);
    expect(relayCalls).toEqual([]);
  });

  it('throws X402_NO_COMPATIBLE_OPTION when no accepted option is supported', async () => {
    const c = connectedClient();
    const targetFetch = vi.fn(async () => r402('eip155:1', PAY_TO));
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_NO_COMPATIBLE_OPTION' });
    expect(targetFetch).toHaveBeenCalledTimes(1);
  });

  it('does not loop on a second 402 (X402_PAYMENT_REJECTED)', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();
    const targetFetch = vi.fn(async () => r402()); // always 402, even on the paid retry
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });

    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_PAYMENT_REJECTED' });
    expect(targetFetch).toHaveBeenCalledTimes(2);
    expect(relayCalls).toEqual([]);
  });

  it('fails closed if the paid retry is redirected (X402_REDIRECTED)', async () => {
    const c = connectedClient();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return xPaymentHeader(init) ? new Response(null, { status: 302 }) : r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_REDIRECTED' });
  });

  it('an unconnected standalone agent pays and records NO PE (no sovereign x402 PE)', async () => {
    const c = unconnectedClient();
    const relayCalls = stubRelay();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return xPaymentHeader(init) ? r200WithReceipt() : r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    const res = await wrapped(RESOURCE, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);
    expect(relayCalls).toEqual([]);
  });

  it('recordPE (deprecated) is ignored: nothing is recorded either way', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return xPaymentHeader(init) ? r200WithReceipt() : r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch, recordPE: false });
    const res = await wrapped(RESOURCE);
    expect(res.status).toBe(200);
    expect(relayCalls).toEqual([]);
  });

  // #19: the X-PAYMENT-RESPONSE receipt is attacker-influenced. A facilitator can
  // serve HTTP 200 while reporting settlement success:false. The reputation PE
  // must NOT be recorded for an unsettled payment (it would inflate
  // x402_payment_count for a payment that never landed on-chain).
  it('#19: a settlement receipt reporting success:false is surfaced (warn); nothing is recorded', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r200Failed = (): Response => {
      const receipt = { success: false, payer: WALLET.address, transaction: '0x00', network: 'eip155:8453' };
      return new Response('ok', {
        status: 200,
        headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(receipt)).toString('base64') },
      });
    };
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      xPaymentHeader(init) ? r200Failed() : r402());
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });

    const res = await wrapped(RESOURCE, { method: 'GET' });
    expect(res.status).toBe(200); // the paid path still returns — x402 is governance-free
    expect(relayCalls).toEqual([]); // but NO success PE for an unsettled payment
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('does not report success');
    warnSpy.mockRestore();
  });

  // #9: a caller retry for the SAME logical payment after an AMBIGUOUS outcome (the seller may
  // already have settled: a lost response, a 5xx) must reuse the same single-use EIP-3009 nonce,
  // so a settled-but-lost first response cannot be double-charged (the reused nonce is rejected
  // on-chain as a replay).
  it('#9: a caller retry after an ambiguous outcome (5xx) reuses the SAME EIP-3009 nonce (no second settleable authorization)', async () => {
    const c = connectedClient();
    stubRelay();
    const xpayNonces: string[] = [];
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const xpay = xPaymentHeader(init);
      if (xpay) {
        const decoded = JSON.parse(Buffer.from(xpay, 'base64').toString('utf8'));
        xpayNonces.push(decoded.payload.authorization.nonce);
        // The first paid retry dies upstream AFTER the seller may have settled.
        return xpayNonces.length === 1 ? new Response('upstream died', { status: 503 }) : r200WithReceipt();
      }
      return r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });

    await expect(wrapped(RESOURCE, { method: 'GET' })).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });
    expect((await wrapped(RESOURCE, { method: 'GET' })).status).toBe(200); // caller retry

    expect(xpayNonces).toHaveLength(2);
    expect(xpayNonces[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(xpayNonces[0]).toBe(xpayNonces[1]); // SAME nonce → replay-rejected on-chain, no double charge
  });

  // #9 (memo is instance-scoped): even a RE-WRAP for the same logical payment on
  // the same client reuses the same nonce after an ambiguous outcome, so the
  // cross-invocation retry case is covered too (not just repeated calls of one wrapped fetch).
  it('#9: a re-wrapped fetch for the same payment on the same client reuses the SAME nonce after an ambiguous outcome', async () => {
    const c = connectedClient();
    stubRelay();
    const xpayNonces: string[] = [];
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const xpay = xPaymentHeader(init);
      if (xpay) {
        xpayNonces.push(JSON.parse(Buffer.from(xpay, 'base64').toString('utf8')).payload.authorization.nonce);
        return xpayNonces.length === 1 ? new Response('upstream died', { status: 503 }) : r200WithReceipt();
      }
      return r402();
    });
    // Two SEPARATE wrapFetchWithX402 invocations (e.g. a caller that re-wraps).
    await expect(c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch })(RESOURCE, { method: 'GET' })).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });
    await c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch })(RESOURCE, { method: 'GET' });

    expect(xpayNonces).toHaveLength(2);
    expect(xpayNonces[0]).toBe(xpayNonces[1]); // instance-scoped memo → same single-use nonce
  });

  // A settled payment ends the memo. Before this the memo lived until validBefore, so an agent
  // buying the SAME resource twice inside that window re-sent its spent nonce and was refused as a
  // replay — stranded, with no way to pay again (2026-10-17 bug check).
  it('a settled payment (2xx) is consumed: the next purchase of the same resource carries a FRESH nonce', async () => {
    const c = connectedClient();
    stubRelay();
    const xpayNonces: string[] = [];
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const xpay = xPaymentHeader(init);
      if (xpay) {
        xpayNonces.push(JSON.parse(Buffer.from(xpay, 'base64').toString('utf8')).payload.authorization.nonce);
        return r200WithReceipt();
      }
      return r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    expect((await wrapped(RESOURCE, { method: 'GET' })).status).toBe(200);
    expect((await wrapped(RESOURCE, { method: 'GET' })).status).toBe(200);
    expect(xpayNonces).toHaveLength(2);
    expect(xpayNonces[0]).not.toBe(xpayNonces[1]); // two purchases, two authorizations
  });

  it("a 402 on the paid retry (settle failed or still PENDING after broadcast) keeps the memo: the caller's retry re-sends the SAME nonce, never a second authorization ", async () => {
    const c = connectedClient();
    stubRelay();
    const xpayNonces: string[] = [];
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const xpay = xPaymentHeader(init);
      if (xpay) {
        xpayNonces.push(JSON.parse(Buffer.from(xpay, 'base64').toString('utf8')).payload.authorization.nonce);
        return xpayNonces.length === 1 ? r402() : r200WithReceipt();
      }
      return r402();
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
    await expect(wrapped(RESOURCE, { method: 'GET' })).rejects.toMatchObject({ code: 'X402_PAYMENT_REJECTED' });
    expect((await wrapped(RESOURCE, { method: 'GET' })).status).toBe(200);
    expect(xpayNonces).toHaveLength(2);
    // RED control: evicting the memo on the 402 signed a fresh nonce here — a second settleable
    // authorization while the first may already have been broadcast (`settlement_pending` is a 402).
    expect(xpayNonces[0]).toBe(xpayNonces[1]);
  });

  // #9: a facilitator that settles on-chain but hangs the HTTP response must not
  // hang the agent forever — the per-request timeout aborts and fails the retry.
  it('#9: a hung paid-retry response times out (X402_REQUEST_FAILED) instead of hanging forever', async () => {
    const c = connectedClient();
    stubRelay();
    const targetFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (xPaymentHeader(init)) {
        // The paid retry hangs until the timeout's AbortSignal fires.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return Promise.resolve(r402());
    });
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n,
      fetchFn: targetFetch as unknown as typeof fetch,
      requestTimeoutMs: 30,
    });
    await expect(wrapped(RESOURCE, { method: 'GET' })).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });
  });
});

describe('wrapFetchWithX402 — per-payment ceiling (F31)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  // A hostile 402 that demands a large amount (the drain scenario).
  function r402Hostile(amount: string): Response {
    return new Response(
      JSON.stringify({
        x402Version: 2,
        resource: { url: RESOURCE },
        accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  }

  it('refuses a 402 whose amount exceeds the ceiling and NEVER sends the paid retry', async () => {
    const c = connectedClient();
    const relayCalls = stubRelay();
    // The seller demands $5,000; the agent set a $1 ceiling.
    const targetFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => r402Hostile('5000000000'));
    const wrapped = c.wrapFetchWithX402(WALLET, {
      maxAmountAtomic: 1_000_000n, // $1
      fetchFn: targetFetch as unknown as typeof fetch,
    });
    await expect(wrapped(RESOURCE, { method: 'GET' })).rejects.toMatchObject({ code: 'X402_AMOUNT_EXCEEDS_CAP' });
    // Only the initial request happened — no signed paid retry, no PE.
    expect(targetFetch).toHaveBeenCalledTimes(1);
    expect(targetFetch.mock.calls.every(([, init]) => xPaymentHeader(init) === null)).toBe(true);
    expect(relayCalls).toEqual([]);
  });

  it('pays a 402 at exactly the ceiling', async () => {
    const c = connectedClient();
    stubRelay();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      xPaymentHeader(init) ? r200WithReceipt() : r402Hostile('10000'),
    );
    const wrapped = c.wrapFetchWithX402(WALLET, {
      maxAmountAtomic: 10_000n, // exactly equal to the demand
      fetchFn: targetFetch as unknown as typeof fetch,
    });
    const res = await wrapped(RESOURCE, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);
  });

  it('applies a per-host override above the global ceiling', async () => {
    const c = connectedClient();
    stubRelay();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      xPaymentHeader(init) ? r200WithReceipt() : r402Hostile('50000'), // $0.05
    );
    // Global ceiling $0.01 would refuse, but api.test is allowed up to $1.
    const wrapped = c.wrapFetchWithX402(WALLET, {
      maxAmountAtomic: 10_000n, // $0.01 global
      maxAmountAtomicPerHost: { 'api.test': 1_000_000n }, // $1 for this host
      fetchFn: targetFetch as unknown as typeof fetch,
    });
    const res = await wrapped(RESOURCE, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);
  });

  it('throws at wrap time when the ceiling is omitted (required, no unlimited default)', () => {
    const c = connectedClient();
    let code = '';
    try {
      // Untyped-JS caller omits maxAmountAtomic entirely.
      c.wrapFetchWithX402(WALLET, {} as unknown as { maxAmountAtomic: bigint });
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    expect(code).toBe('X402_CEILING_REQUIRED');
  });
});
