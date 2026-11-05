/**
 * PE METER test fixtures: identity acts exactly as `generatePE` writes them.
 *
 * `generatePE` authors a PE v2 (`relayPeOf`) and, for an identity-bearing action type, keeps its
 * act record in `identity_acts_v1/{pe_id}` (`buildIdentityAct(actRecordOf(pe))`). These helpers
 * build the same document from the same canonical content `generatePE` hashes, so a fixture is
 * byte-identical to what the relay would have stored — and a tampered copy can be re-hashed to
 * stay self-consistent, isolating the binding a RED control is aimed at.
 */

import {
  buildIdentityAct,
  IDENTITY_ACTS_COLLECTION,
  isIdentityActType,
  peOfIdentityAct,
  type IdentityActDoc,
} from '../../meter/identity-acts';
import { relayPeOf } from '../../meter/meter-relay-authored';
import { actRecordOf, peHashOf } from '../../meter/meter-wire';

type Store = Map<string, Record<string, unknown>>;

export interface IdentityPeFixtureParams {
  readonly id: string;
  readonly walletId: string;
  readonly agentId: string;
  readonly actorAddress: string;
  readonly actionType: string;
  readonly policyActionType?: string;
  readonly timestamp: number;
  readonly prevHash: string;
  readonly metadata: Record<string, unknown>;
}

/** The identity act `generatePE` would store for this PE, and its PE v2 hash. */
export function identityPeFixture(params: IdentityPeFixtureParams): {
  readonly hash: string;
  readonly key: string;
  readonly document: Record<string, unknown>;
} {
  const pe = relayPeOf({
    peId: params.id,
    actorId: params.agentId,
    prevHash: params.prevHash,
    timestamp: params.timestamp,
    actionType: params.actionType,
    content: {
      wallet_id: params.walletId,
      agent_id: params.agentId,
      actor_address: params.actorAddress,
      attestation_type: 'software',
      metadata: params.metadata,
      compute: null,
      geo: null,
      execution_env: null,
      cited_pe_ids: null,
      parent_goal_pe_id: null,
    },
  });
  const act = actRecordOf(pe);
  const document = buildIdentityAct({
    actorId: params.agentId,
    walletId: params.walletId,
    policyActionType: params.policyActionType ?? params.actionType,
    act,
    nowMs: params.timestamp,
  });
  return {
    hash: act.pe_hash,
    key: `${IDENTITY_ACTS_COLLECTION}/${params.id}`,
    document: structuredClone(document) as unknown as Record<string, unknown>,
  };
}

/**
 * Append a PE to the agent's chain as the relay does: an identity-bearing PE (`IDENTITY_ACT_TYPES`)
 * keeps its identity act; ANY PE advances the tip. A non-identity (work) PE leaves nothing readable behind — the
 * relay keeps only the tip hash.
 */
export function appendRelayPe(
  store: Store,
  params: Omit<IdentityPeFixtureParams, 'prevHash'> & { readonly keepIdentityAct?: boolean },
): string {
  const tipKey = `pe_chain_tips/${params.agentId}`;
  const tip = store.get(tipKey);
  const prevHash = typeof tip?.hash === 'string' ? tip.hash : '0x0000';
  const fixture = identityPeFixture({ ...params, prevHash });
  if (params.keepIdentityAct ?? isIdentityActType(params.actionType)) {
    store.set(fixture.key, fixture.document);
  }
  store.set(tipKey, { hash: fixture.hash, user_id: params.agentId, updated_at: params.timestamp });
  return fixture.hash;
}

/**
 * Re-hash a (tampered) identity act so it is self-consistent again; returns the new hash. A RED
 * control that re-hashes proves the refusal comes from a binding, not from the hash re-derivation.
 */
export function rehashIdentityAct(store: Store, key: string): string {
  const doc = store.get(key) as unknown as IdentityActDoc | undefined;
  if (!doc) throw new Error(`identity act fixture missing: ${key}`);
  const hash = peHashOf(peOfIdentityAct(doc));
  store.set(key, { ...(doc as unknown as Record<string, unknown>), act: { ...doc.act, pe_hash: hash } });
  return hash;
}

/** Replace one field of an identity act's PRICING content (metadata, actor_address, …). */
export function replaceIdentityActPricing(
  store: Store,
  key: string,
  field: string,
  value: unknown,
): void {
  const doc = store.get(key) as unknown as IdentityActDoc | undefined;
  if (!doc) throw new Error(`identity act fixture missing: ${key}`);
  store.set(key, {
    ...(doc as unknown as Record<string, unknown>),
    act: { ...doc.act, pricing: { ...doc.act.pricing, [field]: value } },
  });
}

/** Replace one field of an identity act's metadata. */
export function replaceIdentityActMetadata(
  store: Store,
  key: string,
  field: string,
  value: unknown,
): void {
  const doc = store.get(key) as unknown as IdentityActDoc | undefined;
  if (!doc) throw new Error(`identity act fixture missing: ${key}`);
  const metadata = { ...(doc.act.pricing.metadata as Record<string, unknown>), [field]: value };
  replaceIdentityActPricing(store, key, 'metadata', metadata);
}

/** Replace one field of an identity act's act record (pe_id, prev_hash, timestamp, action_type, pe_hash). */
export function replaceIdentityActRecord(
  store: Store,
  key: string,
  field: 'pe_id' | 'pe_hash' | 'prev_hash' | 'timestamp' | 'action_type',
  value: unknown,
): void {
  const doc = store.get(key) as unknown as IdentityActDoc | undefined;
  if (!doc) throw new Error(`identity act fixture missing: ${key}`);
  store.set(key, { ...(doc as unknown as Record<string, unknown>), act: { ...doc.act, [field]: value } });
}
