import { AbiCoder, getBytes, hashMessage, Interface, sha256 } from 'ethers';
import { parseMembershipAuthorizationDomain, type MembershipAuthorizationDomain } from './recourse-membership-authorization';
export interface MembershipIssuanceContext {
  readonly batchId: string; readonly lane: 0 | 1; readonly epoch: string; readonly policyHash: string;
  readonly settlementDigest: string; readonly revision: string; readonly month: string; readonly membershipRuleHash: string;
}
export interface MembershipIssuanceTicket {
  readonly account: string; readonly gross: string; readonly contributor: string; readonly contribution: string;
  readonly consentNonce: string; readonly protectedMember: boolean;
}
const CONTEXT = 'tuple(bytes32 batchId,uint8 lane,uint64 epoch,bytes32 policyHash,bytes32 settlementDigest,uint256 revision,uint256 month,bytes32 membershipRuleHash)';
const TICKETS = 'tuple(address account,uint256 gross,uint256 contributor,uint256 contribution,uint256 consentNonce,bool protectedMember)[]';
export const MEMBER_SETTLEMENT_ABI = new Interface([
  `function settleMemberBatch(bytes kernelCall,${CONTEXT} context,${TICKETS} tickets,bytes attestorSignature)`,
  'function cancelMemberBatch(bytes32 batchId,uint256 revision)',
  `function probeMemberBatch(bytes kernelCall,${CONTEXT} context,${TICKETS} tickets)`,
  'error ProbeResult(bool success,bytes result)',
]);
export const MEMBERSHIP_ISSUANCE_ABI = new Interface([
  `function issuanceDigest(${CONTEXT},${TICKETS}) view returns(bytes32)`,
  `function installIssuanceTickets(${CONTEXT},${TICKETS},bytes)`, 'function finishIssuanceTickets(bytes32)',
  'function cancelIssuanceBatch(bytes32,uint256)', 'function cancelledIssuanceBatch(bytes32) view returns(bool)',
  'event IssuanceTicketConsumed(bytes32 indexed batchId,uint256 indexed ordinal,address indexed account,uint256 gross,uint256 contribution,bytes32 membershipRuleHash)',
  'event IssuanceBatchCancelled(bytes32 indexed batchId)',
]);
const invalid = (): never => { throw Error('recourse_issuance_ticket_invalid'); };
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) return invalid();
  return value as Record<string, unknown>;
}
function uint(value: unknown, bits = 256): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) >= 2n ** BigInt(bits)) return invalid();
  return value;
}
function hex(value: unknown, length: number): string {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-f]{${length}}$`).test(value) || /^0x0+$/.test(value)) return invalid();
  return value;
}
export function parseMembershipIssuanceContext(value: unknown): MembershipIssuanceContext {
  const r = record(value, 'batchId,epoch,lane,membershipRuleHash,month,policyHash,revision,settlementDigest');
  if ((r.lane !== 0 && r.lane !== 1) || r.revision === '0') return invalid();
  return { batchId: hex(r.batchId, 64), lane: r.lane, epoch: uint(r.epoch, 64), policyHash: hex(r.policyHash, 64),
    settlementDigest: hex(r.settlementDigest, 64), revision: uint(r.revision), month: uint(r.month), membershipRuleHash: hex(r.membershipRuleHash, 64) };
}
export function parseMembershipIssuanceTickets(value: unknown): readonly MembershipIssuanceTicket[] {
  if (!Array.isArray(value) || value.length === 0) return invalid();
  return Array.from(value, item => {
    const r = record(item, 'account,consentNonce,contribution,contributor,gross,protectedMember');
    if (typeof r.protectedMember !== 'boolean') return invalid();
    const ticket = { account: hex(r.account, 40), gross: uint(r.gross), contributor: uint(r.contributor),
      contribution: uint(r.contribution), consentNonce: uint(r.consentNonce), protectedMember: r.protectedMember };
    if (BigInt(ticket.contributor) > BigInt(ticket.gross) || BigInt(ticket.contribution) > BigInt(ticket.contributor)
      || (!ticket.protectedMember && ticket.contribution !== '0')) return invalid();
    return ticket;
  });
}
/** One ordinary settlement batch, without grouping recipients by their hidden
 * owner. The actual kernel digest binds claims, recipient order and rounding. */
export function membershipIssuanceSigningHash(domain: MembershipAuthorizationDomain, input: MembershipIssuanceContext,
  tickets: readonly MembershipIssuanceTicket[]): string {
  const d = parseMembershipAuthorizationDomain(domain), context = parseMembershipIssuanceContext(input);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'address', 'address', CONTEXT, TICKETS],
    ['Provian private membership issuance', d.chainId, d.pointer, d.kernel, d.pool, context, parseMembershipIssuanceTickets(tickets)]));
}
export function membershipIssuanceDigest(domain: MembershipAuthorizationDomain, context: MembershipIssuanceContext,
  tickets: readonly MembershipIssuanceTicket[]): string {
  return hashMessage(getBytes(membershipIssuanceSigningHash(domain, context, tickets)));
}
