/**
 * WP-EV — the off-chain eligibility evaluator.
 *
 * The kernel hands its verifier nothing but an opaque settlement digest, so no eligibility
 * rule can run on-chain. This is where eligibility is actually decided; the on-chain
 * verifier only attests to the batch that came out of it.
 *
 * THE POLICY
 *
 * A PE is eligible when it is structurally valid, its hash chain is intact, its submission
 * provenance is one the relay can vouch for, it carries a real attestation tier, and there is
 * evidence the work happened.
 *
 * SUBMISSION PROVENANCE IS THREE-VALUED, NOT A BOOLEAN. An act the RELAY authored has no earner
 * signature to verify — not a missing one, none. See `submission-provenance.ts`; a boolean here
 * gated the entire Genesis lane out of settlement permanently and silently.
 *
 * ATTESTATION TIER AFFECTS WEIGHT, NEVER ELIGIBILITY. Attestation is a gradient, not a
 * gate: a software-attested PE with real work evidence is FULLY eligible and simply mints
 * at 0.8x, while a hardware-attested one mints at 2.5x. Absence of hardware attestation is
 * not ineligibility and is not evidence of a ghost PE.
 *
 * WORK-HAPPENED IS SEPARATE FROM TIER AND IS NEVER A PROXY FOR IT. A ghost PE is one with
 * nothing behind it — no work-product hash, no corroboration from a counterparty who should
 * have confirmed — regardless of how well-attested the device that signed it was. A
 * hardware-attested PE with nothing behind it is a ghost; a software-attested PE with an
 * artifact hash is not.
 *
 * COMPUTE QUANTITY IS OUT OF SCOPE. Nothing here measures or verifies how much compute a
 * PE claims. Quantity is self-reported by design; the economic defence (flat
 * per-action-type weights, occurrence-derived novelty pricing, mint-once claims, and the
 * on-chain epoch caps) is what handles gaming. (there is no per-user volume cap —
 * the former 50/day qualification bound is removed; the defence is pricing and evidence,
 * not a ceiling.)
 *
 * Pure: nothing here reads Firestore, signs, submits, or opens a connection. The caller
 * projects stored documents into `EligibilityCandidate` and this decides.
 */

import { ATTESTATION_MULTIPLIERS } from '../pe-weight-framework';
import { deriveClaimId, type SealedEnvelopeIdentity } from './claim-id';
import {
  isSettleableProvenance,
  type SubmissionProvenance,
} from './submission-provenance';

/**
 * Legacy tier spellings the relay still emits. `pe-weight-framework.normalizeAttestationTier`
 * maps these, and so must this module — but unlike that helper, an UNRECOGNIZED tier is
 * rejected here rather than silently priced as `software`. A tier nobody can account for is
 * a tier nobody validly assigned.
 */
const TIER_ALIASES: Readonly<Record<string, string>> = {
  hardware: 'hardware_full',
  hardware_tpm: 'hardware_partial',
  hardware_limited: 'hardware_partial',
};

/**
 * Tiers that exist in the multiplier table but that NO evidence path can validly assign
 * today. `compute_tee` awaits GPU TEE attestation; `full_stack` awaits simultaneous
 * four-layer attestation. Both are roadmap, deliberately unimplemented. Honouring a claim
 * to one now would mint 1.4x-2.0x on evidence nothing can check, so they fail closed.
 */
const RESERVED_TIERS: ReadonlySet<string> = new Set(['compute_tee', 'full_stack']);

