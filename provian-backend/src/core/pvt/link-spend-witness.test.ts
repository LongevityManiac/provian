/**
 * link_spend witness validator — RED controls for the two things this module
 * exists to guarantee :
 * (1) no credential, card object, or LINK_ACCESS_TOKEN can enter a PE
 * (Security Invariant #1) — the payload is REFUSED, never redacted;
 * (2) the mint-once anchor is Link's own spend-request id, and only a
 * SUCCEEDED spend is a completed act (canonical event), so a replay of
 * the same id keys to the same event and a failed spend earns nothing.
 */
import { describe, it, expect } from '@jest/globals';
import {
  LINK_SPEND_ID_RE,
  LINK_SPEND_BINDING_RE,
  linkSpendCanonicalEvent,
  linkSpendCredentialLeak,
  linkSpendTranscriptBindingPresent,
  validateLinkSpendMetadata,
} from './link-spend-witness';

const GOOD = {
  link_spend_id: 'lsrq_1AbCdEfGhIjKlMnOpQrStUv',
  amount: 3500,
  currency: 'usd',
  status: 'succeeded',
  merchant_name: 'Example Books',
  merchant_url: 'https://books.example.com/checkout/123',
  credential_type: 'card',
  created_at: 1_760_000_000_000,
  approved_at: 1_760_000_060_000,
  agent_wallet_id: 'wallet_aw_6c5e74b0',
  beneficiary_wallet_id: 'wallet_h_1',
};

