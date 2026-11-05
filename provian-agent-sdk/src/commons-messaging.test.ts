import { withThreadOutputSignature, outputHashOfText, type OutputSignature } from './output-signature';
/**
 * Agents reachable by default : the agent-side key self-heal and the inbox →
 * local mailbox delivery (commons-messaging.ts). Real thread crypto, a fake relay, a temp home.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeCommonsHeartbeat, actionRequiredPath, clearMailboxThreads, commonsHeartbeatAcknowledged, deliverThreadMessagesOnce, lastReplyPolicy,
  ensureCommonsMessageKey, INBOX_LOOKBACK_MS, MAILBOX_MAX, MAILBOX_RECONCILE_MS, mailboxPath, readMailbox, startCommonsMessageKeyHeal,
  COMMONS_HEARTBEAT_VERSION, startThreadDelivery, syncCommonsHeartbeatNotice, unreadMailNotice, type CommonsMessagingRelay,
} from './commons-messaging';
import { cliCommand } from './cli-command';
import { commonsHeartbeatInstruction, witnessSetupLines } from './witness-setup';
import { deriveMessageKeyPair, sealThreadMessage } from './thread-crypto';
import type { AgentInboxEvent } from './commons-institutions';

const AGENT = 'wallet_aw_atlas';
const FRANK = 'user_frank';
const agentKey = deriveMessageKeyPair(randomBytes(32).toString('hex'));
const frankKey = deriveMessageKeyPair(randomBytes(32).toString('hex'));

const homes: string[] = [];
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'provian-msg-')); homes.push(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const evId = (ms: number, suffix = randomBytes(6).toString('hex')): string => `${String(ms).padStart(15, '0')}_${suffix}`;

/** A relay with one profile thread between the operator and Atlas, an inbox, and a key registry. */
function fakeRelay(opts: { joined?: boolean; excluded?: boolean; heldKey?: string | null } = {}) {
  const inbox: AgentInboxEvent[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const thread = { thread_id: 't1', party_a: FRANK, party_b: AGENT, anchor_kind: 'profile', anchor_id: AGENT, read_cursors: {} as Record<string, number>, display_names: { [FRANK]: 'the operator', [AGENT]: 'Atlas' }, last_message_at: 0 };
  let held = opts.heldKey ?? null;
  const published: string[] = [];
  const relay: CommonsMessagingRelay & { published: string[] } = {
    published,
    readJoinContext: vi.fn(async () => ({ already_joined: opts.joined ?? true, excluded_from_public: opts.excluded ?? false })),
    readMessageKey: vi.fn(async () => (held ? { pubkey_b64u: held, key_version: 1 } : null)),
    publishMessageKey: vi.fn(async (k: string) => { held = k; published.push(k); return {}; }),
    readInbox: vi.fn(async ({ cursor, limit }: { cursor?: string; limit?: number }) => {
      const sorted = [...inbox].sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
      const after = cursor ? sorted.filter((e) => e.event_id > cursor) : sorted;
      const page = after.slice(0, limit ?? 50);
      return { events: page, next_cursor: page.length === (limit ?? 50) ? page[page.length - 1].event_id : null };
    }),
    getThreadMessages: vi.fn(async () => ({ thread, messages })),
    unreadThreads: vi.fn(async () => ({ threads: thread.last_message_at > (thread.read_cursors[AGENT] ?? 0) ? [thread] : [] })),
  };
  /** the operator sends a sealed message; the relay stores it and writes the agent's inbox event at `eventMs`. */
  const send = (text: string, at: number, eventMs: number = at, author = FRANK): string => {
    const sealed = sealThreadMessage(text, { [FRANK]: frankKey.pubkeyB64u, [AGENT]: agentKey.pubkeyB64u });
    const message_id = `m_${messages.length + 1}`;
    messages.push({ message_id, author_id: author, kind: 'text', ciphertexts: sealed.ciphertexts, created_at: at });
    thread.last_message_at = Math.max(thread.last_message_at, at);
    if (author !== AGENT) {
      inbox.push({ event_id: evId(eventMs), event: 'thread_message', entity_id: 't1', entity_type: 'thread', counterparty_wallet: author, actor_wallet_id: author, amount: 0, amount_unit: 'pvt_whole', data: { thread_id: 't1', message_id }, created_at: eventMs });
    }
    return message_id;
  };
  const other = (ms: number) => inbox.push({ event_id: evId(ms), event: 'job_posted', entity_id: 'j1', entity_type: 'job', counterparty_wallet: null, actor_wallet_id: null, amount: 0, amount_unit: null, data: {}, created_at: ms });
  return { relay, send, other, thread, messages };
}

const secret = () => async () => new Uint8Array(agentKey.secretKey);

describe('ensureCommonsMessageKey — joining = reachable, for agents already in the Commons', () => {
  it('publishes when the relay holds no key', async () => {
    const { relay } = fakeRelay({ heldKey: null });
    expect(await ensureCommonsMessageKey(relay, AGENT, agentKey.pubkeyB64u)).toBe('published');
    expect(relay.published).toEqual([agentKey.pubkeyB64u]);
  });

  it('re-publishes when the relay holds a DIFFERENT key (rotation)', async () => {
    const { relay } = fakeRelay({ heldKey: frankKey.pubkeyB64u });
    expect(await ensureCommonsMessageKey(relay, AGENT, agentKey.pubkeyB64u)).toBe('published');
    expect(relay.published).toEqual([agentKey.pubkeyB64u]);
  });

  it('is a no-op when the relay already holds the current key', async () => {
    const { relay } = fakeRelay({ heldKey: agentKey.pubkeyB64u });
    expect(await ensureCommonsMessageKey(relay, AGENT, agentKey.pubkeyB64u)).toBe('already_current');
    expect(relay.published).toEqual([]);
  });

  it('RED: an agent that is NOT in the Commons (opted out) publishes nothing', async () => {
    const { relay } = fakeRelay({ joined: false });
    expect(await ensureCommonsMessageKey(relay, AGENT, agentKey.pubkeyB64u)).toBe('not_in_commons');
    expect(relay.publishMessageKey).not.toHaveBeenCalled();
  });

  it('a test-platform agent (excluded from the public Commons) publishes nothing', async () => {
    const { relay } = fakeRelay({ joined: true, excluded: true });
    expect(await ensureCommonsMessageKey(relay, AGENT, agentKey.pubkeyB64u)).toBe('not_in_commons');
    expect(relay.publishMessageKey).not.toHaveBeenCalled();
  });

  it('no keystore here → no_key_here; a relay failure → failed (never throws)', async () => {
    expect(await ensureCommonsMessageKey(fakeRelay().relay, AGENT, null)).toBe('no_key_here');
    const broken = { ...fakeRelay().relay, readJoinContext: async () => { throw new Error('ECONNREFUSED'); } };
    expect(await ensureCommonsMessageKey(broken, AGENT, agentKey.pubkeyB64u)).toBe('failed');
  });

  it('the startup heal retries after a failure and settles once the relay answers', async () => {
    const { relay } = fakeRelay({ heldKey: null });
    let calls = 0;
    const flaky = { ...relay, readJoinContext: async () => { calls += 1; if (calls === 1) throw new Error('down'); return { already_joined: true }; } };
    const lines: string[] = [];
    const h = startCommonsMessageKeyHeal({ relay: flaky, walletId: AGENT, pubkey: async () => agentKey.pubkeyB64u }, { retryMs: 5, log: (l) => lines.push(l) });
    expect(await h.done).toBe('published');
    expect(calls).toBe(2);
    expect(relay.published).toEqual([agentKey.pubkeyB64u]);
    expect(lines.join('\n')).toMatch(/message key published/);
  });
});

describe('deliverThreadMessagesOnce — a thread message reaches the agent, not merely the relay', () => {
  it('first pass on a machine: delivers what is unread on the relay and does not replay inbox history', async () => {
    const h = home();
    const { relay, send, other } = fakeRelay();
    other(1_000);
    send('Hey atlas - just seeing if I can reach you this way. It’s the operator', 2_000);
    const delivered = await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_000 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ thread_id: 't1', author_id: FRANK, author_name: 'the operator', text: 'Hey atlas - just seeing if I can reach you this way. It’s the operator', anchor_kind: 'profile' });
    expect(readMailbox(h).unread.map((m) => m.message_id)).toEqual(['m_1']);
    // The mailbox is private to the agent's user.
    expect(statSync(mailboxPath(h)).mode & 0o077).toBe(0);
    // A second pass with nothing new delivers nothing (the frontier was set past the history).
    expect(await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_100 })).toEqual([]);
  });

  it('a new message after the first pass is pulled from the inbox, opened with the agent key, and delivered once', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 10_000 });
    send('second', 20_000);
    const first = await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 21_000 });
    expect(first.map((m) => m.text)).toEqual(['second']);
    // Re-reading the lookback window never delivers it twice.
    expect(await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 22_000 })).toEqual([]);
    expect(readMailbox(h).unread).toHaveLength(1);
  });

  it('RED (the late-write race): an event the relay writes AFTER a newer one, with an older id, is still delivered', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    const t0 = 5_000_000;
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 });
    send('newer', t0 + 120_000);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 + 121_000 });
    // The outbox drains an earlier message late: its inbox id (its own time) sorts BEFORE the frontier.
    send('older, drained late', t0 + 60_000, t0 + 60_000);
    const late = await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 + 180_000 });
    expect(late.map((m) => m.text)).toEqual(['older, drained late']);
    expect(INBOX_LOOKBACK_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('never delivers the agent\'s own messages; a message it cannot open is delivered with text null', async () => {
    const h = home();
    const { relay, send, messages } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1 });
    send('mine', 10, 10, AGENT);
    const id = send('for another key', 20);
    const m = messages.find((x) => x.message_id === id)!;
    m.ciphertexts = { ...(m.ciphertexts as Record<string, string>), [AGENT]: sealThreadMessage('x', { k: frankKey.pubkeyB64u }).ciphertexts.k };
    const out = await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 30 });
    expect(out.map((x) => [x.message_id, x.text])).toEqual([[id, null]]);
  });

  it('zeroes the secret key it was handed', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    send('hi', 10);
    const buf = new Uint8Array(agentKey.secretKey);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: async () => buf, home: h, now: () => 20 });
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('a relay outage leaves the state untouched, so the next pass still delivers', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1 });
    send('during outage', 10);
    const down = { ...relay, readInbox: async () => { throw new Error('503'); } };
    await expect(deliverThreadMessagesOnce({ relay: down, walletId: AGENT, secretKey: secret(), home: h, now: () => 20 })).rejects.toThrow('503');
    expect((await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 30 })).map((m) => m.text)).toEqual(['during outage']);
  });
});

