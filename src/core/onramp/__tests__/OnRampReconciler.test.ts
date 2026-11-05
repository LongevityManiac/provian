import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory AsyncStorage so beginPending/reconcile actually round-trip.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));

const fetchAllBalances = vi.fn((..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]));
// reconcile() now reads through fetchAllBalancesDetailed; back it with the same
// spy so existing call-count assertions still hold. failedChainIds is overridable
// per test via failedChains.
let failedChains: number[] = [];
vi.mock('../../wallet/BalanceService', () => ({
    default: {
        fetchAllBalances: (...args: unknown[]) => fetchAllBalances(...args),
        fetchAllBalancesDetailed: async (...args: unknown[]) => ({
            assets: await fetchAllBalances(...args),
            failedChainIds: failedChains,
        }),
    },
}));

const createEnvelope = vi.fn(
    (..._args: unknown[]): Promise<{ envelope_id: string }> => Promise.resolve({ envelope_id: 'pe_test' }),
);
vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({
    default: { createEnvelope: (...args: unknown[]) => createEnvelope(...args) },
}));

// Relay-side Coinbase source verification (#30). Default: null (relay
// unreachable / not verified) so the reconciler falls back to the heuristic mint
// — preserving the pre-#30-backend behavior for every existing test.
const verifyCoinbaseBuy = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(null));
vi.mock('../../../services/RelayAPIService', () => ({
    default: { verifyCoinbaseBuy: (...args: unknown[]) => verifyCoinbaseBuy(...args) },
}));

import OnRampReconciler, { beginPending, refreshPendingWindow, hasPending, reconcile } from '../OnRampReconciler';

const ADDR = '0xAbC0000000000000000000000000000000000001';
const BASE = 8453;

// Build the Asset[] shape fetchAllBalances returns, with a given USDC balance.
function balances(usdc: number) {
    return [
        { symbol: 'ETH', name: 'Ether', balance: '0.1', price: 3000, chain: 'Base', chainId: BASE },
        { symbol: 'USDC', name: 'USD Coin', balance: String(usdc), price: 1, chain: 'Base', chainId: BASE },
    ];
}

beforeEach(() => {
    store.clear();
    fetchAllBalances.mockReset();
    failedChains = [];
    createEnvelope.mockReset();
    createEnvelope.mockResolvedValue({ envelope_id: 'pe_test' });
    verifyCoinbaseBuy.mockReset();
    verifyCoinbaseBuy.mockResolvedValue(null); // default: relay can't verify → heuristic fallback
});

