/**
 * pendingProtectedNav — a module-level stash for a navigation target that must
 * only be reached from behind the wallet lock. [F11]
 *
 * A push-notification tap (NotificationService) or a deep link (AppNavigator)
 * can arrive while the app is locked (`isAuthenticated === false`, e.g. after a
 * background timeout reset to WalletLock, with the OS still unlocked on a desk).
 * Navigating straight to a sensitive screen (ApprovalReview, ProxiedPaymentApproval,
 * GoalApproval, LinkAccept, …) would land it ON TOP of the lock with no auth.
 *
 * Instead the caller stashes the intended destination here and sends the user to
 * WalletLock; AppNavigator watches `isAuthenticated` and, once a real unlock
 * flips it true, consumes the stash and navigates to the intended screen. Held
 * in memory only — if the app is killed before unlock, the target is dropped,
 * which is the safe outcome (the push/link can be re-tapped).
 */
export type ProtectedNavTarget = { screen: string; params?: Record<string, unknown> };

let pending: ProtectedNavTarget | null = null;

/** Stash the destination to replay after a successful unlock. Last write wins. */
export function stashProtectedNav(target: ProtectedNavTarget): void {
    pending = target;
}

/** Take and clear the stashed destination (at most once). */
export function consumeProtectedNav(): ProtectedNavTarget | null {
    const t = pending;
    pending = null;
    return t;
}

/** Inspect the stash without clearing it. */
export function peekProtectedNav(): ProtectedNavTarget | null {
    return pending;
}
