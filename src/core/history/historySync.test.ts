import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => {
    const store = new Map<string, string>();
    return { default: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => { store.set(k, v); } } };
});
import {
    HISTORY_FULL_REFRESH_MS,
    HISTORY_HEAD_LAG_OVERLAP_MS,
    HISTORY_REORG_OVERLAP_BLOCKS,
    PERMIT_RESCAN_DEFAULT_MS,
    PERMIT_RESCAN_INTERVAL_MS,
    PERMIT_RESCAN_MAX_MS,
    chainScanDue,
    incrementalFromBlock,
    markHistoryRescanDue,
    nextEvmSyncState,
    nextSolanaSyncState,
    permitRescanUntilMs,
    probeEvmChain,
    readHistoryRescanWindow,
    type ChainSyncState,
} from './historySync';

const NOW = 1_800_000_000_000;
const state = (over: Partial<ChainSyncState> = {}): ChainSyncState => ({
    fingerprint: 'f1', scannedAtMs: NOW - 60_000, throughBlock: 1_000, approvalsThroughBlock: 1_000, lastSignature: null, ...over,
});

describe('chainScanDue (the app reads Alchemy only when something changed)', () => {
    it('an unchanged fingerprint inside a week reads nothing', () => {
        expect(chainScanDue({ state: state(), fingerprint: 'f1', nowMs: NOW, force: false })).toBe(false);
    });
    it('RED: a changed fingerprint, a week-old scan, a forced refresh, a failed check, or no state each read', () => {
        expect(chainScanDue({ state: state(), fingerprint: 'f2', nowMs: NOW, force: false })).toBe(true);
        expect(chainScanDue({ state: state({ scannedAtMs: NOW - HISTORY_FULL_REFRESH_MS }), fingerprint: 'f1', nowMs: NOW, force: false })).toBe(true);
        expect(chainScanDue({ state: state(), fingerprint: 'f1', nowMs: NOW, force: true })).toBe(true);
        expect(chainScanDue({ state: state(), fingerprint: null, nowMs: NOW, force: false })).toBe(true);
        expect(chainScanDue({ state: state({ fingerprint: null }), fingerprint: 'f1', nowMs: NOW, force: false })).toBe(true);
        expect(chainScanDue({ state: undefined, fingerprint: 'f1', nowMs: NOW, force: false })).toBe(true);
    });
    it('a signed permit reads once right after signing, then at least hourly until its deadline (the nonce never moves)', () => {
        const permit = { signedAtMs: NOW - 10 * 60_000, untilMs: NOW + 24 * 60 * 60_000 };
        // Scanned before the signature: read.
        expect(chainScanDue({ state: state({ scannedAtMs: NOW - 20 * 60_000 }), fingerprint: 'f1', nowMs: NOW, permit, force: false })).toBe(true);
        // RED for the reviewer's case: scanned after signing but before the permit landed; an hour on it reads again.
        expect(chainScanDue({ state: state({ scannedAtMs: NOW - 5 * 60_000 }), fingerprint: 'f1', nowMs: NOW, permit, force: false })).toBe(false);
        expect(chainScanDue({ state: state({ scannedAtMs: NOW - 5 * 60_000 }), fingerprint: 'f1', nowMs: NOW - 5 * 60_000 + PERMIT_RESCAN_INTERVAL_MS, permit, force: false })).toBe(true);
        // Past the deadline the permit no longer forces anything.
        expect(chainScanDue({ state: state({ scannedAtMs: permit.untilMs + 1 }), fingerprint: 'f1', nowMs: permit.untilMs + 2 * PERMIT_RESCAN_INTERVAL_MS, permit, force: false })).toBe(false);
    });
    it('incremental reads start below the last scan by the reorg overlap or ten minutes of blocks, whichever is more; no state reads as a first scan', () => {
        expect(incrementalFromBlock(100_000)).toBe(100_000 - Math.max(HISTORY_REORG_OVERLAP_BLOCKS, HISTORY_HEAD_LAG_OVERLAP_MS / 2_000));
        expect(incrementalFromBlock(100_000, 250)).toBe(100_000 - HISTORY_HEAD_LAG_OVERLAP_MS / 250);
        expect(incrementalFromBlock(100_000, 60_000)).toBe(100_000 - HISTORY_REORG_OVERLAP_BLOCKS);
        expect(incrementalFromBlock(10)).toBe(0);
        expect(incrementalFromBlock(null)).toBeNull();
        expect(incrementalFromBlock(undefined)).toBeNull();
    });
});

