import { beforeAll, expect, it, vi } from 'vitest';
import { AbiCoder, getBytes, keccak256, sha256 } from 'ethers';
import { prepareBreakDeploymentRequest, breakDeploymentDigest } from './break-deployment-proof';
import { parseBreakDeploymentRequest } from './break-deployment-data';
import { recoverySigningRoot, recoveryCommitment } from './recourse-hash-authorization';
import { BREAK_RECOVERY_ABI } from './break-recovery';
import { HASH_ACCOUNT_FACTORY_ABI } from './hash-account-deployment';
import { PROTOCOL_COMPONENTS, type ProtocolComponent, type ProtocolDeployment } from './protocol-pointer';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const secret = new Uint8Array(32).fill(1), signing = new Uint8Array(32).fill(2), spending = new Uint8Array(32).fill(3);
let commitment: string;
beforeAll(async () => { commitment = recoveryCommitment(secret, await recoverySigningRoot(signing)); });
function fixture() {
  const entitlement = { identity: h(7), amount: '123', commitment, proof: [] };
  const leaf = sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32','uint256','bytes32'],
    ['Provian restoration', a(8), 100, entitlement.identity, entitlement.amount, commitment]));
  const state = { badProof: false, changed: false };
  const deployment: ProtocolDeployment = { pointer: a(9), revision: 1n, manifestHash: h(8), blockHash: h(9), runtimeHashes: [],
    addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map(key => [key, a(1)])) as Record<ProtocolComponent, string> };
  const rpc = { async request(method: string, params: readonly unknown[]): Promise<unknown> {
    expect(params.at(-1)).toEqual({ blockHash: h(9), requireCanonical: true });
    if (method === 'eth_getCode') return params[0] === a(5) ? '0x' : '0x6000';
    const data = (params[0] as { data: string }).data;
    for (const abi of [BREAK_RECOVERY_ABI, HASH_ACCOUNT_FACTORY_ABI]) {
      const parsed = abi.parseTransaction({ data }); if (!parsed) continue;
      const values: Record<string, unknown> = { ownerAuthorization: a(2), kernel: a(1), breakOrigin: a(3), hashAccountFactory: a(4),
        accountAddress: a(5), hashAccountCodeHash: keccak256('0x6000'), predecessor: a(8), lastGoodBlock: 100,
        restorationRoot: state.badProof ? h(99) : leaf };
      if (!(parsed.name in values)) throw Error('unexpected call');
      return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    }
    throw Error('unexpected rpc');
  } };
  const input = { entitlement, destinationSigningSeed: spending, recoverySecret: secret, recoverySigningSeed: signing,
    network: { rpcs: [rpc, rpc] as const, async deployment() { return { ...deployment, manifestHash: state.changed ? h(99) : h(8) }; } },
    persistBeforePublishing: vi.fn(async (_record: { account: string; breakOrigin: string; digest: string }) => {}) };
  return { input, state };
}
it('signs the exact authenticated factory request after durable retention, without changing caller secrets', async () => {
  const { input } = fixture();
  const request = await prepareBreakDeploymentRequest(input);
  expect(parseBreakDeploymentRequest(request)).toEqual(request);
  const digest = breakDeploymentDigest(request);
  expect(input.persistBeforePublishing).toHaveBeenCalledExactlyOnceWith({ account: a(5), breakOrigin: a(3), digest });
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  expect(slh_dsa_sha2_128s.verify(getBytes(request.signature), getBytes(digest), getBytes(request.publicKey))).toBe(true);
  expect(slh_dsa_sha2_128s.verify(getBytes(request.signature), getBytes(breakDeploymentDigest({ ...request, account: a(99) })), getBytes(request.publicKey))).toBe(false);
  expect([...secret]).toEqual(Array(32).fill(1)); expect([...signing]).toEqual(Array(32).fill(2)); expect([...spending]).toEqual(Array(32).fill(3));
});
it('refuses unauthenticated snapshots and shared recovery/spending keys before publishing', async () => {
  const { input, state } = fixture(); state.badProof = true;
  await expect(prepareBreakDeploymentRequest(input)).rejects.toThrow('entitlement_invalid');
  state.badProof = false;
  await expect(prepareBreakDeploymentRequest({ ...input, destinationSigningSeed: signing })).rejects.toThrow('material_invalid');
  await expect(prepareBreakDeploymentRequest({ ...input, recoverySecret: spending })).rejects.toThrow('material_invalid');
  expect(input.persistBeforePublishing).not.toHaveBeenCalled();
});
it('cannot publish without a durable backup or after the pointer changes while retaining it', async () => {
  const { input, state } = fixture();
  input.persistBeforePublishing.mockRejectedValueOnce(Error('backup_unavailable'));
  await expect(prepareBreakDeploymentRequest(input)).rejects.toThrow('backup_unavailable');
  input.persistBeforePublishing.mockImplementationOnce(async () => { state.changed = true; });
  await expect(prepareBreakDeploymentRequest(input)).rejects.toThrow('protocol_changed');
});
