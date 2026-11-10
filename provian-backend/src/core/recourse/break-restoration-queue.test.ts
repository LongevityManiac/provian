import { AbiCoder, Interface, concat, keccak256, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { OwnerOperationChain } from './owner-operation-queue';
import { OWNER_EXECUTOR_ABI } from './owner-operation';
import { BREAK_RESTORATION_TUPLE, breakRestorationId } from './break-restoration-data';
import { BREAK_RESTORATIONS, checkBreakRestoration, assertCheckedBreakRestoration, queueBreakRestoration } from './break-restoration-queue';
import { HASH_ACCOUNT_ABI, hashAccountIntentDigest, hashAccountCall } from './hash-account-data';
import { checkBreakAuthority, assertCheckedBreakAuthority } from './break-authority-execution';

const a = (n: number) => `0x${n.toString(16).padStart(40,'0')}`, h = (n: number) => `0x${n.toString(16).padStart(64,'0')}`;
const coder = AbiCoder.defaultAbiCoder();
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function restorationAuthority() view returns(address)',
  'function kernel() view returns(address)', 'function breakOrigin() view returns(address)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)', 'function restorationRoot() view returns(bytes32)',
  'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)',
  'function operationalMinter() view returns(address)', 'function pool() view returns(address)', 'function submitter() view returns(address)']);
