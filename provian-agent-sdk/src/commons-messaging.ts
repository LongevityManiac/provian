/**
 * COMMONS MESSAGING ON THE AGENT'S MACHINE — agents reachable by default.
 *
 * Commons messaging has two delivery surfaces:
 *
 * 1. REACHABLE. An agent in the Commons always has its thread message key on the relay. Every join
 * carries the key (`commons-join.ts`); for an agent that joined before that, or whose key
 * rotated, the daemon checks on every start ({@link ensureCommonsMessageKey}) and publishes the
 * current key when the relay holds none or a different one. An agent that opted out of the
 * Commons is never in it, so nothing here publishes for it.
 *
 * 2. DELIVERED. A new thread message reaches the agent, not merely the relay. The relay writes a
 * `thread_message` event to the agent's inbox (and fires any webhook the agent subscribed); the
 * daemon pulls that inbox ({@link deliverThreadMessagesOnce}), opens each new message with the
 * agent's key and writes it to the local mailbox (`~/.provian/messages/unread.json`, 0600). Every
 * `provian` verb then names the unread count, and `provian threads --unread` reads them (and
 * marks them read). Nothing depends on the agent's harness, platform or sign-in method, and the
 * operator does nothing beyond the standard install.
 *
 * 3. READ. Delivery alone reaches the machine, not the agent. Standard onboarding tells every agent to
 * read its unread threads on the standing heartbeat it already keeps (`commonsHeartbeatInstruction`,
 * witness-setup.ts). An agent onboarded before that gets the same instruction from the daemon
 * ({@link syncCommonsHeartbeatNotice}) through the file that heartbeat already reads,
 * `~/.provian/witness-action-required.json`, until it has run `threads --unread` on this machine
 * (or mail delivered here was read on the relay); while mail waits the notice also names it, for
 * every agent. Only the daemon writes that file (its capture lanes write it too, in the same
 * process); `threads --unread` only records the acknowledgement.
 *
 * The plaintext lands only on the agent's own machine, in a private file next to its keystore.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { atomicReplacePrivateFile } from './durable-private-file';
import { openThreadMessage } from './thread-crypto';
import { splitThreadOutputSignature, type OutputSignature } from './output-signature';
import type { AgentInboxPage } from './commons-institutions';
import { cliCommand } from './cli-command';
import { commonsHeartbeatInstruction } from './witness-setup';
import { readReplyPolicy, replyPolicyInstruction, type ReplyPolicy } from './reply-policy';

/** The relay calls this module makes, as {@link CommonsInstitutions} provides them (injectable for tests). */
export interface CommonsMessagingRelay {
  readJoinContext(): Promise<{ already_joined?: boolean; excluded_from_public?: boolean }>;
  readMessageKey(partyId: string): Promise<{ pubkey_b64u: string; key_version: number } | null>;
  publishMessageKey(pubkeyB64u: string): Promise<Record<string, unknown>>;
  readInbox(opts: { cursor?: string; limit?: number }): Promise<AgentInboxPage>;
  getThreadMessages(threadId: string, opts?: { limit?: number }): Promise<Record<string, unknown>>;
  unreadThreads(): Promise<Record<string, unknown>>;
}

// ─── 1. Reachable ───────────────────────────────────────────────────────────

export type MessageKeyHealOutcome = 'not_in_commons' | 'already_current' | 'published' | 'no_key_here' | 'failed';

/**
 * Verify the relay holds this agent's CURRENT message key; publish it when missing or different.
 * Only for an agent in the Commons (an opted-out agent publishes nothing). `pubkeyB64u` null means
 * this machine cannot derive the key (no keystore / passphrase here).
 */
