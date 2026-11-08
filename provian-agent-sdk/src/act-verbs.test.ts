import {openTestPrivateRequest} from './private-request.test-support';
/**
 * the act verbs a hosted agent runs from its shell.
 *
 * What is pinned:
 * - verb selection is by POSITION only, and the act verbs never collide with the bootstrap verbs;
 * - `help` lists every verb once, grouped Presentations / Commons / On-chain, with the speech-window and gas notes;
 * - each verb drives the SDK call that performs the act, with the request shape the relay expects
 * (real CommonsInstitutions over a mock fetch; chain calls through mock signer functions);
 * - NO SELF-DECLARATION : no verb is named like a declaration, and across a sweep
 * of every relay-reaching verb no request touches a self-declaration path — both checks have a
 * RED control that feeds them a violating input;
 * - CREDENTIAL SAFETY: the wallet key (bare and 0x) and the API secret never reach the output, even
 * when an error message carries them — with the RED control that the raw error DID carry them.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACT_VERBS,
  resolveActVerb,
  isHelpVerb,
  renderActHelp,
  parseActArgs,
  resolveAtomicAmount,
  runActVerbCli,
  scrubSecrets,
  defaultActDeps,
  verifyStatusOf,
  type ActDeps,
} from './act-verbs';
import { BOOTSTRAP_VERBS } from './scripts/bootstrap';
import { CommonsInstitutions, payoutRequestIdOfPayment, provianServiceFeePin } from './commons-institutions';
import { ProvianError } from './errors';
import { anchoredStore } from './meter/anchored-store.test-support';
import { ProvianClient } from './ProvianClient';
import type { InstalledAgent } from './installed-agent';
import { TOKEN_ALLOWLIST } from './evm-allowlist';
import { signOutputWithWalletKey, walletOutputSignatureRecovers } from './output-signing';
import { decodeOutputSignatureHeader } from './output-signature';
import { deriveMessageKeyPair, sealThreadMessage } from './thread-crypto';

const KEY_BARE = '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const ADDRESS = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const API_KEY = `pvn_live_${'1'.repeat(32)}`;
const API_SECRET = `pvns_${'2'.repeat(64)}`;
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TX = `0x${'ab'.repeat(32)}`;

interface Call { url: string; path: string; method: string; body: unknown }

function harness(opts: { respond?: (c: Call) => { status?: number; body: unknown }; deps?: Partial<ActDeps> } = {}) {
  const calls: Call[] = [];
  let keyUses = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { url: String(url), path: u.pathname, method: init?.method ?? 'GET', body: init?.body ? openTestPrivateRequest(JSON.parse(String(init.body)),String(url),init?.headers) : undefined };
    calls.push(call);
    const { status = 200, body } = opts.respond?.(call) ?? defaultRespond(call);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  const agent: InstalledAgent = {
    walletId: 'wallet_aw_bot',
    address: ADDRESS,
    apiSecret: API_SECRET,
    config: { relayUrl: 'https://relay.test', walletId: 'wallet_aw_bot', apiKey: API_KEY, apiSecret: API_SECRET },
    withKey: async (fn) => { keyUses++; return fn(KEY_BARE); },
  };
  const transferToken = vi.fn(async () => ({ hash: TX }) as never);
  const transferNative = vi.fn(async () => ({ hash: TX }) as never);
  const waitForReceipt = vi.fn(async () => 'success' as const);
  const flushMeter = vi.fn(async () => ({ sent: true, detail: 'sent' }));
  const makeX402Fetch = vi.fn(() => (async () => new Response('paid body', { status: 200, headers: { 'content-type': 'text/plain', 'payment-response': 'settled' } })) as unknown as typeof fetch);
  const deps: ActDeps = {
    loadAgent: () => agent,
    makeInstitutions: (config) => new CommonsInstitutions({ ...config, fetch: fetchImpl }),
    transferToken: transferToken as unknown as ActDeps['transferToken'],
    transferNative: transferNative as unknown as ActDeps['transferNative'],
    waitForReceipt: waitForReceipt as unknown as ActDeps['waitForReceipt'],
    validateEgress: defaultActDeps().validateEgress,
    makeX402Fetch,
    readFile: () => { throw new Error('no files in this test'); },
    env: {},
    confirmations: 12,
    openPeStore: () => ({ ok: false, detail: 'no PE store in this test' }),
    flushMeter: flushMeter as unknown as ActDeps['flushMeter'],
    openArchive: async () => null,
    mailNotice: () => null,
    actionNotice: () => null,
    clearMailbox: () => undefined,
    acknowledgeHeartbeat: () => undefined,
    ...opts.deps,
  };
  const out: string[] = [];
  const run = async (verb: string, ...args: string[]) => {
    const code = await runActVerbCli(verb, args, deps, { stdout: (l) => { out.push(l); } });
    const text = out.join('\n');
    out.length = 0;
    return { code, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { run, calls, deps, transferToken, transferNative, waitForReceipt, makeX402Fetch, flushMeter, keyUses: () => keyUses };
}

function defaultRespond(c: Call): { status?: number; body: unknown } {
  if (c.path.endsWith('/transfer/record')) return { body: { pe_id: 'pe_transfer', verified: true } };
  if (c.path.endsWith('/burn/record')) return { body: { burn_id: 'burn_1', verified: true, finality: 'provisional' } };
  if (c.path.endsWith('/balances')) return { body: { eth: '0.001', usdc: '0', chain: 'base', pvt9: { balance: '99', available: true, address: ADDRESS } } };
  if (c.path.endsWith('/inbox')) return { body: { events: [], next_cursor: null } };
  if (c.path.endsWith('/rail-handshake')) return { body: { state: 'none' } };
  if (c.path.endsWith('/vouches')) return { body: { vouches: [] } };
  return { body: { ok: true, pe_id: 'pe_x', job_id: 'hjob_1', status: 'open' } };
}

// ---------------------------------------------------------------------------

describe('CLI output completion', () => {
  it('waits for a large reader response to flush before returning the exit code', async () => {
    const threads = Array.from({ length: 100 }, (_, i) => ({ thread_id: `thread_${i}`, text: 'message '.repeat(100) }));
    const h = harness({ respond: () => ({ body: { threads } }) });
    let release = () => {};
    const flushed = new Promise<void>((resolve) => { release = resolve; });
    let output = '';
    let returned = false;
    const run = runActVerbCli('threads', [], h.deps, {
      stdout: async (line) => { output = line; await flushed; },
    }).then((code) => { returned = true; return code; });
    await vi.waitFor(() => { expect(output.length).toBeGreaterThan(65_536); });
    const returnedBeforeFlush = returned;
    release();
    expect(await run).toBe(0);
    expect(returnedBeforeFlush).toBe(false);
    expect(JSON.parse(output).threads).toEqual(threads);
  });
});

describe('verb selection', () => {
  it('selects only at the argument position', () => {
    expect(resolveActVerb(['node', 'agent.js', 'post', '--content', 'hi'])).toBe('post');
    expect(resolveActVerb(['node', 'agent.js', 'report-pe', '--description', 'post'])).toBeNull();
    expect(resolveActVerb(['node', 'agent.js'])).toBeNull();
    expect(isHelpVerb(['node', 'agent.js', 'help'])).toBe(true);
    expect(isHelpVerb(['node', 'agent.js', '--help'])).toBe(true);
  });

  it('act verbs and bootstrap verbs are disjoint (an act verb can never shadow repair/observe)', () => {
    const boot = new Set<string>(BOOTSTRAP_VERBS);
    expect(ACT_VERBS.filter((v) => boot.has(v.name)).map((v) => v.name)).toEqual([]);
    expect(new Set(ACT_VERBS.map((v) => v.name)).size).toBe(ACT_VERBS.length);
  });

  it('parses --k v, --k=v, booleans and repeated flags; rejects prototype keys', () => {
    const p = parseActArgs(['https://x.test', '--max-usdc', '0.5', '--header=A: 1', '--header', 'B: 2', '--yes']);
    expect(p.positionals).toEqual(['https://x.test']);
    expect(p.flags['max-usdc']).toBe('0.5');
    expect(p.flags.yes).toBe(true);
    expect(p.lists.header).toEqual(['A: 1', 'B: 2']);
    expect(() => parseActArgs(['--__proto__', 'x'])).toThrow(/not a valid option/);
  });

  it('decimal amounts convert exactly; too many decimals and junk are refused', () => {
    expect(resolveAtomicAmount(parseActArgs(['--amount', '1.5']), 'amount', 'amount-atomic', 6)).toBe(1_500_000n);
    expect(resolveAtomicAmount(parseActArgs(['--amount', '5']), 'amount', 'amount-atomic', 18)).toBe(5n * 10n ** 18n);
    expect(resolveAtomicAmount(parseActArgs(['--amount-atomic', '42']), 'amount', 'amount-atomic', 6)).toBe(42n);
    expect(() => resolveAtomicAmount(parseActArgs(['--amount', '0.0000001']), 'amount', 'amount-atomic', 6)).toThrow(/decimal places/);
    expect(() => resolveAtomicAmount(parseActArgs(['--amount', '1e6']), 'amount', 'amount-atomic', 6)).toThrow(/plain decimal/);
  });
});

describe('help', () => {
  it('lists every verb exactly once, grouped Presentations, Commons then On-chain, with the window and gas notes', () => {
    const text = renderActHelp().join('\n');
    for (const v of ACT_VERBS) {
      expect(text.split('\n').filter((l) => l.trimStart().startsWith(`${v.name} `)).length).toBe(1);
    }
    expect(text.indexOf('Commons')).toBeLessThan(text.indexOf('On-chain'));
    expect(text).toMatch(/speech window/);
    expect(text).toMatch(/ETH on Base for gas/);
    expect(text.indexOf('Presentations')).toBeLessThan(text.indexOf('Commons  ('));
    expect(ACT_VERBS.filter((v) => v.group === 'Presentations').map((v) => v.name)).toEqual(['present', 'respond']);
    expect(ACT_VERBS.filter((v) => v.group === 'Commons').length).toBeGreaterThan(0);
    expect(ACT_VERBS.filter((v) => v.group === 'On-chain').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No self-declaration (+ "PEs prove provenance")
// ---------------------------------------------------------------------------

const DECLARATION_NAME = /report|declare|submit|self|sovereign|link-spend|record-link|witness|claim-work/;
const DECLARATION_PATH = /\/v1\/pe\/submit|\/sovereign|\/report|link-spend|\/x402|\/pe\/record|\/work-product/;

function declarationNameOffenders(names: readonly string[]): string[] {
  return names.filter((n) => DECLARATION_NAME.test(n));
}
function declarationPathOffenders(paths: readonly string[]): string[] {
  return paths.filter((p) => DECLARATION_PATH.test(p));
}

/** Every relay-reaching verb, with arguments that avoid broadcasting. */
const RELAY_SWEEP: Array<[string, string[]]> = [
  ['speech-window', []],
  ['post', ['--content', 'hello commons']],
  ['reply', ['--post', 'post_1', '--content', 'agreed']],
  ['vote', ['--post', 'post_1', '--direction', 'up']],
  ['threads', []],
  ['inbox', []],
  ['want', ['--outcome', 'a summary', '--capabilities', 'writing']],
  ['jobs', []],
  ['jobs', ['--mine']],
  ['jobs', ['--job', 'hjob_1']],
  ['job-post', ['--currency', 'pvt', '--budget', '10', '--title', 't', '--description', 'd', '--deadline-hours', '24']],
  ['job-apply', ['--job', 'hjob_1', '--proposal', 'I can']],
  ['job-accept', ['--job', 'hjob_1', '--applicant', 'wallet_aw_other']],
  ['job-deliver', ['--job', 'hjob_1', '--uri', 'https://example.com/out']],
  ['job-fund', ['--job', 'hjob_1', '--tx-hash', TX]],
  ['job-release', ['--job', 'hjob_1', '--record-only']],
  ['vouch', ['--target', 'wallet_aw_other']],
  ['balance', []],
  ['burn', ['--tx-hash', TX, '--amount', '5']],
  ['transfer', ['--token', 'USDC', '--to', RECIPIENT, '--amount', '1']],
  ['transfer-native', ['--to', RECIPIENT, '--amount', '0.001']],
  ['x402-fetch', ['https://seller.test/paid', '--max-usdc', '0.1']],
];

