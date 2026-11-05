/**
 * EVM token + contract allowlist for the agent sovereign-wallet signer.
 *
 * This is the SDK's OWN pinned copy of the canonical token addresses. It is a
 * deliberate duplicate of the mobile app's `src/core/chains/evm/config.ts`
 * `TOKEN_ADDRESSES`, NOT an import: that mobile file participates in a
 * React-Native module graph (it dynamically imports NotificationService /
 * walletStore and a runtime token-override layer) and cannot be pulled into a
 * Node package. Keeping a small, audited copy here is the safe choice.
 *
 * SECURITY: the agent's sovereign key is ungoverned ("agent's money, agent's
 * rules" - no AAG, kill switch, or friction gate its own spending). That means
 * the SDK's code surface is the ONLY safety boundary. This allowlist is that
 * boundary: `transferToken` will only move an allowlisted token, and
 * `sendTransaction` blocks a non-allowlisted `to` target unless the CALLER
 * explicitly opts out (never an attacker- or argument-supplied default).
 *
 * Addresses verbatim from src/core/chains/evm/config.ts TOKEN_ADDRESSES
 * (Base/Arbitrum/Optimism). Decimals are the standard ERC-20 values for these
 * specific deployed contracts (Circle USDC = 6, Tether USDT = 6, ProvianPVT =
 * 18); the mobile app reads `decimals()` on-chain at runtime rather than
 * hardcoding them, so confirm against the contract if changing this table.
 */
import { base, arbitrum, optimism, type Chain as ViemChain } from 'viem/chains';
import { resolveBondPoolAddress, resolveEscrowUsdcAddress, resolvePoolAddress } from './contract-addresses';

/** Mainnets the signer supports today. */
export type SupportedChain = 'base' | 'arbitrum' | 'optimism';

/** Tokens the signer will move via `transferToken`. */
export type AllowlistedToken = 'PVT' | 'USDC' | 'USDT';

export interface TokenInfo {
  symbol: AllowlistedToken;
  /** Canonical contract address on the chain (EIP-55 checksummed). */
  address: `0x${string}`;
  /** ERC-20 decimals for this specific deployed contract. */
  decimals: number;
}

/** Numeric chain ids, mirroring viem's chain definitions. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
};

/** viem chain objects, indexed by our chain name. */
export const VIEM_CHAINS: Record<SupportedChain, ViemChain> = {
  base,
  arbitrum,
  optimism,
};

/**
 * Pinned token addresses per chain.
 *
 * PVT on Base is the LIVE PVT9 successor kernel
 * `0x8811441914381143b9408c5C32247367F86F173A` (successor; every balance migrated
 * 1:1). The kernel `0x4Bf02d5C…` it replaced is HELD with its minter revoked, and
 * PVT on it is no longer the network's token.
 *
 * It used to be PVTv8 `0x50D6F1Ff…4BAa` (the 2026-06-26 EOA-admin cascade).
 * That was correct through the Pass-3 redeploy and went stale at the
 * succession, which cut the kernel over and did not update this literal — the
 * token allowlist was excluded from the `contract-addresses.ts` consolidation
 * (that module resolves protocol CONTRACTS, not tokens, so no per-file literal
 * survived there while this one did). PVTv8 is now a RETIRED token and sits in
 * `config/pvt9-base.json` → `validation.forbidden_pvt_addresses`. Leaving it
 * here pointed the ungoverned agent signer — the surface this file calls "the
 * ONLY safety boundary" at a dead token: `transferToken(PVT)` would have
 * moved retired PVTv8, `CommonsInstitutions.postBond` would have approved it, and the
 * live kernel would have been rejected as an unlisted target.
 *
 * Arbitrum / Optimism still name PVTv4 `0x9193BD19…50bd3`. PVT consolidated to
 * Base-only on 2026-05-12, so those two entries are dead weight; they are left
 * UNCHANGED here deliberately rather than swept in on a Base-scoped fix — see
 * the note in OPEN_ITEMS.md.
 */
