import { readPrivateMembershipScan } from './private-membership-scan';
jest.mock('./private-membership-scan', () => ({ readPrivateMembershipScan: jest.fn() }));
import type { Firestore } from 'firebase-admin/firestore';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { resolveHistoricalProtocolDeployment } from '../protocol/pointer';
import { createRecourseChainPort } from './chain-ledger';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { joinPrivateMembership, creditPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { utcCalendarMonth } from './calendar-month';
import { membershipJournalHash as hash, prepareMembershipJournalAppend, readMembershipJournal, activeMembershipJournal,
  PRIVATE_MEMBERSHIP_JOURNAL as J, type MembershipJournalEntry } from './private-membership-journal';
import { readPrivateMembershipSuccession, commitPrivateMembershipSuccession } from './private-membership-succession';
import { privateMembershipAtLoss } from './membership-at-loss';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../onchain/economic-discovery', () => ({ getAgreedBaseLogs: jest.fn() }));
jest.mock('../protocol/pointer', () => ({ resolveHistoricalProtocolDeployment: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: { address: '0x0000000000000000000000000000000000000009', runtimeHash: '0x' + '11'.repeat(32) } }));
jest.mock('./chain-ledger', () => ({ createRecourseChainPort: jest.fn() }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ownerId = h(9), binding = h(8), wallet = a(8), accountKey = `${C.owners}/${ownerId}`, ownerKey = `${R.owners}/${ownerId}`;
const jan = Date.UTC(2026,0,1) / 1000, month = utcCalendarMonth(jan);
const stamp = (block: number) => jan + ({ 20: 0, 50: 30, 70: 35, 80: 36, 90: 39, 95: 39, 100: 40, 110: 41, 120: 42, 150: 45, 190: 59, 200: 60, 201: 61 }[block] ?? 40) * 86400;
const rules: PrivateCalendarRules = () => ({ ruleHash: h(1), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
  pointer: a(9), firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
const publicationAbi = new Interface(['event DeploymentChanged(uint256 indexed revision,bytes32 indexed manifestHash,address[10] components,bytes32[10] runtimeHashes)']);
const authority = new Interface(['function ownerAuthorization() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function cryptographicBreak() view returns(bool)', 'function kernel() view returns(address)',
  'function retired(address) view returns(bool)',
  'function getBatchRecord(bytes32) view returns((bool settled,uint8 lane,uint64 epoch,uint256 finalizedCursorStart,uint256 finalizedCursorEnd,bytes32 policyHash,bytes32 claimsHash,bytes32 settlementDigest,uint256 grossInput,uint256 totalMinted,uint256 contributorTotal,uint256 provianTotal,uint256 foundationTotal,uint256 recipientCount,uint256 claimCount))']);
function setup(joinBlock = 20) {
  const fake = createFakeFirestore({ strictTransactionOrder: true, rejectUndefinedValues: true }), db = fake as unknown as Firestore;
  const state = { block: 100, effective: 90, revision: 2n, republish: false, cutoff: 50, afterBreak: true, retired: true, disagreement: false, wrongCutoff: false, batchSettled: false, batchCancelled: false, nextDebit: 0, absentBinding: '' as string,
    priorPool: a(1), priorKernel: a(2), pool: a(3), kernel: a(4), events: [] as ReturnType<typeof event>[] };
  fake.store.set(ownerKey, { ownerIdentity: ownerId, bindingSetVersion: 1, membershipTransition: null });
  fake.store.set(`${R.addresses}/${wallet}`, { ownerIdentity: ownerId, identity: binding, address: wallet, kernel: a(2) });
  const account = seedMembershipJournal(fake.store, { ownerIdentity: ownerId, version: 0, needsScan: false, pendingReservation: null,
    episode: joinPrivateMembership(null, utcCalendarMonth(stamp(joinBlock)), rules), checkpoint: { pool: a(1), block: 80, blockHash: h(80) } },
    { chainId: '8453', kernel: a(2), pool: a(1), block: joinBlock, blockHash: h(joinBlock), logIndex: 1, timestamp: stamp(joinBlock) });
  fake.store.set(accountKey, account);
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  (createRecourseChainPort as jest.Mock).mockReturnValue({ finalizedBlock: async () => state.block, blockHash: async (n: number) => h(n) });
  const manifest = (next: boolean, override?: bigint) => {
    const components = Array.from({ length: 10 }, (_, i) => a(50+i)); components[0] = next ? state.kernel : state.priorKernel; components[8] = next ? state.pool : state.priorPool;
    const hashes = Array.from({ length: 10 }, (_, i) => h(i+100)), revision = override ?? (next ? state.revision : state.revision - (state.republish ? 2n : 1n));
    const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','address[10]','bytes32[10]'], [8453,a(9),revision,components,hashes]));
    return { components, hashes, revision, digest };
  };
  (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(async (_r,_p,_h,n: number) => {
    const m = manifest(n === state.block); return { pointer: a(9), blockHash: h(n), manifestHash: m.digest, revision: m.revision,
      addresses: { kernel: m.components[0], recoursePool: m.components[8] } };
  });
  (getAgreedBaseLogs as jest.Mock).mockImplementation(async ({ address: target, fromBlock, toBlock }) => {
    const m = manifest(true, state.republish ? state.revision - 1n : state.revision), publication = { ...publicationAbi.encodeEventLog(publicationAbi.getEvent('DeploymentChanged')!, [m.revision,m.digest,m.components,m.hashes]),
      address: a(9), blockNumber: state.effective, blockHash: h(state.effective), logIndex: 4, transactionHash: h(700), removed: false };
    const activation = { ...RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('PoolHistoryActivated')!, [h(7),4]),
      address: state.pool, blockNumber: state.effective, blockHash: h(state.effective), logIndex: 3, transactionHash: h(699), removed: false };
    const last = manifest(true), republished = { ...publication, ...publicationAbi.encodeEventLog(publicationAbi.getEvent('DeploymentChanged')!, [last.revision,last.digest,last.components,last.hashes]), blockNumber: 95, blockHash: h(95) };
    return (target === a(9) ? state.republish ? [publication, republished] : [publication] : [activation, ...state.events]).filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  });
  (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([0,1].map(index => ({ operatorId: `operator-${index}`, provider: {
    send: async (method: string, params: readonly unknown[]) => {
      if (method === 'eth_getBlockByNumber') { const n = Number(params[0]); return { hash: h(n), timestamp: `0x${stamp(n).toString(16)}` }; }
      if (method !== 'eth_call') throw Error('unexpected RPC');
      const call = params[0] as { to: string; data: string }, contract = call.to === state.pool || call.to === state.priorPool ? RECOURSE_POOL_ABI : authority;
      const parsed = contract.parseTransaction({ data: call.data })!, name = parsed.name;
      let result: readonly unknown[];
      if (name === 'poolSnapshot') result = [state.priorPool, state.cutoff, h(7), 4, state.afterBreak];
      else if (name === 'poolHistoryReady') result = [true];
      else if (name === 'token') result = [state.kernel];
      else if (name === 'ownerAuthorization') result = [a(10)];
      else if (name === 'kernel') result = [state.kernel];
      else if (name === 'predecessor') result = [state.priorKernel];
      else if (name === 'lastGoodBlock') result = [state.cutoff + (state.wrongCutoff ? 1 : 0)];
      else if (name === 'cryptographicBreak') result = [state.afterBreak];
      else if (name === 'retired') result = [state.retired && !(state.disagreement && index === 1)];
      else if (name === 'getBatchRecord') result = [[state.batchSettled,0,1,0,0,h(1),h(2),h(3),0,0,0,0,0,0,0]];
      else if (name === 'cancelledIssuanceBatch') result = [state.batchCancelled];
      else if (name === 'addressConsent') result = parsed.args[0] === state.absentBinding ? [0,0,false] : [1,1,true];
      else if (name === 'debitNonce') result = [call.to === state.pool ? state.nextDebit : 0];
      else throw Error(`unexpected call ${name}`);
      return contract.encodeFunctionResult(name, result);
    },
  } })));
  const credit = async (block: number, pool = state.priorPool, kernel = state.priorKernel) => {
    const ref = db.collection(C.owners).doc(ownerId);
    return db.runTransaction(async tx => {
      const row = await tx.get(ref), old = row.data() as PrivateMembershipAccount;
      const episode = creditPrivateMembership(old.episode, month + 1, month, { burnAtomic: '100', reserveAtomic: '100' }, rules);
      const journal = await prepareMembershipJournalAppend(db, tx, { ownerIdentity: ownerId, account: old, episode, kind: 'debit', evidenceId: h(block + 500),
        position: { chainId: '8453', pool, kernel, block, blockHash: h(block), logIndex: 2, timestamp: stamp(block) } });
      journal.write(); tx.update(ref, { journalHead: journal.head, episode, version: old.version + 1,
        checkpoint: { pool, block, blockHash: h(block) } });
    });
  };
  return { fake, db, state, account, credit, current: () => fake.store.get(accountKey) as unknown as PrivateMembershipAccount };
}
function event(name: 'MembershipDebitCancelled' | 'MembershipDebitExecuted', args: readonly unknown[]) {
  return { ...RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent(name)!, args), address: a(3), blockNumber: 100,
    blockHash: h(100), logIndex: 2, transactionHash: h(500), removed: false };
}
beforeEach(() => { jest.resetAllMocks(); (readPrivateMembershipScan as jest.Mock).mockRejectedValue(Error('recourse_membership_succession_reconciliation_pending')); });
test('break selects cutoff history, retains discarded payments and fences, and rejects fabricated proof', async () => {
  const s = setup(); await s.credit(70);
  s.fake.store.set(`${C.effects}/${h(22)}`, { ownerIdentity: ownerId });
  const proof = await readPrivateMembershipSuccession(s.db, ownerId);
  expect(proof.entry.episode.invoices[String(month)].burnPaidAtomic).toBe('0');
  await expect(commitPrivateMembershipSuccession(s.db, { ...proof })).rejects.toThrow('unverified');
  await commitPrivateMembershipSuccession(s.db, proof);
  const audit = await readMembershipJournal(s.db, s.current());
  expect(audit).toHaveLength(3); expect(activeMembershipJournal(audit)).toHaveLength(2);
  expect(audit[1].episode.invoices[String(month)].burnPaidAtomic).toBe('100');
  expect(s.fake.store.has(`${C.effects}/${h(22)}`)).toBe(true);
  expect(privateMembershipAtLoss(binding, audit, { ...proof.entry.position, block: 201, blockHash: h(201), timestamp: stamp(201), logIndex: 2 },
    { generation: 1, active: true, admissionLogIndex: 0, closureLogIndex: 0 }, rules).active).toBe(false);
  await expect(commitPrivateMembershipSuccession(s.db, proof)).rejects.toThrow('concurrent');
});
test('admission after cutoff becomes never-admitted and cannot import a discarded invoice or debt', async () => {
  const s = setup(70), proof = await readPrivateMembershipSuccession(s.db, ownerId);
  expect(proof.entry.episode).toMatchObject({ generation: 0, joined: false, invoices: {}, endMonthExclusive: null });
  await commitPrivateMembershipSuccession(s.db, proof);
  const rejoined = joinPrivateMembership(s.current().episode, month + 2, rules);
  expect(rejoined.generation).toBe(1); expect(Object.keys(rejoined.invoices)).toEqual([String(month + 2)]);
});
test('ordinary succession carries all prior credits and refuses rollback, wrong cutoff or unretired contracts', async () => {
  const s = setup(); await s.credit(70); s.state.afterBreak = false;
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('ordinary_rollback');
  s.state.cutoff = 70;
  expect((await readPrivateMembershipSuccession(s.db, ownerId)).entry.episode.invoices[String(month)].burnPaidAtomic).toBe('100');
  s.state.wrongCutoff = true; await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('kernel_cutoff');
  s.state.wrongCutoff = false; s.state.retired = false;
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('not_retired');
  s.state.retired = true; s.state.disagreement = true;
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('disagreement');
});
test('stale cutoff reconciliation and potentially earlier pending execution refuse; provably later pending work is retained as superseded', async () => {
  const s = setup(), pending = h(22);
  s.fake.store.set(accountKey, { ...s.current(), checkpoint: { pool: a(1), block: 20, blockHash: h(20) } });
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('reconciliation_pending');
  s.fake.store.set(accountKey, { ...s.account, pendingReservation: pending });
  const reservation = { id: pending, ownerIdentity: ownerId, domain: { pointer: a(9), pool: a(1), kernel: a(2) }, checkpoint: { block: 20 } };
  s.fake.store.set(`${C.reservations}/${pending}`, { status: 'pending', reservation });
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('pending_reconciliation');
  s.fake.store.set(`${C.reservations}/${pending}`, { status: 'pending', reservation: { ...reservation, checkpoint: { block: 80 } } });
  s.fake.store.set(ownerKey, { ...s.fake.store.get(ownerKey), membershipTransition: 'transition' });
  s.fake.store.set(`${T}/transition`, { ownerIdentity: ownerId, pool: a(1), kernel: a(2), status: 'consenting' });
  await commitPrivateMembershipSuccession(s.db, await readPrivateMembershipSuccession(s.db, ownerId));
  expect(s.fake.store.get(`${C.reservations}/${pending}`)?.status).toBe('superseded');
  expect(s.fake.store.get(`${T}/transition`)?.status).toBe('superseded');
  expect(s.current().pendingReservation).toBeNull();
});
test('successor cancellation counters must replay completely and concurrent portfolio changes invalidate a proof', async () => {
  const s = setup(); s.state.nextDebit = 1;
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('counter_gap');
  s.state.events = [event('MembershipDebitCancelled', [binding, 0])];
  const proof = await readPrivateMembershipSuccession(s.db, ownerId);
  s.fake.store.set(`${R.addresses}/${a(12)}`, { ownerIdentity: ownerId, identity: h(12), address: a(12) });
  await expect(commitPrivateMembershipSuccession(s.db, proof)).rejects.toThrow('concurrent');
  expect(s.current().journalHead).toBe(s.account.journalHead);
});
test('a second break follows the selected branch and never resurrects a first-break discarded payment', async () => {
  const s = setup(); await s.credit(70); await commitPrivateMembershipSuccession(s.db, await readPrivateMembershipSuccession(s.db, ownerId));
  await s.credit(120, a(3), a(4));
  s.state.priorPool = a(3); s.state.priorKernel = a(4); s.state.pool = a(5); s.state.kernel = a(6); s.state.block = 200; s.state.effective = 190; s.state.revision = 3n; s.state.cutoff = 110;
  const proof = await readPrivateMembershipSuccession(s.db, ownerId);
  await commitPrivateMembershipSuccession(s.db, proof);
  const audit = await readMembershipJournal(s.db, s.current()), selected = activeMembershipJournal(audit);
  expect(audit).toHaveLength(5); expect(selected).toHaveLength(3);
  expect(selected.map(e => e.position.block)).toEqual([20,90,190]);
  expect(s.current().episode.invoices[String(month)].burnPaidAtomic).toBe('0');
  // A valid content hash cannot make an ancestor from a discarded branch eligible.
  const body = { ...proof.entry, succession: { ...proof.entry.succession!, ancestorId: audit[1].id } };
  const { id: _id, ...rest } = body; const forged: MembershipJournalEntry = { ...rest, id: hash(rest) };
  expect(() => activeMembershipJournal([...audit.slice(0,-1), forged])).toThrow('succession_ancestor');
  expect(s.fake.store.has(`${J}/${audit[1].id}`)).toBe(true);
});

test('imported protection starts at the publication position even when private replay arrives later', async () => {
  const s = setup(), proof = await readPrivateMembershipSuccession(s.db, ownerId);
  await commitPrivateMembershipSuccession(s.db, proof);
  expect(proof.entry.position.block).toBe(90); expect(s.current().checkpoint.block).toBe(100);
  const audit = await readMembershipJournal(s.db, s.current());
  expect(privateMembershipAtLoss(binding, audit, { ...proof.entry.position, block: 95, blockHash: h(95), timestamp: stamp(95), logIndex: 2 },
    { generation: 1, active: true, admissionLogIndex: 0, closureLogIndex: 0 }, rules).active).toBe(true);
  expect(() => privateMembershipAtLoss(binding, audit, { ...proof.entry.succession!.cutoff, block: 70, blockHash: h(70), timestamp: stamp(70), logIndex: 2 },
    { generation: 1, active: true, admissionLogIndex: 0, closureLogIndex: 0 }, rules)).toThrow('loss_after_cutoff');
});

test('a later pointer revision retaining the same kernel and pool never postpones membership activation', async () => {
  const s = setup(); s.state.republish = true; s.state.revision = 3n;
  const proof = await readPrivateMembershipSuccession(s.db, ownerId);
  expect(proof.entry.position.block).toBe(90);
});

test('an interrupted first join with only partial consent creates an explicit unadmitted successor root', async () => {
  const s = setup(); s.fake.store.delete(accountKey);
  for (const key of s.fake.store.keys()) if (key.startsWith(J + '/')) s.fake.store.delete(key);
  s.fake.store.set(ownerKey, { ...s.fake.store.get(ownerKey), membershipTransition: 'first-join' });
  s.fake.store.set(`${R.addresses}/${a(88)}`, { ownerIdentity: ownerId, identity: h(88), address: a(88), kernel: a(2) });
  s.state.absentBinding = h(88);
  const bindings = [binding,h(88)].map(id => ({ binding: id, address: id === binding ? wallet : a(88), nonce: '0', generation: '0',
    initiallyJoined: false, recoveryGeneration: 0, departure: null, admission: null }));
  s.fake.store.set(`${T}/first-join`, { id: 'first-join', ownerIdentity: ownerId, kind: 'join', status: 'consenting', pool: a(1), kernel: a(2),
    checkpoint: { block: 20, blockHash: h(20), logIndex: 0, timestamp: stamp(20) }, bindings });
  const proof = await readPrivateMembershipSuccession(s.db, ownerId);
  expect(proof.entry.previousId).toBeNull(); expect(proof.entry.episode.generation).toBe(0);
  await commitPrivateMembershipSuccession(s.db, proof);
  expect(await readMembershipJournal(s.db, s.current())).toHaveLength(1);
  expect(s.fake.store.get(`${T}/first-join`)?.status).toBe('superseded');
  expect(joinPrivateMembership(s.current().episode, month + 1, rules).generation).toBe(1);
});
test('fully executed but unrecorded first-join consent must reconcile instead of being erased as unadmitted', async () => {
  const s = setup(); s.fake.store.delete(accountKey);
  s.fake.store.set(ownerKey, { ...s.fake.store.get(ownerKey), membershipTransition: 'first-join' });
  s.fake.store.set(`${T}/first-join`, { id: 'first-join', ownerIdentity: ownerId, kind: 'join', status: 'consenting', pool: a(1), kernel: a(2),
    checkpoint: { block: 20, blockHash: h(20), logIndex: 0, timestamp: stamp(20) },
    bindings: [{ binding, nonce: '0', generation: '0', initiallyJoined: false }] });
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('first_join_reconciliation_pending');
  expect(s.fake.store.has(accountKey)).toBe(false);
  await expect(readPrivateMembershipSuccession(s.db, ownerId, { block: 101, blockHash: h(101) })).rejects.toThrow('observation');
  await expect(readPrivateMembershipSuccession(s.db, ownerId, { block: 100, blockHash: h(99) })).rejects.toThrow('reorg');
});

test('an authenticated complete old-domain scan reaches a lagged cutoff and every credited effect is rechecked at commit', async () => {
  const s = setup(), effect = { kernel: a(2), transactionHash: h(45), logIndex: 2 };
  s.fake.store.set(accountKey, { ...s.current(), checkpoint: { pool: a(1), block: 20, blockHash: h(20) } });
  (readPrivateMembershipScan as jest.Mock).mockResolvedValue({ ownerIdentity: ownerId, historical: true, accountVersion: 0, bindingHash: h(8),
    fromBlock: 20, fromBlockHash: h(20), pool: a(1), block: 50, blockHash: h(50), timestamp: stamp(50), receipts: [], requiredEffects: [effect] });
  await expect(readPrivateMembershipSuccession(s.db, ownerId)).rejects.toThrow('reconciliation_pending');
  const id = hash([a(2),a(1),h(45),2]); s.fake.store.set(`${C.effects}/${id}`, { ownerIdentity: ownerId });
  const proof = await readPrivateMembershipSuccession(s.db,ownerId);
  expect(readPrivateMembershipScan).toHaveBeenCalledWith(s.db,ownerId,expect.objectContaining({ pool: a(1),block: 50,blockHash: h(50) }));
  s.fake.store.delete(`${C.effects}/${id}`);
  await expect(commitPrivateMembershipSuccession(s.db,proof)).rejects.toThrow('concurrent');
  s.fake.store.set(`${C.effects}/${id}`, { ownerIdentity: ownerId });
  await commitPrivateMembershipSuccession(s.db,proof);
  expect(s.current().checkpoint.pool).toBe(a(3));
});

test('missing issuance logs cannot erase a batch that the cutoff kernel records as settled or cancelled', async () => {
  const s = setup(), id = h(123);
  s.fake.store.set(accountKey, { ...s.current(), pendingReservation: id, checkpoint: { pool: a(1),block: 20,blockHash: h(20) } });
  s.fake.store.set(`${C.reservations}/${id}`, { status: 'pending', reservation: { id, ownerIdentity: ownerId,kind: 'issuance',
    domain: { pointer: a(9),kernel: a(2),pool: a(1) }, checkpoint: { block: 20 },context: { batchId: h(124) } } });
  (readPrivateMembershipScan as jest.Mock).mockResolvedValue({ ownerIdentity: ownerId,historical: true,accountVersion: 0,bindingHash: h(8),
    fromBlock: 20,fromBlockHash: h(20),pool: a(1),block: 50,blockHash: h(50),timestamp: stamp(50),receipts: [],requiredEffects: [] });
  s.state.batchSettled = true;
  await expect(readPrivateMembershipSuccession(s.db,ownerId)).rejects.toThrow('pending_reconciliation');
  s.state.batchSettled = false; s.state.batchCancelled = true;
  await expect(readPrivateMembershipSuccession(s.db,ownerId)).rejects.toThrow('pending_reconciliation');
  s.state.batchCancelled = false;
  await commitPrivateMembershipSuccession(s.db,await readPrivateMembershipSuccession(s.db,ownerId));
  expect(s.fake.store.get(`${C.reservations}/${id}`)?.status).toBe('superseded');
});
