import { PRIVATE_MEMBERSHIP_JOURNAL, membershipJournalHash, type MembershipJournalPosition } from '../private-membership-journal';
import type { PrivateMembershipAccount } from '../private-membership-reservation';
/** Seed a valid pre-existing episode using the production content hash. Tests of
 * admission itself use the actual transition and journal append transaction. */
export function seedMembershipJournal(store: Map<string, FirebaseFirestore.DocumentData>, account: PrivateMembershipAccount,
  position: MembershipJournalPosition): PrivateMembershipAccount & Record<string, unknown> {
  const body = { ownerIdentity: account.ownerIdentity, previousId: null,
    salt: `0x${'ab'.repeat(32)}`, kind: 'admission' as const, beforeEpisodeHash: membershipJournalHash(null),
    episode: account.episode, position, evidenceId: `0x${'cd'.repeat(32)}` };
  const entry = { id: membershipJournalHash(body), ...body };
  store.set(`${PRIVATE_MEMBERSHIP_JOURNAL}/${entry.id}`, entry);
  return { ...account, journalHead: entry.id };
}
