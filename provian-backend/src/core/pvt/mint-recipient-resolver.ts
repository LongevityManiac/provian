/** Exact, fail-closed recipient resolution for PVT settlement. */

import { ethers } from 'ethers';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import type { BeneficiaryRoutingSnapshot } from './beneficiary-routing';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function normalizedAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return null;
  const normalized = value.toLowerCase();
  return normalized === ZERO_ADDRESS ? null : normalized;
}

function addressFromFields(
  data: Record<string, unknown>,
  fields: readonly string[],
  source: string,
): string {
  const values = fields
    .map((field) => normalizedAddress(data[field]))
    .filter((value): value is string => value !== null);
  if (values.length === 0) throw new Error(`mint_recipient_address_invalid:${source}`);
  if (new Set(values).size !== 1) throw new Error(`mint_recipient_address_conflict:${source}`);
  return values[0];
}

function validateQueriedCandidate(
  snap: DocumentSnapshot,
  field: 'agent_id' | 'user_id',
  userId: string,
  collection: string,
): string {
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data
    || data.id !== snap.id
    || data[field] !== userId) {
    throw new Error(`mint_recipient_identity_invalid:${collection}:${field}`);
  }
  return addressFromFields(data, ['address', 'evm_address'], `${collection}:${snap.id}`);
}

async function queriedCandidate(
  db: Firestore,
  collection: 'agent_wallets' | 'wallets',
  field: 'agent_id' | 'user_id',
  userId: string,
): Promise<string | null> {
  const snap = await db.collection(collection).where(field, '==', userId).limit(2).get();
  if (snap.docs.length > 1) {
    throw new Error(`mint_recipient_duplicate_identity:${collection}:${field}`);
  }
  return snap.empty ? null : validateQueriedCandidate(snap.docs[0], field, userId, collection);
}

async function directWalletCandidate(
  db: Firestore,
  collection: 'agent_wallets' | 'wallets',
  userId: string,
): Promise<string | null> {
  const snap = await db.collection(collection).doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data
    || data.id !== userId) {
    throw new Error(`mint_recipient_direct_identity_invalid:${collection}`);
  }
  return addressFromFields(data, ['address', 'evm_address'], `${collection}:${userId}`);
}

async function userCandidate(db: Firestore, userId: string): Promise<string | null> {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!data || (data.user_id !== undefined && data.user_id !== userId)) {
    throw new Error('mint_recipient_user_identity_invalid');
  }
  return addressFromFields(data, ['wallet_address', 'address'], `users:${userId}`);
}

/**
 * Resolve every registry representation for an economic actor. A single
 * malformed, duplicated, or disagreeing representation blocks settlement;
 * arbitrary query order can never choose the recipient.
 */
export async function resolveMintRecipientAddress(
  db: Firestore,
  userId: string,
): Promise<string | null> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('mint_recipient_actor_invalid');
  }
  const candidates = await Promise.all([
    queriedCandidate(db, 'agent_wallets', 'agent_id', userId),
    queriedCandidate(db, 'wallets', 'user_id', userId),
    queriedCandidate(db, 'wallets', 'agent_id', userId),
    directWalletCandidate(db, 'agent_wallets', userId),
    directWalletCandidate(db, 'wallets', userId),
    userCandidate(db, userId),
  ]);
  const addresses = candidates.filter((value): value is string => value !== null);
  if (addresses.length === 0) return null;
  if (new Set(addresses).size !== 1) {
    throw new Error('mint_recipient_registry_conflict');
  }
  return addresses[0];
}

/** Rebind a historical split to the exact canonical human wallet document. */
export async function resolveCommittedBeneficiaryAddress(
  db: Firestore,
  route: BeneficiaryRoutingSnapshot,
): Promise<string | null> {
  const byUser = await db.collection('wallets')
    .where('user_id', '==', route.human_user_id)
    .limit(2)
    .get();
  if (byUser.docs.length > 1) {
    throw new Error('mint_beneficiary_duplicate_human_identity');
  }
  if (byUser.empty) return null;
  const queried = byUser.docs[0];
  const data = queried.data() as Record<string, unknown>;
  if (queried.id !== route.human_wallet_id
    || data.id !== route.human_wallet_id
    || data.type !== 'human'
    || data.user_id !== route.human_user_id
    || addressFromFields(data, ['address', 'evm_address'], `wallets:${queried.id}`)
      !== route.human_address) {
    throw new Error('mint_beneficiary_human_binding_invalid');
  }
  const direct = await db.collection('wallets').doc(route.human_wallet_id).get();
  if (!direct.exists || direct.data()?.id !== route.human_wallet_id) {
    throw new Error('mint_beneficiary_human_binding_invalid');
  }
  const resolved = await resolveMintRecipientAddress(db, route.human_user_id);
  if (resolved !== route.human_address) {
    throw new Error('mint_beneficiary_registry_conflict');
  }
  return resolved;
}
