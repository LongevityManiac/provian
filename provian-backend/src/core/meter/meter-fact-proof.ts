/**
 * PE METER — a past act presented as a chain-verifiable fact (, item 9).
 *
 * The relay keeps no PE, so a fact presentation is built from what the PRESENTER holds: the PE
 * itself and its two-hop inclusion proof (which the device fetched from `/v1/meter/proofs` once
 * its day was anchored). Provian confirms, without trusting either side:
 *
 * hop 1 the act record of the PE (its pe_hash + pricing inputs) is a leaf of its batch's
 * `acts_root`, and that root with the batch identity (device, actor, seq, batch hash)
 * produces the batch leaf;
 * hop 2 keccak(0x00 ‖ batch leaf) is in the day root anchored on the deployed PEAnchor, read
 * from Base;
 *
 * and that the batch leaf's actor is the presenter (the batch leaf commits to the actor, so
 * ownership needs no relay record). The resulting proof is embedded in the presentation so the
 * counterparty repeats both hops against Base with zero trust in Provian.
 */

import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import { meterAnchorBatchId } from './meter-anchor';
import {
  actLeafOf,
  actRecordOf,
  batchLeafOf,
  peHashOf,
  PE_V2_SCHEMA,
  verifyMerkleProofOf,
  type ActRecord,
  type PeV2,
} from './meter-wire';

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX32_PROOF_ITEM = /^(0x)?[0-9a-fA-F]{64}$/;

/** What the presenter supplies beside a claim to present a metered PE. */
export interface MeterFactInclusion {
  readonly act_index: number;
  readonly act_proof: readonly string[];
  readonly acts_root: string;
  readonly batch: {
    readonly device_id: string;
    readonly actor_id: string;
    readonly seq: number;
    readonly batch_hash: string;
  };
  readonly anchor: {
    readonly day: string;
    /** keccak sibling path of the anchor leaf to the anchored day root. */
    readonly proof: readonly string[];
    /** 2026-10-10: the intra-day anchor segment (`<day>:<n>`) the batch was anchored in; absent for the day's close anchor. */
    readonly segment?: number;
  };
}

export interface MeterFactLeaf {
  readonly kind: 'meter_act';
  /** keccak(0x00 ‖ batch_leaf): the leaf anchored on chain. */
  readonly leaf_value: string;
  readonly act: ActRecord;
  readonly act_index: number;
  readonly act_proof: readonly string[];
  readonly acts_root: string;
  readonly batch: MeterFactInclusion['batch'];
  readonly batch_leaf: string;
}

function isStringArray(value: unknown, item: RegExp): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every((v) => typeof v === 'string' && item.test(v));
}

export function parseMeterFactInclusion(raw: unknown): MeterFactInclusion | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const batch = r.batch as Record<string, unknown> | undefined;
  const anchor = r.anchor as Record<string, unknown> | undefined;
  if (typeof r.act_index !== 'number' || !Number.isSafeInteger(r.act_index) || r.act_index < 0
    || !isStringArray(r.act_proof, HEX64)
    || typeof r.acts_root !== 'string' || !HEX64.test(r.acts_root)
    || !batch || typeof batch.device_id !== 'string' || batch.device_id.length === 0
    || typeof batch.actor_id !== 'string' || batch.actor_id.length === 0
    || typeof batch.seq !== 'number' || !Number.isSafeInteger(batch.seq) || batch.seq < 1
    || typeof batch.batch_hash !== 'string' || !HEX64.test(batch.batch_hash)
    || !anchor || typeof anchor.day !== 'string' || !DAY.test(anchor.day)
    || !isStringArray(anchor.proof, HEX32_PROOF_ITEM)
    || !(anchor.segment === undefined || (typeof anchor.segment === 'number' && Number.isSafeInteger(anchor.segment) && anchor.segment >= 1))) {
    return null;
  }
  return {
    act_index: r.act_index,
    act_proof: r.act_proof,
    acts_root: r.acts_root,
    batch: { device_id: batch.device_id, actor_id: batch.actor_id, seq: batch.seq, batch_hash: batch.batch_hash },
    anchor: { day: anchor.day, proof: anchor.proof, ...(anchor.segment !== undefined ? { segment: anchor.segment as number } : {}) },
  };
}