describe('NO SELF-DECLARATION', () => {
  it('no act verb is named like a declaration of work', () => {
    expect(declarationNameOffenders(ACT_VERBS.map((v) => v.name))).toEqual([]);
  });
  it('RED control: the name check flags a declaration verb', () => {
    expect(declarationNameOffenders(['post', 'report-pe', 'submit-work', 'x402-record-self'])).toEqual(['report-pe', 'submit-work', 'x402-record-self']);
  });

  it('across every relay-reaching verb, no request touches a self-declaration path', async () => {
    const h = harness();
    for (const [verb, args] of RELAY_SWEEP) {
      const r = await h.run(verb, ...args);
      expect({ verb, code: r.code, out: r.json }).toMatchObject({ verb, code: 0 });
    }
    // Empty-population guard: the sweep must actually have reached the relay.
    expect(h.calls.length).toBeGreaterThanOrEqual(RELAY_SWEEP.length - 1);
    expect(declarationPathOffenders(h.calls.map((c) => c.path))).toEqual([]);
    // x402-fetch never reaches the relay at all (the chain watcher prices the settlement).
    expect(h.makeX402Fetch).toHaveBeenCalledTimes(1);
  });
  it('RED control: the path check flags the self-declaration routes', () => {
    expect(declarationPathOffenders(['/v1/commons/forum/post', '/v1/pe/submit', '/v1/agent/wallet/w/sovereign-work', '/v1/agent/wallet/w/link-spend']))
      .toEqual(['/v1/pe/submit', '/v1/agent/wallet/w/sovereign-work', '/v1/agent/wallet/w/link-spend']);
  });

  it('the default x402 fetch is built with recordPE:false (no x402_payment self-record)', () => {
    const spy = vi.spyOn(ProvianClient.prototype, 'wrapFetchWithX402').mockReturnValue((async () => new Response('')) as unknown as typeof fetch);
    defaultActDeps().makeX402Fetch('https://relay.test', { privateKeyHex: `0x${KEY_BARE}`, address: ADDRESS }, 100n);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ maxAmountAtomic: 100n, recordPE: false });
  });
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

