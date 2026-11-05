/**
 * Coinbase Onramp — Transaction Status client (relay-side source verification).
 *
 * GET https://api.developer.coinbase.com/onramp/v1/buy/user/{partner_user_ref}/transactions
 * returns the user's Onramp transactions (newest first) with status, tx_hash and
 * settlement fields. This is the ONLY trustworthy way to confirm an on-chain USDC
 * arrival actually originated from a Coinbase buy: on-device source attribution
 * is unreliable (Coinbase settlement addresses rotate and are not pinned), so the
 * device heuristic can only scope a time window — it can never PROVE the source.
 * Only the relay, authenticating with the CDP Secret API Key, can confirm it
 * (audit #30). `partner_user_ref` is the stable per-user join key that Coinbase
 * links every session transaction to; the device sets it as the `partnerUserId`
 * query param on the pay.coinbase.com buy URL.
 *
 * Auth: CDP Secret API Key JWT (EdDSA) — the SAME auth the session-token mint
 * uses (coinbase-cdp-auth.ts).
 *
 * Docs: https://docs.cdp.coinbase.com/onramp-&-offramp/onramp-apis/transaction-status
 */
import crypto from 'crypto';
import {
    CDP_HOST,
    CoinbaseNotConfiguredError,
    generateCdpJwt,
    loadCdpCredentials,
} from './coinbase-cdp-auth';

export { CoinbaseNotConfiguredError } from './coinbase-cdp-auth';

/** Failure modes of a transaction-status query, mapped to caller HTTP responses. */
export type CoinbaseTransactionsErrorKind = 'auth' | 'rate_limited' | 'upstream' | 'bad_response';

/** Non-configuration error from the Coinbase Transactions API. */
export class CoinbaseTransactionsError extends Error {
    constructor(
        message: string,
        public readonly httpStatus: number,
        public readonly kind: CoinbaseTransactionsErrorKind,
    ) {
        super(message);
        this.name = 'CoinbaseTransactionsError';
    }
}

/** A money amount as Coinbase returns it (string value + fiat/crypto currency). */
export interface OnrampAmount {
    value: string;
    currency: string;
}

/** One Onramp transaction, normalized from the snake_case API shape. */
export interface OnrampTransaction {
    /** ONRAMP_TRANSACTION_STATUS_{IN_PROGRESS,SUCCESS,FAILED} (or the bare suffix). */
    status: string;
    /** On-chain settlement tx hash once the buy settles (null while in progress). */
    txHash: string | null;
    /** Coinbase's stable transaction id — the idempotency key for a verified PE. */
    transactionId: string | null;
    /** Destination wallet the crypto settled to. */
    walletAddress: string | null;
    /** Crypto amount purchased. */
    purchaseAmount: OnrampAmount | null;
    purchaseCurrency: string | null;
    purchaseNetwork: string | null;
    /** ISO-8601 creation time. */
    createdAt: string | null;
    partnerUserRef: string | null;
}

/** A page of transactions plus the pagination cursor. */
export interface OnrampTransactionsPage {
    transactions: OnrampTransaction[];
    nextPageKey: string | null;
    totalCount: number | null;
}

interface RawOnrampTransaction {
    status?: unknown;
    tx_hash?: unknown;
    transaction_id?: unknown;
    wallet_address?: unknown;
    purchase_amount?: unknown;
    purchase_currency?: unknown;
    purchase_network?: unknown;
    created_at?: unknown;
    partner_user_ref?: unknown;
}

interface RawTransactionsResponse {
    transactions?: unknown;
    next_page_key?: unknown;
    total_count?: unknown;
}