function fixture(mode = 'valid') {
  const proof = { recoverySecret: h(1), signingRoot: sha256(h(2)), nextCommitment: h(3), nextSigningRoot: h(4),
    publicKey: h(2), signature: `0x${'11'.repeat(7856)}` };
  const commitment = sha256(concat([proof.recoverySecret, proof.signingRoot])), identity = h(5), destination = a(6), destinationKeyRoot = h(7);
  const leaf = sha256(coder.encode(['string','address','uint256','bytes32','uint256','bytes32'], ['Provian restoration', a(8), 100, identity, 50, commitment]));
  const operation = sha256(coder.encode(['string','bytes32','uint256','address','bytes32','address','uint256'],
    ['Provian cryptographic break', identity, 50, destination, destinationKeyRoot, a(8), 100]));
  const ownerIntent = sha256(coder.encode(['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],
    ['Provian restoration owner authorization', 8453, a(1), identity, commitment, 0, operation, proof.nextCommitment, proof.nextSigningRoot]));
  const payload = coder.encode(['uint8','bytes'], [1, coder.encode([BREAK_RESTORATION_TUPLE], [[identity,50,commitment,destination,destinationKeyRoot,[]]])]);
  const request = { kernel: a(1), ownerIntent, data: OWNER_EXECUTOR_ABI.encodeFunctionData('execute', [identity,operation,proof,payload]) };
  const authorityOperation = { chainId:'8453', account:a(3), nonce:'4', target:a(2), value:'0', callGas:'10000000',
    data:request.data, nextCommitment:h(31), publicKey:h(30), signingRoot:sha256(h(30)), signature:`0x${'22'.repeat(7856)}` };
  const port: OwnerOperationChain = { async deployment() { return { addresses: { kernel: mode === 'retired' ? a(99) : a(1), settlement:a(9), recoursePool:a(10) },
    manifestHash: h(20), blockHash: h(21) } as ProtocolDeployment; }, agree: jest.fn(async (method, params) => {
    expect(params.at(-1)).toEqual({ blockHash: h(21), requireCanonical: true });
    if (method === 'eth_getCode') return mode === 'curve-authority' && params[0] === a(3) ? '0x' : '0x6000';
    const input = params[0] as { to: string; data: string; from?: string };
    for (const iface of [abi, OWNER_EXECUTOR_ABI, HASH_ACCOUNT_ABI]) {
      const call = iface.parseTransaction(input); if (!call) continue;
      if (call.name === 'execute') {
        if (iface === HASH_ACCOUNT_ABI) {
          expect(input).toEqual({ to:a(3), from:a(11), data:hashAccountCall(authorityOperation) });
          return HASH_ACCOUNT_ABI.encodeFunctionResult('execute', [mode !== 'authority-refused']);
        }
        expect(input).toEqual({ to: a(2), from: a(3), data: request.data });
        // Signature correctness is an EVM responsibility here; this negative
        // control proves a refusal from its verifier cannot be ignored.
        if (mode === 'verifier-refused') throw Error('onchain_owner_signature_refused');
        return '0x';
      }
      const values: Record<string, unknown> = { ownerAuthorization: a(2), restorationAuthority: a(3), kernel: a(1), breakOrigin: a(4),
        predecessor: a(8), lastGoodBlock: 100, restorationRoot: mode === 'snapshot' ? h(99) : leaf, hashAccountCodeHash: keccak256('0x6000'),
        keyCommitment: input.to === a(3) ? sha256(h(30)) : mode === 'destination' ? h(99) : destinationKeyRoot, nonce: 4,
        ownerAuthorizationNonce: mode === 'owner' ? 1 : 0, ownerRecoveryCommitment: commitment, ownerSigningRoot: proof.signingRoot,
        ownerAuthorizationDigest: mode === 'intent' ? h(99) : ownerIntent, operationalMinter:a(9), pool:a(10), submitter:a(11),
        intentDigest:mode === 'authority-digest' ? h(99) : hashAccountIntentDigest(authorityOperation) };
      if (!(call.name in values)) throw Error('unexpected call');
      return iface.encodeFunctionResult(call.name, [values[call.name]]);
    }
    throw Error('unexpected call');
  }) };
  return { request, port, authorityOperation };
}
test('queues only exact kind-one owner authorization for a separate hash-held restoration authority', async () => {
  const { request, port } = fixture(), fake = createFakeFirestore({ strictTransactionOrder: true }), db = fake as unknown as Firestore;
  const plan = await checkBreakRestoration(request, port);
  expect(plan).toMatchObject({ executor: a(2), authority: a(3), amount: '50', nonce: 0, authorityNonce: '4' });
  expect(() => assertCheckedBreakRestoration(plan)).not.toThrow();
  expect(() => assertCheckedBreakRestoration({ ...plan })).toThrow('unverified');
  expect(await queueBreakRestoration(db, request, port)).toEqual({ id: breakRestorationId(request), status: 'awaiting_authority', transactionHash: null });
  expect(fake.store.get(`${BREAK_RESTORATIONS}/${plan.id}`)).not.toHaveProperty('signedTransaction');
});
test('gas sponsorship requires the authority signature over the same exact owner-authorized restoration', async () => {
  const { request, port, authorityOperation } = fixture(), fake = createFakeFirestore(), db = fake as unknown as Firestore;
  const queued = await queueBreakRestoration(db, request, port);
  const input = { restoration:queued.id, operation:authorityOperation };
  const plan = await checkBreakAuthority(db, input, port);
  expect(plan).toMatchObject({ executor:a(3), gasPayer:a(11), calldata:hashAccountCall(authorityOperation) });
  expect(() => assertCheckedBreakAuthority(plan)).not.toThrow();
  expect(() => assertCheckedBreakAuthority({ ...plan })).toThrow('unverified');
  for (const patch of [{ target:a(99) }, { account:a(99) }, { value:'1' }, { nonce:'5' }, { data:request.data+'00' },
    { publicKey:h(32), signingRoot:sha256(h(32)) }]) {
    await expect(checkBreakAuthority(db, { ...input, operation:{ ...authorityOperation, ...patch } }, port)).rejects.toThrow();
  }
});
test.each(['authority-refused','authority-digest'])('refuses %s before granting a gas-signing capability', async mode => {
  const { request, port, authorityOperation } = fixture(mode), fake = createFakeFirestore(), db = fake as unknown as Firestore;
  const queued = await queueBreakRestoration(db, request, port);
  await expect(checkBreakAuthority(db, { restoration:queued.id, operation:authorityOperation }, port)).rejects.toThrow();
});
test.each(['retired','curve-authority','snapshot','destination','owner','intent','verifier-refused'])('refuses %s before authority queueing', async mode => {
  const { request, port } = fixture(mode), fake = createFakeFirestore(), db = fake as unknown as Firestore;
  await expect(queueBreakRestoration(db, request, port)).rejects.toThrow();
  expect([...fake.store.keys()].filter(key => key.startsWith(BREAK_RESTORATIONS))).toHaveLength(0);
});
