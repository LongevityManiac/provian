import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — a cited act's identifier facts, wherever they can be proven.
 *
 * Court standing and Court evidence cite PEs by id. Before the meter the relay answered from its
 * own copy of every PE (`provenance_envelopes` / `pe_history`); under the meter it keeps no PE, so
 * a cited act is resolved from what the relay DOES keep, in order:
 *
 *   1. the act's 31-day act key (`meter_act_keys_v1/{relay_pe_id}`.facts — identifiers only);
 *   2. the act's identity record (`identity_acts_v1/{pe_id}`) for an identity-bearing act, whose
 *      hash is re-derived from its own fields before it is believed;
 *   3. otherwise the PRESENTER proves it: the PE body plus its two-hop inclusion proof, checked
 *      against the anchored root on Base (`proveMeterFactInclusion`, the pe_fact presentation's
 *      own proof). The facts then come from the proven PE itself.
 *
 * Nothing found and nothing presented is `not_found` — never a guess (Unknown = Block). A
 * presented proof that fails is `refused` with its reason, never silently treated as absence.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { MeterActKeyDoc } from './meter-act-key';
import { proveMeterFactInclusion } from './meter-fact-proof';
import { IDENTITY_ACTS_COLLECTION, peOfIdentityAct, type IdentityActDoc } from './identity-acts';
import { METER_ACT_KEYS_COLLECTION, meterRelayPeId, relayDeviceId } from './meter-store';
import { peHashOf, type PeV2 } from './meter-wire';

/** What a presenter supplies to prove a PE the relay no longer keeps. */
export interface PresentedPeProof {
  readonly pe_id: string;
  readonly envelope_hash: string;
  readonly pe: unknown;
  readonly inclusion: unknown;
}

export interface CitedActFacts {
  /** The id the relay keys the act under (`pe_m_…` for a device act, the PE id for a relay act). */
  readonly relay_pe_id: string;
  readonly action_type: string;
  readonly user_id: string;
  readonly wallet_id: string | null;
  readonly counterparty_address: string | null;
  readonly actor_address: string | null;
  readonly timestamp: number;
  readonly source: 'act_key' | 'identity_act' | 'presented';
}

export type CitedActResolution =
  | { readonly status: 'found'; readonly facts: CitedActFacts }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly http: number; readonly reason: string };

export interface CitedActDeps {
  readonly anchorContract: { verifyPE(batchId: string, leaf: string, proof: string[]): Promise<boolean> } | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The relay's id for a PE: a relay-authored PE keeps its own id; a device PE is keyed by its hash. */
export function relayPeIdOfPe(pe: PeV2, peHash: string): string {
  return typeof pe.device_id === 'string' && pe.device_id.startsWith(relayDeviceId(''))
    ? pe.pe_id
    : meterRelayPeId(peHash);
}

function factsOfActKey(peId: string, key: Partial<MeterActKeyDoc>): CitedActFacts | null {
  const facts = key.facts;
  if (facts) {
    if (typeof facts.user_id !== 'string' || typeof facts.action_type !== 'string' || num(facts.timestamp) === null) return null;
    return {
      relay_pe_id: peId,
      action_type: facts.action_type,
      user_id: facts.user_id,
      wallet_id: str(facts.wallet_id),
      counterparty_address: str(facts.counterparty_address),
      actor_address: str(facts.actor_address),
      timestamp: facts.timestamp,
      source: 'act_key',
    };
  }
  // A key sealed before it carried facts still names its actor; the identifiers it never stored
  // are null (a missing identifier never grants standing).
  const actor = str(key.actor_id);
  const actionType = str(key.action_type);
  const timestamp = num(key.timestamp);
  if (actor === null || actionType === null || timestamp === null) return null;
  return {
    relay_pe_id: peId,
    action_type: actionType,
    user_id: actor,
    wallet_id: null,
    counterparty_address: null,
    actor_address: null,
    timestamp,
    source: 'act_key',
  };
}

function factsOfIdentityAct(peId: string, doc: IdentityActDoc): CitedActFacts | null {
  if (doc.schema !== 'provian.identity-act.v1' || !doc.act || doc.pe_id !== peId || doc.act.pe_id !== peId) return null;
  // Believe the record only when its hash re-derives from its own fields.
  if (peHashOf(peOfIdentityAct(doc)) !== doc.act.pe_hash) return null;
  const pricing = doc.act.pricing as Record<string, unknown>;
  return {
    relay_pe_id: peId,
    action_type: doc.act.action_type,
    user_id: doc.actor_id,
    wallet_id: str(doc.wallet_id),
    counterparty_address: str(pricing.counterparty_address),
    actor_address: str(pricing.actor_address),
    timestamp: doc.act.timestamp,
    source: 'identity_act',
  };
}

/**
 * Resolve one cited PE id to its identifier facts. `presented` is used only when the relay keeps
 * nothing for the id (a proof is never needed for an act the relay can still see).
 */
export async function resolveCitedAct(
  db: Firestore,
  peId: string,
  presented: PresentedPeProof | null,
  deps: CitedActDeps,
): Promise<CitedActResolution> {
  const key = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId).get();
  if (key.exists) {
    const facts = factsOfActKey(peId, key.data() as Partial<MeterActKeyDoc>);
    return facts !== null ? { status: 'found', facts } : { status: 'refused', http: 500, reason: 'act_key_malformed' };
  }
  const identity = await privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(peId).get();
  if (identity.exists) {
    const facts = factsOfIdentityAct(peId, identity.data() as IdentityActDoc);
    return facts !== null ? { status: 'found', facts } : { status: 'refused', http: 500, reason: 'identity_act_integrity' };
  }
  if (presented === null) return { status: 'not_found' };
  const proven = await proveMeterFactInclusion({
    claim: { pe_id: presented.pe_id, envelope_hash: presented.envelope_hash },
    pe: presented.pe,
    inclusion: presented.inclusion,
    anchorContract: deps.anchorContract,
  });
  if (proven.status === 'refused') return proven;
  const pe = proven.pe;
  // The cited id must name THIS PE: its own id (relay-authored, or as the owner knows it) or the
  // relay's hash-derived id for it. A proof of some other PE never stands in for the cited one.
  const relayPeId = relayPeIdOfPe(pe, proven.proof.envelope_hash);
  if (peId !== pe.pe_id && peId !== relayPeId) return { status: 'refused', http: 409, reason: 'presented_pe_is_not_the_cited_pe' };
  return {
    status: 'found',
    facts: {
      relay_pe_id: relayPeId,
      action_type: pe.action_type,
      user_id: proven.actorId,
      wallet_id: str(pe.wallet_id),
      counterparty_address: str(pe.counterparty_address),
      actor_address: str(pe.actor_address),
      timestamp: pe.timestamp,
      source: 'presented',
    },
  };
}

/** Parse a request body's `pe_proofs` array into a map by cited id; null when malformed. */
export function parsePresentedPeProofs(raw: unknown, maxEntries: number): Map<string, PresentedPeProof> | null {
  const out = new Map<string, PresentedPeProof>();
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw) || raw.length > maxEntries) return null;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.pe_id !== 'string' || e.pe_id.length === 0 || e.pe_id.length > 200
      || typeof e.envelope_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(e.envelope_hash)) {
      return null;
    }
    out.set(e.pe_id, { pe_id: e.pe_id, envelope_hash: e.envelope_hash, pe: e.pe, inclusion: e.inclusion });
  }
  return out;
}
