/**
 * EVM on-chain transaction verifier.
 *
 * Phase 2.9 - Theme 3 fix. The Agent Bank funding/settlement endpoints
 * previously trusted caller-asserted txHashes without ever checking the
 * chain, so a malicious agent could mark an escrow "funded" without
 * actually moving USDC. This module fetches and validates the receipt
 * before any state transition is allowed.
 *
 * Supported chains:
 *   - EVM (Base, Arbitrum, Optimism): full receipt + USDC Transfer log parse
 *
 * The Agent Bank only writes 'verified' state transitions
 * after a successful verification.
 */

import { ethers } from 'ethers';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from './economic-constants';
import { verifyBaseEconomicTransactionFinality, verifyBaseTransactionInclusion } from './economic-finality';
import {
  getAcceptedPvtBurnTokensForChain,
  getPvtAddressForChain,
  type PvtBurnTokenAcceptance,
} from '../agent-bank/pvt-principal-config';
import { getVerifierProvider, type ChainName } from './rpc-provider';

// USDC on supported chains. The mainnet contract addresses must match
// `TOKEN_ADDRESSES.usdc` in src/core/chains/evm/config.ts (mobile).
const USDC_ADDRESSES: Record<number, string> = {
  // Mainnets
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',  // Base
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // Arbitrum One
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',    // Optimism
  // Testnets
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',    // Base Sepolia
  421614: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',   // Arbitrum Sepolia
  11155420: '0x5fd84259d66cd46123540766be93dfe6d43130d7', // Optimism Sepolia
};

// USDC has 6 decimals everywhere
const USDC_DECIMALS = 6;

// USDT on supported MAINNET chains. Addresses must match
// `TOKEN_ADDRESSES.USDT` in src/core/chains/evm/config.ts (mobile) and the
// USDT_BY_CHAIN map in routes/config.ts. USDT is 6 decimals on Base/Arb/Op, so
// the USDC atomic conversion (usdcToAtomic) is reused verbatim. Mainnet-only:
// the Sepolia testnets do not carry a canonical USDT here.
const USDT_ADDRESSES: Record<number, string> = {
  8453: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',   // Base
  42161: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',  // Arbitrum One
  10: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',     // Optimism
};

// PVT (PVTv3) has 18 decimals everywhere.

// ERC-20 Transfer event topic: keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Build a hex-padded address topic for log filter matching.
 */
function addressToTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/**
 * Convert a USD float to USDC atomic units (6 decimals), tolerating
 * floating-point rounding by truncating to 6 places before scaling.
 *
 * Exported so the escrow release path (#36) derives the EXPECTED on-chain
 * principal with the byte-identical conversion the funding verifier uses, so
 * the two paths can never disagree on which EscrowFunded event "matches".
 */
/** The canonical USDC token address for a chain id (lowercased), or undefined. the
 * Commons hire funding details hand this to the depositor for the USDC `approve`. */
export function usdcTokenAddressForChainId(chainId: number): string | undefined {
  return USDC_ADDRESSES[chainId];
}

export function usdcToAtomic(amountUsdc: number): bigint {
  const fixed = amountUsdc.toFixed(USDC_DECIMALS);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded);
}

// =============================================================================
// Provider cache
// =============================================================================

// Sepolia testnets stay on direct JsonRpcProvider - there's no production
// fallback need and no per-env-var requirement.
const sepoliaProviderCache = new Map<number, ethers.JsonRpcProvider>();

const PROD_CHAIN_NAME: Record<number, ChainName> = {
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
};

/**
 * Build the EVM provider for a chain's VERIFICATION reads.
 *
 * Production chains route through getVerifierProvider — a quorum-2 FallbackProvider
 * (env primary + public) that requires BOTH endpoints to agree before a receipt is
 * accepted, so a single compromised/malicious RPC cannot forge a "verified" PE.
 * This FAILS CLOSED if either endpoint is down or the two disagree (intentional:
 * for provenance, don't-verify beats maybe-falsely-verify). Note this is the
 * verifier-only quorum-2 path; general reads elsewhere keep quorum 1 via
 * getChainProvider. Sepolia testnets stay on a single direct JsonRpcProvider
 * (testnet receipts are not provenance-critical).
 */
function getEvmProvider(chainId: number): ethers.JsonRpcProvider | ethers.FallbackProvider | null {
  // Production: quorum-2 verifier FallbackProvider over env primary + public secondary.
  const chainName = PROD_CHAIN_NAME[chainId];
  if (chainName) {
    try {
      return getVerifierProvider(chainName);
    } catch (err) {
      console.warn(`[tx-verifier] getVerifierProvider(${chainName}) failed:`, err);
      return null;
    }
  }

  // Testnets: simple direct JsonRpcProvider with timeout.
  const cached = sepoliaProviderCache.get(chainId);
  if (cached) return cached;

  let url: string | undefined;
  switch (chainId) {
    case 84532:   url = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'; break;
    case 421614:  url = process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'; break;
    case 11155420:url = process.env.OPTIMISM_SEPOLIA_RPC_URL || 'https://sepolia.optimism.io'; break;
    default: return null;
  }

  if (!url) return null;
  const fetchReq = new ethers.FetchRequest(url);
  fetchReq.timeout = 30_000;
  const provider = new ethers.JsonRpcProvider(fetchReq, chainId);
  sepoliaProviderCache.set(chainId, provider);
  return provider;
}

// =============================================================================
// Public API
// =============================================================================

export interface TxVerificationResult {
  ok: boolean;
  reason?: string;
  blockNumber?: number;
  /** The block hash the verdict was read at (burn verifier; lowercase). */
  blockHash?: string;
  confirmations?: number;
  /**
   * The PVT token the matched burn log was emitted by (burn verifier only; lowercase). the
   * live kernel, or the retired predecessor for a burn at/below the migration snapshot block.
   */
  tokenAddress?: string;
}

export { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from './economic-constants';

function requiredConfirmations(chainId: number, requested?: number): number {
  const protocolFloor = chainId === 8453 ? BASE_ECONOMIC_FINALITY_CONFIRMATIONS : 1;
  return Math.max(protocolFloor, requested ?? protocolFloor);
}

async function receiptConfirmations(
  chainId: number,
  txHash: string,
  receipt: ethers.TransactionReceipt,
): Promise<number> {
  if (chainId !== 8453) return receipt.confirmations();
  const exact = await verifyBaseEconomicTransactionFinality(txHash);
  if (exact.evidence.blockNumber !== receipt.blockNumber
    || (typeof receipt.blockHash === 'string'
      && exact.evidence.blockHash !== receipt.blockHash.toLowerCase())) {
    throw new Error('base_exact_finality_receipt_mismatch');
  }
  return exact.evidence.confirmations;
}

/** The exact-finality primitive's "agreed, canonical, just not deep enough yet" refusal. */
const BASE_CONFIRMATIONS_PENDING = /^economic_finality_confirmations_pending:(\d+)\/\d+$/;

/**
 * the PVT burn verifier's confirmation count, never masking an RPC failure.
 *
 * `receiptConfirmations` throws for two different things: the Base exact-finality primitive's
 * agreed-but-shallow refusal (`economic_finality_confirmations_pending:N/12` a real count, both
 * legs agreeing on a canonical block) and every RPC failure / leg disagreement / non-canonical read.
 * The first is a count; everything else is `rpc_error: …`. It is NEVER 0 confirmations: a burn
 * whose finality could not be READ is not a burn shown to be shallow, and the burn finalizer
 * (`core/presentation/burn-finality.ts`) must be able to tell the two apart. Only the burn
 * verifier uses it; every other verifier keeps its own fail-closed count, since for them an RPC
 * failure and a shallow receipt both only ever refuse (and their SDK / MCP retry hints key on
 * `insufficient_confirmations`).
 */
async function burnReceiptConfirmations(
  chainId: number,
  txHash: string,
  receipt: ethers.TransactionReceipt,
): Promise<{ confirmations: number } | { refusal: string }> {
  try {
    return { confirmations: await receiptConfirmations(chainId, txHash, receipt) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const pending = BASE_CONFIRMATIONS_PENDING.exec(message);
    if (pending) return { confirmations: Number(pending[1]) };
    return { refusal: `rpc_error: ${message}` };
  }
}

export interface VerifyEvmUsdcTransferParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  expectedAmountUsdc: number;
  /** Optional minimum confirmations; Base mainnet always floors this at 12. */
  minConfirmations?: number;
}

/**
 * Verify that a given transaction hash on an EVM chain represents a
 * successful USDC transfer of the expected amount from the expected
 * sender to the expected recipient.
 *
 * Returns ok=true only when ALL of these are satisfied:
 *   - The receipt exists and has status === 1 (success)
 *   - The transaction has at least minConfirmations
 *   - One of the receipt logs is a USDC Transfer event matching
 *     (from, to, amount) exactly
 *
 * The from/to comparison is case-insensitive. Amount is compared exactly
 * in atomic USDC units (6 decimals). Partial matches do not pass.
 */
export async function verifyEvmUsdcTransfer(
  params: VerifyEvmUsdcTransferParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom, expectedTo, expectedAmountUsdc } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom) || !ethers.isAddress(expectedTo)) {
    return { ok: false, reason: 'invalid_address_format' };
  }
  if (!Number.isFinite(expectedAmountUsdc) || expectedAmountUsdc <= 0) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }

  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) {
    return { ok: false, reason: 'unsupported_chain' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) {
    return { ok: false, reason: 'no_provider_for_chain' };
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  if (!receipt) {
    return { ok: false, reason: 'tx_not_found' };
  }
  if (receipt.status !== 1) {
    return { ok: false, reason: 'tx_failed' };
  }

  // Confirmations check
  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  // Look for a USDC Transfer log matching from→to with the expected amount.
  const expectedFromTopic = addressToTopic(expectedFrom);
  const expectedToTopic = addressToTopic(expectedTo);
  const expectedAtomic = usdcToAtomic(expectedAmountUsdc);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress) continue;
    if (log.topics.length !== 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[1].toLowerCase() !== expectedFromTopic) continue;
    if (log.topics[2].toLowerCase() !== expectedToTopic) continue;

    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount !== expectedAtomic) continue;

    return {
      ok: true,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: false,
    reason: 'no_matching_transfer_log',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// USDT Transfer verification
// =============================================================================

export interface VerifyEvmUsdtTransferParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  /** USD float (USDT is 6 decimals on Base/Arb/Op). */
  expectedAmountUsdt: number;
  minConfirmations?: number;
}

/**
 * Verify a successful USDT transfer of the expected amount from→to. Identical
 * log-matching contract to verifyEvmUsdcTransfer (USDT is a standard 6-decimal
 * ERC-20 on Base/Arb/Op); only the token address source differs (USDT_ADDRESSES,
 * mainnet-only). Amount is compared exactly in atomic units.
 */
export async function verifyEvmUsdtTransfer(
  params: VerifyEvmUsdtTransferParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom, expectedTo, expectedAmountUsdt } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom) || !ethers.isAddress(expectedTo)) {
    return { ok: false, reason: 'invalid_address_format' };
  }
  if (!Number.isFinite(expectedAmountUsdt) || expectedAmountUsdt <= 0) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }

  const usdtAddress = USDT_ADDRESSES[chainId];
  if (!usdtAddress) {
    return { ok: false, reason: 'unsupported_chain' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) {
    return { ok: false, reason: 'no_provider_for_chain' };
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  if (!receipt) {
    return { ok: false, reason: 'tx_not_found' };
  }
  if (receipt.status !== 1) {
    return { ok: false, reason: 'tx_failed' };
  }

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const expectedFromTopic = addressToTopic(expectedFrom);
  const expectedToTopic = addressToTopic(expectedTo);
  // USDT shares USDC's 6-decimal scale; reuse the same conversion.
  const expectedAtomic = usdcToAtomic(expectedAmountUsdt);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdtAddress) continue;
    if (log.topics.length !== 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[1].toLowerCase() !== expectedFromTopic) continue;
    if (log.topics[2].toLowerCase() !== expectedToTopic) continue;

    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount !== expectedAtomic) continue;

    return {
      ok: true,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: false,
    reason: 'no_matching_transfer_log',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// PVT Transfer verification (Workstream 2)
// =============================================================================

export interface VerifyEvmPvtTransferParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  /**
   * Expected PVT amount in atomic 18-decimal units (BigInt). This is wei-style
   * scaling - pass the raw amount returned by ethers / pvtToWei, not a float.
   */
  expectedAmountWei: bigint;
  minConfirmations?: number;
}

/**
 * Verify a PVT transfer on the given chain. Mirrors verifyEvmUsdcTransfer
 * structurally - same Transfer-event topic, same confirmations check, same
 * exact-amount semantics. Differences:
 * - PVT contract address is the canonical live kernel from pvt-principal-config
 * (a code literal, never env), not the hardcoded USDC map. A transfer verifies
 * against the LIVE token only — never the predecessor kernel.
 * - Amounts are 18-decimal BigInts, so the caller passes wei rather than
 * a USD float.
 *
 * Returns ok=true only when ALL of these hold:
 * - PVT-principal is enabled in this backend (else 'pvt_principal_disabled')
 * - PVT contract address is configured for the requested chain
 * - Receipt exists, status === 1, ≥ minConfirmations
 * - Some receipt log is a Transfer(from, to, expectedAmountWei) emitted by
 * the PVT contract address (case-insensitive on addresses, exact on amount).
 */
