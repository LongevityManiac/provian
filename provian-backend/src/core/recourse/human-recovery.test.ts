jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { kernel: `0x${'77'.repeat(20)}` } }) }));
import { Wallet } from 'ethers';
import type { Request, Response } from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { installArmedGenesisPolicyForTest, restoreCheckedInGenesisPolicyAfterTest } from '../pvt/__test-helpers__/armed-genesis-policy';
import { createHumanWalletRegistrationHandler } from '../../routes/human-wallet-registration';
import { proofForAddress } from '../wallet-registration/__test-helpers__/address-proof';
import { HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION, humanWalletRegistrationIndexId } from '../pvt/genesis-ingress';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId, AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../pvt/native-wallet-registration';
import { recoverHumanOwnership, humanRecoveryMessage, parseHumanRecoveryRequest, type HumanRecoveryRequest } from './human-recovery';
import { identityHash, recoveryHash, RECOURSE_COLLECTIONS } from './ownership';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { recoveryAuthorizationFixture } from './__test-helpers__/recovery-authorization-fixture';

installArmedGenesisPolicyForTest(); afterAll(restoreCheckedInGenesisPolicyAfterTest);
const h = (b: string) => `0x${b.repeat(32)}`;
const old = new Wallet(h('11')), next = new Wallet(h('22')); // Public deterministic test keys.
const userId = 'human-recovery-user', oldAddress = old.address.toLowerCase(), destination = next.address.toLowerCase();
async function fixture(failCredentialWrite = false) {
  const fake = createFakeFirestore({ strictTransactionOrder: true,
    ...(failCredentialWrite ? { failTxnWriteOccurrence: { collection: 'auth_secrets', occurrence: 1 } } : {}) }), db = fake as unknown as Firestore;
  const now = Date.now(), recordPEAccrual = jest.fn(async () => {});
  fake.store.set(`users/${userId}`, { id: userId, devices: [{ id: 'old-device', created_at: now - 1000, last_seen: now }], network_class: 'external' });
  fake.store.set(`auth_secrets/${userId}`, { secret: 'old-secret' });
  const deps = { db, cache: { setUserAuthSecret: jest.fn(async () => {}), del: jest.fn(async () => {}) },
    peBuffer: { enqueue: jest.fn() }, recordPEAccrual } as unknown as AgentBankDeps;
  const handler = createHumanWalletRegistrationHandler({ db, peBuffer: deps.peBuffer, recordPEAccrual,
    processGenesisQualification: async qualificationId => ({ qualificationId, status: 'pending_activation', reason: 'activation_missing', peId: null, reservedAtomic: '0' }),
    readBaseRegistrationHead: async () => 50, now: () => now });
  const runRegistration = async (account: string, includeProof = false) => {
    const captured: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
    const req = { user: { id: userId, device_id: 'old-device' }, body: { publicKey: account, address: account,
      ...(includeProof ? { address_proof: await proofForAddress(account, [old, next], { userId, deviceId: 'old-device', nowMs: now }) } : {}) } } as unknown as Request;
    const res = { status(code: number) { captured.status = code; return this; }, json(body: Record<string, unknown>) { captured.body = body; return this; } } as unknown as Response;
    await handler(req, res, () => {});
    return captured;
  };
  const birth = await runRegistration(oldAddress, true);
  expect(birth.status).toBe(201);
  const walletId = String(birth.body.walletId), ownerIdentity = identityHash('human', userId), identity = h('a9'), preimage = `0x${'17'.repeat(64)}`;
  fake.store.set(`${RECOURSE_COLLECTIONS.owners}/${ownerIdentity}`, { ownerIdentity, ownerType: 'human', ownerId: userId, walletId, primaryBinding: identity });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`, { identity, ownerIdentity, primaryBinding: true, ownerType: 'human', ownerId: userId, walletId,
    recoveryCommitment: recoveryHash(Buffer.from(preimage.slice(2), 'hex')), signingRoot: h('17'), recoveryGeneration: 0 });
  const unsigned = { kernel: `0x${'77'.repeat(20)}`, identity, preimage, destination, nextCommitment: h('33'), nextSigningRoot: h('44'),
    requestId: h('55'), authorizationTxHash: h('66'), authorizationNonce: 0, deviceId: 'new-device', authSecret: '77'.repeat(32), expiresAtMs: now + 60000 };
  const input: HumanRecoveryRequest = { ...unsigned, signature: await next.signMessage(humanRecoveryMessage(unsigned)) };
  const ports = { chain: { finalizedBlock: async () => 490, blockHash: async () => h('88'),
    balance: async () => 1n, transfers: async () => [] }, head: async () => 500,
    verify: jest.fn(async evidence => verifyRecoveryAuthorization(evidence, recoveryAuthorizationFixture(evidence))) };
  return { fake, db, deps, input, ports, now, walletId, birth, recordPEAccrual, runRegistration };
}
test('human recovery atomically changes credentials and indexes, accepts dust, and preserves birth PE on replay', async () => {
  const f = await fixture();
  const markerPath = `${HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION}/${humanWalletRegistrationIndexId(userId)}`;
  const marker = JSON.stringify(f.fake.store.get(markerPath));
  const result = await recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports);
  expect(result).toEqual({ identity: f.input.identity, userId, walletId: f.walletId, destination, generation: 1 });
  expect(await recoverHumanOwnership(f.deps, f.input, f.now + 2000, f.ports)).toEqual(result);
  expect(f.fake.store.has(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(oldAddress)}`)).toBe(false);
  expect(f.fake.store.get(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${oldAddress}`)).toMatchObject({ owner_type: 'human', owner_id: userId });
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.addresses}/${destination}`)).toMatchObject({ boundBlock: 100,
    openingBalanceAtomic: '1', chainBindingStatus: 'confirmed', ledgerNeedsCatchup: true });
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe(f.input.authSecret);
  const replay = await f.runRegistration(destination);
  expect(replay.status).toBe(200);
  expect(replay.body.firstEnvelope).toEqual(f.birth.body.firstEnvelope);
  expect(replay.body.walletId).toBe(f.walletId);
  expect(JSON.stringify(f.fake.store.get(markerPath))).toBe(marker);
  expect(JSON.stringify([...f.fake.store])).not.toContain(f.input.preimage.slice(2));
});
test('wrong fresh-key signature or missing finalized authorization changes no human credentials', async () => {
  const f = await fixture(), before = JSON.stringify([...f.fake.store]);
  await expect(recoverHumanOwnership(f.deps, { ...f.input, authSecret: '88'.repeat(32) }, f.now, f.ports)).rejects.toThrow('destination_proof_invalid');
  f.ports.verify.mockRejectedValueOnce(new Error('recourse_authorization_intent_missing'));
  await expect(recoverHumanOwnership(f.deps, f.input, f.now, f.ports)).rejects.toThrow('intent_missing');
  expect(JSON.stringify([...f.fake.store])).toBe(before);
});

