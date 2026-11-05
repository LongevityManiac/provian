/**
 * Coinbase Transactions client (#30 relay-side source verification) — unit tests.
 *
 * Covers the pure decision/parse helpers (fail-before/pass-after for the
 * verified/in-progress/none classification) and the authenticated fetch: the
 * JWT `uri` claim, header, pagination, and the auth/rate-limit/upstream error
 * mapping. Uses an injected fetch — no network.
 */
import {
    CoinbaseNotConfiguredError,
    CoinbaseTransactionsError,
    decideOnrampVerification,
    deriveOnrampPartnerRef,
    fetchOnrampTransactions,
    findSettledBuy,
    hasInProgressBuy,
    isOnrampInProgress,
    isOnrampSuccess,
    normalizeTransaction,
    parseTransactionsPage,
    type FetchLike,
    type OnrampTransaction,
} from './coinbase-transactions';

const SUCCESS = 'ONRAMP_TRANSACTION_STATUS_SUCCESS';
const IN_PROGRESS = 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS';
const FAILED = 'ONRAMP_TRANSACTION_STATUS_FAILED';
const WALLET = '0x1111111111111111111111111111111111111111';

function tx(overrides: Partial<OnrampTransaction> = {}): OnrampTransaction {
    return {
        status: SUCCESS,
        txHash: '0xabc',
        transactionId: 'cbtx_1',
        walletAddress: WALLET,
        purchaseAmount: { value: '50', currency: 'USDC' },
        purchaseCurrency: 'USDC',
        purchaseNetwork: 'base',
        createdAt: '2026-07-02T12:00:00Z',
        partnerUserRef: 'pv_abc',
        ...overrides,
    };
}

function fakeFetch(status: number, body: unknown): { impl: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const impl: FetchLike = async (url, init) => {
        calls.push({ url, headers: init.headers });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
    };
    return { impl, calls };
}

describe('deriveOnrampPartnerRef', () => {
    afterEach(() => {
        delete process.env.ONRAMP_PARTNER_REF_PEPPER;
    });

    it('is deterministic, prefixed, ≤49 chars, and non-PII (excludes the userId)', () => {
        const userId = 'user-uuid-1234-5678';
        const ref = deriveOnrampPartnerRef(userId);
        expect(ref).toBe(deriveOnrampPartnerRef(userId)); // deterministic → recomputable at verify time
        expect(ref).toMatch(/^pv_[0-9a-f]{40}$/);
        expect(ref.length).toBeLessThanOrEqual(49); // Coinbase limit
        expect(ref).not.toContain(userId); // hashed, not raw PII
    });

    it('differs per user and per pepper', () => {
        expect(deriveOnrampPartnerRef('a')).not.toBe(deriveOnrampPartnerRef('b'));
        const base = deriveOnrampPartnerRef('a');
        process.env.ONRAMP_PARTNER_REF_PEPPER = 'salt';
        expect(deriveOnrampPartnerRef('a')).not.toBe(base);
    });

    it('rejects an empty userId', () => {
        expect(() => deriveOnrampPartnerRef('')).toThrow();
    });
});

describe('status helpers', () => {
    it('isOnrampSuccess matches only SUCCESS (prefixed or bare)', () => {
        expect(isOnrampSuccess(SUCCESS)).toBe(true);
        expect(isOnrampSuccess('SUCCESS')).toBe(true);
        expect(isOnrampSuccess(IN_PROGRESS)).toBe(false);
        expect(isOnrampSuccess(FAILED)).toBe(false);
        expect(isOnrampSuccess(null)).toBe(false);
    });

    it('isOnrampInProgress matches only IN_PROGRESS', () => {
        expect(isOnrampInProgress(IN_PROGRESS)).toBe(true);
        expect(isOnrampInProgress(SUCCESS)).toBe(false);
    });
});

describe('parseTransactionsPage / normalizeTransaction', () => {
    it('normalizes snake_case fields and tolerates missing ones', () => {
        const page = parseTransactionsPage({
            transactions: [
                {
                    status: SUCCESS,
                    tx_hash: '0xdeadbeef',
                    transaction_id: 'cbtx_9',
                    wallet_address: WALLET,
                    purchase_amount: { value: '25.5', currency: 'USDC' },
                    purchase_currency: 'USDC',
                    purchase_network: 'base',
                    created_at: '2026-07-02T00:00:00Z',
                    partner_user_ref: 'pv_x',
                },
                { status: IN_PROGRESS }, // sparse row
            ],
            next_page_key: 'pk2',
            total_count: '2',
        });
        expect(page.transactions).toHaveLength(2);
        expect(page.transactions[0]).toMatchObject({
            status: SUCCESS,
            txHash: '0xdeadbeef',
            transactionId: 'cbtx_9',
            walletAddress: WALLET,
            purchaseAmount: { value: '25.5', currency: 'USDC' },
        });
        expect(page.transactions[1].txHash).toBeNull();
        expect(page.nextPageKey).toBe('pk2');
        expect(page.totalCount).toBe(2);
    });

    it('a malformed status never reads as SUCCESS', () => {
        expect(normalizeTransaction({ status: 42 as unknown as string }).status).toBe('');
        expect(isOnrampSuccess(normalizeTransaction({}).status)).toBe(false);
    });
});

