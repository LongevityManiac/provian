import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * HumanJobEscrowFunder — the poster's on-chain escrow-funding sequence, in PVT or USDC.
 *
 * : a person who posts a Commons job and accepts an applicant
 * funds the escrow with their OWN key, non-custodially. the Commons board hires in PVT or
 * USDC, so the same three-transaction sequence runs for either currency against ProvianEscrowV4:
 *
 * 1. createEscrow(escrowId, recipient, amount, autoReleaseAt, currency) (USDC = 0, PVT = 1)
 * 2. TOKEN.approve(escrowContract, amount) (USDC 6 decimals, PVT 18)
 * 3. fundEscrow(escrowId, false) ← the tx hash submitted to the relay
 *
 * The relay's `verifyFunding` binds these EXACTLY: the funding tx must transfer `amount` of the
 * escrow's token FROM the depositor INTO the escrow contract, and the on-chain struct must pay OUR
 * `recipient` with an `autoReleaseAt <= auto_release_at`. So this builder uses the server-provided
 * recipient / amount / auto_release_at / token VERBATIM — it never invents a value.
 *
 * ONE on-chain escrow per hire (live finding): the id is DERIVED from the depositor, the
 * relay escrow id, and a salt only the depositor's key can produce (`deriveHireOnchainEscrowId`),
 * so a second tap — on this phone or a restored one — finds the escrow the first tap created and
 * RESUMES it from on-chain state, while nobody else can predict the id and squat it (createEscrow
 * is permissionless and the relay escrow id + poster address are public) — create is skipped
 * once the escrow exists, approve once the allowance covers the amount, and an escrow that is
 * already funded returns its funding tx instead of paying twice. It used to be a fresh random id
 * per tap, so a retry created a second escrow. A send whose gas ESTIMATE is refused (the node has
 * not yet seen the approve that just landed — the live failure) broadcast nothing and is retried;
 * any other send failure stops.
 *
 * Non-custodial: the key is the poster's own BIP-44 secp256k1 key from SeedManager, used exactly
 * as first-party Send does. One biometric session covers the sequence, after an on-screen review.
 */

import { ethers } from 'ethers';
import { assertWalletEnabled } from '../AppModeManager';
import SeedManager from './SeedManager';
import TransactionService from './TransactionService';
import { HIRE_ESCROW_SALT_MESSAGE } from './hireEscrowSaltMessage';
import { JOB_ESCROW_V4, PVT9_TOKEN, TOKEN_ADDRESSES } from '../chains/evm/config';
import { translate } from '../../i18n/translate';

/** ProvianEscrowV4 `Currency` enum: USDC = 0, PVT = 1. */
export const ESCROW_CURRENCY_USDC = 0;
export const ESCROW_CURRENCY_PVT = 1;

/** Token decimals per escrow currency (USDC 6, PVT 18). */
export const ESCROW_TOKEN_DECIMALS: Record<'usdc' | 'pvt', number> = { usdc: 6, pvt: 18 };

/** The minimal ABI fragments the poster's fund sequence needs. */
const ESCROW_V4_ABI = [
  'function createEscrow(bytes32 escrowId, address recipient, uint256 amount, uint256 autoReleaseAt, uint8 currencyType)',
  'function fundEscrow(bytes32 escrowId, bool payFeeInPVT)',
] as const;
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'] as const;
const ESCROW_READ_ABI = [
  'function escrows(bytes32 escrowId) view returns (address depositor, address recipient, uint256 amount, uint256 fee, uint256 autoReleaseAt, uint8 status, uint8 currency, bool feePaidInPVT)',
  'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
  'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
] as const;
const ERC20_ALLOWANCE_ABI = ['function allowance(address owner, address spender) view returns (uint256)'] as const;

/** ProvianEscrowV4 `Status`: Created = 0, Cancelled = 5 (Funded/Completed/Disputed/Resolved between). */
const ONCHAIN_STATUS_CREATED = 0;
const ONCHAIN_STATUS_CANCELLED = 5;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Estimate-refusal retries: the node lagging the approve clears within seconds. */
export const FUND_SEND_ATTEMPTS = 6;
export const FUND_SEND_RETRY_DELAY_MS = 5000;

