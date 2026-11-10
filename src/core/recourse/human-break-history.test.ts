import { expect, it, vi } from 'vitest';
import { Interface, ZeroAddress, ZeroHash, sha256 } from 'ethers';
import { discoverHumanIdentityHistory, recoverHumanHistoricalMaterial } from './human-break-history';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import type { OwnerChainNetwork } from './owner-chain';
import type { ProtocolDeployment } from '../protocol/pointer';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const phrase = 'test test test test test test test test test test test junk';
vi.mock('./human-account', () => ({ deriveHumanAccount: async () => ({ evm: `0x${'11'.repeat(20)}`, sol: 'unused' }) }));
vi.mock('./hash-authorization', () => ({ recoverySigningRoot: async (seed: Uint8Array) => sha256(seed),
  recoveryCommitment: (secret: Uint8Array) => sha256(secret) }));
const abi = new Interface(['function registryOperator() view returns(address)', 'function ownerOf(address) view returns(bytes32)',
  'function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)', 'function breakOrigin() view returns(address)',
  'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)',
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)', 'function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
  'function ownerSigningRoot(bytes32) view returns(bytes32)']);
function fixture(mode = 'valid'): OwnerChainNetwork {
  const commitment = sha256(humanRecoverySecret(phrase, 4));
  const rpc = (index: number) => ({ async request(method: string, params: readonly unknown[]) {
    if (method === 'eth_getBlockByNumber') return { hash: mode === 'disagree' && index === 1 ? h(99) : h(100), number: '0x64', extra: index };
    const request = params[0] as { to: string; data: string }, parsed = abi.parseTransaction({ data: request.data })!;
    const blockHash = (params[1] as { blockHash: string }).blockHash;
    if ([a(2), a(6), a(8)].includes(request.to)) expect(blockHash).toBe(h(100));
    const old = blockHash === h(100);
    const values: Record<string, unknown> = {
      registryOperator: old ? a(6) : a(5), ownerOf: old ? h(11) : ZeroHash,
      ownerAuthorization: old ? a(8) : a(7), kernel: old ? a(2) : a(1), breakOrigin: old ? ZeroAddress : a(3),
      predecessor: a(2), lastGoodBlock: 100,
      ownerRecoveryCommitment: old ? commitment : ZeroHash, ownerAuthorizationNonce: 4,
      ownerSigningRoot: sha256(humanRecoverySigningSeed(phrase, 4)),
    };
    return abi.encodeFunctionResult(parsed.name, [values[parsed.name]]);
  } });
  return { rpcs: [rpc(0), rpc(1)], deployment: async () => ({ addresses: { kernel: a(1) }, blockHash: h(200), manifestHash: h(201) } as ProtocolDeployment) };
}
it('rediscovers the original owner only at authenticated last-good registry state and reconstructs its exact historic commitment', async () => {
  const network = fixture(), history = await discoverHumanIdentityHistory(phrase, network);
  expect(history?.identity).toBe(h(11)); expect(history?.points.map(point => point.blockHash)).toEqual([h(200), h(100)]);
  const material = await recoverHumanHistoricalMaterial(phrase, history!, sha256(humanRecoverySecret(phrase, 4)), network);
  expect(material.secret).toEqual(humanRecoverySecret(phrase, 4));
  expect(material.signingSeed).toEqual(humanRecoverySigningSeed(phrase, 4));
  material.secret.fill(0); material.signingSeed.fill(0);
});
it('refuses disagreeing historical blocks and unrelated or wrong-backup commitments', async () => {
  await expect(discoverHumanIdentityHistory(phrase, fixture('disagree'))).rejects.toThrow('disagreement');
  const network = fixture(), history = await discoverHumanIdentityHistory(phrase, network);
  await expect(recoverHumanHistoricalMaterial(phrase, history!, h(77), network)).rejects.toThrow('commitment_mismatch');
  await expect(recoverHumanHistoricalMaterial('another backup', history!, sha256(humanRecoverySecret(phrase, 4)), network)).rejects.toThrow('commitment_mismatch');
});
