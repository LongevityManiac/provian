import { Interface, ZeroAddress, ZeroHash } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { deriveHumanAccount } from './human-account';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';

const abi = new Interface([
  'function registryOperator() view returns(address)', 'function ownerOf(address) view returns(bytes32)',
  'function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function ownerAuthorizationNonce(bytes32) view returns(uint256)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function recoveredDestination(bytes32) view returns(address)',
]);
export interface HumanRecoveryHistoryPoint {
  readonly kernel: string; readonly executor: string; readonly breakOrigin: string;
  readonly blockHash: string;
}
export interface HumanIdentityHistory {
  readonly identity: string; readonly rootAddress: string; readonly manifestHash: string;
  /** Newest first; old registries are read only at their last-good cutoffs. */
  readonly points: readonly HumanRecoveryHistoryPoint[];
}
async function agree(network: OwnerChainNetwork, method: string, params: readonly unknown[]): Promise<unknown> {
  const replies = await Promise.all(network.rpcs.map(rpc => rpc.request(method, params)));
  if (JSON.stringify(replies[0]) !== JSON.stringify(replies[1])) throw Error('recourse_break_history_disagreement');
  return replies[0];
}
async function call(network: OwnerChainNetwork, target: string, method: string, args: readonly unknown[], blockHash: string) {
  const raw = await agree(network, 'eth_call', [{ to: target, data: abi.encodeFunctionData(method, args) },
    { blockHash, requireCanonical: true }]);
  if (typeof raw !== 'string') throw Error('recourse_break_history_invalid');
  return abi.decodeFunctionResult(method, raw)[0];
}
/** A break registry intentionally does not trust its compromised predecessor's
 * current bindings. Follow immutable break origins and read each predecessor at
 * the last-good block instead. The relay cannot select an identity or a signer. */
export async function discoverHumanIdentityHistory(mnemonic: string, network: OwnerChainNetwork): Promise<HumanIdentityHistory | null> {
  const root = await deriveHumanAccount(mnemonic, 0), deployment = await network.deployment();
  let kernel = deployment.addresses.kernel.toLowerCase(), blockHash = deployment.blockHash;
  let ownerIdentity: string | null = null;
  const points: HumanRecoveryHistoryPoint[] = [], seen = new Set<string>();
  while (true) {
    const key = `${kernel}:${blockHash}`;
    if (seen.has(key)) throw Error('recourse_break_history_cycle');
    seen.add(key);
    const registry = String(await call(network, kernel, 'registryOperator', [], blockHash)).toLowerCase();
    const executor = String(await call(network, kernel, 'ownerAuthorization', [], blockHash)).toLowerCase();
    if (registry === ZeroAddress || executor === ZeroAddress
      || String(await call(network, executor, 'kernel', [], blockHash)).toLowerCase() !== kernel) throw Error('recourse_break_history_invalid');
    const origin = String(await call(network, executor, 'breakOrigin', [], blockHash)).toLowerCase();
    points.push({ kernel, executor, breakOrigin: origin, blockHash });
    const identity = String(await call(network, registry, 'ownerOf', [root.evm], blockHash));
    if (identity !== ZeroHash) {
      if (ownerIdentity !== null && ownerIdentity !== identity) throw Error('recourse_break_history_identity_conflict');
      ownerIdentity = identity;
    }
    if (origin === ZeroAddress) {
      if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_break_history_changed');
      return ownerIdentity === null ? null : { identity: ownerIdentity, rootAddress: root.evm, manifestHash: deployment.manifestHash, points };
    }
    const previous = String(await call(network, origin, 'predecessor', [], blockHash)).toLowerCase();
    const cutoff = BigInt(await call(network, origin, 'lastGoodBlock', [], blockHash));
    if (previous === ZeroAddress || cutoff === 0n) throw Error('recourse_break_history_invalid');
    // Compare only chain facts; RPC-specific block annotations are irrelevant.
    const replies = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBlockByNumber', [`0x${cutoff.toString(16)}`, false])));
    const facts = replies.map(raw => {
      if (!raw || typeof raw !== 'object' || !('hash' in raw) || typeof raw.hash !== 'string'
        || !/^0x[0-9a-f]{64}$/.test(raw.hash) || !('number' in raw) || typeof raw.number !== 'string'
        || BigInt(raw.number) !== cutoff) throw Error('recourse_break_history_block_invalid');
      return raw.hash;
    });
    if (facts[0] !== facts[1]) throw Error('recourse_break_history_disagreement');
    kernel = previous; blockHash = facts[0];
  }
}