describe('OnRampReconciler', () => {
    it('does nothing and makes no network call when nothing is pending', async () => {
        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(fetchAllBalances).not.toHaveBeenCalled();
        expect(createEnvelope).not.toHaveBeenCalled();
    });

    it('mints exactly one onramp PE when the deposit lands, then clears the record', async () => {
        await beginPending(ADDR, BASE, 10); // baseline 10 USDC
        fetchAllBalances.mockResolvedValue(balances(15)); // +5 arrived

        const result = await reconcile(ADDR);
        expect(result.arrived).toBe(true);
        expect(result.amountUsdc).toBeCloseTo(5);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
        const arg = createEnvelope.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actionType).toBe('onramp');
        expect(arg.amount).toBe('5');
        expect(arg.chainId).toBe(BASE);

        // Record cleared: a second pass mints nothing more (idempotent).
        expect(await hasPending()).toBe(false);
        const again = await reconcile(ADDR);
        expect(again.arrived).toBe(false);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    // --- #30: relay-side Coinbase source verification (server-mint) ---

    it('[#30] relay-verified buy → server minted, device SKIPS the heuristic PE (no double-mint)', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15)); // +5 arrived on-chain
        verifyCoinbaseBuy.mockResolvedValue({ verified: true, status: 'success', txHash: '0xabc', peId: 'pe_srv' });

        const result = await reconcile(ADDR);
        expect(result).toMatchObject({ arrived: true, verified: true });
        expect(result.amountUsdc).toBeCloseTo(5);
        // The relay already minted the authoritative verified PE — the device must
        // NOT mint its heuristic PE (exactly one onramp PE per buy).
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(false);
        // Verify was asked about THIS wallet, scoped from the buy's startedAt.
        expect(verifyCoinbaseBuy).toHaveBeenCalledTimes(1);
        expect(verifyCoinbaseBuy.mock.calls[0][0]).toBe(ADDR);
        expect(typeof verifyCoinbaseBuy.mock.calls[0][1]).toBe('number');
    });

    it('[#30] relay says not-verified → falls back to the source-unverified heuristic mint', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));
        verifyCoinbaseBuy.mockResolvedValue({ verified: false, status: 'none' });

        const result = await reconcile(ADDR);
        expect(result).toMatchObject({ arrived: true, verified: false });
        expect(createEnvelope).toHaveBeenCalledTimes(1); // heuristic mint
        expect(await hasPending()).toBe(false);
    });

    it('[#30] relay unreachable (verify returns null) → heuristic fallback, never a dropped PE', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));
        verifyCoinbaseBuy.mockResolvedValue(null);

        const result = await reconcile(ADDR);
        expect(result.arrived).toBe(true);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('[#30] lost-200 after a server commit: the confirmation retry hits the marker → NO heuristic double-mint', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));
        // First call: the relay DID server-mint the verified PE, but its 200 was
        // lost in transit → looks like null. Retry: the idempotency marker now
        // returns verified:true (idempotent). The device must NOT also mint the
        // heuristic PE (which would double-count PVT for one buy).
        verifyCoinbaseBuy
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ verified: true, status: 'success' });

        const result = await reconcile(ADDR);
        expect(result).toMatchObject({ arrived: true, verified: true });
        expect(createEnvelope).not.toHaveBeenCalled(); // no double-mint
        expect(verifyCoinbaseBuy).toHaveBeenCalledTimes(2);
        expect(await hasPending()).toBe(false);
    });

    it('[#30] relay verify throwing does not lose the PE (falls back to heuristic)', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));
        verifyCoinbaseBuy.mockRejectedValue(new Error('network down'));

        const result = await reconcile(ADDR);
        expect(result.arrived).toBe(true);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('[#30] does not call the relay when no deposit has arrived', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(10)); // unchanged

        await reconcile(ADDR);
        expect(verifyCoinbaseBuy).not.toHaveBeenCalled();
        expect(createEnvelope).not.toHaveBeenCalled();
    });

    it('[#30] uses the immutable button-tap time (not the re-anchored startedAt) as the verify lower bound', async () => {
        // startedAt was re-anchored to browser-close (5 min ago); buyStartedAt is
        // the original button-tap (25 min ago). The Coinbase buy's created_at sits
        // BETWEEN them, so sinceMs must come from buyStartedAt (earlier) — using
        // startedAt would filter the real buy out (the #30 HIGH finding).
        const buyStartedAt = Date.now() - 25 * 60 * 1000;
        const startedAt = Date.now() - 5 * 60 * 1000; // inside the 30-min window
        store.set('provian_onramp_pending', JSON.stringify({
            address: ADDR, chainId: BASE, baselineUsdc: 10, startedAt, buyStartedAt,
        }));
        fetchAllBalances.mockResolvedValue(balances(15));
        verifyCoinbaseBuy.mockResolvedValue({ verified: true });

        await reconcile(ADDR);
        expect(verifyCoinbaseBuy).toHaveBeenCalledTimes(1);
        const sinceMs = verifyCoinbaseBuy.mock.calls[0][1] as number;
        expect(sinceMs).toBe(buyStartedAt - 15 * 60 * 1000); // buyStartedAt minus the skew slack
        expect(sinceMs).toBeLessThan(startedAt); // strictly earlier than the browser-close re-anchor
    });

    it('[#30] in_progress verdict → keeps pending and does NOT mint (waits for settlement to finalize)', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15)); // funds on-chain, but Coinbase status still settling
        verifyCoinbaseBuy.mockResolvedValue({ verified: false, status: 'in_progress' });

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(createEnvelope).not.toHaveBeenCalled(); // no source-unverified heuristic mint
        expect(await hasPending()).toBe(true); // record kept so a later tick gets the verified server-mint
    });

    it('waits (no PE) while the balance has not increased', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(10)); // unchanged

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(true); // still waiting
    });

    it('does not double-mint under two concurrent reconcile calls', async () => {
        await beginPending(ADDR, BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));

        const [a, b] = await Promise.all([reconcile(ADDR), reconcile(ADDR)]);
        const arrivals = [a, b].filter((r) => r.arrived).length;
        expect(arrivals).toBe(1);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('drops a stale record past the window without minting', async () => {
        // Write a pending record directly with an old startedAt.
        store.set('provian_onramp_pending', JSON.stringify({
            address: ADDR, chainId: BASE, baselineUsdc: 10,
            startedAt: Date.now() - 7 * 60 * 60 * 1000, // 7h ago > 6h window
        }));
        fetchAllBalances.mockResolvedValue(balances(15));

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(fetchAllBalances).not.toHaveBeenCalled(); // dropped before any RPC
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(false);
    });

    it('[#30] drops a record older than the tightened 30-minute window (would have minted under the old 6h)', async () => {
        // 45 minutes ago: inside the OLD 6h window (would have misattributed any
        // later USDC arrival), outside the new 30-minute scope.
        store.set('provian_onramp_pending', JSON.stringify({
            address: ADDR, chainId: BASE, baselineUsdc: 10,
            startedAt: Date.now() - 45 * 60 * 1000,
        }));
        fetchAllBalances.mockResolvedValue(balances(15)); // +5 arrived from an unrelated source

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(fetchAllBalances).not.toHaveBeenCalled(); // dropped before any RPC
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(false);
    });

    it('still mints for an arrival WITHIN the 30-minute window', async () => {
        store.set('provian_onramp_pending', JSON.stringify({
            address: ADDR, chainId: BASE, baselineUsdc: 10,
            startedAt: Date.now() - 20 * 60 * 1000, // 20 min ago, inside the window
        }));
        fetchAllBalances.mockResolvedValue(balances(15));

        const result = await reconcile(ADDR);
        expect(result.arrived).toBe(true);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('drops a record belonging to a different wallet', async () => {
        await beginPending('0xother00000000000000000000000000000000beef', BASE, 10);
        fetchAllBalances.mockResolvedValue(balances(15));

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(false);
    });

    it('does not mint when the baseline could not be confirmed (null)', async () => {
        // RPC failed at start time, so the baseline is unknown. Even though the
        // balance now reads 250, we must NOT attribute the whole amount to the
        // on-ramp (review #4).
        await beginPending(ADDR, BASE, null);
        fetchAllBalances.mockResolvedValue(balances(250));

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(fetchAllBalances).not.toHaveBeenCalled(); // bailed before any RPC
        expect(await hasPending()).toBe(true); // record kept until window expiry
    });

    it('does not mint when the chain balance could not be confirmed this tick', async () => {
        await beginPending(ADDR, BASE, 10);
        failedChains = [BASE]; // RPC failure on the relevant chain
        fetchAllBalances.mockResolvedValue(balances(0)); // failure-induced 0

        const result = await reconcile(ADDR);
        expect(result).toEqual({ arrived: false });
        expect(createEnvelope).not.toHaveBeenCalled();
        expect(await hasPending()).toBe(true); // retry next tick, don't drop
    });

    it('[#30] refreshPendingWindow re-anchors the clock (keeping the baseline) so post-KYC settlement still mints', async () => {
        // Simulate a long first-time KYC: the record is now OLD relative to the
        // button tap (would be dropped), but the user just returned from Coinbase.
        store.set('provian_onramp_pending', JSON.stringify({
            address: ADDR, chainId: BASE, baselineUsdc: 10,
            startedAt: Date.now() - 40 * 60 * 1000, // 40 min ago → expired under the 30-min window
        }));

        await refreshPendingWindow(ADDR); // browser closed → re-anchor to now
        // Baseline preserved.
        const rec = JSON.parse(store.get('provian_onramp_pending')!);
        expect(rec.baselineUsdc).toBe(10);
        expect(Date.now() - rec.startedAt).toBeLessThan(60 * 1000);

        fetchAllBalances.mockResolvedValue(balances(15)); // +5 settles shortly after return
        const result = await reconcile(ADDR);
        expect(result.arrived).toBe(true);
        expect(createEnvelope).toHaveBeenCalledTimes(1);
    });

    it('[#30] refreshPendingWindow no-ops for a different wallet and when nothing is pending', async () => {
        // Nothing pending: safe no-op.
        await refreshPendingWindow(ADDR);
        expect(await hasPending()).toBe(false);

        // Different wallet: the record is left untouched.
        const original = JSON.stringify({ address: ADDR, chainId: BASE, baselineUsdc: 10, startedAt: 123 });
        store.set('provian_onramp_pending', original);
        await refreshPendingWindow('0xother00000000000000000000000000000000beef');
        expect(store.get('provian_onramp_pending')).toBe(original); // unchanged
    });

    it('exposes the same functions on the default export', () => {
        expect(OnRampReconciler.beginPending).toBe(beginPending);
        expect(OnRampReconciler.refreshPendingWindow).toBe(refreshPendingWindow);
        expect(OnRampReconciler.reconcile).toBe(reconcile);
        expect(OnRampReconciler.hasPending).toBe(hasPending);
    });
});
