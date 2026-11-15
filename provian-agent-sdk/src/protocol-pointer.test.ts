import { describe, it, expect } from 'vitest';
import { createProtocolVerification, type ProtocolVerificationStore } from './protocol-verification';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { resolveProtocolDeployment, resolveHistoricalProtocolDeployment, type PointerRpc } from './protocol-pointer';
const pointer = `0x${'01'.repeat(20)}`;
const runtime = '0x60006000f3';
const runtimeHash = keccak256(runtime);
const blockHash = `0x${'ab'.repeat(32)}`;
const addresses = Array.from({ length: 10 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`);
const hashes = addresses.map(() => runtimeHash);
const abi = new Interface(['function current() view returns (uint256,bytes32,address[10],bytes32[10])']);
function manifest(revision: bigint, corrupt = false): string {
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
    [8453, pointer, revision, addresses, hashes]));
  return abi.encodeFunctionResult('current', [revision, corrupt ? blockHash : digest, addresses, hashes]);
}
function rpc(options: { chain?: string; code?: string; corrupt?: boolean; newer?: boolean; reorg?: boolean; wrongBinding?: boolean; revision?: bigint; anchorLost?: boolean; missing?: boolean; height?: number; hash?: string } = {}): PointerRpc {
  let blocks = 0;
  return { async request(method, params) {
    if (method === 'eth_chainId') return options.chain ?? '0x2105';
    if (method === 'eth_blockNumber') return `0x${(options.height ?? 100).toString(16)}`;
    if (method === 'eth_getBlockByNumber') return { number: `0x${(options.height ?? 100).toString(16)}`, hash: options.reorg && blocks++ > 0 ? `0x${'cd'.repeat(32)}` : options.hash ?? blockHash };
    if (method === 'eth_getCode') return params[0] === pointer ? runtime : (options.code ?? runtime);
    if (method === 'eth_call') {
      if (options.missing) throw Error('unavailable');
      if (options.anchorLost && (params[1] as { blockHash?: string })?.blockHash === blockHash) throw Error('noncanonical');
      const call = params[0] as { data: string };
      if (call.data === abi.encodeFunctionData('current')) return manifest(params[1] === 'latest' && options.newer ? 2n : options.revision ?? 1n, options.corrupt);
      const getters = ['KERNEL', 'pvt', 'epochClock', 'token', 'kernel', 'settlement', 'pool', 'protocolPointer', 'pointer'];
      for (const getter of getters) {
        const binding = new Interface([`function ${getter}() view returns(address)`]);
        if (call.data === binding.encodeFunctionData(getter)) {
          const target = options.wrongBinding ? addresses[4] : getter === 'settlement' ? addresses[9]
            : getter === 'pool' ? addresses[8] : getter === 'protocolPointer' || getter === 'pointer' ? pointer : addresses[0];
          return binding.encodeFunctionResult(getter, [target]);
        }
      }
      return '0x';
    }
    throw new Error('unexpected_rpc');
  } };
}
describe('chain-verified permanent pointer', () => {
  it('authenticates the old manifest for receipts without substituting current contracts', async () => {
    const result = await resolveHistoricalProtocolDeployment([rpc({ newer: true }), rpc({ newer: true })], pointer, runtimeHash, 100, blockHash);
    expect(result.revision).toBe(1n);
    await expect(resolveHistoricalProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 100, `0x${'cd'.repeat(32)}`)).rejects.toThrow('invalid_block');
    await expect(resolveHistoricalProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 99, blockHash)).rejects.toThrow('invalid_block');
    await expect(resolveHistoricalProtocolDeployment([rpc({ reorg: true }), rpc({ reorg: true })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('reorg');
    await expect(resolveHistoricalProtocolDeployment([rpc({ wrongBinding: true }), rpc({ wrongBinding: true })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('binding_mismatch');
    await expect(resolveHistoricalProtocolDeployment([rpc({ code: '0x00' }), rpc({ code: '0x00' })], pointer, runtimeHash, 100, blockHash)).rejects.toThrow('runtime_mismatch');
  });
  it('resolves all ten runtime-verified components without relay data', async () => {
    const result = await resolveProtocolDeployment([rpc(), rpc()], pointer, runtimeHash);
    expect(result.revision).toBe(1n);
    expect(Object.keys(result.addresses)).toHaveLength(10);
    expect(result.addresses.kernel.toLowerCase()).toBe(addresses[0]);
    expect(result.blockHash).toBe(blockHash);
  });
  it('refuses disagreement, wrong chain, wrong code, manifest alteration and rollback', async () => {
    await expect(resolveProtocolDeployment([rpc(), rpc({ chain: '0x1' })], pointer, runtimeHash)).rejects.toThrow('disagreement');
    await expect(resolveProtocolDeployment([rpc({ chain: '0x1' }), rpc({ chain: '0x1' })], pointer, runtimeHash)).rejects.toThrow('wrong_chain');
    await expect(resolveProtocolDeployment([rpc(), rpc()], pointer, blockHash)).rejects.toThrow('runtime_mismatch');
    await expect(resolveProtocolDeployment([rpc({ code: '0x00' }), rpc({ code: '0x00' })], pointer, runtimeHash)).rejects.toThrow('component_runtime_mismatch');
    await expect(resolveProtocolDeployment([rpc({ corrupt: true }), rpc({ corrupt: true })], pointer, runtimeHash)).rejects.toThrow('manifest_mismatch');
    await expect(resolveProtocolDeployment([rpc(), rpc()], pointer, runtimeHash, 2n)).rejects.toThrow('rollback');
    await expect(resolveProtocolDeployment([rpc({ wrongBinding: true }), rpc({ wrongBinding: true })], pointer, runtimeHash)).rejects.toThrow('binding_mismatch');
  });
  it('rejects a deployment change or reorganization during verification', async () => {
    await expect(resolveProtocolDeployment([rpc({ newer: true }), rpc({ newer: true })], pointer, runtimeHash)).rejects.toThrow('changed');
    await expect(resolveProtocolDeployment([rpc({ reorg: true }), rpc({ reorg: true })], pointer, runtimeHash)).rejects.toThrow('reorg');
  });
});


describe('durable revision verification', () => {
  const operators = ['provider-one', 'provider-two'] as const;
  function setup() {
    let saved: string | null = null;
    const store: ProtocolVerificationStore = { load: async () => saved, save: async (_revision, value) => { saved = value; } };
    const state: Parameters<typeof rpc>[0] = {};
    let calls = 0, componentReads = 0;
    function leg(): PointerRpc {
      const source = rpc(state);
      return { request(method, params) {
        calls++;
        if (method === 'eth_getCode' && params[0] !== pointer) componentReads++;
        return source.request(method, params);
      } };
    }
    const options = { pointer, runtimeHash, operators, rpcs: [leg(), leg()] as const, store };
    return { options, state, counts: () => ({ calls, componentReads }), saved: () => saved,
      corrupt: (change: (value: Record<string, unknown>) => void) => {
        const value = JSON.parse(saved!); change(value); saved = JSON.stringify(value);
      } };
  }
  it('verifies once, confirms every later call and reuses durable evidence on cold restart', async () => {
    const f = setup(), verifier = createProtocolVerification(f.options);
    await verifier.current();
    const initial = f.counts();
    expect(initial.componentReads).toBe(20);
    const evidence = f.saved();
    const current = await verifier.current();
    expect(f.counts()).toEqual({ calls: initial.calls + 14, componentReads: 20 });
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.addresses)).toBe(true);
    expect(Object.isFrozen(current.runtimeHashes)).toBe(true);
    await createProtocolVerification(f.options).current();
    expect(f.counts()).toEqual({ calls: initial.calls + 28, componentReads: 20 });
    expect(f.saved()).toBe(evidence);
  });
  it('keeps the original full-verification anchor across advancing blocks and restart', async () => {
    const f = setup(), verifier = createProtocolVerification(f.options);
    await verifier.current();
    f.state.height = 101; f.state.hash = `0x${'cd'.repeat(32)}`;
    expect((await verifier.current()).blockHash).toBe(f.state.hash);
    f.state.height = 102; f.state.hash = `0x${'ef'.repeat(32)}`;
    expect((await verifier.current()).blockHash).toBe(f.state.hash);
    f.state.anchorLost = true;
    // Current-block reads still succeed. Only the ORIGINAL evidence anchor is orphaned.
    await expect(verifier.current()).rejects.toThrow('noncanonical');
    await expect(createProtocolVerification(f.options).current()).rejects.toThrow('noncanonical');
    expect(f.counts().componentReads).toBe(20);
  });
  it('serializes concurrent cold callers without duplicate full verification', async () => {
    const f = setup(), verifier = createProtocolVerification(f.options);
    await Promise.all([verifier.current(), verifier.current(), verifier.current()]);
    expect(f.counts().componentReads).toBe(20);
  });
  it('fully verifies changed revisions and refuses subsequent rollback', async () => {
    const f = setup(), verifier = createProtocolVerification(f.options);
    await verifier.current(); f.state.revision = 2n;
    expect((await verifier.current()).revision).toBe(2n);
    expect(f.counts().componentReads).toBe(40);
    f.state.revision = 1n;
    await expect(verifier.current()).rejects.toThrow('rollback');
    expect(() => verifier.snapshot()).toThrow('resolution_required');
    f.state.revision = 2n;
    expect((await verifier.current()).revision).toBe(2n);
    expect(f.counts().componentReads).toBe(40);
  });
  it.each(['chain', 'newer', 'anchorLost', 'missing'] as const)('never falls back after %s confirmation failure', async kind => {
    const f = setup(), verifier = createProtocolVerification(f.options);
    await verifier.current();
    if (kind === 'chain') f.state.chain = '0x1'; else f.state[kind] = true;
    await expect(verifier.current()).rejects.toThrow();
    expect(() => verifier.snapshot()).toThrow('resolution_required');
    expect(f.counts().componentReads).toBe(20);
  });
  it.each(['schema', 'runtimeHash', 'operators', 'manifestHash', 'revision', 'blockHash', 'runtimeHashes', 'addresses'])(
    'does not trust tampered persisted %s', async field => {
      const f = setup(); await createProtocolVerification(f.options).current();
      f.corrupt(value => { value[field] = 'invalid'; });
      await expect(createProtocolVerification(f.options).current()).rejects.toThrow();
      expect(f.counts().componentReads).toBe(20);
    });
});

describe('bundled full proof and combined live heads', () => {
  const operators = ['provider-one', 'provider-two'] as const;
  async function builtIn(revision = 1n) {
    const proof = await resolveProtocolDeployment([rpc({ revision }), rpc({ revision })], pointer, runtimeHash);
    const { packProtocolProof } = await import('./protocol-verification.js');
    return packProtocolProof(proof, { operators, runtimeHash });
  }
  const empty = { load: async () => null, save: async () => {} };
  it('first launch makes seven reads per provider and exposes nothing verified beforehand', async () => {
    let calls = 0, components = 0;
    const leg = (): PointerRpc => ({ request(method, params) {
      calls++; if (method === 'eth_getCode' && params[0] !== pointer) components++;
      return rpc().request(method, params);
    } });
    const v = createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [leg(), leg()], store: empty, builtInProof: await builtIn() });
    expect((await v.candidate())?.revision).toBe(1n);
    expect(() => v.snapshot()).toThrow('resolution_required');
    const pending = v.current();
    expect(() => v.snapshot()).toThrow('resolution_required');
    expect((await pending).revision).toBe(1n);
    expect(calls).toBe(14); expect(components).toBe(0);
  });
  it('a newer revision requires full verification even when the kernel address stays the same', async () => {
    let components = 0, saved = '';
    const leg = (): PointerRpc => ({ request(method, params) {
      if (method === 'eth_getCode' && params[0] !== pointer) components++;
      return rpc({ revision: 2n }).request(method, params);
    } });
    const v = createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [leg(), leg()],
      store: { load: async () => null, save: async (_, value) => { saved = value; } }, builtInProof: await builtIn() });
    expect((await v.current()).revision).toBe(2n);
    expect(components).toBe(20); expect(JSON.parse(saved).revision).toBe('2');
  });
  it('durable and bundled evidence preserve the highest revision floor', async () => {
    const one = await builtIn(), two = await builtIn(2n);
    const v = createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [rpc({ revision: 2n }), rpc({ revision: 2n })],
      store: { ...empty, load: async () => two }, builtInProof: one });
    expect((await v.candidate())?.revision).toBe(2n);
    expect((await v.current()).revision).toBe(2n);
    const rollback = createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [rpc(), rpc()],
      store: { ...empty, load: async () => one }, builtInProof: two });
    expect((await rollback.candidate())?.revision).toBe(2n);
    await expect(rollback.current()).rejects.toThrow('rollback');
  });
  it.each(['schema','operators','pointer','runtimeHash','manifestHash','addresses','blockHash','runtimeHashes'])(
    'refuses a malformed bundled %s', async field => {
      const value = JSON.parse(await builtIn()); value[field] = 'invalid';
      expect(() => createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [rpc(), rpc()],
        store: empty, builtInProof: JSON.stringify(value) })).toThrow();
    });
  it('refuses an orphaned bundled anchor and never authorizes a snapshot', async () => {
    const v = createProtocolVerification({ pointer, runtimeHash, operators,
      rpcs: [rpc({ anchorLost: true }), rpc({ anchorLost: true })], store: empty, builtInProof: await builtIn() });
    await expect(v.current()).rejects.toThrow('noncanonical');
    expect(() => v.snapshot()).toThrow('resolution_required');
  });
  it('reconciles unequal heads and rejects equal-height forks or malformed headers', async () => {
    const proof = await builtIn();
    const leg = (height: number): PointerRpc => ({ request(method, params) {
      if (method === 'eth_getBlockByNumber') return Promise.resolve({ number: params[0] === 'latest' ? `0x${height.toString(16)}` : params[0], hash: blockHash });
      return rpc().request(method, params);
    } });
    const v = createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [leg(100), leg(101)], store: empty, builtInProof: proof });
    expect((await v.current()).revision).toBe(1n);
    for (const bad of [null, { number: 'invalid', hash: blockHash }, { number: '0x64', hash: '0x12' }, { number: '0x64', hash: blockHash, parentHash: blockHash }, { number: '0x64', hash: `0x${'cd'.repeat(32)}` }]) {
      const corrupt: PointerRpc = { request: (method, params) => method === 'eth_getBlockByNumber' ? Promise.resolve(bad) : rpc().request(method, params) };
      await expect(createProtocolVerification({ pointer, runtimeHash, operators, rpcs: [leg(100), corrupt], store: empty, builtInProof: proof }).current()).rejects.toThrow();
    }
  });
  it('build generation fully verifies finalized evidence and rejects a newer live revision', async () => {
    const { buildProtocolProof } = await import('./protocol-proof-build.js');
    const value = await buildProtocolProof([rpc(), rpc()], pointer, runtimeHash, operators);
    expect(JSON.parse(value).blockHash).toBe(blockHash);
    expect(await buildProtocolProof([rpc(), rpc()], pointer, runtimeHash, operators, value)).toBe(value);
    await expect(buildProtocolProof([rpc({ newer: true }), rpc({ newer: true })], pointer, runtimeHash, operators)).rejects.toThrow();
    await expect(buildProtocolProof([rpc({ wrongBinding: true }), rpc({ wrongBinding: true })], pointer, runtimeHash, operators)).rejects.toThrow('binding_mismatch');
  });
  it('anchors build evidence at finalized height rather than the later live head', async () => {
    const { buildProtocolProof } = await import('./protocol-proof-build.js');
    const laterHash = `0x${'cd'.repeat(32)}`;
    function leg(disagree = false): PointerRpc {
      return { request(method, params) {
        if (method === 'eth_getBlockByNumber') {
          const height = params[0] === 'finalized' ? 100 : params[0] === 'latest' ? 102 : Number(BigInt(String(params[0])));
          const hash = height === 100 ? (disagree ? laterHash : blockHash) : laterHash;
          return Promise.resolve({ number: `0x${height.toString(16)}`, hash });
        }
        return rpc().request(method, params);
      } };
    }
    const proof = JSON.parse(await buildProtocolProof([leg(), leg()], pointer, runtimeHash, operators));
    expect(proof.blockHash).toBe(blockHash);
    expect(proof.blockHash).not.toBe(laterHash);
    await expect(buildProtocolProof([leg(), leg(true)], pointer, runtimeHash, operators)).rejects.toThrow('finalized_disagreement');
  });

});
