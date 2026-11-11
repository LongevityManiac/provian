jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: `0x${'77'.repeat(20)}` } }) }));
import { Wallet } from 'ethers';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { installArmedGenesisPolicyForTest, restoreCheckedInGenesisPolicyAfterTest } from '../pvt/__test-helpers__/armed-genesis-policy';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId, AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../pvt/native-wallet-registration';
import { PROVEN_ADDRESSES_COLLECTION, HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { recoverAuxiliaryOwnership, auxiliaryRecoveryMessage, parseAuxiliaryRecoveryRequest, type AuxiliaryRecoveryRequest } from './auxiliary-recovery';
import { identityHash, recoveryHash, RECOURSE_COLLECTIONS as R } from './ownership';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { recoveryAuthorizationFixture } from './__test-helpers__/recovery-authorization-fixture';

installArmedGenesisPolicyForTest(); afterAll(restoreCheckedInGenesisPolicyAfterTest);
const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
const next = new Wallet(h('22')); // Public deterministic fixture key.
async function fixture(failWrite = false) {
  const db = createFakeFirestore({ strictTransactionOrder: true,
    ...(failWrite ? { failTxnWriteOccurrence: { collection: R.addresses, occurrence: 1 } } : {}) });
  const owner = { type: 'human' as const, id: 'aux-owner', walletId: 'aux-wallet' }, ownerIdentity = identityHash(owner.type, owner.id);
  const now = Date.now(), identity = h('a9'), preimage = `0x${'17'.repeat(64)}`, primary = h('aa');
  db.store.set(`users/${owner.id}`, { id: owner.id, wallet_address: a('11'), devices: [], network_class: 'external' });
  db.store.set(`wallets/${owner.walletId}`, { id: owner.walletId, user_id: owner.id, address: a('11'), type: 'human', status: 'active' });
  db.store.set(`auth_secrets/${owner.id}`, { secret: 'PRIMARY_LOGIN_UNCHANGED' });
  const privateOwner = { ownerIdentity, ownerType: owner.type, ownerId: owner.id, walletId: owner.walletId };
  db.store.set(`${R.owners}/${ownerIdentity}`, { ...privateOwner, primaryBinding: primary });
  db.store.set(`${R.identities}/${primary}`, { ...privateOwner, identity: primary, primaryBinding: true });
  db.store.set(`${R.identities}/${identity}`, { ...privateOwner, identity, primaryBinding: false,
    recoveryCommitment: recoveryHash(Buffer.from(preimage.slice(2), 'hex')), signingRoot: h('17'), recoveryGeneration: 0 });
  db.store.set(`${R.addresses}/${a('33')}`, { ownerIdentity, identity, address: a('33'), kernel: a('77'), recoveryGeneration: 0,
    chainBindingStatus: 'confirmed', bindingDigest: h('34'), boundBlock: 1, boundBlockHash: h('35'), openingBalanceAtomic: '10' });
  db.store.set(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${a('33')}`, { user_id: owner.id, address: a('33'), retained: 'existing earning proof' });
  const unsigned = { kernel: a('77'), identity, preimage, destination: next.address.toLowerCase(), nextCommitment: h('44'),
    nextSigningRoot: h('45'), requestId: h('55'), authorizationTxHash: h('66'), authorizationNonce: 0, expiresAtMs: now + 60000 };
  const input: AuxiliaryRecoveryRequest = { ...unsigned, signature: await next.signMessage(auxiliaryRecoveryMessage(unsigned)) };
  const deps = { db, cache: { setUserAuthSecret: jest.fn(), del: jest.fn() },
    peBuffer: { enqueue: jest.fn() }, recordPEAccrual: jest.fn(async () => {}) } as unknown as AgentBankDeps;
  const ports = { chain: { finalizedBlock: async () => 490, blockHash: jest.fn(async () => h('19')),
    balance: async () => 1n, transfers: async () => [] },
    verify: jest.fn(async evidence => verifyRecoveryAuthorization(evidence, recoveryAuthorizationFixture(evidence))) };
  return { db, deps, owner, ownerIdentity, input, ports, now };
}
test('auxiliary recovery appends exactly one owner-chain record and fresh binding without changing login, primary wallet or earning proofs', async () => {
  const f = await fixture(), preserved = [...f.db.store].filter(([key]) => !key.startsWith('recourse_'));
  const result = await recoverAuxiliaryOwnership(f.deps, f.owner, f.input, f.now, f.ports);
  expect(result).toEqual({ identity: f.input.identity, destination: f.input.destination, generation: 1 });
  expect(f.db.store.get(`${R.addresses}/${f.input.destination}`)).toMatchObject({ ownerIdentity: f.ownerIdentity,
    identity: f.input.identity, recoveryGeneration: 1, boundBlock: 100, openingBalanceAtomic: '1', ledgerNeedsCatchup: true });
  for (const [key, value] of preserved) expect(f.db.store.get(key)).toEqual(value);
  expect(f.deps.cache.setUserAuthSecret).not.toHaveBeenCalled();
  const after = JSON.stringify([...f.db.store]);
  expect(after).not.toContain(f.input.preimage.slice(2));
  expect(await recoverAuxiliaryOwnership(f.deps, f.owner, f.input, f.now + 1000, f.ports)).toEqual(result);
  expect(JSON.stringify([...f.db.store])).toBe(after);
  expect([...f.db.store.keys()].filter(key => key.startsWith('pe_chain_tips/'))).toHaveLength(1);
  expect(parseAuxiliaryRecoveryRequest(f.input)).toEqual(f.input);
  expect(() => parseAuxiliaryRecoveryRequest({ ...f.input, authSecret: 'never' })).toThrow('invalid');
});
test.each(['primary', 'foreign', 'signature', 'unverified', 'reorg', 'expired', 'write-failure'])(
  '%s cannot consume the auxiliary recovery or create an owner-chain event', async mode => {
    const f = await fixture(mode === 'write-failure');
    let input = f.input;
    if (mode === 'primary') f.db.store.get(`${R.identities}/${input.identity}`)!.primaryBinding = true;
    if (mode === 'foreign') f.db.store.get(`${R.identities}/${input.identity}`)!.ownerId = 'other';
    if (mode === 'signature') input = { ...input, nextCommitment: h('88') };
    if (mode === 'unverified') f.ports.verify.mockImplementationOnce(async evidence => ({
      ...await verifyRecoveryAuthorization(evidence, recoveryAuthorizationFixture(evidence)) }));
    if (mode === 'reorg') f.ports.chain.blockHash.mockResolvedValueOnce(h('99'));
    if (mode === 'expired') input = { ...input, expiresAtMs: f.now - 1 };
    const before = JSON.stringify([...f.db.store]);
    await expect(recoverAuxiliaryOwnership(f.deps, f.owner, input, f.now, f.ports)).rejects.toThrow();
    expect(JSON.stringify([...f.db.store])).toBe(before);
  });
test.each([NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION, HUMAN_PROVEN_ADDRESSES_COLLECTION, R.addresses])('a destination already in %s is refused atomically', async collection => {
  const f = await fixture(), id = collection === NATIVE_WALLET_ADDRESS_INDEX_COLLECTION ? nativeWalletAddressIndexId(f.input.destination) : f.input.destination;
  f.db.store.set(`${collection}/${id}`, { occupied: true });
  const before = JSON.stringify([...f.db.store]);
  await expect(recoverAuxiliaryOwnership(f.deps, f.owner, f.input, f.now, f.ports)).rejects.toThrow();
  expect(JSON.stringify([...f.db.store])).toBe(before);
});
test('transaction-time owner substitution is refused after a valid chain proof', async () => {
  const f = await fixture();
  f.ports.chain.blockHash.mockImplementationOnce(async () => {
    f.db.store.get(`${R.owners}/${f.ownerIdentity}`)!.primaryBinding = f.input.identity;
    return h('19');
  });
  await expect(recoverAuxiliaryOwnership(f.deps, f.owner, f.input, f.now, f.ports)).rejects.toThrow('owner_changed');
  expect(f.db.store.has(`${R.recoveries}/${f.input.requestId}`)).toBe(false);
  expect(f.db.store.has(`${R.addresses}/${f.input.destination}`)).toBe(false);
});
test('an auxiliary break resets its authorization domain and requires fresh hash-account possession',async()=>{
  const f=await fixture();
  f.db.store.get(`${R.identities}/${f.input.identity}`)!.lastAuthorizationNonce=9;
  const input:AuxiliaryRecoveryRequest={...f.input,destinationKind:'hash',breakDestinationRoot:h('99'),signature:`0x${'11'.repeat(7888)}`};
  expect(parseAuxiliaryRecoveryRequest(input)).toEqual(input);
  const verifyHashDestination=jest.fn(async()=>{});
  const deny=jest.fn(async()=>{throw Error('hash_proof_invalid');});
  const before=JSON.stringify([...f.db.store]);
  await expect(recoverAuxiliaryOwnership(f.deps,f.owner,input,f.now,{...f.ports,verifyHashDestination:deny})).rejects.toThrow('hash_proof_invalid');
  expect(JSON.stringify([...f.db.store])).toBe(before);
  await expect(recoverAuxiliaryOwnership(f.deps,f.owner,input,f.now,{...f.ports,verifyHashDestination})).resolves.toEqual({
    identity:input.identity,destination:input.destination,generation:1});
  expect(verifyHashDestination).toHaveBeenCalledWith(input.destination,auxiliaryRecoveryMessage(input),input.signature);
  expect(f.db.store.get(`auth_secrets/${f.owner.id}`)?.secret).toBe('PRIMARY_LOGIN_UNCHANGED');
});
