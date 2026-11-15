/**
 * WP-EV — assembling an approved batch and deriving the digest the oracle will affirm.
 *
 * `ProvianPVT9EligibilityVerifier` re-derives the settlement digest from the recipients and
 * claims it is handed and affirms only that. This module builds those arrays from evaluated
 * PEs and computes the same digest off-chain, so the settler can assert before it spends a
 * transaction that the batch it is about to submit is the batch it had approved.
 *
 * The preimages mirror the kernel exactly (`ProvianPVT9.hashStandardClaims`,
 * `hashGenesisClaims`, `computeSettlementDigest`) and are pinned against Solidity by a
 * shared fixed vector — `settlement-batch.test.ts` and
 * `contracts/test/ProvianPVT9EligibilityVerifier.t.sol::test_crossLanguageDigestVector`
 * assert the same constant, so a drift on either side fails a test rather than a mint.
 *
 * Ordering is not cosmetic. The kernel requires recipients in STRICTLY ascending address
 * order and each recipient's claims contiguous in that same order; anything else reverts.
 *
 * Pure: nothing here reads Firestore, signs, submits, or opens a connection.
 */

import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();

export const STANDARD_CLAIMS_DOMAIN = keccak256(toUtf8Bytes('provian.pvt9.standard-claims.v1'));
export const GENESIS_CLAIMS_DOMAIN = keccak256(toUtf8Bytes('provian.pvt9.genesis-claims.v1'));
export const SETTLEMENT_DOMAIN = keccak256(toUtf8Bytes('provian.pvt9.settlement.v1'));

/** Mirrors `ProvianPVT9.SettlementLane`. */
export enum SettlementLane {
  StandardPE = 0,
  GenesisPE = 1,
}

/** Mirrors `ProvianPVT9.BeneficiaryClass`. */
export enum BeneficiaryClass {
  Unknown = 0,
  HumanResolving = 1,
  AutonomousAgent = 2,
}

/** Mirrors `ProvianPVT9.MAX_RECIPIENTS_PER_BATCH`. */
export const MAX_RECIPIENTS_PER_BATCH = 500;

const BYTES32 = /^0x[0-9a-f]{64}$/i;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

export interface BatchHeader {
  readonly batchId: string;
  readonly epoch: bigint;
  readonly policyHash: string;
  readonly finalizedCursorStart: bigint;
  readonly finalizedCursorEnd: bigint;
}

export interface StandardRecipient {
  readonly contributor: string;
  readonly beneficiaryClass: BeneficiaryClass;
  readonly claimCount: bigint;
}

export interface StandardPEClaim {
  readonly claimId: string;
  readonly recordPointsAtomic: bigint;
}

export interface GenesisRecipient {
  readonly contributor: string;
  readonly claimCount: bigint;
}

export interface GenesisPEClaim {
  readonly claimId: string;
  readonly walletId: string;
  readonly oneTimeAnchor: string;
  readonly grantType: number;
  readonly qualifiedAt: bigint;
  readonly reservedGrossAtomic: bigint;
}

/** One evaluated, eligible standard PE ready to be placed in a batch. */
export interface StandardClaimEntry {
  readonly contributor: string;
  readonly beneficiaryClass: BeneficiaryClass;
  readonly claimId: string;
  readonly recordPointsAtomic: bigint;
}

export interface StandardBatch {
  readonly header: BatchHeader;
  readonly recipients: readonly StandardRecipient[];
  readonly claims: readonly StandardPEClaim[];
}

export type BatchRejection =
  | 'empty_batch'
  | 'too_many_recipients'
  | 'invalid_claim_id'
  | 'invalid_record_points'
  | 'invalid_contributor'
  | 'invalid_beneficiary_class'
  | 'beneficiary_class_required'
  | 'beneficiary_class_conflict'
  | 'duplicate_claim_id'
  | 'invalid_batch_id'
  | 'invalid_policy_hash'
  | 'invalid_cursor'
  | 'invalid_epoch'
  | 'cursor_range_mismatch';

