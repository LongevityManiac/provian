/**
 * The person's PE Archive purchase, as logic the screen renders (PE Archive human-path run,
 * 2026-10-07).
 *
 * the operator’s first purchase died silently: his wallet held $0.945 USDC, the relay refused the signed
 * payment (402 `payment_insufficient_funds`) before recording anything, and the app showed one gray
 * line under a paragraph while the same "Turn on" button came back. Here every outcome of the path
 * becomes something the screen states plainly, and "Nothing was charged" is said only when it is
 * known: before the payment left the phone, or when the relay answered a refusal. A request whose
 * answer was lost is followed up by its request id (derived exactly as the relay derives it) until
 * the relay reports it or the signed authorization has expired.
 */
import { sha256HexOfText } from './meter-wire';

/** Mirrors `archivePaymentRequestId` in provian-backend/src/core/archive/archive-terms.ts. */
export function archiveRequestIdOf(from: string, nonce: string): string {
    return `ap_${sha256HexOfText(`provian.archive.v1|${from.toLowerCase()}|${nonce.toLowerCase()}`).slice(0, 40)}`;
}

export interface SignedArchivePayment {
    readonly requestId: string;
    readonly from: string;
    /** Unix seconds after which the authorization can never be charged. */
    readonly validBefore: number;
}

function fromBase64(text: string): string {
    if (typeof globalThis.atob === 'function') return globalThis.atob(text);
    return Buffer.from(text, 'base64').toString('utf8');
}

/** The request id and expiry of a signed x402 payment (the base64 JSON `signArchivePayment` returns). */
export function signedArchivePaymentOf(payment: string): SignedArchivePayment {
    const parsed = JSON.parse(fromBase64(payment)) as { payload?: { authorization?: Record<string, unknown> } };
    const auth = parsed.payload?.authorization ?? {};
    const from = typeof auth.from === 'string' ? auth.from : '';
    const nonce = typeof auth.nonce === 'string' ? auth.nonce : '';
    const validBefore = Number(auth.validBefore);
    if (!/^0x[0-9a-fA-F]{40}$/.test(from) || !/^0x[0-9a-fA-F]{64}$/.test(nonce) || !Number.isFinite(validBefore)) {
        throw new Error('archive_payment_unreadable');
    }
    return { requestId: archiveRequestIdOf(from, nonce), from, validBefore };
}

