/**
 * Pending thread drafts — a message written to someone who has no message key yet
 * is KEPT, and sent automatically once their key appears.
 *
 * The person approved the send (Face ID) when they tapped Send; the draft carries what that approval
 * produced — the plaintext and their own PUBLIC message key — so sending it later needs only public
 * keys and the wallet's stored relay credentials. Nothing here reads seed material or prompts: a send
 * that cannot complete without a prompt (an auth refresh, a speech window) stays pending and is sent
 * from the thread with the ordinary Send flow.
 *
 * Stored ENCRYPTED in AsyncStorage (XChaCha20-Poly1305 under a per-install key kept in the Keychain,
 * this device only, readable only while unlocked): the text is end-to-end message content and never
 * sits in plain storage or a device backup. One blob, per wallet (`myId`); a draft only ever sends as
 * the wallet that wrote it. The wallet's seed change clears it (SeedManager.invalidateDerivedCaches).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import * as CommonsService from './CommonsService';
import { sealThreadMessage } from './threadCrypto';
import { signedThreadPlaintext } from './commonsOutputSigning';

export const PENDING_THREAD_DRAFTS_KEY = 'provian_commons_pending_thread_drafts_v1';
/** The Keychain item holding the drafts' encryption key. */
export const PENDING_THREAD_DRAFTS_KEYCHAIN = 'provian_commons_draft_key_v1';

export interface PendingThreadDraft {
    readonly id: string;
    /** The writer's Commons party id; the draft sends only as this wallet. */
    readonly myId: string;
    /** The writer's own published message key (public), so the sealed copy stays readable to them. */
    readonly myPubkey: string;
    readonly counterparty: string;
    /** The existing thread, or null to open one with the first message. */
    readonly threadId: string | null;
    /** What a new thread is anchored to (a want the person answered); absent → the counterparty's profile. */
    readonly anchor?: { readonly kind: CommonsService.ThreadAnchorKind; readonly id: string };
    readonly text: string;
    readonly createdAt: number;
    /** Set when an automatic send failed for a reason other than the missing key. */
    readonly failedAt?: number;
    /**
     * The failure left it unknown whether the relay took the message (no HTTP answer): never retried
     * automatically — the person sees the thread and decides — so nothing is sent twice.
     */
    readonly uncertain?: boolean;
    /** Set while a sender holds the draft (DRAFT_CLAIM_LEASE_MS); nobody else sends it meanwhile. */
    readonly claimedAt?: number;
}

export interface SentDraft {
    readonly draft: PendingThreadDraft;
    readonly threadId: string;
    readonly message: CommonsService.ThreadMessage;
}

/**
 * The drafts key. Throws when the Keychain cannot be read right now (a locked phone): the caller must
 * not treat that as "no drafts". Null when there is no key (nothing was ever stored, or this is a new
 * device a backup was restored to) — then any stored blob is permanently unreadable.
 */
async function draftKey(create: boolean): Promise<Uint8Array | null> {
    const existing = await SecureStore.getItemAsync(PENDING_THREAD_DRAFTS_KEYCHAIN);
    if (existing) return hexToBytes(existing);
    if (!create) return null;
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    await SecureStore.setItemAsync(PENDING_THREAD_DRAFTS_KEYCHAIN, bytesToHex(fresh), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    return fresh;
}

/**
 * Every stored draft. Throws when storage cannot be read RIGHT NOW (the Keychain is locked), so a write
 * never replaces drafts it could not see. A blob that can never be read again (no key on this device,
 * or corrupt) is empty.
 */
async function readStrict(): Promise<PendingThreadDraft[]> {
    const raw = await AsyncStorage.getItem(PENDING_THREAD_DRAFTS_KEY);
    if (!raw) return [];
    const key = await draftKey(false); // throws while locked
    try {
        const blob = JSON.parse(raw) as { v?: number; n?: string; c?: string };
        if (blob.v !== 1 || !blob.n || !blob.c || !key) return [];
        const parsed = JSON.parse(new TextDecoder().decode(xchacha20poly1305(key, hexToBytes(blob.n)).decrypt(hexToBytes(blob.c))));
        return Array.isArray(parsed) ? parsed.filter((d) => d && typeof d.id === 'string' && typeof d.text === 'string') : [];
    } catch {
        return [];
    }
}

/** For display: what can be read now ([] while locked). */
async function readAll(): Promise<PendingThreadDraft[]> {
    try { return await readStrict(); } catch { return []; }
}

async function writeAll(drafts: PendingThreadDraft[]): Promise<void> {
    if (drafts.length === 0) { await AsyncStorage.removeItem(PENDING_THREAD_DRAFTS_KEY); return; }
    const key = await draftKey(true);
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);
    const c = xchacha20poly1305(key!, nonce).encrypt(utf8ToBytes(JSON.stringify(drafts)));
    await AsyncStorage.setItem(PENDING_THREAD_DRAFTS_KEY, JSON.stringify({ v: 1, n: bytesToHex(nonce), c: bytesToHex(c) }));
}