describe('the mailbox follows what the agent has read ( )', () => {
  it('RED: a message the agent already read on the relay (within the minute) is never delivered', async () => {
    const h = home();
    const { relay, send, thread } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1_000 });
    send('read fast', 2_000);
    thread.read_cursors[AGENT] = 2_500; // threads --unread / a webhook handler read it first
    expect(await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_000 })).toEqual([]);
    expect(unreadMailNotice(h)).toBeNull();
  });

  it('RED: mail read anywhere after delivery (a reply, another client) leaves the mailbox on the next pass', async () => {
    const h = home();
    const { relay, send, thread } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1_000 });
    send('hello', 2_000);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_000 });
    expect(unreadMailNotice(h)?.unread).toBe(1);
    thread.read_cursors[AGENT] = 4_000; // thread-send moved the agent's read cursor
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 5_000 });
    expect(unreadMailNotice(h)).toBeNull();
  });

  it('RED: an unread message whose inbox event was written beyond the lookback is still delivered by the reconcile', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    const t0 = 50_000_000;
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 });
    send('newer', t0 + 3 * INBOX_LOOKBACK_MS);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 + 3 * INBOX_LOOKBACK_MS });
    // An outbox backlog writes an older message's event long after: far behind the lookback.
    send('stuck in a backlog', t0 + 60_000, t0 + 60_000);
    // The inbox pull alone cannot see it (its id sorts far behind the lookback)…
    expect(await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 + 3 * INBOX_LOOKBACK_MS + 60_000 })).toEqual([]);
    // …the next backfill from the relay's unread threads delivers it.
    const out = await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => t0 + 3 * INBOX_LOOKBACK_MS + MAILBOX_RECONCILE_MS });
    expect(out.map((m) => m.text)).toEqual(['stuck in a backlog']);
  });

  it('RED ( ): past the mailbox cap, trimmed messages are never re-delivered', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1 });
    for (let i = 0; i < MAILBOX_MAX + 5; i++) send(`m${i}`, 10 + i);
    // The daemon reads up to 100 per thread page; deliver in passes until all were seen once.
    let total = 0;
    for (let pass = 0; pass < 3; pass++) total += (await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 10_000 + pass * MAILBOX_RECONCILE_MS })).length;
    const after = total;
    expect(readMailbox(h).unread.length).toBeLessThanOrEqual(MAILBOX_MAX);
    // Later backfills deliver nothing again.
    for (let pass = 3; pass < 6; pass++) total += (await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 10_000 + pass * MAILBOX_RECONCILE_MS })).length;
    expect(total).toBe(after);
  });

  it('with nothing waiting, the relay\'s unread list is consulted only every MAILBOX_RECONCILE_MS', async () => {
    const h = home();
    const { relay } = fakeRelay();
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1_000 });
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 61_000 });
    expect(relay.unreadThreads).toHaveBeenCalledTimes(1);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 1_000 + MAILBOX_RECONCILE_MS });
    expect(relay.unreadThreads).toHaveBeenCalledTimes(2);
  });
});

