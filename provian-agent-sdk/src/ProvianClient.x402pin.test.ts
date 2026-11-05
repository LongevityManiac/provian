/**
 * Pinned x402 payments (PE Archive human-path follow-up, 2026-10-07): the agent's `provian archive pay`
 * and `provian payout` pay Provian's own fees, whose terms the SDK already knows. With `pinnedPayment`
 * the wrapper signs only an option naming exactly those terms (Base, Base USDC, Provian's revenue
 * wallet, the exact amount) and refuses anything else before the key signs. Each refusal has its RED
 * beside it: the same 402 is signed when the pin is absent, so the pin is what refuses it.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProvianClient } from './ProvianClient';
import {
  ARCHIVE_GB_FEE_USDC_ATOMIC,
  PAYOUT_FEE_USDC_ATOMIC,
  PROVIAN_SERVICE_FEE_RECIPIENT,
  provianServiceFeePin,
} from './commons-institutions';
import { getX402Network } from './x402-signer';

// Deterministic test wallet (NOT real). Same key as ProvianClient.x402.test.ts.
const WALLET = {
  privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
};
const BASE = 'eip155:8453';
const SEPOLIA = 'eip155:84532';
const BASE_USDC = getX402Network(BASE)!.usdcAddress;
const SEPOLIA_USDC = getX402Network(SEPOLIA)!.usdcAddress;
const ATTACKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const URL_ = 'https://relay.test/v1/archive/pay';

interface Option { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string }

function the402(options: Option[]): Response {
  const accepts = options.map((o) => ({
    scheme: 'exact', network: BASE, amount: ARCHIVE_GB_FEE_USDC_ATOMIC.toString(), asset: BASE_USDC,
    payTo: PROVIAN_SERVICE_FEE_RECIPIENT, maxTimeoutSeconds: 300, ...o,
  }));
  return new Response(JSON.stringify({ x402Version: 2, resource: { url: URL_ }, accepts }), {
    status: 402, headers: { 'content-type': 'application/json' },
  });
}

function seller(options: Option[]) {
  return vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
    new Headers(init?.headers).get('PAYMENT-SIGNATURE') ? new Response('ok', { status: 200 }) : the402(options));
}

function signedTerms(fetchFn: ReturnType<typeof seller>): { network: string; payTo: string; amount: string } {
  const header = new Headers((fetchFn.mock.calls[1][1] as RequestInit).headers).get('PAYMENT-SIGNATURE')!;
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  return { network: decoded.accepted.network, payTo: decoded.payload.authorization.to, amount: decoded.payload.authorization.value };
}

const client = () => new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'agent-1' });
const pinned = (fetchFn: unknown) => client().wrapFetchWithX402(WALLET, {
  maxAmountAtomic: ARCHIVE_GB_FEE_USDC_ATOMIC, pinnedPayment: provianServiceFeePin(ARCHIVE_GB_FEE_USDC_ATOMIC), fetchFn: fetchFn as typeof fetch,
});
const unpinned = (fetchFn: unknown) => client().wrapFetchWithX402(WALLET, {
  maxAmountAtomic: ARCHIVE_GB_FEE_USDC_ATOMIC, fetchFn: fetchFn as typeof fetch,
});

describe('wrapFetchWithX402 pinnedPayment', () => {
  it('the pin names Provian\'s revenue wallet on Base mainnet for both fees', () => {
    expect(PROVIAN_SERVICE_FEE_RECIPIENT.toLowerCase()).toBe('0x086e0f377af1245b8888540f39e99a42a7daf1da');
    expect(provianServiceFeePin(PAYOUT_FEE_USDC_ATOMIC)).toEqual({ network: BASE, payTo: PROVIAN_SERVICE_FEE_RECIPIENT, amountAtomic: 1_000_000n });
    expect(provianServiceFeePin(ARCHIVE_GB_FEE_USDC_ATOMIC).amountAtomic).toBe(5_000_000n);
  });

  it('signs the exact pinned terms', async () => {
    const f = seller([{}]);
    expect((await pinned(f)(URL_, { method: 'POST' })).status).toBe(200);
    expect(signedTerms(f)).toEqual({ network: BASE, payTo: PROVIAN_SERVICE_FEE_RECIPIENT, amount: '5000000' });
  });

  it('picks the matching option even when a non-matching one comes first', async () => {
    const f = seller([{ payTo: ATTACKER }, {}]);
    await pinned(f)(URL_, { method: 'POST' });
    expect(signedTerms(f).payTo.toLowerCase()).toBe(PROVIAN_SERVICE_FEE_RECIPIENT.toLowerCase());
  });

  const refusals: Array<[string, Option]> = [
    ['another recipient', { payTo: ATTACKER }],
    ['a lower amount', { amount: '4999999' }],
    ['a testnet', { network: SEPOLIA, asset: SEPOLIA_USDC }],
    ['a testnet naming mainnet USDC', { network: SEPOLIA }],
    ['another token', { asset: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' }],
  ];

  for (const [what, option] of refusals) {
    it(`refuses ${what} before signing; RED: without the pin the same 402 is signed`, async () => {
      const f = seller([option]);
      await expect(pinned(f)(URL_, { method: 'POST' })).rejects.toMatchObject({ code: 'X402_NO_COMPATIBLE_OPTION' });
      expect(f).toHaveBeenCalledTimes(1); // never retried with a signature

      // Not that network's USDC: refused with or without the pin.
      if (option.asset === '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' || (option.network === SEPOLIA && !option.asset)) return;
      const g = seller([option]);
      expect((await unpinned(g)(URL_, { method: 'POST' })).status).toBe(200);
      expect(g).toHaveBeenCalledTimes(2);
    });
  }

  it('refuses malformed pins when the fetch is built', () => {
    for (const bad of [
      { network: 'eip155:1', payTo: PROVIAN_SERVICE_FEE_RECIPIENT, amountAtomic: 1n },
      { network: BASE, payTo: 'nope', amountAtomic: 1n },
      { network: BASE, payTo: PROVIAN_SERVICE_FEE_RECIPIENT, amountAtomic: 0n },
    ]) {
      expect(() => client().wrapFetchWithX402(WALLET, { maxAmountAtomic: 1n, pinnedPayment: bad }))
        .toThrowError(expect.objectContaining({ code: 'X402_PINNED_PAYMENT_INVALID' }));
    }
  });
});
