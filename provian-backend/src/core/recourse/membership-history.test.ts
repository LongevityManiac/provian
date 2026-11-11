jest.mock('./private-membership-domain', () => ({ reconcilePrivateMembershipDomain: jest.fn(async () => undefined) }));
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { readLossMembership } from './membership-history';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { readHistoricalRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { PRIVATE_MEMBERSHIP_JOURNAL as J } from './private-membership-journal';
import type { LossSnapshot } from './loss-snapshot';
import { utcCalendarMonth } from './calendar-month';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
jest.mock('./pool-state', () => ({ ...jest.requireActual('./pool-state'), readHistoricalRecoursePoolState: jest.fn() }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn(), readAgreedBaseBlockHash: jest.fn() }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const kernel = a(1), pool = a(2), identity = h(3), ownerIdentity = h(4), accountKey = `${C.owners}/${ownerIdentity}`;
const now = Date.UTC(2026, 10, 1) / 1000;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(8), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a(9), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const snapshot: LossSnapshot = { identity, kernel, block: 80, blockHash: h(80), transactionHash: h(99), firstOutflowLogIndex: 3,
  recordedBalanceAtomic: '100', lossAtomic: '100', addresses: [], outflows: [], occurrence: h(100), evidenceHash: h(101) };
function setup() {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  fake.store.set(`${R.identities}/${identity}`, { ownerIdentity });
  const account = seedMembershipJournal(fake.store, { ownerIdentity, version: 0, needsScan: false, pendingReservation: null,
    checkpoint: { pool, block: 99, blockHash: h(99) }, episode: joinPrivateMembership(null, utcCalendarMonth(now), rules) },
    { chainId: '8453', kernel, pool, block: 20, blockHash: h(20), timestamp: now, logIndex: 1 });
  fake.store.set(accountKey, account);
  const state = { start: 20, end: 0, disagreement: false, reorg: false, changeHead: false, events: [] as ReturnType<typeof consentEvent>[] };
  (readHistoricalRecoursePoolState as jest.Mock).mockResolvedValue({ kernel, pool, timestamp: now + 60, consentGeneration: '1' });
  (readPrivateCalendarRules as jest.Mock).mockImplementation(async () => {
    if (state.changeHead) fake.store.set(accountKey, { ...account, version: 1 }); return rules;
  });
  (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(h(80));
  (getAgreedBaseLogs as jest.Mock).mockImplementation(async () => state.events);
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index => ({ operatorId: `operator-${index}`, provider: {
    send: async (method: string) => {
      if (method === 'eth_getBlockByNumber') return { hash: state.reorg ? h(21) : h(20), timestamp: `0x${now.toString(16)}` };
      if (method === 'eth_call') return RECOURSE_POOL_ABI.encodeFunctionResult('consentPeriods', [state.disagreement && index ? 19 : state.start, state.end]);
      throw Error('unexpected RPC');
    },
  } })));
  return { fake, db, state, account };
}
function consentEvent(joined: boolean, index: number) {
  return { ...RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('AddressConsentChanged')!, [identity, 1, joined, joined ? 0 : 1]),
    address: pool, blockNumber: 80, blockHash: h(80), logIndex: index, transactionHash: h(99), removed: false };
}
beforeEach(() => jest.resetAllMocks());
test('reads the private owner calendar and only the affected address public consent', async () => {
  const s = setup();
  expect(await readLossMembership(s.db, snapshot)).toMatchObject({ active: true, periodIndex: 0, unpaidAtomic: '0' });
  expect(getAgreedBaseLogs).toHaveBeenCalledWith({ address: pool, topics: [RECOURSE_POOL_ABI.getEvent('AddressConsentChanged')!.topicHash, identity], fromBlock: 80, toBlock: 80 });
});
test('same-block address admission and departure use exact event order and missing events refuse', async () => {
  const s = setup(); s.state.start = 80; s.state.events = [consentEvent(true, 2)];
  expect((await readLossMembership(s.db, snapshot)).active).toBe(true);
  s.state.events = [consentEvent(true, 4)]; expect((await readLossMembership(s.db, snapshot)).active).toBe(false);
  s.state.start = 20; s.state.end = 80; s.state.events = [consentEvent(false, 4)];
  expect((await readLossMembership(s.db, snapshot)).active).toBe(true);
  s.state.events = [consentEvent(false, 2)]; expect((await readLossMembership(s.db, snapshot)).active).toBe(false);
  s.state.events = []; await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('history_incomplete');
});
test('pending, incomplete and changed private histories never become an eligibility attestation', async () => {
  const s = setup(); s.fake.store.set(accountKey, { ...s.account, needsScan: true });
  await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('reconciliation_pending');
  s.fake.store.set(accountKey, s.account); s.state.changeHead = true;
  await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('checkpoint_changed');
  s.fake.store.set(accountKey, s.account); s.state.changeHead = false;
  s.fake.store.delete(`${J}/${s.account.journalHead}`);
  await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('missing_entry');
});
test('independent RPC disagreement, reorged journal and mismatched kernel fail closed', async () => {
  const s = setup(); s.state.disagreement = true;
  await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('rpc_disagreement');
  s.state.disagreement = false; s.state.reorg = true;
  await expect(readLossMembership(s.db, snapshot)).rejects.toThrow('journal_reorg');
  s.state.reorg = false;
  await expect(readLossMembership(s.db, { ...snapshot, kernel: a(55) })).rejects.toThrow('membership_kernel');
});
test('no private membership is inactive even if public consent is present', async () => {
  const s = setup(); s.fake.store.delete(accountKey);
  expect((await readLossMembership(s.db, snapshot)).active).toBe(false);
});
