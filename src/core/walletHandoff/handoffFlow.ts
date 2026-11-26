/**
 * The four sides of a QR handoff, over the relay mailbox (/v1/handoff) and handoffCrypto.
 *
 *   web sends     (Add your phone):            openWebSend   → waitForJoin → confirm(seal)
 *   phone receives (From your computer):       joinAsReceiver → waitForWallet
 *   web receives  (I already have a wallet):   openWebReceive → waitForJoin → waitForWallet
 *   phone sends   (Add a computer):            joinAsSender  → confirm(seal)
 *
 * A sender always checks the receiver's key against the code's secret before it seals, and shows
 * the receiving device's label and the match code before the person confirms.
 */
import {
    decodeHandoffQr,
    encodeHandoffQr,
    handoffMatchCode,
    newHandoffSecret,
    newReceiverKeyPair,
    openHandoff,
    receiverKeyMac,
    sealHandoff,
    toB64Url,
    verifyReceiverKey,
    type HandoffEnvelope,
    type ReceiverKeyPair,
} from './handoffCrypto';

export type HandoffPlatform = 'ios' | 'android' | 'web';
export interface HandoffDevice { label: string; platform: HandoffPlatform }

export interface HandoffRelay {
    handoffCall<T>(action: 'open' | 'join' | 'state' | 'seal' | 'take' | 'cancel', body: Record<string, unknown>): Promise<T>;
}

interface StateResponse {
    joined: boolean;
    sealed: boolean;
    peer_device: HandoffDevice | null;
    receiver_key: string | null;
    receiver_key_mac: string | null;
    expires_at: number;
}

export class HandoffNotACodeError extends Error {
    constructor() { super('handoff_not_a_code'); this.name = 'HandoffNotACodeError'; }
}
export class HandoffExpiredError extends Error {
    constructor() { super('handoff_expired'); this.name = 'HandoffExpiredError'; }
}

const POLL_MS = 1200;