/** Hop 1 over an act RECORD (what a verifier holds): the batch leaf it proves, or a reason. */
export function verifyActRecordInclusion(
  act: ActRecord,
  inclusion: Pick<MeterFactInclusion, 'act_proof' | 'acts_root' | 'batch'>,
): { ok: true; batch_leaf: string } | { ok: false; reason: string } {
  if (!verifyMerkleProofOf(actLeafOf(act), inclusion.act_proof, inclusion.acts_root)) {
    return { ok: false, reason: 'act_not_in_batch' };
  }
  return {
    ok: true,
    batch_leaf: batchLeafOf({ ...inclusion.batch, acts_root: inclusion.acts_root }),
  };
}

export type MeterFactResolution =
  | { readonly status: 'proven'; readonly proof: {
    readonly pe_id: string;
    readonly envelope_hash: string;
    readonly anchored: true;
    readonly anchor: Record<string, unknown>;
    readonly leaf: Record<string, unknown>;
    readonly merkle_proof: string[];
    readonly verification: Record<string, unknown>;
  } }
  | { readonly status: 'refused'; readonly http: number; readonly reason: string };

type ProvenMeterFact = Extract<MeterFactResolution, { status: 'proven' }>['proof'];

/** A presented PE proven against Base, whoever presents it. */
export type MeterFactInclusionResolution =
  | {
    readonly status: 'proven';
    readonly proof: ProvenMeterFact;
    /** The PE's owner: the actor its anchored batch leaf commits to. */
    readonly actorId: string;
    /** The proven PE (its hash re-derived, its act in an anchored batch). */
    readonly pe: PeV2;
  }
  | { readonly status: 'refused'; readonly http: number; readonly reason: string };

interface MeterFactInput {
  readonly claim: { readonly pe_id: string; readonly envelope_hash: string };
  readonly pe: unknown;
  readonly inclusion: unknown;
  readonly anchorContract: { verifyPE(batchId: string, leaf: string, proof: string[]): Promise<boolean> } | null;
}

/**
 * Prove one presented metered PE: identity, hop 1, ownership, hop 2 (on chain). Fail-closed:
 * every check that cannot run refuses.
 */
export async function proveMeterFact(input: MeterFactInput & { readonly presenterOwnerId: string }): Promise<MeterFactResolution> {
  const proven = await proveMeterFactCore(input, input.presenterOwnerId);
  return proven.status === 'proven' ? { status: 'proven', proof: proven.proof } : proven;
}

/**
 * Prove one presented metered PE WITHOUT asking who presents it: identity, hop 1, hop 2 (on chain).
 * Returns the PE and its owner (the actor its anchored batch leaf commits to), so a caller that
 * admits a non-owner presenter — a counterparty citing a PE as Court evidence — decides standing
 * from the proven PE itself. Fail-closed exactly like {@link proveMeterFact}.
 */
export async function proveMeterFactInclusion(input: MeterFactInput): Promise<MeterFactInclusionResolution> {
  return proveMeterFactCore(input, null);
}

