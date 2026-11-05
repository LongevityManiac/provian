/**
 * Single source of truth for SDK contract addresses. Central resolution keeps
 * signers from sending funds into retired contracts the relay no longer indexes.
 * Per-file address copies can silently diverge and make a chain-valid action
 * impossible to record against the active institution.
 *
 * Base defaults come from base-pvt9-institutions.json; Arbitrum and Optimism
 * use their live deployment artifacts. Per-chain environment variables take
 * precedence over legacy names, then the deployment default, matching the
 * relay's resolution order. Retired deployments supply only denial guards.
 *
 * Deployment JSON is loaded at runtime. scripts/copy-assets.js copies those
 * canonical bytes into dist/deployments for the packaged SDK, so there is no
 * separately maintained source mirror.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
// Type-only import (erased at runtime) — avoids any require() cycle with
// evm-allowlist.ts, which imports the value resolvers below.
import type { SupportedChain } from './evm-allowlist';

/**
 * Shape of `contracts/deployments/base-pvt9-institutions.json` (fields we read).
 * The institution deployment institution redeploy nests each contract under an object carrying its
 * observed CREATE `address`; the PVT9 successor kernel is under `successorKernel`.
 */
interface Pvt9InstitutionsDeployment {
  contracts: {
    escrowV4: { address: string };
    promiseV3: { address: string };
    poolV3: { address: string };
    bondPool: { address: string };
    courtV2: { address: string };
  };
  successorKernel: { pvt9Kernel: { address: string } };
  /** The set retired: kernel + verifier HELD, every balance/bond/escrow carried. */
  predecessor: {
    pvt9Kernel: string;
    eligibilityVerifier: string;
    contracts: { escrowV4: string; promiseV3: string; poolV3: string; bondPool: string; courtV2: string };
  };
  /** the PoolV3 (pre-fix S1-A bytecode) replaced in place by a fresh PoolV3; no PVT redeploy. */
  safetyPolicy: { retiredPoolV3: { address: string } };
  shutdownCoverage: { retiredPoolV3: { address: string } };
}

/**
 * Shape of `contracts/deployments/base-retired-addresses.json` (fields we read).
 * Loaded ONLY to derive the retired guard set: `.contracts` are the now-
 * retired institutions, `.retired` the prior PVTv8-cascade quartet,
 * and `.reused.pvtV8` the abandoned PVTv8 kernel.
 */
interface Pass3Deployment {
  contracts: { escrowV4: string; poolV3: string; courtV2: string; bondPool: string };
  reused: { pvtV8: string; promiseV3: string; agentGovernance: string };
  retired: { escrowV4: string; poolV3: string; courtV2: string; bondPool: string };
}

/** Shape of `contracts/deployments/{chain}-chunk-ii.json` (fields we read). */
interface ChunkIIDeployment {
  contracts: { escrowV4: string };
}

/**
 * Candidate locations for a deployment artifact, in resolution order:
 *  - packaged SDK:  <pkg>/dist/deployments/<file>   (copied by copy-assets.js)
 *  - monorepo/test: <repo>/contracts/deployments/<file>   (__dirname = .../src or .../dist)
 * `__dirname` is `.../dist` in the compiled package and `.../src` under vitest.
 * `../../contracts/deployments` resolves to the repo artifacts from either.
 */
function deploymentCandidates(file: string): string[] {
  return [
    join(__dirname, 'deployments', file),
    join(__dirname, '..', '..', 'contracts', 'deployments', file),
  ];
}

/**
 * the self-contained bootstrap bundle ships no `deployments/` directory, but its
 * act verbs (job-fund, bond-post, …) resolve institution addresses. The bundle build
 * embeds the four artifacts through this esbuild `define`; everywhere else (the npm
 * package, vitest) it is undefined and the file candidates below are read as before.
 */
declare const __PROVIAN_EMBEDDED_DEPLOYMENTS__: Record<string, unknown> | undefined;

function embeddedDeployment(file: string): unknown {
  return typeof __PROVIAN_EMBEDDED_DEPLOYMENTS__ !== 'undefined' && __PROVIAN_EMBEDDED_DEPLOYMENTS__ !== null
    ? __PROVIAN_EMBEDDED_DEPLOYMENTS__[file]
    : undefined;
}

function loadDeployment<T>(file: string): T {
  const embedded = embeddedDeployment(file);
  if (embedded !== undefined) return embedded as T;
  const candidates = deploymentCandidates(file);
  for (const path of candidates) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    }
  }
  throw new Error(
    `[contract-addresses] deployment artifact '${file}' not found (looked in: ${candidates.join(', ')})`,
  );
}

