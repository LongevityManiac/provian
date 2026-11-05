/**
 * ProvianStorePurchase — JS interface for the native store-purchase bridge (StoreKit 2 on iOS,
 * Google Play Billing on Android).
 *
 * App code goes through `src/core/store/storePurchase.ts`, which loads this module via
 * `requireOptionalNativeModule('ProvianStorePurchase')`, so a build without it (Expo Go, the
 * website APK's tests) simply has no store purchases.
 */
export interface StoreProduct {
    readonly id: string;
    readonly displayName: string;
    /** The store's localized price, e.g. "$0.99" or "0,99 €". */
    readonly displayPrice: string | null;
}

export interface NativeStorePurchase {
    readonly status: 'purchased' | 'pending' | 'cancelled' | 'unavailable' | 'already_owned' | 'error';
    readonly productId?: string | null;
    /** Apple's transaction id, or Play's order id. */
    readonly transactionId?: string | null;
    /** App Store: StoreKit's signed transaction (JWS), sent to the relay untouched. */
    readonly signedTransaction?: string;
    /** Google Play: the purchase token, sent to the relay untouched. */
    readonly purchaseToken?: string;
    readonly code?: string;
}

export interface ProvianStorePurchaseModule {
    canMakePayments(): boolean;
    products(ids: string[]): Promise<StoreProduct[]>;
    /** `accountToken`: the account token the relay issued (Apple appAccountToken / Play obfuscatedAccountId). */
    purchase(productId: string, accountToken: string): Promise<NativeStorePurchase>;
    /** Purchases bought but not yet finished (not yet recorded by the relay). */
    unfinished(): Promise<NativeStorePurchase[]>;
    /** Finish (iOS: transaction id) or consume (Android: purchase token) one purchase. */
    finish(idOrToken: string): Promise<boolean>;
}