/**
 * `conflicts` is tied to its own reason by a nested discriminant rather than being an
 * optional field on every rejection, so it cannot be read where it is meaningless.
 */
export type StandardBatchResult =
  | { readonly kind: 'assembled'; readonly batch: StandardBatch }
  | {
      readonly kind: 'rejected';
      readonly reason: 'beneficiary_class_conflict';
      /** Every contributor carrying more than one classification. */
      readonly conflicts: readonly string[];
    }
  | {
      readonly kind: 'rejected';
      readonly reason: Exclude<BatchRejection, 'beneficiary_class_conflict'>;
    };

/**
 * Whether the settling epoch prices agents differently from humans — i.e. whether
 * `policy.agentFoundationBps != HUMAN_FOUNDATION_BPS`.
 *
 * The kernel only demands a resolved classification when this is true
 * (`ProvianPVT9._validateStandardInputs`, `BeneficiaryClassificationRequired`), so this
 * mirrors it exactly rather than guessing in either direction: rejecting `Unknown`
 * unconditionally would refuse batches the kernel accepts today, and never rejecting it
 * would burn an approval transaction on a batch that cannot settle.
 */
export interface StandardAssemblyPolicy {
  readonly differentialAgentFoundationRate: boolean;
}

/** Mirrors `ProvianPVT9.HUMAN_FOUNDATION_BPS` — the immutable human Foundation floor. */
export const HUMAN_FOUNDATION_BPS = 50n;

/**
 * Derive the assembly policy from the epoch's `agentFoundationBps`, so the caller compares
 * against the kernel's own constant rather than reproducing the rule.
 */
export function assemblyPolicyForEpoch(agentFoundationBps: bigint): StandardAssemblyPolicy {
  return { differentialAgentFoundationRate: agentFoundationBps !== HUMAN_FOUNDATION_BPS };
}

