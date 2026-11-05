/**
 * "check again" on a charged payout: a slow or failed check keeps the request as charged,
 * never "failed"; a check that answers shows the relay's answer.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PayoutRequestView } from '../../services/RelayAPIService';
import { checkPayoutAgain } from './settleNowCheck';

const charged = {
    request_id: 'po_' + 'a'.repeat(40),
    payee: '0x' + '1'.repeat(40),
    state: 'charged',
    fee_usdc: '1.00',
    charge_tx_hash: '0x' + 'b'.repeat(64),
    waiting_reason: null,
    created_at_ms: 1,
    settled_at_ms: null,
    settlement: null,
    note: 'Charged.',
} as unknown as PayoutRequestView;

describe('Settle now — check again ', () => {
    it('RED: a check that times out keeps the charged request', async () => {
        const advance = vi.fn(async () => { throw new Error('Request timeout'); });
        await expect(checkPayoutAgain(charged, advance)).resolves.toBe(charged);
        expect(advance).toHaveBeenCalledWith(charged.request_id);
    });

    it('RED: a check the relay refuses keeps the charged request', async () => {
        await expect(checkPayoutAgain(charged, async () => { throw new Error('payout_http_500'); })).resolves.toEqual(charged);
    });

    it('a check that answers shows the answer (settled)', async () => {
        const settled = { ...charged, state: 'settled', settled_at_ms: 2 } as unknown as PayoutRequestView;
        await expect(checkPayoutAgain(charged, async () => settled)).resolves.toBe(settled);
    });
});
