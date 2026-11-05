/**
 * The store-purchase runtime: the native bridge (absent in a build without it) and the relay calls.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ProvianStorePurchaseModule } from '../../../modules/provian-store-purchase';
import relayService from '../../services/RelayAPIService';
import { storeOfThisBuild } from '../../config/distribution';
import { resumeUnfinished, type StoreRelay } from './storePurchase';

export function storeNative(): ProvianStorePurchaseModule | null {
    try {
        const mod = requireOptionalNativeModule<ProvianStorePurchaseModule>('ProvianStorePurchase');
        return mod && typeof mod.purchase === 'function' ? mod : null;
    } catch {
        return null;
    }
}

export const storeRelay: StoreRelay = {
    storeAccount: () => relayService.storeAccount(),
    redeemStorePurchase: (body) => relayService.redeemStorePurchase(body),
};

/** Send any purchase bought but not yet recorded. A no-op in the website APK. Never throws. */
export async function resumeStorePurchases(): Promise<void> {
    const platform = storeOfThisBuild();
    const native = storeNative();
    if (platform === null || native === null) return;
    await resumeUnfinished(native, storeRelay, platform).catch(() => undefined);
}
