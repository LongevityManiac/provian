/**
 * The history service stores a chain's sync position only for what it read completely, so a read that
 * failed is read again on the next open instead of being skipped for good. These drive the service's
 * own EVM and Solana scans with the network replaced, and read back the stored position.
 */
vi.mock('../protocol/runtime', async () => (await import('../protocol/__test-helpers__/runtime')).protocolRuntimeFixture);
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    solana: {
        getSignaturesForAddress: vi.fn(),
        getParsedTransaction: vi.fn(),
    },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => h.store.get(k) ?? null,
        setItem: async (k: string, v: string) => { h.store.set(k, v); },
        removeItem: async (k: string) => { h.store.delete(k); },
    },
}));
vi.mock('../chains/solana/SolanaRpc', () => ({ default: h.solana }));
// alchemyRpc is replaced below; the relay proxy client itself is never reached.
vi.mock('../../services/ProxyConfig', () => ({ default: {} }));
vi.mock('./historySync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./historySync')>()),
    probeEvmChain: vi.fn(async () => ({ block: 2_000, fingerprint: 'f-new' })),
    probeSolanaAddress: vi.fn(async () => ({ newestSignature: 'sig-new' })),
}));

import service from './TransactionHistoryService';
import { loadHistorySyncState, type ChainSyncState, type HistorySyncState } from './historySync';

const PRIMARY = '0x' + 'ab'.repeat(20);
const SOL = 'So1anaUser1111111111111111111111111111111111';
const NOW = 1_800_000_000_000;
const PRIOR: ChainSyncState = { fingerprint: 'f-old', scannedAtMs: NOW - 8 * 24 * 3_600_000, throughBlock: 1_000, approvalsThroughBlock: 1_000, lastSignature: 'sig-old' };

interface ServiceInternals {
    alchemyRpc(network: string, method: string, params: unknown[]): Promise<unknown>;
    fetchEVMTransactions(address: string, chain: string, ctx: unknown): Promise<unknown[]>;
    fetchSolanaTransactions(address: string, ctx: unknown): Promise<unknown[]>;
}
const internals = service as unknown as ServiceInternals;

const ctx = (state: HistorySyncState) => ({ primaryAddress: PRIMARY, state, permit: { signedAtMs: 0, untilMs: 0 }, force: false, nowMs: NOW });

/** Alchemy through the relay: transfers and approval logs answer unless told to fail. */
function alchemy(fail: { readonly outTransfers?: boolean; readonly logs?: boolean } = {}) {
    return vi.spyOn(internals, 'alchemyRpc').mockImplementation(async (_network, method, params) => {
        if (method === 'alchemy_getAssetTransfers') {
            const outgoing = (params[0] as { fromAddress?: string }).fromAddress !== undefined;
            return outgoing && fail.outTransfers ? null : { result: { transfers: [] } };
        }
        if (method === 'eth_getLogs') return fail.logs ? null : { result: [] };
        return null;
    });
}

beforeEach(() => {
    h.store.clear();
    vi.restoreAllMocks();
    h.solana.getSignaturesForAddress.mockReset();
    h.solana.getParsedTransaction.mockReset();
});

describe('EVM scan: the stored position moves only for what was read', () => {
    it('a complete read stores the probe block for transfers and approvals', async () => {
        alchemy();
        await internals.fetchEVMTransactions(PRIMARY, 'Base', ctx({ Base: PRIOR }));
        expect((await loadHistorySyncState(PRIMARY)).Base)
            .toMatchObject({ fingerprint: 'f-new', throughBlock: 2_000, approvalsThroughBlock: 2_000, scannedAtMs: NOW });
    });

    it('RED: transfers missing in one direction store nothing, so the next open reads from the same block', async () => {
        alchemy({ outTransfers: true });
        await internals.fetchEVMTransactions(PRIMARY, 'Base', ctx({ Base: PRIOR }));
        expect((await loadHistorySyncState(PRIMARY)).Base).toBeUndefined();
    });

    it('RED: approval logs not read keep the old approval block and clear the fingerprint', async () => {
        alchemy({ logs: true });
        await internals.fetchEVMTransactions(PRIMARY, 'Base', ctx({ Base: PRIOR }));
        expect((await loadHistorySyncState(PRIMARY)).Base)
            .toMatchObject({ throughBlock: 2_000, approvalsThroughBlock: 1_000, fingerprint: null });
    });
});

describe('Solana scan: the newest signature is stored only after every new transaction was read', () => {
    const sigs = [
        { signature: 'sig-new', slot: 2, blockTime: 2, err: null },
        { signature: 'sig-mid', slot: 1, blockTime: 1, err: null },
    ];
    const parsedTx = { blockTime: 1, meta: { fee: 0, err: null, preBalances: [], postBalances: [] }, transaction: { message: { accountKeys: [], instructions: [] } } };

    it('all read: the newest signature is stored', async () => {
        h.solana.getSignaturesForAddress.mockResolvedValue(sigs);
        h.solana.getParsedTransaction.mockResolvedValue(parsedTx);
        await internals.fetchSolanaTransactions(SOL, ctx({ Solana: PRIOR }));
        expect((await loadHistorySyncState(PRIMARY)).Solana).toMatchObject({ lastSignature: 'sig-new', fingerprint: 'sig:sig-new' });
        expect(h.solana.getSignaturesForAddress).toHaveBeenCalledWith(SOL, 20, 'sig-old');
    });

    it('RED: one transaction not read stores nothing, so the next open reads both again', async () => {
        h.solana.getSignaturesForAddress.mockResolvedValue(sigs);
        h.solana.getParsedTransaction.mockImplementation(async (signature: string) => (signature === 'sig-mid' ? null : parsedTx));
        await internals.fetchSolanaTransactions(SOL, ctx({ Solana: PRIOR }));
        expect((await loadHistorySyncState(PRIMARY)).Solana).toBeUndefined();
    });
});