describe('reply policy on the read, and the approval verbs (item 4)', () => {
  const unreadWith = (policy: unknown) => (c: Call): { status?: number; body: unknown } => {
    if (c.path === '/v1/threads/unread') return { body: { threads: [], count: 0, ...(policy === undefined ? {} : { reply_policy: policy }) } };
    return defaultRespond(c);
  };

  it('threads --unread carries the owner\'s policy and what to do under it', async () => {
    const ask = await harness({ respond: unreadWith({ mode: 'ask_me_first', linked_human: 'user_frank' }) }).run('threads', '--unread');
    expect(ask.json.reply_policy).toEqual({ mode: 'ask_me_first', linked_human: 'user_frank' });
    expect(String(ask.json.reply_instruction)).toContain('Reply directly only to your linked human (user_frank)');
    const anyone = await harness({ respond: unreadWith({ mode: 'answer_anyone', linked_human: 'user_frank' }) }).run('threads', '--unread');
    expect(String(anyone.json.reply_instruction)).toContain('answer anyone');
    // A relay without the field: the default, stated.
    const older = await harness({ respond: unreadWith(undefined) }).run('threads', '--unread');
    expect(older.json.reply_policy).toBeNull();
    expect(String(older.json.reply_instruction)).toContain('answer anyone');
  });

  it('request-approval asks the linked human; approvals lists the requests (status / decision, never text)', async () => {
    const h = harness({ respond: (c) => {
      if (c.path.endsWith('/request-approval')) return { status: 201, body: { request: { request_id: 'har_1', status: 'pending', decision: null } } };
      if (c.path.endsWith('/approval-requests')) return { body: { requests: [{ request_id: 'har_1', status: 'satisfied', decision: 'approved' }] } };
      return defaultRespond(c);
    } });
    const asked = await h.run('request-approval', '--description', 'Reply to Ann in thread t9: yes, happy to help');
    expect(asked.code).toBe(0);
    expect(h.calls.find((c) => c.path === '/v1/agent/wallet/wallet_aw_bot/request-approval')?.body).toMatchObject({ action_description: 'Reply to Ann in thread t9: yes, happy to help' });
    const list = await h.run('approvals', '--status', 'satisfied');
    expect((list.json.requests as unknown[])[0]).toMatchObject({ request_id: 'har_1', status: 'satisfied', decision: 'approved' });
    expect(h.calls.find((c) => c.path.endsWith('/approval-requests'))?.url).toContain('status=satisfied');
  });

  it('RED: request-approval without a description, or approvals with a bad status, is a usage error and calls nothing', async () => {
    const h = harness();
    expect((await h.run('request-approval').catch(() => ({ code: 2 }))).code).not.toBe(0);
    expect((await h.run('approvals', '--status', 'everything').catch(() => ({ code: 2 }))).code).not.toBe(0);
    expect(h.calls.some((c) => c.path.includes('approval'))).toBe(false);
  });
});

describe('ask me first: a stranger\'s thread waits for the linked human, with no memory needed (item 4, )', () => {
  const agentPub = deriveMessageKeyPair(KEY_BARE).pubkeyB64u;
  const sealed = sealThreadMessage('Can you help with my project?', { wallet_aw_bot: agentPub });
  const FUTURE = Date.now() + 86_400_000;
  type Approval = { request_id: string; subject_pe_id: string | null; status: string; decision: 'approved' | 'rejected' | null; expires_at_ms: number };
  const setup = (opts: { from: string; approvals?: Approval[] | 'fail' }) => {
    const cleared: string[][] = [];
    const h = harness({
      deps: { clearMailbox: (ids) => { cleared.push([...ids]); } },
      respond: (c) => {
        if (c.path === '/v1/threads/unread') return { body: { threads: [{ thread_id: 't9' }], reply_policy: { mode: 'ask_me_first', linked_human: 'user_frank' } } };
        if (c.path === '/v1/threads/t9/messages') return { body: {
          thread: { thread_id: 't9', read_cursors: { wallet_aw_bot: 5 }, display_names: { [opts.from]: 'Ann' } },
          messages: [
            { message_id: 'm1', pe_id: 'pe_m1', author_id: opts.from, kind: 'text', ciphertexts: { wallet_aw_bot: sealed.ciphertexts.wallet_aw_bot }, created_at: 6 },
            { message_id: 'm2', pe_id: 'pe_m2', author_id: opts.from, kind: 'text', ciphertexts: { wallet_aw_bot: sealed.ciphertexts.wallet_aw_bot }, created_at: 8 },
          ],
        } };
        if (c.path.endsWith('/approval-requests')) {
          return opts.approvals === 'fail' ? { status: 503, body: { error: 'down' } } : { body: { requests: opts.approvals ?? [] } };
        }
        return defaultRespond(c);
      },
    });
    const marked = () => h.calls.some((c) => c.path === '/v1/threads/t9/read');
    return { h, cleared, marked };
  };
  const thread = (json: Record<string, unknown>) => (json.threads as Array<Record<string, unknown>>)[0];

  it('no request yet → ask_first, naming the newest message; the thread stays unread and in the mailbox', async () => {
    const s = setup({ from: 'wallet_aw_ann' });
    const t = thread((await s.h.run('threads', '--unread')).json);
    expect(t).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_m2', approval: null, marked_read: false });
    expect(s.marked()).toBe(false);
    expect(s.cleared).toEqual([[]]);
  });

  it('a request for the newest message: pending → waiting; approved → reply now (still unread until the reply)', async () => {
    const pending = setup({ from: 'wallet_aw_ann', approvals: [{ request_id: 'har_1', subject_pe_id: 'pe_m2', status: 'pending', decision: null, expires_at_ms: FUTURE }] });
    expect(thread((await pending.h.run('threads', '--unread')).json)).toMatchObject({ next_step: 'waiting_for_approval', marked_read: false });
    expect(pending.marked()).toBe(false);
    const approved = setup({ from: 'wallet_aw_ann', approvals: [{ request_id: 'har_1', subject_pe_id: 'pe_m2', status: 'satisfied', decision: 'approved', expires_at_ms: FUTURE }] });
    expect(thread((await approved.h.run('threads', '--unread')).json)).toMatchObject({ next_step: 'approved_reply_now', marked_read: false });
    expect(approved.marked()).toBe(false);
  });

  it('declined or lapsed → do not reply, and the thread is closed (marked read, out of the mailbox)', async () => {
    for (const a of [
      { request_id: 'har_1', subject_pe_id: 'pe_m2', status: 'satisfied', decision: 'rejected' as const, expires_at_ms: FUTURE },
      { request_id: 'har_1', subject_pe_id: 'pe_m2', status: 'expired', decision: null, expires_at_ms: 1 },
      { request_id: 'har_1', subject_pe_id: 'pe_m2', status: 'pending', decision: null, expires_at_ms: 1 },
    ]) {
      const s = setup({ from: 'wallet_aw_ann', approvals: [a] });
      expect(thread((await s.h.run('threads', '--unread')).json)).toMatchObject({ next_step: 'do_not_reply', marked_read: true });
      expect(s.marked()).toBe(true);
      expect(s.cleared).toEqual([['t9']]);
    }
  });

  it('RED: an approval for an OLDER message does not approve a newer one — the newest must be asked about', async () => {
    const s = setup({ from: 'wallet_aw_ann', approvals: [{ request_id: 'har_0', subject_pe_id: 'pe_m1', status: 'satisfied', decision: 'approved', expires_at_ms: FUTURE }] });
    expect(thread((await s.h.run('threads', '--unread')).json)).toMatchObject({ next_step: 'ask_first', ask_for: 'pe_m2' });
  });

  it('RED: approvals unreadable → wait (nothing asked, nothing marked read) — unknown = block', async () => {
    const s = setup({ from: 'wallet_aw_ann', approvals: 'fail' });
    expect(thread((await s.h.run('threads', '--unread')).json)).toMatchObject({ next_step: 'waiting_for_approval', marked_read: false });
    expect(s.marked()).toBe(false);
  });

  it('the linked human\'s own thread is read and marked as always, with no next step', async () => {
    const s = setup({ from: 'user_frank' });
    const t = thread((await s.h.run('threads', '--unread')).json);
    expect(t.marked_read).toBe(true);
    expect(t).not.toHaveProperty('next_step');
    expect(s.marked()).toBe(true);
  });

  it('request-approval --for names the message the request concerns', async () => {
    const h = harness({ respond: (c) => (c.path.endsWith('/request-approval') ? { status: 201, body: { request: { request_id: 'har_2' } } } : defaultRespond(c)) });
    await h.run('request-approval', '--for', 'pe_m2', '--description', 'Reply to Ann in thread t9: yes');
    expect(h.calls.find((c) => c.path.endsWith('/request-approval'))?.body).toMatchObject({ subject_pe_id: 'pe_m2', action_description: 'Reply to Ann in thread t9: yes' });
  });
});

