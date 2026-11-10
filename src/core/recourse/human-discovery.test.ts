import { expect, it, vi } from 'vitest';
import { Interface, ZeroAddress, sha256 } from 'ethers';
import { discoverHumanAccount } from './human-discovery';
import { deriveHumanAccount } from './human-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import type { OwnerChainNetwork } from './owner-chain';
import { readOwnerChainState } from './owner-chain';
vi.mock('expo-secure-store', () => ({}));
vi.mock('../security/biometricAction', () => ({}));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({}) }));
vi.mock('./owner-chain', () => ({ readOwnerChainState: vi.fn() }));
vi.mock('./hash-authorization', () => ({ recoverySigningRoot: async (seed: Uint8Array) => sha256(seed),
  recoveryCommitment: (secret: Uint8Array) => sha256(secret) }));
const phrase = 'test test test test test test test test test test test junk';
const hash = `0x${'33'.repeat(32)}`;
const kernel = new Interface(['function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)',
  'function kernel() view returns(address)', 'function breakOrigin() view returns(address)']);
const registry = new Interface(['function ownerOf(address) view returns(bytes32)']);
function network(disagree = false): OwnerChainNetwork {
  const rpc = (index: number) => ({ async request(_method: string, params: readonly unknown[]) {
    const data = (params[0] as { data: string }).data;
    const parsed = kernel.parseTransaction({ data });
    if (parsed) {
      const values: Record<string, string> = { registryOperator: `0x${'44'.repeat(20)}`, ownerAuthorization: `0x${'45'.repeat(20)}`,
        kernel: `0x${'66'.repeat(20)}`, breakOrigin: ZeroAddress };
      return kernel.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    }
    return registry.encodeFunctionResult('ownerOf', [disagree && index === 1 ? `0x${'55'.repeat(32)}` : hash]);
  } });
  return { rpcs: [rpc(0), rpc(1)], deployment: async () => ({ manifestHash: hash, blockHash: hash,
    addresses: { kernel: `0x${'66'.repeat(20)}` } } as Awaited<ReturnType<OwnerChainNetwork['deployment']>>) };
}
it('an old backup discovers the current account when proof generation advanced beyond its spending account', async () => {
  const next = await deriveHumanAccount(phrase, 1), net = network();
  vi.mocked(readOwnerChainState).mockResolvedValue({ deployment: await net.deployment(), executor: `0x${'44'.repeat(20)}`,
    nonce: 2, destination: next.evm, signingRoot: sha256(humanRecoverySigningSeed(phrase, 2)), commitment: sha256(humanRecoverySecret(phrase, 2)) });
  const found = await discoverHumanAccount(phrase, net);
  expect(found?.selection).toMatchObject({ ...next, generation: 1, recoveryGeneration: 2 });
});
it('provider disagreement and an unmatched seed commitment cannot select an account', async () => {
  await expect(discoverHumanAccount(phrase, network(true))).rejects.toThrow('disagreement');
  const net = network();
  vi.mocked(readOwnerChainState).mockResolvedValue({ deployment: await net.deployment(), executor: `0x${'44'.repeat(20)}`,
    nonce: 1, destination: `0x${'77'.repeat(20)}`, signingRoot: hash, commitment: hash });
  await expect(discoverHumanAccount(phrase, net)).rejects.toThrow('commitment_mismatch');
});