async function proveMeterFactCore(
  input: MeterFactInput,
  presenterOwnerId: string | null,
): Promise<MeterFactInclusionResolution> {
  const pe = input.pe as PeV2 | null;
  if (pe === null || typeof pe !== 'object' || Array.isArray(pe) || pe.schema !== PE_V2_SCHEMA) {
    return { status: 'refused', http: 400, reason: 'pe_malformed' };
  }
  const inclusion = parseMeterFactInclusion(input.inclusion);
  if (inclusion === null) return { status: 'refused', http: 400, reason: 'inclusion_malformed' };
  if (pe.pe_id !== input.claim.pe_id) return { status: 'refused', http: 409, reason: 'pe_id_mismatch' };
  const peHash = peHashOf(pe);
  if (peHash !== input.claim.envelope_hash.toLowerCase()) return { status: 'refused', http: 409, reason: 'pe_hash_mismatch' };
  const act = actRecordOf(pe);
  const hop1 = verifyActRecordInclusion(act, inclusion);
  if (!hop1.ok) return { status: 'refused', http: 409, reason: hop1.reason };
  // The batch leaf commits to its actor, so a presenter can only present acts of its own batches.
  if (presenterOwnerId !== null && inclusion.batch.actor_id !== presenterOwnerId) {
    return { status: 'refused', http: 403, reason: 'pe_not_owned' };
  }
  if (input.anchorContract === null) return { status: 'refused', http: 503, reason: 'anchor_contract_unavailable' };
  const batchId = meterAnchorBatchId(inclusion.anchor.day, inclusion.anchor.segment);
  const leafValue = hashEnvelopeHashLeaf(hop1.batch_leaf);
  let anchored = false;
  try {
    anchored = await input.anchorContract.verifyPE(batchId, leafValue, [...inclusion.anchor.proof]);
  } catch {
    anchored = false;
  }
  if (!anchored) return { status: 'refused', http: 409, reason: 'pe_not_anchored' };
  const leaf: MeterFactLeaf = {
    kind: 'meter_act',
    leaf_value: leafValue,
    act,
    act_index: inclusion.act_index,
    act_proof: inclusion.act_proof,
    acts_root: inclusion.acts_root,
    batch: inclusion.batch,
    batch_leaf: hop1.batch_leaf,
  };
  return {
    status: 'proven',
    actorId: inclusion.batch.actor_id,
    pe,
    proof: {
      pe_id: pe.pe_id,
      envelope_hash: peHash,
      anchored: true,
      anchor: { kind: 'meter_day', batch_id: batchId, day: inclusion.anchor.day, ...(inclusion.anchor.segment !== undefined ? { segment: inclusion.anchor.segment } : {}), chain_id: 8453 },
      leaf: { ...leaf },
      merkle_proof: [...inclusion.anchor.proof],
      verification: {
        rule: 'provian.meter.fact.v1',
        hop1: 'sha256 act leaf of `leaf.act` is in `leaf.acts_root` by `leaf.act_proof`; batchLeafOf(batch, acts_root) == leaf.batch_leaf; leaf.act.pe_hash == envelope_hash',
        hop2: 'keccak256(0x00 || batch_leaf) == leaf.leaf_value; PEAnchor.verifyPE(anchor.batch_id, leaf_value, merkle_proof) on Base',
      },
    },
  };
}

/**
 * The counterparty's side (no relay records): check a `meter_act` leaf against its claim and
 * return the anchor leaf to verify on chain, or null when anything does not hold.
 */
export function checkMeterFactLeaf(envelopeHash: string, leafRaw: unknown): string | null {
  if (leafRaw === null || typeof leafRaw !== 'object') return null;
  const leaf = leafRaw as Partial<MeterFactLeaf>;
  if (leaf.kind !== 'meter_act' || !leaf.act || typeof leaf.leaf_value !== 'string'
    || typeof leaf.batch_leaf !== 'string' || typeof leaf.acts_root !== 'string'
    || !Array.isArray(leaf.act_proof) || !leaf.batch) {
    return null;
  }
  if (typeof leaf.act.pe_hash !== 'string' || leaf.act.pe_hash !== envelopeHash.toLowerCase()) return null;
  const hop1 = verifyActRecordInclusion(leaf.act, {
    act_proof: leaf.act_proof,
    acts_root: leaf.acts_root,
    batch: leaf.batch,
  });
  if (!hop1.ok || hop1.batch_leaf !== leaf.batch_leaf) return null;
  let expected: string;
  try {
    expected = hashEnvelopeHashLeaf(hop1.batch_leaf);
  } catch {
    return null;
  }
  return expected.toLowerCase() === leaf.leaf_value.toLowerCase() ? leaf.leaf_value : null;
}
