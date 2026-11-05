/**
 * Centralized chain RPC provider.
 *
 * Wraps the env-configured primary endpoint (Alchemy / Infura / etc.) and
 * the chain's public endpoint in an ethers.FallbackProvider so a primary
 * outage transparently falls through to public RPC. Both providers carry
 * a 30-second per-call timeout via FetchRequest so a hung upstream
 * cannot pin a request indefinitely.
 *
 * The primary env var (BASE_RPC_URL / ARBITRUM_RPC_URL / OPTIMISM_RPC_URL)
 * is REQUIRED at boot - see validateRequiredEnv in server.ts. The previous
 * "fall back to public if env unset" pattern silently pushed all
 * production traffic onto rate-limited public RPC any time someone
 * forgot to set an env var on Cloud Run. Fail-fast is safer.
 */

import { ethers } from 'ethers';
import { bumpOpsCounter } from '../observability/ops-counters';
import { linearRpcGetUrl } from './rpc-response-transport';

export type ChainName = 'base' | 'arbitrum' | 'optimism';

const PUBLIC_ENDPOINTS: Record<ChainName, string> = {
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
};

export const RPC_ENV_VARS: Record<ChainName, string> = {
  base: 'BASE_RPC_URL',
  arbitrum: 'ARBITRUM_RPC_URL',
  optimism: 'OPTIMISM_RPC_URL',
};

/**
 * Optional SECONDARY endpoint env vars. Used ONLY as the second,
 * operator-identity-bound leg of the quorum-2 verifier
 * (getVerifierProvider), so its two legs are not the same provider queried
 * twice. Point this at a separately operated provider while binding both
 * operator identities explicitly (known public endpoints use the pinned table
 * below).
 *
 * The monetary drain confirms queued transaction facts through both legs.
 * Production capacity uses an authenticated endpoint;
 * public gateway quotas are unsuitable for continuous chain coverage. The general
 * availability provider keeps its existing failover. Different hostnames alone
 * never establish operator independence.
 */
export const RPC_SECONDARY_ENV_VARS: Record<ChainName, string> = {
  base: 'BASE_RPC_URL_SECONDARY',
  arbitrum: 'ARBITRUM_RPC_URL_SECONDARY',
  optimism: 'OPTIMISM_RPC_URL_SECONDARY',
};

/**
 * Operator identity is a separate configuration dimension from endpoint URL.
 * Two hostnames can be products, gateways, or aliases run by the same operator,
 * so hostname inequality is not evidence of independent operation.
 */
export const RPC_OPERATOR_ENV_VARS: Record<ChainName, string> = {
  base: 'BASE_RPC_OPERATOR_ID',
  arbitrum: 'ARBITRUM_RPC_OPERATOR_ID',
  optimism: 'OPTIMISM_RPC_OPERATOR_ID',
};

export const RPC_SECONDARY_OPERATOR_ENV_VARS: Record<ChainName, string> = {
  base: 'BASE_RPC_SECONDARY_OPERATOR_ID',
  arbitrum: 'ARBITRUM_RPC_SECONDARY_OPERATOR_ID',
  optimism: 'OPTIMISM_RPC_SECONDARY_OPERATOR_ID',
};

const PUBLIC_ENDPOINT_OPERATORS: Record<ChainName, string> = {
  base: 'base-foundation',
  arbitrum: 'offchain-labs',
  optimism: 'optimism-foundation',
};

const KNOWN_OPERATOR_HOST_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['alchemy.com', 'alchemy'],
  ['infura.io', 'consensys-infura'],
  ['quicknode.pro', 'quicknode'],
  ['drpc.org', 'drpc'],
  ['drpc.live', 'drpc'],
  ['mainnet.base.org', 'base-foundation'],
  ['arb1.arbitrum.io', 'offchain-labs'],
  ['mainnet.optimism.io', 'optimism-foundation'],
];

const CHAIN_IDS: Record<ChainName, number> = {
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
};

const RPC_TIMEOUT_MS = 30_000;

const providerCache = new Map<ChainName, ethers.FallbackProvider>();
const verifierProviderCache = new Map<ChainName, ethers.FallbackProvider>();
const verifierLegCache = new Map<ChainName, readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg]>();

export interface VerifierProviderIdentity {
  readonly primaryOperatorId: string;
  readonly secondaryOperatorId: string;
}

/**
 * One independently operated verifier leg. Economic-state reads use the two
 * legs separately and compare their raw JSON-RPC results at one explicit block
 * tag. This is intentionally stronger than routing those reads through the
 * availability-oriented quorum-one provider.
 */
export interface OperatorBoundRpcLeg {
  readonly operatorId: string;
  readonly provider: ethers.JsonRpcProvider;
}

function normalizeOperatorId(value: string | undefined, envName: string): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error(`[rpc-provider] ${envName} is not a valid RPC operator id`);
  }
  return normalized;
}

function knownOperatorForHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  for (const [suffix, operatorId] of KNOWN_OPERATOR_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return operatorId;
  }
  return null;
}

function resolveEndpointOperator(
  url: string,
  declaredValue: string | undefined,
  declaredEnvName: string,
): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error('[rpc-provider] verifier RPC URL is invalid');
  }
  const known = knownOperatorForHost(hostname);
  const declared = normalizeOperatorId(declaredValue, declaredEnvName);
  if (known && declared && known !== declared) {
    throw new Error(
      `[rpc-provider] ${declaredEnvName}=${declared} conflicts with the pinned operator ${known} for ${hostname}`,
    );
  }
  if (known) return known;
  if (declared) return declared;
  throw new Error(
    `[rpc-provider] ${declaredEnvName} is required for unrecognized verifier host ${hostname}`,
  );
}

function verifierEndpointConfig(chain: ChainName): {
  primaryUrl: string;
  secondaryUrl: string;
  identity: VerifierProviderIdentity;
} {
  const primaryUrl = process.env[RPC_ENV_VARS[chain]];
  if (!primaryUrl) {
    throw new Error(
      `[rpc-provider] ${RPC_ENV_VARS[chain]} is not set; primary RPC is required for verification`,
    );
  }
  const secondaryIsConfigured = Boolean(process.env[RPC_SECONDARY_ENV_VARS[chain]]);
  const secondaryUrl = process.env[RPC_SECONDARY_ENV_VARS[chain]] || PUBLIC_ENDPOINTS[chain];
  let primaryHost: string;
  let secondaryHost: string;
  try {
    primaryHost = new URL(primaryUrl).hostname.toLowerCase();
    secondaryHost = new URL(secondaryUrl).hostname.toLowerCase();
  } catch {
    throw new Error('[rpc-provider] verifier RPC URL is invalid');
  }
  if (primaryHost === secondaryHost) {
    throw new Error(
      `[rpc-provider] verifier endpoints cannot share the same host ${primaryHost}`,
    );
  }
  const primaryOperatorId = resolveEndpointOperator(
    primaryUrl,
    process.env[RPC_OPERATOR_ENV_VARS[chain]],
    RPC_OPERATOR_ENV_VARS[chain],
  );
  const secondaryOperatorId = secondaryIsConfigured
    ? resolveEndpointOperator(
        secondaryUrl,
        process.env[RPC_SECONDARY_OPERATOR_ENV_VARS[chain]],
        RPC_SECONDARY_OPERATOR_ENV_VARS[chain],
      )
    : PUBLIC_ENDPOINT_OPERATORS[chain];
  if (primaryOperatorId === secondaryOperatorId) {
    throw new Error(
      `[rpc-provider] verifier RPC operators must be independent; both legs are operated by ${primaryOperatorId}`,
    );
  }
  return {
    primaryUrl,
    secondaryUrl,
    identity: { primaryOperatorId, secondaryOperatorId },
  };
}

/** Return the validated operator identities bound to the verifier endpoints. */
export function getVerifierProviderIdentity(chain: ChainName): VerifierProviderIdentity {
  return verifierEndpointConfig(chain).identity;
}

/**
 * Return the two validated verifier legs without combining them. Callers that
 * need an exact-block state snapshot compare the raw response from each leg;
 * a stale or forged response from either operator therefore fails closed.
 */
export function getOperatorBoundRpcLegs(
  chain: ChainName,
): readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg] {
  const cached = verifierLegCache.get(chain);
  if (cached) return cached;
  const { primaryUrl, secondaryUrl, identity } = verifierEndpointConfig(chain);
  const chainId = CHAIN_IDS[chain];
  const legs = Object.freeze([
    Object.freeze({
      operatorId: identity.primaryOperatorId,
      provider: buildJsonRpc(primaryUrl, chainId, chain),
    }),
    Object.freeze({
      operatorId: identity.secondaryOperatorId,
      provider: buildJsonRpc(secondaryUrl, chainId, chain),
    }),
  ]) as readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg];
  verifierLegCache.set(chain, legs);
  return legs;
}

// =============================================================================
// 2026-10-01 — TRACE LEGS (ETH that arrives inside a transaction)
// =============================================================================
//
// An internal ETH transfer (ETH a contract or smart wallet sends inside some
// other transaction) has no transaction and no log of its own: only a trace
// shows it. The public Base endpoint serves no trace methods, so the trace pair
// is the primary verifier leg (Alchemy, which serves `trace_*`) and a second,
// independently operated trace endpoint (default: dRPC's public Base endpoint,
// which serves `trace_transaction`). Both must be different operators, exactly
// as the verifier pair.