export async function verifyEvmPvtTransfer(
  params: VerifyEvmPvtTransferParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom, expectedTo, expectedAmountWei } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom) || !ethers.isAddress(expectedTo)) {
    return { ok: false, reason: 'invalid_address_format' };
  }
  if (typeof expectedAmountWei !== 'bigint' || expectedAmountWei <= 0n) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }

  // Resolve the PVT token address for this chain via the chain id → name map
  // we already encode below. The PVT principal config keys by name string
  // ('base', 'arbitrum', etc.) for parity with the existing chain field on
  // EscrowDocument / PromiseDocument / PoolDocument.
  const chainNameById: Record<number, string> = {
    8453: 'base',
    42161: 'arbitrum',
    10: 'optimism',
    84532: 'base_sepolia',
    421614: 'arbitrum_sepolia',
    11155420: 'optimism_sepolia',
  };
  const chainName = chainNameById[chainId];
  if (!chainName) {
    return { ok: false, reason: 'unsupported_chain' };
  }

  const pvtAddress = getPvtAddressForChain(chainName);
  if (!pvtAddress) {
    return { ok: false, reason: 'pvt_principal_disabled_or_unconfigured_chain' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) {
    return { ok: false, reason: 'no_provider_for_chain' };
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const expectedFromTopic = addressToTopic(expectedFrom);
  const expectedToTopic = addressToTopic(expectedTo);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pvtAddress) continue;
    if (log.topics.length !== 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[1].toLowerCase() !== expectedFromTopic) continue;
    if (log.topics[2].toLowerCase() !== expectedToTopic) continue;

    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount !== expectedAmountWei) continue;

    return {
      ok: true,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: false,
    reason: 'no_matching_pvt_transfer_log',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// PVT BURN verification (the demand-side counterpart to verifyEvmPvtTransfer).
//
// An ERC-20 `_burn(from, amount)` — which PVT9's `burn(uint256)` performs —
// emits `Transfer(from, address(0), amount)`. So a burn is exactly a PVT
// Transfer whose DESTINATION is the zero address. This verifier is
// verifyEvmPvtTransfer with `expectedTo` fixed to the zero address: the caller
// never supplies the destination (a burn can only go to 0x0), which is what
// makes "proof that `expectedFrom` burned N PVT" unforgeable — a transfer to a
// non-zero address can never satisfy it.
//
// FAIL-CLOSED WHEN UNCONFIGURED: getPvtAddressForChain returns null unless
// PVT-principal is enabled AND configured for the chain, so this fail-closes to
// 'pvt_principal_disabled_or_unconfigured_chain' exactly like the transfer
// verifier. On the live service PVT-principal IS enabled for Base
// (ENABLE_PVT_PRINCIPAL=true, kernel pinned) and the kernel has real supply, so
// this verifier is ACTIVE and a real PVT9 burn verifies here. Unit tests still
// exercise it via a mocked verifier (the established pattern).
// =============================================================================

export interface VerifyEvmPvtBurnParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  /**
   * Expected PVT amount burned, in atomic 18-decimal units (BigInt). Wei-style
   * scaling - pass the raw amount, not a float.
   */
  expectedAmountWei: bigint;
  minConfirmations?: number;
  /**
   * . `'finality'` (the default, and every non-burn verifier) holds
   * Base to 12 confirmations. `'inclusion'` accepts a Base burn once it is MINED in one block, both
   * operator-bound legs agreeing on the receipt and its canonical block (`verifyBaseTransactionInclusion`);
   * a pending / mempool tx is never accepted. A caller that accepts at inclusion owns the obligation to
   * run this verifier again at `'finality'` and revoke what it granted if that fails
   * (`core/presentation/burn-finality.ts`). Other chains ignore it (their floor is already 1).
   */
  acceptance?: 'finality' | 'inclusion';
}

/**
 * Verify a PVT burn on the given chain. Structurally identical to
 * verifyEvmPvtTransfer, differing ONLY in that the Transfer destination is
 * pinned to the zero address (a burn) rather than caller-supplied. There is no
 * `expectedTo` param by design.
 *
 * Returns ok=true only when ALL of these hold:
 *   - PVT-principal is enabled + configured for the chain (else fail-closed)
 *   - Receipt exists, status === 1, >= minConfirmations
 *   - Some receipt log is a Transfer(expectedFrom, 0x0, expectedAmountWei)
 *     emitted by the PVT contract address (case-insensitive on the address,
 *     exact on the amount).
 */
export async function verifyEvmPvtBurn(
  params: VerifyEvmPvtBurnParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom, expectedAmountWei } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom)) {
    return { ok: false, reason: 'invalid_address_format' };
  }
  if (typeof expectedAmountWei !== 'bigint' || expectedAmountWei <= 0n) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }

  const chainNameById: Record<number, string> = {
    8453: 'base',
    42161: 'arbitrum',
    10: 'optimism',
    84532: 'base_sepolia',
    421614: 'arbitrum_sepolia',
    11155420: 'optimism_sepolia',
  };
  const chainName = chainNameById[chainId];
  if (!chainName) {
    return { ok: false, reason: 'unsupported_chain' };
  }

  // the live token at any block, plus the retired predecessor kernel for burns mined
  // at or before the migration snapshot (its balances were carried from that block).
  const burnTokens = getAcceptedPvtBurnTokensForChain(chainName);
  if (burnTokens.length === 0) {
    return { ok: false, reason: 'pvt_principal_disabled_or_unconfigured_chain' };
  }

  if (params.acceptance === 'inclusion' && chainId === 8453) {
    let included: Awaited<ReturnType<typeof verifyBaseTransactionInclusion>>;
    try {
      included = await verifyBaseTransactionInclusion(txHash);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Both legs agree there is no receipt: not mined (pending, dropped, or replaced). Never accepted.
      if (message.includes('economic_inclusion_receipt_absent')) return { ok: false, reason: 'tx_not_found' };
      if (message.includes('transaction_failed')) return { ok: false, reason: 'tx_failed' };
      // One leg without a receipt, a disagreement, or an RPC failure: refused, and retryable.
      return { ok: false, reason: `rpc_error: ${message}` };
    }
    return matchPvtBurnLog(included.receipt, burnTokens, expectedFrom, expectedAmountWei, {
      blockNumber: included.blockNumber,
      blockHash: included.blockHash,
      confirmations: 1,
    });
  }

  const provider = getEvmProvider(chainId);
  if (!provider) {
    return { ok: false, reason: 'no_provider_for_chain' };
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  // an exception while counting confirmations is an RPC failure and is SAID so — never
  // masked as "0 confirmations", which the burn finalizer would otherwise read as a burn that is
  // not final. Either way the verdict is `ok: false`, so nothing that credits a burn loosens.
  const counted = await burnReceiptConfirmations(chainId, txHash, receipt);
  if ('refusal' in counted) {
    return { ok: false, reason: counted.refusal, blockNumber: receipt.blockNumber };
  }
  const { confirmations } = counted;
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return matchPvtBurnLog(receipt, burnTokens, expectedFrom, expectedAmountWei, {
    blockNumber: receipt.blockNumber,
    ...(typeof receipt.blockHash === 'string' ? { blockHash: receipt.blockHash.toLowerCase() } : {}),
    confirmations,
  });
}

/**
 * The one burn-log match both acceptance stages share: `Transfer(expectedFrom, 0x0, amount)` on
 * an accepted PVT token. A token with a `maxBlock` (the predecessor kernel) matches only
 * when the burn's block is at or below it; the block is the RECEIPT's, never caller-supplied.
 */
export function matchPvtBurnLog(
  receipt: ethers.TransactionReceipt,
  burnTokens: readonly PvtBurnTokenAcceptance[],
  expectedFrom: string,
  expectedAmountWei: bigint,
  at: { blockNumber: number; blockHash?: string; confirmations: number },
): TxVerificationResult {
  const accepted = new Set(
    burnTokens
      .filter((token) => token.maxBlock === null || at.blockNumber <= token.maxBlock)
      .map((token) => token.address.toLowerCase()),
  );
  const expectedFromTopic = addressToTopic(expectedFrom);
  // A burn is a Transfer to the zero address; this destination is NEVER
  // caller-supplied. Match it exactly, so a transfer to any real address
  // (including a self-send back to expectedFrom) can never pass as a burn.
  const zeroToTopic = addressToTopic(ethers.ZeroAddress);

  for (const log of receipt.logs) {
    if (!accepted.has(log.address.toLowerCase())) continue;
    if (log.topics.length !== 3) continue;
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics[1].toLowerCase() !== expectedFromTopic) continue;
    if (log.topics[2].toLowerCase() !== zeroToTopic) continue;

    let amount: bigint;
    try {
      amount = BigInt(log.data);
    } catch {
      continue;
    }
    if (amount !== expectedAmountWei) continue;

    return { ok: true, ...at, tokenAddress: log.address.toLowerCase() };
  }

  return { ok: false, reason: 'no_matching_pvt_burn_log', ...at };
}

/**
 * Verify that an EVM transaction exists, succeeded, has the expected
 * confirmations, and was sent to the expected contract address. Used for
 * non-Transfer state-changing calls (e.g. pool execution) where parsing
 * the event log is heavier than the security gain - at minimum, the tx
 * must have actually run against the right contract.
 */
export interface VerifyEvmContractCallParams {
  chainId: number;
  txHash: string;
  expectedContract: string;
  expectedFrom?: string;
  minConfirmations?: number;
}

