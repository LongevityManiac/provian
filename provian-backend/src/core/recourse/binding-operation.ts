import { Interface, Wallet, hashMessage, verifyMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { ownershipBindingMessage, RECOURSE_COLLECTIONS, type OwnershipBinding } from './ownership';
import type { OwnerOperationChain } from './owner-operation-queue';

export const BINDING_OPERATIONS = 'recourse_binding_operations_v1';
export const REGISTRY_ABI = new Interface([
  'function identityAttestor() view returns(address)', 'function pointer() view returns(address)',
  'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'function consumedBinding(bytes32) view returns(bool)',
  'function bindingBlock(bytes32) view returns(uint256)',
  'function bind((bytes32 identity,address account,bytes32 recoveryCommitment,bytes32 signingRoot,address kernel,bytes32 nonce,uint256 expiresAtMs),bytes,bytes,uint256)',
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
]);
const KERNEL = new Interface(['function registryOperator() view returns(address)', 'function restorationAuthority() view returns(address)']);
const POOL = new Interface(['function registryOperator() view returns(address)']);
const TOKEN = new Interface(['function balanceOf(address) view returns(uint256)']);
export interface IdentityAttestor {
  readonly address: string;
  signMessage(message: string): Promise<string>;
}
/** The existing independently held settlement approver attests identity. It is
 * never the restoration authority and this role cannot debit a holder. */
export function configuredIdentityAttestor(env: NodeJS.ProcessEnv = process.env): IdentityAttestor {
  const key = env.PVT9_SETTLEMENT_APPROVER_KEY;
  if (!key) throw new Error('recourse_identity_attestor_unavailable');
  const wallet = new Wallet(key);
  return { address: wallet.address.toLowerCase(), signMessage: message => wallet.signMessage(message) };
}
function chainPort(): OwnerOperationChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  return { deployment: currentProtocolDeployment, async agree(method, params) {
    const values = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(values[0], values[1])) throw new Error('recourse_binding_rpc_disagreement');
    return values[0];
  } };
}
export interface ConfirmedBinding {
  readonly identity: string; readonly address: string; readonly kernel: string; readonly digest: string;
  readonly transactionHash: string; readonly block: number; readonly logIndex: number; readonly blockHash: string; readonly balanceAtomic: string;
}
const confirmed = new WeakSet<ConfirmedBinding>();
/** Find the exact consent event, including permissionless execution by another
 * submitter. The first on-chain binding supplies the ownership ledger boundary. */
