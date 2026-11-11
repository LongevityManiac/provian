import { AbiCoder, sha256 } from 'ethers';
import { decodeSettlementCalldata } from '../pvt/wp4/batch-approval';
import type { SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { BeneficiaryClass, computeSettlementDigest, hashGenesisClaims, hashStandardClaims,
  MAX_RECIPIENTS_PER_BATCH } from '../pvt/wp-ev/settlement-batch';
import type { PrivateIssuanceRecipient } from './private-monthly-earnings';

export interface SettlementIssuancePlan {
  readonly batchId: string; readonly epoch: string; readonly policyHash: string;
  readonly lane: 0 | 1; readonly settlementDigest: string;
  readonly recipients: readonly (PrivateIssuanceRecipient & { readonly ordinal: number })[];
}
export interface SettlementIssuancePolicy {
  readonly kernel: string; readonly epoch: string; readonly policyHash: string;
  readonly mintRateAtomic: string; readonly agentFoundationBps: string;
}
const MAX = (1n << 256n) - 1n;
const invalid = (): never => { throw Error('recourse_settlement_issuance_invalid'); };
function uint(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) > MAX) return invalid();
  return BigInt(value);
}
function bounded(value: bigint): bigint { return value < 0n || value > MAX ? invalid() : value; }

/** Decode the immutable INNER kernel call. Sum each recipient's claims before
 * mint-rate rounding, then apply its frozen epoch split. Neither balance deltas
 * nor the recipient's net transfer can recover this gross issuance correctly.
 * The returned order is the original batch order, never a private-owner group. */
export function planSettlementIssuance(batch: SettlementBatchDoc, policy: SettlementIssuancePolicy): SettlementIssuancePlan {
  const decoded = decodeSettlementCalldata(batch.calldata);
  const rate = uint(policy.mintRateAtomic), agentBps = uint(policy.agentFoundationBps);
  if (decoded.kind === 'undecodable' || !/^0x[0-9a-f]{40}$/.test(policy.kernel) || /^0x0+$/.test(policy.kernel)
    || rate === 0n || agentBps < 50n || agentBps > 9950n) return invalid();
  const { header, recipients, claims } = decoded;
  const lane = decoded.kind === 'genesis' ? 1 : 0;
  if (batch.lane !== decoded.kind || header.batchId.toLowerCase() !== batch.batch_id
    || header.epoch !== BigInt(batch.epoch) || String(header.epoch) !== policy.epoch
    || header.policyHash.toLowerCase() !== batch.policy_hash || batch.policy_hash !== policy.policyHash
    || String(header.finalizedCursorStart) !== batch.cursor_start || String(header.finalizedCursorEnd) !== batch.cursor_end
    || header.finalizedCursorEnd - header.finalizedCursorStart !== BigInt(claims.length)
    || recipients.length === 0 || recipients.length > MAX_RECIPIENTS_PER_BATCH || recipients.length !== batch.recipient_count
    || claims.length === 0 || claims.length !== batch.claim_count || claims.length !== batch.members.length) return invalid();
  const claimIds = new Set(claims.map(c => c.claimId.toLowerCase()));
  const memberIds = new Set(batch.members.map(m => m.claim_id.toLowerCase()));
  if (claimIds.size !== claims.length || memberIds.size !== claims.length
    || [...claimIds].some(id => /^0x0+$/.test(id) || !memberIds.has(id))) return invalid();
  const claimsHash = decoded.kind === 'standard' ? hashStandardClaims(decoded.recipients, decoded.claims)
    : hashGenesisClaims(decoded.recipients, decoded.claims);
  const settlementDigest = computeSettlementDigest({ chainId: 8453n, kernelAddress: policy.kernel, lane, header, claimsHash });
  let cursor = 0, previousAddress = 0n, totalGross = 0n, contributorTotal = 0n, foundationTotal = 0n;
  const rows = recipients.map((r, ordinal) => {
    const account = r.contributor.toLowerCase();
    if (BigInt(account) <= previousAddress || r.claimCount <= 0n || r.claimCount > BigInt(claims.length - cursor)) return invalid();
    previousAddress = BigInt(account);
    let input = 0n;
    for (let i = 0; i < Number(r.claimCount); i++, cursor++) {
      const amount = decoded.kind === 'standard' ? decoded.claims[cursor].recordPointsAtomic : decoded.claims[cursor].reservedGrossAtomic;
      if (amount <= 0n) return invalid();
      input = bounded(input + amount);
    }
    const gross = bounded(lane === 0 ? input * rate / 10n ** 18n : input);
    let foundationBps = 50n;
    if (decoded.kind === 'standard') {
      const classification = decoded.recipients[ordinal].beneficiaryClass;
      if (![BeneficiaryClass.Unknown, BeneficiaryClass.HumanResolving, BeneficiaryClass.AutonomousAgent].includes(classification)
        || (agentBps !== 50n && classification === BeneficiaryClass.Unknown)) return invalid();
      foundationBps = classification === BeneficiaryClass.HumanResolving ? 50n : agentBps;
    }
    const contributor = gross * (9950n - foundationBps) / 10000n;
    totalGross = bounded(totalGross + gross);
    contributorTotal = bounded(contributorTotal + contributor);
    foundationTotal = bounded(foundationTotal + gross * foundationBps / 10000n);
    return { ordinal, account, grossAtomic: String(gross), contributorAtomic: String(contributor),
      occurrence: sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32', 'uint256'],
        ['Provian membership issuance occurrence', settlementDigest, ordinal])) };
  });
  if (cursor !== claims.length || bounded(contributorTotal + foundationTotal + totalGross * 50n / 10000n) !== uint(batch.total_minted_atomic)) return invalid();
  return { batchId: batch.batch_id, epoch: policy.epoch, policyHash: policy.policyHash, lane, settlementDigest, recipients: rows };
}