/** Read-modify-write, serialized in this process. Throws (writing nothing) when the store cannot be read now. */
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (all: PendingThreadDraft[]) => { next: PendingThreadDraft[] | null; result: T }): Promise<T> {
    const run = chain.then(async () => {
        const { next, result } = fn(await readStrict());
        if (next) await writeAll(next);
        return result;
    });
    chain = run.catch(() => undefined);
    return run;
}

const listeners = new Set<(sent?: SentDraft) => void>();
/**
 * Called whenever the pending set changes (saved, sent, failed, released); a send passes what was sent,
 * whichever caller sent it. Returns the unsubscribe.
 */
export function onPendingDraftsChanged(fn: (sent?: SentDraft) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
function notify(sent?: SentDraft): void { for (const fn of [...listeners]) { try { fn(sent); } catch { /* a listener never breaks the store */ } } }

export async function savePendingDraft(input: Omit<PendingThreadDraft, 'id' | 'createdAt'>, nowMs: number = Date.now()): Promise<PendingThreadDraft> {
    const draft: PendingThreadDraft = { ...input, id: `draft_${nowMs}_${Math.random().toString(36).slice(2, 10)}`, createdAt: nowMs };
    await mutate((all) => ({ next: [...all, draft], result: undefined }));
    notify();
    return draft;
}

/**
 * How long a claim holds a draft. A claim that LAPSES means its sender died or could not record the
 * outcome — possibly after the request reached the relay — so a lapsed draft is uncertain: shown with
 * "Send now", never sent again automatically.
 */
export const DRAFT_CLAIM_LEASE_MS = 10 * 60 * 1000;
const claimed = (d: PendingThreadDraft, now: number) => typeof d.claimedAt === 'number' && now - d.claimedAt < DRAFT_CLAIM_LEASE_MS;

/** The draft may already have been sent (an unanswered send, or a claim that lapsed): the person decides. */
export function draftIsUncertain(d: PendingThreadDraft, nowMs: number = Date.now()): boolean {
    return d.uncertain === true || (typeof d.claimedAt === 'number' && !claimed(d, nowMs));
}

/**
 * Claim a draft to send it — "Send now" and the automatic flush both do, so only one of them ever
 * sends it. The draft stays stored (a crash loses nothing; the claim lapses). Null when it is gone or
 * already claimed.
 */
export async function claimPendingDraft(id: string, nowMs: number = Date.now()): Promise<PendingThreadDraft | null> {
    return mutate((all) => {
        const d = all.find((x) => x.id === id);
        if (!d || claimed(d, nowMs)) return { next: null, result: null };
        const taken = { ...d, claimedAt: nowMs };
        return { next: all.map((x) => (x.id === id ? taken : x)), result: taken };
    }).catch(() => null);
}

/**
 * After a claimed send did not go out, release the draft: `not_sent` (nothing reached the relay — it
 * keeps waiting as it was), `refused` (the relay answered 4xx — retried after FAILED_DRAFT_RETRY_MS) or
 * `uncertain` (no answer after the request left — never resent automatically).
 */
export async function releasePendingDraft(id: string, outcome: 'not_sent' | 'refused' | 'uncertain', nowMs: number = Date.now()): Promise<void> {
    await mutate((all) => ({
        next: all.map((d) => {
            if (d.id !== id) return d;
            const { claimedAt: _c, ...rest } = d;
            return outcome === 'not_sent' ? rest : { ...rest, failedAt: nowMs, ...(outcome === 'uncertain' ? { uncertain: true } : { uncertain: undefined }) };
        }),
        result: undefined,
    })).catch(() => undefined);
    notify();
}

/** A send's failure, classified for release: a 4xx is a refusal; anything after the request left is uncertain. */
export function sendFailureOutcome(err: unknown, requested: boolean): 'refused' | 'uncertain' {
    if (err instanceof CommonsService.CommonsError && err.status >= 400 && err.status < 500) return 'refused';
    return requested ? 'uncertain' : 'refused';
}

/** This wallet's drafts to `counterparty`, oldest first. */
export async function pendingDraftsFor(myId: string, counterparty: string): Promise<PendingThreadDraft[]> {
    return (await readAll()).filter((d) => d.myId === myId && d.counterparty === counterparty).sort((a, b) => a.createdAt - b.createdAt);
}

/** This wallet's kept answers to wants, by want id (the wants board shows them). */
export async function pendingWantDrafts(myId: string): Promise<Map<string, PendingThreadDraft>> {
    const out = new Map<string, PendingThreadDraft>();
    for (const d of await readAll()) if (d.myId === myId && d.anchor?.kind === 'want') out.set(d.anchor.id, d);
    return out;
}

/** The draft went out: remove it and announce what was sent. */
export async function removePendingDraft(id: string, sent?: SentDraft): Promise<void> {
    await mutate((all) => ({ next: all.filter((d) => d.id !== id), result: undefined })).catch(() => undefined);
    notify(sent);
}

export interface FlushDeps {
    readMessageKey: typeof CommonsService.readMessageKey;
    openThread: typeof CommonsService.openThread;
    sendThreadMessage: typeof CommonsService.sendThreadMessage;
    sign: (text: string) => Promise<string>;
}
const defaultDeps = (): FlushDeps => ({
    readMessageKey: CommonsService.readMessageKey,
    openThread: CommonsService.openThread,
    sendThreadMessage: CommonsService.sendThreadMessage,
    sign: signedThreadPlaintext,
});

let flushing: Promise<SentDraft[]> | null = null;

/** After a refused automatic send, wait this long before trying it again. */
export const FAILED_DRAFT_RETRY_MS = 5 * 60 * 1000;

/**
 * Send every draft of `myId` whose counterparty now has a message key. Single-flight; never prompts,
 * never throws. Each draft is claimed before it is sent (so "Send now" cannot send it too). A draft
 * whose recipient still has no key stays pending untouched; a refused send is retried after the
 * backoff; an uncertain one is never resent automatically (the thread offers Send now).
 */
export function flushPendingThreadDrafts(myId: string | null, deps: FlushDeps = defaultDeps(), nowMs: () => number = Date.now): Promise<SentDraft[]> {
    if (!myId) return Promise.resolve([]);
    if (flushing) return flushing;
    flushing = (async () => {
        const sent: SentDraft[] = [];
        try {
            const mine = (await readStrict())
                .filter((d) => d.myId === myId && !d.uncertain && d.claimedAt === undefined && (!d.failedAt || nowMs() - d.failedAt >= FAILED_DRAFT_RETRY_MS))
                .sort((a, b) => a.createdAt - b.createdAt);
            const keyOf = new Map<string, string | null>();
            const threadOf = new Map<string, string>();
            for (const pending of mine) {
                let theirs = keyOf.get(pending.counterparty);
                if (theirs === undefined) {
                    theirs = await deps.readMessageKey(pending.counterparty).then((k) => k?.pubkey_b64u ?? null, () => null);
                    keyOf.set(pending.counterparty, theirs);
                }
                if (!theirs) continue;
                const draft = await claimPendingDraft(pending.id, nowMs());
                if (!draft) continue; // sent or being sent by hand
                let requested = false;
                try {
                    const sealed = sealThreadMessage(await deps.sign(draft.text), { [draft.myId]: draft.myPubkey, [draft.counterparty]: theirs });
                    const message = { kind: 'text' as const, ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 };
                    // Drafts to the same person keep their order and land in one thread.
                    const threadId = draft.threadId ?? (draft.anchor ? null : threadOf.get(draft.counterparty) ?? null);
                    let result: SentDraft;
                    requested = true;
                    if (threadId) {
                        const r = await deps.sendThreadMessage(threadId, message);
                        result = { draft, threadId, message: r.message };
                    } else {
                        const r = await deps.openThread({ anchor: draft.anchor ?? { kind: 'profile', id: draft.counterparty }, counterparty: draft.counterparty, message });
                        result = { draft, threadId: r.thread.thread_id, message: r.message };
                    }
                    if (!draft.anchor) threadOf.set(draft.counterparty, result.threadId);
                    await removePendingDraft(draft.id, result);
                    sent.push(result);
                } catch (err) {
                    await releasePendingDraft(draft.id, sendFailureOutcome(err, requested), nowMs());
                }
            }
        } catch {
            /* storage unreadable right now (a locked phone): nothing sent, nothing lost */
        } finally {
            flushing = null;
        }
        return sent;
    })();
    return flushing;
}

/** Copy for "they have no message key": the person's own linked agent, or anyone else. */
export function keyMissingCopyKeys(isOwnAgent: boolean): { title: string; body: string } {
    return isOwnAgent
        ? { title: 'commons.threadKeyMissingTitle', body: 'commons.threadKeyMissingOwnAgent' }
        : { title: 'commons.threadKeyMissingTitle', body: 'commons.threadKeyMissingOther' };
}