/**
 * The PVT9 eligibility cut line, in ms.
 *
 * PVT9 is a fresh zero-supply kernel with NO ordinary historical-PE migration, so a PE
 * recorded before the cut line belongs to the legacy era and is not PVT9-issuable — a
 * legacy-era `mint_status='eligible'` PE is exactly the kind of record whose value, if any,
 * belonged to a legacy contract, and admitting it here would be issuance PVT9 never owed.
 *
 * This is the SAME instant as the cutover reconciliation cutover reconciliation cut line (the `starts_after_ms`
 * cursor bound, `wp11/cutover-cursors.ts:120`): eligible PVT9 work starts strictly AFTER it.
 * At the time this fence was added there were 16 pre-cut-line `eligible` PEs in production
 * (all recorded on or before 2026-07-08), and this fence excludes every one of them —
 * enumerated and tested in `eligibility.cutLineFence.test.ts`.
 *
 * NOTE : this is the established reconciliation cut line and is baked in so the
 * fence lives at the boundary, not at a call site. It MUST be ratified as THE canonical PVT9
 * cut line before the settlement runtime is activated (runtime activation is deferred past the
 * first-mint gate); until then the fence is merged but nothing settles.
 */
export const PVT9_ELIGIBILITY_CUT_LINE_MS = 1_784_938_132_043;

/** A counterparty named on the PE — someone who is in a position to confirm the work. */
export interface CounterpartyRef {
  readonly address: string;
  readonly type: string;
}

/**
 * Corroboration that carries mint weight.
 *
 * Feed this from the backend/on-chain `corroboration_status` ONLY. The separate
 * `client_corroboration_*` fields are deliberately mint-neutral — `CorroborationManager`
 * writes them without touching `corroboration_status` precisely so a party cannot
 * self-corroborate into a higher tier. Wiring them here would defeat that.
 */
export interface CorroborationRef {
  readonly received: boolean;
  readonly signalType?: string;
}

/** A complete replication pack. All three hashes are required; a partial pack is nothing. */
export interface ReplicationPackRef {
  readonly inputHash?: string | null;
  readonly outputHash?: string | null;
  readonly packHash?: string | null;
}

export interface WorkEvidence {
  /** `work_product.artifact_hash`, or any equivalent hash of the thing produced. */
  readonly workProductHash?: string | null;
  readonly replicationPack?: ReplicationPackRef | null;
  readonly counterparty?: CounterpartyRef | null;
  readonly counterpartyCorroboration?: CorroborationRef | null;
  /**
   * A settlement Provian's OWN WATCHER observed on-chain.
   *
   * Feed this only from a chain-verified observation. A self-reported settlement hash is
   * explicitly worth zero — it records provenance and mints nothing — so passing one here
   * would launder an unverified claim into the strongest evidence the evaluator recognizes,
   * including past the counterparty gate below.
   */
  readonly chainVerifiedTxHash?: string | null;
  /**
   * The RECORD-TIME evidence verdict, read from the sealed economic snapshot.
   *
   * Supplied ONLY from a snapshot that re-hashed to its own `economic_snapshot_hash` and is
   * bound to this very PE — the projection performs that verification through the single
   * verified-read (`policy/economic-projection.ts::verifiedSnapshot`), so a tampered or
   * transplanted snapshot arrives here as null, never as a verdict.
   *
   * THE SEAL IS AUTHORITATIVE (2026-08-16 seam ruling). Under / the body-binding
   * IS the evidence: a trusted server verifier — device body-binding, forge webhook HMAC,
   * the chain watcher, the sovereign key-binding — stamps `evidenceState: 'verified'` at
   * record time, and the armed action policy stamps `'not_required'` where it requires no
   * evidence at all (e.g. `wallet_created`, whose off-chain anchor `device_pe_rate_limits`
   * already enforced). Corroboration is a LIFT, never a gate, and nothing the record path
   * seals eligible records-but-can-never-settle by design. This module re-litigating that
   * verdict against its own evidence taxonomy was the defect that refused every
   * family, solo coding_session, and solo `service:*` forge row as
   * `ghost_pe_no_work_evidence` while `pe_history` said eligible+verified.
   *
   * DELIBERATELY CARRIES NO DISPOSITION. The disposition axis is already owned by the
   * `relayMintStatus === 'eligible'` allowlist gate above, and the CURRENT status is the
   * authority there: a `pending_cache`-recovered row (pitfall #45's one reclassifiable
   * bucket) lawfully reads `mint_status: 'eligible'` while its immutable sealed snapshot
   * still says the record-time `pending_cache` conditioning the seal on the sealed
   * disposition would strand that whole class as records-that-can-never-settle. No lawful
   * transition produces `mint_status: 'eligible'` on a `record_only` seal, and the
   * unlawful ones are pitfall #44's problem, not this field's.
   */
  readonly recordTimeSeal?: {
    readonly evidenceState: string;
  } | null;
  /**
   * A typed one-time anchor for acts whose evidence IS the act — Genesis grants and
   * device-anchored setup PEs. These produce no artifact and have no counterparty, so the
   * anchor is what witnesses that the act occurred.
   *
   * Where the uniqueness is actually enforced differs by lane, and the caller must only
   * supply an anchor that HAS been enforced:
   *   - Genesis lane: on-chain. `_validateGenesisInputs` rejects a zero anchor and the
   *     `genesisAnchorUsed[genesisAnchorKey(grantType, oneTimeAnchor)]` registry rejects a
   *     reused one.
   *   - Standard lane (`wallet_created`, `device_register`, ...): OFF-CHAIN ONLY, by
   *     `device_pe_rate_limits`. `settleStandardPEBatch` has no anchor concept at all and
   *     dedupes on `claimId` alone.
   *
   * This module is pure and cannot check either. It treats the field as an assertion by the
   * caller that the relevant enforcement already ran.
   */
  readonly oneTimeAnchor?: string | null;
}

