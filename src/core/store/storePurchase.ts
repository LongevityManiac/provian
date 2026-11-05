/**
 * Buying the PE Archive and Settle now through the App Store or Google Play (store builds only).
 *
 * The phone buys; the relay decides. A purchase is sent to the relay exactly as the store handed it
 * over (Apple's signed transaction, Play's purchase token), the relay verifies it with the store,
 * and only once the relay has RECORDED it (credited, or held as an unused Settle now) does the
 * phone finish the transaction. A purchase the relay refused or could not reach stays unfinished
 * and is sent again by `resumeUnfinished` — never lost, never credited twice (the relay grants
 * each store transaction once).
 *
 * The website APK never comes here: it pays with USDC from the wallet.
 */
import type { NativeStorePurchase, ProvianStorePurchaseModule, StoreProduct } from '../../../modules/provian-store-purchase';

export const STORE_PRODUCT_IDS = {
    archiveGb: 'com.provian.wallet.archive_1gb',
    settleNow: 'com.provian.wallet.settle_now',
} as const;

export type StorePlatform = 'app_store' | 'google_play';

export interface StoreAccount {
    readonly accountToken: string;
    readonly settleNowHeld: number;
}

/** What the relay answered about one purchase. */
export type StoreRelayAnswer =
    | { readonly status: 'credited' | 'held'; readonly heldReason: string | null; readonly payout: unknown | null }
    | { readonly status: 'denied'; readonly error: string };

export interface StoreRelay {
    storeAccount(): Promise<StoreAccount>;
    redeemStorePurchase(body: {
        platform: StorePlatform;
        product_id: string;
        signed_transaction?: string;
        purchase_token?: string;
    }): Promise<StoreRelayAnswer>;
}

export type StoreBuyOutcome =
    | { readonly kind: 'credited'; readonly payout: unknown | null }
    | { readonly kind: 'held'; readonly reason: string | null }
    | { readonly kind: 'pending' }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'unavailable' }
    | { readonly kind: 'denied'; readonly error: string }
    | { readonly kind: 'error'; readonly code: string };

/** The id the native layer finishes a purchase by: Apple's transaction id, Play's purchase token. */
function finishIdOf(platform: StorePlatform, purchase: NativeStorePurchase): string | null {
    const id = platform === 'app_store' ? purchase.transactionId : purchase.purchaseToken;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Send one bought purchase to the relay; finish it only once the relay has recorded it. */
export async function submitAndFinish(
    native: ProvianStorePurchaseModule,
    relay: StoreRelay,
    platform: StorePlatform,
    purchase: NativeStorePurchase,
): Promise<StoreBuyOutcome> {
    if (purchase.status === 'pending') return { kind: 'pending' };
    if (purchase.status !== 'purchased' || typeof purchase.productId !== 'string') return { kind: 'error', code: purchase.code ?? 'not_purchased' };
    const proof = platform === 'app_store' ? purchase.signedTransaction : purchase.purchaseToken;
    const finishId = finishIdOf(platform, purchase);
    if (typeof proof !== 'string' || proof.length === 0 || finishId === null) return { kind: 'error', code: 'purchase_unreadable' };
    let answer: StoreRelayAnswer;
    try {
        answer = await relay.redeemStorePurchase({
            platform,
            product_id: purchase.productId,
            ...(platform === 'app_store' ? { signed_transaction: proof } : { purchase_token: proof }),
        });
    } catch {
        // The relay's answer was lost: the purchase stays unfinished and is sent again later.
        return { kind: 'error', code: 'relay_unreachable' };
    }
    if (answer.status === 'denied') return { kind: 'denied', error: answer.error };
    await native.finish(finishId).catch(() => false);
    return answer.status === 'credited' ? { kind: 'credited', payout: answer.payout } : { kind: 'held', reason: answer.heldReason };
}

/** Buy one product through this build's store and have the relay record it. */
export async function buyWithStore(
    native: ProvianStorePurchaseModule,
    relay: StoreRelay,
    platform: StorePlatform,
    productId: string,
): Promise<StoreBuyOutcome> {
    if (!native.canMakePayments()) return { kind: 'unavailable' };
    let account: StoreAccount;
    try {
        account = await relay.storeAccount();
    } catch {
        return { kind: 'error', code: 'relay_unreachable' };
    }
    const purchase = await native.purchase(productId, account.accountToken).catch((): NativeStorePurchase => ({ status: 'error', code: 'native_failed' }));
    switch (purchase.status) {
        case 'cancelled': return { kind: 'cancelled' };
        case 'pending': return { kind: 'pending' };
        case 'unavailable': return { kind: 'unavailable' };
        case 'already_owned': {
            // An earlier purchase of this product was never finished: send it (it is the one to credit).
            const resumed = await resumeUnfinished(native, relay, platform);
            return resumed.find((r) => r.productId === productId)?.outcome ?? { kind: 'error', code: 'already_owned' };
        }
        case 'purchased': return submitAndFinish(native, relay, platform, purchase);
        default: return { kind: 'error', code: purchase.code ?? 'purchase_failed' };
    }
}

/** Send every purchase bought but not yet recorded (an app closed mid-purchase, a lost answer). */
export async function resumeUnfinished(
    native: ProvianStorePurchaseModule,
    relay: StoreRelay,
    platform: StorePlatform,
): Promise<{ productId: string; outcome: StoreBuyOutcome }[]> {
    const open = await native.unfinished().catch(() => [] as NativeStorePurchase[]);
    const out: { productId: string; outcome: StoreBuyOutcome }[] = [];
    for (const purchase of open) {
        if (purchase.status !== 'purchased' || typeof purchase.productId !== 'string') continue;
        out.push({ productId: purchase.productId, outcome: await submitAndFinish(native, relay, platform, purchase) });
    }
    return out;
}

/** The store's localized price for a product, or null (the button then shows no price). */
export function priceOf(products: readonly StoreProduct[], productId: string): string | null {
    const p = products.find((x) => x.id === productId);
    return p && typeof p.displayPrice === 'string' && p.displayPrice.length > 0 ? p.displayPrice : null;
}
