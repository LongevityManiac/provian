/**
 * — the on-demand payout's payment terms. Every term is a constant; a payment that
 * differs from the quote in any of them is refused before anything touches the chain. Each RED
 * starts from the same valid payment the GREEN accepts, changed in exactly one term.
 */
import { describe, it, expect } from '@jest/globals';
import { Wallet } from 'ethers';
import { checkPayoutPayment, payoutRequestId, PAYOUT_FEE_RECIPIENT } from './payout-terms';
import { recoverPayoutSigner } from './payout-chain';
import { signedPaymentHeader } from './payout-test-fixtures';

const NOW = 1_790_000_000;
const payer = new Wallet('0x' + '11'.repeat(32));
const stranger = new Wallet('0x' + '22'.repeat(32));

describe('on-demand payout terms', () => {
  it('GREEN: accepts the exact quote, and the recovered signer is the payer', async () => {
    const result = checkPayoutPayment(await signedPaymentHeader(payer, NOW), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.authorization.to).toBe(PAYOUT_FEE_RECIPIENT);
    expect(result.payment.authorization.value).toBe('1000000');
    expect(recoverPayoutSigner(result.payment)).toBe(payer.address.toLowerCase());
  });

  it.each([
    ['amount below the fee', { value: '999999' }, 'payment_amount_wrong'],
    ['amount above the fee (never a price)', { value: '1000001' }, 'payment_amount_wrong'],
    ['paid to someone else', { to: stranger.address }, 'payment_pay_to_wrong'],
    ['not Base USDC', { asset: '0x' + '33'.repeat(20) }, 'payment_asset_wrong'],
    ['another network', { network: 'eip155:84532' }, 'payment_network_wrong'],
    ['x402 v1', { x402Version: 1 }, 'payment_version_unsupported'],
    ['not yet valid', { validAfter: String(NOW + 60) }, 'payment_not_yet_valid'],
    ['about to expire', { validBefore: String(NOW + 10) }, 'payment_expires_too_soon'],
  ])('RED: refuses %s', async (_label, overrides, reason) => {
    const result = checkPayoutPayment(await signedPaymentHeader(payer, NOW, overrides), NOW);
    expect(result).toEqual({ ok: false, reason });
  });

  it('RED: a signature by someone other than `from` recovers to them, not the payer', async () => {
    const result = checkPayoutPayment(await signedPaymentHeader(payer, NOW, { signWith: stranger }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recoverPayoutSigner(result.payment)).not.toBe(result.payment.authorization.from);
  });

  it('RED: refuses garbage and an absent header', () => {
    expect(checkPayoutPayment(undefined, NOW)).toEqual({ ok: false, reason: 'payment_missing' });
    expect(checkPayoutPayment('not-base64-json', NOW).ok).toBe(false);
    expect(checkPayoutPayment(Buffer.from('[]').toString('base64'), NOW)).toEqual({ ok: false, reason: 'payment_not_object' });
  });

  it('one request per (payer, nonce), case-insensitive', () => {
    const a = payoutRequestId({ from: payer.address, nonce: '0x' + 'ab'.repeat(32) });
    expect(a).toMatch(/^po_[0-9a-f]{40}$/);
    expect(payoutRequestId({ from: payer.address.toLowerCase(), nonce: '0x' + 'AB'.repeat(32) })).toBe(a);
    expect(payoutRequestId({ from: payer.address, nonce: '0x' + 'cd'.repeat(32) })).not.toBe(a);
  });

  it('the id is a fixed derivation the SDK repeats to follow a paid request whose answer was lost ', () => {
    // The same vector is pinned in provian-agent-sdk/src/act-verbs.test.ts (`payoutRequestIdOfPayment`).
    expect(payoutRequestId({ from: '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1', nonce: '0x' + 'ab'.repeat(32) }))
      .toBe('po_f450773f249c1506318221c07fbe37f0c38d6d93');
  });
});
