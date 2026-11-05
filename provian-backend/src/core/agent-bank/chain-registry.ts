/**
 * Agent Bank chain registry.
 *
 * Wave J-bis (Chunk J HIGH-13): the README, SDK docs, and OpenAPI claim
 * Base / Arbitrum / Optimism support, but the backend was hard-coded to
 * Base on every Agent Bank surface (escrow, promise, pool, court). This
 * module is the single source of truth for:
 *
 *   - Which chains the Agent Bank accepts at the API boundary
 *     (`assertSupportedAgentBankChain`).
 *   - Per-chain contract address resolution for every Agent Bank contract
 *     (Escrow V3 USDC + V4 PVT, Promise V2 USDC + V3 PVT, Pool V2 USDC +
 *     V3 PVT, Court V2). Each resolver reads
 *     `<NAME>_CONTRACT_ADDRESS_BASE / _ARBITRUM / _OPTIMISM` and falls
 *     back to the legacy single-valued env var so single-chain
 *     deployments keep working unchanged.
 *
 * Mirrors the pattern established by `bondPoolAddressForChain` in bonds.ts
 * and the per-chain PVT token map in pvt-principal-config.ts. The on-chain
 * verifier (`core/onchain/tx-verifier.ts`) is already chain-aware on chain
 * id; this module is the chain-name-side counterpart.
 *
 * Supported chains at launch are mainnets only: Base, Arbitrum, Optimism.
 * Testnets remain accepted by the on-chain verifier for dev environments
 * but are not part of the API-side supported list - adding them would
 * require deploying the Agent Bank contracts to each testnet and is out
 * of scope for Wave J-bis.
 */

import { ValidationError } from './errors';
import { pvtPrincipalInstitutionAddress } from './pvt-principal-config';

/**
 * Chains the Agent Bank API accepts at launch. Add a chain here only after
 * (a) the contracts have been deployed to it, (b) per-chain env vars have
 * been set in the production relay, and (c) the addresses have been
 * recorded in `contracts/deployments/<chain>-agent-bank-v4.json` (and the
 * other deployment files as appropriate for non-V4 contracts).
 */
export const SUPPORTED_AGENT_BANK_CHAINS = ['base', 'arbitrum', 'optimism'] as const;
export type AgentBankChain = typeof SUPPORTED_AGENT_BANK_CHAINS[number];

const CHAIN_TO_ID: Record<AgentBankChain, number> = {
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
};

const ID_TO_CHAIN: Record<number, AgentBankChain> = {
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
};

/**
 * Throw a ValidationError when the requested chain is not in
 * `SUPPORTED_AGENT_BANK_CHAINS`. The error message lists the supported
 * chains so SDK callers can surface a useful 400 to the agent.
 *
 * Used at every API boundary that accepts a `chain` field - escrow create,
 * promise create, pool create, and any read path that filters by chain.
 */
export function assertSupportedAgentBankChain(
  chain: string | undefined,
): asserts chain is AgentBankChain {
  if (!chain || !(SUPPORTED_AGENT_BANK_CHAINS as readonly string[]).includes(chain)) {
    throw new ValidationError(
      `UNSUPPORTED_CHAIN: ${chain ?? '<unset>'}. Supported chains: ${SUPPORTED_AGENT_BANK_CHAINS.join(', ')}`,
    );
  }
}

/**
 * Map an Agent Bank chain name to its EVM chain id. Callers should have
 * already validated via `assertSupportedAgentBankChain`.
 */
export function chainIdForName(chain: AgentBankChain): number {
  return CHAIN_TO_ID[chain];
}

/**
 * Reverse lookup: chain id → chain name. Returns `undefined` when the id
 * is not part of the supported set.
 */
export function chainNameForId(chainId: number): AgentBankChain | undefined {
  return ID_TO_CHAIN[chainId];
}

/**
 * Per-chain env-var resolver: reads `<envBase>_<UPPER>` first, falls back
 * to the legacy single-valued `<envBase>` env var. Returns undefined when
 * neither is set, so the caller can decide whether to raise.
 *
 * Mirrors `bondPoolAddressForChain` in bonds.ts.
 */
