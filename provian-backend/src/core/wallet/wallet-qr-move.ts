/**
 * Moving a wallet between the phone app and the web app with a QR code: the relay's part.
 *
 * The relay is a mailbox. It never sees the seed or anything that could open it; the devices seal
 * the seed to a one-time key of the receiver, authenticated by a secret that travels only in the QR
 * code (src/core/walletHandoff/handoffCrypto.ts in the app). The relay holds, for at most ten minutes:
 * the two devices' labels (so each can show the other), the receiver's one-time public key with
 * its MAC, and, once the sender confirms, the sealed seed. The receiver's pickup deletes the whole
 * session, so nothing stays after the handoff; cancel deletes it too, and every new session sweeps
 * expired ones.
 *
 * Roles. The web app opens the session (it shows the code). `mode: 'send'` means the web app is
 * sending (it already holds the wallet; the phone that scans receives); `mode: 'receive'` means the
 * web app is receiving (the phone that scans sends). The receiver's key comes with whichever side
 * receives: at open for 'receive', at join for 'send'.
 *
 * Each side gets its own bearer token (32 random bytes; only its SHA-256 is stored). One join per
 * session, one seal, one pickup.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const WALLET_HANDOFFS_COLLECTION = 'wallet_handoffs';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_SWEEP_LIMIT = 25;
const MAX_ENVELOPE_FIELD = 4096;

export type HandoffMode = 'send' | 'receive';
export type HandoffPlatform = 'ios' | 'android' | 'web';

export interface HandoffDevice {
    label: string;
    platform: HandoffPlatform;
}

export interface HandoffEnvelope {
    v: 1;
    epk: string;
    iv: string;
    ct: string;
}

interface StoredHandoff {
    mode: HandoffMode;
    creator_device: HandoffDevice;
    creator_token_sha256: string;
    joiner_device: HandoffDevice | null;
    joiner_token_sha256: string | null;
    receiver_key: string | null;
    receiver_key_mac: string | null;
    envelope: HandoffEnvelope | null;
    created_at: number;
    expires_at: number;
}

export class HandoffError extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
        this.name = 'HandoffError';
    }
}

const bad = (code: string): never => { throw new HandoffError(400, code); };
const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{22}$/;

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const docId = (id: string): string => sha256(`handoff:${id}`);
const sameHash = (a: string | null, b: string): boolean =>
    !!a && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function validDevice(raw: unknown): HandoffDevice {
    const device = raw as Partial<HandoffDevice> | null;
    if (!device || typeof device !== 'object') bad('device_invalid');
    const label = typeof device!.label === 'string' ? device!.label.trim() : '';
    // Shown on the other device: printable, short, no control characters.
    if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) bad('device_invalid');
    if (device!.platform !== 'ios' && device!.platform !== 'android' && device!.platform !== 'web') bad('device_invalid');
    return { label, platform: device!.platform as HandoffPlatform };
}

function validKey(key: unknown, mac: unknown): { key: string; mac: string } {
    // An X25519 public key (32 bytes) and an HMAC-SHA256 (32 bytes), base64url without padding.
    if (typeof key !== 'string' || key.length !== 43 || !B64URL.test(key)) bad('receiver_key_invalid');
    if (typeof mac !== 'string' || mac.length !== 43 || !B64URL.test(mac)) bad('receiver_key_invalid');
    return { key: key as string, mac: mac as string };
}

function validEnvelope(raw: unknown): HandoffEnvelope {
    const envelope = raw as Partial<HandoffEnvelope> | null;
    if (!envelope || typeof envelope !== 'object' || envelope.v !== 1) bad('envelope_invalid');
    if (typeof envelope!.epk !== 'string' || envelope!.epk.length !== 43 || !B64URL.test(envelope!.epk)) bad('envelope_invalid');
    if (typeof envelope!.iv !== 'string' || envelope!.iv.length !== 16 || !B64URL.test(envelope!.iv)) bad('envelope_invalid');
    if (typeof envelope!.ct !== 'string' || envelope!.ct.length < 24 || envelope!.ct.length > MAX_ENVELOPE_FIELD || !B64URL.test(envelope!.ct)) bad('envelope_invalid');
    return { v: 1, epk: envelope!.epk!, iv: envelope!.iv!, ct: envelope!.ct! };
}

function validId(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) bad('handoff_invalid');
    return id as string;
}

function validToken(token: unknown): string {
    if (typeof token !== 'string' || token.length !== 43 || !B64URL.test(token)) throw new HandoffError(401, 'handoff_token_invalid');
    return token as string;
}

const newToken = (): string => crypto.randomBytes(32).toString('base64url');

/** Which side a token belongs to, or a 401. */
function roleOf(stored: StoredHandoff, token: string): 'creator' | 'joiner' {
    const hash = sha256(token);
    if (sameHash(stored.creator_token_sha256, hash)) return 'creator';
    if (sameHash(stored.joiner_token_sha256, hash)) return 'joiner';
    throw new HandoffError(401, 'handoff_token_invalid');
}