/** The last curve-era destination determines the independent Solana account
 * used before PVT's break recovery. Its generation does not reset at a break. */
export async function discoverHistoricalCurveGeneration(mnemonic: string, history: HumanIdentityHistory,
  network: OwnerChainNetwork): Promise<number> {
  const point = history.points.at(-1);
  if (!point || point.breakOrigin !== ZeroAddress) throw Error('recourse_curve_history_missing');
  const destination = String(await call(network, point.executor, 'recoveredDestination', [history.identity], point.blockHash)).toLowerCase();
  if (destination === ZeroAddress || destination === history.rootAddress) return 0;
  const nonce = BigInt(await call(network, point.executor, 'ownerAuthorizationNonce', [history.identity], point.blockHash));
  if (nonce >= 0x80000000n) throw Error('recourse_curve_history_invalid');
  for (let generation = Number(nonce); generation >= 0; --generation) {
    if ((await deriveHumanAccount(mnemonic, generation)).evm !== destination) continue;
    if ((await network.deployment()).manifestHash !== history.manifestHash) throw Error('recourse_break_history_changed');
    return generation;
  }
  throw Error('recourse_curve_history_destination_mismatch');
}

/** Locate the exact historic recovery material, including a rolled-back or
 * still-pending earlier break. No newest-generation assumption is made. The
 * caller must authenticate the entitlement's Merkle proof before publishing it. */
export async function recoverHumanHistoricalMaterial(mnemonic: string, history: HumanIdentityHistory,
  commitment: string, network: OwnerChainNetwork): Promise<{ secret: Uint8Array; signingSeed: Uint8Array }> {
  if (!/^0x[0-9a-f]{64}$/.test(commitment) || commitment === ZeroHash) throw Error('recourse_break_commitment_invalid');
  for (const point of history.points) {
    const expected = String(await call(network, point.executor, 'ownerRecoveryCommitment', [history.identity], point.blockHash));
    if (expected !== commitment) continue;
    const nonce = BigInt(await call(network, point.executor, 'ownerAuthorizationNonce', [history.identity], point.blockHash));
    const expectedRoot = String(await call(network, point.executor, 'ownerSigningRoot', [history.identity], point.blockHash));
    const candidates: Array<() => [Uint8Array, Uint8Array]> = [];
    if (point.breakOrigin !== ZeroAddress) {
      const context = { identity: history.identity, breakOrigin: point.breakOrigin, chainId: '8453' };
      candidates.push(() => [humanBreakKey(mnemonic, context, 'recovery-secret', String(nonce)),
        humanBreakKey(mnemonic, context, 'recovery-signing', String(nonce))]);
    } else if (nonce < 0x80000000n) candidates.push(() => [humanRecoverySecret(mnemonic, Number(nonce), history.identity), humanRecoverySigningSeed(mnemonic, Number(nonce), history.identity)]);
    for (const derive of candidates) {
      const [secret, signingSeed] = derive();
      let retained = false;
      try {
        const root = await recoverySigningRoot(signingSeed);
        if (root !== expectedRoot || recoveryCommitment(secret, root) !== commitment) continue;
        if ((await network.deployment()).manifestHash !== history.manifestHash) throw Error('recourse_break_history_changed');
        retained = true; return { secret, signingSeed };
      } finally { if (!retained) { secret.fill(0); signingSeed.fill(0); } }
    }
  }
  throw Error('recourse_break_backup_commitment_mismatch');
}
