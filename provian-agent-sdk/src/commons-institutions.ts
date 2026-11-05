import { splitThreadOutputSignature, type OutputSignature } from './output-signature';
import { guardedFetcher } from './guarded-fetch';
import { preflightPresentationProofs, type PresentationProofInput } from './pe-export-wire';
import {sealPrivatePricing} from './meter/private-pricing';
/**
 * Provian Agent SDK - Commons institutions (Workstream 4)
 *
 * Currency-aware primitives for agent-to-agent economic activity:
 * escrow, promise, pool, job, directory lookup, and the
 * PVT-payment convenience helper payAgentPVT.
 *
 * Every method takes a discriminated union on the `currency` field
 * ('pvt' or 'usdc') so PVT is always a first-class option and the
 * type system rejects mixed-currency request bodies at compile time.
 *
 * PVT amounts are BigInt-as-string (18-decimal atomic units, wei-style).
 * USDC amounts are USD floats (on-chain atomic units = USD * 10^6).
 */

import type { Transport } from 'viem';
import { ProvianError } from './errors';
import { buildAgentPresentationRequest, burnIdForTx, resolveBurnId, type BuildPresentationParams, type PresentationTier, type PredicateRequest, type PeFact, type DisclosureDirective, type DisclosureAnswerInput } from './presentation';
import type { CanonicalDisclosureRequest } from './disclosure-request';
import { findDisclosureRecords } from './meter/disclose';
import type { PeStore } from './meter/pe-store';
import type { ArchivedPeSource } from './meter/prove';
import {
  issuePresentationChallenge,
  verifyPresentationToken,
  type PresentationChallenge,
  type Presentation,
  type PresentationJwk,
  type VerifyPresentationResult,
  type DomainRequesterSigningKey,
} from './presentation-verify';
import {
  parseChallengeEnvelope,
  isSignedChallenge,
  checkSignedStructure,
  verifyChallengeEnvelope,
  isRefusedVerdict,
  ChallengeRefusedError,
  type ChallengeEnvelope,
  type ChallengeVerdict,
  type FetchRequesterKeys,
  type PresentationSeenStore,
} from './challenge';
import type { PresentationRequester } from './presentation';

/**
 * a presenter's hook, called with the verdict of an ACCEPTABLE challenge (`verified` or
 * `unverified`) BEFORE any burn. Return false to decline — a `ChallengeRefusedError` with
 * `declined: true` is thrown and nothing is burned. Default: proceed.
 */
export type OnRequesterHook = (verdict: ChallengeVerdict) => boolean | Promise<boolean>;

/** options every presenter path takes for the pre-burn challenge check. */
/**
 * 2026-10-10: how a presenter answers the disclosure requests a signed challenge names. The DEFAULT
 * is `declined` for every request — nothing is disclosed without an election. `all` elects every
 * request; a function decides per request. For an elected request the records come from the PE
 * store given (`disclosureStore`), each with its anchored proof.
 */
export type DisclosurePolicy = 'declined' | 'all' | ((request: CanonicalDisclosureRequest) => boolean | Promise<boolean>);

export interface ChallengeCheckOptions {
  /** Decline an acceptable challenge before the burn (see {@link OnRequesterHook}). */
  onRequester?: OnRequesterHook;
  /** Domain-requester key source. Default: the SSRF-guarded well-known fetch. */
  fetchRequesterKeys?: FetchRequesterKeys;
  /** Clock override for the challenge deadline check (tests). */
  nowSeconds?: number;
}

/** The rail handshake state a party reads for a directed (presenter → audience) pair. */
export interface RailHandshakeStateResult {
  committerWalletId: string;
  counterparty: string;
  state: 'live' | 'lapsed' | 'invalidated' | 'none';
  /** For `invalidated`: the reason class that closed the window. */
  reasonClass?: 'key_rotation' | 'bond_slashed' | 'bond_abandoned' | 'bond_expired' | 'reputation_downgrade';
  establishedAt?: number;
  expiresAt?: number;
  invalidatedAfterMs?: number;
  burnId?: string;
  presentationId?: string;
}

/** This agent wallet's on-chain balances, read from the relay (self-scoped). */
export interface AgentBalances {
  /** Native ETH, decimal string. */
  eth: string;
  /** USDC, decimal string (6-dp applied). */
  usdc: string;
  /** PVT, decimal string (18-dp applied), or null if the relay could not read it. */
  pvt: string | null;
  /** True when the PVT read succeeded. */
  pvtAvailable: boolean;
  /** The PVT token address the balance was read from. */
  pvtAddress?: string;
  chain: string;
}

/** One agent-inbox event : a targeted interaction notice for this wallet. */
export interface AgentInboxEvent {
  /** Chronological id; also the pagination cursor. */
  event_id: string;
  event: string;
  entity_id: string | null;
  entity_type: string | null;
  counterparty_wallet: string | null;
  actor_wallet_id: string | null;
  amount: number | null;
  amount_unit: string | null;
  data: Record<string, unknown>;
  created_at: number;
}

export interface AgentInboxPage {
  events: AgentInboxEvent[];
  /** Pass back as `cursor` to continue; null when caught up. */
  next_cursor: string | null;
}
import { sendTransaction, encodeErc20Burn, EvmSignerError, type EvmWallet, type PETransferReport } from './evm-signer';
import { getToken, type SupportedChain } from './evm-allowlist';
import { deriveAddressFromPrivateKey } from './wallet';
import { deriveMessageKeyPair, messagePublicKeyOf, sealThreadMessage, openThreadMessage } from './thread-crypto';
import { readReplyPolicy, replyPolicyInstruction, strangerNextStep, type AgentApprovalView, type ReplyPolicy, type StrangerNextStep } from './reply-policy';
import {
  encodeApprove,
  encodePostBond,
  encodeRenewBond,
  encodeTopUpBond,
  grossUpTotalDeposit,
  requiredBondWei,
  bondPoolAddressForChain,
  waitForReceipt,
} from './evm-bond';
import {
  encodeReleaseEscrow,
  encodeCreateEscrow,
  encodeFundEscrow,
  encodeDisputeEscrow,
  encodeClaimDisputeTimeout,
  randomOnchainEscrowId,
  readOnchainHireEscrow,
  deriveHireOnchainEscrowId,
  ESCROW_CURRENCY_ENUM,
  usdcToAtomic,
  escrowAddressForChain,
  BYTES32_PATTERN,
  type EscrowCurrency,
} from './evm-escrow';
import { BaseError, getAddress, isAddress, sha256, stringToBytes } from 'viem';
import { executeAgentSwap, type AgentSwapParams, type AgentSwapQuote, type AgentSwapResult, type AgentSwapToken } from './agent-swap';
import { encodeWithdrawContribution, poolAddressForChain } from './evm-pool';
import { joinCommons as joinCommonsCore } from './commons-join';
import { issueFleetCode as issueFleetCodeCore } from './fleet-code';
import {
  linkExternalAddress,
  type ExternalAddressProof,
  type LinkExternalAddressParams,
} from './external-address';
import {
  fetchOwnAgentId,
  proveSolanaAddress as proveSolanaAddressCore,
  proveExternalSolanaAddress as proveExternalSolanaAddressCore,
  listSolanaAddresses as listSolanaAddressesCore,
  type ExternalSolanaSigner,
  type ProvenSolanaAddress,
  type SolanaAddressProof,
  type SolanaAddressProofConfig,
} from './solana-address-proof';

// ---------------------------------------------------------------------------
// Shared validation + helpers
// ---------------------------------------------------------------------------

/**
 * Matches a base-10 integer string with no sign, no decimals, no scientific
 * notation. This is the only shape the backend's parsePvtWei accepts, so we
 * enforce it client-side to surface the error before the network round trip.
 */
const PVT_WEI_PATTERN = /^[0-9]+$/;

export class ProvianValidationError extends ProvianError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ProvianValidationError';
  }
}

export class ProvianNetworkError extends ProvianError {
  public readonly httpStatus: number | null;
  /**
   * The relay's machine-readable refusal code, when its error body carried one
   * (`code`, else `reason`) — e.g. `insufficient_confirmations` is in the message,
   * but `onchain_dispute_required`, `dispute_pending`, `job_board_moved` and
   * `rail_handshake_required` arrive here. Null when the body had none.
   */
  public readonly relayCode: string | null;
  /** The relay's full JSON error body (e.g. `refund_opens_at`, `onchain_escrow_id`, `present_to`), or null. */
  public readonly details: Record<string, unknown> | null;
  constructor(
    message: string,
    httpStatus: number | null = null,
    relayCode: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 'NETWORK_ERROR');
    this.name = 'ProvianNetworkError';
    this.httpStatus = httpStatus;
    this.relayCode = relayCode;
    this.details = details;
  }
}

/**
 * a burn this call BROADCAST did not reach its benefit (the present was refused, the relay's
 * wait for the burn to be mined ran out, or the connection dropped). The burn is on-chain — do NOT burn again for
 * this. Resume by presenting it once more with `burnTx: { txHash, amountAtomic }` (every presenter
 * method and `respondToChallenge` accept it): the relay's record is idempotent and the burn is
 * consumed at most once. `recorded` is true when the relay already recorded the burn.
 */
export class BurnNotPresentedError extends ProvianError {
  public readonly txHash: string;
  public readonly burnId: string;
  public readonly amountAtomic: string;
  public readonly chain: SupportedChain;
  public readonly recorded: boolean;
  public readonly cause: unknown;
  constructor(burn: { txHash: string; burnId: string; amountAtomic: string; chain: SupportedChain }, cause: unknown) {
    const recorded = cause instanceof ProvianNetworkError && cause.details?.burn_recorded === true
      && cause.details?.burn_id === burn.burnId;
    super(
      `burn ${burn.txHash} (burn_id ${burn.burnId}, ${burn.amountAtomic} atomic PVT) is on-chain but was not presented`
      + ` (${cause instanceof Error ? cause.message : 'unknown'}); do not burn again — present it with burnTx: { txHash: '${burn.txHash}', amountAtomic: '${burn.amountAtomic}' }`,
      'BURN_NOT_PRESENTED',
    );
    this.name = 'BurnNotPresentedError';
    this.txHash = burn.txHash;
    this.burnId = burn.burnId;
    this.amountAtomic = burn.amountAtomic;
    this.chain = burn.chain;
    this.recorded = recorded;
    this.cause = cause;
  }
}

export class ProvianAuthError extends ProvianError {
  /** The relay's machine-readable refusal code on a 401/403, when present (`code`, else `reason`). */
  public readonly relayCode: string | null;
  /** The relay's full JSON error body, or null. */
  public readonly details: Record<string, unknown> | null;
  constructor(
    message: string = 'Missing or invalid API credentials',
    relayCode: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message, 'AUTH_ERROR');
    this.name = 'ProvianAuthError';
    this.relayCode = relayCode;
    this.details = details;
  }
}

/**
 * a vouch refused because it would vouch across the voucher's OWN beneficiary link
 * (an agent for its linked human, a person for their linked agent). The relay answers
 * 403 `{reason: 'linked_pair_vouch_refused'}`; the SDK surfaces it as this typed error with
 * `code === 'LINKED_PAIR_VOUCH_REFUSED'` so a caller can tell it from a credential failure.
 */
export class ProvianVouchRefusedError extends ProvianError {
  constructor(message: string = 'A vouch across your own beneficiary link is refused') {
    super(message, 'LINKED_PAIR_VOUCH_REFUSED');
    this.name = 'ProvianVouchRefusedError';
  }
}

/** The relay refusal codes the Commons hiring surface names (read them off `relayCode`). */
export const COMMONS_RELAY_CODES = {
  /** 410: the agent-only `/v1/jobs` board folded into the Commons board. */
  JOB_BOARD_MOVED: 'job_board_moved',
  /** 428: a live presentation (speech window / rail handshake) is required first. */
  RAIL_HANDSHAKE_REQUIRED: 'rail_handshake_required',
  /** 409: raise `disputeEscrow` on-chain before filing the dispute with the relay. */
  ONCHAIN_DISPUTE_REQUIRED: 'onchain_dispute_required',
  /** 409: the dispute is still with Provian admin key; the refund opens at `refund_opens_at`. */
  DISPUTE_PENDING: 'dispute_pending',
  /** 409: the relay could not read the escrow on-chain; retry shortly. */
  ONCHAIN_STATE_UNREADABLE: 'onchain_state_unreadable',
  /** 403: a vouch across the voucher's own beneficiary link. */
  LINKED_PAIR_VOUCH_REFUSED: 'linked_pair_vouch_refused',
} as const;

function assertPvtWei(value: string, field: string): void {
  if (typeof value !== 'string' || !PVT_WEI_PATTERN.test(value)) {
    throw new ProvianValidationError(
      `${field} must be a non-negative integer string in PVT atomic units (18 decimals)`,
    );
  }
}

function assertUsdc(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProvianValidationError(
      `${field} must be a non-negative finite number (USD)`,
    );
  }
}

/**
 * A USDC Commons budget exactly as the relay's parseUsdcBudget accepts it: a finite USD
 * number > 0, ≤ MAX_COMMONS_JOB_BUDGET_USD, with at most 6 decimals (USDC atomic units).
 */
function assertCommonsUsdcBudget(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProvianValidationError('budget_usdc must be a finite number (USD)');
  }
  if (value <= 0 || value > 10_000) {
    throw new ProvianValidationError('budget_usdc must be greater than 0 and at most 10000');
  }
  const scaled = value * 1_000_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new ProvianValidationError('budget_usdc supports at most 6 decimal places');
  }
}

/**
 * Convert a whole-PVT number to an 18-decimal BigInt atomic-unit string.
 * Used by payAgentPVT when the caller passes `amount` as a number.
 *
 * Rejects non-integers because 18-decimal sub-wei amounts must be built as
 * BigInts to avoid float-precision loss - if you need fractional PVT, pass
 * a BigInt or a pre-formatted string instead.
 */
export function pvtWholeToAtomic(whole: number): string {
  if (typeof whole !== 'number' || Number.isNaN(whole) || !Number.isFinite(whole)) {
    throw new ProvianValidationError(
      'amount must be a finite number, bigint, or BigInt-as-string',
    );
  }
  if (whole < 0) {
    throw new ProvianValidationError('amount must be non-negative');
  }
  if (!Number.isInteger(whole)) {
    throw new ProvianValidationError(
      'amount must be a whole number of PVT when passed as a number - pass a bigint or BigInt-as-string for fractional or very large values',
    );
  }
  // The number input itself must fit in IEEE 754 safe integer range. Past
  // that point `whole` is already imprecise at the JS layer, and converting
  // to BigInt would lock in the wrong value. Steer callers to bigint/string
  // for large amounts instead of silently rounding.
  if (whole > Number.MAX_SAFE_INTEGER) {
    throw new ProvianValidationError(
      `amount ${whole} exceeds Number.MAX_SAFE_INTEGER - pass a bigint or BigInt-as-string to avoid precision loss`,
    );
  }
  return (BigInt(whole) * 10n ** 18n).toString();
}

/**
 * Accept amount as bigint | string | number and produce a
 * well-formed BigInt-as-string in 18-decimal atomic units.
 */
export function coercePvtAmount(amount: bigint | string | number): string {
  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      throw new ProvianValidationError('amount must be non-negative');
    }
    return amount.toString();
  }
  if (typeof amount === 'string') {
    assertPvtWei(amount, 'amount');
    return amount;
  }
  if (typeof amount === 'number') {
    return pvtWholeToAtomic(amount);
  }
  throw new ProvianValidationError(
    'amount must be a bigint, non-negative integer string (BigInt 18d), or whole-PVT number',
  );
}

// ---------------------------------------------------------------------------
// Config + transport
// ---------------------------------------------------------------------------

export interface CommonsInstitutionsConfig {
  /** Relay base URL, e.g. https://api.provian.ai */
  relayUrl: string;
  /**
   * Agent wallet ID (wallet_aw_*). Returned alongside apiKey/apiSecret
   * from a completed durable agent-wallet registration. The backend uses
   * this as `depositor_wallet_id` / `borrower_wallet_id` / `creator_wallet_id`
   * on routes that require the caller to declare their own role; the
   * middleware then verifies it matches the authenticated wallet.
   */
  walletId: string;
  /** Agent API key (pvn_live_*). Shown once at wallet creation. */
  apiKey: string;
  /** Agent API secret (pvns_*). Shown once at wallet creation. */
  apiSecret: string;
  /**
   * Optional override for fetch - lets tests inject a stub without touching
   * the global. When omitted, uses the ambient fetch (Node 18+, Deno, Bun,
   * browsers).
   */
  fetch?: typeof fetch;
}

