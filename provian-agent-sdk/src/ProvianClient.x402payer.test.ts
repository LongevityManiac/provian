vi.mock('./protocol-runtime', async () => (await import('./__test-helpers__/protocol-runtime.js')).protocolRuntimeFixture);
/**
 * A signed x402 authorization is reused only for the wallet that signed it. Two wallets paying
 * the same resource through one client must each send their own payment.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { ProvianClient } from './ProvianClient';

const KEY_A = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const KEY_B = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const WALLET_A = { privateKeyHex: KEY_A, address: new ethers.Wallet(KEY_A).address };
const WALLET_B = { privateKeyHex: KEY_B, address: new ethers.Wallet(KEY_B).address };
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RESOURCE = 'https://api.test/resource';

const r402 = (): Response => new Response(JSON.stringify({
  x402Version: 2, resource: { url: RESOURCE },
  accepted: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
}), { status: 402, headers: { 'content-type': 'application/json' } });

function paymentHeader(init: RequestInit | undefined): string | null {
  const h = new Headers(init?.headers);
  return h.get('PAYMENT-SIGNATURE') ?? h.get('X-PAYMENT');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('wrapFetchWithX402 — the reuse memo is per paying wallet', () => {
  it('a second wallet paying the same resource sends its own authorization, never the first wallet\'s', async () => {
    expect(WALLET_A.address).not.toBe(WALLET_B.address);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the relay must not be called'); }));
    const client = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1' });
    const sent: Array<{ from: string; nonce: string }> = [];
    const target = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const header = paymentHeader(init);
      if (!header) return r402();
      const { from, nonce } = JSON.parse(Buffer.from(header, 'base64').toString('utf8')).payload.authorization as { from: string; nonce: string };
      sent.push({ from, nonce });
      // An ambiguous outcome keeps the signed authorization for a retry by the same payer.
      return new Response('upstream died', { status: 503 });
    });
    const options = { maxAmountAtomic: 100_000_000n, fetchFn: target as unknown as typeof fetch };
    await expect(client.wrapFetchWithX402(WALLET_A, options)(RESOURCE)).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });
    await expect(client.wrapFetchWithX402(WALLET_B, options)(RESOURCE)).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });
    await expect(client.wrapFetchWithX402(WALLET_A, options)(RESOURCE)).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED' });

    expect(sent).toHaveLength(3);
    expect(sent[0].from.toLowerCase()).toBe(WALLET_A.address.toLowerCase());
    expect(sent[1].from.toLowerCase()).toBe(WALLET_B.address.toLowerCase());
    expect(sent[1].nonce).not.toBe(sent[0].nonce);
    // The first wallet's own retry still reuses its own single-use nonce.
    expect(sent[2]).toEqual(sent[0]);
  });
});
