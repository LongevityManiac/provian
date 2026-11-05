/**
 * PE METER — building a PE v2 on the device.
 *
 * The device builds, hashes and chains each PE itself. The fields are the ones the v1 device
 * submit body carried, unchanged in meaning; `cited_pe_ids` is gone (retired in favour of
 * `input_origins`,). Identity (`schema`, `pe_id`, `device_id`, `prev_hash`, `timestamp`,
 * `action_type`) and free text (`description`) never reach the relay's pricing; everything else is
 * the act's pricing input (see `meter-wire.ts`).
 *
 * A hardware witness, when this host has one, signs `hardwareNonceOfAct(actRecordOf(pe))` over
 * the PE WITHOUT its witness slot — identity plus pricing inputs, bound to this exact position
 * in this device's chain. Its pe_hash is deliberately not part of the nonce: that hash covers the
 * witness itself.
 */

import { randomBytes } from 'crypto';
import {privateCommitmentOpening,sealPrivatePricing} from './private-pricing';
import type { HardwareWitnessProvider } from '../hardware-witness';
import {
  actRecordOf,
  canonicalJson,
  hardwareNonceOfAct,
  peHashOf,
  pricingOf,
  PE_V2_SCHEMA,
  type PeV2,
} from '../meter-wire';
import type { StoredPeV2 } from './pe-store';

/** The observed content of one PE (everything but its chain identity). */
export interface PeV2Content {
  readonly action_type: string;
  readonly description?: string;
  readonly metadata: Record<string, unknown>;
  readonly compute: unknown;
  readonly geo: unknown;
  readonly execution_env: unknown;
  readonly parent_goal_pe_id: unknown;
  readonly input_origins?: unknown;
  readonly output_digests?: unknown;
  readonly economic_session_lineage?: unknown;
}

/** A fresh, unique PE id (`pe_` + 24 hex). Never reused as a relay key (the relay keys on pe_hash). */
export function newPeId(): string {
  return `pe_${randomBytes(12).toString('hex')}`;
}

/**
 * The content of a legacy v1 device-submit body (a queued `pe-outbox` entry), or null when it is
 * not one. `cited_pe_ids` is dropped; everything else carries over.
 */
export function peContentFromV1Body(body: Record<string, unknown>): PeV2Content | null {
  if (typeof body.action_type !== 'string' || body.action_type.length === 0) return null;
  const metadata = body.metadata !== null && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
  return {
    action_type: body.action_type,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    metadata,
    compute: body.compute ?? null,
    geo: body.geo ?? null,
    execution_env: body.execution_env ?? null,
    parent_goal_pe_id: body.parent_goal_pe_id ?? null,
    ...(body.input_origins !== undefined && body.input_origins !== null ? { input_origins: body.input_origins } : {}),
    ...(body.output_digests !== undefined && body.output_digests !== null ? { output_digests: body.output_digests } : {}),
    ...(body.economic_session_lineage !== undefined ? { economic_session_lineage: body.economic_session_lineage } : {}),
  };
}

/**
 * Build one complete PE v2 at a given chain position. Throws on content that cannot be hashed
 * canonically (a non-finite number): such a PE could never be proven, so it is never recorded.
 */
export async function buildPeV2(input: {
  readonly content: PeV2Content;
  readonly deviceId: string;
  readonly prevHash: string;
  readonly timestampMs: number;
  readonly peId: string;
  readonly hardwareWitness?: HardwareWitnessProvider;
  readonly privacySecret?: string;
}): Promise<StoredPeV2> {
  const c = input.content;
  const draft: Record<string, unknown> = {
    schema: PE_V2_SCHEMA,
    pe_id: input.peId,
    device_id: input.deviceId,
    prev_hash: input.prevHash,
    timestamp: input.timestampMs,
    action_type: c.action_type,
    ...(c.description !== undefined ? { description: c.description } : {}),
    metadata: c.metadata,
    compute: c.compute ?? null,
    geo: c.geo ?? null,
    execution_env: c.execution_env ?? null,
    parent_goal_pe_id: c.parent_goal_pe_id ?? null,
    ...(c.input_origins !== undefined ? { input_origins: c.input_origins } : {}),
    ...(c.output_digests !== undefined ? { output_digests: c.output_digests } : {}),
    ...(c.economic_session_lineage !== undefined ? { economic_session_lineage: c.economic_session_lineage } : {}),
  };
  // Refuse what canonical JSON refuses, THEN normalise to plain JSON: the PE that is hashed is
  // byte-for-byte the PE that is stored and later re-read.
  canonicalJson(draft);
  if(input.privacySecret) {
    const ownerView=pricingOf(draft as PeV2);
    draft.private_commitment=privateCommitmentOpening(input.privacySecret,input.peId);
    draft.private_pricing=sealPrivatePricing(ownerView,String(draft.private_commitment),input.peId);
  }
  const base = JSON.parse(JSON.stringify(draft)) as PeV2;
  let pe: PeV2 = base;
  if (input.hardwareWitness) {
    try {
      const slot = await input.hardwareWitness(hardwareNonceOfAct(actRecordOf(base)));
      if (slot) pe = JSON.parse(JSON.stringify({ ...base, hardware_witness: slot })) as PeV2;
    } catch {
      // A producer never blocks or fails a record: no slot, ordinary class.
    }
  }
  return { ...pe, pe_hash: peHashOf(pe) };
}