/** The fixed message the depositor signs to salt its hire escrow ids (never sent anywhere). */
export { HIRE_ESCROW_SALT_MESSAGE };

/**
 * The depositor's private salt: keccak256 of its (deterministic, RFC 6979) signature over a fixed
 * message. Only the key holder can produce it; the same seed always produces the same salt, so a
 * restored wallet resumes the same escrow.
 */
export function hireEscrowSalt(signMessageSync: (message: string) => string): string {
  return ethers.keccak256(signMessageSync(HIRE_ESCROW_SALT_MESSAGE));
}

/**
 * The one on-chain escrow id for a hire — keccak256(abi.encode("provian.commons.hire-escrow.v2",
 * depositor, relayEscrowId, salt)). The salt makes it unpredictable to anyone but the depositor, so
 * a third party cannot pre-create an escrow at the id (createEscrow is permissionless) and block
 * the hire. (The SDK's agent-side `deriveHireOnchainEscrowId` is the unsalted v1 form; a person's
 * hire is only ever funded from the app, so the two never need to agree.)
 */
export function deriveHireOnchainEscrowId(depositor: string, relayEscrowId: string, salt: string): string {
  if (typeof relayEscrowId !== 'string' || relayEscrowId.length === 0) {
    throw new Error('relay escrow id is required to derive the on-chain escrow id');
  }
  if (!ethers.isHexString(salt, 32)) {
    throw new Error('the escrow id salt must be 32 bytes');
  }
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'address', 'string', 'bytes32'],
    ['provian.commons.hire-escrow.v2', ethers.getAddress(depositor), relayEscrowId, salt],
  ));
}

/** Why funding stopped. The screen shows the message; every code is resumable by tapping Fund again unless noted. */
export type EscrowFundingErrorCode =
  | 'escrow_id_conflict'   // the derived id holds an escrow with other terms — not resumable
  | 'escrow_cancelled'     // the escrow was cancelled on-chain — not resumable
  | 'funded_unrecorded'    // funded on-chain but the funding tx was not found
  | 'unconfirmed'          // broadcast, receipt not observed — resumable
  | 'reverted'             // mined and reverted — resumable after the cause clears
  | 'send_failed';         // refused before broadcast (not an estimate lag) — resumable

export class EscrowFundingError extends Error {
  constructor(readonly code: EscrowFundingErrorCode, message: string, readonly txHash?: string) {
    super(message);
    this.name = 'EscrowFundingError';
  }
}

/** The on-chain escrow the plan would create, as the contract reports it. */
export interface FundingChainState {
  depositor: string;
  recipient: string;
  amount: bigint;
  /** Seconds. */
  autoReleaseAt: bigint;
  status: number;
  currency: number;
}

/** Reads the funding sequence needs. `providerFundingReader` is the production one. */
export interface FundingChainReader {
  escrow(contract: string, escrowId: string): Promise<FundingChainState>;
  allowance(token: string, owner: string, spender: string): Promise<bigint>;
  /** The tx that funded `escrowId`, or null when no funding event is found. */
  fundingTx(contract: string, escrowId: string): Promise<string | null>;
}

/** The on-chain fields the relay returns from `GET /v1/commons/jobs/:id/escrow`. */
export interface EscrowFundingDetails {
  escrow_id: string;
  currency: 'usdc' | 'pvt';
  contract_address: string;
  amount_pvt?: string;
  /** USD, at most 6 decimals (the relay's own unit for a USDC escrow). */
  amount_usdc?: number;
  status: string;
  chain: string;
  depositor_address: string;
  recipient_address: string;
  /** Auto-release deadline in MILLISECONDS (relay convention). */
  auto_release_at: number;
  token_address?: string;
  /** the bytes32 id bound at funding (null until funded) — what release / dispute call. */
  onchain_escrow_id?: string | null;
  disputed_at?: number | null;
  resolution?: string | null;
}

/** One built, unsigned contract call in the funding sequence. */
export interface EscrowFundingCall {
  label: 'createEscrow' | 'approve' | 'fundEscrow';
  to: string;
  data: string;
}

export interface EscrowFundingPlan {
  escrowId: string;
  chainId: number;
  /** The escrow currency's on-chain enum (USDC = 0, PVT = 1). */
  currencyEnum: number;
  /** Atomic token units (USDC 6 decimals, PVT 18). */
  amountAtomic: bigint;
  autoReleaseAtSec: number;
  calls: EscrowFundingCall[];
}

