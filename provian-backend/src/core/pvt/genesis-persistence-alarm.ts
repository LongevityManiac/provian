/**
 * The Genesis persistence dependency is no longer silent.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 * `enforceGenesisLaunchSequenceAtStartup` returns immediately when
 * `PUBLIC_LAUNCH` is false. That is correct for a LAUNCH guard — with signup
 * closed there is no launch to gate — but it meant the persistence check never
 * ran at all in the state production is actually in. The enqueue window IS
 * armed. If `FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY` / `FRANK_PVT_APPROVAL_SSH_KEY_SHA256`
 * were dropped in a deploy, truncated, or mangled, **nothing would notice**:
 * no boot failure, no log line, no metric. The dependency would simply stop
 * working, and the first evidence would be a grant that failed to persist.
 *
 * ── WHY IT ALARMS RATHER THAN REFUSING BOOT ───────────────────────────────
 * Refusing startup was the other option offered, and it is the wrong one HERE.
 * A missing Genesis approval key would take the entire relay down — wallets,
 * promises, agent bank, Commons — over a dependency that gates one campaign,
 * and a bad env value would then be unfixable in place because the service
 * could no longer start. The refusal that *is* correct already exists and is
 * untouched: H4 still refuses boot when `PUBLIC_LAUNCH` is true and persistence
 * is not live. This module covers the case H4 structurally cannot see.
 *
 * ── UNMISSABLE ────────────────────────────────────────────────────────────
 * Two surfaces, because a log line alone is exactly what "silent" means:
 *   1. A multi-line boot banner naming the verdict and what to do about it.
 *   2. A Firestore status document (`system_status/genesis_persistence`),
 *      upserted at every boot, so the live state is readable with one query
 *      and no log-diving. It is a RECORD: nothing reads it back, and it
 *      confers no authority.
 *
 * The status document is deliberately NOT exposed on any HTTP surface. An
 * unauthenticated endpoint reporting Genesis persistence state would disclose
 * that Genesis exists, which is the thing being kept closed.
 *
 * UNKNOWN ALARMS. A probe that cannot answer is an alarm under its own verdict,
 * never a quiet pass.
 */

import type { Firestore } from 'firebase-admin/firestore';

/** Where the live state is readable without reading logs. */
export const GENESIS_PERSISTENCE_STATUS_COLLECTION = 'system_status';
export const GENESIS_PERSISTENCE_STATUS_DOCUMENT = 'genesis_persistence';

/** Named outcomes. Exactly two are quiet; everything else alarms. */
export type GenesisPersistenceVerdict =
  | 'quiet_window_unarmed'
  | 'quiet_persistence_live'
  | 'alarm_approval_env_absent'
  | 'alarm_approval_env_malformed'
  | 'alarm_persistence_not_live'
  | 'alarm_persistence_unknown';

const QUIET: ReadonlySet<GenesisPersistenceVerdict> = new Set<GenesisPersistenceVerdict>([
  'quiet_window_unarmed',
  'quiet_persistence_live',
]);

export function isGenesisPersistenceAlarm(verdict: GenesisPersistenceVerdict): boolean {
  return !QUIET.has(verdict);
}

export interface GenesisPersistenceAlarmInput {
  /** Is the Genesis enqueue window armed? If not, there is nothing to protect. */
  readonly enqueueArmed: boolean;
  /** Raw env, so ABSENT stays distinguishable from MALFORMED. */
  readonly approvalPublicKeyRaw: string | undefined;
  readonly approvalKeySha256Raw: string | undefined;
  /**
   * Result of the real persist gate. `undefined` means the probe could not
   * answer (read error, throw) and alarms under its own verdict — it is never
   * collapsed into `false`, which would report the right severity for the
   * wrong reason and would go quiet the moment the read started succeeding
   * with an empty result.
   */
  readonly persistLive: boolean | undefined;
}

