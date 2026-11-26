/**
 * A queue of "open the wallet" requests from code that needs the seed (sign, send, reveal the
 * phrase) to the one on-screen prompt (WebUnlockHost). The phone shows Face ID at that moment; the
 * web app shows the passkey button, plus the PIN when the vault is closed or the action asks for it.
 */
export type UnlockMode =
    /** The vault is closed: passkey + PIN. */
    | 'unlock'
    /** The vault is open: a fresh passkey check only. */
    | 'presence'
    /** Passkey + PIN again even though the vault is open (showing the recovery phrase). */
    | 'reveal'
    /** Passkey + PIN again even though the vault is open (moving the wallet to a phone by QR code). */
    | 'move';

/** Why an open vault asks for the PIN again; the prompt's title names it. */
export type PinPurpose = 'reveal' | 'move';

export interface UnlockRequest {
    readonly id: number;
    readonly reason: string;
    readonly mode: UnlockMode;
}

interface Pending extends UnlockRequest {
    resolve: () => void;
    reject: (err: Error) => void;
}

export class UnlockCancelledError extends Error {
    readonly code = 'ERR_SEED_AUTH_CANCELLED';
    constructor() { super('User cancelled the operation.'); this.name = 'UnlockCancelledError'; }
}

const queue: Pending[] = [];
const listeners = new Set<(request: UnlockRequest | null) => void>();
let nextId = 1;

function current(): UnlockRequest | null {
    const head = queue[0];
    return head ? { id: head.id, reason: head.reason, mode: head.mode } : null;
}

function notify(): void {
    const head = current();
    for (const listener of listeners) listener(head);
}

export function subscribeUnlockRequests(listener: (request: UnlockRequest | null) => void): () => void {
    listeners.add(listener);
    listener(current());
    return () => listeners.delete(listener);
}

export function requestVaultAccess(reason: string, mode: UnlockMode): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        queue.push({ id: nextId++, reason, mode, resolve, reject });
        notify();
    });
}

export function settleUnlockRequest(id: number, error?: Error): void {
    const index = queue.findIndex(item => item.id === id);
    if (index < 0) return;
    const [item] = queue.splice(index, 1);
    if (error) item.reject(error);
    else item.resolve();
    notify();
}

export function cancelAllUnlockRequests(): void {
    while (queue.length) queue.shift()!.reject(new UnlockCancelledError());
    notify();
}

const pinReasons = new Map<string, PinPurpose[]>();

/**
 * The seed access started with this exact `reason` must ask for the PIN as well as the passkey,
 * even while the wallet is open (showing the recovery phrase, or moving the wallet to a phone). It is
 * bound to the reason, not to whichever action starts next, so another action queued ahead of it
 * cannot use it up. A no-op off the web.
 */
export function requirePinForAction(reason: string, purpose: PinPurpose = 'reveal'): void {
    pinReasons.set(reason, [...(pinReasons.get(reason) ?? []), purpose]);
}

/**
 * Called by `beginActionAsync`: the purpose (consumed) when an action with this reason must ask for
 * the PIN, otherwise null.
 */
export function takePinForAction(reason: string): PinPurpose | null {
    const pending = pinReasons.get(reason);
    if (!pending?.length) return null;
    const [purpose, ...rest] = pending;
    if (rest.length) pinReasons.set(reason, rest);
    else pinReasons.delete(reason);
    return purpose;
}