export interface PollOptions {
    signal?: { aborted: boolean };
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function expiredOrAborted(expiresAt: number, options: PollOptions): void {
    if (options.signal?.aborted) throw new Error('handoff_cancelled');
    if ((options.now ?? Date.now)() > expiresAt) throw new HandoffExpiredError();
}

function relayError(err: unknown): never {
    const code = err instanceof Error ? err.message : String(err);
    if (code === 'handoff_expired' || code === 'handoff_not_found') throw new HandoffExpiredError();
    throw err instanceof Error ? err : new Error(code);
}

/**
 * A failure worth trying again while polling: no answer at all (a dropped connection), a busy or
 * failing relay (rate limit, 5xx), or a reply without a code. A refusal the relay names (an expired
 * session, a wrong token, a malformed request) is final. Polling stops at the session's expiry anyway.
 */
export function isTransientRelayError(err: unknown): boolean {
    if (err instanceof HandoffExpiredError) return false;
    const code = err instanceof Error ? err.message : String(err);
    if (code === 'rate_limited' || code === 'temporarily_unavailable' || code === 'internal_error') return true;
    if (/^handoff_\w+_failed_\d+$/.test(code)) return true;
    return !/^(?:handoff|receiver_key|device|envelope|mode|id|token)_/.test(code);
}

/** One poll: a transient failure answers null (try again after a pause); anything else is thrown. */
async function poll<T>(call: () => Promise<T>): Promise<T | null> {
    try {
        return await call().catch(relayError);
    } catch (err) {
        if (isTransientRelayError(err)) return null;
        throw err;
    }
}

/** A session one side holds: its id, token, the code's secret and (for a receiver) its key pair. */
export interface HandoffSession {
    id: string;
    token: string;
    secret: Uint8Array;
    expiresAt: number;
    receiver: ReceiverKeyPair | null;
}

export interface HandoffPeer {
    device: HandoffDevice;
    matchCode: string;
    receiverKey: Uint8Array;
}

// ── Web app: open a session and show its code ─────────────────────────────────

export async function openWebSession(relay: HandoffRelay, mode: 'send' | 'receive', device: HandoffDevice): Promise<{ session: HandoffSession; qrText: string }> {
    const secret = newHandoffSecret();
    const receiver = mode === 'receive' ? newReceiverKeyPair() : null;
    const opened = await relay.handoffCall<{ id: string; token: string; expires_at: number }>('open', receiver
        ? { mode, device, ...receiverKeyFields(receiver, secret) }
        : { mode, device });
    const session: HandoffSession = { id: opened.id, token: opened.token, secret, expiresAt: opened.expires_at, receiver };
    return { session, qrText: encodeHandoffQr({ id: opened.id, secret }) };
}

// The relay assigns the session id only when the session opens, so a receiver key sent at open is
// bound to the code's secret alone (an empty id; the secret is fresh for every session); a key sent
// at join is bound to the id as well.
const OPEN_BINDING = '';

function receiverKeyFields(receiver: ReceiverKeyPair, secret: Uint8Array): { receiver_key: string; receiver_key_mac: string } {
    return { receiver_key: toB64Url(receiver.publicKey), receiver_key_mac: receiverKeyMac(secret, OPEN_BINDING, receiver.publicKey) };
}

/** Wait until the phone scanned and joined; returns its label, the match code and the verified receiver key. */
export async function waitForJoin(relay: HandoffRelay, session: HandoffSession, options: PollOptions = {}): Promise<HandoffPeer> {
    const sleep = options.sleep ?? defaultSleep;
    for (;;) {
        expiredOrAborted(session.expiresAt, options);
        const state = await poll(() => relay.handoffCall<StateResponse>('state', { id: session.id, token: session.token }));
        if (state?.joined && state.peer_device && state.receiver_key && state.receiver_key_mac) {
            const binding = session.receiver ? OPEN_BINDING : session.id;
            const receiverKey = verifyReceiverKey(session.secret, binding, state.receiver_key, state.receiver_key_mac);
            return { device: state.peer_device, matchCode: handoffMatchCode(session.secret, session.id, receiverKey), receiverKey };
        }
        await sleep(POLL_MS);
    }
}

// ── Phone: scan the code and join ─────────────────────────────────────────────

/** A join this phone refuses after the relay accepted it: end the session, then report why. */
async function leave(relay: HandoffRelay, id: string, token: string, reason: unknown): Promise<never> {
    await relay.handoffCall('cancel', { id, token }).catch(() => undefined);
    throw reason;
}

/** Phone receiving (From your computer): join with a fresh key; the web app confirms and sends. */
export async function joinAsReceiver(relay: HandoffRelay, scanned: string, device: HandoffDevice): Promise<{ session: HandoffSession; peer: HandoffPeer }> {
    const qr = decodeHandoffQr(scanned);
    if (!qr) throw new HandoffNotACodeError();
    const receiver = newReceiverKeyPair();
    const joined = await relay.handoffCall<{ token: string; mode: string; peer_device: HandoffDevice; expires_at: number }>('join', {
        id: qr.id, device, receiver_key: toB64Url(receiver.publicKey), receiver_key_mac: receiverKeyMac(qr.secret, qr.id, receiver.publicKey),
    }).catch(relayError);
    if (joined.mode !== 'send') return leave(relay, qr.id, joined.token, new Error('handoff_wrong_direction'));
    const session: HandoffSession = { id: qr.id, token: joined.token, secret: qr.secret, expiresAt: joined.expires_at, receiver };
    return { session, peer: { device: joined.peer_device, matchCode: handoffMatchCode(qr.secret, qr.id, receiver.publicKey), receiverKey: receiver.publicKey } };
}

/** Phone sending (Add a computer): join, and check the web app's key against the code before anything is sealed. */
export async function joinAsSender(relay: HandoffRelay, scanned: string, device: HandoffDevice): Promise<{ session: HandoffSession; peer: HandoffPeer }> {
    const qr = decodeHandoffQr(scanned);
    if (!qr) throw new HandoffNotACodeError();
    const joined = await relay.handoffCall<{ token: string; mode: string; peer_device: HandoffDevice; receiver_key: string | null; receiver_key_mac: string | null; expires_at: number }>('join', {
        id: qr.id, device,
    }).catch(relayError);
    if (joined.mode !== 'receive' || !joined.receiver_key || !joined.receiver_key_mac) return leave(relay, qr.id, joined.token, new Error('handoff_wrong_direction'));
    let receiverKey: Uint8Array;
    try {
        receiverKey = verifyReceiverKey(qr.secret, OPEN_BINDING, joined.receiver_key, joined.receiver_key_mac);
    } catch (err) {
        return leave(relay, qr.id, joined.token, err);
    }
    const session: HandoffSession = { id: qr.id, token: joined.token, secret: qr.secret, expiresAt: joined.expires_at, receiver: null };
    return { session, peer: { device: joined.peer_device, matchCode: handoffMatchCode(qr.secret, qr.id, receiverKey), receiverKey } };
}

// ── Both: send and receive ────────────────────────────────────────────────────

/** The sender, after the person confirmed with their unlock: seal the seed to the verified receiver key. */
export async function sendWallet(relay: HandoffRelay, session: HandoffSession, peer: HandoffPeer, mnemonic: string, walletAddress: string): Promise<void> {
    const envelope = sealHandoff({ secret: session.secret, id: session.id, receiverPublicKey: peer.receiverKey, mnemonic, walletAddress });
    await relay.handoffCall('seal', { id: session.id, token: session.token, envelope }).catch(relayError);
}

/** The receiver: wait for the sealed seed, pick it up (the relay deletes the session) and open it. */
export async function waitForWallet(relay: HandoffRelay, session: HandoffSession, options: PollOptions = {}): Promise<{ mnemonic: string; walletAddress: string }> {
    if (!session.receiver) throw new Error('handoff_not_receiver');
    const sleep = options.sleep ?? defaultSleep;
    for (;;) {
        expiredOrAborted(session.expiresAt, options);
        const taken = await poll(() => relay.handoffCall<{ envelope: HandoffEnvelope | null }>('take', { id: session.id, token: session.token }));
        if (taken?.envelope) return openHandoff({ secret: session.secret, id: session.id, receiver: session.receiver, envelope: taken.envelope });
        await sleep(POLL_MS);
    }
}

/**
 * While the person decides (the confirm step), notice when the other side ended the session: it
 * throws HandoffExpiredError once the session is gone or expired, and 'handoff_cancelled' when
 * aborted. Abort it before sealing, because a delivered wallet also ends the session.
 */
export async function watchSession(relay: HandoffRelay, session: HandoffSession, options: PollOptions = {}): Promise<never> {
    const sleep = options.sleep ?? defaultSleep;
    for (;;) {
        await sleep(POLL_MS * 2);
        expiredOrAborted(session.expiresAt, options);
        await poll(() => relay.handoffCall<StateResponse>('state', { id: session.id, token: session.token }));
        expiredOrAborted(session.expiresAt, options);
    }
}

/** Best effort: end a session the person left. */
export async function cancelSession(relay: HandoffRelay, session: HandoffSession | null): Promise<void> {
    if (!session) return;
    await relay.handoffCall('cancel', { id: session.id, token: session.token }).catch(() => undefined);
}
