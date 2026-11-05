import type { ThreadMessage } from './CommonsService';

export const THREAD_PAGE_SIZE = 100;

/** Merge a fetched page without dropping older history or an outgoing message sent during the fetch. */
export function mergeThreadMessages(current: ThreadMessage[], page: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map(current.map((message) => [message.message_id, message]));
  for (const message of page) byId.set(message.message_id, message);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at || a.message_id.localeCompare(b.message_id));
}

/** The cursor comes only from this fetched page, never the thread summary or the wall clock. */
export function fetchedReadCursor(messages: ThreadMessage[]): number {
  return messages.reduce((at, message) => Math.max(at, message.created_at), 0);
}
