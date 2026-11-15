import { Interface, getBytes, hashMessage } from 'ethers';
import { configuredIdentityAttestor, assertIdentityAttestation, type IdentityAttestor } from './identity-attestor';
export { configuredIdentityAttestor, type IdentityAttestor } from './identity-attestor';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { readCommonCanonicalHead } from '../onchain/common-canonical-head';
import { RECOURSE_CONFIRMATIONS } from './transaction-finality';
import { laneQueuedFields } from './transaction-lane';
import { ownershipBindingMessage, RECOURSE_COLLECTIONS, type OwnershipBinding } from './ownership';
import type { OwnerOperationChain } from './owner-operation-queue';

import { memberBindingSigningHash, MEMBER_BINDING_TUPLE, MEMBER_CONSENT_TUPLE, type MemberBindingConsent } from './member-binding';
import { standingMembershipSigningHash, parseStandingMembershipAuthorization } from './membership-authorization';
import { requiresMemberBinding } from './member-binding-requirement';

import { createHash } from 'crypto';
import { readMembershipReceipt, MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { PRIVATE_MEMBERSHIP_COLLECTIONS } from './private-membership-reservation';
export const BINDING_OPERATIONS = 'recourse_binding_operations_v1';
export const REGISTRY_ABI = new Interface([
  'function identityAttestor() view returns(address)', 'function pointer() view returns(address)',
  'function ownerOf(address) view returns(bytes32)', 'function boundBlock(address) view returns(uint256)',
  'function consumedBinding(bytes32) view returns(bool)',
  'function bindingBlock(bytes32) view returns(uint256)',
  'function bind((bytes32 identity,address account,bytes32 recoveryCommitment,bytes32 signingRoot,address kernel,bytes32 nonce,uint256 expiresAtMs),bytes,bytes,uint256)',
  `function bindWithConsent(${MEMBER_BINDING_TUPLE},bytes,bytes,uint256,${MEMBER_CONSENT_TUPLE},bytes,bytes)`,
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
]);
const KERNEL = new Interface(['function registryOperator() view returns(address)', 'function restorationAuthority() view returns(address)']);
const POOL = new Interface(['function registryOperator() view returns(address)']);
const TOKEN = new Interface(['function balanceOf(address) view returns(uint256)']);
function chainPort(): OwnerOperationChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  return { deployment: () => currentProtocolDeployment({ fresh: true }), async agree(method, params) {
    // Two providers' tips routinely differ by a block; their common canonical head is the agreed one.
    if (method === 'eth_blockNumber') return `0x${(await readCommonCanonicalHead([
      { operatorId: legs[0].operatorId, send: (m, p) => legs[0].provider.send(m, [...p]) },
      { operatorId: legs[1].operatorId, send: (m, p) => legs[1].provider.send(m, [...p]) }], 'recourse_binding_rpc_disagreement')).toString(16)}`;
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
  // A binding counts once it has twelve confirmations, the relay's Base rule.
  const head: unknown = await chain.agree('eth_blockNumber', []);
  if (typeof head !== 'string' || !/^0x[0-9a-f]+$/i.test(head)) throw new Error('recourse_binding_reply_invalid');
  const depth = BigInt(head) - BigInt(RECOURSE_CONFIRMATIONS - 1);
  if (depth < 0n) return null;
  const finalized: unknown = await chain.agree('eth_getBlockByNumber', [`0x${depth.toString(16)}`, false]);
  if (!finalized || typeof finalized !== 'object' || !('hash' in finalized) || !('number' in finalized)
    || typeof finalized.hash !== 'string' || typeof finalized.number !== 'string' || BigInt(finalized.number) !== depth) throw new Error('recourse_binding_reply_invalid');
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
/** The address's on-chain binding at the latest block and at twelve confirmations:
 * its owner, the block it was first bound in, and the block this binding's digest landed in. */
export interface AddressBindingState { readonly owner: string; readonly firstBlock: bigint; readonly digestBlock: bigint; }
export async function readAddressBinding(binding: OwnershipBinding, tag: 'latest' | 'confirmed', chain = chainPort()): Promise<AddressBindingState> {
  const digest = hashMessage(ownershipBindingMessage(binding)), deployment = await chain.deployment();
  if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('recourse_binding_operation_retired');
  let at: unknown = 'latest';
  if (tag === 'confirmed') {
    const head: unknown = await chain.agree('eth_blockNumber', []);
    if (typeof head !== 'string' || !/^0x[0-9a-f]+$/i.test(head)) throw new Error('recourse_binding_reply_invalid');
    const depth = BigInt(head) - BigInt(RECOURSE_CONFIRMATIONS - 1);
    const block: unknown = await chain.agree('eth_getBlockByNumber', [`0x${(depth < 0n ? 0n : depth).toString(16)}`, false]);
    if (!block || typeof block !== 'object' || !('hash' in block) || typeof block.hash !== 'string') throw new Error('recourse_binding_reply_invalid');
    at = { blockHash: block.hash, requireCanonical: true };
  }
  const call = async (target: string, abi: Interface, method: string, args: readonly unknown[]) => {
    const raw = await chain.agree('eth_call', [{ to: target, data: abi.encodeFunctionData(method, args) }, at]);
    if (typeof raw !== 'string') throw new Error('recourse_binding_reply_invalid');
    return abi.decodeFunctionResult(method, raw);
  };
  const registry = String((await call(binding.kernel, KERNEL, 'registryOperator', []))[0]).toLowerCase();
  const [owner, first, block] = await Promise.all([call(registry, REGISTRY_ABI, 'ownerOf', [binding.address]),
    call(registry, REGISTRY_ABI, 'boundBlock', [binding.address]), call(registry, REGISTRY_ABI, 'bindingBlock', [digest])]);
  return { owner: String(owner[0]).toLowerCase(), firstBlock: BigInt(first[0]), digestBlock: BigInt(block[0]) };
}
export async function confirmBindingRegistration(db: Firestore, proof: ConfirmedBinding, member?: MemberBindingConsent): Promise<void> {
  if (!confirmed.has(proof)) throw new Error('recourse_binding_confirmation_unverified');
  let effect: { pool: string; logIndex: number; receipt: Awaited<ReturnType<typeof readMembershipReceipt>> } | null = null;
  if (member) {
    const pool = (await currentProtocolDeployment()).addresses.recoursePool.toLowerCase();
    const receipt = await readMembershipReceipt(proof.transactionHash, pool);
    const matches = receipt.events.filter(event => {
      if (event.name !== 'AddressConsentChanged' || event.pool !== pool || event.kernel !== proof.kernel) return false;
      const log = MEMBERSHIP_RECEIPT_ABI.parseLog({ topics: [...event.topics], data: event.data });
      return log?.args.binding === proof.identity && log.args.joined === true && String(log.args.nonce) === member.authorization.consent.nonce;
    });
    if (matches.length !== 1 || receipt.block !== proof.block || receipt.blockHash !== proof.blockHash
      || matches[0].logIndex <= proof.logIndex || member.authorization.consent.binding !== proof.identity || member.authorization.consent.account !== proof.address) throw Error('recourse_binding_member_effect_missing');
    effect = { pool, logIndex: matches[0].logIndex, receipt };
  }
  const ref = db.collection(RECOURSE_COLLECTIONS.addresses).doc(proof.address);
  await db.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (!row.exists || row.get('identity') !== proof.identity || row.get('kernel') !== proof.kernel) throw new Error('recourse_binding_record_changed');
    let effectRef: FirebaseFirestore.DocumentReference | null = null;
    let ownerRef: FirebaseFirestore.DocumentReference | null = null;
    if (effect) {
      const ownerIdentity: unknown = row.get('ownerIdentity');
      if (typeof ownerIdentity !== 'string') throw Error('recourse_binding_private_owner_invalid');
      ownerRef = db.collection(RECOURSE_COLLECTIONS.owners).doc(ownerIdentity);
      effectRef = db.collection(PRIVATE_MEMBERSHIP_COLLECTIONS.effects).doc(`0x${createHash('sha256')
        .update(JSON.stringify([proof.kernel, effect.pool, proof.transactionHash, effect.logIndex])).digest('hex')}`);
      const [owner, prior] = await Promise.all([tx.get(ownerRef), tx.get(effectRef)]);
      if (!owner.exists || owner.get('ownerIdentity') !== ownerIdentity) throw Error('recourse_binding_private_owner_invalid');
      if (prior.exists) {
        if (prior.get('bindingDigest') !== proof.digest || prior.get('ownerIdentity') !== ownerIdentity) throw Error('recourse_binding_member_effect_replay');
        effectRef = null; ownerRef = null;
      }
    }
    if (row.get('chainBindingStatus') !== 'confirmed') {
      if (row.get('checkpoint') !== undefined) throw new Error('recourse_binding_provisional_ledger');
      tx.update(ref, { chainBindingStatus: 'confirmed', chainBindingTransaction: proof.transactionHash,
        boundBlock: proof.block, boundLogIndex: proof.logIndex, boundBlockHash: proof.blockHash, openingBalanceAtomic: proof.balanceAtomic,
        bindingDigest: proof.digest, ledgerNeedsCatchup: true });
    }
    if (effect && effectRef && ownerRef) {
      tx.create(effectRef, { ownerIdentity: row.get('ownerIdentity'), bindingDigest: proof.digest,
        transactionHash: proof.transactionHash, logIndex: effect.logIndex, block: proof.block, blockHash: proof.blockHash, receipt: effect.receipt });
      // Keep any prior money reservation's immutable before-state intact. This
      // separate flag blocks NEW signing until the owner scanner catches up.
      tx.update(ownerRef, { membershipScanRequired: true });
    }
  });
}

export interface CheckedBindingOperation {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly manifestHash: string;
  readonly binding: OwnershipBinding; readonly ownerSignature: string; readonly identitySignature: string;
  readonly revision: string; readonly attestor: string;
  readonly memberConsent?: MemberBindingConsent & { readonly attestorSignature: string };
}
const checked = new WeakSet<CheckedBindingOperation>();
export function assertCheckedBindingOperation(plan: CheckedBindingOperation): void {
  if (!checked.has(plan)) throw new Error('recourse_binding_operation_unverified');
}
/** Only a previously admitted identity/address binding can obtain this
 * attestation. The actual registry simulates BOTH signatures before queueing. */
export async function checkBindingOperation(db: Firestore, binding: OwnershipBinding, ownerSignature: string,
  attestor: IdentityAttestor, chain = chainPort(), memberInput?: MemberBindingConsent): Promise<CheckedBindingOperation> {
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
  const privateOwner: unknown = owner.get('ownerIdentity');
  if (typeof privateOwner !== 'string' || address.get('ownerIdentity') !== privateOwner) throw Error('recourse_binding_operation_owner_mismatch');
  const memberRequired = await requiresMemberBinding(db, privateOwner, deployment, chain);
  if (memberRequired !== Boolean(memberInput)) throw Error('recourse_binding_member_consent_required');
  const domain = { chainId: '8453', pointer, kernel: binding.kernel, pool: deployment.addresses.recoursePool.toLowerCase() };
  let memberConsent: CheckedBindingOperation['memberConsent'];
  let identitySignature: string;
  if (memberInput) {
    const authorization = parseStandingMembershipAuthorization(memberInput.authorization), consent = authorization.consent;
    if (authorization.fixedChargePayer || authorization.burnLimit !== "0" || authorization.reserveLimit !== "0") throw Error("recourse_binding_member_consent_invalid");
    if (!attestor.signBytes || consent.revision !== String(deployment.revision) || typeof memberInput.ownerSignature !== 'string'
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(memberInput.ownerSignature)) throw Error('recourse_binding_member_consent_invalid');
    const bindingBytes = getBytes(memberBindingSigningHash(domain, registry, binding, authorization));
    const consentBytes = getBytes(standingMembershipSigningHash(domain, authorization));
    identitySignature = await attestor.signBytes(bindingBytes);
    const attestorSignature = await attestor.signBytes(consentBytes);
    await assertIdentityAttestation(chain, identitySigner, deployment.blockHash, bindingBytes, identitySignature);
    await assertIdentityAttestation(chain, identitySigner, deployment.blockHash, consentBytes, attestorSignature);
    memberConsent = Object.freeze({ authorization: Object.freeze(authorization), ownerSignature: memberInput.ownerSignature, attestorSignature });
  } else {
    identitySignature = await attestor.signMessage(message);
    await assertIdentityAttestation(chain, identitySigner, deployment.blockHash, message, identitySignature);
  }
  const calldata = bindingOperationCalldata(binding, ownerSignature, identitySignature, String(deployment.revision), memberConsent);
  if (await chain.agree('eth_call', [{ to: registry, data: calldata }, pin]) !== '0x') throw new Error('recourse_binding_simulation_invalid');
  if ((await chain.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_binding_operation_retired');
  const plan = Object.freeze({ id, executor: registry, calldata, manifestHash: deployment.manifestHash,
    binding: Object.freeze({ ...binding }), ownerSignature, identitySignature,
    revision: deployment.revision.toString(), attestor: identitySigner, ...(memberConsent ? { memberConsent } : {}) });
  checked.add(plan);
  return plan;
}
export async function queueBindingOperation(db: Firestore, binding: OwnershipBinding, signature: string,
  attestor: IdentityAttestor = configuredIdentityAttestor(), chain?: OwnerOperationChain, memberConsent?: MemberBindingConsent): Promise<string> {
  const id = hashMessage(ownershipBindingMessage(binding));
  const ref = db.collection(BINDING_OPERATIONS).doc(id);
  if ((await ref.get()).exists) return id;
  const prior = await readConfirmedBinding(binding, chain);
  if (prior) {
    await confirmBindingRegistration(db, prior, memberConsent);
    await db.runTransaction(async tx => {
      if (!(await tx.get(ref)).exists) tx.create(ref, { id, binding, ownerSignature: signature,
        status: 'confirmed', transactionHash: prior.transactionHash, finalizedAtMs: Date.now() });
    });
    return id;
  }
  const plan = await checkBindingOperation(db, binding, signature, attestor, chain, memberConsent);
  await db.runTransaction(async tx => {
    const [existing, owner] = await Promise.all([tx.get(ref),
      tx.get(db.collection(RECOURSE_COLLECTIONS.identities).doc(binding.identity))]);
    if (existing.exists) return;
    if (owner.get('recoveryCommitment') !== binding.recoveryCommitment || owner.get('signingRoot') !== binding.signingRoot) {
      throw new Error('recourse_binding_operation_owner_mismatch');
    }
    tx.create(ref, { ...plan, status: 'queued', transactionHash: null, createdAtMs: Date.now(), ...laneQueuedFields(Date.now(), id) });
  });
  return id;
}

/** Reconstruct persisted bytes for both initial submission and crash retry. */
export function bindingOperationCalldata(binding: OwnershipBinding, ownerSignature: string, identitySignature: string,
  revision: string, member?: CheckedBindingOperation['memberConsent']): string {
  const args = [[binding.identity, binding.address, binding.recoveryCommitment, binding.signingRoot, binding.kernel, binding.nonce, binding.expiresAtMs],
    ownerSignature, identitySignature, BigInt(revision)];
  if (!member) return REGISTRY_ABI.encodeFunctionData('bind', args);
  return REGISTRY_ABI.encodeFunctionData('bindWithConsent', [...args, parseStandingMembershipAuthorization(member.authorization), member.ownerSignature, member.attestorSignature]);
}
