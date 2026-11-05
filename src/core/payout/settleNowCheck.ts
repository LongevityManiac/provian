/**
 * the "Settle now" card's "check again".
 *
 * By the time the card shows "check again", the $1 fee is charged and the relay finishes the
 * settlement on its own (the payout sweep, every 10 minutes). Asking the relay to advance it can
 * run long (the settlement itself takes minutes on Base) or fail; either way the request is still
 * charged, so the card keeps showing it as it was — never "failed".
 */
import type { PayoutRequestView } from '../../services/RelayAPIService';

export async function checkPayoutAgain(
    request: PayoutRequestView,
    advance: (requestId: string) => Promise<PayoutRequestView>,
): Promise<PayoutRequestView> {
    try {
        return await advance(request.request_id);
    } catch {
        return request;
    }
}
