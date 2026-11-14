import { randomUUID } from 'crypto';
import { AbiCoder, keccak256 } from 'ethers';
import { relayDb } from '../../firestore-db';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { PROTOCOL_POINTER_PIN } from './pointer-pin.generated';
import { confirmProtocolDeployment, resolveProtocolDeployment, PROTOCOL_COMPONENTS, type ProtocolDeployment } from './pointer';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_MS = 60_000;
let cached: ProtocolDeployment | undefined, checkedAt = 0, minimumRevision = 0n;
let scheduled: Promise<ProtocolDeployment> | undefined;
type SavedDeployment = Omit<ProtocolDeployment, 'revision'> & { revision: string };
function unpack(value: unknown): ProtocolDeployment {
  if (!value || typeof value !== 'object') throw Error('protocol_cache_invalid');
  const saved = value as SavedDeployment;
  if (!/^[1-9][0-9]*$/.test(saved.revision) || saved.pointer.toLowerCase() !== PROTOCOL_POINTER_PIN.address?.toLowerCase()
    || !/^0x[0-9a-f]{64}$/.test(saved.blockHash) || saved.runtimeHashes.length !== 10) throw Error('protocol_cache_invalid');
  const revision = BigInt(saved.revision);
  const hash = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','address[10]','bytes32[10]'],
    [8453, saved.pointer, revision, PROTOCOL_COMPONENTS.map(key => saved.addresses[key]), saved.runtimeHashes]));
  if (hash !== saved.manifestHash || revision < minimumRevision) throw Error('protocol_cache_invalid');
  return { ...saved, revision };
}
function accept(deployment: ProtocolDeployment, timestamp: number): ProtocolDeployment {
  if (deployment.revision < minimumRevision) throw Error('protocol_pointer_rollback');
  minimumRevision = deployment.revision;
  cached = deployment; checkedAt = timestamp;
  return deployment;
}
/** Metadata reads share a durable, fully verified revision. Signing and evidence
 * boundaries request fresh=true: both chain providers must confirm it now. */
export async function currentProtocolDeployment(options: { readonly fresh?: boolean } = {}): Promise<ProtocolDeployment> {
  const fresh = options.fresh === true;
  if (!fresh && cached && Date.now() >= checkedAt && Date.now() - checkedAt < CHECK_INTERVAL_MS) return cached;
  if (!fresh && scheduled) return scheduled;
  const run = refresh(fresh);
  if (fresh) return run;
  scheduled = run;
  try { return await run; } finally { scheduled = undefined; }
}
async function refresh(fresh: boolean): Promise<ProtocolDeployment> {
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash) throw Error('protocol_pointer_not_deployed');
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('protocol_rpc_operators_not_independent');
  const rpcs = legs.map(leg => ({ request: (method: string, params: readonly unknown[]) => leg.provider.send(method, [...params]) })) as
    [import('./pointer').PointerRpc, import('./pointer').PointerRpc];
  const db = relayDb(), ref = db.collection('protocol_verified_deployments_v1').doc(`${address.toLowerCase()}:${runtimeHash}`);
  const initial = await ref.get();
  const verified = initial.exists && initial.get('verified') ? unpack(initial.get('verified')) : undefined;
  const timestamp: unknown = initial.get('checkedAt');
  if (!fresh && verified && typeof timestamp === 'number' && timestamp <= Date.now() && Date.now() - timestamp < CHECK_INTERVAL_MS)
    {
      const current = unpack(initial.get('current'));
      if (current.manifestHash !== verified.manifestHash) throw Error('protocol_cache_invalid');
      return accept(current, timestamp);
    }
  const owner = randomUUID(), now = Date.now();
  // Only a revision discovery/scheduled check takes the shared lease. An actual
  // signing boundary always makes its own fresh two-provider confirmation.
  if (!fresh || !verified) await db.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (Number(row.get('leaseUntil') ?? 0) > now) throw Error('protocol_verification_busy');
    tx.set(ref, { leaseOwner: owner, leaseUntil: now + LEASE_MS }, { merge: true });
  });
  let result: ProtocolDeployment;
  try {
    const confirmed = verified ? await confirmProtocolDeployment(rpcs, verified, runtimeHash) : null;
    // New revisions require full verification under the same cross-instance lease.
    if (!confirmed && fresh && verified) await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (Number(row.get('leaseUntil') ?? 0) > Date.now()) throw Error('protocol_verification_busy');
      tx.set(ref, { leaseOwner: owner, leaseUntil: Date.now() + LEASE_MS }, { merge: true });
    });
    result = confirmed ?? await resolveProtocolDeployment(rpcs, address, runtimeHash, verified?.revision ?? minimumRevision);
    const completedAt = Date.now(), packed = { ...result, revision: result.revision.toString() };
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      const newer = row.get('verified') ? unpack(row.get('verified')) : undefined;
      if (newer && newer.revision > result.revision) throw Error('protocol_pointer_changed');
      if (!confirmed && row.get('leaseOwner') !== owner) throw Error('protocol_verification_lease_lost');
      tx.set(ref, { verified: confirmed ? { ...verified!, revision: verified!.revision.toString() } : packed,
        current: packed, checkedAt: completedAt,
        ...(row.get('leaseOwner') === owner ? { leaseOwner: null, leaseUntil: 0 } : {}) }, { merge: true });
    });
    return accept(result, completedAt);
  } catch (error) {
    cached = undefined; checkedAt = 0;
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (row.get('leaseOwner') === owner) tx.set(ref, { leaseOwner: null, leaseUntil: 0, checkedAt: 0 }, { merge: true });
      else if (Number(row.get('checkedAt') ?? 0) <= now) tx.set(ref, { checkedAt: 0 }, { merge: true });
    });
    throw error;
  }
}
