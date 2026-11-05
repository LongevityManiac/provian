/**
 * `provian threads --unread` an agent pulls the messages it has not read,
 * decrypted with its key, and the threads it read are marked read (--peek leaves them unread).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveMessageKeyPair, sealThreadMessage } from '@provian/agent-sdk';
import { cmdApprovals, cmdRequestApproval, cmdThreads } from './commons-institutions-commands';
import { openTestPrivateRequest } from '../../../provian-agent-sdk/src/private-request.test-support';

const KEY = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const ME = 'wallet_aw_bot';
const sealed = sealThreadMessage('Hey atlas - it\'s the operator', { [ME]: deriveMessageKeyPair(KEY).pubkeyB64u });

let calls: Array<{ path: string; method: string; body?: unknown }> = [];
let policy: unknown;
beforeEach(() => {
  calls = [];
  policy = undefined;
  process.env.PROVIAN_API_KEY = `pvn_live_${'1'.repeat(32)}`;
  process.env.PROVIAN_API_SECRET = `pvns_${'2'.repeat(64)}`;
  process.env.PROVIAN_AGENT_WALLET_ID = ME;
  process.env.PROVIAN_AGENT_PRIVATE_KEY = KEY;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? openTestPrivateRequest(JSON.parse(String(init.body)), String(url), init?.headers) : undefined });
    const body = path === '/v1/threads/unread' ? { threads: [{ thread_id: 't1' }], ...(policy ? { reply_policy: policy } : {}) }
      : path.endsWith('/approval-requests') ? { requests: [] }
      : path.endsWith('/request-approval') ? { request: { request_id: 'har_1', status: 'pending' } }
      : path === '/v1/threads/t1/messages' ? {
        thread: { read_cursors: { [ME]: 5 }, display_names: { user_frank: 'the operator' } },
        messages: [
          { message_id: 'm_old', author_id: 'user_frank', kind: 'text', created_at: 4, ciphertexts: {} },
          { message_id: 'm_new', pe_id: 'pe_new', author_id: 'user_frank', kind: 'text', created_at: 7, ciphertexts: { [ME]: sealed.ciphertexts[ME] } },
        ],
      } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['PROVIAN_API_KEY', 'PROVIAN_API_SECRET', 'PROVIAN_AGENT_WALLET_ID', 'PROVIAN_AGENT_PRIVATE_KEY']) delete process.env[k];
});

describe('provian threads --unread', () => {
  it('returns only the unread messages, decrypted, and marks the thread read', async () => {
    const r = await cmdThreads({ unread: true }) as Record<string, unknown>;
    expect(r).toMatchObject({ count: 1, threads: [{ thread_id: 't1', from: 'user_frank', from_name: 'the operator', messages: [{ message_id: 'm_new', text: 'Hey atlas - it\'s the operator' }] }] });
    expect(calls.some((c) => c.path === '/v1/threads/t1/read' && c.method === 'POST')).toBe(true);
  });

  it('--peek never marks read', async () => {
    await cmdThreads({ unread: true, peek: true });
    expect(calls.some((c) => c.path.endsWith('/read'))).toBe(false);
  });

  it('carries the owner\'s reply policy and what to do under it', async () => {
    const r = await cmdThreads({ unread: true }) as Record<string, unknown>;
    expect(String(r.reply_instruction)).toContain('answer anyone');
  });

  it('RED: under ask me first a stranger\'s thread stays unread with its next step (item 4)', async () => {
    policy = { mode: 'ask_me_first', linked_human: 'user_someone_else' };
    const r = await cmdThreads({ unread: true }) as { threads: Array<Record<string, unknown>>; reply_instruction: string };
    expect(r.threads[0]).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_new', marked_read: false });
    expect(r.reply_instruction).toContain('ask me first');
    // RED ( ): the instruction names THIS CLI's verbs, never another package's command line.
    expect(r.reply_instruction).toContain('provian request-approval --for <ask_for>');
    expect(r.reply_instruction).toContain('provian thread-send --thread <id>');
    expect(r.reply_instruction).not.toMatch(/npx|agent-sdk|\.provian\/bin/);
    expect(calls.some((c) => c.path.endsWith('/read'))).toBe(false);
  });

  it('the linked human\'s own thread is still read and marked under ask me first', async () => {
    policy = { mode: 'ask_me_first', linked_human: 'user_frank' };
    await cmdThreads({ unread: true });
    expect(calls.some((c) => c.path === '/v1/threads/t1/read')).toBe(true);
  });

  it('with no key it still names the policy and marks nothing read', async () => {
    delete process.env.PROVIAN_AGENT_PRIVATE_KEY;
    policy = { mode: 'ask_me_first', linked_human: 'user_frank' };
    const r = await cmdThreads({ unread: true }) as Record<string, unknown>;
    expect(String(r.reply_instruction)).toContain('ask me first');
    expect(calls.some((c) => c.path.endsWith('/read'))).toBe(false);
  });

  it('request-approval --for names the message; approvals refuses a bad status before any call', async () => {
    await cmdRequestApproval({ description: 'Reply to Ann in thread t1: yes', for: 'pe_new' });
    expect(calls.find((c) => c.path.endsWith('/request-approval'))?.body).toMatchObject({ action_description: 'Reply to Ann in thread t1: yes', subject_pe_id: 'pe_new' });
    const n = calls.length;
    const bad = await cmdApprovals({ status: 'all' }) as Record<string, unknown>;
    expect(JSON.stringify(bad)).toMatch(/--status must be/);
    expect(calls).toHaveLength(n);
    expect(await cmdApprovals({ status: 'pending' })).toEqual({ requests: [] });
  });
});