describe('findSettledBuy', () => {
    it('returns the first SUCCESS matching wallet (case-insensitive)', () => {
        const found = findSettledBuy([tx({ transactionId: 'a' }), tx({ transactionId: 'b' })], {
            walletAddress: WALLET.toUpperCase(),
        });
        expect(found?.transactionId).toBe('a');
    });

    it('ignores FAILED / IN_PROGRESS / wrong-wallet transactions', () => {
        expect(findSettledBuy([tx({ status: FAILED })], { walletAddress: WALLET })).toBeNull();
        expect(findSettledBuy([tx({ status: IN_PROGRESS })], { walletAddress: WALLET })).toBeNull();
        expect(findSettledBuy([tx({ walletAddress: '0x2222222222222222222222222222222222222222' })], {
            walletAddress: WALLET,
        })).toBeNull();
    });

    it('respects the sinceMs lower bound (drops buys older than the window)', () => {
        const old = tx({ createdAt: '2020-01-01T00:00:00Z' });
        expect(findSettledBuy([old], { walletAddress: WALLET, sinceMs: Date.parse('2026-01-01T00:00:00Z') })).toBeNull();
        const fresh = tx({ createdAt: '2026-07-02T12:00:00Z' });
        expect(
            findSettledBuy([fresh], { walletAddress: WALLET, sinceMs: Date.parse('2026-07-02T00:00:00Z') }),
        ).not.toBeNull();
    });
});

describe('decideOnrampVerification', () => {
    const page = (txs: OnrampTransaction[]) => ({ transactions: txs, nextPageKey: null, totalCount: txs.length });

    it('verified when a settled SUCCESS matches', () => {
        const d = decideOnrampVerification(page([tx()]), { walletAddress: WALLET });
        expect(d.kind).toBe('verified');
        if (d.kind === 'verified') expect(d.tx.transactionId).toBe('cbtx_1');
    });

    it('in_progress when only a matching IN_PROGRESS exists', () => {
        expect(decideOnrampVerification(page([tx({ status: IN_PROGRESS })]), { walletAddress: WALLET }).kind).toBe(
            'in_progress',
        );
    });

    it('none when nothing matches', () => {
        expect(decideOnrampVerification(page([tx({ status: FAILED })]), { walletAddress: WALLET }).kind).toBe('none');
        expect(decideOnrampVerification(page([]), { walletAddress: WALLET }).kind).toBe('none');
    });

    it('hasInProgressBuy is wallet-scoped', () => {
        expect(hasInProgressBuy([tx({ status: IN_PROGRESS })], { walletAddress: WALLET })).toBe(true);
        expect(hasInProgressBuy([tx({ status: IN_PROGRESS, walletAddress: '0x9999999999999999999999999999999999999999' })], {
            walletAddress: WALLET,
        })).toBe(false);
    });
});

describe('fetchOnrampTransactions (authenticated)', () => {
    const savedEnv = { ...process.env };
    beforeEach(() => {
        // A valid CDP Secret key: any 32-byte ed25519 seed (first 32 of 64).
        process.env.COINBASE_CDP_API_KEY_ID = 'test-key-id';
        process.env.COINBASE_CDP_API_PRIVATE_KEY = Buffer.alloc(64, 7).toString('base64');
    });
    afterEach(() => {
        for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
        Object.assign(process.env, savedEnv);
    });

    it('signs a Bearer JWT whose uri matches GET host+path and sets pagination', async () => {
        const ref = 'pv_deadbeef';
        const { impl, calls } = fakeFetch(200, { transactions: [], next_page_key: null, total_count: '0' });
        await fetchOnrampTransactions(ref, { pageSize: 10, fetchImpl: impl });

        expect(calls).toHaveLength(1);
        const call = calls[0];
        expect(call.url).toContain(`/onramp/v1/buy/user/${ref}/transactions`);
        expect(call.url).toContain('page_size=10');
        const auth = call.headers.Authorization;
        expect(auth).toMatch(/^Bearer /);
        // Decode the JWT payload and verify the signed uri (no query string).
        const payload = JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1], 'base64url').toString());
        expect(payload.uri).toBe(`GET api.developer.coinbase.com/onramp/v1/buy/user/${ref}/transactions`);
    });

    it('parses a 200 page', async () => {
        const { impl } = fakeFetch(200, {
            transactions: [{ status: SUCCESS, transaction_id: 'cbtx_1', wallet_address: WALLET }],
            total_count: '1',
        });
        const page = await fetchOnrampTransactions('pv_x', { fetchImpl: impl });
        expect(page.transactions[0].transactionId).toBe('cbtx_1');
        expect(page.totalCount).toBe(1);
    });

    it('maps 401/403 → auth, 429 → rate_limited, 500 → upstream', async () => {
        await expect(fetchOnrampTransactions('pv_x', { fetchImpl: fakeFetch(401, '').impl })).rejects.toMatchObject({
            kind: 'auth',
        });
        await expect(fetchOnrampTransactions('pv_x', { fetchImpl: fakeFetch(403, '').impl })).rejects.toBeInstanceOf(
            CoinbaseTransactionsError,
        );
        await expect(fetchOnrampTransactions('pv_x', { fetchImpl: fakeFetch(429, '').impl })).rejects.toMatchObject({
            kind: 'rate_limited',
        });
        await expect(fetchOnrampTransactions('pv_x', { fetchImpl: fakeFetch(500, 'boom').impl })).rejects.toMatchObject({
            kind: 'upstream',
        });
    });

    it('throws CoinbaseNotConfiguredError when CDP creds are absent', async () => {
        delete process.env.COINBASE_CDP_API_KEY_ID;
        delete process.env.COINBASE_CDP_API_PRIVATE_KEY;
        await expect(fetchOnrampTransactions('pv_x', { fetchImpl: fakeFetch(200, {}).impl })).rejects.toBeInstanceOf(
            CoinbaseNotConfiguredError,
        );
    });
});
