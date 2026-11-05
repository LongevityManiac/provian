/**
 * evidence-class — the six WITNESS CLASSES every PE is admitted under (Trust Layer build, the operator
 * 2026-09-16 §2.8/§2.9). A PE's class is WHO vouched for it, declared by the EMITTER at record time
 * (never by the body), and it is what class-based earning admission prices from:
 *
 * hardware_rooted — an App Attest report verified against Apple's public root, nonce-bound to
 * THIS PE, signed by a key that is not the actor's.
 * chain_witnessed — the relay re-read the canonical event from Base (a watcher, or a route that
 * re-checks a tx on-chain before recording).
 * forge_witnessed — an HMAC-verified forge webhook (GitHub / GitLab / Bitbucket).
 * relay_verified — the relay's own verified institution / genesis logic stamped the row after
 * an on-chain-gated check it performed itself.
 * device_tier — a registered device, or the verified key of a TPM/cloud-attested machine,
 * cryptographically bound this exact body (SE signature or
 * body-HMAC on `/v1/pe/submit`; the request-bound wallet auth on the phone).
 * actor_declared — everything else: the actor's own key/session is the only voucher (sovereign
 * self-report, a bare wallet-auth relay/action, a bearer device with no body
 * binding). Fail-closed default.
 *
 * The class is sealed INFORMATIONALLY on the economic snapshot (`recordTimeFactors.witnessClass`)
 * and mirrored top-level on `pe_history.witness_class` / `provenance_envelopes.witness_class`
 * (relay-assigned, UNHASHED — never part of a PE preimage). §2.8 prices from it through the signed
 * template's `evidenceClassBasesBps`; §2.5's Work vocabulary splits counts by it.
 */

export const WITNESS_CLASSES = [
  'hardware_rooted',
  'chain_witnessed',
  'forge_witnessed',
  'relay_verified',
  'device_tier',
  'actor_declared',
] as const;
export type WitnessClass = (typeof WITNESS_CLASSES)[number];

const WITNESS_CLASS_SET: ReadonlySet<string> = new Set(WITNESS_CLASSES);

export function isWitnessClass(value: unknown): value is WitnessClass {
  return typeof value === 'string' && WITNESS_CLASS_SET.has(value);
}

/** Normalize an untrusted value to a class — anything unrecognized is `actor_declared` (Unknown = Block). */
export function normalizeWitnessClass(value: unknown): WitnessClass {
  return isWitnessClass(value) ? value : 'actor_declared';
}

/** Every class a NON-actor key vouched for — the classes whose admission stamps evidence. */
export const WITNESSED_CLASSES: ReadonlySet<WitnessClass> = new Set<WitnessClass>([
  'hardware_rooted', 'chain_witnessed', 'forge_witnessed', 'relay_verified', 'device_tier',
]);

/**
 * §2.8 CLASS-BASED EARNING ADMISSION — the six class BASES (bps of one base point), pinned in the
 * signed monetary template (`evidenceClassBasesBps`) and the signed matrix. A never-seen action
 * type earns at its witness class's base on FIRST submission; a named matrix row is an OVERRIDE.
 * The five existing bases are DERIVED from the existing rows so every named row prices
 * byte-identically: chain_witnessed = the `base_final_chain_receipt` family (20000);
 * forge_witnessed = the `verified_external_service_witness` family (30000); relay_verified = the
 * `verified_institution_lifecycle` family (10000); device_tier = the `verified_compute_or_work`
 * family (10000); actor_declared = 0 (a bare self-report records, never mints — the existing
 * `pending_policy`/record_only outcome). hardware_rooted = 40000 (the operator: 4.0×).
 */
export const PROPOSED_EVIDENCE_CLASS_BASES_BPS: Readonly<Record<WitnessClass, number>> = Object.freeze({
  hardware_rooted: 40_000,
  chain_witnessed: 20_000,
  forge_witnessed: 30_000,
  relay_verified: 10_000,
  device_tier: 10_000,
  actor_declared: 0,
});

/** How a class-admitted (unnamed) action prices — mirrors the named family each base was derived from. */
export interface ClassAdmissionProfile {
  readonly category: 'financial' | 'compute' | 'institutional' | 'uncategorized';
  readonly attestationPricing: 'standard' | 'external_proof_priced';
  /** Attestation depth does not scale a chain/relay-witnessed act (mirrors the neutral families). */
  readonly financialAttestationNeutral: boolean;
}

export function classAdmissionProfile(witnessClass: WitnessClass): ClassAdmissionProfile {
  switch (witnessClass) {
    case 'hardware_rooted':
      // The hardware report is costly-to-forge external proof: the evidence-priced table at the
      // hardware_full tier (1.0×) on the 40000 base → exactly 4.0×.
      return { category: 'compute', attestationPricing: 'external_proof_priced', financialAttestationNeutral: false };
    case 'chain_witnessed':
      return { category: 'financial', attestationPricing: 'standard', financialAttestationNeutral: true };
    case 'forge_witnessed':
      return { category: 'compute', attestationPricing: 'standard', financialAttestationNeutral: false };
    case 'relay_verified':
      return { category: 'institutional', attestationPricing: 'standard', financialAttestationNeutral: true };
    case 'device_tier':
      return { category: 'compute', attestationPricing: 'standard', financialAttestationNeutral: false };
    case 'actor_declared':
      return { category: 'uncategorized', attestationPricing: 'standard', financialAttestationNeutral: false };
  }
}

/** The strict order of classes, strongest first — used only for display/ranking, never pricing. */
export const WITNESS_CLASS_RANK: Readonly<Record<WitnessClass, number>> = Object.freeze({
  hardware_rooted: 5,
  chain_witnessed: 4,
  forge_witnessed: 3,
  relay_verified: 2,
  device_tier: 1,
  actor_declared: 0,
});

/** machine hardware tiers are facts; only an App Attest class prices as hardware. */
export function ordinaryHardwareAttestationTier(tier:string):string {
 return ['hardware','hardware_tpm','hardware_partial','hardware_full','compute_tee','full_stack'].includes(tier)?'software':tier;
}