describe('threads --unread: the agent reads the mail the daemon delivered ', () => {
  const agentPub = deriveMessageKeyPair(KEY_BARE).pubkeyB64u;
  const sealed = sealThreadMessage('Hey atlas - it\'s the operator', { wallet_aw_bot: agentPub });
  const respond = (c: Call): { status?: number; body: unknown } => {
    if (c.path === '/v1/threads/unread') return { body: { threads: [{ thread_id: 't1' }], count: 1 } };
    if (c.path === '/v1/threads/t1/messages') return { body: {
      thread: { thread_id: 't1', anchor_kind: 'profile', anchor_id: 'wallet_aw_bot', read_cursors: { wallet_aw_bot: 5 }, display_names: { user_frank: 'the operator' } },
      messages: [
        { message_id: 'm_old', author_id: 'user_frank', kind: 'text', ciphertexts: {}, created_at: 4 },
        { message_id: 'm_mine', author_id: 'wallet_aw_bot', kind: 'text', ciphertexts: {}, created_at: 6 },
        { message_id: 'm_new', author_id: 'user_frank', kind: 'text', ciphertexts: { wallet_aw_bot: sealed.ciphertexts.wallet_aw_bot }, created_at: 7 },
      ],
    } };
    return defaultRespond(c);
  };

  it('returns the unread messages decrypted, marks the thread read and clears it from the mailbox', async () => {
    const cleared: string[][] = [];
    let acked = 0;
    const h = harness({ respond, deps: { clearMailbox: (ids) => { cleared.push([...ids]); }, acknowledgeHeartbeat: () => { acked++; } } });
    const r = await h.run('threads', '--unread');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ count: 1, threads: [{ thread_id: 't1', from: 'user_frank', from_name: 'the operator', messages: [{ message_id: 'm_new', text: 'Hey atlas - it\'s the operator' }] }] });
    // Marked read through the newest message fetched (m_new, created_at 7) — one arriving meanwhile stays unread.
    expect(h.calls.find((c) => c.path === '/v1/threads/t1/read' && c.method === 'POST')?.body).toMatchObject({ up_to: 7 });
    expect(cleared).toEqual([['t1']]);
    expect(acked).toBe(1); // the heartbeat check ran here: the read-loop notice is done
  });

  it('pages back past one page: 150 unread are all returned (none silently marked read)', async () => {
    const msg = (i: number) => ({ message_id: `m${i}`, author_id: 'user_frank', kind: 'text', ciphertexts: { wallet_aw_bot: sealed.ciphertexts.wallet_aw_bot }, created_at: 1_000 + i });
    const all = Array.from({ length: 150 }, (_, i) => msg(i));
    const h = harness({ respond: (c) => {
      if (c.path === '/v1/threads/unread') return { body: { threads: [{ thread_id: 't1' }] } };
      if (c.path === '/v1/threads/t1/messages') {
        const before = new URL(c.url).searchParams.get('before');
        const pool = before ? all.filter((m) => m.created_at < Number(before)) : all;
        return { body: { thread: { read_cursors: { wallet_aw_bot: 500 }, display_names: {} }, messages: pool.slice(-100) } };
      }
      return defaultRespond(c);
    } });
    const r = await h.run('threads', '--unread', '--peek');
    expect(r.json.count).toBe(150);
  });

  it('--peek reads without marking read or clearing the mailbox', async () => {
    const cleared: string[][] = [];
    let acked = 0;
    const h = harness({ respond, deps: { clearMailbox: (ids) => { cleared.push([...ids]); }, acknowledgeHeartbeat: () => { acked++; } } });
    const r = await h.run('threads', '--unread', '--peek');
    expect(r.json.count).toBe(1);
    expect(h.calls.some((c) => c.path.endsWith('/read'))).toBe(false);
    expect(cleared).toEqual([]);
    expect(acked).toBe(1); // a peek is still the check running
  });

  it('every verb\'s output carries commons_mail while delivered mail is unread, and none once it is read', async () => {
    let notice: { unread: number; from: string[]; read_with: string } | null = { unread: 1, from: ['the operator'], read_with: 'provian threads --unread' };
    const h = harness({ deps: { mailNotice: () => notice } });
    expect((await h.run('balance')).json.commons_mail).toEqual({ unread: 1, from: ['the operator'], read_with: 'provian threads --unread' });
    notice = null;
    expect((await h.run('balance')).json).not.toHaveProperty('commons_mail');
  });

  it('every verb\'s output carries the witness notice while the observer asks for something, and none after', async () => {
    let notice: { instruction?: string; programs?: string[]; file: string } | null = { instruction: 'Re-record the launcher.', file: '/h/.provian/witness-action-required.json' };
    const h = harness({ deps: { actionNotice: () => notice } });
    expect((await h.run('balance')).json.witness_action_required).toEqual(notice);
    // RED control: the notice cleared, the field is gone.
    notice = null;
    expect((await h.run('balance')).json).not.toHaveProperty('witness_action_required');
    // A reader that throws never fails the verb.
    const broken = harness({ deps: { actionNotice: () => { throw new Error('unreadable'); } } });
    const r = await broken.run('balance');
    expect(r.json).not.toHaveProperty('witness_action_required');
  });
});

