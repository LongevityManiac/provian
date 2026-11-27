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
 *   allowance granted by a permit signed in another wallet app) and a failed change check always
 *   scan. A typed-data request signed through WalletConnect (a permit grants an allowance without
 *   moving the nonce, whenever a third party submits it) scans once at once, then at least hourly
 *   until the permit's own deadline (at most 30 days; a week when it names none).
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

/**
 * While a signed permit can still land (a third party submits it, the nonce never moves), every
 * EVM scan at least this often reads Alchemy.
 */
export const PERMIT_RESCAN_INTERVAL_MS = 60 * 60 * 1000;
/** A permit with no readable deadline is watched this long; the weekly scan covers anything later. */
export const PERMIT_RESCAN_DEFAULT_MS = HISTORY_FULL_REFRESH_MS;
/** The longest a permit is watched hourly, whatever its deadline (the weekly scan covers the rest). */
export const PERMIT_RESCAN_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** The window in which a signed permit may still land, as stored. */
export interface PermitRescanWindow {
    /** When the typed data was signed (every chain scans once after it). */
    readonly signedAtMs: number;
    /** Until when EVM scans read Alchemy at least hourly. */
    readonly untilMs: number;
}

/**
 * Until when a signed typed-data request may still create an allowance: its own deadline
 * (`deadline` for an ERC-2612 permit, `sigDeadline` for a Permit2 signature, `expiry` for a DAI-style
 * permit, in seconds), capped at 30 days; the default when none is readable.
 */
export function permitRescanUntilMs(typedData: unknown, nowMs: number): number {
    let parsed: unknown = typedData;
    if (typeof typedData === 'string') {
        try { parsed = JSON.parse(typedData); } catch { parsed = null; }
    }
    const message = parsed && typeof parsed === 'object' ? (parsed as { message?: unknown }).message : undefined;
    const fields = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const deadlines: number[] = [];
    for (const key of ['deadline', 'sigDeadline', 'expiry']) {
        const raw = fields[key];
        if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'bigint') continue;
        let seconds: bigint;
        try { seconds = BigInt(raw); } catch { continue; }
        if (seconds <= 0n) continue; // 0 means no expiry
        deadlines.push(seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ? Number.MAX_SAFE_INTEGER : Number(seconds) * 1000);
    }
    const until = deadlines.length > 0 ? Math.max(...deadlines) : nowMs + PERMIT_RESCAN_DEFAULT_MS;
    return Math.max(nowMs, Math.min(until, nowMs + PERMIT_RESCAN_MAX_MS));
}

/** The wallet signed something that can grant an allowance without a transaction: watch for it landing. */
export async function markHistoryRescanDue(window: PermitRescanWindow): Promise<void> {
    try {
        const current = await readHistoryRescanWindow();
        const next: PermitRescanWindow = { signedAtMs: Math.max(current.signedAtMs, window.signedAtMs), untilMs: Math.max(current.untilMs, window.untilMs) };
        await AsyncStorage.setItem(RESCAN_DUE_KEY, JSON.stringify(next));
    } catch { /* the weekly scan */ }
}

export async function readHistoryRescanWindow(): Promise<PermitRescanWindow> {
    try {
        const raw = await AsyncStorage.getItem(RESCAN_DUE_KEY);
        if (!raw) return { signedAtMs: 0, untilMs: 0 };
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'number' && Number.isFinite(parsed)) return { signedAtMs: parsed, untilMs: parsed };
        if (parsed && typeof parsed === 'object') {
            const { signedAtMs, untilMs } = parsed as Record<string, unknown>;
            if (typeof signedAtMs === 'number' && Number.isFinite(signedAtMs) && typeof untilMs === 'number' && Number.isFinite(untilMs)) {
                return { signedAtMs, untilMs };
            }
        }
        return { signedAtMs: 0, untilMs: 0 };
    } catch {
        return { signedAtMs: 0, untilMs: 0 };
    }
}

/** Whether a chain must be read from Alchemy now. */
export function chainScanDue(input: {
    readonly state: ChainSyncState | undefined;
    readonly fingerprint: string | null;
    readonly nowMs: number;
    /** The signed-permit window (EVM chains only; Solana passes none). */
    readonly permit?: PermitRescanWindow;
    readonly force: boolean;
}): boolean {
    const { state, fingerprint, nowMs, permit, force } = input;
    if (force || !state || fingerprint === null || state.fingerprint === null) return true;
    if (state.fingerprint !== fingerprint) return true;
    if (nowMs - state.scannedAtMs >= HISTORY_FULL_REFRESH_MS || state.scannedAtMs > nowMs) return true;
    if (!permit) return false;
    // Once right after signing, then at least hourly while the permit can still land.
    if (permit.signedAtMs > state.scannedAtMs) return true;
    return nowMs <= permit.untilMs && nowMs - state.scannedAtMs >= PERMIT_RESCAN_INTERVAL_MS;
}

/**
 * The re-read below the last scan also spans this much time, because the scan's block comes from the
 * public RPC's change check while Alchemy answers up to its own head, which can trail it.
 */
export const HISTORY_HEAD_LAG_OVERLAP_MS = 10 * 60 * 1000;

/** The first block an incremental read starts at (null: read as a first scan). */
export function incrementalFromBlock(throughBlock: number | null | undefined, blockTimeMs: number = 2_000): number | null {
    if (typeof throughBlock !== 'number' || !Number.isSafeInteger(throughBlock) || throughBlock < 0) return null;
    const lagBlocks = blockTimeMs > 0 ? Math.ceil(HISTORY_HEAD_LAG_OVERLAP_MS / blockTimeMs) : 0;
    return Math.max(0, throughBlock - Math.max(HISTORY_REORG_OVERLAP_BLOCKS, lagBlocks));
}

/**
 * The EVM state to store after a scan, or null to store nothing (the next open reads again from the
 * same place). Transfers must have been read in both directions; approvals that were not read keep
 * their old block and clear the fingerprint, so the next open scans again even when nothing moved.
 */
export function nextEvmSyncState(input: {
    readonly previous: ChainSyncState | undefined;
    readonly fingerprint: string | null;
    readonly nowMs: number;
    readonly latestBlock: number;
    readonly transfersRead: boolean;
    readonly approvalsRead: boolean;
}): ChainSyncState | null {
    const { previous, fingerprint, nowMs, latestBlock, transfersRead, approvalsRead } = input;
    if (!transfersRead || !Number.isSafeInteger(latestBlock) || latestBlock <= 0) return null;
    return {
        fingerprint: approvalsRead ? fingerprint : null,
        scannedAtMs: nowMs,
        throughBlock: latestBlock,
        approvalsThroughBlock: approvalsRead ? latestBlock : (previous?.approvalsThroughBlock ?? null),
        lastSignature: null,
    };
}

/** The Solana state to store after a scan, or null when a signature's transaction was not read. */
export function nextSolanaSyncState(input: {
    readonly previous: ChainSyncState | undefined;
    readonly fingerprint: string | null;
    readonly nowMs: number;
    readonly newestSignature: string | null;
    readonly allRead: boolean;
}): ChainSyncState | null {
    if (!input.allRead) return null;
    return {
        fingerprint: input.fingerprint, scannedAtMs: input.nowMs, throughBlock: null, approvalsThroughBlock: null,
        lastSignature: input.newestSignature ?? input.previous?.lastSignature ?? null,
    };
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