export async function verifyEvmContractCall(
  params: VerifyEvmContractCallParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedContract } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedContract)) {
    return { ok: false, reason: 'invalid_contract_address' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  if (receipt.to?.toLowerCase() !== expectedContract.toLowerCase()) {
    return { ok: false, reason: 'tx_to_mismatch' };
  }
  if (params.expectedFrom && receipt.from.toLowerCase() !== params.expectedFrom.toLowerCase()) {
    return { ok: false, reason: 'tx_from_mismatch' };
  }

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: true,
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

/**
 * Verify that an EVM transaction exists, succeeded, has the expected
 * confirmations, and was SENT FROM the expected address - without asserting
 * anything about the `to` address. Used when the destination is unknowable
 * (e.g. a swap routed through a third-party DEX aggregator whose router
 * address rotates), but the sender identity is the load-bearing trust
 * property. Do NOT fold this into verifyEvmContractCall by accepting
 * `tx_to_mismatch`: that function checks `to` BEFORE `from`, so accepting
 * `tx_to_mismatch` silently discards the sender check.
 */
export interface VerifyEvmTxFromParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  minConfirmations?: number;
}

export async function verifyEvmTxFrom(
  params: VerifyEvmTxFromParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom)) {
    return { ok: false, reason: 'invalid_from_address' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  if (receipt.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { ok: false, reason: 'tx_from_mismatch' };
  }

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: true,
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// Generic dispatcher
// =============================================================================

export type SupportedVerificationChain =
  | 'base' | 'arbitrum' | 'optimism'
  | 'base_sepolia' | 'arbitrum_sepolia' | 'optimism_sepolia';

/**
 * Entry-point shape, currency-discriminated.
 *
 * Existing USDC callers can keep passing only `expectedAmountUsdc` (or
 * additionally `currency: 'usdc'`) - the dispatcher defaults to USDC when no
 * currency is specified. PVT callers MUST set `currency: 'pvt'` and pass
 * `expectedAmountPvtWei` (a BigInt of 18-decimal atomic units).
 */
export interface VerifyTransferParams {
  chain: SupportedVerificationChain;
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  /** Defaults to 'usdc' when omitted, preserving V3 caller contracts. */
  currency?: 'usdc' | 'usdt' | 'pvt';
  /** Required when currency === 'usdc' (or omitted). USD float. */
  expectedAmountUsdc?: number;
  /** Required when currency === 'usdt'. USD float (6 decimals). */
  expectedAmountUsdt?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedAmountPvtWei?: bigint;
  minConfirmations?: number;
}

/** Chain-name → EVM chain id for every chain the verifier understands. */
const EVM_CHAIN_ID_BY_NAME: Record<string, number> = {
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  base_sepolia: 84532,
  arbitrum_sepolia: 421614,
  optimism_sepolia: 11155420,
};

/**
 * Entry point used by Agent Bank funding/settlement paths.
 * Routes to the EVM verifier for the supported chains, dispatching on
 * `currency` to either the USDC log parser or the PVT log parser.
 */
export async function verifyTransfer(params: VerifyTransferParams): Promise<TxVerificationResult> {
  if (!(params.chain in EVM_CHAIN_ID_BY_NAME)) {
    return { ok: false, reason: 'unknown_chain' };
  }
  const chainId = EVM_CHAIN_ID_BY_NAME[params.chain];

  const currency = params.currency ?? 'usdc';

  if (currency === 'pvt') {
    if (params.expectedAmountPvtWei === undefined) {
      return { ok: false, reason: 'missing_expected_amount_pvt_wei' };
    }
    return verifyEvmPvtTransfer({
      chainId,
      txHash: params.txHash,
      expectedFrom: params.expectedFrom,
      expectedTo: params.expectedTo,
      expectedAmountWei: params.expectedAmountPvtWei,
      minConfirmations: params.minConfirmations,
    });
  }

  if (currency === 'usdt') {
    if (params.expectedAmountUsdt === undefined) {
      return { ok: false, reason: 'missing_expected_amount_usdt' };
    }
    return verifyEvmUsdtTransfer({
      chainId,
      txHash: params.txHash,
      expectedFrom: params.expectedFrom,
      expectedTo: params.expectedTo,
      expectedAmountUsdt: params.expectedAmountUsdt,
      minConfirmations: params.minConfirmations,
    });
  }

  // USDC (default).
  if (params.expectedAmountUsdc === undefined) {
    return { ok: false, reason: 'missing_expected_amount_usdc' };
  }
  return verifyEvmUsdcTransfer({
    chainId,
    txHash: params.txHash,
    expectedFrom: params.expectedFrom,
    expectedTo: params.expectedTo,
    expectedAmountUsdc: params.expectedAmountUsdc,
    minConfirmations: params.minConfirmations,
  });
}

// =============================================================================
// Escrow on-chain struct + funding-event verification (Pass-2 WS3 #2/#11/#36)
// =============================================================================

// EscrowFunded / EscrowFundedPVT signatures MUST stay byte-identical to the
// Solidity declarations in ProvianEscrowV3.sol / ProvianEscrowV4.sol — ethers
// derives topic0 from them, so a contract change (a renamed field / reordered
// type) fails the decode (fail-closed) instead of silently matching a stale
// hash. The on-chain `escrowId` is the indexed first arg; `amount` is the first
// data word in BOTH variants and always carries the FULL principal (the USDC
// fee-discount path still emits EscrowFunded(escrowId, e.amount)).
const ESCROW_FUNDED_EVENT_ABI = [
  'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
  'event EscrowFundedPVT(bytes32 indexed escrowId, uint256 amount, uint256 feeBurned)',
];
const escrowFundedInterface = new ethers.Interface(ESCROW_FUNDED_EVENT_ABI);

// keccak256("escrows(bytes32)") first 4 bytes — the public mapping getter shared
// by the V3 and V4 escrow contracts.
const ESCROWS_GETTER_SELECTOR = ethers.id('escrows(bytes32)').slice(0, 10);

export interface EscrowFundedEvent {
  /** bytes32 on-chain escrow id (0x-prefixed, lowercased). */
  escrowId: string;
  /** Principal in the escrow's native atomic units (USDC 6dp / PVT wei). */
  amountAtomic: bigint;
}

/**
 * Pure: extract every EscrowFunded / EscrowFundedPVT event emitted BY the given
 * escrow contract from a receipt's logs. Logs from other addresses are ignored
 * (an attacker cannot forge a funding event from an unrelated contract). Shared
 * by the funding verifier (#2/#11, quorum-2) and the release path's id recovery
 * (#36, quorum-1) so the two never diverge on which event is "the" funding event.
 */
export function parseEscrowFundedEvents(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
  escrowContractAddress: string,
): EscrowFundedEvent[] {
  const wantAddr = escrowContractAddress.toLowerCase();
  const out: EscrowFundedEvent[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = escrowFundedInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // not an escrow-funding event we recognize
    }
    if (!parsed) continue;
    if (parsed.name !== 'EscrowFunded' && parsed.name !== 'EscrowFundedPVT') continue;
    out.push({
      escrowId: String(parsed.args.escrowId).toLowerCase(),
      amountAtomic: BigInt(parsed.args.amount),
    });
  }
  return out;
}

export interface EscrowStructPrefix {
  /** word 0 — the on-chain depositor (msg.sender at create), lowercased. */
  depositor: string;
  /** word 1 — the on-chain recipient (release destination), lowercased. */
  recipient: string;
  /** word 2 — principal in native atomic units. */
  amountAtomic: bigint;
  /** word 4 — autoReleaseAt in UNIX SECONDS. */
  autoReleaseAtSeconds: bigint;
  /** word 5 — Status enum (0=Created,1=Funded,2=Completed,3=Disputed,4=Resolved,5=Cancelled). */
  status: number;
}

/**
 * Pure: decode the version-agnostic prefix (struct words 0..5) of the
 * `escrows(bytes32)` public-getter return. The V3 USDC layout (7 words:
 * depositor, recipient, amount, fee, autoReleaseAt, status, feePaidInPVT) and
 * the V4 layout (8 words: ...status, currency, feePaidInPVT — currency appended
 * AFTER status) share an IDENTICAL first six words, so reading by word index is
 * correct for both without ABI-decoding the whole tuple (which would throw
 * BAD_DATA on whichever shape the fixed ABI doesn't match). Returns null on a
 * too-short / unparseable return (caller treats it as a failed read → fail-closed).
 */
export function decodeEscrowStructPrefix(rawCallReturn: string): EscrowStructPrefix | null {
  const body = rawCallReturn.startsWith('0x') ? rawCallReturn.slice(2) : rawCallReturn;
  if (body.length < 6 * 64) return null;
  if (!/^[0-9a-fA-F]+$/.test(body.slice(0, 6 * 64))) return null;
  const word = (i: number): string => body.slice(i * 64, (i + 1) * 64);
  try {
    return {
      depositor: ('0x' + word(0).slice(24)).toLowerCase(),
      recipient: ('0x' + word(1).slice(24)).toLowerCase(),
      amountAtomic: BigInt('0x' + word(2)),
      autoReleaseAtSeconds: BigInt('0x' + word(4)),
      status: Number(BigInt('0x' + word(5))),
    };
  } catch {
    return null;
  }
}

export interface VerifyOnchainEscrowFundingParams {
  chain: SupportedVerificationChain;
  fundTxHash: string;
  escrowContractAddress: string;
  /** The Firestore recipient_address the on-chain escrow MUST pay (#2). */
  expectedRecipient: string;
  /** Defaults to 'usdc'. Escrows are USDC- or PVT-principal only (no USDT). */
  currency?: 'usdc' | 'pvt';
  /** Required when currency === 'usdc' (or omitted). USD float. */
  expectedAmountUsdc?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedAmountPvtWei?: bigint;
  minConfirmations?: number;
}

export interface OnchainEscrowFundingResult extends TxVerificationResult {
  /** bytes32 on-chain escrow id of the matched funding (lowercased). */
  onchainEscrowId?: string;
  /** word 1 — on-chain recipient (lowercased); == expectedRecipient when ok. */
  recipient?: string;
  /** word 4 — on-chain autoReleaseAt in UNIX SECONDS. */
  autoReleaseAtSeconds?: bigint;
}

/**
 * Verify, from the funding tx, that the on-chain escrow the depositor actually
 * funded pays the EXPECTED recipient, and recover its autoReleaseAt (#2/#11/#36).
 *
 * verifyTransfer proves the depositor moved `amount` into the escrow CONTRACT,
 * but says NOTHING about the on-chain escrow STRUCT. A depositor can
 * createEscrow off-relay with recipient=self, fund it (passing verifyTransfer),
 * then have release pay THEMSELVES while the relay credits the worker and emits
 * a verified escrow_completed PE. This binds the funding to the on-chain struct:
 *   1. select the EscrowFunded/EscrowFundedPVT event whose `amount` matches the
 *      expected principal (NOT positionally first — #36), then
 *   2. eth_call escrows(escrowId) and require the struct recipient == the
 *      Firestore recipient (#2), recovering autoReleaseAt for the release gate (#11).
 * Routes through the quorum-2 verifier provider (getEvmProvider), so a single
 * compromised/malicious RPC cannot forge a matching struct. Fails closed
 * (ok:false) on any read error or absent match.
 */
export async function verifyOnchainEscrowFunding(
  params: VerifyOnchainEscrowFundingParams,
): Promise<OnchainEscrowFundingResult> {
  const { chain, fundTxHash, escrowContractAddress, expectedRecipient } = params;
  const currency = params.currency ?? 'usdc';

  if (!/^0x[0-9a-fA-F]{64}$/.test(fundTxHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(escrowContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedRecipient)) return { ok: false, reason: 'invalid_recipient_address' };
  if (!(chain in EVM_CHAIN_ID_BY_NAME)) return { ok: false, reason: 'unknown_chain' };

  let expectedAmountAtomic: bigint;
  if (currency === 'pvt') {
    if (params.expectedAmountPvtWei === undefined || params.expectedAmountPvtWei <= 0n) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAmountAtomic = params.expectedAmountPvtWei;
  } else {
    if (
      params.expectedAmountUsdc === undefined ||
      !Number.isFinite(params.expectedAmountUsdc) ||
      params.expectedAmountUsdc <= 0
    ) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAmountAtomic = usdcToAtomic(params.expectedAmountUsdc);
  }

  const chainId = EVM_CHAIN_ID_BY_NAME[chain];
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);
  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(fundTxHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, fundTxHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const funded = parseEscrowFundedEvents(receipt.logs, escrowContractAddress);
  if (funded.length === 0) {
    return { ok: false, reason: 'escrow_funded_event_not_found', blockNumber: receipt.blockNumber, confirmations };
  }
  // #36: select by amount, never positionally. An attacker batching multiple
  // fundings in one tx cannot steer us to the wrong escrow.
  const amountMatches = funded.filter((e) => e.amountAtomic === expectedAmountAtomic);
  if (amountMatches.length === 0) {
    return { ok: false, reason: 'escrow_funded_amount_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }

  const wantRecipient = expectedRecipient.toLowerCase();
  let sawStructRead = false;
  for (const ev of amountMatches) {
    const data = ESCROWS_GETTER_SELECTOR + ev.escrowId.replace(/^0x/, '').padStart(64, '0');
    let raw: string;
    try {
      raw = await provider.call({ to: escrowContractAddress, data });
    } catch (err) {
      return { ok: false, reason: `rpc_error: ${(err as Error).message}`, blockNumber: receipt.blockNumber, confirmations };
    }
    const struct = decodeEscrowStructPrefix(raw);
    if (!struct) continue;
    sawStructRead = true;
    // Defense in depth: the struct's own principal must also match the event's.
    if (struct.amountAtomic !== expectedAmountAtomic) continue;
    // #2: the on-chain release destination MUST be the agreed recipient.
    if (struct.recipient !== wantRecipient) continue;
    return {
      ok: true,
      onchainEscrowId: ev.escrowId,
      recipient: struct.recipient,
      autoReleaseAtSeconds: struct.autoReleaseAtSeconds,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: false,
    reason: sawStructRead ? 'escrow_recipient_mismatch' : 'escrow_struct_unreadable',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// Promise on-chain funding-event verification (/ Stage 1a)
// =============================================================================

// PromiseFunded / PromiseFundedPVT signatures MUST stay byte-identical to the
// Solidity declarations in ProvianPromiseV2.sol (USDC) / ProvianPromiseV3.sol
// (USDC+PVT) — ethers derives topic0 from them, so a contract change fails the
// decode (fail-closed) rather than silently matching a stale hash. `promiseId`
// and `lender` are the indexed args; `principal` is the single data word.
const PROMISE_FUNDED_EVENT_ABI = [
  'event PromiseFunded(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
  'event PromiseFundedPVT(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
  // The settlement leg. `netAmount` is repayAmount − fee and is what the lender
  // actually receives; the fee rides in the second data word (USDC: paid to the
  // fee wallet; PVT: pulled into the contract and burned).
  'event PromiseSettled(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 fee)',
  'event PromiseSettledPVT(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 feeBurned)',
  // The default leg. `markDefault` flips a Funded promise to Defaulted
  // after its deadline+grace and moves NO tokens, so — unlike funded/settled —
  // these events carry THREE indexed args (promiseId, borrower, lender) with only
  // `principal` in the data word. Must stay byte-identical to ProvianPromiseV2/V3.
  'event PromiseDefaulted(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal)',
  'event PromiseDefaultedPVT(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal)',
];
const promiseFundedInterface = new ethers.Interface(PROMISE_FUNDED_EVENT_ABI);

// keccak256("promises(bytes32)") first 4 bytes — the public mapping getter shared
// by the V2 and V3 promise contracts.
const PROMISES_GETTER_SELECTOR = ethers.id('promises(bytes32)').slice(0, 10);

export interface PromiseFundedEvent {
  /** bytes32 on-chain promise id (0x-prefixed, lowercased). */
  promiseId: string;
  /** The on-chain lender (PromiseFunded.lender == msg.sender), lowercased. */
  lender: string;
  /** Principal in the promise's native atomic units (USDC 6dp / PVT wei). */
  principalAtomic: bigint;
  /**
   * Position of this log within its transaction. Part of the canonical log
   * identity `chainId:txHash:logIndex` — one transaction can carry several
   * fundings, so tx identity alone is not an identity.
   */
  logIndex: number;
}

/**
 * Pure: extract every `PromiseFunded` (or `PromiseFundedPVT`) event emitted BY
 * the given promise contract from a receipt's logs, keeping each event's log
 * index. Logs from any other address are ignored — an attacker cannot forge a
 * funding event from an unrelated contract. A log whose index is not a number
 * is skipped here and reported by the caller as an unusable identity rather
 * than silently accepted without one.
 */
export function parsePromiseFundedEvents(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string; index?: number }>,
  promiseContractAddress: string,
  wantEvent: 'PromiseFunded' | 'PromiseFundedPVT',
): { events: PromiseFundedEvent[]; sawEventWithoutIndex: boolean } {
  const wantAddr = promiseContractAddress.toLowerCase();
  const events: PromiseFundedEvent[] = [];
  let sawEventWithoutIndex = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = promiseFundedInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // not a promise-funding event we recognize
    }
    if (!parsed) continue;
    if (parsed.name !== wantEvent) continue;
    if (typeof log.index !== 'number' || !Number.isInteger(log.index) || log.index < 0) {
      sawEventWithoutIndex = true;
      continue;
    }
    let principalAtomic: bigint;
    try {
      principalAtomic = BigInt(parsed.args.principal);
    } catch {
      continue;
    }
    events.push({
      promiseId: String(parsed.args.promiseId).toLowerCase(),
      lender: String(parsed.args.lender).toLowerCase(),
      principalAtomic,
      logIndex: log.index,
    });
  }
  return { events, sawEventWithoutIndex };
}

export interface PromiseStructPrefix {
  /** word 0 — the on-chain borrower (msg.sender at create), lowercased. */
  borrower: string;
  /** word 1 — the on-chain lender (zero until funded), lowercased. */
  lender: string;
  /** word 2 — principal in native atomic units. */
  principalAtomic: bigint;
}

/**
 * Pure: decode the version-agnostic prefix (struct words 0..2) of the
 * `promises(bytes32)` public-getter return. The V2 layout (borrower, lender,
 * principal, repayAmount, fee, deadline, status, feePaidInPVT) and the V3
 * layout (…status, currency, feePaidInPVT — `currency` appended AFTER status)
 * share an IDENTICAL first three words, so reading by word index is correct for
 * both without ABI-decoding the whole tuple (which would throw BAD_DATA on
 * whichever shape a fixed ABI doesn't match). Returns null on a too-short /
 * unparseable return, which the caller treats as a failed read → fail-closed.
 */
export function decodePromiseStructPrefix(rawCallReturn: string): PromiseStructPrefix | null {
  const body = rawCallReturn.startsWith('0x') ? rawCallReturn.slice(2) : rawCallReturn;
  if (body.length < 3 * 64) return null;
  if (!/^[0-9a-fA-F]+$/.test(body.slice(0, 3 * 64))) return null;
  const word = (i: number): string => body.slice(i * 64, (i + 1) * 64);
  try {
    return {
      borrower: ('0x' + word(0).slice(24)).toLowerCase(),
      lender: ('0x' + word(1).slice(24)).toLowerCase(),
      principalAtomic: BigInt('0x' + word(2)),
    };
  } catch {
    return null;
  }
}

export interface VerifyEvmPromiseFundingParams {
  chain: SupportedVerificationChain;
  fundTxHash: string;
  promiseContractAddress: string;
  /** The lender EOA that must have funded (PromiseFunded.lender == msg.sender). */
  expectedLender: string;
  /** The Firestore borrower_address the on-chain promise MUST pay. */
  expectedBorrower: string;
  /** Defaults to 'usdc'. Promises are USDC- or PVT-principal only. */
  currency?: 'usdc' | 'pvt';
  /** Required when currency === 'usdc' (or omitted). USD float. */
  expectedAmountUsdc?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedAmountPvtWei?: bigint;
  minConfirmations?: number;
}

export interface PromiseFundingVerificationResult extends TxVerificationResult {
  /** bytes32 on-chain promise id of the matched funding (lowercased). */
  onchainPromiseId?: string;
  /** Log index of the matched PromiseFunded event within its transaction. */
  logIndex?: number;
  /** word 0 — on-chain borrower (lowercased); == expectedBorrower when ok. */
  borrower?: string;
}

/**
 * Verify that a transaction is a REAL on-chain `ProvianPromise.fundPromise(bytes32)`
 * paying the EXPECTED borrower — a successful call that emitted a
 * `PromiseFunded`/`PromiseFundedPVT` event from the promise contract naming
 * `expectedLender` for exactly the expected principal, whose on-chain struct
 * names `expectedBorrower` — and return the canonical log identity it landed at.
 *
 * This is the promise-side mirror of `verifyEvmPoolContribution` (entry leg) and
 * `verifyOnchainEscrowFunding` (struct binding), and it closes the same gap both
 * of those closed. The prior bar here was a bare ERC-20 `Transfer`
 * lender → borrower (`verifyTransfer`), which proves only that two addresses
 * moved a token: a plain `usdc.transfer(borrower, principal)` that never calls
 * `fundPromise()` passes it, so the contract's promise stays `Open`, the lender
 * is never recorded on-chain, `settlePromise` can never pay them — and the relay
 * would still have flipped the row to `funded` and emitted a `promise_funded` PE.
 * Requiring the contract's own event (emitted AFTER its `transferFrom`, so its
 * presence proves the funds moved) plus the struct's borrower makes every
 * recorded funding a real on-chain funding of the promise the relay claims.
 *
 * Routes through the quorum-2 verifier provider (`getEvmProvider`), so a single
 * compromised RPC cannot forge a matching event or struct. Fails closed
 * (`ok:false`, named reason) on any read error, absent match, or unusable log
 * identity — a canonical event without an identity is not a canonical event.
 */
export async function verifyEvmPromiseFunding(
  params: VerifyEvmPromiseFundingParams,
): Promise<PromiseFundingVerificationResult> {
  const { chain, fundTxHash, promiseContractAddress, expectedLender, expectedBorrower } = params;
  const currency = params.currency ?? 'usdc';

  if (!/^0x[0-9a-fA-F]{64}$/.test(fundTxHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(promiseContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedLender)) return { ok: false, reason: 'invalid_lender_address' };
  if (!ethers.isAddress(expectedBorrower)) return { ok: false, reason: 'invalid_borrower_address' };
  if (!(chain in EVM_CHAIN_ID_BY_NAME)) return { ok: false, reason: 'unknown_chain' };
  // A promise funded by its own borrower moves nothing and is not a lending act.
  // Refused by address, not only by wallet id — the chain sees addresses.
  if (expectedLender.toLowerCase() === expectedBorrower.toLowerCase()) {
    return { ok: false, reason: 'promise_self_funding_refused' };
  }

  let expectedAmountAtomic: bigint;
  if (currency === 'pvt') {
    if (params.expectedAmountPvtWei === undefined || params.expectedAmountPvtWei <= 0n) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAmountAtomic = params.expectedAmountPvtWei;
  } else {
    if (
      params.expectedAmountUsdc === undefined
      || !Number.isFinite(params.expectedAmountUsdc)
      || params.expectedAmountUsdc <= 0
    ) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAmountAtomic = usdcToAtomic(params.expectedAmountUsdc);
  }
  // A zero-value funding is not a funding. Both currency arms already refuse a
  // non-positive expectation above; this restates it on the atomic value so a
  // sub-unit USDC float (0.0000001 → 0 atomic) cannot round into "verified".
  if (expectedAmountAtomic <= 0n) return { ok: false, reason: 'invalid_expected_amount' };

  const chainId = EVM_CHAIN_ID_BY_NAME[chain];
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);
  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(fundTxHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, fundTxHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantEvent = currency === 'pvt' ? 'PromiseFundedPVT' : 'PromiseFunded';
  const { events, sawEventWithoutIndex } = parsePromiseFundedEvents(
    receipt.logs,
    promiseContractAddress,
    wantEvent,
  );
  if (events.length === 0) {
    return {
      ok: false,
      // THE BARE-TRANSFER BYPASS LANDS HERE: a receipt carrying only an ERC-20
      // Transfer lender → borrower has no event from the promise contract.
      reason: sawEventWithoutIndex
        ? 'promise_funded_log_identity_unavailable'
        : 'promise_funded_event_not_found',
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantLender = expectedLender.toLowerCase();
  const wantBorrower = expectedBorrower.toLowerCase();
  const lenderMatches = events.filter((e) => e.lender === wantLender);
  if (lenderMatches.length === 0) {
    return { ok: false, reason: 'promise_funded_lender_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }
  // Select by amount, never positionally — one tx can fund several promises.
  const amountMatches = lenderMatches.filter((e) => e.principalAtomic === expectedAmountAtomic);
  if (amountMatches.length === 0) {
    return { ok: false, reason: 'promise_funded_amount_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }

  let sawStructRead = false;
  for (const ev of amountMatches) {
    const data = PROMISES_GETTER_SELECTOR + ev.promiseId.replace(/^0x/, '').padStart(64, '0');
    let raw: string;
    try {
      raw = await provider.call({ to: promiseContractAddress, data });
    } catch (err) {
      return {
        ok: false,
        reason: `rpc_error: ${(err as Error).message}`,
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    }
    const struct = decodePromiseStructPrefix(raw);
    if (!struct) continue;
    sawStructRead = true;
    // Defense in depth: the struct's own principal must match the event's.
    if (struct.principalAtomic !== expectedAmountAtomic) continue;
    // The on-chain lender of record must be the wallet claiming the funding.
    if (struct.lender !== wantLender) continue;
    // The on-chain principal destination MUST be the agreed borrower.
    if (struct.borrower !== wantBorrower) continue;
    return {
      ok: true,
      onchainPromiseId: ev.promiseId,
      logIndex: ev.logIndex,
      borrower: struct.borrower,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return {
    ok: false,
    reason: sawStructRead ? 'promise_borrower_mismatch' : 'promise_struct_unreadable',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

export interface PromiseSettledEvent {
  /** bytes32 on-chain promise id (0x-prefixed, lowercased). */
  promiseId: string;
  /** The on-chain lender paid by this settlement, lowercased. */
  lender: string;
  /** Net-to-lender (repayAmount − fee) in native atomic units. */
  netAmountAtomic: bigint;
  /** Position of this log within its transaction. */
  logIndex: number;
}

/**
 * Pure: extract every `PromiseSettled` (or `PromiseSettledPVT`) event emitted BY
 * the given promise contract, keeping each event's log index. Same address
 * filter and same index requirement as `parsePromiseFundedEvents`.
 */
export function parsePromiseSettledEvents(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string; index?: number }>,
  promiseContractAddress: string,
  wantEvent: 'PromiseSettled' | 'PromiseSettledPVT',
): { events: PromiseSettledEvent[]; sawEventWithoutIndex: boolean } {
  const wantAddr = promiseContractAddress.toLowerCase();
  const events: PromiseSettledEvent[] = [];
  let sawEventWithoutIndex = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = promiseFundedInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name !== wantEvent) continue;
    if (typeof log.index !== 'number' || !Number.isInteger(log.index) || log.index < 0) {
      sawEventWithoutIndex = true;
      continue;
    }
    let netAmountAtomic: bigint;
    try {
      netAmountAtomic = BigInt(parsed.args.netAmount);
    } catch {
      continue;
    }
    events.push({
      promiseId: String(parsed.args.promiseId).toLowerCase(),
      lender: String(parsed.args.lender).toLowerCase(),
      netAmountAtomic,
      logIndex: log.index,
    });
  }
  return { events, sawEventWithoutIndex };
}

export interface VerifyEvmPromiseSettlementParams {
  chain: SupportedVerificationChain;
  settleTxHash: string;
  promiseContractAddress: string;
  /** The lender that must have been paid (PromiseSettled.lender). */
  expectedLender: string;
  /** Defaults to 'usdc'. */
  currency?: 'usdc' | 'pvt';
  /** Required when currency === 'usdc' (or omitted). USD float, net to lender. */
  expectedNetToLenderUsdc?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedNetToLenderPvtWei?: bigint;
  /**
   * The bytes32 on-chain promise id this row was BOUND to at funding time. When
   * present the settlement event's promiseId MUST match, so a settlement of a
   * DIFFERENT promise for the same lender and amount cannot close this row.
   * Omit only for rows funded before the id was pinned; the
   * lender + amount + contract match still holds for those.
   */
  expectedOnchainPromiseId?: string;
  minConfirmations?: number;
}

export interface PromiseSettlementVerificationResult extends TxVerificationResult {
  /** bytes32 on-chain promise id of the matched settlement (lowercased). */
  onchainPromiseId?: string;
  /** Log index of the matched PromiseSettled event within its transaction. */
  logIndex?: number;
}

/**
 * Verify that a transaction is a REAL on-chain `ProvianPromise.settlePromise` —
 * a successful call that emitted `PromiseSettled`/`PromiseSettledPVT` from the
 * promise contract paying `expectedLender` exactly the agreed net amount — and
 * return the canonical log identity it landed at.
 *
 * The exit-side twin of `verifyEvmPromiseFunding`, and it closes the same
 * bypass on the same institution: the prior bar was a bare borrower → lender
 * `Transfer` for the net amount, which a plain `usdc.transfer(lender, net)`
 * satisfies without ever calling `settlePromise()`. On chain the promise would
 * stay `Funded` (still defaultable, and its fee never paid), while the relay
 * marked the row `settled` and emitted a `promise_settled` PE — a row whose
 * policy disposition is `eligible`, so the weak bar sat directly on the money
 * path. Requiring the contract's own event proves the settlement executed
 * atomically, fee leg included (the contract's ordering reverts the whole call
 * otherwise). Fails closed, named reason, on every arm.
 */
export async function verifyEvmPromiseSettlement(
  params: VerifyEvmPromiseSettlementParams,
): Promise<PromiseSettlementVerificationResult> {
  const { chain, settleTxHash, promiseContractAddress, expectedLender } = params;
  const currency = params.currency ?? 'usdc';

  if (!/^0x[0-9a-fA-F]{64}$/.test(settleTxHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(promiseContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedLender)) return { ok: false, reason: 'invalid_lender_address' };
  if (!(chain in EVM_CHAIN_ID_BY_NAME)) return { ok: false, reason: 'unknown_chain' };
  if (
    params.expectedOnchainPromiseId !== undefined
    && !/^0x[0-9a-fA-F]{64}$/.test(params.expectedOnchainPromiseId)
  ) {
    return { ok: false, reason: 'invalid_onchain_promise_id' };
  }

  let expectedAtomic: bigint;
  if (currency === 'pvt') {
    if (params.expectedNetToLenderPvtWei === undefined || params.expectedNetToLenderPvtWei <= 0n) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = params.expectedNetToLenderPvtWei;
  } else {
    if (
      params.expectedNetToLenderUsdc === undefined
      || !Number.isFinite(params.expectedNetToLenderUsdc)
      || params.expectedNetToLenderUsdc <= 0
    ) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = usdcToAtomic(params.expectedNetToLenderUsdc);
  }
  if (expectedAtomic <= 0n) return { ok: false, reason: 'invalid_expected_amount' };

  const chainId = EVM_CHAIN_ID_BY_NAME[chain];
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);
  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(settleTxHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, settleTxHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantEvent = currency === 'pvt' ? 'PromiseSettledPVT' : 'PromiseSettled';
  const { events, sawEventWithoutIndex } = parsePromiseSettledEvents(
    receipt.logs,
    promiseContractAddress,
    wantEvent,
  );
  if (events.length === 0) {
    // THE BARE-TRANSFER BYPASS LANDS HERE.
    return {
      ok: false,
      reason: sawEventWithoutIndex
        ? 'promise_settled_log_identity_unavailable'
        : 'promise_settled_event_not_found',
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantLender = expectedLender.toLowerCase();
  const lenderMatches = events.filter((e) => e.lender === wantLender);
  if (lenderMatches.length === 0) {
    return { ok: false, reason: 'promise_settled_lender_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }
  const amountMatches = lenderMatches.filter((e) => e.netAmountAtomic === expectedAtomic);
  if (amountMatches.length === 0) {
    return { ok: false, reason: 'promise_settled_amount_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }

  const wantId = params.expectedOnchainPromiseId?.toLowerCase();
  const idMatches = wantId ? amountMatches.filter((e) => e.promiseId === wantId) : amountMatches;
  if (idMatches.length === 0) {
    return { ok: false, reason: 'promise_settled_id_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }

  return {
    ok: true,
    onchainPromiseId: idMatches[0].promiseId,
    logIndex: idMatches[0].logIndex,
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// Promise on-chain default-event verification
// =============================================================================

export interface PromiseDefaultedEvent {
  /** bytes32 on-chain promise id (0x-prefixed, lowercased). */
  promiseId: string;
  /** The on-chain borrower named by the default event, lowercased. */
  borrower: string;
  /** The on-chain lender named by the default event, lowercased. */
  lender: string;
  /** Position of this log within its transaction. */
  logIndex: number;
}

/**
 * Pure: extract every `PromiseDefaulted` (or `PromiseDefaultedPVT`) event emitted
 * BY the given promise contract, keeping each event's log index. Same address
 * filter and same index requirement as `parsePromiseSettledEvents`. Unlike the
 * funded/settled events, the default event names both `borrower` and `lender` as
 * indexed args (the caller matches on the on-chain promise id + those parties).
 */
export function parsePromiseDefaultedEvents(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string; index?: number }>,
  promiseContractAddress: string,
  wantEvent: 'PromiseDefaulted' | 'PromiseDefaultedPVT',
): { events: PromiseDefaultedEvent[]; sawEventWithoutIndex: boolean } {
  const wantAddr = promiseContractAddress.toLowerCase();
  const events: PromiseDefaultedEvent[] = [];
  let sawEventWithoutIndex = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = promiseFundedInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name !== wantEvent) continue;
    if (typeof log.index !== 'number' || !Number.isInteger(log.index) || log.index < 0) {
      sawEventWithoutIndex = true;
      continue;
    }
    events.push({
      promiseId: String(parsed.args.promiseId).toLowerCase(),
      borrower: String(parsed.args.borrower).toLowerCase(),
      lender: String(parsed.args.lender).toLowerCase(),
      logIndex: log.index,
    });
  }
  return { events, sawEventWithoutIndex };
}

export interface VerifyEvmPromiseDefaultParams {
  chain: SupportedVerificationChain;
  defaultTxHash: string;
  promiseContractAddress: string;
  /** Defaults to 'usdc'. Selects PromiseDefaulted vs PromiseDefaultedPVT. */
  currency?: 'usdc' | 'pvt';
  /**
   * The bytes32 on-chain promise id this row was BOUND to at funding time. A
   * defaulted promise ALWAYS has one (only a Funded promise can default), so this
   * is REQUIRED — a default of a DIFFERENT promise cannot mark this row.
   */
  expectedOnchainPromiseId: string;
  /** The borrower named on the funded row (PromiseDefaulted.borrower). */
  expectedBorrower: string;
  /** The lender named on the funded row (PromiseDefaulted.lender). */
  expectedLender: string;
  minConfirmations?: number;
}

export interface PromiseDefaultVerificationResult extends TxVerificationResult {
  /** bytes32 on-chain promise id of the matched default (lowercased). */
  onchainPromiseId?: string;
  /** Log index of the matched PromiseDefaulted event within its transaction. */
  logIndex?: number;
}

/**
 * Verify that a transaction is a REAL on-chain `ProvianPromise.markDefault` a
 * successful call that emitted `PromiseDefaulted`/`PromiseDefaultedPVT` from the
 * promise contract for THIS on-chain promise id, naming this borrower and lender —
 * and return the canonical log identity it landed at.
 *
 * The third leg alongside `verifyEvmPromiseFunding` / `verifyEvmPromiseSettlement`
 *. `markDefault` moves no tokens; the contract reverts unless the promise
 * is Funded and `block.timestamp >= deadline` (+ grace), so the event's existence
 * is itself proof the deadline passed on chain. The relay STILL enforces its own
 * deadline check before accepting a default (defense in depth); this verifier is
 * the on-chain half. Fails closed, named reason, on every arm.
 */
export async function verifyEvmPromiseDefault(
  params: VerifyEvmPromiseDefaultParams,
): Promise<PromiseDefaultVerificationResult> {
  const { chain, defaultTxHash, promiseContractAddress, expectedBorrower, expectedLender } = params;
  const currency = params.currency ?? 'usdc';

  if (!/^0x[0-9a-fA-F]{64}$/.test(defaultTxHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(promiseContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedBorrower)) return { ok: false, reason: 'invalid_borrower_address' };
  if (!ethers.isAddress(expectedLender)) return { ok: false, reason: 'invalid_lender_address' };
  if (!(chain in EVM_CHAIN_ID_BY_NAME)) return { ok: false, reason: 'unknown_chain' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.expectedOnchainPromiseId)) {
    return { ok: false, reason: 'invalid_onchain_promise_id' };
  }

  const chainId = EVM_CHAIN_ID_BY_NAME[chain];
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);
  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(defaultTxHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, defaultTxHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantEvent = currency === 'pvt' ? 'PromiseDefaultedPVT' : 'PromiseDefaulted';
  const { events, sawEventWithoutIndex } = parsePromiseDefaultedEvents(
    receipt.logs,
    promiseContractAddress,
    wantEvent,
  );
  if (events.length === 0) {
    return {
      ok: false,
      reason: sawEventWithoutIndex
        ? 'promise_defaulted_log_identity_unavailable'
        : 'promise_defaulted_event_not_found',
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantId = params.expectedOnchainPromiseId.toLowerCase();
  const idMatches = events.filter((e) => e.promiseId === wantId);
  if (idMatches.length === 0) {
    return { ok: false, reason: 'promise_defaulted_id_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }
  const wantBorrower = expectedBorrower.toLowerCase();
  const wantLender = expectedLender.toLowerCase();
  const partyMatches = idMatches.filter((e) => e.borrower === wantBorrower && e.lender === wantLender);
  if (partyMatches.length === 0) {
    return { ok: false, reason: 'promise_defaulted_party_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }

  return {
    ok: true,
    onchainPromiseId: partyMatches[0].promiseId,
    logIndex: partyMatches[0].logIndex,
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// Native-coin (ETH) transfer verification
// =============================================================================

export interface VerifyEvmNativeTransferParams {
  chainId: number;
  txHash: string;
  expectedFrom: string;
  expectedTo: string;
  /** Expected native value in wei (BigInt, exact match). */
  expectedAmountWei: bigint;
  minConfirmations?: number;
}

/**
 * Verify a native-coin (ETH) transfer: the expected EOA sent EXACTLY
 * expectedAmountWei to expectedTo in a SUCCESSFUL transaction.
 *
 * A plain native send carries its value + recipient on the TRANSACTION object
 * (eth_getTransactionByHash exposes `tx.to` and `tx.value`), NOT on the receipt
 * (which only has logs, status, and the `to` of the outermost call). The prior
 * native path used verifyEvmTxFrom, which reads only the receipt and so could
 * confirm the SENDER but never the value or recipient. This verifier reads BOTH:
 *   - getTransaction       -> tx.from / tx.to / tx.value (sender, recipient, amount)
 *   - getTransactionReceipt -> status === 1 (success) + confirmations
 *
 * Returns ok=true only when ALL hold: the tx exists and is mined, the receipt
 * status is success, sender + recipient + value all match exactly, and the tx
 * has >= minConfirmations. Contract-creation txs (tx.to === null) are rejected.
 */
export async function verifyEvmNativeTransfer(
  params: VerifyEvmNativeTransferParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, expectedFrom, expectedTo, expectedAmountWei } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'invalid_tx_hash_format' };
  }
  if (!ethers.isAddress(expectedFrom) || !ethers.isAddress(expectedTo)) {
    return { ok: false, reason: 'invalid_address_format' };
  }
  if (typeof expectedAmountWei !== 'bigint' || expectedAmountWei < 0n) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let tx: ethers.TransactionResponse | null;
  let receipt: ethers.TransactionReceipt | null;
  try {
    [tx, receipt] = await Promise.all([
      provider.getTransaction(txHash),
      provider.getTransactionReceipt(txHash),
    ]);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  if (!tx || !receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  // Recipient: a value send has tx.to set; a contract-creation tx has null.
  if (tx.to === null) {
    return { ok: false, reason: 'tx_to_is_contract_creation', blockNumber: receipt.blockNumber };
  }
  if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { ok: false, reason: 'tx_from_mismatch', blockNumber: receipt.blockNumber };
  }
  if (tx.to.toLowerCase() !== expectedTo.toLowerCase()) {
    return { ok: false, reason: 'native_recipient_mismatch', blockNumber: receipt.blockNumber };
  }
  if (tx.value !== expectedAmountWei) {
    return { ok: false, reason: 'native_value_mismatch', blockNumber: receipt.blockNumber };
  }

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  return { ok: true, blockNumber: receipt.blockNumber, confirmations };
}

// =============================================================================
// Bond origination verification (BondPosted / BondRenewed events)
// =============================================================================

// ProvianBondPool events. These signature strings MUST stay byte-identical to
// the Solidity declarations in contracts/src/ProvianBondPool.sol (lines 135-136)
// because ethers derives topic0 from them. We deliberately do NOT hardcode a
// topic0 hash - ethers.Interface computes it, so a contract change that renames
// a field or reorders types fails the decode (fail-closed) instead of silently
// matching a stale hash.
const BOND_POOL_EVENT_ABI = [
  'event BondPosted(address indexed agent, uint256 totalDeposit, uint256 lockedAmount, uint8 autonomyLevel)',
  'event BondRenewed(address indexed agent, uint256 newDeadline)',
  // bond lifecycle: shortfall-restore top-up (no burn/fee; 100% becomes slashable collateral).
  'event BondToppedUp(address indexed agent, uint256 amount, uint256 newBondAmount)',
  'event BondWithdrawn(address indexed agent, uint256 returnedAmount)',
  'event ClaimFiled(bytes32 indexed claimId, address indexed claimant, address indexed agent)',
  // WS1 (Pass-2): on-chain settlement events bridged from a Court verdict.
  'event BondSlashed(address indexed agent, bytes32 indexed claimId, address indexed claimant, uint256 claimantAmount, uint256 burnedAmount)',
  'event ClaimDismissed(bytes32 indexed claimId, address indexed agent)',
  // bond lifecycle: receipt anchors for the scheduler's non-adjudicative lifecycle mirrors.
  'event BondAbandoned(address indexed agent, uint256 burnedAmount)',
  'event ClaimExpired(bytes32 indexed claimId, address indexed agent)',
];
const bondPoolInterface = new ethers.Interface(BOND_POOL_EVENT_ABI);

function parseBondLog(
  log: { address: string; topics: ReadonlyArray<string>; data: string },
  poolAddress: string,
): ethers.LogDescription | null {
  if (log.address.toLowerCase() !== poolAddress.toLowerCase()) return null;
  try {
    return bondPoolInterface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null; // not a BondPool event we recognize
  }
}

export interface VerifyEvmBondPostedParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /** The agent EOA that must have posted the bond (BondPosted.agent == msg.sender). */
  expectedAgent: string;
  /** The autonomy level the agent claims (BondPosted.autonomyLevel). */
  expectedAutonomyLevel: 2 | 3;
  /**
   * WS5: minimum on-chain locked collateral the server requires (atomic PVT).
   * On-chain `postBond` honors a CALLER-supplied trustDiscountBps (≤50%), so an
   * agent could lock far less than the server's computed requiredBond while the
   * backend recorded it as fully collateralized. When set, BondPosted.lockedAmount
   * must be >= this value or the verification fails closed. Omit to skip (legacy).
   */
  expectedMinLockedAmount?: bigint | string;
  minConfirmations?: number;
}

/**
 * Verify a bond was ACTUALLY posted on-chain, by the claiming agent, for the
 * claimed level. The prior verifier only checked receipt.to === BondPool +
 * confirmations, which proves the tx touched the pool but NOT that a bond was
 * created, by whom, or at what level (a failed/unrelated call to the pool, or a
 * relayer-wrapped call, would pass). This decodes the BondPosted event from the
 * pool's own logs and confirms:
 *   1. a BondPosted event was emitted by the BondPool, AND
 *   2. its indexed `agent` equals expectedAgent (the bond's owner / msg.sender), AND
 *   3. its `autonomyLevel` equals expectedAutonomyLevel.
 * Absent event or sender/level mismatch => fail closed.
 */
export async function verifyEvmBondPosted(
  params: VerifyEvmBondPostedParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent, expectedAutonomyLevel } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);
  const minLocked = params.expectedMinLockedAmount !== undefined
    ? BigInt(params.expectedMinLockedAmount)
    : undefined;

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };
  if (expectedAutonomyLevel !== 2 && expectedAutonomyLevel !== 3) {
    return { ok: false, reason: 'invalid_autonomy_level' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  // Scan ALL BondPosted events emitted by the pool; pass if any matches both
  // agent and level. Only after exhausting them do we report the closest reason.
  let sawBondPosted = false;
  let sawAgentMatch = false;
  let sawLevelMatchButUnderLocked = false;
  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed || parsed.name !== 'BondPosted') continue;
    sawBondPosted = true;
    const agent = String(parsed.args.agent).toLowerCase();
    if (agent !== expectedAgent.toLowerCase()) continue;
    sawAgentMatch = true;
    if (Number(parsed.args.autonomyLevel) !== expectedAutonomyLevel) continue;
    // WS5: the on-chain locked collateral must meet the server-required bond.
    if (minLocked !== undefined && BigInt(parsed.args.lockedAmount) < minLocked) {
      sawLevelMatchButUnderLocked = true;
      continue;
    }
    return { ok: true, blockNumber: receipt.blockNumber, confirmations };
  }

  if (!sawBondPosted) {
    return { ok: false, reason: 'bond_posted_event_not_found', blockNumber: receipt.blockNumber, confirmations };
  }
  if (sawLevelMatchButUnderLocked) {
    return { ok: false, reason: 'bond_locked_amount_below_required', blockNumber: receipt.blockNumber, confirmations };
  }
  if (!sawAgentMatch) {
    return { ok: false, reason: 'bond_agent_mismatch', blockNumber: receipt.blockNumber, confirmations };
  }
  return { ok: false, reason: 'bond_level_mismatch', blockNumber: receipt.blockNumber, confirmations };
}

export interface VerifyEvmBondRenewedParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /** The agent EOA whose bond is being renewed (BondRenewed.agent == msg.sender). */
  expectedAgent: string;
  minConfirmations?: number;
}

export interface BondRenewedVerificationResult extends TxVerificationResult {
  /**
   * The on-chain renewal deadline from the matching BondRenewed event
   * (BondRenewed.newDeadline), in UNIX SECONDS. The on-chain renewalPeriod is
   * governance-mutable, so the contract — not a backend-derived now+90d — is the
   * source of truth for the deadline. The caller persists THIS (converted to ms)
   * rather than re-deriving it (#25). Undefined only on a non-match or a
   * pathological out-of-range event value.
   */
  newDeadlineSeconds?: number;
}

/**
 * Verify a bond renewal: a BondRenewed event was emitted by the BondPool with
 * its indexed `agent` equal to expectedAgent, and recover the event's
 * `newDeadline` (#25). (No level in the renewal event; renewBond() applies to the
 * caller's own active bond.) Absent event or sender mismatch => fail closed.
 */
export async function verifyEvmBondRenewed(
  params: VerifyEvmBondRenewedParams,
): Promise<BondRenewedVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  let sawBondRenewed = false;
  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed || parsed.name !== 'BondRenewed') continue;
    sawBondRenewed = true;
    if (String(parsed.args.agent).toLowerCase() === expectedAgent.toLowerCase()) {
      // #25: surface the on-chain newDeadline (unix seconds). Guard against an
      // out-of-range value (Number() of a pathological uint256) so the caller
      // falls back to its policy default rather than persisting NaN/Infinity.
      const rawDeadline = Number(parsed.args.newDeadline);
      const newDeadlineSeconds =
        Number.isSafeInteger(rawDeadline) && rawDeadline > 0 ? rawDeadline : undefined;
      return { ok: true, newDeadlineSeconds, blockNumber: receipt.blockNumber, confirmations };
    }
  }

  return {
    ok: false,
    reason: sawBondRenewed ? 'bond_agent_mismatch' : 'bond_renewed_event_not_found',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

export interface VerifyEvmBondToppedUpParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /** The agent EOA whose bond was topped up (BondToppedUp.agent == msg.sender). */
  expectedAgent: string;
  minConfirmations?: number;
}

export interface BondToppedUpVerificationResult extends TxVerificationResult {
  /** BondToppedUp.amount — the PVT (atomic) added as slashable collateral. */
  toppedAmountAtomic?: string;
  /** BondToppedUp.newBondAmount — the bond's total locked collateral (atomic) after the top-up. */
  newBondAmountAtomic?: string;
}

/**
 * bond lifecycle: verify a bond top-up — a BondToppedUp event emitted by the BondPool with
 * its indexed `agent` equal to expectedAgent — and recover the event's exact
 * amount + resulting collateral so the backend records chain truth rather than
 * a caller assertion. Absent event or agent mismatch => fail closed.
 */
export async function verifyEvmBondToppedUp(
  params: VerifyEvmBondToppedUpParams,
): Promise<BondToppedUpVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  let sawToppedUp = false;
  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed || parsed.name !== 'BondToppedUp') continue;
    sawToppedUp = true;
    if (String(parsed.args.agent).toLowerCase() === expectedAgent.toLowerCase()) {
      return {
        ok: true,
        toppedAmountAtomic: BigInt(parsed.args.amount).toString(),
        newBondAmountAtomic: BigInt(parsed.args.newBondAmount).toString(),
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    }
  }

  return {
    ok: false,
    reason: sawToppedUp ? 'bond_agent_mismatch' : 'bond_topped_up_event_not_found',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// bond lifecycle: receipt recovery for observed (not backend-driven) bond outcomes.
//
// The scheduler's abandonment / stale-claim mirrors sometimes observe an
// on-chain outcome another caller already drove (processAbandonment and
// expireStaleClaim are PERMISSIONLESS). The economic Firestore transition still
// needs a Base-final receipt anchor (beneficiary routing machine), so these helpers recover the
// settlement tx hash from the emitted BondAbandoned / ClaimExpired log — the
// same pattern escrow-release.ts uses for already_released/already_resolved.
// Unrecoverable => the caller fails closed (record left for a later tick).
// =============================================================================

export interface RecoveredBondReceipt extends TxVerificationResult {
  /** The recovered settlement tx hash (the receipt/idempotency anchor). */
  txHash?: string;
}

async function recoverBondPoolEventReceipt(params: {
  chainId: number;
  bondPoolAddress: string;
  eventName: 'BondAbandoned' | 'ClaimExpired' | 'BondSlashed' | 'ClaimDismissed';
  /**
   * Indexed-topic filter AFTER topic0 (the event signature), in declaration
   * order; `null` skips a position. E.g. BondAbandoned/ClaimExpired filter on
   * topic1 (agent / claimId); BondSlashed on [agent, claimId].
   */
  topics: (string | null)[];
  /** Match the parsed log's args against the expectation (defense in depth). */
  matches: (parsed: ethers.LogDescription) => boolean;
  fromBlock?: number | null;
  minConfirmations?: number;
}): Promise<RecoveredBondReceipt> {
  const { chainId, bondPoolAddress, eventName, matches } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  const topic0 = bondPoolInterface.getEvent(eventName)?.topicHash;
  if (!topic0) return { ok: false, reason: 'event_fragment_missing' };

  let logs: ethers.Log[];
  try {
    logs = await provider.getLogs({
      address: bondPoolAddress,
      topics: [topic0, ...params.topics],
      fromBlock: Math.max(0, params.fromBlock ?? 0),
      toBlock: 'latest',
    });
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }

  // Most-recent matching log wins (mirrors escrow-release recovery).
  for (let i = logs.length - 1; i >= 0; i--) {
    const parsed = parseBondLog(logs[i], bondPoolAddress);
    if (!parsed || parsed.name !== eventName) continue;
    if (!matches(parsed)) continue;

    const txHash = logs[i].transactionHash;
    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await provider.getTransactionReceipt(txHash);
    } catch (err) {
      return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
    }
    if (!receipt || receipt.status !== 1) return { ok: false, reason: 'recovered_tx_unavailable' };

    let confirmations = 0;
    try {
      confirmations = await receiptConfirmations(chainId, txHash, receipt);
    } catch {
      confirmations = 0;
    }
    if (confirmations < minConfirmations) {
      return {
        ok: false,
        reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
        blockNumber: receipt.blockNumber,
        confirmations,
        txHash,
      };
    }
    return { ok: true, blockNumber: receipt.blockNumber, confirmations, txHash };
  }

  return { ok: false, reason: `${eventName.toLowerCase()}_log_not_found` };
}

/**
 * bond lifecycle: recover the Base-final BondAbandoned receipt for an agent whose bond the
 * chain already shows Abandoned (burned by another caller / a prior tick).
 */
export async function recoverEvmBondAbandoned(params: {
  chainId: number;
  bondPoolAddress: string;
  agent: string;
  fromBlock?: number | null;
  minConfirmations?: number;
}): Promise<RecoveredBondReceipt> {
  if (!ethers.isAddress(params.agent)) return { ok: false, reason: 'invalid_agent_address' };
  const want = params.agent.toLowerCase();
  return recoverBondPoolEventReceipt({
    chainId: params.chainId,
    bondPoolAddress: params.bondPoolAddress,
    eventName: 'BondAbandoned',
    topics: [ethers.zeroPadValue(params.agent, 32)],
    matches: (parsed) => String(parsed.args.agent).toLowerCase() === want,
    fromBlock: params.fromBlock,
    minConfirmations: params.minConfirmations,
  });
}

/**
 * bond lifecycle: recover the Base-final ClaimExpired receipt for a claim the chain already
 * shows Dismissed via the permissionless timeout (expired by another caller).
 * Fails closed (log_not_found) when the claim was dismissed by a COURT verdict
 * instead — that path is the Court settlement mirror, not claim expiry.
 */
export async function recoverEvmClaimExpired(params: {
  chainId: number;
  bondPoolAddress: string;
  onchainClaimId: string;
  expectedAgent: string;
  fromBlock?: number | null;
  minConfirmations?: number;
}): Promise<RecoveredBondReceipt> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.onchainClaimId)) {
    return { ok: false, reason: 'invalid_claim_id' };
  }
  if (!ethers.isAddress(params.expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };
  const wantClaim = params.onchainClaimId.toLowerCase();
  const wantAgent = params.expectedAgent.toLowerCase();
  return recoverBondPoolEventReceipt({
    chainId: params.chainId,
    bondPoolAddress: params.bondPoolAddress,
    eventName: 'ClaimExpired',
    topics: [wantClaim],
    matches: (parsed) =>
      String(parsed.args.claimId).toLowerCase() === wantClaim
      && String(parsed.args.agent).toLowerCase() === wantAgent,
    fromBlock: params.fromBlock,
    minConfirmations: params.minConfirmations,
  });
}

/**
 * agent directory: the recovered on-chain resolution of a Court-adjudicated bond claim —
 * the receipt anchor for the receipt-gated `resolveBondClaim` bridge.
 */
export interface RecoveredClaimResolution extends RecoveredBondReceipt {
  /** The on-chain verdict the settlement event proves. */
  verdict?: 'upheld' | 'dismissed';
  /** BondSlashed.claimantAmount (wei), present for an upheld verdict. */
  slashClaimantAmountWei?: string;
  /** BondSlashed.burnedAmount (wei), present for an upheld verdict. */
  slashBurnedAmountWei?: string;
}

/**
 * agent directory: recover the Base-final Court settlement of a bond claim from the
 * BondPool's own logs — BondSlashed (a 2-of-3 panel slash landing on-chain via
 * ProvianCourtV2.castBondClaimVote) or ClaimDismissed (a panel Dismiss majority,
 * a 1/1/1 deadlock, or the permissionless finalizeBondClaim). The VERDICT is
 * taken from the EVENT, never from a caller assertion or a Firestore tally —
 * the chain is the only slash authority (slashes originate ONLY from a Court
 * verdict through slashBond; there is no admin or backend slash path to
 * observe). Bounded from the claim's filing block; fails closed
 * (log_not_found / insufficient confirmations) when no Base-final settlement
 * exists, leaving the claim 'filed' for a later retry.
 */
export async function recoverEvmBondClaimResolution(params: {
  chainId: number;
  bondPoolAddress: string;
  onchainClaimId: string;
  expectedAgent: string;
  fromBlock?: number | null;
  minConfirmations?: number;
}): Promise<RecoveredClaimResolution> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.onchainClaimId)) {
    return { ok: false, reason: 'invalid_claim_id' };
  }
  if (!ethers.isAddress(params.expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };
  const wantClaim = params.onchainClaimId.toLowerCase();
  const wantAgent = params.expectedAgent.toLowerCase();

  // 1) BondSlashed(agent indexed, claimId indexed, claimant indexed, ...):
  //    filter [agent, claimId]; recover the actual slashed amounts for
  //    separate party/burn accounting.
  let claimantAmountWei: string | undefined;
  let burnedAmountWei: string | undefined;
  const slashed = await recoverBondPoolEventReceipt({
    chainId: params.chainId,
    bondPoolAddress: params.bondPoolAddress,
    eventName: 'BondSlashed',
    topics: [ethers.zeroPadValue(params.expectedAgent, 32), wantClaim],
    matches: (parsed) => {
      const hit =
        String(parsed.args.claimId).toLowerCase() === wantClaim
        && String(parsed.args.agent).toLowerCase() === wantAgent;
      if (hit) {
        claimantAmountWei = BigInt(parsed.args.claimantAmount).toString();
        burnedAmountWei = BigInt(parsed.args.burnedAmount).toString();
      }
      return hit;
    },
    fromBlock: params.fromBlock,
    minConfirmations: params.minConfirmations,
  });
  if (slashed.ok) {
    return {
      ...slashed,
      verdict: 'upheld',
      slashClaimantAmountWei: claimantAmountWei,
      slashBurnedAmountWei: burnedAmountWei,
    };
  }
  // Only fall through to the dismissal probe when the slash log genuinely does
  // not exist. A slash log that exists but is not yet Base-final (or an RPC
  // failure) must surface as-is — never mask a pending slash as "dismissed
  // not found".
  if (slashed.reason !== 'bondslashed_log_not_found') return slashed;

  // 2) ClaimDismissed(claimId indexed, agent indexed): filter [claimId, agent].
  const dismissed = await recoverBondPoolEventReceipt({
    chainId: params.chainId,
    bondPoolAddress: params.bondPoolAddress,
    eventName: 'ClaimDismissed',
    topics: [wantClaim, ethers.zeroPadValue(params.expectedAgent, 32)],
    matches: (parsed) =>
      String(parsed.args.claimId).toLowerCase() === wantClaim
      && String(parsed.args.agent).toLowerCase() === wantAgent,
    fromBlock: params.fromBlock,
    minConfirmations: params.minConfirmations,
  });
  if (dismissed.ok) return { ...dismissed, verdict: 'dismissed' };
  return dismissed;
}

// =============================================================================
// Live bond-parameter reads (eth_call against the configured BondPool)
// =============================================================================

export interface OnchainBaseBondResult {
  ok: boolean;
  reason?: string;
  /** Live on-chain base bond for the level, atomic PVT (1e18), at discount 0. */
  baseBondAtomic?: bigint;
}

// Short-TTL cache so a burst of bond posts does not eth_call per request. Keyed by
// chainId:pool:level. 60s reflects a governance base-bond change within a minute
// while absorbing request bursts.
const BASE_BOND_CACHE_TTL_MS = 60_000;
const baseBondCache = new Map<string, { value: bigint; expiresAt: number }>();

/** Test-only: clear the live base-bond cache between cases. */
export function _clearBaseBondCache(): void {
  baseBondCache.clear();
}

const BOND_POOL_REQUIRED_BOND_ABI = [
  'function getRequiredBond(uint8 autonomyLevel, uint256 trustDiscountBps) view returns (uint256)',
];

/**
 * Read the LIVE on-chain base bond for an autonomy level via eth_call to the
 * configured BondPool. ProvianBondPool.level2/3BaseBond is governance-mutable, so
 * the static SAFETY_LIMITS constant can drift below it; a base REDUCTION would
 * make a correctly-collateralized post fail the server's collateral floor until a
 * backend redeploy (#26). getRequiredBond(level, 0) returns the full base bond
 * (atomic, 1e18) under the contract's own integer math.
 *
 * Routes through the quorum-2 verifier provider (getEvmProvider) so a single
 * compromised RPC cannot forge a falsely-low base bond (which would let an
 * under-collateralized post pass the floor). Fails closed (ok:false) on any read
 * error; the caller falls back to the static constant.
 */
export async function readOnchainBaseBond(params: {
  chainId: number;
  bondPoolAddress: string;
  autonomyLevel: 2 | 3;
}): Promise<OnchainBaseBondResult> {
  const { chainId, bondPoolAddress, autonomyLevel } = params;
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (autonomyLevel !== 2 && autonomyLevel !== 3) return { ok: false, reason: 'invalid_autonomy_level' };

  const cacheKey = `${chainId}:${bondPoolAddress.toLowerCase()}:${autonomyLevel}`;
  const cached = baseBondCache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs) return { ok: true, baseBondAtomic: cached.value };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  try {
    const contract = new ethers.Contract(bondPoolAddress, BOND_POOL_REQUIRED_BOND_ABI, provider);
    const base = (await contract.getRequiredBond(autonomyLevel, 0)) as bigint;
    if (base <= 0n) return { ok: false, reason: 'nonpositive_base_bond' };
    baseBondCache.set(cacheKey, { value: base, expiresAt: nowMs + BASE_BOND_CACHE_TTL_MS });
    return { ok: true, baseBondAtomic: base };
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
}

export type OnchainBondStatusName = 'none' | 'active' | 'withdrawn' | 'abandoned';

export interface OnchainBondStatusResult {
  ok: boolean;
  reason?: string;
  status?: OnchainBondStatusName;
  /** Current on-chain locked amount (atomic PVT); 0 once abandoned/withdrawn. */
  amountAtomic?: bigint;
}

// ProvianBondPool.BondStatus enum order (contracts/src/ProvianBondPool.sol):
// None=0, Active=1, Withdrawn=2, Abandoned=3.
const ONCHAIN_BOND_STATUS: Record<number, OnchainBondStatusName> = {
  0: 'none',
  1: 'active',
  2: 'withdrawn',
  3: 'abandoned',
};

const BOND_POOL_BONDS_ABI = [
  'function bonds(address) view returns (uint256 amount, uint8 autonomyLevel, uint256 createdAt, uint256 lastRenewalAt, uint256 renewalDeadline, uint8 status, uint256 pendingClaims)',
];

/**
 * Read the LIVE on-chain bond record for an agent. The abandonment scheduler uses
 * this to CONFIRM an on-chain burn before asserting it off-chain (#24): the
 * backend never calls processAbandonment, and the on-chain function reverts until
 * renewalDeadline + grace + abandonment, so the scheduler must not emit a "burned"
 * PE until the chain actually shows the bond Abandoned. Fails closed on any error.
 */
export async function readOnchainBondStatus(params: {
  chainId: number;
  bondPoolAddress: string;
  agent: string;
}): Promise<OnchainBondStatusResult> {
  const { chainId, bondPoolAddress, agent } = params;
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(agent)) return { ok: false, reason: 'invalid_agent_address' };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  try {
    const contract = new ethers.Contract(bondPoolAddress, BOND_POOL_BONDS_ABI, provider);
    const bond = await contract.bonds(agent);
    const statusNum = Number(bond.status);
    const status = ONCHAIN_BOND_STATUS[statusNum];
    if (!status) return { ok: false, reason: `unknown_status_${statusNum}` };
    return { ok: true, status, amountAtomic: BigInt(bond.amount) };
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
}

export interface VerifyEvmBondWithdrawnParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /** The agent EOA whose bond is being withdrawn (BondWithdrawn.agent == msg.sender). */
  expectedAgent: string;
  minConfirmations?: number;
}

/**
 * Verify a bond withdrawal: a BondWithdrawn event was emitted by the BondPool
 * with its indexed `agent` equal to expectedAgent. The same hardening FIX C
 * applied to postBond/renewBond - the prior path only checked receipt.to ===
 * BondPool, which proves the tx touched the pool but NOT that a withdrawal
 * happened or by whom. Absent event or sender mismatch => fail closed.
 */
export async function verifyEvmBondWithdrawn(
  params: VerifyEvmBondWithdrawnParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  let sawBondWithdrawn = false;
  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed || parsed.name !== 'BondWithdrawn') continue;
    sawBondWithdrawn = true;
    if (String(parsed.args.agent).toLowerCase() === expectedAgent.toLowerCase()) {
      return { ok: true, blockNumber: receipt.blockNumber, confirmations };
    }
  }

  return {
    ok: false,
    reason: sawBondWithdrawn ? 'bond_agent_mismatch' : 'bond_withdrawn_event_not_found',
    blockNumber: receipt.blockNumber,
    confirmations,
  };
}

// =============================================================================
// Bond claim filing verification (ClaimFiled event)
// =============================================================================

export interface VerifyEvmClaimFiledParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /**
   * The bonded agent the claim must be filed against
   * (ClaimFiled.agent == the respondent's bond owner). Recovered + matched
   * so a backend claim can never be attributed to a respondent who was not
   * actually named in the on-chain filing.
   */
  expectedAgent: string;
  /**
   * The claimant that must have filed (ClaimFiled.claimant == msg.sender).
   * Binds the backend filer to the on-chain claimant so an attacker cannot
   * replay someone else's legitimate ClaimFiled tx under their own session.
   */
  expectedClaimant: string;
  minConfirmations?: number;
}

export interface ClaimFiledVerificationResult extends TxVerificationResult {
  /**
   * On-chain bytes32 claimId recovered from the matching ClaimFiled event
   * (0x-prefixed, lowercased). The backend binds + dedups against THIS value
   * rather than minting its own id, so one on-chain filing maps to at most one
   * backend claim.
   */
  onchainClaimId?: string;
}

/**
 * Verify a bond claim was ACTUALLY filed on-chain, against the claimed agent,
 * by the claiming filer - and recover the on-chain bytes32 claimId.
 *
 * The prior fileClaim path used the generic verifyEvmContractCall (only
 * receipt.to === BondPool + confirmations), which proves the tx touched the
 * pool but NOT that a claim was filed, against whom, or by whom. That let one
 * ClaimFiled tx be POSTed repeatedly (no claimId binding, no dedup), each
 * stacking pending_claims against an attacker-chosen respondent. This decodes
 * the ClaimFiled event from the pool's own logs and confirms:
 *   1. a ClaimFiled event was emitted by the BondPool, AND
 *   2. its indexed `agent` equals expectedAgent (the respondent's bond), AND
 *   3. its indexed `claimant` equals expectedClaimant (the authenticated filer).
 * On a match it returns the on-chain claimId for transactional dedup at the
 * call site. Absent event or agent/claimant mismatch => fail closed.
 */
export async function verifyEvmClaimFiled(
  params: VerifyEvmClaimFiledParams,
): Promise<ClaimFiledVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent, expectedClaimant } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };
  if (!ethers.isAddress(expectedClaimant)) return { ok: false, reason: 'invalid_claimant_address' };

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  // Scan ALL ClaimFiled events emitted by the pool; pass on the first that
  // matches BOTH agent and claimant. Track partial matches for a precise reason.
  let sawClaimFiled = false;
  let sawAgentMatch = false;
  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed || parsed.name !== 'ClaimFiled') continue;
    sawClaimFiled = true;
    if (String(parsed.args.agent).toLowerCase() !== expectedAgent.toLowerCase()) continue;
    sawAgentMatch = true;
    if (String(parsed.args.claimant).toLowerCase() !== expectedClaimant.toLowerCase()) continue;
    return {
      ok: true,
      onchainClaimId: String(parsed.args.claimId).toLowerCase(),
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  let reason: string;
  if (!sawClaimFiled) reason = 'claim_filed_event_not_found';
  else if (!sawAgentMatch) reason = 'claim_agent_mismatch';
  else reason = 'claim_claimant_mismatch';
  return { ok: false, reason, blockNumber: receipt.blockNumber, confirmations };
}

// =============================================================================
// Bond claim settlement verification (BondSlashed / ClaimDismissed events)
// =============================================================================

export interface VerifyEvmBondClaimResolvedParams {
  chainId: number;
  txHash: string;
  bondPoolAddress: string;
  /** The bonded respondent the claim was filed against (event `agent`). */
  expectedAgent: string;
  /** The on-chain bytes32 claimId the backend claim is bound to (0x-prefixed). */
  expectedClaimId: string;
  /**
   * The off-chain verdict whose settlement we are confirming. 'upheld' must
   * match an on-chain BondSlashed; 'dismissed' must match a ClaimDismissed.
   * A mismatch (e.g. the off-chain verdict says upheld but the chain dismissed)
   * fails closed - we never record a settlement that contradicts the chain.
   *
   * agent directory: OPTIONAL. When omitted, the verifier accepts WHICHEVER settlement
   * event (BondSlashed or ClaimDismissed) matches the claimId + agent and
   * returns its verdict — the on-chain event is the verdict authority, never a
   * caller assertion. When provided, a contradiction still fails closed.
   */
  expectedVerdict?: 'upheld' | 'dismissed';
  minConfirmations?: number;
}

export interface BondClaimResolvedVerificationResult extends TxVerificationResult {
  /** The verdict actually settled on-chain ('upheld' = slashed, 'dismissed'). */
  verdict?: 'upheld' | 'dismissed';
  /** The on-chain bytes32 claimId of the matched settlement (lowercased). */
  onchainClaimId?: string;
  /** Slash payout to the claimant in atomic PVT (BigInt string). Upheld only. */
  slashClaimantAmountWei?: string;
  /** Burned portion of the slash in atomic PVT (BigInt string). Upheld only. */
  slashBurnedAmountWei?: string;
}

/**
 * Verify a bond claim was ACTUALLY settled on-chain for the bound claimId, by the
 * BondPool, with the verdict the backend recorded. The settlement (slashBond /
 * dismissClaim) is driven by a 2-of-3 panel vote landing on the redeployed Court,
 * NOT by the backend - this verifier is how the backend confirms the on-chain
 * outcome and flips onchain_settlement → 'confirmed'. Fails closed unless:
 *   1. the matching event (BondSlashed for 'upheld', ClaimDismissed for
 *      'dismissed') was emitted by the BondPool, AND
 *   2. its claimId equals the bound on-chain claimId, AND
 *   3. its agent equals the respondent's bond owner.
 * Recovers the on-chain slash split (claimant/burned) for an upheld settlement so
 * the recorded amount is the on-chain truth, not a re-derivation.
 */
export async function verifyEvmBondClaimResolved(
  params: VerifyEvmBondClaimResolvedParams,
): Promise<BondClaimResolvedVerificationResult> {
  const { chainId, txHash, bondPoolAddress, expectedAgent, expectedClaimId, expectedVerdict } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(bondPoolAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedAgent)) return { ok: false, reason: 'invalid_agent_address' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedClaimId)) return { ok: false, reason: 'invalid_claim_id' };
  // agent directory: expectedVerdict is optional (undefined = the on-chain event decides).
  if (expectedVerdict !== undefined && expectedVerdict !== 'upheld' && expectedVerdict !== 'dismissed') {
    return { ok: false, reason: 'invalid_expected_verdict' };
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  // agent directory: undefined expectedVerdict = accept whichever settlement event matches
  // (the chain decides); a provided one restricts to that event type only.
  const acceptSlashed = expectedVerdict === undefined || expectedVerdict === 'upheld';
  const acceptDismissed = expectedVerdict === undefined || expectedVerdict === 'dismissed';
  const expectedClaimIdLc = expectedClaimId.toLowerCase();
  const expectedAgentLc = expectedAgent.toLowerCase();
  let sawSettlement = false; // saw an accepted settlement event TYPE
  let sawClaimIdMatch = false;

  for (const log of receipt.logs) {
    const parsed = parseBondLog(log, bondPoolAddress);
    if (!parsed) continue;
    if (acceptSlashed && parsed.name === 'BondSlashed') {
      sawSettlement = true;
      if (String(parsed.args.claimId).toLowerCase() !== expectedClaimIdLc) continue;
      sawClaimIdMatch = true;
      if (String(parsed.args.agent).toLowerCase() !== expectedAgentLc) continue;
      return {
        ok: true,
        verdict: 'upheld',
        onchainClaimId: expectedClaimIdLc,
        slashClaimantAmountWei: BigInt(parsed.args.claimantAmount).toString(),
        slashBurnedAmountWei: BigInt(parsed.args.burnedAmount).toString(),
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    }
    if (acceptDismissed && parsed.name === 'ClaimDismissed') {
      sawSettlement = true;
      if (String(parsed.args.claimId).toLowerCase() !== expectedClaimIdLc) continue;
      sawClaimIdMatch = true;
      if (String(parsed.args.agent).toLowerCase() !== expectedAgentLc) continue;
      return {
        ok: true,
        verdict: 'dismissed',
        onchainClaimId: expectedClaimIdLc,
        blockNumber: receipt.blockNumber,
        confirmations,
      };
    }
  }

  let reason: string;
  if (!sawSettlement) {
    reason = expectedVerdict === undefined
      ? 'settlement_event_not_found'
      : expectedVerdict === 'upheld'
        ? 'bond_slashed_event_not_found'
        : 'claim_dismissed_event_not_found';
  } else if (!sawClaimIdMatch) reason = 'settlement_claim_id_mismatch';
  else reason = 'settlement_agent_mismatch';
  return { ok: false, reason, blockNumber: receipt.blockNumber, confirmations };
}

// =============================================================================
// Pool fund-exit verification (P4-01 / P4-02): withdrawContribution + refundPool
//
// Both exit legs of a capital pool move REAL contributor funds on-chain, yet the
// backend previously reported success (route "Contribution withdrawn
// successfully" / scheduler pool_refunded PE) without ever broadcasting or
// confirming the on-chain settlement — the same Firestore-only exit class Pass-3
// closed for escrow (escrowChain) and bonds (bondKeeper). These helpers are the
// on-chain confirmation the two legs now require before any PE asserts funds
// returned.
//
// Event signatures MUST stay byte-identical to ProvianPoolV2.sol / ProvianPoolV3.sol
// — ethers derives topic0 from them, so a contract change fails the decode
// (fail-closed) rather than silently matching a stale hash. V2 (USDC) emits the
// non-PVT variants; V3 (USDC+PVT) emits both. `poolId` + `contributor` are the
// indexed args in the contribution/withdrawal events.
// =============================================================================

const POOL_EVENT_ABI = [
  'event PoolContribution(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed)',
  'event PoolContributionPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed)',
  'event PoolWithdrawal(bytes32 indexed poolId, address indexed contributor, uint256 amount)',
  'event PoolWithdrawalPVT(bytes32 indexed poolId, address indexed contributor, uint256 amount)',
  'event PoolRefunded(bytes32 indexed poolId, uint256 contributorCount)',
  'event PoolRefundedPVT(bytes32 indexed poolId, uint256 contributorCount)',
];
const poolEventInterface = new ethers.Interface(POOL_EVENT_ABI);

// keccak256("pools(bytes32)") first 4 bytes — the public mapping getter shared by
// the V2 (USDC) and V3 (USDC+PVT) pool contracts. The PoolInfo struct's first
// SEVEN words are identical across V2 and V3 (creator, target, threshold,
// totalContributed, fee, deadline, status), so `status` sits at word index 6 in
// BOTH; V3 appends `currency` at word 7 but that never shifts status. We read
// word 6 from the raw eth_call return rather than ABI-decoding the whole tuple
// (which would throw on whichever shape a fixed ABI doesn't match).
const POOLS_GETTER_SELECTOR = ethers.id('pools(bytes32)').slice(0, 10);

// On-chain Pool Status enum (ProvianPoolV2/V3.sol): Open=0, Funded=1, Executed=2,
// Refunded=3, Cancelled=4.
export const POOL_STATUS_OPEN = 0;
export const POOL_STATUS_FUNDED = 1;
export const POOL_STATUS_REFUNDED = 3;

export interface RecoverPoolIdParams {
  chainId: number;
  poolContractAddress: string;
  /** Tx hash of an on-chain `contribute` to this pool by `expectedContributor`. */
  txHash: string;
  /** The contributor EOA whose PoolContribution event pins the on-chain poolId. */
  expectedContributor: string;
}

/**
 * Recover the on-chain `bytes32 poolId` from a contribution transaction.
 *
 * The backend never records the on-chain poolId the creator chose at on-chain
 * `createPool` (there is no create-tx binding), but every on-chain `contribute`
 * emits `PoolContribution(bytes32 indexed poolId, address indexed contributor, …)`
 * — the poolId is the indexed first topic. All contributions to a pool share the
 * same on-chain poolId, so any contribution tx by a known contributor recovers it.
 * This mirrors the escrow release path's `recoverOnchainIdFromFundTx`
 * (EscrowFunded event → bytes32 escrowId). Returns the 0x-lowercased poolId, or
 * null on an unreadable/absent match (caller fails closed — never refunds/withdraws
 * a poolId it cannot pin).
 */
export async function recoverPoolIdFromContributionTx(
  params: RecoverPoolIdParams,
): Promise<string | null> {
  const { chainId, poolContractAddress, txHash, expectedContributor } = params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  if (!ethers.isAddress(poolContractAddress) || !ethers.isAddress(expectedContributor)) return null;

  const provider = getEvmProvider(chainId);
  if (!provider) return null;

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch {
    return null;
  }
  if (!receipt || receipt.status !== 1) return null;

  const wantAddr = poolContractAddress.toLowerCase();
  const wantContributor = expectedContributor.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = poolEventInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'PoolContribution' && parsed?.name !== 'PoolContributionPVT') continue;
    if (String(parsed.args.contributor).toLowerCase() !== wantContributor) continue;
    return String(parsed.args.poolId).toLowerCase();
  }
  return null;
}

export interface VerifyEvmPoolContributionParams {
  chainId: number;
  txHash: string;
  poolContractAddress: string;
  /** The contributor EOA that must have contributed (PoolContribution.contributor == msg.sender). */
  expectedContributor: string;
  /** Pool currency — selects the USDC vs PVT contribution event variant. */
  currency: 'usdc' | 'pvt';
  /** Required when currency === 'usdc'. USD float (this contribution's amount). */
  expectedAmountUsdc?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedAmountPvtWei?: bigint;
  minConfirmations?: number;
}

export interface PoolContributionVerificationResult extends TxVerificationResult {
  /**
   * The on-chain bytes32 poolId from the matched PoolContribution event
   * (0x-lowercased). Present only on ok:true — the caller binds the Firestore pool
   * to it (first contributor establishes it; later contributors must match).
   */
  poolId?: string;
}

/**
 * Verify that a transaction is a REAL on-chain `ProvianPool.contribute(bytes32,uint256)`
 * — a successful call that emitted a `PoolContribution`/`PoolContributionPVT` event
 * from the pool contract crediting `expectedContributor` exactly `expectedAmount` —
 * and return the on-chain bytes32 poolId it targeted.
 *
 * The entry-side mirror of `verifyEvmPoolWithdrawal`. It closes the gap where the
 * prior contribute path verified only a bare ERC-20 `Transfer` into the pool
 * contract (`verifyTransfer`): a bare `usdc.transfer(poolContract, amount)` moves
 * funds into the contract's balance but never calls `contribute()`, so the sender
 * is NOT credited to `contributions[poolId]` / `contributorList` on-chain and can
 * neither withdraw nor be refunded — yet it used to pass and get recorded as a
 * Firestore contributor. Requiring the `PoolContribution` event (emitted AFTER the
 * contract's own `transferFrom`, so its presence proves the funds moved) makes every
 * recorded contributor a real on-chain contributor bound to a specific poolId. Fails
 * closed on any mismatch.
 */
export async function verifyEvmPoolContribution(
  params: VerifyEvmPoolContributionParams,
): Promise<PoolContributionVerificationResult> {
  const { chainId, txHash, poolContractAddress, expectedContributor, currency } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(poolContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedContributor)) return { ok: false, reason: 'invalid_address_format' };

  let expectedAtomic: bigint;
  if (currency === 'pvt') {
    if (params.expectedAmountPvtWei === undefined || params.expectedAmountPvtWei <= 0n) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = params.expectedAmountPvtWei;
  } else {
    if (
      params.expectedAmountUsdc === undefined ||
      !Number.isFinite(params.expectedAmountUsdc) ||
      params.expectedAmountUsdc <= 0
    ) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = usdcToAtomic(params.expectedAmountUsdc);
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantEvent = currency === 'pvt' ? 'PoolContributionPVT' : 'PoolContribution';
  const wantAddr = poolContractAddress.toLowerCase();
  const wantContributor = expectedContributor.toLowerCase();

  let sawContribution = false;
  let sawContributorMatch = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = poolEventInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== wantEvent) continue;
    sawContribution = true;
    if (String(parsed.args.contributor).toLowerCase() !== wantContributor) continue;
    sawContributorMatch = true;
    let amount: bigint;
    try {
      amount = BigInt(parsed.args.amount);
    } catch {
      continue;
    }
    if (amount !== expectedAtomic) continue;
    return {
      ok: true,
      poolId: String(parsed.args.poolId).toLowerCase(),
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  let reason: string;
  if (!sawContribution) reason = 'pool_contribution_event_not_found';
  else if (!sawContributorMatch) reason = 'pool_contribution_contributor_mismatch';
  else reason = 'pool_contribution_amount_mismatch';
  return { ok: false, reason, blockNumber: receipt.blockNumber, confirmations };
}

export interface VerifyEvmPoolWithdrawalParams {
  chainId: number;
  txHash: string;
  poolContractAddress: string;
  /** The contributor EOA that must have withdrawn (PoolWithdrawal.contributor == msg.sender). */
  expectedContributor: string;
  /** Pool currency — selects the USDC vs PVT withdrawal event variant. */
  currency: 'usdc' | 'pvt';
  /** Required when currency === 'usdc'. USD float (the full contributed balance). */
  expectedAmountUsdc?: number;
  /** Required when currency === 'pvt'. BigInt 18-decimal atomic units. */
  expectedAmountPvtWei?: bigint;
  /**
   * On-chain bytes32 poolId to bind the withdrawal to (recovered from the
   * contributor's own contribution tx). When provided, the PoolWithdrawal event's
   * poolId MUST match — so a same-contract withdrawal from a DIFFERENT pool for the
   * same amount cannot satisfy this pool's exit. Omit only when unrecoverable
   * (legacy / RPC-degraded); the contributor + amount + pool-contract match still holds.
   */
  expectedPoolId?: string;
  minConfirmations?: number;
}

/**
 * Verify that a transaction is the contributor's REAL on-chain
 * `ProvianPool.withdrawContribution(bytes32)` — a successful call that emitted a
 * `PoolWithdrawal`/`PoolWithdrawalPVT` event from the pool contract crediting
 * `expectedContributor` exactly `expectedAmount`.
 *
 * `withdrawContribution` is `msg.sender`-bound on-chain, so the event's
 * `contributor` IS the withdrawing EOA — matching it to the relay-authenticated
 * wallet address proves the wallet withdrew its OWN funds (no keeper can do this
 * on a contributor's behalf; the withdraw is agent-signed, backend-verified — the
 * exact contribute/execute tx_hash model). Fails closed on any mismatch.
 */
export async function verifyEvmPoolWithdrawal(
  params: VerifyEvmPoolWithdrawalParams,
): Promise<TxVerificationResult> {
  const { chainId, txHash, poolContractAddress, expectedContributor, currency } = params;
  const minConfirmations = requiredConfirmations(chainId, params.minConfirmations);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format' };
  if (!ethers.isAddress(poolContractAddress)) return { ok: false, reason: 'invalid_contract_address' };
  if (!ethers.isAddress(expectedContributor)) return { ok: false, reason: 'invalid_address_format' };

  let expectedAtomic: bigint;
  if (currency === 'pvt') {
    if (params.expectedAmountPvtWei === undefined || params.expectedAmountPvtWei <= 0n) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = params.expectedAmountPvtWei;
  } else {
    if (
      params.expectedAmountUsdc === undefined ||
      !Number.isFinite(params.expectedAmountUsdc) ||
      params.expectedAmountUsdc <= 0
    ) {
      return { ok: false, reason: 'invalid_expected_amount' };
    }
    expectedAtomic = usdcToAtomic(params.expectedAmountUsdc);
  }

  const provider = getEvmProvider(chainId);
  if (!provider) return { ok: false, reason: 'no_provider_for_chain' };

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    return { ok: false, reason: `rpc_error: ${(err as Error).message}` };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_failed' };

  let confirmations = 0;
  try {
    confirmations = await receiptConfirmations(chainId, txHash, receipt);
  } catch {
    confirmations = 0;
  }
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      reason: `insufficient_confirmations: ${confirmations}/${minConfirmations}`,
      blockNumber: receipt.blockNumber,
      confirmations,
    };
  }

  const wantEvent = currency === 'pvt' ? 'PoolWithdrawalPVT' : 'PoolWithdrawal';
  const wantAddr = poolContractAddress.toLowerCase();
  const wantContributor = expectedContributor.toLowerCase();
  const wantPoolId = params.expectedPoolId
    ? params.expectedPoolId.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    : undefined;

  let sawWithdrawal = false;
  let sawContributorMatch = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = poolEventInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== wantEvent) continue;
    sawWithdrawal = true;
    if (String(parsed.args.contributor).toLowerCase() !== wantContributor) continue;
    sawContributorMatch = true;
    if (wantPoolId !== undefined) {
      const evPoolId = String(parsed.args.poolId).replace(/^0x/, '').toLowerCase().padStart(64, '0');
      if (evPoolId !== wantPoolId) continue;
    }
    let amount: bigint;
    try {
      amount = BigInt(parsed.args.amount);
    } catch {
      continue;
    }
    if (amount !== expectedAtomic) continue;
    return { ok: true, blockNumber: receipt.blockNumber, confirmations };
  }

  let reason: string;
  if (!sawWithdrawal) reason = 'pool_withdrawal_event_not_found';
  else if (!sawContributorMatch) reason = 'pool_withdrawal_contributor_mismatch';
  else reason = 'pool_withdrawal_amount_or_poolid_mismatch';
  return { ok: false, reason, blockNumber: receipt.blockNumber, confirmations };
}

export interface ReadOnchainPoolStatusParams {
  chainId: number;
  poolContractAddress: string;
  onchainPoolId: string;
}

/**
 * Read a pool's on-chain Status enum (0..4) version-agnostically. `status` is
 * word index 6 of the `pools(bytes32)` public getter in BOTH V2 (7 words) and V3
 * (8 words) — identical first seven words — so reading word 6 is correct for
 * both without ABI-decoding the whole tuple. Returns null on a too-short/
 * unreadable return (caller treats it as a failed read → fail-closed).
 */
export async function readOnchainPoolStatus(
  params: ReadOnchainPoolStatusParams,
): Promise<number | null> {
  const { chainId, poolContractAddress, onchainPoolId } = params;
  const provider = getEvmProvider(chainId);
  if (!provider) return null;
  const data = POOLS_GETTER_SELECTOR + onchainPoolId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  let raw: string;
  try {
    raw = await provider.call({ to: poolContractAddress, data });
  } catch {
    return null;
  }
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (body.length < 7 * 64) return null; // not enough words to contain status@6
  return parseInt(body.slice(6 * 64, 7 * 64), 16);
}

/**
 * True iff a receipt carries a `PoolRefunded`/`PoolRefundedPVT` event emitted by
 * the pool contract for the given on-chain poolId. Used by the pool keeper to
 * confirm the refund actually landed on-chain before the scheduler flips Firestore
 * / emits a pool_refunded PE — never assert a refund the chain didn't emit.
 */
export function poolRefundedEventMatches(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
  poolContractAddress: string,
  onchainPoolId: string,
): boolean {
  const wantAddr = poolContractAddress.toLowerCase();
  const wantPoolId = onchainPoolId.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  for (const log of logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = poolEventInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'PoolRefunded' && parsed?.name !== 'PoolRefundedPVT') continue;
    const evPoolId = String(parsed.args.poolId).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    if (evPoolId === wantPoolId) return true;
  }
  return false;
}

/**
 * Live ERC-20 `totalSupply()` read (A6,) — the Commons Bank PVT supply
 * tile's data source. Null on any failure (no provider, RPC error): the caller
 * renders an honest absence rather than a fabricated figure.
 */
export async function readErc20TotalSupply(
  chainId: number,
  tokenAddress: string,
): Promise<bigint | null> {
  const provider = getEvmProvider(chainId);
  if (!provider) return null;
  try {
    const token = new ethers.Contract(
      tokenAddress,
      ['function totalSupply() view returns (uint256)'],
      provider,
    );
    const supply: unknown = await token.totalSupply();
    return typeof supply === 'bigint' ? supply : null;
  } catch {
    return null;
  }
}
