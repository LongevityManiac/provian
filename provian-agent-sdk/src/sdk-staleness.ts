/**
 * Client-side SDK staleness evaluation.
 *
 * The relay advertises the version an agent SHOULD be on via the
 * `X-Provian-SDK-Latest` / `X-Provian-SDK-Min` response headers (on every call)
 * and `GET /v1/sdk/version`. This module compares THIS SDK's `SDK_VERSION`
 * against those advertised values and decides whether to nudge the operator.
 *
 * FAIL-OPEN: every function here is pure and side-effect-free except the logger.
 * An unreachable/absent signal, or an unparseable version, yields "not stale" —
 * the check never blocks agent operation and never gates x402 spending. The
 * relay never refuses an agent over this; `belowMin` only escalates the log
 * (and, if the operator opted into strict mode, a connect-time throw).
 */
import { sdkUpgradeHint } from './cli-command';

/** Parse `X.Y.Z` (pre-release/build suffix ignored). null when unrecognizable. */
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

/** <0 if a<b, 0 if equal/unparseable, >0 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export interface StalenessVerdict {
  current: string;
  latest: string | null;
  minSupported: string | null;
  /** current < latest (an update is available). */
  stale: boolean;
  /** current < minSupported (advisory hard-nudge). */
  belowMin: boolean;
}

/**
 * Compare `current` against advertised `latest` / `minSupported`. Any missing or
 * unparseable input collapses that dimension to false (fail-open). Passing both
 * `latest` and `minSupported` null yields an all-false verdict.
 */
export function evaluateStaleness(
  current: string,
  latest: string | null,
  minSupported: string | null,
): StalenessVerdict {
  const currentParseable = parseSemver(current) !== null;
  const stale =
    currentParseable && latest !== null && parseSemver(latest) !== null
      ? compareSemver(current, latest) < 0
      : false;
  const belowMin =
    currentParseable && minSupported !== null && parseSemver(minSupported) !== null
      ? compareSemver(current, minSupported) < 0
      : false;
  return { current, latest, minSupported, stale, belowMin };
}

const DEFAULT_UPGRADE_COMMAND = sdkUpgradeHint();

/**
 * Build the human-facing upgrade message for a verdict. Returns null when there
 * is nothing to say (not stale, not below min).
 */
export function stalenessMessage(
  v: StalenessVerdict,
  upgradeCommand: string = DEFAULT_UPGRADE_COMMAND,
): string | null {
  if (v.belowMin) {
    return (
      `[Provian] Your @provian/agent-sdk (${v.current}) is BELOW the minimum ` +
      `supported version (${v.minSupported}). Update now: ${upgradeCommand}`
    );
  }
  if (v.stale) {
    return (
      `[Provian] A newer @provian/agent-sdk is available (${v.current} -> ` +
      `${v.latest}). Update to pick up the latest features: ${upgradeCommand}`
    );
  }
  return null;
}

export interface StalenessLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Emit the staleness nudge (belowMin -> error, stale -> warn). Returns true if
 * anything was logged. Pure aside from the injected logger, so tests can assert
 * exactly what would be printed without capturing console.
 */
export function logStaleness(
  v: StalenessVerdict,
  logger: StalenessLogger = console,
  upgradeCommand: string = DEFAULT_UPGRADE_COMMAND,
): boolean {
  const msg = stalenessMessage(v, upgradeCommand);
  if (!msg) return false;
  if (v.belowMin) logger.error(msg);
  else logger.warn(msg);
  return true;
}
