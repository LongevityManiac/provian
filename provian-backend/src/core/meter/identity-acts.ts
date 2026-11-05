import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — identity acts: the act records an actor's IDENTITY rests on.
 *
 * per actor the relay keeps identity, links, escrows and
 * recovery state — never its PEs. Before the meter, the relay proved an agent's identity facts
 * (its birth, its key rotations, its beneficiary link, a badge's source, a vote) by reading the
 * agent's WHOLE PE chain out of `provenance_envelopes` and finding the PE in it: a read that
 * grows with history and a store the meter removes.
 *
 * Instead, when the relay authors an identity-bearing PE it keeps that act's RECORD — identity
 * and pricing inputs, no free text (relay-authored PEs carry none), exactly the act record the
 * meter prices — in `identity_acts_v1/{pe_id}`, written in the same transaction that advances the
 * actor's chain tip. A validator holding a pe id + hash from an identity record (registration,
 * rotation history, relationship, badge, vote) reads that one document, re-derives the PE v2 hash
 * from it, and gets back the stored-PE shape it always checked. Per actor this is bounded by how
 * many identity events the actor has (one birth, a rotation at most daily, link changes), and no
 * read is proportional to history.
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { relayDeviceId } from './meter-store';
import { peHashOf, PE_V2_SCHEMA, type ActRecord, type PeV2 } from './meter-wire';

export const IDENTITY_ACTS_COLLECTION = 'identity_acts_v1';

/**
 * Relay-authored action types an identity record names by pe id. A PE of any other type is a
 * record of work: it is priced and delivered to its owner, never kept.
 */
export const IDENTITY_ACT_TYPES: ReadonlySet<string> = new Set([
  'agent_wallet_created',
  'agent_key_rotated',
  'agent_linked_to_human',
  'agent_unlinked_from_human',
  'agent_share_updated',
  'policy_updated',
  'external_address_proven',
  'badge_earned',
  'governance_vote_cast',
  'bond_posted',
  // A PVT mint batch's badge projection pins its system source PE and its completion PE by id +
  // hash (`pvt_mint_batches`). Only the retired PVTv8 minting engine emits these (no production
  // caller); kept so those pins validate by one point read until that module is deleted.
  'pvt_batch_minted',
  'pvt_badge_projection_completed',
]);

export function isIdentityActType(actionType: string): boolean {
  return IDENTITY_ACT_TYPES.has(actionType);
}

export interface IdentityActDoc {
  readonly schema: 'provian.identity-act.v1';
  readonly pe_id: string;
  readonly actor_id: string;
  readonly wallet_id: string;
  /** The type the act was priced under (`accrualActionType`), when it differs from the PE's. */
  readonly policy_action_type: string;
  readonly act: ActRecord;
  readonly created_at_ms: number;
}

export function buildIdentityAct(input: {
  readonly actorId: string;
  readonly walletId: string;
  readonly policyActionType: string;
  readonly act: ActRecord;
  readonly nowMs: number;
}): IdentityActDoc {
  return {
    schema: 'provian.identity-act.v1',
    pe_id: input.act.pe_id,
    actor_id: input.actorId,
    wallet_id: input.walletId,
    policy_action_type: input.policyActionType,
    act: input.act,
    created_at_ms: input.nowMs,
  };
}

export function stageIdentityActInTransaction(txn: Transaction, db: Firestore, doc: IdentityActDoc): void {
  txn.set(privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(doc.pe_id), { ...doc });
}

export class IdentityActIntegrityError extends Error {
  constructor(readonly code: string) {
    super(`identity_act_${code}`);
  }
}

/** The PE v2 an identity act records (relay-authored PEs carry no free text, so it is the whole PE). */
export function peOfIdentityAct(doc: IdentityActDoc): PeV2 {
  return {
    ...doc.act.pricing,
    schema: PE_V2_SCHEMA,
    pe_id: doc.act.pe_id,
    device_id: relayDeviceId(doc.actor_id),
    prev_hash: doc.act.prev_hash,
    timestamp: doc.act.timestamp,
    action_type: doc.act.action_type,
  };
}

/** The stored-PE view of an identity act: the fields the pre-meter validators read. */
export interface IdentityStoredPe extends Record<string, unknown> {
  readonly id: string;
  readonly wallet_id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly action_type: string;
  readonly policy_action_type: string;
  readonly actor_address: string;
  readonly timestamp: number;
  readonly created_at: number;
  readonly prev_hash: string;
  readonly hash: string;
  readonly metadata: Record<string, unknown>;
  readonly integration_source: 'agent_bank_generate_pe';
}

/**
 * Validate an identity act and return its stored-PE view. Fails closed (throws) unless the record
 * exists, names this actor and wallet, carries the expected id and hash, and its hash re-derives
 * from its own fields.
 */
export function validateIdentityAct(params: {
  readonly raw: Record<string, unknown> | undefined;
  readonly peId: string;
  readonly peHash: string;
  readonly actorId: string;
  readonly walletId?: string;
  readonly maxTimestampMs?: number;
}): IdentityStoredPe {
  const doc = params.raw as IdentityActDoc | undefined;
  if (!doc || doc.schema !== 'provian.identity-act.v1') throw new IdentityActIntegrityError('missing');
  const act = doc.act;
  const pricing = act?.pricing as Record<string, unknown> | undefined;
  if (!act || !pricing
    || doc.pe_id !== params.peId || act.pe_id !== params.peId
    || act.pe_hash !== params.peHash
    || doc.actor_id !== params.actorId
    || (params.walletId !== undefined && doc.wallet_id !== params.walletId)
    || pricing.wallet_id !== doc.wallet_id
    || (pricing.agent_id !== undefined && pricing.agent_id !== doc.actor_id)
    || typeof act.timestamp !== 'number'
    || (params.maxTimestampMs !== undefined && act.timestamp > params.maxTimestampMs)
    || pricing.metadata === null || typeof pricing.metadata !== 'object' || Array.isArray(pricing.metadata)
    || typeof pricing.actor_address !== 'string') {
    throw new IdentityActIntegrityError('fields');
  }
  if (peHashOf(peOfIdentityAct(doc)) !== act.pe_hash) throw new IdentityActIntegrityError('hash');
  return {
    ...pricing,
    id: act.pe_id,
    wallet_id: doc.wallet_id,
    agent_id: doc.actor_id,
    user_id: doc.actor_id,
    action_type: act.action_type,
    policy_action_type: doc.policy_action_type,
    actor_address: pricing.actor_address,
    timestamp: act.timestamp,
    created_at: act.timestamp,
    prev_hash: act.prev_hash,
    hash: act.pe_hash,
    metadata: pricing.metadata as Record<string, unknown>,
    integration_source: 'agent_bank_generate_pe',
  };
}

export async function readIdentityAct(
  db: Firestore,
  params: Omit<Parameters<typeof validateIdentityAct>[0], 'raw'>,
  get: (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot> = (ref) => ref.get(),
): Promise<IdentityStoredPe> {
  const snap = await get(privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(params.peId));
  return validateIdentityAct({ ...params, raw: snap.exists ? (snap.data() as Record<string, unknown>) : undefined });
}