export const BASE_TRACE_SECONDARY_ENV = 'BASE_TRACE_RPC_URL_SECONDARY';
export const BASE_TRACE_SECONDARY_OPERATOR_ENV = 'BASE_TRACE_RPC_SECONDARY_OPERATOR_ID';
export const DEFAULT_BASE_TRACE_SECONDARY_URL = 'https://base.drpc.org';

let baseTraceLegCache: readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg] | null = null;

/** The two independently operated Base trace legs: [primary verifier leg, trace secondary]. */
export function getBaseTraceRpcLegs(): readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg] {
  if (baseTraceLegCache) return baseTraceLegCache;
  const { primaryUrl, identity } = verifierEndpointConfig('base');
  const secondaryUrl = process.env[BASE_TRACE_SECONDARY_ENV] || DEFAULT_BASE_TRACE_SECONDARY_URL;
  let primaryHost: string;
  let secondaryHost: string;
  try {
    primaryHost = new URL(primaryUrl).hostname.toLowerCase();
    secondaryHost = new URL(secondaryUrl).hostname.toLowerCase();
  } catch {
    throw new Error('[rpc-provider] trace RPC URL is invalid');
  }
  if (primaryHost === secondaryHost) {
    throw new Error(`[rpc-provider] trace endpoints cannot share the same host ${primaryHost}`);
  }
  const secondaryOperatorId = resolveEndpointOperator(
    secondaryUrl,
    process.env[BASE_TRACE_SECONDARY_OPERATOR_ENV],
    BASE_TRACE_SECONDARY_OPERATOR_ENV,
  );
  if (secondaryOperatorId === identity.primaryOperatorId) {
    throw new Error(
      `[rpc-provider] trace RPC operators must be independent; both legs are operated by ${secondaryOperatorId}`,
    );
  }
  const chainId = CHAIN_IDS.base;
  baseTraceLegCache = Object.freeze([
    Object.freeze({ operatorId: identity.primaryOperatorId, provider: buildJsonRpc(primaryUrl, chainId, 'base') }),
    Object.freeze({ operatorId: secondaryOperatorId, provider: buildJsonRpc(secondaryUrl, chainId, 'base-trace') }),
  ]) as readonly [OperatorBoundRpcLeg, OperatorBoundRpcLeg];
  return baseTraceLegCache;
}

/** Validate every production verifier's operator binding without network I/O. */
export function validateVerifierProviderIdentities(): void {
  for (const chain of Object.keys(CHAIN_IDS) as ChainName[]) {
    getVerifierProviderIdentity(chain);
  }
}

/**
 * Relay heap OOM (2026-10-17): ethers 6's `FetchResponse.bodyText` decodes
 * UTF-8 by pushing one JS number per byte into an array, mapping that to an
 * array of one-character strings, then joining. Each byte of a response
 * becomes two array slots: one 8.4 MB Base block cost ~170 MB of heap per leg,
 * and four batched blocks on two legs aborted the relay at its ~700 MB heap
 * ceiling. This provider sends exactly what `JsonRpcProvider._send` sends
 * (same FetchRequest: URL, timeout, headers, throttle retry) and decodes the
 * body with the platform decoder: the same string for valid UTF-8, a throw for
 * invalid UTF-8 (as ethers throws), a kept byte-order mark (as ethers keeps
 * it), and heap proportional to the body.
 */
export const RPC_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class LinearDecodeJsonRpcProvider extends ethers.JsonRpcProvider {
  override async _send(
    payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>,
  ): Promise<Array<ethers.JsonRpcResult>> {
    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader('content-type', 'application/json');
    const response = await request.send();
    response.assertOk();
    const body = response.body;
    // A missing body is the empty string, which fails to parse, as in ethers.
    const parsed: unknown = JSON.parse(body === null ? '' : RPC_UTF8_DECODER.decode(body));
    return (Array.isArray(parsed) ? parsed : [parsed]) as Array<ethers.JsonRpcResult>;
  }
}

function buildJsonRpc(url: string, chainId: number, chainLabel: string): ethers.JsonRpcProvider {
  const fetchReq = new ethers.FetchRequest(url);
  fetchReq.timeout = RPC_TIMEOUT_MS;
  fetchReq.getUrlFunc = linearRpcGetUrl;
  // Heavy Base trace responses must not hold small canonical reads in one RPC batch.
  const provider = new LinearDecodeJsonRpcProvider(fetchReq, chainId, chainLabel.startsWith('base') ? { batchMaxCount: 1 } : undefined);
  // Advisory ops counters on RPC errors (ethers v6 'debug' event). Wrapped so a broken
  // subscription can NEVER break provider construction on the settlement path.
  try {
    provider.on('debug', (event: { action?: string; error?: unknown }) => {
      if (event?.action !== 'receiveRpcError') return;
      bumpOpsCounter(`rpc.error.${chainLabel}`);
      if (String((event.error as { info?: unknown })?.info ?? event.error ?? '').includes('429')) {
        bumpOpsCounter(`rpc.429.${chainLabel}`);
      }
    });
  } catch { /* advisory only */ }
  return provider;
}

