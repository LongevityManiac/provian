#!/usr/bin/env node
/**
 * report-pe — the git post-commit hook's commit witness.
 *
 * "an agent declaring its own work has no path to a
 * PE, minting or record-only." The manual mode (`report-pe --type <x>
 * --description <y>` a caller-chosen type and prose, submitted as the device)
 * is REMOVED. What remains is the one INSTRUMENTATION mode: the git post-commit
 * hook runs `report-pe --hook post-commit --commit-sha <sha>` with the sha it
 * captured synchronously, and this reads everything else about that commit —
 * branch, changed files/lines — from git itself, never from caller flags, and
 * submits one body-bound `coding_session` for it.
 *
 * The named commit is recorded only when it is a WITNESS ( ): a
 * commit object in this repository, HEAD or reachable from HEAD, committed
 * within COMMIT_WITNESS_FRESHNESS_MS of now. Checking out old history and
 * invoking the hook records nothing. An already-installed older hook calls
 * `report-pe --type coding_session … --commit-sha <sha>`; that shape is served
 * the same way, and every other flag it carries is ignored. Any other
 * invocation exits 2 and submits nothing.
 *
 * Usage (installed by the hook, not typed):
 * report-pe --hook post-commit --commit-sha <sha>
 */

import { execFileSync } from 'child_process';
import { ProvianClient } from '../ProvianClient';
import { laneHardwareWitnessProvider } from '../hardware-witness';
import { SUBMIT_OBSERVED_PE } from '../observed-submit';
import { applyRuntimeEnvAtEntry } from '../runtime-env';
import { isDirectCliEntry } from './cli-entry';
import { getCredentialsPath, loadCredentials, type ProvianCredentials } from './credentials';
import type { InputOrigin } from '../input-origins';
import {
  resolvableOrigin, privateOrigin, artifactScanOrigins, observerDeviceWitness, PRIVATE_FILE,
  npmDependencyOrigin,
} from '../observer/origin-capture';
import { resolveRepoDependencies } from '../observer/plugins/GitPlugin';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';

/** The message every non-hook invocation prints. */
export const REPORT_PE_MANUAL_REMOVED_MESSAGE =
  'report-pe: manual reporting was removed. An agent\'s own claim about its work is never a '
  + 'Provenance Envelope. Commits are recorded by the git post-commit hook (report-pe --hook post-commit), '
  + 'which reads the commit from git itself; other work on this machine is recorded by the observer daemon.';

function detectTool(): string {
  // VS Code / Cursor / Windsurf set TERM_PROGRAM
  const tp = process.env.TERM_PROGRAM || '';
  if (tp.includes('vscode') || tp.includes('Code')) return 'vscode';
  if (tp.includes('cursor') || tp.includes('Cursor')) return 'cursor';
  if (tp.includes('windsurf') || tp.includes('Windsurf')) return 'windsurf';
  // Claude Code sets CLAUDE_CODE
  if (process.env.CLAUDE_CODE) return 'claude-code';
  if (process.env.HERMES_AGENT) return 'hermes';
  return 'unknown';
}

function printUsage(): void {
  console.log(`
Usage: report-pe --hook post-commit --commit-sha <sha>

Installed by the Provian git post-commit hook; not a command to type. It records
one coding_session, body-bound to this registered device, for the commit the hook
just made — only when git shows that commit exists, is reachable from HEAD, and
was committed in the last ${COMMIT_WITNESS_FRESHNESS_MS / 60_000} minutes. Branch
and changed files/lines are read from git itself.

Manual reporting (--type / --description) was removed: an actor's own
claim about its work is never a Provenance Envelope.
`);
}

/** How this invocation is served. */
export type ReportPeInvocation =
  | { readonly mode: 'help' }
  /** `claimedSha` is the sha the hook captured synchronously, or null (bare `--hook post-commit`). */
  | { readonly mode: 'hook'; readonly claimedSha: string | null }
  | { readonly mode: 'refused'; readonly reason: string };

const SHA_SHAPE = /^[0-9a-f]{7,64}$/;

/**
 * Classify argv. PURE. Hook mode is `--hook post-commit [--commit-sha <sha>]`
 * (the current hook, which captures the sha synchronously before backgrounding
 * this process) or an older installed hook's `--commit-sha <sha>` shape (its
 * other flags are ignored). A passed sha is only the NAME of the commit to
 * witness; whether it is a commit that just happened on this box is decided by
 * `evaluateCommitWitness` against git itself, never by the caller.
 * Everything else is refused.
 */