function isSettleableHash(value: unknown): value is string {
  return typeof value === 'string' && BYTES32.test(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function normalizeAddress(value: string): string | null {
  try {
    const checksummed = getAddress(value);
    return checksummed === '0x0000000000000000000000000000000000000000' ? null : checksummed;
  } catch {
    return null;
  }
}

/**
 * Group evaluated claims into the recipient/claim arrays the kernel requires.
 *
 * Recipients come out in strictly ascending address order and each recipient's claims sit
 * contiguously in the same order. Claims within a recipient keep the order they arrived in,
 * which keeps the assembly deterministic for a given input.
 *
 * A contributor carrying two different beneficiary classifications is a hard REJECTION, not
 * a warning. Under a differential rate the classification alone decides that contributor's
 * split (`ProvianPVT9.settleStandardPEBatch` derives `foundationBps` from it), so silently
 * picking the first one seen would mint every one of their claims at a rate nobody chose.
 * A duplicate claim id is already a hard reject and it costs strictly less — a revert
 * rather than a mispricing.
 */
export function assembleStandardBatch(
  entries: readonly StandardClaimEntry[],
  header: BatchHeader,
  policy: StandardAssemblyPolicy = { differentialAgentFoundationRate: false },
): StandardBatchResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { kind: 'rejected', reason: 'empty_batch' };
  }
  // Header values the kernel and the oracle both reject outright. Catching them here saves
  // an approval transaction that could never be settled.
  if (!isSettleableHash(header?.batchId)) return { kind: 'rejected', reason: 'invalid_batch_id' };
  if (!isSettleableHash(header.policyHash)) return { kind: 'rejected', reason: 'invalid_policy_hash' };
  // Both cursors are `uint256` on the kernel. The upper bound matters for the same reason
  // the epoch and points bounds below do: past it `abi.encode` throws instead of rejecting.
  if (
    typeof header.finalizedCursorStart !== 'bigint'
    || header.finalizedCursorStart < 0n
    || header.finalizedCursorStart > MAX_UINT256
  ) {
    return { kind: 'rejected', reason: 'invalid_cursor' };
  }
  if (
    typeof header.finalizedCursorEnd !== 'bigint'
    || header.finalizedCursorEnd < 0n
    || header.finalizedCursorEnd > MAX_UINT256
  ) {
    return { kind: 'rejected', reason: 'invalid_cursor' };
  }
  // The epoch is `uint64` on the kernel. Out of that domain it would not be a rejection at
  // all — `abi.encode` would THROW inside digest computation, which is the one outcome a
  // result-typed assembler should never produce.
  if (typeof header.epoch !== 'bigint' || header.epoch < 0n || header.epoch > MAX_UINT64) {
    return { kind: 'rejected', reason: 'invalid_epoch' };
  }

  const byContributor = new Map<
    string,
    { contributor: string; beneficiaryClass: BeneficiaryClass; claims: StandardPEClaim[] }
  >();
  const seenClaimIds = new Set<string>();
  const conflicts: string[] = [];

  for (const entry of entries) {
    const contributor = normalizeAddress(entry?.contributor);
    if (contributor === null) return { kind: 'rejected', reason: 'invalid_contributor' };
    if (!isSettleableHash(entry.claimId)) return { kind: 'rejected', reason: 'invalid_claim_id' };
    if (
      typeof entry.recordPointsAtomic !== 'bigint'
      || entry.recordPointsAtomic <= 0n
      // Same reason as the epoch bound: past `uint256` this throws rather than rejects.
      || entry.recordPointsAtomic > MAX_UINT256
    ) {
      return { kind: 'rejected', reason: 'invalid_record_points' };
    }
    // Out of range is ALWAYS invalid: the kernel range-checks it, and a value the enum
    // cannot hold reverts at ABI decode before it even gets there.
    if (
      !Number.isInteger(entry.beneficiaryClass)
      || entry.beneficiaryClass < BeneficiaryClass.Unknown
      || entry.beneficiaryClass > BeneficiaryClass.AutonomousAgent
    ) {
      return { kind: 'rejected', reason: 'invalid_beneficiary_class' };
    }
    // `Unknown` is the enum's zero value, so it is also what a defaulted or missing field
    // decodes to — exactly the case the kernel refuses to price under a differential rate.
    if (policy.differentialAgentFoundationRate && entry.beneficiaryClass === BeneficiaryClass.Unknown) {
      return { kind: 'rejected', reason: 'beneficiary_class_required' };
    }

    const claimKey = entry.claimId.toLowerCase();
    // The kernel reverts `ClaimAlreadySettled` on a repeat, taking the whole batch with it.
    if (seenClaimIds.has(claimKey)) return { kind: 'rejected', reason: 'duplicate_claim_id' };
    seenClaimIds.add(claimKey);

    const existing = byContributor.get(contributor);
    if (existing === undefined) {
      byContributor.set(contributor, {
        contributor,
        beneficiaryClass: entry.beneficiaryClass,
        claims: [{ claimId: entry.claimId, recordPointsAtomic: entry.recordPointsAtomic }],
      });
    } else {
      if (existing.beneficiaryClass !== entry.beneficiaryClass && !conflicts.includes(contributor)) {
        conflicts.push(contributor);
      }
      existing.claims.push({ claimId: entry.claimId, recordPointsAtomic: entry.recordPointsAtomic });
    }
  }

  // Unconditional, unlike the `Unknown` rule above. Under a non-differential epoch the two
  // classes price identically so a conflict is economically inert, but it still means the
  // caller's own records disagree about who this contributor is, and the epoch's rate is
  // prospectively changeable. Refusing is fail-closed and recoverable — the settler resolves
  // the classification or drops those claims and settles the rest.
  if (conflicts.length > 0) {
    return { kind: 'rejected', reason: 'beneficiary_class_conflict', conflicts };
  }

  const ordered = [...byContributor.values()].sort((a, b) => {
    const left = BigInt(a.contributor);
    const right = BigInt(b.contributor);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  if (ordered.length > MAX_RECIPIENTS_PER_BATCH) {
    return { kind: 'rejected', reason: 'too_many_recipients' };
  }

  const recipients: StandardRecipient[] = [];
  const claims: StandardPEClaim[] = [];
  for (const group of ordered) {
    recipients.push({
      contributor: group.contributor,
      beneficiaryClass: group.beneficiaryClass,
      claimCount: BigInt(group.claims.length),
    });
    claims.push(...group.claims);
  }

  if (header.finalizedCursorEnd - header.finalizedCursorStart !== BigInt(claims.length)) {
    return { kind: 'rejected', reason: 'cursor_range_mismatch' };
  }

  return { kind: 'assembled', batch: { header, recipients, claims } };
}

/** Mirrors `ProvianPVT9.hashStandardClaims`. */
export function hashStandardClaims(
  recipients: readonly StandardRecipient[],
  claims: readonly StandardPEClaim[],
): string {
  return keccak256(
    abi.encode(
      ['bytes32', 'tuple(address,uint8,uint256)[]', 'tuple(bytes32,uint256)[]'],
      [
        STANDARD_CLAIMS_DOMAIN,
        recipients.map((r) => [r.contributor, r.beneficiaryClass, r.claimCount]),
        claims.map((c) => [c.claimId, c.recordPointsAtomic]),
      ],
    ),
  );
}

/** Mirrors `ProvianPVT9.hashGenesisClaims`. */
export function hashGenesisClaims(
  recipients: readonly GenesisRecipient[],
  claims: readonly GenesisPEClaim[],
): string {
  return keccak256(
    abi.encode(
      [
        'bytes32',
        'tuple(address,uint256)[]',
        'tuple(bytes32,bytes32,bytes32,uint8,uint64,uint256)[]',
      ],
      [
        GENESIS_CLAIMS_DOMAIN,
        recipients.map((r) => [r.contributor, r.claimCount]),
        claims.map((c) => [
          c.claimId,
          c.walletId,
          c.oneTimeAnchor,
          c.grantType,
          c.qualifiedAt,
          c.reservedGrossAtomic,
        ]),
      ],
    ),
  );
}

/**
 * Mirrors `ProvianPVT9.computeSettlementDigest`.
 *
 * `kernelAddress` and `chainId` are the kernel's own `address(this)` and `block.chainid`;
 * binding them is what stops a digest approved for one deployment from meaning anything on
 * another.
 */
export function computeSettlementDigest(params: {
  readonly kernelAddress: string;
  readonly chainId: bigint;
  readonly lane: SettlementLane;
  readonly header: BatchHeader;
  readonly claimsHash: string;
}): string {
  const { kernelAddress, chainId, lane, header, claimsHash } = params;
  return keccak256(
    abi.encode(
      [
        'bytes32',
        'uint256',
        'address',
        'uint8',
        'bytes32',
        'uint64',
        'bytes32',
        'uint256',
        'uint256',
        'bytes32',
      ],
      [
        SETTLEMENT_DOMAIN,
        chainId,
        kernelAddress,
        lane,
        header.batchId,
        header.epoch,
        header.policyHash,
        header.finalizedCursorStart,
        header.finalizedCursorEnd,
        claimsHash,
      ],
    ),
  );
}

/** The digest the oracle will derive for an assembled standard batch. */
export function standardSettlementDigest(
  batch: StandardBatch,
  kernelAddress: string,
  chainId: bigint,
): string {
  return computeSettlementDigest({
    kernelAddress,
    chainId,
    lane: SettlementLane.StandardPE,
    header: batch.header,
    claimsHash: hashStandardClaims(batch.recipients, batch.claims),
  });
}
