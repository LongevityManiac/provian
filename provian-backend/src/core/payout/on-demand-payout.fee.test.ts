/**
 * the on-demand payout fee is a flat $1 USDC, and the payout waits
 * while Base gas for the charge plus the one-payee settlement is above what that $1 covers.
 */
import { describe, it, expect } from '@jest/globals';
import { PAYOUT_FEE_USDC_ATOMIC, PAYOUT_SERVICE_TERMS, payoutRequirement } from './payout-terms';
import { PAYOUT_FEE_USD, quotePayoutGas, publicPayoutView, type PayoutRequestDoc } from './on-demand-payout';

/** A chain whose only cost is the two L1 data fees: 0.25 ETH each, so the quote costs 0.5 ETH. */
const chain = {
  gasPriceWei: async () => 0n,
  l1FeeUpperBoundWei: async () => 250_000_000_000_000_000n,
};
const work = { claims: 1, recipients: 1 };

describe('the on-demand payout fee is a flat $1 USDC', () => {
  it.each(['charging', 'charge_unconfirmed'] as const)('does not call an undecided %s fee charged or invite a second payment', state => {
    const view = publicPayoutView({ state, paid_via: 'usdc' } as PayoutRequestDoc);
    expect(view.note).toBe('The fee payment is not confirmed yet. Follow this request until its charge is decided; do not pay again.');
  });
  it('preserves confirmed, failed, settled and store-paid status meanings', () => {
    const note = (state: PayoutRequestDoc['state'], paid_via: PayoutRequestDoc['paid_via'] = 'usdc') =>
      publicPayoutView({ state, paid_via } as PayoutRequestDoc).note;
    expect(note('charged')).toMatch(/^Charged\./);
    expect(note('charge_failed')).toBe('The fee was not taken. Nothing was charged.');
    expect(note('settled')).toMatch(/^Settled\./);
    expect(note('charged', 'app_store')).toMatch(/^Paid\./);
    expect(note('charged', 'google_play')).toMatch(/^Paid\./);
  });
  it('the quote asks for exactly 1 USDC (6 decimals), whatever is owed', () => {
    expect(PAYOUT_FEE_USDC_ATOMIC).toBe(1_000_000n);
    expect(PAYOUT_SERVICE_TERMS.amountAtomic).toBe(1_000_000n);
    expect(payoutRequirement().amount).toBe('1000000');
    expect(PAYOUT_SERVICE_TERMS.description).toContain('$1 USDC');
    expect(PAYOUT_FEE_USD).toBe(1);
  });

  it('gas up to $1 is covered: $0.50 and exactly $1.00 (RED under the old $0.10 ceiling)', async () => {
    expect((await quotePayoutGas(chain, 1, work)).costUsd).toBeCloseTo(0.5, 9);
    expect((await quotePayoutGas(chain, 1, work)).covered).toBe(true);
    expect((await quotePayoutGas(chain, 2, work)).covered).toBe(true);
  });

  it('RED: gas above $1 waits, and an unknown ETH price waits', async () => {
    const above = await quotePayoutGas(chain, 2.02, work);
    expect(above.costUsd).toBeGreaterThan(1);
    expect(above.covered).toBe(false);
    expect((await quotePayoutGas(chain, null, work)).covered).toBe(false);
  });
});
