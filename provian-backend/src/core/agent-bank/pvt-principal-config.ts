import { currentProtocolDeployment } from '../protocol/runtime';
import { predecessorBurnAcceptances } from '../protocol/predecessor-burns';


/** Chain ids retained for non-PVT callers and display labels. */
export const SUPPORTED_EVM_CHAIN_IDS = [
  8453,
  42161,
  10,
  84532,
  421614,
  11155420,
] as const;

export type SupportedEvmChainId = typeof SUPPORTED_EVM_CHAIN_IDS[number];

export const CHAIN_ID_LABELS: Record<number, string> = {
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
  11155420: 'optimism-sepolia',
};

/**
 * Chain STRING → id. Accepts both the hyphen and underscore testnet spellings
 * that different callers use (`base_sepolia` from tx-verifier, `base-sepolia`
 * from labels). Only Base mainnet is ever PVT-principal-enabled, but the full
 * map is kept so `getPvtAddressForChain` returns a clean `null` (not a throw)
 * for a recognized-but-disabled chain.
 */
const CHAIN_STRING_TO_ID: Record<string, number> = {
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  base_sepolia: 84532,
  'base-sepolia': 84532,
  arbitrum_sepolia: 421614,
  'arbitrum-sepolia': 421614,
  optimism_sepolia: 11155420,
  'optimism-sepolia': 11155420,
};

/**
 * the PREDECESSOR PVT9 kernel. Held, minter revoked, every balance carried
 * 1:1 to the successor from its state at the migration's snapshot block. It is NOT a live
 * token: nothing routes to it, and a transfer on it proves nothing.
 *
 * A BURN on it stays verifiable — the presentations, speech windows and bids it backed are
 * history the relay must keep honouring — but ONLY up to and including the snapshot block.
 * Every predecessor balance at that block was carried, so a burn in a LATER block spent PVT
 * the burner also holds on the successor: accepting it would count that PVT twice.
 */
export const PREDECESSOR_PVT9_KERNEL_BASE = '0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7';
/**
 * the PREDECESSOR EscrowV4. Nothing new is created on it. An escrow the migration
 * left there (USDC principal leaves a non-custodial escrow only to its own parties) keeps being
 * serviced where it was deposited: its document pins `escrow_contract_address` to this address
 * (`resolveEscrowContractForDocument`), and the completion watcher keeps one spec on it.
 */
export const PREDECESSOR_ESCROW_V4_BASE = '0xc738092785698DCfB28af5a016e69c7AD2b97164';
/** The migration snapshot block (contracts/deployments/d486/mainnet/plan.json `snapshotBlock`). */
export const PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK = 51_823_797;

const BASE_CHAIN_ID = 8453;

export interface PvtPrincipalConfig {
  enabled: boolean;
  chains: number[];
  escrowV4Address: string;
  promiseV3Address: string;
  poolV3Address: string;
  pvtAddressByChainId: Record<number, string>;
}

const DISABLED_CONFIG: PvtPrincipalConfig = Object.freeze({
  enabled: false,
  chains: Object.freeze([]) as unknown as number[],
  escrowV4Address: '',
  promiseV3Address: '',
  poolV3Address: '',
  pvtAddressByChainId: Object.freeze({}),
});

function isPvtPrincipalFlagOn(): boolean {
  return process.env.ENABLE_PVT_PRINCIPAL === 'true';
}

/**
 * Return the canonical config for the current env. Computed per call (no cache)
 * so tests and boot both see the live flag; env does not change at runtime.
 */
export async function loadPvtPrincipalConfig(): Promise<PvtPrincipalConfig> {
  if (!isPvtPrincipalFlagOn()) return DISABLED_CONFIG;
  const deployment = await currentProtocolDeployment();
  return { enabled: true, chains: [BASE_CHAIN_ID], escrowV4Address: deployment.addresses.escrow,
    promiseV3Address: deployment.addresses.promises, poolV3Address: deployment.addresses.projectPool,
    pvtAddressByChainId: { [BASE_CHAIN_ID]: deployment.addresses.kernel.toLowerCase() } };
}

/** Compatibility seam for historical tests; there is no environment cache. */
export function _resetPvtPrincipalConfigForTests(): void {
  // Intentionally empty. The config is derived per call from process.env.
}