export async function readConfirmedBinding(binding: OwnershipBinding, chain = chainPort()): Promise<ConfirmedBinding | null> {
  const digest = hashMessage(ownershipBindingMessage(binding)), deployment = await chain.deployment();
  if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('recourse_binding_operation_retired');
  const finalized: unknown = await chain.agree('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized || typeof finalized !== 'object' || !('hash' in finalized) || !('number' in finalized)
    || typeof finalized.hash !== 'string' || typeof finalized.number !== 'string') throw new Error('recourse_binding_reply_invalid');
  const pin = { blockHash: finalized.hash, requireCanonical: true };
  const call = async (target: string, abi: Interface, method: string, args: readonly unknown[], tag: unknown = pin) => {
    const raw = await chain.agree('eth_call', [{ to: target, data: abi.encodeFunctionData(method, args) }, tag]);
    if (typeof raw !== 'string') throw new Error('recourse_binding_reply_invalid');
    return abi.decodeFunctionResult(method, raw);
  };
  const code = await chain.agree('eth_getCode', [binding.kernel, pin]);
  if (code === '0x') return null; // Newly deployed kernel has not finalized yet.
  const registry = String((await call(binding.kernel, KERNEL, 'registryOperator', []))[0]).toLowerCase();
  const block = BigInt((await call(registry, REGISTRY_ABI, 'bindingBlock', [digest]))[0]);
  if (block === 0n) return null;
  if (block > BigInt(finalized.number) || block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('recourse_binding_reply_invalid');
  const logBlock = `0x${block.toString(16)}`;
  const topics = REGISTRY_ABI.encodeFilterTopics('OwnershipBound', [binding.identity, binding.address, binding.kernel]);
  const logs = await chain.agree('eth_getLogs', [{ address: registry, topics, fromBlock: logBlock, toBlock: logBlock }]);
  if (!Array.isArray(logs)) throw new Error('recourse_binding_reply_invalid');
  const matches = logs.filter((value: unknown) => {
    if (!value || typeof value !== 'object' || !('data' in value) || !('topics' in value)
      || typeof value.data !== 'string' || !Array.isArray(value.topics) || !value.topics.every(t => typeof t === 'string')) return false;
    const parsed = REGISTRY_ABI.parseLog({ data: value.data, topics: value.topics });
    return parsed?.args.digest === digest && parsed.args.identity === binding.identity
      && String(parsed.args.account).toLowerCase() === binding.address && String(parsed.args.kernel).toLowerCase() === binding.kernel
      && parsed.args.recoveryCommitment === binding.recoveryCommitment && parsed.args.signingRoot === binding.signingRoot;
  }) as Record<string, unknown>[];
  if (matches.length !== 1 || matches[0].removed === true || String(matches[0].address).toLowerCase() !== registry
    || typeof matches[0].transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(matches[0].transactionHash)
    || matches[0].blockNumber !== logBlock || typeof matches[0].logIndex !== 'string'
    || !/^0x[0-9a-f]+$/.test(matches[0].logIndex) || !Number.isSafeInteger(Number(BigInt(matches[0].logIndex)))) throw new Error('recourse_binding_event_invalid');
  const eventHeader = await chain.agree('eth_getBlockByNumber', [logBlock, false]);
  if (!eventHeader || typeof eventHeader !== 'object' || !('hash' in eventHeader)
    || eventHeader.hash !== matches[0].blockHash) throw new Error('recourse_binding_event_invalid');
  const first = BigInt((await call(registry, REGISTRY_ABI, 'boundBlock', [binding.address]))[0]);
  if (first <= 0n || first !== block || (await call(registry, REGISTRY_ABI, 'ownerOf', [binding.address]))[0] !== binding.identity) {
    throw new Error('recourse_binding_event_invalid');
  }
  const firstHeader = await chain.agree('eth_getBlockByNumber', [`0x${first.toString(16)}`, false]);
  if (!firstHeader || typeof firstHeader !== 'object' || !('hash' in firstHeader)
    || typeof firstHeader.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(firstHeader.hash)) throw new Error('recourse_binding_event_invalid');
  const balance = (await call(binding.kernel, TOKEN, 'balanceOf', [binding.address], { blockHash: firstHeader.hash, requireCanonical: true }))[0];
  const proof = Object.freeze({ identity: binding.identity, address: binding.address, kernel: binding.kernel, digest,
    transactionHash: matches[0].transactionHash, block: Number(first), logIndex: Number(BigInt(String(matches[0].logIndex))), blockHash: firstHeader.hash, balanceAtomic: String(balance) });
  confirmed.add(proof);
  return proof;
}
export async function confirmBindingRegistration(db: Firestore, proof: ConfirmedBinding): Promise<void> {
  if (!confirmed.has(proof)) throw new Error('recourse_binding_confirmation_unverified');
  const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(proof.address);
  await db.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (!row.exists || row.get('identity') !== proof.identity || row.get('kernel') !== proof.kernel) throw new Error('recourse_binding_record_changed');
    if (row.get('chainBindingStatus') === 'confirmed') return;
    if (row.get('checkpoint') !== undefined) throw new Error('recourse_binding_provisional_ledger');
    tx.update(ref, { chainBindingStatus: 'confirmed', chainBindingTransaction: proof.transactionHash,
      boundBlock: proof.block, boundLogIndex: proof.logIndex, boundBlockHash: proof.blockHash, openingBalanceAtomic: proof.balanceAtomic,
      bindingDigest: proof.digest, ledgerNeedsCatchup: true });
  });
}
export interface CheckedBindingOperation {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly manifestHash: string;
  readonly binding: OwnershipBinding; readonly ownerSignature: string; readonly identitySignature: string;
  readonly revision: string; readonly attestor: string;
}
const checked = new WeakSet<CheckedBindingOperation>();
export function assertCheckedBindingOperation(plan: CheckedBindingOperation): void {
  if (!checked.has(plan)) throw new Error('recourse_binding_operation_unverified');
}
/** Only a previously admitted identity/address binding can obtain this
 * attestation. The actual registry simulates BOTH signatures before queueing. */
