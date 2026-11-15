import { AbiCoder, Interface, getAddress, keccak256 } from 'ethers';

export const PROTOCOL_COMPONENTS = ['kernel', 'eligibilityVerifier', 'beneficiaryVerifier', 'escrow',
  'promises', 'projectPool', 'bonds', 'court', 'recoursePool', 'settlement'] as const;
export type ProtocolComponent = typeof PROTOCOL_COMPONENTS[number];
export interface PointerRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}
export interface ProtocolDeployment {
  readonly pointer: string;
  readonly revision: bigint;
  readonly manifestHash: string;
  readonly blockHash: string;
  readonly addresses: Readonly<Record<ProtocolComponent, string>>;
  readonly runtimeHashes: readonly string[];
}
const iface = new Interface([
  'function current() view returns (uint256,bytes32,address[10],bytes32[10])',
  'function requireCurrent(uint256,uint256,address) view',
  'function retired(address) view returns(bool)',
]);
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('protocol_pointer_invalid_rpc');
  return value.toLowerCase();
}
/** Checks only protocol retirement; it imposes no restriction on ordinary
 * recipients or an agent's spending choices. The caller must freshly resolve
 * the deployment and recheck its manifest before signing. */
export async function assertNoRetiredProtocolAddresses(rpcs: readonly [PointerRpc, PointerRpc],
  deployment: ProtocolDeployment, addresses: readonly string[]): Promise<void> {
  for (const address of new Set(addresses.map(getAddress))) {
    const encoded = await agreement(rpcs, 'eth_call', [{ to: deployment.pointer,
      data: iface.encodeFunctionData('retired', [address]) }, { blockHash: deployment.blockHash, requireCanonical: true }]);
    if (iface.decodeFunctionResult('retired', hex(encoded))[0] !== false) throw new Error('protocol_contract_retired');
  }
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('protocol_pointer_invalid_rpc');
  return BigInt(value);
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalized(record[key])]));
  }
  return value;
}
async function agreement(rpcs: readonly [PointerRpc, PointerRpc], method: string, params: readonly unknown[]): Promise<unknown> {
  const values = await Promise.all(rpcs.map(rpc => rpc.request(method, params)));
  if (JSON.stringify(normalized(values[0])) !== JSON.stringify(normalized(values[1]))) throw new Error('protocol_pointer_rpc_disagreement');
  return values[0];
}
/** No relay response, deployment-file fallback or cached address can authorize a transaction.
 * Callers supply two independently operated chain transports and the permanent pointer pin. */
export async function resolveProtocolDeployment(rpcs: readonly [PointerRpc, PointerRpc],
  pointer: string, pointerRuntimeHash: string, minimumRevision = 0n): Promise<ProtocolDeployment> {
  return resolveDeployment(rpcs, pointer, pointerRuntimeHash, minimumRevision);
}
/** Historical end-of-block evidence only; never authorizes a new operation.
 * Callers verify finality separately and account for publication log order when
 * a receipt and a pointer change occur within the same block. */
export async function resolveHistoricalProtocolDeployment(rpcs: readonly [PointerRpc, PointerRpc],
  pointer: string, pointerRuntimeHash: string, block: number, blockHash: string): Promise<ProtocolDeployment> {
  if (!Number.isSafeInteger(block) || block < 0 || !/^0x[0-9a-f]{64}$/.test(blockHash)) throw Error('protocol_pointer_invalid_block');
  return resolveDeployment(rpcs, pointer, pointerRuntimeHash, 0n, { height: BigInt(block), hash: blockHash });
}
async function resolveDeployment(rpcs: readonly [PointerRpc, PointerRpc], pointer: string,
  pointerRuntimeHash: string, minimumRevision: bigint, historical?: { readonly height: bigint; readonly hash: string }): Promise<ProtocolDeployment> {
  pointer = getAddress(pointer);
  if (quantity(await agreement(rpcs, 'eth_chainId', [])) !== 8453n) throw new Error('protocol_pointer_wrong_chain');
  const heights = historical ? [historical.height, historical.height]
    : await Promise.all(rpcs.map(async rpc => quantity(await rpc.request('eth_blockNumber', []))));
  const height = heights[0] < heights[1] ? heights[0] : heights[1];
  const block = await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!block || typeof block !== 'object' || !('hash' in block) || !('number' in block)
    || quantity(block.number) !== height) throw new Error('protocol_pointer_invalid_block');
  const blockHash = hex(block.hash);
  if (blockHash.length !== 66 || (historical && blockHash !== historical.hash)) throw new Error('protocol_pointer_invalid_block');
  const pin = { blockHash, requireCanonical: true };
  const code = hex(await agreement(rpcs, 'eth_getCode', [pointer, pin]));
  if (code === '0x' || keccak256(code) !== pointerRuntimeHash.toLowerCase()) throw new Error('protocol_pointer_runtime_mismatch');
  const data = iface.encodeFunctionData('current');
  const encoded = hex(await agreement(rpcs, 'eth_call', [{ to: pointer, data }, pin]));
  const decoded = iface.decodeFunctionResult('current', encoded);
  const revision = BigInt(decoded[0]);
  if (revision === 0n || revision < minimumRevision) throw new Error('protocol_pointer_rollback');
  const addresses = (Array.from(decoded[2]) as string[]).map(getAddress);
  const hashes = Array.from(decoded[3]) as string[];
  if (new Set(addresses).size !== PROTOCOL_COMPONENTS.length) throw new Error('protocol_pointer_duplicate_component');
  const manifestHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'], [8453, pointer, revision, addresses, hashes]));
  if (manifestHash !== decoded[1]) throw new Error('protocol_pointer_manifest_mismatch');
  await Promise.all(addresses.map(async (address, index) => {
    if (index === 2 && address === '0x0000000000000000000000000000000000000000' && hashes[index] === `0x${'00'.repeat(32)}`) return;
    const runtime = hex(await agreement(rpcs, 'eth_getCode', [address, pin]));
    if (runtime === '0x' || keccak256(runtime) !== hashes[index]) throw new Error('protocol_component_runtime_mismatch');
    await agreement(rpcs, 'eth_call', [{ to: pointer,
      data: iface.encodeFunctionData('requireCurrent', [revision, index, address]) }, pin]);
  }));
  // A set of authentic bytecodes can still be wired to different kernels.
  const links: readonly [number, string, number | string][] = [
    [1, 'KERNEL', 0], [3, 'pvt', 0], [4, 'pvt', 0], [5, 'pvt', 0], [6, 'pvt', 0], [7, 'pvt', 0],
    [3, 'epochClock', 0], [4, 'epochClock', 0], [5, 'epochClock', 0], [6, 'epochClock', 0], [7, 'epochClock', 0],
    [8, 'token', 0], [8, 'settlement', 9], [9, 'kernel', 0], [9, 'pool', 8],
    [0, 'protocolPointer', pointer], [8, 'pointer', pointer], [9, 'pointer', pointer],
  ];
  await Promise.all(links.map(async ([source, getter, expected]) => {
    const binding = new Interface([`function ${getter}() view returns(address)`]);
    const result = hex(await agreement(rpcs, 'eth_call', [{ to: addresses[source], data: binding.encodeFunctionData(getter) }, pin]));
    const actual = getAddress(binding.decodeFunctionResult(getter, result)[0]);
    if (actual !== (typeof expected === 'number' ? addresses[expected] : expected)) throw new Error('protocol_component_binding_mismatch');
  }));
  // Reject a newer pointer seen by either provider while the pinned read ran.
  if (!historical) {
    const latest = await agreement(rpcs, 'eth_call', [{ to: pointer, data }, 'latest']);
    if (hex(latest) !== encoded) throw new Error('protocol_pointer_changed');
  }
  const canonical = await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!canonical || typeof canonical !== 'object' || !('hash' in canonical)
    || hex(canonical.hash) !== blockHash) throw new Error('protocol_pointer_reorg');
  return { pointer, revision, manifestHash, blockHash,
    addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map((key, i) => [key, addresses[i]])) as Record<ProtocolComponent, string>,
    runtimeHashes: hashes };
}

