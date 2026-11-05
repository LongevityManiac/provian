/**
 * WP-C — the eligibility-verifier approval gate in front of settlement.
 *
 * `ProvianPVT9` calls `_verifyEligibility` on every settle, which reads
 * `verifyStandardBatch` / `verifyGenesisBatch` on `ProvianPVT9EligibilityVerifier`. Those
 * return true only for a digest the verifier's `batchApprover` has affirmed. Nothing in the
 * settlement runtime settlement runner ever touched the verifier, so an armed system would have signed,
 * broadcast, and paid gas for settlements that revert on arrival.
 *
 * This module is that missing step, and it is deliberately more than a relay:
 *
 * - It APPROVES ONLY WHAT WILL BE BROADCAST. The recipients and claims are decoded back out
 * of `batch.calldata` the exact bytes the runner signs — not re-derived from a parallel
 * in-memory copy that could have drifted. The decoded header is then cross-checked against
 * the durable batch doc, so a doc/calldata disagreement refuses instead of approving one
 * and settling the other.
 *
 * - It RUNS THE ELIGIBILITY CRITERIA. Every PE in the batch is put through
 * `evaluateEligibility` from `../wp-ev/eligibility`, and the claim id that evaluation
 * DERIVES must equal the claim id the batch is settling. An approver that affirms whatever
 * it is handed makes the on-chain verifier decorative; this one can refuse its own batch.
 *
 * - It FAILS CLOSED, everywhere. Missing adapter, missing candidate, ineligible PE, decode
 * failure, digest disagreement, a throw from any adapter call, or an approval the verifier
 * does not subsequently affirm — every one of them returns `refused`. There is no path
 * through this module that returns `approved` without the verifier having affirmed the
 * digest, and the caller must not broadcast on anything but `approved`.
 *
 * The digest is NOT reimplemented here. `hashStandardClaims`, `hashGenesisClaims`, and
 * `computeSettlementDigest` come from `../wp-ev/settlement-batch`, whose preimages are pinned
 * to Solidity by the shared fixed vector that `settlement-batch.test.ts` and
 * `ProvianPVT9EligibilityVerifier.t.sol::test_crossLanguageDigestVector` both assert. A drift
 * on either side fails a test rather than a mint.
 *
 * Approval is idempotent per digest: an already-affirmed digest is reported approved without
 * a second on-chain call, which is what makes crash-resume and replacement transactions
 * cheap and safe — the digest binds the batch, not the attempt.
 *
 * This module signs and submits NOTHING itself. The adapter is injected, and in the current
 * tree no production caller constructs one: PVT9 and its verifier are undeployed.
 */

import type { PayoutLegRole } from '../wp-ev/payout-legs';
import { Interface } from 'ethers';

import { evaluateEligibility, type EligibilityCandidate } from '../wp-ev/eligibility';
import { deriveLegClaimId, deriveTopupClaimId } from '../wp-ev/claim-id';
import {
  BeneficiaryClass,
  SettlementLane,
  computeSettlementDigest,
  hashGenesisClaims,
  hashStandardClaims,
  type BatchHeader,
  type GenesisPEClaim,
  type GenesisRecipient,
  type StandardPEClaim,
  type StandardRecipient,
} from '../wp-ev/settlement-batch';
import { KERNEL_SETTLEMENT_ABI } from './settlement-cycle-runner';
import type { SettlementBatchDoc } from './durable-settlement-store';

/**
 * Built lazily on first decode, NOT at module scope. `settlement-cycle-runner` imports this
 * module for the gate and this module imports its ABI, so the two form a cycle; at module
 * evaluation time the ABI binding is still undefined. Deferring construction to first use is
 * what keeps the ABI a single source of truth instead of a second copy that could drift from
 * the calldata the runner actually encodes.
 */
