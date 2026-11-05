/**
 * PE METER (app) — where the encrypted PE backup lives: the person's OWN cloud.
 *
 * iOS an iCloud Documents ubiquity container owned by the app (`iCloud.com.provian.wallet`),
 * through the local Expo module `modules/provian-icloud-documents`. Files there count as
 * "Provian" under Settings > [your name] > iCloud > Manage Account Storage, sync to every
 * device signed into the same Apple Account, and survive deleting the app. (The previous
 * PE archive transport was synced iCloud KEYCHAIN items, which show as no app storage
 * and are size-limited — the reason the operator’s iCloud showed no Provian storage at all.)
 * Android the Google Drive appDataFolder, through the SAME native module the seed backup uses
 * (`ProvianCloudKeychainSync` → Drive REST v3 `files.create/update` with
 * `drive.appdata` scope). It stores each value as one Drive file with no size limit
 * beyond Drive's own, so PE files ride it unchanged under their own `pe_*` names. The
 * seed backup's own key and code path are untouched.
 *
 * Only ciphertext ever reaches either cloud (see `peCloudBackup.ts`).
 */

import { Platform } from 'react-native';

export type CloudKind = 'icloud' | 'google_drive' | 'memory' | 'none';

export interface CloudFileTransport {
    readonly kind: CloudKind;
    /** True when a write can land now (iOS: signed into iCloud with iCloud Drive on; Android: signed into Google). */
    available(): Promise<boolean>;
    write(name: string, text: string): Promise<void>;
    /** The file's text, or null when it does not exist. Downloads it first when only a placeholder is local. */
    read(name: string): Promise<string | null>;
    /** Discover committed manifests, including cloud placeholders, without a shared mutable index. */
    list(): Promise<string[]>;
    /** Ask the person to sign in where the platform needs it (Android Google). True when ready. */
    prepare?(): Promise<boolean>;
}

/** Cloud file names: lowercase letters, digits, `_`, `-`, `.` only (safe on both clouds and in Drive queries). */
export function assertCloudName(name: string): void {
    if (!/^[a-z0-9_.-]{1,96}$/.test(name)) throw new Error(`cloud_name_invalid:${name}`);
}

// ─── memory (tests) ─────────────────────────────────────────────────────────────

export class MemoryCloudFiles implements CloudFileTransport {
    readonly kind: CloudKind = 'memory';
    readonly files = new Map<string, string>();
    online = true;
    writes = 0;
    /** Test hook: fail writes whose name matches. */
    failWritesMatching: RegExp | null = null;

    async available(): Promise<boolean> {
        return this.online;
    }

    async write(name: string, text: string): Promise<void> {
        assertCloudName(name);
        if (!this.online) throw new Error('cloud_offline');
        if (this.failWritesMatching && this.failWritesMatching.test(name)) throw new Error(`simulated cloud write failure: ${name}`);
        this.files.set(name, text);
        this.writes += 1;
    }

    async read(name: string): Promise<string | null> {
        if (!this.online) throw new Error('cloud_offline');
        return this.files.get(name) ?? null;
    }

    async list(): Promise<string[]> {
        if (!this.online) throw new Error('cloud_offline');
        return [...this.files.keys()];
    }
}

// ─── iOS: iCloud Documents (local Expo module) ──────────────────────────────────

/** The JS surface of `modules/provian-icloud-documents` (Swift, Expo Modules API). */
export interface ProvianICloudDocumentsModule {
    /** Signed into iCloud AND the app's ubiquity container resolves (iCloud Drive on for this app). */
    isAvailableAsync(): Promise<boolean>;
    /** Coordinated, atomic write of UTF-8 text to `<container>/PEBackup/<name>`. */
    writeFileAsync(name: string, contents: string): Promise<boolean>;
    /** UTF-8 text of `<container>/PEBackup/<name>`, downloading it first if needed; null when absent. */
    readFileAsync(name: string, timeoutMs: number): Promise<string | null>;
    /** File names in `<container>/PEBackup/` (placeholders for not-yet-downloaded files included). */
    listFilesAsync(): Promise<string[]>;
    /**
     * Restore on a fresh phone: ask iCloud for the container's file list (NSMetadataQuery) and start
     * downloading every backup file, waiting up to `timeoutMs` for the list. Resolves the count found.
     */
    prepareAsync(timeoutMs: number): Promise<number>;
}

