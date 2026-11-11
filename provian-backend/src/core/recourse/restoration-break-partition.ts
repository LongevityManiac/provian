import type { BreakEntitlement } from './break-entitlement';
import type { VerifiedBreakArtifact } from './break-artifact';

export interface BreakPartitionPort {
  manifest(): Promise<string>;
  artifact(origin: string): Promise<VerifiedBreakArtifact>;
  blockHash(block: number): Promise<string>;
  call(target: string, method: 'ownerAuthorization' | 'registryOperator' | 'protocolPointer' | 'pointer' | 'component'
    | 'kernel' | 'breakOrigin' | 'restoredIdentity' | 'ownerOf' | 'boundBlock' | 'balanceOf', args: readonly unknown[], blockHash: string): Promise<unknown>;
  /** Complete canonical registry history, including immutable predecessors.
   * The implementation establishes the deployment boundary and checks logs;
   * artifact accounts[] is never an input to enumeration. */
  registryAccounts(registry: string, identity: string, block: number, blockHash: string, pointer: string): Promise<readonly string[]>;
}
export interface ReconstructedBreakPartition {
  readonly origin: string;
  readonly predecessor: string;
  readonly cutoff: number;
  readonly cutoffHash: string;
  readonly owner: BreakEntitlement;
  readonly accounts: readonly { readonly address: string; readonly amountAtomic: string }[];
  readonly carried: ReconstructedBreakPartition | null;
}
const zero = `0x${'0'.repeat(40)}`, hash = /^0x[0-9a-f]{64}$/;
function address(value: unknown, allowZero = false): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || !allowZero && value.toLowerCase() === zero) throw Error('recourse_partition_address_invalid');
  return value.toLowerCase();
}
function uint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << 256n)) throw Error('recourse_partition_amount_invalid');
  return value;
}
/** Recover the partition that an aggregate Merkle leaf does NOT commit. Every
 * address and its balance comes from the cutoff registry/chain. Prior unissued
 * rights come from the predecessor's effective executor at that same cutoff,
 * recursively authenticated through complete ancestral artifacts. */
export async function reconstructBreakPartition(origin: string, identity: string, port: BreakPartitionPort): Promise<ReconstructedBreakPartition | null> {
  origin = address(origin);
  if (!hash.test(identity) || /^0x0+$/.test(identity)) throw Error('recourse_partition_identity_invalid');
  const manifest = await port.manifest(), checkpoints = new Map<number, string>(), seen = new Set<string>();
  const artifacts = new Map<string, VerifiedBreakArtifact>();
  const artifact = async (origin: string): Promise<VerifiedBreakArtifact> => {
    let result = artifacts.get(origin);
    if (!result) { result = await port.artifact(origin); artifacts.set(origin, result); }
    return result;
  };
  const reconstruct = async (origin: string, ceiling: number): Promise<ReconstructedBreakPartition | null> => {
    if (seen.has(origin)) throw Error('recourse_partition_cycle');
    seen.add(origin);
    const snapshot = await artifact(origin), { predecessor, block: cutoff } = snapshot.domain;
    if (!Number.isSafeInteger(cutoff) || cutoff < 1 || cutoff >= ceiling) throw Error('recourse_partition_cutoff_invalid');
    const cutoffHash = await port.blockHash(cutoff);
    if (!hash.test(cutoffHash) || checkpoints.has(cutoff) && checkpoints.get(cutoff) !== cutoffHash) throw Error('recourse_partition_reorg');
    checkpoints.set(cutoff, cutoffHash);
    const call = (target: string, method: Parameters<BreakPartitionPort['call']>[1], args: readonly unknown[] = []) => port.call(target, method, args, cutoffHash);
    const [registry, executor, pointer] = await Promise.all(['registryOperator', 'ownerAuthorization', 'protocolPointer'].map(async method =>
      address(await call(predecessor, method as 'registryOperator' | 'ownerAuthorization' | 'protocolPointer'))));
    if (address(await call(executor, 'kernel')) !== predecessor || address(await call(registry, 'pointer')) !== pointer
      || address(await call(pointer, 'component', [0])) !== predecessor) throw Error('recourse_partition_domain_invalid');
    const candidates = await port.registryAccounts(registry, identity, cutoff, cutoffHash, pointer);
    const accounts: { address: string; amountAtomic: string }[] = [], unique = new Set<string>();
    let total = 0n;
    for (const candidate of candidates) {
      const account = address(candidate);
      if (unique.has(account)) throw Error('recourse_partition_account_duplicate');
      unique.add(account);
      const bound = uint(await call(registry, 'boundBlock', [account]));
      if (await call(registry, 'ownerOf', [account]) !== identity || bound === 0n || bound > BigInt(cutoff)) throw Error('recourse_partition_binding_invalid');
      const balance = uint(await call(predecessor, 'balanceOf', [account]));
      total += balance; accounts.push({ address: account, amountAtomic: balance.toString() });
    }
    let carried: ReconstructedBreakPartition | null = null;
    const priorOrigin = address(await call(executor, 'breakOrigin'), true);
    if (priorOrigin !== zero) {
      if (priorOrigin === origin || seen.has(priorOrigin)) throw Error('recourse_partition_cycle');
      const prior = await artifact(priorOrigin);
      if (prior.domain.block >= cutoff) throw Error('recourse_partition_cutoff_invalid');
      const priorOwner = prior.owners.find(owner => owner.identity === identity);
      const restored = await call(executor, 'restoredIdentity', [identity]);
      if (typeof restored !== 'boolean' || restored && !priorOwner) throw Error('recourse_partition_prior_state_invalid');
      if (priorOwner && !restored) {
        carried = await reconstruct(priorOrigin, cutoff);
        if (!carried) throw Error('recourse_partition_prior_state_invalid');
        total += BigInt(carried.owner.amount);
      }
    }
    const owner = snapshot.owners.find(owner => owner.identity === identity);
    if (!owner) {
      if (accounts.length !== 0 || carried) throw Error('recourse_partition_owner_omitted');
      return null;
    }
    if (accounts.length === 0 && !carried) throw Error('recourse_partition_owner_omitted');
    if (total !== BigInt(owner.amount) || carried && carried.owner.commitment !== owner.commitment) throw Error('recourse_partition_total_mismatch');
    return { origin, predecessor, cutoff, cutoffHash, owner, accounts: accounts.sort((a, b) => a.address.localeCompare(b.address)), carried };
  };
  const result = await reconstruct(origin, Number.MAX_SAFE_INTEGER);
  if (await port.manifest() !== manifest) throw Error('recourse_partition_protocol_changed');
  for (const [block, expected] of checkpoints) if (await port.blockHash(block) !== expected) throw Error('recourse_partition_reorg');
  if (result && await port.blockHash(result.cutoff) !== result.cutoffHash) throw Error('recourse_partition_reorg');
  return result;
}
