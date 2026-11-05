/**
 * Pending thread drafts : a message to someone with no message key is kept and
 * sends itself once their key appears — never prompting, only as the wallet that wrote it, in order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { x25519 } from '@noble/curves/ed25519';

const store = new Map<string, string>();
const keychain = new Map<string, string>();
let keychainLocked = false;
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (k: string) => { if (keychainLocked) throw new Error('User interaction is not allowed.'); return keychain.get(k) ?? null; },
  setItemAsync: async (k: string, v: string) => { if (keychainLocked) throw new Error('locked'); keychain.set(k, v); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  },
}));

import {
  FAILED_DRAFT_RETRY_MS, flushPendingThreadDrafts, keyMissingCopyKeys, onPendingDraftsChanged, PENDING_THREAD_DRAFTS_KEY,
  pendingDraftsFor, savePendingDraft, type FlushDeps,
} from './pendingThreadDrafts';
import { openThreadMessage } from './threadCrypto';
import { CommonsError } from './CommonsService';
import { claimPendingDraft, draftIsUncertain, DRAFT_CLAIM_LEASE_MS, pendingWantDrafts, releasePendingDraft, removePendingDraft } from './pendingThreadDrafts';

const pub = (sk: Uint8Array) => Buffer.from(x25519.getPublicKey(sk)).toString('base64url');
const frankSk = x25519.utils.randomPrivateKey();
const atlasSk = x25519.utils.randomPrivateKey();
const FRANK = 'user_frank';
const ATLAS = 'wallet_aw_atlas';

function deps(over: Partial<FlushDeps> & { atlasKey?: string | null } = {}) {
  const sent: Array<{ threadId: string | null; anchor?: unknown; ciphertexts: Record<string, string> }> = [];
  const d: FlushDeps = {
    readMessageKey: vi.fn(async (id: string) => (id === ATLAS && over.atlasKey ? { pubkey_b64u: over.atlasKey, key_version: 1 } : null)) as unknown as FlushDeps['readMessageKey'],
    openThread: vi.fn(async (body: { anchor: unknown; message: { ciphertexts: Record<string, string> } }) => {
      sent.push({ threadId: null, anchor: body.anchor, ciphertexts: body.message.ciphertexts });
      return { thread: { thread_id: 't_new' }, message: { message_id: `m_${sent.length}` }, created: true };
    }) as unknown as FlushDeps['openThread'],
    sendThreadMessage: vi.fn(async (threadId: string, message: { ciphertexts: Record<string, string> }) => {
      sent.push({ threadId, ciphertexts: message.ciphertexts });
      return { message: { message_id: `m_${sent.length}` } };
    }) as unknown as FlushDeps['sendThreadMessage'],
    sign: async (text: string) => text,
    ...over,
  };
  return { d, sent };
}

beforeEach(() => { store.clear(); keychain.clear(); keychainLocked = false; });

const draft = (over: Record<string, unknown> = {}) => ({ myId: FRANK, myPubkey: pub(frankSk), counterparty: ATLAS, threadId: 't1', text: 'Hey atlas - just seeing if I can reach you this way. It’s the operator', ...over });

describe('pending thread drafts', () => {
  it('a kept draft stays pending while the recipient has no key, and nothing is sent', async () => {
    await savePendingDraft(draft());
    const { d, sent } = deps({ atlasKey: null });
    expect(await flushPendingThreadDrafts(FRANK, d)).toEqual([]);
    expect(sent).toEqual([]);
    expect(await pendingDraftsFor(FRANK, ATLAS)).toHaveLength(1);
  });

  it('once the key appears it sends itself into the thread, sealed to both keys, and leaves the store', async () => {
    let changes = 0;
    const off = onPendingDraftsChanged(() => { changes += 1; });
    await savePendingDraft(draft());
    const { d, sent } = deps({ atlasKey: pub(atlasSk) });
    const out = await flushPendingThreadDrafts(FRANK, d);
    off();
    expect(out).toHaveLength(1);
    expect(out[0].threadId).toBe('t1');
    expect(sent[0].threadId).toBe('t1');
    expect(openThreadMessage(atlasSk, sent[0].ciphertexts[ATLAS])).toBe(draft().text);
    expect(openThreadMessage(frankSk, sent[0].ciphertexts[FRANK])).toBe(draft().text);
    expect(await pendingDraftsFor(FRANK, ATLAS)).toEqual([]);
    expect(store.has(PENDING_THREAD_DRAFTS_KEY)).toBe(false);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('a send is announced with what went out, so an open thread shows it whoever flushed', async () => {
    const seen: Array<string | null> = [];
    const off = onPendingDraftsChanged((sent) => { seen.push(sent ? sent.message.message_id : null); });
    await savePendingDraft(draft());
    await flushPendingThreadDrafts(FRANK, deps({ atlasKey: pub(atlasSk) }).d);
    off();
    expect(seen).toEqual([null, 'm_1']);
  });

  it('with no thread yet, the first draft opens the direct thread and the next lands in it, in order', async () => {
    await savePendingDraft(draft({ threadId: null, text: 'one' }), 1);
    await savePendingDraft(draft({ threadId: null, text: 'two' }), 2);
    const { d, sent } = deps({ atlasKey: pub(atlasSk) });
    await flushPendingThreadDrafts(FRANK, d);
    expect(sent.map((s) => [s.threadId, s.anchor ?? null])).toEqual([[null, { kind: 'profile', id: ATLAS }], ['t_new', null]]);
    expect(openThreadMessage(atlasSk, sent[1].ciphertexts[ATLAS])).toBe('two');
  });

  it('a want answer opens a thread anchored to the want', async () => {
    await savePendingDraft(draft({ threadId: null, anchor: { kind: 'want', id: 'want_1' } }));
    const { d, sent } = deps({ atlasKey: pub(atlasSk) });
    await flushPendingThreadDrafts(FRANK, d);
    expect(sent[0].anchor).toEqual({ kind: 'want', id: 'want_1' });
  });

  it('RED: a draft only ever sends as the wallet that wrote it', async () => {
    await savePendingDraft(draft());
    const { d, sent } = deps({ atlasKey: pub(atlasSk) });
    expect(await flushPendingThreadDrafts('user_someone_else', d)).toEqual([]);
    expect(await flushPendingThreadDrafts(null, d)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a refused send (4xx) stays pending, marked, and is retried only after the backoff', async () => {
    await savePendingDraft(draft());
    let now = 1_000_000;
    const failing = deps({ atlasKey: pub(atlasSk), sendThreadMessage: vi.fn(async () => { throw new CommonsError('talking pass required', 428); }) as unknown as FlushDeps['sendThreadMessage'] });
    expect(await flushPendingThreadDrafts(FRANK, failing.d, () => now)).toEqual([]);
    const [kept] = await pendingDraftsFor(FRANK, ATLAS);
    expect(kept.failedAt).toBe(now);
    const ok = deps({ atlasKey: pub(atlasSk) });
    now += FAILED_DRAFT_RETRY_MS - 1;
    expect(await flushPendingThreadDrafts(FRANK, ok.d, () => now)).toEqual([]);
    now += 1;
    expect(await flushPendingThreadDrafts(FRANK, ok.d, () => now)).toHaveLength(1);
  });
});

describe(' : drafts at rest, double sends', () => {
  it('the stored blob is encrypted: the draft text never sits in AsyncStorage', async () => {
    await savePendingDraft(draft({ text: 'a secret only Atlas may read' }));
    const raw = store.get(PENDING_THREAD_DRAFTS_KEY)!;
    expect(raw).not.toContain('secret only Atlas');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect((await pendingDraftsFor(FRANK, ATLAS))[0].text).toBe('a secret only Atlas may read');
  });

  it('RED: a timeout / dropped connection (no HTTP answer) is never resent automatically', async () => {
    await savePendingDraft(draft());
    let now = 1_000_000;
    const failing = deps({ atlasKey: pub(atlasSk), sendThreadMessage: vi.fn(async () => { throw new Error('Network request failed'); }) as unknown as FlushDeps['sendThreadMessage'] });
    await flushPendingThreadDrafts(FRANK, failing.d, () => now);
    expect((await pendingDraftsFor(FRANK, ATLAS))[0]).toMatchObject({ uncertain: true });
    now += 10 * FAILED_DRAFT_RETRY_MS;
    const ok = deps({ atlasKey: pub(atlasSk) });
    expect(await flushPendingThreadDrafts(FRANK, ok.d, () => now)).toEqual([]);
    expect(ok.sent).toEqual([]);
  });

  it('RED: a draft claimed for "Send now" is never also sent by the flush, and is still stored (a crash loses nothing)', async () => {
    const saved = await savePendingDraft(draft());
    const { d, sent } = deps({ atlasKey: pub(atlasSk) });
    expect((await claimPendingDraft(saved.id, 1_000))?.id).toBe(saved.id);
    expect(await claimPendingDraft(saved.id, 1_001)).toBeNull();
    expect(await flushPendingThreadDrafts(FRANK, d, () => 1_002)).toEqual([]);
    expect(sent).toEqual([]);
    expect(await pendingDraftsFor(FRANK, ATLAS)).toHaveLength(1);
    // RED ( ): the sender died — maybe after its request landed. The lapsed claim is
    // uncertain: never sent again automatically, offered to the person instead.
    expect(await flushPendingThreadDrafts(FRANK, d, () => 1_000 + DRAFT_CLAIM_LEASE_MS)).toEqual([]);
    expect(sent).toEqual([]);
    const [kept] = await pendingDraftsFor(FRANK, ATLAS);
    expect(draftIsUncertain(kept, 1_000 + DRAFT_CLAIM_LEASE_MS)).toBe(true);
    expect(draftIsUncertain(kept, 1_500)).toBe(false);
    // "Send now" can still take it.
    expect((await claimPendingDraft(saved.id, 1_000 + DRAFT_CLAIM_LEASE_MS))?.id).toBe(saved.id);
  });

  it('RED: a draft the flush is sending cannot be claimed by "Send now"', async () => {
    const saved = await savePendingDraft(draft());
    let claimDuringSend: unknown = 'not tried';
    const { d } = deps({ atlasKey: pub(atlasSk), sendThreadMessage: vi.fn(async () => {
      claimDuringSend = await claimPendingDraft(saved.id);
      return { message: { message_id: 'm_1' } };
    }) as unknown as FlushDeps['sendThreadMessage'] });
    await flushPendingThreadDrafts(FRANK, d);
    expect(claimDuringSend).toBeNull();
  });

  it('release: not_sent returns it as it was; refused retries after backoff; uncertain never auto-resends', async () => {
    const a = await savePendingDraft(draft({ text: 'a' }), 1);
    await claimPendingDraft(a.id, 10);
    await releasePendingDraft(a.id, 'not_sent', 20);
    expect((await pendingDraftsFor(FRANK, ATLAS))[0]).not.toHaveProperty('claimedAt');
    expect((await pendingDraftsFor(FRANK, ATLAS))[0]).not.toHaveProperty('failedAt');
    await claimPendingDraft(a.id, 30);
    await releasePendingDraft(a.id, 'refused', 40);
    expect((await pendingDraftsFor(FRANK, ATLAS))[0]).toMatchObject({ failedAt: 40 });
    expect((await pendingDraftsFor(FRANK, ATLAS))[0].uncertain).toBeFalsy();
    await claimPendingDraft(a.id, 50);
    await releasePendingDraft(a.id, 'uncertain', 60);
    expect((await pendingDraftsFor(FRANK, ATLAS))[0]).toMatchObject({ uncertain: true });
    await removePendingDraft(a.id);
    expect(await pendingDraftsFor(FRANK, ATLAS)).toEqual([]);
  });

  it('RED ( ): a locked Keychain never wipes the kept drafts', async () => {
    const a = await savePendingDraft(draft({ text: 'to atlas' }));
    await savePendingDraft(draft({ counterparty: 'wallet_aw_other', text: 'to someone else' }));
    keychainLocked = true;
    await removePendingDraft(a.id);
    await releasePendingDraft(a.id, 'uncertain');
    expect(await claimPendingDraft(a.id)).toBeNull();
    expect(await flushPendingThreadDrafts(FRANK, deps({ atlasKey: pub(atlasSk) }).d)).toEqual([]);
    expect(store.has(PENDING_THREAD_DRAFTS_KEY)).toBe(true);
    keychainLocked = false;
    expect((await pendingDraftsFor(FRANK, ATLAS)).map((x) => x.text)).toEqual(['to atlas']);
    expect((await pendingDraftsFor(FRANK, 'wallet_aw_other')).map((x) => x.text)).toEqual(['to someone else']);
  });

  it('kept want answers are listed by want id for the wants board', async () => {
    await savePendingDraft(draft({ threadId: null, anchor: { kind: 'want', id: 'want_9' }, text: 'I can help' }));
    await savePendingDraft(draft());
    const m = await pendingWantDrafts(FRANK);
    expect([...m.keys()]).toEqual(['want_9']);
    expect(m.get('want_9')?.text).toBe('I can help');
  });
});

describe('the no-key copy (all 12 locales)', () => {
  const localesDir = resolve(__dirname, '../../i18n/locales');
  const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  const keys = ['threadKeyMissingTitle', 'threadKeyMissingOwnAgent', 'threadKeyMissingOther', 'threadDraftKept', 'threadDraftWaiting', 'threadDraftWaitingOwnAgent', 'threadDraftNotSent', 'threadDraftUncertain', 'threadDraftSendNow'];

  it('own linked agent and anyone else get different copy', () => {
    expect(keyMissingCopyKeys(true).body).toBe('commons.threadKeyMissingOwnAgent');
    expect(keyMissingCopyKeys(false).body).toBe('commons.threadKeyMissingOther');
  });

  it('English reads exactly as specified', () => {
    const en = JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8')).commons;
    expect(en.threadKeyMissingOwnAgent.replace('{{name}}', 'Atlas')).toBe('Atlas hasn\'t turned on messaging yet. It will the next time it starts.');
    expect(en.threadKeyMissingOther).toBe('This wallet can\'t receive messages yet.');
  });

  it('every locale carries every line, translated, with {{name}} intact where English has it', () => {
    expect(files).toHaveLength(12);
    const en = JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8')).commons;
    for (const f of files) {
      const c = JSON.parse(readFileSync(resolve(localesDir, f), 'utf8')).commons;
      for (const k of keys) {
        expect(typeof c[k], `${f} ${k}`).toBe('string');
        if (f !== 'en.json' && k !== 'threadKeyMissingTitle') expect(c[k], `${f} ${k} untranslated`).not.toBe(en[k]);
        expect(c[k].includes('{{name}}'), `${f} ${k} placeholder`).toBe(en[k].includes('{{name}}'));
      }
      expect(c.threadKeyMissingBody, `${f} stale key`).toBeUndefined();
    }
  });
});
