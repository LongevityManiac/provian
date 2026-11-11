import { execFileSync } from 'node:child_process';
import { Interface, Wallet, getBytes, hashMessage, sha256, verifyMessage } from 'ethers';
import { assertIdentityAttestation, configuredIdentityAttestor } from './identity-attestor';
import { hashAccountContractDigest } from './hash-account-data';
import type { OwnerOperationChain } from './owner-operation-queue';

// Jest's CommonJS loader cannot load the library's ESM entry. Execute the real
// cryptographic implementation in Node; no fake signatures or verification.
jest.mock('@noble/post-quantum/slh-dsa.js', () => ({ slh_dsa_sha2_128s: {
  keygen(seed: Uint8Array) {
    const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{readFileSync}from'node:fs';import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const k=s.keygen(new Uint8Array(JSON.parse(readFileSync(0,'utf8'))));console.log(JSON.stringify({publicKey:[...k.publicKey],secretKey:[...k.secretKey]}));"],
    { input: JSON.stringify([...seed]), encoding: 'utf8' }));
    return { publicKey: new Uint8Array(value.publicKey), secretKey: new Uint8Array(value.secretKey) };
  },
  sign(message: Uint8Array, key: Uint8Array) {
    const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    return new Uint8Array(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{readFileSync}from'node:fs';import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const x=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify([...s.sign(new Uint8Array(x[0]),new Uint8Array(x[1]),{extraEntropy:false})]));"],
    { input: JSON.stringify([[...message], [...key]]), encoding: 'utf8' })));
  },
} }));
const hash = (b: string) => `0x${b.repeat(32)}`, address = (b: string) => `0x${b.repeat(20)}`;
const abi = new Interface(['function isValidSignature(bytes32,bytes) view returns(bytes4)']);
const curve = new Wallet(hash('11')); // Public fixture only.

test('curve and contract signatures use exactly the consumer message digest and pinned block', async () => {
  const signer = configuredIdentityAttestor({ PVT9_SETTLEMENT_APPROVER_KEY: hash('11') });
  const message = getBytes(hash('ab')), signature = await signer.signBytes!(message);
  expect(verifyMessage(message, signature)).toBe(curve.address);
  const agree = jest.fn(async () => '0x');
  const chain = { agree } as unknown as OwnerOperationChain;
  await assertIdentityAttestation(chain, signer.address, hash('bb'), message, signature);
  expect(agree).toHaveBeenCalledWith('eth_getCode', [signer.address, { blockHash: hash('bb'), requireCanonical: true }]);
  agree.mockImplementation(async (method?: string) => method === 'eth_getCode' ? '0x1234'
    : abi.encodeFunctionResult('isValidSignature', ['0x1626ba7e']));
  await assertIdentityAttestation(chain, address('22'), hash('bb'), message, '0x1234');
  expect(agree).toHaveBeenLastCalledWith('eth_call', [{ to: address('22'),
    data: abi.encodeFunctionData('isValidSignature', [hashMessage(message), '0x1234']) }, { blockHash: hash('bb'), requireCanonical: true }]);
  agree.mockImplementation(async (method?: string) => method === 'eth_getCode' ? '0x1234'
    : abi.encodeFunctionResult('isValidSignature', ['0xffffffff']));
  await expect(assertIdentityAttestation(chain, signer.address, hash('bb'), message, signature)).rejects.toThrow('invalid');
});

test.each(['0x1', null, false, '0xzz'])('malformed code is refused: %s', async code => {
  const chain = { agree: async () => code } as unknown as OwnerOperationChain;
  await expect(assertIdentityAttestation(chain, curve.address, hash('bb'), 'test', await curve.signMessage('test'))).rejects.toThrow('invalid');
});
test('partial hash configuration cannot silently select an old curve key', () => {
  for (const patch of [{ RECOURSE_IDENTITY_HASH_ACCOUNT: address('22') }, { RECOURSE_IDENTITY_HASH_SIGNING_SEED: hash('33') },
    { RECOURSE_IDENTITY_HASH_ACCOUNT: address('00'), RECOURSE_IDENTITY_HASH_SIGNING_SEED: hash('33') }]) {
    expect(() => configuredIdentityAttestor({ PVT9_SETTLEMENT_APPROVER_KEY: hash('11'), ...patch })).toThrow('configuration_invalid');
  }
});
test('configured independent hash attestor makes a real domain-bound SLH-DSA proof', async () => {
  const account = address('22'), attestor = configuredIdentityAttestor({ RECOURSE_IDENTITY_HASH_ACCOUNT: account,
    RECOURSE_IDENTITY_HASH_SIGNING_SEED: hash('33'), PVT9_SETTLEMENT_APPROVER_KEY: hash('11') });
  const message = getBytes(hash('ab')), signature = await attestor.signBytes!(message);
  expect(attestor.address).toBe(account); expect(getBytes(signature)).toHaveLength(7888);
  const publicKey = signature.slice(0, 66), proof = `0x${signature.slice(66)}`;
  const digest = hashAccountContractDigest(account, sha256(publicKey), hashMessage(message));
  const verify = (d: string): boolean => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import{readFileSync}from'node:fs';import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const x=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(s.verify(...x.map(h=>Buffer.from(h.slice(2),'hex')))));"],
  { input: JSON.stringify([proof, d, publicKey]), encoding: 'utf8' }));
  expect(verify(digest)).toBe(true);
  expect(verify(hashAccountContractDigest(address('44'), sha256(publicKey), hashMessage(message)))).toBe(false);
  expect(verify(hashAccountContractDigest(account, sha256(publicKey), hashMessage(hash('ab'))))).toBe(false);
}, 60000);
