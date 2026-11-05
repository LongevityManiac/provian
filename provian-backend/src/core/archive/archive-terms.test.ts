/**
 * — the PE Archive's money terms ride the shared USDC charge path: exactly $5 per GB,
 * Base USDC, to the revenue wallet. Each RED starts from the valid $5 payment changed in one term —
 * including the $1 payout payment, which must never buy archive space (and vice versa).
 */
import { describe, it, expect } from '@jest/globals';
import { Wallet } from 'ethers';
import {
  ARCHIVE_GB_BYTES,
  ARCHIVE_GB_FEE_USDC_ATOMIC,
  ARCHIVE_TOPUP_WINDOW_BYTES,
  archiveGbPurchasable,
  archivePaymentRequestId,
  archivePaymentRequired,
  archiveChargedBytes,
  ARCHIVE_MIN_CHARGED_PART_BYTES,
  archiveSpaceFits,
  checkArchivePayment,
} from './archive-terms';
import { checkPayoutPayment, payoutRequestId } from '../payout/payout-terms';
import { PROVIAN_TREASURY } from '../config/live-value-recipients';
import { signedPaymentHeader } from '../payout/payout-test-fixtures';

const NOW = 1_790_000_000;
const payer = new Wallet('0x' + '44'.repeat(32));

describe('PE Archive terms', () => {
  it('GREEN: the quote is exactly $5 USDC on Base to the revenue wallet; 1 GB = 10^9 bytes', () => {
    expect(ARCHIVE_GB_FEE_USDC_ATOMIC).toBe(5_000_000n);
    expect(ARCHIVE_GB_BYTES).toBe(1_000_000_000);
    const body = archivePaymentRequired('https://api.provian.ai/v1/archive/pay') as { accepts: Record<string, unknown>[] };
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact', network: 'eip155:8453', amount: '5000000', payTo: PROVIAN_TREASURY,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    });
  });

  it('GREEN: a signed $5 authorization passes', async () => {
    const result = checkArchivePayment(await signedPaymentHeader(payer, NOW, { value: '5000000' }), NOW);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['the $1 payout fee', { value: '1000000' }],
    ['$4.99', { value: '4999999' }],
    ['$5.01 (never a price above the GB)', { value: '5000001' }],
    ['paid to someone else', { value: '5000000', to: new Wallet('0x' + '55'.repeat(32)).address }],
    ['another network', { value: '5000000', network: 'eip155:84532' }],
  ])('RED: refuses %s', async (_label, overrides) => {
    expect(checkArchivePayment(await signedPaymentHeader(payer, NOW, overrides), NOW).ok).toBe(false);
  });

  it('RED: a $5 archive payment is not a payout payment', async () => {
    expect(checkPayoutPayment(await signedPaymentHeader(payer, NOW, { value: '5000000' }), NOW)).toEqual({ ok: false, reason: 'payment_amount_wrong' });
  });

  it('the same authorization can never key both a payout and an archive request', () => {
    const auth = { from: payer.address, nonce: '0x' + 'ab'.repeat(32) };
    expect(archivePaymentRequestId(auth)).toMatch(/^ap_[0-9a-f]{40}$/);
    expect(archivePaymentRequestId(auth).slice(3)).not.toBe(payoutRequestId(auth).slice(3));
  });

  it('a GB is purchasable at turn-on and within 100 MB of the paid space — never earlier', () => {
    expect(archiveGbPurchasable(null)).toBe(true);
    expect(archiveGbPurchasable({ paid_bytes: 0, used_bytes: 0 })).toBe(true);
    expect(archiveGbPurchasable({ paid_bytes: ARCHIVE_GB_BYTES, used_bytes: ARCHIVE_GB_BYTES })).toBe(true);
    expect(archiveGbPurchasable({ paid_bytes: ARCHIVE_GB_BYTES, used_bytes: ARCHIVE_GB_BYTES - ARCHIVE_TOPUP_WINDOW_BYTES + 1 })).toBe(true);
    // RED: most of the GB unused — a second payment is refused before anything is charged.
    expect(archiveGbPurchasable({ paid_bytes: ARCHIVE_GB_BYTES, used_bytes: ARCHIVE_GB_BYTES - ARCHIVE_TOPUP_WINDOW_BYTES })).toBe(false);
    expect(archiveGbPurchasable({ paid_bytes: ARCHIVE_GB_BYTES, used_bytes: 0 })).toBe(false);
  });

  it('space fits up to the paid bytes and not one byte past', () => {
    expect(archiveSpaceFits({ paid_bytes: 100, used_bytes: 60 }, 40)).toBe(true);
    expect(archiveSpaceFits({ paid_bytes: 100, used_bytes: 60 }, 41)).toBe(false);
  });
});

describe('the 1 MB floor per part ', () => {
  it('a part counts its bytes, never less than 1 MB; one GB holds at most 1,000 parts', () => {
    expect(ARCHIVE_MIN_CHARGED_PART_BYTES).toBe(1_000_000);
    expect(archiveChargedBytes(1)).toBe(1_000_000);
    expect(archiveChargedBytes(999_999)).toBe(1_000_000);
    expect(archiveChargedBytes(1_000_000)).toBe(1_000_000);
    expect(archiveChargedBytes(1_000_001)).toBe(1_000_001); // RED: a large part is never rounded
    expect(Math.floor(ARCHIVE_GB_BYTES / archiveChargedBytes(1))).toBe(1_000);
  });
});
