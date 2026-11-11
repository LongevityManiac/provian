import type { Firestore } from 'firebase-admin/firestore';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS } from './ownership';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { privateMembershipStatus } from './private-membership-calendar';
import { utcCalendarMonth } from './calendar-month';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { OwnerOperationChain } from './owner-operation-queue';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { readRecoursePoolState } from './pool-state';
import type { OwnershipBinding } from './ownership';
import type { AddressMembershipConsent, MembershipAuthorizationDomain } from './membership-authorization';

/** Signing gate for an additional address only. It grants no transaction,
 * settlement or debit authority and never changes membership amounts. */
export async function requiresMemberBinding(db: Firestore, ownerIdentity: string,
  deployment: ProtocolDeployment, chain: OwnerOperationChain): Promise<boolean> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity)) throw Error('recourse_binding_private_owner_invalid');
  const [owner, row] = await Promise.all([db.collection(RECOURSE_COLLECTIONS.owners).doc(ownerIdentity).get(),
    db.collection(C.owners).doc(ownerIdentity).get()]);
  if (!owner.exists && !row.exists) return false; // First binding challenge, before registration.
  if (!owner.exists || owner.get('ownerIdentity') !== ownerIdentity || owner.get('membershipTransition') != null || owner.get('membershipScanRequired') === true) throw Error('recourse_binding_private_owner_pending');
  if (!row.exists) return false;
  const account = row.data() as PrivateMembershipAccount;
  if (account.ownerIdentity !== ownerIdentity || account.pendingReservation !== null || account.needsScan
    || account.checkpoint.pool !== deployment.addresses.recoursePool.toLowerCase()) throw Error('recourse_binding_membership_pending');
  const header = await chain.agree('eth_getBlockByHash', [deployment.blockHash, false]);
  if (!header || typeof header !== 'object' || !('hash' in header) || header.hash !== deployment.blockHash
    || !('number' in header) || typeof header.number !== 'string' || !('timestamp' in header) || typeof header.timestamp !== 'string') throw Error('recourse_binding_checkpoint');
  const block = Number(BigInt(header.number)), timestamp = Number(BigInt(header.timestamp));
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(timestamp)) throw Error('recourse_binding_checkpoint');
  const rules = await readPrivateCalendarRules(db, { pool: account.checkpoint.pool, block, blockHash: deployment.blockHash });
  return privateMembershipStatus(account.episode, utcCalendarMonth(timestamp), rules).protectedNow;
}

export async function prepareMemberBindingConsent(db: Firestore, ownerIdentity: string, binding: OwnershipBinding): Promise<{
  readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
} | null> {
  const deployment = await currentProtocolDeployment(), legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw Error('recourse_binding_rpc_operators');
  const chain: OwnerOperationChain = { deployment: currentProtocolDeployment, agree: async (m, p) => {
    const [a, b] = await Promise.all(legs.map(l => l.provider.send(m, [...p])));
    if (!rpcChainFactsEqual(a, b)) throw Error('recourse_binding_rpc_disagreement'); return a;
  } };
  if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw Error('recourse_binding_operation_retired');
  if (!await requiresMemberBinding(db, ownerIdentity, deployment, chain)) return null;
  const state = await readRecoursePoolState(binding.identity);
  if (state.kernel !== binding.kernel || state.pool !== deployment.addresses.recoursePool.toLowerCase()) throw Error('recourse_binding_operation_retired');
  // A previously confirmed binding is returned idempotently by the bind route.
  if (state.currentAddress === binding.address) return null;
  if (state.currentAddress !== `0x${'0'.repeat(40)}` || state.addressConsent) throw Error('recourse_binding_address_already_bound');
  return { domain: { chainId: '8453', pointer: deployment.pointer.toLowerCase(), kernel: binding.kernel, pool: state.pool },
    consent: { binding: binding.identity, account: binding.address, nonce: state.consentNonce, joined: true,
      revision: String(deployment.revision), ruleHash: state.signedRuleHash, expiresAt: String(Math.min(state.timestamp + 300, Math.floor(binding.expiresAtMs / 1000))) } };
}
