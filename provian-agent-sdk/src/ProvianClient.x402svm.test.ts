/**
 * wrapFetchWithX402 — the Solana (SVM) branch, end-to-end.
 *
 * ProvianClient no longer statically imports the Solana signer; it lazy-loads it
 * via dynamic import() the first time a wrapped fetch handles a Solana 402 (so
 * @solana/web3.js stays out of the lean bootstrap bundle). This suite proves
 * that lazy path actually resolves and signs through wrapFetchWithX402 — the
 * behavior the static-import version had, now behind the dynamic load — so the
 * bundle optimization did not quietly break Solana x402.
 *
 * RED control: a Solana 402 whose asset is NOT the pinned USDC mint must fail
 * closed (X402_NO_COMPATIBLE_OPTION), proving the accept path is not hardwired.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ProvianClient } from './ProvianClient';
import { PROVIAN_SOLANA_FACILITATOR_FEE_WALLET } from './x402-signer-svm';

const WALLET = {
  privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
};
const SOL_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const RESOURCE = 'https://api.test/solana-resource';

function svm402(asset = SOL_USDC, provianFee?: Record<string, unknown>): Response {
  const extra: Record<string, unknown> = { feePayer: FEE_PAYER };
  if (provianFee !== undefined) extra.provianFee = provianFee;
  const body = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [
      { scheme: 'exact', network: SOL_MAINNET, amount: '1000000', asset, payTo: PAY_TO, extra },
    ],
  };
  return new Response(JSON.stringify(body), { status: 402, headers: { 'content-type': 'application/json' } });
}

function connectedClient(): ProvianClient {
  const c = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1' });
  (c as unknown as { connected: boolean; sessionId: string }).connected = true;
  (c as unknown as { connected: boolean; sessionId: string }).sessionId = 'sess-1';
  return c;
}

// The SVM signer fetches a recent blockhash from the pinned Solana RPC via the
// GLOBAL fetch. Stub it so signing is deterministic and offline.
function stubBlockhashRpc(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      if (bodyStr.includes('getLatestBlockhash')) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: BLOCKHASH } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected global fetch: ${String(_url)}`);
    }),
  );
}

function paymentHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('PAYMENT-SIGNATURE');
}

describe('wrapFetchWithX402 — Solana (lazy-loaded SVM signer)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pays a Solana 402 by lazy-loading the SVM signer and replays a valid PAYMENT-SIGNATURE', async () => {
    stubBlockhashRpc();
    const c = connectedClient();

    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return paymentHeader(init)
        ? new Response('ok', { status: 200 })
        : svm402();
    });

    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n,
      fetchFn: targetFetch as unknown as typeof fetch,
      recordPE: false, // isolate the payment path from PE recording
    });
    const res = await wrapped(RESOURCE, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(targetFetch).toHaveBeenCalledTimes(2);

    // The paid retry carried a well-formed SVM payment for the Solana network.
    const retryInit = targetFetch.mock.calls[1][1] as RequestInit;
    expect(retryInit.redirect).toBe('manual');
    const header = paymentHeader(retryInit)!;
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe(SOL_MAINNET);
    expect(typeof decoded.payload.transaction).toBe('string');

    // And it's a real partially-signed versioned tx (decodes; fee payer first).
    const vtx = VersionedTransaction.deserialize(
      new Uint8Array(Buffer.from(decoded.payload.transaction, 'base64')),
    );
    expect(vtx.message.staticAccountKeys[0].toBase58()).toBe(FEE_PAYER);
  });

  it('RED CONTROL: a Solana 402 whose asset is not the pinned USDC mint fails closed', async () => {
    stubBlockhashRpc();
    const c = connectedClient();
    const targetFetch = vi.fn(async () => svm402('So11111111111111111111111111111111111111112'));
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n,
      fetchFn: targetFetch as unknown as typeof fetch,
      recordPE: false,
    });
    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_NO_COMPATIBLE_OPTION' });
    // Never even reached the paid retry.
    expect(targetFetch).toHaveBeenCalledTimes(1);
  });
});

describe('wrapFetchWithX402 — Solana Provian facilitator fee', () => {
  afterEach(() => vi.unstubAllGlobals());
  const FEE = { amount: '10000', payTo: PROVIAN_SOLANA_FACILITATOR_FEE_WALLET, asset: SOL_USDC, quote: 'q1' };

  function wrapWith(fee: Record<string, unknown>, maxAmountAtomic: bigint) {
    stubBlockhashRpc();
    const c = connectedClient();
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      paymentHeader(init) ? new Response('ok', { status: 200 }) : svm402(SOL_USDC, fee),
    );
    const wrapped = c.wrapFetchWithX402(WALLET, { maxAmountAtomic, fetchFn: targetFetch as unknown as typeof fetch });
    return { wrapped, targetFetch };
  }

  it('pays with the fee TransferChecked at index 3 and echoes the quote under accepted.extra', async () => {
    const { wrapped, targetFetch } = wrapWith(FEE, 100_000_000n);
    const res = await wrapped(RESOURCE);
    expect(res.status).toBe(200);
    const header = paymentHeader(targetFetch.mock.calls[1][1] as RequestInit)!;
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.accepted.extra.provianFee.quote).toBe('q1');
    const vtx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(decoded.payload.transaction, 'base64')));
    const ixs = vtx.message.compiledInstructions;
    expect(ixs).toHaveLength(5);
    expect(Buffer.from(ixs[3].data).readBigUInt64LE(1)).toBe(10_000n);
  });

  it('RED: a hostile provianFee.payTo is refused with X402_PROVIAN_FEE_REFUSED before any paid retry', async () => {
    const { wrapped, targetFetch } = wrapWith({ ...FEE, payTo: PAY_TO }, 100_000_000n);
    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_PROVIAN_FEE_REFUSED' });
    expect(targetFetch).toHaveBeenCalledTimes(1);
  });

  it('RED: amount + fee over the ceiling is refused (amount alone fits) before any paid retry', async () => {
    const { wrapped, targetFetch } = wrapWith(FEE, 1_005_000n);
    await expect(wrapped(RESOURCE)).rejects.toMatchObject({ code: 'X402_AMOUNT_EXCEEDS_CAP' });
    expect(targetFetch).toHaveBeenCalledTimes(1);
    // Control: the same ceiling pays the same request when no fee is named.
    stubBlockhashRpc();
    const c = connectedClient();
    const noFeeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      paymentHeader(init) ? new Response('ok', { status: 200 }) : svm402(),
    );
    const ok = c.wrapFetchWithX402(WALLET, { maxAmountAtomic: 1_005_000n, fetchFn: noFeeFetch as unknown as typeof fetch });
    expect((await ok(RESOURCE)).status).toBe(200);
  });
});
