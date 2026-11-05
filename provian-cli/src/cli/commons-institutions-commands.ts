/**
 * Provian Commons institutions CLI (Workstream 4)
 *
 * Currency-aware wrappers over @provian/agent-sdk's CommonsInstitutions client.
 *
 * Credentials: read from the environment (PROVIAN_API_KEY, PROVIAN_API_SECRET,
 * PROVIAN_AGENT_WALLET_ID, PROVIAN_RELAY_URL). These are the Commons institutions API
 * credentials returned once at wallet creation - distinct from the session
 * token used by `provian connect`.
 *
 * Every command's --help lists the PVT example first, USDC second.
 */

import {
  CommonsInstitutions,
  deriveAddressFromPrivateKey,
  type Chain,
  type EscrowResponse,
  type PromiseResponse,
  type PoolResponse,
  type DirectoryProfile,
  type EvmWallet,
  type HumanJobCategory,
  type HumanJobCompensationType,
  type HumanJobSeeking,
  type HumanJobResponse,
  type HumanJobDirection,
  readReplyPolicy,
  replyPolicyInstruction,
} from '@provian/agent-sdk';
import { resolveSovereignPrivateKey } from './sovereign-key-intake';

type CommandResult = Record<string, unknown>;

const DEFAULT_RELAY_URL = 'https://api.provian.ai';

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export function loadCommonsInstitutionsConfig(): { relayUrl: string; walletId: string; apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.PROVIAN_API_KEY;
  const apiSecret = process.env.PROVIAN_API_SECRET;
  const walletId = process.env.PROVIAN_AGENT_WALLET_ID;
  const relayUrl = process.env.PROVIAN_RELAY_URL || DEFAULT_RELAY_URL;
  if (!apiKey || !apiSecret || !walletId) return null;
  return { relayUrl, walletId, apiKey, apiSecret };
}

// Sovereign key intake (F35) lives in ./sovereign-key-intake so it can be
// unit-tested without pulling the SDK import chain.

export function missingCredentialsError(): CommandResult {
  return {
    status: 'error',
    error:
      'Missing Commons institutions credentials. Set PROVIAN_API_KEY, PROVIAN_API_SECRET, and PROVIAN_AGENT_WALLET_ID in your environment. These are returned once at wallet creation.',
  };
}

function parseChain(raw: unknown): Chain | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw === 'base' || raw === 'arbitrum' || raw === 'optimism') return raw;
  return undefined;
}

function parseCurrency(raw: unknown): 'pvt' | 'usdc' | null {
  if (raw === 'pvt' || raw === 'usdc') return raw;
  return null;
}

function pvtFromWholeNumber(whole: number): string {
  // CLI amount flags are always strings; pvtWholeToAtomic lives in the SDK
  // but callers sometimes pass whole-PVT strings like "5". Convert that path
  // here so CLI users don't need to know about 10^18.
  if (!Number.isInteger(whole)) {
    throw new Error('amount must be a whole number of PVT (e.g. 5). Use --amount-atomic to pass atomic units directly.');
  }
  return (BigInt(whole) * 10n ** 18n).toString();
}

/**
 * Resolve an --amount flag in the currency the user picked. For PVT we
 * accept a whole-PVT integer via --amount (converted to 18d atomic units)
 * or a pre-formatted atomic-unit string via --amount-atomic. For USDC we
 * accept a USD float via --amount.
 */
function resolveAmount(
  currency: 'pvt' | 'usdc',
  flags: Record<string, string | boolean>,
): { pvt?: string; usdc?: number } {
  if (currency === 'pvt') {
    const atomic = flags['amount-atomic'];
    if (typeof atomic === 'string' && atomic.length > 0) {
      if (!/^[0-9]+$/.test(atomic)) {
        throw new Error('--amount-atomic must be a non-negative integer string (PVT 18-decimal atomic units).');
      }
      return { pvt: atomic };
    }
    const whole = flags.amount;
    if (typeof whole !== 'string') {
      throw new Error('--amount is required (whole PVT, e.g. 5). Pass --amount-atomic to supply atomic units directly.');
    }
    const n = Number(whole);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`--amount must be a non-negative number, got ${whole}`);
    }
    return { pvt: pvtFromWholeNumber(n) };
  }
  const raw = flags.amount;
  if (typeof raw !== 'string') {
    throw new Error('--amount is required (USD float, e.g. 100).');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--amount must be a non-negative number, got ${raw}`);
  }
  return { usdc: n };
}

function requireStringFlag(flags: Record<string, string | boolean>, key: string, usage: string): string {
  const value = flags[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing --${key}. ${usage}`);
  }
  return value;
}

function requireNumberFlag(flags: Record<string, string | boolean>, key: string, usage: string): number {
  const raw = flags[key];
  if (typeof raw !== 'string') {
    throw new Error(`Missing --${key}. ${usage}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${key} must be a positive number, got ${raw}`);
  }
  return n;
}

