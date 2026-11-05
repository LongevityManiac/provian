/**
 * PE METER (app) — the durable text files the phone's PE store lives in.
 *
 * One small interface so the store is testable in Node (an in-memory implementation) and runs on
 * the phone over expo-file-system (the app's document directory, which iOS and Android never
 * evict). Every write is ATOMIC from a reader's point of view: the text is written to `<path>.tmp`
 * and then moved over `<path>`. A crash between "remove the old file" and "move" leaves only the
 * `.tmp`, which `read` falls back to — so a write is either fully visible or not at all.
 *
 * There is no `delete` for record files. The only files ever removed are a `.tmp` that has been
 * moved and the in-flight batch marker; PEs, receipts and proofs are never removed (the operator’s
 * 10-03: PEs are never deleted by any lifecycle).
 */

export interface MeterFiles {
    /** The text at `path`, or null when it does not exist. */
    read(path: string): Promise<string | null>;
    /** Atomically replace (or create) `path` with `text`. Parent directories are created. */
    writeAtomic(path: string, text: string): Promise<void>;
    /** Names (not paths) of the files and subdirectories directly inside `dir`; empty when it does not exist. */
    list(dir: string): Promise<string[]>;
    /** Remove a transient file (`inflight.json`). Never called for a PE, receipt or proof file. */
    removeTransient(path: string): Promise<void>;
}

const TMP_SUFFIX = '.tmp';

/** A transient-file name the store may remove. Anything else is a record and is never removed. */
export function isTransientPath(path: string): boolean {
    return path.endsWith(TMP_SUFFIX) || /(^|\/)inflight\.json$/.test(path);
}

// ─── in-memory (tests, and a fallback when no filesystem is reachable) ──────────

export class MemoryMeterFiles implements MeterFiles {
    readonly files = new Map<string, string>();
    /** Test hook: throw on the next write whose path matches. */
    failNextWriteMatching: RegExp | null = null;

    async read(path: string): Promise<string | null> {
        return this.files.get(path) ?? this.files.get(path + TMP_SUFFIX) ?? null;
    }

    async writeAtomic(path: string, text: string): Promise<void> {
        if (this.failNextWriteMatching && this.failNextWriteMatching.test(path)) {
            this.failNextWriteMatching = null;
            throw new Error(`simulated write failure: ${path}`);
        }
        this.files.set(path, text);
        this.files.delete(path + TMP_SUFFIX);
    }

    async list(dir: string): Promise<string[]> {
        const prefix = dir.endsWith('/') ? dir : dir + '/';
        const names = new Set<string>();
        for (const key of this.files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            if (rest.length === 0) continue;
            // Like a directory listing: a nested path shows as its first segment (a subdirectory).
            if (rest.includes('/')) {
                names.add(rest.slice(0, rest.indexOf('/')));
                continue;
            }
            names.add(rest.endsWith(TMP_SUFFIX) ? rest.slice(0, -TMP_SUFFIX.length) : rest);
        }
        return [...names].sort();
    }

    async removeTransient(path: string): Promise<void> {
        if (!isTransientPath(path)) throw new Error(`meter_files_refuse_remove:${path}`);
        this.files.delete(path);
        this.files.delete(path + TMP_SUFFIX);
    }
}

// ─── expo-file-system (the phone) ───────────────────────────────────────────────

type LegacyFS = typeof import('expo-file-system/legacy');

/**
 * The phone's implementation, rooted at `<documentDirectory>/<rootName>/`. expo-file-system is
 * loaded lazily (the static import pulls expo-modules-core, which Vitest cannot transform).
 */
export function createExpoMeterFiles(rootName = 'pe_meter'): MeterFiles {
    let fsPromise: Promise<LegacyFS> | null = null;
    const fs = (): Promise<LegacyFS> => {
        if (!fsPromise) fsPromise = import('expo-file-system/legacy');
        return fsPromise;
    };
    const absolute = async (path: string): Promise<string> => {
        const mod = await fs();
        if (!mod.documentDirectory) throw new Error('meter_files_no_document_directory');
        return `${mod.documentDirectory}${rootName}/${path}`;
    };
    const ensureParent = async (abs: string): Promise<void> => {
        const mod = await fs();
        const dir = abs.slice(0, abs.lastIndexOf('/') + 1);
        const info = await mod.getInfoAsync(dir);
        if (!info.exists) await mod.makeDirectoryAsync(dir, { intermediates: true });
    };
    const readIfExists = async (abs: string): Promise<string | null> => {
        const mod = await fs();
        const info = await mod.getInfoAsync(abs);
        if (!info.exists) return null;
        return mod.readAsStringAsync(abs);
    };
    return {
        async read(path) {
            const abs = await absolute(path);
            return (await readIfExists(abs)) ?? (await readIfExists(abs + TMP_SUFFIX));
        },
        async writeAtomic(path, text) {
            const mod = await fs();
            const abs = await absolute(path);
            await ensureParent(abs);
            const tmp = abs + TMP_SUFFIX;
            await mod.writeAsStringAsync(tmp, text);
            // iOS FileManager.moveItem refuses an existing destination, so the old copy goes first;
            // a crash in between leaves the complete `.tmp`, which `read` falls back to.
            await mod.deleteAsync(abs, { idempotent: true });
            await mod.moveAsync({ from: tmp, to: abs });
        },
        async list(dir) {
            const mod = await fs();
            const abs = await absolute(dir.endsWith('/') ? dir : dir + '/');
            const info = await mod.getInfoAsync(abs);
            if (!info.exists) return [];
            const names = await mod.readDirectoryAsync(abs);
            const out = new Set<string>();
            for (const n of names) out.add(n.endsWith(TMP_SUFFIX) ? n.slice(0, -TMP_SUFFIX.length) : n);
            return [...out].sort();
        },
        async removeTransient(path) {
            if (!isTransientPath(path)) throw new Error(`meter_files_refuse_remove:${path}`);
            const mod = await fs();
            const abs = await absolute(path);
            await mod.deleteAsync(abs, { idempotent: true });
            await mod.deleteAsync(abs + TMP_SUFFIX, { idempotent: true });
        },
    };
}
