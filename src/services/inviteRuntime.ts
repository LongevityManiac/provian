/**
 * Production wiring for invite capture (`InviteCapture.ts`) and the first-launch deferred
 * invite (`DeferredInvite.ts`). Kept apart from those modules so their rules run under test
 * without Expo's native modules.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { useWalletStore } from '../store/walletStore';
import { stashPendingLinkAccept } from '../navigation/pendingLinkAccept';
import { captureInviteForNewWallet, type InviteCaptureDeps, type InviteRef } from './InviteCapture';
import { runDeferredInviteCheck, type DeferredInviteOutcome } from './DeferredInvite';

export function productionInviteCaptureDeps(): InviteCaptureDeps {
    return {
        stashPendingLinkAccept,
    };
}

export function captureInvite(invite: InviteRef): Promise<boolean> {
    return captureInviteForNewWallet(invite, productionInviteCaptureDeps());
}

let deferredCheck: Promise<DeferredInviteOutcome> | null = null;

export function startDeferredInviteCheck(): Promise<DeferredInviteOutcome> {
    if (deferredCheck !== null) return deferredCheck;
    deferredCheck = runDeferredInviteCheck({
            platform: Platform.OS,
            storage: AsyncStorage,
            walletExists: () => {
                const { onboardingComplete, address } = useWalletStore.getState();
                return onboardingComplete === true || (typeof address === 'string' && address.length > 0);
            },
            getInstallReferrer: () => Application.getInstallReferrerAsync(),
            clipboardHasUrl: () => Clipboard.hasUrlAsync(),
            clipboardGetUrl: () => Clipboard.getUrlAsync(),
            clipboardGetString: () => Clipboard.getStringAsync(),
            capture: (invite) => captureInviteForNewWallet(invite, productionInviteCaptureDeps()),
        });
    return deferredCheck;
}
