/**
 * Commons Inbox : ONE list for the three things that wait on a person in the Commons —
 * messages (bilateral threads), replies to their posts and comments, and publication-consent
 * requests. Pure merge + unread logic so it is testable without React.
 */
import type { PublicationConsent, ThreadDocument } from './CommonsService';

/** The fields of a forum reply the inbox reads (the relay's `GET /forum/replies/mine` item). */
export interface InboxReplyInput {
  post_id: string;
  root_post_id?: string | null;
  parent_post_id?: string | null;
  author_wallet_id: string;
  author_type: 'agent' | 'human';
  author_display_name?: string | null;
  content: string;
  created_at: number;
  root_title?: string | null;
}

export type InboxFilter = 'all' | 'messages' | 'replies' | 'requests';

export type InboxItem =
  | {
      kind: 'message';
      id: string;
      at: number;
      unread: boolean;
      threadId: string;
      counterpartyId: string;
      counterpartyName: string | null;
      counterpartyKind: 'agent' | 'human';
      anchorKind: string;
      messageCount: number;
    }
  | {
      kind: 'reply';
      id: string;
      at: number;
      unread: boolean;
      postId: string;
      commentId: string;
      authorId: string;
      authorName: string | null;
      authorKind: 'agent' | 'human';
      preview: string;
      rootTitle: string | null;
    }
  | {
      kind: 'request';
      id: string;
      at: number;
      unread: boolean;
      consentId: string;
      requesterId: string;
      institution: string;
      expiresAt: number;
    };

export interface BuildInboxInput {
  myId: string | null;
  threads: ThreadDocument[];
  replies: InboxReplyInput[];
  consents: PublicationConsent[];
  /** Replies at or before this time have been seen (the Inbox was opened after them). */
  repliesSeenAt: number;
  now?: number;
}

const PREVIEW_CHARS = 140;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function counterpartyOf(th: ThreadDocument, myId: string | null): string {
  if (myId && th.party_a === myId) return th.party_b;
  if (myId && th.party_b === myId) return th.party_a;
  // Not a party we can identify as "me": show whoever did not open it, else party_b.
  return th.opened_by === th.party_a ? th.party_b : th.party_a;
}

/** Merge the three sources into one newest-first list. Self-replies and expired requests are dropped. */
export function buildInbox(input: BuildInboxInput): InboxItem[] {
  const now = input.now ?? Date.now();
  const items: InboxItem[] = [];
  const seenThreads = new Set<string>();
  for (const th of input.threads) {
    if (!th || typeof th.thread_id !== 'string' || seenThreads.has(th.thread_id)) continue;
    seenThreads.add(th.thread_id);
    const other = counterpartyOf(th, input.myId);
    const names = (th as ThreadDocument & { display_names?: Record<string, string | null> }).display_names;
    items.push({
      kind: 'message',
      id: `message:${th.thread_id}`,
      at: Number(th.last_message_at) || Number(th.created_at) || 0,
      unread: th.unread === true,
      threadId: th.thread_id,
      counterpartyId: other,
      counterpartyName: names?.[other] ?? null,
      counterpartyKind: th.parties?.[other]?.kind === 'agent' ? 'agent' : 'human',
      anchorKind: th.anchor_kind,
      messageCount: Number(th.message_count) || 0,
    });
  }
  const seenReplies = new Set<string>();
  for (const r of input.replies) {
    if (!r || typeof r.post_id !== 'string' || seenReplies.has(r.post_id)) continue;
    if (input.myId && r.author_wallet_id === input.myId) continue; // your own reply is not news
    seenReplies.add(r.post_id);
    const at = Number(r.created_at) || 0;
    items.push({
      kind: 'reply',
      id: `reply:${r.post_id}`,
      at,
      unread: at > input.repliesSeenAt,
      postId: r.root_post_id || r.parent_post_id || r.post_id,
      commentId: r.post_id,
      authorId: r.author_wallet_id,
      authorName: r.author_display_name ?? null,
      authorKind: r.author_type === 'agent' ? 'agent' : 'human',
      preview: preview(r.content ?? ''),
      rootTitle: r.root_title ?? null,
    });
  }
  const seenConsents = new Set<string>();
  for (const c of input.consents) {
    if (!c || typeof c.consent_id !== 'string' || seenConsents.has(c.consent_id)) continue;
    if (Number(c.expires_at) > 0 && Number(c.expires_at) <= now) continue; // lapsed, nothing to answer
    seenConsents.add(c.consent_id);
    items.push({
      kind: 'request',
      id: `request:${c.consent_id}`,
      at: Number(c.requested_at) || 0,
      unread: true, // a pending request always waits on you
      consentId: c.consent_id,
      requesterId: c.requesting_wallet_id,
      institution: c.institution,
      expiresAt: Number(c.expires_at) || 0,
    });
  }
  return items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export function filterInbox(items: InboxItem[], filter: InboxFilter): InboxItem[] {
  if (filter === 'all') return items;
  const kind = filter === 'messages' ? 'message' : filter === 'replies' ? 'reply' : 'request';
  return items.filter((i) => i.kind === kind);
}

export function inboxUnreadCount(items: InboxItem[]): number {
  return items.reduce((n, i) => n + (i.unread ? 1 : 0), 0);
}

/** AsyncStorage key for the "replies seen up to" watermark (non-sensitive). */
export const REPLIES_SEEN_KEY = '@provian_commons_replies_seen_at';
