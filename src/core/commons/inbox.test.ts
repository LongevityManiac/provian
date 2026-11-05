/**
 * Commons Inbox — one newest-first list of messages, replies, and consent requests.
 * Each guard carries a RED control: the violating input is constructed and must be refused.
 */
import { describe, it, expect } from 'vitest';
import { buildInbox, filterInbox, inboxUnreadCount, type InboxReplyInput } from './inbox';
import type { PublicationConsent, ThreadDocument } from './CommonsService';

const ME = 'user_me';

const thread = (id: string, at: number, extra: Partial<ThreadDocument> = {}): ThreadDocument => ({
  thread_id: id,
  anchor_kind: 'profile',
  anchor_id: 'x',
  party_a: ME,
  party_b: 'wallet_aw_atlas',
  parties: { [ME]: { kind: 'human', id: ME }, wallet_aw_atlas: { kind: 'agent', id: 'wallet_aw_atlas' } },
  opened_by: ME,
  created_at: at,
  last_message_at: at,
  message_count: 3,
  read_cursors: {},
  ...extra,
} as ThreadDocument);

const reply = (id: string, at: number, extra: Partial<InboxReplyInput> = {}): InboxReplyInput => ({
  post_id: id,
  root_post_id: 'post_root',
  parent_post_id: 'post_root',
  author_wallet_id: 'wallet_aw_atlas',
  author_type: 'agent',
  author_display_name: 'Atlas',
  content: 'hello there',
  created_at: at,
  root_title: 'A question',
  ...extra,
});

const consent = (id: string, at: number, expires: number): PublicationConsent => ({
  consent_id: id,
  pe_id: 'pe_1',
  requesting_wallet_id: 'wallet_x',
  consenting_wallet_ids: [ME],
  consent_status: { [ME]: 'pending' },
  redaction_config: {} as PublicationConsent['redaction_config'],
  institution: 'forum',
  requested_at: at,
  expires_at: expires,
} as PublicationConsent);

describe('buildInbox', () => {
  it('merges the three sources newest first, with the right counterparty and names', () => {
    const items = buildInbox({
      myId: ME,
      threads: [thread('th_1', 100, { unread: true, display_names: { wallet_aw_atlas: 'Atlas' } } as Partial<ThreadDocument>)],
      replies: [reply('post_r1', 300)],
      consents: [consent('c_1', 200, 10_000)],
      repliesSeenAt: 0,
      now: 1_000,
    });
    expect(items.map((i) => i.kind)).toEqual(['reply', 'request', 'message']);
    const msg = items[2];
    expect(msg.kind === 'message' && msg.counterpartyId).toBe('wallet_aw_atlas');
    expect(msg.kind === 'message' && msg.counterpartyName).toBe('Atlas');
    expect(msg.kind === 'message' && msg.counterpartyKind).toBe('agent');
    const r = items[0];
    expect(r.kind === 'reply' && r.postId).toBe('post_root');
    expect(r.kind === 'reply' && r.commentId).toBe('post_r1');
    expect(inboxUnreadCount(items)).toBe(3);
  });

  it('marks a reply read once the watermark passes it', () => {
    const items = buildInbox({ myId: ME, threads: [], replies: [reply('a', 50), reply('b', 150)], consents: [], repliesSeenAt: 100 });
    expect(items.find((i) => i.id === 'reply:a')?.unread).toBe(false);
    expect(items.find((i) => i.id === 'reply:b')?.unread).toBe(true);
  });

  it('RED: your own reply never lands in your inbox', () => {
    const items = buildInbox({ myId: ME, threads: [], replies: [reply('mine', 10, { author_wallet_id: ME })], consents: [], repliesSeenAt: 0 });
    expect(items).toHaveLength(0);
  });

  it('RED: an expired consent request is dropped, a live one kept', () => {
    const items = buildInbox({ myId: ME, threads: [], replies: [], consents: [consent('dead', 1, 500), consent('live', 2, 5_000)], repliesSeenAt: 0, now: 1_000 });
    expect(items.map((i) => i.id)).toEqual(['request:live']);
  });

  it('RED: duplicate rows from a retried page are not doubled', () => {
    const items = buildInbox({ myId: ME, threads: [thread('t', 1), thread('t', 1)], replies: [reply('r', 2), reply('r', 2)], consents: [], repliesSeenAt: 0 });
    expect(items).toHaveLength(2);
  });

  it('a reply with no root/parent still points at a post (never an empty id)', () => {
    const items = buildInbox({ myId: ME, threads: [], replies: [reply('orphan', 5, { root_post_id: null, parent_post_id: null })], consents: [], repliesSeenAt: 0 });
    const r = items[0];
    expect(r.kind === 'reply' && r.postId).toBe('orphan');
  });

  it('long reply text is previewed, not dumped', () => {
    const items = buildInbox({ myId: ME, threads: [], replies: [reply('long', 5, { content: 'x'.repeat(500) })], consents: [], repliesSeenAt: 0 });
    const r = items[0];
    expect(r.kind === 'reply' && r.preview.length).toBeLessThanOrEqual(140);
  });
});

describe('filterInbox', () => {
  it('filters by kind and passes everything through on all', () => {
    const items = buildInbox({ myId: ME, threads: [thread('t', 1)], replies: [reply('r', 2)], consents: [consent('c', 3, 0)], repliesSeenAt: 0 });
    expect(filterInbox(items, 'all')).toHaveLength(3);
    expect(filterInbox(items, 'messages').map((i) => i.kind)).toEqual(['message']);
    expect(filterInbox(items, 'replies').map((i) => i.kind)).toEqual(['reply']);
    expect(filterInbox(items, 'requests').map((i) => i.kind)).toEqual(['request']);
  });
});
