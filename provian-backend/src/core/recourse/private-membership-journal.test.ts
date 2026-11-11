import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareMembershipJournalAppend, readMembershipJournal, PRIVATE_MEMBERSHIP_JOURNAL as J,
  membershipJournalHash, type MembershipJournalAccount, type MembershipJournalEntry } from './private-membership-journal';
import { joinPrivateMembership, leavePrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`, a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(8), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a(9), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const position = (n: number) => ({ chainId: '8453' as const, kernel: a(1), pool: a(2), block: n, blockHash: h(n), logIndex: 1, timestamp: n });
function setup() {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const first = joinPrivateMembership(null, 10, rules), ref = db.collection('accounts').doc(h(9));
  const append = async (block: number, kind: Exclude<MembershipJournalEntry['kind'], 'succession'> = 'admission') => db.runTransaction(async tx => {
    const row = await tx.get(ref), account = row.exists ? row.data() as MembershipJournalAccount : null;
    const episode = kind === 'closure' ? leavePrivateMembership(first, 10, rules) : first;
    const prepared = await prepareMembershipJournalAppend(db, tx, { ownerIdentity: h(9), account, episode, position: position(block), kind, evidenceId: h(10) });
    const next = { ownerIdentity: h(9), journalHead: prepared.head, episode };
    prepared.write(); tx.set(ref, next); return next;
  });
  return { db, fake, append };
}
test('append and head advance atomically, salted identical first episodes have different commitments', async () => {
  const s = setup(), first = await s.append(1), second = await s.append(2, 'closure');
  const history = await readMembershipJournal(s.db, second);
  expect(history).toHaveLength(2); expect(history[1].previousId).toBe(first.journalHead);
  expect(history[1].beforeEpisodeHash).toBe(membershipJournalHash(first.episode));
  expect(history[1].episode.joined).toBe(false);
  expect((await setup().append(1)).journalHead).not.toBe(first.journalHead);
});
test('missing entry, edited episode and swapped owner refuse instead of rewriting history', async () => {
  const s = setup(), first = await s.append(1), second = await s.append(2, 'closure');
  const key = `${J}/${first.journalHead}`, original = s.fake.store.get(key)!;
  s.fake.store.delete(key); await expect(readMembershipJournal(s.db, second)).rejects.toThrow('missing_entry');
  s.fake.store.set(key, { ...original, episode: second.episode });
  await expect(readMembershipJournal(s.db, second)).rejects.toThrow('journal_entry');
  s.fake.store.set(key, original);
  await expect(readMembershipJournal(s.db, { ...second, ownerIdentity: h(55) })).rejects.toThrow('journal_owner');
  await expect(readMembershipJournal(s.db, { ...second, episode: first.episode })).rejects.toThrow('journal_chain');
});
test('backward receipt and mismatched account head refuse before consuming any effect', async () => {
  const s = setup(), first = await s.append(10), size = s.fake.store.size;
  await expect(s.append(9, 'closure')).rejects.toThrow('journal_order');
  await expect(s.append(10, 'closure')).rejects.toThrow('journal_order');
  expect(s.fake.store.size).toBe(size);
  s.fake.store.set(`accounts/${h(9)}`, { ...first, episode: leavePrivateMembership(first.episode, 10, rules) });
  await expect(s.append(11, 'closure')).rejects.toThrow('head_mismatch');
  expect(s.fake.store.size).toBe(size);
});
test('a missing root and a changed domain cannot be silently treated as an admission or successor', async () => {
  const s = setup(); await expect(s.append(1, 'closure')).rejects.toThrow('missing_admission');
  const first = await s.append(1);
  await expect(s.db.runTransaction(tx => prepareMembershipJournalAppend(s.db, tx, { ownerIdentity: h(9), account: first,
    episode: first.episode, position: { ...position(2), pool: a(55) }, kind: 'debit', evidenceId: h(10) }))).rejects.toThrow('succession_required');
  await expect(readMembershipJournal(s.db, { ...first, journalHead: undefined })).rejects.toThrow('missing_head');
});