/** An OpenSSH ed25519 public key line, as `ssh-ed25519 AAAA… [comment]`. */
const OPENSSH_ED25519 = /^ssh-ed25519\s+[A-Za-z0-9+/]{43,}={0,3}(\s|$)/;
/**
 * The CANONICAL key digest, `sha256:<64 LOWERCASE hex>` — the exact shape
 * `decodeOpenSshEd25519PublicKey` produces and the exact pattern the verifier
 * compares against (`approval-signature.ts:95`, `/^sha256:[a-f0-9]{64}$/`,
 * case-SENSITIVE).
 *
 * Two shapes are deliberately treated as malformed because they look right to a
 * human and would never match: a BARE 64-hex digest with no `sha256:` prefix,
 * and an UPPERCASE digest. Both are precisely the failures this alarm exists to
 * catch — an uppercase digest that read as "well formed" here would push the
 * verdict down to `alarm_persistence_not_live` and misattribute the cause.
 */
const CANONICAL_KEY_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * Decide the verdict. Pure and total, so both the quiet and the alarming
 * branches are reachable in test — a function that can only ever alarm proves
 * nothing about the condition it claims to detect.
 */
export function evaluateGenesisPersistenceAlarm(
  input: GenesisPersistenceAlarmInput,
): GenesisPersistenceVerdict {
  // Nothing armed, nothing at risk. This is the only silence that is earned.
  if (!input.enqueueArmed) return 'quiet_window_unarmed';

  const key = input.approvalPublicKeyRaw;
  const sha = input.approvalKeySha256Raw;
  if (key === undefined || key.trim() === '' || sha === undefined || sha.trim() === '') {
    return 'alarm_approval_env_absent';
  }
  if (!OPENSSH_ED25519.test(key.trim()) || !CANONICAL_KEY_SHA256.test(sha.trim())) {
    return 'alarm_approval_env_malformed';
  }
  if (input.persistLive === undefined) return 'alarm_persistence_unknown';
  if (!input.persistLive) return 'alarm_persistence_not_live';
  return 'quiet_persistence_live';
}

/** What an operator should do, per verdict. Rendered into the boot banner. */
export function genesisPersistenceRemedy(verdict: GenesisPersistenceVerdict): string {
  switch (verdict) {
    case 'quiet_window_unarmed':
      return 'No action: the Genesis enqueue window is not armed, so no in-window grant can be lost.';
    case 'quiet_persistence_live':
      return 'No action: the armed window is backed by a live, verified activation document.';
    case 'alarm_approval_env_absent':
      return 'Set FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY and FRANK_PVT_APPROVAL_SSH_KEY_SHA256 on the '
        + 'service. The window is armed, so every in-window grant currently depends on them.';
    case 'alarm_approval_env_malformed':
      return 'One of FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY / FRANK_PVT_APPROVAL_SSH_KEY_SHA256 is set '
        + 'but not the expected shape. The public key must be an `ssh-ed25519 AAAA...` line. The '
        + 'digest must be `sha256:` followed by 64 LOWERCASE hex characters — exactly what '
        + '`ssh-keygen` output is converted to, and exactly what the verifier compares against. '
        + 'A bare 64-hex digest with no `sha256:` prefix, an uppercase digest, and a quoted or '
        + 'truncated value each look present and verify nothing.';
    case 'alarm_persistence_not_live':
      return 'The approval env is well-formed but the activation document does not admit an '
        + 'in-window act (absent, unsigned, wrong campaign, or killed). Genesis grants inside the '
        + 'armed window will NOT persist.';
    case 'alarm_persistence_unknown':
      return 'The persistence probe could not answer (read error). Treat as not live until it can.';
    default:
      return 'Unrecognized verdict — treat as an alarm.';
  }
}

/**
 * The boot banner. Multi-line and framed on purpose: the failure mode being
 * fixed is a dependency that broke without anyone noticing, and a single
 * `console.warn` in a thousand-line startup log is how that happens.
 */