export function classifyReportPeInvocation(argv: readonly string[]): ReportPeInvocation {
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'help' };
  const hookIdx = argv.indexOf('--hook');
  if (hookIdx !== -1 && argv[hookIdx + 1] !== 'post-commit') {
    return { mode: 'refused', reason: 'unknown --hook value (only post-commit exists)' };
  }
  const shaIdx = argv.indexOf('--commit-sha');
  if (shaIdx !== -1) {
    const claimed = String(argv[shaIdx + 1] ?? '').trim().toLowerCase();
    if (!SHA_SHAPE.test(claimed)) {
      return { mode: 'refused', reason: 'the --commit-sha given is not a commit sha' };
    }
    return { mode: 'hook', claimedSha: claimed };
  }
  if (hookIdx !== -1) return { mode: 'hook', claimedSha: null };
  return { mode: 'refused', reason: 'manual invocation' };
}

/**
 * The replay bound on a commit witness ( ). The hook runs
 * report-pe in the background IMMEDIATELY after `git commit` returns, so the
 * committer timestamp of the commit it witnesses is seconds old. Ten minutes
 * absorbs a loaded machine, a slow chained repo hook, and a cold Node start,
 * while refusing the replay the review found: `git checkout <old sha>` then
 * invoking the hook over existing history (other authors' commits included).
 * This is a freshness bound on WHICH commit a witness may name, not an economic
 * threshold — it changes no price, weight, or count.
 */
export const COMMIT_WITNESS_FRESHNESS_MS = 10 * 60_000;
/** Tolerated committer-clock lead over now (a clock step between commit and hook). */
export const COMMIT_WITNESS_FUTURE_SKEW_MS = 60_000;

/** How far back HEAD's reflog is scanned for the commit entry (a hook fires seconds after it). */
const COMMIT_WITNESS_REFLOG_SCAN = 200;
/** A reflog subject git writes when THIS repository creates a commit. */
const COMMIT_REFLOG_SUBJECT = /^commit(?: \((?:initial|amend|merge)\))?: /;

/** What git says about the commit a hook invocation names. */
export interface CommitWitnessFacts {
  /** Full lowercase sha when the name resolves to a commit object in this repo, else null. */
  readonly resolvedSha: string | null;
  /**
   * This box MADE the commit: it appears in HEAD's reflog as a `commit` entry
   * (`commit:`, `commit (initial):`, `commit (amend):`, `commit (merge):`). Git
   * writes that entry before post-commit runs, it survives a branch switch or
   * pull that races the backgrounded hook, and a commit that only arrived here
   * (pull, fetch + merge, checkout of history) never carries one.
   */
  readonly madeOnThisBox: boolean;
  /** The resolved commit's COMMITTER time (ms), or null when unreadable. */
  readonly committerTimeMs: number | null;
}

export type CommitWitnessVerdict =
  | { readonly ok: true; readonly commitSha: string }
  | { readonly ok: false; readonly reason: string };

/**
 * PURE. A hook invocation witnesses a commit only when the commit exists in this
 * repository, this box's reflog records making it, and it was committed within
 * COMMIT_WITNESS_FRESHNESS_MS of now (and not more than
 * COMMIT_WITNESS_FUTURE_SKEW_MS in the future).
 */
export function evaluateCommitWitness(facts: CommitWitnessFacts, nowMs: number): CommitWitnessVerdict {
  if (facts.resolvedSha === null) return { ok: false, reason: 'the named commit does not exist in this repository' };
  if (!facts.madeOnThisBox) return { ok: false, reason: 'the named commit was not made in this repository on this box (no commit entry in its reflog)' };
  if (facts.committerTimeMs === null || !Number.isFinite(facts.committerTimeMs)) {
    return { ok: false, reason: 'the named commit has no readable committer time' };
  }
  const ageMs = nowMs - facts.committerTimeMs;
  if (ageMs > COMMIT_WITNESS_FRESHNESS_MS) {
    return { ok: false, reason: `the named commit was committed ${Math.round(ageMs / 1000)}s ago; a hook witnesses only a commit made in the last ${COMMIT_WITNESS_FRESHNESS_MS / 60_000} minutes` };
  }
  if (-ageMs > COMMIT_WITNESS_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'the named commit\'s committer time is in the future' };
  }
  return { ok: true, commitSha: facts.resolvedSha };
}

function readGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Read the witness facts for `claimedSha` (or HEAD when null) from git itself. */
export function readCommitWitnessFacts(claimedSha: string | null): CommitWitnessFacts {
  const none: CommitWitnessFacts = { resolvedSha: null, madeOnThisBox: false, committerTimeMs: null };
  if (claimedSha !== null && !SHA_SHAPE.test(claimedSha)) return none;
  const name = claimedSha ?? 'HEAD';
  const resolved = readGit(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
  if (!resolved || !/^[0-9a-fA-F]{40,64}$/.test(resolved)) return none;
  const resolvedSha = resolved.toLowerCase();
  const reflog = readGit(['log', '-g', '--format=%H%x09%gs', '-n', String(COMMIT_WITNESS_REFLOG_SCAN), 'HEAD']) ?? '';
  const madeOnThisBox = reflog.split('\n').some((line) => {
    const tab = line.indexOf('\t');
    return tab > 0 && line.slice(0, tab).toLowerCase() === resolvedSha && COMMIT_REFLOG_SUBJECT.test(line.slice(tab + 1));
  });
  const ct = readGit(['show', '-s', '--format=%ct', resolvedSha]);
  const seconds = ct !== null && /^\d+$/.test(ct) ? Number(ct) : NaN;
  return { resolvedSha, madeOnThisBox, committerTimeMs: Number.isFinite(seconds) ? seconds * 1000 : null };
}

/** What the hook records, read from the repository — never from caller flags. */
export interface HookCommit {
  readonly commitSha: string;
  readonly branch: string | null;
  readonly filesChanged: number;
  readonly linesAdded: number;
}

/** Read a witnessed commit's facts from the repository. */
export function readHookCommit(commitSha: string): HookCommit {
  const branchRaw = readGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
  let filesChanged = 0;
  let linesAdded = 0;
  const numstat = readGit(['show', '--numstat', '--format=', commitSha]) ?? '';
  for (const line of numstat.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    filesChanged += 1;
    const added = parseInt(cols[0], 10);
    if (Number.isFinite(added)) linesAdded += added;
  }
  return { commitSha, branch, filesChanged, linesAdded };
}

/** A git object name as the hook / CLI may pass it: abbreviated or full hex, nothing else. */
const HEX_OBJECT_NAME = /^[0-9a-fA-F]{7,64}$/;

/**
 * Prompt 2 — derive a coding_session's input_origins from the commit itself, so
 * the global post-commit hook path (which passes --commit-sha but not
 * --input-origins) records the SAME rich origins the observer's GitPlugin
 * records for a watched repo: the PARENT commit hash (resolvable), the repo's
 * resolved dependency coordinates (resolvable), and the changed file paths
 * (PRIVATE — hash only, no plaintext path). observer_device witness (the
 * device's body-HMAC vouches the boundary crossing); the commit subject is
 * artifact-scanned (witnessed:false). Best-effort: any git failure yields no
 * origins and NEVER fails the commit's PE. Exported for unit testing.
 */
export function deriveCodingSessionOrigins(
  commitSha: string,
  credentials: ProvianCredentials,
): InputOrigin[] {
  const witness = observerDeviceWitness(
    credentials.deviceId ?? null, credentials.ownerType, credentials.signingMethod ?? null,
  );
  const origins: InputOrigin[] = [];
  // The sha is a hook / CLI argument. Only a hex object name reaches git, and only as an argv
  // element (execFileSync — no shell), never spliced into a command line (2026-10-17 bug check:
  // the former `execSync` interpolation handed the argument to /bin/sh).
  if (!HEX_OBJECT_NAME.test(commitSha)) return origins;
  let repoRoot = '';
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { return origins; }
  if (!repoRoot) return origins;
  let parentSha = '';
  try {
    parentSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', `${commitSha}^`], {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* a root commit has no parent */ }
  const parentIsObjectName = HEX_OBJECT_NAME.test(parentSha);
  if (parentIsObjectName) {
    origins.push(resolvableOrigin(`commit:${parentSha.toLowerCase()}`, witness));
  }
  if (parentIsObjectName) {
    try {
      const stat = execFileSync('git', ['-C', repoRoot, 'diff', '--numstat', parentSha, commitSha], {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
      if (stat) {
        for (const line of stat.split('\n').slice(0, 20)) {
          const cols = line.split('\t');
          const filePath = cols.length >= 3 ? cols.slice(2).join('\t').trim() : '';
          if (filePath) origins.push(privateOrigin(PRIVATE_FILE, `${repoRoot} ${filePath}`, witness));
        }
      }
    } catch { /* stat failure — origins stay partial, never fatal */ }
  }
  // credentials in a dependency range never leave the device (see GitPlugin).
  for (const dep of resolveRepoDependencies(repoRoot).slice(0, 30)) {
    origins.push(npmDependencyOrigin(dep.name, dep.range, witness));
  }
  try {
    const subject = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--pretty=%s', commitSha], {
      encoding: 'utf-8', timeout: 5000,
    }).trim().slice(0, 500);
    origins.push(...artifactScanOrigins(subject));
  } catch { /* no subject */ }
  return origins;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * The report-pe CLI body.
 *
 * Exported so the single-file bundle can serve `node agent.js report-pe`. The
 * global git post-commit hook bakes whichever runtime artifact
 * `resolveRuntimeTarget` picked; when that is the bundle, this is the entry it
 * reaches. One implementation, two entrypoints — never two copies.
 */
export async function runReportPeCli(): Promise<void> {
  // (C): the npm hook entry applies the recorded egress environment (a
  // no-op under the bundle, whose dispatcher already did).
  applyRuntimeEnvAtEntry();
  // only the git hook mode exists. Classify before credentials so a
  // manual invocation is refused (exit 2) without touching the relay.
  const invocation = classifyReportPeInvocation(process.argv.slice(2));
  if (invocation.mode === 'help') {
    printUsage();
    process.exit(0);
  }
  if (invocation.mode === 'refused') {
    console.error(`${REPORT_PE_MANUAL_REMOVED_MESSAGE} (${invocation.reason})`);
    process.exit(2);
  }
  // : the hook names the commit it captured synchronously;
  // it is recorded only when git shows it is a commit that just happened here.
  const verdict = evaluateCommitWitness(readCommitWitnessFacts(invocation.claimedSha), Date.now());
  if (!verdict.ok) {
    console.error(`report-pe --hook post-commit: nothing recorded — ${verdict.reason}. `
      + 'The hook witnesses a commit as it is made; it does not record existing history.');
    process.exit(2);
  }
  const commit = readHookCommit(verdict.commitSha);

  const credentials = loadCredentials();

  if (!credentials) {
    console.error('Error: Device not registered.');
    console.error(`No credentials found in env or ${getCredentialsPath()}`);
    console.error(HOSTED_BUNDLE
      ? 'Generate a fresh code in the Provian app under "Connect an agent" and paste the install line again.'
      : `Run: ${cliCommand('register-device')}`);
    process.exit(1);
  }

  const { deviceKey, deviceSecret, relayUrl, deviceId, signingMethod, signingKeyAlias } = credentials;

  // Forward signing config so SE-registered devices actually use SE for
  // PE submission. Dropping signingMethod/signingKeyAlias/deviceId here
  // silently demotes every PE to bearer DeviceKey, nullifying the
  // hardware_partial attestation evidence the human Mac registered for.
  // PE meter : the commit's PE is built, chained and kept in this
  // machine's PE store (the same store the observer daemon appends to, under a cross-process
  // lock); the daemon's daily batch carries its act record to the relay. No network here.
  // 2026-10-10: the commit lane carries the same optional hardware_witness slot as the daemon's
  // lanes (a vTPM / Nitro / Confidential VM / Azure / NVIDIA report bound to this act's nonce), so a
  // commit made on a measured observer prices at its best-supported value.
  const provian = new ProvianClient({
    relayUrl,
    deviceKey,
    deviceSecret,
    deviceId,
    signingMethod,
    signingKeyAlias,
    hardwareWitness: laneHardwareWitnessProvider(process.env),
  });

  const tool = detectTool();
  const metadata: Record<string, unknown> = {
    tool,
    files_changed: commit.filesChanged,
    lines_added: commit.linesAdded,
    // commit_sha is the cross-witness mint-once key: the field name MUST be
    // `commit_sha` to match GitPlugin, the forge webhook, and the relay's
    // findPEsByCommitSha lookup — exactly one witness of a commit mints.
    commit_sha: commit.commitSha,
  };
  if (commit.branch) metadata.branch = commit.branch;
  const detail = [`${commit.filesChanged} files`, `${commit.linesAdded} lines`, ...(tool !== 'unknown' ? [tool] : [])];
  const description = `Structural coding_session record (${detail.join(', ')})`;

  // The commit's rich origins (parent hash, resolved deps, changed files) — the
  // SAME origins the observer's GitPlugin records for a watched repo.
  const derived = deriveCodingSessionOrigins(commit.commitSha, credentials);
  const effectiveInputOrigins: InputOrigin[] | undefined = derived.length > 0 ? derived : undefined;

  try {
    const result = await provian[SUBMIT_OBSERVED_PE]({
      actionType: 'coding_session',
      description,
      success: true,
      metadata,
      ...(effectiveInputOrigins !== undefined ? { input_origins: effectiveInputOrigins } : {}),
    });

    if (result && 'recorded_locally' in result) {
      // Truthful: recorded here; it reaches the relay in the observer's next daily batch, and
      // what it earns arrives with that batch's receipt.
      console.log(`PE created: ${result.pe_id} (kept on this machine; sent in the next daily batch)`);
    } else if (result && 'pe_id' in result) {
      console.log(`PE created: ${result.pe_id}`);
    } else if (result && 'peId' in result) {
      console.log(`PE created: ${result.peId}`);
    } else {
      console.error('PE was not recorded (see above)');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Failed to report PE: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run as a CLI when invoked directly (mirrors register-device.ts). Guarded
// so the helpers can be imported by tests without executing the submit flow.
if (isDirectCliEntry(module)) {
  runReportPeCli().catch(err => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
  });
}
