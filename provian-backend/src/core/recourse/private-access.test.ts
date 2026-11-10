import { execFileSync } from 'child_process';
import { concat, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { RECOURSE_COLLECTIONS } from './ownership';
import { privateRecourseIntent, privateRecourseRequestHash, verifyRecoursePrivateAccess,
  assertRecoursePrivateAccess, type RecoursePrivateAuthorization } from './private-access';
let mockVerificationHook: (() => void) | undefined;

// CommonJS Jest bridges to the actual ESM verifier; signatures are not mocked true.
jest.mock('@noble/post-quantum/slh-dsa.js', () => ({ slh_dsa_sha2_128s: {
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => {
    mockVerificationHook?.();
    const { execFileSync } = jest.requireActual<typeof import('child_process')>('child_process');
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import{readFileSync}from'node:fs';import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const a=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(s.verify(...a.map(x=>new Uint8Array(x)))));"],
    { input: JSON.stringify([[...signature], [...message], [...publicKey]]), encoding: 'utf8' })) as boolean;
  },
} }));
const h = (byte: string) => `0x${byte.repeat(32)}`;
const nowMs = 1000000, path = `break-entitlements/0x${'22'.repeat(20)}/${h('11')}`;
let authorization: RecoursePrivateAuthorization;
beforeEach(() => { mockVerificationHook = undefined; });
beforeAll(() => {
  const publicKey = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';console.log('0x'+Buffer.from(s.keygen(new Uint8Array(48).fill(1)).publicKey).toString('hex'));"], { encoding: 'utf8' }).trim();
  const input = { version: 1 as const, identity: h('11'), publicKey, recoverySecret: h('33'),
    commitment: sha256(concat([h('33'), sha256(publicKey)])), issuedAtMs: nowMs };
  const signature = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import{slh_dsa_sha2_128s as s}from'@noble/post-quantum/slh-dsa.js';const k=s.keygen(new Uint8Array(48).fill(1));console.log('0x'+Buffer.from(s.sign(Buffer.from(process.argv[1].slice(2),'hex'),k.secretKey,{extraEntropy:false})).toString('hex'));",
    privateRecourseIntent(input, path)], { encoding: 'utf8' }).trim();
  authorization = { ...input, signature };
});
function fixture() {
  const fake = createFakeFirestore({ strictTransactionOrder: true });
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${authorization.identity}`, {
    identity: authorization.identity, recoveryCommitment: authorization.commitment,
  });
  return { fake, db: fake as unknown as Firestore };
}
test('current and historical independent signing credentials authorize only the exact private request', async () => {
  const f = fixture();
  const access = await verifyRecoursePrivateAccess(f.db, { authorization, path, nowMs });
  expect(() => assertRecoursePrivateAccess(access, { identity: authorization.identity, path })).not.toThrow();
  expect(() => assertRecoursePrivateAccess({ ...access }, { identity: authorization.identity, path })).toThrow('refused');
  expect(() => assertRecoursePrivateAccess(access, { identity: h('44'), path })).toThrow('refused');
  expect(() => assertRecoursePrivateAccess(access, { identity: authorization.identity, path, request: { changed: true } })).toThrow('refused');
  f.fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${authorization.identity}`, { identity: authorization.identity, recoveryCommitment: h('55') });
  await expect(verifyRecoursePrivateAccess(f.db, { authorization, path, nowMs })).rejects.toThrow('refused');
  f.fake.store.set(`${RECOURSE_COLLECTIONS.commitments}/${authorization.identity}:${authorization.commitment}`,
    { identity: authorization.identity, commitment: authorization.commitment });
  await expect(verifyRecoursePrivateAccess(f.db, { authorization, path, nowMs })).resolves.toMatchObject({ identity: authorization.identity });
});
test('a public preimage, corrupt signature, changed path or body cannot read private records', async () => {
  const f = fixture();
  await expect(verifyRecoursePrivateAccess(f.db, { authorization: { ...authorization, signature: '0x' + '00'.repeat(7856) }, path, nowMs })).rejects.toThrow('refused');
  await expect(verifyRecoursePrivateAccess(f.db, { authorization, path: path.replace('entitlements', 'recovery-state'), nowMs })).rejects.toThrow('refused');
  await expect(verifyRecoursePrivateAccess(f.db, { authorization, path, request: { destination: h('66') }, nowMs })).rejects.toThrow('refused');
  await expect(verifyRecoursePrivateAccess(f.db, { authorization: { ...authorization, recoverySecret: h('77') }, path, nowMs })).rejects.toThrow('refused');
});
test('stale/future proofs, malformed bodies, unregistered identities and ambiguous JSON fail closed', async () => {
  const f = fixture();
  for (const change of [{ issuedAtMs: nowMs - 300001 }, { issuedAtMs: nowMs + 30001 }, { extra: true }, { publicKey: '0x' }]) {
    await expect(verifyRecoursePrivateAccess(f.db, { authorization: { ...authorization, ...change }, path, nowMs })).rejects.toThrow('refused');
  }
  expect(() => privateRecourseRequestHash({ amount: NaN })).toThrow('refused');
  expect(() => privateRecourseRequestHash(JSON.parse('{"__proto__":{}}'))).toThrow('refused');
  expect(() => privateRecourseRequestHash({ omitted: undefined })).toThrow('refused');
  expect(() => privateRecourseIntent(authorization, path.replace(authorization.identity, h('99')))).toThrow('refused');
  expect(privateRecourseRequestHash({ b: 2, a: 1 })).toBe(privateRecourseRequestHash({ a: 1, b: 2 }));
  f.fake.store.clear(); await expect(verifyRecoursePrivateAccess(f.db, { authorization, path, nowMs })).rejects.toThrow('refused');
});
test('caller mutation during verification cannot change the admitted identity or request', async () => {
  const f = fixture(), copy = { ...authorization }, input = { authorization: copy, path, nowMs };
  mockVerificationHook = () => { copy.identity = h('99'); input.path = path.replace('entitlements', 'recovery-state'); };
  const access = await verifyRecoursePrivateAccess(f.db, input);
  expect(access.identity).toBe(authorization.identity); expect(access.path).toBe(path);
});