describe('Commons verbs drive the relay write that performs the act', () => {
  it('post / reply / vote', async () => {
    const h = harness();
    await h.run('post', '--content', 'hello', '--title', 'T');
    await h.run('reply', '--post', 'p1', '--content', 'yes');
    await h.run('vote', '--post', 'p1', '--direction', 'down');
    expect(h.calls[0]).toMatchObject({ method: 'POST', body: { channel: 'general', content: 'hello', title: 'T' } });
    expect(h.calls[0].path).toMatch(/\/v1\/commons\/forum/);
    expect(h.calls[1].path).toMatch(/p1/);
    expect(h.calls[1].body).toMatchObject({ content: 'yes' });
    expect(h.calls[2].path).toMatch(/p1/);
    expect(JSON.stringify(h.calls[2].body)).toContain('downvote');
  });

  it('want converts --budget-max-pvt to 18-decimal atomic', async () => {
    const h = harness();
    await h.run('want', '--outcome', 'o', '--capabilities', 'a, b', '--budget-max-pvt', '2');
    expect(h.calls[0]).toMatchObject({ path: '/v1/wants', method: 'POST', body: { outcome: 'o', capabilities: ['a', 'b'], budget_max_pvt: '2000000000000000000' } });
  });

  it('job-post (PVT) posts seeking + budget_pvt atomic to the one Commons board', async () => {
    const h = harness();
    await h.run('job-post', '--currency', 'pvt', '--seeking', 'human', '--budget', '10', '--title', 't', '--description', 'd', '--deadline-hours', '48', '--skills', 'x,y');
    expect(h.calls[0].path).toBe('/v1/commons/jobs/post');
    expect(h.calls[0].body).toMatchObject({ seeking: 'human', currency: 'pvt', budget_pvt: '10000000000000000000', skills_required: ['x', 'y'], deadline_hours: 48 });
  });

  it('job-apply / job-accept / job-deliver / job-release --record-only hit their routes', async () => {
    const h = harness();
    await h.run('job-apply', '--job', 'hjob_9', '--proposal', 'p');
    await h.run('job-accept', '--job', 'hjob_9', '--applicant', 'wallet_aw_x');
    await h.run('job-deliver', '--job', 'hjob_9', '--body', 'the work');
    await h.run('job-release', '--job', 'hjob_9', '--record-only');
    expect(h.calls.map((c) => c.path)).toEqual([
      '/v1/commons/jobs/hjob_9/apply', '/v1/commons/jobs/hjob_9/accept', '/v1/commons/jobs/hjob_9/deliver', '/v1/commons/jobs/hjob_9/complete',
    ]);
    expect(h.calls[0].body).toMatchObject({ cover_note: 'p' });
    expect(JSON.stringify(h.calls[2].body)).toContain('the work');
  });

  it('job-deliver refuses an empty deliverable before the network', async () => {
    const h = harness();
    const r = await h.run('job-deliver', '--job', 'hjob_9');
    expect(r.code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('speech-window with no live window reports state and the --open hint (no burn, no key)', async () => {
    const h = harness();
    const r = await h.run('speech-window');
    expect(r.json).toMatchObject({ audience: 'provian:commons', state: 'none' });
    expect(String(r.json.hint)).toMatch(/--open/);
    expect(h.keyUses()).toBe(0);
  });

  it('a 428 from a Commons write surfaces the speech-window hint', async () => {
    const h = harness({ respond: () => ({ status: 428, body: { error: 'speech window required', code: 'rail_handshake_required', present_to: 'provian:commons' } }) });
    const r = await h.run('post', '--content', 'x');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'error', http_status: 428, relay_code: 'rail_handshake_required', present_to: 'provian:commons' });
    expect(String(r.json.hint)).toMatch(/speech-window --open/);
  });

  it('present --pe <pe_id> sends the PE and its anchored inclusion from this machine\'s store (the relay keeps no PE)', async () => {
    const { store, pes } = await anchoredStore();
    const h = harness({
      deps: { openPeStore: () => ({ ok: true, store }) },
      respond: (c) => (c.path.endsWith('/present') ? { body: { tier: 'pe_fact', token: 'tok', presentation: {} } } : defaultRespond(c)),
    });
    const r = await h.run('present', '--burn-id', 'burn_1', '--audience', 'wallet_aw_req', '--challenge', 'c'.repeat(32), '--pe', pes[1].pe_id);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ tier: 'pe_fact', token: 'tok' });
    const present = h.calls.find((c) => c.path.endsWith('/present'));
    const facts = (present?.body as { pe_facts?: Record<string, unknown>[] }).pe_facts;
    expect(facts).toHaveLength(1);
    expect(facts![0]).toMatchObject({ pe_id: pes[1].pe_id, envelope_hash: pes[1].pe_hash, pe: pes[1] });
    expect(facts![0].inclusion).toMatchObject({ act_index: 1, batch: { seq: 1 }, anchor: { day: '2026-10-02' } });
  });

  it('RED: present --pe for a PE this machine does not hold, or not yet anchored, refuses before any call', async () => {
    const unanchored = await anchoredStore({ anchored: false });
    for (const [store, pe] of [[unanchored.store, 'pe_elsewhere'], [unanchored.store, unanchored.pes[0].pe_id]] as const) {
      const h = harness({ deps: { openPeStore: () => ({ ok: true, store }) } });
      const r = await h.run('present', '--burn-id', 'burn_1', '--audience', 'wallet_aw_req', '--challenge', 'c'.repeat(32), '--pe', pe);
      expect(r.code).toBe(2);
      expect(String(r.json.error)).toMatch(/Cannot present/);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('respond forwards a new 50 PVT amount without treating it as a resumed burn', async () => {
    const response = { token: 'tok', tier: 'reputation', burnId: 'burn', txHash: TX, burnAmountAtomic: '50000000000000000000', presentation: {}, requesterVerdict: { status: 'unverified' } } as Awaited<ReturnType<CommonsInstitutions['respondToChallenge']>>;
    const spy = vi.spyOn(CommonsInstitutions.prototype, 'respondToChallenge').mockResolvedValue(response);
    try {
      const h = harness(); const r = await h.run('respond', '--challenge-json', JSON.stringify({ audience: 'gate', challenge: 'c'.repeat(32) }),
        '--tier', 'reputation', '--yes', '--burn-amount-atomic', '50000000000000000000');
      expect(r.code).toBe(0);
      expect(spy.mock.calls[0][1]).toMatchObject({ burnAmountAtomic: '50000000000000000000' });
      expect(spy.mock.calls[0][1].burnTx).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('respond without --yes burns nothing and never touches the key', async () => {
    const h = harness();
    const r = await h.run('respond', '--challenge-json', JSON.stringify({ audience: 'wallet_aw_req', challenge: 'c'.repeat(32) }));
    expect(r.code).toBe(2);
    expect(String(r.json.error)).toMatch(/--yes/);
    expect(h.keyUses()).toBe(0);
    expect(h.calls).toHaveLength(0);
  });
});

describe('On-chain verbs', () => {
  it('balance reads the relay (no RPC, no key)', async () => {
    const h = harness();
    const r = await h.run('balance');
    expect(r.json).toMatchObject({ address: ADDRESS, pvt: '99', eth: '0.001', usdc: '0' });
    expect(h.keyUses()).toBe(0);
  });

  it('transfer: signs with the own key, waits for the relay\'s 12-block floor, records a chain-verified PE', async () => {
    const h = harness();
    const r = await h.run('transfer', '--token', 'usdc', '--to', RECIPIENT, '--amount', '1.5');
    expect(h.transferToken).toHaveBeenCalledTimes(1);
    const [wallet, params] = h.transferToken.mock.calls[0] as unknown as [{ address: string }, Record<string, unknown>];
    expect(wallet.address.toLowerCase()).toBe(ADDRESS.toLowerCase());
    expect(params).toMatchObject({ token: 'USDC', to: RECIPIENT, amount: 1_500_000n, chain: 'base', rpcUrl: 'https://mainnet.base.org', waitForReceipt: true });
    expect((h.waitForReceipt.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({ hash: TX, confirmations: 12 });
    expect(h.calls[0]).toMatchObject({ path: '/v1/agent/wallet/wallet_aw_bot/transfer/record', body: { tx_hash: TX, chain: 'base', currency: 'usdc', to: RECIPIENT, amount_atomic: '1500000' } });
    expect(r.json).toMatchObject({ tx_hash: TX, pe_id: 'pe_transfer', verified: true });
  });

  it('transfer --record-tx re-records without broadcasting (resume)', async () => {
    const h = harness();
    await h.run('transfer', '--token', 'PVT', '--to', RECIPIENT, '--amount-atomic', '7', '--record-tx', TX);
    expect(h.transferToken).not.toHaveBeenCalled();
    expect(h.calls[0].body).toMatchObject({ currency: 'pvt', amount_atomic: '7' });
  });

  it('transfer-native records currency native with the wei amount; --rpc-url overrides the default', async () => {
    const h = harness();
    await h.run('transfer-native', '--to', RECIPIENT, '--amount', '0.001', '--rpc-url', 'https://my.rpc');
    expect((h.transferNative.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({ amount: 10n ** 15n, rpcUrl: 'https://my.rpc' });
    expect(h.calls[0].body).toMatchObject({ currency: 'native', amount_atomic: '1000000000000000' });
  });

  it('a record that fails after broadcast prints the resume line — never a re-send', async () => {
    const h = harness({ respond: () => ({ status: 400, body: { error: 'On-chain transfer verification failed', reason: 'amount_mismatch' } }) });
    const r = await h.run('transfer', '--token', 'USDC', '--to', RECIPIENT, '--amount', '1');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'error', broadcast: true, tx_hash: TX });
    expect(String(r.json.error)).toContain(`--record-tx ${TX}`);
    expect(h.transferToken).toHaveBeenCalledTimes(1);
  });

  it('burn --tx-hash records the burn (await_finality) and returns the burn_id', async () => {
    const h = harness();
    const r = await h.run('burn', '--tx-hash', TX, '--amount', '5');
    expect(h.calls[0]).toMatchObject({ path: '/v1/agent/wallet/wallet_aw_bot/burn/record', body: { tx_hash: TX, chain: 'base', amount_atomic: '5000000000000000000', await_finality: true } });
    expect(r.json).toMatchObject({ burn_id: 'burn_1', verified: true });
  });

  it('transfer refuses a token outside the allowlist and a malformed recipient, before any key use', async () => {
    const h = harness();
    expect((await h.run('transfer', '--token', 'DAI', '--to', RECIPIENT, '--amount', '1')).code).toBe(2);
    expect((await h.run('transfer', '--token', 'USDC', '--to', '0xnope', '--amount', '1')).code).toBe(2);
    expect(h.keyUses()).toBe(0);
    expect((TOKEN_ALLOWLIST.base as Record<string, unknown>).DAI).toBeUndefined();
  });

  it('x402-fetch pays through the wrapped fetch with the named ceiling and records nothing', async () => {
    const h = harness();
    const r = await h.run('x402-fetch', 'https://seller.test/paid', '--max-usdc', '0.25');
    expect(h.makeX402Fetch).toHaveBeenCalledTimes(1);
    expect((h.makeX402Fetch.mock.calls[0] as unknown as [string, unknown, bigint])[2]).toBe(250_000n);
    expect(r.json).toMatchObject({ status: 200, body: 'paid body', payment_response: 'settled' });
    expect(h.calls).toHaveLength(0);
  });

  it('RED: x402-fetch refuses a private / non-HTTPS target before the key is touched (egress guard)', async () => {
    const h = harness();
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://127.0.0.1/x', 'https://10.0.0.5/pay']) {
      const r = await h.run('x402-fetch', url, '--max-usdc', '1');
      expect(r.code).toBe(2);
      expect(String(r.json.error)).toMatch(/Refusing to fetch/);
    }
    expect(h.keyUses()).toBe(0);
    expect(h.makeX402Fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Credential safety
// ---------------------------------------------------------------------------

describe('CREDENTIAL SAFETY — the key and the API secret never reach the output', () => {
  const leakyMessage = `signer exploded with 0x${KEY_BARE} / ${KEY_BARE} / ${KEY_BARE.toUpperCase()} and auth ${API_SECRET}`;

  it('an error that carries the key and the secret is scrubbed', async () => {
    const thrown: string[] = [];
    const h = harness({
      deps: {
        transferToken: (async () => { const e = new Error(leakyMessage); thrown.push(e.message); throw e; }) as unknown as ActDeps['transferToken'],
      },
    });
    const r = await h.run('transfer', '--token', 'USDC', '--to', RECIPIENT, '--amount', '1');
    // RED control: the raw error really did carry every secret…
    expect(thrown[0]).toContain(KEY_BARE);
    expect(thrown[0]).toContain(API_SECRET);
    // …and none of it reached stdout.
    expect(r.code).toBe(1);
    expect(r.text).not.toContain(KEY_BARE);
    expect(r.text.toLowerCase()).not.toContain(KEY_BARE.toLowerCase());
    expect(r.text).not.toContain(API_SECRET);
    expect(r.text).toContain('[redacted]');
  });

  it('a successful result never contains the key or the secret (sweep)', async () => {
    const h = harness();
    for (const [verb, args] of RELAY_SWEEP) {
      const r = await h.run(verb, ...args);
      expect(r.text.toLowerCase()).not.toContain(KEY_BARE.toLowerCase());
      expect(r.text).not.toContain(API_SECRET);
    }
  });

  it('RED control: without the scrubber the key would print', () => {
    expect(scrubSecrets(leakyMessage, [])).toContain(KEY_BARE);
    expect(scrubSecrets(leakyMessage, [KEY_BARE, API_SECRET])).not.toMatch(new RegExp(KEY_BARE, 'i'));
  });

  it('--help needs no identity at all', async () => {
    const loadAgent = vi.fn(() => { throw new Error('should not load'); });
    const h = harness({ deps: { loadAgent } });
    const r = await h.run('swap', '--help');
    expect(r.code).toBe(0);
    expect(String(r.json.usage)).toMatch(/^provian swap/);
    expect(loadAgent).not.toHaveBeenCalled();
  });
});

// — `provian payout`: quote by default; --yes pays the flat $1 over x402 with a
// $1 ceiling; nothing is paid without --yes or when the relay has nothing to settle.
describe('payout verb (on-demand payout)', () => {
  const quote402 = (c: Call) => (c.path === '/v1/payout'
    ? { status: 402, body: { x402Version: 2, accepts: [], ready: { claims: 2, record_points_atomic: '800' }, estimated_gas_usd: 0.03 } }
    : defaultRespond(c));

  it('without --yes: shows the quote and pays nothing', async () => {
    const h = harness({ respond: quote402 });
    const r = await h.run('payout');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ available: true, fee_usdc: '1.00', ready_claims: 2, ready_record_points_atomic: '800', meter_flush: 'sent' });
    expect(h.flushMeter).toHaveBeenCalledTimes(1); // the latest acts reach the relay before the quote
    expect(h.makeX402Fetch).not.toHaveBeenCalled();
    expect(h.keyUses()).toBe(0);
  });

  it('--yes: pays through the x402 fetch with exactly the $1 ceiling', async () => {
    const paid = vi.fn(async () => new Response(JSON.stringify({ request_id: 'po_x', state: 'settled', charge_tx_hash: TX, settlement: { claims_settled: 1 } }), { status: 200 }));
    const h = harness({ respond: quote402, deps: { makeX402Fetch: vi.fn(() => paid as unknown as typeof fetch) } });
    const r = await h.run('payout', '--yes');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ request_id: 'po_x', state: 'settled', charge_tx_hash: TX });
    const make = h.deps.makeX402Fetch as unknown as ReturnType<typeof vi.fn>;
    expect((make.mock.calls[0] as unknown as [string, unknown, bigint])[2]).toBe(1_000_000n);
    // The fee's terms are pinned: only $1 to Provian's revenue wallet on Base is signed.
    expect((make.mock.calls[0] as unknown as [string, unknown, bigint, unknown])[3]).toEqual(provianServiceFeePin(1_000_000n));
    // the paid request may outlast the 30 s default (the charge's Base receipt).
    expect((make.mock.calls[0] as unknown as [string, unknown, bigint, unknown, { requestTimeoutMs?: number }])[4]?.requestTimeoutMs).toBe(120_000);
    expect(paid).toHaveBeenCalledTimes(1);
  });

  // the relay answers once the fee is charged; a charged payout is never reported as an error.
  const NONCE = `0x${'ab'.repeat(32)}`;
  // The relay's own derivation, pinned in provian-backend/src/core/payout/payout-terms.test.ts.
  const SENT_ID = 'po_f450773f249c1506318221c07fbe37f0c38d6d93';
  const paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 2, accepted: {}, payload: { signature: '0x', authorization: { from: ADDRESS, to: RECIPIENT, value: '1000000', validAfter: '0', validBefore: '9', nonce: NONCE } },
  })).toString('base64');
  type X402Opts = { requestTimeoutMs?: number; onPaymentSent?: (p: string) => void };
  const sentThenFails = (error: Error) => vi.fn((_r: string, _w: unknown, _m: bigint, _p: unknown, opts?: X402Opts) => (async () => {
    opts?.onPaymentSent?.(paymentHeader);
    throw error;
  }) as unknown as typeof fetch);
  const timedOut = () => new ProvianError('x402 request timed out after 120000ms', 'X402_REQUEST_FAILED');

  it('the SDK derives the relay\'s request id from the payment it sent', () => {
    expect(payoutRequestIdOfPayment(paymentHeader)).toBe(SENT_ID);
    expect(payoutRequestIdOfPayment('not-a-payment')).toBeNull();
  });

  it('a charged payout answers with its request and the command to follow it', async () => {
    const paid = vi.fn(async () => new Response(JSON.stringify({ request_id: SENT_ID, state: 'charged', charge_tx_hash: TX, settlement: null }), { status: 202 }));
    const h = harness({ respond: quote402, deps: { makeX402Fetch: vi.fn(() => paid as unknown as typeof fetch) } });
    const r = await h.run('payout', '--yes');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ request_id: SENT_ID, state: 'charged', charge_tx_hash: TX, next_step: `provian payout --request ${SENT_ID}` });
  });

  it('RED: a paid request whose answer times out is read back by the id its payment fixes — the charged request, never an error', async () => {
    const h = harness({
      respond: (c) => (c.path === `/v1/payout/${SENT_ID}`
        ? { body: { request_id: SENT_ID, state: 'charged', charge_tx_hash: TX, waiting_reason: null, settlement: null, note: 'Charged.' } }
        : quote402(c)),
      deps: { makeX402Fetch: sentThenFails(timedOut()) },
    });
    const r = await h.run('payout', '--yes');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ request_id: SENT_ID, state: 'charged', charge_tx_hash: TX, next_step: `provian payout --request ${SENT_ID}` });
    expect(r.json.status).toBeUndefined();
    expect(h.calls.filter((c) => c.path === `/v1/payout/${SENT_ID}` && c.method === 'GET')).toHaveLength(1);
  });

  it('RED: the read-back finds no request → the error names the request to follow', async () => {
    const h = harness({
      respond: (c) => (c.path === `/v1/payout/${SENT_ID}` ? { status: 404, body: { error: 'not_found' } } : quote402(c)),
      deps: { makeX402Fetch: sentThenFails(timedOut()) },
    });
    const r = await h.run('payout', '--yes');
    expect(r.code).not.toBe(0);
    expect(r.json).toMatchObject({ status: 'error', code: 'X402_REQUEST_FAILED' });
    expect(String(r.json.error)).toContain(`provian payout --request ${SENT_ID}`);
  });

  it('a payment the relay rejected (and recorded nothing for) stays a plain rejection', async () => {
    const h = harness({
      respond: (c) => (c.path === `/v1/payout/${SENT_ID}` ? { status: 404, body: { error: 'not_found' } } : quote402(c)),
      deps: { makeX402Fetch: sentThenFails(new ProvianError('x402 payment was rejected by the server', 'X402_PAYMENT_REJECTED')) },
    });
    const r = await h.run('payout', '--yes');
    expect(r.json).toMatchObject({ status: 'error', code: 'X402_PAYMENT_REJECTED', error: 'x402 payment was rejected by the server' });
  });

  it('RED: a read-back that finds the charge failed keeps the rejection — a failed payout never exits 0', async () => {
    const h = harness({
      respond: (c) => (c.path === `/v1/payout/${SENT_ID}`
        ? { body: { request_id: SENT_ID, state: 'charge_failed', charge_tx_hash: TX, waiting_reason: null, settlement: null, note: 'The fee was not taken. Nothing was charged.' } }
        : quote402(c)),
      deps: { makeX402Fetch: sentThenFails(new ProvianError('x402 payment was rejected by the server', 'X402_PAYMENT_REJECTED')) },
    });
    const r = await h.run('payout', '--yes');
    expect(r.code).not.toBe(0);
    expect(r.json).toMatchObject({ status: 'error', code: 'X402_PAYMENT_REJECTED', error: 'x402 payment was rejected by the server' });
  });

  it('no payment went out → the error stands and no request is read', async () => {
    const h = harness({ respond: quote402, deps: { makeX402Fetch: vi.fn(() => (async () => { throw timedOut(); }) as unknown as typeof fetch) } });
    const r = await h.run('payout', '--yes');
    expect(r.json).toMatchObject({ status: 'error', code: 'X402_REQUEST_FAILED', error: 'x402 request timed out after 120000ms' });
    expect(h.calls.filter((c) => c.path.startsWith('/v1/payout/po_'))).toHaveLength(0);
  });

  it('the default x402 fetch applies the deadline and reports the payment as it goes out', async () => {
    const requirement = { scheme: 'exact', network: 'eip155:8453', amount: '1000000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x086e0F377af1245B8888540f39e99A42a7daF1dA', maxTimeoutSeconds: 300 };
    const relay = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (new Headers(init?.headers).get('payment-signature') === null) {
        return new Response(JSON.stringify({ x402Version: 2, resource: { url: 'https://relay.test/v1/payout' }, accepts: [requirement] }), { status: 402, headers: { 'content-type': 'application/json' } });
      }
      // The paid request hangs past the deadline.
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    vi.stubGlobal('fetch', relay);
    try {
      const sent: string[] = [];
      const wallet = { privateKeyHex: `0x${KEY_BARE}`, address: ADDRESS };
      const paidFetch = defaultActDeps().makeX402Fetch('https://relay.test', wallet, 1_000_000n, provianServiceFeePin(1_000_000n), {
        requestTimeoutMs: 50, onPaymentSent: (p) => sent.push(p),
      });
      await expect(paidFetch('https://relay.test/v1/payout', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'X402_REQUEST_FAILED', message: 'x402 request timed out after 50ms' });
      expect(relay).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(1);
      expect(payoutRequestIdOfPayment(sent[0])).toMatch(/^po_[0-9a-f]{40}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('archive pay --yes: pays through the x402 fetch with the $5 ceiling and the pinned terms', async () => {
    const archiveQuote = (c: Call) => (c.path === '/v1/archive/pay'
      ? { status: 402, body: { x402Version: 2, accepts: [], archive: { on: false, paid_bytes: 0, used_bytes: 0 } } }
      : defaultRespond(c));
    const paid = vi.fn(async () => new Response(JSON.stringify({ request_id: 'ap_x', state: 'charged', credited: true, charge_tx_hash: TX }), { status: 200 }));
    const h = harness({ respond: archiveQuote, deps: { makeX402Fetch: vi.fn(() => paid as unknown as typeof fetch) } });
    const r = await h.run('archive', 'pay', '--yes');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ request_id: 'ap_x', state: 'charged', credited: true });
    const call = (h.deps.makeX402Fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, unknown, bigint, unknown];
    expect(call[2]).toBe(5_000_000n);
    expect(call[3]).toEqual({ network: 'eip155:8453', payTo: '0x086e0F377af1245B8888540f39e99A42a7daF1dA', amountAtomic: 5_000_000n });
  });

  it('the default x402 fetch passes the pin through to wrapFetchWithX402 (RED: a 402 to another recipient is refused)', async () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const seller402 = vi.fn(async () => new Response(JSON.stringify({ x402Version: 2, resource: { url: 'https://relay.test/v1/payout' }, accepts: [{
      scheme: 'exact', network: 'eip155:8453', amount: '1000000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: other, maxTimeoutSeconds: 300,
    }] }), { status: 402, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', seller402);
    try {
      const wallet = { privateKeyHex: `0x${KEY_BARE}`, address: ADDRESS };
      const pinnedFetch = defaultActDeps().makeX402Fetch('https://relay.test', wallet, 1_000_000n, provianServiceFeePin(1_000_000n));
      await expect(pinnedFetch('https://relay.test/v1/payout', { method: 'POST' })).rejects.toMatchObject({ code: 'X402_NO_COMPATIBLE_OPTION' });
      expect(seller402).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('RED: nothing to pay → no key, no payment, even with --yes', async () => {
    const h = harness({ respond: (c) => (c.path === '/v1/payout' ? { status: 409, body: { error: 'nothing_to_pay', message: 'No earnings are ready' } } : defaultRespond(c)) });
    const r = await h.run('payout', '--yes');
    expect(r.json).toMatchObject({ available: false, reason: 'nothing_to_pay' });
    expect(h.makeX402Fetch).not.toHaveBeenCalled();
    expect(h.keyUses()).toBe(0);
  });
});

describe('sign-output (: every output carries its signature)', () => {
  it('signs --text with the agent\'s own key, locally: the header value decodes to a signature that recovers to the agent', async () => {
    const h = harness();
    const r = await h.run('sign-output', '--text', 'a report');
    expect(r.code).toBe(0);
    expect(h.calls).toEqual([]); // nothing goes to the relay
    expect(h.keyUses()).toBe(1);
    const sig = decodeOutputSignatureHeader(r.json.header_value);
    expect(sig).toEqual(signOutputWithWalletKey(KEY_BARE, 'a report'));
    expect(sig!.signer.id).toBe(ADDRESS.toLowerCase());
    expect(walletOutputSignatureRecovers(sig!)).toBe(true);
    expect(r.json.header_name).toBe('Provian-Output-Signature');
  });

  it('RED — neither or both of --file / --text is a usage error and signs nothing', async () => {
    const h = harness();
    expect((await h.run('sign-output')).code).not.toBe(0);
    expect((await h.run('sign-output', '--text', 'a', '--file', '/nonexistent')).code).not.toBe(0);
    expect(h.keyUses()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Your PEs — export and verify (PE export, docs/PE_PROTOCOL_SPEC.md §14)
// ---------------------------------------------------------------------------

describe('Your PEs: export-pes and verify-export', () => {
  it('help lists both under "Your PEs"', () => {
    const text = renderActHelp().join('\n');
    expect(text).toMatch(/Your PEs \(/);
    expect(text.indexOf('Your PEs (')).toBeLessThan(text.indexOf('  export-pes '));
    expect(ACT_VERBS.filter((v) => v.group === 'Your PEs').map((v) => v.name)).toEqual(['export-pes', 'verify-export']);
  });

  it('export-pes runs the export without the agent API identity and passes --out; a failed self-check exits 1', async () => {
    const exportPes = vi.fn(async (o: { out?: string | null }) => ({ status: 'ok', path: o.out ?? 'default.jsonl', counts: { pe: 1, batch: 1, received: 1, legacy: 1 } }) as never);
    const loadAgent = vi.fn(() => { throw new Error('the export must not need the agent API identity'); });
    const h = harness({ deps: { exportPes, loadAgent } });
    const ok = await h.run('export-pes', '--out', '/tmp/x.jsonl');
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ status: 'ok', path: '/tmp/x.jsonl' });
    expect(exportPes).toHaveBeenCalledWith({ out: '/tmp/x.jsonl' });
    expect(loadAgent).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    const corrupt = harness({ deps: { exportPes: async () => ({ status: 'error', warning: 'THE LOCAL PE STORE IS CORRUPT' }) as never, loadAgent } });
    expect((await corrupt.run('export-pes')).code).toBe(1);
  });

  it('verify-export passes the file, the RPC and --offline; a failed verdict exits 1, a missing file argument is a usage error', async () => {
    const verifyExport = vi.fn(async (file: string, o: { rpcUrl?: string; offline?: boolean }) => ({ verdict: o.offline ? 'offline_ok' : 'ok', file }) as never);
    const h = harness({ deps: { verifyExport, env: { PROVIAN_BASE_RPC_URL: 'https://rpc.example' } } });
    expect((await h.run('verify-export', 'e.jsonl')).json).toMatchObject({ status: 'ok', verdict: 'ok', file: 'e.jsonl' });
    expect(verifyExport).toHaveBeenLastCalledWith('e.jsonl', { offline: false, rpcUrl: 'https://rpc.example' });
    await h.run('verify-export', 'e.jsonl', '--rpc-url', 'https://other.example', '--offline');
    expect(verifyExport).toHaveBeenLastCalledWith('e.jsonl', { offline: true });
    const failed = harness({ deps: { verifyExport: async () => ({ verdict: 'failed' }) as never } });
    expect((await failed.run('verify-export', 'e.jsonl')).code).toBe(1);
    expect((await h.run('verify-export')).code).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('RED: verify-export on an incomplete export exits 3 with status incomplete and prints what is missing — never 0', async () => {
    const missing = ['mailbox: 2 PE(s) sealed to this agent still waiting on the relay — no_message_key_here: x'];
    for (const verdict of ['incomplete', 'offline_incomplete'] as const) {
      const h = harness({ deps: { verifyExport: async () => ({ verdict, missing, incomplete: [{ what: 'mailbox', reason: 'x' }] }) as never } });
      const r = await h.run('verify-export', 'e.jsonl');
      expect(r.code).toBe(3);
      expect(r.json).toMatchObject({ status: 'incomplete', verdict, missing });
    }
    // The control: the same harness on a clean verdict exits 0.
    const clean = harness({ deps: { verifyExport: async () => ({ verdict: 'offline_ok', missing: [], incomplete: [] }) as never } });
    expect((await clean.run('verify-export', 'e.jsonl', '--offline')).code).toBe(0);
    expect(verifyStatusOf('ok')).toBe('ok');
    expect(verifyStatusOf('failed')).toBe('error');
  });
});


describe('hosted Commons reply retries',()=>{
 it('passes the sender retry key through the installed wrapper path',async()=>{
  const send=vi.spyOn(CommonsInstitutions.prototype,'sendEncryptedThreadMessage').mockResolvedValueOnce({message:{message_id:'msg_one'}});
  const h=harness();
  try{
   await h.run('thread-send','--thread','thr_one','--text','reply','--idempotency-key','commons-reply:msg_original');
   expect(send).toHaveBeenCalledWith('thr_one','reply',KEY_BARE,{idempotencyKey:'commons-reply:msg_original'});
  }finally{send.mockRestore();}
 });
});
