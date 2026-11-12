import { Interface, Wallet, getBytes, getCreateAddress, keccak256, verifyMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/wp4/durable-settlement-store';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T, type PrivateMembershipTransition } from './private-membership-transition';
import { standingMembershipSigningHash, STANDING_MEMBERSHIP_ABI, type AddressMembershipConsent } from './membership-authorization';
import { queueMembershipConsent, membershipConsentAdapter, checkMembershipConsent, assertCheckedMembershipConsent,
  MEMBERSHIP_CONSENT_OPERATIONS as Q, type MembershipConsentPorts, type CheckedMembershipConsent } from './membership-consent-operation';
import type { FinalizedOwnerTransaction } from './transaction-finality';
import { executeSponsoredOperation } from './sponsored-operation-worker';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { RecoursePoolState } from './pool-state';
const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
const ownerWallet = new Wallet(h('11')), attestorWallet = new Wallet(h('22')), gasWallet = new Wallet(h('33'));
async function fixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const owner = h('ab'), id = h('ac'), binding = h('ad');
  const domain = { chainId: '8453', pointer: a('40'), kernel: a('41'), pool: a('42') };
  const consent: AddressMembershipConsent = { binding, account: ownerWallet.address.toLowerCase(), nonce: '0', joined: true,
    revision: '1', ruleHash: h('43'), expiresAt: '1200' };
  const transition: PrivateMembershipTransition = { id, ownerIdentity: owner, kind: 'join', status: 'consenting', bindingSetVersion: 1,
    portfolioHash: h('44'), pool: domain.pool, kernel: domain.kernel, checkpoint: { block: 10, blockHash: h('45'), timestamp: 999, logIndex: -1 },
    bindings: [{ binding, address: consent.account, nonce: '0', generation: '0', initiallyJoined: false, recoveryGeneration: 0, admission: null, departure: null }], closure: null };
  fake.store.set(`${T}/${id}`, { ...transition }); fake.store.set(`${R.owners}/${owner}`, { ownerIdentity: owner, membershipTransition: id, bindingSetVersion: 1, primaryBinding: binding });
  fake.store.set(`${R.identities}/${binding}`, { identity: binding, ownerIdentity: owner, recoveryGeneration: 0 });
  fake.store.set(`${R.addresses}/${consent.account}`, { identity: binding, ownerIdentity: owner, recoveryGeneration: 0, kernel: domain.kernel, chainBindingStatus: 'confirmed' });
  const deployment = { pointer: domain.pointer, addresses: { kernel: domain.kernel, recoursePool: domain.pool, settlement: a('46') },
    revision: 1n, blockHash: h('47'), manifestHash: h('48') } as ProtocolDeployment;
  const state = { pool: domain.pool, kernel: domain.kernel, block: 11, blockHash: deployment.blockHash, timestamp: 1000,
    currentAddress: consent.account, signedRuleHash: consent.ruleHash, consentNonce: '0', addressConsent: false, participationBurnAtomic:'100', noEarningsContributionAtomic:'100', earningsBps:100 } as RecoursePoolState;
  const standing = { consent, fixedChargePayer: true, burnLimit: '100', reserveLimit: '100', earningsBpsLimit: 100, exitCommitment:h('51'), exitSalt:h('52') };
  const controller=getCreateAddress({from:domain.pool,nonce:1}).toLowerCase();
  const wire = new Interface(['function standingMembership() view returns(address)', 'function registryOperator() view returns(address)', 'function identityAttestor() view returns(address)',
    'function restorationAuthority() view returns(address)', 'function pointer() view returns(address)',
    'function operationalMinter() view returns(address)', 'function kernel() view returns(address)', 'function pool() view returns(address)', 'function submitter() view returns(address)',
    ...STANDING_MEMBERSHIP_ABI.fragments]);
  const p: MembershipConsentPorts = { state: async () => state, chain: { deployment: async () => deployment,
    agree: async (method, args) => {
      expect(args[1]).toEqual({ blockHash: deployment.blockHash, requireCanonical: true });
      if (method === 'eth_getCode') return '0x';
      const call = args[0] as { to: string; data: string }, parsed = wire.parseTransaction(call)!;
      if (parsed.name === 'setStandingConsent') {
        expect(call.to).toBe(controller);
        const bytes = getBytes(standingMembershipSigningHash(domain, standing));
        expect(verifyMessage(bytes, parsed.args[1])).toBe(ownerWallet.address);
        expect(verifyMessage(bytes, parsed.args[2])).toBe(attestorWallet.address);
        return '0x';
      }
      const result: Record<string, string> = { standingMembership:controller, registryOperator: a('49'), identityAttestor: attestorWallet.address, restorationAuthority: a('50'),
        pointer: domain.pointer, operationalMinter: deployment.addresses.settlement, kernel: domain.kernel, pool: domain.pool, submitter: gasWallet.address };
      return wire.encodeFunctionResult(parsed.name, [result[parsed.name]]);
    } } };
  const attestor = { address: attestorWallet.address.toLowerCase(), signMessage: (m: string) => attestorWallet.signMessage(m),
    signBytes: jest.fn((m: Uint8Array) => attestorWallet.signMessage(m)) };
  const input = { transitionId: id, domain, consent, standing, exitSecret:null, ownerSignature: await ownerWallet.signMessage(getBytes(standingMembershipSigningHash(domain, standing))) };
  return { fake, db, owner, id, binding, transition, domain, consent, deployment, state, p, attestor, input };
}
test('private owner authorizes individual consent; no portfolio data enters calldata', async () => {
  const f = await fixture(), status = await queueMembershipConsent(f.db, f.owner, f.input, f.attestor, f.p);
  expect(status.status).toBe('queued');
  const row = f.fake.store.get(`${Q}/${status.id}`)!;
  const plan = await checkMembershipConsent(f.db, row.request, f.p);
  expect(plan.calldata).not.toContain(f.owner.slice(2)); expect(plan.calldata).not.toContain(f.id.slice(2));
  expect(() => assertCheckedMembershipConsent({ ...plan })).toThrow('unverified');
  await expect(queueMembershipConsent(f.db, h('ff'), f.input, f.attestor, f.p)).rejects.toThrow('unknown');
});
test.each(['payer', 'nonce', 'joined', 'rule', 'expiry', 'generation', 'status', 'owner', 'domain', 'signature'])('refuses altered authorization before attesting: %s', async mutation => {
  const f = await fixture();
  const changes: Record<string, Partial<AddressMembershipConsent>> = { payer: { account: a('fe') }, nonce: { nonce: '1' },
    joined: { joined: false }, rule: { ruleHash: h('fe') }, expiry: { expiresAt: '1301' } };
  const input = { ...f.input, consent: { ...f.consent, ...changes[mutation] } };
  if (mutation === 'generation') f.fake.store.get(`${R.identities}/${f.binding}`)!.recoveryGeneration = 1;
  if (mutation === 'status') f.fake.store.get(`${T}/${f.id}`)!.status = 'complete';
  if (mutation === 'owner') f.fake.store.get(`${R.owners}/${f.owner}`)!.membershipTransition = h('fe');
  if (mutation === 'domain') input.domain = { ...input.domain, pool: a('fe') };
  if (mutation === 'signature') input.ownerSignature = await ownerWallet.signMessage(standingMembershipSigningHash(f.domain, f.input.standing));
  await expect(queueMembershipConsent(f.db, f.owner, input, f.attestor, f.p)).rejects.toThrow();
  expect(f.attestor.signBytes).not.toHaveBeenCalled();
  expect([...f.fake.store.keys()].filter(k => k.startsWith(Q))).toHaveLength(0);
});
test('sponsored receipt failure retains exact bytes and nonce until durable reconciliation succeeds', async () => {
  const f = await fixture(), { id } = await queueMembershipConsent(f.db, f.owner, f.input, f.attestor, f.p);
  const adapter = membershipConsentAdapter(f.db, f.p), finalized = jest.fn(async (): Promise<FinalizedOwnerTransaction | null> => null);
  const reconcile = jest.fn(async (): Promise<void> => { throw Error('receipt_temporarily_unavailable'); });
  const signer = { address: gasWallet.address.toLowerCase(), sign: jest.fn((plan: CheckedMembershipConsent) => gasWallet.signTransaction({ chainId: 8453, type: 2,
    to: plan.executor, data: plan.calldata, value: 0, nonce: 3, gasLimit: 400000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 })),
    broadcast: jest.fn(async (raw: string) => keccak256(raw)) };
  const worker = { ...adapter, finalized, reconcileConfirmed: reconcile };
  expect(await executeSponsoredOperation(f.db, id, signer, worker)).toBe('submitted');
  const raw = f.fake.store.get(`${Q}/${id}`)!.signedTransaction;
  finalized.mockResolvedValue({ status: 1, transactionHash: keccak256(String(raw)), blockHash: h('55'), block: 12 });
  await expect(executeSponsoredOperation(f.db, id, signer, worker)).rejects.toThrow('temporarily_unavailable');
  expect(f.fake.store.get(`${Q}/${id}`)).toMatchObject({ status: 'submitted', signedTransaction: raw });
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)!.pending_operation).toBe(id);
  reconcile.mockImplementation(async () => undefined);
  expect(await executeSponsoredOperation(f.db, id, signer, worker)).toBe('confirmed');
  expect(signer.sign).toHaveBeenCalledTimes(1); expect(signer.broadcast).toHaveBeenCalledTimes(1);
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)!.pending_operation).toBeNull();
});
test('recovery releases an interrupted unsigned gas reservation without erasing signed work', async () => {
  const f = await fixture(), { id } = await queueMembershipConsent(f.db, f.owner, f.input, f.attestor, f.p);
  const signer = { address: gasWallet.address.toLowerCase(), sign: jest.fn(async (): Promise<string> => { throw Error('signer_interrupted'); }),
    broadcast: jest.fn(async (raw: string) => keccak256(raw)) };
  const adapter = membershipConsentAdapter(f.db, f.p);
  await expect(executeSponsoredOperation(f.db, id, signer, adapter)).rejects.toThrow('signer_interrupted');
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)!.pending_operation).toBe(id);
  expect(f.fake.store.get(`${Q}/${id}`)!.signedTransaction).toBeUndefined();
  f.fake.store.get(`${R.identities}/${f.binding}`)!.recoveryGeneration = 1;
  expect(await executeSponsoredOperation(f.db, id, signer, adapter)).toBe('failed');
  expect(signer.sign).toHaveBeenCalledTimes(1); expect(signer.broadcast).not.toHaveBeenCalled();
  expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${signer.address}`)!.pending_operation).toBeNull();
});
