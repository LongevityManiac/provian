
export type PendingLinkAccept = { inviteId: string; agentWalletId: string };

let pending: PendingLinkAccept | null = null;
const listeners = new Set<() => void>();

export function subscribePendingLinkAccept(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Stash the invitation to open once the wallet exists. Last write wins. */
export function stashPendingLinkAccept(target: PendingLinkAccept): void {
    pending = target;
    for (const listener of listeners) listener();
}

/** Inspect the stash without clearing it. */
export function peekPendingLinkAccept(): PendingLinkAccept | null {
    return pending;
}

/** Take and clear the stash (at most once). */
export function consumePendingLinkAccept(): PendingLinkAccept | null {
    const p = pending;
    pending = null;
    return p;
}
