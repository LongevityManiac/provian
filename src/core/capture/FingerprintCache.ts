/**
 * AsyncStorage-backed fingerprint dedup cache with a 24-hour TTL.
 *
 * Purpose: keep the mobile WebView surface from re-submitting an
 * `ai_conversation` PE with the same `session_fingerprint_hash` that was
 * already accepted by the relay. The relay enforces a 24-hour dedup window
 * (PHASE_2B_DESIGN_NOTES.md §5); this local cache matches that horizon so
 * the client stops emitting duplicates at the source.
 *
 * Storage layout:
 *   key   = 'provian/capture/fingerprint_cache_v1'
 *   value = JSON.stringify({ [fingerprint: string]: timestampMs: number })
 *
 * Expired entries are pruned lazily on every read and every write.
 *
 * Storage is injected. Production passes `@react-native-async-storage/async-storage`.
 * Tests pass an in-memory adapter to avoid touching the no-op test stub.
 */

export const FINGERPRINT_CACHE_STORAGE_KEY = 'provian/capture/fingerprint_cache_v1';
export const FINGERPRINT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

interface CachePayload {
    [fingerprint: string]: number;
}

export interface FingerprintCacheOptions {
    storage: StorageAdapter;
    ttlMs?: number;
    storageKey?: string;
    /**
     * Maximum entries kept in the cache. Defense against unbounded growth
     * on a pathological client that never sees TTL expiry reach it (e.g.
     * system clock stuck in the past). When exceeded after pruning, the
     * oldest entries are dropped until size is under the cap.
     */
    maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export class FingerprintCache {
    private readonly storage: StorageAdapter;
    private readonly ttlMs: number;
    private readonly storageKey: string;
    private readonly maxEntries: number;

    constructor(opts: FingerprintCacheOptions) {
        this.storage = opts.storage;
        this.ttlMs = opts.ttlMs ?? FINGERPRINT_CACHE_TTL_MS;
        this.storageKey = opts.storageKey ?? FINGERPRINT_CACHE_STORAGE_KEY;
        this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    }

    async has(fingerprint: string, nowMs: number = Date.now()): Promise<boolean> {
        const payload = await this.loadPruned(nowMs);
        return Object.prototype.hasOwnProperty.call(payload, fingerprint);
    }

    async add(fingerprint: string, nowMs: number = Date.now()): Promise<void> {
        const payload = await this.loadPruned(nowMs);
        payload[fingerprint] = nowMs;
        this.enforceCap(payload);
        await this.storage.setItem(this.storageKey, JSON.stringify(payload));
    }

    async size(nowMs: number = Date.now()): Promise<number> {
        const payload = await this.loadPruned(nowMs);
        return Object.keys(payload).length;
    }

    private async loadPruned(nowMs: number): Promise<CachePayload> {
        const raw = await this.storage.getItem(this.storageKey);
        if (!raw) return {};
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {};
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const obj = parsed as Record<string, unknown>;
        const out: CachePayload = {};
        const cutoff = nowMs - this.ttlMs;
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            if (value > nowMs) continue; // future timestamp, discard
            if (value < cutoff) continue; // expired
            out[key] = value;
        }
        return out;
    }

    private enforceCap(payload: CachePayload): void {
        const keys = Object.keys(payload);
        if (keys.length <= this.maxEntries) return;
        keys.sort((a, b) => payload[a] - payload[b]);
        const toDrop = keys.length - this.maxEntries;
        for (let i = 0; i < toDrop; i++) {
            delete payload[keys[i]];
        }
    }
}

/**
 * Build an in-memory storage adapter. Useful for tests and as the caller's
 * fallback when AsyncStorage is unavailable. Not a singleton; each call
 * returns a new adapter with its own backing Map.
 */
export function createMemoryStorage(): StorageAdapter & { snapshot(): Record<string, string> } {
    const store = new Map<string, string>();
    return {
        async getItem(key: string): Promise<string | null> {
            return store.has(key) ? (store.get(key) as string) : null;
        },
        async setItem(key: string, value: string): Promise<void> {
            store.set(key, value);
        },
        snapshot(): Record<string, string> {
            return Object.fromEntries(store.entries());
        },
    };
}