/**
 * The ONE relay `mint_status` that may proceed to evaluation.
 *
 * This is an allowlist, and deliberately so. `mint_status` has seventeen members
 * (`src/pe-history.ts`), and the dangerous ones are not the obvious ones: `minted` and
 * `minting` mean the PE has ALREADY been paid, and PVT9 is a fresh zero-supply kernel with
 * no historical-PE migration, so its `claimSettled` registry holds no record of a legacy
 * mint and cannot catch the second one. A deny-list would have to enumerate every such
 * state correctly forever; an allowlist only has to be right about the one state that is
 * safe. Unknown = block, which is how every other input to this module already behaves.
 *
 * Note this is a gate, not a verdict: the relay saying `eligible` means "ready to be
 * considered". Whether the PE actually mints is what the policy below decides.
 */
const RELAY_STATUS_READY = 'eligible';

/** Already paid. Settling one of these again is a double mint the kernel cannot detect. */
const RELAY_STATUS_ALREADY_MINTED: ReadonlySet<string> = new Set(['minted', 'minting']);

/**
 * Compliance-terminal. Sanctions, a real per-device rate limit, and a blocked jurisdiction
 * all land here, and no mechanism may transition one back out.
 */
const RELAY_STATUS_TERMINAL = 'ineligible';

/**
 * Action types that are records by protocol and mint zero, whatever else they carry.
 * A badge projection with a work-product hash is still a badge projection.
 */
const ZERO_MINT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'badge_earned',
  'pvt_badge_projection_completed',
]);

export interface EligibilityCandidate {
  readonly pe: SealedEnvelopeIdentity;
  /** As recorded on the sealed PE (`attestation_type`). */
  readonly attestationTier: string;
  /** The PE's `prev_hash` link re-derived and confirmed against the chain. */
  readonly chainVerified: boolean;
  /**
   * How the act reached the relay. See `submission-provenance.ts`.
   *
   * REPLACED a `signatureVerified: boolean`, which could not tell "no signature was verified"
   * apart from "no signature exists to verify". That conflation gated every server-authored act
   * the whole Genesis lane — out of settlement permanently and silently.
   */
  readonly submissionProvenance: SubmissionProvenance;
  readonly workEvidence: WorkEvidence;
  /**
   * The relay's `mint_status` for this PE, verbatim from the stored record.
   *
   * REQUIRED and matched exactly — there is no "unknown" value and no normalization. A
   * status this module does not recognize is a status it cannot vouch for, and an absent
   * one would be a caller bug that must not resolve to "fine to mint". Exact matching is
   * the strict direction on purpose: a formatting artifact costs a PE a cycle, which is
   * visible and recoverable, whereas admitting an unrecognized status could pay twice.
   */
  readonly relayMintStatus: string;
}

