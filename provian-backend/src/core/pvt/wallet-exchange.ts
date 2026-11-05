/**
 * ONE swap classification for every lane.
 *
 * the invariant: prices sends,
 * receives and swaps at the same financial base (20000 bps each). What differs
 * is the LABEL, and with it the daily ceiling the act counts against
 * (`send` 25 with the verified-counterparty requirement, `swap` 25, `receive`
 * 50 with receive authorship). labelled an exchange through 0x as a swap
 * only in the chain-record lane; the outbound USDC watcher called a USDC → WETH
 * trade through 0x AllowanceHolder a `send`, because its router list held only
 * the Uniswap routers. This module is the single answer all three lanes read:
 *
 * A transaction is the wallet's EXCHANGE when the wallet signed it, its target
 * is a known swap target (the Uniswap routers on Base, or 0x AllowanceHolder —
 * the route the relay quotes both the app and agents), and the wallet received
 * a known asset different from the one it gave. A native ↔ WETH wrap is not an
 * exchange. A swap INTO native ETH ( , defect 3) shows no
 * Transfer to the wallet — the ETH arrives as an internal transfer — so it is
 * recognised by the WETH unwrap that pays it: the wallet gave a known asset
 * other than WETH and, in the same transaction, someone other than the wallet
 * unwrapped a non-zero amount of WETH (WETH9 `Withdrawal`). The asset "given" is the carrier leg: the native value when there
 * is one, else the wallet's first outbound Transfer that moves a non-zero amount
 * to someone else (the and 2 rules, unchanged).
 *
 * Every lane labels every leg of an exchange `swap`, and keys it on the BARE
 * TRANSACTION HASH (`observedCanonicalEventId`), so the unchanged
 * financial-settlement mint-once claim (settling address, canonical event)
 * collapses every swap-labelled PE of one transaction onto one mint, whichever
 * lane sealed it. What a swap mints is unchanged: the same base, the same fences.
 *
 * Pure: reads only final chain facts (`BaseTransactionEvidence`).
 */

import { BASE_USDC_ADDRESS, ERC20_TRANSFER_TOPIC, type BaseTransactionEvidence, type ChainTransactionEvidence, type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { PVT9_BASE_CONFIG } from './pvt9-base-config.generated';

/** Uniswap routers on Base (moved here from `OUTBOUND_CHAIN_CONFIGS.base.dexRouters`,
 * which now reads this set). */
export const BASE_UNISWAP_ROUTERS: ReadonlySet<string> = new Set<string>([
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap SwapRouter02 (Base)
  '0x6ff5693b99212da76ad316178a184ab56d299b43', // Uniswap Universal Router (Base)
  '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc', // Uniswap Universal Router v1.2 (Base)
]);

/** 0x AllowanceHolder (Base) — the target of every swap the relay quotes
 * (`provian-agent-sdk/src/zerox-swap-guard.ts` ZEROX_ALLOWANCE_HOLDER; the app's
 * `SwapEngine` sends to the quote's `to`, the same contract). */
export const ZEROX_ALLOWANCE_HOLDER_BASE = '0x0000000000001ff3684f28c67538d4d072c22734';

/** Every known swap target on Base. */
export const BASE_SWAP_TARGETS: ReadonlySet<string> = new Set<string>([
  ...BASE_UNISWAP_ROUTERS,
  ZEROX_ALLOWANCE_HOLDER_BASE,
]);

/** The live PVT9 kernel (the token) from `config/pvt9-base.json`, lowercased;
 * null when the config names none (then PVT is simply not a known asset). */
export const LIVE_PVT9_TOKEN: string | null = (() => {
  const address: unknown = PVT9_BASE_CONFIG.assets.pvt9.address;
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
})();

export const WETH_BASE = '0x4200000000000000000000000000000000000006';

/**
 * The known NON-USDC Base assets. Addresses mirror `TOKEN_ADDRESSES[8453]`
 * (src/core/chains/evm/config.ts) and the live PVT9 kernel. USDC is kept apart
 * because its legs belong to the USDC watchers. An unknown token never mints
 * (Unknown = Block).
 */
export const BASE_NON_USDC_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  ...(LIVE_PVT9_TOKEN ? { [LIVE_PVT9_TOKEN]: 'PVT' } : {}),
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  [WETH_BASE]: 'WETH',
});

export function isKnownBaseAsset(token: string): boolean {
  return token === BASE_USDC_ADDRESS || token in BASE_NON_USDC_ASSETS;
}

