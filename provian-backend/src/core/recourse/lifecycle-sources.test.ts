import { Interface, keccak256 } from 'ethers';
import { recourseLifecycleSources, type LifecycleSourcePort } from './lifecycle-sources';
import { protocolDeploymentFixture } from '../../__test-helpers__/protocol-fixture';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function poolSnapshot() view returns(address,uint256,bytes32,uint256,bool)',
  'function token() view returns(address)', 'function pointer() view returns(address)',
  'function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)']);
function fixture() {
  const base = protocolDeploymentFixture;
  const hashes = [...base.runtimeHashes]; hashes[8] = keccak256('0x6001');
  const deployment = { ...base, addresses: { ...base.addresses, kernel: a(20), recoursePool: a(21) }, runtimeHashes: hashes };
  let cycle = false, wrongKernel = false, cutoff = 80;
  const port: LifecycleSourcePort = {
    deployment: async () => deployment, finalized: async () => 100,
    async read(method, params) {
      if (method === 'eth_getCode') {
        const target = String(params[0]), tag = params[1];
        const birth = [a(20), a(21), a(22), a(23)].includes(target) ? 85 : 10;
        return typeof tag === 'string' && BigInt(tag) < BigInt(birth) ? '0x' : '0x6001';
      }
      const req = params[0] as { to: string; data: string }, call = abi.parseTransaction({ data: req.data })!;
      const current = [a(20), a(21), a(22), a(23)].includes(req.to);
      const value = call.name === 'poolSnapshot' ? current ? [a(11), cutoff, h(2), 3, true] : [cycle ? a(21) : a(0), 0, h(0), 0, false]
        : call.name === 'pointer' ? [deployment.pointer]
        : call.name === 'token' || call.name === 'kernel' ? [wrongKernel && call.name === 'kernel' ? a(99) : a(current ? 20 : 10)]
        : call.name === 'registryOperator' ? [a(current ? 22 : 12)] : [a(current ? 23 : 13)];
      return abi.encodeFunctionResult(call.name, value);
    },
  };
  return { port, cycle: () => { cycle = true; }, mismatch: () => { wrongKernel = true; }, invalidCutoff: () => { cutoff = 101; } };
}
test('a break preserves old source events only through its immutable custody cutoff', async () => {
  const f = fixture(), sources = await recourseLifecycleSources(f.port);
  expect(sources).toHaveLength(6);
  expect(sources.filter(s => s.address === a(11))).toEqual([{ address: a(11), kind: 'pool', from: 10, through: 80 }]);
  expect(sources.find(s => s.address === a(23))).toEqual({ address: a(23), kind: 'restoration', from: 85, through: 100 });
});
test('wrong executor wiring, cycles and a future cutoff cannot nominate witness contracts', async () => {
  for (const mutate of ['cycle', 'mismatch', 'invalidCutoff'] as const) {
    const f = fixture(); f[mutate]();
    await expect(recourseLifecycleSources(f.port)).rejects.toThrow(/recourse_lifecycle_/);
  }
});
