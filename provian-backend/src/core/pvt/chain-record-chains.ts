/**
 * THE CHAINS THE CHAIN-RECORD LANE READS, AND WHAT IT KNOWS ABOUT EACH.
 *
 * The rule is the same on every chain the wallet sends, receives or swaps on:
 * a chain-verified send, a receive from a counterparty the recipient has dealt
 * with, and a swap mint at the financial base under the per-actor daily
 * ceilings; a first receive from a stranger records only. What differs per
 * chain is only the facts the derivation reads:
 *
 * - `assets`: the tokens the wallet holds there, which can be this lane's act.
 *   On Base, USDC is absent on purpose (its legs belong to the USDC watchers);
 *   on Arbitrum One and OP Mainnet there are no USDC watchers, so USDC is an
 *   ordinary asset of this lane. An unknown token never mints (Unknown = Block).
 *   The lists mirror the wallet's own token table (`TOKEN_ADDRESSES` in
 *   `src/core/chains/evm/config.ts`) plus the tokens the app's swap screen
 *   offers there (ARB, OP).
 * - `swapTargets`: the contracts an exchange is sent to (the Uniswap routers the
 *   app and agents use there, and 0x AllowanceHolder, the same address on every
 *   chain).
 * - `bridgeTargets`: the LI.FI Diamond, the same address on all three chains,
 *   which the app's cross-chain swaps are sent to. When the Diamond emits
 *   `LiFiTransferStarted` in the wallet's own transaction, the wallet's outbound
 *   leg into it is the swap; its proceeds arrive on the other chain in a
 *   transaction the wallet did not sign (a receive from a stranger, which
 *   records only). Any other Diamond call is a swap only by the ordinary
 *   exchange rule.
 * - `excludedCounterparties` / `institutionTargets`: the zero address and the
 *   Provian contracts on that chain.
 *
 * Base's profile is assembled from the lane's existing Base constants, so Base
 * behaviour is unchanged by this module.
 */

import { BASE_USDC_ADDRESS } from '../onchain/economic-discovery';
import {
  BASE_NON_USDC_ASSETS,
  BASE_SWAP_TARGETS,
  LIFI_DIAMOND,
  MULTICHAIN_COMMERCE_CUT_LINE_MS,
  WETH_BASE,
  ZEROX_ALLOWANCE_HOLDER_BASE,
  isKnownBaseAsset,
  type ExchangeProfile,
} from './wallet-exchange';

export type ChainRecordChainName = 'base' | 'arbitrum' | 'optimism';

export interface ChainRecordChainProfile extends ExchangeProfile {
  readonly chain: ChainRecordChainName;
  readonly chainId: 8453 | 42161 | 10;
  /** Known assets whose legs are this lane's acts, lowercased address → symbol. */
  readonly assets: Readonly<Record<string, string>>;
  /** A token whose legs belong to another lane on this chain (Base USDC), else null. */
  readonly otherLaneToken: string | null;
  readonly bridgeTargets: ReadonlySet<string>;
  /** Counterparties that are never a send or receive on this chain. */
  readonly excludedCounterparties: ReadonlySet<string>;
  /** Transaction targets whose transaction is a Provian institution's act. */
  readonly institutionTargets: ReadonlySet<string>;
}

export { LIFI_DIAMOND, MULTICHAIN_COMMERCE_CUT_LINE_MS };

/** The EscrowV4 deployment on Arbitrum One and OP Mainnet (`contracts/deployments/{arbitrum,optimism}-live.json`). */
export const ESCROW_V4_ARBITRUM_OPTIMISM = '0x73934580ecfd8bf1f689f73205a2e681feaa54af';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const ARBITRUM_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': 'ARB',
});

const OPTIMISM_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC',
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'USDC.e',
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'USDT',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x4200000000000000000000000000000000000042': 'OP',
});

/** Uniswap SwapRouter02 — the same address on Arbitrum One and OP Mainnet. */
const UNISWAP_SWAP_ROUTER_02_ARB_OP = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';

const ARBITRUM_SWAP_TARGETS: ReadonlySet<string> = new Set<string>([
  UNISWAP_SWAP_ROUTER_02_ARB_OP,
  '0x5e325eda8064b456f4781070c0738d849c824258', // Uniswap Universal Router (the app's router on Arbitrum)
  ZEROX_ALLOWANCE_HOLDER_BASE, // 0x AllowanceHolder: the same address on every chain
]);

const OPTIMISM_SWAP_TARGETS: ReadonlySet<string> = new Set<string>([
  UNISWAP_SWAP_ROUTER_02_ARB_OP,
  '0xcb1355ff08ab38bbce60111f1bb2b784be25d7e8', // Uniswap Universal Router (the app's router on Optimism)
  ZEROX_ALLOWANCE_HOLDER_BASE,
]);

function otherChainProfile(
  chain: 'arbitrum' | 'optimism',
  chainId: 42161 | 10,
  assets: Readonly<Record<string, string>>,
  swapTargets: ReadonlySet<string>,
  weth: string,
): ChainRecordChainProfile {
  const provian = new Set<string>([ESCROW_V4_ARBITRUM_OPTIMISM]);
  return Object.freeze({
    chain,
    chainId,
    assets,
    otherLaneToken: null,
    swapTargets,
    bridgeTargets: new Set<string>([LIFI_DIAMOND]),
    isKnownAsset: (token: string) => token in assets,
    weth,
    excludedCounterparties: new Set<string>([ZERO_ADDRESS, ...provian]),
    institutionTargets: provian,
  });
}

export const ARBITRUM_CHAIN_RECORD_PROFILE: ChainRecordChainProfile = otherChainProfile(
  'arbitrum', 42161, ARBITRUM_ASSETS, ARBITRUM_SWAP_TARGETS, '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
);

export const OPTIMISM_CHAIN_RECORD_PROFILE: ChainRecordChainProfile = otherChainProfile(
  'optimism', 10, OPTIMISM_ASSETS, OPTIMISM_SWAP_TARGETS, '0x4200000000000000000000000000000000000006',
);

/**
 * Base, from the lane's existing constants. `excludedCounterparties` and
 * `institutionTargets` are filled in by `chain-record-watcher.ts`, which owns the
 * Base institution sets (they import the institution watchers).
 */
export function baseChainRecordProfile(
  excludedCounterparties: ReadonlySet<string>,
  institutionTargets: ReadonlySet<string>,
): ChainRecordChainProfile {
  return Object.freeze({
    chain: 'base' as const,
    chainId: 8453 as const,
    assets: BASE_NON_USDC_ASSETS,
    otherLaneToken: BASE_USDC_ADDRESS,
    swapTargets: BASE_SWAP_TARGETS,
    bridgeTargets: new Set<string>([LIFI_DIAMOND]),
    isKnownAsset: isKnownBaseAsset,
    weth: WETH_BASE,
    excludedCounterparties,
    institutionTargets,
  });
}

/** The chain ids the lane reads besides Base. */
export const OTHER_CHAIN_RECORD_PROFILES: Readonly<Record<number, ChainRecordChainProfile>> = Object.freeze({
  42161: ARBITRUM_CHAIN_RECORD_PROFILE,
  10: OPTIMISM_CHAIN_RECORD_PROFILE,
});