/** Immutable component verification can be reused only while both providers
 * still prove the same pointer manifest. This refreshes the hash-pinned read
 * context without re-reading every component's bytecode and immutable links. */
export async function confirmProtocolDeployment(rpcs: readonly [PointerRpc, PointerRpc],
  verified: ProtocolDeployment, pointerRuntimeHash: string): Promise<ProtocolDeployment | null> {
  if (quantity(await agreement(rpcs, 'eth_chainId', [])) !== 8453n) throw Error('protocol_pointer_wrong_chain');
  const heads = await Promise.all(rpcs.map(async rpc => {
    const header = await rpc.request('eth_getBlockByNumber', ['latest', false]);
    if (!header || typeof header !== 'object' || !('number' in header) || !('hash' in header)
      || hex(header.hash).length !== 66) throw Error('protocol_pointer_invalid_block');
    return { height: quantity(header.number), hash: hex(header.hash), header };
  }));
  const height = heads[0].height < heads[1].height ? heads[0].height : heads[1].height;
  if (heads[0].height === heads[1].height
    && JSON.stringify(normalized(heads[0].header)) !== JSON.stringify(normalized(heads[1].header)))
    throw Error('protocol_pointer_rpc_disagreement');
  // Lagging providers reconcile at the lower common height; equal heads need
  // no second lookup. Every state read and the final reorg check remain pinned.
  const block = heads[0].height === heads[1].height ? heads[0].header
    : await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!block || typeof block !== 'object' || !('hash' in block) || !('number' in block)
    || quantity(block.number) !== height) throw Error('protocol_pointer_invalid_block');
  const blockHash = hex(block.hash);
  if (blockHash.length !== 66) throw Error('protocol_pointer_invalid_block');
  const pin = { blockHash, requireCanonical: true };
  const code = hex(await agreement(rpcs, 'eth_getCode', [verified.pointer, pin]));
  if (code === '0x' || keccak256(code) !== pointerRuntimeHash.toLowerCase()) throw Error('protocol_pointer_runtime_mismatch');
  const expected = iface.encodeFunctionResult('current', [verified.revision, verified.manifestHash,
    PROTOCOL_COMPONENTS.map(key => verified.addresses[key]), verified.runtimeHashes]).toLowerCase();
  const data = iface.encodeFunctionData('current');
  const encoded = hex(await agreement(rpcs, 'eth_call', [{ to: verified.pointer, data }, pin]));
  const revision = BigInt(iface.decodeFunctionResult('current', encoded)[0]);
  if (revision < verified.revision) throw Error('protocol_pointer_rollback');
  if (revision === verified.revision && encoded !== expected) throw Error('protocol_pointer_manifest_mismatch');
  if (encoded !== expected) return null;
  // The block at which full verification ran must still exist canonically.
  const original = hex(await agreement(rpcs, 'eth_call', [{ to: verified.pointer, data },
    { blockHash: verified.blockHash, requireCanonical: true }]));
  if (original !== expected) throw Error('protocol_pointer_reorg');
  if (hex(await agreement(rpcs, 'eth_call', [{ to: verified.pointer, data }, 'latest'])) !== expected)
    throw Error('protocol_pointer_changed');
  const canonical = await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!canonical || typeof canonical !== 'object' || !('hash' in canonical) || hex(canonical.hash) !== blockHash)
    throw Error('protocol_pointer_reorg');
  return { ...verified, blockHash };
}
