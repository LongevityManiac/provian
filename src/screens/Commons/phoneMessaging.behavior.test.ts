import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { buildInbox } from '../../core/commons/inbox';
import { fetchedReadCursor, mergeThreadMessages, THREAD_PAGE_SIZE } from '../../core/commons/threadHistory';
import { viewThreadBody } from '../../core/commons/threadMessageView';

/** Execute the screen's actual callback, with the same hook boundaries as the native screen. */
function callback(file: string, name: string, context: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  const path = resolve(__dirname, file);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.name.getText(source) === name && n.initializer && ts.isCallExpression(n.initializer)) found = n.initializer.arguments[0];
    ts.forEachChild(n, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing ${name} callback`);
  return runInNewContext(ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
}
function acknowledge(context: Record<string, unknown>): void {
  const path = resolve(__dirname, 'CommonsThread.tsx');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
      && node.arguments[0]?.getText(source).includes('markThreadRead(')) found = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error('Missing read acknowledgement effect');
  runInNewContext(ts.transpileModule(`(${found.getText(source)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
describe('phone read acknowledgement refreshes existing badge sources', () => {
  function context() {
    const refreshNotifications = vi.fn(async () => undefined);
    return {
      threadId: 'thread', loading: false, atLatest: true, shownCursor: 123,
      acknowledged: { current: 0 }, visibleRef: { current: true }, layoutReady: { current: true },
      AppState: { currentState: 'active' },
      requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame: vi.fn(),
      CommonsService: { markThreadRead: vi.fn(async () => ({ read: true })) },
      useCommonsStore: { getState: () => ({ refreshNotifications }) }, refreshNotifications,
      requestAttentionRefresh: vi.fn(),
    };
  }
  it('refreshes Commons, Wallet and bell counters only after the bounded read succeeds', async () => {
    const c = context(); acknowledge(c);
    expect(c.CommonsService.markThreadRead).toHaveBeenCalledWith('thread', 123);
    expect(c.requestAttentionRefresh).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(c.acknowledged.current).toBe(123); });
    expect(c.refreshNotifications).toHaveBeenCalledOnce();
    expect(c.requestAttentionRefresh).toHaveBeenCalledOnce();
  });
  it('does not clear badges when acknowledgement fails or the screen is not visible', async () => {
    const c = context(); c.CommonsService.markThreadRead.mockRejectedValueOnce(new Error('offline'));
    acknowledge(c); await new Promise(resolve => setTimeout(resolve, 0));
    expect(c.acknowledged.current).toBe(0);
    expect(c.refreshNotifications).not.toHaveBeenCalled(); expect(c.requestAttentionRefresh).not.toHaveBeenCalled();
    c.CommonsService.markThreadRead.mockClear(); c.visibleRef.current = false; acknowledge(c);
    expect(c.CommonsService.markThreadRead).not.toHaveBeenCalled();
  });
});
function inbox() {
  const context = {
    CommonsService: { listThreads: vi.fn(async () => ({ threads: [{ thread_id: 't', party_a: 'me', party_b: 'other', last_message_at: 100, unread: true }] })), getMyReplies: vi.fn(async () => ({ replies: [{ post_id: 'p', author_wallet_id: 'other', created_at: 150, content: 'reply' }] })), getPendingConsents: vi.fn(async () => ({ consents: [] })) },
    AsyncStorage: { getItem: vi.fn(async () => '50') }, REPLIES_SEEN_KEY: 'seen', myId: 'me', buildInbox,
    visibleRef: { current: true }, loadingRef: { current: false }, setItems: vi.fn(), setLoadError: vi.fn(), markRepliesSeen: vi.fn(async () => undefined), refreshNotifications: vi.fn(),
  };
  return { context, load: callback('tabs/CommonsInboxTab.tsx', 'load', context) };
}
describe('phone Inbox executes real load callback', () => {
  it('healthy control shows retrieved items and acknowledges only the fetched reply timestamp', async () => {
    const { context: c, load } = inbox(); await load();
    expect(c.setItems.mock.calls[0][0]).toHaveLength(2);
    expect(c.markRepliesSeen).toHaveBeenCalledWith(150);
    expect(c.setLoadError).toHaveBeenCalledWith(false);
  });
  for (const source of ['listThreads', 'getMyReplies', 'getPendingConsents'] as const) {
    it(`retains previous items and watermark when ${source} fails`, async () => {
      const { context: c, load } = inbox(); await load();
      c.setItems.mockClear(); c.markRepliesSeen.mockClear();
      c.CommonsService[source].mockRejectedValueOnce(new Error('503'));
      await load();
      expect(c.setItems).not.toHaveBeenCalled(); expect(c.markRepliesSeen).not.toHaveBeenCalled();
      expect(c.setLoadError).toHaveBeenLastCalledWith(true);
      await load(); expect(c.setLoadError).toHaveBeenLastCalledWith(false);
    });
  }
  it('all sources failing is an error, never an empty success', async () => {
    const { context: c, load } = inbox();
    for (const f of Object.values(c.CommonsService)) f.mockRejectedValueOnce(new Error('503'));
    await load(); expect(c.setItems).not.toHaveBeenCalled(); expect(c.markRepliesSeen).not.toHaveBeenCalled();
    expect(c.setLoadError).toHaveBeenCalledWith(true);
  });
  it('does not clear unseen replies after the user leaves during a fetch', async () => {
    const { context: c, load } = inbox();
    c.CommonsService.getMyReplies.mockImplementationOnce(async () => { c.visibleRef.current = false; return { replies: [] }; });
    await load(); expect(c.setItems).not.toHaveBeenCalled(); expect(c.markRepliesSeen).not.toHaveBeenCalled();
  });
});
function thread() {
  const all = Array.from({ length: 150 }, (_, i) => ({ message_id: `m${i + 1}`, created_at: (i + 1) * 10 }));
  const c = {
    fetchedCoverage: { current: null as number | null }, oldestCursor: { current: null as { at: number; id: string } | null }, threadId: 't', myId: 'me', visibleRef: { current: true }, loadInFlight: { current: false }, AppState: { currentState: 'active' }, messagesRef: { current: [] as typeof all },
    CommonsService: { getThreadMessages: vi.fn(async (_id: string, opts: { before?: number }) => ({ thread: { thread_id: 't', read_cursors: { me: 1000 } }, messages: all.filter(m => !opts.before || m.created_at < opts.before).slice(-100) })), listThreadPresentationRequests: vi.fn(async () => ({ requests: [] })) },
    THREAD_PAGE_SIZE, mergeThreadMessages, fetchedReadCursor, decrypt: vi.fn(async (_rows: typeof all) => true), setThread: vi.fn(), setMessages: vi.fn((fn) => { c.messagesRef.current = fn(c.messagesRef.current); }), setRequests: vi.fn(),
    layoutReady: { current: false }, setAtLatest: vi.fn(), setOlderAvailable: vi.fn(), scrollToLatest: { current: true }, setLoadError: vi.fn(), setShownCursor: vi.fn(), setLoading: vi.fn(), setLoadingOlder: vi.fn(),
  };
  return { all, c, load: callback('CommonsThread.tsx', 'load', c) };
}
describe('phone thread opens actual message bodies before advancing read coverage', () => {
  function decryption() {
    const c = {
      myId: 'me', plainRef: { current: {} },
      getMessageKeyPair: vi.fn(async () => ({ secretKey: 'key' })),
      openThreadMessage: vi.fn((_key, ciphertext) => ciphertext === 'readable' ? 'shown text' : null),
      readThreadPlaintext: (text: string) => ({ text, signature: null }),
      captureShownOutput: vi.fn(), viewThreadBody,
      setKeyUnavailable: vi.fn(), setPlain: vi.fn(), console,
    };
    return { c, decrypt: callback('CommonsThread.tsx', 'decrypt', c) };
  }
  const application = { message_id: 'application', kind: 'text', ciphertexts: {}, attachment: { application: true } };
  const message = { message_id: 'message', kind: 'text', ciphertexts: { me: 'readable' } };
  it('a displayed attachment-only Application does not block subsequent readable messages', async () => {
    const { decrypt } = decryption();
    expect(await decrypt([application, message])).toBe(true);
  });
  it.each([{ me: 'locked' }, { someone_else: 'readable' }])('still blocks encrypted text that this person cannot open', async ciphertexts => {
    const { decrypt } = decryption();
    expect(await decrypt([application, { ...message, ciphertexts }])).toBe(false);
  });
  it('still blocks when the message key cannot be unlocked', async () => {
    const { c, decrypt } = decryption();
    c.getMessageKeyPair.mockRejectedValueOnce(new Error('locked'));
    expect(await decrypt([application, message])).toBe(false);
  });
});
describe('phone thread executes real page loading', () => {
  it('loads recent 100 then reaches the earlier 50 and preserves them on refresh', async () => {
    const { c, load } = thread(); await load();
    expect(c.messagesRef.current).toHaveLength(100); expect(c.messagesRef.current[0].message_id).toBe('m51');
    expect(c.setOlderAvailable).toHaveBeenLastCalledWith(true);
    await load(true);
    expect(c.CommonsService.getThreadMessages).toHaveBeenLastCalledWith('t', { limit: 100, before: 510, beforeId: 'm51' });
    expect(c.messagesRef.current).toHaveLength(150); expect(c.messagesRef.current[0].message_id).toBe('m1');
    expect(c.setOlderAvailable).toHaveBeenLastCalledWith(false);
    await load(); expect(c.messagesRef.current).toHaveLength(150);
  });
  it('fetches the entire unread gap before acknowledging the newest page', async () => {
    const { c, all, load } = thread();
    c.CommonsService.getThreadMessages.mockImplementation(async (_id, opts) => ({ thread: { thread_id: 't', read_cursors: { me: 0 } }, messages: all.filter(m => !opts.before || m.created_at < opts.before).slice(-100) }));
    await load(); expect(c.messagesRef.current).toHaveLength(150);
    expect(c.CommonsService.getThreadMessages).toHaveBeenCalledTimes(2);
  });
  it('a newly arrived message appears on refresh, with no send required', async () => {
    const { all, c, load } = thread(); await load(); all.push({ message_id: 'reply', created_at: 1600 }); await load();
    expect(c.messagesRef.current.at(-1)?.message_id).toBe('reply');
    expect(c.messagesRef.current).toHaveLength(101);
  });
  it('does not acknowledge a locked or backgrounded page', async () => {
    const { c, load } = thread(); c.decrypt.mockResolvedValueOnce(false); await load(); expect(c.setShownCursor).not.toHaveBeenCalled();
    c.decrypt.mockImplementationOnce(async () => { c.visibleRef.current = false; return true; }); await load(); expect(c.setShownCursor).not.toHaveBeenCalled();
  });
  it('uses the fetched cursor even if the summary is ahead', async () => {
    const { c, load } = thread(); await load();
    expect(c.setShownCursor.mock.calls[0][0](0)).toBe(1500);
    const source = readFileSync(resolve(__dirname, 'CommonsThread.tsx'), 'utf8');
    expect(source).toContain('markThreadRead(threadId, shownCursor)');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('setInterval(() => { void load(); }, 10_000)');
    expect(source).toContain("AppState.addEventListener('change'");
  });
});

it('Inbox retrieves unread replies beyond the first page before moving the watermark', async () => {
 const { context: c, load } = inbox();
 c.CommonsService.getMyReplies.mockResolvedValueOnce({ replies: [{ post_id: 'new', author_wallet_id: 'other', created_at: 300, content: 'new' }], next_cursor: 'next' } as never);
 c.CommonsService.getMyReplies.mockResolvedValueOnce({ replies: [{ post_id: 'old', author_wallet_id: 'other', created_at: 200, content: 'older unread' }], next_cursor: null } as never);
 await load(); expect(c.CommonsService.getMyReplies).toHaveBeenCalledTimes(2);
 expect(c.setItems.mock.calls[0][0]).toHaveLength(3); expect(c.markRepliesSeen).toHaveBeenCalledWith(300);
});

it('an optimistic send cannot cover an unread fetch gap', async () => {
 const { all, c, load } = thread(); await load();
 for (let i = 151; i <= 300; i++) all.push({ message_id: `m${i}`, created_at: i * 10 });
 const sent = { message_id: 'mine', created_at: 3010 };
 all.push(sent); c.messagesRef.current.push(sent);
 await load(); expect(c.messagesRef.current).toHaveLength(251);
 expect(c.messagesRef.current.some(m => m.message_id === 'm151')).toBe(true);
});
it('retained locked rows are rechecked before a newer page can advance read coverage', async () => {
 const { all, c, load } = thread();
 c.decrypt.mockImplementation(async rows => !rows.some(m => m.message_id === 'm51'));
 await load();
 for (let i = 151; i <= 300; i++) all.push({ message_id: `m${i}`, created_at: i * 10 });
 await load();
 expect(c.setShownCursor).not.toHaveBeenCalled(); expect(c.fetchedCoverage.current).toBeNull();
 expect(c.decrypt.mock.calls.at(-1)?.[0].some(m => m.message_id === 'm51')).toBe(true);
});
