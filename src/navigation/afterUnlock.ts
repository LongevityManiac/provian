/**
 * afterUnlock — where a real wallet unlock lands.
 *
 * A notification tapped on a locked phone stashes its screen (pendingProtectedNav) and opens
 * WalletLock. The unlock used to flip `isAuthenticated` and then reset the stack to MainTabs, while
 * AppNavigator replayed the stash as soon as `isAuthenticated` flipped. The two raced: the stashed
 * screen could mount and be wiped by the reset in the same moment — a Commons thread loaded, marked
 * itself read, and vanished, so the badge cleared on a message the person never saw.
 *
 * Here the unlock takes the stash itself BEFORE it flips `isAuthenticated` (so AppNavigator finds
 * nothing to replay), resets to the app, and then opens the stashed screen on top of it. When a gate
 * must come first (a restore of an unreadable seed, a required cloud backup, Terms or a Privacy
 * Policy changed since this install accepted them) the stashed screen is
 * dropped: it must not open over that screen, and nothing would replay it afterwards. The message it
 * pointed at stays unread, so the person finds it in the app once the gate is done.
 */
import { consumeProtectedNav } from './pendingProtectedNav';

type ResetState = { index: number; routes: Array<{ name: string; params?: Record<string, unknown> }> };

export interface UnlockNavigation {
    reset(state: ResetState): void;
    navigate(screen: string, params?: Record<string, unknown>): void;
}

export type UnlockGate = 'app' | 'backup' | 'restore' | 'terms';

export function landAfterUnlock(
    navigation: UnlockNavigation,
    gate: UnlockGate,
    authenticate: () => void,
    consume: typeof consumeProtectedNav = consumeProtectedNav,
): void {
    const target = consume();
    authenticate();
    if (gate === 'restore') {
        navigation.reset({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'RecoveryStart' }] });
    } else if (gate === 'backup') {
        navigation.reset({ index: 0, routes: [{ name: 'CloudBackupConfirm', params: { requiredBeforeApp: true } }] });
    } else if (gate === 'terms') {
        navigation.reset({ index: 0, routes: [{ name: 'Consent', params: { review: true } }] });
    } else {
        navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
        if (target) navigation.navigate(target.screen, target.params);
    }
}
