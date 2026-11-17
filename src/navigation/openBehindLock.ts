/**
 * openBehindLock — open a screen that must only ever sit on top of an unlocked wallet.
 *
 * A deep link can arrive while the wallet is locked. Navigating straight to its screen would put
 * that screen (and every action on it) over the lock with no unlock. So: when the wallet is
 * unlocked the screen opens at once; when it is locked the destination is held
 * (pendingProtectedNav) and the lock screen is shown. The unlock then opens the held screen, or
 * drops it when a required gate comes first (afterUnlock).
 */
import { stashProtectedNav, type ProtectedNavTarget } from './pendingProtectedNav';

export interface LockAwareNavigation {
    navigate(screen: string, params?: Record<string, unknown>): void;
}

export function openBehindLock(
    navigation: LockAwareNavigation,
    authenticated: boolean,
    target: ProtectedNavTarget,
    stash: (target: ProtectedNavTarget) => void = stashProtectedNav,
): void {
    if (authenticated) {
        navigation.navigate(target.screen, target.params);
        return;
    }
    stash(target);
    navigation.navigate('WalletLock');
}
