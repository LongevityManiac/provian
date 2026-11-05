/**
 * Launch listings — the one place a route's CDP listing is chosen. Only the agent
 * pay route is a public x402 resource: its 402 and its CDP settlement carry the Bazaar extension.
 * The person's wallet-auth route, and every other resource, carry none.
 */
import { describe, it, expect } from '@jest/globals';
import { archiveListingFor, paymentRequiredFor } from './archive';

const BASE = 'https://api.provian.ai';

describe('archive listing per route', () => {
  it('the agent pay route lists, with the Bazaar extension, at its own URL', () => {
    const listing = archiveListingFor(`${BASE}/v1/archive/pay`);
    expect(listing.resource.url).toBe(`${BASE}/v1/archive/pay`);
    expect(listing.extensions).toHaveProperty('bazaar');
    const body = paymentRequiredFor(`${BASE}/v1/archive/pay`) as { extensions?: Record<string, unknown>; resource?: { url: string } };
    expect(body.extensions).toHaveProperty('bazaar');
    expect(body.resource?.url).toBe(`${BASE}/v1/archive/pay`);
  });

  it.each(['/v1/archive/mobile/pay', '/v1/archive/pay/x', '/v1/archive/payx', '/v1/archive'])('%s carries no listing extension', (p) => {
    const listing = archiveListingFor(`${BASE}${p}`);
    expect(listing.extensions).toBeUndefined();
    expect(listing.resource.url).toBe(`${BASE}${p}`);
    expect((paymentRequiredFor(`${BASE}${p}`) as { extensions?: unknown }).extensions).toBeUndefined();
  });

  it('the error rides on both 402 shapes', () => {
    expect((paymentRequiredFor(`${BASE}/v1/archive/pay`, 'payment_invalid') as { error?: string }).error).toBe('payment_invalid');
    expect((paymentRequiredFor(`${BASE}/v1/archive/mobile/pay`, 'payment_invalid') as { error?: string }).error).toBe('payment_invalid');
  });
});
