/**
 * secureSeedStore — where the BIP-39 seed lives, and how it is replaced without ever losing it.
 *
 * THE DEFECT (audited 2026-09-26, expo-secure-store 15.0.8):
 * F14 put the seed behind the OS user-authentication gate with
 * `setItemAsync(KEY, m, { requireAuthentication: true })`. That library pins the gate to the
 * CURRENT biometric set: iOS `.biometryCurrentSet` (SecureStoreModule.swift:105), Android a
 * per-use Keystore key that the platform invalidates on enrollment change (AESEncryptor.kt:59-64,
 * read → null at SecureStoreModule.kt:156-158). Re-enrolling a face or a finger therefore made
 * the seed permanently unreadable, and a device with no enrolled biometrics (Android passcode
 * fallback) could not write it at all, so wallet creation threw.
 *
 * THE STORE:
 * - The seed lives in `provian-secure-seed` (modules/), a native store whose ACL is still
 * OS-enforced user authentication (F14 stands) but survives re-enrollment and admits the device
 * passcode: iOS `.userPresence`; Android `setInvalidatedByBiometricEnrollment(false)` +
 * BIOMETRIC_STRONG | DEVICE_CREDENTIAL. The native `set` only ADDS — it refuses to replace an
 * existing item — so nothing can ever be overwritten in place.
 * - There are two native slots, A and B. The live one is named by ONE AsyncStorage record, the
 * IDENTITY: `{slot, evm, sol}` which slot holds the seed and which wallet it is. That single
 * `setItem` is the commit point of every change; the public address shown anywhere in the app is
 * read from the same record, so what is shown and what is stored cannot disagree.
 *
 * HOW A NEW VALUE IS STORED (write, migration, repair):
 * 1. stage it in the NON-live slot (emptied first — it never holds the live seed),
 * 2. read it back: byte-for-byte equal AND deriving the expected EVM address,
 * 3. commit the identity naming the staged slot (one atomic write),
 * 4. only then delete the replaced slot / the legacy item, and clear those flags.
 * A crash before 3 leaves the old identity and the old seed untouched; a crash after 3 leaves the
 * new seed live and the retirements pending (retried on the next verified read).
 *
 * HOW A SEED IS READ:
 * A value is returned ONLY if it derives the expected address (the identity's; for a wallet that
 * never moved, the F14 public-address cache). The live slot is tried first; if it is absent, can
 * never decrypt, or holds another wallet, every other stored copy is checked and the ONE that
 * derives the expected address is used. If none does, SeedUnreadableError (→ restore flow) — the
 * seed of a different wallet is never handed out.
 *
 * INVARIANTS (money path):
 * - ONE deletion choke point (`deleteProven`): a seed item — legacy or slot — is deleted only if it
 * was READ in the same operation and derives the wallet being replaced (or a copy of the live
 * one), or is byte-equal to the value being written. The only other deletes are this operation's
 * own uncommitted write (`deleteOwnWrite`) and the explicit wallet wipe (`clear`).
 * One more proof admits a delete there, for an Android native SLOT only: its Keystore key was
 * PERMANENTLY INVALIDATED, shown by TWO independent signals in the same operation that both come
 * from KeyPermanentlyInvalidatedException — a read that failed with ERR_SEED_UNRECOVERABLE tagged
 * `[cause:invalidated]`, and the no-prompt probe answering 'invalidated'. Such an item can never be
 * read by anyone, so removing it loses nothing. Never on a key the Keystore merely reports MISSING
 * (that lookup can be false transiently — keystore1 swallows RemoteException in contains(),
 * keystore2 returns null metadata on any KeyStoreException), never on an unwrap/integrity failure,
 * a cancel or any transient error, never for the legacy item, never on iOS.
 * - the live slot is never deleted or overwritten except by the explicit wallet wipe;
 * - a new wallet is generated only when NO seed item of any kind exists; nothing is generated or
 * adopted beside an item that could not be read or identified.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { ProvianSecureSeedModule, SecureSeedProbe } from '../../../modules/provian-secure-seed';
import { translate } from '../../i18n/translate';

export const SEED_ITEMS = {
    /** expo-secure-store item written by F14 (and earlier, with no ACL). Read + migrated, never written by native builds. */
    LEGACY: 'provian_bip39_mnemonic',
    /** provian-secure-seed slot A (`.userPresence` / re-enrollment-proof Keystore key). */
    SLOT_A: 'provian_bip39_mnemonic_v2',
    /** provian-secure-seed slot B — the staging slot while A is live, and vice versa. */
    SLOT_B: 'provian_bip39_mnemonic_v2b',
} as const;

export type SeedSlot = 'a' | 'b';
const SLOTS: readonly SeedSlot[] = ['a', 'b'];
const SLOT_ITEM: Record<SeedSlot, string> = { a: SEED_ITEMS.SLOT_A, b: SEED_ITEMS.SLOT_B };
const otherSlot = (slot: SeedSlot): SeedSlot => (slot === 'a' ? 'b' : 'a');

/** Non-secret bookkeeping (AsyncStorage). */
export const SEED_STATE_KEYS = {
    /** The commit record: JSON `SeedIdentity`. */
    IDENTITY: 'provian_seed_identity',
    /** '1' while the wallet is known but no readable copy of its seed was found. */
    UNREADABLE: 'provian_seed_unreadable',
} as const;

export interface PublicAddresses {
    evm: string;
    sol: string;
}

export interface SeedIdentity extends PublicAddresses {
    v: 1;
    /** The native slot holding this wallet's verified seed. */
    slot: SeedSlot;
    /**
     * Pending: delete the OTHER slot — but only once a read in the deleting operation shows it still
     * derives this EVM address (the wallet it held when it was replaced). Otherwise it is kept.
     */
    retireSlot?: string;
    /** Pending: delete the legacy expo item, under the same read-and-derive proof against this address. */
    retireLegacy?: string;
}

export const seedUnlockPrompt = (): string => translate('biometricPrompts.unlockWalletKey', 'Unlock your wallet key');

/**
 * The seed is missing or can never be decrypted although this device knows the wallet's public
 * address. The only correct response is the restore flow (cloud backup or recovery phrase). Never
 * treat this as "no wallet" and never write a new seed over it.
 */