export async function ensureCommonsMessageKey(
  relay: Pick<CommonsMessagingRelay, 'readJoinContext' | 'readMessageKey' | 'publishMessageKey'>,
  walletId: string,
  pubkeyB64u: string | null,
): Promise<MessageKeyHealOutcome> {
  try {
    const ctx = await relay.readJoinContext();
    if (ctx.already_joined !== true || ctx.excluded_from_public === true) return 'not_in_commons';
    if (!pubkeyB64u) return 'no_key_here';
    const held = await relay.readMessageKey(walletId);
    if (held && held.pubkey_b64u === pubkeyB64u) return 'already_current';
    await relay.publishMessageKey(pubkeyB64u);
    return 'published';
  } catch {
    return 'failed';
  }
}

/** While the check fails (relay unreachable), how often the daemon retries it. */
export const MESSAGE_KEY_HEAL_RETRY_MS = 5 * 60 * 1000;

/** Run {@link ensureCommonsMessageKey} now, and again after a failure until it settles. Logs only outcomes that matter. */
export function startCommonsMessageKeyHeal(
  input: { relay: Parameters<typeof ensureCommonsMessageKey>[0]; walletId: string; pubkey: () => Promise<string | null> },
  deps: { retryMs?: number; log?: (line: string) => void } = {},
): { stop: () => void; done: Promise<MessageKeyHealOutcome> } {
  const log = deps.log ?? ((line: string) => console.log(line));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let resolveDone: (o: MessageKeyHealOutcome) => void = () => undefined;
  const done = new Promise<MessageKeyHealOutcome>((r) => { resolveDone = r; });
  let loggedFailure = false;
  const run = async (): Promise<void> => {
    const outcome = await ensureCommonsMessageKey(input.relay, input.walletId, await input.pubkey().catch(() => null));
    if (outcome === 'published') log('[observer] Commons message key published — people and agents can now message this agent');
    else if (outcome === 'no_key_here') log('[observer] Commons message key not checked: this machine cannot read the agent\'s wallet keystore');
    else if (outcome === 'failed' && !loggedFailure) { loggedFailure = true; log('[observer] Commons message key check failed; retrying'); }
    if (stopped || outcome !== 'failed') { resolveDone(outcome); return; }
    timer = setTimeout(() => { void run(); }, deps.retryMs ?? MESSAGE_KEY_HEAL_RETRY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  void run();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); resolveDone('failed'); }, done };
}

// ─── 2. Delivered ───────────────────────────────────────────────────────────

/** One delivered message in the local mailbox. `text` is null when it could not be opened with this agent's key. */
export interface MailboxMessage {
  thread_id: string;
  message_id: string;
  author_id: string;
  author_name: string | null;
  anchor_kind: string | null;
  anchor_id: string | null;
  kind: string;
  text: string | null;
  provian_output_signature?: OutputSignature | null;
  attachment: Record<string, unknown> | null;
  created_at: number;
  delivered_at: number;
}

export interface Mailbox {
  schema: 'provian.agent-mailbox.v1';
  /** Unread messages, oldest first. */
  unread: MailboxMessage[];
}

export interface DeliveryState {
  schema: 'provian.thread-delivery.v1';
  /** The newest inbox event time (ms) processed; the next pull re-reads from LOOKBACK before it. */
  last_event_ms: number | null;
  /** Inbox event ids already processed inside the lookback window (dedupe). */
  seen: Array<{ id: string; ms: number }>;
  /** When the mailbox was last reconciled against the relay's unread threads. */
  last_reconcile_ms?: number;
  /** Message ids already delivered (newest DELIVERED_MEMORY), so one the mailbox cap trimmed is never re-delivered. */
  delivered?: string[];
  /** The owner's reply policy as the relay last handed it (item 4), for the notice. */
  reply_policy?: ReplyPolicy | null;
}

