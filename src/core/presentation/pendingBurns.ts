/**
 * pendingBurns — a PVT burn is irreversible the moment it is mined, so the phone must never
 * lose one it has broadcast (found live 2026-09-22).
 *
 * The relay verifies a burn through its OWN providers: since it accepts the burn
 * once it is mined in one Base block (both providers agree on the receipt and its canonical block),
 * records it `provisional`, and checks 12-block finality afterwards — revoking every benefit of a
 * burn that fails it. Before this module the burn's tx hash lived only in a local variable: a refused record
 * lost it, the screen said "your burn is preserved", and the retry burned AGAIN.
 *
 * Here every burn is saved (tx hash + amount, AsyncStorage — public on-chain data, not a secret)
 * the instant it is broadcast, BEFORE any relay call. Any later attempt for the same amount
 * RESUMES that saved burn instead of burning again. An entry leaves the store only when the
 * product it bought succeeds (`markBurnConsumed`), the relay says it was already consumed, or the
 * relay says the burn tx REVERTED (it burned nothing, so there is nothing to resume).
 *
 * the phone no longer waits for a confirmation, and the relay holds a record (or a
 * pipelined present) until the burn is mined — one call, answered about one Base block (one canonical block)
 * after broadcast, instead of re-posting every 5 s. The retry loop stays for a dropped connection.
 */
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translate } from '../../i18n/translate';

export interface PendingBurn {
    txHash: string;
    amountAtomic: string;
    createdAt: number;
    burnId?: string;
    operationId?: string;
    nonce?: number;
}

export interface BurnDeps {
    /** Broadcast the burn (biometric-gated in the app). */
    burn: (amountPvt: string, operationId?: string) => Promise<{ txHash: string; amountAtomic: string; nonce?: number }>;
    /** Record it on the relay (re-verified on-chain there; the relay holds the call until the burn is mined). */
    record: (p: { txHash: string; chain: string; amountAtomic: string; awaitFinality?: boolean }) => Promise<{ burnId: string }>;
    storage?: Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;
    now?: () => number;
    /**
     * The chain's view of a saved burn tx: mined, still pending in the node's pool, or unknown to it
     * (dropped, or never propagated). Lets a phantom saved burn — broadcast, never mined — be
     * forgotten instead of resumed forever.
     */
    txStatus?: (txHash: string) => Promise<'mined' | 'pending' | 'unknown'>;
    sleep?: (ms: number) => Promise<void>;
}

export type BurnStage = 'burning' | 'finalizing';

/** Default record deadline: the relay accepts at inclusion (~one Base block); allow generous relay-provider lag. */
export const BURN_RECORD_DEADLINE_MS = 180_000;
/** Between record attempts — only a dropped connection or the relay's wait bound gets here now. */
export const BURN_RECORD_INTERVAL_MS = 2_000;
/** Compatibility export; elapsed time never authorizes forgetting an unresolved burn. */
export const PHANTOM_BURN_AFTER_MS = 3 * 60_000;

const keyFor = (address: string) => `@provian_pending_burns_v1:${address.toLowerCase()}`;

/** The relay's refusals that mean "not final / not visible yet" — wait and retry. */
export function isTransientRecordError(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err ?? '');
    return /insufficient_confirmations|tx_not_found|verification failed|rpc_error|already in progress|burn record failed \(5\d\d\)|network request failed|timed? ?out|abort/i.test(m);
}

/** The relay's "this burn tx mined but REVERTED" refusal — final; the burn burned nothing. */
export function isRevertedBurnError(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err ?? '');
    return /\btx_failed\b|reverted on-chain/i.test(m);
}

/**
 * the relay accepted this burn at inclusion and then REVOKED it, because it never
 * reached Base finality. Final: it can never be recorded or used again, so the saved entry is forgotten.
 */
export function isRevokedBurnError(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err ?? '');
    return /\bburn_revoked\b|did not reach Base finality/i.test(m);
}

/** The relay's "this burn already bought something" refusal. */
export function isBurnConsumedError(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err ?? '');
    return /already been consumed|already consumed/i.test(m);
}

export class BurnStillFinalizingError extends Error {
    readonly txHash: string;
    constructor(txHash: string) {
        super(translate('humanPresentation.burnStillFinalizing', 'Your PVT burn is on Base but not confirmed yet. It is saved on this phone: try again in a minute and it will be used — nothing is burned twice.'));
        this.name = 'BurnStillFinalizingError';
        this.txHash = txHash;
    }
}

async function load(storage: BurnDeps['storage'], address: string): Promise<PendingBurn[]> {
    try {
        const raw = await storage!.getItem(keyFor(address));
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(parsed) ? (parsed as PendingBurn[]).filter((b) => typeof b?.txHash === 'string' && typeof b?.amountAtomic === 'string') : [];
    } catch {
        return [];
    }
}

async function save(storage: BurnDeps['storage'], address: string, list: PendingBurn[]): Promise<void> {
    await storage!.setItem(keyFor(address), JSON.stringify(list));
}

/** Every saved, not-yet-consumed burn for this wallet (a bid screen offers them before burning again). */
export async function listPendingBurns(address: string, storage: BurnDeps['storage'] = AsyncStorage): Promise<PendingBurn[]> {
    return load(storage, address);
}

