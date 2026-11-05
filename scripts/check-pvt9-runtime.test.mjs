import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assertRuntime, assertArtifactSources, assertPinScope } from './check-pvt9-runtime.mjs';
const require = createRequire(new URL('../provian-backend/package.json', import.meta.url));
const { keccak256, toUtf8Bytes } = require('ethers');
test('scope requires the kernel and a distinct verifier, with no duplicate or omitted contract', () => {
  const kernel = { name: 'ProvianPVT9', address: '0x' + '1'.repeat(40), codehash: '0x' + 'a'.repeat(64) };
  const verifier = { name: 'ProvianPVT9EligibilityVerifier', address: '0x' + '2'.repeat(40), codehash: '0x' + 'b'.repeat(64) };
  const config = { network: { chain_id: 8453 }, assets: { pvt9: { address: kernel.address } } };
  assertPinScope({ chain_id: 8453, contracts: [kernel, verifier] }, config);
  for (const contracts of [[kernel], [kernel, kernel], [kernel, verifier, verifier], [kernel, { ...verifier, address: kernel.address }]]) {
    assert.throws(() => assertPinScope({ chain_id: 8453, contracts }, config), /scope/);
  }
});
test('runtime pin and compiled source both bind, including constructor bytes', () => {
  const code = '0x11223344';
  const pin = { codehash: keccak256(code) };
  const artifact = { deployedBytecode: { object: '0x11003344', immutableReferences: { slot: [{ start: 1, length: 1 }] } } };
  assertRuntime(code, artifact, pin);
  assert.throws(() => assertRuntime('0x11233344', artifact, pin), /codehash/);
  assert.throws(() => assertRuntime('0x11223345', artifact, { codehash: keccak256('0x11223345') }), /source/);
  assert.throws(() => assertRuntime('0x', artifact, pin), /missing/);
  assert.throws(() => assertRuntime('0x112233', artifact, { codehash: keccak256('0x112233') }), /length/);
});
test('stale source and empty populations cannot pass the artifact source check', () => {
  const artifact = { metadata: { sources: { 'src/Kernel.sol': { keccak256: keccak256(toUtf8Bytes('source')) } } } };
  assert.equal(assertArtifactSources(artifact, () => 'source'), 1);
  assert.throws(() => assertArtifactSources(artifact, () => 'changed'), /stale/);
  assert.throws(() => assertArtifactSources({ metadata: { sources: {} } }, () => ''), /empty/);
});
