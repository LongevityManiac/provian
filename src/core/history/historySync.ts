/**
 * When the wallet's transaction history and approval scan must ask Alchemy, and from where.
 *
 * The scan used to re-read every chain through the relay's Alchemy proxy on the first visit after
 * every app start, and the approval scan re-read a fixed ~5-hour window each time, so its cost grew
 * with people times opens and an approval older than the window could be missed. Now:
 *
 * - CHANGE CHECK (free). Before any Alchemy read, each EVM chain is asked through its public RPC
 *   for the block, the wallet's nonce, its native balance and its verified-token balances (one
 *   batched request). Every history row the default view shows changes one of those: a send,
 *   swap or approval raises the nonce; a receive of ETH, USDC, USDT, WETH or PVT changes a balance.
 *   Solana is asked (public cluster) for the newest signature naming the address.
 * - SKIP. When that fingerprint equals the one stored at the last scan, and the last scan is less
 *   than a week old, nothing is read from Alchemy.
 * - INCREMENTAL. Otherwise the scan reads only blocks after the last scan (with an overlap for
 *   reorgs; rows merge by id) and only signatures newer than the last one seen. The first scan of
 *   approvals reads the whole history once, so every approval the wallet ever granted is listed.
 * - FORCED. Pull-to-refresh, a week-old scan (for what no fingerprint shows: an unverified token, an
 *   allowance granted by a permit signed in another wallet app), a failed change check, and a signed WalletConnect
 *   typed-data request (a permit grants an allowance without moving the nonce) always scan.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SyncedChain = 'Base' | 'Arbitrum' | 'Optimism' | 'Solana';

export interface ChainSyncState {
    /** The change-check fingerprint at the last scan (null when the check failed then). */
    readonly fingerprint: string | null;
    readonly scannedAtMs: number;
    /** EVM: every transfer through this block was read (the next scan starts below it). */
    readonly throughBlock: number | null;
    /** EVM: every approval through this block was read. */
    readonly approvalsThroughBlock: number | null;
    /** Solana: the newest signature read. */
    readonly lastSignature: string | null;
}

export type HistorySyncState = Partial<Record<SyncedChain, ChainSyncState>>;

/** A scan at least this often, whatever the change check says. */
export const HISTORY_FULL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Blocks re-read below the last scan's block (a reorg can move a transfer between blocks). */
export const HISTORY_REORG_OVERLAP_BLOCKS = 64;

const STATE_KEY = 'transaction_history_sync_v1';
const RESCAN_DUE_KEY = 'transaction_history_rescan_due_v1';

export async function loadHistorySyncState(primaryAddress: string): Promise<HistorySyncState> {
    try {
        const raw = await AsyncStorage.getItem(`${STATE_KEY}_${primaryAddress}`);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HistorySyncState : {};
    } catch {
        return {};
    }
}

export async function saveChainSyncState(primaryAddress: string, chain: SyncedChain, state: ChainSyncState): Promise<void> {
    try {
        const current = await loadHistorySyncState(primaryAddress);
        await AsyncStorage.setItem(`${STATE_KEY}_${primaryAddress}`, JSON.stringify({ ...current, [chain]: state }));
    } catch {
        // A lost state only means the next open scans again.
    }
}

/** The wallet signed something that can grant an allowance without a transaction: scan next time. */
export async function markHistoryRescanDue(nowMs: number = Date.now()): Promise<void> {
    try { await AsyncStorage.setItem(RESCAN_DUE_KEY, String(nowMs)); } catch { /* next daily scan */ }
}

export async function readHistoryRescanDueAt(): Promise<number> {
    try {
        const raw = await AsyncStorage.getItem(RESCAN_DUE_KEY);
        const n = raw ? Number(raw) : 0;
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

/** Whether a chain must be read from Alchemy now. */
export function chainScanDue(input: {
    readonly state: ChainSyncState | undefined;
    readonly fingerprint: string | null;
    readonly nowMs: number;
    readonly rescanDueAtMs: number;
    readonly force: boolean;
}): boolean {
    const { state, fingerprint, nowMs, rescanDueAtMs, force } = input;
    if (force || !state || fingerprint === null || state.fingerprint === null) return true;
    if (state.fingerprint !== fingerprint) return true;
    if (nowMs - state.scannedAtMs >= HISTORY_FULL_REFRESH_MS || state.scannedAtMs > nowMs) return true;
    return rescanDueAtMs > state.scannedAtMs;
}

/** The first block an incremental read starts at (null: read as a first scan). */
export function incrementalFromBlock(throughBlock: number | null | undefined): number | null {
    if (typeof throughBlock !== 'number' || !Number.isSafeInteger(throughBlock) || throughBlock < 0) return null;
    return Math.max(0, throughBlock - HISTORY_REORG_OVERLAP_BLOCKS);
}

type JsonRpcRequest = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`rpc_http_${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const BALANCE_OF = '0x70a08231';

/**
 * The EVM change check: one batched request to the chain's public RPC (falling back to its second
 * public endpoint). Returns the block and a fingerprint of (nonce, native balance, each token
 * balance), or null when neither endpoint answers completely (the caller then scans).
 */
export async function probeEvmChain(input: {
    readonly rpcUrls: readonly string[];
    readonly address: string;
    readonly tokenAddresses: readonly string[];
    readonly timeoutMs?: number;
}): Promise<{ readonly block: number; readonly fingerprint: string } | null> {
    const owner = input.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(owner)) return null;
    const tokens = [...new Set(input.tokenAddresses.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))].sort();
    const batch: JsonRpcRequest[] = [
        { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [owner, 'latest'] },
        { jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: [owner, 'latest'] },
        ...tokens.map((token, i) => ({
            jsonrpc: '2.0' as const, id: 4 + i, method: 'eth_call',
            params: [{ to: token, data: BALANCE_OF + owner.slice(2).padStart(64, '0') }, 'latest'],
        })),
    ];
    for (const url of input.rpcUrls) {
        try {
            const reply = await postJson(url, batch, input.timeoutMs ?? 8_000);
            if (!Array.isArray(reply)) continue;
            const byId = new Map<number, unknown>();
            for (const r of reply as Array<{ id?: unknown; result?: unknown; error?: unknown }>) {
                if (typeof r?.id === 'number' && r.error === undefined && typeof r.result === 'string') byId.set(r.id, r.result);
            }
            if (batch.some((req) => !byId.has(req.id))) continue;
            const block = parseInt(byId.get(1) as string, 16);
            if (!Number.isSafeInteger(block) || block <= 0) continue;
            const parts = batch.slice(1).map((req) => `${req.method}:${String(req.params[0] && typeof req.params[0] === 'object' ? (req.params[0] as { to: string }).to : '')}=${String(byId.get(req.id))}`);
            return { block, fingerprint: parts.join('|') };
        } catch {
            // Next endpoint.
        }
    }
    return null;
}

/** The Solana change check: the newest signature naming the address, from the public cluster. */
export async function probeSolanaAddress(input: {
    readonly rpcUrl: string;
    readonly address: string;
    readonly timeoutMs?: number;
}): Promise<{ readonly newestSignature: string | null } | null> {
    try {
        const reply = await postJson(input.rpcUrl, {
            jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [input.address, { limit: 1, commitment: 'confirmed' }],
        }, input.timeoutMs ?? 8_000) as { result?: unknown; error?: unknown };
        if (reply?.error !== undefined || !Array.isArray(reply?.result)) return null;
        const first = reply.result[0] as { signature?: unknown } | undefined;
        return { newestSignature: typeof first?.signature === 'string' ? first.signature : null };
    } catch {
        return null;
    }
}