describe('the local mailbox — what the provian verbs announce', () => {
  it('names the unread count and senders, and clears per thread once read', async () => {
    const h = home();
    expect(unreadMailNotice(h)).toBeNull();
    const { relay, send } = fakeRelay();
    send('one', 10);
    send('two', 20);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 30 });
    expect(unreadMailNotice(h)).toEqual({ unread: 2, from: ['the operator'], read_with: cliCommand('threads --unread') });
    expect(clearMailboxThreads(['t1'], h)).toBe(2);
    expect(unreadMailNotice(h)).toBeNull();
  });
});

describe('the daemon starts both on every agent start', () => {
  it('startCommonsMessaging runs the key heal and the inbox delivery for the agent wallet', async () => {
    const { startCommonsMessaging } = await import('./observer/run-daemon.js');
    const keyHeal = vi.fn(() => ({ stop: () => undefined, done: Promise.resolve('already_current' as const) }));
    const delivery = vi.fn(() => ({ stop: () => undefined, tick: async () => undefined }));
    const notice = vi.fn(() => 'none' as const);
    startCommonsMessaging(
      { relayUrl: 'https://relay.test', walletId: AGENT, apiKey: 'k', apiSecret: 's' },
      { keyHeal: keyHeal as never, delivery: delivery as never, notice, pubkey: async () => agentKey.pubkeyB64u, secret: () => async () => null },
    );
    expect(keyHeal).toHaveBeenCalledTimes(1);
    expect((keyHeal.mock.calls[0] as unknown[])[0]).toMatchObject({ walletId: AGENT });
    expect(await ((keyHeal.mock.calls[0] as unknown[])[0] as { pubkey: () => Promise<string> }).pubkey()).toBe(agentKey.pubkeyB64u);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect((delivery.mock.calls[0] as unknown[])[0]).toMatchObject({ walletId: AGENT });
    // After each pull the read-loop notice is synced; the agent counts as in the Commons once the key check says so.
    const afterTick = ((delivery.mock.calls[0] as unknown[])[1] as { afterTick: () => void }).afterTick;
    await Promise.resolve();
    afterTick();
    expect(notice).toHaveBeenLastCalledWith({ inCommons: true });
  });

  it('an agent the key check finds outside the Commons gets no standing notice', async () => {
    const { startCommonsMessaging } = await import('./observer/run-daemon.js');
    const keyHeal = vi.fn(() => ({ stop: () => undefined, done: Promise.resolve('not_in_commons' as const) }));
    const delivery = vi.fn(() => ({ stop: () => undefined, tick: async () => undefined }));
    const notice = vi.fn(() => 'none' as const);
    startCommonsMessaging(
      { relayUrl: 'https://relay.test', walletId: AGENT, apiKey: 'k', apiSecret: 's' },
      { keyHeal: keyHeal as never, delivery: delivery as never, notice, pubkey: async () => null, secret: () => async () => null },
    );
    await Promise.resolve();
    ((delivery.mock.calls[0] as unknown[])[1] as { afterTick: () => void }).afterTick();
    expect(notice).toHaveBeenLastCalledWith({ inCommons: false });
  });

  it('the delivery loop runs afterTick after every pass, reachable or not', async () => {
    const { relay } = fakeRelay();
    (relay.unreadThreads as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const after = vi.fn();
    const h = home();
    const d = startThreadDelivery({ relay, walletId: AGENT, secretKey: secret(), home: h }, { intervalMs: 60_000, log: () => undefined, afterTick: after });
    await d.tick();
    await d.tick();
    d.stop();
    expect(after.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * THE READ LOOP : an agent that completed standard onboarding reads its threads
 * without its operator doing anything else. Onboarding carries the instruction; an agent onboarded
 * before it gets the same instruction from the daemon through the file its heartbeat already reads.
 */
describe('the read loop — the standing heartbeat instruction', () => {
  it('standard onboarding\'s standing instruction carries the thread check, with the command that reads and the one that answers', () => {
    const lines = witnessSetupLines();
    const line = lines.find((l) => l.startsWith('Commons mail:'));
    expect(line).toBe(commonsHeartbeatInstruction());
    expect(line).toContain(cliCommand('threads --unread'));
    expect(line).toContain(cliCommand('thread-send --thread <id>'));
    expect(line).toContain('read_threads with unread: true');
    // It rides the standing instruction the agent installs in its own harness — never a hook.
    const standing = lines.findIndex((l) => l.startsWith('Install a persistent standing instruction'));
    expect(standing).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(line as string)).toBe(standing + 1);
    // RED (item 5, live): a headless harness with no wake facility of its own (codex exec in a
    // fresh box) set up no heartbeat. The text names the machine's scheduler as the fallback, started
    // only when there is something to act on.
    expect(lines[standing]).toContain("use this machine's scheduler instead");
    expect(lines[standing]).toMatch(/crontab entry, a launchd agent or a systemd timer/);
    expect(lines[standing]).not.toContain('~/.provian/messages/unread.json');
    // RED (review): the file alone is no signal — the SDK leaves a cleared one behind — so the check
    // wakes only for a file that names something to act on, throttled for the same notice or message.
    expect(lines[standing]).toContain('carries an "instruction" or a non-empty "programs" list');
    expect(lines[standing]).not.toMatch(/witness-action-required\.json exists/);
    expect(lines[standing]).toContain('again at most every 30 minutes while the same one still waits');
    // participating never costs a model turn. The check reads the files
    // without a model and starts a turn only for something to act on; a harness whose only wake is
    // a model turn uses the machine's scheduler for the check instead.
    expect(lines[standing]).toContain('The check itself never costs a model turn');
    expect(lines[standing]).toContain('witness-action-required.json');
    expect(lines[standing]).toContain('Never add a model-turn wake, or wake more often, just to look for Provian work');
    expect(lines[standing]).toContain('or can only wake by running a model turn');
    expect(line).toContain('Looking for mail never costs a model turn');
    expect(line).toContain('Do not schedule your own Commons mail checks or a Commons heartbeat');
    expect(line).toContain('never schedule a turn just to look for mail');
    expect(line).not.toMatch(/so it runs on your heartbeat/);
    // The hosted bundle names the absolute wrapper, never npx.
    expect(commonsHeartbeatInstruction(true)).toContain('"$HOME/.provian/bin/provian" threads --unread');
    expect(commonsHeartbeatInstruction(true)).not.toContain('npx');
  });

  const readNotice = (h: string): Record<string, unknown> | null =>
    existsSync(actionRequiredPath(h)) ? JSON.parse(readFileSync(actionRequiredPath(h), 'utf8')) as Record<string, unknown> : null;

  it('an agent in the Commons onboarded before the instruction is told it through witness-action-required.json until it reads its threads', () => {
    const h = home();
    expect(commonsHeartbeatAcknowledged(h)).toBe(false);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('written');
    const n = readNotice(h);
    expect(n).toMatchObject({ lane: 'commons', unread: 0 });
    expect(String(n?.instruction)).toContain(commonsHeartbeatInstruction());
    // It names the one check that clears it, so an agent following it knows when it is done.
    expect(String(n?.instruction)).toContain(`clears within a minute of your heartbeat running ${cliCommand('threads --unread')}`);
    expect(statSync(actionRequiredPath(h)).mode & 0o777).toBe(0o600);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('unchanged');
    // The agent runs the check once (threads --unread): the standing notice is done.
    acknowledgeCommonsHeartbeat(h, 5);
    expect(commonsHeartbeatAcknowledged(h)).toBe(true);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('cleared');
    expect(readNotice(h)).toBeNull();
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('none');
  });

  it('an agent that acknowledged an earlier instruction is told the current one again, once ', () => {
    const h = home();
    mkdirSync(join(h, '.provian', 'messages'), { recursive: true });
    // What a daemon before wrote when the agent ran threads --unread.
    writeFileSync(join(h, '.provian', 'messages', 'heartbeat.json'), JSON.stringify({ schema: 'provian.commons-heartbeat.v1', version: 1, acknowledged_at_ms: 1 }));
    expect(COMMONS_HEARTBEAT_VERSION).toBe(2);
    expect(commonsHeartbeatAcknowledged(h)).toBe(false);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('written');
    const n = readNotice(h);
    expect(String(n?.instruction)).toContain('looking for it must never cost a model turn');
    // RED (review R1): an agent onboarded before never sees witnessSetupLines again, so the
    // notice itself carries the rule for the standing check it already runs, not only for mail.
    expect(String(n?.instruction)).toContain('The check itself never costs a model turn: it reads this file and ~/.provian/messages/unread.json without a model');
    expect(String(n?.instruction)).toContain('If your check runs as a model turn now, change it');
    expect(String(n?.instruction)).toContain("a harness that can only wake by running a model turn uses this machine's scheduler instead");
    expect(String(n?.instruction)).toContain(commonsHeartbeatInstruction());
    acknowledgeCommonsHeartbeat(h, 2);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('cleared');
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('none');
  });

  it('an agent outside the Commons gets no standing notice', () => {
    const h = home();
    expect(syncCommonsHeartbeatNotice({ inCommons: false, home: h })).toBe('none');
    expect(readNotice(h)).toBeNull();
  });

  it('waiting mail is named in the notice for every agent, and the notice clears once it is read', async () => {
    const h = home();
    acknowledgeCommonsHeartbeat(h, 1);
    const { relay, send } = fakeRelay();
    send('hello atlas', 10);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 30 });
    expect(syncCommonsHeartbeatNotice({ inCommons: false, home: h })).toBe('written');
    const n = readNotice(h);
    expect(n).toMatchObject({ lane: 'commons', unread: 1 });
    expect(String(n?.instruction)).toContain(`1 unread Commons message from the operator waits now: run ${cliCommand('threads --unread')}`);
    // The plaintext stays in the mailbox; the notice carries only the count and the sender.
    expect(String(n?.instruction)).not.toContain('hello atlas');
    clearMailboxThreads(['t1'], h);
    expect(syncCommonsHeartbeatNotice({ inCommons: false, home: h })).toBe('cleared');
  });

  it('another lane\'s instruction is never overwritten or removed; the notice waits for it to clear', () => {
    const h = home();
    mkdirSync(join(h, '.provian'), { recursive: true });
    const processFlag = { instruction: 'run process-lane record', lane: 'process', state: 'launcher_not_seen' };
    writeFileSync(actionRequiredPath(h), JSON.stringify(processFlag));
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('held_by_other_lane');
    expect(readNotice(h)).toEqual(processFlag);
    acknowledgeCommonsHeartbeat(h, 1);
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('none');
    expect(readNotice(h)).toEqual(processFlag);
    // A transcript break (no lane tag, programs flagged) is held the same way.
    const transcriptFlag = { instruction: 'Re-describe…', programs: ['openclaw'] };
    writeFileSync(actionRequiredPath(h), JSON.stringify(transcriptFlag));
    rmSync(join(h, '.provian', 'messages', 'heartbeat.json'));
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('held_by_other_lane');
    expect(readNotice(h)).toEqual(transcriptFlag);
    // Its cleared remainder ({programs: []}) frees the file.
    writeFileSync(actionRequiredPath(h), JSON.stringify({ programs: [] }));
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('written');
    expect(readNotice(h)).toMatchObject({ lane: 'commons' });
    // An unreadable file is left to its writer.
    writeFileSync(actionRequiredPath(h), '{not json');
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('held_by_other_lane');
    expect(readFileSync(actionRequiredPath(h), 'utf8')).toBe('{not json');
  });

  it('mail read on the relay (another client, the MCP server, a reply) acknowledges the read loop', async () => {
    const h = home();
    const { relay, send, thread } = fakeRelay();
    send('one', 10);
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 30 });
    expect(commonsHeartbeatAcknowledged(h)).toBe(false);
    thread.read_cursors[AGENT] = 40;
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 50 });
    expect(readMailbox(h).unread).toEqual([]);
    expect(commonsHeartbeatAcknowledged(h)).toBe(true);
  });
});