export type WorkEvidenceKind =
  | 'work_product_hash'
  | 'replication_pack'
  | 'counterparty_corroboration'
  | 'chain_verified_settlement'
  | 'one_time_anchor'
  | 'record_time_seal';

export type EligibilityRejection =
  | 'terminally_ineligible'
  | 'already_minted'
  | 'pre_cut_line'
  | 'relay_status_not_ready'
  | 'zero_mint_action_type'
  | 'identity_underivable'
  | 'chain_not_verified'
  | 'signature_not_verified'
  /**
   * A verified signature is CLAIMED on an act that structurally has no signer. Refused rather
   * than downgraded: a false attestation must cost the mint, never earn one.
   */
  | 'provenance_contradictory'
  | 'unknown_attestation_tier'
  | 'reserved_attestation_tier'
  | 'ghost_pe_no_work_evidence'
  | 'ghost_pe_counterparty_uncorroborated';

export type EligibilityVerdict =
  | {
      readonly kind: 'eligible';
      readonly claimId: string;
      /** The canonical tier, aliases resolved. */
      readonly attestationTier: string;
      /** What the tier is worth. Weight, not a gate. */
      readonly weightMultiplier: number;
      readonly evidence: readonly WorkEvidenceKind[];
    }
  | { readonly kind: 'ineligible'; readonly reasons: readonly EligibilityRejection[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isCompletePack(pack: ReplicationPackRef | null | undefined): boolean {
  return (
    pack !== null
    && pack !== undefined
    && isNonEmptyString(pack.inputHash)
    && isNonEmptyString(pack.outputHash)
    && isNonEmptyString(pack.packHash)
  );
}

/** Resolve a recorded tier to its canonical name, or null if nothing accounts for it. */
export function resolveAttestationTier(recorded: unknown): string | null {
  if (typeof recorded !== 'string') return null;
  const canonical = TIER_ALIASES[recorded] ?? recorded;
  return ATTESTATION_MULTIPLIERS[canonical] === undefined ? null : canonical;
}

/**
 * Collect every kind of work evidence the PE actually carries.
 *
 * Exported because "what did this PE prove" is worth reading on its own, and because it
 * makes the ghost rule below testable independent of the rest of the policy.
 */
export function collectWorkEvidence(evidence: WorkEvidence): readonly WorkEvidenceKind[] {
  const found: WorkEvidenceKind[] = [];
  if (isNonEmptyString(evidence?.workProductHash)) found.push('work_product_hash');
  if (isCompletePack(evidence?.replicationPack)) found.push('replication_pack');
  if (evidence?.counterpartyCorroboration?.received === true) found.push('counterparty_corroboration');
  if (isNonEmptyString(evidence?.chainVerifiedTxHash)) found.push('chain_verified_settlement');
  if (isNonEmptyString(evidence?.oneTimeAnchor)) found.push('one_time_anchor');
  // The record path's own verdict, from the hash-verified sealed snapshot (see the field's
  // note). Counts ONLY when the seal says the evidence question was ANSWERED at record time:
  // `verified` (a trusted server verifier witnessed the act) or `not_required` (the armed
  // action policy demands none). A `pending`, `rejected`, or `unverifiable` seal
  // contributes nothing — those rows were never sealed evidence-sufficient, so the
  // taxonomy above remains their only way in. The disposition axis lives in the
  // relay-status gate, never here (see the field's note).
  const seal = evidence?.recordTimeSeal;
  if (
    seal !== null
    && seal !== undefined
    && (seal.evidenceState === 'verified' || seal.evidenceState === 'not_required')
  ) {
    found.push('record_time_seal');
  }
  return found;
}

/**
 * Decide whether a PE is eligible to be settled.
 *
 * Reports ALL failing reasons rather than the first, so one pass shows the whole picture.
 */
export function evaluateEligibility(candidate: EligibilityCandidate): EligibilityVerdict {
  const reasons: EligibilityRejection[] = [];

  // The relay's own status outranks everything below it, and anything it does not
  // explicitly clear is refused. The two most consequential cases get their own reason so
  // an operator reading a rejection can tell a compliance block from a double-mint block.
  const relayStatus = candidate?.relayMintStatus;
  if (relayStatus !== RELAY_STATUS_READY) {
    if (relayStatus === RELAY_STATUS_TERMINAL) reasons.push('terminally_ineligible');
    else if (RELAY_STATUS_ALREADY_MINTED.has(relayStatus)) reasons.push('already_minted');
    else reasons.push('relay_status_not_ready');
  }

  // Cut-line fence: a PE recorded AT OR BEFORE the cut line is legacy-era and not
  // PVT9-issuable (PVT9 has no historical-PE migration). Fail CLOSED on a missing or
  // non-finite timestamp — a PE that cannot prove it is post-cut-line cannot be admitted
  // (Unknown = Block). This runs at the boundary so no call site can forget it.
  const peTimestamp = candidate?.pe?.timestamp;
  if (
    typeof peTimestamp !== 'number'
    || !Number.isFinite(peTimestamp)
    || peTimestamp <= PVT9_ELIGIBILITY_CUT_LINE_MS
  ) {
    reasons.push('pre_cut_line');
  }

  // Record-only by protocol, whatever evidence the PE happens to carry.
  if (ZERO_MINT_ACTION_TYPES.has(candidate?.pe?.action_type)) reasons.push('zero_mint_action_type');

  // Structural validity and hash-chain identity are the same question: a PE whose immutable
  // identity fields do not form a derivable claim id has no settleable identity.
  const identity = deriveClaimId(candidate?.pe ?? ({} as SealedEnvelopeIdentity));
  if (identity.kind !== 'derived') reasons.push('identity_underivable');

  if (candidate?.chainVerified !== true) reasons.push('chain_not_verified');
  // PRICED, NOT GATED. `server_authored` is fully eligible: attestation is a multiplier and the
  // tier already prices these acts. Only a genuinely unverified signature, or a CLAIMED one that
  // cannot exist, is refused.
  const provenance = candidate?.submissionProvenance;
  if (provenance === 'contradictory') {
    reasons.push('provenance_contradictory');
  } else if (provenance === undefined || !isSettleableProvenance(provenance)) {
    reasons.push('signature_not_verified');
  }

  const tier = resolveAttestationTier(candidate?.attestationTier);
  if (tier === null) {
    reasons.push('unknown_attestation_tier');
  } else if (RESERVED_TIERS.has(tier)) {
    reasons.push('reserved_attestation_tier');
  }

  const evidence = collectWorkEvidence(candidate?.workEvidence ?? {});
  const hasCounterparty = isNonEmptyString(candidate?.workEvidence?.counterparty?.address);

  if (hasCounterparty) {
    // Where a counterparty exists, THEY are the evidence. An artifact hash the submitter
    // chose cannot stand in for the other party never confirming — that is exactly the
    // shape a fabricated engagement takes. The record-time seal ALSO confirms here: it is
    // never submitter-chosen — only a trusted server verifier (or the armed action policy
    // itself) writes it, and the projection admits it only hash-verified and PE-bound — so
    // it is a different class of witness from the submitter's own artifact hash, and the
    // seam ruling makes it authoritative (a fabricated engagement seals `pending`, not
    // `verified`, and never reaches this branch with a seal).
    const confirmed = evidence.includes('counterparty_corroboration')
      || evidence.includes('chain_verified_settlement')
      || evidence.includes('record_time_seal');
    if (!confirmed) reasons.push('ghost_pe_counterparty_uncorroborated');
  } else if (evidence.length === 0) {
    reasons.push('ghost_pe_no_work_evidence');
  }

  if (reasons.length > 0 || identity.kind !== 'derived' || tier === null) {
    // The second and third clauses are unreachable once `reasons` is non-empty; they are
    // here so the compiler, not a reader, guarantees the eligible branch has both values.
    return { kind: 'ineligible', reasons };
  }

  return {
    kind: 'eligible',
    claimId: identity.claimId,
    attestationTier: tier,
    weightMultiplier: ATTESTATION_MULTIPLIERS[tier],
    evidence,
  };
}