/** The saved, not-yet-consumed burn this wallet can reuse for `amountAtomic`, if any. */
export async function findPendingBurn(address: string, amountAtomic: string, storage: BurnDeps['storage'] = AsyncStorage): Promise<PendingBurn | null> {
    const list = await load(storage, address);
    return list.find((b) => b.amountAtomic === amountAtomic) ?? null;
}

/**
 * return a BROADCAST burn of exactly `amountAtomic` for `address` without recording it —
 * resume a saved one (with its `burnId` when it is already recorded), or burn `amountPvt` once and
 * save it before returning. The caller hands the tx to a pipelined present, which records it once
 * it is mined; {@link obtainRecordedBurn} records it on its own.
 */
export async function obtainBroadcastBurn(
    opts: { address: string; amountPvt: string; amountAtomic: string; onStage?: (s: BurnStage) => void },
    deps: Pick<BurnDeps, 'burn' | 'storage' | 'now' | 'txStatus'>,
): Promise<{ txHash: string; amountAtomic: string; burnId?: string; resumed: boolean }> {
    const storage = deps.storage ?? AsyncStorage;
    const now = deps.now ?? Date.now;
    let list = await load(storage, opts.address);
    const saved = list.find((b) => b.amountAtomic === opts.amountAtomic) ?? null;
    if (saved?.txHash) {
        if (saved.operationId && !saved.burnId && deps.txStatus
            && await deps.txStatus(saved.txHash).catch(() => 'mined' as const) !== 'mined') {
            // A fresh approved attempt recovers ONLY the exact saved operation/nonce.
            const recovered = await deps.burn(opts.amountPvt, saved.operationId);
            if (recovered.txHash !== saved.txHash) throw new Error('burn_recovery_hash_changed');
        }
        return { txHash: saved.txHash, amountAtomic: saved.amountAtomic, ...(saved.burnId ? { burnId: saved.burnId } : {}), resumed: true };
    }
    const operationId = saved?.operationId ?? Crypto.randomUUID();
    if (!saved) {
        // Persist the logical burn before signing or wire I/O, including pre-wire crashes.
        list = [...list, { txHash: '', amountAtomic: opts.amountAtomic, createdAt: now(), operationId }];
        await save(storage, opts.address, list);
    }
    opts.onStage?.('burning');
    const b = await deps.burn(opts.amountPvt, operationId);
    await save(storage, opts.address, list.map(entry => entry.operationId === operationId
        ? { ...entry, txHash: b.txHash, amountAtomic: b.amountAtomic, ...(b.nonce === undefined ? {} : { nonce: b.nonce }) } : entry));
    return { txHash: b.txHash, amountAtomic: b.amountAtomic, resumed: !!saved };
}

/** The relay recorded this saved burn (a record, or a pipelined present that refused afterwards). */
export async function rememberRecordedBurn(address: string, txHash: string, burnId: string, storage: BurnDeps['storage'] = AsyncStorage): Promise<void> {
    const current = await load(storage, address);
    await save(storage, address, current.map((b) => (b.txHash === txHash ? { ...b, burnId } : b)));
}

/**
 * Return a relay-recorded burn of exactly `amountAtomic` for `address` resume a saved one, or
 * burn `amountPvt` once and save it, then record it — the relay holds the record until the burn is
 * final. A dropped connection is retried until the deadline; a REVERTED burn is forgotten
 * (it burned nothing) and reported.
 */
export async function obtainRecordedBurn(
    opts: { address: string; amountPvt: string; amountAtomic: string; onStage?: (s: BurnStage) => void; deadlineMs?: number; intervalMs?: number },
    deps: BurnDeps,
): Promise<{ burnId: string; txHash: string; resumed: boolean }> {
    const storage = deps.storage ?? AsyncStorage;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const entry = await obtainBroadcastBurn(opts, deps);
    if (entry.burnId) return { burnId: entry.burnId, txHash: entry.txHash, resumed: entry.resumed };

    opts.onStage?.('finalizing');
    const deadline = now() + (opts.deadlineMs ?? BURN_RECORD_DEADLINE_MS);
    for (;;) {
        try {
            const rec = await deps.record({ txHash: entry.txHash, chain: 'base', amountAtomic: entry.amountAtomic, awaitFinality: true });
            await rememberRecordedBurn(opts.address, entry.txHash, rec.burnId, storage);
            return { burnId: rec.burnId, txHash: entry.txHash, resumed: entry.resumed };
        } catch (err) {
            if (isRevertedBurnError(err)) {
                await markBurnConsumed(opts.address, { txHash: entry.txHash }, storage);
                throw new Error('The PVT burn reverted on Base — nothing was burned. Try again.');
            }
            if (isRevokedBurnError(err)) {
                await markBurnConsumed(opts.address, { txHash: entry.txHash }, storage);
                throw new Error('This PVT burn did not confirm on Base, so it cannot be used. Try again.');
            }
            if (!isTransientRecordError(err)) throw err;
            if (now() >= deadline) throw new BurnStillFinalizingError(entry.txHash);
            await sleep(opts.intervalMs ?? BURN_RECORD_INTERVAL_MS);
        }
    }
}

/** The product this burn bought succeeded (or the relay says it is already spent): forget it. */
export async function markBurnConsumed(address: string, ref: { burnId?: string; txHash?: string }, storage: BurnDeps['storage'] = AsyncStorage): Promise<void> {
    const list = await load(storage, address);
    await save(storage, address, list.filter((b) => !((ref.burnId && b.burnId === ref.burnId) || (ref.txHash && b.txHash === ref.txHash))));
}
