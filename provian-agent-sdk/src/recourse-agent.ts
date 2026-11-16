/**
 * recourse-agent — everything a person does on the app's Recourse screens, for an
 * agent from its own machine: see its membership, join, leave, rejoin after a
 * lapse, choose a transfer it did not make and report it, and follow the request.
 *
 * One implementation, three front doors: `npx @provian/agent-sdk@latest recourse …`
 * (and the hosted install's `provian recourse …`), `@provian/cli`'s
 * `provian recourse …`, and the read-only MCP tools.
 *
 * Signing uses the agent's own encrypted keystore directory (default ~/.provian),
 * never a raw key: membership consent also needs the keystore's encrypted
 * recovery material (the membership exit secret and any bound recovery wallet),
 * and a theft report rotates the agent to a fresh recovery key inside that same
 * directory. The relay's consent challenge is checked against Base before
 * anything is signed (recourse-membership-client.ts), and every amount shown is
 * read from the signed membership rule on the Recourse Pool contract.
 *
 * Membership is optional. Joining approves once: the monthly burn and pool
 * contribution are carried out automatically, with no monthly signature and no
 * ETH. One month of grace follows a missed month; rejoining after a lapse first
 * completes the unpaid protected months. Pool contributions are not refundable.
 * Recourse records and restores PVT only. Restoration is a discretionary
 * determination of the pool, never a contractual right.
 */
import * as path from 'path';
import { homedir } from 'os';
import { formatUnits } from 'ethers';
import { loadKeystore, type AgentKeystore } from './keystore';
import { loadBoundAgentCredentialsFile } from './scripts/agent-credentials-file';
import { readLocalKeystoreSecret } from './local-keystore-secret';
import { readRecoursePoolChain, type RecoursePoolState } from './recourse-pool-chain';
import { ownerChainNetwork } from './protocol-runtime';
import {
  beginAgentMembership, readAgentMembershipTransition, authorizeAgentMembershipConsent, leaveAgentMembership,
  submitAgentRestorationRequest, readRestorationRequests, readRecoursePool, type RecourseConfig,
} from './recourse';
import type { MembershipConsentChallenge, MembershipOperationStatus, MembershipTransitionView } from './recourse-membership-client';
import {
  listTheftTransfers, resolveTheftTransfer, THEFT_TRANSFER_DEFAULTS,
  type TheftTransferPage, type TheftTransferScan, type VerifiedTheftTransfer,
} from './recourse-theft-transfers';

export type RecourseMembershipStatus = 'not_member' | 'protected' | 'grace' | 'lapsed';
export const RECOURSE_SUBCOMMANDS = ['status', 'join', 'rejoin', 'leave', 'transfers', 'report', 'requests'] as const;
export type RecourseSubcommand = typeof RECOURSE_SUBCOMMANDS[number];

/** The rule the Recourse Pool holds for the current month, read from Base. */
export interface RecourseRule {
  readonly month: string; readonly participationBurnAtomic: string; readonly noEarningsContributionAtomic: string;
  readonly earningsBps: number; readonly ruleHash: string;
}
export interface AgentRecourseMembership {
  readonly status: RecourseMembershipStatus;
  readonly enrolled: boolean; readonly grace: boolean;
  readonly protectionStartedAtMs: number | null; readonly nextMonthAtMs: number | null;
  readonly nextBurnAtomic: string | null; readonly nextNoEarningsContributionAtomic: string | null; readonly earningsBps: number | null;
  /** Outstanding burns and contributions: awaiting collection while enrolled, to complete before rejoining after a lapse. */
  readonly unpaidAtomic: string;
}
export interface AgentRecourseStatus {
  readonly identity: string | null; readonly pool: string; readonly kernel: string; readonly reserveAtomic: string;
  readonly rule: RecourseRule;
  /** Null while the relay cannot reconcile private membership (for example during an open membership action). */
  readonly membership: AgentRecourseMembership | null;
  readonly pendingAction: MembershipTransitionView | null;
}