/**
 * Returns a FallbackProvider for the chain. The env-configured primary
 * is preferred (priority 1, weight 2); the public endpoint is the
 * fallback (priority 2, weight 1). Quorum 1 - single response is
 * enough - so a primary outage cuts over to the public endpoint
 * without quorum stalling.
 *
 * Throws if the primary env var is missing. validateRequiredEnv runs
 * at boot, so this only fires in a misconfigured deploy.
 */
export function getChainProvider(chain: ChainName): ethers.FallbackProvider {
  const cached = providerCache.get(chain);
  if (cached) return cached;
  const envName = RPC_ENV_VARS[chain];
  const primaryUrl = process.env[envName];
  if (!primaryUrl) {
    throw new Error(`[rpc-provider] ${envName} is not set; primary RPC is required`);
  }
  const chainId = CHAIN_IDS[chain];
  const primary = buildJsonRpc(primaryUrl, chainId, chain);
  const secondary = buildJsonRpc(PUBLIC_ENDPOINTS[chain], chainId, chain);
  const fallback = new ethers.FallbackProvider(
    [
      { provider: primary, weight: 2, priority: 1 },
      { provider: secondary, weight: 1, priority: 2 },
    ],
    chainId,
    { quorum: 1 },
  );
  providerCache.set(chain, fallback);
  return fallback;
}

/**
 * Returns a quorum-2 FallbackProvider for VERIFICATION reads ONLY — the
 * agent-wallet transfer/bond receipt confirmation in tx-verifier.ts
 * (verifyTransfer, verifyEvmNativeTransfer, verifyEvmBondPosted/Renewed/Withdrawn,
 * etc.).
 *
 * Unlike getChainProvider (quorum 1, tuned for AVAILABILITY — a primary outage
 * transparently cuts over to the public endpoint), this provider requires TWO
 * endpoints whose validated operator identities differ to return the SAME
 * result before a read is accepted. Hostname difference alone is rejected as
 * evidence of operator independence. Both legs carry EQUAL weight (1), so
 * quorum 2 can only be met by agreement of BOTH; the primary cannot satisfy it
 * alone.
 *
 * WHY THIS PATH IS QUORUM 2 WHILE GENERAL READS ARE QUORUM 1:
 * A verifier read that trusts a single endpoint lets a compromised or malicious
 * primary RPC return a FORGED transaction receipt, which would mint a
 * `verified: true` Provenance Envelope for a transfer/bond that never occurred.
 * For provenance, correct-or-nothing beats available-but-maybe-forged. The
 * tradeoff is deliberate and the SECURITY-PREFERRED failure mode: verifier reads
 * now FAIL CLOSED during a single-provider outage, or when the two endpoints
 * disagree — ethers throws ("failed to meet quorum") and the caller records NO
 * verified PE — rather than risk a false verification. General discovery,
 * broadcast, balance, nonce, stake, and watcher log-range reads may use quorum
 * 1 via getChainProvider for availability, but none of those reads may finalize
 * economic state. Watcher and mint finalization re-read exact evidence through
 * this operator-bound quorum-two provider.
 *
 * Operational implication: verification depends on both configured operator
 * identities being distinct and both endpoints being reachable and in agreement.
 * If identity is absent/ambiguous, either endpoint is down, or results disagree,
 * verification fails closed until the condition is corrected.
 *
 * Throws if the primary env var is missing (same precondition as getChainProvider).
 */
export function getVerifierProvider(chain: ChainName): ethers.FallbackProvider {
  const cached = verifierProviderCache.get(chain);
  if (cached) return cached;
  const { primaryUrl, secondaryUrl } = verifierEndpointConfig(chain);
  const chainId = CHAIN_IDS[chain];
  const primary = buildJsonRpc(primaryUrl, chainId, chain);
  const secondary = buildJsonRpc(secondaryUrl, chainId, chain);
  // Equal weight (1 each) + quorum 2 => BOTH endpoints must return and agree.
  // Neither leg can satisfy quorum alone, so a single forged/compromised endpoint
  // cannot produce an accepted result, and a single-provider outage fails closed.
  const fallback = new ethers.FallbackProvider(
    [
      { provider: primary, weight: 1, priority: 1 },
      { provider: secondary, weight: 1, priority: 1 },
    ],
    chainId,
    { quorum: 2 },
  );
  verifierProviderCache.set(chain, fallback);
  return fallback;
}

/**
 * Test-only: clears the cached providers. Production code never calls this.
 */
export function _clearProviderCache(): void {
  providerCache.clear();
  verifierProviderCache.clear();
  verifierLegCache.clear();
}
