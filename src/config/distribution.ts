/**
 * Where this build is distributed, which decides two things:
 * - how the PE Archive and Settle now are paid for: an in-app purchase through the store in a
 *   store build, USDC from the wallet in the website APK (it has no store billing);
 * - whether the app checks for a newer APK: only the website APK does. A store build is updated
 *   by its store.
 *
 * Every iOS build ships through the App Store. An Android build is a Google Play build only when
 * it was built with `EXPO_PUBLIC_DISTRIBUTION=play` (`scripts/build-android-release.sh --play`);
 * every other Android build is the website APK.
 */
import { Platform } from 'react-native';

export type Distribution = 'store' | 'website';

export function distributionFor(os: string, flag: string | undefined): Distribution {
    if (os === 'ios') return 'store';
    if (os === 'android') return flag === 'play' ? 'store' : 'website';
    return 'website';
}

export function appDistribution(): Distribution {
    return distributionFor(Platform.OS, process.env.EXPO_PUBLIC_DISTRIBUTION);
}

/** The store this build buys through, or null for the website APK. */
export function storeOfThisBuild(): 'app_store' | 'google_play' | null {
    if (appDistribution() !== 'store') return null;
    return Platform.OS === 'ios' ? 'app_store' : 'google_play';
}
