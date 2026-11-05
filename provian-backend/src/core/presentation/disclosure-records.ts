/**
 * Requester-named disclosure — the RELAY'S derivation of a disclosed record from a presented PE
 * (2026-10-10). The presenter hands over the PE and its two-hop proof; `proveMeterFact` has already
 * proven identity, ownership and anchoring. This module derives, from the complete PE the relay
 * verified against its hash:
 *
 *   - the METADATA FLOOR: pe id, hash, action type, time, and the witness facts the relay verifies
 *     NOW — a hardware report re-admitted against the act's own nonce and the scheme's pinned root
 *     (issuer = the root fingerprint reached, signer = sha256(SPKI) of the report key), a chain
 *     witness (the verified transaction), else the recording device (signer = its device id);
 *   - the requested FIELDS, read at their dotted paths off the act's pricing projection — the very
 *     bytes the anchored act record covers, so a verifier re-checks each value against the proof;
 *   - the elected CONTENT: description / intent (free text the hash covers but the pricing does
 *     not), artifacts (the output digests), fact_tier (the whole anchored act record).
 *
 * The relay stores none of it: the record exists only inside the presentation it is issued in.
 */

import { admitHardwareWitness } from '../hardware/admit';
import type { HardwareVerifyContext } from '../hardware/types';
import { hardwareMeasurementOf } from '../hardware/measurement';
import { actRecordOf, hardwareNonceOfAct, type ActRecord, type PeV2 } from '../meter/meter-wire';
import {
  canonicalJson,
  readFieldPath,
  recordMatchesRequest,
  DISCLOSURE_RECORD_MAX_BYTES,
  type CanonicalDisclosureRequest,
  type DisclosedRecord,
  type DisclosedWitness,
} from './disclosure-request';

const HEX64_RE = /^[0-9a-f]{64}$/;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function digestOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '');
  return HEX64_RE.test(d) ? d : null;
}

/** The output digests a PE carries (`output_digests[].hash`, normalized), from its pricing projection. */
export function outputDigestsOf(pricing: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const list = pricing.output_digests;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    const d = digestOf(obj(e)?.hash);
    if (d !== null && !out.includes(d)) out.push(d);
  }
  return out;
}

/** A chain-witnessed record's transaction hash, from the relay-stamped verified metadata only. */
function chainRef(pricing: Readonly<Record<string, unknown>>): string | null {
  const md = obj(pricing.metadata);
  if (!md || md.verified !== true) return null;
  const ev = obj(md.economic_evidence);
  for (const c of [md.tx_hash, md.txHash, ev?.txHash, ev?.tx_hash]) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]{64}$/.test(c)) return c.toLowerCase();
  }
  return null;
}

/**
 * The witness facts of a presented PE, verified at issuance. A hardware report is re-admitted
 * against the act's nonce and the scheme's pinned root as of the ACT'S time (the attestation was
 * current when it was sealed; a certificate that has since expired does not un-witness the act). A
 * report that does not admit yields no issuer — the record then carries only the device witness.
 */
export async function disclosedWitnessOf(
  pe: PeV2,
  act: ActRecord,
  batchDeviceId: string,
  hardware: Pick<HardwareVerifyContext, 'rootsOverride' | 'fetch'> = {},
): Promise<DisclosedWitness> {
  const pricing = act.pricing;
  if (pricing.hardware_witness !== undefined) {
    const adm = await admitHardwareWitness(pricing.hardware_witness, {
      bindingNonce: Buffer.from(hardwareNonceOfAct(act), 'hex'),
      actorKeyFingerprints: new Set<string>(),
      nowMs: typeof pe.timestamp === 'number' ? pe.timestamp : Date.now(),
      appleAppId: process.env.APPLE_APP_ATTEST_APP_ID ?? null,
      ...hardware,
    });
    const f = adm.verdict?.fields;
    if (adm.admitted && adm.verdict?.scheme && f) {
      const measurement = hardwareMeasurementOf({ ...f, scheme: adm.verdict.scheme });
      return {
        kind: 'hardware',
        scheme: adm.verdict.scheme,
        ...(f.issuer_root_fingerprint ? { issuer: f.issuer_root_fingerprint.toLowerCase() } : {}),
        signer: f.signer_key_sha256.toLowerCase(),
        ...(measurement ? { measurement } : {}),
        ...(f.region ? { region: f.region } : {}),
      };
    }
  }
  const ref = chainRef(pricing);
  if (ref !== null) return { kind: 'chain', issuer: 'chain:base', ref };
  return { kind: 'device', signer: batchDeviceId };
}

export type BuildDisclosedRecordResult =
  | { ok: true; record: DisclosedRecord }
  | { ok: false; reason: 'disclosure_record_mismatch' | 'disclosure_record_too_large' | 'disclosure_fields_private' };

/**
 * Build the disclosed record of a PROVEN PE for one request. Refuses a record that does not satisfy
 * the request (the presenter must put forward only matching records: its proof of possession
 * commits to the record identities, so the relay never silently drops one).
 */
export async function buildDisclosedRecord(input: {
  readonly pe: PeV2;
  readonly peHash: string;
  readonly batchDeviceId: string;
  readonly request: CanonicalDisclosureRequest;
  /** TEST SEAM ONLY: the hardware verifier's root override / key fetch (production lanes never set it). */
  readonly hardware?: Pick<HardwareVerifyContext, 'rootsOverride' | 'fetch'>;
}): Promise<BuildDisclosedRecordResult> {
  const { pe, request } = input;
  const act = actRecordOf(pe);
  const pricing = act.pricing;
  const witness = await disclosedWitnessOf(pe, act, input.batchDeviceId, input.hardware ?? {});
  const floor: DisclosedRecord = {
    pe_id: pe.pe_id,
    pe_hash: input.peHash.toLowerCase(),
    action_type: act.action_type,
    timestamp: act.timestamp,
    witness,
  };
  let record: DisclosedRecord = floor;
  if (request.kind === 'pe') {
    const carried = outputDigestsOf(pricing);
    const named = request.output_digest;
    if (!carried.includes(named) && named !== floor.pe_hash) return { ok: false, reason: 'disclosure_record_mismatch' };
    record = { ...record, output_digest: named };
  }
  if (!recordMatchesRequest(record, request)) return { ok: false, reason: 'disclosure_record_mismatch' };

  if (request.fields !== undefined && request.fields.length > 0) {
    // A privately-priced PE carries only commitments; its fields are not readable here.
    if (pricing.private_pricing !== undefined) return { ok: false, reason: 'disclosure_fields_private' };
    const fields: Record<string, unknown> = {};
    for (const path of request.fields) fields[path] = readFieldPath(pricing, path);
    record = { ...record, fields };
  }
  if (request.content !== undefined && request.content.length > 0) {
    const content: Record<string, unknown> = {};
    for (const c of request.content) {
      if (c === 'description') content.description = typeof pe.description === 'string' ? pe.description : null;
      else if (c === 'intent') content.intent = typeof pe.intent_text === 'string' ? pe.intent_text : null;
      else if (c === 'artifacts') content.artifacts = Array.isArray(pricing.output_digests) ? [...pricing.output_digests] : [];
      else if (c === 'fact_tier') content.fact_tier = { ...act };
    }
    record = { ...record, content: content as DisclosedRecord['content'] };
  }
  try {
    if (canonicalJson(record).length > DISCLOSURE_RECORD_MAX_BYTES) return { ok: false, reason: 'disclosure_record_too_large' };
  } catch {
    return { ok: false, reason: 'disclosure_record_too_large' };
  }
  return { ok: true, record };
}