/** The receiving side: the web app for 'receive', the phone that joined for 'send'. */
const receiverRole = (mode: HandoffMode): 'creator' | 'joiner' => (mode === 'receive' ? 'creator' : 'joiner');

async function sweepExpired(db: Firestore, nowMs: number): Promise<void> {
    try {
        const expired = await db.collection(WALLET_HANDOFFS_COLLECTION).where('expires_at', '<', nowMs).limit(HANDOFF_SWEEP_LIMIT).get();
        await Promise.all(expired.docs.map(doc => doc.ref.delete()));
    } catch {
        // A failed sweep never blocks a handoff; the next open sweeps again.
    }
}

async function load(db: Firestore, id: string, nowMs: number): Promise<{ ref: FirebaseFirestore.DocumentReference; stored: StoredHandoff }> {
    const ref = db.collection(WALLET_HANDOFFS_COLLECTION).doc(docId(id));
    const doc = await ref.get();
    if (!doc.exists) throw new HandoffError(404, 'handoff_not_found');
    const stored = doc.data() as StoredHandoff;
    if (Number(stored.expires_at) < nowMs) {
        await ref.delete().catch(() => undefined);
        throw new HandoffError(410, 'handoff_expired');
    }
    return { ref, stored };
}

/** The web app opens a session and shows its code. */
export async function openHandoff(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{ id: string; token: string; expires_at: number }> {
    const mode = body.mode;
    if (mode !== 'send' && mode !== 'receive') bad('mode_invalid');
    const device = validDevice(body.device);
    const receiver = mode === 'receive' ? validKey(body.receiver_key, body.receiver_key_mac) : null;
    if (mode === 'send' && (body.receiver_key !== undefined || body.receiver_key_mac !== undefined)) bad('receiver_key_unexpected');
    const id = crypto.randomBytes(16).toString('base64url');
    const token = newToken();
    const expires = nowMs + HANDOFF_TTL_MS;
    const stored: StoredHandoff = {
        mode: mode as HandoffMode,
        creator_device: device,
        creator_token_sha256: sha256(token),
        joiner_device: null,
        joiner_token_sha256: null,
        receiver_key: receiver?.key ?? null,
        receiver_key_mac: receiver?.mac ?? null,
        envelope: null,
        created_at: nowMs,
        expires_at: expires,
    };
    await db.collection(WALLET_HANDOFFS_COLLECTION).doc(docId(id)).set(stored);
    await sweepExpired(db, nowMs);
    return { id, token, expires_at: expires };
}

/** The phone joins after scanning. Exactly one join per session. */
export async function joinHandoff(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{
    token: string; mode: HandoffMode; peer_device: HandoffDevice; receiver_key: string | null; receiver_key_mac: string | null; expires_at: number;
}> {
    const id = validId(body.id);
    const device = validDevice(body.device);
    const ref = db.collection(WALLET_HANDOFFS_COLLECTION).doc(docId(id));
    const token = newToken();
    return db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new HandoffError(404, 'handoff_not_found');
        const stored = doc.data() as StoredHandoff;
        if (Number(stored.expires_at) < nowMs) throw new HandoffError(410, 'handoff_expired');
        if (stored.joiner_token_sha256) throw new HandoffError(409, 'handoff_already_joined');
        // A phone that offers a key means to receive; one that offers none means to send. A phone that
        // scanned from the other screen is told so, and the session stays open for the right one.
        const offersKey = body.receiver_key !== undefined || body.receiver_key_mac !== undefined;
        if ((stored.mode === 'send') !== offersKey) throw new HandoffError(409, 'handoff_wrong_direction');
        const receiver = stored.mode === 'send' ? validKey(body.receiver_key, body.receiver_key_mac) : null;
        const update: Partial<StoredHandoff> = { joiner_device: device, joiner_token_sha256: sha256(token) };
        if (receiver) { update.receiver_key = receiver.key; update.receiver_key_mac = receiver.mac; }
        tx.update(ref, update);
        return {
            token,
            mode: stored.mode,
            peer_device: stored.creator_device,
            // The receiving web app's key, for a phone that sends; none for a phone that receives.
            receiver_key: stored.mode === 'receive' ? stored.receiver_key : null,
            receiver_key_mac: stored.mode === 'receive' ? stored.receiver_key_mac : null,
            expires_at: stored.expires_at,
        };
    });
}

