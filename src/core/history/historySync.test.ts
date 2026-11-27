import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => {
    const store = new Map<string, string>();
    return { default: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => { store.set(k, v); } } };
});
import {
    HISTORY_FULL_REFRESH_MS,
    HISTORY_REORG_OVERLAP_BLOCKS,
    chainScanDue,
    incrementalFromBlock,
    probeEvmChain,
    type ChainSyncState,
} from './historySync';

const NOW = 1_800_000_000_000;
const state = (over: Partial<ChainSyncState> = {}): ChainSyncState => ({
    fingerprint: 'f1', scannedAtMs: NOW - 60_000, throughBlock: 1_000, approvalsThroughBlock: 1_000, lastSignature: null, ...over,
});

describe('chainScanDue (the app reads Alchemy only when something changed)', () => {
    it('an unchanged fingerprint inside a day reads nothing', () => {
        expect(chainScanDue({ state: state(), fingerprint: 'f1', nowMs: NOW, rescanDueAtMs: 0, force: false })).toBe(false);
    });
    it('RED: a changed fingerprint, a day-old scan, a forced refresh, a failed check, a permit signed since, or no state each read', () => {
        expect(chainScanDue({ state: state(), fingerprint: 'f2', nowMs: NOW, rescanDueAtMs: 0, force: false })).toBe(true);
        expect(chainScanDue({ state: state({ scannedAtMs: NOW - HISTORY_FULL_REFRESH_MS }), fingerprint: 'f1', nowMs: NOW, rescanDueAtMs: 0, force: false })).toBe(true);
        expect(chainScanDue({ state: state(), fingerprint: 'f1', nowMs: NOW, rescanDueAtMs: 0, force: true })).toBe(true);
        expect(chainScanDue({ state: state(), fingerprint: null, nowMs: NOW, rescanDueAtMs: 0, force: false })).toBe(true);
        expect(chainScanDue({ state: state(), fingerprint: 'f1', nowMs: NOW, rescanDueAtMs: NOW - 1, force: false })).toBe(true);
        expect(chainScanDue({ state: undefined, fingerprint: 'f1', nowMs: NOW, rescanDueAtMs: 0, force: false })).toBe(true);
    });
    it('incremental reads start below the last scan by the reorg overlap; no state reads as a first scan', () => {
        expect(incrementalFromBlock(1_000)).toBe(1_000 - HISTORY_REORG_OVERLAP_BLOCKS);
        expect(incrementalFromBlock(10)).toBe(0);
        expect(incrementalFromBlock(null)).toBeNull();
        expect(incrementalFromBlock(undefined)).toBeNull();
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