export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
}

/**
 * The well-formed ERC-20 Transfer logs of a receipt (exactly three topics and one
 * 32-byte amount word). Any contract can emit the Transfer signature with
 * arbitrary data; an empty or odd payload is skipped, never parsed (review
 * round 3).
 */
export function wellFormedTransfers(evidence: ChainTransactionEvidence): readonly CanonicalEconomicLog[] {
  return evidence.logs.filter((log) => !log.removed
    && log.topics.length === 3
    && log.topics[0] === ERC20_TRANSFER_TOPIC
    && /^0x[0-9a-f]{64}$/.test(log.data));
}

/** keccak256("Withdrawal(address,uint256)") — WETH9's unwrap event. */
export const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** A leg moves a non-zero amount between two DIFFERENT parties ( ). */
export function movesValue(log: CanonicalEconomicLog): boolean {
  return BigInt(log.data) > 0n && log.topics[1] !== log.topics[2];
}

export type ExchangeCarrier =
  | { readonly kind: 'native'; readonly amountWei: bigint }
  | { readonly kind: 'erc20'; readonly log: CanonicalEconomicLog };

export type WalletExchangeVerdict =
  | { readonly exchange: true; readonly carrier: ExchangeCarrier }
  | { readonly exchange: false; readonly reason: string };

/**
 * What the exchange rule reads about one chain: its swap targets, which tokens
 * are known assets there, and its wrapped native token. Base's profile is the
 * constants above; other chains' profiles live in `chain-record-chains.ts`.
 */
export interface ExchangeProfile {
  readonly swapTargets: ReadonlySet<string>;
  readonly isKnownAsset: (token: string) => boolean;
  readonly weth: string;
}

export const BASE_EXCHANGE_PROFILE: ExchangeProfile = Object.freeze({
  swapTargets: BASE_SWAP_TARGETS,
  isKnownAsset: isKnownBaseAsset,
  weth: WETH_BASE,
});

/**
 * Is this transaction `wallet`'s exchange? See the module header for the rule.
 * `profile` names the chain's swap targets and known assets (Base by default).
 */
export function classifyWalletExchange(
  evidence: ChainTransactionEvidence,
  walletAddress: string,
  profile: ExchangeProfile = BASE_EXCHANGE_PROFILE,
): WalletExchangeVerdict {
  const wallet = walletAddress.toLowerCase();
  if (evidence.fromAddress !== wallet) return { exchange: false, reason: 'sender_not_wallet' };
  const to = evidence.toAddress;
  if (to === null || !profile.swapTargets.has(to)) return { exchange: false, reason: 'not_a_swap_target' };
  const walletTopic = addressTopic(wallet);
  const transfers = wellFormedTransfers(evidence);
  const outbound = transfers.filter((log) => log.topics[1] === walletTopic && movesValue(log));
  const inbound = transfers.filter((log) => log.topics[2] === walletTopic && movesValue(log));
  // A swap into native ETH is not visible in logs and is not recognised.
  const receivedOther = (given: string | null): boolean => inbound.some((log) => profile.isKnownAsset(log.address)
    && log.address !== given
    && !(given === null && log.address === profile.weth));
  // Swap into native ETH: a non-zero WETH unwrap by someone other than the
  // wallet (a router / settler paying out ETH). Only well-formed WETH9 events.
  const unwrappedToEth = evidence.logs.some((log) => !log.removed
    && log.address === profile.weth
    && log.topics.length === 2
    && log.topics[0] === WETH_WITHDRAWAL_TOPIC
    && log.topics[1] !== walletTopic
    && /^0x[0-9a-f]{64}$/.test(log.data)
    && BigInt(log.data) > 0n);
  const value = BigInt(evidence.valueWei);
  if (value > 0n) {
    return receivedOther(null)
      ? { exchange: true, carrier: { kind: 'native', amountWei: value } }
      : { exchange: false, reason: 'swap_without_exchange' };
  }
  const first = outbound[0];
  if (!first) return { exchange: false, reason: 'swap_without_outbound_leg' };
  if (!profile.isKnownAsset(first.address)) return { exchange: false, reason: 'swap_leg_unknown_asset' };
  return receivedOther(first.address) || (unwrappedToEth && first.address !== profile.weth)
    ? { exchange: true, carrier: { kind: 'erc20', log: first } }
    : { exchange: false, reason: 'swap_without_exchange' };
}

/** The LI.FI Diamond — the target of the app's cross-chain swaps on Base, Arbitrum and Optimism. */
export const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