/** Hiring escrows are Base-only; map the relay chain label to its id. */
export function escrowChainId(chain: string): number {
  switch (chain) {
    case 'base':
      return 8453;
    default:
      throw new Error(`Job escrow funding is Base-only (got chain '${chain}')`);
  }
}

/** The on-chain Currency enum for a relay currency label. Throws on anything else. */
export function escrowCurrencyEnum(currency: string): number {
  if (currency === 'usdc') return ESCROW_CURRENCY_USDC;
  if (currency === 'pvt') return ESCROW_CURRENCY_PVT;
  throw new Error(`Unknown escrow currency '${currency}'`);
}

/**
 * USD → USDC atomic units (6 decimals). Mirrors the relay's `usdcToAtomic` exactly
 * (`toFixed(6)`, then integer parts) so the amount the phone approves and escrows is
 * byte-for-byte the amount the relay verifies.
 */
export function usdcToAtomic(amountUsdc: number): bigint {
  if (typeof amountUsdc !== 'number' || !Number.isFinite(amountUsdc)) {
    throw new Error('amount_usdc must be a finite number (USD)');
  }
  const fixed = amountUsdc.toFixed(6);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

/** The escrow amount in atomic token units for the escrow's currency. */
export function escrowAmountAtomic(funding: Pick<EscrowFundingDetails, 'currency' | 'amount_pvt' | 'amount_usdc'>): bigint {
  if (funding.currency === 'pvt') {
    if (!funding.amount_pvt || !/^\d+$/.test(funding.amount_pvt)) {
      throw new Error('amount_pvt must be a base-10 integer string (18-decimal wei)');
    }
    return BigInt(funding.amount_pvt);
  }
  if (funding.currency === 'usdc') {
    if (funding.amount_usdc === undefined || funding.amount_usdc === null) {
      throw new Error('amount_usdc is missing for a USDC escrow');
    }
    return usdcToAtomic(funding.amount_usdc);
  }
  throw new Error(`Unknown escrow currency '${String(funding.currency)}'`);
}

/** A human label for the amount ("12.5 USDC", "40 PVT") — used in the biometric prompt. */
export function formatEscrowAmount(funding: Pick<EscrowFundingDetails, 'currency' | 'amount_pvt' | 'amount_usdc'>): string {
  const atomic = escrowAmountAtomic(funding);
  const decimals = ESCROW_TOKEN_DECIMALS[funding.currency];
  return `${ethers.formatUnits(atomic, decimals)} ${funding.currency === 'pvt' ? 'PVT' : 'USDC'}`;
}

/** The token a Commons hire escrow may approve, per currency — pinned, never taken from the relay. */
export function pinnedEscrowToken(currency: 'usdc' | 'pvt'): string {
  if (currency === 'pvt') return PVT9_TOKEN.address;
  const usdc = TOKEN_ADDRESSES[JOB_ESCROW_V4.chainId]?.USDC;
  if (!usdc) throw new Error('Base USDC is not pinned in this build');
  return usdc;
}

function sameAddress(a: string | undefined | null, b: string): boolean {
  return typeof a === 'string' && ethers.isAddress(a) && a.toLowerCase() === b.toLowerCase();
}

/**
 * Refuse — before anything is signed — an escrow whose contract or token is not the one this build
 * pins. The relay's record is what the plan is built FROM, so checking the plan against that same
 * record proves nothing; a misconfigured or compromised relay naming another contract would
 * otherwise get the approval and the funds.
 */
export function assertPinnedEscrow(funding: Pick<EscrowFundingDetails, 'contract_address' | 'token_address' | 'currency' | 'chain'>): void {
  if (escrowChainId(funding.chain) !== JOB_ESCROW_V4.chainId) {
    throw new Error(`Job escrow funding is Base-only (got chain '${funding.chain}')`);
  }
  if (!sameAddress(funding.contract_address, JOB_ESCROW_V4.address)) {
    throw new Error(`The relay named escrow contract ${String(funding.contract_address)}, but this app only funds ${JOB_ESCROW_V4.address}. Nothing was signed.`);
  }
  const token = pinnedEscrowToken(funding.currency);
  if (!sameAddress(funding.token_address, token)) {
    throw new Error(`The relay named token ${String(funding.token_address)} for a ${funding.currency.toUpperCase()} escrow, but this app only approves ${token}. Nothing was signed.`);
  }
}

/**
 * PURE: build the three unsigned calls for an escrow funding, given the relay details and a
 * caller-chosen escrowId. No signing, no network, no randomness — so the encoding, the currency
 * enum, the ms→s auto-release conversion, and the amount handling are all unit-testable. Throws on
 * any input the on-chain verify would later reject, so a bad plan fails BEFORE the wallet is touched.
 */
export function buildEscrowFundingPlan(
  funding: EscrowFundingDetails,
  escrowId: string,
): EscrowFundingPlan {
  const currencyEnum = escrowCurrencyEnum(funding.currency);
  if (!ethers.isHexString(escrowId, 32)) {
    throw new Error('escrowId must be a 0x-prefixed 32-byte hex string');
  }
  if (!ethers.isAddress(funding.contract_address)) {
    throw new Error('escrow contract_address is not a valid address');
  }
  if (!ethers.isAddress(funding.recipient_address)) {
    throw new Error('recipient_address is not a valid address');
  }
  if (!funding.token_address || !ethers.isAddress(funding.token_address)) {
    throw new Error('token_address (the token to approve) is missing or invalid');
  }
  assertPinnedEscrow(funding);
  const amountAtomic = escrowAmountAtomic(funding);
  if (amountAtomic <= 0n) {
    throw new Error('The escrow amount must be greater than zero');
  }
  // The contract requires autoReleaseAt > block.timestamp, and the relay requires the on-chain
  // seconds*1000 <= auto_release_at (ms). floor(ms/1000)*1000 <= ms always holds.
  const autoReleaseAtSec = Math.floor(funding.auto_release_at / 1000);
  if (!Number.isFinite(autoReleaseAtSec) || autoReleaseAtSec <= 0) {
    throw new Error('auto_release_at is missing or invalid');
  }

  const escrowIface = new ethers.Interface(ESCROW_V4_ABI);
  const erc20Iface = new ethers.Interface(ERC20_APPROVE_ABI);

  const calls: EscrowFundingCall[] = [
    {
      label: 'createEscrow',
      to: funding.contract_address,
      data: escrowIface.encodeFunctionData('createEscrow', [
        escrowId,
        funding.recipient_address,
        amountAtomic,
        BigInt(autoReleaseAtSec),
        currencyEnum,
      ]),
    },
    {
      label: 'approve',
      to: funding.token_address,
      data: erc20Iface.encodeFunctionData('approve', [funding.contract_address, amountAtomic]),
    },
    {
      label: 'fundEscrow',
      to: funding.contract_address,
      data: escrowIface.encodeFunctionData('fundEscrow', [escrowId, false]),
    },
  ];

  return {
    escrowId,
    chainId: escrowChainId(funding.chain),
    currencyEnum,
    amountAtomic,
    autoReleaseAtSec,
    calls,
  };
}

/**
 * PURE: re-decode a plan's calls and check them against the relay's funding record — the
 * currency enum, recipient, amount, approve target, and escrow id must all agree. Run right
 * before anything is signed, so a plan that drifted (or was built for the other currency) can
 * never send a transaction.
 */
export function assertFundingPlanMatches(plan: EscrowFundingPlan, funding: EscrowFundingDetails): void {
  const escrowIface = new ethers.Interface(ESCROW_V4_ABI);
  const erc20Iface = new ethers.Interface(ERC20_APPROVE_ABI);
  const byLabel = new Map(plan.calls.map((c) => [c.label, c]));
  const create = byLabel.get('createEscrow');
  const approve = byLabel.get('approve');
  const fund = byLabel.get('fundEscrow');
  if (!create || !approve || !fund || plan.calls.length !== 3) {
    throw new Error('Funding plan is incomplete');
  }
  const expectedEnum = escrowCurrencyEnum(funding.currency);
  const expectedAmount = escrowAmountAtomic(funding);
  const c = escrowIface.decodeFunctionData('createEscrow', create.data);
  if (Number(c[4]) !== expectedEnum || plan.currencyEnum !== expectedEnum) {
    throw new Error(`Funding plan currency does not match this ${funding.currency.toUpperCase()} escrow`);
  }
  if (String(c[1]).toLowerCase() !== funding.recipient_address.toLowerCase()) {
    throw new Error('Funding plan recipient does not match the escrow');
  }
  if (BigInt(c[2]) !== expectedAmount || plan.amountAtomic !== expectedAmount) {
    throw new Error('Funding plan amount does not match the escrow');
  }
  if (create.to.toLowerCase() !== funding.contract_address.toLowerCase()
    || fund.to.toLowerCase() !== funding.contract_address.toLowerCase()) {
    throw new Error('Funding plan targets the wrong escrow contract');
  }
  if (!funding.token_address || approve.to.toLowerCase() !== funding.token_address.toLowerCase()) {
    throw new Error('Funding plan approves the wrong token');
  }
  const a = erc20Iface.decodeFunctionData('approve', approve.data);
  if (String(a[0]).toLowerCase() !== funding.contract_address.toLowerCase() || BigInt(a[1]) !== expectedAmount) {
    throw new Error('Funding plan approval does not match the escrow');
  }
  const f = escrowIface.decodeFunctionData('fundEscrow', fund.data);
  if (String(f[0]).toLowerCase() !== plan.escrowId.toLowerCase() || String(c[0]).toLowerCase() !== plan.escrowId.toLowerCase()) {
    throw new Error('Funding plan escrow id is inconsistent');
  }
  if (f[1] !== false) {
    throw new Error('Funding plan must not ask for the retired PVT fee discount');
  }
}

/** The signing surface the phone's own key exposes (an ethers Wallet satisfies it). */
export interface OwnKeySigner {
  readonly address: string;
  sendTransaction(tx: { to: string; data: string }): Promise<{
    hash: string;
    wait(): Promise<{ status?: number | null } | null>;
  }>;
}

/**
 * Send calls in order from the signer, waiting for each receipt (later calls read state earlier
 * ones write). Throws on the first revert. Returns each call's tx hash by label.
 */
export async function sendCallsInOrder<L extends string>(
  signer: OwnKeySigner,
  calls: ReadonlyArray<{ label: L; to: string; data: string }>,
): Promise<Record<L, string>> {
  const hashes = {} as Record<L, string>;
  for (const call of calls) {
    const tx = await signer.sendTransaction({ to: call.to, data: call.data });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Escrow step '${call.label}' reverted on-chain`);
    }
    hashes[call.label] = tx.hash;
  }
  return hashes;
}

/** An ethers v6 gas-estimate refusal: nothing was broadcast, so a retry cannot pay twice. */
export function isGasEstimateRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; action?: unknown } | null;
  return !!e && e.code === 'CALL_EXCEPTION' && e.action === 'estimateGas';
}

export interface FundingRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Send ONE funding call and wait for its receipt. Only a gas-estimate refusal is retried (nothing
 * was broadcast); any other send error, a failed receipt wait, or a revert stops with a coded error
 * carrying the tx hash when one exists.
 */
async function sendFundingCall(
  signer: OwnKeySigner,
  call: EscrowFundingCall,
  retry: Required<FundingRetryOptions>,
): Promise<string> {
  let tx: { hash: string; wait(): Promise<{ status?: number | null } | null> } | null = null;
  for (let attempt = 1; tx === null; attempt++) {
    try {
      tx = await signer.sendTransaction({ to: call.to, data: call.data });
    } catch (err) {
      if (isGasEstimateRefusal(err) && attempt < retry.attempts) {
        await retry.sleep(retry.delayMs);
        continue;
      }
      const why = err instanceof Error ? err.message : String(err);
      throw new EscrowFundingError('send_failed', `The ${call.label} step was not sent (${why}). Nothing moved in this step; tap Fund again to pick up from here.`);
    }
  }
  let receipt: { status?: number | null } | null;
  try {
    receipt = await tx.wait();
  } catch (err) {
    // ethers v6 wait() THROWS CALL_EXCEPTION (with the receipt attached) on a mined revert.
    const mined = err as { code?: unknown; receipt?: unknown } | null;
    if (mined && mined.code === 'CALL_EXCEPTION' && mined.receipt) {
      throw new EscrowFundingError('reverted', `Escrow step '${call.label}' reverted on-chain (${tx.hash}).`, tx.hash);
    }
    throw new EscrowFundingError('unconfirmed', `The ${call.label} step was sent (${tx.hash}) but its confirmation was not seen. Tap Fund again: it reads the chain and picks up from there.`, tx.hash);
  }
  if (!receipt || receipt.status === 0) {
    throw new EscrowFundingError('reverted', `Escrow step '${call.label}' reverted on-chain (${tx.hash}).`, tx.hash);
  }
  return tx.hash;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EscrowFundingResult {
  /** The fundEscrow tx hash — submit this to POST /v1/commons/jobs/:id/fund. */
  fundTxHash: string;
  /** Null when the escrow already existed on-chain (resumed). */
  createTxHash: string | null;
  /** Null when the allowance already covered the amount (resumed). */
  approveTxHash: string | null;
  escrowId: string;
  /** True when the escrow was already funded on-chain and nothing was sent. */
  alreadyFunded: boolean;
}

/**
 * Sign-and-send a built plan with a given signer, RESUMING from on-chain state. Every precondition
 * is checked BEFORE the first transaction: the signer must be the escrow's depositor on record,
 * the plan must match the relay's escrow record exactly, and an escrow already at the plan's id
 * must carry exactly the plan's terms.
 */
export async function executeFundingPlan(
  signer: OwnKeySigner,
  funding: EscrowFundingDetails,
  plan: EscrowFundingPlan,
  reader: FundingChainReader,
  retryOptions: FundingRetryOptions = {},
): Promise<EscrowFundingResult> {
  if (signer.address.toLowerCase() !== funding.depositor_address.toLowerCase()) {
    throw new Error(
      'This wallet is not the escrow depositor on record; funding it would not verify. '
      + 'Fund from the same wallet that posted the job.',
    );
  }
  assertFundingPlanMatches(plan, funding);
  const retry: Required<FundingRetryOptions> = {
    attempts: retryOptions.attempts ?? FUND_SEND_ATTEMPTS,
    delayMs: retryOptions.delayMs ?? FUND_SEND_RETRY_DELAY_MS,
    sleep: retryOptions.sleep ?? sleepMs,
  };
  const call = (label: EscrowFundingCall['label']): EscrowFundingCall => {
    const c = plan.calls.find((x) => x.label === label);
    if (!c) throw new Error('Funding plan is incomplete');
    return c;
  };
  const contract = call('createEscrow').to;
  const token = call('approve').to;

  const state = await reader.escrow(contract, plan.escrowId);
  let createTxHash: string | null = null;
  if (state.depositor.toLowerCase() === ZERO_ADDRESS) {
    createTxHash = await sendFundingCall(signer, call('createEscrow'), retry);
  } else {
    const sameTerms = state.depositor.toLowerCase() === signer.address.toLowerCase()
      && state.recipient.toLowerCase() === funding.recipient_address.toLowerCase()
      && state.amount === plan.amountAtomic
      && state.currency === plan.currencyEnum
      && state.autoReleaseAt === BigInt(plan.autoReleaseAtSec);
    if (!sameTerms) {
      throw new EscrowFundingError('escrow_id_conflict', `On-chain escrow ${plan.escrowId} exists with different terms than this hire. Nothing was sent.`);
    }
    if (state.status === ONCHAIN_STATUS_CANCELLED) {
      throw new EscrowFundingError('escrow_cancelled', `On-chain escrow ${plan.escrowId} was cancelled. Nothing was sent.`);
    }
    if (state.status !== ONCHAIN_STATUS_CREATED) {
      // Already funded (or past funding): never pay twice — hand back the funding tx.
      const fundTxHash = await reader.fundingTx(contract, plan.escrowId);
      if (!fundTxHash) {
        throw new EscrowFundingError('funded_unrecorded', `On-chain escrow ${plan.escrowId} is already funded, but its funding transaction was not found. Nothing was sent.`);
      }
      return { fundTxHash, createTxHash: null, approveTxHash: null, escrowId: plan.escrowId, alreadyFunded: true };
    }
  }

  let approveTxHash: string | null = null;
  if (await reader.allowance(token, signer.address, contract) < plan.amountAtomic) {
    approveTxHash = await sendFundingCall(signer, call('approve'), retry);
  }
  const fundTxHash = await sendFundingCall(signer, call('fundEscrow'), retry);
  return { fundTxHash, createTxHash, approveTxHash, escrowId: plan.escrowId, alreadyFunded: false };
}

/**
 * How far back to look for a funding event. mainnet.base.org refuses an eth_getLogs span wider
 * than 2,000 blocks (-32614), so each window is exactly 2,000 blocks inclusive; 45 windows ≈ 50 h
 * at Base's ~2 s blocks — a re-tap after a lost confirmation is minutes, not days.
 */
export const FUNDING_LOG_WINDOW = 2_000;
export const FUNDING_LOG_WINDOWS = 45;

/** The production reader: the `escrows` getter, ERC-20 `allowance`, and the funding event. */
export function providerFundingReader(provider: ethers.Provider): FundingChainReader {
  const escrowIface = new ethers.Interface(ESCROW_READ_ABI);
  return {
    async escrow(contract, escrowId) {
      const c = new ethers.Contract(contract, ESCROW_READ_ABI, provider);
      const r = (await c.escrows(escrowId)) as unknown as {
        depositor: string; recipient: string; amount: bigint; autoReleaseAt: bigint; status: bigint; currency: bigint;
      };
      return {
        depositor: String(r.depositor),
        recipient: String(r.recipient),
        amount: BigInt(r.amount),
        autoReleaseAt: BigInt(r.autoReleaseAt),
        status: Number(r.status),
        currency: Number(r.currency),
      };
    },
    async allowance(token, owner, spender) {
      const c = new ethers.Contract(token, ERC20_ALLOWANCE_ABI, provider);
      return BigInt(await c.allowance(owner, spender));
    },
    async fundingTx(contract, escrowId) {
      const topics = [[
        escrowIface.getEvent('EscrowFunded')!.topicHash,
        escrowIface.getEvent('EscrowFundedPVT')!.topicHash,
      ], escrowId];
      let to = await provider.getBlockNumber();
      for (let i = 0; i < FUNDING_LOG_WINDOWS && to > 0; i++) {
        const from = Math.max(0, to - FUNDING_LOG_WINDOW + 1);
        const logs = await provider.getLogs({ address: contract, topics, fromBlock: from, toBlock: to });
        if (logs.length > 0) return logs[logs.length - 1].transactionHash;
        to = from - 1;
      }
      return null;
    },
  };
}

/**
 * IMPURE: sign and broadcast the funding sequence with the poster's own key.
 *
 * Establishes ONE biometric session, then reads the hire's on-chain escrow and sends only the
 * calls still needed (create / approve / fund), waiting for each to confirm before the next.
 * Returns the fundEscrow tx hash for the relay to verify — or, when the escrow is already funded,
 * the funding tx found on-chain.
 */
export async function fundHumanJobEscrowOnChain(
    funding: EscrowFundingDetails, biometricAction?: BiometricAction,
): Promise<EscrowFundingResult> {
    assertWalletEnabled('fundHumanJobEscrowOnChain');

    // Validate the relay record before prompting. The escrow id needs the key (its salt), so the
    // plan is rebuilt with the real id below: one escrow per hire, resumed by every later tap.
    // (The signer is checked against the depositor on record before anything is sent.)
    buildEscrowFundingPlan(funding, ethers.ZeroHash);

    return await withBiometricAction(translate('biometricPrompts.fundJobEscrow', `Fund the job escrow with ${formatEscrowAmount(funding)}`, { amount: formatEscrowAmount(funding) }), async (biometricAction) => {
        assertBiometricAction(biometricAction);

        const provider = TransactionService.providerFor(escrowChainId(funding.chain));
        const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
        const wallet = new ActionWallet(privateKey, biometricAction, provider);
        const escrowId = deriveHireOnchainEscrowId(
            funding.depositor_address,
            funding.escrow_id,
            hireEscrowSalt((m) => wallet.signMessageSync(m)),
        );
        const plan = buildEscrowFundingPlan(funding, escrowId);

        return executeFundingPlan(wallet, funding, plan, providerFundingReader(provider));

    }, biometricAction);
}
