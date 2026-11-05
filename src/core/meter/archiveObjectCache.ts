/**
 * Pulled PE Archive days, kept so one pull serves repeated use (PE Archive human-path run,
 * 2026-10-07). Every read of an Archive-class object pays a retrieval fee plus egress; a day pulled
 * for a presentation or for "Pull back" is kept here and used again.
 *
 * What is kept is the day's object exactly as the relay served it: ciphertext sealed to the person
 * (and the same bytes the Archive holds). Opening it still takes the person's key. It lives in the
 * app's CACHE directory (the OS may clear it; then the day is simply pulled again), bounded in size,
 * oldest first out. It is never a PE record: the PE store, its backups and its no-delete rule live
 * elsewhere (`meterFiles.ts`).
 */

export interface ArchiveObjectCache {
    get(key: string): Promise<string | null>;
    put(key: string, text: string): Promise<void>;
}

/** The cache's file name for `<wallet>/<day>`. */
export function archiveCacheFileName(key: string): string {
    return `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.pea`;
}

export class MemoryArchiveObjectCache implements ArchiveObjectCache {
    readonly entries = new Map<string, string>();
    puts = 0;
    async get(key: string): Promise<string | null> {
        return this.entries.get(key) ?? null;
    }
    async put(key: string, text: string): Promise<void> {
        this.puts += 1;
        this.entries.set(key, text);
    }
}

export const ARCHIVE_CACHE_MAX_BYTES = 64_000_000;

type LegacyFS = typeof import('expo-file-system/legacy');

/** The phone's cache: `<cacheDirectory>/pe_archive_cache/`, at most `maxBytes`, oldest out first. */
export function createExpoArchiveObjectCache(maxBytes: number = ARCHIVE_CACHE_MAX_BYTES): ArchiveObjectCache {
    let fsPromise: Promise<LegacyFS> | null = null;
    const fs = (): Promise<LegacyFS> => {
        if (!fsPromise) fsPromise = import('expo-file-system/legacy');
        return fsPromise;
    };
    const dir = async (): Promise<string> => {
        const mod = await fs();
        if (!mod.cacheDirectory) throw new Error('archive_cache_no_cache_directory');
        return `${mod.cacheDirectory}pe_archive_cache/`;
    };
    const evict = async (): Promise<void> => {
        const mod = await fs();
        const root = await dir();
        const names = (await mod.readDirectoryAsync(root)).filter((n) => n.endsWith('.pea'));
        const files: { path: string; size: number; at: number }[] = [];
        for (const n of names) {
            const info = await mod.getInfoAsync(`${root}${n}`);
            if (info.exists && !info.isDirectory) files.push({ path: `${root}${n}`, size: info.size ?? 0, at: info.modificationTime ?? 0 });
        }
        let total = files.reduce((s, f) => s + f.size, 0);
        for (const f of files.sort((a, b) => a.at - b.at)) {
            if (total <= maxBytes) break;
            await mod.deleteAsync(f.path, { idempotent: true });
            total -= f.size;
        }
    };
    return {
        async get(key) {
            const mod = await fs();
            const path = `${await dir()}${archiveCacheFileName(key)}`;
            const info = await mod.getInfoAsync(path);
            return info.exists ? mod.readAsStringAsync(path) : null;
        },
        async put(key, text) {
            const mod = await fs();
            const root = await dir();
            const info = await mod.getInfoAsync(root);
            if (!info.exists) await mod.makeDirectoryAsync(root, { intermediates: true });
            const path = `${root}${archiveCacheFileName(key)}`;
            const tmp = `${path}.tmp`;
            await mod.writeAsStringAsync(tmp, text);
            await mod.deleteAsync(path, { idempotent: true });
            await mod.moveAsync({ from: tmp, to: path });
            await evict().catch(() => undefined);
        },
    };
}