const ZERO_IDENTITY = `0x${'00'.repeat(32)}`;
const ATOMIC = /^(0|[1-9][0-9]*)$/, HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const invalid = (): never => { throw Error('recourse_reply_invalid'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string { return typeof value === 'string' && pattern.test(value) ? value : invalid(); }
function bps(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : invalid();
}
function date(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : invalid();
}

/** PVT from atomic units, as the app shows it ("100", "1.5"). */
export function pvt(atomic: string): string { return formatUnits(atomic, 18).replace(/\.0$/, ''); }
export function percent(earningsBps: number): string { return String(earningsBps / 100); }
export function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
export function calendarMonth(month: string): string {
  const n = Number(month);
  return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
}

/** Parse the relay's GET /v1/recourse/pool reply (pool state + private membership). */
export function parseRecoursePoolReply(value: unknown): Omit<AgentRecourseStatus, 'pendingAction'> {
  const row = object(value), membership = object(row.membership);
  const identity = text(row.identity, HASH);
  const rule: RecourseRule = { month: text(row.month, ATOMIC), participationBurnAtomic: text(row.participationBurnAtomic, ATOMIC),
    noEarningsContributionAtomic: text(row.noEarningsContributionAtomic, ATOMIC), earningsBps: bps(row.earningsBps),
    ruleHash: text(row.signedRuleHash, HASH) };
  if (typeof membership.enrolled !== 'boolean' || typeof membership.grace !== 'boolean') return invalid();
  const details = membership.details === undefined ? null : object(membership.details);
  const status = details ? String(details.status) : '';
  if (details && !['not_member', 'protected', 'grace', 'lapsed'].includes(status)) return invalid();
  const derived: RecourseMembershipStatus = membership.grace ? 'grace' : membership.enrolled ? 'protected'
    : status === 'lapsed' ? 'lapsed' : 'not_member';
  return {
    identity: identity === ZERO_IDENTITY ? null : identity, pool: text(row.pool, ADDRESS), kernel: text(row.kernel, ADDRESS),
    reserveAtomic: text(row.reserveAtomic, ATOMIC), rule,
    membership: { status: derived, enrolled: membership.enrolled, grace: membership.grace,
      protectionStartedAtMs: details ? date(details.protectionStartedAtMs) : null,
      nextMonthAtMs: details ? date(details.nextMonthAtMs) : null,
      nextBurnAtomic: details && details.nextBurnAtomic !== null ? text(details.nextBurnAtomic, ATOMIC) : null,
      nextNoEarningsContributionAtomic: details && details.noEarningsContributionAtomic !== null ? text(details.noEarningsContributionAtomic, ATOMIC) : null,
      earningsBps: details && details.earningsBps !== null ? bps(details.earningsBps) : null,
      unpaidAtomic: text(membership.unpaidAtomic, ATOMIC) },
  };
}

/** The relay's rule must equal the rule read independently from Base. */
export function assertRuleMatchesChain(relay: Pick<AgentRecourseStatus, 'pool' | 'kernel' | 'rule'>, chain: RecoursePoolState): void {
  if (relay.pool !== chain.pool || relay.kernel !== chain.kernel || relay.rule.month !== chain.month
    || relay.rule.participationBurnAtomic !== chain.participationBurnAtomic
    || relay.rule.noEarningsContributionAtomic !== chain.noEarningsContributionAtomic
    || relay.rule.earningsBps !== chain.earningsBps || relay.rule.ruleHash !== chain.signedRuleHash) {
    throw Error('recourse_rule_mismatch: the relay and Base disagree on the membership rule; nothing was signed');
  }
}
function chainOnlyStatus(chain: RecoursePoolState, pendingAction: MembershipTransitionView | null): AgentRecourseStatus {
  return { identity: null, pool: chain.pool, kernel: chain.kernel, reserveAtomic: chain.reserveAtomic, membership: null, pendingAction,
    rule: { month: chain.month, participationBurnAtomic: chain.participationBurnAtomic, noEarningsContributionAtomic: chain.noEarningsContributionAtomic,
      earningsBps: chain.earningsBps, ruleHash: chain.signedRuleHash } };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RecourseMembershipStatus, string> = {
  protected: 'Protected', grace: 'In grace — still protected', lapsed: 'Lapsed', not_member: 'Not a member',
};
export function ruleLines(rule: RecourseRule): string[] {
  return [
    `Each month while protected: burn ${pvt(rule.participationBurnAtomic)} PVT, plus contribute ${percent(rule.earningsBps)}% of that month's earnings to the Recourse Pool, or ${pvt(rule.noEarningsContributionAtomic)} PVT from your PVT holdings if the month has no earnings.`,
    `These amounts come from the signed membership rule for ${calendarMonth(rule.month)} (rule ${rule.ruleHash.slice(0, 10)}…), read from the Recourse Pool contract on Base.`,
  ];
}
export const MEMBERSHIP_TERMS: readonly string[] = Object.freeze([
  'Membership is optional. You approve once: each month\'s burn and contribution then happen automatically, with no monthly signature and no ETH.',
  'After a missed month you stay protected for one more calendar month. If the outstanding burn and contribution are not completed during that grace month, protection lapses. Rejoining first completes the unpaid protected months; lapsed months are never charged and never covered.',
  'Pool contributions are not refundable, and participation burns are permanent.',
  'Recourse records and restores PVT only; other assets at your address are neither recorded nor restored.',
  'Restoration is a discretionary determination of the pool: no member has a contractual right to it. Until the Court opens, Provian reviews a theft report and decides what the pool can restore. Provian Technologies does not fund, hold or guarantee the pool.',
]);

function transitionLines(view: MembershipTransitionView): string[] {
  const lines = [`Open membership action: ${view.kind} (${view.status}), id ${view.id}.`];
  for (const p of view.pending) lines.push(`  Submitted for ${p.account}: ${p.operation.status}${p.operation.transactionHash ? ` (${p.operation.transactionHash})` : ''}.`);
  return lines;
}

export function renderRecourseStatus(status: AgentRecourseStatus): string[] {
  const m = status.membership, lines: string[] = [];
  lines.push(`Recourse membership: ${m ? STATUS_LABEL[m.status] : 'unavailable right now (the relay is reconciling membership; try again shortly)'}`);
  if (m && (m.status === 'protected' || m.status === 'grace')) {
    lines.push(m.protectionStartedAtMs !== null ? `Protection started ${utcDay(m.protectionStartedAtMs)} (UTC).` : 'Protection start date is not available yet.');
    if (m.nextMonthAtMs !== null && m.nextBurnAtomic !== null) {
      lines.push(`Next month begins ${utcDay(m.nextMonthAtMs)} (UTC): burn ${pvt(m.nextBurnAtomic)} PVT.`);
      if (m.nextNoEarningsContributionAtomic !== null) lines.push(`If that month has no earnings: contribute ${pvt(m.nextNoEarningsContributionAtomic)} PVT.`);
      lines.push(`Otherwise ${percent(m.earningsBps ?? status.rule.earningsBps)}% of your earnings is contributed when they settle.`);
    } else lines.push('The next month\'s schedule is not available yet.');
    if (m.unpaidAtomic !== '0') lines.push(`Awaiting automatic collection: ${pvt(m.unpaidAtomic)} PVT. Keep enough PVT in your wallet.`);
  }
  if (m && m.status === 'lapsed') {
    lines.push(m.unpaidAtomic !== '0'
      ? `To rejoin, first complete the unpaid protected months: ${pvt(m.unpaidAtomic)} PVT.`
      : 'You can rejoin; no unpaid protected months are recorded.');
  }
  lines.push(...ruleLines(status.rule));
  lines.push(`Recourse Pool reserve: ${pvt(status.reserveAtomic)} PVT.`);
  if (status.pendingAction && status.pendingAction.status !== 'complete' && status.pendingAction.status !== 'superseded') lines.push(...transitionLines(status.pendingAction));
  return lines;
}

function statusJson(status: AgentRecourseStatus): Record<string, unknown> {
  const m = status.membership;
  return {
    membership: m ? {
      status: m.status, protected: m.status === 'protected' || m.status === 'grace', in_grace: m.grace,
      protection_started_at: m.protectionStartedAtMs === null ? null : new Date(m.protectionStartedAtMs).toISOString(),
      next_month_at: m.nextMonthAtMs === null ? null : new Date(m.nextMonthAtMs).toISOString(),
      next_burn_pvt: m.nextBurnAtomic === null ? null : pvt(m.nextBurnAtomic),
      next_no_earnings_contribution_pvt: m.nextNoEarningsContributionAtomic === null ? null : pvt(m.nextNoEarningsContributionAtomic),
      earnings_contribution_percent: m.earningsBps === null ? null : m.earningsBps / 100,
      earnings_bps: m.earningsBps,
      unpaid_pvt: pvt(m.unpaidAtomic), unpaid_atomic: m.unpaidAtomic,
      unpaid_meaning: m.status === 'lapsed' ? 'complete_before_rejoining' : m.enrolled ? 'awaiting_automatic_collection' : 'none',
    } : null,
    rule: { month: calendarMonth(status.rule.month), participation_burn_pvt: pvt(status.rule.participationBurnAtomic),
      no_earnings_contribution_pvt: pvt(status.rule.noEarningsContributionAtomic), earnings_contribution_percent: status.rule.earningsBps / 100,
      earnings_bps: status.rule.earningsBps, rule_hash: status.rule.ruleHash, source: 'signed membership rule on the Recourse Pool contract (Base)' },
    pool: { address: status.pool, kernel: status.kernel, reserve_pvt: pvt(status.reserveAtomic) },
    pending_action: status.pendingAction ? { id: status.pendingAction.id, kind: status.pendingAction.kind, status: status.pendingAction.status,
      submitted: status.pendingAction.pending.map(p => ({ account: p.account, status: p.operation.status, transaction_hash: p.operation.transactionHash })) } : null,
  };
}

// ---------------------------------------------------------------------------
// The command runner (front-door independent)
// ---------------------------------------------------------------------------

export interface RestorationSubmission { readonly walletId: string; readonly destination: string; readonly generation: number; readonly restorationRequestId?: string }
export interface RestorationRequestRow {
  readonly requestId: string; readonly status: string; readonly transactionHash: string;
  readonly reversalTransactionHash: string | null; readonly destination: string | null; readonly createdAtMs: number | null;
}
export interface AgentRecourseDeps {
  /** The agent's own address (its keystore/credentials address). */
  readonly address: string;
  readStatus(): Promise<AgentRecourseStatus>;
  readTransition(id?: string): Promise<MembershipTransitionView | null>;
  beginTransition(kind: 'join' | 'leave'): Promise<MembershipTransitionView>;
  authorize(view: MembershipTransitionView, challenge: MembershipConsentChallenge): Promise<MembershipOperationStatus>;
  leave(view: MembershipTransitionView): Promise<void>;
  listTransfers(scan: TheftTransferScan): Promise<TheftTransferPage>;
  resolveTransfer(transactionHash: string): Promise<VerifiedTheftTransfer>;
  submitRestoration(transfer: VerifiedTheftTransfer): Promise<RestorationSubmission>;
  readRequests(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Render a command for this front door, e.g. `recourse join --yes`. */
  command(sub: string): string;
}
export interface RecourseCommandOptions {
  readonly yes?: boolean; readonly tx?: string;
  readonly beforeBlock?: number; readonly windowBlocks?: number; readonly windows?: number; readonly limit?: number;
  /** Polls of an open action before reporting it as still in progress (default 20, 3 s apart). */
  readonly polls?: number;
}
export interface RecourseCommandOutcome {
  readonly exitCode: number;
  readonly result: Record<string, unknown>;
  readonly lines: readonly string[];
}

const ok = (result: Record<string, unknown>, lines: string[]): RecourseCommandOutcome => ({ exitCode: 0, result, lines });
const refused = (code: string, message: string, extra: Record<string, unknown> = {}, lines: string[] = []): RecourseCommandOutcome =>
  ({ exitCode: 1, result: { status: 'error', code, error: message, ...extra }, lines: [...lines, message] });
const OPEN = (view: MembershipTransitionView | null): view is MembershipTransitionView =>
  view !== null && view.status !== 'complete' && view.status !== 'superseded';

function challengeLines(challenge: MembershipConsentChallenge): string[] {
  const lines = [`Wallet ${challenge.consent.account}: ${challenge.consent.joined ? 'include this wallet' : 'first close this wallet\'s previous membership'}.`];
  if (challenge.consent.joined) {
    lines.push(`  Most each month: ${pvt(challenge.burnLimit)} PVT burned and ${pvt(challenge.reserveLimit)} PVT contributed from this wallet's PVT holdings; earnings contribution ${percent(challenge.earningsBpsLimit)}%.`);
  }
  for (const r of challenge.rejoinPayments) {
    lines.push(`  ${calendarMonth(r.month)}: burn ${pvt(r.burn)} PVT and contribute ${pvt(r.reserve)} PVT before rejoining.`);
  }
  return lines;
}
function rejoinTotal(challenge: MembershipConsentChallenge): bigint {
  return challenge.rejoinPayments.reduce((sum, r) => sum + BigInt(r.burn) + BigInt(r.reserve), 0n);
}

async function settle(deps: AgentRecourseDeps, id: string, polls: number): Promise<MembershipTransitionView | null> {
  let view = await deps.readTransition(id);
  for (let i = 0; i < polls && view && view.status !== 'complete' && view.status !== 'superseded'
    && (view.pending.length > 0 || (view.status === 'preparing' && view.challenges.length === 0)); i++) {
    await deps.sleep(3_000);
    view = await deps.readTransition(id);
  }
  return view;
}

async function runJoin(kind: 'join' | 'rejoin', opts: RecourseCommandOptions, deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  const status = await deps.readStatus(), m = status.membership;
  const lines = [...renderRecourseStatus(status), '', ...MEMBERSHIP_TERMS];
  if (m && (m.status === 'protected' || m.status === 'grace')) {
    return ok({ status: 'already_member', ...statusJson(status) }, [...lines, '', 'You are already a member. Nothing was signed.']);
  }
  if (kind === 'rejoin' && m && m.status !== 'lapsed') {
    return refused('NOT_LAPSED', `Rejoin is for a lapsed membership; you are not a member yet. Run: ${deps.command('recourse join --yes')}`, statusJson(status), lines);
  }
  if (kind === 'join' && m && m.status === 'lapsed' && m.unpaidAtomic !== '0') {
    return refused('REJOIN_REQUIRED', `Your membership lapsed with ${pvt(m.unpaidAtomic)} PVT of unpaid protected months. Review it, then run: ${deps.command('recourse rejoin --yes')}`, statusJson(status), lines);
  }
  if (!opts.yes) {
    const cmd = deps.command(`recourse ${kind} --yes`);
    return ok({ status: 'review', signed: false, ...statusJson(status), terms: MEMBERSHIP_TERMS, next_step: cmd },
      [...lines, '', `Nothing was signed. To ${kind} on these terms, run: ${cmd}`]);
  }
  let view = await deps.readTransition();
  if (OPEN(view) && view.kind !== 'join') {
    return refused('ACTION_OPEN', `An unfinished ${view.kind} is open. Finish it first (run ${deps.command(`recourse ${view.kind === 'leave' ? 'leave' : 'status'}`)}).`, {}, lines);
  }
  if (!OPEN(view)) view = await deps.beginTransition('join');
  view = await settle(deps, view.id, opts.polls ?? 20) ?? view;
  if (view.status !== 'consenting' || view.challenges.length === 0) {
    return ok({ status: 'in_progress', signed: false, action: { id: view.id, kind: view.kind, status: view.status } },
      [...lines, '', ...transitionLines(view), `Run ${deps.command('recourse status')} to follow it, then rerun this command if it asks for approval.`]);
  }
  const shown = m?.status === 'lapsed' ? BigInt(m.unpaidAtomic) : 0n;
  for (const challenge of view.challenges) {
    if (challenge.rejoinPayments.length > 0 && kind !== 'rejoin') {
      return refused('REJOIN_REQUIRED', `Joining first completes unpaid protected months. Review them, then run: ${deps.command('recourse rejoin --yes')}`, {},
        [...lines, '', ...challengeLines(challenge)]);
    }
    if (rejoinTotal(challenge) > shown || BigInt(challenge.burnLimit) > BigInt(status.rule.participationBurnAtomic)
      || BigInt(challenge.reserveLimit) > BigInt(status.rule.noEarningsContributionAtomic) || challenge.earningsBpsLimit > status.rule.earningsBps) {
      return refused('AMOUNTS_CHANGED', 'The amounts to approve differ from the ones shown. Nothing was signed; run the command again to review the current amounts.', {},
        [...lines, '', ...challengeLines(challenge)]);
    }
  }
  const approved: string[] = [], submitted: Record<string, unknown>[] = [];
  for (const challenge of view.challenges) {
    approved.push(...challengeLines(challenge));
    const op = await deps.authorize(view, challenge);
    submitted.push({ account: challenge.consent.account, operation: op.id, status: op.status, transaction_hash: op.transactionHash });
  }
  const after = await settle(deps, view.id, opts.polls ?? 20);
  const done = after?.status === 'complete';
  return ok({ status: done ? 'joined' : 'submitted', signed: true, action_id: view.id, submitted },
    [...lines, '', 'Approved:', ...approved,
      done ? 'Membership action confirmed. Protection starts with this month.' : `Approval submitted. Run ${deps.command('recourse status')} to check its confirmation.`]);
}

async function runLeave(opts: RecourseCommandOptions, deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  const status = await deps.readStatus(), m = status.membership;
  const lines = renderRecourseStatus(status);
  if (m && m.status === 'not_member') return ok({ status: 'not_member', ...statusJson(status) }, [...lines, '', 'You are not a member. Nothing to leave.']);
  const effects = ['Leaving ends future burns and contributions. Contributions already made are not refundable; a restoration already allocated to you stays withdrawable on Base after you leave.'];
  if (!opts.yes) {
    const cmd = deps.command('recourse leave --yes');
    return ok({ status: 'review', signed: false, ...statusJson(status), next_step: cmd }, [...lines, '', ...effects, `Nothing was signed. To leave, run: ${cmd}`]);
  }
  let view = await deps.readTransition();
  if (!OPEN(view) || view.kind !== 'leave') view = await deps.beginTransition('leave');
  if (view.status === 'complete') return ok({ status: 'left', action_id: view.id }, [...lines, '', 'Membership action confirmed. You have left the Recourse Pool.']);
  await deps.leave(view);
  const after = await settle(deps, view.id, opts.polls ?? 20);
  const done = after?.status === 'complete';
  return ok({ status: done ? 'left' : 'submitted', signed: true, action_id: view.id },
    [...lines, '', ...effects, done ? 'Membership action confirmed. You have left the Recourse Pool.'
      : `Departure retained by the relay; it completes even if this machine goes offline. Run ${deps.command('recourse status')} to check.`]);
}

function transferJson(t: { transactionHash: string; to: string; amount: string; timestamp: number; block: number;
  recipients?: ReadonlyArray<{ to: string; amount: string }> }): Record<string, unknown> {
  return { transaction_hash: t.transactionHash, ...(t.recipients ? { recipients: t.recipients.map(r => ({ to: r.to, amount_pvt: r.amount })) } : { to: t.to }),
    amount_pvt: t.amount, at: new Date(t.timestamp).toISOString(), block: t.block };
}

async function runTransfers(opts: RecourseCommandOptions, deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  const page = await deps.listTransfers({ beforeBlock: opts.beforeBlock, windowBlocks: opts.windowBlocks, windows: opts.windows, limit: opts.limit });
  const lines = [`Outgoing PVT transfers from ${page.account}, finalized blocks ${page.fromBlock}-${page.toBlock} (newest first):`];
  if (page.transfers.length === 0) lines.push('  None in these blocks.');
  for (const t of page.transfers) lines.push(`  ${utcDay(t.timestamp)}  ${t.amount} PVT to ${t.to}  tx ${t.transactionHash}`);
  if (page.nextBeforeBlock !== null) lines.push(`Older transfers: ${deps.command(`recourse transfers --before ${page.nextBeforeBlock}`)}`);
  lines.push(`To report a transfer you did not make: ${deps.command('recourse report --tx <transaction hash>')}`);
  return ok({ status: 'transfers', account: page.account, kernel: page.kernel, from_block: page.fromBlock, to_block: page.toBlock,
    next_before_block: page.nextBeforeBlock, transfers: page.transfers.map(transferJson) }, lines);
}

async function runReport(opts: RecourseCommandOptions, deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  if (!opts.tx) {
    return refused('MISSING_TX', `Choose the transfer you did not make: list them with ${deps.command('recourse transfers')}, then run ${deps.command('recourse report --tx <transaction hash>')}.`);
  }
  const transfer = await deps.resolveTransfer(opts.tx);
  const review = [
    `Report this transaction: ${transfer.amount} PVT left ${transfer.from} on ${utcDay(transfer.timestamp)} (UTC), block ${transfer.block}, tx ${transfer.transactionHash}.`,
    ...transfer.recipients.map(r => `  ${r.amount} PVT to ${r.to}`),
    'The report covers the whole transaction.',
    `I did not authorize this transfer of ${transfer.amount} PVT.`,
    'Reporting moves control of your agent identity to a fresh recovery key in this keystore directory (your credentials are updated in place). PVT still held by whoever took it is reversed first; the pool determines restoration of any remaining loss.',
    'Restoration is a discretionary determination of the pool: no member has a contractual right to it. Until the Court opens, Provian reviews a theft report and decides what the pool can restore. Recourse restores PVT only.',
  ];
  if (!opts.yes) {
    const cmd = deps.command(`recourse report --tx ${transfer.transactionHash} --yes`);
    return ok({ status: 'review', signed: false, transfer: transferJson(transfer), next_step: cmd }, [...review, `Nothing was submitted. To report it, run: ${cmd}`]);
  }
  const result = await deps.submitRestoration(transfer);
  return ok({ status: 'reported', transfer: transferJson(transfer), restoration_request_id: result.restorationRequestId ?? null,
    new_address: result.destination, recovery_generation: result.generation },
  [...review, `Restoration request ${result.restorationRequestId ?? '(pending)'} submitted. Your agent now signs from ${result.destination}.`,
    `Follow it with ${deps.command('recourse requests')}.`]);
}

export function parseRestorationRequests(value: unknown): RestorationRequestRow[] {
  const rows = object(value).requests;
  if (!Array.isArray(rows)) return invalid();
  return rows.map(raw => {
    const r = object(raw);
    return { requestId: text(r.requestId, HASH), status: text(r.status, /^[a-z_]+$/), transactionHash: text(r.transactionHash, HASH),
      reversalTransactionHash: r.reversalTransactionHash == null ? null : text(r.reversalTransactionHash, HASH),
      destination: r.destination == null ? null : text(r.destination, ADDRESS),
      createdAtMs: r.createdAtMs == null ? null : date(r.createdAtMs) };
  }).sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
}

async function runRequests(deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  const rows = parseRestorationRequests(await deps.readRequests());
  const lines = rows.length === 0 ? ['No restoration requests.'] : ['Restoration requests (newest first):',
    ...rows.map(r => `  ${r.requestId}  ${r.status}  reported tx ${r.transactionHash}${r.reversalTransactionHash ? `  reversal ${r.reversalTransactionHash}` : ''}${r.createdAtMs !== null ? `  ${utcDay(r.createdAtMs)}` : ''}`)];
  return ok({ status: 'requests', requests: rows.map(r => ({ request_id: r.requestId, status: r.status, transaction_hash: r.transactionHash,
    reversal_transaction_hash: r.reversalTransactionHash, destination: r.destination,
    created_at: r.createdAtMs === null ? null : new Date(r.createdAtMs).toISOString() })) }, lines);
}

export async function runAgentRecourseCommand(sub: string, opts: RecourseCommandOptions, deps: AgentRecourseDeps): Promise<RecourseCommandOutcome> {
  try {
    switch (sub) {
      case 'status': {
        const status = await deps.readStatus();
        const lines = renderRecourseStatus(status);
        const m = status.membership;
        const next = !m ? deps.command('recourse status') : m.status === 'lapsed' ? deps.command('recourse rejoin')
          : m.status === 'not_member' ? deps.command('recourse join') : deps.command('recourse leave');
        return ok({ status: 'recourse_status', ...statusJson(status), next_step: next }, lines);
      }
      case 'join': return await runJoin('join', opts, deps);
      case 'rejoin': return await runJoin('rejoin', opts, deps);
      case 'leave': return await runLeave(opts, deps);
      case 'transfers': return await runTransfers(opts, deps);
      case 'report': return await runReport(opts, deps);
      case 'requests': return await runRequests(deps);
      default:
        return refused('UNKNOWN_SUBCOMMAND', `Usage: ${deps.command('recourse status|join|rejoin|leave|transfers|report|requests')}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^recourse_[a-z_]+/.exec(message)?.[0] ?? 'recourse_failed';
    return refused(code, message);
  }
}

// ---------------------------------------------------------------------------
// Default dependencies: the agent's own keystore directory, the relay, Base
// ---------------------------------------------------------------------------

export interface AgentRecourseIdentity {
  readonly directory: string; readonly walletId: string; readonly address: string; readonly config: RecourseConfig;
  readonly keystore: AgentKeystore | null; readonly passphrase: string | null;
}
export class RecourseIdentityError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'RecourseIdentityError'; }
}

/** Load the agent's credentials (and, for signing, its keystore) from a keystore directory. */
export function loadRecourseIdentity(opts: { directory?: string; env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch } = {}): AgentRecourseIdentity {
  const env = opts.env ?? process.env;
  const directory = path.resolve(opts.directory ?? path.join(homedir(), '.provian'));
  const creds = loadBoundAgentCredentialsFile(path.join(directory, 'agent-credentials.json'));
  if (!creds) {
    throw new RecourseIdentityError(`No agent credentials in ${path.join(directory, 'agent-credentials.json')} (a private 0600 file with api_key, api_secret, wallet_id and address). Run the Provian install on this machine, or pass --directory.`, 'NO_CREDENTIALS');
  }
  let keystore: AgentKeystore | null;
  try { keystore = loadKeystore(path.join(directory, 'agent-keystore.json')); }
  catch { throw new RecourseIdentityError(`The agent keystore in ${directory} is not readable.`, 'BAD_KEYSTORE'); }
  if (keystore && (keystore.wallet_id !== creds.wallet_id || keystore.address.toLowerCase() !== creds.address.toLowerCase())) {
    throw new RecourseIdentityError('The keystore and the credentials belong to different agents; refusing to continue.', 'IDENTITY_MISMATCH');
  }
  const passphrase = env.PROVIAN_KEYSTORE_PASSPHRASE && env.PROVIAN_KEYSTORE_PASSPHRASE.length > 0
    ? env.PROVIAN_KEYSTORE_PASSPHRASE : readLocalKeystoreSecret(path.join(directory, 'agent-keystore.secret'));
  const relayUrl = (env.PROVIAN_RELAY_URL ?? '').trim() || 'https://api.provian.ai';
  return { directory, walletId: creds.wallet_id, address: creds.address.toLowerCase(), keystore, passphrase,
    config: { relayUrl, apiKey: creds.api_key, apiSecret: creds.api_secret, walletId: creds.wallet_id, ...(opts.fetch ? { fetch: opts.fetch } : {}) } };
}

function signer(identity: AgentRecourseIdentity): { directory: string; passphrase: string } {
  if (!identity.keystore) throw new RecourseIdentityError(`Signing needs the agent keystore (${path.join(identity.directory, 'agent-keystore.json')}).`, 'NO_KEYSTORE');
  if (!identity.passphrase) throw new RecourseIdentityError('Signing needs the keystore secret: set PROVIAN_KEYSTORE_PASSPHRASE or keep agent-keystore.secret beside the keystore.', 'NO_KEYSTORE_SECRET');
  return { directory: identity.directory, passphrase: identity.passphrase };
}

/** Relay status cross-checked with the rule read independently from Base. */
export async function readAgentRecourseStatus(config: RecourseConfig,
  chain: (identity: string) => Promise<RecoursePoolState> = identity => readRecoursePoolChain(identity, ownerChainNetwork())): Promise<AgentRecourseStatus> {
  const pendingAction = await readAgentMembershipTransition(config).catch(() => null);
  let relay: Omit<AgentRecourseStatus, 'pendingAction'> | null = null;
  try {
    relay = parseRecoursePoolReply(await readRecoursePool(config));
  } catch { relay = null; }
  if (!relay) return chainOnlyStatus(await chain(ZERO_IDENTITY), pendingAction);
  assertRuleMatchesChain(relay, await chain(relay.identity ?? ZERO_IDENTITY));
  return { ...relay, pendingAction };
}

export function defaultAgentRecourseDeps(identity: AgentRecourseIdentity, command: (sub: string) => string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): AgentRecourseDeps {
  const config = identity.config;
  return {
    address: identity.address,
    readStatus: () => readAgentRecourseStatus(config),
    readTransition: id => readAgentMembershipTransition(config, id),
    beginTransition: kind => beginAgentMembership(config, kind),
    authorize: async (view, challenge) => authorizeAgentMembershipConsent(config, { ...signer(identity), transitionId: view.id,
      kind: view.kind, challenge }),
    leave: async view => leaveAgentMembership(config, { ...signer(identity), transitionId: view.id }),
    listTransfers: scan => listTheftTransfers(identity.address, ownerChainNetwork(), scan),
    resolveTransfer: tx => resolveTheftTransfer(tx, identity.address, ownerChainNetwork()),
    submitRestoration: async transfer => submitAgentRestorationRequest(config, { ...signer(identity),
      transactionHash: transfer.transactionHash, block: transfer.block }),
    readRequests: () => readRestorationRequests(config),
    sleep, command,
  };
}

export { THEFT_TRANSFER_DEFAULTS };