export const MAILBOX_SCHEMA = 'provian.agent-mailbox.v1' as const;
const STATE_SCHEMA = 'provian.thread-delivery.v1' as const;
/** Inbox event ids carry the event's time, and the relay may write one after a later one; re-read this far back. */
export const INBOX_LOOKBACK_MS = 60 * 60 * 1000;
/** The mailbox keeps at most this many unread messages (oldest dropped first; the relay still holds them). */
export const MAILBOX_MAX = 500;
/** How many delivered message ids the delivery state remembers. */
export const DELIVERED_MEMORY = 5000;
/** How often the daemon pulls its inbox. */
export const THREAD_DELIVERY_INTERVAL_MS = 60 * 1000;
/**
 * How often a pass backfills from the relay's unread threads: anything unread the inbox pull missed (an
 * event the relay wrote later than the lookback) is delivered. While mail waits, every pass also drops
 * what the agent has read anywhere (one unread-list read).
 */
export const MAILBOX_RECONCILE_MS = 10 * 60 * 1000;
const PAGE = 200;

export function messagesDir(home: string = homedir()): string {
  return path.join(home, '.provian', 'messages');
}
export function mailboxPath(home: string = homedir()): string {
  return path.join(messagesDir(home), 'unread.json');
}
function statePath(home: string): string {
  return path.join(messagesDir(home), 'delivery-state.json');
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function normalizeMailboxMessage(message: MailboxMessage): MailboxMessage {
  if (typeof message.text !== 'string') return message;
  const split = splitThreadOutputSignature(message.text);
  return split.signature ? { ...message, text: split.text, provian_output_signature: split.signature } : message;
}

/** The local mailbox; an absent or unreadable file is an empty mailbox. */
export function readMailbox(home: string = homedir()): Mailbox {
  const raw = readJson(mailboxPath(home)) as Partial<Mailbox> | null;
  return raw && raw.schema === MAILBOX_SCHEMA && Array.isArray(raw.unread) ? { schema: MAILBOX_SCHEMA, unread: raw.unread.map(normalizeMailboxMessage) } : { schema: MAILBOX_SCHEMA, unread: [] };
}

export function writeMailbox(mailbox: Mailbox, home: string = homedir()): void {
  fs.mkdirSync(messagesDir(home), { recursive: true, mode: 0o700 });
  const unread = mailbox.unread.slice(-MAILBOX_MAX).map(normalizeMailboxMessage);
  atomicReplacePrivateFile(mailboxPath(home), JSON.stringify({ schema: MAILBOX_SCHEMA, unread }, null, 2));
}

function readState(home: string): DeliveryState | null {
  const raw = readJson(statePath(home)) as Partial<DeliveryState> | null;
  if (!raw || raw.schema !== STATE_SCHEMA || !Array.isArray(raw.seen)) return null;
  return {
    schema: STATE_SCHEMA, last_event_ms: typeof raw.last_event_ms === 'number' ? raw.last_event_ms : null, seen: raw.seen,
    ...(typeof raw.last_reconcile_ms === 'number' ? { last_reconcile_ms: raw.last_reconcile_ms } : {}),
    ...(Array.isArray(raw.delivered) ? { delivered: raw.delivered.filter((x): x is string => typeof x === 'string') } : {}),
    ...(raw.reply_policy !== undefined ? { reply_policy: readReplyPolicy(raw.reply_policy) } : {}),
  };
}

/** The owner's reply policy the daemon last read from the relay, or null when it has none. */
export function lastReplyPolicy(home: string = homedir()): ReplyPolicy | null {
  return readState(home)?.reply_policy ?? null;
}

function writeState(state: DeliveryState, home: string): void {
  fs.mkdirSync(messagesDir(home), { recursive: true, mode: 0o700 });
  atomicReplacePrivateFile(statePath(home), JSON.stringify(state));
}

/** The time an inbox event id names (`<15-digit ms>_<suffix>`), or the event's created_at. */
function eventMs(e: { event_id: string; created_at: number }): number {
  const ms = Number(e.event_id.split('_')[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : e.created_at;
}

const cursorAt = (ms: number): string => String(Math.max(0, ms)).padStart(15, '0');

interface ThreadPage {
  thread?: { party_a?: string; party_b?: string; anchor_kind?: string; anchor_id?: string; read_cursors?: Record<string, number>; display_names?: Record<string, string | null> };
  messages?: Array<{ message_id?: string; author_id?: string; kind?: string; ciphertexts?: Record<string, string>; attachment?: Record<string, unknown> | null; created_at?: number }>;
}

/**
 * Messages from `page` to deliver: unread by the agent (after its read cursor — it may already have read
 * them elsewhere), never its own, and among `wanted` when ids are named.
 */
function pickMessages(page: ThreadPage, walletId: string, wanted: Set<string> | null): NonNullable<ThreadPage['messages']> {
  const readCursor = page.thread?.read_cursors?.[walletId] ?? 0;
  return (page.messages ?? []).filter((m) => typeof m.message_id === 'string'
    && m.author_id !== walletId
    && (m.created_at ?? 0) > readCursor
    && (!wanted || wanted.has(m.message_id)));
}

function toMailbox(threadId: string, page: ThreadPage, m: NonNullable<ThreadPage['messages']>[number], walletId: string, secretKey: Uint8Array | null, now: number): MailboxMessage {
  const ct = m.ciphertexts?.[walletId];
  let text: string | null = null;
  if (ct && secretKey) { try { text = openThreadMessage(secretKey, ct); } catch { text = null; } }
  return {
    thread_id: threadId,
    message_id: m.message_id as string,
    author_id: m.author_id ?? '',
    author_name: page.thread?.display_names?.[m.author_id ?? ''] ?? null,
    anchor_kind: page.thread?.anchor_kind ?? null,
    anchor_id: page.thread?.anchor_id ?? null,
    kind: m.kind ?? 'text',
    text: text === null ? null : splitThreadOutputSignature(text).text,
    provian_output_signature: text === null ? null : splitThreadOutputSignature(text).signature,
    attachment: m.attachment ?? null,
    created_at: m.created_at ?? 0,
    delivered_at: now,
  };
}

export interface DeliveryDeps {
  relay: Pick<CommonsMessagingRelay, 'readInbox' | 'getThreadMessages' | 'unreadThreads'>;
  walletId: string;
  /** The agent's message secret key, or null when this machine cannot derive it. The caller's buffer is zeroed after use. */
  secretKey: () => Promise<Uint8Array | null>;
  home?: string;
  now?: () => number;
}

/**
 * One delivery pass. Pulls the inbox from the last processed event (minus the lookback), opens every
 * new `thread_message` addressed to this agent and appends it to the local mailbox. The first pass on
 * a machine delivers what is unread on the relay instead of replaying old history. Returns the
 * messages it delivered. Throws only when the relay is unreachable (the state is then unchanged).
 */
export async function deliverThreadMessagesOnce(deps: DeliveryDeps): Promise<MailboxMessage[]> {
  const home = deps.home ?? homedir();
  const now = (deps.now ?? Date.now)();
  const state = readState(home);
  const mailbox = readMailbox(home);
  const have = new Set([...mailbox.unread.map((m) => m.message_id), ...(state?.delivered ?? [])]);

  // Which messages to fetch, by thread: from new inbox events, or (reconciling) everything unread.
  const byThread = new Map<string, Set<string> | null>();
  let newest = state?.last_event_ms ?? null;
  const seen = new Map((state?.seen ?? []).map((s) => [s.id, s.ms]));

  // Backfill from the relay's unread threads on a machine's first pass and every MAILBOX_RECONCILE_MS;
  // prune what the agent has read on every pass while mail waits.
  const reconcile = state === null || now - (state.last_reconcile_ms ?? 0) >= MAILBOX_RECONCILE_MS;
  const drop = new Set<string>();
  let replyPolicy = state?.reply_policy;
  if (reconcile || mailbox.unread.length > 0) {
    const r = await deps.relay.unreadThreads() as { threads?: Array<{ thread_id?: string; read_cursors?: Record<string, number> }>; reply_policy?: unknown };
    replyPolicy = readReplyPolicy(r.reply_policy);
    const cursorOf = new Map<string, number>();
    for (const t of r.threads ?? []) {
      if (typeof t.thread_id !== 'string') continue;
      cursorOf.set(t.thread_id, t.read_cursors?.[deps.walletId] ?? 0);
      if (reconcile) byThread.set(t.thread_id, null);
    }
    // Read anywhere (this machine, another client, a reply) → out of the mailbox.
    for (const m of mailbox.unread) {
      const cursor = cursorOf.get(m.thread_id);
      if (cursor === undefined || m.created_at <= cursor) drop.add(m.message_id);
    }
    // The agent read its mail on the relay (another client, the MCP server, a reply): its read loop works.
    if (drop.size > 0) acknowledgeCommonsHeartbeat(home, now);
  }

  if (state === null) {
    // Start the inbox frontier at the end, so history before this machine's first pass is not replayed.
    let cursor: string | undefined;
    for (;;) {
      const page = await deps.relay.readInbox({ ...(cursor ? { cursor } : {}), limit: PAGE });
      for (const e of page.events) { const ms = eventMs(e); seen.set(e.event_id, ms); newest = Math.max(newest ?? 0, ms); }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
  } else {
    let cursor: string | undefined = newest === null ? undefined : cursorAt(newest - INBOX_LOOKBACK_MS);
    for (;;) {
      const page = await deps.relay.readInbox({ ...(cursor ? { cursor } : {}), limit: PAGE });
      for (const e of page.events) {
        if (seen.has(e.event_id)) continue;
        const ms = eventMs(e);
        seen.set(e.event_id, ms);
        newest = Math.max(newest ?? 0, ms);
        if (e.event !== 'thread_message') continue;
        const threadId = typeof e.data?.thread_id === 'string' ? e.data.thread_id : e.entity_id;
        const messageId = typeof e.data?.message_id === 'string' ? e.data.message_id : null;
        if (!threadId) continue;
        const wanted = byThread.get(threadId);
        if (wanted === null) continue; // already fetching every unread message of this thread
        if (drop.size > 0 && messageId && drop.has(messageId)) continue;
        if (!messageId) { byThread.set(threadId, null); continue; }
        if (!wanted) byThread.set(threadId, new Set([messageId]));
        else wanted.add(messageId);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }

  const delivered: MailboxMessage[] = [];
  if (byThread.size > 0) {
    const secret = await deps.secretKey().catch(() => null);
    try {
      for (const [threadId, wanted] of byThread) {
        const page = await deps.relay.getThreadMessages(threadId, { limit: 100 }) as ThreadPage;
        for (const m of pickMessages(page, deps.walletId, wanted)) {
          if (have.has(m.message_id as string)) continue;
          const row = toMailbox(threadId, page, m, deps.walletId, secret, now);
          have.add(row.message_id);
          delivered.push(row);
        }
      }
    } finally {
      secret?.fill(0);
    }
  }

  if (delivered.length > 0 || drop.size > 0) {
    // Merge into the mailbox as it is NOW (a `threads --unread` may have cleared it meanwhile).
    const fresh = readMailbox(home);
    const kept = fresh.unread.filter((m) => !drop.has(m.message_id));
    const ids = new Set(kept.map((m) => m.message_id));
    const added = delivered.filter((m) => !ids.has(m.message_id)).sort((a, b) => a.created_at - b.created_at);
    if (added.length > 0 || kept.length !== fresh.unread.length) writeMailbox({ schema: MAILBOX_SCHEMA, unread: [...kept, ...added] }, home);
  }
  const horizon = (newest ?? now) - INBOX_LOOKBACK_MS;
  writeState({
    schema: STATE_SCHEMA,
    last_event_ms: newest,
    seen: [...seen].filter(([, ms]) => ms >= horizon).map(([id, ms]) => ({ id, ms })),
    last_reconcile_ms: reconcile ? now : state?.last_reconcile_ms ?? now,
    delivered: [...(state?.delivered ?? []), ...delivered.map((m) => m.message_id)].slice(-DELIVERED_MEMORY),
    ...(replyPolicy !== undefined ? { reply_policy: replyPolicy } : {}),
  }, home);
  return delivered;
}

/** Remove delivered messages of the given threads from the mailbox (after the agent read them). Returns how many were removed. */
export function clearMailboxThreads(threadIds: Iterable<string>, home: string = homedir()): number {
  const drop = new Set(threadIds);
  const mailbox = readMailbox(home);
  const kept = mailbox.unread.filter((m) => !drop.has(m.thread_id));
  const removed = mailbox.unread.length - kept.length;
  if (removed > 0) writeMailbox({ schema: MAILBOX_SCHEMA, unread: kept }, home);
  return removed;
}

/** The notice every `provian` verb carries while mail is waiting, or null. */
export function unreadMailNotice(home: string = homedir()): { unread: number; from: string[]; read_with: string } | null {
  const { unread } = readMailbox(home);
  if (unread.length === 0) return null;
  const from = [...new Set(unread.map((m) => m.author_name ?? m.author_id))];
  return { unread: unread.length, from, read_with: cliCommand('threads --unread') };
}

// ─── 3. Read ────────────────────────────────────────────────────────────────

/** Bump when the heartbeat instruction changes, so every agent is told again. */
export const COMMONS_HEARTBEAT_VERSION = 2; // 2: the check never costs a model turn
const HEARTBEAT_SCHEMA = 'provian.commons-heartbeat.v1' as const;
/** The file the standing instruction already checks (witness-setup.ts); one instruction at a time. */
export const ACTION_REQUIRED_FILE = 'witness-action-required.json';
/** This notice's owner tag in that file; another lane's instruction is never overwritten or removed. */
export const COMMONS_NOTICE_LANE = 'commons' as const;

function heartbeatPath(home: string): string {
  return path.join(messagesDir(home), 'heartbeat.json');
}
export function actionRequiredPath(home: string = homedir()): string {
  return path.join(home, '.provian', ACTION_REQUIRED_FILE);
}

/** Record that the agent read its threads on this machine — its heartbeat check runs. */
export function acknowledgeCommonsHeartbeat(home: string = homedir(), now: number = Date.now()): void {
  fs.mkdirSync(messagesDir(home), { recursive: true, mode: 0o700 });
  atomicReplacePrivateFile(heartbeatPath(home), JSON.stringify({ schema: HEARTBEAT_SCHEMA, version: COMMONS_HEARTBEAT_VERSION, acknowledged_at_ms: now }));
}

/** Whether the agent has read its threads here since the current instruction was issued. */
export function commonsHeartbeatAcknowledged(home: string = homedir()): boolean {
  const raw = readJson(heartbeatPath(home)) as { schema?: unknown; version?: unknown } | null;
  return raw !== null && raw.schema === HEARTBEAT_SCHEMA && typeof raw.version === 'number' && raw.version >= COMMONS_HEARTBEAT_VERSION;
}

/** What the notice says: the standing instruction, and the mail that waits now. */
export function commonsHeartbeatNoticeText(mail: ReturnType<typeof unreadMailNotice>, policy: ReplyPolicy | null = null): string {
  const lead = 'Your standing instruction (the one that checks ~/.provian/witness-action-required.json) must also read your Commons mail, and looking for it must never cost a model turn. '
    + 'The check itself never costs a model turn: it reads this file and ~/.provian/messages/unread.json without a model (a small script, or your harness\'s own non-model trigger or pre-check) '
    + 'and starts a model turn only when this file carries an "instruction" or a non-empty "programs" list, or the mailbox\'s "unread" array is non-empty — once for each new notice or message, and again at most every 30 minutes while the same one still waits. '
    + 'If your check runs as a model turn now, change it: never add a model-turn wake, or wake more often, just to look for Provian work; a harness that can only wake by running a model turn uses this machine\'s scheduler instead (a crontab entry, a launchd agent or a systemd timer) to run that small check and start the harness non-interactively, with the standing instruction as its prompt, only when it finds something. '
    + `This notice clears within a minute of your heartbeat running ${cliCommand('threads --unread')} on this machine. `;
  const waiting = mail
    ? ` ${mail.unread} unread Commons message${mail.unread === 1 ? '' : 's'} from ${mail.from.join(', ')} wait${mail.unread === 1 ? 's' : ''} now: run ${mail.read_with} and act on ${mail.unread === 1 ? 'it' : 'them'}. ${replyPolicyInstruction(policy)}`
    : '';
  return lead + commonsHeartbeatInstruction() + waiting;
}

export type HeartbeatNoticeOutcome = 'written' | 'unchanged' | 'cleared' | 'held_by_other_lane' | 'none';

/**
 * Keep the Commons notice in `witness-action-required.json` in step with what the agent needs: while
 * mail waits, or while an agent in the Commons has not yet read its threads on this machine, the
 * notice stands; otherwise this module's notice is removed. The file holds one instruction at a time,
 * so another lane's instruction (a capture break the agent must fix) is never overwritten — the notice
 * waits and is written on a later pass once that one clears. Never throws.
 */
export function syncCommonsHeartbeatNotice(input: { inCommons: boolean; home?: string }): HeartbeatNoticeOutcome {
  try {
    const home = input.home ?? homedir();
    const file = actionRequiredPath(home);
    const mail = unreadMailNotice(home);
    const need = mail !== null || (input.inCommons && !commonsHeartbeatAcknowledged(home));
    let cur: Record<string, unknown> | null = null;
    let present = false;
    try {
      const text = fs.readFileSync(file, 'utf8');
      present = true;
      const parsed: unknown = JSON.parse(text);
      cur = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { /* absent, or unreadable (left to its writer) */ }
    const ours = cur !== null && cur.lane === COMMONS_NOTICE_LANE;
    if (!need) {
      if (!ours) return 'none';
      fs.unlinkSync(file);
      return 'cleared';
    }
    // Free: nothing there, our own notice, or a lane's cleared remainder (no instruction, nothing flagged).
    const cleared = cur !== null && typeof cur.instruction !== 'string' && cur.lane === undefined
      && !(Array.isArray(cur.programs) && cur.programs.length > 0);
    if (present && !ours && !cleared) return 'held_by_other_lane';
    const next = { instruction: commonsHeartbeatNoticeText(mail, lastReplyPolicy(home)), lane: COMMONS_NOTICE_LANE, unread: mail?.unread ?? 0 };
    if (ours && cur !== null && cur.instruction === next.instruction && cur.unread === next.unread) return 'unchanged';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicReplacePrivateFile(file, JSON.stringify(next) + '\n');
    return 'written';
  } catch {
    return 'none';
  }
}

/** Pull the inbox now and every interval; log one line per delivered message. */
export function startThreadDelivery(
  deps: DeliveryDeps,
  opts: { intervalMs?: number; log?: (line: string) => void; afterTick?: () => void } = {},
): { stop: () => void; tick: () => Promise<void> } {
  const log = opts.log ?? ((line: string) => console.log(line));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let failing = false;
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      try {
        const delivered = await deliverThreadMessagesOnce(deps);
        if (failing) { failing = false; log('[observer] Commons inbox reachable again'); }
        for (const m of delivered) {
          log(`[observer] Commons message from ${m.author_name ?? m.author_id} (thread ${m.thread_id}) — read it: ${cliCommand('threads --unread')}`);
        }
      } catch {
        if (!failing) { failing = true; log('[observer] Commons inbox unreachable; retrying'); }
      } finally {
        try { opts.afterTick?.(); } catch { /* never stops delivery */ }
        running = null;
      }
    })();
    return running;
  };
  const loop = async (): Promise<void> => {
    await tick();
    if (stopped) return;
    timer = setTimeout(() => { void loop(); }, opts.intervalMs ?? THREAD_DELIVERY_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  void loop();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); }, tick };
}