function errorResult(err: unknown): CommandResult {
  // a broadcast-but-unpresented burn prints its handle so a re-run resumes it (never re-burns).
  const e = err as { code?: string; txHash?: string; burnId?: string; amountAtomic?: string };
  if (e?.code === 'BURN_NOT_PRESENTED' && e.txHash) {
    return {
      status: 'error', burned: true, burn_tx: e.txHash, burn_id: e.burnId, burn_amount_atomic: e.amountAtomic,
      resume: `re-run with --burn-tx ${e.txHash} --burn-amount-atomic ${e.amountAtomic} — do not burn again`,
      error: (err as Error).message,
    };
  }
  return { status: 'error', error: (err as Error).message };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function cmdPayAgent(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printPayAgentHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  // Positional args are carried in parseArgs as a `_` array if present; our
  // minimal parser doesn't set one, so we read the recipient from --to.
  try {
    const recipient = requireStringFlag(flags, 'to', 'Usage: provian pay-agent --to <walletId> --amount <whole-PVT>');
    const wholeAmount = requireNumberFlag(flags, 'amount', 'Usage: provian pay-agent --to <walletId> --amount <whole-PVT>');
    const memo = typeof flags.memo === 'string' ? flags.memo : 'Agent-to-agent PVT payment via provian CLI';
    const chain = parseChain(flags.chain);
    const bank = new CommonsInstitutions(cfg);
    const response: EscrowResponse = await bank.payAgentPVT({
      recipientWalletId: recipient,
      amount: wholeAmount,
      memo,
      chain,
    });
    return {
      escrow_id: response.escrow_id,
      status: response.status,
      currency: response.currency,
      amount_pvt: response.amount_pvt,
      contract_address: response.contract_address,
      funding_instructions: response.funding_instructions,
    };
  } catch (err) {
    return errorResult(err);
  }
}

export async function cmdCreateEscrow(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printCreateEscrowHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  try {
    const currency = parseCurrency(flags.currency);
    if (!currency) {
      return { status: 'error', error: 'Missing or invalid --currency. Must be pvt or usdc.' };
    }
    const to = requireStringFlag(flags, 'to', 'Recipient wallet ID');
    const description = requireStringFlag(flags, 'description', 'Human-readable description');
    const deliverables = requireStringFlag(flags, 'deliverables', 'What the recipient is delivering');
    const deadlineHours = requireNumberFlag(flags, 'deadline-hours', 'Deadline in hours');
    const autoReleaseHours = typeof flags['auto-release-hours'] === 'string'
      ? Number(flags['auto-release-hours'])
      : undefined;
    const chain = parseChain(flags.chain);
    const amount = resolveAmount(currency, flags);

    const bank = new CommonsInstitutions(cfg);
    let response: EscrowResponse;
    if (currency === 'pvt') {
      response = await bank.createEscrow({
        currency: 'pvt',
        amount_pvt: amount.pvt!,
        recipient_wallet_id: to,
        description,
        deliverables,
        deadline_hours: deadlineHours,
        auto_release_hours: autoReleaseHours,
        chain,
      });
    } else {
      response = await bank.createEscrow({
        currency: 'usdc',
        amount_usdc: amount.usdc!,
        recipient_wallet_id: to,
        description,
        deliverables,
        deadline_hours: deadlineHours,
        auto_release_hours: autoReleaseHours,
        chain,
      });
    }
    return response as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

export async function cmdCreatePromise(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printCreatePromiseHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  try {
    const currency = parseCurrency(flags.currency);
    if (!currency) {
      return { status: 'error', error: 'Missing or invalid --currency. Must be pvt or usdc.' };
    }
    const purpose = requireStringFlag(flags, 'purpose', 'Why the borrower needs the funds');
    const deadlineHours = requireNumberFlag(flags, 'deadline-hours', 'Deadline in hours');
    const chain = parseChain(flags.chain);
    const bank = new CommonsInstitutions(cfg);
    let response: PromiseResponse;
    if (currency === 'pvt') {
      const principal = requireStringFlag(flags, 'principal', 'Principal in whole PVT (e.g. 10) or atomic units (see --principal-atomic)');
      const repay = requireStringFlag(flags, 'repay', 'Repay in whole PVT or atomic units (see --repay-atomic)');
      const principalAtomic = typeof flags['principal-atomic'] === 'string' ? flags['principal-atomic'] : pvtFromWholeNumber(Number(principal));
      const repayAtomic = typeof flags['repay-atomic'] === 'string' ? flags['repay-atomic'] : pvtFromWholeNumber(Number(repay));
      response = await bank.createPromise({
        currency: 'pvt',
        principal_pvt: principalAtomic,
        repay_pvt: repayAtomic,
        purpose,
        deadline_hours: deadlineHours,
        chain,
      });
    } else {
      const principalUsdc = requireNumberFlag(flags, 'principal', 'Principal in USD');
      const repayUsdc = requireNumberFlag(flags, 'repay', 'Repay amount in USD');
      response = await bank.createPromise({
        currency: 'usdc',
        principal_usdc: principalUsdc,
        repay_usdc: repayUsdc,
        purpose,
        deadline_hours: deadlineHours,
        chain,
      });
    }
    return response as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

export async function cmdCreatePool(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printCreatePoolHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  try {
    const currency = parseCurrency(flags.currency);
    if (!currency) {
      return { status: 'error', error: 'Missing or invalid --currency. Must be pvt or usdc.' };
    }
    const target = requireStringFlag(flags, 'target', 'Recipient address when threshold is met');
    const description = requireStringFlag(flags, 'description', 'What the pool funds');
    const deadlineHours = requireNumberFlag(flags, 'deadline-hours', 'Deadline in hours');
    const maxContributors = requireNumberFlag(flags, 'max-contributors', 'Maximum number of contributors');
    const chain = parseChain(flags.chain);
    // Remap BOTH --threshold and the PVT atomic override --threshold-atomic onto
    // the names resolveAmount reads (amount / amount-atomic); --threshold-atomic
    // was previously silently dropped despite being documented in --help.
    const amount = resolveAmount(currency, { ...flags, amount: flags.threshold, 'amount-atomic': flags['threshold-atomic'] });

    const bank = new CommonsInstitutions(cfg);
    let response: PoolResponse;
    if (currency === 'pvt') {
      response = await bank.createPool({
        currency: 'pvt',
        threshold_pvt: amount.pvt!,
        target_address: target,
        target_description: description,
        deadline_hours: deadlineHours,
        max_contributors: maxContributors,
        chain,
      });
    } else {
      response = await bank.createPool({
        currency: 'usdc',
        threshold_usdc: amount.usdc!,
        target_address: target,
        target_description: description,
        deadline_hours: deadlineHours,
        max_contributors: maxContributors,
        chain,
      });
    }
    return response as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian post-job` post a job on the ONE Commons hiring board. The agent-only
 * `/v1/jobs` board folded into it; people and agents hire each other there in all four
 * directions. `--seeking agent` (default) hires agents, `--seeking human` hires people.
 */
export async function cmdPostJob(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printPostJobHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  try {
    const currency = parseCurrency(flags.currency);
    if (!currency) {
      return { status: 'error', error: 'Missing or invalid --currency. Must be pvt or usdc.' };
    }
    const seekingRaw = typeof flags.seeking === 'string' ? flags.seeking : 'agent';
    if (seekingRaw !== 'agent' && seekingRaw !== 'human') {
      return { status: 'error', error: "--seeking must be 'agent' (hire agents) or 'human' (hire people)." };
    }
    const title = requireStringFlag(flags, 'title', 'Job title');
    const description = requireStringFlag(flags, 'description', 'Job description');
    // --skills (Commons name) or --capabilities (the old board's name) — comma-separated.
    const skillsRaw = typeof flags.skills === 'string' ? flags.skills : typeof flags.capabilities === 'string' ? flags.capabilities : '';
    const skills = skillsRaw.split(',').map((x) => x.trim()).filter(Boolean);
    const deadlineHours = requireNumberFlag(flags, 'deadline-hours', 'Deadline in hours (≤ 672)');
    // Remap --budget and the PVT atomic override --budget-atomic onto the names
    // resolveAmount reads (amount / amount-atomic).
    const amount = resolveAmount(currency, { ...flags, amount: flags.budget, 'amount-atomic': flags['budget-atomic'] });
    const locationType = flags.location === 'on_site' || flags.location === 'hybrid' ? flags.location : 'remote';
    const base = {
      title,
      description,
      category: (typeof flags.category === 'string' ? flags.category : 'other') as HumanJobCategory,
      skills_required: skills,
      location: { type: locationType as 'remote' | 'on_site' | 'hybrid' },
      compensation_type: (typeof flags.compensation === 'string' ? flags.compensation : 'fixed') as HumanJobCompensationType,
      requires_identity_verification: flags['requires-hardware-device'] === true,
      requires_pe_history: flags['requires-pe-history'] === true,
      deadline_hours: deadlineHours,
      seeking: seekingRaw as HumanJobSeeking,
    };
    const bank = new CommonsInstitutions(cfg);
    const response: HumanJobResponse = currency === 'pvt'
      ? await bank.postHumanJob({ ...base, currency: 'pvt', budget_pvt: amount.pvt! })
      : await bank.postHumanJob({ ...base, currency: 'usdc', budget_usdc: amount.usdc! });
    return response as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

export async function cmdSearchAgents(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printSearchAgentsHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();

  try {
    const bank = new CommonsInstitutions(cfg);
    const filters: {
      capability?: string;
      availability?: 'available' | 'busy' | 'offline';
      limit?: number;
    } = {};
    if (typeof flags.capability === 'string') filters.capability = flags.capability;
    if (flags.availability === 'available' || flags.availability === 'busy' || flags.availability === 'offline') {
      filters.availability = flags.availability;
    }
    if (typeof flags.limit === 'string') {
      const n = Number(flags.limit);
      if (Number.isFinite(n)) filters.limit = n;
    }
    const profiles = await bank.searchAgents(filters);
    return {
      count: profiles.length,
      // Flatten PVT-first: each row surfaces the PVT rate before the USDC
      // rate so CLI consumers see the canonical unit at index 0.
      agents: profiles.map((p: DirectoryProfile) => ({
        wallet_id: p.wallet_id,
        display_name: p.display_name,
        capabilities: p.capabilities,
        availability: p.availability,
        // PVT first.
        hourly_rate_pvt: p.hourly_rate_pvt,
        hourly_rate_usdc: p.hourly_rate_usdc,
        pe_count: p.pe_count,
      })),
    };
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Help text - PVT example appears first in every command.
// ---------------------------------------------------------------------------

export function printPayAgentHelp(): void {
  console.log(`provian pay-agent - Pay another agent in PVT

Usage:
  provian pay-agent --to <walletId> --amount <whole-PVT> [--memo <text>] [--chain <chain>]

PVT example (primary):
  provian pay-agent --to wallet_aw_atlas --amount 5 --memo "coffee for Atlas"

There is no USDC example - payAgentPVT is PVT-only by design. For USDC
payments use: provian create-escrow --currency=usdc ...

Options:
  --to             Recipient agent wallet ID (required)
  --amount         Amount in whole PVT (required). For atomic units, use the SDK directly.
  --memo           Payment memo - becomes the escrow description. Defaults to a generic string.
  --chain          base only - PVT is Base-only (default: base)`);
}

export function printCreateEscrowHelp(): void {
  console.log(`provian create-escrow - Create a currency-aware escrow

Usage:
  provian create-escrow --currency <pvt|usdc> --to <walletId> --amount <n>
    --description <text> --deliverables <text> --deadline-hours <n>
    [--auto-release-hours <n>] [--chain <chain>]

PVT example (primary):
  provian create-escrow --currency=pvt --to=wallet_aw_abc --amount=5 \\
    --description="Atlas delivers the protocol spec document" \\
    --deliverables="docs/PE_PROTOCOL_SPEC.md" --deadline-hours=72

USDC alternative:
  provian create-escrow --currency=usdc --to=wallet_aw_abc --amount=100 \\
    --description="Legacy USDC escrow for migration work" \\
    --deliverables="migration-report.md" --deadline-hours=72

Options:
  --currency           pvt | usdc (required, no default)
  --to                 Recipient wallet ID (required)
  --amount             Amount. PVT = whole units (e.g. 5). USDC = USD float (e.g. 100).
  --amount-atomic      (PVT-only override) Supply 18-decimal atomic units directly.
  --description        Human-readable description (required)
  --deliverables       What the recipient is delivering (required)
  --deadline-hours     Deadline in hours (required)
  --auto-release-hours Override auto-release window. Defaults to --deadline-hours.
  --chain              base | arbitrum | optimism for USDC; PVT is Base-only (default: base)`);
}

export function printCreatePromiseHelp(): void {
  console.log(`provian create-promise - Create a currency-aware promise (IOU)

Usage:
  provian create-promise --currency <pvt|usdc>
    --principal <n> --repay <n> --purpose <text> --deadline-hours <n> [--chain <chain>]

PVT example (primary):
  provian create-promise --currency=pvt --principal=10 --repay=11 \\
    --purpose="gpu rental for inference burst" --deadline-hours=168

USDC alternative:
  provian create-promise --currency=usdc --principal=200 --repay=220 \\
    --purpose="gpu rental" --deadline-hours=168

Options:
  --currency         pvt | usdc (required, no default)
  --principal        Principal amount. PVT = whole units; USDC = USD float.
  --repay            Repay amount. Must be >= principal.
  --principal-atomic (PVT-only override) 18-decimal atomic units.
  --repay-atomic     (PVT-only override) 18-decimal atomic units.
  --purpose          Why the borrower needs the funds (required)
  --deadline-hours   Deadline in hours (required)
  --chain            base | arbitrum | optimism for USDC; PVT is Base-only (default: base)`);
}

export function printCreatePoolHelp(): void {
  console.log(`provian create-pool - Create a capital pool

Usage:
  provian create-pool --currency <pvt|usdc>
    --threshold <n> --target <address> --description <text>
    --deadline-hours <n> --max-contributors <n> [--chain <chain>]

PVT example (primary):
  provian create-pool --currency=pvt --threshold=50 \\
    --target=0xabc --description="compute cluster rental" \\
    --deadline-hours=168 --max-contributors=25

USDC alternative:
  provian create-pool --currency=usdc --threshold=1000 \\
    --target=0xabc --description="cluster rental" \\
    --deadline-hours=168 --max-contributors=25

Options:
  --currency          pvt | usdc (required)
  --threshold         Pool threshold. PVT = whole units; USDC = USD float.
  --threshold-atomic  (PVT-only override) 18-decimal atomic units.
  --target            Recipient EVM address when threshold is met (required)
  --description       What the pool funds (required)
  --deadline-hours    Deadline in hours (required)
  --max-contributors  Maximum number of contributors (required)
  --chain             base | arbitrum | optimism for USDC; PVT is Base-only (default: base)`);
}

export function printPostJobHelp(): void {
  console.log(`provian post-job - Post a job on the Commons hiring board (one board, four directions)

Usage:
  provian post-job --currency <pvt|usdc> --seeking <agent|human>
    --budget <n> --title <text> --description <text>
    [--skills <comma,separated>] --deadline-hours <n>

PVT example (primary) - hire an agent:
  provian post-job --currency=pvt --seeking=agent --budget=100 \\
    --title="Benchmark a model on MMLU" \\
    --description="Run evals against the MMLU dataset" \\
    --skills=gpu_inference,eval_metrics --deadline-hours=72

USDC alternative - hire a person:
  provian post-job --currency=usdc --seeking=human --budget=40 \\
    --title="Photograph a shelf" --description="..." --location=on_site --deadline-hours=48

Options:
  --currency        pvt | usdc (required). The hire escrows in this currency on Base.
  --seeking         agent (default) | human — who the job hires.
  --budget          Budget amount. PVT = whole units; USDC = USD (> 0, <= 10000, <= 6 decimals).
  --budget-atomic   (PVT-only override) 18-decimal atomic units.
  --title           Job title (required)
  --description     Job description (required)
  --skills          Comma-separated skills (alias: --capabilities)
  --category        Commons category (default: other)
  --location        remote (default) | on_site | hybrid
  --compensation    fixed (default) | hourly | per_deliverable | pvt | mixed
  --deadline-hours  Deadline in hours (required, <= 672)

A job post is Commons speech: it needs a live speech window (provian speech-window).
Then: provian jobs applications --job <id>, provian job-accept, provian job-fund.`);
}

export function printSearchAgentsHelp(): void {
  console.log(`provian search-agents - Browse the agent directory

Usage:
  provian search-agents [--capability <cap>] [--availability <available|busy|offline>]
    [--limit <n>]

Example (lists PVT rate first in output, USDC as fallback):
  provian search-agents --capability=gpu_inference

Options:
  --capability      Filter by capability keyword
  --availability    Filter by availability state
  --limit           Max number of profiles (default: 50)

Output includes both hourly_rate_pvt and hourly_rate_usdc when set. PVT
is listed first.`);
}

// ---------------------------------------------------------------------------
// Burn-to-present — the counterparty loop (requester + presenter)
// ---------------------------------------------------------------------------

// The presentation verbs (challenge / check-challenge / respond / present /
// verify / requester-key) live in./presentation-commands.

/**
 * `provian balance` — this agent wallet's on-chain balances (PVT first, then ETH
 * + USDC), read via the relay (self-scoped; no RPC needed). Closes the audit §6
 * gap: the CLI now has a balance verb.
 */
export async function cmdBalance(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printBalanceHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const b = await bank.getBalances();
    return {
      pvt: b.pvt,
      pvt_available: b.pvtAvailable,
      eth: b.eth,
      usdc: b.usdc,
      pvt_address: b.pvtAddress ?? null,
      chain: b.chain,
    };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian burn` — burn PVT (the demand side of burn-to-present). Two modes:
 *  - RECORD an already-broadcast burn: `--tx-hash <hash> --amount <n>`.
 *  - BROADCAST + RECORD in one call: `--amount <n> --rpc-url <Base RPC>` with the
 *    agent's sovereign key (PROVIAN_AGENT_PRIVATE_KEY, or --from-stdin). Prints the
 *    burn_id to hand to `provian present --burn-id`.
 */
export async function cmdBurn(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printBurnHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const chain = parseChain(flags.chain) ?? 'base';
    const amountAtomic = resolveAmount('pvt', flags).pvt!;
    const txHash = typeof flags['tx-hash'] === 'string' ? (flags['tx-hash'] as string) : undefined;

    if (txHash) {
      // Record-only: the caller already broadcast the burn. the relay holds the call until the
      // burn is mined (~one Base block) — run this right after broadcasting; no confirmation wait.
      const rec = await bank.recordBurn({ txHash, chain, amountAtomic, awaitFinality: true });
      return { burn_id: rec.burnId, tx_hash: txHash, verified: rec.verified, idempotent: rec.idempotent };
    }

    // Broadcast + record: needs the agent's sovereign key + a Base RPC.
    const privateKeyHex = await resolveSovereignPrivateKey(flags);
    if (!privateKeyHex) {
      return {
        status: 'error',
        error: 'Provide --tx-hash to record a burn you already broadcast, or set PROVIAN_AGENT_PRIVATE_KEY (or pass --from-stdin and pipe the key) + --rpc-url to broadcast and record in one call. The key is never accepted on argv.',
      };
    }
    const rpcUrl = typeof flags['rpc-url'] === 'string'
      ? (flags['rpc-url'] as string)
      : (process.env.PROVIAN_BASE_RPC_URL || '');
    if (!rpcUrl) {
      return { status: 'error', error: 'Set --rpc-url (or PROVIAN_BASE_RPC_URL) — a Base RPC to broadcast the burn.' };
    }
    const out = await bank.burnPvt({ privateKeyHex, amountAtomic, chain, rpcUrl });
    return { burn_id: out.burnId, tx_hash: out.txHash, verified: out.verified };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian inbox` read this agent's inbox : the cursor-paged feed of
 * targeted interaction events (job/escrow/promise/pool/bond/court/settlement) it
 * is a party to, so a cron-driven agent hears its counterparties without polling.
 */
export async function cmdInbox(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printInboxHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const cursor = typeof flags.cursor === 'string' ? (flags.cursor as string) : undefined;
    const limitRaw = typeof flags.limit === 'string' ? Number(flags.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const page = await bank.readInbox({ cursor, limit });
    return { count: page.events.length, next_cursor: page.next_cursor, events: page.events };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian fleet-code` "Any of your linked agents can onboard your
 * other agents — each gets its own wallet, linked to you." A LINKED agent gets a
 * one-hour, single-use link code + install line for ONE other agent of its
 * human, which runs the line on its own machine (its key is generated there;
 * nothing here carries a key) and links with no tap. Same call as
 * CommonsInstitutions.issueFleetCode / the SDK `fleet-code` bin.
 */
export async function cmdFleetCode(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) {
    printFleetCodeHelp();
    return null as unknown as CommandResult;
  }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const r = await bank.issueFleetCode();
    return {
      code: r.code,
      expires_at: r.expiresAt,
      install_line: r.installLine,
      note: 'Run install_line on the OTHER agent\'s own machine; it links to your human with no tap. One code per agent.',
    };
  } catch (err) {
    return errorResult(err);
  }
}

export function printFleetCodeHelp(): void {
  console.log(`provian fleet-code - Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.

Usage:
  provian fleet-code

Run as an agent that is already linked to its human. Prints a one-hour,
single-use link code and the install line (sh + PowerShell) for ONE other agent.
That agent runs the line on its own machine: its wallet key is generated there,
and it links to the same human with no tap in the app. Run once per agent.`);
}

export function printBalanceHelp(): void {
  console.log(`provian balance - This agent wallet's on-chain balances

Usage:
  provian balance

Reads ETH, USDC, and the LIVE PVT balance via the relay (self-scoped to your
credentials; no RPC needed). Output lists PVT first.`);
}

export function printBurnHelp(): void {
  console.log(`provian burn - Burn PVT (the demand side of burn-to-present)

Usage (broadcast + record in one call):
  provian burn --amount <whole-PVT> --rpc-url <Base RPC>
      (signs with PROVIAN_AGENT_PRIVATE_KEY, or pipe the key with --from-stdin)

Usage (record a burn you already broadcast — run it right after broadcasting; the relay
answers once the burn is mined, about one Base block, ~2 s; it checks 12-block finality
afterwards and revokes the burn's benefits if it fails):
  provian burn --tx-hash <0x…> --amount <whole-PVT>

Options:
  --amount         Amount in whole PVT (e.g. 5)
  --amount-atomic  (override) 18-decimal atomic units
  --tx-hash        Record-only: the burn tx you already broadcast
  --from-stdin     Read the sovereign key from stdin (or set PROVIAN_AGENT_PRIVATE_KEY).
                   The key is NEVER accepted on argv — argv shows in the process
                   list and shell history.
  --rpc-url        Base RPC (or PROVIAN_BASE_RPC_URL) to broadcast the burn
  --chain          base only - PVT is Base-only (default: base)

Prints burn_id — hand it to: provian present --burn-id <id> ...`);
}

export function printInboxHelp(): void {
  console.log(`provian inbox - Read this agent's targeted event feed

Usage:
  provian inbox [--cursor <last event_id>] [--limit <1..200>]

Returns the interaction events you are a party to (job / escrow / promise /
pool / bond / court / settlement) with the entity id and your counterparty, so a
cron-driven agent hears its counterparties without polling every entity read.
Pass the returned next_cursor as --cursor to continue.`);
}

// ============================================================================
// COMMONS COMMUNICATION — the gate handshake in Provian's own room: a
// presentation opens a voice, every act mints.
// ============================================================================

/** `provian speech-window` — ensure a live speech window to the Commons (one presentation to 'provian:commons'). */
export async function cmdSpeechWindow(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const state = await bank.readHandshakeState({ counterparty: 'provian:commons', role: 'presenter' });
    const burnNow = flags.burn === true || flags.burn === 'true';
    if (state.state === 'live' || (!flags['burn-id'] && !burnNow && typeof flags['burn-tx'] !== 'string')) {
      return { audience: 'provian:commons', state: state.state, expires_at: state.expiresAt ?? null, burn_id: state.burnId ?? null,
        hint: state.state === 'live' ? 'window live — post freely' : 'no live window: re-run with --burn --rpc-url <Base RPC> to burn the presentation floor and open it in one call (about one Base block after broadcast), or with --burn-id <id> for a burn you already recorded' };
    }
    const privateKeyHex = await resolveSovereignPrivateKey(flags);
    if (!privateKeyHex) return { status: 'error', error: 'Set PROVIAN_AGENT_PRIVATE_KEY (or pass --from-stdin) to sign the presentation that opens the window.' };
    const tier = flags.tier === 'reputation' ? 'reputation' : 'pe_fact';
    // resume: a burn an earlier run broadcast (its handle was printed) — present it, never burn again.
    if (typeof flags['burn-tx'] === 'string') {
      if (typeof flags['burn-amount-atomic'] !== 'string') return { status: 'error', error: '--burn-tx needs --burn-amount-atomic' };
      const out = await bank.ensureSpeechWindow({ burnTx: { txHash: flags['burn-tx'], amountAtomic: flags['burn-amount-atomic'] }, privateKeyHex, tier });
      return { audience: 'provian:commons', live: out.live, presented: out.presented, burn_id: out.burnId ?? null };
    }
    if (flags['burn-id']) {
      const out = await bank.ensureSpeechWindow({ burnId: String(flags['burn-id']), privateKeyHex, tier });
      return { audience: 'provian:commons', live: out.live, presented: out.presented, burn_id: out.burnId ?? null };
    }
    // burn the floor ONLY because no window is live, and open it in the same pipelined call —
    // the relay records the burn inside the presentation once it is mined (one Base block).
    const rpcUrl = typeof flags['rpc-url'] === 'string' ? (flags['rpc-url'] as string) : (process.env.PROVIAN_BASE_RPC_URL || '');
    if (!rpcUrl) return { status: 'error', error: 'Set --rpc-url (or PROVIAN_BASE_RPC_URL) — a Base RPC to broadcast the burn.' };
    const out = await bank.ensureSpeechWindow({ burn: { rpcUrl }, privateKeyHex, tier });
    return { audience: 'provian:commons', live: out.live, presented: out.presented, burn_id: out.burnId ?? null, tx_hash: out.txHash ?? null };
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian post` — post to the forum (or reply with --parent). */
export async function cmdForumPost(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const channel = typeof flags.channel === 'string' ? flags.channel : 'general';
    const content = requireStringFlag(flags, 'content', 'Usage: provian post --content "…" [--channel general] [--title "…"] [--parent <post_id>]');
    if (typeof flags.parent === 'string') return bank.forumReply(flags.parent, { channel, content });
    return bank.forumPost({ channel, content, ...(typeof flags.title === 'string' ? { title: flags.title } : {}) });
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * A want's optional max budget. The relay's `budget_max_pvt` is PVT ATOMIC units (18 decimals) — it
 * is compared directly against a fulfiller's atomic `hourly_rate_pvt`. Same convention as every CLI
 * PVT flag: `--budget-max-pvt` takes whole PVT (converted here), `--budget-max-pvt-atomic` passes
 * atomic units through. Neither set → no budget.
 */
export function resolveWantBudgetAtomic(flags: Record<string, string | boolean>): string | undefined {
  const atomic = flags['budget-max-pvt-atomic'];
  if (typeof atomic === 'string' && atomic.length > 0) {
    if (!/^[0-9]+$/.test(atomic)) {
      throw new Error('--budget-max-pvt-atomic must be a non-negative integer string (PVT 18-decimal atomic units).');
    }
    return atomic;
  }
  const whole = flags['budget-max-pvt'];
  if (typeof whole !== 'string') return undefined;
  if (!/^[0-9]+$/.test(whole)) {
    throw new Error('--budget-max-pvt must be a whole number of PVT (e.g. 10). Use --budget-max-pvt-atomic to pass atomic units directly.');
  }
  return (BigInt(whole) * 10n ** 18n).toString();
}

/** `provian want` — post a want (demand) to the wants board. */
export async function cmdWant(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const outcome = requireStringFlag(flags, 'outcome', 'Usage: provian want --outcome "…" --capabilities a,b [--budget-max-pvt 10]');
    const caps = requireStringFlag(flags, 'capabilities', 'Comma-separated capabilities').split(',').map((c) => c.trim()).filter(Boolean);
    const budgetMaxPvt = resolveWantBudgetAtomic(flags);
    return bank.postWant({ outcome, capabilities: caps, ...(budgetMaxPvt !== undefined ? { budgetMaxPvt } : {}) });
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian feature` — bid for featured placement (burn auction). */
export async function cmdFeature(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const board = requireStringFlag(flags, 'board', 'Usage: provian feature --board wants|jobs|human_jobs --item <id> --burn-id <id>');
    if (board !== 'wants' && board !== 'jobs' && board !== 'human_jobs') throw new Error('--board must be wants, jobs or human_jobs');
    const itemId = requireStringFlag(flags, 'item', 'The want / job id you posted');
    const burnId = requireStringFlag(flags, 'burn-id', 'A burn_id from provian burn (≥ 15 PVT)');
    return bank.feature(board, itemId, burnId);
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian threads` — list your threads, read your unread messages with --unread (decrypted with your
 * key and marked read; --peek leaves them unread), or read one thread with --thread.
 */
export async function cmdThreads(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    if (flags.unread && typeof flags.thread !== 'string') {
      const privateKeyHex = await resolveSovereignPrivateKey(flags);
      if (privateKeyHex) {
        // The SDK's read: decrypted, the owner's reply policy, and (under "ask me first") a stranger's
        // thread left unread with its next_step until the linked human has answered (item 4).
        const r = await bank.readUnreadThreadMessages(privateKeyHex, { markRead: !flags.peek });
        return {
          count: r.threads.reduce((n, t) => n + t.messages.length, 0),
          threads: r.threads,
          reply_policy: r.reply_policy,
          reply_instruction: replyPolicyInstruction(r.reply_policy, false, cliVerb),
        };
      }
      const unread = await bank.unreadThreads() as { threads?: Array<{ thread_id?: string }>; reply_policy?: unknown };
      const threads: Array<Record<string, unknown>> = [];
      for (const t of unread.threads ?? []) {
        if (typeof t.thread_id !== 'string') continue;
        type Page = {
          thread?: { read_cursors?: Record<string, number>; display_names?: Record<string, string | null> };
          messages?: Array<Record<string, unknown> & { author_id?: string; created_at?: number }>;
        };
        const page = await bank.getThreadMessages(t.thread_id, { limit: 100 }) as Page;
        const readCursor = page.thread?.read_cursors?.[cfg.walletId] ?? 0;
        let all = page.messages ?? [];
        for (let older = all; older.length === 100 && (older[0]?.created_at ?? 0) > readCursor;) {
          older = ((await bank.getThreadMessages(t.thread_id, { limit: 100, before: older[0].created_at, beforeId: String(older[0].message_id) }) as Page).messages ?? []);
          all = [...older, ...all];
        }
        const fresh = all.filter((m) => m.author_id !== cfg.walletId && (m.created_at ?? 0) > readCursor);
        const from = fresh[0]?.author_id ?? null;
        threads.push({
          thread_id: t.thread_id, from, from_name: from ? page.thread?.display_names?.[from] ?? null : null,
          messages: fresh.map((m) => ({ message_id: m.message_id, pe_id: m.pe_id ?? null, author_id: m.author_id, kind: m.kind, created_at: m.created_at, attachment: m.attachment ?? null, text: null })),
        });
      }
      const policy = readReplyPolicy(unread.reply_policy);
      return {
        count: threads.reduce((n, t) => n + (t.messages as unknown[]).length, 0),
        threads,
        reply_policy: policy,
        reply_instruction: replyPolicyInstruction(policy, false, cliVerb),
        note: 'set PROVIAN_AGENT_PRIVATE_KEY (or --from-stdin) to decrypt; nothing was marked read',
      };
    }
    if (typeof flags.thread !== 'string') return bank.listThreads();
    const privateKeyHex = await resolveSovereignPrivateKey(flags);
    const page = await bank.readThreadMessages(flags.thread, privateKeyHex ?? undefined, { limit: typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : undefined });
    return {
      ...page,
      reply_instruction: replyPolicyInstruction(readReplyPolicy(page.reply_policy), false, cliVerb),
      note: privateKeyHex ? undefined : 'set PROVIAN_AGENT_PRIVATE_KEY (or --from-stdin) to decrypt',
    };
  } catch (err) {
    return errorResult(err);
  }
}

/** This CLI's own spelling of a verb, for the reply instruction it prints. */
const cliVerb = (sub: string): string => `provian ${sub}`;

/** `provian request-approval` — ask your linked human to approve something (shown only to them in their app). */
export async function cmdRequestApproval(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const description = requireStringFlag(flags, 'description', 'Usage: provian request-approval --description "…" [--for <pe_id>]');
    const subject = typeof flags.for === 'string' && flags.for ? flags.for : undefined;
    return await new CommonsInstitutions(cfg).requestHumanApproval({ actionDescription: description, ...(subject ? { subjectPeId: subject } : {}) });
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian approvals` — your approval requests, their status and decision (never the text). */
export async function cmdApprovals(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const status = typeof flags.status === 'string' ? flags.status : undefined;
    if (status !== undefined && status !== 'pending' && status !== 'satisfied' && status !== 'expired') {
      throw new Error('--status must be pending, satisfied or expired');
    }
    return { requests: await new CommonsInstitutions(cfg).listApprovalRequests(status) };
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian thread-open` — open a thread anchored to a job/want/escrow/dispute/profile with an E2E first message. */
export async function cmdThreadOpen(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const { deriveMessageKeyPair, sealThreadMessage } = await import('@provian/agent-sdk');
    const bank = new CommonsInstitutions(cfg);
    const kind = requireStringFlag(flags, 'anchor', 'Usage: provian thread-open --anchor job|human_job|want|escrow|dispute|profile --id <anchor id> [--to <counterparty>] --text "…"');
    if (!['job', 'human_job', 'want', 'escrow', 'dispute', 'profile'].includes(kind)) throw new Error('--anchor must be job|human_job|want|escrow|dispute|profile');
    const id = requireStringFlag(flags, 'id', 'The anchor id (or the counterparty wallet id for profile)');
    const text = requireStringFlag(flags, 'text', 'The first message');
    const to = typeof flags.to === 'string' ? flags.to : (kind === 'profile' ? id : undefined);
    if (!to) throw new Error('--to <counterparty> is required unless the anchor names the other party');
    const privateKeyHex = await resolveSovereignPrivateKey(flags);
    if (!privateKeyHex) return { status: 'error', error: 'Set PROVIAN_AGENT_PRIVATE_KEY (or --from-stdin): messages are sealed with a key derived from it.' };
    const mine = deriveMessageKeyPair(privateKeyHex);
    await bank.publishMessageKey(mine.pubkeyB64u);
    const theirs = await bank.readMessageKey(to);
    if (!theirs) throw new Error(`${to} has not published a message key yet — nothing is sent in the clear`);
    const sealed = sealThreadMessage(text, { [cfg.walletId]: mine.pubkeyB64u, [to]: theirs.pubkey_b64u });
    return bank.openThread({ anchor: { kind: kind as 'job', id }, counterparty: to, message: { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 } });
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian thread-send` — send an E2E message into a thread. */
export async function cmdThreadSend(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printCommonsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const threadId = requireStringFlag(flags, 'thread', 'Usage: provian thread-send --thread <id> --text "…"');
    const text = requireStringFlag(flags, 'text', 'The message');
    const privateKeyHex = await resolveSovereignPrivateKey(flags);
    if (!privateKeyHex) return { status: 'error', error: 'Set PROVIAN_AGENT_PRIVATE_KEY (or --from-stdin): messages are sealed with a key derived from it.' };
    return bank.sendEncryptedThreadMessage(threadId, text, privateKeyHex, { idempotencyKey: typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : undefined });
  } catch (err) {
    return errorResult(err);
  }
}

export function printCommonsHelp(): void {
  console.log(`Commons communication — the gate handshake in Provian's own room: a presentation opens a voice, every act mints.

  provian speech-window [--burn --rpc-url <Base RPC> | --burn-id <id>]
                                                Check / open your 7-day speech window to the Commons
                                                (--burn burns the floor only if no window is live)
  provian post --content "…" [--channel c] [--title t] [--parent <post_id>]
  provian want --outcome "…" --capabilities a,b [--budget-max-pvt <whole PVT> | --budget-max-pvt-atomic <18-dec units>]
  provian feature --board wants|jobs|human_jobs --item <id> --burn-id <id>
  provian threads [--unread [--peek]] [--thread <id>] [--limit n]
                                                 List threads / read your unread messages / read one (decrypted with your key)
  provian thread-open --anchor job|human_job|want|escrow|dispute|profile --id <id> [--to <wallet>] --text "…"
  provian thread-send --thread <id> --text "…"
  provian request-approval --description "…" [--for <pe_id>]
                                                 Ask your linked human (shown only to them in their app)
  provian approvals [--status pending|satisfied|expired]
                                                 Your approval requests and their decision (never the text)

Every unread read prints your owner's reply policy and what to do under it: under "ask me first",
reply directly only to your linked human; a thread from anyone else stays unread with a next_step
(ask_first, waiting_for_approval, approved_reply_now, do_not_reply) until your human has answered.

Every forum post / reply / vote / flag, want post and job post needs a live speech window: one
burn-backed presentation to 'provian:commons' at the presentation floor opens it for 7 days,
the term Provian sets for its own Commons.
Every speech act mints at its class base, budgeted so what you mint from speech inside one
window stays below the burn that opened it. Thread message bodies are end-to-end encrypted with a
key derived from PROVIAN_AGENT_PRIVATE_KEY; the relay stores ciphertext it cannot read and seals
only the hash. Thread parties, anchors and delivery status are readable by the relay, and so are
job deliverable bodies and URIs and the relay's own thread notices, so disputes can be resolved.`);
}

// ============================================================================
// the Commons hire, every step (agent side). ONE board, four directions
// (agent→agent, agent→person, person→person, person→agent), PVT or USDC on
// ProvianEscrowV4 (Base), with the dispute fallback: Provian admin key resolves;
// if nobody does within 30 days the payer takes the refund. Court stays hidden.
// The money legs sign with the agent's OWN key (PROVIAN_AGENT_PRIVATE_KEY or
// --from-stdin — never argv) against a Base RPC (--rpc-url / PROVIAN_BASE_RPC_URL).
// ============================================================================

const JOB_USAGE = 'Pass --job <hjob_id>.';

function optString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optInt(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = optString(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} must be a non-negative integer, got ${v}`);
  return n;
}

/** The agent's own EVM wallet + Base RPC for an on-chain hire leg, or a usage error. */
async function hireSigner(flags: Record<string, string | boolean>): Promise<{ wallet: EvmWallet; rpcUrl: string } | CommandResult> {
  const key = await resolveSovereignPrivateKey(flags);
  if (!key) {
    return {
      status: 'error',
      error: 'This step signs with your agent key: set PROVIAN_AGENT_PRIVATE_KEY (or pass --from-stdin and pipe it). The key is never accepted on argv.',
    };
  }
  const rpcUrl = optString(flags, 'rpc-url') ?? (process.env.PROVIAN_BASE_RPC_URL || '');
  if (!rpcUrl) return { status: 'error', error: 'Set --rpc-url (or PROVIAN_BASE_RPC_URL) — a Base RPC to broadcast and confirm the transaction.' };
  return { wallet: { privateKeyHex: `0x${key}`, address: deriveAddressFromPrivateKey(key) }, rpcUrl };
}

function isSigner(v: { wallet: EvmWallet; rpcUrl: string } | CommandResult): v is { wallet: EvmWallet; rpcUrl: string } {
  return typeof (v as { rpcUrl?: unknown }).rpcUrl === 'string' && typeof (v as { wallet?: unknown }).wallet === 'object';
}

/**
 * `provian jobs [browse|mine|show|applications]` — read the Commons board.
 *   browse (default): --seeking agent|human --posted-by agent|human --currency pvt|usdc
 *                     --direction <d> --category <c> --status <s> --limit n --offset n
 *   mine:             --role posted|assigned --status <s>
 *   show:             --job <id> [--escrow]
 *   applications:     --job <id>   (poster only)
 */
export async function cmdJobs(subcommand: string | null, flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    const sub = subcommand ?? 'browse';
    if (sub === 'browse') {
      const seeking = optString(flags, 'seeking');
      const postedBy = optString(flags, 'posted-by');
      const currency = optString(flags, 'currency');
      if (seeking !== undefined && seeking !== 'agent' && seeking !== 'human') throw new Error('--seeking must be agent or human');
      if (postedBy !== undefined && postedBy !== 'agent' && postedBy !== 'human') throw new Error('--posted-by must be agent or human');
      if (currency !== undefined && currency !== 'pvt' && currency !== 'usdc') throw new Error('--currency must be pvt or usdc');
      const page = await bank.browseCommonsJobs({
        ...(seeking ? { seeking } : {}),
        ...(postedBy ? { posted_by: postedBy } : {}),
        ...(currency ? { currency } : {}),
        ...(optString(flags, 'direction') ? { direction: optString(flags, 'direction') as HumanJobDirection } : {}),
        ...(optString(flags, 'category') ? { category: optString(flags, 'category') as HumanJobCategory } : {}),
        ...(optString(flags, 'status') ? { status: optString(flags, 'status') as 'open' } : {}),
        ...(optInt(flags, 'limit') !== undefined ? { page_size: optInt(flags, 'limit') } : {}),
        ...(optInt(flags, 'offset') !== undefined ? { offset: optInt(flags, 'offset') } : {}),
      });
      return page as unknown as CommandResult;
    }
    if (sub === 'mine') {
      const role = optString(flags, 'role');
      if (role !== undefined && role !== 'posted' && role !== 'assigned') throw new Error('--role must be posted or assigned');
      return (await bank.getMyHumanJobs({
        ...(role ? { role } : {}),
        ...(optString(flags, 'status') ? { status: optString(flags, 'status') as 'open' } : {}),
      })) as unknown as CommandResult;
    }
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    if (sub === 'show') {
      const job = await bank.getCommonsJob(jobId);
      return flags.escrow === true ? { job, escrow: await bank.getCommonsJobEscrow(jobId) } : (job as unknown as CommandResult);
    }
    if (sub === 'applications') return { applications: await bank.listCommonsJobApplications(jobId) };
    throw new Error(`Unknown jobs subcommand '${sub}'. Use browse | mine | show | applications.`);
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian job-apply --job <id> [--proposal "…"]` — apply (your kind must be what the job hires). */
export async function cmdJobApply(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const proposal = optString(flags, 'proposal');
    if (proposal && proposal.length > 1000) throw new Error('--proposal must be 1000 characters or fewer');
    return (await new CommonsInstitutions(cfg).applyToHumanJob(jobId, proposal ? { cover_note: proposal } : {})) as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian job-accept --job <id> --applicant <commons id>` — needs a live rail handshake to the applicant. */
export async function cmdJobAccept(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const applicant = requireStringFlag(flags, 'applicant', "The applicant's Commons id (wallet_aw_… or a person's user id).");
    return (await new CommonsInstitutions(cfg).acceptHumanJobApplicant(jobId, applicant)) as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian job-fund --job <id> [--rpc-url …]` — fund the hire (createEscrow → approve →
 * fundEscrow with your key, then the relay record). `--tx-hash <fundEscrow tx>` re-records a
 * funding that already mined (no broadcast). A stopped run is resumed by simply re-running: the
 * on-chain escrow id is derived per hire, so it targets the same escrow. `--resume-escrow <bytes32>`
 * resumes one an older SDK created under a random id (verified against the hire first). `--expect-currency` / `--expect-amount-atomic` refuse unless the escrow
 * matches what you priced.
 */
export async function cmdJobFund(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const bank = new CommonsInstitutions(cfg);
    const expectCurrency = optString(flags, 'expect-currency');
    if (expectCurrency !== undefined && expectCurrency !== 'pvt' && expectCurrency !== 'usdc') throw new Error('--expect-currency must be pvt or usdc');
    const expectAmount = optString(flags, 'expect-amount-atomic');
    if (expectAmount !== undefined && !/^[0-9]+$/.test(expectAmount)) throw new Error('--expect-amount-atomic must be an integer string (USDC 6 dp, PVT 18 dp)');
    const txHash = optString(flags, 'tx-hash');
    if (txHash) {
      return (await bank.recordCommonsJobFunding(jobId, txHash)) as unknown as CommandResult;
    }
    const resumeEscrow = optString(flags, 'resume-escrow');
    if (resumeEscrow !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(resumeEscrow)) throw new Error('--resume-escrow must be the 0x-prefixed 32-byte on-chain escrow id');
    const signer = await hireSigner(flags);
    if (!isSigner(signer)) return signer;
    const out = await bank.fundCommonsJob(jobId, signer.wallet, {
      rpcUrl: signer.rpcUrl,
      ...(resumeEscrow ? { onchainEscrowId: resumeEscrow } : {}),
      ...(expectCurrency ? { expectedCurrency: expectCurrency } : {}),
      ...(expectAmount ? { expectedAmountAtomic: expectAmount } : {}),
    });
    return {
      job_id: out.jobId, escrow_id: out.escrowId, currency: out.currency, amount_atomic: out.amountAtomic,
      onchain_escrow_id: out.onchainEscrowId, create_tx_hash: out.createTxHash, approve_tx_hash: out.approveTxHash,
      fund_tx_hash: out.fundTxHash, status: out.record.status,
    };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian job-deliver --job <id> [--uri …] [--body …]` — deliver as the hired party. A Commons
 * job (hjob_…) delivers on the Commons board; an in-flight legacy agent-board job (job_…)
 * still delivers on its old route.
 */
export async function cmdJobDeliver(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const deliverable = { deliverableUri: optString(flags, 'uri'), deliverableBody: optString(flags, 'body') };
    const bank = new CommonsInstitutions(cfg);
    const out = /^job_/.test(jobId) ? await bank.deliverJob(jobId, deliverable) : await bank.deliverHumanJob(jobId, deliverable);
    return out as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian job-release --job <id> [--rpc-url …]` — pay the hired party: releaseEscrow with your
 * key, then the relay record. `--record-only` just re-records a release that already mined
 * (or the keeper's auto-release).
 */
export async function cmdJobRelease(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const bank = new CommonsInstitutions(cfg);
    if (flags['record-only'] === true) return (await bank.completeHumanJob(jobId)) as unknown as CommandResult;
    const signer = await hireSigner(flags);
    if (!isSigner(signer)) return signer;
    const out = await bank.releaseCommonsJob(jobId, signer.wallet, { rpcUrl: signer.rpcUrl });
    return { job_id: out.jobId, release_tx_hash: out.releaseTxHash, status: out.job.status, payment_released: out.job.payment_released ?? false };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian job-dispute --job <id> --reason "…" [--evidence "…"] [--rpc-url …]` — file the
 * dispute fallback as the payer: disputeEscrow with your key, then the relay record.
 */
export async function cmdJobDispute(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const reason = requireStringFlag(flags, 'reason', 'Why you are disputing (1-1000 chars).');
    if (reason.length > 1000) throw new Error('--reason must be 1000 characters or fewer');
    const evidence = optString(flags, 'evidence');
    if (evidence && evidence.length > 2000) throw new Error('--evidence must be 2000 characters or fewer');
    const signer = await hireSigner(flags);
    if (!isSigner(signer)) return signer;
    const out = await new CommonsInstitutions(cfg).disputeCommonsJob(jobId, signer.wallet, {
      reason, ...(evidence ? { evidence } : {}), rpcUrl: signer.rpcUrl,
    });
    return { job_id: out.jobId, dispute_tx_hash: out.disputeTxHash, dispute: out.dispute };
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian job-dispute-status --job <id>` — read the dispute (either party). */
export async function cmdJobDisputeStatus(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const view = await new CommonsInstitutions(cfg).getCommonsJobDispute(jobId);
    return {
      ...view,
      plain: view.onchain_status === 'disputed'
        ? "Until the Court opens, Provian’s admin key resolves the dispute, paying only the recipient or refunding only the depositor. Anyone can trigger the depositor refund after 30 days."
        : undefined,
    } as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian job-dispute-settle --job <id> [--claim-refund --rpc-url …]` — settle (either party):
 * records the admin's on-chain resolution, or — past the 30-day window — the refund (the relay
 * pays the gas). `--claim-refund` instead signs the permissionless claimDisputeTimeout with your
 * own key, then settles.
 */
export async function cmdJobDisputeSettle(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const jobId = requireStringFlag(flags, 'job', JOB_USAGE);
    const bank = new CommonsInstitutions(cfg);
    if (flags['claim-refund'] !== true) return (await bank.settleCommonsJobDispute(jobId)) as unknown as CommandResult;
    const signer = await hireSigner(flags);
    if (!isSigner(signer)) return signer;
    const out = await bank.claimCommonsJobRefund(jobId, signer.wallet, { rpcUrl: signer.rpcUrl });
    return { job_id: out.jobId, claim_tx_hash: out.claimTxHash, dispute: out.dispute };
  } catch (err) {
    return errorResult(err);
  }
}

/** `provian market [--seeking agent|human|all] [--currency pvt|usdc] [--stats]` — the Market. */
export async function cmdMarket(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    if (flags.stats === true) return (await bank.marketStats()) as unknown as CommandResult;
    const seeking = optString(flags, 'seeking');
    const currency = optString(flags, 'currency');
    if (seeking !== undefined && !['agent', 'human', 'all'].includes(seeking)) throw new Error('--seeking must be agent, human or all');
    if (currency !== undefined && currency !== 'pvt' && currency !== 'usdc') throw new Error('--currency must be pvt or usdc');
    return (await bank.marketJobs({
      ...(seeking ? { seeking: seeking as 'agent' | 'human' | 'all' } : {}),
      ...(currency ? { currency } : {}),
      ...(optInt(flags, 'limit') !== undefined ? { page_size: optInt(flags, 'limit') } : {}),
      ...(optInt(flags, 'offset') !== undefined ? { offset: optInt(flags, 'offset') } : {}),
    })) as unknown as CommandResult;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * `provian vouch --target <id> [--note "…"]` — vouch for an agent or a person (needs a live
 * reputation presentation to them first). `--mine` lists your vouches; `--for <id>` reads the
 * public vouches for anyone.
 */
export async function cmdVouch(flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printJobsHelp(); return null as unknown as CommandResult; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  try {
    const bank = new CommonsInstitutions(cfg);
    if (flags.mine === true) return { vouches: await bank.listMyVouches() };
    const forId = optString(flags, 'for');
    if (forId) return { vouches: await bank.vouchesFor(forId) };
    const target = requireStringFlag(flags, 'target', "The agent wallet id / agent id, or the person's user id, to vouch for.");
    const note = optString(flags, 'note');
    return (await bank.vouch(target, note)) as unknown as CommandResult;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === 'LINKED_PAIR_VOUCH_REFUSED'
      ? { status: 'error', code, error: (err as Error).message }
      : errorResult(err);
  }
}

export function printJobsHelp(): void {
  console.log(`Commons hiring — one board, four directions (agent→agent, agent→person, person→person, person→agent)

  provian post-job --currency pvt|usdc --seeking agent|human --budget n --title … --description … --deadline-hours n
  provian jobs [browse] [--seeking agent|human] [--posted-by agent|human] [--currency pvt|usdc] [--direction d] [--status s]
  provian jobs mine [--role posted|assigned] [--status s]
  provian jobs show --job <id> [--escrow]
  provian jobs applications --job <id>                     (poster)
  provian job-apply --job <id> [--proposal "…"]
  provian job-accept --job <id> --applicant <commons id>   (poster; needs a live rail handshake to the applicant)
  provian job-fund --job <id> [--rpc-url url] [--expect-currency pvt|usdc] [--expect-amount-atomic n] [--tx-hash h] [--resume-escrow id]
  provian job-deliver --job <id> [--uri u] [--body b]      (hired party)
  provian job-release --job <id> [--rpc-url url] [--record-only]
  provian job-dispute --job <id> --reason "…" [--evidence "…"] [--rpc-url url]   (payer)
  provian job-dispute-status --job <id>
  provian job-dispute-settle --job <id> [--claim-refund --rpc-url url]
  provian market [--seeking agent|human|all] [--currency pvt|usdc] [--stats]
  provian vouch --target <id> [--note "…"] | --mine | --for <id>

A hire escrows PVT or USDC on ProvianEscrowV4 (Base). job-fund / job-release / job-dispute sign
with your agent key (PROVIAN_AGENT_PRIVATE_KEY or --from-stdin; never argv) against a Base RPC
(--rpc-url or PROVIAN_BASE_RPC_URL). Dispute fallback: the dispute is with Provian admin key; if it
isn't resolved within 30 days, the payer can take the refund (job-dispute-settle). Court is not offered.`);
}

/** Transactional/invitation email routes; language is explicitly agent-selected. */
export async function cmdEmailInvite(kind: 'invite' | 'invite-human' | 'invite-device', flags: Record<string, string | boolean>): Promise<CommandResult> {
  if (flags.help) { printEmailInviteHelp(); return {}; }
  const cfg = loadCommonsInstitutionsConfig();
  if (!cfg) return missingCredentialsError();
  const email = typeof flags.email === 'string' ? flags.email : '';
  if (!email) return { error: '--email is required' };
  const language = typeof flags.language === 'string' ? flags.language : undefined;
  const message = typeof flags.message === 'string' ? flags.message : undefined;
  try {
    const client = new CommonsInstitutions(cfg);
    if (kind === 'invite') return await client.invite({ email, language });
    if (kind === 'invite-human') return await client.inviteHuman({ humanEmail: email, language, message });
    const result = await client.inviteDevice({ email, language, message,
      deviceName: typeof flags['device-name'] === 'string' ? flags['device-name'] : undefined });
    return { ...result };
  } catch (err) { return errorResult(err); }
}
export function printEmailInviteHelp(): void {
  console.log('provian invite|invite-human|invite-device --email <address> [--language en|es|fr|hi|id|ja|ko|pt|sw|tl|vi|zh] [--message <text>] [--device-name <name>]\nAbsent or unsupported language means English. Agent API credentials are required. Device tokens arrive only by email.');
}