describe('permit window', () => {
    it('uses the permit\'s own deadline (ERC-2612 deadline, Permit2 sigDeadline, DAI expiry), capped at 30 days', () => {
        const typed = (message: Record<string, unknown>) => JSON.stringify({ primaryType: 'Permit', message });
        expect(permitRescanUntilMs(typed({ deadline: String(NOW / 1000 + 3600) }), NOW)).toBe(NOW + 3_600_000);
        expect(permitRescanUntilMs(typed({ sigDeadline: NOW / 1000 + 600 }), NOW)).toBe(NOW + 600_000);
        expect(permitRescanUntilMs(typed({ deadline: (2n ** 256n - 1n).toString() }), NOW)).toBe(NOW + PERMIT_RESCAN_MAX_MS);
        // No readable deadline (or expiry 0, "never"): a week; the weekly scan covers anything later.
        expect(permitRescanUntilMs(typed({ expiry: 0 }), NOW)).toBe(NOW + PERMIT_RESCAN_DEFAULT_MS);
        expect(permitRescanUntilMs('not json', NOW)).toBe(NOW + PERMIT_RESCAN_DEFAULT_MS);
        // A deadline already past still scans once (the signing itself), never before now.
        expect(permitRescanUntilMs(typed({ deadline: NOW / 1000 - 10 }), NOW)).toBe(NOW);
    });
    it('a later signature widens the stored window and never narrows it; an old numeric marker still reads', async () => {
        await markHistoryRescanDue({ signedAtMs: NOW, untilMs: NOW + 10 * 86_400_000 });
        await markHistoryRescanDue({ signedAtMs: NOW + 1, untilMs: NOW + 3_600_000 });
        expect(await readHistoryRescanWindow()).toEqual({ signedAtMs: NOW + 1, untilMs: NOW + 10 * 86_400_000 });
    });
});

describe('sync state after a scan (only what was read completely moves)', () => {
    const base = { previous: state(), fingerprint: 'f2', nowMs: NOW, latestBlock: 2_000 };
    it('a complete read stores the new block for transfers and approvals', () => {
        expect(nextEvmSyncState({ ...base, transfersRead: true, approvalsRead: true }))
            .toEqual({ fingerprint: 'f2', scannedAtMs: NOW, throughBlock: 2_000, approvalsThroughBlock: 2_000, lastSignature: null });
    });
    it('RED: transfers not read in both directions store nothing', () => {
        expect(nextEvmSyncState({ ...base, transfersRead: false, approvalsRead: true })).toBeNull();
        expect(nextEvmSyncState({ ...base, latestBlock: NaN, transfersRead: true, approvalsRead: true })).toBeNull();
    });
    it('RED: approvals not read keep their old block and clear the fingerprint, so the next open reads again', () => {
        const next = nextEvmSyncState({ ...base, transfersRead: true, approvalsRead: false });
        expect(next).toMatchObject({ throughBlock: 2_000, approvalsThroughBlock: 1_000, fingerprint: null });
        expect(chainScanDue({ state: next ?? undefined, fingerprint: 'f2', nowMs: NOW + 1, force: false })).toBe(true);
    });
    it('Solana: RED a transaction not read stores nothing; a complete read stores the newest signature', () => {
        expect(nextSolanaSyncState({ previous: state(), fingerprint: 'sig:x', nowMs: NOW, newestSignature: 'x', allRead: false })).toBeNull();
        expect(nextSolanaSyncState({ previous: state({ lastSignature: 'w' }), fingerprint: 'sig:x', nowMs: NOW, newestSignature: 'x', allRead: true }))
            .toMatchObject({ lastSignature: 'x', fingerprint: 'sig:x' });
        expect(nextSolanaSyncState({ previous: state({ lastSignature: 'w' }), fingerprint: 'sig:w', nowMs: NOW, newestSignature: null, allRead: true }))
            .toMatchObject({ lastSignature: 'w' });
    });
});

describe('probeEvmChain (the free change check)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const answer = (overrides: Record<number, string> = {}) => vi.fn(async (_url: string, init: { body: string }) => {
        const batch = JSON.parse(init.body) as Array<{ id: number; method: string }>;
        return {
            ok: true,
            json: async () => batch.map((r) => ({ jsonrpc: '2.0', id: r.id, result: overrides[r.id] ?? (r.method === 'eth_blockNumber' ? '0x64' : '0x1') })),
        };
    });
    const ADDR = '0x' + 'ab'.repeat(20);
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

    it('the same chain state gives the same fingerprint; RED: a token balance change gives another', async () => {
        vi.stubGlobal('fetch', answer());
        const a = await probeEvmChain({ rpcUrls: ['https://rpc.test'], address: ADDR, tokenAddresses: [USDC] });
        const b = await probeEvmChain({ rpcUrls: ['https://rpc.test'], address: ADDR, tokenAddresses: [USDC] });
        expect(a?.block).toBe(100);
        expect(a?.fingerprint).toBe(b?.fingerprint);
        vi.stubGlobal('fetch', answer({ 4: '0x2' }));
        const c = await probeEvmChain({ rpcUrls: ['https://rpc.test'], address: ADDR, tokenAddresses: [USDC] });
        expect(c?.fingerprint).not.toBe(a?.fingerprint);
    });
    it('RED: a reply missing any answer is not a fingerprint (the caller then reads)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ jsonrpc: '2.0', id: 1, result: '0x64' }] })));
        expect(await probeEvmChain({ rpcUrls: ['https://rpc.test'], address: ADDR, tokenAddresses: [USDC] })).toBeNull();
    });
});