export class SeedUnreadableError extends Error {
    readonly code = 'SEED_UNREADABLE';
    /** English text for dApp replies and PE records; `message` is the on-screen copy. */
    readonly englishMessage = 'Your wallet key on this device cannot be read. Restore it from your cloud backup or recovery phrase.';

    constructor() {
        super(translate('seedErrors.unreadable', 'Your wallet key on this device cannot be read. Restore it from your cloud backup or recovery phrase.'));
        this.name = 'SeedUnreadableError';
    }
}

/**
 * A new seed was written to the staging slot but did not read back as the same wallet. Only the
 * staging slot was touched: the wallet key that was live before (if any) is exactly as it was.
 */
export class SeedWriteVerificationError extends Error {
    readonly code = 'SEED_WRITE_UNVERIFIED';

    constructor(reason: string) {
        super(translate('seedErrors.writeUnverified', `The new wallet key could not be verified after writing it (${reason}). Your existing wallet key, if any, was not changed; please try again.`, { reason }));
        this.name = 'SeedWriteVerificationError';
    }
}

/**
 * More than one DIFFERENT valid wallet phrase is stored on this device and nothing identifies which one
 * is the user's (bookkeeping lost, e.g. an iOS reinstall inside a replacement's crash window). Nothing
 * is auto-picked and nothing is deleted: the user restores the wallet they use (recovery phrase or
 * cloud backup), which adopts the matching stored copy and keeps the other.
 */
export class MultipleUnidentifiedWalletsError extends Error {
    readonly code = 'SEED_MULTIPLE_UNIDENTIFIED';

    constructor() {
        super('More than one wallet already exists on this device and none is identified as yours. Nothing was changed: restore the wallet you use from its recovery phrase or cloud backup.');
        this.name = 'MultipleUnidentifiedWalletsError';
    }
}

/**
 * A seed item is stored on this device that could not be read or identified (unreadable, undecodable,
 * or answering errSecAuthFailed — which a Face ID lockout also produces) and nothing identifies the
 * wallet. It may be a real wallet whose bookkeeping an iOS reinstall wiped, so nothing is generated or
 * adopted beside it and nothing deletes it: the conflict panel offers Restore, or the explicit,
 * biometric + destructive-confirm "Delete and retry".
 */
export class UnidentifiedStoredKeyError extends Error {
    readonly code = 'SEED_UNIDENTIFIED_STORED_KEY';

    constructor() {
        super('A wallet already exists on this device but could not be read or identified. Nothing was changed: restore your wallet from its recovery phrase or cloud backup.');
        this.name = 'UnidentifiedStoredKeyError';
    }
}

export type NativeSeedStore = Pick<ProvianSecureSeedModule, 'isAvailable' | 'hasItemAsync' | 'probeItemAsync' | 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'> & Partial<ProvianSecureSeedModule>;

export interface LegacySeedStore {
    getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
    setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
    deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

export interface KeyValueStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface SeedVaultDeps {
    native: () => NativeSeedStore | null;
    legacy: LegacySeedStore;
    kv: KeyValueStore;
    /** AsyncStorage keys of the F14 public-address cache (the identity of a wallet that never moved). */
    publicCacheKeys: { evm: string; sol: string };
    deriveEvmAddress: (mnemonic: string) => Promise<string>;
    deriveSolanaAddress: (mnemonic: string) => Promise<string>;
    /**
     * True only on Android, where a native slot's Keystore key can be permanently invalidated (the
     * secure lock screen was removed). iOS `.userPresence` items are never invalidated: absent → false.
     */
    slotKeysCanBeInvalidated?: () => boolean;
    log?: (message: string) => void;
}

export type MigrationOutcome =
    | 'no_native_store'
    /** The live slot is present (no-prompt probe) — nothing to do. */
    | 'already_migrated'
    | 'migrated'
    | 'no_wallet'
    /** The wallet is known but no readable copy of its seed exists: route to restore. */
    | 'unreadable'
    /** Not finished this time (a prompt was dismissed, the read-back failed, …). Retried later. */
    | 'deferred';

/** Resolve the native store, or null when the build does not carry it (Expo Go, unit tests). */
export function loadNativeSeedStore(): NativeSeedStore | null {
    try {
        const mod = requireOptionalNativeModule<NativeSeedStore>('ProvianSecureSeed');
        return mod && typeof mod.isAvailable === 'function' && mod.isAvailable() ? mod : null;
    } catch {
        return null;
    }
}

function nativeErrorCode(err: unknown): string | undefined {
    if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code?: unknown }).code;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}

/**
 * expo-secure-store's iOS text for errSecAuthFailed (SecureStoreExceptions.swift). An F14 item whose
 * `.biometryCurrentSet` constraint was invalidated by a re-enrollment answers this; a dismissed prompt
 * answers errSecUserCanceled ("User canceled the operation.") and is NOT matched. Used for ROUTING
 * only (restore flow) — never to delete or overwrite anything.
 */
const LEGACY_AUTH_FAILED = /Authentication failed\. Provided passphrase\/PIN is incorrect/;

function isLegacyAuthFailed(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return LEGACY_AUTH_FAILED.test(message) && !/cancel/i.test(message);
}

/**
 * The `[cause:…]` tag the Android module puts in an ERR_SEED_UNRECOVERABLE message (searched anywhere
 * in it: expo may wrap the message). Undefined when there is none.
 */
function unrecoverableCause(err: unknown): string | undefined {
    const message = err instanceof Error ? err.message : String(err);
    return /\[cause:([a-z_]+)\]/.exec(message)?.[1];
}

