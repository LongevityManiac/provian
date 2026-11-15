import { Interface, Wallet, getBytes, getCreateAddress, keccak256, verifyMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { runRecourseLane, RECOURSE_LANE_COLLECTION } from './transaction-lane';
import { sponsoredLaneKind } from './transaction-lane-kinds';
import { simulatedBase, laneTestWallet } from './__test-helpers__/lane-chain-fixture';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateDebit, reservePrivateMembership, type PrivateMembershipAccount } from './private-membership-reservation';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { STANDING_MEMBERSHIP_ABI, standingMembershipDebitSigningHash } from './membership-authorization';
import { queueMembershipDebit, checkMembershipDebit, membershipDebitAdapter, assertCheckedMembershipDebit,
  MEMBERSHIP_DEBIT_OPERATIONS as Q, type CheckedMembershipDebit } from './membership-debit-operation';
import { utcCalendarMonth } from './calendar-month';
import type { MembershipConsentPorts } from './membership-consent-operation';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { RecoursePoolState } from './pool-state';
import { fixture as receiptFixture, old, pointer, tx as receiptHash } from './__test-helpers__/membership-receipt-fixture';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
jest.mock('../onchain/rpc-provider', () => ({ getOperatorBoundRpcLegs: jest.fn() }));
jest.mock('../protocol/pointer-pin.generated', () => ({ PROTOCOL_POINTER_PIN: {
  address: '0x0000000000000000000000000000000000000001', runtimeHash: require('ethers').keccak256('0x6000'),
} }));
jest.mock('./private-calendar-rules', () => ({ readPrivateCalendarRules: jest.fn() }));
const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
const ownerWallet = new Wallet(h('11')), attestorWallet = new Wallet(h('22')), gasWallet = new Wallet(h('33'));
const laneWallet = laneTestWallet(), LANE = laneWallet.address.toLowerCase();
const now = 1700000000, month = utcCalendarMonth(now);
async function fixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const owner = h('ab'), binding = h('ad'), payer = ownerWallet.address.toLowerCase();
  const domain = { chainId: '8453', pointer, kernel: old[0], pool: old[8] };
  const rules: PrivateCalendarRules = () => ({ ruleHash: h('43'), rule: { schema: 'provian-recourse-membership/v1', chainId: 8453,
    pointer: domain.pointer, firstMonth: 0, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } });
  (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
  const account: PrivateMembershipAccount = seedMembershipJournal(fake.store, { ownerIdentity: owner, version: 0, pendingReservation: null, needsScan: false,
    checkpoint: { pool: domain.pool, block: 10, blockHash: h('45') }, episode: joinPrivateMembership(null, month - 1, rules) },
    { chainId: '8453', kernel: domain.kernel, pool: domain.pool, block: 9, blockHash: h('44'), logIndex: 1, timestamp: now - 30 * 86400 });
  fake.store.set(`${C.owners}/${owner}`, { ...account }); fake.store.set(`${R.owners}/${owner}`, { ownerIdentity: owner });
  fake.store.set(`${R.identities}/${binding}`, { identity: binding, ownerIdentity: owner, recoveryGeneration: 0 });
  fake.store.set(`${R.addresses}/${payer}`, { address: payer, identity: binding, ownerIdentity: owner, recoveryGeneration: 0, kernel: domain.kernel, chainBindingStatus: 'confirmed' });
  const debit = { binding, payer, month: String(month - 1), burn: '40', reserve: '25', nonce: '0', generation: '1', revision: '1', ruleHash: h('43'), expiresAt: String(now + 300) };
  const reservation = planPrivateDebit(account, domain, debit, month, rules);
  await reservePrivateMembership(db, reservation);
  const deployment = { pointer: domain.pointer, addresses: { kernel: domain.kernel, recoursePool: domain.pool, settlement: a('46') },
    revision: 1n, blockHash: h('47'), manifestHash: h('48') } as ProtocolDeployment;
  const state = { pool: domain.pool, kernel: domain.kernel, block: 11, blockHash: deployment.blockHash, timestamp: now,
    currentAddress: payer, signedRuleHash: debit.ruleHash, debitNonce: '0', consentGeneration: '1', addressConsent: true } as RecoursePoolState;
  const controller=getCreateAddress({from:domain.pool,nonce:1}).toLowerCase();
  const wire = new Interface(['function standingMembership() view returns(address)', 'function registryOperator() view returns(address)', 'function identityAttestor() view returns(address)',
    'function restorationAuthority() view returns(address)', 'function pointer() view returns(address)', 'function operationalMinter() view returns(address)',
    'function kernel() view returns(address)', 'function pool() view returns(address)', 'function submitter() view returns(address)', ...STANDING_MEMBERSHIP_ABI.fragments]);
  const p: MembershipConsentPorts = { gasPayer: LANE, state: async () => state, chain: { deployment: async () => deployment, agree: async (method, args) => {
    expect(args[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
    if (method === 'eth_getCode') return '0x';
    const call = args[0] as { to: string; data: string }, parsed = wire.parseTransaction(call)!;
    if (parsed.name === 'executeStandingDebit') {
      expect(call.to).toBe(controller);
      expect(String(parsed.args[0].burn)).toBe('40'); expect(String(parsed.args[0].reserve)).toBe('25');
      const bytes = getBytes(standingMembershipDebitSigningHash(domain, debit));
      expect(verifyMessage(bytes, parsed.args[1])).toBe(attestorWallet.address);
      return '0x';
    }
    const result: Record<string, string> = { standingMembership:controller, registryOperator: a('49'), identityAttestor: attestorWallet.address, restorationAuthority: a('50'),
      pointer: domain.pointer, operationalMinter: deployment.addresses.settlement, kernel: domain.kernel, pool: domain.pool, submitter: gasWallet.address };
    return wire.encodeFunctionResult(parsed.name, [result[parsed.name]]);
  } } };
  const attestor = { address: attestorWallet.address.toLowerCase(), signMessage: (m: string) => attestorWallet.signMessage(m),
    signBytes: jest.fn((m: Uint8Array) => attestorWallet.signMessage(m)) };
  const input = { reservationId: reservation.id, domain, debit };
  return { fake, db, owner, binding, payer, domain, debit, reservation, account, state, p, attestor, input };
}
test('exact prior-month partial payment is queued without credit and portfolio data never enters calldata', async () => {
  const f = await fixture(), { id } = await queueMembershipDebit(f.db, f.owner, f.input, f.attestor, f.p);
  const plan = await checkMembershipDebit(f.db, f.fake.store.get(`${Q}/${id}`)!.request, f.p);
  expect(plan.calldata).not.toContain(f.owner.slice(2)); expect(plan.calldata).not.toContain(f.reservation.id.slice(2));
  expect(() => assertCheckedMembershipDebit({ ...plan })).toThrow('unverified');
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.episode).toEqual(f.account.episode);
  await expect(queueMembershipDebit(f.db, h('ff'), f.input, f.attestor, f.p)).rejects.toThrow('unknown');
});
test.each(['burn', 'reserve', 'reservation', 'payer', 'month', 'generation', 'transition'])('altered payment cannot obtain attestation: %s', async mutation => {
  const f = await fixture(), input = { ...f.input, debit: { ...f.debit } };
  if (mutation === 'burn') input.debit.burn = '41';
  if (mutation === 'reserve') input.debit.reserve = '26';
  if (mutation === 'reservation') input.reservationId = h('ff');
  if (mutation === 'payer') input.debit.payer = a('ff');
  if (mutation === 'month') input.debit.month = String(month);
  if (mutation === 'generation') input.debit.generation = '2';
  if (mutation === 'transition') f.fake.store.get(`${R.owners}/${f.owner}`)!.membershipTransition = h('ff');
  await expect(queueMembershipDebit(f.db, f.owner, input, f.attestor, f.p)).rejects.toThrow();
  expect(f.attestor.signBytes).not.toHaveBeenCalled();
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.pendingReservation).toBe(f.reservation.id);
});
function lane(db: Firestore, adapter: ReturnType<typeof membershipDebitAdapter>) {
  const base = simulatedBase(laneWallet.address);
  const signer = { address: LANE, signTransaction: jest.fn((tx: Parameters<typeof laneWallet.signTransaction>[0]) => laneWallet.signTransaction(tx)) };
  const run = () => runRecourseLane({ db, signer, chain: base, kinds: [sponsoredLaneKind('membership_debit', adapter)], workerId: `w-${Math.random()}`, now: base.now }, base.now() + 5_000);
  return { base, signer, run };
}
test('a confirmed gas revert releases only the sponsor nonce and retains the exact private payment reservation', async () => {
  const f = await fixture(), { id } = await queueMembershipDebit(f.db, f.owner, f.input, f.attestor, f.p);
  const l = lane(f.db, membershipDebitAdapter(f.db, f.p));
  expect(await l.run()).toMatchObject({ signed: 1 });
  l.base.state.status = () => 0; l.base.mine(); l.base.advance(11);
  expect(await l.run()).toMatchObject({ failed: 1 });
  expect(f.fake.store.get(`${Q}/${id}`)).toMatchObject({ status: 'failed', terminalReason: 'transaction_reverted' });
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`)?.open).toEqual({});
  expect(f.fake.store.get(`${C.reservations}/${f.reservation.id}`)!.status).toBe('pending');
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)).toMatchObject({ pendingReservation: f.reservation.id, episode: f.account.episode });
});
test('expired prior-month authorization cannot be refreshed into a later payable month', async () => {
  const f = await fixture();
  f.p.state = async () => ({ ...f.state, timestamp: now + 32 * 86400 });
  await expect(queueMembershipDebit(f.db, f.owner, f.input, f.attestor, f.p)).rejects.toThrow('stale');
  expect(f.attestor.signBytes).not.toHaveBeenCalled();
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.pendingReservation).toBe(f.reservation.id);
});
test('a signer interruption reserves no nonce and never the private money lock', async () => {
  const f = await fixture(), { id } = await queueMembershipDebit(f.db, f.owner, f.input, f.attestor, f.p);
  const l = lane(f.db, membershipDebitAdapter(f.db, f.p));
  l.signer.signTransaction.mockRejectedValueOnce(Error('signer_interrupted'));
  expect(await l.run()).toMatchObject({ signed: 0, stopReason: 'recourse_lane_sign_failed' });
  f.fake.store.get(`${R.identities}/${f.binding}`)!.recoveryGeneration = 1;
  expect(await l.run()).toMatchObject({ failed: 1, closedUnsigned: 1 });
  expect(f.fake.store.get(`${Q}/${id}`)?.status).toBe('failed');
  expect(f.fake.store.get(`${RECOURSE_LANE_COLLECTION}/${LANE}`)).toMatchObject({ next_nonce: 0, open: {} });
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.pendingReservation).toBe(f.reservation.id);
  expect(f.fake.store.get(`${C.reservations}/${f.reservation.id}`)!.status).toBe('pending');
});
test('sponsor confirmation consumes a real branded receipt once before crediting the private invoice', async () => {
  const f = await fixture(), { id } = await queueMembershipDebit(f.db, f.owner, f.input, f.attestor, f.p);
  const receipt = receiptFixture(); receipt.state.priorRevision = 1; receipt.state.publications = [];
  receipt.state.effects = [{ logIndex: '0x5', ...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('MembershipDebitExecuted')!,
    [f.reservation.digest, f.binding, f.payer, month - 1, 40, 25, 0]) }];
  const adapter = membershipDebitAdapter(f.db, f.p), request = f.fake.store.get(`${Q}/${id}`)!.request;
  await adapter.reconcileConfirmed!(adapter.parse(request), receiptHash);
  const account = f.fake.store.get(`${C.owners}/${f.owner}`)!;
  expect(account).toMatchObject({ pendingReservation: null, needsScan: true });
  expect((account.episode as PrivateMembershipAccount['episode']).invoices[String(month - 1)]).toMatchObject({ burnPaidAtomic: '40', reservePaidAtomic: '25' });
  expect(f.fake.store.get(`${C.reservations}/${f.reservation.id}`)!.status).toBe('committed');
  const version = account.version;
  await adapter.reconcileConfirmed!(adapter.parse(request), receiptHash);
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.version).toBe(version);
  expect([...f.fake.store.keys()].filter(k => k.startsWith(C.effects + '/'))).toHaveLength(1);
});

test('departure recorded after simulation fences a new debit queue without clearing its money reservation', async () => {
  const f=await fixture(),original=f.db.runTransaction.bind(f.db);
  f.db.runTransaction=(async action=>{
    f.fake.store.get(`${R.owners}/${f.owner}`)!.membershipTransition=h('ff');
    return original(action);
  }) as Firestore['runTransaction'];
  await expect(queueMembershipDebit(f.db,f.owner,f.input,f.attestor,f.p)).rejects.toThrow('leaving');
  expect([...f.fake.store.keys()].filter(key=>key.startsWith(Q+'/'))).toHaveLength(0);
  expect(f.fake.store.get(`${C.owners}/${f.owner}`)!.pendingReservation).toBe(f.reservation.id);
});
