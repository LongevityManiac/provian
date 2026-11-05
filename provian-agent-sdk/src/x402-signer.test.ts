/**
 * Tests for the agent-side x402 EIP-3009 signer.
 *
 * The hand-rolled EIP-712 (keccak256 + @noble/curves) is verified byte-exact
 * against ethers (a dev-only oracle, same approach as link-signing.test.ts):
 *   - the 0x1901 signing digest matches ethers.TypedDataEncoder.hash
 *   - the produced signature is byte-identical to ethers Wallet.signTypedData
 *     (RFC-6979 deterministic ECDSA, canonical lowS) and recovers the signer
 *     via ethers.verifyTypedData
 * for BOTH Base mainnet ('USD Coin') and Base Sepolia ('USDC') USDC domains.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  signX402Payment,
  buildPaymentHeader,
  eip712Digest,
  getX402Network,
  X402_NETWORKS,
  selectCompatibleRequirement,
  decodePaymentResponse,
  getAgentUsdcBalance,
  getAgentPvtBalance,
  getErc20Balance,
  type PaymentRequirement,
  type PaymentRequired,
} from './x402-signer';
import { getToken } from './evm-allowlist';

// Deterministic test key (NOT a real wallet). Same as link-signing.test.ts.
const TEST_PRIV_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const TEST_ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// Fixed nonce + time for deterministic signatures.
const FIXED_NONCE = Buffer.from('a'.repeat(64), 'hex');
const FIXED_NOW = 1_750_000_000;

// Generous per-payment ceiling for the byte-exact / behavior tests (F31). The
// cap-enforcement negative controls below call signX402Payment directly.
const MAX_ATOMIC = 100_000_000n; // 100 USDC
function signWithCap(
  args: Omit<Parameters<typeof signX402Payment>[0], 'maxAmountAtomic'> & { maxAmountAtomic?: bigint },
): ReturnType<typeof signX402Payment> {
  return signX402Payment({ maxAmountAtomic: MAX_ATOMIC, ...args });
}

const EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function requirement(network: string, asset: string): PaymentRequirement {
  return { scheme: 'exact', network, amount: '10000', asset, payTo: PAY_TO, maxTimeoutSeconds: 120 };
}

describe('signX402Payment — EIP-3009 EIP-712 vs ethers (byte-exact)', () => {
  for (const [network, usdc] of [
    ['eip155:8453', BASE_MAINNET_USDC],
    ['eip155:84532', BASE_SEPOLIA_USDC],
  ] as const) {
    const net = getX402Network(network)!;

    it(`digest + signature match ethers for ${network} (${net.usdcDomainName})`, async () => {
      const signed = signWithCap({
        privateKeyHex: TEST_PRIV_KEY,
        fromAddress: TEST_ADDRESS,
        requirement: requirement(network, usdc),
        nowSeconds: FIXED_NOW,
        nonce: FIXED_NONCE,
      });

      // Validity window derives from the clamped timeout.
      expect(signed.authorization.validAfter).toBe('0');
      expect(signed.authorization.validBefore).toBe(String(FIXED_NOW + 120));
      expect(signed.authorization.nonce).toBe(`0x${'a'.repeat(64)}`);

      const domain = {
        name: net.usdcDomainName,
        version: net.usdcDomainVersion,
        chainId: net.chainId,
        verifyingContract: net.usdcAddress,
      };

      // 1. Digest is byte-exact with ethers.
      const ethersDigest = ethers.TypedDataEncoder.hash(domain, EIP712_TYPES, signed.authorization);
      const myDigest = '0x' + eip712Digest(net, signed.authorization).toString('hex');
      expect(myDigest).toBe(ethersDigest);

      // 2. Signature is byte-identical to ethers (deterministic ECDSA, lowS).
      const ethersSig = await new ethers.Wallet(TEST_PRIV_KEY).signTypedData(
        domain,
        EIP712_TYPES,
        signed.authorization,
      );
      expect(signed.signature).toBe(ethersSig);

      // 3. Recovers the signer.
      const recovered = ethers.verifyTypedData(domain, EIP712_TYPES, signed.authorization, signed.signature);
      expect(recovered).toBe(TEST_ADDRESS);
      expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    });
  }

  it('random nonce differs per call but stays a valid signature', () => {
    const a = signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: requirement('eip155:8453', BASE_MAINNET_USDC) });
    const b = signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: requirement('eip155:8453', BASE_MAINNET_USDC) });
    expect(a.authorization.nonce).not.toBe(b.authorization.nonce);
    expect(a.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('clamps maxTimeoutSeconds to 300', () => {
    const signed = signWithCap({
      privateKeyHex: TEST_PRIV_KEY,
      fromAddress: TEST_ADDRESS,
      requirement: { ...requirement('eip155:8453', BASE_MAINNET_USDC), maxTimeoutSeconds: 99999 },
      nowSeconds: FIXED_NOW,
      nonce: FIXED_NONCE,
    });
    expect(signed.authorization.validBefore).toBe(String(FIXED_NOW + 300));
  });
});

describe('signX402Payment — rejections', () => {
  const base = requirement('eip155:8453', BASE_MAINNET_USDC);

  it('rejects a non-exact scheme', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: { ...base, scheme: 'upto' as unknown as 'exact' } })).toThrow(/scheme/);
  });
  it('rejects an unsupported network', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: { ...base, network: 'eip155:1' } })).toThrow(/network/);
  });
  it('rejects an asset that is not the network USDC', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: { ...base, asset: PAY_TO } })).toThrow(/USDC/);
  });
  it('rejects a malformed payTo', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: { ...base, payTo: '0xdead' } })).toThrow(/payTo/);
  });
  it('rejects a non-positive amount', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: { ...base, amount: '0' } })).toThrow(/positive/);
  });
  it('rejects a key that does not control fromAddress', () => {
    expect(() => signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: PAY_TO, requirement: base })).toThrow(/does not match/);
  });
  it('rejects a malformed private key', () => {
    expect(() => signWithCap({ privateKeyHex: '0xdeadbeef', fromAddress: TEST_ADDRESS, requirement: base })).toThrow(/32 bytes/);
  });
});

describe('signX402Payment — per-payment ceiling (F31)', () => {
  // RED negative controls: on the pre-fix signer these signed and returned a
  // valid authorization for ANY seller-supplied amount. The ceiling is required
  // and enforced BEFORE signing.
  const drain = requirement('eip155:8453', BASE_MAINNET_USDC); // amount '10000'

  it('refuses an amount above the ceiling before signing (X402_AMOUNT_EXCEEDS_CAP)', () => {
    let code = '';
    try {
      signX402Payment({
        privateKeyHex: TEST_PRIV_KEY,
        fromAddress: TEST_ADDRESS,
        requirement: { ...drain, amount: '5000000000' }, // $5,000 hostile 402
        maxAmountAtomic: 1_000_000n, // $1 ceiling
      });
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    expect(code).toBe('X402_AMOUNT_EXCEEDS_CAP');
  });

  it('signs an amount at exactly the ceiling', () => {
    const signed = signX402Payment({
      privateKeyHex: TEST_PRIV_KEY,
      fromAddress: TEST_ADDRESS,
      requirement: { ...drain, amount: '10000' },
      maxAmountAtomic: 10_000n, // exactly equal
      nowSeconds: FIXED_NOW,
      nonce: FIXED_NONCE,
    });
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('refuses when no ceiling is supplied (required, no unlimited default)', () => {
    let code = '';
    try {
      // Untyped-JS caller path: omit maxAmountAtomic entirely.
      signX402Payment({
        privateKeyHex: TEST_PRIV_KEY,
        fromAddress: TEST_ADDRESS,
        requirement: drain,
      } as unknown as Parameters<typeof signX402Payment>[0]);
      throw new Error('SHOULD_HAVE_THROWN');
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      expect((e as Error).message).not.toBe('SHOULD_HAVE_THROWN');
    }
    expect(code).toBe('X402_CEILING_REQUIRED');
  });

  it('refuses a non-positive ceiling', () => {
    expect(() =>
      signX402Payment({
        privateKeyHex: TEST_PRIV_KEY,
        fromAddress: TEST_ADDRESS,
        requirement: drain,
        maxAmountAtomic: 0n,
      }),
    ).toThrow(/positive integer/);
  });
});

describe('buildPaymentHeader / network table / helpers', () => {
  it('encodes the v2 base64 PaymentPayload envelope: chosen requirement echoed under `accepted`, no top-level scheme/network', () => {
    const req = requirement('eip155:8453', BASE_MAINNET_USDC);
    const signed = signWithCap({ privateKeyHex: TEST_PRIV_KEY, fromAddress: TEST_ADDRESS, requirement: req, nowSeconds: FIXED_NOW, nonce: FIXED_NONCE });
    const header = buildPaymentHeader(signed, req);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    // v2 wire shape (official @x402/core PaymentPayloadV2Schema): the selected
    // requirement rides under `accepted`; top-level scheme/network are v1-isms
    // that live sellers reject.
    expect(decoded.accepted).toEqual(req);
    expect(decoded.scheme).toBeUndefined();
    expect(decoded.network).toBeUndefined();
    expect(decoded.payload.signature).toBe(signed.signature);
    expect(decoded.payload.authorization.from).toBe(TEST_ADDRESS);
  });

  it('getX402Network returns null for unsupported networks', () => {
    expect(getX402Network('eip155:1')).toBeNull();
    expect(getX402Network('eip155:8453')).not.toBeNull();
    expect(Object.keys(X402_NETWORKS)).toEqual(['eip155:8453', 'eip155:84532']);
  });

  it('selectCompatibleRequirement picks the USDC/exact/Base option (case-insensitive asset)', () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://api.test/x' },
      accepted: [
        { scheme: 'exact', network: 'eip155:1', amount: '1', asset: BASE_MAINNET_USDC, payTo: PAY_TO },
        { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: BASE_MAINNET_USDC.toUpperCase().replace('0X', '0x'), payTo: PAY_TO },
      ],
    };
    const chosen = selectCompatibleRequirement(pr);
    expect(chosen.network).toBe('eip155:8453');
  });

  it('selectCompatibleRequirement throws when nothing is compatible', () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://api.test/x' },
      accepted: [{ scheme: 'exact', network: 'eip155:1', amount: '1', asset: PAY_TO, payTo: PAY_TO }],
    };
    expect(() => selectCompatibleRequirement(pr)).toThrow(/supported/);
  });

  it('selectCompatibleRequirement reads the WIRE field `accepts` (live-seller shape, LIVE-VERIFY 2026-07-08)', () => {
    // Mirrors the real 402 from a Bazaar-indexed Base-mainnet seller
    // (x402.ottoai.services): `accepts` array, multi-network, permit2 variant
    // included. The SDK previously read only `accepted` — a key no live 402
    // carries — and threw X402_NO_COMPATIBLE_OPTION against every real seller.
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://x402.example/crypto-news', description: 'news', mimeType: 'application/json' },
      accepts: [
        { scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: BASE_MAINNET_USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
        { scheme: 'exact', network: 'eip155:137', amount: '1000', asset: PAY_TO, payTo: PAY_TO },
      ],
    };
    const chosen = selectCompatibleRequirement(pr);
    expect(chosen.network).toBe('eip155:8453');
    expect(chosen.amount).toBe('1000');
  });

  it('decodePaymentResponse reads the base64 receipt header', () => {
    const receipt = { success: true, payer: TEST_ADDRESS, transaction: '0xabc', network: 'eip155:8453' };
    const res = new Response('ok', {
      status: 200,
      headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify(receipt)).toString('base64') },
    });
    expect(decodePaymentResponse(res)?.transaction).toBe('0xabc');
    expect(decodePaymentResponse(new Response('ok', { status: 200 }))).toBeNull();
  });

  it('getAgentUsdcBalance issues an eth_call balanceOf and parses the result', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('eth_call');
      expect(body.params[0].to).toBe(getX402Network('eip155:8453')!.usdcAddress);
      expect(body.params[0].data.startsWith('0x70a08231')).toBe(true);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0f4240' }), { status: 200 });
    });
    const bal = await getAgentUsdcBalance('https://rpc.test', TEST_ADDRESS, 'eip155:8453', fetchMock as unknown as typeof fetch);
    expect(bal).toBe(1_000_000n); // 0x0f4240
  });

  it('getAgentPvtBalance reads the PINNED PVT token (not a caller/relay-supplied address) and parses atomic 18-dp units', async () => {
    const pinnedPvt = getToken('base', 'PVT').address;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('eth_call');
      // The read is pointed at the SDK's own pinned PVT9 token — a spoofed token
      // cannot be injected via the call. This is the "cannot be pointed at a
      // spoofed token" guarantee.
      expect(body.params[0].to).toBe(pinnedPvt);
      expect(body.params[0].data.startsWith('0x70a08231')).toBe(true); // balanceOf
      // 1185.58 PVT in atomic 18-dp units → 0x404ad7...
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_185_580_000_000_000_000_000n).toString(16) }), { status: 200 });
    });
    const bal = await getAgentPvtBalance('https://rpc.test', TEST_ADDRESS, 'base', fetchMock as unknown as typeof fetch);
    expect(bal).toBe(1_185_580_000_000_000_000_000n);
    expect(Number(bal) / 1e18).toBeCloseTo(1185.58, 2);
  });

  it('getErc20Balance treats an empty (0x) result as zero — a configured token an agent simply has none of', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), { status: 200 }));
    const bal = await getErc20Balance('https://rpc.test', BASE_MAINNET_USDC, TEST_ADDRESS, fetchMock as unknown as typeof fetch);
    expect(bal).toBe(0n);
  });

  // RED control : a fail-visible read. An RPC-level error must THROW, never
  // silently read as a zero balance (which would misreport "agent holds nothing").
  it('RED control — an RPC error result throws (never a silent zero), and a malformed token address is refused', async () => {
    const errFetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }), { status: 200 }));
    await expect(getErc20Balance('https://rpc.test', BASE_MAINNET_USDC, TEST_ADDRESS, errFetch as unknown as typeof fetch))
      .rejects.toThrow(/balanceOf RPC error/);
    // A malformed token address is refused before any network call.
    const neverCalled = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(getErc20Balance('https://rpc.test', '0xnothex', TEST_ADDRESS, neverCalled as unknown as typeof fetch))
      .rejects.toThrow(/invalid token address/);
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