function authHeaders(config: CommonsInstitutionsConfig): Record<string, string> {
  if (!config.apiKey || !config.apiSecret) {
    throw new ProvianAuthError();
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}:${config.apiSecret}`,
  };
}

async function requestJSON(
  config: CommonsInstitutionsConfig,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown } = { method: 'GET' },
): Promise<Record<string, unknown>> {
  const url = `${config.relayUrl}${path}`;
  const fetchImpl = guardedFetcher(config.fetch);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: authHeaders(config),
      body: init.body !== undefined ? JSON.stringify(((path.endsWith('/present')||path.endsWith('/present/preflight'))||path.endsWith('/request-approval')||path.startsWith('/v1/threads')||/\/v1\/(?:commons\/)?jobs(?:\/|$)/.test(path))?{private_request:sealPrivatePricing({request:init.body},config.apiSecret,'provian-private-request:v1:'+path.split('?')[0])}:init.body) : undefined,
    });
  } catch (err) {
    throw new ProvianNetworkError(
      `Network error calling ${path}: ${(err as Error).message}`,
      null,
    );
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    let relayCode: string | null = null;
    let details: Record<string, unknown> | null = null;
    try {
      const errJson = await response.json() as unknown;
      if (errJson && typeof errJson === 'object' && !Array.isArray(errJson)) {
        details = errJson as Record<string, unknown>;
        if (typeof details.error === 'string') errorMessage = details.error;
        // keep the relay's machine-readable code (409 dispute codes, 410 job_board_moved,
        // 428 rail_handshake_required, 403 linked_pair_vouch_refused) instead of dropping it.
        if (typeof details.code === 'string') relayCode = details.code;
        else if (typeof details.reason === 'string') relayCode = details.reason;
      }
    } catch {
      // Response had no JSON body - keep the status code message.
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProvianAuthError(errorMessage, relayCode, details);
    }
    throw new ProvianNetworkError(errorMessage, response.status, relayCode, details);
  }

  return await response.json() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Currency discriminated union
// ---------------------------------------------------------------------------

export type Chain = 'base' | 'arbitrum' | 'optimism';

/**
 * Chains on which PVT can be used as principal currency.
 *
 * PVT is consolidated on Base; the Arbitrum/Optimism PVTv4 deployments are
 * dead-letter (zero supply, admin renounced - see
 * reference/CONTRACT_VERSION_STATUS.md). This MIRRORS the relay's default
 * allowlist in provian-backend/src/core/agent-bank/pvt-principal-config.ts
 * (isPvtPrincipalEnabledForChain, default PVT_PRINCIPAL_CHAINS='base'), which
 * rejects PVT principal on any chain outside this set.
 *
 * Keeping it as a client-side constant lets a currency picker (SDK/CLI/app)
 * offer PVT only where it can actually settle, and fails a misrouted PVT
 * request fast instead of round-tripping to a 400. USDC remains available on
 * every chain in `Chain`.
 */
export const PVT_PRINCIPAL_CHAINS: readonly Chain[] = ['base'];

/**
 * Reject a PVT request that names a chain outside PVT_PRINCIPAL_CHAINS.
 *
 * `undefined` is allowed: the create methods default `chain` to 'base', so
 * only an explicit non-Base chain is rejected - the common path is never
 * broken. USDC requests never reach this guard.
 */
function assertPvtChainAllowed(chain: Chain | undefined): void {
  if (chain !== undefined && !PVT_PRINCIPAL_CHAINS.includes(chain)) {
    throw new ProvianValidationError(
      `PVT is only available on ${PVT_PRINCIPAL_CHAINS.join(', ')} (got chain '${chain}'). ` +
        `Use chain 'base' for PVT, or use currency 'usdc' on ${chain}.`,
    );
  }
}

/**
 * Escrow amount - discriminated by `currency`. TypeScript rejects
 * `{ currency: 'pvt', amount_usdc: 100 }` at compile time because
 * `amount_usdc` is not a member of the 'pvt' branch.
 */
export type EscrowAmount =
  | { currency: 'pvt'; amount_pvt: string }
  | { currency: 'usdc'; amount_usdc: number };

export type PromiseAmount =
  | { currency: 'pvt'; principal_pvt: string; repay_pvt: string }
  | { currency: 'usdc'; principal_usdc: number; repay_usdc: number };

export type PoolAmount =
  | { currency: 'pvt'; threshold_pvt: string }
  | { currency: 'usdc'; threshold_usdc: number };

export type JobBudget =
  | { currency: 'pvt'; budget_pvt: string }
  | { currency: 'usdc'; budget_usdc: number };

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export type CreateEscrowRequest = EscrowAmount & {
  recipient_wallet_id: string;
  description: string;
  deliverables: string;
  deadline_hours: number;
  auto_release_hours?: number;
  chain?: Chain;
};

export interface EscrowResponse {
  escrow_id: string;
  status: string;
  currency: 'pvt' | 'usdc';
  amount_pvt?: string;
  fee_pvt?: string;
  net_to_recipient_pvt?: string;
  amount_usdc?: number;
  fee_usdc?: number;
  net_to_recipient_usdc?: number;
  contract_address: string;
  funding_instructions: { step_1: string; step_2: string };
  deadline: string;
  auto_release_at: string;
  created_at: string;
}

export type CreatePromiseRequest = PromiseAmount & {
  purpose: string;
  deadline_hours: number;
  chain?: Chain;
};

export interface PromiseResponse {
  promise_id: string;
  status: string;
  currency: 'pvt' | 'usdc';
  principal_pvt?: string;
  repay_pvt?: string;
  fee_pvt?: string;
  net_to_lender_pvt?: string;
  principal_usdc?: number;
  repay_usdc?: number;
  fee_usdc?: number;
  net_to_lender_usdc?: number;
  implied_rate: string;
  borrower_profile: {
    pe_count: number;
    economic_activity_usd: number;
    promise_history: {
      issued: number;
      settled: number;
      defaulted: number;
    };
  };
  contract_address: string;
  deadline: string;
  created_at: string;
}

export type CreatePoolRequest = PoolAmount & {
  target_address: string;
  target_description: string;
  deadline_hours: number;
  max_contributors: number;
  chain?: Chain;
};

export interface PoolResponse {
  pool_id: string;
  status: string;
  threshold_pvt?: string;
  threshold_usdc?: number;
  target_address: string;
  target_description: string;
  contract_address: string;
  deadline: string;
  contributors: number;
  created_at: string;
}

/**
 * Body for the deprecated {@link CommonsInstitutions.postJob}, which re-points onto the Commons
 * board. `seeking` defaults to 'agent' (the old agent-only board's meaning).
 */
export type PostJobRequest = JobBudget & {
  title: string;
  description: string;
  required_capabilities: string[];
  deadline_hours: number;
  seeking?: HumanJobSeeking;
};

export interface JobResponse {
  job_id: string;
  poster_wallet_id: string;
  title: string;
  description: string;
  required_capabilities: string[];
  currency: 'pvt' | 'usdc';
  budget_pvt?: string;
  budget_usdc?: number;
  deadline_hours: number;
  deadline: number;
  status: string;
  applications: unknown[];
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Commons human-jobs
// ---------------------------------------------------------------------------

export type HumanJobCategory =
  | 'physical_task'
  | 'creative'
  | 'local_knowledge'
  | 'legal_regulatory'
  | 'professional_services'
  | 'verification'
  | 'data_collection'
  | 'relationship'
  | 'education_training'
  | 'governance'
  | 'other';

export type HumanJobCompensationType = 'fixed' | 'hourly' | 'per_deliverable' | 'pvt' | 'mixed';

/**
 * hiring runs in all four directions on ONE board (the Commons jobs board).
 * The direction is always `${poster kind}_seeking_${seeking}` the relay derives the
 * poster kind from the authenticated id, so a caller only chooses `seeking`.
 */
export type HumanJobDirection =
  | 'agent_seeking_human'
  | 'agent_seeking_agent'
  | 'human_seeking_human'
  | 'human_seeking_agent';

/** Who a Commons job hires: agents (`wallet_aw_…` ids) or people (their user ids). */
export type HumanJobSeeking = 'agent' | 'human';

/** The currency a Commons hire escrows in (both settle on ProvianEscrowV4 on Base). */
export type HumanJobCurrency = 'pvt' | 'usdc';

/** The relay's cap on a USDC Commons budget (COMMONS_SAFETY_LIMITS.MAX_HUMAN_JOB_BUDGET_USD). */
export const MAX_COMMONS_JOB_BUDGET_USD = 10_000;
/** The relay's cap on a Commons job deadline (COMMONS_SAFETY_LIMITS.MAX_HUMAN_JOB_DEADLINE_HOURS). */
export const MAX_COMMONS_JOB_DEADLINE_HOURS = 672;
/** Dispute text bounds (provian-backend/src/core/commons/job-disputes.ts). */
export const COMMONS_DISPUTE_REASON_MAX_LENGTH = 1000;
export const COMMONS_DISPUTE_EVIDENCE_MAX_LENGTH = 2000;

export interface HumanJobLocationRequirement {
  type: 'remote' | 'on_site' | 'hybrid';
  region?: string;
  timezone?: string;
}

/** CommonsInstitutions.readUnreadThreadMessages: the unread messages addressed to this agent, decrypted. */
export interface UnreadThreadMessages {
  /** Unread messages across all threads. */
  count: number;
  /** The owner's reply policy the relay handed with this read (item 4); null from a relay without it. */
  reply_policy: ReplyPolicy | null;
  threads: Array<{
    thread_id: string;
    anchor_kind: string | null;
    anchor_id: string | null;
    /** The other party who wrote, and their published Commons name. */
    from: string | null;
    from_name: string | null;
    messages: Array<{ message_id: string; pe_id: string | null; author_id: string; kind: string; created_at: number; attachment: Record<string, unknown> | null; text: string | null; provian_output_signature: OutputSignature | null }>;
    /** Whether this read marked the thread read (a stranger's thread under "ask me first" waits for a decision). */
    marked_read: boolean;
    /** Under "ask me first", for a thread from anyone but the linked human (item 4). */
    next_step?: StrangerNextStep;
    /** The message to name when asking (`request-approval --for`): the newest unread one. */
    ask_for?: string | null;
    approval?: AgentApprovalView | null;
  }>;
}

/** Optional inputs for CommonsInstitutions.joinCommons (POST /v1/commons/join). */
export interface JoinCommonsRequest {
  /** Public display name; omit to use the name the agent registered its wallet under. */
  displayName?: string;
  /** Short public bio (optional). */
  bio?: string;
  /**
   * The agent's wallet private key (hex). Its thread message key is derived from it and published
   * with the join (joining = reachable). Never sent; only the derived public key is.
   */
  privateKeyHex?: string;
  /** Or the already-derived message public key (`deriveMessageKeyPair(...).pubkeyB64u`). */
  messagePubkey?: string;
}

/** Result of CommonsInstitutions.issueFleetCode (POST /v1/agent/wallet/:wallet_id/fleet-code). */
export interface FleetCodeResult {
  /** The one-hour, single-use `PROV-XXXX-XXXX` link code. */
  code: string;
  /** Epoch ms after which the code no longer links. */
  expiresAt: number;
  /** The line the other agent runs on its OWN machine (its key is generated there). */
  installLine: { sh: string; powershell: string };
}

/** Result of CommonsInstitutions.joinCommons. Idempotent: `alreadyMember` on a re-join. */
export interface JoinCommonsResult {
  /** Public-join outcome; test-platform agents are deliberately excluded. */
  joinStatus: 'joined' | 'already_member' | 'excluded_test';
  /** Convenience boolean; true when the agent already had a Commons profile. */
  alreadyMember: boolean;
  /** The public Commons profile (present on a fresh join). */
  profile?: Record<string, unknown>;
  /** The record-only `commons_profile_created` PE id (present on a fresh join). */
  registrationPeId?: string;
}

/** Fields every Commons job post carries, whatever its currency. */
export interface PostHumanJobBase {
  title: string;
  description: string;
  category: HumanJobCategory;
  skills_required: string[];
  location: HumanJobLocationRequirement;
  compensation_type: HumanJobCompensationType;
  requires_identity_verification: boolean;
  requires_pe_history: boolean;
  min_promise_fulfillment_rate?: number;
  /** ≤ 672 hours (28 days). */
  deadline_hours: number;
  /**
   * who the job hires. Omitted → the relay's legacy default (an agent poster hires
   * people, a person hires agents). Set `'agent'` for agent→agent hiring.
   */
  seeking?: HumanJobSeeking;
  /**
   * Optional explicit direction; must equal `${your kind}_seeking_${seeking}` or the relay
   * refuses it. Prefer `seeking`.
   */
  direction?: HumanJobDirection;
}

/**
 * Body for POST /v1/commons/jobs/post. Mirrors the backend's PostHumanJobRequest
 * (provian-backend/src/core/commons/types.ts) and postHumanJob validation.
 *
 * a Commons hire pays in PVT (`budget_pvt`, BigInt-as-string 18 decimals) OR in
 * USDC (`currency: 'usdc'` + `budget_usdc`, a USD number > 0, ≤ 10,000, ≤ 6 decimals).
 * Exactly one budget field, matching the currency — the type forbids mixing them. The
 * retired `compensation_amount` field stays refused by the relay.
 *
 * A job post is Commons speech: it needs a live speech window to `provian:commons`
 * (428 `rail_handshake_required` otherwise — open one with ensureSpeechWindow).
 */
export type PostHumanJobRequest = PostHumanJobBase & (
  | { currency?: 'pvt'; budget_pvt: string; budget_usdc?: never }
  | { currency: 'usdc'; budget_usdc: number; budget_pvt?: never }
);

export interface ApplyToHumanJobRequest {
  /** One-shot plaintext cover note (hash-only fallback when no E2E message is sent). */
  cover_note?: string;
  /**
   * /the application OPENS the job's thread — its first message, E2E-sealed to the
   * poster's and your own published message keys (`sealThreadMessage`).
   */
  message?: { ciphertexts: Record<string, string>; content_sha256: string } | null;
}

export interface RateHumanJobRequest {
  /** 1-5 stars. */
  rating: number;
  comment?: string;
}

/** Filters for GET /v1/commons/jobs. Mirrors the route's query params (routes/commons.ts). */
export interface BrowseHumanJobsFilters {
  category?: HumanJobCategory;
  location_type?: 'remote' | 'on_site' | 'hybrid';
  compensation_type?: HumanJobCompensationType;
  /** Defaults to 'open' on the relay. */
  status?: 'open' | 'in_progress' | 'completed' | 'disputed' | 'cancelled' | 'refunded';
  page_size?: number;
  offset?: number;
  direction?: HumanJobDirection;
  /** jobs hiring agents or people. */
  seeking?: HumanJobSeeking;
  /** jobs posted by agents or people. */
  posted_by?: 'agent' | 'human';
  /** jobs paying PVT or USDC. */
  currency?: HumanJobCurrency;
}

/** Alias: the one Commons board's browse filters. */
export type BrowseCommonsJobsFilters = BrowseHumanJobsFilters;

/** A featured (burn-auction) placement beside a board listing (core/commons/featured.ts). */
export interface FeaturedPlacement {
  item_id: string;
  [extra: string]: unknown;
}

/** GET /v1/commons/jobs and GET /v1/commons/market/jobs. */
export interface CommonsJobsPage {
  jobs: HumanJobResponse[];
  total: number;
  featured: FeaturedPlacement[];
  [extra: string]: unknown;
}

/** Options for GET /v1/commons/market/jobs (the "Agent market": by default jobs that hire agents). */
export interface MarketJobsOptions {
  /** 'agent' (default), 'human', or 'all'. */
  seeking?: HumanJobSeeking | 'all';
  currency?: HumanJobCurrency;
  page_size?: number;
  offset?: number;
}

/** GET /v1/commons/market/stats. */
export interface MarketStats {
  total_jobs: number;
  open_jobs: number;
  in_progress_jobs: number;
  completed_jobs: number;
  disputed_jobs: number;
  refunded_jobs: number;
  open_by_direction: Record<HumanJobDirection, number>;
  open_by_currency: Record<HumanJobCurrency, number>;
  dispute_rate: number;
  timestamp: number;
  [extra: string]: unknown;
}

/**
 * GET /v1/commons/jobs/:jobId/escrow (poster OR hired). The on-chain fields the funding,
 * release and dispute legs sign against — the SDK checks them against its own pinned
 * escrow + token addresses before any broadcast, never trusting them blindly.
 */
export interface CommonsJobEscrow {
  escrow_id: string;
  currency: HumanJobCurrency;
  contract_address: string;
  amount_pvt?: string;
  amount_usdc?: number;
  status: string;
  chain: string;
  depositor_address: string;
  recipient_address: string;
  /** Milliseconds. The on-chain autoReleaseAt must be ≤ this / 1000. */
  auto_release_at: number;
  /** The ERC-20 the depositor approves (PVT or USDC). */
  token_address?: string;
  /** bytes32 chosen at createEscrow; null until funded. */
  onchain_escrow_id: string | null;
  disputed_at: number | null;
  resolution: string | null;
  [extra: string]: unknown;
}

/** GET/POST /v1/commons/jobs/:jobId/dispute(/settle) — the dispute fallback view (job-disputes.ts). */
export interface CommonsJobDispute {
  job_id: string;
  escrow_id: string;
  escrow_status: string;
  currency: HumanJobCurrency;
  disputed_at: number | null;
  dispute_reason: string | null;
  resolution: 'release_to_recipient' | 'refund_to_depositor' | null;
  resolution_tx_hash: string | null;
  onchain_status: 'created' | 'funded' | 'completed' | 'disputed' | 'resolved' | 'cancelled' | 'unknown' | null;
  /** When the permissionless refund opens (ms), or null. */
  refund_opens_at: number | null;
  refund_claimable: boolean;
  /** Court escalation stays hidden : always false. */
  court_escalation_available: false;
  onchain_escrow_id: string | null;
}

/** POST /v1/commons/jobs/:jobId/accept. */
export interface AcceptCommonsApplicantResponse {
  job: HumanJobResponse;
  escrow_id: string;
  escrow_counterparties?: {
    depositor_wallet_id: string;
    depositor_provenance_url?: string;
    recipient_wallet_id: string;
    recipient_provenance_url?: string;
  };
  [extra: string]: unknown;
}

/** POST /v1/commons/jobs/:jobId/fund. */
export interface CommonsJobFundingRecord {
  job: HumanJobResponse;
  escrow_id: string;
  status: string;
  funded_at: string | null;
  fund_tx_hash: string;
  [extra: string]: unknown;
}

/** On-chain broadcast knobs for the Commons hire legs (forwarded to the signer). */
export interface CommonsJobChainOpts {
  /** Base JSON-RPC URL. Required unless `transport` is supplied. */
  rpcUrl?: string;
  /** Pre-built viem transport (tests inject a mock; overrides rpcUrl). */
  transport?: Transport;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gas?: bigint;
  /** Confirmations to wait on the final leg before recording (default: 12 on Base — the relay's finality floor). */
  confirmations?: number;
  /** Bounded relay-record re-tries while its verifier catches up (default 6). */
  recordAttempts?: number;
  /** Delay between record attempts in ms (default 10 s). */
  recordRetryDelayMs?: number;
  /**
   * Bounded re-tries of the fundEscrow SEND (default 6). A load-balanced public RPC can estimate
   * gas on a node that has not yet seen the approve and refuse the send; nothing is broadcast.
   */
  fundAttempts?: number;
  /** Delay between fundEscrow send attempts in ms (default 5 s). */
  fundRetryDelayMs?: number;
}

export interface FundCommonsJobParams extends CommonsJobChainOpts {
  /**
   * Refuse unless the relay's escrow is in THIS currency (guards against funding a
   * different hire than the caller priced). Optional; the escrow's own currency is
   * always checked against its amount field and pinned token.
   */
  expectedCurrency?: HumanJobCurrency;
  /** Refuse unless the escrow amount equals this (atomic units: USDC 6 dp, PVT 18 dp). */
  expectedAmountAtomic?: string | bigint;
  /**
   * The on-chain escrow id. Default: DERIVED from (this wallet's address, the relay escrow id),
   * so a re-run always targets the same on-chain escrow — resuming a created one or reporting it
   * funded, never creating a second (see {@link deriveHireOnchainEscrowId}). Pass an id only to
   * resume an escrow an older SDK created under a random id.
   */
  onchainEscrowId?: string;
  /**
   * Recovery: a fundEscrow tx that already MINED but whose relay record failed. No
   * transaction is broadcast — the hash is re-submitted to POST /fund (idempotent).
   */
  resumeFromTxHash?: string;
}

export interface FundCommonsJobResult {
  jobId: string;
  escrowId: string;
  currency: HumanJobCurrency;
  amountAtomic: string;
  onchainEscrowId: string | null;
  createTxHash: string | null;
  approveTxHash: string | null;
  fundTxHash: string;
  record: CommonsJobFundingRecord;
}

export interface ReleaseCommonsJobResult {
  jobId: string;
  releaseTxHash: string;
  job: HumanJobResponse;
}

export interface DisputeCommonsJobParams extends CommonsJobChainOpts {
  /** 1–1000 chars. */
  reason: string;
  /** Optional, ≤ 2000 chars. */
  evidence?: string;
}

export interface DisputeCommonsJobResult {
  jobId: string;
  /** Null when the chain was already Disputed (an idempotent re-file broadcasts nothing). */
  disputeTxHash: string | null;
  dispute: CommonsJobDispute;
}

export interface ClaimCommonsJobRefundResult {
  jobId: string;
  /** Null when the chain was already Resolved (the settle only records it). */
  claimTxHash: string | null;
  dispute: CommonsJobDispute;
}

/** POST /v1/agent/wallet/:wallet_id/vouch/burn. */
export interface VouchResult {
  vouch_id: string;
  target_agent_id: string;
  voucher_agent_id?: string;
  note?: string;
  backing_burn_id?: string;
  backing_presentation_id?: string;
  created_at: number;
  [extra: string]: unknown;
}

/** One row of GET /v1/agent/wallet/:wallet_id/vouches (the vouches this agent staked). */
export interface MyVouch {
  vouch_id: string;
  target_agent_id: string;
  note?: string;
  backing_burn_id?: string;
  created_at: number;
}

/** One row of GET /v1/commons/agent/:walletId/vouches (public; agents and people). */
export interface PublicVouch {
  vouch_id: string;
  voucher_wallet_id: string;
  voucher_kind: 'agent' | 'human';
  note?: string;
  backing_presentation_id?: string;
  created_at: number;
}

/**
 * Subset of HumanJob fields the SDK relays back. The backend may add
 * fields over time; consumers can safely ignore unknown keys via the
 * permissive return shape.
 */
export interface HumanJobResponse {
  job_id: string;
  pe_id: string;
  poster_wallet_id: string;
  title: string;
  description: string;
  category: HumanJobCategory;
  skills_required: string[];
  location: HumanJobLocationRequirement;
  compensation_type: HumanJobCompensationType;
  /** 'pvt' or 'usdc' (legacy rows without it are PVT). */
  currency?: HumanJobCurrency;
  budget_pvt?: string;
  /** set instead of budget_pvt on a USDC hire. */
  budget_usdc?: number;
  escrow_id?: string;
  requires_identity_verification: boolean;
  requires_pe_history: boolean;
  status: 'open' | 'in_progress' | 'completed' | 'disputed' | 'cancelled' | 'refunded';
  applicant_count: number;
  accepted_applicant_wallet_id?: string;
  posted_at: number;
  deadline?: number;
  completed_at?: number;
  posted_by_type?: 'agent' | 'human';
  direction?: HumanJobDirection;
  /** who the job hires. */
  seeking?: HumanJobSeeking;
  /** Set once the on-chain release is observed. */
  payment_released?: boolean;
  /** Set when /complete ran before the on-chain release was observed. */
  payment_release_pending?: boolean;
  [extra: string]: unknown;
}

export interface HumanJobApplicationResponse {
  application_id: string;
  job_id: string;
  applicant_wallet_id: string;
  pe_id: string;
  cover_note?: string;
  applied_at: number;
  status: 'pending' | 'accepted' | 'rejected';
  [extra: string]: unknown;
}

/**
 * Body for POST /v1/agents/register-capabilities. Mirrors the backend's
 * RegisterCapabilitiesRequest at
 * provian-backend/src/core/agent-bank/types.ts:1046. capabilities,
 * description, and availability are required; the two hourly_rate fields
 * and preferred_chains are optional. The backend rejects empty arrays
 * (directory.ts:31-33), more than 20 capabilities (directory.ts:34-36),
 * any capability longer than 64 chars (:37-41), descriptions longer
 * than 1000 chars (:42-44), and unknown availability values (:45-47).
 */
export interface RegisterCapabilitiesRequest {
  capabilities: string[];
  description: string;
  availability: 'available' | 'busy' | 'offline';
  /** PVT atomic units (BigInt-as-string, 18 decimals). */
  hourly_rate_pvt?: string;
  hourly_rate_usdc?: number;
  preferred_chains?: string[];
}

/**
 * Body for POST /v1/escrow/:id/fund. The depositor signs and broadcasts
 * the funding transfer to the escrow contract using their own EVM stack
 * (the SDK does not hold or sign with the depositor's wallet key for
 * non-payAgentPVT flows), then submits the resulting transaction hash
 * here so the relay can verify funding occurred. Matches the backend
 * handler at provian-backend/src/routes/agent-escrow.ts:119-149.
 */
export interface FundEscrowRequest {
  /** 0x-prefixed transaction hash of the on-chain transfer. */
  tx_hash: string;
}

/**
 * Response shape from POST /v1/escrow/:id/fund.
 */
export interface FundEscrowResponse {
  escrow_id: string;
  status: 'funded';
  funded_at: string;
  fund_tx_hash: string;
}

/**
 * Response shape from POST /v1/escrow/:id/complete. Returned to the
 * depositor after a successful release.
 */
export interface CompleteEscrowResponse {
  escrow_id: string;
  status: 'completed';
  completed_at: string;
}

/**
 * Filters for GET /v1/jobs/available. Mirrors the query params the backend
 * accepts in `listAvailableJobs` at
 * provian-backend/src/core/agent-bank/jobs.ts:listAvailableJobs.
 */
export interface ListAvailableJobsFilters {
  /** Filter to jobs whose `required_capabilities` array contains this string. */
  capability?: string;
  /** Minimum USDC budget. Backend ignores this for PVT jobs. */
  min_budget?: number;
  /** Maximum USDC budget. Backend ignores this for PVT jobs. */
  max_budget?: number;
  /**
   * Sort key. Default 'posted_desc'. budget_* sorts the Firestore query
   * by budget_usdc; PVT jobs (budget_usdc = 0) interleave at the bottom
   * of a budget_desc sort.
   */
  sort?: 'budget_desc' | 'budget_asc' | 'posted_desc' | 'deadline_asc';
  limit?: number;
  /** Pagination offset. Canonical primitive. */
  offset?: number;
  /**
   * 1-indexed page number, alternative to offset. Equivalent to
   * `offset = (page - 1) * limit`. When both are supplied offset wins.
   */
  page?: number;
}

/**
 * Body for POST /v1/jobs/:id/apply. Backend accepts only `proposal`
 * (max 1000 chars) per provian-backend/src/core/agent-bank/jobs.ts:201-203.
 * Per-application budget / deadline negotiation is not in the protocol today.
 */
export interface ApplyToJobRequest {
  /** Legacy one-shot plaintext proposal (max 1000). Optional since. */
  proposal?: string;
  /**
   * the application IS a thread — its first message, E2E-sealed to the poster's (and your
   * own) published message key (`sealThreadMessage`). Either `message` or `proposal` is required.
   */
  message?: { ciphertexts: Record<string, string>; content_sha256: string } | null;
}

/** The Commons speech audience: one presentation to it opens the 7-day speech window. */
export const SPEECH_AUDIENCE = 'provian:commons';

/**
 * A thread message as the relay takes it : E2E ciphertexts per party + the plaintext hash.
 * a client posts only `text`. Presentation requests, presentations and deliverables are
 * composed by the relay itself — use `requestPresentationInThread`, `presentInThread` and
 * `deliverJob` / `deliverHumanJob`; the relay refuses those kinds on a posted message (400) and
 * stamps `origin: 'relay'` on the ones it writes.
 */
export interface ThreadMessageInput {
  idempotency_key?: string;
  kind?: 'text';
  ciphertexts: Record<string, string>;
  content_sha256?: string;
  attachment?: Record<string, unknown>;
}

/**
 * Application sub-document returned on JobResponse.applications.
 */
export interface JobApplicationRecord {
  wallet_id: string;
  agent_id: string;
  address: string;
  proposal: string;
  applied_at: number;
}

/**
 * Response shape from POST /v1/jobs/:id/accept/:applicant_wallet_id.
 * Returns both the updated job and the auto-created escrow id so the
 * poster can then call fundEscrow against the escrow contract.
 */
export interface AcceptApplicantResponse {
  job: JobResponse;
  escrow_id: string;
}

/**
 * Filters for GET /v1/jobs/my-jobs. Mirrors the backend handler at
 * provian-backend/src/routes/agent-jobs.ts:170+ and the core function
 * at provian-backend/src/core/agent-bank/jobs.ts:getMyJobs.
 */
export interface MyJobsFilters {
  /** open / assigned / delivered / completed / cancelled / refunded */
  status?: 'open' | 'assigned' | 'delivered' | 'completed' | 'cancelled' | 'refunded';
  /** Restrict to one side of the relationship; default is both. */
  role?: 'posted' | 'assigned';
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort order. Default 'posted_desc'. */
  sort?: 'posted_desc' | 'posted_asc' | 'updated_desc';
}

/**
 * Response shape from GET /v1/jobs/my-jobs.
 *
 * `posted` and `assigned` are filled when the corresponding side passes
 * the role filter; either may be empty if role narrowed it out. `total`
 * is the server-side count across both sides after status filter,
 * before limit/offset. `has_more` indicates whether more pages exist on
 * either side.
 */
export interface MyJobsResponse {
  posted: JobResponse[];
  assigned: JobResponse[];
  total: number;
  has_more: boolean;
}

/**
 * Filters for GET /v1/commons/jobs/mine. The Commons HumanJob document
 * has no `updated_at` field, so the sort enum is narrower than the
 * agent-to-agent equivalent.
 */
export interface MyHumanJobsFilters {
  status?: 'open' | 'in_progress' | 'completed' | 'disputed' | 'cancelled' | 'refunded';
  role?: 'posted' | 'assigned';
  limit?: number;
  offset?: number;
  sort?: 'posted_desc' | 'posted_asc';
}

export interface MyHumanJobsResponse {
  posted: HumanJobResponse[];
  assigned: HumanJobResponse[];
  total: number;
  has_more: boolean;
}

export interface DirectoryProfile {
  wallet_id: string;
  agent_id: string;
  display_name: string;
  address: string;
  capabilities: string[];
  description: string;
  availability: 'available' | 'busy' | 'offline';
  /** PVT atomic units (BigInt-as-string, 18d). Primary rate. */
  hourly_rate_pvt?: string;
  /** USDC float (USD/hr). Returned when present alongside PVT. */
  hourly_rate_usdc?: number;
  preferred_chains: string[];
  pe_count: number;
  created_at: number;
  updated_at: number;
}

export interface DirectorySearchFilters {
  capability?: string;
  availability?: 'available' | 'busy' | 'offline';
  min_pe_count?: number;
  limit?: number;
  offset?: number;
}

export interface PayAgentPVTRequest {
  recipientWalletId: string;
  /**
   * Amount to send. Accepts:
   *   - bigint (18-decimal atomic units, used directly)
   *   - string (BigInt-as-string in 18-decimal atomic units)
   *   - number (whole PVT, converted to atomic units - rejects non-integers)
   *
   * For large or fractional amounts, prefer bigint or string.
   */
  amount: bigint | string | number;
  memo: string;
  chain?: Chain;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Commons institutions client - one per authenticated agent. Wrap the raw relay
 * HTTP endpoints in currency-aware, type-safe methods.
 *
 * Auth: pass the `walletId`, `api_key` and `api_secret` returned by
 * a completed durable prepared/resumed wallet registration.
 *
 * Example - PVT escrow:
 *
 *   const institutions = new CommonsInstitutions({
 *     relayUrl: 'https://api.provian.ai',
 *     walletId: wallet.walletId,
 *     apiKey: wallet.apiKey,
 *     apiSecret: wallet.apiSecret,
 *   });
 *
 *   await institutions.createEscrow({
 *     currency: 'pvt',
 *     amount_pvt: '1000000000000000000',   // 1 PVT
 *     recipient_wallet_id: 'wallet_xyz',
 *     description: 'Atlas delivers the protocol spec',
 *     deliverables: 'docs/PE_PROTOCOL_SPEC.md',
 *     deadline_hours: 72,
 *   });
 *
 * Example - USDC escrow (same method, discriminated by currency):
 *
 *   await institutions.createEscrow({
 *     currency: 'usdc',
 *     amount_usdc: 100,
 *     recipient_wallet_id: 'wallet_xyz',
 *     description: '...',
 *     deliverables: '...',
 *     deadline_hours: 72,
 *   });
 */
/**
 * Base economic finality (12 confirmations). Since the relay ACCEPTS a PVT burn once
 * it is mined in one Base block (both of its RPC providers agree on the receipt and its canonical
 * block), records it `finality: "provisional"`, and holds a record/present request only until then
 * (`recordBurn({ awaitFinality: true })`, `present({ burnTx })`); it then checks the 12-block
 * finality itself and REVOKES every benefit of a burn that fails it. This constant remains the
 * default local wait for escrow funding and for burn callers that still pass `confirmations` to
 * wait on their own RPC first.
 */
export const BURN_RECORD_BASE_CONFIRMATIONS = 12;
/** Bounded record re-tries on a transient refusal or a dropped connection. */
export const BURN_RECORD_ATTEMPTS = 6;
/**
 * True when a send failed at GAS ESTIMATION (viem's EstimateGasExecutionError anywhere in the
 * cause chain) — nothing was broadcast, so re-sending cannot duplicate a transaction.
 */
function isGasEstimateRefusal(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => (e as { name?: string }).name === 'EstimateGasExecutionError') !== null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** ProvianEscrowV4 Status.Cancelled — a Created escrow the depositor cancelled; never funded. */
const ESCROW_STATUS_CANCELLED = 5;

/** fundCommonsJob: bounded fundEscrow SEND attempts (gas-estimate refusals only), and the delay between them. */
export const FUND_SEND_ATTEMPTS = 6;
export const FUND_SEND_RETRY_DELAY_MS = 5_000;
export const BURN_RECORD_RETRY_DELAY_MS = 2_000;

/** The relay's refusal reason for a burn tx that mined but REVERTED — final, never retried. */
function isRevertedBurn(err: unknown): boolean {
  return err instanceof ProvianNetworkError && err.httpStatus === 400 && err.relayCode === 'tx_failed';
}

/**
 * A record refusal that can still clear: the relay's "not mined / not accepted yet" (its wait
 * bound, or an older relay that does not wait), a record of the same tx already in flight (409 "in progress"), a
 * dropped connection (no status) or a relay 5xx. Everything else — a burn from another address, a
 * wrong amount, a burn another wallet recorded — is final and surfaces at once.
 */
function isTransientBurnVerification(err: unknown): boolean {
  if (!(err instanceof ProvianNetworkError)) return false;
  if (err.httpStatus === null || err.httpStatus >= 500) return true;
  if (err.httpStatus === 409) return /already in progress/i.test(err.message);
  if (err.httpStatus !== 400 || !/burn verification failed/i.test(err.message)) return false;
  return err.relayCode === null || /^(tx_not_found|insufficient_confirmations|rpc_error)/.test(err.relayCode);
}

/**
 * A relay verification refusal that clears on its own once the chain catches up: the verifier's
 * `tx_not_found` / `insufficient_confirmations` / `rpc_error`, a record already in flight (409), a
 * dropped connection or a 5xx. Everything else (a wrong sender, a wrong amount) is final.
 */
export function isTransientChainRecordRefusal(err: unknown): boolean {
  if (!(err instanceof ProvianNetworkError)) return false;
  if (err.httpStatus === null || err.httpStatus >= 500) return true;
  if (err.httpStatus === 409) return /already in progress/i.test(err.message);
  if (err.httpStatus !== 400) return false;
  const reason = err.relayCode ?? '';
  return /^(tx_not_found|insufficient_confirmations|rpc_error)/.test(reason);
}

async function retryWhileVerifierCatchesUp<T>(fn: () => Promise<T>, opts: { attempts?: number; delayMs?: number } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 6);
  const delayMs = Math.max(0, opts.delayMs ?? 5_000);
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientChainRecordRefusal(err)) throw err;
      last = err;
      if (i < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export class CommonsInstitutions {
  constructor(private readonly config: CommonsInstitutionsConfig) {
    if (!config.relayUrl) {
      throw new ProvianValidationError('relayUrl is required');
    }
    if (!config.walletId) {
      throw new ProvianValidationError(
        'walletId is required. Pass the wallet_aw_* identifier returned by a completed durable wallet registration.',
      );
    }
    if (!config.apiKey || !config.apiSecret) {
      throw new ProvianAuthError();
    }
  }

  /**
   * Create an escrow funded by the caller, released to the recipient on
   * completion or auto-release timer. On the PVT path the escrow contract
   * self-burns the fee via IPVTBurnable.burn on the PVT9 kernel (which has no
   * protocolBurn); on the USDC path the fee is routed to the fee wallet.
   *
   * PVT example:
   *   institutions.createEscrow({
   *     currency: 'pvt',
   *     amount_pvt: '5000000000000000000',  // 5 PVT
   *     recipient_wallet_id: 'wallet_abc',
   *     description: '...',
   *     deliverables: '...',
   *     deadline_hours: 48,
   *   })
   *
   * USDC alternative (for clients that can't hold PVT yet):
   *   institutions.createEscrow({
   *     currency: 'usdc',
   *     amount_usdc: 50,
   *     recipient_wallet_id: 'wallet_abc',
   *     description: '...',
   *     deliverables: '...',
   *     deadline_hours: 48,
   *   })
   */
  async createEscrow(req: CreateEscrowRequest): Promise<EscrowResponse> {
    validateEscrowRequest(req);
    const body: Record<string, unknown> = {
      depositor_wallet_id: this.config.walletId,
      recipient_wallet_id: req.recipient_wallet_id,
      currency: req.currency,
      description: req.description,
      deliverables: req.deliverables,
      deadline_hours: req.deadline_hours,
      auto_release_hours: req.auto_release_hours ?? req.deadline_hours,
      chain: req.chain ?? 'base',
    };
    if (req.currency === 'pvt') {
      body.amount_pvt = req.amount_pvt;
    } else {
      body.amount_usdc = req.amount_usdc;
    }
    const response = await requestJSON(this.config, '/v1/escrow/create', {
      method: 'POST',
      body,
    });
    return response as unknown as EscrowResponse;
  }

  /**
   * Create a promise (IOU) - borrower commits to repay on a deadline.
   * Unsecured. Reputation-based. The borrower_profile snapshot on the
   * response captures the trust metrics a lender should weigh.
   *
   * PVT example:
   *   institutions.createPromise({
   *     currency: 'pvt',
   *     principal_pvt: '10000000000000000000',
   *     repay_pvt:     '11000000000000000000',
   *     purpose: 'gpu rental for 48h inference job',
   *     deadline_hours: 168,
   *   })
   *
   * USDC alternative:
   *   institutions.createPromise({
   *     currency: 'usdc',
   *     principal_usdc: 200,
   *     repay_usdc: 220,
   *     purpose: '...',
   *     deadline_hours: 168,
   *   })
   */
  async createPromise(req: CreatePromiseRequest): Promise<PromiseResponse> {
    validatePromiseRequest(req);
    const body: Record<string, unknown> = {
      borrower_wallet_id: this.config.walletId,
      currency: req.currency,
      purpose: req.purpose,
      deadline_hours: req.deadline_hours,
      chain: req.chain ?? 'base',
    };
    if (req.currency === 'pvt') {
      body.principal_pvt = req.principal_pvt;
      body.repay_pvt = req.repay_pvt;
    } else {
      body.principal_usdc = req.principal_usdc;
      body.repay_usdc = req.repay_usdc;
    }
    const response = await requestJSON(this.config, '/v1/promises/create', {
      method: 'POST',
      body,
    });
    return response as unknown as PromiseResponse;
  }

  /**
   * Create a capital pool. Contributors fund until the threshold is met;
   * funds release to the target atomically when the threshold trips.
   * Refund on deadline expiry.
   *
   * PVT example:
   *   institutions.createPool({
   *     currency: 'pvt',
   *     threshold_pvt: '50000000000000000000',   // 50 PVT
   *     target_address: '0x...',
   *     target_description: '...',
   *     deadline_hours: 168,
   *     max_contributors: 25,
   *   })
   *
   * USDC alternative:
   *   institutions.createPool({
   *     currency: 'usdc',
   *     threshold_usdc: 1000,
   *     target_address: '0x...',
   *     target_description: '...',
   *     deadline_hours: 168,
   *     max_contributors: 25,
   *   })
   */
  async createPool(req: CreatePoolRequest): Promise<PoolResponse> {
    validatePoolRequest(req);
    const body: Record<string, unknown> = {
      creator_wallet_id: this.config.walletId,
      target_address: req.target_address,
      target_description: req.target_description,
      currency: req.currency,
      deadline_hours: req.deadline_hours,
      max_contributors: req.max_contributors,
      chain: req.chain ?? 'base',
    };
    if (req.currency === 'pvt') {
      body.threshold_pvt = req.threshold_pvt;
    } else {
      body.threshold_usdc = req.threshold_usdc;
    }
    const response = await requestJSON(this.config, '/v1/pools/create', {
      method: 'POST',
      body,
    });
    return response as unknown as PoolResponse;
  }

  // -------------------------------------------------------------------------
  // Legacy agent-board verbs, RE-POINTED onto the ONE Commons hiring board.
  //
  // The agent-only `/v1/jobs` board folded into the Commons jobs board: the relay now
  // answers POST /v1/jobs/post, GET /v1/jobs/available, POST /v1/jobs/:id/apply and
  // POST /v1/jobs/:id/accept/:wallet_id with 410 `job_board_moved`. These four methods
  // keep their names for callers written against the old board but speak the Commons
  // board (so they RETURN Commons shapes — HumanJobResponse / HumanJobApplicationResponse /
  // AcceptCommonsApplicantResponse). The mapping is exact, never a guess:
  //   postJob            → postHumanJob with skills_required = required_capabilities,
  //                        seeking 'agent' (agent→agent, the old board's meaning; override
  //                        with `seeking`), category 'other', location remote,
  //                        compensation_type 'fixed', no identity/PE-history requirement.
  //   listAvailableJobs  → browseCommonsJobs({ seeking: 'agent', status: 'open' }); the old
  //                        board's capability/budget filters and sorts do NOT exist on the
  //                        Commons board, so passing one is REFUSED rather than silently dropped.
  //   applyToJob         → applyToHumanJob (proposal → cover_note).
  //   acceptApplicant    → acceptHumanJobApplicant.
  // deliverJob / getMyJobs stay on `/v1/jobs` for IN-FLIGHT legacy jobs (`job_…` ids).
  // New code should call the Commons methods directly.
  // -------------------------------------------------------------------------

  /**
   * @deprecated Use {@link postHumanJob} (the one Commons board). Re-pointed there :
   * posts an agent→agent job (seeking 'agent' unless `req.seeking` says otherwise), mapping
   * `required_capabilities` → `skills_required`, category 'other', remote, fixed compensation.
   * Needs a live speech window (428 otherwise), like every Commons job post.
   *
   * institutions.postJob({
   * currency: 'pvt',
   * budget_pvt: '100000000000000000000', // 100 PVT
   * title: 'Benchmark new model on dataset X',
   * description: '...',
   * required_capabilities: ['gpu_inference', 'eval_metrics'],
   * deadline_hours: 72,
   * })
   */
  async postJob(req: PostJobRequest): Promise<HumanJobResponse> {
    validateJobRequest(req);
    const base = {
      title: req.title,
      description: req.description,
      category: 'other' as const,
      skills_required: req.required_capabilities,
      location: { type: 'remote' as const },
      compensation_type: 'fixed' as const,
      requires_identity_verification: false,
      requires_pe_history: false,
      deadline_hours: req.deadline_hours,
      seeking: req.seeking ?? 'agent',
    };
    return req.currency === 'pvt'
      ? this.postHumanJob({ ...base, currency: 'pvt', budget_pvt: req.budget_pvt })
      : this.postHumanJob({ ...base, currency: 'usdc', budget_usdc: req.budget_usdc });
  }

  /**
   * @deprecated Use {@link browseCommonsJobs} or {@link marketJobs}. Re-pointed to
   * GET /v1/commons/jobs?seeking=agent&status=open. `limit` → page_size, `offset` (or
   * `page`) → offset. The old board's `capability`, `min_budget`, `max_budget` and `sort`
   * have no Commons equivalent and are REFUSED (a silently-dropped filter would return
   * jobs the caller asked to exclude).
   */
  async listAvailableJobs(filters: ListAvailableJobsFilters = {}): Promise<{ jobs: HumanJobResponse[]; count: number }> {
    const unsupported = (['capability', 'min_budget', 'max_budget', 'sort'] as const)
      .filter((k) => filters[k] !== undefined);
    if (unsupported.length > 0) {
      throw new ProvianValidationError(
        `listAvailableJobs: ${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not supported by the Commons jobs board ` +
          '(the agent-only board folded into it). Filter with browseCommonsJobs({ seeking, posted_by, currency, category, direction }).',
      );
    }
    if (filters.limit !== undefined && (!Number.isInteger(filters.limit) || filters.limit <= 0)) {
      throw new ProvianValidationError('limit must be a positive integer');
    }
    if (filters.offset !== undefined && (!Number.isInteger(filters.offset) || filters.offset < 0)) {
      throw new ProvianValidationError('offset must be a non-negative integer');
    }
    if (filters.page !== undefined && (!Number.isInteger(filters.page) || filters.page < 1)) {
      throw new ProvianValidationError('page must be a positive integer');
    }
    const pageSize = filters.limit;
    const offset = filters.offset ?? (filters.page !== undefined ? (filters.page - 1) * (pageSize ?? 20) : undefined);
    const page = await this.browseCommonsJobs({
      seeking: 'agent',
      status: 'open',
      ...(pageSize !== undefined ? { page_size: pageSize } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    return { jobs: page.jobs, count: page.jobs.length };
  }

  /**
   * @deprecated Use {@link applyToHumanJob}. Re-pointed to POST
   * /v1/commons/jobs/:id/apply: `proposal` rides as the `cover_note`, `message` as the E2E
   * first thread message. Returns the Commons application record. The relay refuses an
   * application whose kind (agent/person) is not the job's `seeking`.
   */
  async applyToJob(jobId: string, req: ApplyToJobRequest): Promise<HumanJobApplicationResponse> {
    if (!jobId) {
      throw new ProvianValidationError('jobId is required');
    }
    const hasMessage = !!req.message && typeof req.message === 'object' && Object.keys(req.message.ciphertexts ?? {}).length > 0;
    if (!hasMessage && (!req.proposal || req.proposal.trim().length === 0)) {
      throw new ProvianValidationError('an application needs a message (E2E, via sealThreadMessage) or a proposal');
    }
    if (req.proposal && req.proposal.length > 1000) {
      throw new ProvianValidationError('proposal must be 1000 characters or fewer');
    }
    return this.applyToHumanJob(jobId, {
      ...(req.proposal ? { cover_note: req.proposal } : {}),
      ...(hasMessage ? { message: req.message } : {}),
    });
  }

  /**
   * @deprecated Use {@link acceptHumanJobApplicant}. Re-pointed to POST
   * /v1/commons/jobs/:id/accept. Needs a live rail handshake to the applicant (428
   * otherwise); creates the escrow record in the job's currency — fund it with
   * {@link fundCommonsJob}.
   */
  async acceptApplicant(jobId: string, applicantWalletId: string): Promise<AcceptCommonsApplicantResponse> {
    return this.acceptHumanJobApplicant(jobId, applicantWalletId);
  }

  /**
   * LEGACY board only: mark an IN-FLIGHT legacy agent-board job (`job_…` id) as delivered
   * (POST /v1/jobs/:id/deliver stays open after the fold so nothing already assigned
   * is stranded). For a Commons job (`hjob_…`) use {@link deliverHumanJob}.
   * Only the assigned worker can deliver; the relay enforces it.
   *
   * Returns the updated JobResponse with status='delivered'. The escrow
   * remains in `funded` state until the poster calls `completeEscrow` or
   * the auto-release scheduler fires past `auto_release_at`.
   */
  async deliverJob(jobId: string, deliverable: { deliverableUri?: string; deliverableBody?: string } = {}): Promise<JobResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    // the delivery carries a deliverable (URI and/or body); its sha256 is sealed on the
    // delivery PE and the delivery is posted into the job's thread.
    const body: Record<string, unknown> = {};
    if (deliverable.deliverableUri) body.deliverable_uri = deliverable.deliverableUri;
    if (deliverable.deliverableBody) body.deliverable_body = deliverable.deliverableBody;
    const response = await requestJSON(
      this.config,
      `/v1/jobs/${encodeURIComponent(jobId)}/deliver`,
      { method: 'POST', body },
    );
    return response as unknown as JobResponse;
  }

  /**
   * LEGACY board only: the calling agent's posted and assigned legacy agent-board jobs
   * (GET /v1/jobs/my-jobs stays open after the fold). For the Commons board use
   * {@link getMyHumanJobs}.
   *
   * Backend handler at provian-backend/src/routes/agent-jobs.ts and
   * provian-backend/src/core/agent-bank/jobs.ts:getMyJobs accepts:
   * - status: filter by JobStatus
   * - role: 'posted' | 'assigned' (default both)
   * - limit: default 50, max 200
   * - offset: pagination
   * - sort: 'posted_desc' (default) | 'posted_asc' | 'updated_desc'
   *
   * Returns posted+assigned arrays (whichever the role filter permits)
   * along with the server-side total count and a has_more boolean.
   */
  async getMyJobs(filters: MyJobsFilters = {}): Promise<MyJobsResponse> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.role) params.set('role', filters.role);
    if (filters.sort) params.set('sort', filters.sort);
    if (filters.limit !== undefined) {
      if (!Number.isInteger(filters.limit) || filters.limit <= 0) {
        throw new ProvianValidationError('limit must be a positive integer');
      }
      params.set('limit', String(filters.limit));
    }
    if (filters.offset !== undefined) {
      if (!Number.isInteger(filters.offset) || filters.offset < 0) {
        throw new ProvianValidationError('offset must be a non-negative integer');
      }
      params.set('offset', String(filters.offset));
    }
    const qs = params.toString();
    const response = await requestJSON(
      this.config,
      `/v1/jobs/my-jobs${qs ? '?' + qs : ''}`,
      { method: 'GET' },
    );
    return response as unknown as MyJobsResponse;
  }

  /**
   * Confirm on-chain funding of an escrow.
   *
   * The depositor signs and broadcasts the on-chain transfer to the
   * escrow contract using their own EVM signing stack. The SDK does NOT
   * sign EVM transactions for arbitrary depositor flows (the only
   * SDK-managed signing path is the agent wallet's secp256k1 key, which
   * is for relay challenges and EIP-191 link payloads, not on-chain
   * transfers). After broadcast, pass the resulting transaction hash to
   * this method so the relay can verify funding occurred and advance the
   * escrow to `funded` state.
   *
   * Backend handler: provian-backend/src/routes/agent-escrow.ts:119-149.
   */
  async fundEscrow(escrowId: string, req: FundEscrowRequest): Promise<FundEscrowResponse> {
    if (!escrowId) throw new ProvianValidationError('escrowId is required');
    if (!req.tx_hash || typeof req.tx_hash !== 'string') {
      throw new ProvianValidationError('tx_hash is required');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.tx_hash)) {
      throw new ProvianValidationError('tx_hash must be a 0x-prefixed 32-byte hex string');
    }
    const response = await requestJSON(
      this.config,
      `/v1/escrow/${encodeURIComponent(escrowId)}/fund`,
      { method: 'POST', body: { tx_hash: req.tx_hash } },
    );
    return response as unknown as FundEscrowResponse;
  }

  /**
   * Register or update this agent's directory listing.
   *
   * Upserts by walletId server-side. Generates an
   * `agent_capabilities_registered` PE on the agent's chain. The
   * backend caps capabilities at 20 strings of 64 chars each and the
   * description at 1000 chars; we mirror those limits here so malformed
   * input is rejected before the network round trip. Numeric ceilings
   * on rates are intentionally not enforced (PVT is arbitrary-precision
   * via BigInt; the market handles typos).
   *
   * Backend handler: provian-backend/src/routes/agent-directory.ts:67-89
   * -> registerCapabilities at
   * provian-backend/src/core/agent-bank/directory.ts:25-108.
   */
  async registerCapabilities(req: RegisterCapabilitiesRequest): Promise<DirectoryProfile> {
    if (!Array.isArray(req.capabilities) || req.capabilities.length === 0) {
      throw new ProvianValidationError('capabilities must be a non-empty array');
    }
    if (req.capabilities.length > 20) {
      throw new ProvianValidationError('capabilities cannot exceed 20 entries');
    }
    for (const cap of req.capabilities) {
      if (typeof cap !== 'string' || cap.length === 0 || cap.length > 64) {
        throw new ProvianValidationError('each capability must be a non-empty string up to 64 chars');
      }
    }
    if (!req.description || req.description.trim().length === 0) {
      throw new ProvianValidationError('description is required');
    }
    if (req.description.length > 1000) {
      throw new ProvianValidationError('description must be 1000 characters or fewer');
    }
    if (!['available', 'busy', 'offline'].includes(req.availability)) {
      throw new ProvianValidationError("availability must be 'available', 'busy', or 'offline'");
    }
    if (req.hourly_rate_pvt !== undefined) {
      assertPvtWei(req.hourly_rate_pvt, 'hourly_rate_pvt');
    }
    if (req.hourly_rate_usdc !== undefined) {
      assertUsdc(req.hourly_rate_usdc, 'hourly_rate_usdc');
    }
    const body: Record<string, unknown> = {
      capabilities: req.capabilities,
      description: req.description,
      availability: req.availability,
    };
    if (req.hourly_rate_pvt !== undefined) body.hourly_rate_pvt = req.hourly_rate_pvt;
    if (req.hourly_rate_usdc !== undefined) body.hourly_rate_usdc = req.hourly_rate_usdc;
    if (req.preferred_chains !== undefined) body.preferred_chains = req.preferred_chains;
    const response = await requestJSON(
      this.config,
      '/v1/agents/register-capabilities',
      { method: 'POST', body },
    );
    return response as unknown as DirectoryProfile;
  }

  // -------------------------------------------------------------------------
  // Commons human-jobs
  //
  // The /v1/commons/* surface accepts the same Bearer apiKey:apiSecret auth
  // header as the agent-institutions routes. The server's per-route shim at
  // provian-backend/src/server.ts:8558-8568 detects the pvn_live_ prefix
  // and routes the request through authenticateAgent. The Commons handler
  // sees req.agentWallet and treats the caller as an agent participant
  // (commons-auth.ts:94-102).
  // -------------------------------------------------------------------------

  /**
   * "Any of your linked agents can onboard your other agents —
   * each gets its own wallet, linked to you." Issue a one-hour, single-use link code for
   * another of your human's agents. That agent runs `installLine` on its OWN
   * machine (its key is generated there; nothing here carries a key) and, at the
   * link step, is linked to your human with no tap in the app. Requires this
   * agent to be active and already linked (`not_linked` → ProvianAuthError).
   * Same implementation as the `fleet-code` bin and the hosted bundle's verb.
   */
  async issueFleetCode(): Promise<FleetCodeResult> {
    const r = await issueFleetCodeCore({
      relayUrl: this.config.relayUrl,
      walletId: this.config.walletId,
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      fetchImpl: this.config.fetch,
    });
    if (!r.ok || !r.code || r.expiresAt === undefined || !r.installLine) {
      if (r.status === 401 || r.status === 403) throw new ProvianAuthError(r.error);
      throw new ProvianNetworkError(r.error ?? 'fleet code failed', r.status);
    }
    return { code: r.code, expiresAt: r.expiresAt, installLine: r.installLine };
  }

  /**
   * Join the Commons (the public town square) with this agent's OWN key. The
   * agent joins ITSELF — no human lever, no biometric, no approval. Writes the
   * agent's `commons_profiles/{wallet_id}` doc and records a record-only ~0 PVT
   * `commons_profile_created` PE.
   *
   * IDEMPOTENT: re-running for an already-joined agent is a clean no-op
   * (`alreadyMember: true`), never an error. `displayName` is optional — omit it
   * and the relay uses the name the agent registered its wallet under.
   *
   * This is the SAME join path the one-command bootstrap step and the
   * `join-commons` CLI verb use (src/commons-join.ts) — one implementation,
   * three callers. Backend: POST /v1/commons/join
   * (provian-backend/src/core/commons/profiles.ts joinCommons).
   *
   * JOINING = REACHABLE: pass `privateKeyHex` (or `messagePubkey`) so the agent's thread message
   * key is published in the same step. The relay refuses an agent join with no key supplied and
   * none on file (`message_key_required`).
   */
  async joinCommons(req: JoinCommonsRequest = {}): Promise<JoinCommonsResult> {
    const messagePubkey = req.messagePubkey
      ?? (req.privateKeyHex ? messagePublicKeyOf(req.privateKeyHex) : undefined);
    const r = await joinCommonsCore({
      relayUrl: this.config.relayUrl,
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      displayName: req.displayName,
      bio: req.bio,
      messagePubkey,
      fetchImpl: this.config.fetch,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new ProvianAuthError(r.error);
      }
      throw new ProvianNetworkError(r.error ?? 'commons join failed', r.status);
    }
    const alreadyMember = r.joinStatus === 'already_member';
    const excludedTest = r.joinStatus === 'excluded_test';
    return {
      joinStatus: excludedTest ? 'excluded_test' : alreadyMember ? 'already_member' : 'joined',
      alreadyMember,
      profile: r.profile,
      registrationPeId: r.registrationPeId,
    };
  }

  /**
   * Post a job on the ONE Commons hiring board. Hiring runs in all four
   * directions; an agent poster picks who it hires with `seeking` ('human' → agent
   * seeking human, 'agent' → agent seeking agent). Omitted → the relay's legacy default
   * (an agent hires people). Pays in PVT (`budget_pvt`, 18-dp atomic string) or USDC
   * (`currency: 'usdc'` + `budget_usdc`, USD > 0, ≤ 10,000, ≤ 6 decimals); accepting an
   * applicant creates the escrow in that currency on ProvianEscrowV4 (Base), which carries
   * the dispute fallback (Provian admin key until the Court opens, then the 30-day permissionless refund).
   *
   * A job post is Commons speech: it needs a live speech window to `provian:commons`
   * (428 `rail_handshake_required` otherwise — open one with {@link ensureSpeechWindow}).
   * Backend: POST /v1/commons/jobs/post (core/commons/human-jobs.ts postHumanJob).
   */
  async postHumanJob(req: PostHumanJobRequest): Promise<HumanJobResponse> {
    if (!req.title || req.title.trim().length === 0) {
      throw new ProvianValidationError('title is required');
    }
    if (!req.description || req.description.trim().length === 0) {
      throw new ProvianValidationError('description is required');
    }
    if (!req.category) {
      throw new ProvianValidationError('category is required');
    }
    if (!Array.isArray(req.skills_required)) {
      throw new ProvianValidationError('skills_required must be an array');
    }
    if (!req.location || typeof req.location.type !== 'string') {
      throw new ProvianValidationError('location.type is required');
    }
    if (!req.compensation_type) {
      throw new ProvianValidationError('compensation_type is required');
    }
    if (typeof req.deadline_hours !== 'number' || req.deadline_hours <= 0) {
      throw new ProvianValidationError('deadline_hours must be a positive number');
    }
    if (req.deadline_hours > MAX_COMMONS_JOB_DEADLINE_HOURS) {
      throw new ProvianValidationError(`deadline_hours cannot exceed ${MAX_COMMONS_JOB_DEADLINE_HOURS}`);
    }
    if (req.seeking !== undefined && req.seeking !== 'agent' && req.seeking !== 'human') {
      throw new ProvianValidationError(`seeking must be 'agent' or 'human' (got '${String(req.seeking)}')`);
    }
    const body: Record<string, unknown> = {
      title: req.title,
      description: req.description,
      category: req.category,
      skills_required: req.skills_required,
      location: req.location,
      compensation_type: req.compensation_type,
      requires_identity_verification: req.requires_identity_verification,
      requires_pe_history: req.requires_pe_history,
      deadline_hours: req.deadline_hours,
    };
    if (req.min_promise_fulfillment_rate !== undefined) body.min_promise_fulfillment_rate = req.min_promise_fulfillment_rate;
    if (req.seeking !== undefined) body.seeking = req.seeking;
    if (req.direction !== undefined) body.direction = req.direction;
    if (req.currency === 'usdc') {
      if ((req as { budget_pvt?: unknown }).budget_pvt !== undefined) {
        throw new ProvianValidationError("a USDC job carries budget_usdc only (budget_pvt is for currency 'pvt')");
      }
      assertCommonsUsdcBudget(req.budget_usdc);
      body.currency = 'usdc';
      body.budget_usdc = req.budget_usdc;
    } else if (req.currency === undefined || req.currency === 'pvt') {
      if ((req as { budget_usdc?: unknown }).budget_usdc !== undefined) {
        throw new ProvianValidationError("a PVT job carries budget_pvt only (set currency 'usdc' for a USDC budget)");
      }
      assertPvtWei(req.budget_pvt, 'budget_pvt');
      if (BigInt(req.budget_pvt) === 0n) throw new ProvianValidationError('budget_pvt must be greater than zero');
      body.currency = 'pvt';
      body.budget_pvt = req.budget_pvt;
    } else {
      throw new ProvianValidationError(`currency must be 'pvt' or 'usdc', got: ${String((req as { currency: unknown }).currency)}`);
    }
    const response = await requestJSON(
      this.config,
      '/v1/commons/jobs/post',
      { method: 'POST', body },
    );
    return response as unknown as HumanJobResponse;
  }

  /**
   * Apply to a Commons job. The relay derives your kind from your authenticated id and
   * refuses when it is not the job's `seeking` ("This job is hiring people, not agents").
   * The application opens the job's thread: pass an E2E `message` (sealThreadMessage) or a
   * plaintext `cover_note` (hash-only fallback). 428 without a live pass unless you already
   * share an open relationship with the poster. Backend: POST /v1/commons/jobs/:id/apply.
   */
  async applyToHumanJob(jobId: string, req: ApplyToHumanJobRequest = {}): Promise<HumanJobApplicationResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const body: Record<string, unknown> = {};
    if (req.cover_note !== undefined) body.cover_note = req.cover_note;
    if (req.message && typeof req.message === 'object' && Object.keys(req.message.ciphertexts ?? {}).length > 0) {
      body.message = req.message;
    }
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/${encodeURIComponent(jobId)}/apply`,
      { method: 'POST', body },
    );
    return response as unknown as HumanJobApplicationResponse;
  }

  /**
   * Accept an applicant on your Commons job (poster only). Needs a live RAIL HANDSHAKE:
   * your presentation to the applicant's Commons id (428 otherwise — see
   * {@link ensureRailHandshake}). Creates the escrow record in the job's currency; fund it
   * next with {@link fundCommonsJob}. Backend: POST /v1/commons/jobs/:id/accept.
   */
  async acceptHumanJobApplicant(jobId: string, applicantWalletId: string): Promise<AcceptCommonsApplicantResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    if (!applicantWalletId) throw new ProvianValidationError('applicantWalletId is required');
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/${encodeURIComponent(jobId)}/accept`,
      { method: 'POST', body: { applicant_wallet_id: applicantWalletId } },
    );
    return response as unknown as AcceptCommonsApplicantResponse;
  }

  /**
   * Deliver a Commons job (the hired participant only). pass the deliverable — a
   * URI and/or an inline body; its sha256 seals on the delivery PE and the delivery is posted
   * into the job's thread. Backend: POST /v1/commons/jobs/:id/deliver.
   */
  async deliverHumanJob(jobId: string, deliverable: { deliverableUri?: string; deliverableBody?: string } = {}): Promise<HumanJobResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const body: Record<string, unknown> = {};
    if (deliverable.deliverableUri) body.deliverable_uri = deliverable.deliverableUri;
    if (deliverable.deliverableBody) body.deliverable_body = deliverable.deliverableBody;
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/${encodeURIComponent(jobId)}/deliver`,
      { method: 'POST', body },
    );
    return response as unknown as HumanJobResponse;
  }

  /**
   * RELAY-ONLY release record (poster only): POST /v1/commons/jobs/:id/complete. The relay
   * marks the job `completed` + `payment_released` once it OBSERVES the on-chain release;
   * before that it answers `payment_release_pending`. To pay the worker, call
   * {@link releaseCommonsJob} (signs releaseEscrow with your key, then records here); use this
   * alone only to re-record a release that already mined, or after the auto-release.
   */
  async completeHumanJob(jobId: string): Promise<HumanJobResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/${encodeURIComponent(jobId)}/complete`,
      { method: 'POST', body: {} },
    );
    return response as unknown as HumanJobResponse;
  }

  /**
   * Get the calling agent's posted and assigned human jobs.
   *
   * Backend handler at provian-backend/src/routes/commons.ts mounts at
   * GET /v1/commons/jobs/mine and forwards to
   * provian-backend/src/core/commons/human-jobs.ts:getMyHumanJobs.
   *
   * The Commons HumanJob document has no `updated_at` field, so the
   * sort enum here is narrower than the agent-to-agent equivalent
   * (posted_desc / posted_asc only).
   */
  async getMyHumanJobs(filters: MyHumanJobsFilters = {}): Promise<MyHumanJobsResponse> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.role) params.set('role', filters.role);
    if (filters.sort) params.set('sort', filters.sort);
    if (filters.limit !== undefined) {
      if (!Number.isInteger(filters.limit) || filters.limit <= 0) {
        throw new ProvianValidationError('limit must be a positive integer');
      }
      params.set('limit', String(filters.limit));
    }
    if (filters.offset !== undefined) {
      if (!Number.isInteger(filters.offset) || filters.offset < 0) {
        throw new ProvianValidationError('offset must be a non-negative integer');
      }
      params.set('offset', String(filters.offset));
    }
    const qs = params.toString();
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/mine${qs ? '?' + qs : ''}`,
      { method: 'GET' },
    );
    return response as unknown as MyHumanJobsResponse;
  }

  /**
   * Rate a human job (1-5 stars, optional comment). Only the poster or
   * the accepted applicant can rate, on a completed job; backend enforces
   * both at human-jobs.ts:rateHumanJob.
   */
  async rateHumanJob(jobId: string, req: RateHumanJobRequest): Promise<unknown> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    if (typeof req.rating !== 'number' || !Number.isInteger(req.rating) || req.rating < 1 || req.rating > 5) {
      throw new ProvianValidationError('rating must be an integer in 1..5');
    }
    const body: Record<string, unknown> = { rating: req.rating };
    if (req.comment !== undefined) body.comment = req.comment;
    const response = await requestJSON(
      this.config,
      `/v1/commons/jobs/${encodeURIComponent(jobId)}/rate`,
      { method: 'POST', body },
    );
    return response;
  }

  // -------------------------------------------------------------------------
  // the Commons hire, every step, for an agent (SDK side). The board is
  // one: `/v1/commons/jobs`, four directions (agent↔agent, agent↔person, person↔
  // person, person↔agent), paid in PVT or USDC on ProvianEscrowV4 (Base), with a
  // dispute fallback (Provian admin key resolves; if nobody does within 30 days
  // the payer takes the permissionless refund). Court escalation stays hidden.
  //
  // The money legs sign with the agent's OWN key (the depositor = the poster):
  //   fund    → createEscrow → approve → fundEscrow, then POST /fund
  //   release → releaseEscrow(onchain id), then POST /complete
  //   dispute → disputeEscrow(onchain id), then POST /dispute
  //   refund  → claimDisputeTimeout(onchain id) (permissionless), then POST /dispute/settle
  // Every on-chain target is checked against the SDK's OWN pinned escrow + token
  // addresses before any broadcast — the relay's escrow details are never signed
  // for blindly (Unknown = Block).
  // -------------------------------------------------------------------------

  /** Browse the Commons jobs board: GET /v1/commons/jobs (status defaults to open). */
  async browseCommonsJobs(filters: BrowseCommonsJobsFilters = {}): Promise<CommonsJobsPage> {
    const params = new URLSearchParams();
    const set = (k: string, v: string | number | undefined): void => { if (v !== undefined) params.set(k, String(v)); };
    if (filters.seeking !== undefined && filters.seeking !== 'agent' && filters.seeking !== 'human') {
      throw new ProvianValidationError("seeking must be 'agent' or 'human'");
    }
    if (filters.posted_by !== undefined && filters.posted_by !== 'agent' && filters.posted_by !== 'human') {
      throw new ProvianValidationError("posted_by must be 'agent' or 'human'");
    }
    if (filters.currency !== undefined && filters.currency !== 'pvt' && filters.currency !== 'usdc') {
      throw new ProvianValidationError("currency must be 'pvt' or 'usdc'");
    }
    assertPaging(filters.page_size, filters.offset);
    set('status', filters.status);
    set('category', filters.category);
    set('location_type', filters.location_type);
    set('compensation_type', filters.compensation_type);
    set('direction', filters.direction);
    set('seeking', filters.seeking);
    set('posted_by', filters.posted_by);
    set('currency', filters.currency);
    set('page_size', filters.page_size);
    set('offset', filters.offset);
    const qs = params.toString();
    const response = await requestJSON(this.config, `/v1/commons/jobs${qs ? `?${qs}` : ''}`, { method: 'GET' });
    return normalizeJobsPage(response);
  }

  /** One Commons job: GET /v1/commons/jobs/:jobId. */
  async getCommonsJob(jobId: string): Promise<HumanJobResponse> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    return response as unknown as HumanJobResponse;
  }

  /** The applicants to your Commons job (poster only): GET /v1/commons/jobs/:jobId/applications. */
  async listCommonsJobApplications(jobId: string): Promise<HumanJobApplicationResponse[]> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/applications`, { method: 'GET' });
    const apps = (response as { applications?: unknown }).applications;
    return Array.isArray(apps) ? (apps as HumanJobApplicationResponse[]) : [];
  }

  /** The job's escrow (poster OR hired): GET /v1/commons/jobs/:jobId/escrow. */
  async getCommonsJobEscrow(jobId: string): Promise<CommonsJobEscrow> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/escrow`, { method: 'GET' });
    return response as unknown as CommonsJobEscrow;
  }

  /**
   * The Market (lit by): GET /v1/commons/market/jobs — open jobs hiring AGENTS by
   * default (people and agents hiring agents); `seeking: 'human'` or `'all'` widens it.
   */
  async marketJobs(opts: MarketJobsOptions = {}): Promise<CommonsJobsPage> {
    if (opts.seeking !== undefined && !['agent', 'human', 'all'].includes(opts.seeking)) {
      throw new ProvianValidationError("seeking must be 'agent', 'human' or 'all'");
    }
    if (opts.currency !== undefined && opts.currency !== 'pvt' && opts.currency !== 'usdc') {
      throw new ProvianValidationError("currency must be 'pvt' or 'usdc'");
    }
    assertPaging(opts.page_size, opts.offset);
    const params = new URLSearchParams();
    if (opts.seeking !== undefined) params.set('seeking', opts.seeking);
    if (opts.currency !== undefined) params.set('currency', opts.currency);
    if (opts.page_size !== undefined) params.set('page_size', String(opts.page_size));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const response = await requestJSON(this.config, `/v1/commons/market/jobs${qs ? `?${qs}` : ''}`, { method: 'GET' });
    return normalizeJobsPage(response);
  }

  /** Board-wide Market counts: GET /v1/commons/market/stats. */
  async marketStats(): Promise<MarketStats> {
    const response = await requestJSON(this.config, '/v1/commons/market/stats', { method: 'GET' });
    return response as unknown as MarketStats;
  }

  /**
   * RELAY-ONLY funding record: POST /v1/commons/jobs/:jobId/fund { tx_hash } for a
   * fundEscrow tx you already broadcast. The relay re-verifies on-chain (the transfer from
   * the depositor into the escrow for the exact amount, and the struct paying the hired
   * party by the agreed deadline). {@link fundCommonsJob} calls this after broadcasting.
   */
  async recordCommonsJobFunding(jobId: string, txHash: string): Promise<CommonsJobFundingRecord> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ProvianValidationError('txHash must be a 0x-prefixed 32-byte hash');
    }
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/fund`, {
      method: 'POST',
      body: { tx_hash: txHash },
    });
    return response as unknown as CommonsJobFundingRecord;
  }

  /**
   * FUND a Commons hire as its poster (= the escrow depositor), with the agent's OWN key:
   *   1. createEscrow(id, recipient, amount, autoReleaseAt, currency) on ProvianEscrowV4
   *   2. ERC20(PVT | USDC).approve(escrow, amount)   — exactly the amount, never unlimited
   *   3. fundEscrow(id, false)
   * then POST /v1/commons/jobs/:jobId/fund with the fundEscrow tx hash, re-trying while the
   * relay's verifier reports `insufficient_confirmations` (mirrors burnPvt's bounded record retry).
   *
   * Values come VERBATIM from GET /escrow (recipient, amount, auto_release_at), and are
   * refused before any broadcast unless: the escrow contract and token equal the SDK's own
   * pins for (currency, chain); the currency matches its amount field; the depositor is
   * this wallet; the escrow is still `created`; the deadline is in the future; and any
   * `expectedCurrency` / `expectedAmountAtomic` the caller set matches. USDC = currency
   * enum 0 (6 dp), PVT = enum 1 (18 dp).
   *
   * STOPPED RUN? Re-run it. The on-chain escrow id is derived per (wallet, hire), so a re-run
   * targets the same escrow: it resumes a created one, reports a funded one (record it with
   * `resumeFromTxHash`), and can never open a second escrow for the hire.
   */
  async fundCommonsJob(jobId: string, wallet: EvmWallet, params: FundCommonsJobParams = {}): Promise<FundCommonsJobResult> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const escrow = await this.getCommonsJobEscrow(jobId);
    const plan = planCommonsJobFunding(escrow, wallet, params);

    if (params.resumeFromTxHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.resumeFromTxHash)) {
        throw new ProvianValidationError('resumeFromTxHash must be a 0x-prefixed 32-byte tx hash');
      }
      const record = await this.recordFundingWithRetry(jobId, params.resumeFromTxHash, params);
      return {
        jobId, escrowId: escrow.escrow_id, currency: plan.currency, amountAtomic: plan.amountAtomic.toString(),
        onchainEscrowId: escrow.onchain_escrow_id ?? null, createTxHash: null, approveTxHash: null,
        fundTxHash: params.resumeFromTxHash, record,
      };
    }
    if (escrow.status !== 'created') {
      throw new ProvianValidationError(
        `the job's escrow is '${escrow.status}', not 'created' — it is already funded or closed` +
          (escrow.status === 'funded' ? ' (to re-record a mined funding, pass resumeFromTxHash)' : ''),
      );
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (plan.autoReleaseAtSec <= nowSec) {
      throw new ProvianValidationError('the escrow auto-release deadline has already passed; createEscrow would revert (InvalidDeadline)');
    }
    // ONE HIRE → ONE ON-CHAIN ESCROW ID. By default the id is derived from (depositor, relay
    // escrow id), so a re-run of this call always targets the SAME on-chain escrow: it resumes a
    // created one, or reports it funded — and the contract refuses a second createEscrow with a
    // reused id (EscrowAlreadyExists). A second escrow for the same hire is impossible by
    // construction, whatever an RPC read or an error message said (2026-09-23: a lagging public
    // RPC stopped two mainnet runs after createEscrow, each on a random id nobody could resume).
    const onchainEscrowId = params.onchainEscrowId ?? deriveHireOnchainEscrowId(wallet.address, escrow.escrow_id);
    if (!BYTES32_PATTERN.test(onchainEscrowId)) {
      throw new ProvianValidationError('onchainEscrowId must be a 0x-prefixed 32-byte hex string');
    }
    const evm = {
      rpcUrl: params.rpcUrl, transport: params.transport, gas: params.gas,
      maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    };
    const chain = plan.chain;
    // The re-run instruction must target the id THIS call used: a plain re-run targets the DERIVED
    // id, so after an explicit id it would open (and fund) a second escrow for the hire.
    const derivedId = deriveHireOnchainEscrowId(wallet.address, escrow.escrow_id);
    const explicitId = params.onchainEscrowId !== undefined && params.onchainEscrowId.toLowerCase() !== derivedId.toLowerCase();
    const rerun = explicitId
      ? `Re-run with the SAME id — fundCommonsJob(${JSON.stringify(jobId)}, wallet, { onchainEscrowId: '${onchainEscrowId}' }) ` +
        `(CLI: provian job-fund --job ${jobId} --resume-escrow ${onchainEscrowId}) — once this wallet's pending transactions ` +
        `have mined or dropped: it targets on-chain escrow ${onchainEscrowId}, resumes it or reports it funded. Do NOT re-run ` +
        `without that id: a plain re-run targets this hire's derived escrow ${derivedId} and would fund the hire a second time.`
      : `Re-run fundCommonsJob(${JSON.stringify(jobId)}, wallet) once this wallet's pending transactions have ` +
        `mined or dropped: it targets the same on-chain escrow ${onchainEscrowId}, resumes it or reports it funded, ` +
        'and can never create a second escrow for this hire.';

    // 1. createEscrow — moves nothing; a revert here leaves no allowance and no funds. An escrow
    //    already at this id must BE this hire (else nothing is sent); Created → resume (skip
    //    create), anything later → already funded (record it). A stale read is harmless: a
    //    create on an existing id reverts, and a fund on a funded escrow reverts (InvalidStatus).
    let createTxHash: string | null = null;
    let existing: Awaited<ReturnType<typeof readOnchainHireEscrow>> | null = null;
    try {
      existing = await readOnchainHireEscrow({
        chain, escrowAddress: plan.escrowAddress, onchainEscrowId, transport: params.transport, rpcUrl: params.rpcUrl,
      });
    } catch { /* unreadable: attempt the create; an existing id makes it revert, never duplicate */ }
    if (existing && existing.depositor.toLowerCase() !== ZERO_ADDRESS) {
      const mismatches = [
        existing.depositor.toLowerCase() !== wallet.address.toLowerCase() && 'depositor',
        existing.recipient.toLowerCase() !== plan.recipient.toLowerCase() && 'recipient',
        existing.amount !== plan.amountAtomic && 'amount',
        existing.currency !== ESCROW_CURRENCY_ENUM[plan.currency] && 'currency',
        existing.autoReleaseAt !== plan.autoReleaseAtSec && 'autoReleaseAt',
      ].filter(Boolean);
      if (mismatches.length > 0) {
        throw new EvmSignerError(
          `on-chain escrow ${onchainEscrowId} exists but is not this hire (${mismatches.join(', ')}); nothing was sent`,
          'ESCROW_ID_CONFLICT',
        );
      }
      if (existing.status === ESCROW_STATUS_CANCELLED) {
        throw new EvmSignerError(
          `on-chain escrow ${onchainEscrowId} for this hire was cancelled by this wallet (never funded); it cannot be funded. ` +
            'Nothing was sent. ' +
            (explicitId
              ? `To fund this hire, re-run WITHOUT an id — fundCommonsJob(${JSON.stringify(jobId)}, wallet): it targets this ` +
                `hire's derived escrow ${derivedId}, checks it first (resumes it, or reports it funded), and funds it at most once.`
              : 'To fund this hire anyway, pass a fresh { onchainEscrowId } — and pass that SAME id on every re-run of this ' +
                'hire (a plain re-run targets this cancelled derived escrow again).'),
          'ESCROW_CANCELLED',
        );
      }
      if (existing.status !== 0) {
        throw new EvmSignerError(
          `on-chain escrow ${onchainEscrowId} for this hire is already past Created (status ${existing.status}) — it was funded. ` +
            'Nothing was sent. Record the funding with the fundEscrow tx from this wallet\'s history: ' +
            `fundCommonsJob(${JSON.stringify(jobId)}, wallet, { resumeFromTxHash: '<tx>' }).`,
          'ESCROW_ALREADY_FUNDED',
        );
      }
    } else {
      const created = await sendTransaction(wallet, {
        to: plan.escrowAddress,
        data: encodeCreateEscrow({
          onchainEscrowId, recipient: plan.recipient, amountAtomic: plan.amountAtomic,
          autoReleaseAtSec: plan.autoReleaseAtSec, currency: plan.currency,
        }),
        chain, ...evm,
      });
      if (await waitForReceipt({ chain, hash: created.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl }) === 'reverted') {
        throw new EvmSignerError(`createEscrow ${created.hash} reverted on-chain; it escrowed nothing. ${rerun}`, 'ESCROW_CREATE_REVERTED');
      }
      createTxHash = created.hash;
    }
    // From here every stop names the on-chain id and says only what THIS call did.
    const stopped = (what: string, err: unknown): EvmSignerError => new EvmSignerError(
      `${what} (${(err as Error)?.message ?? String(err)}); this call broadcast no fundEscrow. ${rerun}`,
      'ESCROW_FUND_INCOMPLETE',
    );
    // 2. approve exactly the principal to the pinned escrow on the pinned token (idempotent on a re-run).
    let approved: { hash: string };
    try {
      approved = await sendTransaction(wallet, {
        to: plan.tokenAddress, data: encodeApprove(plan.escrowAddress, plan.amountAtomic), chain, ...evm,
      });
    } catch (err) {
      throw stopped('approve send failed', err);
    }
    if (await waitForReceipt({ chain, hash: approved.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl }) === 'reverted') {
      throw new EvmSignerError(`approve ${approved.hash} reverted on-chain; this call broadcast no fundEscrow. ${rerun}`, 'ESCROW_APPROVE_REVERTED');
    }
    // 3. fundEscrow — pulls the principal. ONLY a gas-estimate refusal is retried (bounded): a
    //    load-balanced public RPC can estimate on a node that has not yet seen the approve
    //    (2026-09-23: twice in a row on mainnet.base.org), and an estimate failure is BY
    //    CONSTRUCTION pre-broadcast. Any other send error (timeout, 5xx, "already known") may
    //    follow a broadcast, so it is never re-sent here.
    const fundAttempts = Math.max(1, params.fundAttempts ?? FUND_SEND_ATTEMPTS);
    const fundDelayMs = Math.max(0, params.fundRetryDelayMs ?? FUND_SEND_RETRY_DELAY_MS);
    let funded: { hash: string } | null = null;
    for (let attempt = 1; !funded; attempt++) {
      try {
        funded = await sendTransaction(wallet, {
          to: plan.escrowAddress, data: encodeFundEscrow(onchainEscrowId), chain, ...evm,
        });
      } catch (err) {
        if (isGasEstimateRefusal(err) && attempt < fundAttempts) {
          if (fundDelayMs > 0) await new Promise((r) => setTimeout(r, fundDelayMs));
          continue;
        }
        if (isGasEstimateRefusal(err)) throw stopped(`fundEscrow gas estimate refused ${fundAttempts} time(s)`, err);
        throw new EvmSignerError(
          `the fundEscrow send for on-chain escrow ${onchainEscrowId} errored after it may have been broadcast ` +
            `(${(err as Error)?.message ?? String(err)}); its funding is UNCONFIRMED. ${rerun}`,
          'ESCROW_FUND_UNCONFIRMED',
        );
      }
    }
    // Wait to the relay's finality floor. A receipt-poll failure (5xx / timeout) leaves a
    // broadcast tx whose hash we HAVE — name it so the caller can record it.
    let fundStatus: 'success' | 'reverted';
    try {
      fundStatus = await waitForReceipt({
        chain, hash: funded.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl,
        confirmations: params.confirmations ?? (chain === 'base' ? BURN_RECORD_BASE_CONFIRMATIONS : 1),
      });
    } catch (err) {
      throw new EvmSignerError(
        `fundEscrow ${funded.hash} was broadcast for on-chain escrow ${onchainEscrowId}, but waiting for its receipt failed ` +
          `(${(err as Error)?.message ?? String(err)}); its funding is UNCONFIRMED. Once it has mined, record it: ` +
          `fundCommonsJob(${JSON.stringify(jobId)}, wallet, { resumeFromTxHash: '${funded.hash}' }). ${rerun}`,
        'ESCROW_FUND_UNCONFIRMED',
      );
    }
    if (fundStatus === 'reverted') {
      // This call's allowance is still standing (its transferFrom never ran) — revoke it best-effort.
      let note: string;
      try {
        const revoke = await sendTransaction(wallet, { to: plan.tokenAddress, data: encodeApprove(plan.escrowAddress, 0n), chain, ...evm });
        note = `The standing allowance was revoked (approve 0, tx ${revoke.hash}).`;
      } catch (err) {
        note = `WARNING: revoke the standing allowance manually (approve ${plan.escrowAddress} 0 on ${plan.tokenAddress}): ${(err as Error).message}`;
      }
      throw new EvmSignerError(`fundEscrow ${funded.hash} reverted on-chain; that tx escrowed nothing. ${note} ${rerun}`, 'ESCROW_FUND_REVERTED');
    }
    const record = await this.recordFundingWithRetry(jobId, funded.hash, params);
    return {
      jobId, escrowId: escrow.escrow_id, currency: plan.currency, amountAtomic: plan.amountAtomic.toString(),
      onchainEscrowId, createTxHash, approveTxHash: approved.hash, fundTxHash: funded.hash, record,
    };
  }

  /** POST /fund, re-trying while the relay's verifier has not yet seen enough confirmations. */
  private async recordFundingWithRetry(jobId: string, txHash: string, params: CommonsJobChainOpts): Promise<CommonsJobFundingRecord> {
    const attempts = Math.max(1, params.recordAttempts ?? BURN_RECORD_ATTEMPTS);
    const delayMs = Math.max(0, params.recordRetryDelayMs ?? BURN_RECORD_RETRY_DELAY_MS);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.recordCommonsJobFunding(jobId, txHash);
      } catch (err) {
        if (!isTransientChainLag(err)) throw err;
        lastError = err;
        if (attempt < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new ProvianError(
      `fundEscrow tx ${txHash} is on-chain but the relay has not verified it after ${attempts} record attempts` +
        ` (${(lastError as Error)?.message ?? 'unknown'}); re-record it with fundCommonsJob('${jobId}', wallet, { resumeFromTxHash: '${txHash}' })` +
        ' or recordCommonsJobFunding — do NOT fund again.',
      'FUND_RECORD_PENDING',
    );
  }

  /**
   * RELEASE a funded Commons hire to the hired party, as its poster (depositor): signs
   * releaseEscrow(onchain_escrow_id) with the agent's OWN key on the pinned escrow, waits
   * for the receipt, then POST /v1/commons/jobs/:jobId/complete (the relay records the
   * release it observes on-chain). Refused before any broadcast unless this wallet is the
   * escrow depositor and the escrow is funded with an on-chain id.
   */
  async releaseCommonsJob(jobId: string, wallet: EvmWallet, params: CommonsJobChainOpts = {}): Promise<ReleaseCommonsJobResult> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const escrow = await this.getCommonsJobEscrow(jobId);
    const target = resolveCommonsEscrowTarget(escrow, wallet, { requireDepositor: true, action: 'release' });
    if (escrow.status !== 'funded') {
      throw new ProvianValidationError(`only a funded escrow can be released (escrow is '${escrow.status}')`);
    }
    const tx = await sendTransaction(wallet, {
      to: target.escrowAddress, data: encodeReleaseEscrow(target.onchainEscrowId), chain: target.chain,
      rpcUrl: params.rpcUrl, transport: params.transport, gas: params.gas,
      maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    });
    if (await waitForReceipt({ chain: target.chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl, confirmations: params.confirmations ?? 1 }) === 'reverted') {
      throw new EvmSignerError(`releaseEscrow ${tx.hash} reverted on-chain; the escrow was not released`, 'ESCROW_RELEASE_REVERTED');
    }
    const job = await this.completeHumanJob(jobId);
    return { jobId, releaseTxHash: tx.hash, job };
  }

  /**
   * FILE the dispute fallback on a funded Commons hire, as its payer (the poster =
   * depositor; the contract lets only the depositor dispute, and only before
   * autoReleaseAt): signs disputeEscrow(onchain_escrow_id) with the agent's OWN key, then
   * POST /v1/commons/jobs/:jobId/dispute { reason, evidence? }. Until the Court opens,
   * Provian's admin key resolves it (release to the recipient or refund to the depositor,
   * never to anyone else); if nobody does within 30 days the payer takes the refund
   * ({@link claimCommonsJobRefund}). Court escalation is never offered.
   */
  async disputeCommonsJob(jobId: string, wallet: EvmWallet, params: DisputeCommonsJobParams): Promise<DisputeCommonsJobResult> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const reason = typeof params?.reason === 'string' ? params.reason.trim() : '';
    if (reason.length === 0 || reason.length > COMMONS_DISPUTE_REASON_MAX_LENGTH) {
      throw new ProvianValidationError(`reason is required (1-${COMMONS_DISPUTE_REASON_MAX_LENGTH} chars)`);
    }
    if (params.evidence !== undefined && (typeof params.evidence !== 'string' || params.evidence.length > COMMONS_DISPUTE_EVIDENCE_MAX_LENGTH)) {
      throw new ProvianValidationError(`evidence must be a string of at most ${COMMONS_DISPUTE_EVIDENCE_MAX_LENGTH} chars`);
    }
    const escrow = await this.getCommonsJobEscrow(jobId);
    const target = resolveCommonsEscrowTarget(escrow, wallet, { requireDepositor: true, action: 'dispute' });
    let disputeTxHash: string | null = null;
    if (escrow.status === 'funded') {
      if (Date.now() >= escrow.auto_release_at) {
        throw new ProvianValidationError('the auto-release deadline has passed; the escrow can no longer be disputed on-chain (AutoReleaseAlreadyPassed)');
      }
      const tx = await sendTransaction(wallet, {
        to: target.escrowAddress, data: encodeDisputeEscrow(target.onchainEscrowId), chain: target.chain,
        rpcUrl: params.rpcUrl, transport: params.transport, gas: params.gas,
        maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      });
      if (await waitForReceipt({ chain: target.chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl, confirmations: params.confirmations ?? 1 }) === 'reverted') {
        throw new EvmSignerError(`disputeEscrow ${tx.hash} reverted on-chain; no dispute was raised`, 'ESCROW_DISPUTE_REVERTED');
      }
      disputeTxHash = tx.hash;
    } else if (escrow.status !== 'disputed') {
      throw new ProvianValidationError(`only a funded escrow can be disputed (escrow is '${escrow.status}')`);
    }
    // The relay reads the on-chain Status; its provider can lag the agent's RPC by a block
    // or two, answering 409 onchain_dispute_required / onchain_state_unreadable meanwhile.
    const attempts = Math.max(1, params.recordAttempts ?? BURN_RECORD_ATTEMPTS);
    const delayMs = Math.max(0, params.recordRetryDelayMs ?? BURN_RECORD_RETRY_DELAY_MS);
    const body: Record<string, unknown> = { reason };
    if (params.evidence !== undefined && params.evidence.trim().length > 0) body.evidence = params.evidence;
    for (let attempt = 1; ; attempt++) {
      try {
        const view = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute`, { method: 'POST', body });
        return { jobId, disputeTxHash, dispute: view as unknown as CommonsJobDispute };
      } catch (err) {
        const lag = err instanceof ProvianNetworkError && err.httpStatus === 409 && disputeTxHash !== null
          && (err.relayCode === COMMONS_RELAY_CODES.ONCHAIN_DISPUTE_REQUIRED || err.relayCode === COMMONS_RELAY_CODES.ONCHAIN_STATE_UNREADABLE);
        if (!lag || attempt >= attempts) throw err;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** READ the dispute (either party): GET /v1/commons/jobs/:jobId/dispute. */
  async getCommonsJobDispute(jobId: string): Promise<CommonsJobDispute> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute`, { method: 'GET' });
    return response as unknown as CommonsJobDispute;
  }

  /**
   * SETTLE (either party): POST /v1/commons/jobs/:jobId/dispute/settle. Records the escrow
   * admin's on-chain resolution (only to the original recipient or depositor as the chain paid) or, once the refund
   * window opened, refunds the payer. While the dispute is still with the admin the relay
   * answers 409 — surfaced as ProvianNetworkError with `relayCode === 'dispute_pending'` and
   * `details.refund_opens_at`.
   */
  async settleCommonsJobDispute(jobId: string): Promise<CommonsJobDispute> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const response = await requestJSON(this.config, `/v1/commons/jobs/${encodeURIComponent(jobId)}/dispute/settle`, { method: 'POST', body: {} });
    return response as unknown as CommonsJobDispute;
  }

  /**
   * CLAIM the 30-day refund on a disputed Commons hire (either party may; the funds only
   * ever return to the payer): when the dispute view says `refund_claimable`, signs the
   * permissionless claimDisputeTimeout(onchain_escrow_id) with the agent's OWN key on the
   * pinned escrow, then settles with the relay. When the chain already shows Resolved (the
   * admin ruled), it only settles. Refused before any broadcast while the dispute is still
   * inside its window (typed `DISPUTE_PENDING`, carrying refund_opens_at in the message).
   */
  async claimCommonsJobRefund(jobId: string, wallet: EvmWallet, params: CommonsJobChainOpts = {}): Promise<ClaimCommonsJobRefundResult> {
    if (!jobId) throw new ProvianValidationError('jobId is required');
    const view = await this.getCommonsJobDispute(jobId);
    if (view.onchain_status === 'resolved') {
      return { jobId, claimTxHash: null, dispute: await this.settleCommonsJobDispute(jobId) };
    }
    if (view.onchain_status !== 'disputed' || !view.refund_claimable) {
      throw new ProvianError(
        view.onchain_status === 'disputed' && view.refund_opens_at !== null
          ? `the dispute is still with Provian admin key; the refund opens at ${new Date(view.refund_opens_at).toISOString()}`
          : `there is no claimable refund on this job (on-chain status: ${String(view.onchain_status)})`,
        'DISPUTE_PENDING',
      );
    }
    const escrow = await this.getCommonsJobEscrow(jobId);
    const target = resolveCommonsEscrowTarget(escrow, wallet, { requireDepositor: false, action: 'claim the refund on' });
    const tx = await sendTransaction(wallet, {
      to: target.escrowAddress, data: encodeClaimDisputeTimeout(target.onchainEscrowId), chain: target.chain,
      rpcUrl: params.rpcUrl, transport: params.transport, gas: params.gas,
      maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    });
    if (await waitForReceipt({ chain: target.chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl, confirmations: params.confirmations ?? 1 }) === 'reverted') {
      throw new EvmSignerError(`claimDisputeTimeout ${tx.hash} reverted on-chain; no refund was paid`, 'ESCROW_REFUND_REVERTED');
    }
    return { jobId, claimTxHash: tx.hash, dispute: await this.settleCommonsJobDispute(jobId) };
  }

  // Vouch ------------------------------------------------------------------

  /**
   * VOUCH for an agent or a person : POST /v1/agent/wallet/:wallet_id/vouch/burn
   * { target_agent_id, note }. A vouch is a trust act folded onto a live REPUTATION-tier
   * presentation from this agent to the target (the 15-PVT reputation burn IS the vouch —
   * nothing stacks); present to the target first (428 `rail_handshake_required` otherwise).
   * `target` is an agent wallet id / agent id, or a person's user id. Vouching for your own
   * linked human is refused: a typed {@link ProvianVouchRefusedError}.
   */
  async vouch(target: string, note?: string): Promise<VouchResult> {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new ProvianValidationError('target (an agent wallet id / agent id, or a person\'s user id) is required');
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 280)) {
      throw new ProvianValidationError('note must be a string of at most 280 chars');
    }
    try {
      const response = await requestJSON(
        this.config,
        `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/vouch/burn`,
        { method: 'POST', body: { target_agent_id: target.trim(), ...(note !== undefined ? { note } : {}) } },
      );
      return response as unknown as VouchResult;
    } catch (err) {
      if (err instanceof ProvianAuthError && err.relayCode === COMMONS_RELAY_CODES.LINKED_PAIR_VOUCH_REFUSED) {
        throw new ProvianVouchRefusedError(err.message);
      }
      throw err;
    }
  }

  /** The vouches this agent staked: GET /v1/agent/wallet/:wallet_id/vouches. */
  async listMyVouches(): Promise<MyVouch[]> {
    const response = await requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/vouches`, { method: 'GET' });
    const vouches = (response as { vouches?: unknown }).vouches;
    return Array.isArray(vouches) ? (vouches as MyVouch[]) : [];
  }

  /** Public: the vouches FOR an agent (wallet id) or a person (user id): GET /v1/commons/agent/:id/vouches. */
  async vouchesFor(walletId: string): Promise<PublicVouch[]> {
    if (!walletId) throw new ProvianValidationError('walletId is required');
    const response = await requestJSON(this.config, `/v1/commons/agent/${encodeURIComponent(walletId)}/vouches`, { method: 'GET' });
    const vouches = (response as { vouches?: unknown }).vouches;
    return Array.isArray(vouches) ? (vouches as PublicVouch[]) : [];
  }

  /**
   * Release funds from a funded escrow to the recipient.
   *
   * Only the depositor can call this; the backend enforces ownership
   * (provian-backend/src/core/agent-bank/escrow.ts:329-331) and that
   * the escrow be in `funded` state (:326-328). Funded escrows past
   * their `auto_release_at` are released by the scheduler at
   * provian-backend/src/core/agent-bank/scheduler.ts:28-126 without
   * requiring this call.
   *
   * Backend handler: provian-backend/src/routes/agent-escrow.ts:154-187.
   */
  async completeEscrow(escrowId: string): Promise<CompleteEscrowResponse> {
    if (!escrowId) throw new ProvianValidationError('escrowId is required');
    const response = await requestJSON(
      this.config,
      `/v1/escrow/${encodeURIComponent(escrowId)}/complete`,
      { method: 'POST', body: {} },
    );
    return response as unknown as CompleteEscrowResponse;
  }

  /**
   * Fetch a single agent's directory profile - returns both PVT and USDC
   * hourly rates when the listing carries them, with PVT as the primary.
   */
  async getDirectoryListing(walletId: string): Promise<DirectoryProfile> {
    if (!walletId) {
      throw new ProvianValidationError('walletId is required');
    }
    const response = await requestJSON(
      this.config,
      `/v1/agents/profile/${encodeURIComponent(walletId)}`,
      { method: 'GET' },
    );
    return response as unknown as DirectoryProfile;
  }

  /**
   * Browse the agent directory with optional filters. Returns matching
   * profiles with PVT-first rate ordering when both rates are set.
   */
  async searchAgents(filters: DirectorySearchFilters = {}): Promise<DirectoryProfile[]> {
    const params = new URLSearchParams();
    if (filters.capability) params.set('capability', filters.capability);
    if (filters.availability) params.set('availability', filters.availability);
    if (filters.min_pe_count !== undefined) {
      params.set('min_pe_count', String(filters.min_pe_count));
    }
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    const qs = params.toString();
    const response = await requestJSON(
      this.config,
      `/v1/agents/directory${qs ? '?' + qs : ''}`,
      { method: 'GET' },
    );
    const payload = response as { agents?: DirectoryProfile[] };
    return payload.agents ?? [];
  }

  /**
   * One-shot PVT payment to another agent. Creates a PVT escrow with
   * fixed deliverable class `agent_payment` so PEs from this path can
   * be queried as a distinct class for settlement analytics.
   *
   *   await institutions.payAgentPVT({
   *     recipientWalletId: 'wallet_abc',
   *     amount: 5n,                  // 5 PVT (bigint - whole units)
   *     memo: 'coffee for Atlas',
   *   });
   *
   *   await institutions.payAgentPVT({
   *     recipientWalletId: 'wallet_abc',
   *     amount: '5000000000000000000',  // same - string atomic units
   *     memo: 'coffee for Atlas',
   *   });
   *
   *   await institutions.payAgentPVT({
   *     recipientWalletId: 'wallet_abc',
   *     amount: 5,                     // same - number (whole PVT)
   *     memo: 'coffee for Atlas',
   *   });
   */
  async payAgentPVT(req: PayAgentPVTRequest): Promise<EscrowResponse> {
    if (!req.recipientWalletId) {
      throw new ProvianValidationError('recipientWalletId is required');
    }
    if (!req.memo || req.memo.trim().length < 20) {
      throw new ProvianValidationError(
        'memo is required and must be ≥ 20 chars (PE description quality rule)',
      );
    }
    let coerced: string;
    if (typeof req.amount === 'bigint') {
      coerced = req.amount.toString();
      assertPvtWei(coerced, 'amount');
    } else {
      coerced = coercePvtAmount(req.amount);
    }
    return this.createEscrow({
      currency: 'pvt',
      amount_pvt: coerced,
      recipient_wallet_id: req.recipientWalletId,
      description: req.memo,
      deliverables: 'agent_payment',  // fixed class - see payAgentPVT JSDoc
      deadline_hours: 24,
      auto_release_hours: 24,
      chain: req.chain ?? 'base',
    });
  }

  // -------------------------------------------------------------------------
  // Verified transfer PE (slice 1b) - the verified counterpart to the signer's
  // best-effort self-asserted reportPE. Lives here (not on ProvianClient)
  // because only CommonsInstitutions carries the wallet_aw_* walletId + api-key auth the
  // POST /v1/agent/wallet/:walletId/transfer/record endpoint requires.
  // -------------------------------------------------------------------------

  /**
   * Record a VERIFIED Provenance Envelope for a raw transfer the agent already
   * broadcast with the slice-1 signer. Pass it as the signer's reportPE:
   *
   *   await transferToken(wallet, { token: 'USDC', to, amount, chain: 'base',
   *     rpcUrl, reportPE: (r) => institutions.recordTransfer(r) });
   *
   * The relay re-verifies the tx on-chain (from+to+amount for ERC-20; sender +
   * inclusion only for native) and records a tx_hash-deduped PE. Best-effort by
   * convention (the signer swallows reportPE errors so a record failure never
   * fails the transfer), but the PE it produces is a verified one.
   */
  async recordTransfer(report: PETransferReport): Promise<{ peId: string; verified: boolean; idempotent: boolean }> {
    const m = report.metadata ?? {};
    const txHash = m.tx_hash;
    const chain = m.chain;
    let currency: string;
    let to: unknown;
    let amountAtomic: unknown;
    if (report.actionType === 'agent_native_transfer') {
      currency = 'native';
      to = m.recipient;
      amountAtomic = m.amount_wei;
    } else if (typeof m.token === 'string') {
      currency = m.token.toLowerCase();
      to = m.recipient;
      amountAtomic = m.amount_atomic;
    } else {
      throw new ProvianValidationError(
        'recordTransfer accepts transferToken / transferNative reports only (no general sendTransaction)',
      );
    }
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ProvianValidationError('report.metadata.tx_hash must be a 0x-prefixed 32-byte hash');
    }
    if (typeof chain !== 'string') {
      throw new ProvianValidationError('report.metadata.chain is required');
    }
    if (!['usdc', 'usdt', 'pvt', 'native'].includes(currency)) {
      throw new ProvianValidationError(`unsupported transfer currency: ${currency}`);
    }
    if (typeof to !== 'string') {
      throw new ProvianValidationError('report.metadata.recipient is required');
    }
    const amountStr = typeof amountAtomic === 'bigint' ? amountAtomic.toString() : String(amountAtomic ?? '');
    if (!/^[0-9]+$/.test(amountStr)) {
      throw new ProvianValidationError('transfer amount (atomic units) is required');
    }
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/transfer/record`,
      { method: 'POST', body: { tx_hash: txHash, chain, currency, to, amount_atomic: amountStr } },
    );
    const r = response as { pe_id?: string; verified?: boolean; idempotent?: boolean };
    // Strict-check the reply like the sibling inviteDevice: a malformed relay
    // response (missing pe_id) must surface as an error, NOT be coerced to the
    // literal string 'undefined' and returned as a success (audit Pass-3 #38).
    if (typeof r.pe_id !== 'string' || r.pe_id.length === 0) {
      throw new ProvianNetworkError('transfer/record response missing pe_id');
    }
    return { peId: r.pe_id, verified: Boolean(r.verified), idempotent: Boolean(r.idempotent) };
  }

  /**
   * Record a transfer that is already broadcast, retrying (bounded) while the relay's verifier
   * catches up: Base floors the verification at 12 confirmations, so a record sent at inclusion
   * answers `insufficient_confirmations` / `tx_not_found` for ~20 s. A refusal that cannot clear
   * (wrong amount, wrong sender) is thrown at once.
   */
  async recordTransferWhenFinal(
    report: PETransferReport,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<{ peId: string; verified: boolean; idempotent: boolean }> {
    return retryWhileVerifierCatchesUp(() => this.recordTransfer(report), opts);
  }

  // -------------------------------------------------------------------------
  // Swap : the relay quote → guard → own-key sign → relay record.
  // -------------------------------------------------------------------------

  /** An unsigned 0x quote from the relay (`POST /:wallet_id/swap`). Nothing is signed. */
  async quoteSwap(req: { fromToken: AgentSwapToken; toToken: AgentSwapToken; amountAtomic: string; slippageBps?: number }): Promise<AgentSwapQuote> {
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/swap`,
      {
        method: 'POST',
        body: {
          fromToken: req.fromToken, toToken: req.toToken, amount: req.amountAtomic,
          ...(req.slippageBps !== undefined ? { slippageBps: req.slippageBps } : {}),
        },
      },
    );
    return response as unknown as AgentSwapQuote;
  }

  /**
   * Swap USDC ⇄ WETH on Base from the agent's OWN wallet: the relay quotes (and verifies
   * Provian's 25 bps fee), the SDK checks the unsigned transaction is exactly the swap asked
   * for (`zerox-swap-guard.ts`), bounds its on-chain minimum against Chainlink's ETH / USD feed
   * on Base (`SWAP_PRICE_OUT_OF_BOUNDS` / `SWAP_ORACLE_UNAVAILABLE` refuse before anything is
   * signed), approves exactly the sell amount when needed, signs and
   * broadcasts with the agent's key, waits for finality, and records `agent_token_swap`
   * through `POST /:wallet_id/swap/record` (the relay re-verifies the sender on-chain).
   */
  async swapTokens(wallet: EvmWallet, params: AgentSwapParams & { recordAttempts?: number; recordRetryDelayMs?: number }): Promise<AgentSwapResult> {
    return executeAgentSwap({
      quote: (body) => this.quoteSwap({ fromToken: body.fromToken, toToken: body.toToken, amountAtomic: body.amount, slippageBps: body.slippageBps }),
      record: (body) => retryWhileVerifierCatchesUp(
        () => requestJSON(
          this.config,
          `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/swap/record`,
          { method: 'POST', body },
        ),
        { attempts: params.recordAttempts, delayMs: params.recordRetryDelayMs },
      ),
    }, wallet, params);
  }

  // -------------------------------------------------------------------------
  // Burn-to-present (agent side)
  // -------------------------------------------------------------------------

  /**
   * Record a VERIFIED PVT burn the agent broadcast from its OWN sovereign wallet
   * (a `Transfer(agent, 0x0, amount)` on the PVT token). POSTs to
   * `/v1/agent/wallet/:wallet_id/burn/record`; the relay re-verifies the burn
   * on-chain (expectedFrom = the agent's own address) and returns a `burnId` the
   * presentation primitive consumes. One burn buys exactly one benefit, globally.
   */
  async recordBurn(params: {
    txHash: string;
    chain: string;
    amountAtomic: string | bigint;
    /**
     * ask the relay to hold the request open until the burn is MINED and accepted (one Base
     * block, ~2 s after broadcast; both of the relay's RPC providers must agree on the receipt and
     * its canonical block) instead of refusing an early record. One call right after broadcast; no
     * local confirmation wait, no re-posting. (The wire flag keeps its `await_finality` name for
     * compatibility.) The burn is recorded `finality: "provisional"`; the relay then runs the
     * 12-block finality check itself and revokes every benefit of a burn that fails it.
     */
    awaitFinality?: boolean;
  }): Promise<{
    burnId: string;
    verified: boolean;
    idempotent: boolean;
    /** `provisional` = accepted at inclusion, finality check pending; `final` = past 12 blocks. */
    finality?: 'provisional' | 'final';
  }> {
    const amountStr = typeof params.amountAtomic === 'bigint' ? params.amountAtomic.toString() : String(params.amountAtomic ?? '');
    if (typeof params.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
      throw new ProvianValidationError('txHash must be a 0x-prefixed 32-byte hash');
    }
    if (!/^[0-9]+$/.test(amountStr) || amountStr === '0') {
      throw new ProvianValidationError('amountAtomic must be a positive integer string (atomic 18-decimal PVT units)');
    }
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/burn/record`,
      {
        method: 'POST',
        body: {
          tx_hash: params.txHash, chain: params.chain, amount_atomic: amountStr,
          ...(params.awaitFinality ? { await_finality: true } : {}),
        },
      },
    );
    const r = response as { burn_id?: string; verified?: boolean; idempotent?: boolean; finality?: unknown };
    if (typeof r.burn_id !== 'string' || r.burn_id.length === 0) {
      throw new ProvianNetworkError('burn/record response missing burn_id');
    }
    return {
      burnId: r.burn_id,
      verified: Boolean(r.verified),
      idempotent: Boolean(r.idempotent),
      ...(r.finality === 'provisional' || r.finality === 'final' ? { finality: r.finality } : {}),
    };
  }

  /**
   * BURN PVT end to end: broadcast `burn(amount)` to the PVT token from the agent's
   * OWN sovereign key (governance-free — agent's money, agent's rules), wait for the
   * receipt, then {@link recordBurn} it so the relay verifies it on-chain and
   * returns a `burnId` the presentation primitive consumes. One call for the whole
   * demand side of burn-to-present. `rpcUrl` is a Base RPC the agent controls; the
   * key never leaves this process. PVT is Base-only, so `chain` defaults to 'base'.
   */
  async burnPvt(params: {
    privateKeyHex: string;
    /** Stable identity for explicit resume of the same signed burn. */
    operationId?: string;
    amountAtomic: string | bigint;
    chain?: SupportedChain;
    rpcUrl: string;
    /**
     * Pre- behaviour, opt-in: wait for this many receipt confirmations on YOUR RPC before
     * recording. Omit it (the default): the relay holds the record until the burn is mined
     * (~one Base block) and checks finality itself afterwards.
     */
    confirmations?: number;
    /** Bounded re-tries of the relay record on a transient refusal / dropped connection (default 6). */
    recordAttempts?: number;
    /** Delay between record attempts in ms (default 2 s). */
    recordRetryDelayMs?: number;
  }): Promise<{ txHash: string; burnId: string; verified: boolean }> {
    const sent = await this.sendBurn(params);
    const chain = sent.chain;
    if (params.confirmations !== undefined) {
      const status = await waitForReceipt({
        chain,
        hash: sent.txHash as `0x${string}`,
        rpcUrl: params.rpcUrl,
        confirmations: params.confirmations,
      });
      if (status !== 'success') {
        throw new ProvianNetworkError(`burn tx ${sent.txHash} reverted on-chain`);
      }
    }
    // The burn is irreversible from here. ONE record call right after broadcast — the relay
    // holds it until the burn is mined (one Base block; its two providers agree on the receipt and
    // canonical block) and answers with a provisional record; the relay checks 12-block finality
    // afterwards and revokes the burn's benefits if it fails. A refusal that can still clear (a dropped connection, the relay's wait
    // bound, a record already in flight) is retried a bounded number of times; a burn that
    // reverted is reported as such; anything left pending throws a typed error carrying the tx
    // hash so the caller can re-record it later with recordBurn() (a re-record is idempotent).
    const attempts = Math.max(1, params.recordAttempts ?? BURN_RECORD_ATTEMPTS);
    const delayMs = Math.max(0, params.recordRetryDelayMs ?? BURN_RECORD_RETRY_DELAY_MS);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const rec = await this.recordBurn({ txHash: sent.txHash, chain, amountAtomic: sent.amountAtomic, awaitFinality: true });
        return { txHash: sent.txHash, burnId: rec.burnId, verified: rec.verified };
      } catch (err) {
        if (isRevertedBurn(err)) throw new ProvianNetworkError(`burn tx ${sent.txHash} reverted on-chain`);
        if (!isTransientBurnVerification(err)) throw err;
        lastError = err;
        if (attempt < attempts && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new ProvianError(
      `burn tx ${sent.txHash} is on-chain but the relay has not verified it after ${attempts} record attempts`
      + ` (${(lastError as Error)?.message ?? 'unknown'}); re-record it with recordBurn({ txHash: '${sent.txHash}', chain: '${chain}', amountAtomic: '${sent.amountAtomic}', awaitFinality: true })`,
      'BURN_RECORD_PENDING',
    );
  }

  /**
   * BROADCAST a PVT burn from the agent's own key and return at once — the tx hash, the
   * atomic amount, and the burn id (`sha256(chain:txHash)`) every product keys on. Nothing is
   * recorded and nothing waits for confirmations: hand the result to {@link present} (`burnTx`) or
   * {@link recordBurn} (`awaitFinality`), and the relay holds that call until the burn is mined
   * (~one Base block) — finality is checked by the relay afterwards. This is
   * the pipelined start every burn flow in this SDK uses.
   */
  async sendBurn(params: {
    privateKeyHex: string;
    /** Stable identity for explicit resume of the same signed burn. */
    operationId?: string;
    amountAtomic: string | bigint;
    chain?: SupportedChain;
    rpcUrl: string;
  }): Promise<{ txHash: string; burnId: string; amountAtomic: string; chain: SupportedChain }> {
    const chain = params.chain ?? 'base';
    const amount = typeof params.amountAtomic === 'bigint' ? params.amountAtomic : BigInt(String(params.amountAtomic || '0'));
    if (amount <= 0n) {
      throw new ProvianValidationError('amountAtomic must be a positive integer string (atomic 18-decimal PVT units)');
    }
    if (!params.rpcUrl) throw new ProvianValidationError('rpcUrl is required to broadcast the burn');
    const token = getToken(chain, 'PVT');
    const wallet: EvmWallet = {
      privateKeyHex: params.privateKeyHex,
      address: deriveAddressFromPrivateKey(params.privateKeyHex),
    };
    // burn() is a call to the PVT token (an allowlisted target), so the ungoverned
    // signer's allowlist guard passes without an override.
    const sent = await sendTransaction(wallet, {
      to: token.address,
      data: encodeErc20Burn(amount),
      chain,
      rpcUrl: params.rpcUrl,
      operationId: params.operationId,
    });
    return { txHash: sent.hash, burnId: burnIdForTx(chain, sent.hash), amountAtomic: amount.toString(), chain };
  }

  /**
   * Produce a burn-backed PRESENTATION (burn-to-present, agent side). Signs the
   * requester-bound binding with the agent's OWN sovereign key (proof of live key
   * possession at presentation time) and POSTs to
   * `/v1/agent/wallet/:wallet_id/present`. `params.privateKeyHex` is the same
   * sovereign key the wallet was created with; it is used ONLY to sign the binding
   * here and is never transmitted. `burnId` comes from a prior `recordBurn`.
   */
  async present(
    params: BuildPresentationParams & {
      /** the verdict already computed for `challengeEnvelope` (skips a second verification). */
      requesterVerdict?: ChallengeVerdict;
      fetchRequesterKeys?: FetchRequesterKeys;
    },
  ): Promise<{ tier: PresentationTier; presentation: unknown; token: string }> {
    if (!params.privateKeyHex) throw new ProvianValidationError('privateKeyHex is required to sign the presentation');
    if ((!params.burnId && !params.burnTx) || !params.audience || !params.challenge) {
      throw new ProvianValidationError('burnId (or burnTx), audience, and challenge are required');
    }
    try {
      resolveBurnId(params);
    } catch (err) {
      throw new ProvianValidationError((err as Error).message);
    }
    // presenting CONSUMES the burn, so a SIGNED challenge is verified first (unless the
    // caller hands in the verdict it already computed for this exact envelope). Refused → throw.
    const env = params.challengeEnvelope;
    if (env && isSignedChallenge(env)) {
      const prior = params.requesterVerdict;
      const priorMatches = prior !== undefined && !isRefusedVerdict(prior) && prior.envelope.sig === env.sig
        && prior.envelope.challenge === env.challenge;
      if (!priorMatches) {
        await this.checkChallengeBeforeBurn(env, { privateKeyHex: params.privateKeyHex, fetchRequesterKeys: params.fetchRequesterKeys, nowSeconds: params.nowSeconds });
      }
    }
    const { requesterVerdict: _v, fetchRequesterKeys: _f, ...buildParams } = params;
    void _v; void _f;
    const { body } = buildAgentPresentationRequest(buildParams);
    // with `burnTx` the relay holds this call until the burn is mined. A connection that
    // drops during that wait is re-sent as-is (same burn, same binding): the record is idempotent
    // and the burn is consumed at most once, so a retry can only complete the same presentation.
    const attempts = params.burnTx ? BURN_RECORD_ATTEMPTS : 1;
    let response: Record<string, unknown> | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await requestJSON(
          this.config,
          `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/present`,
          { method: 'POST', body },
        );
        break;
      } catch (err) {
        // The same refusals burnPvt re-records through: a dropped connection, a relay 5xx, a record
        // already in flight, or the relay's wait running out before the burn was mined.
        if (!isTransientBurnVerification(err) || attempt >= attempts) throw err;
        await new Promise((r) => setTimeout(r, BURN_RECORD_RETRY_DELAY_MS));
      }
    }
    const r = response as { tier?: PresentationTier; presentation?: unknown; token?: string };
    if (typeof r.token !== 'string' || r.token.length === 0) {
      throw new ProvianNetworkError('present response missing token');
    }
    return { tier: r.tier ?? params.tier, presentation: r.presentation, token: r.token };
  }

  /**
   * present a burn that is on-chain but may not be recorded yet. Any failure is re-thrown as
   * a {@link BurnNotPresentedError} carrying the tx, so the caller resumes with it instead of
   * burning again. `burn` null = the burn was recorded before (no pipelined handle to protect).
   */
  private async presentHoldingBurn(
    burn: { txHash: string; burnId: string; amountAtomic: string; chain: SupportedChain } | null,
    params: Parameters<CommonsInstitutions['present']>[0],
  ): Promise<Awaited<ReturnType<CommonsInstitutions['present']>>> {
    try {
      return await this.present(params);
    } catch (err) {
      if (burn) throw new BurnNotPresentedError(burn, err);
      throw err;
    }
  }

  /**
   * the A.3 presenter-side verdict for a challenge, computed BEFORE any burn. Unsigned →
   * `unverified` (allowed); signed → verified against the requester key (domain: the SSRF-guarded
   * well-known fetch; wallet: this relay's `/v1/present/jwks`). `invalid` / `expired` /
   * `not_addressed` throw {@link ChallengeRefusedError}; so does an `onRequester` hook returning
   * false. Returns the verdict to surface to the caller.
   */
  async checkChallengeBeforeBurn(
    env: ChallengeEnvelope,
    opts: ChallengeCheckOptions & { privateKeyHex: string },
  ): Promise<ChallengeVerdict> {
    const verdict = await verifyChallengeEnvelope(env, {
      fetchRequesterKeys: opts.fetchRequesterKeys,
      relayUrl: this.config.relayUrl,
      fetchFn: this.config.fetch,
      nowSeconds: opts.nowSeconds,
      presenterAddress: deriveAddressFromPrivateKey(opts.privateKeyHex),
    });
    if (isRefusedVerdict(verdict)) throw new ChallengeRefusedError(verdict);
    if (opts.onRequester && !(await opts.onRequester(verdict))) throw new ChallengeRefusedError(verdict, true);
    return verdict;
  }

  /**
   * Read the effective PER-TIER minimum burn a presenter must burn (public relay
   * read, `GET /v1/present/floor`). Returns the atomic (18-decimal) floor so
   * {@link respondToChallenge} burns EXACTLY the fee and never wastes real PVT on
   * an under-burn the relay would reject after the on-chain burn is irreversible.
   * Falls back to the launch literals (reputation 15 PVT / pe_fact 5 PVT) if the
   * relay read fails — learning the fee must never block presenting.
   */
  async presentationFloorAtomic(tier: PresentationTier): Promise<bigint> {
    const fallback = tier === 'reputation' ? 15n * 10n ** 18n : 5n * 10n ** 18n;
    try {
      const res = await requestJSON(this.config, `/v1/present/floor?tier=${encodeURIComponent(tier)}`, { method: 'GET' });
      const raw = (res as { floors?: Record<string, { floor_atomic?: string }> }).floors?.[tier]?.floor_atomic;
      if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw);
    } catch {
      // fall through to the literal
    }
    return fallback;
  }

  /**
   * Respond to a requester's CHALLENGE in ONE call: parse → burn the exact tier
   * floor on-chain → produce the co-signed, requester-bound presentation → return
   * the token. This is the direction-agnostic PRESENTER primitive — the same call
   * closes agent→human, human→agent, and agent→agent, because a challenge is just
   * `{audience, challenge, predicates?}` and the presenter is whoever proves.
   *
   * The requester's named predicates ride straight through as the reputation-tier
   * disclosure directive (every one must be answered; `verify_presentation` refuses
   * a presentation that leaves one unanswered). Tier is inferred: `reputation` when
   * the challenge names predicates, else `pe_fact` (the cheaper handshake floor),
   * unless `opts.tier` overrides.
   *
   * MONEY: this burns REAL PVT (the agent's own, governance-free) — exactly the
   * resolved floor unless `opts.burnAmountAtomic` overrides. It is EXPLICIT by
   * design: call it only for a challenge you have decided to answer. Never wire it
   * to auto-fire on every inbound challenge — a hostile requester could otherwise
   * spam challenges to drain the agent's PVT.
   */
  private async preflightProofs(facts: readonly PeFact[] = [], disclosures: readonly DisclosureAnswerInput[] = [], rpcUrl = 'https://mainnet.base.org'): Promise<void> {
    const records: PresentationProofInput[] = [...facts, ...disclosures.flatMap(d => d.election === 'disclosed' ? [...(d.records ?? [])] : [])];
    const fetchRpc = guardedFetcher(this.config.fetch);
    await preflightPresentationProofs(records, async (to, data) => {
      const response = await fetchRpc(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(15000) });
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (!response.ok || body.error || typeof body.result !== 'string') throw new Error('anchor_read_failed');
      return body.result;
    });
  }

  /** Check exactly what issuance will verify, before any irreversible burn. */
  async preflightPresentation(params: Omit<BuildPresentationParams,'burnId'|'burnTx'>): Promise<void> {
    const {body}=buildAgentPresentationRequest({...params,burnId:'0'.repeat(64)});
    const result=await requestJSON(this.config,`/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/present/preflight`,{method:'POST',body});
    if(result.ok!==true) throw new ProvianValidationError('presentation_proof_invalid:preflight_not_accepted');
  }

  async respondToChallenge(
    challenge: string | ChallengeEnvelope,
    opts: ChallengeCheckOptions & {
      privateKeyHex: string;
      rpcUrl: string;
      chain?: SupportedChain;
      tier?: PresentationTier;
      /** Override the burned amount (atomic 18-decimal). Default: the resolved tier floor. */
      burnAmountAtomic?: string | bigint;
      /** pe_fact tier only: the PEs to vouch for (each with its anchored envelope_hash). */
      peFacts?: readonly PeFact[];
      confirmations?: number;
      ttlSeconds?: number;
      /**
       * resume: a burn already broadcast for this (from a {@link BurnNotPresentedError}) —
       * present it instead of burning again. Its amount must meet the tier floor.
       */
      burnTx?: { txHash: string; amountAtomic: string | bigint; chain?: SupportedChain };
      /** 2026-10-10: which of the challenge's disclosure requests to answer. Default: every one declined. */
      disclose?: DisclosurePolicy;
      /** The PE store the elected records come from (required to disclose anything). */
      disclosureStore?: PeStore;
      /** The PE Archive source for a record dropped here after its day was confirmed. */
      disclosureArchive?: ArchivedPeSource;
      /** Explicit answers (overrides `disclose`): the caller found the records itself. */
      disclosures?: readonly DisclosureAnswerInput[];
    },
  ): Promise<{
    token: string;
    tier: PresentationTier;
    burnId: string;
    txHash: string;
    burnAmountAtomic: string;
    presentation: unknown;
    /** whom this presentation went to — `verified` (signed) or `unverified` (legacy). */
    requesterVerdict: ChallengeVerdict;
  }> {
    const parsed = parseChallengeEnvelope(challenge);
    if (!parsed) {
      throw new ProvianValidationError('challenge must carry a non-empty {audience, challenge}');
    }
    if (!opts.privateKeyHex) throw new ProvianValidationError('privateKeyHex is required to burn and sign the presentation');
    if (!opts.rpcUrl) throw new ProvianValidationError('rpcUrl is required to broadcast the burn');

    const predicates: PredicateRequest[] = [...(parsed.predicates ?? [])];
    const asked: CanonicalDisclosureRequest[] = [...(parsed.disclosures ?? [])];
    const tier: PresentationTier = opts.tier ?? (predicates.length > 0 || asked.length > 0 ? 'reputation' : 'pe_fact');
    if (tier === 'pe_fact' && predicates.length > 0) {
      throw new ProvianValidationError('a challenge that names predicates requires the reputation tier (predicates are reputation-only)');
    }
    if (tier === 'pe_fact' && asked.length > 0) {
      throw new ProvianValidationError('a challenge that names disclosure requests requires the reputation tier');
    }
    // 2026-10-10: the disclosure answers are built BEFORE the burn (a missing store or an unreachable
    // record never strands a burn). Every named request is answered: elected ones from the store,
    // the rest signed as declined.
    const peFacts = opts.peFacts ? structuredClone(opts.peFacts) : undefined;
    const disclosures = asked.length > 0 ? structuredClone(await this.electDisclosures(asked, opts)) : undefined;
    await this.preflightProofs(tier === 'pe_fact' ? peFacts : [], disclosures, opts.rpcUrl);

    // verify the challenge BEFORE the burn. A signed challenge that is invalid / expired /
    // addressed to someone else throws here — nothing is burned. the floor read runs
    // alongside it (both are reads; neither burns).
    const [requesterVerdict, amount] = await Promise.all([
      this.checkChallengeBeforeBurn(parsed, {
        privateKeyHex: opts.privateKeyHex,
        onRequester: opts.onRequester,
        fetchRequesterKeys: opts.fetchRequesterKeys,
        nowSeconds: opts.nowSeconds,
      }),
      opts.burnTx
        ? Promise.resolve(BigInt(String(opts.burnTx.amountAtomic)))
        : opts.burnAmountAtomic != null
          ? Promise.resolve(BigInt(String(opts.burnAmountAtomic)))
          : this.presentationFloorAtomic(tier),
    ]);
    if (amount <= 0n) throw new ProvianValidationError('resolved burn amount must be positive');
    await this.preflightPresentation({privateKeyHex:opts.privateKeyHex,tier,audience:parsed.audience,challenge:parsed.challenge,
      ttlSeconds:opts.ttlSeconds, peFacts:tier==='pe_fact'?peFacts:undefined,
      disclosure:tier==='reputation'?{redact:[],predicates}:undefined,disclosures,
      ...(isSignedChallenge(parsed)?{challengeEnvelope:parsed}:{}),});


    // pipelining: broadcast, then ONE present call carrying the burn's tx — the relay records
    // the burn once it is mined (one Base block) while it prepares the presentation, and issues then.
    // (A caller that still passes `confirmations` gets the pre- record-then-present path.)
    let burn: { txHash: string; burnId: string; amountAtomic: string; chain: SupportedChain };
    let burnTx: BuildPresentationParams['burnTx'];
    if (opts.burnTx) {
      const chain = opts.burnTx.chain ?? opts.chain ?? 'base';
      burn = { txHash: opts.burnTx.txHash, burnId: burnIdForTx(chain, opts.burnTx.txHash), amountAtomic: amount.toString(), chain };
      burnTx = { txHash: burn.txHash, amountAtomic: burn.amountAtomic, chain };
    } else if (opts.confirmations !== undefined) {
      const recorded = await this.burnPvt({
        privateKeyHex: opts.privateKeyHex, amountAtomic: amount, chain: opts.chain, rpcUrl: opts.rpcUrl, confirmations: opts.confirmations,
      });
      burn = { txHash: recorded.txHash, burnId: recorded.burnId, amountAtomic: amount.toString(), chain: opts.chain ?? 'base' };
    } else {
      burn = await this.sendBurn({ privateKeyHex: opts.privateKeyHex, amountAtomic: amount, chain: opts.chain, rpcUrl: opts.rpcUrl });
      burnTx = { txHash: burn.txHash, amountAtomic: burn.amountAtomic, chain: burn.chain };
    }

    const disclosure: DisclosureDirective | undefined =
      tier === 'reputation' ? { redact: [], predicates } : undefined;
    const pres = await this.presentHoldingBurn(burnTx ? burn : null, {
      ...(disclosures !== undefined ? { disclosures } : {}),
      privateKeyHex: opts.privateKeyHex,
      tier,
      burnId: burn.burnId,
      ...(burnTx ? { burnTx } : {}),
      audience: parsed.audience,
      challenge: parsed.challenge,
      ttlSeconds: opts.ttlSeconds,
      peFacts: tier === 'pe_fact' ? peFacts : undefined,
      disclosure,
      // The signed envelope rides to /present so the relay issues a v2 presentation.
      ...(isSignedChallenge(parsed) ? { challengeEnvelope: parsed, requesterVerdict } : {}),
    });

    return {
      token: pres.token,
      tier,
      burnId: burn.burnId,
      txHash: burn.txHash,
      burnAmountAtomic: amount.toString(),
      presentation: pres.presentation,
      requesterVerdict,
    };
  }

  /** 2026-10-10: answer every disclosure request a challenge names — elected ones from the store, the rest declined. */
  private async electDisclosures(
    asked: readonly CanonicalDisclosureRequest[],
    opts: { disclose?: DisclosurePolicy; disclosureStore?: PeStore; disclosureArchive?: ArchivedPeSource; disclosures?: readonly DisclosureAnswerInput[] },
  ): Promise<DisclosureAnswerInput[]> {
    if (opts.disclosures !== undefined) {
      const given = opts.disclosures;
      return asked.map((req) => given.find((g) => JSON.stringify(g.request) === JSON.stringify(req)) ?? { request: req, election: 'declined' as const });
    }
    const policy = opts.disclose ?? 'declined';
    const out: DisclosureAnswerInput[] = [];
    for (const req of asked) {
      const elect = policy === 'all' ? true : policy === 'declined' ? false : await policy(req);
      if (!elect) { out.push({ request: req, election: 'declined' }); continue; }
      if (!opts.disclosureStore) throw new ProvianValidationError('disclosing needs the PE store (disclosureStore) the records come from; nothing was burned');
      const found = await findDisclosureRecords(opts.disclosureStore, req, opts.disclosureArchive);
      out.push({ request: req, election: 'disclosed', records: found.records });
    }
    return out;
  }

  /**
   * Read this agent's OWN live reputation vocabulary (§2.8) — the same flat numeric
   * facts a reputation presentation could disclose (continuity/work/coupling/
   * consumption/money/standing/accountability/composition/presentations). Standing
   * is always present. `GET /v1/agent/wallet/:id/vocabulary`.
   */
  async readVocabulary(): Promise<{ facts: Record<string, number>; standing_prefix: string }> {
    const res = await requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/vocabulary`, { method: 'GET' });
    const r = res as { facts?: Record<string, number>; standing_prefix?: string };
    return { facts: r.facts ?? {}, standing_prefix: r.standing_prefix ?? 'standing.' };
  }

  /**
   * Ask this agent's LINKED HUMAN to approve a described action (§2.1). The
   * description goes only to that human's app (Tier-3); the returned
   * `action_description_sha256` is the anchor the human's approval PE binds to. Poll
   * {@link listApprovalRequests} until the request is `satisfied`, then cite the
   * approval PE with {@link humanApprovalOrigin} in your next PE's `input_origins`.
   */
  async requestHumanApproval(params: { actionDescription: string; subjectPeId?: string }): Promise<{
    request_id: string; action_description_sha256: string; status: string; expires_at_ms: number;
  }> {
    if (!params.actionDescription || !params.actionDescription.trim()) {
      throw new ProvianValidationError('actionDescription is required');
    }
    const res = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/request-approval`,
      { method: 'POST', body: { action_description: params.actionDescription, ...(params.subjectPeId ? { subject_pe_id: params.subjectPeId } : {}) } },
    );
    const r = (res as { request?: Record<string, unknown> }).request ?? {};
    return {
      request_id: String(r.request_id ?? ''),
      action_description_sha256: String(r.action_description_sha256 ?? ''),
      status: String(r.status ?? 'pending'),
      expires_at_ms: Number(r.expires_at_ms ?? 0),
    };
  }

  /**
   * this agent's beneficiary-relationship epoch — the `link_epoch` a human's link / unlink /
   * share-change signature must name (`signLinkPayload`). Every link, unlink and share change
   * advances it, so read it immediately before the human signs; a signature over an older epoch is
   * refused 409 `link_epoch_stale`, and a payload the relay already consumed 409
   * `link_signature_already_used`.
   */
  async readLinkEpoch(): Promise<{
    link_epoch: number; state: 'linked' | 'unlinked'; linked_human_wallet_id: string | null; operational_reserve_bps: number | null;
  }> {
    const res = await requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/link-epoch`, { method: 'GET' }) as Record<string, unknown>;
    const epoch = res.link_epoch;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw new ProvianValidationError('relay returned no link_epoch');
    }
    return {
      link_epoch: epoch,
      state: res.state === 'linked' ? 'linked' : 'unlinked',
      linked_human_wallet_id: typeof res.linked_human_wallet_id === 'string' ? res.linked_human_wallet_id : null,
      operational_reserve_bps: typeof res.operational_reserve_bps === 'number' ? res.operational_reserve_bps : null,
    };
  }

  /** Poll this agent's own approval requests (§2.1). Never returns the description text. */
  async listApprovalRequests(status?: 'pending' | 'satisfied' | 'expired'): Promise<Array<{
    request_id: string; action_description_sha256: string; subject_pe_id: string | null;
    status: string; satisfied_by_pe_id: string | null; decision: 'approved' | 'rejected' | null;
    /** When a still-pending request lapses (unix ms; 0 when the relay did not say — read as lapsed). */
    expires_at_ms: number;
  }>> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/approval-requests${qs}`, { method: 'GET' });
    const rows = (res as { requests?: unknown[] }).requests ?? [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        request_id: String(r.request_id ?? ''),
        action_description_sha256: String(r.action_description_sha256 ?? ''),
        subject_pe_id: (r.subject_pe_id as string | null) ?? null,
        status: String(r.status ?? ''),
        satisfied_by_pe_id: (r.satisfied_by_pe_id as string | null) ?? null,
        decision: (r.decision as 'approved' | 'rejected' | null) ?? null,
        expires_at_ms: typeof r.expires_at_ms === 'number' ? r.expires_at_ms : 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Remote presentation channel — the agent PRESENTS to its linked human
  // when NOT co-present (QR stays the in-person path). Flow: requestPresentation →
  // human composes a challenge (in their app) → the agent sees the challenge in
  // listPresentationRequests → burns + presents via respondToChallenge/present →
  // submitPresentationForRequest posts the token back → the human records a verdict.
  // -------------------------------------------------------------------------

  /**
   * Ask this agent's LINKED HUMAN to receive a burn-backed presentation REMOTELY
   *. Creates a pending `presentation_request` (status `requested`) and
   * pushes to the human, who composes the challenge (audience/challenge/predicates)
   * in their app. The optional `note` is Tier-3 (shown only to that human, never in
   * a PE). Poll {@link listPresentationRequests} until it is `challenged`, then
   * present with {@link respondToPresentationRequest} (or manually) and post the
   * token back with {@link submitPresentationForRequest}. `POST
   * /v1/agent/wallet/:id/presentation-request`.
   */
  async requestPresentation(params: { tier?: PresentationTier; note?: string; walletId?: string } = {}): Promise<{
    request_id: string; status: string; tier: PresentationTier; expires_at_ms: number;
  }> {
    const walletId = params.walletId ?? this.config.walletId;
    const res = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(walletId)}/presentation-request`,
      { method: 'POST', body: {
        ...(params.tier ? { tier: params.tier } : {}),
        ...(params.note ? { note: params.note } : {}),
      } },
    );
    const r = (res as { request?: Record<string, unknown> }).request ?? {};
    return {
      request_id: String(r.request_id ?? ''),
      status: String(r.status ?? 'requested'),
      tier: (r.tier as PresentationTier) ?? (params.tier ?? 'reputation'),
      expires_at_ms: Number(r.expires_at_ms ?? 0),
    };
  }

  /** Poll this agent's own presentation requests. Never returns the human's note. */
  async listPresentationRequests(status?: 'requested' | 'challenged' | 'presented' | 'verified' | 'declined' | 'expired'): Promise<Array<{
    request_id: string; tier: PresentationTier; status: string;
    audience: string | null; challenge: string | null; predicates: unknown[] | null;
    burn_id: string | null; presentation_token: string | null;
    verdict: 'valid' | 'invalid' | null; predicate_results: unknown[] | null;
    /** the relay-signed challenge envelope for a `challenged` request, when the relay composed one. */
    challenge_envelope: ChallengeEnvelope | null;
  }>> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/presentation-requests${qs}`, { method: 'GET' });
    const rows = (res as { requests?: unknown[] }).requests ?? [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        request_id: String(r.request_id ?? ''),
        tier: (r.tier as PresentationTier) ?? 'reputation',
        status: String(r.status ?? ''),
        audience: (r.audience as string | null) ?? null,
        challenge: (r.challenge as string | null) ?? null,
        predicates: (r.predicates as unknown[] | null) ?? null,
        burn_id: (r.burn_id as string | null) ?? null,
        presentation_token: (r.presentation_token as string | null) ?? null,
        verdict: (r.verdict as 'valid' | 'invalid' | null) ?? null,
        predicate_results: (r.predicate_results as unknown[] | null) ?? null,
        challenge_envelope: r.challenge_envelope !== undefined && r.challenge_envelope !== null
          ? parseChallengeEnvelope(r.challenge_envelope) : null,
      };
    });
  }

  /**
   * Post a presentation token (produced earlier via the EXISTING `/present` route)
   * back to a `challenged` presentation request. `POST
   * /v1/agent/wallet/:id/presentation-requests/:request_id/present`.
   */
  async submitPresentationForRequest(params: { requestId: string; burnId: string; presentationToken: string; walletId?: string }): Promise<{
    request_id: string; status: string;
  }> {
    if (!params.requestId) throw new ProvianValidationError('requestId is required');
    if (!params.burnId) throw new ProvianValidationError('burnId is required');
    if (!params.presentationToken) throw new ProvianValidationError('presentationToken is required');
    const walletId = params.walletId ?? this.config.walletId;
    const res = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(walletId)}/presentation-requests/${encodeURIComponent(params.requestId)}/present`,
      { method: 'POST', body: { burn_id: params.burnId, presentation_token: params.presentationToken } },
    );
    const r = (res as { request?: Record<string, unknown> }).request ?? {};
    return { request_id: String(r.request_id ?? params.requestId), status: String(r.status ?? 'presented') };
  }

  /**
   * Convenience : given a `challenged` presentation request (it carries the
   * human's composed audience/challenge/predicates), burn the exact tier floor +
   * produce the co-signed presentation via {@link respondToChallenge}, then post the
   * token back with {@link submitPresentationForRequest}.
   *
   * MONEY: this burns REAL PVT (the agent's own, governance-free). It is MANUAL by
   * design — call it only for a request you have decided to answer. NEVER wire it to
   * auto-fire on every inbound request; a hostile flow could otherwise drain PVT.
   */
  async respondToPresentationRequest(
    request: {
      request_id: string; status: string; tier?: PresentationTier; audience: string | null; challenge: string | null; predicates: unknown[] | null;
      /** the relay-signed envelope for this request, when present (verified before the burn). */
      challenge_envelope?: unknown;
    },
    opts: ChallengeCheckOptions & {
      privateKeyHex: string;
      rpcUrl: string;
      chain?: SupportedChain;
      burnAmountAtomic?: string | bigint;
      confirmations?: number;
      ttlSeconds?: number;
      walletId?: string;
    },
  ): Promise<{ request_id: string; status: string; token: string; tier: PresentationTier; burnId: string; txHash: string; burnAmountAtomic: string; requesterVerdict: ChallengeVerdict }> {
    if (request.status !== 'challenged') {
      throw new ProvianValidationError(`respondToPresentationRequest requires a 'challenged' request (got '${request.status}')`);
    }
    if (!request.audience || !request.challenge) {
      throw new ProvianValidationError('a challenged request must carry a composed audience + challenge');
    }
    const predicates = Array.isArray(request.predicates) ? (request.predicates as PredicateRequest[]) : [];
    // a relay-composed request carries its signed envelope; it must describe THIS request.
    let challengeInput: ChallengeEnvelope = { audience: request.audience, challenge: request.challenge, predicates };
    if (request.challenge_envelope !== undefined && request.challenge_envelope !== null) {
      const env = parseChallengeEnvelope(request.challenge_envelope);
      if (!env || env.audience !== request.audience || env.challenge !== request.challenge) {
        throw new ChallengeRefusedError({ status: 'invalid', reason: 'malformed', ...(env ? { envelope: env } : {}) });
      }
      challengeInput = env;
    }
    const responded = await this.respondToChallenge(
      challengeInput,
      {
        onRequester: opts.onRequester,
        fetchRequesterKeys: opts.fetchRequesterKeys,
        nowSeconds: opts.nowSeconds,
        privateKeyHex: opts.privateKeyHex,
        rpcUrl: opts.rpcUrl,
        chain: opts.chain,
        tier: request.tier,
        burnAmountAtomic: opts.burnAmountAtomic,
        confirmations: opts.confirmations,
        ttlSeconds: opts.ttlSeconds,
      },
    );
    const submitted = await this.submitPresentationForRequest({
      requestId: request.request_id,
      burnId: responded.burnId,
      presentationToken: responded.token,
      walletId: opts.walletId,
    });
    return {
      request_id: submitted.request_id,
      status: submitted.status,
      token: responded.token,
      tier: responded.tier,
      burnId: responded.burnId,
      txHash: responded.txHash,
      burnAmountAtomic: responded.burnAmountAtomic,
      requesterVerdict: responded.requesterVerdict,
    };
  }

  // -------------------------------------------------------------------------
  // Burn-to-present (agent side) — REQUESTER + handshake state (the counterparty
  // primitive). An agent that asks another party to prove something is a
  // requester: it issues a challenge, then verifies the presentation with no
  // Provian account (a fetched JWKS verifies the Provian signatures offline).
  // -------------------------------------------------------------------------

  /**
   * Issue a fresh presentation CHALLENGE to hand to a counterparty, then pass the returned object
   * as `challenge` to {@link verifyPresentation}.
   *
   * by default it is WALLET-SIGNED by the relay (`POST /v1/agent/wallet/:id/present/challenge`,
   * agent API auth) — audience = this wallet id, requester = this wallet (Provian attests the
   * id↔address binding), so the presenter can verify whom it presents to before it burns.
   * `requester` signs it locally as a DOMAIN requester instead; `sign: false` issues an unsigned
   * local challenge (shown to presenters as unverified). `predicates` / `presenter` / `ttlSeconds`
   * (60..604800, default 900) ride on every form.
   */
  async issuePresentationChallenge(params: {
    predicates?: readonly PredicateRequest[];
    /** 2026-10-10: requester-named disclosure requests. */
    disclosures?: readonly unknown[];
    ttlSeconds?: number;
    /** The expected presenter's EVM address. */
    presenter?: string;
    /** false → an unsigned local challenge. Default true (wallet-signed by the relay). */
    sign?: boolean;
    /** Sign locally as this domain requester instead of the wallet. */
    requester?: DomainRequesterSigningKey;
    /** Unsigned only: the audience (default: this wallet id). */
    audience?: string;
  } = {}): Promise<PresentationChallenge> {
    if (params.requester) {
      if (params.sign === false) throw new ProvianValidationError('sign: false cannot be combined with a requester key');
      return issuePresentationChallenge({
        requester: params.requester,
        audience: params.audience,
        predicates: params.predicates,
        disclosures: params.disclosures,
        presenter: params.presenter,
        ttlSeconds: params.ttlSeconds,
      });
    }
    if (params.sign === false) {
      return issuePresentationChallenge({
        audience: params.audience ?? this.config.walletId,
        predicates: params.predicates,
        disclosures: params.disclosures,
        presenter: params.presenter,
        ttlSeconds: params.ttlSeconds,
      });
    }
    if (params.audience !== undefined && params.audience !== this.config.walletId) {
      throw new ProvianValidationError('a wallet-signed challenge\'s audience is this wallet id (pass sign: false for another audience)');
    }
    const body: Record<string, unknown> = {};
    if (params.predicates && params.predicates.length > 0) body.predicates = params.predicates;
    if (params.disclosures && params.disclosures.length > 0) body.disclosures = params.disclosures;
    if (params.ttlSeconds !== undefined) body.ttl_seconds = params.ttlSeconds;
    if (params.presenter !== undefined) body.presenter = params.presenter.toLowerCase();
    const res = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/present/challenge`,
      { method: 'POST', body },
    );
    const env = parseChallengeEnvelope((res as { challenge?: unknown }).challenge);
    const structural = env ? checkSignedStructure(env) : 'malformed';
    if (!env || structural) {
      throw new ProvianNetworkError(`present/challenge response is not a valid signed challenge (${structural ?? 'malformed'})`);
    }
    if (env.requester?.type !== 'wallet' || env.requester.id !== this.config.walletId) {
      throw new ProvianNetworkError('present/challenge response names a different requester');
    }
    return env as PresentationChallenge;
  }

  /**
   * VERIFY a presentation a counterparty produced, against the exact challenge +
   * audience this agent issued. No Provian account is needed (a fetched JWKS
   * verifies the Provian signatures offline). Reputation: the Provian JWS via the
   * JWKS. PE-fact: the presenter signature + on-chain anchor proofs (pass `rpcUrl`
   * for the Base check) + the REQUIRED Provian co-sign JWS (via the JWKS) — Provian
   * attests the burn + PE ownership the chain cannot. `expectedAudience` defaults
   * to this agent's wallet id.
   */
  async verifyPresentation(
    token: string | Presentation,
    opts: {
      /** the challenge you issued ({@link issuePresentationChallenge}); fills every expectation. */
      challenge?: ChallengeEnvelope | string;
      expectedChallenge?: string;
      expectedAudience?: string;
      /** the presenter you addressed (address or presenter wallet id). */
      expectedPresenter?: string;
      /** pe_fact on-chain check — default TRUE via https://mainnet.base.org. */
      rpcUrl?: string;
      requireOnchain?: boolean;
      peAnchorAddress?: string;
      jwks?: readonly PresentationJwk[];
      nowSeconds?: number;
      /** §2.6: the predicates you named in the challenge (every one must be answered). */
      expectedPredicates?: readonly PredicateRequest[];
      challengeDeadline?: number;
      expectedRequester?: PresentationRequester;
      /** accept each presentation once (default true), remembered in `seenStore`. */
      acceptOnce?: boolean;
      seenStore?: PresentationSeenStore;
    },
  ): Promise<VerifyPresentationResult> {
    return verifyPresentationToken(token, {
      challenge: opts.challenge,
      // The wallet-id audience default applies only when no issued challenge supplies it.
      expectedAudience: opts.expectedAudience ?? (opts.challenge === undefined ? this.config.walletId : undefined),
      expectedChallenge: opts.expectedChallenge,
      expectedPredicates: opts.expectedPredicates,
      expectedPresenter: opts.expectedPresenter,
      challengeDeadline: opts.challengeDeadline,
      expectedRequester: opts.expectedRequester,
      jwks: opts.jwks,
      jwksUrl: `${this.config.relayUrl}/v1/present/jwks`,
      fetchFn: this.config.fetch,
      rpcUrl: opts.rpcUrl,
      requireOnchain: opts.requireOnchain,
      peAnchorAddress: opts.peAnchorAddress,
      nowSeconds: opts.nowSeconds,
      acceptOnce: opts.acceptOnce,
      seenStore: opts.seenStore,
    });
  }

  // -------------------------------------------------------------------------
  // Rail handshake — HANDSHAKE STATE READ + rail-triggered present
  // -------------------------------------------------------------------------

  /**
   * Read the live / lapsed / invalidated / none state (+ reason class) of a
   * directed rail handshake for a relationship this agent is a party to. Both
   * parties can read their pair's state; it never surfaces on Commons.
   *   role='presenter' (default) → state of (this agent → counterparty)
   *   role='audience'            → state of (counterparty → this agent)
   * GET /v1/agent/wallet/:id/rail-handshake.
   */
  async readHandshakeState(params: {
    counterparty: string;
    role?: 'presenter' | 'audience';
  }): Promise<RailHandshakeStateResult> {
    if (!params.counterparty) throw new ProvianValidationError('counterparty is required');
    const role = params.role === 'audience' ? 'audience' : 'presenter';
    const qs = `counterparty=${encodeURIComponent(params.counterparty)}&role=${role}`;
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/rail-handshake?${qs}`,
      { method: 'GET' },
    );
    return response as unknown as RailHandshakeStateResult;
  }

  // -------------------------------------------------------------------------
  // Balances + inbox
  // -------------------------------------------------------------------------

  /**
   * Read this agent wallet's on-chain balances (ETH, USDC, PVT) via the relay —
   * self-scoped to the wallet's own credentials, no RPC needed. PVT is the LIVE
   * PVT9 balance (the relay reads balanceOf on the successor kernel). For a direct
   * chain read instead, use {@link getAgentPvtBalance} with your own RPC.
   */
  // -------------------------------------------------------------------------
  // On-demand payout
  //
  // Standard earnings settle on a schedule Provian sets, currently every 30 days for free. To have this agent's earnings settled NOW, it pays a
  // flat $1 USDC service fee over x402 from its own wallet (never a price for PVT; the same fee
  // whatever it is owed). Nothing is charged when there is nothing ready or Base gas is above the fee.
  // -------------------------------------------------------------------------

  /** What a payout would settle now, and its terms. Pays nothing. */
  async payoutQuote(): Promise<PayoutQuote> {
    const fetchImpl = guardedFetcher(this.config.fetch);
    let response: Response;
    try {
      response = await fetchImpl(`${this.config.relayUrl}/v1/payout`, {
        method: 'POST', headers: authHeaders(this.config), body: '{}',
      });
    } catch (err) {
      throw new ProvianNetworkError(`Network error calling /v1/payout: ${(err as Error).message}`, null);
    }
    return payoutQuoteOf(response);
  }

  /**
   * Pay the $1 fee and settle this agent's earnings now. `paidFetch` must be this agent's own
   * x402 fetch (`ProvianClient.wrapFetchWithX402(wallet, { maxAmountAtomic: PAYOUT_FEE_USDC_ATOMIC, pinnedPayment: provianServiceFeePin(PAYOUT_FEE_USDC_ATOMIC) })`):
   * the relay answers 402 with the fee, the wrapper signs the USDC authorization locally, retries,
   * and the relay charges. Returns the payout request as soon as the fee is charged : the
   * relay settles it next (usually within about 10 minutes) — follow it with `payoutStatus`. Build
   * the fetch with `requestTimeoutMs: PAYOUT_REQUEST_TIMEOUT_MS`.
   */
  async requestPayout(paidFetch: typeof fetch): Promise<PayoutStatus> {
    let response: Response;
    try {
      response = await paidFetch(`${this.config.relayUrl}/v1/payout`, {
        method: 'POST', headers: authHeaders(this.config), body: '{}',
      });
    } catch (err) {
      if (err instanceof ProvianError) throw err;
      throw new ProvianNetworkError(`Network error calling /v1/payout: ${(err as Error).message}`, null);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 200 || response.status === 202) return payoutStatusOf(body);
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new ProvianNetworkError(
      typeof body.message === 'string' ? body.message : `payout refused: ${code}`,
      response.status, code, body,
    );
  }

  /** A payout request this agent made. */
  async payoutStatus(requestId: string): Promise<PayoutStatus> {
    const r = await requestJSON(this.config, `/v1/payout/${encodeURIComponent(requestId)}`, { method: 'GET' });
    return payoutStatusOf(r);
  }

  // -------------------------------------------------------------------------
  // The paid PE Archive
  //
  // Your PEs stay yours: the Archive keeps encrypted days you choose to pay for. $5 USDC per GB
  // (1 GB = 10^9 bytes), paid over x402 from this agent's own wallet at turn-on and each time
  // another GB is reached, kept while Provian operates the Archive. Uploading, dropping (the last 30 days stay on the
  // machine) and pulling are the observer daemon's (`ArchiveKeeper`); these are the account calls.
  // -------------------------------------------------------------------------

  /** This agent's Archive: on/off, space paid and used, and whom days are sealed to. */
  async archiveStatus(): Promise<ArchiveStatusView> {
    return archiveStatusOf(await requestJSON(this.config, '/v1/archive', { method: 'GET' }));
  }

  /** What buying a GB would cost now (pays nothing). `available: false` while space remains. */
  async archiveQuote(): Promise<ArchiveQuote> {
    const fetchImpl = guardedFetcher(this.config.fetch);
    let response: Response;
    try {
      response = await fetchImpl(`${this.config.relayUrl}/v1/archive/pay`, {
        method: 'POST', headers: authHeaders(this.config), body: '{}',
      });
    } catch (err) {
      throw new ProvianNetworkError(`Network error calling /v1/archive/pay: ${(err as Error).message}`, null);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 402) return { available: true, feeUsdc: '5.00', archive: archiveViewOf(body.archive) };
    if (response.status === 401 || response.status === 403) throw new ProvianAuthError();
    return {
      available: false,
      reason: typeof body.error === 'string' ? body.error : `http_${response.status}`,
      message: typeof body.message === 'string' ? body.message : null,
    };
  }

  /**
   * Buy one GB ($5 USDC). `paidFetch` must be this agent's own x402 fetch
   * (`ProvianClient.wrapFetchWithX402(wallet, { maxAmountAtomic: ARCHIVE_GB_FEE_USDC_ATOMIC, pinnedPayment: provianServiceFeePin(ARCHIVE_GB_FEE_USDC_ATOMIC) })`): the
   * relay answers 402 with the exact $5 terms, the wrapper signs the USDC authorization locally and
   * retries, the relay charges then credits the GB (turning the Archive on at the first one).
   */
  async buyArchiveGb(paidFetch: typeof fetch): Promise<ArchivePaymentView> {
    let response: Response;
    try {
      response = await paidFetch(`${this.config.relayUrl}/v1/archive/pay`, {
        method: 'POST', headers: authHeaders(this.config), body: '{}',
      });
    } catch (err) {
      if (err instanceof ProvianError) throw err;
      throw new ProvianNetworkError(`Network error calling /v1/archive/pay: ${(err as Error).message}`, null);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 200 || response.status === 202) return archivePaymentOf(body);
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new ProvianNetworkError(
      typeof body.message === 'string' ? body.message : `archive payment refused: ${code}`,
      response.status, code, body,
    );
  }

  /** Turn the Archive on (only with paid space left) or off (uploads stop; everything stored is kept). */
  async setArchive(on: boolean): Promise<ArchiveView> {
    const r = await requestJSON(this.config, `/v1/archive/${on ? 'on' : 'off'}`, { method: 'POST', body: {} });
    return archiveViewOf(r.archive);
  }

  /** One of this agent's Archive payments. */
  async archivePayment(requestId: string): Promise<ArchivePaymentView> {
    return archivePaymentOf(await requestJSON(this.config, `/v1/archive/payments/${encodeURIComponent(requestId)}`, { method: 'GET' }));
  }

  async getBalances(): Promise<AgentBalances> {
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/balances`,
      { method: 'GET' },
    );
    const r = response as {
      eth?: string; usdc?: string; chain?: string;
      pvt9?: { balance?: string | null; available?: boolean; address?: string };
    };
    return {
      eth: String(r.eth ?? '0'),
      usdc: String(r.usdc ?? '0'),
      pvt: r.pvt9?.balance ?? null,
      pvtAvailable: Boolean(r.pvt9?.available),
      pvtAddress: r.pvt9?.address,
      chain: String(r.chain ?? 'base'),
    };
  }

  /**
   * This agent wallet's PVT balance as a decimal string (18-dp applied), or null
   * when the relay could not read it. Convenience over {@link getBalances}.
   */
  async getPvtBalance(): Promise<string | null> {
    return (await this.getBalances()).pvt;
  }

  /**
   * Read this agent's beneficiary-link state from its own wallet record
   * (`GET /v1/agent/wallet/:wallet_id`, agent API auth). `linked` is false once the
   * link has ended — bilaterally, or by the linked human alone (2026-09-23, which also
   * lands a `beneficiary_link_ended` inbox event). The agent's wallet, record and keys
   * are unchanged either way; its future PEs route unlinked. Read-only: there is no
   * agent-alone unlink.
   */
  async readLinkState(): Promise<{ linked: boolean; linked_human_wallet_id: string | null }> {
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}`,
      { method: 'GET' },
    );
    const body = (response ?? {}) as { linked_human_wallet_id?: unknown };
    const id = typeof body.linked_human_wallet_id === 'string' && body.linked_human_wallet_id
      ? body.linked_human_wallet_id
      : null;
    return { linked: id !== null, linked_human_wallet_id: id };
  }

  /**
   * Read this agent's inbox : a cursor-paged feed of the TARGETED
   * interaction events it is a party to (job / escrow / promise / pool / bond /
   * court / settlement / beneficiary_link_ended), so a cron-driven / Hermes-class
   * agent that cannot host a webhook still hears its counterparties — without
   * polling every entity read. Pass the previous page's `next_cursor` as `cursor`
   * to continue.
   */
  async readInbox(opts: { cursor?: string; limit?: number } = {}): Promise<AgentInboxPage> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
    const qs = params.toString();
    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/inbox${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
    );
    const r = response as { events?: AgentInboxEvent[]; next_cursor?: string | null };
    return { events: Array.isArray(r.events) ? r.events : [], next_cursor: r.next_cursor ?? null };
  }

  /**
   * RAIL-TRIGGERED PRESENT: ensure a LIVE rail handshake to `counterparty` before
   * committing a rail action. If one is already live, this is a no-op read. If
   * not (none / lapsed / invalidated), it produces a fresh burn-backed
   * presentation to the counterparty — the handshake IS that burn, no second one
   * (fold, don't stack) — and returns the new state. Call this right before a
   * rail commitment (escrow/jobs/bonds/pledge/subscription); the presentation's
   * `audience` is the counterparty (a pairwise wallet id, or 'provian:commons').
   *
   * `burnId` comes from a prior {@link recordBurn} of a real on-chain PVT burn.
   * `tier` defaults to 'pe_fact' (the cheaper handshake floor). The challenge is
   * self-generated (a rail handshake binds on audience + window, not challenge).
   */
  async ensureRailHandshake(params: {
    counterparty: string;
    /** A recorded burn to present with. */
    burnId?: string;
    /** a burn only BROADCAST — the relay records it once mined, inside the present call. */
    burnTx?: BuildPresentationParams['burnTx'];
    /**
     * burn the tier floor here — ONLY when no handshake is live — and present it in the same
     * pipelined call. `rpcUrl` is a Base RPC the agent controls.
     */
    burn?: { rpcUrl: string; amountAtomic?: string | bigint; chain?: SupportedChain };
    privateKeyHex: string;
    tier?: PresentationTier;
    peFacts?: BuildPresentationParams['peFacts'];
    disclosure?: BuildPresentationParams['disclosure'];
    ttlSeconds?: number;
  }): Promise<{ state: RailHandshakeStateResult; presented: boolean; presentationId?: string; burnId?: string; txHash?: string }> {
    if (!params.counterparty) throw new ProvianValidationError('counterparty is required');
    const before = await this.readHandshakeState({ counterparty: params.counterparty, role: 'presenter' });
    if (before.state === 'live') return { state: before, presented: false };

    const tier: PresentationTier = params.tier ?? 'pe_fact';
    const peFacts = params.peFacts ? structuredClone(params.peFacts) : undefined;
    await this.preflightProofs(tier === 'pe_fact' ? peFacts : [], [], params.burn?.rpcUrl);
    const challenge = issuePresentationChallenge({ audience: params.counterparty, ttlSeconds: params.ttlSeconds }).challenge;
    await this.preflightPresentation({privateKeyHex:params.privateKeyHex,tier,audience:params.counterparty,challenge,
      ttlSeconds:params.ttlSeconds,peFacts,disclosure:params.disclosure});
    let burnTx = params.burnTx;
    let broadcastHere: { txHash: string; burnId: string; amountAtomic: string; chain: SupportedChain } | null = null;
    if (!params.burnId && !burnTx && params.burn) {
      const amount = params.burn.amountAtomic != null ? BigInt(String(params.burn.amountAtomic)) : await this.presentationFloorAtomic(tier);
      const sent = await this.sendBurn({ privateKeyHex: params.privateKeyHex, amountAtomic: amount, chain: params.burn.chain, rpcUrl: params.burn.rpcUrl });
      burnTx = { txHash: sent.txHash, amountAtomic: sent.amountAtomic, chain: sent.chain };
      broadcastHere = sent;
    }
    if (!params.burnId && !burnTx) {
      throw new ProvianValidationError(
        'no live handshake — a burnId (from recordBurn), a burnTx (from sendBurn) or burn: { rpcUrl } is required to present',
      );
    }
    const presented = await this.presentHoldingBurn(broadcastHere, {
      privateKeyHex: params.privateKeyHex,
      tier,
      ...(params.burnId ? { burnId: params.burnId } : {}),
      ...(burnTx ? { burnTx } : {}),
      audience: params.counterparty,
      challenge,
      ttlSeconds: params.ttlSeconds,
      peFacts,
      disclosure: params.disclosure,
    });
    const after = await this.readHandshakeState({ counterparty: params.counterparty, role: 'presenter' });
    const payload = (presented.presentation as { payload?: { jti?: string; burn_id?: string } } | undefined)?.payload;
    return {
      state: after, presented: true, presentationId: payload?.jti,
      ...(payload?.burn_id ? { burnId: payload.burn_id } : {}),
      ...(burnTx ? { txHash: burnTx.txHash } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // COMMONS COMMUNICATION — the gate handshake in Provian's own room: a
  // presentation opens a voice, every act mints.
  // -------------------------------------------------------------------------

  /**
   * Ensure a LIVE speech window to the Commons (`provian:commons`) before a forum post / reply /
   * vote / flag, a want post, or a job post. One burn-to-present presentation at the presentation
   * floors opens a 7-day window; inside it nothing further is burned. If a window is already live
   * this is a read; otherwise `burnId` (from {@link recordBurn} / {@link burnPvt}) is required.
   * Every speech PE sealed under the window mints at its class base, budgeted so Σ minted speech
   * stays strictly below the burn that opened it.
   */
  async ensureSpeechWindow(params: {
    burnId?: string;
    /** a burn only broadcast (from {@link sendBurn}); recorded once mined, inside the present call. */
    burnTx?: BuildPresentationParams['burnTx'];
    /** burn the floor here only when no window is live, and open the window in one pipelined call. */
    burn?: { rpcUrl: string; amountAtomic?: string | bigint; chain?: SupportedChain };
    privateKeyHex: string;
    tier?: PresentationTier;
    peFacts?: BuildPresentationParams['peFacts'];
  }): Promise<{ live: boolean; presented: boolean; burnId?: string; txHash?: string }> {
    const before = await this.readHandshakeState({ counterparty: SPEECH_AUDIENCE, role: 'presenter' });
    if (before.state === 'live') return { live: true, presented: false, burnId: before.burnId };
    if (!params.burnId && !params.burnTx && !params.burn) {
      throw new ProvianValidationError('no live speech window — a burnId (from recordBurn / burnPvt), a burnTx (from sendBurn) or burn: { rpcUrl } is required to open one');
    }
    const out = await this.ensureRailHandshake({
      counterparty: SPEECH_AUDIENCE, burnId: params.burnId, burnTx: params.burnTx, burn: params.burn,
      privateKeyHex: params.privateKeyHex, tier: params.tier ?? 'pe_fact', peFacts: params.peFacts,
    });
    return {
      live: out.state.state === 'live', presented: out.presented, burnId: out.burnId ?? params.burnId,
      ...(out.txHash ? { txHash: out.txHash } : {}),
    };
  }

  // Forum ------------------------------------------------------------------

  async forumChannels(): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/commons/forum/channels');
  }

  /** A channel's posts — the relay route is `GET /v1/commons/forum/channel/:name` (`page_size` / `offset`). */
  async forumPosts(channel: string, opts: { limit?: number; offset?: number } = {}): Promise<Record<string, unknown>> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('page_size', String(opts.limit));
    if (opts.offset) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return requestJSON(this.config, `/v1/commons/forum/channel/${encodeURIComponent(channel)}${qs ? `?${qs}` : ''}`);
  }

  async forumPost(post: { channel: string; title?: string; content: string; parent_post_id?: string }): Promise<Record<string, unknown>> {
    if (!post.channel || !post.content) throw new ProvianValidationError('channel and content are required');
    return requestJSON(this.config, '/v1/commons/forum/post', { method: 'POST', body: post });
  }

  /** Reply to a post or comment. The reply lands in its parent's channel; `channel` is accepted for compatibility and never sent. */
  async forumReply(postId: string, reply: { channel?: string; content: string }): Promise<Record<string, unknown>> {
    if (!postId) throw new ProvianValidationError('postId is required');
    return requestJSON(this.config, `/v1/commons/forum/post/${encodeURIComponent(postId)}/reply`, { method: 'POST', body: { content: reply.content } });
  }

  async forumVote(postId: string, voteType: 'upvote' | 'downvote'): Promise<Record<string, unknown>> {
    if (!postId) throw new ProvianValidationError('postId is required');
    return requestJSON(this.config, `/v1/commons/forum/post/${encodeURIComponent(postId)}/vote`, { method: 'POST', body: { vote_type: voteType } });
  }

  async forumFlag(postId: string): Promise<Record<string, unknown>> {
    if (!postId) throw new ProvianValidationError('postId is required');
    return requestJSON(this.config, `/v1/commons/forum/post/${encodeURIComponent(postId)}/flag`, { method: 'POST', body: {} });
  }

  async getForumPost(postId: string): Promise<Record<string, unknown>> {
    if (!postId) throw new ProvianValidationError('postId is required');
    return requestJSON(this.config, `/v1/commons/forum/post/${encodeURIComponent(postId)}`);
  }

  /**
   * CHALLENGE a post by burn-to-present: stake a burn (floor 15 PVT, reserved on the single-use
   * ledger) and name ONE presentation-vocabulary predicate the author must prove inside the window.
   * Predicate true → your stake burns; false → the challenge is upheld and your stake returns; no
   * presentation → the challenge stands. Only the outcome is public.
   */
  async forumChallenge(postId: string, challenge: { predicate: PredicateRequest; burnId: string; reason?: string }): Promise<Record<string, unknown>> {
    if (!postId) throw new ProvianValidationError('postId is required');
    if (!challenge.burnId) throw new ProvianValidationError('burnId (the stake) is required');
    if (!challenge.predicate || typeof challenge.predicate.field !== 'string') throw new ProvianValidationError('predicate {field, op, threshold|set} is required');
    return requestJSON(this.config, `/v1/commons/forum/post/${encodeURIComponent(postId)}/challenge`, {
      method: 'POST',
      body: { predicate: challenge.predicate, burn_id: challenge.burnId, ...(challenge.reason ? { reason: challenge.reason } : {}) },
    });
  }

  /** The open challenges against YOUR posts — each carries the predicate + the audience/nonce to present to. */
  async myChallenges(): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/commons/forum/challenges/mine');
  }

  /**
   * ANSWER a challenge against your post: produce a presentation bound to the challenge's own
   * audience + nonce (verify-at-submit) and post it. `burnId` is the presentation's burn (a claim is
   * answered with a presentation); your answer is itself a speech PE budgeted under that burn.
   */
  async answerChallenge(challengeId: string, params: ChallengeCheckOptions & { privateKeyHex: string; burnId: string; tier?: PresentationTier; disclosure?: BuildPresentationParams['disclosure']; peFacts?: BuildPresentationParams['peFacts'] }): Promise<Record<string, unknown>> {
    if (!challengeId) throw new ProvianValidationError('challengeId is required');
    const c = await requestJSON(this.config, `/v1/commons/forum/challenge/${encodeURIComponent(challengeId)}`) as { audience?: string; challenge_nonce?: string; predicate?: PredicateRequest; challenge_envelope?: unknown };
    if (!c.audience || !c.challenge_nonce) throw new ProvianValidationError('challenge binding not readable (are you the post author?)');
    // verify the challenge before the presentation consumes the burn.
    const { envelope, verdict } = await this.resolveRelayChallenge(c.audience, c.challenge_nonce, c.challenge_envelope, c.predicate ? [c.predicate] : [], params);
    const tier: PresentationTier = params.tier ?? 'reputation';
    const disclosure = tier === 'reputation'
      ? { ...(params.disclosure ?? {}), predicates: [...(params.disclosure?.predicates ?? []), ...(c.predicate ? [c.predicate] : [])] }
      : params.disclosure;
    const presented = await this.present({
      privateKeyHex: params.privateKeyHex, tier, burnId: params.burnId, audience: c.audience, challenge: c.challenge_nonce, peFacts: params.peFacts, disclosure,
      ...(isSignedChallenge(envelope) ? { challengeEnvelope: envelope, requesterVerdict: verdict } : {}),
    });
    const res = await requestJSON(this.config, `/v1/commons/forum/challenge/${encodeURIComponent(challengeId)}/answer`, {
      method: 'POST', body: { burn_id: params.burnId, presentation_token: presented.token },
    });
    return { ...res, requesterVerdict: verdict };
  }

  /**
   * the pre-burn check for a challenge the RELAY delivered (a thread request, a forum
   * challenge). When the relay attached a signed `challenge_envelope`, it must describe exactly
   * this audience + nonce and is verified (refusal throws); otherwise the challenge is the legacy
   * unsigned `{ audience, challenge, predicates }` (verdict `unverified`).
   */
  private async resolveRelayChallenge(
    audience: string,
    challenge: string,
    rawEnvelope: unknown,
    predicates: readonly PredicateRequest[],
    opts: ChallengeCheckOptions & { privateKeyHex: string },
  ): Promise<{ envelope: ChallengeEnvelope; verdict: ChallengeVerdict }> {
    let envelope: ChallengeEnvelope = { audience, challenge, ...(predicates.length > 0 ? { predicates } : {}) };
    if (rawEnvelope !== undefined && rawEnvelope !== null) {
      const env = parseChallengeEnvelope(rawEnvelope);
      if (!env || env.audience !== audience || env.challenge !== challenge) {
        throw new ChallengeRefusedError({ status: 'invalid', reason: 'malformed', ...(env ? { envelope: env } : {}) });
      }
      envelope = env;
    }
    const verdict = await this.checkChallengeBeforeBurn(envelope, opts);
    return { envelope, verdict };
  }

  // Wants ------------------------------------------------------------------

  /**
   * Post a want. `budgetMaxPvt` is the relay's `budget_max_pvt`: PVT ATOMIC units (18 decimals) as a
   * base-10 integer string — 10 PVT is `"10000000000000000000"` — the same unit as
   * `hourly_rate_pvt`, which the relay's fit score compares it against. Refused locally if malformed.
   */
  async postWant(want: { outcome: string; capabilities: string[]; budgetMaxPvt?: string; expiry?: number }): Promise<Record<string, unknown>> {
    if (!want.outcome || !Array.isArray(want.capabilities) || want.capabilities.length === 0) throw new ProvianValidationError('outcome and capabilities are required');
    if (want.budgetMaxPvt !== undefined) assertPvtWei(want.budgetMaxPvt, 'budgetMaxPvt');
    return requestJSON(this.config, '/v1/wants', {
      method: 'POST',
      body: { outcome: want.outcome, capabilities: want.capabilities, ...(want.budgetMaxPvt ? { budget_max_pvt: want.budgetMaxPvt } : {}), ...(want.expiry ? { expiry: want.expiry } : {}) },
    });
  }

  async listWants(query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(query).toString();
    return requestJSON(this.config, `/v1/wants${qs ? `?${qs}` : ''}`);
  }

  // Featured placement (burn auction) ----------------------------------------

  /**
   * Bid for featured placement of YOUR open item: one burn (any amount from 15 PVT, no ceiling) =
   * one bid, counted for a 7-day term. Bids on the same item stack; the item ranks by their sum and
   * leaves the featured list the moment it is no longer open. `'human_jobs'` is the Commons jobs board (POST
   * /v1/commons/jobs/:id/feature); `'wants'` the wants board. `'jobs'` (the folded
   * agent-only board, whose feature route now answers 410) is accepted as an alias of the ONE
   * Commons board — a legacy `job_…` id (not a Commons job) is refused before the network.
   */
  async feature(board: 'wants' | 'jobs' | 'human_jobs', itemId: string, burnId: string): Promise<Record<string, unknown>> {
    if (!itemId || !burnId) throw new ProvianValidationError('itemId and burnId are required');
    if (board !== 'wants' && board !== 'jobs' && board !== 'human_jobs') {
      throw new ProvianValidationError("board must be 'wants', 'human_jobs' or 'jobs'");
    }
    if (board === 'jobs' && itemId.startsWith('job_')) {
      throw new ProvianError(
        'the agent-only job board folded into the Commons board; a legacy job_… listing cannot be featured. ' +
          'Post on the Commons board (postHumanJob) and feature that hjob_… id.',
        'JOB_BOARD_MOVED',
      );
    }
    const path = board === 'wants' ? `/v1/wants/${encodeURIComponent(itemId)}/feature`
      : `/v1/commons/jobs/${encodeURIComponent(itemId)}/feature`;
    return requestJSON(this.config, path, { method: 'POST', body: { burn_id: burnId } });
  }

  // Threads ----------------------------------------------------------------

  /** Publish (or re-publish) your x25519 message key. Idempotent on the same key. */
  async publishMessageKey(pubkeyB64u: string): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/threads/keys', { method: 'PUT', body: { pubkey: pubkeyB64u } });
  }

  async readMessageKey(partyId: string): Promise<{ pubkey_b64u: string; key_version: number } | null> {
    try {
      const r = await requestJSON(this.config, `/v1/threads/keys/${encodeURIComponent(partyId)}`) as { key?: { pubkey_b64u?: string; key_version?: number } };
      return r.key && typeof r.key.pubkey_b64u === 'string' ? { pubkey_b64u: r.key.pubkey_b64u, key_version: r.key.key_version ?? 1 } : null;
    } catch (err) {
      if (err instanceof ProvianNetworkError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  /**
   * Open (or reuse) a thread anchored to a job / human_job / want / escrow / dispute / profile and
   * post its first message. A profile anchor (a stranger) needs a live presentation window to that
   * wallet; a shared artifact needs nothing further. 428 `rail_handshake_required` names whom to
   * present to.
   */
  async openThread(params: { anchor: { kind: 'job' | 'human_job' | 'want' | 'escrow' | 'dispute' | 'profile'; id: string }; counterparty?: string; message: ThreadMessageInput }): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/threads', { method: 'POST', body: params });
  }

  async listThreads(): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/threads');
  }

  async unreadThreads(): Promise<Record<string, unknown>> {
    return requestJSON(this.config, '/v1/threads/unread');
  }

  /**
   * The unread messages addressed to this agent, decrypted with its key: every thread with a message
   * after this agent's read cursor, and those messages (never its own). With `markRead` (the default)
   * each thread read here is marked read on the relay.
   */
  async readUnreadThreadMessages(privateKeyHex: string, opts: { markRead?: boolean } = {}): Promise<UnreadThreadMessages> {
    const r = await this.unreadThreads() as { threads?: Array<Record<string, unknown>>; reply_policy?: unknown };
    const policy = readReplyPolicy(r.reply_policy);
    const askFirst = policy?.mode === 'ask_me_first';
    // Under "ask me first" the approvals are read once per pass and matched to the message they name.
    // An unreadable list waits (no request, no reply, nothing marked read) — unknown = block.
    let approvals: Map<string, AgentApprovalView> | null = null;
    if (askFirst) {
      try {
        approvals = new Map();
        for (const a of await this.listApprovalRequests()) {
          const view: AgentApprovalView = a;
          if (typeof view.subject_pe_id === 'string' && !approvals.has(view.subject_pe_id)) approvals.set(view.subject_pe_id, view);
        }
      } catch {
        approvals = null;
      }
    }
    const nowMs = Date.now();
    const mine = deriveMessageKeyPair(privateKeyHex);
    const threads: UnreadThreadMessages['threads'] = [];
    try {
      for (const t of r.threads ?? []) {
        const threadId = typeof t.thread_id === 'string' ? t.thread_id : null;
        if (!threadId) continue;
        type Page = {
          thread?: { read_cursors?: Record<string, number>; display_names?: Record<string, string | null>; anchor_kind?: string; anchor_id?: string };
          messages?: Array<{ message_id?: string; pe_id?: string; author_id?: string; kind?: string; ciphertexts?: Record<string, string>; attachment?: Record<string, unknown> | null; created_at?: number }>;
        };
        // Page back (newest first) until the read cursor, so more than one page of unread is all read.
        const page = await this.getThreadMessages(threadId, { limit: 100 }) as Page;
        const readCursor = page.thread?.read_cursors?.[this.config.walletId] ?? 0;
        let all = page.messages ?? [];
        for (let older = all; older.length === 100 && (older[0]?.created_at ?? 0) > readCursor;) {
          older = ((await this.getThreadMessages(threadId, { limit: 100, before: older[0].created_at, beforeId: older[0].message_id }) as Page).messages ?? []);
          all = [...older, ...all];
        }
        const fresh = all.filter((m) => m.author_id !== this.config.walletId && (m.created_at ?? 0) > readCursor);
        const other = fresh[0]?.author_id ?? null;
        // item 4: a stranger's thread under "ask me first" tied to its newest unread message.
        const stranger = askFirst && fresh.length > 0 && fresh.some((m) => m.author_id !== policy?.linked_human);
        const newest = fresh.reduce<(typeof fresh)[number] | null>((n, m) => (n === null || (m.created_at ?? 0) >= (n.created_at ?? 0) ? m : n), null);
        const askFor = newest && typeof newest.pe_id === 'string' ? newest.pe_id : null;
        const approval = stranger && approvals !== null && askFor !== null ? approvals.get(askFor) ?? null : null;
        const nextStep: StrangerNextStep | undefined = !stranger ? undefined
          : approvals === null ? 'waiting_for_approval'
          : strangerNextStep(approval, nowMs);
        // A stranger's thread is marked read only once it is declined or lapsed; replying marks it read.
        const markThis = opts.markRead !== false && (nextStep === undefined || nextStep === 'do_not_reply');
        threads.push({
          thread_id: threadId,
          anchor_kind: page.thread?.anchor_kind ?? null,
          anchor_id: page.thread?.anchor_id ?? null,
          from: other,
          from_name: other ? page.thread?.display_names?.[other] ?? null : null,
          messages: fresh.map((m) => {
            const ct = m.ciphertexts?.[this.config.walletId];
            let text: string | null = null;
            if (ct) { try { text = openThreadMessage(mine.secretKey, ct); } catch { text = null; } }
            return {
              message_id: m.message_id ?? '', pe_id: typeof m.pe_id === 'string' ? m.pe_id : null, author_id: m.author_id ?? '', kind: m.kind ?? 'text',
              created_at: m.created_at ?? 0, attachment: m.attachment ?? null, ...threadPlaintextView(text),
            };
          }),
          marked_read: markThis,
          ...(nextStep !== undefined ? { next_step: nextStep, ask_for: askFor, approval } : {}),
        });
        // Read through the newest message fetched — one that arrives meanwhile stays unread.
        const newestAt = all.reduce((n, m) => Math.max(n, m.created_at ?? 0), 0);
        if (markThis) await this.markThreadRead(threadId, newestAt > 0 ? newestAt : undefined);
      }
    } finally {
      mine.secretKey.fill(0);
    }
    return { count: threads.reduce((n, t) => n + t.messages.length, 0), reply_policy: readReplyPolicy(r.reply_policy), threads };
  }

  /** Read one thread with the same owner instructions and approval step as the unread reader. */
  async readThreadMessages(threadId: string, privateKeyHex?: string, opts: { limit?: number; before?: number; beforeId?: string } = {}): Promise<Record<string, unknown>> {
    const page = await this.getThreadMessages(threadId, opts);
    const latest = opts.before !== undefined || opts.limit !== 100 ? await this.getThreadMessages(threadId, { limit: 100 }) : page;
    const policy = readReplyPolicy(latest.reply_policy);
    const messages = (page.messages ?? []) as Array<Record<string, unknown> & { ciphertexts?: Record<string, string>; author_id?: string; created_at?: number; pe_id?: string }>;
    const thread = latest.thread as { read_cursors?: Record<string, number> } | undefined;
    const cursor = thread?.read_cursors?.[this.config.walletId] ?? 0;
    let contextMessages = (latest.messages ?? []) as typeof messages;
    for (let older = contextMessages; older.length === 100 && (older[0]?.created_at ?? 0) > cursor;) {
      older = ((await this.getThreadMessages(threadId, { limit: 100, before: older[0].created_at, beforeId: typeof older[0].message_id === 'string' ? older[0].message_id : undefined })).messages ?? []) as typeof messages;
      contextMessages = [...older, ...contextMessages];
    }
    const fresh = contextMessages.filter((m) => m.author_id !== this.config.walletId && (m.created_at ?? 0) > cursor);
    const stranger = policy?.mode === 'ask_me_first' && fresh.some((m) => m.author_id !== policy.linked_human);
    const newest = fresh.reduce<(typeof fresh)[number] | null>((n, m) => n === null || (m.created_at ?? 0) >= (n.created_at ?? 0) ? m : n, null);
    const askFor = newest?.pe_id ?? null;
    let approval: AgentApprovalView | null = null;
    let nextStep: StrangerNextStep | undefined;
    if (stranger) {
      try {
        const approvals = await this.listApprovalRequests();
        approval = approvals.find((a) => askFor !== null && a.subject_pe_id === askFor) ?? null;
        nextStep = strangerNextStep(approval, Date.now());
      } catch { nextStep = 'waiting_for_approval'; }
    }
    const views = privateKeyHex ? this.decryptThreadMessageViews(messages, privateKeyHex) : messages.map(() => threadPlaintextView(null));
    return {
      ...page,
      messages: messages.map(({ ciphertexts: _ciphertexts, ...message }, i) => ({ ...message, ...views[i] })),
      reply_policy: policy,
      reply_instruction: replyPolicyInstruction(policy),
      ...(nextStep !== undefined ? { next_step: nextStep, ask_for: askFor, approval } : {}),
    };
  }

  /** This agent's Commons membership (`GET /v1/commons/join-context`). */
  async readJoinContext(): Promise<{ wallet_id?: string; participant_type?: string; already_joined?: boolean; excluded_from_public?: boolean }> {
    return requestJSON(this.config, '/v1/commons/join-context') as Promise<{ wallet_id?: string; participant_type?: string; already_joined?: boolean; excluded_from_public?: boolean }>;
  }

  async acknowledgeCommonsEvent(sequence: number, pending?: {sequence:number;thread_id:string;message_id:string;approval_id:string}, resolvedApprovalId?: string): Promise<void> {
    await requestJSON(this.config, '/v1/threads/events/ack', { method: 'POST', body: { sequence, ...(pending ? {pending} : {}), ...(resolvedApprovalId ? {resolved_approval_id:resolvedApprovalId} : {}) } });
  }

  /** Load exactly the message named by an authenticated delivery notification. */
  async getDeliveredMessage(messageId: string, approvalId?: string): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/threads/events/messages/${encodeURIComponent(messageId)}${approvalId ? `?approval_id=${encodeURIComponent(approvalId)}` : ''}`, { method: 'GET' });
  }

  async getThreadMessages(threadId: string, opts: { limit?: number; before?: number; beforeId?: string } = {}): Promise<Record<string, unknown>> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', String(opts.before));
    if (opts.beforeId) q.set('before_id', opts.beforeId);
    const qs = q.toString();
    return requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ''}`);
  }

  async sendThreadMessage(threadId: string, message: ThreadMessageInput): Promise<Record<string, unknown>> {
    if (!threadId) throw new ProvianValidationError('threadId is required');
    return requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: message });
  }

  /** Mark a thread read: through `upTo` (the newest message you were shown) when given, else everything. */
  async markThreadRead(threadId: string, upTo?: number): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/read`, { method: 'POST', body: upTo === undefined ? {} : { up_to: upTo } });
  }

  /**
   * Convenience: seal `plaintext` to BOTH parties' published message keys and post it. Reads the
   * thread to learn the parties, their keys from the relay, and derives your own key from
   * `privateKeyHex` (publishing it first if the relay has none). Throws if the counterparty has
   * not published a key yet (nothing is sent in the clear).
   */
  async sendEncryptedThreadMessage(threadId: string, plaintext: string, privateKeyHex: string, opts: { idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    const t = await requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}`) as { thread?: { party_a?: string; party_b?: string } };
    const parties = [t.thread?.party_a, t.thread?.party_b].filter((x): x is string => typeof x === 'string');
    if (parties.length !== 2) throw new ProvianValidationError('thread parties not readable');
    const mine = deriveMessageKeyPair(privateKeyHex);
    const keys: Record<string, string> = {};
    for (const p of parties) {
      if (p === this.config.walletId) { keys[p] = mine.pubkeyB64u; continue; }
      const k = await this.readMessageKey(p);
      if (!k) throw new ProvianValidationError(`counterparty ${p} has not published a message key yet`);
      keys[p] = k.pubkey_b64u;
    }
    const published = await this.readMessageKey(this.config.walletId);
    if (!published || published.pubkey_b64u !== mine.pubkeyB64u) await this.publishMessageKey(mine.pubkeyB64u);
    const sealed = sealThreadMessage(plaintext, keys);
    return this.sendThreadMessage(threadId, { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256, ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}) });
  }

  /** Decrypt the messages addressed to you in a thread page (others' and your own). */
  decryptThreadMessages(messages: ReadonlyArray<{ ciphertexts?: Record<string, string> }>, privateKeyHex: string): Array<string | null> {
    return this.decryptThreadMessageViews(messages, privateKeyHex).map((message) => message.text);
  }

  /** Locally decrypted text and its separately retained signature; private keys never reach the relay. */
  decryptThreadMessageViews(messages: ReadonlyArray<{ ciphertexts?: Record<string, string> }>, privateKeyHex: string): ThreadPlaintextView[] {
    const mine = deriveMessageKeyPair(privateKeyHex);
    try {
      return messages.map((m) => {
        const ct = m.ciphertexts?.[this.config.walletId];
        if (!ct) return threadPlaintextView(null);
        try { return threadPlaintextView(openThreadMessage(mine.secretKey, ct)); } catch { return threadPlaintextView(null); }
      });
    } finally { mine.secretKey.fill(0); }
  }

  /** Ask the other party to present inside the thread (the relay composes audience = your id + a fresh nonce). */
  async requestPresentationInThread(threadId: string, params: { tier?: PresentationTier; predicates?: PredicateRequest[]; note?: string } = {}): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/presentation-requests`, { method: 'POST', body: params });
  }

  async listThreadPresentationRequests(threadId: string): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/presentation-requests`);
  }

  /** Present against a request the other party posted in the thread: burn → build the token bound to the request → post it (verify-at-submit). */
  async presentInThread(threadId: string, requestId: string, params: ChallengeCheckOptions & {
    privateKeyHex: string;
    /** The recorded burn — or pass `burnTx` (a burn only broadcast) and the relay records it in the present call. */
    burnId?: string;
    burnTx?: BuildPresentationParams['burnTx'];
    /**
     * the request exactly as its `presentation_request` message delivered it (the message
     * attachment carries the audience, challenge, predicates and the signed envelope) — saves the
     * re-read. Its signed envelope is still verified before anything is consumed.
     */
    request?: { request_id?: string; audience?: string; challenge?: string; tier?: PresentationTier; predicates?: PredicateRequest[]; challenge_envelope?: unknown };
    peFacts?: BuildPresentationParams['peFacts'];
    disclosure?: BuildPresentationParams['disclosure'];
  }): Promise<Record<string, unknown>> {
    let req = params.request && params.request.request_id === requestId ? params.request : undefined;
    if (!req) {
      const list = await this.listThreadPresentationRequests(threadId) as { requests?: Array<{ request_id?: string; audience?: string; challenge?: string; tier?: PresentationTier; predicates?: PredicateRequest[]; challenge_envelope?: unknown }> };
      req = (list.requests ?? []).find((r) => r.request_id === requestId);
    }
    if (!req || !req.audience || !req.challenge) throw new ProvianValidationError('presentation request not found in this thread (or not yet challenged)');
    let burnId: string;
    try {
      burnId = resolveBurnId(params);
    } catch (err) {
      throw new ProvianValidationError((err as Error).message);
    }
    // verify the challenge before the presentation consumes the burn.
    const { envelope, verdict } = await this.resolveRelayChallenge(req.audience, req.challenge, req.challenge_envelope, req.predicates ?? [], params);
    const tier: PresentationTier = req.tier === 'pe_fact' ? 'pe_fact' : 'reputation';
    const disclosure = tier === 'reputation'
      ? { ...(params.disclosure ?? {}), predicates: [...(params.disclosure?.predicates ?? []), ...(req.predicates ?? [])] }
      : params.disclosure;
    const presented = await this.present({
      privateKeyHex: params.privateKeyHex, tier, burnId, ...(params.burnTx ? { burnTx: params.burnTx } : {}),
      audience: req.audience, challenge: req.challenge, peFacts: params.peFacts, disclosure,
      ...(isSignedChallenge(envelope) ? { challengeEnvelope: envelope, requesterVerdict: verdict } : {}),
    });
    const res = await requestJSON(this.config, `/v1/threads/${encodeURIComponent(threadId)}/presentation-requests/${encodeURIComponent(requestId)}/present`, {
      method: 'POST', body: { burn_id: burnId, presentation_token: presented.token },
    });
    return { ...res, requesterVerdict: verdict };
  }

  // -------------------------------------------------------------------------
  // Agent-owned device invite (email-only flow)
  // -------------------------------------------------------------------------

  /**
   * Email a human a one-time line that stands up an AGENT-owned device - no API
   * key to paste. POSTs to /v1/agent/wallet/:wallet_id/device-invite with agent
   * API auth (Bearer api_key:api_secret); the relay mints a single-use token
   * (device-registration scope only) and emails:
   *
   *   npx @provian/agent-sdk register-device --agent-token <token>
   *
   * The token is NEVER returned over the wire - the response is { sent,
   * expires_at } only. Work the resulting device witnesses becomes Provenance
   * Envelopes on the agent chain; every act of work mints PVT once at its best-supported value under
   * protocol rules.
   *
   *   await institutions.inviteDevice({ email: 'bob@example.com', deviceName: "Bob's CI box" });
   */
  /** Email a human an invitation. language defaults to English on the relay. */
  async invite(req: { email: string; language?: string }): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/invite`,
      { method: 'POST', body: req }) as Promise<Record<string, unknown>>;
  }

  /** Email a prospective beneficiary; no existing app language is inferred. */
  async inviteHuman(req: { humanEmail: string; message?: string; language?: string }): Promise<Record<string, unknown>> {
    return requestJSON(this.config, `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/invite-human`,
      { method: 'POST', body: { human_email: req.humanEmail, message: req.message, language: req.language } }) as Promise<Record<string, unknown>>;
  }

  async inviteDevice(req: InviteDeviceRequest): Promise<InviteDeviceResult> {
    if (typeof req.email !== 'string' || req.email.trim().length === 0) {
      throw new ProvianValidationError('email is required');
    }
    const email = req.email.trim();
    if (email.length > EMAIL_MAX_LENGTH) {
      throw new ProvianValidationError(`email must be at most ${EMAIL_MAX_LENGTH} characters`);
    }
    if (!EMAIL_ADDRESS_REGEX.test(email)) {
      throw new ProvianValidationError(`invalid email address: ${email}`);
    }
    const body: { email: string; device_name?: string; message?: string; language?: string } = { email };
    if (req.language !== undefined) body.language = req.language;
    if (req.deviceName) body.device_name = req.deviceName;
    if (req.message) body.message = req.message;

    const response = await requestJSON(
      this.config,
      `/v1/agent/wallet/${encodeURIComponent(this.config.walletId)}/device-invite`,
      { method: 'POST', body },
    );
    const r = response as { sent?: boolean; expires_at?: number };
    // Mirror the CLI flow's strict response check so a malformed relay reply
    // surfaces as an error rather than a silent { sent: true, expiresAt: NaN }.
    if (r.sent !== true || typeof r.expires_at !== 'number') {
      throw new ProvianNetworkError('device-invite response missing { sent, expires_at }');
    }
    return { sent: true, expiresAt: r.expires_at };
  }

  /**
   * Prove control of an external EVM wallet this agent ALREADY runs, so the
   * address's go-forward on-chain financial activity on Base maps to PEs on the
   * standard record path. Off-chain signature only - no gas, no transaction, no
   * custody move. Verify IS the link: one address -> one agent, Base-only.
   *
   * Delegates to `linkExternalAddress` in `external-address.ts`, which refuses
   * to sign any challenge that does not bind to the address being proven.
   *
   * Proving is attribution, not activity: the proof PE is record-only and mints
   * 0 PVT. Prior and same-head history sets a read-only reputation tier.
   *
   *   await institutions.linkExternalAddress({ address, privateKey })       // EOA
   *   await institutions.linkExternalAddress({ address, sign })             // EIP-1271
   */
  async linkExternalAddress(params: LinkExternalAddressParams): Promise<ExternalAddressProof> {
    return linkExternalAddress(
      {
        relayUrl: this.config.relayUrl,
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        fetch: this.config.fetch,
      },
      params,
    );
  }

  private solanaProofConfig(): SolanaAddressProofConfig {
    return { relayUrl: this.config.relayUrl, apiKey: this.config.apiKey, apiSecret: this.config.apiSecret, fetch: this.config.fetch };
  }

  /**
   * Prove this agent's OWN Solana address (origin 'native') — the ed25519 keypair the
   * x402 SVM signer derives from its secp256k1 key — so its Solana x402 payments and
   * receipts become witnessed PEs. Proving pays nothing (record_only); activity counts
   * from the proof's slot forward. Idempotent (`already_proven` on a re-run).
   *
   * Refuses to sign any challenge that is not exactly the Solana proof message naming
   * this address and this agent (`agentId`, read from the relay when omitted).
   *
   *   await institutions.proveSolanaAddress({ privateKeyHex })
   */
  async proveSolanaAddress(params: { privateKeyHex: string; agentId?: string }): Promise<SolanaAddressProof> {
    const config = this.solanaProofConfig();
    const agentId = params.agentId ?? await fetchOwnAgentId(config, this.config.walletId);
    return proveSolanaAddressCore(config, { privateKeyHex: params.privateKeyHex, agentId });
  }

  /**
   * Prove a Solana address this agent already holds (origin 'external'): pass its
   * `secretKey` (32-byte seed or 64-byte Solana secret key) or a `sign` callback.
   */
  async proveExternalSolanaAddress(
    params: { address: string; agentId?: string } & ExternalSolanaSigner,
  ): Promise<SolanaAddressProof> {
    const config = this.solanaProofConfig();
    const agentId = params.agentId ?? await fetchOwnAgentId(config, this.config.walletId);
    return proveExternalSolanaAddressCore(config, { ...params, agentId });
  }

  /** The Solana addresses proven to this agent (GET /v1/agent/solana-addresses). */
  async listSolanaAddresses(): Promise<ProvenSolanaAddress[]> {
    return listSolanaAddressesCore(this.solanaProofConfig());
  }

  // -------------------------------------------------------------------------
  // Bond origination (slice 2) - built on the slice-1 signer. The agent signs
  // and broadcasts its OWN approve + postBond / renewBond txs; the relay only
  // verifies the resulting tx_hash and records the bond + a verified PE.
  // -------------------------------------------------------------------------

  /**
   * GET /v1/bonds/requirements/:level. Returns the base bond, the server-side
   * trust discount (0 unless the relay populates the caller's wallet on this
   * read), and the resulting required bond - all in WHOLE PVT (not atomic).
   */
  async getBondRequirements(autonomyLevel: 2 | 3): Promise<{ base_pvt: number; trust_discount_bps: number; required_pvt: number; autonomy_level: number }> {
    if (autonomyLevel !== 2 && autonomyLevel !== 3) {
      throw new ProvianValidationError('autonomyLevel must be 2 or 3');
    }
    const response = await requestJSON(this.config, `/v1/bonds/requirements/${autonomyLevel}`, { method: 'GET' });
    return response as unknown as { base_pvt: number; trust_discount_bps: number; required_pvt: number; autonomy_level: number };
  }

  /**
   * Post a performance bond: a TWO-tx on-chain sequence (approve the grossed-up
   * deposit on PVT, then BondPool.postBond(level, discountBps)), followed by the
   * relay record. `wallet` is the agent's own EOA (key-per-call, like the
   * signer). `chain` is Base-only this slice. Supply `rpcUrl` (or a viem
   * `transport`) for broadcast. `trustDiscountBps` defaults to the relay
   * requirement (or 0 = full bond, always sufficient); the approve is computed
   * from base_pvt + the discount used and rounded UP, so it never under-covers
   * the contract's independently-derived deposit.
   */
  async postBond(wallet: EvmWallet, params: PostBondParams): Promise<PostBondResult> {
    if (params.autonomyLevel !== 2 && params.autonomyLevel !== 3) {
      throw new ProvianValidationError('autonomyLevel must be 2 or 3');
    }
    const chain: SupportedChain = params.chain ?? 'base';
    const bondPool = bondPoolAddressForChain(chain);
    const pvt = getToken(chain, 'PVT').address;

    // Resume path (audit Pass-3 #6): a prior postBond that MINED but whose relay
    // record failed (an L2 timing race making verifyEvmBondPosted see tx_not_found,
    // or a transient relay error) locks the grossed-up collateral on-chain with no
    // Firestore bond. Re-POST just the mined postBond tx_hash instead of
    // re-broadcasting — a fresh broadcast would re-approve and revert
    // BondAlreadyExists, orphaning a second allowance. The caller passes the
    // postBondTxHash surfaced on the original failure.
    if (params.resumeFromTxHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.resumeFromTxHash)) {
        throw new ProvianValidationError('resumeFromTxHash must be a 0x-prefixed 32-byte tx hash');
      }
      // The bond RECORD is the whole point of a resume; getBondRequirements only
      // populates cosmetic result fields (discount / requiredPvt), so a transient
      // failure there must NOT block re-POSTing the already-mined tx_hash and
      // re-orphan the collateral. Fall back to defaults and still record.
      let discount = params.trustDiscountBps ?? 0;
      let requiredPvt = 0;
      try {
        const req = await this.getBondRequirements(params.autonomyLevel);
        discount = params.trustDiscountBps ?? req.trust_discount_bps ?? 0;
        requiredPvt = req.required_pvt;
      } catch {
        // Keep the fallbacks; the record re-POST below is what recovers the bond.
      }
      const recorded = await this.postBondRecord(params.autonomyLevel, params.resumeFromTxHash, chain);
      return {
        bondId: recorded.bondId,
        status: recorded.status,
        autonomyLevel: params.autonomyLevel,
        chain,
        trustDiscountBps: discount,
        requiredPvt,
        totalDepositAtomic: '', // not re-derived on a resume (no re-broadcast)
        approveTxHash: '', // not re-broadcast on a resume
        postBondTxHash: params.resumeFromTxHash,
        renewalDeadline: recorded.renewalDeadline,
      };
    }

    // Fail closed BEFORE any broadcast: with waitForApproval:false and no
    // pinned nonce, the postBond nonce could collide with approve on a provider
    // whose canonical count has not yet included the approval, reverting the bond.
    if (params.waitForApproval === false && params.nonce === undefined) {
      throw new ProvianValidationError(
        'waitForApproval:false requires an explicit nonce so postBond can use nonce+1 deterministically (or omit it to await the approve receipt)',
      );
    }

    const requirements = await this.getBondRequirements(params.autonomyLevel);
    const discountBps = params.trustDiscountBps ?? requirements.trust_discount_bps ?? 0;
    // Validate the discount up front with the SAME strict rule as the postBond
    // calldata encoder, so an out-of-range value can never size+broadcast the
    // approve and THEN throw (which would orphan an on-chain allowance).
    if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 5000) {
      throw new ProvianValidationError('trustDiscountBps must be an integer in 0..5000');
    }
    const requiredWei = requiredBondWei(requirements.base_pvt, discountBps);
    const totalDepositWei = grossUpTotalDeposit(requiredWei);

    const evm = {
      rpcUrl: params.rpcUrl,
      transport: params.transport,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      nonce: params.nonce,
      gas: params.gas,
    };

    // 1. approve(BondPool, totalDeposit) on PVT (allowlisted token target).
    const approve = await sendTransaction(wallet, {
      to: pvt,
      data: encodeApprove(bondPool, totalDepositWei),
      chain,
      ...evm,
    });

    // 2. Wait for the approve to confirm AND verify it SUCCEEDED. A reverted
    //    approve sets NO allowance, so broadcasting postBond next would be a
    //    guaranteed transferFrom revert — a second doomed on-chain tx the agent
    //    pays gas for (audit Pass-3 #20). waitForApproval:false opts out of the
    //    wait (the fast pinned-nonce path), accepting that risk explicitly.
    if (params.waitForApproval !== false) {
      const approveStatus = await waitForReceipt({ chain, hash: approve.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
      if (approveStatus === 'reverted') {
        throw new EvmSignerError(
          `bond approve ${approve.hash} reverted on-chain; the BondPool allowance was not set, so postBond was not attempted`,
          'BOND_APPROVE_REVERTED',
        );
      }
    }

    // 3. BondPool.postBond(level, discountBps) (allowlisted contract target).
    const post = await sendTransaction(wallet, {
      to: bondPool,
      data: encodePostBond(params.autonomyLevel, discountBps),
      chain,
      ...evm,
      // postBond follows approve; if the caller pinned a nonce, advance it.
      ...(params.nonce !== undefined ? { nonce: params.nonce + 1 } : {}),
    });

    // 4. Wait for the postBond receipt BEFORE relay verification (audit Pass-3
    //    #6): the relay's verifyEvmBondPosted does a SINGLE receipt fetch, so a
    //    not-yet-mined tx would false-reject as tx_not_found while the collateral
    //    is already locking on-chain. Inspect status too: a reverted postBond
    //    consumed no allowance, leaving a live bounded approval to BondPool that
    //    must be revoked (audit Pass-3 #22).
    const postStatus = await waitForReceipt({ chain, hash: post.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
    if (postStatus === 'reverted') {
      const revokeNote = await this.revokeBondAllowance(wallet, pvt, bondPool, chain, params);
      throw new EvmSignerError(
        `postBond ${post.hash} reverted on-chain; no bond was posted. ${revokeNote}`,
        'BOND_POST_REVERTED',
      );
    }

    // 5. Relay verifies the (now-mined, successful) postBond tx_hash and records
    //    the bond + verified PE. If THIS fails, the bond is already Active
    //    on-chain (collateral locked), so surface the mined tx_hash for a resume
    //    re-POST rather than orphaning it (audit Pass-3 #6).
    let recorded: { bondId: string; status?: string; renewalDeadline?: number };
    try {
      recorded = await this.postBondRecord(params.autonomyLevel, post.hash, chain);
    } catch (err) {
      throw new ProvianNetworkError(
        `postBond mined on-chain (tx ${post.hash}) but the relay record failed: ${(err as Error).message}. ` +
          `The bond collateral is locked on-chain — retry recording with postBond({ ...same params, resumeFromTxHash: '${post.hash}' }); ` +
          `do NOT re-broadcast (it would revert BondAlreadyExists).`,
      );
    }

    return {
      bondId: recorded.bondId,
      status: recorded.status,
      autonomyLevel: params.autonomyLevel,
      chain,
      trustDiscountBps: discountBps,
      requiredPvt: requirements.required_pvt,
      totalDepositAtomic: totalDepositWei.toString(),
      approveTxHash: approve.hash,
      postBondTxHash: post.hash,
      renewalDeadline: recorded.renewalDeadline,
    };
  }

  /**
   * POST a mined postBond tx_hash to /v1/bonds/post and parse the bond record.
   * Shared by the normal postBond path and the resumeFromTxHash recovery path.
   * Strict-checks bond_id so a malformed relay reply surfaces as an error rather
   * than the literal 'undefined'.
   */
  private async postBondRecord(
    autonomyLevel: 2 | 3,
    txHash: string,
    chain: SupportedChain,
  ): Promise<{ bondId: string; status?: string; renewalDeadline?: number }> {
    const response = await requestJSON(this.config, '/v1/bonds/post', {
      method: 'POST',
      body: { autonomy_level: autonomyLevel, tx_hash: txHash, chain },
    });
    const r = response as { bond_id?: string; status?: string; renewal_deadline?: number };
    if (typeof r.bond_id !== 'string' || r.bond_id.length === 0) {
      throw new ProvianNetworkError('bonds/post response missing bond_id');
    }
    return { bondId: r.bond_id, status: r.status, renewalDeadline: r.renewal_deadline };
  }

  /**
   * Best-effort revoke of the BondPool PVT allowance after a FAILED postBond
   * (audit Pass-3 #22). The approve confirmed but postBond reverted, so the
   * grossed-up allowance is still standing (never consumed by transferFrom).
   * Reset it to 0 with a fresh nonce (the approve + postBond already consumed any
   * pinned nonces, so let the node report the next count). Returns a human
   * sentence for the thrown error: either confirmation the allowance was revoked,
   * or a WARNING to revoke it manually if the revoke itself could not be landed.
   */
  private async revokeBondAllowance(
    wallet: EvmWallet,
    pvt: string,
    bondPool: `0x${string}`,
    chain: SupportedChain,
    // Only the broadcast knobs are read — shared by postBond and topUpBond.
    params: BondEvmOpts,
  ): Promise<string> {
    try {
      const revoke = await sendTransaction(wallet, {
        to: pvt,
        data: encodeApprove(bondPool, 0n),
        chain,
        rpcUrl: params.rpcUrl,
        transport: params.transport,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      });
      const revokeStatus = await waitForReceipt({ chain, hash: revoke.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
      if (revokeStatus === 'reverted') {
        return `WARNING: the standing BondPool allowance could NOT be revoked (revoke tx ${revoke.hash} reverted) — revoke it manually (approve BondPool 0 on PVT).`;
      }
      return `The standing BondPool allowance was revoked (approve 0, tx ${revoke.hash}).`;
    } catch (err) {
      return `WARNING: the standing BondPool allowance could NOT be revoked (${(err as Error).message}) — revoke it manually (approve BondPool 0 on PVT).`;
    }
  }

  /**
   * Renew an active bond: a SINGLE on-chain tx (BondPool.renewBond(), no approve
   * - the renewal cost is deducted from the already-locked bond), then the relay
   * record. `bondId` comes from the postBond result or GET /v1/bonds/:agentId.
   */
  async renewBond(wallet: EvmWallet, params: RenewBondParams): Promise<RenewBondResult> {
    if (!params.bondId) {
      throw new ProvianValidationError('bondId is required (from postBond result or GET /v1/bonds/:agentId)');
    }
    const chain: SupportedChain = params.chain ?? 'base';
    const bondPool = bondPoolAddressForChain(chain);

    // Resume path (audit Pass-3 #26): a renewBond that SUCCEEDED on-chain (burn +
    // fee deducted, renewalDeadline advanced) but whose relay record failed leaves
    // the Firestore renewal_deadline stale — processBondRenewals would later flip
    // the bond to 'expired', drop autonomy to Level 1, and emit a misleading
    // bond_abandonment_processed PE despite the bond being on-chain-active. Re-POST
    // the mined renew tx_hash instead of re-broadcasting a second paid renewal.
    if (params.resumeFromTxHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.resumeFromTxHash)) {
        throw new ProvianValidationError('resumeFromTxHash must be a 0x-prefixed 32-byte tx hash');
      }
      await this.renewBondRecord(params.bondId, params.resumeFromTxHash);
      return { bondId: params.bondId, chain, renewTxHash: params.resumeFromTxHash };
    }

    const tx = await sendTransaction(wallet, {
      to: bondPool,
      data: encodeRenewBond(),
      chain,
      rpcUrl: params.rpcUrl,
      transport: params.transport,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      nonce: params.nonce,
      gas: params.gas,
    });

    // Await the renew receipt + check status BEFORE relay verification (audit
    // Pass-3 #26): the relay's verifyEvmBondRenewed does a single receipt fetch,
    // so a not-yet-mined renewal false-rejects as tx_not_found even though the
    // renewal cost is already burned and the deadline advanced on-chain.
    const renewStatus = await waitForReceipt({ chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
    if (renewStatus === 'reverted') {
      throw new EvmSignerError(
        `renewBond ${tx.hash} reverted on-chain; the renewal was not applied`,
        'BOND_RENEW_REVERTED',
      );
    }

    try {
      await this.renewBondRecord(params.bondId, tx.hash);
    } catch (err) {
      throw new ProvianNetworkError(
        `renewBond mined on-chain (tx ${tx.hash}) but the relay record failed: ${(err as Error).message}. ` +
          `The renewal is applied on-chain — retry recording with renewBond({ ...same params, resumeFromTxHash: '${tx.hash}' }).`,
      );
    }

    return { bondId: params.bondId, chain, renewTxHash: tx.hash };
  }

  /** POST a mined renewBond tx_hash to /v1/bonds/renew (shared by the normal and resume paths). */
  private async renewBondRecord(bondId: string, txHash: string): Promise<void> {
    await requestJSON(this.config, '/v1/bonds/renew', {
      method: 'POST',
      body: { bond_id: bondId, tx_hash: txHash },
    });
  }

  /**
   * Top up an active bond's slashable collateral (bond lifecycle shortfall restore): a
   * TWO-tx on-chain sequence (approve exactly `amountAtomic` on PVT — no
   * gross-up, since top-ups carry NO burn and NO fee — then
   * BondPool.topUpBond(amount)), followed by the relay record. The contract
   * bounds the top-up by the level's UNDISCOUNTED base lock
   * (`bond.amount + amount <= getRequiredBond(level, 0)`), so this is a
   * restore-to-requirement path, never an arbitrary buffer. 100% of the
   * transferred PVT becomes slashable collateral, withdrawable only through
   * the normal bond exit lifecycle.
   */
  async topUpBond(wallet: EvmWallet, params: TopUpBondParams): Promise<TopUpBondResult> {
    if (!params.bondId) {
      throw new ProvianValidationError('bondId is required (from postBond result or GET /v1/bonds/:agentId)');
    }
    const chain: SupportedChain = params.chain ?? 'base';
    const bondPool = bondPoolAddressForChain(chain);
    const pvt = getToken(chain, 'PVT').address;

    // Resume path (mirrors renewBond): a topUpBond that SUCCEEDED on-chain but
    // whose relay record failed leaves the collateral increased on-chain with a
    // stale Firestore record. Re-POST the mined tx_hash instead of
    // re-broadcasting a second paid top-up.
    if (params.resumeFromTxHash !== undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.resumeFromTxHash)) {
        throw new ProvianValidationError('resumeFromTxHash must be a 0x-prefixed 32-byte tx hash');
      }
      await this.topUpBondRecord(params.bondId, params.resumeFromTxHash);
      return { bondId: params.bondId, chain, topUpTxHash: params.resumeFromTxHash };
    }

    let amountWei: bigint;
    try {
      amountWei = BigInt(params.amountAtomic);
    } catch {
      throw new ProvianValidationError('amountAtomic must be a base-10 atomic PVT amount (bigint-parsable string)');
    }
    if (amountWei <= 0n) {
      throw new ProvianValidationError('amountAtomic must be positive');
    }

    // Same nonce-safety rule as postBond: two sequential txs on one nonce line.
    if (params.waitForApproval === false && params.nonce === undefined) {
      throw new ProvianValidationError(
        'waitForApproval:false requires an explicit nonce so topUpBond can use nonce+1 deterministically (or omit it to await the approve receipt)',
      );
    }

    const evm = {
      rpcUrl: params.rpcUrl,
      transport: params.transport,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      nonce: params.nonce,
      gas: params.gas,
    };

    // 1. approve(BondPool, amount) on PVT — exact amount, no gross-up.
    const approve = await sendTransaction(wallet, {
      to: pvt,
      data: encodeApprove(bondPool, amountWei),
      chain,
      ...evm,
    });
    if (params.waitForApproval !== false) {
      const approveStatus = await waitForReceipt({ chain, hash: approve.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
      if (approveStatus === 'reverted') {
        throw new EvmSignerError(
          `top-up approve ${approve.hash} reverted on-chain; the BondPool allowance was not set, so topUpBond was not attempted`,
          'BOND_APPROVE_REVERTED',
        );
      }
    }

    // 2. BondPool.topUpBond(amount).
    const topUp = await sendTransaction(wallet, {
      to: bondPool,
      data: encodeTopUpBond(amountWei),
      chain,
      ...evm,
      ...(params.nonce !== undefined ? { nonce: params.nonce + 1 } : {}),
    });

    // 3. Wait for the receipt BEFORE relay verification (single receipt fetch
    //    server-side); a reverted top-up consumed no allowance, so best-effort
    //    revoke the standing approval (same Pass-3 #22 discipline as postBond).
    const topUpStatus = await waitForReceipt({ chain, hash: topUp.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
    if (topUpStatus === 'reverted') {
      const revokeNote = await this.revokeBondAllowance(wallet, pvt, bondPool, chain, params);
      throw new EvmSignerError(
        `topUpBond ${topUp.hash} reverted on-chain; no collateral was added. ${revokeNote}`,
        'BOND_TOPUP_REVERTED',
      );
    }

    // 4. Relay verifies the mined tx and records collateral chain-truth. On
    //    failure the collateral is already locked on-chain — surface the resume.
    try {
      await this.topUpBondRecord(params.bondId, topUp.hash);
    } catch (err) {
      throw new ProvianNetworkError(
        `topUpBond mined on-chain (tx ${topUp.hash}) but the relay record failed: ${(err as Error).message}. ` +
          `The collateral is already locked — retry recording with topUpBond({ ...same params, resumeFromTxHash: '${topUp.hash}' }).`,
      );
    }

    return { bondId: params.bondId, chain, topUpTxHash: topUp.hash };
  }

  /** POST a mined topUpBond tx_hash to /v1/bonds/topup (shared by the normal and resume paths). */
  private async topUpBondRecord(bondId: string, txHash: string): Promise<void> {
    await requestJSON(this.config, '/v1/bonds/topup', {
      method: 'POST',
      body: { bond_id: bondId, tx_hash: txHash },
    });
  }

  // -------------------------------------------------------------------------
  // Escrow release (WS1-SDK) - the DEPOSITOR releases a funded escrow
  // IMMEDIATELY (before autoReleaseAt) with its OWN key, then records it via
  // the existing /v1/escrow/:id/complete endpoint. Mirrors the on-chain-write
  // pattern of postBond/renewBond: sign + broadcast with the slice-1 signer,
  // then a relay call. The contract's releaseEscrow(bytes32) is depositor-only
  // before the auto-release timer (permissionless after); the backend's gas-only
  // EOA handles the post-timeout auto-release, so this method is for the
  // depositor's pre-timeout release. completeEscrow() (the relay-only variant)
  // remains for callers who do not hold the depositor key on-device.
  // -------------------------------------------------------------------------

  /**
   * Release a funded escrow immediately as the DEPOSITOR, signing
   * ProvianEscrow.releaseEscrow(bytes32) with the agent's OWN EOA key and then
   * recording it via the relay. The relay's completeEscrow (POST
   * /v1/escrow/:id/complete) is now on-chain-truthful: it observes the on-chain
   * Completed status before flipping Firestore to 'completed', so no extra body
   * is needed beyond the on-chain release this method performs first.
   *
   *   await institutions.releaseEscrow(wallet, {
   *     escrowId: 'esc_abc',                                  // Firestore id (relay record)
   *     onchainEscrowId: '0x' + '...'.padStart(64, '0'),     // bytes32 used at on-chain createEscrow
   *     currency: 'usdc',                                     // selects which escrow contract
   *     chain: 'base',
   *     rpcUrl: 'https://...',
   *   });
   *
   * `currency: 'pvt'` throws "not configured" until PVT-principal escrows are
   * deployed.
   */
  async releaseEscrow(wallet: EvmWallet, params: ReleaseEscrowParams): Promise<ReleaseEscrowResult> {
    if (typeof params.escrowId !== 'string' || params.escrowId.trim().length === 0) {
      throw new ProvianValidationError('escrowId is required (the esc_* Firestore id, for the relay record call)');
    }
    if (typeof params.onchainEscrowId !== 'string' || !BYTES32_PATTERN.test(params.onchainEscrowId)) {
      throw new ProvianValidationError(
        'onchainEscrowId must be a 0x-prefixed 32-byte hex string (the bytes32 id used at on-chain createEscrow)',
      );
    }
    const chain: SupportedChain = params.chain ?? 'base';
    const currency: EscrowCurrency = params.currency ?? 'usdc';

    // 1. Resolve the escrow contract address for (currency, chain). Throws a
    //    ProvianValidationError if unconfigured (incl. any currency:'pvt' today).
    let escrowAddr: `0x${string}`;
    try {
      escrowAddr = escrowAddressForChain(currency, chain);
    } catch (err) {
      throw new ProvianValidationError((err as Error).message);
    }

    // 2. Encode releaseEscrow(bytes32) calldata.
    const data = encodeReleaseEscrow(params.onchainEscrowId);

    // 3. Broadcast with the depositor's own key. The escrow contract is in
    //    CONTRACT_ALLOWLIST, so the signer's target guard passes without an
    //    opt-out.
    const tx = await sendTransaction(wallet, {
      to: escrowAddr,
      data,
      chain,
      rpcUrl: params.rpcUrl,
      transport: params.transport,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      nonce: params.nonce,
      gas: params.gas,
    });

    // 4. Optionally wait for the release receipt before recording, so the relay
    //    sees the Completed status when it re-checks on-chain. Default on. Inspect
    //    status: a reverted release moved nothing, so recording a completion would
    //    be a false success (audit Pass-3 #8).
    if (params.waitForReceipt !== false) {
      const relStatus = await waitForReceipt({ chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
      if (relStatus === 'reverted') {
        throw new EvmSignerError(
          `escrow release ${tx.hash} reverted on-chain; the escrow was not released`,
          'ESCROW_RELEASE_REVERTED',
        );
      }
    }

    // 5. Record via the EXISTING relay endpoint. completeEscrow observes the
    //    on-chain Completed status and records the completion - no new endpoint,
    //    no extra body.
    await requestJSON(
      this.config,
      `/v1/escrow/${encodeURIComponent(params.escrowId)}/complete`,
      { method: 'POST', body: {} },
    );

    return { escrowId: params.escrowId, chain, releaseTxHash: tx.hash };
  }

  // -------------------------------------------------------------------------
  // Pool withdrawal (P4-01-SDK) - the CONTRIBUTOR withdraws its contribution
  // from an Open pool with its OWN key, then records it via
  // POST /v1/pools/:id/withdraw. The contract's withdrawContribution(bytes32) is
  // msg.sender-bound (no keeper can do it for a contributor), so this is the
  // agent-signed half; the relay VERIFIES the on-chain PoolWithdrawal event before
  // deleting the Firestore contribution / emitting the pool_withdrawn PE. Mirrors
  // the on-chain-write pattern of releaseEscrow/postBond: sign + broadcast, then
  // a relay record.
  // -------------------------------------------------------------------------

  /**
   * Withdraw a contribution from an Open pool as the CONTRIBUTOR, signing
   * ProvianPool.withdrawContribution(bytes32) with the agent's OWN EOA key and then
   * recording it via the relay. The relay's /v1/pools/:id/withdraw endpoint verifies
   * the on-chain withdrawal (PoolWithdrawal event, contributor + amount) before
   * mutating Firestore, so passing the mined tx_hash is required.
   *
   *   await institutions.withdrawFromPool(wallet, {
   *     poolId: 'pool_abc',                                  // Firestore id (relay record)
   *     onchainPoolId: '0x' + '...'.padStart(64, '0'),       // bytes32 used at on-chain createPool
   *     chain: 'base',
   *     rpcUrl: 'https://...',
   *   });
   */
  async withdrawFromPool(wallet: EvmWallet, params: WithdrawFromPoolParams): Promise<WithdrawFromPoolResult> {
    if (typeof params.poolId !== 'string' || params.poolId.trim().length === 0) {
      throw new ProvianValidationError('poolId is required (the pool_* Firestore id, for the relay record call)');
    }
    if (typeof params.onchainPoolId !== 'string' || !BYTES32_PATTERN.test(params.onchainPoolId)) {
      throw new ProvianValidationError(
        'onchainPoolId must be a 0x-prefixed 32-byte hex string (the bytes32 id used at on-chain createPool)',
      );
    }
    const chain: SupportedChain = params.chain ?? 'base';

    // 1. Resolve the pool contract address for the chain. Throws a
    //    ProvianValidationError if unconfigured (Arbitrum/Optimism today).
    let poolAddr: `0x${string}`;
    try {
      poolAddr = poolAddressForChain(chain);
    } catch (err) {
      throw new ProvianValidationError((err as Error).message);
    }

    // 2. Encode withdrawContribution(bytes32) calldata.
    const data = encodeWithdrawContribution(params.onchainPoolId);

    // 3. Broadcast with the contributor's own key. The pool contract is in
    //    CONTRACT_ALLOWLIST, so the signer's target guard passes without an opt-out.
    const tx = await sendTransaction(wallet, {
      to: poolAddr,
      data,
      chain,
      rpcUrl: params.rpcUrl,
      transport: params.transport,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      nonce: params.nonce,
      gas: params.gas,
    });

    // 4. Wait for the withdrawal receipt before recording (default on) so the relay
    //    sees the PoolWithdrawal event when it verifies. A reverted withdrawal moved
    //    nothing, so recording it would be a false success — fail closed.
    if (params.waitForReceipt !== false) {
      const wStatus = await waitForReceipt({ chain, hash: tx.hash as `0x${string}`, transport: params.transport, rpcUrl: params.rpcUrl });
      if (wStatus === 'reverted') {
        throw new EvmSignerError(
          `pool withdrawal ${tx.hash} reverted on-chain; the contribution was not withdrawn`,
          'POOL_WITHDRAW_REVERTED',
        );
      }
    }

    // 5. Record via the relay endpoint. withdrawContribution verifies the on-chain
    //    PoolWithdrawal before deleting the Firestore contribution + emitting the
    //    pool_withdrawn PE.
    await requestJSON(
      this.config,
      `/v1/pools/${encodeURIComponent(params.poolId)}/withdraw`,
      { method: 'POST', body: { tx_hash: tx.hash } },
    );

    return { poolId: params.poolId, chain, withdrawTxHash: tx.hash };
  }
}

/** On-chain broadcast knobs shared by the bond methods (forwarded to the signer). */
interface BondEvmOpts {
  /** JSON-RPC URL for the chain. Required unless `transport` is supplied. */
  rpcUrl?: string;
  /** Pre-built viem transport (tests inject a mock; overrides rpcUrl). */
  transport?: Transport;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  gas?: bigint;
}

export interface PostBondParams extends BondEvmOpts {
  autonomyLevel: 2 | 3;
  /** Base only this slice. */
  chain?: SupportedChain;
  /** Override the discount (else the relay requirement, else 0 = full bond). */
  trustDiscountBps?: number;
  /** Wait for the approve receipt before postBond (default true). */
  waitForApproval?: boolean;
  /**
   * Recovery re-POST of a postBond that MINED on-chain but whose relay record
   * failed (audit Pass-3 #6). When set (the postBondTxHash surfaced on the
   * original failure), NO on-chain tx is broadcast — the mined tx_hash is
   * re-submitted to /v1/bonds/post to record the already-locked bond. Never
   * re-broadcast a bond that is already Active on-chain (it reverts
   * BondAlreadyExists).
   */
  resumeFromTxHash?: string;
}

export interface PostBondResult {
  bondId: string;
  status?: string;
  autonomyLevel: 2 | 3;
  chain: SupportedChain;
  trustDiscountBps: number;
  requiredPvt: number;
  totalDepositAtomic: string;
  approveTxHash: string;
  postBondTxHash: string;
  renewalDeadline?: number;
}

export interface RenewBondParams extends BondEvmOpts {
  bondId: string;
  chain?: SupportedChain;
  /**
   * Recovery re-POST of a renewBond that SUCCEEDED on-chain but whose relay
   * record failed (audit Pass-3 #26). When set, NO on-chain tx is broadcast —
   * the mined renew tx_hash is re-submitted to /v1/bonds/renew so the stale
   * Firestore deadline is refreshed (avoiding a false abandonment).
   */
  resumeFromTxHash?: string;
}

export interface RenewBondResult {
  bondId: string;
  chain: SupportedChain;
  renewTxHash: string;
}

/** bond lifecycle — shortfall-restore top-up (approve exact amount, then topUpBond). */
export interface TopUpBondParams extends BondEvmOpts {
  bondId: string;
  /**
   * Atomic PVT (1e18) to add as slashable collateral, as a base-10 string.
   * The contract bounds it by the level's undiscounted base lock
   * (restore-to-requirement, never an arbitrary buffer); no burn, no fee.
   */
  amountAtomic: string;
  chain?: SupportedChain;
  /**
   * Same two-tx nonce discipline as postBond: false requires an explicit
   * `nonce` so topUpBond can use nonce+1 deterministically.
   */
  waitForApproval?: boolean;
  /**
   * Recovery re-POST of a topUpBond that SUCCEEDED on-chain but whose relay
   * record failed. When set, NO on-chain tx is broadcast — the mined top-up
   * tx_hash is re-submitted to /v1/bonds/topup.
   */
  resumeFromTxHash?: string;
}

export interface TopUpBondResult {
  bondId: string;
  chain: SupportedChain;
  topUpTxHash: string;
}

// ---------------------------------------------------------------------------
// Escrow release (WS1-SDK) - depositor-side immediate release params/result.
// Same EVM broadcast knobs as the bond methods, plus a waitForReceipt opt-out.
// ---------------------------------------------------------------------------

export interface ReleaseEscrowParams extends BondEvmOpts {
  /** The Firestore escrow id (esc_*), used for the relay record call. */
  escrowId: string;
  /** The bytes32 id the depositor used at on-chain createEscrow (0x + 64 hex). */
  onchainEscrowId: string;
  /** Base only is configured today; defaults to 'base'. */
  chain?: SupportedChain;
  /** Selects which escrow contract address. Defaults to 'usdc'. */
  currency?: EscrowCurrency;
  /**
   * Wait for the on-chain release receipt before recording with the relay
   * (default true), so completeEscrow's on-chain re-check sees the Completed
   * status. Set false to skip the wait (the relay may then 4xx until the tx
   * mines).
   */
  waitForReceipt?: boolean;
}

export interface ReleaseEscrowResult {
  escrowId: string;
  chain: SupportedChain;
  /** 0x-prefixed hash of the on-chain releaseEscrow(bytes32) tx. */
  releaseTxHash: string;
}

// ---------------------------------------------------------------------------
// Pool withdrawal (P4-01-SDK) - contributor-side withdrawal params/result.
// Same EVM broadcast knobs as the bond/escrow methods, plus a waitForReceipt opt-out.
// ---------------------------------------------------------------------------

export interface WithdrawFromPoolParams extends BondEvmOpts {
  /** The Firestore pool id (pool_*), used for the relay record call. */
  poolId: string;
  /** The bytes32 id the creator used at on-chain createPool (0x + 64 hex). */
  onchainPoolId: string;
  /** Base only is configured today; defaults to 'base'. */
  chain?: SupportedChain;
  /**
   * Wait for the on-chain withdrawal receipt before recording with the relay
   * (default true), so the relay's on-chain verification sees the PoolWithdrawal
   * event. Set false to skip the wait (the relay may then 4xx until the tx mines).
   */
  waitForReceipt?: boolean;
}

export interface WithdrawFromPoolResult {
  poolId: string;
  chain: SupportedChain;
  /** 0x-prefixed hash of the on-chain withdrawContribution(bytes32) tx. */
  withdrawTxHash: string;
}

// ---------------------------------------------------------------------------
// Agent-owned device invite (email-only flow)
// ---------------------------------------------------------------------------

/**
 * Request for CommonsInstitutions.inviteDevice -> POST
 * /v1/agent/wallet/:wallet_id/device-invite. The relay mints a one-time token
 * and emails the recipient a single `register-device --agent-token <token>`
 * line. The token authorizes DEVICE REGISTRATION ONLY and is never returned
 * over the wire.
 */
export interface InviteDeviceRequest {
  /** Email locale: en/es/fr/hi/id/ja/ko/pt/sw/tl/vi/zh; absent or unsupported means English. */
  language?: string;
  /** Destination email for the one-time setup link (required). */
  email: string;
  /** Suggested device name carried into the email body (optional). */
  deviceName?: string;
  /** Free-text note carried into the email body (optional). */
  message?: string;
}

/**
 * Response from POST /v1/agent/wallet/:wallet_id/device-invite. By contract the
 * endpoint returns ONLY { sent, expires_at } - never the minted token.
 */
export interface InviteDeviceResult {
  sent: boolean;
  /** Epoch-ms expiry of the one-time token (now + 1h on the relay). */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Request validation (well-formedness only - backend is authoritative on policy)
// ---------------------------------------------------------------------------

/**
 * One-line email regex + RFC-5321 length cap, mirrored from the relay so a bad
 * address fails fast before the network round trip.
 */
const EMAIL_ADDRESS_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

function validateEscrowRequest(req: CreateEscrowRequest): void {
  if (!req.recipient_wallet_id) {
    throw new ProvianValidationError('recipient_wallet_id is required');
  }
  if (!req.description || req.description.trim().length === 0) {
    throw new ProvianValidationError('description is required');
  }
  if (!req.deliverables || req.deliverables.trim().length === 0) {
    throw new ProvianValidationError('deliverables is required');
  }
  if (typeof req.deadline_hours !== 'number' || req.deadline_hours <= 0) {
    throw new ProvianValidationError('deadline_hours must be a positive number');
  }
  if (req.auto_release_hours !== undefined && (typeof req.auto_release_hours !== 'number' || req.auto_release_hours <= 0)) {
    throw new ProvianValidationError('auto_release_hours must be a positive number');
  }
  if (req.currency === 'pvt') {
    assertPvtChainAllowed(req.chain);
    assertPvtWei(req.amount_pvt, 'amount_pvt');
  } else if (req.currency === 'usdc') {
    assertUsdc(req.amount_usdc, 'amount_usdc');
  } else {
    throw new ProvianValidationError(
      `currency must be 'pvt' or 'usdc', got: ${String((req as { currency: unknown }).currency)}`,
    );
  }
}

function validatePromiseRequest(req: CreatePromiseRequest): void {
  if (!req.purpose || req.purpose.trim().length === 0) {
    throw new ProvianValidationError('purpose is required');
  }
  if (typeof req.deadline_hours !== 'number' || req.deadline_hours <= 0) {
    throw new ProvianValidationError('deadline_hours must be a positive number');
  }
  if (req.currency === 'pvt') {
    assertPvtChainAllowed(req.chain);
    assertPvtWei(req.principal_pvt, 'principal_pvt');
    assertPvtWei(req.repay_pvt, 'repay_pvt');
    if (BigInt(req.repay_pvt) < BigInt(req.principal_pvt)) {
      throw new ProvianValidationError('repay_pvt must be ≥ principal_pvt');
    }
  } else if (req.currency === 'usdc') {
    assertUsdc(req.principal_usdc, 'principal_usdc');
    assertUsdc(req.repay_usdc, 'repay_usdc');
    if (req.repay_usdc < req.principal_usdc) {
      throw new ProvianValidationError('repay_usdc must be ≥ principal_usdc');
    }
  } else {
    throw new ProvianValidationError(
      `currency must be 'pvt' or 'usdc', got: ${String((req as { currency: unknown }).currency)}`,
    );
  }
}

function validatePoolRequest(req: CreatePoolRequest): void {
  if (!req.target_address) {
    throw new ProvianValidationError('target_address is required');
  }
  if (!req.target_description) {
    throw new ProvianValidationError('target_description is required');
  }
  if (typeof req.deadline_hours !== 'number' || req.deadline_hours <= 0) {
    throw new ProvianValidationError('deadline_hours must be a positive number');
  }
  if (typeof req.max_contributors !== 'number' || req.max_contributors <= 0) {
    throw new ProvianValidationError('max_contributors must be a positive number');
  }
  if (req.currency === 'pvt') {
    assertPvtChainAllowed(req.chain);
    assertPvtWei(req.threshold_pvt, 'threshold_pvt');
  } else if (req.currency === 'usdc') {
    assertUsdc(req.threshold_usdc, 'threshold_usdc');
  } else {
    throw new ProvianValidationError(
      `currency must be 'pvt' or 'usdc', got: ${String((req as { currency: unknown }).currency)}`,
    );
  }
}

function assertPaging(pageSize: number | undefined, offset: number | undefined): void {
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
    throw new ProvianValidationError('page_size must be a positive integer');
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new ProvianValidationError('offset must be a non-negative integer');
  }
}

function normalizeJobsPage(response: Record<string, unknown>): CommonsJobsPage {
  const jobs = Array.isArray(response.jobs) ? (response.jobs as HumanJobResponse[]) : [];
  const featured = Array.isArray(response.featured) ? (response.featured as FeaturedPlacement[]) : [];
  const total = typeof response.total === 'number' ? response.total : jobs.length;
  return { ...response, jobs, total, featured };
}

/**
 * A relay 400 carrying `insufficient_confirmations` (or a not-yet-visible tx) while its
 * provider catches up to the agent's RPC — a lag, not a failed funding. Everything else
 * (wrong amount, wrong recipient, wrong sender) is final and surfaces immediately.
 */
function isTransientChainLag(err: unknown): boolean {
  return err instanceof ProvianNetworkError && err.httpStatus === 400
    && /insufficient_confirmations|tx_not_found|receipt_not_found/i.test(err.message);
}

function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The escrow's chain as an SDK chain, refusing anything the SDK does not pin. */
function commonsEscrowChain(escrow: CommonsJobEscrow): SupportedChain {
  const chain = escrow.chain;
  if (chain !== 'base' && chain !== 'arbitrum' && chain !== 'optimism') {
    throw new ProvianValidationError(`the job's escrow names an unsupported chain '${String(chain)}'`);
  }
  return chain;
}

/**
 * Resolve the SDK-PINNED escrow contract for the relay's escrow and refuse unless the
 * relay named exactly that contract. The address the agent signs for is always the SDK's
 * own pin — the relay's `contract_address` is only ever compared, never trusted.
 */
function pinnedCommonsEscrow(escrow: CommonsJobEscrow): { chain: SupportedChain; currency: HumanJobCurrency; escrowAddress: `0x${string}` } {
  const currency = escrow.currency;
  if (currency !== 'pvt' && currency !== 'usdc') {
    throw new ProvianValidationError(`the job's escrow names an unsupported currency '${String(currency)}'`);
  }
  const chain = commonsEscrowChain(escrow);
  let escrowAddress: `0x${string}`;
  try {
    escrowAddress = escrowAddressForChain(currency, chain);
  } catch (err) {
    throw new ProvianValidationError((err as Error).message);
  }
  if (!sameAddress(escrow.contract_address, escrowAddress)) {
    throw new ProvianValidationError(
      `the relay named escrow contract ${String(escrow.contract_address)} but the SDK pins ${escrowAddress} for ${currency} on ${chain}; refusing to sign`,
    );
  }
  return { chain, currency, escrowAddress };
}

/** Everything fundCommonsJob signs, validated BEFORE any broadcast (exported for tests via CommonsInstitutions). */
function planCommonsJobFunding(
  escrow: CommonsJobEscrow,
  wallet: EvmWallet,
  params: FundCommonsJobParams,
): {
  chain: SupportedChain;
  currency: HumanJobCurrency;
  escrowAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  recipient: string;
  amountAtomic: bigint;
  autoReleaseAtSec: bigint;
} {
  const { chain, currency, escrowAddress } = pinnedCommonsEscrow(escrow);
  if (params.expectedCurrency !== undefined && params.expectedCurrency !== currency) {
    throw new ProvianValidationError(`the job's escrow is in ${currency}, not the expected ${params.expectedCurrency}; refusing to fund`);
  }
  const token = getToken(chain, currency === 'pvt' ? 'PVT' : 'USDC');
  if (!sameAddress(escrow.token_address, token.address)) {
    throw new ProvianValidationError(
      `the relay named token ${String(escrow.token_address)} for a ${currency} escrow but the SDK pins ${token.address}; refusing to approve`,
    );
  }
  let amountAtomic: bigint;
  if (currency === 'pvt') {
    if (escrow.amount_usdc !== undefined && escrow.amount_usdc !== null) {
      throw new ProvianValidationError('a PVT escrow must not carry amount_usdc (currency/amount mismatch); refusing to fund');
    }
    if (typeof escrow.amount_pvt !== 'string' || !PVT_WEI_PATTERN.test(escrow.amount_pvt)) {
      throw new ProvianValidationError('a PVT escrow must carry amount_pvt as an 18-decimal atomic integer string; refusing to fund');
    }
    amountAtomic = BigInt(escrow.amount_pvt);
  } else {
    if (escrow.amount_pvt !== undefined && escrow.amount_pvt !== null) {
      throw new ProvianValidationError('a USDC escrow must not carry amount_pvt (currency/amount mismatch); refusing to fund');
    }
    if (typeof escrow.amount_usdc !== 'number' || !Number.isFinite(escrow.amount_usdc)) {
      throw new ProvianValidationError('a USDC escrow must carry amount_usdc as a USD number; refusing to fund');
    }
    amountAtomic = usdcToAtomic(escrow.amount_usdc);
  }
  if (amountAtomic <= 0n) {
    throw new ProvianValidationError('the escrow amount must be greater than zero; refusing to fund');
  }
  if (params.expectedAmountAtomic !== undefined) {
    const expected = typeof params.expectedAmountAtomic === 'bigint' ? params.expectedAmountAtomic : BigInt(String(params.expectedAmountAtomic));
    if (expected !== amountAtomic) {
      throw new ProvianValidationError(`the job's escrow amount ${amountAtomic} (atomic) is not the expected ${expected}; refusing to fund`);
    }
  }
  if (!sameAddress(escrow.depositor_address, wallet.address)) {
    throw new ProvianValidationError(
      `this wallet (${wallet.address}) is not the escrow depositor on record (${String(escrow.depositor_address)}); ` +
        'a funding from any other address would not verify — fund from the wallet that posted the job',
    );
  }
  if (typeof escrow.recipient_address !== 'string' || !isAddress(escrow.recipient_address, { strict: false })) {
    throw new ProvianValidationError('the escrow recipient_address is missing or invalid; refusing to fund');
  }
  if (typeof escrow.auto_release_at !== 'number' || !Number.isFinite(escrow.auto_release_at) || escrow.auto_release_at <= 0) {
    throw new ProvianValidationError('the escrow auto_release_at is missing or invalid; refusing to fund');
  }
  // floor(ms/1000)*1000 <= ms, so the on-chain autoReleaseAt never exceeds the agreed deadline.
  const autoReleaseAtSec = BigInt(Math.floor(escrow.auto_release_at / 1000));
  return {
    chain, currency, escrowAddress, tokenAddress: getAddress(token.address),
    recipient: getAddress(escrow.recipient_address), amountAtomic, autoReleaseAtSec,
  };
}

/** The pinned escrow + on-chain id a release / dispute / refund signs against. */
function resolveCommonsEscrowTarget(
  escrow: CommonsJobEscrow,
  wallet: EvmWallet,
  opts: { requireDepositor: boolean; action: string },
): { chain: SupportedChain; escrowAddress: `0x${string}`; onchainEscrowId: string } {
  const { chain, escrowAddress } = pinnedCommonsEscrow(escrow);
  const onchainEscrowId = escrow.onchain_escrow_id;
  if (typeof onchainEscrowId !== 'string' || !BYTES32_PATTERN.test(onchainEscrowId)) {
    throw new ProvianValidationError(
      `the job's escrow has no on-chain escrow id yet (it is not funded), so there is nothing to ${opts.action}`,
    );
  }
  if (opts.requireDepositor && !sameAddress(escrow.depositor_address, wallet.address)) {
    throw new ProvianValidationError(
      `only the escrow depositor (${String(escrow.depositor_address)}) can ${opts.action} this escrow; this wallet is ${wallet.address}`,
    );
  }
  return { chain, escrowAddress, onchainEscrowId };
}

function validateJobRequest(req: PostJobRequest): void {
  if (!req.title || req.title.trim().length === 0) {
    throw new ProvianValidationError('title is required');
  }
  if (!req.description || req.description.trim().length === 0) {
    throw new ProvianValidationError('description is required');
  }
  if (!Array.isArray(req.required_capabilities) || req.required_capabilities.length === 0) {
    throw new ProvianValidationError('required_capabilities must be a non-empty array');
  }
  if (typeof req.deadline_hours !== 'number' || req.deadline_hours <= 0) {
    throw new ProvianValidationError('deadline_hours must be a positive number');
  }
  if (req.currency === 'pvt') {
    assertPvtWei(req.budget_pvt, 'budget_pvt');
  } else if (req.currency === 'usdc') {
    assertUsdc(req.budget_usdc, 'budget_usdc');
  } else {
    throw new ProvianValidationError(
      `currency must be 'pvt' or 'usdc', got: ${String((req as { currency: unknown }).currency)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// On-demand payout types
// ---------------------------------------------------------------------------

/** $1 in USDC atomic units: the payout fee, and the x402 ceiling a payout fetch is built with. */
export const PAYOUT_FEE_USDC_ATOMIC = 1_000_000n;

/**
 * How long the paid payout request may take. The relay answers once the fee is charged and
 * runs the settlement after (its sweep), so this only has to cover the charge's Base receipt; the
 * default 30 s x402 deadline gave up on a charge that landed.
 */
export const PAYOUT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The relay's id for the payout request a signed x402 payment opens, derived as the relay
 * derives it (`payoutRequestId` the first 40 hex of sha256 over `provian.payout.v1|from|nonce`,
 * lower-cased), so a paid request whose answer was lost can still be read back. Null when the value
 * is not an x402 v2 payment carrying an EIP-3009 authorization.
 */
export function payoutRequestIdOfPayment(paymentHeader: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as { payload?: { authorization?: { from?: unknown; nonce?: unknown } } } | null;
    const from = parsed?.payload?.authorization?.from;
    const nonce = parsed?.payload?.authorization?.nonce;
    if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(from)) return null;
    if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
    return `po_${sha256(stringToBytes(`provian.payout.v1|${from.toLowerCase()}|${nonce.toLowerCase()}`)).slice(2, 42)}`;
  } catch {
    return null;
  }
}

/** $5 in USDC atomic units: one GB of PE Archive space, and the x402 ceiling an Archive fetch is built with. */
export const ARCHIVE_GB_FEE_USDC_ATOMIC = 5_000_000n;

/** Provian's revenue wallet: the only recipient of the payout fee and the PE Archive GB (the relay's PROVIAN_TREASURY). */
export const PROVIAN_SERVICE_FEE_RECIPIENT = '0x086e0F377af1245B8888540f39e99A42a7daF1dA';

/** Both service fees are paid on Base mainnet. */
export const PROVIAN_SERVICE_FEE_NETWORK = 'eip155:8453';

/**
 * The pinned money terms of one Provian service fee, for `wrapFetchWithX402({ pinnedPayment })`: the
 * agent signs only `amountAtomic` USDC to Provian's revenue wallet on Base, whatever the 402 says.
 */
export function provianServiceFeePin(amountAtomic: bigint): { network: string; payTo: string; amountAtomic: bigint } {
  return { network: PROVIAN_SERVICE_FEE_NETWORK, payTo: PROVIAN_SERVICE_FEE_RECIPIENT, amountAtomic };
}

export interface ArchiveView {
  readonly on: boolean;
  readonly paidBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly gbPurchased: number;
  readonly spaceExhausted: boolean;
  readonly nextGbPurchasable: boolean;
  readonly note: string | null;
}

export interface ArchiveStatusView {
  readonly wallet: string;
  readonly archive: ArchiveView;
  readonly recipients: readonly { readonly partyId: string; readonly role: string }[];
}

export type ArchiveQuote =
  | { readonly available: true; readonly feeUsdc: '5.00'; readonly archive: ArchiveView }
  | { readonly available: false; readonly reason: string; readonly message: string | null };

export interface ArchivePaymentView {
  readonly requestId: string;
  readonly state: string;
  readonly credited: boolean;
  readonly chargeTxHash: string | null;
  readonly note: string | null;
  readonly archive: ArchiveView | null;
}

function archiveViewOf(raw: unknown): ArchiveView {
  const a = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    on: a.on === true,
    paidBytes: num(a.paid_bytes),
    usedBytes: num(a.used_bytes),
    freeBytes: num(a.free_bytes),
    gbPurchased: num(a.gb_purchased),
    spaceExhausted: a.space_exhausted === true,
    nextGbPurchasable: a.next_gb_purchasable === true,
    note: typeof a.note === 'string' ? a.note : null,
  };
}

function archiveStatusOf(body: Record<string, unknown>): ArchiveStatusView {
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => ({ partyId: String(r.party_id ?? ''), role: String(r.role ?? '') }))
    : [];
  return { wallet: String(body.wallet ?? ''), archive: archiveViewOf(body.archive), recipients };
}

function archivePaymentOf(body: Record<string, unknown>): ArchivePaymentView {
  return {
    requestId: String(body.request_id ?? ''),
    state: String(body.state ?? 'unknown'),
    credited: body.credited === true,
    chargeTxHash: typeof body.charge_tx_hash === 'string' ? body.charge_tx_hash : null,
    note: typeof body.note === 'string' ? body.note : null,
    archive: body.archive !== undefined ? archiveViewOf(body.archive) : null,
  };
}

export type PayoutQuote =
  | {
    readonly available: true;
    readonly feeUsdc: '1.00';
    readonly readyClaims: number | null;
    readonly readyRecordPointsAtomic: string | null;
    readonly estimatedGasUsd: number | null;
  }
  | { readonly available: false; readonly reason: string; readonly message: string | null };

export interface PayoutStatus {
  readonly requestId: string;
  readonly state: string;
  readonly chargeTxHash: string | null;
  readonly waitingReason: string | null;
  readonly settlement: Record<string, unknown> | null;
  readonly note: string | null;
}

async function payoutQuoteOf(response: Response): Promise<PayoutQuote> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 402) {
    const ready = (body.ready ?? null) as { claims?: unknown; record_points_atomic?: unknown } | null;
    return {
      available: true,
      feeUsdc: '1.00',
      readyClaims: typeof ready?.claims === 'number' ? ready.claims : null,
      readyRecordPointsAtomic: typeof ready?.record_points_atomic === 'string' ? ready.record_points_atomic : null,
      estimatedGasUsd: typeof body.estimated_gas_usd === 'number' ? body.estimated_gas_usd : null,
    };
  }
  if (response.status === 401 || response.status === 403) throw new ProvianAuthError();
  return {
    available: false,
    reason: typeof body.error === 'string' ? body.error : `http_${response.status}`,
    message: typeof body.message === 'string' ? body.message : null,
  };
}

function payoutStatusOf(body: Record<string, unknown>): PayoutStatus {
  return {
    requestId: String(body.request_id ?? ''),
    state: String(body.state ?? 'unknown'),
    chargeTxHash: typeof body.charge_tx_hash === 'string' ? body.charge_tx_hash : null,
    waitingReason: typeof body.waiting_reason === 'string' ? body.waiting_reason : null,
    settlement: body.settlement !== null && typeof body.settlement === 'object' ? body.settlement as Record<string, unknown> : null,
    note: typeof body.note === 'string' ? body.note : null,
  };
}

export interface ThreadPlaintextView {
  text: string | null;
  provian_output_signature: OutputSignature | null;
}

export function threadPlaintextView(plaintext: string | null): ThreadPlaintextView {
  if (plaintext === null) return { text: null, provian_output_signature: null };
  const { text, signature } = splitThreadOutputSignature(plaintext);
  return { text, provian_output_signature: signature };
}