export async function checkBindingOperation(db: Firestore, binding: OwnershipBinding, ownerSignature: string,
  attestor: IdentityAttestor, chain = chainPort()): Promise<CheckedBindingOperation> {
  const message = ownershipBindingMessage(binding), id = hashMessage(message);
  const deployment = await chain.deployment();
  if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('recourse_binding_operation_retired');
  const [owner, address] = await Promise.all([
    db.collection(RECOURSE_COLLECTIONS.identities).doc(binding.identity).get(),
    db.collection(RECOURSE_COLLECTIONS.addresses).doc(binding.address).get(),
  ]);
  if (!owner.exists || !address.exists || owner.get('recoveryCommitment') !== binding.recoveryCommitment
    || owner.get('signingRoot') !== binding.signingRoot || address.get('identity') !== binding.identity
    || address.get('kernel') !== binding.kernel || address.get('recoveryGeneration') !== owner.get('recoveryGeneration')) {
    throw new Error('recourse_binding_operation_owner_mismatch');
  }
  const pin = { blockHash: deployment.blockHash, requireCanonical: true };
  const getter = async (target: string, abi: Interface, name: string) => {
    const raw = await chain.agree('eth_call', [{ to: target, data: abi.encodeFunctionData(name) }, pin]);
    if (typeof raw !== 'string') throw new Error('recourse_binding_reply_invalid');
    return String(abi.decodeFunctionResult(name, raw)[0]).toLowerCase();
  };
  const [registry, authority, poolRegistry] = await Promise.all([
    getter(binding.kernel, KERNEL, 'registryOperator'), getter(binding.kernel, KERNEL, 'restorationAuthority'),
    getter(deployment.addresses.recoursePool, POOL, 'registryOperator'),
  ]);
  const [identitySigner, pointer] = await Promise.all([
    getter(registry, REGISTRY_ABI, 'identityAttestor'), getter(registry, REGISTRY_ABI, 'pointer'),
  ]);
  if (identitySigner !== attestor.address.toLowerCase() || identitySigner === authority
    || registry !== poolRegistry || pointer !== deployment.pointer.toLowerCase()) throw new Error('recourse_binding_attestor_mismatch');
  const identitySignature = await attestor.signMessage(message);
  if (verifyMessage(message, identitySignature).toLowerCase() !== identitySigner) throw new Error('recourse_binding_attestation_invalid');
  const calldata = REGISTRY_ABI.encodeFunctionData('bind', [[binding.identity, binding.address,
    binding.recoveryCommitment, binding.signingRoot, binding.kernel, binding.nonce, binding.expiresAtMs],
    ownerSignature, identitySignature, deployment.revision]);
  if (await chain.agree('eth_call', [{ to: registry, data: calldata }, pin]) !== '0x') throw new Error('recourse_binding_simulation_invalid');
  if ((await chain.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_binding_operation_retired');
  const plan = Object.freeze({ id, executor: registry, calldata, manifestHash: deployment.manifestHash,
    binding: Object.freeze({ ...binding }), ownerSignature, identitySignature,
    revision: deployment.revision.toString(), attestor: identitySigner });
  checked.add(plan);
  return plan;
}
export async function queueBindingOperation(db: Firestore, binding: OwnershipBinding, signature: string,
  attestor: IdentityAttestor = configuredIdentityAttestor(), chain?: OwnerOperationChain): Promise<string> {
  const id = hashMessage(ownershipBindingMessage(binding));
  const ref = db.collection(BINDING_OPERATIONS).doc(id);
  if ((await ref.get()).exists) return id;
  const prior = await readConfirmedBinding(binding, chain);
  if (prior) {
    await confirmBindingRegistration(db, prior);
    await db.runTransaction(async tx => {
      if (!(await tx.get(ref)).exists) tx.create(ref, { id, binding, ownerSignature: signature,
        status: 'confirmed', transactionHash: prior.transactionHash, finalizedAtMs: Date.now() });
    });
    return id;
  }
  const plan = await checkBindingOperation(db, binding, signature, attestor, chain);
  await db.runTransaction(async tx => {
    const [existing, owner] = await Promise.all([tx.get(ref),
      tx.get(db.collection(RECOURSE_COLLECTIONS.identities).doc(binding.identity))]);
    if (existing.exists) return;
    if (owner.get('recoveryCommitment') !== binding.recoveryCommitment || owner.get('signingRoot') !== binding.signingRoot) {
      throw new Error('recourse_binding_operation_owner_mismatch');
    }
    tx.create(ref, { ...plan, status: 'queued', transactionHash: null, createdAtMs: Date.now() });
  });
  return id;
}
