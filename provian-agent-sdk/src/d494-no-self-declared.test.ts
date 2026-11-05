/**
 * the SDK exposes no path for an agent to declare its own work.
 *
 * "An agent declaring its own work has no path to a PE, minting or record-only." The public
 * report APIs (reportAction / reportWorkProduct / queueAction / submitSovereignWork /
 * recordLinkSpend, the standalone recordLinkSpend, the x402 sovereign PE builders) are gone,
 * and wrapFetchWithX402 records no x402_payment PE — the chain watcher witnesses the
 * settlement. The observer daemon's lanes still record through an internal, non-exported
 * submitter (observed-submit.ts), which is not reachable from the package entry point.
 *
 * RED control: against the pre- SDK, the public-surface assertions fail (the methods and
 * exports exist) and the x402 test observes a POST to /v1/pe/submit-sovereign.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProvianClient } from './ProvianClient';
import * as sdk from './index';

const WALLET = {
  privateKeyHex: '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d',
  address: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1',
};
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RESOURCE = 'https://api.test/resource';

const REMOVED_CLIENT_METHODS = [
  'reportAction', 'reportWorkProduct', 'queueAction', 'submitSovereignWork', 'recordLinkSpend',
  'recordX402PaymentPE', 'submitSovereignX402PE',
];
const REMOVED_EXPORTS = [
  'submitSovereignWork', 'recordLinkSpend', 'signSovereignPE', 'buildSovereignPECanonicalMessage',
  'SOVEREIGN_PE_CANONICAL_TAG', 'signSovereignWork',
];

describe('the SDK has no self-declaration API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ProvianClient exposes none of the report methods (device or sovereign mode)', () => {
    const device = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'a', deviceKey: 'pdk_x', deviceSecret: 'pds_y' });
    const sovereign = new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'a' });
    for (const client of [device, sovereign]) {
      const surface = client as unknown as Record<string, unknown>;
      for (const name of REMOVED_CLIENT_METHODS) expect(surface[name], name).toBeUndefined();
    }
  });

  it('the package entry point exports no self-declaration helper', () => {
    const exported = sdk as unknown as Record<string, unknown>;
    expect(Object.keys(exported).length).toBeGreaterThan(20);
    for (const name of REMOVED_EXPORTS) expect(exported[name], name).toBeUndefined();
  });

  it('a paid x402 request records NO PE on any relay route (the chain witnesses x402)', async () => {
    const relayCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      relayCalls.push(String(url));
      return new Response(JSON.stringify({ pe_id: 'pe_should_not_exist', recorded: true }), { status: 201 });
    }));
    const receipt = { success: true, payer: WALLET.address, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:8453' };
    const targetFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get('PAYMENT-SIGNATURE')) {
        return new Response('ok', { status: 200, headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(receipt)).toString('base64') } });
      }
      return new Response(JSON.stringify({
        x402Version: 2, resource: { url: RESOURCE },
        accepted: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
      }), { status: 402, headers: { 'content-type': 'application/json' } });
    });
    for (const client of [
      new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'a', deviceKey: 'pdk_x', deviceSecret: 'pds_y' }),
      new ProvianClient({ relayUrl: 'https://relay.test', agentId: 'a' }),
    ]) {
      const wrapped = client.wrapFetchWithX402(WALLET, { maxAmountAtomic: 100_000_000n, fetchFn: targetFetch as unknown as typeof fetch });
      const res = await wrapped(RESOURCE, { method: 'GET' });
      expect(res.status).toBe(200);
    }
    expect(relayCalls.filter((u) => u.includes('/v1/pe/'))).toEqual([]);
  });
});