export function formatGenesisPersistenceBanner(verdict: GenesisPersistenceVerdict): string {
  const bar = '='.repeat(78);
  const label = isGenesisPersistenceAlarm(verdict) ? 'ALARM' : 'ok';
  return [
    '',
    bar,
    `[genesis-persistence] ${label}: ${verdict}`,
    `[genesis-persistence] ${genesisPersistenceRemedy(verdict)}`,
    `[genesis-persistence] live state: ${GENESIS_PERSISTENCE_STATUS_COLLECTION}/`
      + `${GENESIS_PERSISTENCE_STATUS_DOCUMENT}`,
    bar,
    '',
  ].join('\n');
}

export interface GenesisPersistenceStatusRecord {
  readonly schema_version: 'genesis-persistence-status/v1';
  readonly verdict: GenesisPersistenceVerdict;
  readonly alarm: boolean;
  readonly enqueue_armed: boolean;
  readonly approval_public_key_present: boolean;
  readonly approval_key_sha256_present: boolean;
  readonly persist_live: boolean | null;
  readonly remedy: string;
  readonly observed_at_ms: number;
}

/**
 * Build the status record. NEVER carries a key VALUE — only whether each is
 * present — so the document is safe to read, copy, and paste.
 */
export function buildGenesisPersistenceStatus(
  input: GenesisPersistenceAlarmInput,
  observedAtMs: number,
): GenesisPersistenceStatusRecord {
  const verdict = evaluateGenesisPersistenceAlarm(input);
  return {
    schema_version: 'genesis-persistence-status/v1',
    verdict,
    alarm: isGenesisPersistenceAlarm(verdict),
    enqueue_armed: input.enqueueArmed,
    approval_public_key_present: typeof input.approvalPublicKeyRaw === 'string'
      && input.approvalPublicKeyRaw.trim() !== '',
    approval_key_sha256_present: typeof input.approvalKeySha256Raw === 'string'
      && input.approvalKeySha256Raw.trim() !== '',
    persist_live: input.persistLive ?? null,
    remedy: genesisPersistenceRemedy(verdict),
    observed_at_ms: observedAtMs,
  };
}

/**
 * Boot wiring: evaluate, print the banner, and upsert the status document.
 *
 * Runs on EVERY boot regardless of `PUBLIC_LAUNCH` — that independence is the
 * whole point. Never throws: an alarm must not become an outage, and a failed
 * status write must not become one either (it is logged and the banner still
 * printed, so the louder of the two surfaces survives the quieter one failing).
 */
export async function reportGenesisPersistenceAtStartup(
  db: Firestore,
  probePersistLive: () => Promise<boolean>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
  log: (message: string) => void = console.warn,
): Promise<GenesisPersistenceStatusRecord> {
  const { genesisEnqueueArmed } = await import('./genesis-award-state-machine');

  let enqueueArmed = false;
  try {
    enqueueArmed = genesisEnqueueArmed();
  } catch {
    // An unreadable window is treated as ARMED so the alarm still evaluates the
    // dependency rather than going quiet on a failed read.
    enqueueArmed = true;
  }

  let persistLive: boolean | undefined;
  if (enqueueArmed) {
    try {
      persistLive = await probePersistLive();
    } catch {
      persistLive = undefined; // UNKNOWN alarms under its own verdict.
    }
  } else {
    persistLive = false;
  }

  const status = buildGenesisPersistenceStatus({
    enqueueArmed,
    approvalPublicKeyRaw: env.FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY,
    approvalKeySha256Raw: env.FRANK_PVT_APPROVAL_SSH_KEY_SHA256,
    persistLive,
  }, now());

  log(formatGenesisPersistenceBanner(status.verdict));

  try {
    await db.collection(GENESIS_PERSISTENCE_STATUS_COLLECTION)
      .doc(GENESIS_PERSISTENCE_STATUS_DOCUMENT)
      .set(status, { merge: true });
  } catch (error) {
    log(`[genesis-persistence] status document write FAILED: `
      + `${error instanceof Error ? error.message : String(error)} — `
      + 'the banner above is the surviving surface.');
  }

  return status;
}
