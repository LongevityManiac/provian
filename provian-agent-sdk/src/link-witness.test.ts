/**
 * link_spend witness — RED controls.
 * (1) No credential, card object, or LINK_ACCESS_TOKEN can enter a PE: a raw
 * input carrying a LIVE credential is REFUSED; a `card` object is never
 * copied by projection; the projection itself is re-scanned.
 * (2) Mint-once anchors on Link's own `lsrq_` id; only SUCCEEDED is the act.
 * (3) The transcript recognizer is content-free: a PAN in a tool result never
 * reaches the event.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLinkSpendWitness,
  linkSpendCredentialLeak,
  linkSpendRawCredentialLeak,
  projectLinkSpendRecord,
  recognizeLinkSpendInText,
  linkSpendWitnessMetadata,
  linkSpendDescription,
} from './link-witness';

const LSRQ = 'lsrq_1AbCdEfGhIjKlMnOpQrStUv';
const PAN = '4000009990001984';
const SENTINEL = 'PRIVACY_SENTINEL_DO_NOT_EMIT';

/** The raw `spend-request retrieve --include card` object the Link CLI prints. */
const LINK_RAW_WITH_CARD = {
  id: LSRQ,
  object: 'spend_request',
  status: 'succeeded',
  amount: 3500,
  currency: 'USD',
  merchant_name: 'Stripe Press',
  merchant_url: 'https://press.stripe.com',
  credential_type: 'card',
  context: `Buying ${SENTINEL} for the team library, a book about open source`,
  created: 1_760_000_000,
  line_items: [{ name: SENTINEL, unit_amount: 3500, quantity: 1 }],
  card: { number: PAN, cvc: '123', exp_month: 12, exp_year: 2030, billing_address: { line1: SENTINEL } },
};

const SDK_INPUT = {
  link_spend_id: LSRQ, amount: 3500, currency: 'usd', status: 'succeeded',
  merchant_name: 'Stripe Press', merchant_url: 'https://press.stripe.com',
  created_at: '2026-09-16T12:00:00.000Z', approved_at: 1_760_000_060_000,
  agent_wallet_id: 'wallet_aw_6c5e74b0', beneficiary_wallet_id: 'wallet_h_1',
};

describe('projectLinkSpendRecord — the allowlist, nothing else', () => {
  it('projects the SDK shape (ISO + epoch-ms timestamps) onto the witness fields', () => {
    const w = projectLinkSpendRecord({ ...SDK_INPUT, unrelated: SENTINEL });
    expect(w).toEqual({
      link_spend_id: LSRQ, amount: 3500, currency: 'usd', status: 'succeeded',
      merchant_name: 'Stripe Press', merchant_url: 'https://press.stripe.com', credential_type: null,
      created_at: Date.parse('2026-09-16T12:00:00.000Z'), approved_at: 1_760_000_060_000,
      agent_wallet_id: 'wallet_aw_6c5e74b0', beneficiary_wallet_id: 'wallet_h_1',
    });
    expect(JSON.stringify(w)).not.toContain(SENTINEL);
  });

  it('projects the raw Link CLI object (`id`, `created` unix SECONDS, uppercase currency) and NEVER copies the card', () => {
    const w = projectLinkSpendRecord(LINK_RAW_WITH_CARD)!;
    expect(w.link_spend_id).toBe(LSRQ);
    expect(w.created_at).toBe(1_760_000_000_000);
    expect(w.currency).toBe('usd');
    expect(w.credential_type).toBe('card');
    const json = JSON.stringify(w);
    expect(json).not.toContain(PAN);
    expect(json).not.toContain('123');
    expect(json).not.toContain(SENTINEL);
    expect((w as unknown as Record<string, unknown>).card).toBeUndefined();
    expect(linkSpendCredentialLeak(w)).toBeNull();
  });

  it('maps execution_method=link_pay_token to the link_pay_token credential type', () => {
    expect(projectLinkSpendRecord({ ...LINK_RAW_WITH_CARD, card: undefined, execution_method: 'link_pay_token' })!.credential_type)
      .toBe('link_pay_token');
  });

  it.each([
    ['no id', { status: 'succeeded', amount: 1, currency: 'usd' }],
    ['non-lsrq id', { id: 'pi_123456789', status: 'succeeded', amount: 1, currency: 'usd' }],
    ['unknown status', { id: LSRQ, status: 'paid', amount: 1, currency: 'usd' }],
    ['not an object', LSRQ],
  ])('returns null for %s (never throws)', (_l, input) => {
    expect(projectLinkSpendRecord(input)).toBeNull();
  });
});

