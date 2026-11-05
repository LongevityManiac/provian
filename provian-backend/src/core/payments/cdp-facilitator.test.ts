/**
 * Coinbase CDP's x402 facilitator client (the PE Archive's settler from the flip,).
 *
 * GREEN: the JWT is the shape `@coinbase/cdp-sdk` signs (EdDSA, `uris`, header nonce, 120 s) and
 * verifies under the key's public half; the settle body carries the relay's OWN requirement and
 * listing; a reported success with a well-formed hash returns that hash.
 * RED: every other reply THROWS — a refusal, an HTTP error, a non-JSON reply, a success without a
 * well-formed hash, a timeout — so the shared charge path keeps the charge unconfirmed and lets the
 * chain decide. A CDP answer is never treated as "paid" or as "not charged" by itself.
 */
import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import { cdpFacilitatorJwt, cdpSettleBody, createCdpFacilitator, CDP_FACILITATOR_HOST } from './cdp-facilitator';
import { usdcChargeRequirement, type UsdcChargePayment } from './usdc-charge';
import { ARCHIVE_SERVICE_TERMS, archiveAgentListing } from '../archive/archive-terms';

// A CDP-format Ed25519 secret: base64 of seed (32) + public key (32).
const keyPair = crypto.generateKeyPairSync('ed25519');
const seed = (keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
const pub = (keyPair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
const CREDS = { keyId: 'c49a339b-0000-4000-8000-000000000000', secret: Buffer.concat([seed, pub]).toString('base64') };

const PAYMENT: UsdcChargePayment = {
  signature: `0x${'11'.repeat(65)}`,
  authorization: {
    from: `0x${'22'.repeat(20)}`,
    to: '0x086e0f377af1245b8888540f39e99a42a7daf1da',
    value: '5000000',
    validAfter: '0',
    validBefore: '1791000300',
    nonce: `0x${'33'.repeat(32)}`,
  },
};
const REQUIREMENT = usdcChargeRequirement(ARCHIVE_SERVICE_TERMS);
const LISTING = archiveAgentListing('https://api.provian.ai/v1/archive/pay');
const TX = `0x${'AB'.repeat(32)}`;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

type Reply = { ok: boolean; status: number; body: string };
function facilitatorReturning(reply: Reply | (() => Promise<Reply>)) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const facilitator = createCdpFacilitator({
    creds: CREDS,
    nowSeconds: () => 1_791_000_000,
    timeoutMs: 50,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ?? '' });
      const r = typeof reply === 'function' ? await reply() : reply;
      return { ok: r.ok, status: r.status, text: async () => r.body };
    },
  });
  return { facilitator, calls };
}

describe('CDP x402 facilitator client', () => {
  it('GREEN: the JWT is EdDSA over the Secret API key, `uris` = POST host+path, nonce in the header, 120 s', () => {
    const token = cdpFacilitatorJwt(CREDS, 'POST', '/platform/v2/x402/settle', 1_791_000_000, 'ab'.repeat(16));
    const [h, c, sig] = token.split('.');
    expect(decode(h)).toEqual({ alg: 'EdDSA', kid: CREDS.keyId, typ: 'JWT', nonce: 'ab'.repeat(16) });
    expect(decode(c)).toEqual({
      sub: CREDS.keyId,
      iss: 'cdp',
      uris: [`POST ${CDP_FACILITATOR_HOST}/platform/v2/x402/settle`],
      iat: 1_791_000_000,
      nbf: 1_791_000_000,
      exp: 1_791_000_120,
    });
    expect(crypto.verify(null, Buffer.from(`${h}.${c}`), keyPair.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    // RED control: the same signature does not verify a different path's claims.
    const other = cdpFacilitatorJwt(CREDS, 'POST', '/platform/v2/x402/verify', 1_791_000_000, 'ab'.repeat(16)).split('.');
    expect(crypto.verify(null, Buffer.from(`${h}.${other[1]}`), keyPair.publicKey, Buffer.from(sig, 'base64url'))).toBe(false);
  });

  it("GREEN: the settle body is the relay's requirement, the payer's authorization, and the relay's listing", () => {
    const body = cdpSettleBody(PAYMENT, REQUIREMENT, LISTING);
    expect(body.x402Version).toBe(2);
    expect(body.paymentRequirements).toEqual(REQUIREMENT);
    const payload = body.paymentPayload as Record<string, unknown>;
    expect(payload.accepted).toEqual(REQUIREMENT);
    expect(payload.payload).toEqual({ signature: PAYMENT.signature, authorization: PAYMENT.authorization });
    expect(payload.resource).toEqual(LISTING.resource);
    expect(payload.extensions).toEqual(LISTING.extensions);
    // A listing without extensions sends none (the people's route never lists).
    const plain = cdpSettleBody(PAYMENT, REQUIREMENT, { resource: LISTING.resource }).paymentPayload as Record<string, unknown>;
    expect('extensions' in plain).toBe(false);
  });

  it('GREEN: success with a well-formed hash returns it, lowercased; the request is an authenticated POST to /settle', async () => {
    const { facilitator, calls } = facilitatorReturning({ ok: true, status: 200, body: JSON.stringify({ success: true, transaction: TX, network: 'eip155:8453', payer: PAYMENT.authorization.from }) });
    await expect(facilitator.settle(PAYMENT, REQUIREMENT, LISTING)).resolves.toBe(TX.toLowerCase());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/settle');
    expect(calls[0].headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(calls[0].body)).toEqual(cdpSettleBody(PAYMENT, REQUIREMENT, LISTING));
  });

  const refusals: [string, Reply, RegExp][] = [
    ['a refusal', { ok: true, status: 200, body: JSON.stringify({ success: false, errorReason: 'insufficient_funds' }) }, /cdp_settle_refused:insufficient_funds/],
    ['a 400 with a refusal body', { ok: false, status: 400, body: JSON.stringify({ success: false, errorReason: 'invalid_payload' }) }, /cdp_settle_http_400/],
    ['a 500', { ok: false, status: 500, body: 'upstream' }, /cdp_settle_http_500/],
    ['a 401 (key not accepted)', { ok: false, status: 401, body: 'Unauthorized' }, /cdp_settle_http_401/],
    ['a non-JSON 200', { ok: true, status: 200, body: '<html>' }, /cdp_settle_reply_not_json/],
    ['success without a hash', { ok: true, status: 200, body: JSON.stringify({ success: true }) }, /cdp_settle_transaction_malformed/],
    ['success with a short hash', { ok: true, status: 200, body: JSON.stringify({ success: true, transaction: '0xabc' }) }, /cdp_settle_transaction_malformed/],
    ['success as a string', { ok: true, status: 200, body: JSON.stringify({ success: 'true', transaction: TX }) }, /cdp_settle_refused/],
  ];
  for (const [name, reply, error] of refusals) {
    it(`RED: ${name} throws (the chain decides; never "paid", never "not charged")`, async () => {
      const { facilitator } = facilitatorReturning(reply);
      await expect(facilitator.settle(PAYMENT, REQUIREMENT, LISTING)).rejects.toThrow(error);
    });
  }

  it('RED: a CDP that never answers is aborted and throws', async () => {
    const facilitator = createCdpFacilitator({
      creds: CREDS,
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    await expect(facilitator.settle(PAYMENT, REQUIREMENT, LISTING)).rejects.toThrow('aborted');
  });
});