function loadICloudModule(): ProvianICloudDocumentsModule | null {
    try {
        // Lazy: expo-modules-core is not loadable under Vitest.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const core = require('expo-modules-core') as { requireOptionalNativeModule<T>(name: string): T | null };
        return core.requireOptionalNativeModule<ProvianICloudDocumentsModule>('ProvianICloudDocuments');
    } catch {
        return null;
    }
}

export function createICloudFiles(mod: ProvianICloudDocumentsModule | null = loadICloudModule()): CloudFileTransport {
    return {
        kind: mod ? 'icloud' : 'none',
        async available() {
            if (!mod) return false;
            try {
                return await mod.isAvailableAsync();
            } catch {
                return false;
            }
        },
        async write(name, text) {
            assertCloudName(name);
            if (!mod) throw new Error('icloud_module_unavailable');
            const ok = await mod.writeFileAsync(name, text);
            if (!ok) throw new Error(`icloud_write_failed:${name}`);
        },
        async read(name) {
            assertCloudName(name);
            if (!mod) throw new Error('icloud_module_unavailable');
            return mod.readFileAsync(name, 60_000);
        },
        async list() {
            if (!mod) throw new Error('icloud_module_unavailable');
            return mod.listFilesAsync();
        },
        async prepare() {
            if (!mod) return false;
            try {
                return (await mod.prepareAsync(30_000)) > 0;
            } catch {
                return false;
            }
        },
    };
}

// ─── Android: Google Drive appDataFolder (the seed backup's native module) ───────

/** The subset of `ProvianCloudKeychainSync` (Android) the PE backup uses. */
export interface DriveAppDataModule {
    store(key: string, value: string): Promise<boolean>;
    retrieve(key: string): Promise<string | null>;
    isSyncVerified(): Promise<boolean>;
    listKeys(): Promise<string[]>;
    signIn?(): Promise<boolean>;
}

function loadDriveModule(): DriveAppDataModule | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const rn = require('react-native') as { NativeModules: Record<string, unknown> };
        return (rn.NativeModules.ProvianCloudKeychainSync as DriveAppDataModule | undefined) ?? null;
    } catch {
        return null;
    }
}

export function createDriveFiles(mod: DriveAppDataModule | null = loadDriveModule()): CloudFileTransport {
    return {
        kind: mod ? 'google_drive' : 'none',
        async available() {
            if (!mod) return false;
            try {
                return await mod.isSyncVerified();
            } catch {
                return false;
            }
        },
        async write(name, text) {
            assertCloudName(name);
            if (!mod) throw new Error('drive_module_unavailable');
            if (!(await mod.store(name, text))) throw new Error(`drive_write_failed:${name}`);
        },
        async read(name) {
            assertCloudName(name);
            if (!mod) throw new Error('drive_module_unavailable');
            return mod.retrieve(name);
        },
        async list() {
            if (!mod) throw new Error('drive_module_unavailable');
            return mod.listKeys();
        },
        async prepare() {
            if (!mod?.signIn) return false;
            try {
                return await mod.signIn();
            } catch {
                return false;
            }
        },
    };
}

/** The transport for this platform. */
export function createPlatformCloudFiles(): CloudFileTransport {
    return Platform.OS === 'ios' ? createICloudFiles() : createDriveFiles();
}

/** User-facing name of where the backup lives. */
export function cloudPlaceLabel(kind: CloudKind = Platform.OS === 'ios' ? 'icloud' : 'google_drive'): string {
    return kind === 'icloud' ? 'iCloud' : kind === 'google_drive' ? 'Google Drive' : 'cloud';
}
