/**
 * Pure app-update decision logic (no native/Expo/network imports).
 *
 * Provian's Android build ships as a directly-downloaded APK (not Google Play),
 * so there is no store to auto-update it. This module owns the *decision*: given
 * the installed build's versionCode and a version manifest hosted on
 * provian.ai, decide whether a newer APK exists and how hard to nudge the user.
 *
 * Deliberately NOT an over-the-air (EAS Update) mechanism: silently mutating a
 * wallet's JavaScript from a remote channel is a security anti-pattern (a
 * compromised channel would push malicious code into every wallet). Instead the
 * user is pointed at the signed APK download; Android enforces that an update is
 * signed by the SAME key as the installed app, so the signature is the
 * authenticity guarantee.
 *
 * Fail-safe invariants (a non-custodial wallet must never lock a user out of
 * their funds because of an update check):
 *  - A missing, unreachable, or malformed manifest → `up_to_date` (never nag,
 *    never block). Update nudges are best-effort, not a gate.
 *  - `update_required` (installed < minSupportedVersionCode) is a STRONG,
 *    non-dismissible nudge — but the caller must still leave the wallet usable
 *    (recovery/export always reachable). It is never a hard brick.
 *  - The mechanism is Android-only; iOS updates through the App Store.
 */

export interface VersionManifest {
  /** Android versionCode of the newest published APK. */
  latestVersionCode: number;
  /** Human version name of the newest APK, e.g. "1.0.1". */
  latestVersionName: string;
  /**
   * Builds with versionCode below this are urged to update non-dismissibly
   * (reserve for critical security fixes). Default 0 = never forces.
   */
  minSupportedVersionCode: number;
  /** Where to send the user to get the new APK (the gated /download page). */
  downloadUrl: string;
  /** Optional short "what's new" note. */
  notes?: string;
}

export type UpdateDecision =
  | { kind: 'up_to_date' }
  | {
      kind: 'update_available' | 'update_required';
      latestVersionName: string;
      downloadUrl: string;
      notes?: string;
    };

const isFiniteNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/** Narrow an untrusted (parsed-JSON) value to a VersionManifest, or null. */
export function parseVersionManifest(raw: unknown): VersionManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.latestVersionCode)) return null;
  if (typeof r.latestVersionName !== 'string' || r.latestVersionName.length === 0) return null;
  if (typeof r.downloadUrl !== 'string' || !/^https:\/\//i.test(r.downloadUrl)) return null;
  return {
    latestVersionCode: r.latestVersionCode,
    latestVersionName: r.latestVersionName,
    // Optional; default 0 (never forces) when absent/invalid.
    minSupportedVersionCode: isFiniteNumber(r.minSupportedVersionCode)
      ? r.minSupportedVersionCode
      : 0,
    downloadUrl: r.downloadUrl,
    notes: typeof r.notes === 'string' ? r.notes : undefined,
  };
}

/**
 * Decide whether to nudge the user to update. Pure + total: never throws, and
 * degrades to `up_to_date` on any unusable input.
 */
export function evaluateUpdate(
  installedVersionCode: number,
  manifest: VersionManifest | null,
): UpdateDecision {
  if (!manifest || !isFiniteNumber(installedVersionCode)) {
    return { kind: 'up_to_date' };
  }
  const { latestVersionCode, minSupportedVersionCode, latestVersionName, downloadUrl, notes } =
    manifest;

  if (installedVersionCode < minSupportedVersionCode) {
    return { kind: 'update_required', latestVersionName, downloadUrl, notes };
  }
  if (installedVersionCode < latestVersionCode) {
    return { kind: 'update_available', latestVersionName, downloadUrl, notes };
  }
  return { kind: 'up_to_date' };
}