function readChainAddress(envBase: string, chain: AgentBankChain): string | undefined {
  const perChain = process.env[`${envBase}_${chain.toUpperCase()}`];
  if (perChain) return perChain;
  return process.env[envBase];
}

// ---------------------------------------------------------------------------
// Per-chain Agent Bank contract address resolvers.
//
// Each function returns the configured address for the given chain or
// `undefined` when neither the per-chain nor the legacy env var is set.
// Callers throw a ValidationError when undefined - see `requireAddressOrThrow`.
// ---------------------------------------------------------------------------

/** Escrow V3 (USDC). Legacy: `ESCROW_CONTRACT_ADDRESS`. */
export function escrowUsdcAddressForChain(chain: AgentBankChain): string | undefined {
  return readChainAddress('ESCROW_CONTRACT_ADDRESS', chain);
}

/**
 * Escrow V4 (PVT). When PVT-principal is enabled for this chain, the CANONICAL
 * institution deployment address wins over any env var (4b) — a stale/misconfigured
 * `ESCROW_V4_CONTRACT_ADDRESS[_BASE]` can never re-route a PVT-principal escrow.
 * Env is the fallback only when PVT-principal is disabled or for a chain the
 * canonical config does not cover. Legacy env: `ESCROW_V4_CONTRACT_ADDRESS`.
 */
export function escrowV4AddressForChain(chain: AgentBankChain): string | undefined {
  return pvtPrincipalInstitutionAddress('escrowV4', chain)
    ?? readChainAddress('ESCROW_V4_CONTRACT_ADDRESS', chain);
}

/** Promise V2 (USDC). Legacy: `PROMISE_CONTRACT_ADDRESS`. */
export function promiseUsdcAddressForChain(chain: AgentBankChain): string | undefined {
  return readChainAddress('PROMISE_CONTRACT_ADDRESS', chain);
}

/** Promise V3 (PVT). Canonical institution deployment address wins when PVT-principal is enabled
 * (see `escrowV4AddressForChain`). Legacy env: `PROMISE_V3_CONTRACT_ADDRESS`. */
export function promiseV3AddressForChain(chain: AgentBankChain): string | undefined {
  return pvtPrincipalInstitutionAddress('promiseV3', chain)
    ?? readChainAddress('PROMISE_V3_CONTRACT_ADDRESS', chain);
}

/** Pool V2 (USDC). Legacy: `POOL_V2_CONTRACT_ADDRESS` then `POOL_CONTRACT_ADDRESS`. */
export function poolUsdcAddressForChain(chain: AgentBankChain): string | undefined {
  return readChainAddress('POOL_V2_CONTRACT_ADDRESS', chain)
    ?? readChainAddress('POOL_CONTRACT_ADDRESS', chain);
}

/** Pool V3 (PVT). Canonical institution deployment address wins when PVT-principal is enabled
 * (see `escrowV4AddressForChain`). Legacy env: `POOL_V3_CONTRACT_ADDRESS`. */
export function poolV3AddressForChain(chain: AgentBankChain): string | undefined {
  return pvtPrincipalInstitutionAddress('poolV3', chain)
    ?? readChainAddress('POOL_V3_CONTRACT_ADDRESS', chain);
}

/** Court V2. Legacy: `COURT_CONTRACT_ADDRESS`. */
export function courtAddressForChain(chain: AgentBankChain): string | undefined {
  return readChainAddress('COURT_CONTRACT_ADDRESS', chain);
}

/**
 * Helper for callers that want a hard ValidationError when the chain has
 * no configured address - i.e. a chain is supported in principle but the
 * relay operator has not yet wired the env var. Mirrors the
 * pvt-principal-config "fail loud" pattern.
 */
export function requireAddressOrThrow(
  address: string | undefined,
  contractLabel: string,
  chain: AgentBankChain,
): string {
  if (!address) {
    throw new ValidationError(
      `${contractLabel} address is not configured on this relay for chain ${chain}. ` +
      `Set ${contractLabel}_CONTRACT_ADDRESS_${chain.toUpperCase()} (or legacy single-valued env var) and redeploy.`,
    );
  }
  return address;
}
