import { describe, it, expect, vi } from 'vitest';
import type { NativeStorePurchase, ProvianStorePurchaseModule } from '../../../modules/provian-store-purchase';
import { buyWithStore, priceOf, resumeUnfinished, STORE_PRODUCT_IDS, submitAndFinish, type StoreRelay, type StoreRelayAnswer } from './storePurchase';

const SETTLE = STORE_PRODUCT_IDS.settleNow;
const bought: NativeStorePurchase = { status: 'purchased', productId: SETTLE, transactionId: '2000000123', signedTransaction: 'header.payload.sig' };

function native(over: Partial<ProvianStorePurchaseModule> = {}, purchase: NativeStorePurchase = bought, open: NativeStorePurchase[] = []) {
    const finished: string[] = [];
    const mod: ProvianStorePurchaseModule = {
        canMakePayments: () => true,
        products: async () => [{ id: SETTLE, displayName: 'Settle now', displayPrice: '$0.99' }],
        purchase: vi.fn(async () => purchase),
        unfinished: async () => open,
        finish: async (id) => { finished.push(id); return true; },
        ...over,
    };
    return { mod, finished };
}

function relay(answer: StoreRelayAnswer | 'throw') {
    const sent: unknown[] = [];
    const r: StoreRelay = {
        storeAccount: async () => ({ accountToken: '0f1e2d3c-4b5a-4968-8776-655443322110', settleNowHeld: 0 }),
        redeemStorePurchase: async (body) => {
            sent.push(body);
            if (answer === 'throw') throw new Error('network');
            return answer;
        },
    };
    return { r, sent };
}

describe('a store purchase is finished only once the relay has recorded it', () => {
    it('credited: the signed transaction goes to the relay untouched, then the transaction is finished', async () => {
        const n = native();
        const rel = relay({ status: 'credited', heldReason: null, payout: { request_id: 'po_x' } });
        const out = await buyWithStore(n.mod, rel.r, 'app_store', SETTLE);
        expect(out).toEqual({ kind: 'credited', payout: { request_id: 'po_x' } });
        expect(n.mod.purchase).toHaveBeenCalledWith(SETTLE, '0f1e2d3c-4b5a-4968-8776-655443322110');
        expect(rel.sent).toEqual([{ platform: 'app_store', product_id: SETTLE, signed_transaction: 'header.payload.sig' }]);
        expect(n.finished).toEqual(['2000000123']);
    });

    it('held: a recorded but unspent Settle now is finished too (the relay keeps it)', async () => {
        const n = native();
        const out = await buyWithStore(n.mod, relay({ status: 'held', heldReason: 'nothing_to_pay', payout: null }).r, 'app_store', SETTLE);
        expect(out).toEqual({ kind: 'held', reason: 'nothing_to_pay' });
        expect(n.finished).toEqual(['2000000123']);
    });

    it('RED denied: a purchase the relay refused is NOT finished, so it is presented again', async () => {
        const n = native();
        const out = await buyWithStore(n.mod, relay({ status: 'denied', error: 'store_receipt_unverified' }).r, 'app_store', SETTLE);
        expect(out).toEqual({ kind: 'denied', error: 'store_receipt_unverified' });
        expect(n.finished).toEqual([]);
    });

    it('RED lost answer: a purchase whose relay answer was lost is NOT finished', async () => {
        const n = native();
        expect(await buyWithStore(n.mod, relay('throw').r, 'app_store', SETTLE)).toEqual({ kind: 'error', code: 'relay_unreachable' });
        expect(n.finished).toEqual([]);
    });

    it('Play: the purchase token goes to the relay and is what gets consumed', async () => {
        const n = native({}, { status: 'purchased', productId: SETTLE, transactionId: 'GPA.1', purchaseToken: 'tok-abc' });
        const rel = relay({ status: 'credited', heldReason: null, payout: null });
        await buyWithStore(n.mod, rel.r, 'google_play', SETTLE);
        expect(rel.sent).toEqual([{ platform: 'google_play', product_id: SETTLE, purchase_token: 'tok-abc' }]);
        expect(n.finished).toEqual(['tok-abc']);
    });

    it('cancelled, pending and unavailable send nothing to the relay', async () => {
        for (const status of ['cancelled', 'pending', 'unavailable'] as const) {
            const n = native({}, { status });
            const rel = relay({ status: 'credited', heldReason: null, payout: null });
            expect((await buyWithStore(n.mod, rel.r, 'app_store', SETTLE)).kind).toBe(status);
            expect(rel.sent).toEqual([]);
            expect(n.finished).toEqual([]);
        }
        const off = native({ canMakePayments: () => false });
        expect(await buyWithStore(off.mod, relay({ status: 'credited', heldReason: null, payout: null }).r, 'app_store', SETTLE)).toEqual({ kind: 'unavailable' });
        expect(off.mod.purchase).not.toHaveBeenCalled();
    });

    it('an unfinished purchase is sent again; a pending one waits', async () => {
        const open: NativeStorePurchase[] = [bought, { status: 'pending', productId: SETTLE, transactionId: '9' }];
        const n = native({}, bought, open);
        const rel = relay({ status: 'credited', heldReason: null, payout: null });
        const out = await resumeUnfinished(n.mod, rel.r, 'app_store');
        expect(out).toEqual([{ productId: SETTLE, outcome: { kind: 'credited', payout: null } }]);
        expect(rel.sent).toHaveLength(1);
        expect(n.finished).toEqual(['2000000123']);
    });

    it('a malformed purchase is never sent or finished', async () => {
        const n = native();
        const rel = relay({ status: 'credited', heldReason: null, payout: null });
        expect(await submitAndFinish(n.mod, rel.r, 'app_store', { status: 'purchased', productId: SETTLE, transactionId: '1' })).toEqual({ kind: 'error', code: 'purchase_unreadable' });
        expect(rel.sent).toEqual([]);
        expect(n.finished).toEqual([]);
    });

    it("prices come from the store's own localized price", () => {
        expect(priceOf([{ id: SETTLE, displayName: 'x', displayPrice: '0,99 €' }], SETTLE)).toBe('0,99 €');
        expect(priceOf([], SETTLE)).toBeNull();
    });
});
