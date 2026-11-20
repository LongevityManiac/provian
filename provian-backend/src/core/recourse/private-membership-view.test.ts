jest.mock('./private-membership-domain', () => ({ reconcilePrivateMembershipDomain: jest.fn(async () => undefined) }));
import { joinPrivateMembership, creditPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { projectPrivateMembershipView } from './private-membership-view';
import type { PrivateMembershipAccount } from './private-membership-reservation';
const rules: PrivateCalendarRules = () => ({ ruleHash: `0x${'12'.repeat(32)}`, rule: {
  schema: 'provian-recourse-membership/v1', chainId: 8453, pointer: `0x${'34'.repeat(20)}`, firstMonth: 0,
  participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100,
} });
const account = (): PrivateMembershipAccount => ({ ownerIdentity: `0x${'56'.repeat(32)}`, version: 1,
  checkpoint: { pool: `0x${'78'.repeat(20)}`, block: 100, blockHash: `0x${'9a'.repeat(32)}` },
  needsScan: false, pendingReservation: null, episode: joinPrivateMembership(null, 100, rules) });
test('membership, grace and amounts derive from the private calendar without publishing owner keys or advancing stored time', () => {
  const state = account(), original = JSON.stringify(state);
  expect(projectPrivateMembershipView(state, 100, rules)).toMatchObject({ enrolled: true, grace: false, unpaidAtomic: '100' });
  expect(projectPrivateMembershipView(state, 101, rules)).toMatchObject({ enrolled: true, grace: true, unpaidAtomic: '300', endMonthExclusive: '102' });
  const expired = projectPrivateMembershipView(state, 102, rules);
  expect(expired).toMatchObject({ enrolled: false, grace: false, unpaidAtomic: '400', endMonthExclusive: '102' });
  expect(JSON.stringify(expired)).not.toContain(state.ownerIdentity);
  expect(JSON.stringify(state)).toBe(original);
});
test('the burn and no-earnings contribution are separate; paying only the burn does not erase the reserve obligation', () => {
  const state = account();
  const paid = { ...state, episode: creditPrivateMembership(state.episode, 100, 100, { burnAtomic: '100', reserveAtomic: '0' }, rules) };
  expect(projectPrivateMembershipView(paid, 100, rules).unpaidAtomic).toBe('0');
  expect(projectPrivateMembershipView(paid, 101, rules)).toMatchObject({ enrolled: true, grace: true, unpaidAtomic: '200' });
});

test('display dates use the confirmed admission and prospective rules without moving private calendar state', () => {
  const month = 2026 * 12 + 10;
  const future: PrivateCalendarRules = m => ({ ...rules(m), rule: { ...rules(m).rule,
    participationBurnAtomic: m > month ? '200' : '100' } });
  const state = { ...account(), episode: joinPrivateMembership(null, month, future),
    admission: { block: 100, blockHash: `0x${'9a'.repeat(32)}`, logIndex: 2, timestamp: 1794500000 } };
  const original = JSON.stringify(state);
  expect(projectPrivateMembershipView(state, month, future).details).toEqual({ status: 'protected',
    protectionStartedAtMs: 1794500000000, nextMonthAtMs: Date.UTC(2026, 11, 1),
    nextBurnAtomic: '200', noEarningsContributionAtomic: '100', earningsBps: 100 });
  const expired = projectPrivateMembershipView(state, month + 2, future);
  expect(expired.details.status).toBe('lapsed');
  expect(expired.details.nextMonthAtMs).toBeNull();
  expect(expired.details.nextBurnAtomic).toBeNull();
  expect(projectPrivateMembershipView({ ...state, admission: null }, month, future).details.protectionStartedAtMs).toBeNull();
  expect(JSON.stringify(state)).toBe(original);
});

test('the actual private view selects retained admission and closure history after succession', async () => {
  const { createFakeFirestore } = await import('../pvt/__test-helpers__/fake-firestore');
  const scans = await import('./private-membership-scan');
  const calendars = await import('./private-calendar-rules');
  const journals = await import('./private-membership-journal');
  const { readPrivateMembershipView } = await import('./private-membership-view');
  const { leavePrivateMembership } = await import('./private-membership-calendar');
  const { PRIVATE_MEMBERSHIP_COLLECTIONS: C } = await import('./private-membership-reservation');
  const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
  const a = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
  const month = 2026 * 12 + 10, stamp = (day: number): number => Date.UTC(2026, 10, day) / 1000;
  const db = createFakeFirestore({ strictTransactionOrder: true });
  let state: PrivateMembershipAccount = { ...account(), episode: joinPrivateMembership(null, month, rules), admission: null, closure: null,
    journalHead: h(5), checkpoint: { pool: a(5), block: 10, blockHash: h(10) } };
  const position = (n: number) => ({ chainId: '8453' as const, kernel: a(1), pool: a(2), block: n,
    blockHash: h(n), logIndex: 1, timestamp: stamp(n) });
  const entry = (n: number, kind: 'admission' | 'closure'): import('./private-membership-journal').MembershipJournalEntry => ({
    id: h(n), ownerIdentity: state.ownerIdentity, previousId: n === 1 ? null : h(n - 1), salt: h(8), kind,
    beforeEpisodeHash: h(9), episode: state.episode, position: position(n), evidenceId: h(7),
  });
  const first = entry(1, 'admission'), discarded = entry(3, 'admission');
  let audit: import('./private-membership-journal').MembershipJournalEntry[] = [first, discarded,
    { ...entry(5, 'admission'), kind: 'succession', position: { ...position(5), kernel: a(4), pool: a(5) },
      succession: { cutoff: { ...position(2), logIndex: Number.MAX_SAFE_INTEGER }, ancestorId: first.id,
        afterBreak: true, manifestHash: h(8), previousManifestHash: h(9) } }];
  const journal = jest.spyOn(journals, 'readMembershipJournal').mockImplementation(async () => audit);
  const scan = jest.spyOn(scans, 'readPrivateMembershipScan').mockResolvedValue({ ownerIdentity: state.ownerIdentity,
    accountVersion: state.version, bindingHash: h(7), historical: false, fromBlock: 10, fromBlockHash: h(10),
    pool: a(5), block: 10, blockHash: h(10), timestamp: stamp(10), receipts: [], requiredEffects: [] });
  const commit = jest.spyOn(scans, 'commitPrivateMembershipScan').mockResolvedValue(undefined);
  const calendar = jest.spyOn(calendars, 'readPrivateCalendarRules').mockResolvedValue(rules);
  const pool = { pool: a(5), addressConsent: true, block: 10, blockHash: h(10) } as import('./pool-state').RecoursePoolState;
  try {
    db.store.set(`${C.owners}/${state.ownerIdentity}`, { ...state });
    const active = await readPrivateMembershipView(db as unknown as import('firebase-admin/firestore').Firestore, state.ownerIdentity, pool);
    expect(journal).toHaveBeenCalled();
    expect(active).toMatchObject({ details: { protectionStartedAtMs: stamp(1) * 1000 } });
    const closedEpisode = leavePrivateMembership(state.episode, month, rules);
    const closure = { ...entry(2, 'closure'), episode: closedEpisode };
    state = { ...state, episode: closedEpisode };
    audit = [first, closure, { ...audit[2], episode: closedEpisode,
      succession: { ...audit[2].succession!, cutoff: { ...position(4), logIndex: Number.MAX_SAFE_INTEGER }, ancestorId: closure.id } }];
    db.store.set(`${C.owners}/${state.ownerIdentity}`, { ...state });
    const left = await readPrivateMembershipView(db as unknown as import('firebase-admin/firestore').Firestore, state.ownerIdentity, pool);
    expect(left).toMatchObject({ details: { status: 'not_member', protectionStartedAtMs: stamp(1) * 1000 } });
    expect(db.store.get(`${C.owners}/${state.ownerIdentity}`)).toEqual(state);
  } finally { journal.mockRestore(); scan.mockRestore(); commit.mockRestore(); calendar.mockRestore(); }
});

test('an unfinished join is visible after reopening without granting protection or disclosing private operation data', async () => {
  const { createFakeFirestore } = await import('../pvt/__test-helpers__/fake-firestore');
  const { RECOURSE_COLLECTIONS } = await import('./ownership');
  const { PRIVATE_MEMBERSHIP_TRANSITIONS } = await import('./private-membership-transition');
  const { readPrivateMembershipView } = await import('./private-membership-view');
  const state = account(), owner = state.ownerIdentity, id = `0x${'aa'.repeat(32)}`;
  const ownerKey = `${RECOURSE_COLLECTIONS.owners}/${owner}`;
  const transitionKey = `${PRIVATE_MEMBERSHIP_TRANSITIONS}/${id}`;
  const db = createFakeFirestore({ strictTransactionOrder: true });
  db.store.set(ownerKey, { ownerIdentity: owner, membershipTransition: id });
  const draft = { id, ownerIdentity: owner, kind: 'join', status: 'consenting' };
  db.store.set(transitionKey, draft);
  const read = () => readPrivateMembershipView(db as unknown as import('firebase-admin/firestore').Firestore, owner,
    { addressConsent: false } as import('./pool-state').RecoursePoolState);
  await expect(read()).resolves.toEqual({ membershipTransition: 'join' });
  expect(db.store.size).toBe(2);
  db.store.set(transitionKey, { ...draft, departureRequested: true });
  await expect(read()).resolves.toEqual({ membershipTransition: 'leave' });
  db.store.set(transitionKey, { ...draft, ownerIdentity: `0x${'bb'.repeat(32)}` });
  await expect(read()).rejects.toThrow('recourse_private_membership_transition_invalid');
  db.store.set(transitionKey, { ...draft, status: 'complete' });
  await expect(read()).rejects.toThrow('recourse_private_membership_transition_invalid');
});
