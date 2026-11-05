import { createCipheriv, createHmac, randomBytes } from 'crypto';
import { openPrivateAuthenticatedRequest, PRIVATE_PRICING_SCHEMA } from './private-pricing';

const secret = 'test-only-device-credential';

function sealedRequest(path: string, request: unknown): Record<string, unknown> {
  const nonce = randomBytes(12);
  const key = createHmac('sha256', secret).update('provian-private-pricing-key:v1').digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${PRIVATE_PRICING_SCHEMA}\0provian-private-request:v1:${path}`));
  const data = Buffer.concat([cipher.update(JSON.stringify({ request })), cipher.final(), cipher.getAuthTag()]);
  return { schema: PRIVATE_PRICING_SCHEMA, nonce: nonce.toString('hex'), data: data.toString('hex') };
}

function transit(copies: number): Record<string, unknown> {
  return {
    batch_hash: 'a'.repeat(64),
    sealed: Array.from({ length: copies }, (_, i) => ({
      to: 'linked_human', pe_id: `pe_${i}`, box: 'x'.repeat(8192),
    })),
  };
}

function open(path: string, request: unknown): unknown {
  const req = { originalUrl: path, body: { private_request: sealedRequest(path, request) } };
  openPrivateAuthenticatedRequest(req, secret);
  return req.body;
}

describe('authenticated transit request size', () => {
  it.each([22, 192])('opens a real-shaped %i-copy batch above the ordinary request limit', copies => {
    const request = transit(copies);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(100 * 1024);
    expect(open('/v1/meter/transit', request)).toEqual(request);
  });

  it('refuses transit above the existing two-megabyte logical batch limit', () => {
    const request = transit(257);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(2 * 1024 * 1024);
    expect(() => open('/v1/meter/transit', request)).toThrow('private_request_transport_limit');
  });

  it.each(['/v1/commons/threads/send', '/v1/meter/transit/other', '/v1/meter/transit-other'])(
    'keeps the ordinary limit at %s', path => {
      expect(() => open(path, transit(22))).toThrow('private_request_transport_limit');
    },
  );

  it('keeps the existing archive allowance', () => {
    const request = transit(22);
    expect(open('/v1/archive/device/parts', request)).toEqual(request);
  });

  it('still refuses a request sealed for a different route', () => {
    const req = {
      originalUrl: '/v1/meter/transit',
      body: { private_request: sealedRequest('/v1/commons/threads/send', transit(22)) },
    };
    expect(() => openPrivateAuthenticatedRequest(req, secret)).toThrow();
  });
});
