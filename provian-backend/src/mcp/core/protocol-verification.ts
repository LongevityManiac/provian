import { AbiCoder, getAddress, keccak256 } from 'ethers';
import { confirmProtocolDeployment, resolveProtocolDeployment, PROTOCOL_COMPONENTS,
  type PointerRpc, type ProtocolDeployment } from './protocol-pointer';

/** This store is local trusted verification evidence, never relay-supplied data. */
export interface ProtocolVerificationStore {
  load(): Promise<string | null>;
  save(revision: bigint, value: string): Promise<void>;
}
export interface ProtocolVerificationOptions {
  readonly pointer: string;
  readonly runtimeHash: string;
  readonly operators: readonly [string, string];
  readonly rpcs: readonly [PointerRpc, PointerRpc];
  readonly store: ProtocolVerificationStore;
  readonly minimumRevision?: () => Promise<bigint>;
}
const schema = 'protocol-verified-v1';
function freeze(value: ProtocolDeployment): ProtocolDeployment {
  return Object.freeze({ ...value, addresses: Object.freeze({ ...value.addresses }),
    runtimeHashes: Object.freeze([...value.runtimeHashes]) });
}
function unpack(text: string, options: ProtocolVerificationOptions): ProtocolDeployment {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw Error('protocol_cache_invalid');
  const saved = value as Record<string, unknown>;
  if (saved.schema !== schema || saved.runtimeHash !== options.runtimeHash
    || JSON.stringify(saved.operators) !== JSON.stringify(options.operators)
    || saved.pointer !== getAddress(options.pointer) || typeof saved.revision !== 'string'
    || !/^[1-9][0-9]*$/.test(saved.revision) || typeof saved.blockHash !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(saved.blockHash) || !Array.isArray(saved.runtimeHashes)
    || saved.runtimeHashes.length !== PROTOCOL_COMPONENTS.length
    || !saved.runtimeHashes.every(hash => typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash))
    || !saved.addresses || typeof saved.addresses !== 'object') throw Error('protocol_cache_invalid');
  const entries = saved.addresses as Record<string, unknown>;
  const addresses = PROTOCOL_COMPONENTS.map(key => {
    const address = entries[key];
    if (typeof address !== 'string') throw Error('protocol_cache_invalid');
    return getAddress(address);
  });
  const revision = BigInt(saved.revision);
  const manifestHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
    [8453, options.pointer, revision, addresses, saved.runtimeHashes]));
  if (manifestHash !== saved.manifestHash || new Set(addresses).size !== addresses.length)
    throw Error('protocol_cache_invalid');
  return freeze({ pointer: getAddress(options.pointer), revision, manifestHash, blockHash: saved.blockHash,
    addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map((key, i) => [key, addresses[i]])) as ProtocolDeployment['addresses'],
    runtimeHashes: saved.runtimeHashes as string[] });
}

/** Only immutable verification is cached. Each operation confirms the pointer on
 * both providers now, with no age-based window permitting stale signing. The
 * original full-verification block remains the reorg anchor across restarts. */
export function createProtocolVerification(options: ProtocolVerificationOptions): {
  current(): Promise<ProtocolDeployment>;
  snapshot(): ProtocolDeployment;
} {
  let verified: ProtocolDeployment | undefined;
  let current: ProtocolDeployment | undefined;
  let minimumRevision = 0n;
  let tail: Promise<void> = Promise.resolve();
  async function refresh(): Promise<ProtocolDeployment> {
    const floor = await options.minimumRevision?.() ?? 0n;
    if (floor > minimumRevision) minimumRevision = floor;
    const stored = await options.store.load();
    if (stored !== null) {
      const saved = unpack(stored, options);
      if (!verified || saved.revision > verified.revision) verified = saved;
      if (saved.revision > minimumRevision) minimumRevision = saved.revision;
    }
    if (verified && verified.revision < minimumRevision) verified = undefined;
    const confirmed = verified ? await confirmProtocolDeployment(options.rpcs, verified, options.runtimeHash) : null;
    if (confirmed) { current = freeze(confirmed); return current; }
    const result = freeze(await resolveProtocolDeployment(options.rpcs, options.pointer, options.runtimeHash, minimumRevision));
    minimumRevision = result.revision;
    await options.store.save(result.revision, JSON.stringify({ ...result, revision: result.revision.toString(),
      schema, runtimeHash: options.runtimeHash, operators: options.operators }));
    verified = result;
    current = result;
    return result;
  }
  return {
    current() {
      // Serialize callers: one full verification per revision, but a caller at
      // a later signing boundary still gets its own fresh chain confirmation.
      const work = tail.then(refresh);
      tail = work.then(() => {}, () => { current = undefined; });
      return work;
    },
    snapshot() {
      if (!current) throw Error('protocol_pointer_resolution_required');
      return current;
    },
  };
}