let kernelInterfaceCache: Interface | null = null;
function kernelAbiInterface(): Interface {
  if (kernelInterfaceCache === null) {
    kernelInterfaceCache = new Interface(KERNEL_SETTLEMENT_ABI as unknown as string[]);
  }
  return kernelInterfaceCache;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type ApprovalRefusal =
  | 'approver_unavailable'
  | 'calldata_undecodable'
  | 'lane_mismatch'
  | 'header_mismatch'
  | 'member_set_mismatch'
  | 'candidate_missing'
  | 'candidate_ineligible'
  | 'claim_id_mismatch'
  | 'digest_disagreement'
  | 'approval_call_failed'
  | 'approval_not_affirmed';

export interface IneligibleClaim {
  readonly peId: string;
  readonly claimId: string;
  readonly reasons: readonly string[];
}

export type ApprovalOutcome =
  | {
      readonly kind: 'approved';
      readonly settlementDigest: string;
      readonly lane: SettlementLane;
      /** True when the digest was already affirmed and no new call was made. */
      readonly alreadyAffirmed: boolean;
      readonly claimsEvaluated: number;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ApprovalRefusal;
      readonly detail: string;
      /** Populated for `candidate_ineligible` so an operator sees WHY, per claim. */
      readonly ineligible?: readonly IneligibleClaim[];
    };

// ---------------------------------------------------------------------------
// Injected surfaces
// ---------------------------------------------------------------------------

export interface StandardApprovalCall {
  readonly header: BatchHeader;
  readonly recipients: readonly StandardRecipient[];
  readonly claims: readonly StandardPEClaim[];
}

export interface GenesisApprovalCall {
  readonly header: BatchHeader;
  readonly recipients: readonly GenesisRecipient[];
  readonly claims: readonly GenesisPEClaim[];
}

/**
 * The verifier, as this module needs it. Implementations hold the approver key; this module
 * never sees one.
 */
export interface BatchApproverAdapter {
  /** `address(this)` of the kernel — half of what binds a digest to one deployment. */
  readonly kernelAddress: string;
  /** `block.chainid` of that deployment — the other half. */
  readonly chainId: bigint;
  /** `verifyStandardBatch` / `verifyGenesisBatch`, by lane. */
  isAffirmed(settlementDigest: string, lane: SettlementLane): Promise<boolean>;
  /**
   * The kernel's per-claim `claimSettled(bytes32)` view — the ON-CHAIN authority on whether ONE
   * leg has already been paid, used by the leg-aware `already_minted` relaxation below.
   *
   * Optional so a legacy adapter still satisfies the type; when absent, the gate keeps the
   * strict PE-level `already_minted` refusal (fail-closed). A split act has two claim-ledger
   * legs under one PE, and `claimSettled` is keyed per claim ITEM (contract line 186), so it
   * distinguishes a paid leg from its unpaid sibling where the PE-level `mint_status` cannot.
   */
  isClaimSettled?(claimId: string): Promise<boolean>;
  /** `approveStandardBatch`; returns the digest the VERIFIER derived. */
  approveStandardBatch(call: StandardApprovalCall): Promise<string>;
  /** `approveGenesisBatch`; returns the digest the VERIFIER derived. */
  approveGenesisBatch(call: GenesisApprovalCall): Promise<string>;
}

/**
 * Where the approver reads the PEs it must judge.
 *
 * Returning a partial map is not an error here — a missing candidate is refused by the gate
 * as `candidate_missing`, because "I could not find the PE" and "the PE is fine" must never
 * collapse into the same answer.
 */
export interface EligibilityCandidateSource {
  loadCandidates(peIds: readonly string[]): Promise<ReadonlyMap<string, EligibilityCandidate>>;
}

/**
 * PE METER. A meter claim has no envelope at the relay: the approver judges it
 * from its pending claim instead (`core/meter/meter-settlement.ts` `verifyMeterClaimMembers` * integrity, state, leg, a claim id that re-derives from the claim's own identity, no demoted act).
 */
export interface MeterClaimVerifier {
  isMeterClaim(peId: string): boolean;
  verify(members: readonly { readonly pe_id: string; readonly leg: PayoutLegRole; readonly claim_id: string }[]): Promise<ReadonlyMap<string,
    | { readonly ok: true; readonly contributor: string; readonly beneficiaryClass: number; readonly recordPointsAtomic: string }
    | { readonly ok: false; readonly reason: string }>>;
}

export interface BatchApprovalDeps {
  readonly approver?: BatchApproverAdapter;
  readonly candidates?: EligibilityCandidateSource;
  /** Absent: a meter member has no candidate and is refused `candidate_missing` (fail closed). */
  readonly meterClaims?: MeterClaimVerifier;
  readonly log?: (message: string) => void;
  /**
   * Sleep between affirmation-confirmation retries. Injectable for tests (fake timers);
   * defaults to a real timer in production.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Bounded retry for the post-approve affirmation confirmation (step 8). The confirmation
   * READ can race the approve WRITE on a load-balanced RPC (read-after-write: an `eth_call`
   * at 'latest' lands on a backend still one block behind the just-mined approve, where the
   * approval genuinely reads false). Because the approve receipt already proved the write
   * committed, a single stale read must not be a permanent refusal. Defaults to 5 attempts
   * over ~4s. Changes no approval DECISION — it only lets the read observe a committed write.
   */
  readonly affirmConfirm?: { readonly attempts: number; readonly delayMs: number };
}

/** Post-approve affirmation-confirmation retry defaults; see `BatchApprovalDeps.affirmConfirm`. */
const DEFAULT_AFFIRM_CONFIRM_ATTEMPTS = 5;
const DEFAULT_AFFIRM_CONFIRM_DELAY_MS = 1_000;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Decode: recover exactly what the kernel will receive
// ---------------------------------------------------------------------------

type DecodedBatch =
  | { readonly kind: 'standard'; readonly header: BatchHeader; readonly recipients: readonly StandardRecipient[]; readonly claims: readonly StandardPEClaim[] }
  | { readonly kind: 'genesis'; readonly header: BatchHeader; readonly recipients: readonly GenesisRecipient[]; readonly claims: readonly GenesisPEClaim[] }
  | { readonly kind: 'undecodable'; readonly detail: string };

export function decodeSettlementCalldata(calldata: string): DecodedBatch {
  let parsed;
  try {
    parsed = kernelAbiInterface().parseTransaction({ data: calldata });
  } catch (error) {
    return { kind: 'undecodable', detail: `parse threw: ${String(error)}` };
  }
  if (parsed === null) return { kind: 'undecodable', detail: 'no matching kernel function' };

  const [batchId, epoch, policyHash, cursorStart, cursorEnd, recipients, claims] = parsed.args;
  const header: BatchHeader = {
    batchId: String(batchId),
    epoch: BigInt(epoch),
    policyHash: String(policyHash),
    finalizedCursorStart: BigInt(cursorStart),
    finalizedCursorEnd: BigInt(cursorEnd),
  };

  if (parsed.name === 'settleStandardPEBatch') {
    return {
      kind: 'standard',
      header,
      recipients: (recipients as unknown[]).map((r) => {
        const t = r as [string, bigint | number, bigint];
        return { contributor: String(t[0]), beneficiaryClass: Number(t[1]) as BeneficiaryClass, claimCount: BigInt(t[2]) };
      }),
      claims: (claims as unknown[]).map((c) => {
        const t = c as [string, bigint];
        return { claimId: String(t[0]), recordPointsAtomic: BigInt(t[1]) };
      }),
    };
  }
  if (parsed.name === 'settleGenesisPEBatch') {
    return {
      kind: 'genesis',
      header,
      recipients: (recipients as unknown[]).map((r) => {
        const t = r as [string, bigint];
        return { contributor: String(t[0]), claimCount: BigInt(t[1]) };
      }),
      claims: (claims as unknown[]).map((c) => {
        const t = c as [string, string, string, bigint | number, bigint, bigint];
        return {
          claimId: String(t[0]),
          walletId: String(t[1]),
          oneTimeAnchor: String(t[2]),
          grantType: Number(t[3]),
          qualifiedAt: BigInt(t[4]),
          reservedGrossAtomic: BigInt(t[5]),
        };
      }),
    };
  }
  return { kind: 'undecodable', detail: `unexpected kernel function ${parsed.name}` };
}

function sameBytes32(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decide whether this exact batch may be settled, and record the approval on-chain if so.
 *
 * The caller MUST NOT broadcast unless this returns `approved`. Every other outcome — and
 * every throw, which is caught and converted — is a refusal.
 */
export async function approveBatchForSettlement(
  deps: BatchApprovalDeps,
  batch: SettlementBatchDoc,
): Promise<ApprovalOutcome> {
  const { approver, candidates } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const confirmAttempts = deps.affirmConfirm?.attempts ?? DEFAULT_AFFIRM_CONFIRM_ATTEMPTS;
  const confirmDelayMs = deps.affirmConfirm?.delayMs ?? DEFAULT_AFFIRM_CONFIRM_DELAY_MS;

  // No approver, or no way to judge eligibility, is UNAVAILABLE — never "fine".
  if (approver === undefined) {
    return { kind: 'refused', reason: 'approver_unavailable', detail: 'no batch approver configured' };
  }
  if (candidates === undefined) {
    return { kind: 'refused', reason: 'approver_unavailable', detail: 'no eligibility candidate source configured' };
  }

  try {
    // 1. Recover what the kernel will actually receive, from the bytes that will be sent.
    const decoded = decodeSettlementCalldata(batch.calldata);
    if (decoded.kind === 'undecodable') {
      return { kind: 'refused', reason: 'calldata_undecodable', detail: decoded.detail };
    }

    const expectedLane = batch.lane === 'genesis' ? 'genesis' : 'standard';
    if (decoded.kind !== expectedLane) {
      return {
        kind: 'refused',
        reason: 'lane_mismatch',
        detail: `batch doc lane '${batch.lane}' but calldata is ${decoded.kind}`,
      };
    }
    const lane = decoded.kind === 'genesis' ? SettlementLane.GenesisPE : SettlementLane.StandardPE;

    // An empty batch mints nothing and is not constructible via planNextBatch/reserveBatch,
    // and the kernel's own `approve*Batch` reverts EmptyBatch — but this is a pure function
    // callable in isolation, so refuse it here rather than rely on a caller or the chain to.
    if (decoded.claims.length === 0 || decoded.recipients.length === 0 || batch.members.length === 0) {
      return {
        kind: 'refused',
        reason: 'member_set_mismatch',
        detail: `empty batch: ${decoded.claims.length} claims, ${decoded.recipients.length} recipients, ${batch.members.length} members`,
      };
    }

    // 2. The durable doc and the calldata must agree. If they do not, one of them is stale
    //    and approving either would affirm a batch that is not the batch being settled.
    const header = decoded.header;
    if (
      header.epoch !== BigInt(batch.epoch)
      || !sameBytes32(header.policyHash, batch.policy_hash)
      || header.finalizedCursorStart !== BigInt(batch.cursor_start)
      || header.finalizedCursorEnd !== BigInt(batch.cursor_end)
      || decoded.claims.length !== batch.claim_count
      || decoded.recipients.length !== batch.recipient_count
    ) {
      return {
        kind: 'refused',
        reason: 'header_mismatch',
        detail: 'settlement calldata disagrees with the durable batch document',
      };
    }

    // 3. The member list must cover the settled claims exactly — no unmembered claim can
    //    ride along unevaluated, and no member may be absent from what is settled.
    const claimIds = decoded.claims.map((c) => c.claimId.toLowerCase());
    const memberClaimIds = batch.members.map((m) => m.claim_id.toLowerCase());
    const claimSet = new Set(claimIds);
    const memberSet = new Set(memberClaimIds);
    if (
      claimIds.length !== memberClaimIds.length
      || claimSet.size !== claimIds.length
      || memberSet.size !== memberClaimIds.length
      || claimIds.some((id) => !memberSet.has(id))
    ) {
      return {
        kind: 'refused',
        reason: 'member_set_mismatch',
        detail: `${claimIds.length} settled claims vs ${memberClaimIds.length} recorded members`,
      };
    }

    // 4. RUN THE ELIGIBILITY CRITERIA. This is the step that makes the verifier real.
    const meter = deps.meterClaims;
    const meterMembers = meter === undefined ? [] : batch.members.filter((m) => meter.isMeterClaim(m.pe_id));
    const meterIds = new Set(meterMembers.map((m) => m.pe_id));
    const peIds = batch.members.filter((m) => !meterIds.has(m.pe_id)).map((m) => m.pe_id);
    const loaded = await candidates.loadCandidates(peIds);
    const ineligible: IneligibleClaim[] = [];
    const missing: string[] = [];
    const mismatched: string[] = [];

    // PE METER: a meter member is judged from its pending claim, and what the calldata settles
    // for it — points, recipient, class — must be exactly what the claim commits to.
    if (meter !== undefined && meterMembers.length > 0) {
      const settledFor = new Map<string, { contributor: string; beneficiaryClass: number; points: bigint }>();
      if (decoded.kind === 'standard') {
        let cursor = 0;
        for (const recipient of decoded.recipients) {
          for (let i = 0n; i < recipient.claimCount; i += 1n) {
            const c = decoded.claims[cursor];
            cursor += 1;
            if (c !== undefined) {
              settledFor.set(c.claimId.toLowerCase(), {
                contributor: recipient.contributor.toLowerCase(),
                beneficiaryClass: Number(recipient.beneficiaryClass),
                points: c.recordPointsAtomic,
              });
            }
          }
        }
      }
      const verdicts = await meter.verify(meterMembers.map((m) => ({ pe_id: m.pe_id, leg: m.leg, claim_id: m.claim_id })));
      for (const member of meterMembers) {
        const verdict = verdicts.get(member.pe_id);
        if (verdict === undefined) {
          missing.push(member.pe_id);
          continue;
        }
        if (!verdict.ok) {
          ineligible.push({ peId: member.pe_id, claimId: member.claim_id, reasons: [verdict.reason] });
          continue;
        }
        const onChain = settledFor.get(member.claim_id.toLowerCase());
        if (onChain === undefined
          || onChain.contributor !== verdict.contributor.toLowerCase()
          || onChain.beneficiaryClass !== verdict.beneficiaryClass
          || onChain.points !== BigInt(verdict.recordPointsAtomic)) {
          mismatched.push(`${member.pe_id}#${member.leg}: calldata does not settle what the meter claim commits to`);
        }
      }
    }

    for (const member of batch.members) {
      if (meterIds.has(member.pe_id)) continue;
      const candidate = loaded.get(member.pe_id);
      if (candidate === undefined) {
        missing.push(member.pe_id);
        continue;
      }
      const verdict = evaluateEligibility(candidate);
      if (verdict.kind !== 'eligible') {
        // LEG-AWARE `already_minted` RELAXATION. A split act has two claim-ledger legs
        // (agent + beneficiary) under one PE. When the FIRST leg settles, the writeback
        // flips the PE-LEVEL `mint_status` to 'minted' — so `evaluateEligibility`, which reads
        // that PE-level status, then reports `already_minted` for the STILL-UNSETTLED sibling
        // leg and orphans it (the root defect behind the stranded human 80% legs). The kernel's
        // per-claim `claimSettled` is the authority on whether THIS leg was paid: when it reads
        // false, the PE-level 'minted' is a sibling-leg artifact for this claim, not a re-mint.
        //
        // Relax ONLY when (a) `already_minted` is the SOLE rejection — every other eligibility
        // criterion already passed — AND (b) the kernel proves THIS claim unsettled. A relaxed
        // leg still falls through to the claim-id derivation check below, so it is admitted only
        // if it derives to exactly the claim being settled. FAIL-CLOSED: no `isClaimSettled`
        // capability keeps the refusal, and a throw from it is caught as `approval_call_failed`.
        //
        // This can NEVER admit a legacy pre-PVT9 'minted' PE (the double-mint the kernel cannot
        // catch): those carry no PVT9 claim-ledger row, so `selectLaneWork` never selects them,
        // so they are never batch members and never reach this line.
        const soleAlreadyMinted = verdict.reasons.length === 1 && verdict.reasons[0] === 'already_minted';
        const legUnsettled = soleAlreadyMinted
          && approver.isClaimSettled !== undefined
          && !(await approver.isClaimSettled(member.claim_id));
        if (!legUnsettled) {
          ineligible.push({ peId: member.pe_id, claimId: member.claim_id, reasons: verdict.reasons });
          continue;
        }
      }
      // The claim id the criteria DERIVE must be the claim id being settled. A batch that
      // settles a different claim than the PE it evaluated is not the batch that was judged.
      //
      // M9: derived FOR THE MEMBER'S LEG. `verdict.claimId` comes from `deriveClaimId(pe)`,
      // which is the `sole` derivation and takes no leg, so comparing it directly refused every
      // `agent`/`beneficiary` member with `claim_id_mismatch` — i.e. every split act, before
      // signing. `deriveLegClaimId(pe,'sole')` delegates to `deriveClaimId`, so the single-payee
      // case is byte-identical to what this line did before.
      //
      // an attestation TOP-UP member derives under its own domain (`deriveTopupClaimId`),
      // which can never equal the act's id — so the gate must re-derive BY KIND, or every top-up
      // would refuse `claim_id_mismatch` and halt the standard lane from that batch onward (the
      // the negative control). The candidate evaluated is the same sealed
      // act; for a MINTED act the leg-aware relaxation above admits the top-up exactly as
      // it admits an unsettled sibling leg — the kernel's `claimSettled(topupId)` reads false.
      const expected = member.claim_kind === 'attestation_topup'
        ? deriveTopupClaimId(candidate.pe, member.leg)
        : deriveLegClaimId(candidate.pe, member.leg);
      if (expected.kind !== 'derived') {
        mismatched.push(`${member.pe_id}#${member.leg}: claim id underivable (${expected.reason})`);
      } else if (!sameBytes32(expected.claimId, member.claim_id)) {
        mismatched.push(
          `${member.pe_id}#${member.leg}: derived ${expected.claimId} != settled ${member.claim_id}`,
        );
      }
    }

    if (missing.length > 0) {
      return {
        kind: 'refused',
        reason: 'candidate_missing',
        detail: `${missing.length} PE(s) had no eligibility candidate: ${missing.slice(0, 5).join(', ')}`,
      };
    }
    if (ineligible.length > 0) {
      return {
        kind: 'refused',
        reason: 'candidate_ineligible',
        detail: `${ineligible.length} of ${batch.members.length} PE(s) are not eligible`,
        ineligible,
      };
    }
    if (mismatched.length > 0) {
      return {
        kind: 'refused',
        reason: 'claim_id_mismatch',
        detail: mismatched.slice(0, 5).join('; '),
      };
    }

    // 5. Derive the digest with the SAME code the Solidity cross-language vector pins.
    const claimsHash = decoded.kind === 'genesis'
      ? hashGenesisClaims(decoded.recipients, decoded.claims)
      : hashStandardClaims(decoded.recipients, decoded.claims);
    const settlementDigest = computeSettlementDigest({
      kernelAddress: approver.kernelAddress,
      chainId: approver.chainId,
      lane,
      header,
      claimsHash,
    });

    // 6. Idempotent per digest — an already-affirmed batch costs no second call.
    if (await approver.isAffirmed(settlementDigest, lane)) {
      return { kind: 'approved', settlementDigest, lane, alreadyAffirmed: true, claimsEvaluated: batch.members.length };
    }

    // 7. Approve. The verifier returns the digest IT derived; disagreement means our mirror
    //    drifted from the kernel and nothing may settle on it.
    const returned = decoded.kind === 'genesis'
      ? await approver.approveGenesisBatch({ header, recipients: decoded.recipients, claims: decoded.claims })
      : await approver.approveStandardBatch({ header, recipients: decoded.recipients, claims: decoded.claims });

    if (!sameBytes32(returned, settlementDigest)) {
      return {
        kind: 'refused',
        reason: 'digest_disagreement',
        detail: `verifier derived ${returned}, off-chain derived ${settlementDigest}`,
      };
    }

    // 8. Confirm the affirmation actually landed. Approving is not the same as being
    //    approved, and the settle-time read is the one that matters.
    //
    //    The confirmation READ can race the approve WRITE: right after `tx.wait()` returns, an
    //    `eth_call` at 'latest' can land on a load-balanced RPC backend still one block behind
    //    the approve, where the approval genuinely reads false (proven on Base: the same verify
    //    call returns false at block N-1 and true at block N). The approve receipt already
    //    proved the write committed, so a single stale read must not be a permanent refusal —
    //    poll a bounded number of times and refuse only if the approval never becomes visible.
    let affirmed = false;
    for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
      if (await approver.isAffirmed(settlementDigest, lane)) {
        affirmed = true;
        break;
      }
      if (attempt < confirmAttempts - 1) await sleep(confirmDelayMs);
    }
    if (!affirmed) {
      return {
        kind: 'refused',
        reason: 'approval_not_affirmed',
        detail: `verifier does not affirm ${settlementDigest} after approval (checked ${confirmAttempts}x)`,
      };
    }

    return { kind: 'approved', settlementDigest, lane, alreadyAffirmed: false, claimsEvaluated: batch.members.length };
  } catch (error) {
    // A throw anywhere above — RPC failure, adapter bug, revert — is a refusal. It is never
    // an approval, and it must never fall through to a broadcast.
    return { kind: 'refused', reason: 'approval_call_failed', detail: String(error) };
  }
}