describe('validateLinkSpendMetadata — accepts exactly the witness record', () => {
  it('projects a well-formed spend-request record onto the allowlisted fields', () => {
    const v = validateLinkSpendMetadata({ ...GOOD, unrelated_extra: 'dropped' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.fields).toEqual({
      link_spend_id: GOOD.link_spend_id, amount: 3500, currency: 'usd', status: 'succeeded',
      merchant_name: 'Example Books', merchant_url: GOOD.merchant_url, credential_type: 'card',
      created_at: GOOD.created_at, approved_at: GOOD.approved_at,
      agent_wallet_id: 'wallet_aw_6c5e74b0', beneficiary_wallet_id: 'wallet_h_1',
    });
    expect((v.fields as unknown as Record<string, unknown>).unrelated_extra).toBeUndefined();
  });

  it('a terminal FAILED / denied / expired / canceled spend is a valid RECORD but not a canonical act', () => {
    for (const status of ['failed', 'denied', 'expired', 'canceled', 'approved', 'submitted', 'pending_approval']) {
      const v = validateLinkSpendMetadata({ ...GOOD, status });
      expect(v.ok).toBe(true);
      expect(linkSpendCanonicalEvent({ ...GOOD, status })).toBeNull();
    }
    expect(linkSpendCanonicalEvent(GOOD)).toBe(`link_spend:${GOOD.link_spend_id}`);
  });

  it('the canonical event is a pure function of the spend-request id (replay keys identically)', () => {
    expect(linkSpendCanonicalEvent({ ...GOOD, merchant_name: 'Other', amount: 1 }))
      .toBe(linkSpendCanonicalEvent(GOOD));
  });
});

describe('a transcript-lane record needs the Link invocation binding to be a canonical act', () => {
  const TRANSCRIPT = { ...GOOD, tool: 'provian:transcript', source: 'transcript', harness: 'claude-code' };

  it('RED: a transcript-lane succeeded record WITHOUT a binding (a pre- daemon, any lsrq_ text) → no canonical act, still a valid record', () => {
    expect(validateLinkSpendMetadata(TRANSCRIPT).ok).toBe(true);
    expect(linkSpendTranscriptBindingPresent(TRANSCRIPT)).toBe(false);
    expect(linkSpendCanonicalEvent(TRANSCRIPT)).toBeNull();
    for (const bogus of ['transcript', 'link_cli', 'link_cli:echo', 'link_web:retrieve', 'LINK_CLI:retrieve', '', 7]) {
      expect(linkSpendCanonicalEvent({ ...TRANSCRIPT, link_spend_binding: bogus })).toBeNull();
    }
  });

  it('GREEN: the same record paired with a Link CLI / MCP invocation → the canonical act', () => {
    for (const binding of ['link_cli:retrieve', 'link_cli:create', 'link_mcp:retrieve', 'link_cli:mpp_pay']) {
      expect(LINK_SPEND_BINDING_RE.test(binding)).toBe(true);
      expect(linkSpendCanonicalEvent({ ...TRANSCRIPT, link_spend_binding: binding }))
        .toBe(`link_spend:${GOOD.link_spend_id}`);
    }
  });

  it('the explicit recordLinkSpend path (no transcript source) is unaffected', () => {
    expect(linkSpendTranscriptBindingPresent(GOOD)).toBe(true);
    expect(linkSpendCanonicalEvent(GOOD)).toBe(`link_spend:${GOOD.link_spend_id}`);
  });
});

describe('RED — credential-shaped payloads are REFUSED, never stored', () => {
  const leaks: Array<[string, Record<string, unknown>]> = [
    ['a card object', { ...GOOD, card: { number: '4242424242424242', exp_month: 12, exp_year: 2030, cvc: '123' } }],
    ['a bare card-number-shaped value in any field', { ...GOOD, merchant_name: '4242 4242 4242 4242' }],
    ['a nested credential key', { ...GOOD, details: { credential: { pan: 'x' } } }],
    ['LINK_ACCESS_TOKEN as a key', { ...GOOD, LINK_ACCESS_TOKEN: 'lat_abc123456789' }],
    ['LINK_ACCESS_TOKEN mentioned in a value', { ...GOOD, merchant_name: 'export LINK_ACCESS_TOKEN=abc' }],
    ['a Link access token value', { ...GOOD, note: 'lat_9f8e7d6c5b4a3210' }],
    ['a Link Pay Token value', { ...GOOD, note: 'lpt_9f8e7d6c5b4a3210' }],
    ['a shared payment token value', { ...GOOD, note: 'spt_9f8e7d6c5b4a3210' }],
    ['a Stripe secret key value', { ...GOOD, note: 'sk_live_9f8e7d6c5b4a3210' }],
    ['a token key at any depth', { ...GOOD, meta: [{ shared_payment_token: 'x' }] }],
    ['a cvc key', { ...GOOD, cvc: '123' }],
    ['credential_type NESTED (the top-level exemption does not reach deeper)', { ...GOOD, details: { credential_type: 'card' } }],
    ['a token-shaped credential_type VALUE (the exemption covers the key, never the value)', { ...GOOD, credential_type: 'lpt_9f8e7d6c5b4a3210' }],
  ];
  it.each(leaks)('refuses %s', (_label, payload) => {
    expect(linkSpendCredentialLeak(payload)).not.toBeNull();
    const v = validateLinkSpendMetadata(payload);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('LINK_SPEND_CREDENTIAL_REJECTED');
  });

  it('GREEN control — the clean record leaks nothing', () => {
    expect(linkSpendCredentialLeak(GOOD)).toBeNull();
  });
});

describe('RED — structural refusals', () => {
  const structural: Array<[string, unknown, string]> = [
    ['missing id', { ...GOOD, link_spend_id: undefined }, 'LINK_SPEND_ID_MALFORMED'],
    ['wrong prefix', { ...GOOD, link_spend_id: 'pi_1AbCdEfGhIjKlMn' }, 'LINK_SPEND_ID_MALFORMED'],
    ['too short', { ...GOOD, link_spend_id: 'lsrq_ab' }, 'LINK_SPEND_ID_MALFORMED'],
    ['unknown status', { ...GOOD, status: 'paid' }, 'LINK_SPEND_STATUS_INVALID'],
    ['fractional amount', { ...GOOD, amount: 35.5 }, 'LINK_SPEND_AMOUNT_INVALID'],
    ['negative amount', { ...GOOD, amount: -1 }, 'LINK_SPEND_AMOUNT_INVALID'],
    ['uppercase currency', { ...GOOD, currency: 'USD' }, 'LINK_SPEND_CURRENCY_INVALID'],
    ['not an object', 'lsrq_1AbCdEfGhIjKlMn', 'LINK_SPEND_METADATA_INVALID'],
  ];
  it.each(structural)('%s → %s', (_label, payload, code) => {
    const v = validateLinkSpendMetadata(payload);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
    expect(linkSpendCanonicalEvent(payload)).toBeNull();
  });

  it('LINK_SPEND_ID_RE binds to the documented lsrq_ shape', () => {
    expect(LINK_SPEND_ID_RE.test('lsrq_1AbCdEfGhIjKlMnOpQrStUv')).toBe(true);
    expect(LINK_SPEND_ID_RE.test('lsrq_')).toBe(false);
    expect(LINK_SPEND_ID_RE.test('lsrq_with-dash')).toBe(false);
  });
});