/** What a side needs to go on: whether the other side is there, its label and the receiver's key. */
export async function handoffState(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{
    joined: boolean; sealed: boolean; peer_device: HandoffDevice | null; receiver_key: string | null; receiver_key_mac: string | null; expires_at: number;
}> {
    const id = validId(body.id);
    const token = validToken(body.token);
    const { stored } = await load(db, id, nowMs);
    const role = roleOf(stored, token);
    return {
        joined: !!stored.joiner_token_sha256,
        sealed: !!stored.envelope,
        peer_device: role === 'creator' ? stored.joiner_device : stored.creator_device,
        receiver_key: stored.receiver_key,
        receiver_key_mac: stored.receiver_key_mac,
        expires_at: stored.expires_at,
    };
}

/** The sender, after the person confirmed, leaves the sealed seed. Once. */
export async function sealHandoff(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{ sealed: true }> {
    const id = validId(body.id);
    const token = validToken(body.token);
    const envelope = validEnvelope(body.envelope);
    const ref = db.collection(WALLET_HANDOFFS_COLLECTION).doc(docId(id));
    return db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new HandoffError(404, 'handoff_not_found');
        const stored = doc.data() as StoredHandoff;
        if (Number(stored.expires_at) < nowMs) throw new HandoffError(410, 'handoff_expired');
        const role = roleOf(stored, token);
        if (role === receiverRole(stored.mode)) throw new HandoffError(403, 'handoff_not_sender');
        if (!stored.joiner_token_sha256 || !stored.receiver_key) throw new HandoffError(409, 'handoff_not_joined');
        if (stored.envelope) throw new HandoffError(409, 'handoff_already_sealed');
        tx.update(ref, { envelope });
        return { sealed: true as const };
    });
}

/** The receiver picks up the sealed seed; the session is deleted in the same step. */
export async function takeHandoff(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{ envelope: HandoffEnvelope | null }> {
    const id = validId(body.id);
    const token = validToken(body.token);
    const ref = db.collection(WALLET_HANDOFFS_COLLECTION).doc(docId(id));
    return db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new HandoffError(404, 'handoff_not_found');
        const stored = doc.data() as StoredHandoff;
        if (Number(stored.expires_at) < nowMs) throw new HandoffError(410, 'handoff_expired');
        const role = roleOf(stored, token);
        if (role !== receiverRole(stored.mode)) throw new HandoffError(403, 'handoff_not_receiver');
        if (!stored.envelope) return { envelope: null };
        tx.delete(ref);
        return { envelope: stored.envelope };
    });
}

/** Either side ends the session; nothing is kept. */
export async function cancelHandoff(db: Firestore, body: Record<string, unknown>, nowMs = Date.now()): Promise<{ cancelled: true }> {
    const id = validId(body.id);
    const token = validToken(body.token);
    const { ref, stored } = await load(db, id, nowMs);
    roleOf(stored, token);
    await ref.delete();
    return { cancelled: true };
}