/** A dismissed prompt (native or expo): the user said "not now" — the one answer an existence check defers on. */
function isCancellation(err: unknown): boolean {
    if (nativeErrorCode(err) === 'ERR_SEED_AUTH_CANCELLED') return true;
    const message = err instanceof Error ? err.message : String(err);
    return /cancel/i.test(message);
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function digest(value: string): string {
    return bytesToHex(sha256(utf8ToBytes(value)));
}

export function parseSeedIdentity(raw: string | null): SeedIdentity | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const r = parsed as Record<string, unknown>;
        if (r.v !== 1 || (r.slot !== 'a' && r.slot !== 'b')) return null;
        if (typeof r.evm !== 'string' || !r.evm || typeof r.sol !== 'string') return null;
        const identity: SeedIdentity = { v: 1, slot: r.slot, evm: r.evm, sol: r.sol };
        if (typeof r.retireSlot === 'string' && r.retireSlot) identity.retireSlot = r.retireSlot;
        if (typeof r.retireLegacy === 'string' && r.retireLegacy) identity.retireLegacy = r.retireLegacy;
        return identity;
    } catch {
        return null;
    }
}

/** Legacy F14 write options — used only by a build that lacks the native store. */
const LEGACY_WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: true,
};

/** A stored seed item: the legacy expo-secure-store item or one of the two native slots. */
type SeedItem = 'legacy' | SeedSlot;

type ItemRead =
    | { kind: 'value'; value: string }
    | { kind: 'absent' }
    /**
     * Present but can never be read (key invalidated / integrity failure / iOS errSecAuthFailed).
     * `nativeCause`: a native slot whose read rejected with ERR_SEED_UNRECOVERABLE — the module's
     * `[cause:…]` tag ('invalidated', 'key_missing', 'unwrap_failed', 'integrity', 'malformed'), or
     * 'untagged' when the module gave none (an older build, iOS).
     */
    | { kind: 'unreadable'; nativeCause?: string }
    /** Cancel, failed auth, no UI, interrupted — not evidence about the item. */
    | { kind: 'transient'; error: unknown };

/** What a deletion may remove: an item whose value, read in THIS operation, is one of these. */
interface DeletionProof {
    /** The item derives one of these wallets (the identity being replaced, or a copy of the live one). */
    evms: readonly string[];
    /** …or is byte-for-byte one of these values (a copy of a value this operation is writing/verified). */
    bytes: readonly string[];
}

/** Per-operation state: reads made in this operation (the deletion proof) and this operation's own writes. */
interface OperationState {
    actionId?: string | null;
    reads: Map<SeedItem, ItemRead>;
    ownWrites: Set<SeedItem>;
}

export class SeedActionKeyUpgradeDeferredError extends Error {
    constructor() { super(translate('seedErrors.keptUnidentified', KEPT_UNIDENTIFIED_MESSAGE)); }
}

const KEPT_UNIDENTIFIED_MESSAGE =
    'Another wallet key on this device could not be identified, so it is kept. Nothing was changed. Remove it only with Delete wallet.';

export class SeedVault {
    private queue: Promise<unknown> = Promise.resolve();
    /** sha256(address|mnemonic) pairs whose derivation was already computed this session (memory only). */
    private readonly proven = new Set<string>();
    private op: OperationState = { reads: new Map(), ownWrites: new Set() };

    constructor(private readonly deps: SeedVaultDeps) {}

