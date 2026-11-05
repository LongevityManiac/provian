/**
 * The copy that names a price or a USDC payment has a store-build twin: the App Store and Play
 * builds buy through the store, so their buttons and lines name the store, never USDC or a dollar
 * figure the store may show differently. The store's own localized price is shown at the confirm.
 */
import type { TFunction } from 'i18next';

const STORE_TWINS: Readonly<Record<string, string>> = {
    'peArchive.turnOn': 'storeBuy.archiveTurnOn',
    'peArchive.buyAnother': 'storeBuy.archiveBuyAnother',
    'peArchive.full': 'storeBuy.archiveFull',
    'peArchive.linePrice': 'storeBuy.archiveLinePrice',
    'peArchive.confirmComing': 'storeBuy.archiveConfirmComing',
};

export function paidCopyKey(key: string, store: 'app_store' | 'google_play' | null): string {
    return store === null ? key : (STORE_TWINS[key] ?? key);
}

export function storeNameOf(t: TFunction, store: 'app_store' | 'google_play' | null): string {
    return store === 'google_play' ? t('storeBuy.googlePlay') : t('storeBuy.appStore');
}

/** `t` for a price-bearing key, in this build's form. */
export function paidCopy(t: TFunction, key: string, store: 'app_store' | 'google_play' | null): string {
    return t(paidCopyKey(key, store), { store: storeNameOf(t, store) });
}
