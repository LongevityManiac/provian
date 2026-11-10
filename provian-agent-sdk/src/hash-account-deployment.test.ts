import { expect, it } from 'vitest';
import { keccak256 } from 'ethers';
import { discoverHashAccount, prepareHashAccountDeployment, HASH_ACCOUNT_FACTORY_ABI as factoryAbi } from './hash-account-deployment';
import { BREAK_RECOVERY_ABI as breakAbi } from './break-recovery';
import { HASH_ACCOUNT_ABI as accountAbi } from './hash-account';
import { PROTOCOL_COMPONENTS, type ProtocolComponent, type ProtocolDeployment } from './protocol-pointer';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const state = { deployed: false, badCode: false, changedRoot: false, nonce: 0, disagree: false, changedManifest: false, missingFactory: false };
  const deployment: ProtocolDeployment = { pointer: a(9), revision: 1n, manifestHash: h(8), blockHash: h(9), runtimeHashes: [],
    addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map(key => [key, a(1)])) as Record<ProtocolComponent, string> };
  const rpc = (index: number) => ({ async request(method: string, params: readonly unknown[]): Promise<unknown> {
    if (index === 1 && state.disagree) return '0x01';
    expect(params.at(-1)).toEqual({ blockHash: h(9), requireCanonical: true });
    if (method === 'eth_getCode') return params[0] === a(5)
      ? state.deployed ? state.badCode ? '0x6001' : '0x6000' : '0x' : state.missingFactory ? '0x' : '0x6002';
    const data = (params[0] as { data: string }).data;
    for (const abi of [breakAbi, factoryAbi, accountAbi]) {
      const parsed = abi.parseTransaction({ data });
      if (!parsed) continue;
      const values: Record<string, unknown> = { ownerAuthorization: a(2), kernel: a(1), breakOrigin: a(3),
        hashAccountFactory: a(4), accountAddress: a(5), hashAccountCodeHash: keccak256('0x6000'),
        keyCommitment: state.changedRoot ? h(2) : h(1), nonce: state.nonce };
      if (!(parsed.name in values)) throw Error('unexpected call');
      return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    }
    throw Error('unexpected rpc');
  } });
  let reads = 0;
  const network = { rpcs: [rpc(0), rpc(1)] as const, async deployment() {
    ++reads; return { ...deployment, manifestHash: state.changedManifest && reads > 1 ? h(99) : h(8) };
  } };
  return { state, network };
}
it('prepares only the immutable origin factory and accepts an identical front-run deployment', async () => {
  const { state, network } = fixture();
  const plan = await prepareHashAccountDeployment(h(1), network, a(3));
  expect(plan).toMatchObject({ factory: a(4), account: a(5), deployed: false, initialRoot: h(1) });
  expect(factoryAbi.parseTransaction({ data: plan.data })!.args[0]).toBe(h(1));
  state.deployed = true;
  expect(await prepareHashAccountDeployment(h(1), network, a(3))).toMatchObject({ deployed: true, account: a(5) });
});
it('refuses missing factories, changed account code, advanced roots/nonces and conflicting chain views', async () => {
  for (const property of ['missingFactory', 'badCode', 'changedRoot', 'disagree', 'changedManifest'] as const) {
    const { state, network } = fixture(); state.deployed = true; state[property] = true;
    await expect(prepareHashAccountDeployment(h(1), network, a(3))).rejects.toThrow();
  }
  const { state, network } = fixture(); state.deployed = true; state.nonce = 1;
  await expect(prepareHashAccountDeployment(h(1), network, a(3))).rejects.toThrow('account_changed');
  await expect(prepareHashAccountDeployment(h(1), network, a(99))).rejects.toThrow('origin_changed');
  await expect(prepareHashAccountDeployment(h(0), network)).rejects.toThrow('root_invalid');
});
it('discovers the same deterministic account after spending without accepting it as a fresh destination', async () => {
  const { state, network } = fixture(); state.deployed = true; state.changedRoot = true; state.nonce = 7;
  expect(await discoverHashAccount(h(1), network, a(3))).toMatchObject({ account: a(5), currentRoot: h(2), nonce: '7' });
  await expect(prepareHashAccountDeployment(h(1), network, a(3))).rejects.toThrow('account_changed');
  state.badCode = true;
  await expect(discoverHashAccount(h(1), network, a(3))).rejects.toThrow('account_changed');
});
