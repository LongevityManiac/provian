import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { approvalVerifierConfigFromEnv, verifySshApprovalSignature,
  type SshApprovalSignature, type SshApprovalVerifierConfig } from '../pvt/policy/approval-signature';

export interface RecourseMembershipRule {
  readonly schema: 'provian-recourse-membership/v1';
  readonly chainId: 8453;
  readonly pointer: string;
  readonly firstMonth: number;
  readonly participationBurnAtomic: string;
  readonly noEarningsContributionAtomic: string;
  readonly earningsBps: number;
}
export interface SignedRecourseMembershipRule {
  readonly rule: RecourseMembershipRule;
  readonly ruleHash: string;
  readonly signature: SshApprovalSignature;
}
export const RECOURSE_MEMBERSHIP_RULES = 'recourse_membership_rules_v1';
const uint256 = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < 2n ** 256n;

/** All three economic amounts and their prospective calendar boundary are in
 * the signed bytes. The permanent pointer binds this rule across successors. */
export function parseRecourseMembershipRule(value: unknown): RecourseMembershipRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_rule_invalid');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'chainId,earningsBps,firstMonth,noEarningsContributionAtomic,participationBurnAtomic,pointer,schema'
    || r.schema !== 'provian-recourse-membership/v1' || r.chainId !== 8453
    || typeof r.pointer !== 'string' || !/^0x[0-9a-f]{40}$/.test(r.pointer) || /^0x0+$/.test(r.pointer)
    || typeof r.firstMonth !== 'number' || !Number.isSafeInteger(r.firstMonth) || r.firstMonth < 0
    || !uint256(r.participationBurnAtomic) || !uint256(r.noEarningsContributionAtomic)
    || typeof r.earningsBps !== 'number' || !Number.isInteger(r.earningsBps) || r.earningsBps < 0 || r.earningsBps > 10000) {
    throw new Error('recourse_rule_invalid');
  }
  return Object.freeze({ schema: r.schema, chainId: r.chainId, pointer: r.pointer,
    firstMonth: r.firstMonth, participationBurnAtomic: r.participationBurnAtomic,
    noEarningsContributionAtomic: r.noEarningsContributionAtomic, earningsBps: r.earningsBps });
}
export function recourseMembershipSigningBytes(value: unknown): Buffer {
  const r = parseRecourseMembershipRule(value);
  return Buffer.from(`Provian Recourse Pool membership rule\n${JSON.stringify(r)}\n`, 'utf8');
}
export function recourseMembershipRuleHash(value: unknown): string {
  return `0x${createHash('sha256').update(recourseMembershipSigningBytes(value)).digest('hex')}`;
}
export function verifyRecourseMembershipRule(value: unknown, expectedPointer: string,
  config: SshApprovalVerifierConfig | null = approvalVerifierConfigFromEnv()): SignedRecourseMembershipRule {
  if (!config || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_rule_unverified');
  const record = value as Partial<SignedRecourseMembershipRule>;
  if (Object.keys(record).sort().join(',') !== 'rule,ruleHash,signature' || !record.signature) throw new Error('recourse_rule_unverified');
  const rule = parseRecourseMembershipRule(record.rule);
  if (rule.pointer !== expectedPointer.toLowerCase() || record.ruleHash !== recourseMembershipRuleHash(rule)
    || !verifySshApprovalSignature(recourseMembershipSigningBytes(rule), record.signature, config)) throw new Error('recourse_rule_unverified');
  return Object.freeze({ rule, ruleHash: record.ruleHash, signature: Object.freeze({ ...record.signature }) });
}

/** Compare every field with the tuple that will be deployed or scheduled.
 * Checking just the signature hash would leave the amounts independently mutable. */
export function assertRecourseRuleTuple(record: SignedRecourseMembershipRule,
  tuple: { firstMonth: bigint; participationBurn: bigint; noEarningsContribution: bigint; earningsBps: bigint; signedRuleHash: string }): void {
  const r = record.rule;
  if (tuple.firstMonth !== BigInt(r.firstMonth) || tuple.participationBurn !== BigInt(r.participationBurnAtomic)
    || tuple.noEarningsContribution !== BigInt(r.noEarningsContributionAtomic) || tuple.earningsBps !== BigInt(r.earningsBps)
    || tuple.signedRuleHash !== record.ruleHash) throw new Error('recourse_rule_chain_mismatch');
}

export async function readPublishedRecourseRule(db: Firestore, hash: string, pointer: string): Promise<SignedRecourseMembershipRule> {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('recourse_rule_invalid');
  const snapshot = await db.collection(RECOURSE_MEMBERSHIP_RULES).doc(hash).get();
  const record = verifyRecourseMembershipRule(snapshot.data(), pointer);
  if (record.ruleHash !== hash) throw new Error('recourse_rule_unverified');
  return record;
}