export const TOKEN_ALLOWLIST: Record<SupportedChain, Record<AllowlistedToken, TokenInfo>> = {
  base: {
    USDC: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    USDT: { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    PVT: { symbol: 'PVT', address: '0x8811441914381143b9408c5C32247367F86F173A', decimals: 18 },
  },
  arbitrum: {
    USDC: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    PVT: { symbol: 'PVT', address: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3', decimals: 18 },
  },
  optimism: {
    USDC: { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    PVT: { symbol: 'PVT', address: '0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3', decimals: 18 },
  },
};

/**
 * Non-token contracts the agent may legitimately call directly. Addresses are
 * resolved from the single source of truth in `contract-addresses.ts` (env
 * override → deployment-JSON default) — NOT local literals — so the live
 * BondPool `0x6b09E9C7…` and EscrowV4 `0x96560fDF…` are allowlisted and the
 * retired, Pass-3 and PVTv8-cascade contracts are not. Ships the
 * live BondPool on Base so the postBond/renewBond helpers have an allowlisted target,
 * plus the USDC-principal escrow contracts on every chain so
 * CommonsInstitutions.releaseEscrow's depositor-side ProvianEscrow.releaseEscrow(bytes32)
 * broadcast passes the `sendTransaction` guard. The guard treats these as
 * allowed `to` addresses alongside the tokens above. (PVT-principal escrows
 * are Base-only on the same institution deployment EscrowV4 — B15,; see evm-escrow.ts.)
 */
function baseContractAllowlist(): Record<string, `0x${string}`> {
  const entries: Record<string, `0x${string}`> = {};
  const bondPool = resolveBondPoolAddress('base');
  if (bondPool) entries.BondPool = bondPool;
  const escrow = resolveEscrowUsdcAddress('base');
  if (escrow) entries.EscrowUSDC = escrow;
  // Capital pool (Pass-3 PoolV3) so CommonsInstitutions.withdrawFromPool's contributor-side
  // ProvianPool.withdrawContribution(bytes32) broadcast passes the sendTransaction
  // target guard (P4-01).
  const pool = resolvePoolAddress('base');
  if (pool) entries.Pool = pool;
  return entries;
}

function escrowContractAllowlist(chain: SupportedChain): Record<string, `0x${string}`> {
  const escrow = resolveEscrowUsdcAddress(chain);
  return escrow ? { EscrowUSDC: escrow } : {};
}

// Built on first ACCESS, never at module import. Resolving an institution
// address reads a deployment artifact (contract-addresses.ts); the self-contained
// bootstrap bundle ships none, and the observer pulls this module in transitively
// (x402-signer → ProvianClient → ProvianObserver). An eager build here read the
// filesystem at import and crashed `agent.js observe` once a real wallet made it
// construct the client. Memoized, so every access returns the same record and the
// artifact is read at most once. Values are unchanged — only the timing moves.
let _contractAllowlist:
  | Record<SupportedChain, Record<string, `0x${string}`>>
  | undefined;
function contractAllowlist(): Record<SupportedChain, Record<string, `0x${string}`>> {
  return (_contractAllowlist ??= {
    base: baseContractAllowlist(),
    arbitrum: escrowContractAllowlist('arbitrum'),
    optimism: escrowContractAllowlist('optimism'),
  });
}
export const CONTRACT_ALLOWLIST: Record<SupportedChain, Record<string, `0x${string}`>> = {
  get base(): Record<string, `0x${string}`> { return contractAllowlist().base; },
  get arbitrum(): Record<string, `0x${string}`> { return contractAllowlist().arbitrum; },
  get optimism(): Record<string, `0x${string}`> { return contractAllowlist().optimism; },
};

export function isSupportedChain(chain: unknown): chain is SupportedChain {
  return chain === 'base' || chain === 'arbitrum' || chain === 'optimism';
}

/**
 * Resolve an allowlisted token on a chain. Throws if the token is not in the
 * allowlist for that chain - this is the runtime half of the `transferToken`
 * guardrail (the type system enforces the compile-time half).
 */
export function getToken(chain: SupportedChain, token: AllowlistedToken): TokenInfo {
  const info = TOKEN_ALLOWLIST[chain]?.[token];
  if (!info) {
    const available = Object.keys(TOKEN_ALLOWLIST[chain] ?? {}).join(', ');
    throw new Error(`token '${String(token)}' is not allowlisted on '${chain}' (available: ${available})`);
  }
  return info;
}

/**
 * Whether `address` is an allowlisted target on `chain` - i.e. one of the
 * pinned token contracts or an allowlisted non-token contract. Case-insensitive.
 */
export function isAllowlistedTarget(chain: SupportedChain, address: string): boolean {
  const needle = address.toLowerCase();
  const tokens = TOKEN_ALLOWLIST[chain] ?? {};
  for (const key of Object.keys(tokens) as AllowlistedToken[]) {
    if (tokens[key].address.toLowerCase() === needle) return true;
  }
  const contracts = CONTRACT_ALLOWLIST[chain] ?? {};
  for (const name of Object.keys(contracts)) {
    if (contracts[name].toLowerCase() === needle) return true;
  }
  return false;
}

/** Human-readable list of allowlisted targets on a chain, for error messages. */
export function allowlistedTargets(chain: SupportedChain): string[] {
  const tokens = TOKEN_ALLOWLIST[chain] ?? {};
  const contracts = CONTRACT_ALLOWLIST[chain] ?? {};
  return [
    ...Object.keys(tokens).map((k) => `${k}=${tokens[k as AllowlistedToken].address}`),
    ...Object.keys(contracts).map((k) => `${k}=${contracts[k]}`),
  ];
}