function asStringOrNull(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

function asAmount(v: unknown): OnrampAmount | null {
    if (v && typeof v === 'object') {
        const o = v as { value?: unknown; currency?: unknown };
        if (typeof o.value === 'string' && typeof o.currency === 'string') {
            return { value: o.value, currency: o.currency };
        }
    }
    return null;
}

/** Normalize one raw transaction. `status` defaults to '' (never SUCCESS). */
export function normalizeTransaction(raw: RawOnrampTransaction): OnrampTransaction {
    return {
        status: typeof raw.status === 'string' ? raw.status : '',
        txHash: asStringOrNull(raw.tx_hash),
        transactionId: asStringOrNull(raw.transaction_id),
        walletAddress: asStringOrNull(raw.wallet_address),
        purchaseAmount: asAmount(raw.purchase_amount),
        purchaseCurrency: asStringOrNull(raw.purchase_currency),
        purchaseNetwork: asStringOrNull(raw.purchase_network),
        createdAt: asStringOrNull(raw.created_at),
        partnerUserRef: asStringOrNull(raw.partner_user_ref),
    };
}

/** Parse the raw API response into a typed page (tolerant of missing fields). */
export function parseTransactionsPage(data: RawTransactionsResponse): OnrampTransactionsPage {
    const rawList = Array.isArray(data.transactions) ? (data.transactions as RawOnrampTransaction[]) : [];
    const totalCountNum =
        typeof data.total_count === 'string'
            ? Number.parseInt(data.total_count, 10)
            : typeof data.total_count === 'number'
              ? data.total_count
              : NaN;
    return {
        transactions: rawList.map(normalizeTransaction),
        nextPageKey: asStringOrNull(data.next_page_key),
        totalCount: Number.isFinite(totalCountNum) ? totalCountNum : null,
    };
}

/** True iff `status` is a settled/successful Onramp buy. */
export function isOnrampSuccess(status: string | null | undefined): boolean {
    return typeof status === 'string' && status.toUpperCase().endsWith('SUCCESS');
}

/** True iff `status` is a still-processing Onramp buy (settlement pending). */
export function isOnrampInProgress(status: string | null | undefined): boolean {
    return typeof status === 'string' && status.toUpperCase().endsWith('IN_PROGRESS');
}

/**
 * Derive the stable, per-user Coinbase `partnerUserRef`.
 *
 * Deterministic (recomputable at verify time from the authenticated user id),
 * non-PII, and non-guessable: sha256 of the internal user id (which is itself a
 * non-guessable UUID), optionally peppered with `ONRAMP_PARTNER_REF_PEPPER`.
 * `pv_` + 40 hex = 43 chars, within Coinbase's ≤49-char limit. Coinbase warns
 * against putting PII (email / wallet address) in this field — a hash avoids that.
 */
export function deriveOnrampPartnerRef(userId: string): string {
    if (!userId || typeof userId !== 'string') {
        throw new Error('deriveOnrampPartnerRef: userId is required');
    }
    const pepper = process.env.ONRAMP_PARTNER_REF_PEPPER ?? '';
    const digest = crypto.createHash('sha256').update(`${pepper}:${userId}`).digest('hex');
    return `pv_${digest.slice(0, 40)}`;
}

/**
 * Select the transaction that verifies a device's pending buy: the most-recent
 * SUCCESS whose destination `walletAddress` matches, created no earlier than
 * `sinceMs` (when supplied). Transactions arrive newest-first, so the first
 * match is the most recent. Returns null when none qualifies.
 */
export function findSettledBuy(
    transactions: OnrampTransaction[],
    criteria: { walletAddress: string; sinceMs?: number },
): OnrampTransaction | null {
    const wanted = criteria.walletAddress.toLowerCase();
    for (const tx of transactions) {
        if (!isOnrampSuccess(tx.status)) continue;
        if ((tx.walletAddress ?? '').toLowerCase() !== wanted) continue;
        if (criteria.sinceMs !== undefined) {
            const created = tx.createdAt ? Date.parse(tx.createdAt) : NaN;
            if (Number.isFinite(created) && created < criteria.sinceMs) continue;
        }
        return tx;
    }
    return null;
}

/**
 * True iff at least one transaction for this ref is still settling and could
 * become the matching SUCCESS — so the caller should keep the pending window
 * open rather than fall back to the (source-unverified) device heuristic.
 */
export function hasInProgressBuy(
    transactions: OnrampTransaction[],
    criteria: { walletAddress: string },
): boolean {
    const wanted = criteria.walletAddress.toLowerCase();
    return transactions.some(
        (tx) => isOnrampInProgress(tx.status) && (tx.walletAddress ?? '').toLowerCase() === wanted,
    );
}

/**
 * Verdict for a device's pending buy, from a page of the user's transactions.
 * `verified` → a settled Coinbase buy matches (mint the verified PE);
 * `in_progress` → a matching buy is still settling (keep waiting, don't fall
 * back to the heuristic); `none` → nothing matches (device heuristic may proceed).
 */
export type OnrampVerificationDecision =
    | { kind: 'verified'; tx: OnrampTransaction }
    | { kind: 'in_progress' }
    | { kind: 'none' };

/** Pure decision: classify a transactions page against the device's pending buy. */
export function decideOnrampVerification(
    page: OnrampTransactionsPage,
    criteria: { walletAddress: string; sinceMs?: number },
): OnrampVerificationDecision {
    const settled = findSettledBuy(page.transactions, criteria);
    if (settled) return { kind: 'verified', tx: settled };
    if (hasInProgressBuy(page.transactions, { walletAddress: criteria.walletAddress })) {
        return { kind: 'in_progress' };
    }
    return { kind: 'none' };
}

/** Optional injectable fetch (tests). Defaults to global fetch. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}>;

/**
 * Fetch a page of Onramp transactions for `partnerUserRef` from the CDP
 * Transaction Status API. Authenticates with a fresh CDP Secret-key JWT.
 *
 * @throws CoinbaseNotConfiguredError  when CDP credentials are absent (→ 503)
 * @throws CoinbaseTransactionsError   on auth / rate-limit / upstream failure
 */
export async function fetchOnrampTransactions(
    partnerUserRef: string,
    opts: { pageSize?: number; pageKey?: string; fetchImpl?: FetchLike } = {},
): Promise<OnrampTransactionsPage> {
    if (!partnerUserRef) {
        throw new CoinbaseTransactionsError('partnerUserRef is required', 400, 'bad_response');
    }
    const creds = loadCdpCredentials(); // throws CoinbaseNotConfiguredError when unset

    // The JWT `uri` claim signs method + host + path WITHOUT the query string.
    const path = `/onramp/v1/buy/user/${encodeURIComponent(partnerUserRef)}/transactions`;
    const jwt = generateCdpJwt(creds, 'GET', path);

    const url = new URL(`https://${CDP_HOST}${path}`);
    if (opts.pageSize) url.searchParams.set('page_size', String(opts.pageSize));
    if (opts.pageKey) url.searchParams.set('page_key', opts.pageKey);

    const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await doFetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    });

    if (res.status === 401 || res.status === 403) {
        throw new CoinbaseTransactionsError(`CDP auth rejected (${res.status})`, res.status, 'auth');
    }
    if (res.status === 429) {
        throw new CoinbaseTransactionsError('CDP rate limited (429)', 429, 'rate_limited');
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new CoinbaseTransactionsError(
            `CDP transactions request failed (${res.status}): ${detail.slice(0, 300)}`,
            res.status,
            'upstream',
        );
    }

    let data: unknown;
    try {
        data = await res.json();
    } catch {
        throw new CoinbaseTransactionsError('CDP transactions response was not JSON', res.status, 'bad_response');
    }
    if (!data || typeof data !== 'object') {
        throw new CoinbaseTransactionsError('CDP transactions response was not an object', res.status, 'bad_response');
    }
    return parseTransactionsPage(data as RawTransactionsResponse);
}