test('an auxiliary address recovery proof cannot replace the primary login credentials', async () => {
  const f = await fixture();
  const path = `${RECOURSE_COLLECTIONS.identities}/${f.input.identity}`;
  f.fake.store.set(path, { ...f.fake.store.get(path), primaryBinding: false });
  await expect(recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports)).rejects.toThrow('primary_binding_invalid');
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe('old-secret');
  expect(f.fake.store.get(`wallets/${f.walletId}`)?.address).toBe(oldAddress);
  expect(f.fake.store.has(`${RECOURSE_COLLECTIONS.recoveries}/${f.input.requestId}`)).toBe(false);
});
test('a finalized break restoration resets its origin-scoped authorization nonce and still requires a hash-account credential proof', async () => {
  const f = await fixture();
  const owner = f.fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${f.input.identity}`)!;
  owner.lastAuthorizationNonce = 9;
  const input: HumanRecoveryRequest = { ...f.input, destinationKind: 'hash', breakDestinationRoot: h('99'), signature: `0x${'11'.repeat(7888)}` };
  expect(parseHumanRecoveryRequest(input)).toEqual(input);
  expect(() => parseHumanRecoveryRequest({ ...input, signature: f.input.signature })).toThrow('proof_invalid');
  expect(() => humanRecoveryMessage({ ...input, destinationKind: undefined })).toThrow('recovery_invalid');
  const denied = { ...f.ports, verifyHashDestination: jest.fn(async () => { throw Error('hash_proof_invalid'); }) };
  const before = JSON.stringify([...f.fake.store]);
  await expect(recoverHumanOwnership(f.deps, input, f.now, denied)).rejects.toThrow('hash_proof_invalid');
  expect(JSON.stringify([...f.fake.store])).toBe(before);
  const verifyHashDestination = jest.fn(async () => {});
  owner.lastAuthorizationBreakOrigin = `0x${'91'.repeat(20)}`;
  await expect(recoverHumanOwnership(f.deps, input, f.now, { ...f.ports, verifyHashDestination })).rejects.toThrow('authorization_superseded');
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe('old-secret');
  delete owner.lastAuthorizationBreakOrigin;
  await expect(recoverHumanOwnership(f.deps, input, f.now, { ...f.ports, verifyHashDestination })).resolves.toMatchObject({ destination });
  expect(verifyHashDestination).toHaveBeenCalledWith(destination, humanRecoveryMessage(input), input.signature);
  expect(f.fake.store.get(`${RECOURSE_COLLECTIONS.identities}/${f.input.identity}`)).toMatchObject({
    lastAuthorizationNonce: 1, lastAuthorizationBreakOrigin: `0x${'91'.repeat(20)}` });
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe(input.authSecret);
});
test('a destination owned by another identity cannot replace the native index', async () => {
  const f = await fixture();
  f.fake.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(destination)}`, { owner_id: 'another-human' });
  await expect(recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports)).rejects.toThrow('state_changed');
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe('old-secret');
  expect(f.fake.store.has(`${RECOURSE_COLLECTIONS.recoveries}/${f.input.requestId}`)).toBe(false);
});
test('a credential write failure rolls back the PE, indexes and recovery receipt; exact retry succeeds', async () => {
  const f = await fixture(true), before = JSON.stringify([...f.fake.store]);
  await expect(recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports)).rejects.toThrow('Injected transaction write failure');
  expect(JSON.stringify([...f.fake.store])).toBe(before);
  await expect(recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports)).resolves.toMatchObject({ destination, generation: 1 });
});
test('a replay cannot replace credentials with a different signed fresh-key request', async () => {
  const f = await fixture();
  await recoverHumanOwnership(f.deps, f.input, f.now + 1000, f.ports);
  const changed = { ...f.input, authSecret: '99'.repeat(32) };
  changed.signature = await next.signMessage(humanRecoveryMessage(changed));
  await expect(recoverHumanOwnership(f.deps, changed, f.now + 2000, f.ports)).rejects.toThrow('replay');
  expect(f.fake.store.get(`auth_secrets/${userId}`)?.secret).toBe(f.input.authSecret);
});
