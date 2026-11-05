/** Signature- and hash-verified daemon self-update. */
import { ed25519 } from '@noble/curves/ed25519';
import { createHash } from 'crypto';
import { canonicalJson, RELEASE_PUBLIC_KEY } from './release-signature';
export { RELEASE_PUBLIC_KEY } from './release-signature';

/** How often an opted-in daemon looks for a newer signed release. */
export const RELEASE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * (1B): the fast retry interval after a TRANSIENT fail-close. When an update
 * could not complete for a reason that clears on its own — the relay is mid-publish
 * (`pending_bundle`), the bundle download failed, the bundle hash did not match the
 * signed manifest (a cross-revision race during a rolling deploy), or the atomic
 * apply failed — the daemon must not rest on its old release for a full 6 h poll.
 * It retries on this cadence (bounded-backoff, resets to the slow poll on any
 * terminal outcome) so a machine self-recovers within a minute, no operator action.
 */
export const RELEASE_RETRY_INTERVAL_MS = 60 * 1000;

/** Refuse an implausibly large bundle before hashing it (the bundle is ~0.4 MB). */
export const RELEASE_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** Refuse an implausibly large manifest body before parsing it. */
export const RELEASE_MANIFEST_MAX_BYTES = 16 * 1024;

/**
 * Opt-OUT switch (close, the operator ). Self-update is DEFAULT ON; an
 * operator turns it OFF with `PROVIAN_SELF_UPDATE=0` (also `false`/`off`/`no`,
 * case-insensitive). Unset → ON. See `selfUpdateOptedOut`.
 */
export const SELF_UPDATE_ENABLE_ENV = 'PROVIAN_SELF_UPDATE';
/** Optional explicit target path override (defaults to the running entry file). */
export const SELF_UPDATE_TARGET_ENV = 'PROVIAN_SELF_UPDATE_TARGET';

export interface ReleaseManifest {
  /** Monotonic build version. A daemon never applies one not strictly newer. */
  version: number;
  /** ISO-8601, operator display only; never used for a trust decision. */
  issued_at: string;
  bundle: {
    /** Hex sha256 of the EXACT bundle bytes that may run. */
    sha256: string;
    /** Exact byte length of the bundle (a second, cheap integrity check). */
    bytes: number;
    /** Optional minimum Node version the bundle needs (e.g. '20.0.0'). */
    node_min?: string;
  };
}

export interface ReleaseEnvelope {
  manifest: ReleaseManifest;
  /** Ed25519 signature over `canonicalJson(manifest)`, hex. */
  signature: string;
}

export type ReleaseRejection =
  | 'malformed_envelope'
  | 'bad_signature'
  | 'invalid_manifest'
  | 'not_newer'
  | 'too_large';