describe('the daemon notice carries the owner\'s reply policy while mail waits (item 4)', () => {
  it('the policy the relay hands on the unread read is remembered and spoken in the notice', async () => {
    const h = home();
    const { relay, send } = fakeRelay();
    relay.unreadThreads = vi.fn(async () => ({ threads: [{ thread_id: 't1', read_cursors: {} }], reply_policy: { mode: 'ask_me_first', linked_human: FRANK } }));
    send('Hi Atlas, can you help with my project?', 2_000, 2_000, 'wallet_aw_stranger');
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_000 });
    expect(lastReplyPolicy(h)).toEqual({ mode: 'ask_me_first', linked_human: FRANK });
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('written');
    const notice = JSON.parse(readFileSync(actionRequiredPath(h), 'utf8')) as { instruction: string };
    expect(notice.instruction).toContain(`Reply directly only to your linked human (${FRANK})`);
    expect(notice.instruction).toContain('request-approval');
  });

  it('RED: with no mail waiting the notice says nothing about replying', async () => {
    const h = home();
    const { relay } = fakeRelay();
    relay.unreadThreads = vi.fn(async () => ({ threads: [], reply_policy: { mode: 'ask_me_first', linked_human: FRANK } }));
    await deliverThreadMessagesOnce({ relay, walletId: AGENT, secretKey: secret(), home: h, now: () => 3_000 });
    expect(syncCommonsHeartbeatNotice({ inCommons: true, home: h })).toBe('written');
    const notice = JSON.parse(readFileSync(actionRequiredPath(h), 'utf8')) as { instruction: string };
    expect(notice.instruction).not.toContain("Your owner's reply policy:");
    expect(notice.instruction).not.toContain('Reply directly only to');
  });
});

it('normalizes an already-delivered signed message when the daemon reads its existing mailbox', () => {
  const h = home();
  const signature: OutputSignature = { hash: outputHashOfText('Received'), signer: { kind: 'app', id: 'aok_' + 'a'.repeat(32) }, scheme: 'p256_sha256', sig: '1'.repeat(128) };
  mkdirSync(join(h, '.provian', 'messages'), { recursive: true });
  writeFileSync(mailboxPath(h), JSON.stringify({ schema: 'provian.agent-mailbox.v1', unread: [{ message_id: 'existing', text: withThreadOutputSignature('Received', signature) }] }));
  expect(readMailbox(h).unread[0]).toMatchObject({ message_id: 'existing', text: 'Received', provian_output_signature: signature });
});