// the LIVE Base institution set: EscrowV4 0x96560fDF…, PromiseV3 0x7506F4A0…,
// PoolV3 0x1301BF63… (2026-10-20: Funded pools refundable past their deadline; replaced the
// PoolV3 0xb355C79a…, which never held a pool, itself the S1-A replacement of the 0x68d557e0…), BondPool 0x6b09E9C7…, CourtV2 0x9a326D1f…, bound to the successor
// kernel 0x88114419…, from `base-pvt9-institutions.json` `.contracts`. The set they
// replaced (Escrow 0xc7380927…, Promise 0x0485dF39…, Pool 0x8C981b15…, Bond 0xC7D699da…,
// Court 0x007CeCa7…, kernel 0x4Bf02d5C…) is retired and lives under `.predecessor`.
// (The set had in turn SUPERSEDED the nonce-12-16 PREDICTIONS off 0x713E33Cc… — those
// were VOID: that EOA's key was compromised and the set would have bound
// the now-abandoned kernel 0x8b2306be…. The predictions never held code.)
//
// The Base default now resolves the institution deployment file. The env-override path is still read
// FIRST (`BOND_POOL_CONTRACT_ADDRESS_BASE` / `ESCROW_CONTRACT_ADDRESS_BASE`; see
// `envAddress` below) so an operator can still cut over without shipping a new SDK.
// `base-retired-addresses.json` is loaded SOLELY for the retired guard set below.
// Lazy, memoized deployment loaders. Reading a deployment artifact is deferred to
// first ACCESS, never performed at module import — so importing this module, and
// everything that transitively pulls it in (evm-allowlist → x402-signer →
// ProvianClient → the observer), does NO filesystem I/O. The self-contained
// bootstrap bundle ships no `deployments/` dir and never resolves an institution
// address; an eager top-level `loadDeployment` (which THROWS when the artifact is
// absent) crashed `agent.js observe`/`bootstrap` at startup. Values are identical:
// the same artifact is read, just on first demand, then cached.
let _basePvt9: Pvt9InstitutionsDeployment | undefined;
const basePvt9 = (): Pvt9InstitutionsDeployment =>
  (_basePvt9 ??= loadDeployment<Pvt9InstitutionsDeployment>('base-pvt9-institutions.json'));
let _basePass3: Pass3Deployment | undefined;
const basePass3 = (): Pass3Deployment =>
  (_basePass3 ??= loadDeployment<Pass3Deployment>('base-retired-addresses.json')); // retired set only
let _arbitrumChunkII: ChunkIIDeployment | undefined;
const arbitrumChunkII = (): ChunkIIDeployment =>
  (_arbitrumChunkII ??= loadDeployment<ChunkIIDeployment>('arbitrum-live.json'));
let _optimismChunkII: ChunkIIDeployment | undefined;
const optimismChunkII = (): ChunkIIDeployment =>
  (_optimismChunkII ??= loadDeployment<ChunkIIDeployment>('optimism-live.json'));

/**
 * Canonical (EIP-55 checksummed) live Base institution deployment/PVT9 protocol addresses. Getters
 * so the backing artifact is read on first property access, never at import.
 */
export const BASE_PVT9_ADDRESSES = {
  get escrow(): `0x${string}` { return getAddress(basePvt9().contracts.escrowV4.address); },
  get pool(): `0x${string}` { return getAddress(basePvt9().contracts.poolV3.address); },
  get court(): `0x${string}` { return getAddress(basePvt9().contracts.courtV2.address); },
  get bondPool(): `0x${string}` { return getAddress(basePvt9().contracts.bondPool.address); },
  get pvt(): `0x${string}` { return getAddress(basePvt9().successorKernel.pvt9Kernel.address); },
} as const;

/**
 * The retired Base addresses that no resolver may ever return and that no SDK
 * source file may reference as a live address — the guard test in
 * `contract-addresses.test.ts` enforces both. Sourced entirely from
 * `base-retired-addresses.json` and the `.predecessor` block of `base-pvt9-institutions.json`
 * (so no new hardcoded literal is introduced), it is:
 * - the retired institution quartet (`.contracts`), superseded on-chain by the
 * institution deployment/PVT9 institutions above;
 * - the prior PVTv8-cascade quartet (`.retired`), which previously retired
 * PVTv8 deregistered on-chain; and
 * - the abandoned PVTv8 kernel (`.reused.pvtV8`), replaced by the PVT9 successor
 * kernel — it also sits in the PVT9 config's `forbidden_pvt_addresses`; and
 * - the PVT9 set (`base-pvt9-institutions.json` `.predecessor`), retired by
 * when the successor kernel carried every balance, bond and escrow; and
 * - the PoolV3 (`.safetyPolicy.retiredPoolV3`), replaced in place by; and
 * - the PoolV3 (`.shutdownCoverage.retiredPoolV3`), replaced 2026-10-20.
 * Checksummed for case-insensitive comparison via `getAddress`. Memoized and built
 * on first call (not at import) so loading this module performs no filesystem I/O.
 */