    /**
     * Serialize every vault operation: at most one keychain prompt sequence at a time. Each operation
     * starts with an empty read ledger — a deletion is proven only by a read made inside it.
     */
    private exclusive<T>(fn: () => Promise<T>, actionId?: string | null): Promise<T> {
        const start = async () => {
            this.op = { reads: new Map(), ownWrites: new Set(), actionId };
            try { return await fn(); }
            finally { this.op = { reads: new Map(), ownWrites: new Set() }; }
        };
        const run = this.queue.then(start, start);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private log(message: string): void {
        this.deps.log?.(message);
    }

    // ── bookkeeping ────────────────────────────────────────────────────────────────────────────

    private async loadIdentity(): Promise<SeedIdentity | null> {
        return parseSeedIdentity(await this.deps.kv.getItem(SEED_STATE_KEYS.IDENTITY));
    }

    /** THE commit point: one atomic AsyncStorage write. */
    private async commit(identity: SeedIdentity): Promise<void> {
        await this.deps.kv.setItem(SEED_STATE_KEYS.IDENTITY, JSON.stringify(identity));
    }

    private async legacyCache(): Promise<PublicAddresses | null> {
        const evm = await this.deps.kv.getItem(this.deps.publicCacheKeys.evm);
        if (!evm) return null;
        const sol = (await this.deps.kv.getItem(this.deps.publicCacheKeys.sol)) ?? '';
        return { evm, sol };
    }

    /** Keep the F14 cache keys equal to the identity (secondary; the identity wins everywhere). */
    private async syncLegacyCache(identity: PublicAddresses): Promise<void> {
        try {
            const cached = await this.legacyCache();
            if (!cached || !sameAddress(cached.evm, identity.evm)) await this.deps.kv.setItem(this.deps.publicCacheKeys.evm, identity.evm);
            if (identity.sol && cached?.sol !== identity.sol) await this.deps.kv.setItem(this.deps.publicCacheKeys.sol, identity.sol);
        } catch {
            this.log('public-address cache refresh deferred');
        }
    }

    private async markUnreadable(): Promise<void> {
        await this.deps.kv.setItem(SEED_STATE_KEYS.UNREADABLE, '1').catch(() => undefined);
    }

    private async clearUnreadable(): Promise<void> {
        await this.deps.kv.removeItem(SEED_STATE_KEYS.UNREADABLE).catch(() => undefined);
    }

    // ── item reads (classified, recorded in the operation's ledger) ────────────────────────────

    private async readItem(native: NativeSeedStore | null, item: SeedItem, prompt: string): Promise<ItemRead> {
        const seen = this.op.reads.get(item);
        if (seen && seen.kind !== 'transient') return seen;
        let result: ItemRead;
        if (item === 'legacy') {
            try {
                const value = this.op.actionId && native?.getLegacyItemAsync
                    ? await native.getLegacyItemAsync(SEED_ITEMS.LEGACY, prompt, this.op.actionId)
                    : await this.deps.legacy.getItemAsync(SEED_ITEMS.LEGACY, { authenticationPrompt: prompt });
                result = value === null ? { kind: 'absent' } : { kind: 'value', value };
            } catch (err) {
                result = (isLegacyAuthFailed(err) || nativeErrorCode(err) === 'ERR_SEED_UNRECOVERABLE') ? { kind: 'unreadable' } : { kind: 'transient', error: err };
            }
        } else {
            if (!native) return { kind: 'absent' };
            try {
                const value = await native.getItemAsync(SLOT_ITEM[item], prompt, this.op.actionId);
                result = value === null ? { kind: 'absent' } : { kind: 'value', value };
            } catch (err) {
                result = nativeErrorCode(err) === 'ERR_SEED_UNRECOVERABLE'
                    ? { kind: 'unreadable', nativeCause: unrecoverableCause(err) ?? 'untagged' }
                    : { kind: 'transient', error: err };
            }
        }
        this.op.reads.set(item, result);
        return result;
    }

    /** Is `value` a mnemonic of the wallet at `address`? */
    private async derivesTo(value: string, address: string): Promise<boolean> {
        const key = digest(`${address.toLowerCase()}|${value}`);
        if (this.proven.has(key)) return true;
        if (!validateMnemonic(value, wordlist)) return false;
        const ok = sameAddress(await this.deps.deriveEvmAddress(value), address);
        if (ok) this.proven.add(key);
        return ok;
    }

    private async addressesOf(value: string): Promise<PublicAddresses> {
        const [evm, sol] = await Promise.all([this.deps.deriveEvmAddress(value), this.deps.deriveSolanaAddress(value)]);
        return { evm, sol };
    }

    // ── THE deletion choke point ───────────────────────────────────────────────────────────────
    //
    // Every deletion of a seed item goes through exactly one of these three, and nothing else in
    // this module calls a delete:
    //   deleteProven   — the item was READ in this operation and its value derives one of the proof
    //                    wallets (the identity being replaced, or a copy of the live one) or is
    //                    byte-equal to a value this operation writes. An unread, unreadable, undecodable
    //                    or foreign item is KEPT — except an Android native slot whose key was
    //                    permanently INVALIDATED by BOTH signals in this operation (its read rejected
    //                    ERR_SEED_UNRECOVERABLE [cause:invalidated] AND the no-prompt probe answers
    //                    'invalidated'): nothing can ever read it, and keeping it would block every
    //                    later repair. A key reported MISSING is never proof (see the header).
    //   deleteOwnWrite — a value THIS operation wrote and never committed (a failed staging).
    //   clear          — the explicit, user-confirmed wallet wipe.

    private async rawDelete(native: NativeSeedStore | null, item: SeedItem): Promise<void> {
        if (item === 'legacy') await this.deps.legacy.deleteItemAsync(SEED_ITEMS.LEGACY);
        else if (native) await native.deleteItemAsync(SLOT_ITEM[item]);
        this.op.reads.delete(item);
        this.op.ownWrites.delete(item);
    }

    /** Transient read failures THROW (the caller keeps its pending state and retries later). */
    private async deleteProven(native: NativeSeedStore | null, item: SeedItem, proof: DeletionProof, prompt: string): Promise<'deleted' | 'absent' | 'kept'> {
        const r = await this.readItem(native, item, prompt);
        if (r.kind === 'transient') throw r.error;
        if (r.kind === 'absent') return 'absent';
        if (r.kind === 'value') {
            let matched = proof.bytes.includes(r.value);
            for (const evm of proof.evms) {
                if (matched) break;
                matched = await this.derivesTo(r.value, evm);
            }
            if (matched) {
                await this.rawDelete(native, item);
                return 'deleted';
            }
        }
        if (item !== 'legacy' && (await this.keyPermanentlyGone(native, item, r))) {
            this.log(`removed a seed slot whose key was permanently invalidated (${item}: read [cause:invalidated] + probe invalidated)`);
            await this.rawDelete(native, item);
            return 'deleted';
        }
        this.log(`kept a seed item that was not proven to be the replaced wallet (${item}: ${r.kind})`);
        return 'kept';
    }

    /**
     * Android only: both independent signals that `slot`'s Keystore key was permanently INVALIDATED —
     * the read in THIS operation (`r`, from the operation's ledger) rejected ERR_SEED_UNRECOVERABLE
     * with cause 'invalidated', and the no-prompt probe, asked now, answers 'invalidated'. Both come
     * only from KeyPermanentlyInvalidatedException. Anything else — a key reported missing (possibly a
     * transient Keystore lookup failure), an unwrap/integrity failure, an untagged error, a cancel,
     * AUTH_UNAVAILABLE, a probe error or 'unknown'/'present'/'unrecoverable', iOS — is not proof.
     */
    private async keyPermanentlyGone(native: NativeSeedStore | null, slot: SeedSlot, r: ItemRead): Promise<boolean> {
        if (!native || r.kind !== 'unreadable' || r.nativeCause !== 'invalidated') return false;
        if (this.op.reads.get(slot) !== r) return false;
        if (this.deps.slotKeysCanBeInvalidated?.() !== true) return false;
        try {
            return (await native.probeItemAsync(SLOT_ITEM[slot])) === 'invalidated';
        } catch {
            return false;
        }
    }

    private async deleteOwnWrite(native: NativeSeedStore, item: SeedSlot): Promise<void> {
        if (!this.op.ownWrites.has(item)) throw new Error('refusing to delete a seed item this operation did not write');
        await this.rawDelete(native, item);
    }

    // ── staging ────────────────────────────────────────────────────────────────────────────────

    /**
     * Pick the EMPTY slot a new value is staged in. With an identity: the non-live slot — emptied first
     * only if a read in this operation proves what it holds is disposable (a copy of the live wallet,
     * the replaced wallet it was retired for, or the very bytes being written); anything else is kept
     * and the write refuses. Without an identity: an already-empty slot only.
     */
    private async stagingSlot(native: NativeSeedStore, before: SeedIdentity | null, incoming: string, prompt: string): Promise<SeedSlot> {
        if (before) {
            const other = otherSlot(before.slot);
            if (!(await native.hasItemAsync(SLOT_ITEM[other]))) return other;
            const evms = before.retireSlot ? [before.evm, before.retireSlot] : [before.evm];
            const outcome = await this.deleteProven(native, other, { evms, bytes: [incoming] }, prompt);
            if (outcome === 'kept') throw new SeedActionKeyUpgradeDeferredError();
            return other;
        }
        for (const slot of SLOTS) {
            if (!(await native.hasItemAsync(SLOT_ITEM[slot]))) return slot;
        }
        throw new MultipleUnidentifiedWalletsError();
    }

    /**
     * Write `value` into the EMPTY `slot` and prove it: read back byte-for-byte equal AND deriving
     * `address`. Touches ONLY `slot`. On failure this operation's own write is removed and
     * SeedWriteVerificationError is thrown.
     */
    private async stage(native: NativeSeedStore, slot: SeedSlot, value: string, address: string, prompt: string): Promise<void> {
        const item = SLOT_ITEM[slot];
        try {
            await native.setItemAsync(item, value, prompt, this.op.actionId);
        } catch (err) {
            throw new SeedWriteVerificationError(nativeErrorCode(err) ?? 'write failed');
        }
        this.op.ownWrites.add(slot);
        this.op.reads.delete(slot);
        let failure: string | null = null;
        try {
            const readBack = await native.getItemAsync(item, prompt, this.op.actionId);
            if (readBack !== value) failure = 'read-back mismatch';
            else if (!(await this.derivesTo(readBack, address))) failure = 'read-back derives another wallet';
        } catch (err) {
            failure = nativeErrorCode(err) ?? 'read-back failed';
        }
        if (failure !== null) {
            await this.deleteOwnWrite(native, slot).catch(() => undefined);
            throw new SeedWriteVerificationError(failure);
        }
    }

    /**
     * Pending retirements of a COMMITTED identity whose live slot was verified in this operation.
     * Each is a deleteProven against the wallet it was recorded for: an item that does not read back
     * as that wallet is kept (and never retried as a retirement). A transient read keeps the flag.
     * The rebuilt record carries every other field unchanged.
     */
    private async finishRetirements(native: NativeSeedStore, identity: SeedIdentity, prompt: string): Promise<void> {
        if (!identity.retireSlot && !identity.retireLegacy) return;
        const next: SeedIdentity = { ...identity };
        let changed = false;
        if (identity.retireSlot) {
            const slot = otherSlot(identity.slot);
            try {
                const outcome = await this.deleteProven(native, slot, { evms: [identity.retireSlot], bytes: [] }, prompt);
                const seen = this.op.reads.get(slot);
                if (outcome === 'kept' && seen?.kind === 'unreadable' && seen.nativeCause === 'key_missing') {
                    // The Keystore said "no key" — possibly a transient lookup failure (no prompt was
                    // shown). The item is kept AND stays pending: a later read retires it once it
                    // reads back as the replaced wallet.
                    this.log('slot retirement deferred: its key lookup failed');
                } else {
                    delete next.retireSlot;
                    changed = true;
                }
            } catch {
                this.log('slot retirement deferred');
            }
        }
        if (identity.retireLegacy) {
            try {
                await this.deleteProven(native, 'legacy', { evms: [identity.retireLegacy], bytes: [] }, prompt);
                delete next.retireLegacy;
                changed = true;
            } catch {
                this.log('legacy retirement deferred');
            }
        }
        if (!changed) return;
        try {
            await this.commit(next);
        } catch {
            this.log('seed retirement bookkeeping deferred');
        }
    }

    /**
     * Stage `value`, commit it, then retire. Returns the committed identity.
     * `retireSlot` / `retireLegacy`: the wallet (EVM address) the previous live slot / the legacy item
     * must still read back as for it to be deleted after the commit.
     */
    private async storeVerified(
        native: NativeSeedStore,
        value: string,
        addresses: PublicAddresses,
        before: SeedIdentity | null,
        opts: { retireSlot?: string; retireLegacy?: string; prompt: string },
    ): Promise<SeedIdentity> {
        const slot = await this.stagingSlot(native, before, value, opts.prompt);
        await this.stage(native, slot, value, addresses.evm, opts.prompt);
        const committed: SeedIdentity = { v: 1, slot, evm: addresses.evm, sol: addresses.sol };
        if (before && opts.retireSlot) committed.retireSlot = opts.retireSlot;
        if (opts.retireLegacy) committed.retireLegacy = opts.retireLegacy;
        try {
            await this.commit(committed);
        } catch (err) {
            // Not committed: the staged value is this operation's own, unnamed write — remove it. If
            // the record did land despite the error, the staged slot IS live now and must stay.
            const landed = await this.loadIdentity().catch(() => undefined);
            if (landed === undefined) throw err;
            if (!landed || landed.slot !== slot) {
                await this.deleteOwnWrite(native, slot).catch(() => undefined);
                throw err;
            }
        }
        this.op.ownWrites.delete(slot);
        this.op.reads.set(slot, { kind: 'value', value });
        this.proven.add(digest(`${committed.evm.toLowerCase()}|${value}`));
        await this.clearUnreadable();
        await this.syncLegacyCache(committed);
        await this.finishRetirements(native, committed, opts.prompt);
        return committed;
    }

    // ── reads ──────────────────────────────────────────────────────────────────────────────────

    private async readUnlocked(prompt: string): Promise<string | null> {
        const native = this.deps.native();
        if (!native) return this.readWithoutNative(prompt);
        const identity = await this.loadIdentity();
        return identity ? this.readWithIdentity(native, identity, prompt) : this.readWithoutIdentity(native, prompt);
    }

    /** Build without the native store (Expo Go / tests): the F14 item, identity-checked. */
    private async readWithoutNative(prompt: string): Promise<string | null> {
        const expected = (await this.loadIdentity()) ?? (await this.legacyCache());
        const legacy = await this.readItem(null, 'legacy', prompt);
        if (legacy.kind === 'transient') throw legacy.error;
        if (legacy.kind === 'value' && (expected ? await this.derivesTo(legacy.value, expected.evm) : validateMnemonic(legacy.value, wordlist))) {
            await this.clearUnreadable();
            return legacy.value;
        }
        if (expected || legacy.kind !== 'absent') {
            await this.markUnreadable();
            throw new SeedUnreadableError();
        }
        return null;
    }

    private async readWithIdentity(native: NativeSeedStore, identity: SeedIdentity, prompt: string): Promise<string> {
        const live = await this.readItem(native, identity.slot, prompt);
        if (live.kind === 'transient') throw live.error;
        if (live.kind === 'value' && (await this.derivesTo(live.value, identity.evm))) {
            await this.clearUnreadable();
            await this.syncLegacyCache(identity);
            await this.finishRetirements(native, identity, prompt);
            return live.value;
        }
        this.log(`live seed slot ${live.kind === 'value' ? 'holds another wallet' : live.kind}; checking the other stored copies`);

        // The other slot: use it only if it IS this wallet (the read is its read-back proof).
        const other = otherSlot(identity.slot);
        const alt = await this.readItem(native, other, prompt);
        if (alt.kind === 'transient') throw alt.error;
        if (alt.kind === 'value' && (await this.derivesTo(alt.value, identity.evm))) {
            // Re-point the identity. The failed slot is NOT retired — it is only ever emptied by a
            // later operation that reads it and proves it disposable.
            const repointed: SeedIdentity = { ...identity, slot: other };
            delete repointed.retireSlot;
            await this.commit(repointed);
            await this.clearUnreadable();
            await this.syncLegacyCache(repointed);
            return alt.value;
        }

        const legacy = await this.readItem(native, 'legacy', prompt);
        if (legacy.kind === 'transient') throw legacy.error;
        if (legacy.kind === 'value' && (await this.derivesTo(legacy.value, identity.evm))) {
            try {
                // Read and matched in this operation: the legacy item may be retired once re-copied.
                await this.storeVerified(native, legacy.value, identity, identity, { retireLegacy: identity.evm, prompt });
            } catch (err) {
                this.log(`re-copy of the legacy seed deferred: ${err instanceof Error ? err.message : String(err)}`);
            }
            await this.clearUnreadable();
            return legacy.value;
        }

        await this.markUnreadable();
        throw new SeedUnreadableError();
    }

    /**
     * No identity yet: an F14 wallet that has not moved, or a device whose bookkeeping was lost.
     * With the F14 cache, only the item deriving the cached wallet is used. Without it, a stored phrase
     * is adopted ONLY when it is the sole wallet stored AND no other item is present-but-unread
     * (an unreadable, undecodable or auth-failed item could be a different, real wallet).
     */
    private async readWithoutIdentity(native: NativeSeedStore, prompt: string): Promise<string | null> {
        const expected = await this.legacyCache();
        let sawUnreadable = false;
        const unnamed: Array<{ source: SeedItem; value: string }> = [];

        for (const item of ['legacy', ...SLOTS] as const) {
            const r = await this.readItem(native, item, prompt);
            if (r.kind === 'transient') throw r.error;
            if (r.kind === 'unreadable') sawUnreadable = true;
            if (r.kind !== 'value') continue;
            if (expected && (await this.derivesTo(r.value, expected.evm))) {
                return item === 'legacy' ? this.adoptLegacy(native, r.value, prompt) : this.adoptSlot(item, r.value);
            }
            if (!expected && validateMnemonic(r.value, wordlist)) {
                unnamed.push({ source: item, value: r.value });
            } else {
                sawUnreadable = true;
            }
        }

        if (unnamed.length > 0) {
            const wallets = new Set<string>();
            for (const found of unnamed) wallets.add((await this.deps.deriveEvmAddress(found.value)).toLowerCase());
            if (wallets.size > 1) {
                this.log('several different unnamed wallet phrases are stored; none is auto-picked, none deleted');
                throw new MultipleUnidentifiedWalletsError();
            }
            if (sawUnreadable) {
                this.log('an unnamed phrase sits beside an item that could not be read; not adopted');
                throw new UnidentifiedStoredKeyError();
            }
            const first = unnamed[0];
            return first.source === 'legacy' ? this.adoptLegacy(native, first.value, prompt) : this.adoptSlot(first.source, first.value);
        }

        if (expected || sawUnreadable) {
            await this.markUnreadable();
            throw new SeedUnreadableError();
        }
        return null;
    }

    /** The legacy item IS the wallet (read and matched in this operation): carry it over; serve it even if that defers. */
    private async adoptLegacy(native: NativeSeedStore, value: string, prompt: string): Promise<string> {
        try {
            const addresses = await this.addressesOf(value);
            await this.storeVerified(native, value, addresses, null, { retireLegacy: addresses.evm, prompt });
        } catch (err) {
            this.log(`seed storage migration deferred: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.clearUnreadable();
        return value;
    }

    /** A slot written before its identity was committed: this read is its read-back proof. */
    private async adoptSlot(slot: SeedSlot, value: string): Promise<string> {
        const addresses = await this.addressesOf(value);
        const adopted: SeedIdentity = { v: 1, slot, evm: addresses.evm, sol: addresses.sol };
        await this.commit(adopted);
        this.proven.add(digest(`${adopted.evm.toLowerCase()}|${value}`));
        await this.clearUnreadable();
        await this.syncLegacyCache(adopted);
        return value;
    }

    /**
     * Read the seed (caller must already hold a biometric session — the OS prompts again for the
     * keychain/Keystore ACL). Returns only a value deriving this wallet's address; null only when the
     * device has no wallet at all; SeedUnreadableError when the wallet is known but no copy reads.
     */
    read(prompt: string = seedUnlockPrompt(), actionId?: string | null): Promise<string | null> {
        return this.exclusive(() => this.readUnlocked(prompt), actionId);
    }

    /**
     * The wallet's public addresses without touching the seed: the identity, else the F14 cache.
     * Everything that shows or uses an address reads it here, so it always names the stored seed.
     */
    async publicAddresses(): Promise<PublicAddresses | null> {
        // Not queued behind a pending prompt: the identity is one atomic record.
        const identity = await this.loadIdentity();
        if (identity) return { evm: identity.evm, sol: identity.sol };
        return this.legacyCache();
    }

    /**
     * Unlock-time check. Moves an unmigrated wallet to the native store (no user step beyond the OS
     * prompts). For a migrated wallet it asks the native store — WITHOUT a prompt — whether the live
     * slot still exists and (Android) whether its key was permanently invalidated; anything short of
     * "present" falls through to a real, prompting read, so an unreadable seed is detected here and
     * the caller routes to restore. Never throws.
     */
    migrateIfNeeded(prompt: string = seedUnlockPrompt(), actionId?: string | null): Promise<MigrationOutcome> {
        return this.exclusive(async () => {
            const native = this.deps.native();
            if (!native) return 'no_native_store';
            const identity = await this.loadIdentity();
            if (identity && (await this.deps.kv.getItem(SEED_STATE_KEYS.UNREADABLE)) !== '1') {
                let probe: SecureSeedProbe = 'unknown';
                try {
                    probe = await native.probeItemAsync(SLOT_ITEM[identity.slot]);
                } catch {
                    probe = 'unknown';
                }
                if (probe === 'present') return 'already_migrated';
                this.log(`live seed slot probe: ${probe}; verifying with a real read`);
            }
            try {
                const value = await this.readUnlocked(prompt);
                if (value === null) return 'no_wallet';
                if (identity) return 'already_migrated';
                return (await this.loadIdentity()) ? 'migrated' : 'deferred';
            } catch (err) {
                if (err instanceof SeedUnreadableError) return 'unreadable';
                this.log(`seed check deferred: ${err instanceof Error ? err.message : String(err)}`);
                return 'deferred';
            }
        }, actionId);
    }

    /**
     * Before creating a NEW wallet. 'none' ONLY when no seed item of any kind exists (no identity, no
     * F14 cache, no native slot item, no legacy item): generate. 'adopted' when exactly one wallet is
     * stored and nothing else sits unread beside it: it is now the committed wallet — continue with it.
     * Everything else THROWS an "already exists" error for the conflict panel (Restore, or the explicit
     * biometric + destructive-confirm "Delete and retry"): a known wallet that cannot be read
     * (SeedUnreadableError → caller), several different wallets, or any item that could not be read
     * or identified — including an F14 item answering errSecAuthFailed, which a Face ID lockout also
     * produces. Nothing is ever generated or adopted beside an unread item. A dismissed prompt rejects.
     */
    prepareForNewWallet(prompt: string = seedUnlockPrompt(), actionId?: string | null): Promise<'none' | 'adopted'> {
        return this.exclusive(async () => {
            const native = this.deps.native();
            const known = (await this.loadIdentity()) !== null || (await this.legacyCache()) !== null;
            const slotItem = native !== null && ((await native.hasItemAsync(SEED_ITEMS.SLOT_A)) || (await native.hasItemAsync(SEED_ITEMS.SLOT_B)));
            const legacy = await this.readItem(native, 'legacy', prompt);
            if (legacy.kind === 'transient') throw legacy.error;
            if (!known && !slotItem && legacy.kind === 'absent') return 'none';
            try {
                if ((await this.readUnlocked(prompt)) === null) {
                    // Nothing usable, yet something was reported present a moment ago: never generate.
                    throw new UnidentifiedStoredKeyError();
                }
                return 'adopted';
            } catch (err) {
                if (err instanceof SeedUnreadableError && !known) throw new UnidentifiedStoredKeyError();
                throw err;
            }
        }, actionId);
    }

    /**
     * An ACTUAL read of the stored seed, classified. 'unreadable' is definitive (no copy derives the
     * wallet); transient failures (a dismissed prompt) reject. The value itself is never returned.
     */
    verifyReadable(prompt: string = seedUnlockPrompt(), actionId?: string | null): Promise<'readable' | 'unreadable' | 'no_wallet'> {
        return this.exclusive(async () => {
            try {
                return (await this.readUnlocked(prompt)) === null ? 'no_wallet' : 'readable';
            } catch (err) {
                if (err instanceof SeedUnreadableError) return 'unreadable';
                throw err;
            }
        }, actionId);
    }

    /**
     * Store a NEW seed (generate) or a user-confirmed import / same-wallet repair. It is staged in an
     * empty slot, read back and verified, and only then committed; the previous seed is retired after
     * the commit, and only once a read proves it is the wallet being replaced. A failure before the
     * commit leaves the previous seed live and untouched.
     *
     * `fresh`: no wallet may exist (generate / first import) — refused if an identity or cache exists.
     */
    /** Android only: move an independently protected old seed through the same verified staging protocol. */
    async needsActionKeyUpgrade(actionId: string | null): Promise<boolean> {
        const native = this.deps.native();
        if (!actionId || !native?.isActionKeyAsync) return false;
        const identity = await this.loadIdentity();
        if (!identity) return false;
        return !(await native.isActionKeyAsync(SLOT_ITEM[identity.slot], actionId));
    }

    write(mnemonic: string, opts: { fresh: boolean; prompt?: string; actionId?: string | null }): Promise<void> {
        return this.exclusive(async () => {
            const prompt = opts.prompt ?? seedUnlockPrompt();
            const native = this.deps.native();
            const addresses = await this.addressesOf(mnemonic);
            if (!native) {
                // Build without the native store (Expo Go / tests): previous F14 behaviour.
                await this.deps.legacy.setItemAsync(SEED_ITEMS.LEGACY, mnemonic, LEGACY_WRITE_OPTIONS);
                await this.deps.kv.setItem(this.deps.publicCacheKeys.evm, addresses.evm);
                await this.deps.kv.setItem(this.deps.publicCacheKeys.sol, addresses.sol);
                return;
            }
            const before = await this.loadIdentity();
            const cached = await this.legacyCache();
            if (opts.fresh && (before || cached)) {
                throw new Error('Wallet already exists: a seed is already stored on this device.');
            }
            if (!before && (await native.hasItemAsync(SEED_ITEMS.SLOT_A)) && (await native.hasItemAsync(SEED_ITEMS.SLOT_B))) {
                // Two unnamed items and no free slot: adopt the one that IS this wallet (the user is
                // restoring it), keep the other; otherwise refuse without touching either.
                for (const slot of SLOTS) {
                    const r = await this.readItem(native, slot, prompt);
                    if (r.kind === 'transient') throw r.error;
                    if (r.kind === 'value' && (await this.derivesTo(r.value, addresses.evm))) {
                        await this.adoptSlot(slot, r.value);
                        return;
                    }
                }
                throw new MultipleUnidentifiedWalletsError();
            }
            // The legacy item is retired ONLY if it is read in this operation and derives the KNOWN
            // wallet the user confirmed replacing (or is the wallet being written). An unread,
            // unreadable, auth-failed or unidentified legacy item is kept.
            let retireLegacy: string | undefined;
            if (!opts.fresh) {
                const replacing = before?.evm ?? cached?.evm ?? null;
                const legacy = await this.readItem(native, 'legacy', prompt);
                if (legacy.kind === 'value') {
                    if (replacing && (await this.derivesTo(legacy.value, replacing))) retireLegacy = replacing;
                    else if (await this.derivesTo(legacy.value, addresses.evm)) retireLegacy = addresses.evm;
                }
            }
            await this.storeVerified(native, mnemonic, addresses, before, {
                retireSlot: before?.evm,
                retireLegacy,
                prompt,
            });
        }, opts.actionId);
    }

    /**
     * Does this device hold a seed? Never prompts for a migrated/new wallet (bookkeeping + no-UI
     * existence probes); falls back to a legacy read only when neither exists. That read answers
     * false ONLY for a clean "no item"; an unreadable / auth-failed item, or any other error, is
     * "exists" (so Restore proceeds past its overwrite gate); only a dismissed prompt rejects.
     */
    exists(): Promise<boolean> {
        return this.exclusive(async () => {
            if (await this.loadIdentity()) return true;
            const native = this.deps.native();
            if (native && ((await native.hasItemAsync(SEED_ITEMS.SLOT_A)) || (await native.hasItemAsync(SEED_ITEMS.SLOT_B)))) return true;
            // An existence check: anything but a clean "no item" means a wallet may be stored (an
            // auth-failed / unreadable F14 item after a reinstall IS a wallet — Restore must see it).
            // Only a dismissed prompt defers.
            if (native?.hasLegacyItemAsync) return native.hasLegacyItemAsync(SEED_ITEMS.LEGACY);
            const legacy = await this.readItem(native, 'legacy', seedUnlockPrompt());
            if (legacy.kind === 'absent') return false;
            if (legacy.kind === 'transient' && isCancellation(legacy.error)) throw legacy.error;
            return true;
        });
    }

    async isMarkedUnreadable(): Promise<boolean> {
        return (await this.deps.kv.getItem(SEED_STATE_KEYS.UNREADABLE)) === '1';
    }

    /** Wallet wipe — the explicit, user-confirmed destruction; the one delete outside deleteProven. */
    clear(): Promise<void> {
        return this.exclusive(async () => {
            const native = this.deps.native();
            if (native) {
                for (const slot of SLOTS) await this.rawDelete(native, slot).catch(() => undefined);
            }
            await this.rawDelete(native, 'legacy').catch(() => undefined);
            for (const key of Object.values(SEED_STATE_KEYS)) {
                await this.deps.kv.removeItem(key).catch(() => undefined);
            }
            this.proven.clear();
        });
    }
}

// =============================================================================
// Auth-gated derived secrets (PECloudSync archive-key cache) — same move, same proof.
// These are CACHES of values re-derivable from the seed, so replacing one (delete, then add — the
// native store never overwrites in place) cannot lose anything.
// =============================================================================

export interface GatedSecretDeps {
    native: () => NativeSeedStore | null;
    legacy: LegacySeedStore;
    log?: (message: string) => void;
}

/**
 * Read an auth-gated secret, preferring the native item and migrating a legacy expo-secure-store
 * copy to it (write → read back → equal → only then delete the legacy copy). `accept` decides
 * whether a value is still usable (e.g. its salt matches). Legacy read errors (an item invalidated
 * by re-enrollment, a cancelled prompt) are a cache miss, never a deletion.
 */
export async function readGatedSecret(
    deps: GatedSecretDeps,
    keys: { legacy: string; current: string },
    prompt: string,
    accept: (value: string) => boolean,
): Promise<string | null> {
    const native = deps.native();
    let currentPresent = false;
    if (native) {
        try {
            const current = await native.getItemAsync(keys.current, prompt);
            currentPresent = current !== null;
            if (current !== null && accept(current)) return current;
        } catch (err) {
            if (nativeErrorCode(err) !== 'ERR_SEED_UNRECOVERABLE') throw err;
            currentPresent = true;
        }
    }
    let legacyValue: string | null;
    try {
        legacyValue = await deps.legacy.getItemAsync(keys.legacy, { authenticationPrompt: prompt });
    } catch {
        return null;
    }
    if (legacyValue === null || !accept(legacyValue)) return null;
    if (native) {
        try {
            // The native copy is absent, unusable or unrecoverable — a stale cache entry.
            if (currentPresent) await native.deleteItemAsync(keys.current);
            await native.setItemAsync(keys.current, legacyValue, prompt);
            const readBack = await native.getItemAsync(keys.current, prompt);
            if (readBack === legacyValue) {
                await deps.legacy.deleteItemAsync(keys.legacy);
            } else {
                deps.log?.(`${keys.current}: read-back mismatch; legacy copy retained`);
            }
        } catch (err) {
            deps.log?.(`${keys.current}: migration deferred (${nativeErrorCode(err) ?? 'error'})`);
        }
    }
    return legacyValue;
}

/** Write an auth-gated secret CACHE to the native store (legacy F14 options when the build lacks it). */
export async function writeGatedSecret(deps: GatedSecretDeps, keys: { legacy: string; current: string }, value: string, prompt: string): Promise<void> {
    const native = deps.native();
    if (native) {
        // A re-derivable cache: replace it (the native store never overwrites in place).
        await native.deleteItemAsync(keys.current);
        await native.setItemAsync(keys.current, value, prompt);
        return;
    }
    await deps.legacy.setItemAsync(keys.legacy, value, LEGACY_WRITE_OPTIONS);
}

/** Default wiring used by the app. */
export function defaultGatedSecretDeps(log?: (message: string) => void): GatedSecretDeps {
    return { native: loadNativeSeedStore, legacy: SecureStore, log };
}

export const defaultKeyValueStore: KeyValueStore = AsyncStorage;