/** USDC atomic units (6 decimals) as dollars, rounded DOWN to the cent ("$0.94" for 945000). */
export function usdcDollars(atomic: string): string {
    const n = BigInt(atomic);
    const cents = n / 10_000n;
    return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export interface ArchiveFailureText {
    readonly key: string;
    readonly params?: Record<string, string>;
}

/**
 * The text for a purchase that did not go through, by the code the phone or the relay gave. Every
 * code here is one where nothing was charged: a refusal before signing or sending, or a refusal the
 * relay answered (the relay records a payment only once it is going to submit it, and a submitted
 * charge that fails is reported with its payment as `charge_failed`). An unknown outcome is never
 * passed here — it is followed up instead (`ArchivePurchaseFollowUp`).
 */
export function archiveFailureText(code: string): ArchiveFailureText {
    if (code === 'cancelled') return { key: 'peArchive.reasonCancelled' };
    if (code.startsWith('biometric:')) return { key: 'peArchive.reasonBiometric', params: { code: code.slice('biometric:'.length) } };
    if (code.startsWith('archive_quote_refused')) return { key: 'peArchive.reasonPriceMismatch' };
    if (code.startsWith('quote:')) return { key: 'peArchive.reasonQuoteFailed', params: { code: code.slice('quote:'.length) } };
    if (code.startsWith('sign:')) return { key: 'peArchive.reasonSignFailed', params: { code: code.slice('sign:'.length) } };
    if (code.startsWith('record:')) return { key: 'peArchive.reasonRecordFailed', params: { code: code.slice('record:'.length) } };
    switch (code) {
        case 'payment_insufficient_funds': return { key: 'peArchive.reasonInsufficient' };
        case 'waits_for_gas': return { key: 'peArchive.reasonGas' };
        case 'archive_space_available': return { key: 'peArchive.reasonSpaceAvailable' };
        case 'payment_nonce_used':
        case 'payment_already_used': return { key: 'peArchive.reasonNonceUsed' };
        case 'payment_submit_failed':
        case 'charge_failed':
        case 'transfer_reverted': return { key: 'peArchive.reasonSubmitFailed' };
        case 'session_unavailable':
        case 'archive_http_401': return { key: 'peArchive.reasonSession' };
        case 'archive_not_configured':
        case 'archive_payments_not_configured':
        case 'archive_owner_unresolved': return { key: 'peArchive.reasonUnavailable', params: { code } };
        case 'authorization_expired': return { key: 'peArchive.reasonExpired' };
        default: return { key: 'peArchive.reasonRefused', params: { code } };
    }
}

/** A biometric failure as a purchase code: a cancel is "you cancelled", anything else names itself. */
export function biometricFailureCode(error: unknown): string {
    const authError = (error as { authError?: unknown } | null)?.authError;
    if (typeof authError === 'string' && ['user_cancel', 'system_cancel', 'app_cancel'].includes(authError)) return 'cancelled';
    const name = error instanceof Error ? error.name : 'unknown';
    return `biometric:${typeof authError === 'string' ? authError : name}`;
}

// ─── a purchase whose answer was lost ──────────────────────────────────────────

export const ARCHIVE_PENDING_PURCHASE_KEY = '@provian_archive_pending_purchase_v1';
/** How long past the authorization's expiry the phone keeps asking (the relay may still be writing). */
export const ARCHIVE_FOLLOW_UP_GRACE_S = 90;

export interface PendingArchivePurchase {
    readonly requestId: string;
    /** The paying wallet (lowercase). A pending purchase belongs to this wallet only. */
    readonly from: string;
    readonly validBefore: number;
    readonly startedAtMs: number;
}

export interface PendingStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export async function savePendingPurchase(kv: PendingStore, p: PendingArchivePurchase): Promise<void> {
    await kv.setItem(ARCHIVE_PENDING_PURCHASE_KEY, JSON.stringify({ ...p, from: p.from.toLowerCase() }));
}

/**
 * The purchase still pending for THIS wallet, if any. A record left by another wallet (the wallet was
 * deleted or replaced on this phone), or one that does not name its wallet, is cleared and reads as
 * none: it can never block, or be followed up as, this wallet's purchase. A malformed record reads
 * as none.
 */
export async function readPendingPurchase(kv: PendingStore, walletAddress: string): Promise<PendingArchivePurchase | null> {
    let p: Partial<PendingArchivePurchase>;
    try {
        const raw = await kv.getItem(ARCHIVE_PENDING_PURCHASE_KEY);
        if (!raw) return null;
        p = JSON.parse(raw) as Partial<PendingArchivePurchase>;
    } catch {
        return null;
    }
    const wellFormed = typeof p.requestId === 'string' && /^ap_[0-9a-f]{40}$/.test(p.requestId)
        && typeof p.validBefore === 'number' && Number.isFinite(p.validBefore)
        && typeof p.from === 'string' && /^0x[0-9a-f]{40}$/.test(p.from);
    if (!wellFormed || p.from !== walletAddress.toLowerCase()) {
        await kv.removeItem(ARCHIVE_PENDING_PURCHASE_KEY).catch(() => undefined);
        return null;
    }
    return { requestId: p.requestId as string, from: p.from as string, validBefore: p.validBefore as number, startedAtMs: typeof p.startedAtMs === 'number' ? p.startedAtMs : 0 };
}

export async function clearPendingPurchase(kv: PendingStore): Promise<void> {
    await kv.removeItem(ARCHIVE_PENDING_PURCHASE_KEY);
}

/** What the relay says about a followed-up payment (null = it has no such payment, yet or ever). */
export interface FollowedPayment {
    readonly state: string;
    readonly credited: boolean;
}

export type FollowUpVerdict =
    | { readonly kind: 'credited' }
    | { readonly kind: 'confirming' }
    | { readonly kind: 'not_charged'; readonly code: string }
    | { readonly kind: 'keep_waiting' };

/** One step of following up a purchase. Pure: the screen polls and renders the verdict. */
export function followUpVerdict(payment: FollowedPayment | null, pending: PendingArchivePurchase, nowMs: number): FollowUpVerdict {
    if (payment !== null) {
        if (payment.credited) return { kind: 'credited' };
        if (payment.state === 'charge_failed') return { kind: 'not_charged', code: 'charge_failed' };
        return { kind: 'confirming' };
    }
    if (nowMs / 1000 > pending.validBefore + ARCHIVE_FOLLOW_UP_GRACE_S) return { kind: 'not_charged', code: 'authorization_expired' };
    return { kind: 'keep_waiting' };
}

/** BaseScan for a Base transaction. */
export function baseTxUrl(txHash: string): string {
    return `https://basescan.org/tx/${txHash}`;
}

export function shortHash(txHash: string): string {
    return txHash.length > 14 ? `${txHash.slice(0, 8)}…${txHash.slice(-6)}` : txHash;
}
