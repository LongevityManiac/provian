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
  pointer = getAddress(pointer);
  if (quantity(await agreement(rpcs, 'eth_chainId', [])) !== 8453n) throw new Error('protocol_pointer_wrong_chain');
  const heights = await Promise.all(rpcs.map(async rpc => quantity(await rpc.request('eth_blockNumber', []))));
  const height = heights[0] < heights[1] ? heights[0] : heights[1];
  const block = await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!block || typeof block !== 'object' || !('hash' in block) || !('number' in block)
    || quantity(block.number) !== height) throw new Error('protocol_pointer_invalid_block');
  const blockHash = hex(block.hash);
  if (blockHash.length !== 66) throw new Error('protocol_pointer_invalid_block');
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
  const latest = await agreement(rpcs, 'eth_call', [{ to: pointer, data }, 'latest']);
  if (hex(latest) !== encoded) throw new Error('protocol_pointer_changed');
  const canonical = await agreement(rpcs, 'eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
  if (!canonical || typeof canonical !== 'object' || !('hash' in canonical)
    || hex(canonical.hash) !== blockHash) throw new Error('protocol_pointer_reorg');
  return { pointer, revision, manifestHash, blockHash,
    addresses: Object.fromEntries(PROTOCOL_COMPONENTS.map((key, i) => [key, addresses[i]])) as Record<ProtocolComponent, string>,
    runtimeHashes: hashes };
}