/** keccak256("LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))"):
 * the Diamond emits it when it starts a cross-chain transfer. */
export const LIFI_TRANSFER_STARTED_TOPIC = '0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1';

/**
 * The landing of commerce on Arbitrum One and OP Mainnet, and of cross-chain
 * swaps on every chain. Nothing mined before it mints through these rules, and
 * no sealed record is repriced.
 */
export const MULTICHAIN_COMMERCE_CUT_LINE_MS = Date.UTC(2026, 9, 29, 0, 0, 0);

/**
 * A cross-chain swap the wallet started: it signed a call to the LI.FI Diamond,
 * mined at or after the landing, and the Diamond itself emitted
 * `LiFiTransferStarted` in that transaction — the chain's own record that a
 * transfer to another chain began. The proceeds land on the other chain in a
 * transaction the wallet did not sign. A Diamond call without that event is
 * not a cross-chain swap (it can still be a same-chain exchange by the ordinary rule).
 */
export function isWalletBridgeSwap(evidence: ChainTransactionEvidence, walletAddress: string): boolean {
  return evidence.fromAddress === walletAddress.toLowerCase()
    && evidence.toAddress === LIFI_DIAMOND
    && evidence.blockTimestampMs >= MULTICHAIN_COMMERCE_CUT_LINE_MS
    && evidence.logs.some((log) => !log.removed
      && log.address === LIFI_DIAMOND
      && log.topics[0] === LIFI_TRANSFER_STARTED_TOPIC);
}

/**
 * The landing of. The new label in the USDC watchers, a human's sends and
 * swaps, and every non-USDC receive apply only to transactions mined at or after
 * this instant: nothing sealed before it is repriced, and a USDC-watcher claim
 * that began before it keeps the label it was first sealed with (its PE id is
 * deterministic, so a retry must derive the same content).
 */
export const VERIFIED_COMMERCE_CUT_LINE_MS = Date.UTC(2026, 9, 1, 4, 0, 0);

/** Minimal USDC-leg facts the USDC watchers already hold. */
export interface UsdcLegTransactionFacts {
  readonly transactionHash: string;
  readonly blockTimestampMs: number;
  readonly transactionSubmitter: string | null;
  readonly transactionTo: string | null;
}

export function isAtOrAfterCommerceCutLine(blockTimestampMs: number): boolean {
  return blockTimestampMs >= VERIFIED_COMMERCE_CUT_LINE_MS;
}

/**
 * The USDC watchers' swap label (outbound and inbound alike), for a leg mined at
 * or after the landing. False without a second read when the transaction
 * cannot be the wallet's exchange (not signed by the wallet, or not to a swap
 * target), so only a transaction to a swap target costs the whole-transaction
 * read. A read that fails throws, and the watcher's claim stays pending
 * (Unknown = Block, never a guessed label).
 */
export async function usdcLegIsWalletExchange(
  facts: UsdcLegTransactionFacts,
  walletAddress: string,
  readTransaction: ((txHash: string) => Promise<BaseTransactionEvidence>) | undefined,
): Promise<boolean> {
  if (!isAtOrAfterCommerceCutLine(facts.blockTimestampMs)) return false;
  if (facts.transactionSubmitter?.toLowerCase() !== walletAddress.toLowerCase()) return false;
  const to = facts.transactionTo?.toLowerCase() ?? null;
  // a USDC leg into the LI.FI Diamond from the multichain landing: a cross-chain
  // swap (or a same-chain exchange) is a swap here too, as in the chain-record lane.
  const viaDiamond = to === LIFI_DIAMOND && facts.blockTimestampMs >= MULTICHAIN_COMMERCE_CUT_LINE_MS;
  if (to === null || (!BASE_SWAP_TARGETS.has(to) && !viaDiamond)) return false;
  if (!readTransaction) throw new Error('wallet_exchange_transaction_reader_unavailable');
  const evidence = await readTransaction(facts.transactionHash);
  if (evidence.transactionHash !== facts.transactionHash.toLowerCase()) {
    throw new Error('wallet_exchange_evidence_mismatch');
  }
  if (viaDiamond) {
    return isWalletBridgeSwap(evidence, walletAddress)
      || classifyWalletExchange(evidence, walletAddress, { ...BASE_EXCHANGE_PROFILE, swapTargets: new Set([LIFI_DIAMOND]) }).exchange;
  }
  return classifyWalletExchange(evidence, walletAddress).exchange;
}