export interface ReleaseVerification {
  accepted: boolean;
  reason?: ReleaseRejection;
  problems?: string[];
  manifest?: ReleaseManifest;
  version?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SEMVERISH = /^\d{1,4}(\.\d{1,5}){0,2}$/;

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Structural validation of a manifest — applied AFTER the signature, BEFORE use.
 * A signature proves the bytes are Provian's; it does not prove they are sane.
 */
export function validateReleaseManifest(value: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const m = value as ReleaseManifest | null;
  if (!m || typeof m !== 'object') return { ok: false, problems: ['manifest is not an object'] };
  if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) {
    problems.push('version must be a positive integer');
  }
  if (typeof m.issued_at !== 'string' || m.issued_at.length === 0 || m.issued_at.length > 64) {
    problems.push('issued_at must be a short string');
  }
  const b = m.bundle;
  if (!b || typeof b !== 'object') {
    problems.push('bundle spec is missing');
  } else {
    if (typeof b.sha256 !== 'string' || !HEX64.test(b.sha256)) problems.push('bundle.sha256 must be a 64-hex digest');
    if (typeof b.bytes !== 'number' || !Number.isInteger(b.bytes) || b.bytes < 1 || b.bytes > RELEASE_MAX_BUNDLE_BYTES) {
      problems.push('bundle.bytes must be a positive integer within the size cap');
    }
    if (b.node_min !== undefined && (typeof b.node_min !== 'string' || !SEMVERISH.test(b.node_min))) {
      problems.push('bundle.node_min must be a version string');
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Verify and accept a release envelope.
 *
 * ORDER IS LOAD-BEARING: signature FIRST, structure SECOND, freshness THIRD —
 * identical discipline to the catalog. We never spend structural effort on bytes
 * that are not Provian's, and we never accept on structure alone.
 */
export function verifyReleaseManifest(
  envelope: unknown,
  currentVersion: number,
  publicKeyHex: string = RELEASE_PUBLIC_KEY,
): ReleaseVerification {
  const env = envelope as ReleaseEnvelope | null;
  if (!env || typeof env !== 'object' || typeof env.signature !== 'string' || !env.manifest) {
    return { accepted: false, reason: 'malformed_envelope' };
  }
  const sig = hexToBytes(env.signature);
  const pub = hexToBytes(publicKeyHex);
  if (!sig || !pub || pub.length !== 32) return { accepted: false, reason: 'malformed_envelope' };

  let message: string;
  try {
    message = canonicalJson(env.manifest);
  } catch {
    return { accepted: false, reason: 'malformed_envelope' };
  }

  let signatureOk = false;
  try {
    signatureOk = ed25519.verify(sig, new TextEncoder().encode(message), pub);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { accepted: false, reason: 'bad_signature' };

  const validation = validateReleaseManifest(env.manifest);
  if (!validation.ok) return { accepted: false, reason: 'invalid_manifest', problems: validation.problems };

  // Monotonic: a replayed older-but-signed manifest cannot roll a daemon back
  // onto a superseded bundle.
  if (env.manifest.version <= currentVersion) {
    return { accepted: false, reason: 'not_newer', version: env.manifest.version };
  }
  return { accepted: true, manifest: env.manifest, version: env.manifest.version };
}

/** True when `have` (e.g. '26.0.0') is strictly LOWER than `need` (e.g. '20.0.0'). */
export function nodeVersionBelow(have: string, need: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Every side effect a self-update performs, injected so the decision logic is
 * unit-testable and so a test never touches a real file or re-execs the runner.
 */
export interface SelfUpdateIO {
  /**
   * Fetch the signed release envelope (parsed body + byte length). Throws on fault.
   * (1B): `pending: true` signals the relay has a manifest but its bundle is
   * not yet in place on the serving revision (HTTP 409) — a transient, self-clearing
   * publish-in-flight state, distinct from "no manifest".
   */
  fetchManifest(): Promise<{ body: unknown; bytes: number; pending?: boolean }>;
  /** Download the bundle bytes from the FIXED relay bundle URL. Throws on fault. */
  fetchBundle(): Promise<Buffer>;
  /** Bytes of the currently-running target file, or null when unreadable. */
  readCurrent(): Buffer | null;
  /** Atomically replace the target with `bytes` (temp + fsync + rename). Throws on failure. */
  applyBytes(bytes: Buffer): void;
  /** Last-applied version, persisted so it survives a restart (default 0). */
  readVersion(): number;
  writeVersion(v: number): void;
  /** Re-exec so the new bytes run (default: exit(0) → the supervisor relaunches). */
  reExec(): void;
  log(level: string, msg: string, extra?: Record<string, unknown>): void;
  nodeVersion: string;
}

export type SelfUpdateOutcome =
  | { status: 'no_manifest' }
  | { status: 'pending_bundle' }
  | { status: 'not_newer'; version?: number }
  | { status: 'rejected'; reason: string }
  | { status: 'node_too_old'; need: string; have: string }
  | { status: 'already_current'; version: number }
  | { status: 'applied'; version: number };

/**
 * (1B): the outcomes that clear on their own and so warrant a FAST retry
 * (`RELEASE_RETRY_INTERVAL_MS`) rather than the slow poll — a machine must not rest
 * on an old release after a transient fail-close. Every other outcome (no manifest,
 * not newer, already current, node too old, a signature/structure rejection) is
 * terminal for this cycle and returns to the slow poll.
 */
export function isTransientSelfUpdateOutcome(outcome: SelfUpdateOutcome): boolean {
  if (outcome.status === 'pending_bundle') return true;
  return outcome.status === 'rejected'
    && (outcome.reason === 'bundle_hash_mismatch'
      || outcome.reason === 'bundle_fetch_failed'
      || outcome.reason === 'apply_failed');
}

/**
 * Run one self-update check. Never throws — a self-update must not be able to
 * disturb the running daemon. The ONLY step that changes the running code is the
 * final apply, and it is reached only after a valid Provian signature AND a
 * byte-exact hash match against that signed manifest.
 *
 * `publicKeyHex` defaults to the pinned `RELEASE_PUBLIC_KEY`; production never
 * passes it (the daemon's IO builder does not). It exists so tests can verify the
 * accept/apply path with a throwaway key they can actually sign with.
 */
export async function runSelfUpdateOnce(
  io: SelfUpdateIO,
  publicKeyHex: string = RELEASE_PUBLIC_KEY,
): Promise<SelfUpdateOutcome> {
  const currentVersion = safe(() => io.readVersion(), 0);

  let body: unknown;
  try {
    const res = await io.fetchManifest();
    // (1B): the relay has a signed manifest but its bundle is not yet the one
    // this revision serves (a publish/deploy is mid-flight). Do NOT fetch a bundle
    // that cannot match — return the transient state so the loop retries soon.
    if (res.pending === true) {
      io.log('debug', 'release pending — bundle not yet in place; will retry soon');
      return { status: 'pending_bundle' };
    }
    if (res.bytes > RELEASE_MANIFEST_MAX_BYTES) {
      io.log('warn', 'release manifest refused', { reason: 'too_large', bytes: res.bytes });
      return { status: 'rejected', reason: 'too_large' };
    }
    body = res.body;
  } catch (err) {
    io.log('debug', 'release manifest not fetched', { error: (err as Error).message });
    return { status: 'no_manifest' };
  }

  const verdict = verifyReleaseManifest(body, currentVersion, publicKeyHex);
  if (!verdict.accepted) {
    if (verdict.reason === 'not_newer') {
      io.log('debug', 'release manifest not newer', { current_version: currentVersion, version: verdict.version });
      return { status: 'not_newer', version: verdict.version };
    }
    io.log('warn', 'release manifest refused', { reason: verdict.reason, problems: verdict.problems ?? null });
    return { status: 'rejected', reason: verdict.reason ?? 'invalid_manifest' };
  }
  const manifest = verdict.manifest!;

  // A bundle that needs a newer Node than this runtime would crash-loop under the
  // supervisor. Refuse it here rather than apply-and-die.
  if (manifest.bundle.node_min && nodeVersionBelow(io.nodeVersion, manifest.bundle.node_min)) {
    io.log('warn', 'release requires a newer Node — not applied', {
      need: manifest.bundle.node_min, have: io.nodeVersion, version: manifest.version,
    });
    return { status: 'node_too_old', need: manifest.bundle.node_min, have: io.nodeVersion };
  }

  let bundle: Buffer;
  try {
    bundle = await io.fetchBundle();
  } catch (err) {
    io.log('warn', 'release bundle not fetched', { error: (err as Error).message, version: manifest.version });
    return { status: 'rejected', reason: 'bundle_fetch_failed' };
  }

  // THE fail-closed gate: the bytes that will run must be EXACTLY the bytes the
  // signed manifest names. Length first (cheap), then the digest.
  if (bundle.length !== manifest.bundle.bytes || sha256Hex(bundle) !== manifest.bundle.sha256) {
    io.log('warn', 'release bundle hash/length mismatch — NOT applied', {
      version: manifest.version,
      expected_bytes: manifest.bundle.bytes,
      got_bytes: bundle.length,
    });
    return { status: 'rejected', reason: 'bundle_hash_mismatch' };
  }

  // Idempotence + no re-exec loop: if the running file already IS these signed
  // bytes, record the version and stop — never swap identical bytes and re-exec.
  const current = safe(() => io.readCurrent(), null);
  if (current && sha256Hex(current) === manifest.bundle.sha256) {
    safe(() => io.writeVersion(manifest.version), undefined);
    io.log('debug', 'release already current', { version: manifest.version });
    return { status: 'already_current', version: manifest.version };
  }

  try {
    io.applyBytes(bundle);
  } catch (err) {
    io.log('warn', 'release apply failed — keeping current bytes', { error: (err as Error).message });
    return { status: 'rejected', reason: 'apply_failed' };
  }
  // Persist the version BEFORE re-exec so the relaunched process sees it as
  // current and does not re-apply (belt-and-suspenders with the identical-bytes
  // check above).
  safe(() => io.writeVersion(manifest.version), undefined);
  io.log('info', 'release applied — re-exec to run new bytes', { version: manifest.version });
  try {
    io.reExec();
  } catch (err) {
    io.log('warn', 'release re-exec failed (new bytes will run on next restart)', { error: (err as Error).message });
  }
  return { status: 'applied', version: manifest.version };
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export interface SelfUpdateConfig {
  /** Absolute path to the running single-file bundle to replace. */
  targetPath: string;
  /** How often to poll for a newer release. */
  pollIntervalMs: number;
}

/**
 * True when the operator has explicitly OPTED OUT of self-update. Self-update is
 * default-on (the operator ), so this is the only thing that turns it off:
 * `PROVIAN_SELF_UPDATE` set to `0`/`false`/`off`/`no` (trimmed, case-insensitive).
 * Any other value — and, crucially, an UNSET variable — leaves it ON.
 */
export function selfUpdateOptedOut(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * Resolve the self-update config from the environment. Default on: returns a config unless the operator has explicitly opted OUT with
 * `PROVIAN_SELF_UPDATE=0`. The target is the running entry file (a single-file
 * bundle) unless overridden.
 *
 * A missing target (no argv entry and no override) yields null — there is nothing
 * safe to replace, so the feature stays inert rather than guess. That is not an
 * opt-out; it is "no bundle to swap", and it reads the same on a machine that has
 * nothing to update.
 */
/**
 * The entry file self-update may replace: the running entry ONLY when this process IS the hosted
 * single-file bundle (`~/.provian/agent.js`, esbuild-folded `__PROVIAN_HOSTED_BUNDLE__`). An npm /
 * tarball install runs `dist/scripts/start-observer.js`, a thin script inside a package — writing
 * the bundle over it and re-exec'ing the same argv runs the bundle's onboarding entry, not
 * `observe` (seen live 2026-10-10: a restart loop on "reading your invite code"). So a non-bundle
 * entry yields undefined ("no bundle to swap", inert); `PROVIAN_SELF_UPDATE_TARGET` still overrides.
 */
export function selfUpdateEntryFor(hostedBundle: boolean, entryPath: string | undefined): string | undefined {
  return hostedBundle ? entryPath : undefined;
}

export function resolveSelfUpdateConfig(
  env: NodeJS.ProcessEnv,
  entryPath: string | undefined,
): SelfUpdateConfig | null {
  if (selfUpdateOptedOut(env[SELF_UPDATE_ENABLE_ENV])) return null;
  const target = (env[SELF_UPDATE_TARGET_ENV] && env[SELF_UPDATE_TARGET_ENV]!.trim())
    || (entryPath && entryPath.trim())
    || '';
  if (!target) return null;
  return { targetPath: target, pollIntervalMs: RELEASE_POLL_INTERVAL_MS };
}
