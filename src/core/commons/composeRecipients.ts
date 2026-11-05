/**
 * composeRecipients (, item 3) — who "New message" in the Inbox offers.
 *
 * The person's own linked agents come first (filtered by the search text), then Directory profiles
 * matching it — never the person themselves, and never an agent twice. Picking one opens the direct
 * thread with them; the speech-window rule applies there unchanged.
 *
 * Pure (no React Native), so the rule is testable under Vitest.
 */

export interface ComposeRecipient {
  readonly walletId: string;
  readonly name: string;
  readonly kind: 'agent' | 'human';
}

export interface ComposeRecipientLists {
  /** The person's own linked agents. */
  readonly own: ComposeRecipient[];
  /** Everyone else the Directory returned for the search. */
  readonly directory: ComposeRecipient[];
}

export function composeRecipients(input: {
  readonly linkedAgents: ReadonlyArray<{ wallet_id: string; display_name: string }>;
  readonly profiles: ReadonlyArray<{ wallet_id: string; display_name: string; participant_type: 'agent' | 'human' }>;
  readonly myId: string | null;
  readonly query: string;
}): ComposeRecipientLists {
  const q = input.query.trim().toLowerCase();
  const matches = (name: string, walletId: string) => q === '' || name.toLowerCase().includes(q) || walletId.toLowerCase().startsWith(q);
  const seen = new Set<string>();
  if (input.myId) seen.add(input.myId);
  const own: ComposeRecipient[] = [];
  for (const a of input.linkedAgents) {
    if (seen.has(a.wallet_id)) continue;
    seen.add(a.wallet_id);
    if (matches(a.display_name, a.wallet_id)) own.push({ walletId: a.wallet_id, name: a.display_name, kind: 'agent' });
  }
  const directory: ComposeRecipient[] = [];
  for (const p of input.profiles) {
    if (seen.has(p.wallet_id)) continue;
    seen.add(p.wallet_id);
    directory.push({ walletId: p.wallet_id, name: p.display_name, kind: p.participant_type });
  }
  return { own, directory };
}
