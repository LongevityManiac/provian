/**
 * Agent-SDK version advertisement (staleness signal).
 *
 * Agent keys are immutable and the relay updates instantly on deploy, but an
 * agent's client SDK code only updates when the operator pulls a new package —
 * with no signal telling them a newer one exists. This module is the relay's
 * single source of truth for "what SDK version should agents be on", surfaced
 * three ways:
 *
 *   1. `GET /v1/sdk/version`            — an explicit pull (public, ungated).
 *   2. `X-Provian-SDK-Latest` / `-Min`  — response headers on every relay call,
 *                                          so the SDK learns staleness passively
 *                                          on connect and on every heartbeat GET.
 *   3. an `sdk` block on the connect     — so the SDK gets it without a 2nd call.
 *      response.
 *
 * FAIL-OPEN by design: this is an advisory signal, never a gate. The SDK must
 * keep operating if this endpoint is missing/unreachable, and NOTHING here gates
 * an agent's own x402 spending. `minSupported` is an advisory floor the SDK logs
 * loudly about — it does not cause the relay to refuse the agent.
 *
 * SOURCE OF TRUTH: `SDK_LATEST` mirrors `provian-agent-sdk/package.json`'s
 * version (the version an agent SHOULD be on). Bump it here in the same change
 * that bumps the SDK package version. `SDK_MIN_SUPPORTED` is a deliberately
 * permissive floor (see its comment) — raise it only when a genuinely breaking
 * protocol change ships, and say why in `SDK_MIN_NOTE`.
 */

/** The version agents should be on — mirrors provian-agent-sdk/package.json. */
export const SDK_LATEST = '1.10.1';

/**
 * Advisory minimum. Deliberately permissive (1.0.0): no released SDK below the
 * 1.x line carries a breaking protocol incompatibility, so nothing real trips
 * `belowMin` today, and the mechanism ships without locking anyone out. Raise
 * this ONLY when a specific breaking change lands, and record the reason in
 * `SDK_MIN_NOTE`. Bumping it never makes the relay refuse an agent — the SDK
 * just logs a louder upgrade message.
 */
export const SDK_MIN_SUPPORTED = '1.0.0';

/** One-line reason the floor sits where it does (shown in the version payload). */
export const SDK_MIN_NOTE =
  'Advisory floor; no released 1.x SDK is protocol-incompatible. Update for latest features (Solana wallet + agent x402).';

/** The command an operator runs to update; echoed in warnings so it's copy-pasteable. */
export const SDK_UPGRADE_COMMAND = 'npm i @provian/agent-sdk@latest';

/** Free-text release note pointer for the `/v1/sdk/version` payload. */
export const SDK_RELEASE_NOTES =
  'v1.5.0 adds Solana as a first-class agent wallet chain and Solana x402 (SVM) settlement.';

export interface SdkVersionInfo {
  latest: string;
  minSupported: string;
  upgradeCommand: string;
  notes: string;
  minNote: string;
}

/** The public payload for `GET /v1/sdk/version` and the connect-response `sdk` block. */
export function sdkVersionInfo(): SdkVersionInfo {
  return {
    latest: SDK_LATEST,
    minSupported: SDK_MIN_SUPPORTED,
    upgradeCommand: SDK_UPGRADE_COMMAND,
    notes: SDK_RELEASE_NOTES,
    minNote: SDK_MIN_NOTE,
  };
}

/**
 * Parse a semver-ish string into [major, minor, patch]. Pre-release/build
 * suffixes (`-rc.1`, `+build`) are ignored for comparison. Returns null when the
 * string is not a recognizable `X.Y.Z` — the caller treats an unparseable
 * client version as "unknown, do not flag" (fail-open).
 */
export function parseSemver(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const core = v.trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = parts[i] ?? '0';
    if (!/^\d+$/.test(raw)) return null;
    nums.push(parseInt(raw, 10));
  }
  return [nums[0], nums[1], nums[2]];
}

/**
 * Returns negative if a < b, 0 if equal, positive if a > b. Unparseable inputs
 * sort as "equal" so an unknown version never trips a comparison (fail-open).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export interface SdkVersionVerdict {
  clientVersion: string;
  latest: string;
  minSupported: string;
  /** Client is older than `latest` (an update is available). */
  stale: boolean;
  /** Client is older than `minSupported` (advisory hard-nudge). */
  belowMin: boolean;
  upgradeCommand: string;
}

/**
 * Evaluate a client SDK version against the advertised latest/min. An
 * unparseable or empty `clientVersion` yields `{ stale:false, belowMin:false }`
 * (fail-open — never flag a version we cannot read).
 */
export function evaluateSdkVersion(clientVersion: string): SdkVersionVerdict {
  const parseable = parseSemver(clientVersion) !== null;
  const stale = parseable && compareSemver(clientVersion, SDK_LATEST) < 0;
  const belowMin = parseable && compareSemver(clientVersion, SDK_MIN_SUPPORTED) < 0;
  return {
    clientVersion,
    latest: SDK_LATEST,
    minSupported: SDK_MIN_SUPPORTED,
    stale,
    belowMin,
    upgradeCommand: SDK_UPGRADE_COMMAND,
  };
}
