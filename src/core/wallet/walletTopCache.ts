/**
 * The last answer each relay read at the top of the Wallet screen gave, saved per wallet address,
 * so the screen opens on what it last showed instead of an empty placeholder while the relay
 * answers. Covers the participation summary (the projected figure), the linked-agents list and the
 * attention count.
 *
 * These are display copies of non-secret relay answers (counts and public agent names), so they
 * live in AsyncStorage. Every value is keyed by the wallet address, so a saved answer can never be
 * shown on another wallet, and every read checks the stored shape before it is used. Storage
 * failures are swallowed: a missing saved value only means the screen waits for the relay.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type WalletTopKey = 'accrual' | 'linkedAgents' | 'attentionCount';

export interface SavedWalletTop<T> {
    readonly value: T;
    readonly savedAtMs: number;
}

const PREFIX = 'provian.walletTop.v1';

export function walletTopStorageKey(key: WalletTopKey, address: string): string {
    return `${PREFIX}.${key}.${address.toLowerCase()}`;
}

export async function readWalletTop<T>(
    key: WalletTopKey,
    address: string | null | undefined,
    isValue: (value: unknown) => value is T,
): Promise<SavedWalletTop<T> | null> {
    if (!address) return null;
    try {
        const raw = await AsyncStorage.getItem(walletTopStorageKey(key, address));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const { value, savedAtMs } = parsed as { value?: unknown; savedAtMs?: unknown };
        if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs) || savedAtMs <= 0) return null;
        if (!isValue(value)) return null;
        return { value, savedAtMs };
    } catch {
        return null;
    }
}

export async function saveWalletTop<T>(
    key: WalletTopKey,
    address: string | null | undefined,
    value: T,
    nowMs: number = Date.now(),
): Promise<void> {
    if (!address) return;
    try {
        await AsyncStorage.setItem(walletTopStorageKey(key, address), JSON.stringify({ value, savedAtMs: nowMs }));
    } catch {
        // A value that could not be saved is simply loaded from the relay next time.
    }
}

/** The participation summary's minimum shape: what the card reads. */
export function isSavedAccrual(value: unknown): value is { totalPEs: number; weeklyPEs: number; currentSettlementProjection: { available: boolean } } {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    const projection = v.currentSettlementProjection as Record<string, unknown> | null | undefined;
    return typeof v.totalPEs === 'number' && Number.isFinite(v.totalPEs)
        && typeof v.weeklyPEs === 'number' && Number.isFinite(v.weeklyPEs)
        && typeof projection === 'object' && projection !== null
        && typeof projection.available === 'boolean'
        && (projection.available !== true || typeof projection.totalPVT === 'string');
}

/** A linked-agents list: every entry names its agent. */
export function isSavedAgentList(value: unknown): value is Array<{ agent_id: string }> {
    return Array.isArray(value) && value.every(a =>
        typeof a === 'object' && a !== null && typeof (a as { agent_id?: unknown }).agent_id === 'string');
}

export function isSavedCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