let _retiredBaseAddresses: readonly `0x${string}`[] | undefined;
export function retiredBaseAddresses(): readonly `0x${string}`[] {
  return (_retiredBaseAddresses ??= [
    // retired institution quartet — superseded by institution deployment/PVT9.
    getAddress(basePass3().contracts.escrowV4),
    getAddress(basePass3().contracts.poolV3),
    getAddress(basePass3().contracts.courtV2),
    getAddress(basePass3().contracts.bondPool),
    // Prior PVTv8-cascade quartet — retired at the Pass-3 redeploy (2026-07-01).
    getAddress(basePass3().retired.escrowV4),
    getAddress(basePass3().retired.poolV3),
    getAddress(basePass3().retired.courtV2),
    getAddress(basePass3().retired.bondPool),
    // The abandoned PVTv8 kernel — the institution set now binds the PVT9 kernel.
    getAddress(basePass3().reused.pvtV8),
    // The PVT9 set, retired by (kernel + verifier held, everything carried).
    getAddress(basePvt9().predecessor.pvt9Kernel),
    getAddress(basePvt9().predecessor.eligibilityVerifier),
    getAddress(basePvt9().predecessor.contracts.escrowV4),
    getAddress(basePvt9().predecessor.contracts.promiseV3),
    getAddress(basePvt9().predecessor.contracts.poolV3),
    getAddress(basePvt9().predecessor.contracts.bondPool),
    getAddress(basePvt9().predecessor.contracts.courtV2),
    // the PoolV3, replaced in place by a fresh PoolV3 carrying the S1-A fix.
    getAddress(basePvt9().safetyPolicy.retiredPoolV3.address),
    getAddress(basePvt9().shutdownCoverage.retiredPoolV3.address),
  ]);
}

/** Per-chain USDC-principal escrow defaults, sourced from deployment artifacts. */
const ESCROW_USDC_DEFAULTS: Record<SupportedChain, `0x${string}`> = {
  get base(): `0x${string}` { return getAddress(basePvt9().contracts.escrowV4.address); },
  get arbitrum(): `0x${string}` { return getAddress(arbitrumChunkII().contracts.escrowV4); },
  get optimism(): `0x${string}` { return getAddress(optimismChunkII().contracts.escrowV4); },
};

/** BondPool default. Base-only this slice (the sole precondition-checked chain). */
const BOND_POOL_DEFAULTS: Partial<Record<SupportedChain, `0x${string}`>> = {
  get base(): `0x${string}` { return getAddress(basePvt9().contracts.bondPool.address); },
};

/**
 * Capital-pool default. Base-only this slice (the live institution deployment/PVT9 PoolV3 handles
 * both USDC and PVT pools). Arbitrum/Optimism return undefined so the pool exit
 * helpers fail closed until a pool is deployed + env-wired there.
 */
const POOL_DEFAULTS: Partial<Record<SupportedChain, `0x${string}`>> = {
  get base(): `0x${string}` { return getAddress(basePvt9().contracts.poolV3.address); },
};

/**
 * First env var (from the given names) holding a valid 0x address, checksummed.
 * Mirrors the backend's per-chain-then-legacy fallback (chain-registry.ts).
 */
function envAddress(...names: string[]): `0x${string}` | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) {
      return getAddress(raw);
    }
  }
  return undefined;
}

/**
 * Resolve the BondPool address for a chain: env override (SAME names the backend
 * reads) → deployment-JSON default. Base-only; other chains return undefined so
 * the caller fails closed (matching evm-bond.ts's slice scope).
 */
export function resolveBondPoolAddress(chain: SupportedChain): `0x${string}` | undefined {
  return (
    envAddress(`BOND_POOL_CONTRACT_ADDRESS_${chain.toUpperCase()}`, 'BOND_POOL_CONTRACT_ADDRESS') ??
    BOND_POOL_DEFAULTS[chain]
  );
}

/**
 * Resolve the USDC-principal escrow address for a chain: env override (SAME
 * names the backend reads) → deployment-JSON default.
 */
export function resolveEscrowUsdcAddress(chain: SupportedChain): `0x${string}` | undefined {
  return (
    envAddress(`ESCROW_CONTRACT_ADDRESS_${chain.toUpperCase()}`, 'ESCROW_CONTRACT_ADDRESS') ??
    ESCROW_USDC_DEFAULTS[chain]
  );
}

/**
 * Resolve the capital-pool contract address for a chain: env override (the SAME
 * per-chain-then-legacy names the backend's `poolUsdcAddressForChain` reads —
 * POOL_V2_* → POOL_CONTRACT_ADDRESS_*) → deployment-JSON default (Base only). The
 * live PoolV3 serves both currencies, so a single address is correct.
 */
export function resolvePoolAddress(chain: SupportedChain): `0x${string}` | undefined {
  return (
    envAddress(
      `POOL_V2_CONTRACT_ADDRESS_${chain.toUpperCase()}`,
      'POOL_V2_CONTRACT_ADDRESS',
      `POOL_CONTRACT_ADDRESS_${chain.toUpperCase()}`,
      'POOL_CONTRACT_ADDRESS',
    ) ?? POOL_DEFAULTS[chain]
  );
}

/** True iff `address` is one of the retired Base cascade contracts (case-insensitive). */
export function isRetiredAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const needle = getAddress(address);
  return retiredBaseAddresses().includes(needle);
}