describe('RED — buildLinkSpendWitness refuses a live credential BEFORE anything else', () => {
  it.each([
    ['an unmasked card object', LINK_RAW_WITH_CARD],
    ['a bare card number under any key', { ...SDK_INPUT, note: PAN }],
    ['LINK_ACCESS_TOKEN as a key', { ...SDK_INPUT, LINK_ACCESS_TOKEN: 'lat_abc123456789' }],
    ['LINK_ACCESS_TOKEN in a value', { ...SDK_INPUT, merchant_name: 'export LINK_ACCESS_TOKEN=x' }],
    ['a Link access token value', { ...SDK_INPUT, note: 'lat_9f8e7d6c5b4a3210' }],
    ['a Link Pay Token object', { ...SDK_INPUT, link_pay_token: { id: 'x' } }],
    ['a shared payment token object', { ...SDK_INPUT, shared_payment_token: { id: 'spt_9f8e7d6c5b4a3210' } }],
    ['a cvc', { ...SDK_INPUT, cvc: '123' }],
  ])('refuses %s with LINK_SPEND_CREDENTIAL_REJECTED', (_l, input) => {
    expect(linkSpendRawCredentialLeak(input)).not.toBeNull();
    expect(() => buildLinkSpendWitness(input)).toThrowError(expect.objectContaining({ code: 'LINK_SPEND_CREDENTIAL_REJECTED' }));
  });

  it('GREEN control — a REDACTED card summary ({brand,last4}) is not a credential: dropped by projection, accepted', () => {
    const w = buildLinkSpendWitness({ ...LINK_RAW_WITH_CARD, card: { brand: 'visa', last4: '1984', redacted: true } });
    expect(w.link_spend_id).toBe(LSRQ);
    expect(JSON.stringify(w)).not.toContain('1984');
  });

  it.each([
    ['no id', { status: 'succeeded', amount: 1, currency: 'usd' }, 'LINK_SPEND_INVALID'],
    ['fractional amount', { ...SDK_INPUT, amount: 35.5 }, 'LINK_SPEND_INVALID'],
    ['negative amount', { ...SDK_INPUT, amount: -1 }, 'LINK_SPEND_INVALID'],
    ['bad currency', { ...SDK_INPUT, currency: 'dollars' }, 'LINK_SPEND_INVALID'],
    ['unknown status', { ...SDK_INPUT, status: 'paid' }, 'LINK_SPEND_INVALID'],
  ])('%s → %s', (_l, input, code) => {
    expect(() => buildLinkSpendWitness(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('the PE metadata is exactly the witness; the description names the merchant, never the id or URL', () => {
    const w = buildLinkSpendWitness(SDK_INPUT);
    expect(linkSpendWitnessMetadata(w)).toEqual({ ...w });
    const d = linkSpendDescription(w);
    expect(d).toBe('Link spend succeeded at Stripe Press (3500 usd)');
    expect(d).not.toContain(LSRQ);
    expect(d.split(' ').length).toBeGreaterThanOrEqual(3);
  });
});

describe('recognizeLinkSpendInText — passive transcript recognizer (content-free)', () => {
  it('JSON tool result WITH a live card → the witness fields only; the PAN and every other field never escape', () => {
    const w = recognizeLinkSpendInText(JSON.stringify(LINK_RAW_WITH_CARD, null, 2));
    expect(w).not.toBeNull();
    expect(w!.link_spend_id).toBe(LSRQ);
    expect(w!.amount).toBe(3500);
    const json = JSON.stringify(w);
    expect(json).not.toContain(PAN);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain('line_items');
    expect(json).not.toContain('context');
  });

  it('key/value text (the Link CLI agent output: toon/yaml) → the same witness', () => {
    const text = [
      'id: ' + LSRQ, 'object: spend_request', 'status: succeeded', 'amount: 3500', 'currency: usd',
      'merchant_name: Stripe Press', 'merchant_url: https://press.stripe.com', 'credential_type: card',
      `context: ${SENTINEL}`, 'created: 1760000000',
      'card:', '  number: ' + PAN, '  cvc: 123',
    ].join('\n');
    const w = recognizeLinkSpendInText(text);
    expect(w).toMatchObject({ link_spend_id: LSRQ, status: 'succeeded', amount: 3500, currency: 'usd', merchant_name: 'Stripe Press', created_at: 1_760_000_000_000 });
    expect(JSON.stringify(w)).not.toContain(PAN);
    expect(JSON.stringify(w)).not.toContain(SENTINEL);
  });

  it.each([
    ['a non-succeeded (approved) spend', JSON.stringify({ ...LINK_RAW_WITH_CARD, status: 'approved' })],
    ['a failed spend', JSON.stringify({ ...LINK_RAW_WITH_CARD, status: 'failed' })],
    ['a list result', JSON.stringify({ object: 'list', data: [LINK_RAW_WITH_CARD] })],
    ['text that merely mentions an lsrq id', `see ${LSRQ} later`],
    ['ordinary tool output', 'total 0\ndrwxr-xr-x 2 frank staff 64 Sep 16 12:00.'],
    ['a projection that is still card-shaped (merchant_name is a PAN)', JSON.stringify({ ...LINK_RAW_WITH_CARD, merchant_name: PAN })],
    ['empty', ''],
  ])('→ null for %s', (_l, text) => {
    expect(recognizeLinkSpendInText(text)).toBeNull();
  });
});