/**
 * PVT token address for a chain string, or `null` when PVT-principal is
 * disabled or the chain has no configured PVT principal. Returned LOWERCASE
 * (see the ENABLED_CONFIG note).
 */
export async function getPvtAddressForChain(chainString: string): Promise<string | null> {
  if (CHAIN_STRING_TO_ID[chainString] !== BASE_CHAIN_ID) return null;
  const config = await loadPvtPrincipalConfig();
  if (!config.enabled) return null;
  const chainId = CHAIN_STRING_TO_ID[chainString];
  if (chainId === undefined) return null;
  return config.pvtAddressByChainId[chainId] ?? null;
}

/**
 * The PVT token contracts a BURN may be verified against, for a chain string. The live
 * token first (any block); then, on Base, the predecessor kernel for burns mined at
 * or before `PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK`. Empty when PVT-principal is disabled or
 * the chain has none. Addresses lowercase (compared against lowercased log addresses).
 *
 * Burns ONLY. A transfer, an escrow funding or any new value path verifies against the
 * live token alone (`getPvtAddressForChain`).
 */
export interface PvtBurnTokenAcceptance {
  readonly address: string;
  /** Inclusive upper bound on the burn's block; `null` = no bound (the live token). */
  readonly maxBlock: number | null;
}

export async function getAcceptedPvtBurnTokensForChain(chainString: string): Promise<readonly PvtBurnTokenAcceptance[]> {
  const live = await getPvtAddressForChain(chainString);
  if (!live) return [];
  const accepted: PvtBurnTokenAcceptance[] = [{ address: live, maxBlock: null }];
  if (CHAIN_STRING_TO_ID[chainString] === BASE_CHAIN_ID) {
    accepted.push(...await predecessorBurnAcceptances(live));
    accepted.push({ address: PREDECESSOR_PVT9_KERNEL_BASE.toLowerCase(), maxBlock: PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK });
  }
  return accepted;
}

/** True iff PVT-principal is enabled AND the chain string resolves to an enabled chain. */
export function isPvtPrincipalEnabledForChain(chainString: string): boolean {
  return isPvtPrincipalFlagOn() && CHAIN_STRING_TO_ID[chainString] === BASE_CHAIN_ID;
}

/**
 * The single canonical PVT-principal chain string (Base), or `null` when
 * disabled. Base-only, so this is deterministic. Consumed by human-jobs to pick
 * the auto-escrow chain (`null` ⇒ posting closed, Unknown = Block).
 */
export function getPvtPrincipalChainString(): string | null {
  return isPvtPrincipalFlagOn() ? CHAIN_ID_LABELS[BASE_CHAIN_ID] : null;
}

/** Canonical Agent Bank institution address for a chain, or `undefined`. Base-only.
 * `chain-registry.ts` prefers this over env for the V4/V3 (PVT) resolvers. */
export async function pvtPrincipalInstitutionAddress(
  institution: 'escrowV4' | 'promiseV3' | 'poolV3',
  chainString: string,
): Promise<string | undefined> {
  const config = await loadPvtPrincipalConfig();
  if (!config.enabled) return undefined;
  if (CHAIN_STRING_TO_ID[chainString] !== BASE_CHAIN_ID) return undefined;
  switch (institution) {
    case 'escrowV4': return config.escrowV4Address || undefined;
    case 'promiseV3': return config.promiseV3Address || undefined;
    case 'poolV3': return config.poolV3Address || undefined;
  }
}

export function logEnabledCurrenciesPerChain(
  config: PvtPrincipalConfig,
  log: (msg: string) => void = console.log,
): void {
  if (!config.enabled) {
    log('[PvtPrincipal] UNAVAILABLE - PVT-principal has no approved runtime in the current Service; legacy environment flags are ignored.');
    return;
  }
  const chains = config.chains.map((id) => `${CHAIN_ID_LABELS[id] ?? 'chain'}(${id})`).join(',');
  log(
    `[PvtPrincipal] ENABLED chains=${chains} pvt=${config.pvtAddressByChainId[BASE_CHAIN_ID]} `
    + `escrowV4=${config.escrowV4Address} promiseV3=${config.promiseV3Address} poolV3=${config.poolV3Address} `
    + '(canonical institution deployment/PVT9 addresses; legacy env addresses ignored)',
  );
}
