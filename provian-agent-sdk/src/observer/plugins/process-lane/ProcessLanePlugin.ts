/**
 * ProcessLanePlugin — the fourth capture lane.
 *
 * Witnesses the commands an agent runs on its OWN cloud VM by reading the OS
 * process table directly, for an agent whose work no described lane sees (no
 * session files, no model-proxy routing, no OTel). It captures continuously on a
 * tight timer (decoupled from the observer's 1 Hz submit tick), folds everything
 * one command starts into one act (`acts.ts`), and seals one
 * `agent_tool_orchestration` PE per completed command — never the daemon's own
 * tree, the OS, or the VM runtime's background services.
 *
 * one lane per program. The lane is INERT on a device whose agent has
 * any other lane (a described session store, the model proxy, OTel), and on every box it mints
 * only commands the agent's recorded LAUNCHER started with the recorded wrapper (`launcher.ts`) —
 * never the OS's or the platform's background jobs, other users' programs, or the harness's own
 * checks. On Linux it reads the launcher's children every 20 ms, so a 50 ms command is seen.
 *
 * Owner-gate: AGENT devices only (`resolveActivePlugins` drops it on humans,
 * which produce no tool-call witnesses on any lane —). Platform: Linux and
 * macOS; elsewhere the reader is empty and the lane is inert.
 *
 * Mint-once is the daemon's OWN durable ledger (`~/.provian/process-lane-ledger.json`,
 * ) advanced only once the relay accepts (or durably journals) a PE, so a
 * transient failure is retried, not burned. The ledger lives in the home
 * directory and so returns after a VM replacement. Privacy is
 * structure-only: argv and environments are hashed in `acts.ts`; only hashes,
 * counts and privacy-classed origins reach a PE.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ObserverPlugin, PECommitOutcome } from '../PluginInterface';
import type { ProvianObserver } from '../../ProvianObserver';
import type { PluginContribution, PluginPE, SessionState } from '../../types';
import { ProgramWitnessRegistry } from '../../program-witness';
import { writeLocal } from '../../program-witness';
import { createHash } from 'crypto';
import { defaultSnapshotReader, LinuxLauncherSubtreeReader, scanLinuxLight, readLinuxProcEntry, processStartedAtMs, type ProcEntry, type ProcSnapshot, type SnapshotReader } from './snapshot';
import { ProcessActTracker, type ActLedger, type RootClass, type SealedAct } from './acts';
import { DEFAULT_SEAL_GRACE_MS, KNOWN_HOUSEKEEPING_CAP } from './acts';
import { launcherFingerprint, launcherFingerprintOf, launcherProgram, launcherRecordKey, matchesTemplate, processLauncherPath, readLauncherRecord, type LauncherRecord } from './launcher';

/** The daemon lane label the relay admits `agent_tool_orchestration` under (parity). */
export const PROCESS_LANE_SOURCE = 'process';
export const PROCESS_LANE_TOOL = 'provian:process';

const LEDGER_CAP = 10_000;
const MAX_RETRIES = 5;

export function processLaneLedgerPath(home = os.homedir()): string {
  return path.join(home, '.provian', 'process-lane-ledger.json');
}

/** The durable mint-once + known-service ledger, bounded FIFO, atomic writes. */
/** Claimed start keys are pruned when their process exits; this bound only stops runaway growth. */
const CLAIM_HARD_CAP = 100_000;

export class FileActLedger implements ActLedger {
  private minted: string[] = [];
  private serviced: string[] = [];
  private claimed: string[] = [];
  private housekeeping: string[] = [];
  private baseline: { record: string; left: number } | null = null;
  private readonly mintedSet = new Set<string>();
  private readonly servicedSet = new Set<string>();
  private readonly claimedSet = new Set<string>();

  constructor(private readonly file = processLaneLedgerPath()) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { minted?: unknown; serviced?: unknown; claimed?: unknown; housekeeping?: unknown; housekeeping_baseline?: unknown };
      if (Array.isArray(raw.minted)) this.minted = raw.minted.filter((x): x is string => typeof x === 'string');
      if (Array.isArray(raw.serviced)) this.serviced = raw.serviced.filter((x): x is string => typeof x === 'string');
      if (Array.isArray(raw.claimed)) this.claimed = raw.claimed.filter((x): x is string => typeof x === 'string');
      const b = raw.housekeeping_baseline as { record?: unknown; left?: unknown } | null | undefined;
      if (b && typeof b.record === 'string' && /^[0-9a-f]{64}$/.test(b.record) && Number.isInteger(b.left) && (b.left as number) >= 0) this.baseline = { record: b.record, left: b.left as number };
      if (Array.isArray(raw.housekeeping)) this.housekeeping = raw.housekeeping.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)).slice(-KNOWN_HOUSEKEEPING_CAP);
    } catch { /* fresh ledger */ }
    for (const k of this.minted) this.mintedSet.add(k);
    for (const k of this.serviced) this.servicedSet.add(k);
    for (const k of this.claimed) this.claimedSet.add(k);
  }

  hasMinted(key: string): boolean { return this.mintedSet.has(key); }
  isClaimed(startKey: string): boolean { return this.claimedSet.has(startKey); }

  /** Processes that were part of a command act (`ProcessActTracker` — once the command's, always). */
  claim(startKeys: readonly string[]): void {
    let changed = false;
    for (const k of startKeys) {
      if (this.claimedSet.has(k)) continue;
      this.claimedSet.add(k);
      this.claimed.push(k);
      changed = true;
    }
    if (!changed) return;
    // Claims leave only when their process is gone (`pruneClaims`); this cap is a last resort.
    while (this.claimed.length > CLAIM_HARD_CAP) this.claimedSet.delete(this.claimed.shift()!);
    // A build's thousands of processes are written at most once a second (`flush` on every poll).
    this.dirty = true;
    if (Date.now() - this.lastPersistAtMs >= 1_000) this.persist();
  }

  /** At most one write a second (a build's thousands of processes); `force` (stop, a seal) writes now. */
  flush(force = false): void {
    if (!this.dirty) return;
    if (!force && Date.now() - this.lastPersistAtMs < 1_000) return;
    this.persist();
  }

  /** Drop the claims of processes that have exited (a live one is never dropped — round 7). */
  pruneClaims(isAlive: (startKey: string) => boolean): void {
    const kept = this.claimed.filter((k) => isAlive(k));
    if (kept.length === this.claimed.length) return;
    for (const k of this.claimed) if (!kept.includes(k)) this.claimedSet.delete(k);
    this.claimed = kept;
    this.persist();
  }
  isServiced(identity: string): boolean { return this.servicedSet.has(identity); }

  /** The harness's own start shapes (hashes only), confirmed by its commands (`acts.ts`). */
  housekeepingShapes(): readonly string[] { return this.housekeeping; }

  housekeepingBaseline(): { record: string; left: number } | null { return this.baseline; }

  setHousekeepingBaseline(record: string, left: number): void {
    if (this.baseline && this.baseline.record === record && this.baseline.left === left) return;
    this.baseline = { record, left };
    this.persist();
  }

  learnHousekeeping(shapes: readonly string[]): void {
    const fresh = shapes.filter((s) => /^[0-9a-f]{64}$/.test(s) && !this.housekeeping.includes(s));
    if (fresh.length === 0) return;
    this.housekeeping.push(...fresh);
    if (this.housekeeping.length > KNOWN_HOUSEKEEPING_CAP) this.housekeeping = this.housekeeping.slice(-KNOWN_HOUSEKEEPING_CAP);
    this.persist();
  }

  recordMinted(key: string): void {
    if (this.mintedSet.has(key)) return;
    this.mintedSet.add(key);
    this.minted.push(key);
    while (this.minted.length > LEDGER_CAP) this.mintedSet.delete(this.minted.shift()!);
    this.persist();
  }

  recordServiced(identity: string): void {
    if (this.servicedSet.has(identity)) return;
    this.servicedSet.add(identity);
    this.serviced.push(identity);
    while (this.serviced.length > LEDGER_CAP) this.servicedSet.delete(this.serviced.shift()!);
    this.persist();
  }

  private dirty = false;
  private lastPersistAtMs = 0;

  private persist(): void {
    this.dirty = false;
    this.lastPersistAtMs = Date.now();
    try { writeLocal(this.file, { minted: this.minted, serviced: this.serviced, claimed: this.claimed, housekeeping: this.housekeeping, housekeeping_baseline: this.baseline }); } catch { /* best-effort */ }
  }
}

export interface ProcessLaneOptions {
  /** Full-scan poll interval (ms): macOS, and Linux without per-thread children lists. Default 250 ms. */
  readonly pollMs?: number;
  /** Is the process with this start key still running (tests; production reads the OS)? */
  readonly isAlive?: (startKey: string) => boolean;
  /** Tests: judge liveness from the lane's own whole-table reads, as production does off Linux. */
  readonly osLiveness?: boolean;
  /** Tests: this daemon's pid (default `process.pid`). */
  readonly observerPid?: number;
  /** Fast poll of the launcher's subtree on Linux (ms). Default 20 ms: a hosted harness's command
   *  tree lives 50 ms or more (Grok's measured 54–73 ms); a whole tree shorter than one poll is missed. */
  readonly fastMs?: number;
  /** When the OS says a process started (tests); default `processStartedAtMs` for this platform. */
  readonly startedAtMs?: (p: ProcEntry) => number | null;
  /** Launcher discovery interval (ms) while a launcher is bound. Default `DISCOVERY_BOUND_MS` when the
   *  lane reads only launchers' subtrees (Linux), else `DISCOVERY_FULL_READ_MS`. */
  readonly discoveryMs?: number;
  /** Injectable full reader (tests); default the real OS reader for this platform. */
  readonly reader?: SnapshotReader;
  /** Injectable fast subtree reader (tests). Null forces full-scan mode. */
  readonly subtreeReader?: { read(launcherPids: readonly number[], nowMs: number): ProcSnapshot | 'unsupported' } | null;
  /** Injectable discovery scan (tests): pid → { startKey, ppid, comm }. */
  readonly scanLight?: () => ReadonlyMap<number, { readonly startKey: string; readonly ppid: number; readonly comm: string }>;
  /** Injectable full entry reader for discovery candidates (tests). */
  readonly readEntry?: (pid: number) => ProcEntry | null;
  /** Injectable ledger (tests); default the home-directory file ledger. */
  readonly ledger?: ActLedger;
  /** Injectable program identifier (tests); default the machine's program-witness registry. */
  readonly identifyProgram?: (entry: { pid: number; args: string; argv?: readonly string[]; exe?: string }) => string | null;
  /** True when this agent has another lane (then this lane is inert). Default: the registry holds a program. */
  readonly otherLaneActive?: () => boolean;
  /** The launcher record file (tests). */
  readonly launcherFile?: string;
  /** Where the action file and lane state are written (tests); default `~/.provian`. */
  readonly stateDir?: string;
  /** This daemon's uid (tests). */
  readonly uid?: number | null;
  /** Override now() (tests). */
  readonly now?: () => number;
  /** Platform (tests). */
  readonly platform?: NodeJS.Platform;
  /** The independent audit's interval (ms). Default 15 s. */
  readonly auditMs?: number;
  /** Injectable audit scan (tests): every process, read fresh with no cache. */
  readonly auditScan?: () => ProcSnapshot;
}

/** One capture-health window of the audit's cross-check (/ parity). */
export interface ProcessLaneWindow {
  /** A process matching the recorded launcher was running at some audit this window. */
  readonly launcherLive: boolean;
  /** Commands the audit saw the launcher start that are now past the time they must have sealed by. */
  readonly commandsDue: number;
  /** Of those, how many the lane sealed. `commandsDue > 0 && commandsDueSealed === 0` is silence. */
  readonly commandsDueSealed: number;
  /** Launcher processes the audit found that discovery had not (the lane re-bound to them). */
  readonly launcherHeals: number;
}

/** The lane's state, as capture health reports it (closed set). */
export type ProcessLaneState =
  | 'active'
  | 'inert_other_lane'
  | 'no_launcher'
  /** No live process matches the recorded launcher's fingerprint (for `LAUNCHER_NOT_SEEN_MS`): flagged. */
  | 'launcher_not_seen'
  /** The launcher (fingerprint matched) keeps starting programs that do not start the recorded way:
   * its wrapper may have changed, or these are checks of its own the lane has not learned. Never shown
   * to anyone : any `provian` command the agent runs under that launcher re-records
   * the wrapper (`recordLauncher`), and a matching command clears it. */
  | 'launcher_unconfirmed'
  /** Flagged: the suspicion stood while the harness kept starting programs and none was recognised or
   * re-recorded the wrapper (`cause` 'wrapper'), or the harness runs only inside one of the agent's own
   * commands (`cause` 'inside_command'). */
  | 'launcher_changed'
  /** The recorded launcher hands the command to its child itself (`direct` mode): unserved, flagged. */
  | 'launcher_unsupported'
  | 'unsupported_platform';
export const PROCESS_LANE_STATES: readonly ProcessLaneState[] = ['active', 'inert_other_lane', 'no_launcher', 'launcher_not_seen', 'launcher_unconfirmed', 'launcher_changed', 'launcher_unsupported', 'unsupported_platform'];

/** Launcher children in a row with no command, over ≥2 distinct starts, before the lane suspects a harness change. */
export const LAUNCHER_DRIFT_STREAK = 6;
/**
 * (the correction): the suspicion is flagged only once the agent's own commands
 * have had their chance to re-record the wrapper — after the suspicion was written (from then any
 * `provian` command heals it), this many children of the streak behaved like the agent's commands (the launcher started its next child within `POST_COMMAND_WINDOW_MS` of their end,
 * as a harness does with its own check after each command), with still no command recognised and no
 * re-record. An idle harness's own unlearned check is never followed so closely, so an idle agent is
 * never flagged; a suspicion a matching command clears (the flicker) is never shown. Declared limit: a
 * harness that starts nothing right after a command gives no such evidence, so its changed wrapper
 * stays an unshown suspicion until the agent's next `provian` command re-records it.
 */
export const LAUNCHER_CHANGE_FLAG_COMMANDS = LAUNCHER_DRIFT_STREAK;
/** A command shape this many tokens long is the harness's own wrapper, never a person's shell. */
const DISTINCTIVE_TEMPLATE_TOKENS = 3;
/** The harness has run only inside one of the agent's commands this long → flag it (a supervisor's restart gap is shorter). */
export const LAUNCHER_INSIDE_COMMAND_MS = 30_000;
/** No launcher process seen this long (with a record) → flag it. */
export const LAUNCHER_NOT_SEEN_MS = 10 * 60_000;
/** A pause between poll ticks this long is the machine asleep, not the launcher missing. */
const SUSPEND_GAP_MS = 30_000;
/** How often the registry / launcher record are re-read (two small files). */
const CONFIG_REFRESH_MS = 1_000;
/** How long discovery trusts a process's command line read earlier (it is re-read after an exec that
 *  changes the process name at once). */
const LIGHT_PROGRAM_TTL_UNBOUND_MS = 2_000;
const LIGHT_PROGRAM_TTL_BOUND_MS = 60_000;
/**
 * witness check on release 92: a hosted harness starts a separate harness process for each
 * scheduled session, beside the one already bound, and that session's first command came 1.5 s after
 * the process appeared and lived under 100 ms (Grok, 19:04:54Z). Where the lane reads only bound
 * launchers' subtrees (Linux), a new harness process must be bound before its first command:
 * discovery runs this often while a launcher is bound (it ran every 2 s, and that command never sealed).
 */
export const DISCOVERY_BOUND_MS = 250;
/** Where every read is of the whole process table (macOS), the tracker reads a new harness's
 *  children from its first read and discovery takes them back when it binds it (round 3). */
export const DISCOVERY_FULL_READ_MS = 2_000;
/** A command the audit saw is due to have sealed this long after its seal hold ends. */
const AUDIT_DUE_MARGIN_MS = 60_000;
export const PROCESS_LANE_ACTION_INSTRUCTION =
  'Your harness changed how it starts your commands, so the Provian process lane cannot recognise them. '
  + 'From your own harness, as an ordinary command, run "$HOME/.provian/bin/provian" process-lane record. Keep the observer running. Never declare work or submit PEs.';
export const PROCESS_LANE_INSIDE_COMMAND_INSTRUCTION =
  'Your harness now runs inside one of your own commands, so the Provian process lane cannot recognise your commands. '
  + 'From your own harness, as an ordinary command, run "$HOME/.provian/bin/provian" process-lane record. Keep the observer running. Never declare work or submit PEs.';
export const PROCESS_LANE_NOT_SEEN_INSTRUCTION =
  'No running program matches the recorded launcher of your commands, so the Provian process lane is not watching your commands. '
  + 'From your own harness, as an ordinary command, run "$HOME/.provian/bin/provian" process-lane record. Keep the observer running. Never declare work or submit PEs.';
/** `process-lane-state.json` format. 2: `launcher_changed` is a flag (shown), with its `cause`; a file
 *  without `v` said `launcher_changed` for an unconfirmed suspicion too. */
export const PROCESS_LANE_STATE_FILE_VERSION = 2;
type ChangeCause = 'wrapper' | 'inside_command';
/** The flags a daemon restart restores until they clear on their own evidence (`restoreFlag`). */
type RestorableFlag = 'launcher_changed' | 'launcher_unconfirmed' | 'launcher_not_seen';
const RESTORABLE_FLAGS: ReadonlySet<string> = new Set<RestorableFlag>(['launcher_changed', 'launcher_unconfirmed', 'launcher_not_seen']);

/** follow-up : the lane is this agent's witness and nothing recorded a launcher
 * (a computer set up by a person from the emailed line, or an install whose own record failed). */
export const PROCESS_LANE_NO_LAUNCHER_INSTRUCTION =
  'No launcher is recorded on this computer, so the Provian process lane witnesses none of your commands. '
  + 'From your own session, as an ordinary command, run "$HOME/.provian/bin/provian" process-lane record once. Keep the observer running. Never declare work or submit PEs.';
/** The states that leave the agent an instruction in witness-action-required.json (the flagged ones;
 *  never the unshown suspicion). */
const ACTION_STATES: ReadonlySet<ProcessLaneState> = new Set<ProcessLaneState>(['launcher_changed', 'launcher_not_seen', 'no_launcher']);

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * Keep only the outermost matches: a process under another process that matches the record is part of
 * what that launcher runs (a copy of the harness an agent's command starts), never a launcher of its
 * own ( ).
 */
function outermostOnly<V>(found: Map<number, V>, ppidOf: (pid: number) => number | undefined): void {
  const all = new Set(found.keys());
  for (const pid of all) {
    let cur = ppidOf(pid);
    for (let depth = 0; cur !== undefined && cur > 0 && depth < 64; depth++) {
      if (all.has(cur)) { found.delete(pid); break; }
      cur = ppidOf(cur);
    }
  }
}

export class ProcessLanePlugin implements ObserverPlugin {
  readonly name = 'process_lane';
  private observer!: ProvianObserver;
  private reader!: SnapshotReader;
  private ledger!: ActLedger;
  private tracker!: ProcessActTracker;
  private timer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private readonly fastMs: number;
  private readonly discoveryMs: number | null;
  /** Discovery reads so far; the read each live process was first seen in; the last fresh read that
   *  showed it not to be the launcher (see `bindLaunchers`). */
  private scanNo = 0;
  private firstSeenScan = new Map<string, number>();
  /** startKey → the program its latest fresh read showed, that read, and the last fresh read that showed
   *  it running a different program (it exec'd since; round 18: a record change is no exec). */
  private programSeen = new Map<string, { program: string; since: number; lastFresh: number; otherUntil?: number; comm?: string; lastNamed?: number }>();
  /** The first discovery read since the lane began reading (what was running then predates it). */
  private baseScan: number | null = null;
  /** startKey → its program, read from its command line (Linux light scans). */
  private readonly lightProgramCache = new Map<string, { comm: string; program: string; atMs: number }>();
  /** Launchers this daemon has bound. */
  private boundStartKeys = new Set<string>();
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  /** PEs waiting to be drained, in seal order, plus retries. */
  private readonly queue: PluginPE[] = [];
  /** turn_id → the sealed act (for ledger + retry bookkeeping) and attempt count. */
  private readonly inFlight = new Map<string, { act: SealedAct; attempts: number }>();
  private active = false;
  private actsSealed = 0;
  private lastActAtMs: number | null = null;
  private lastPollAtMs: number | null = null;
  /** The last tick of the poll timer (a gap far longer than a tick is the machine asleep). */
  private lastTickAtMs: number | null = null;
  private identify!: (entry: { pid: number; args: string; argv?: readonly string[]; exe?: string }) => string | null;
  private subtree: { read(launcherPids: readonly number[], nowMs: number): ProcSnapshot | 'unsupported'; hasChildren?(launcherPids: readonly number[]): boolean } | null = null;
  /** Fast mode: the launcher had no children on the previous tick (idle), and when we last read fully. */
  private launcherIdle = false;
  private lastSubtreeReadAtMs = -Infinity;
  private record: LauncherRecord | null = null;
  private recordKey = '';
  private inert = false;
  private state: ProcessLaneState = 'no_launcher';
  private lastConfigAtMs = -Infinity;
  private lastDiscoveryAtMs = -Infinity;
  private lastFullAtMs = -Infinity;
  private lastLauncherSeenAtMs: number | null = null;
  /** Launcher pid → start key, from the last discovery. */
  private launcherPids = new Map<number, string>();
  /** start key → fingerprint (discovery cache). */
  private readonly fingerprintCache = new Map<string, string>();
  /** The only harness running is one the agent started inside one of its commands (flagged). */
  private launcherInsideCommand = false;
  private insideCommandSinceMs: number | null = null;
  /** The start keys of the last whole-table read (liveness off Linux), and whether it saw this daemon. */
  private lastFullKeys = new Set<string>();
  private lastFullTrusted = false;
  /** A launcher record took effect: the acts the lane holds are judged again under it (next poll). */
  private rejudgePending = false;
  /** A flag the lane raised before a daemon restart, restored until it is affirmatively cleared. */
  private restoredFlag: RestorableFlag | null = null;
  /** When the current state began (a restored flag keeps the moment it was first raised). */
  private stateSinceMs: number | null = null;
  private restoredSinceMs: number | null = null;
  private restoredCause: ChangeCause | null = null;
  /** Why the current `launcher_changed` stands (null in every other state). */
  private stateCause: ChangeCause | null = null;
  /**
   * The tracker's command-like count when the suspicion was first in force (written, so a `provian`
   * command could heal it); only command-like children after it give the agent's commands their chance.
   */
  private commandLikeAtSuspicion: number | null = null;
  /** The state this daemon's predecessor last wrote under the current record, and since when: a
   *  restart that lands in the same state keeps its moment (no_launcher, launcher_unsupported too). */
  private persistedState: string | null = null;
  private persistedSinceMs: number | null = null;
  private readonly myUid: number | null;
  private stateWritten: ProcessLaneState | null = null;
  private readonly auditMs: number;
  private lastAuditAtMs = -Infinity;
  /** Audit: launcher children it judged commands, by start key → when last seen running. */
  private readonly auditSeen = new Map<string, number>();
  /** Audit: children already running when it first found their launcher — not its to count. */
  private readonly auditIgnore = new Set<string>();
  /** Launchers the last audit found (fresh read): discovery keeps them while they live, so a heal sticks. */
  private auditLaunchers = new Map<number, ProcEntry>();
  /** When the audit last judged which of its commands are due. */
  private lastAuditDueAtMs = -Infinity;
  private window = { launcherLive: false, commandsDue: 0, commandsDueSealed: 0, launcherHeals: 0 };

  constructor(private readonly opts: ProcessLaneOptions = {}) {
    this.pollMs = Math.max(50, opts.pollMs ?? 250);
    this.fastMs = Math.max(2, opts.fastMs ?? 20);
    this.discoveryMs = opts.discoveryMs === undefined ? null : Math.max(100, opts.discoveryMs);
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.myUid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
    this.auditMs = Math.max(1_000, opts.auditMs ?? 15_000);
  }

  async init(observer: ProvianObserver): Promise<void> {
    this.observer = observer;
    this.reader = this.opts.reader ?? defaultSnapshotReader(this.platform);
    this.ledger = this.opts.ledger ?? new FileActLedger();
    this.identify = this.opts.identifyProgram ?? (() => {
      const registry = new ProgramWitnessRegistry();
      return (entry: Parameters<ProgramWitnessRegistry['identify']>[0]) => registry.identify(entry);
    })();
    this.subtree = this.opts.subtreeReader !== undefined
      ? this.opts.subtreeReader
      : (this.platform === 'linux' ? new LinuxLauncherSubtreeReader() : null);
    this.tracker = this.newTracker();
  }

  private newTracker(): ProcessActTracker {
    return new ProcessActTracker(
      {
        observerPid: process.pid,
        deviceId: this.observer.getDeviceId() ?? '',
        witness: this.observer.observerDeviceWitness(),
        identifyProgram: (entry) => this.identify(entry),
        classify: (p, parent, grandparent) => this.classify(p, parent, grandparent),
        isLauncherProgram: (p, parent) => this.record !== null && this.fingerprintOf(p, parent) === this.record.fingerprint,
        isAlive: (startKey) => this.isAlive(startKey),
        startedAtMs: (p) => (this.opts.startedAtMs ?? ((e: ProcEntry) => processStartedAtMs(e.startKey, this.platform, this.now())))(p),
      },
      this.ledger,
    );
  }

  async start(): Promise<void> {
    this.active = true;
    this.refreshConfig(true);
    this.restoreFlag();
    // Prime the baseline immediately so pre-existing processes are never minted.
    this.poll();
    const interval = this.subtree ? this.fastMs : this.pollMs;
    this.timer = setInterval(() => this.poll(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.observer.log('info', 'process lane watching', { poll_ms: interval, state: this.state });
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.poll(); // final read, so a command that just finished is sealed on shutdown
    this.enqueueSealed();
    this.ledger.flush?.(true);
  }

  tick(_session: SessionState | null): PluginContribution | null { return null; }

  // --- the decision inputs ------------------------------------------

  private otherLaneActive(): boolean {
    if (this.opts.otherLaneActive) return this.opts.otherLaneActive();
    try { return new ProgramWitnessRegistry().programs().length > 0; } catch { return false; }
  }

  /** Re-read the registry and the launcher record (every 5 s, and once at start). */
  private refreshConfig(force = false): void {
    const now = this.now();
    if (!force && now - this.lastConfigAtMs < CONFIG_REFRESH_MS) return;
    this.lastConfigAtMs = now;
    this.inert = this.otherLaneActive();
    const file = this.opts.launcherFile ?? processLauncherPath();
    const rec = readLauncherRecord(file);
    const key = rec ? launcherRecordKey(rec) : '';
    if (key !== this.recordKey) {
      // A (re-)record applies to roots first seen from now on; a process is classified once, when
      // it is first seen, so nothing already tracked is re-judged and nothing new is lost to a
      // re-baseline (a command the agent runs right after `doctor` / `process-lane record` mints).
      // The harness-change count starts again: a re-record clears `launcher_changed` and
      // `launcher_unconfirmed` at once.
      this.record = rec;
      this.recordKey = key;
      this.launcherPids = new Map();
      this.lastDiscoveryAtMs = -Infinity;
      this.lastLauncherSeenAtMs = null;
      this.tracker?.resetDrift(rec ? sha(key) : '');
      this.fingerprintCache.clear();
      this.lightProgramCache.clear();
      // The audit judges only what starts under this record.
      this.auditSeen.clear();
      this.auditLaunchers = new Map();
      this.restoredFlag = null;
      this.rejudgePending = rec !== null;
    }
  }

  /**
   * A daemon restart (a self-update, a machine update) must not clear a flag the lane raised: the
   * counters behind it start empty, so "nothing wrong yet" is not "fixed" ( ). A
   * flag written under the CURRENT launcher record is restored and stands until it clears on its own
   * evidence — a command recognised (`launcher_changed`, `launcher_unconfirmed`) or a launcher bound
   * (`launcher_not_seen`; and `launcher_changed` of cause 'inside_command', which a launcher bound
   * outside the agent's commands disproves) — or a re-record. It keeps the moment it was first raised.
   * A restart never raises a flag of its own.
   *
   * A file without `v` said `launcher_changed` for an unconfirmed suspicion too: it is restored as
   * `launcher_unconfirmed`, never shown. A v2 file without `cause` was written when `launcher_changed`
   * meant only the harness running inside a command.
   */
  private restoreFlag(): void {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.provian');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'process-lane-state.json'), 'utf8')) as { state?: unknown; record?: unknown; v?: unknown; since_ms?: unknown; at_ms?: unknown; cause?: unknown };
      if (typeof j.state !== 'string' || j.record !== sha(this.recordKey)) return;
      // The file is written only when the state changes, so `at_ms` is the moment for a file without `since_ms`.
      const raw = typeof j.since_ms === 'number' ? j.since_ms : typeof j.at_ms === 'number' ? j.at_ms : null;
      const since = raw !== null && Number.isFinite(raw) && raw > 0 && raw <= this.now() ? raw : null;
      // Only a file from this release names a state in this release's meaning.
      if (j.v === PROCESS_LANE_STATE_FILE_VERSION) { this.persistedState = j.state; this.persistedSinceMs = since; }
      if (!RESTORABLE_FLAGS.has(j.state) || !this.record) return;
      this.restoredFlag = j.state === 'launcher_changed' && j.v !== PROCESS_LANE_STATE_FILE_VERSION ? 'launcher_unconfirmed' : j.state as RestorableFlag;
      this.restoredSinceMs = since;
      this.restoredCause = this.restoredFlag === 'launcher_changed' ? (j.cause === 'wrapper' ? 'wrapper' : 'inside_command') : null;
    } catch { /* none */ }
  }

  /** Only discovery decides what launches (`eligibleLaunchers`); a launcher is one it bound. */
  private get observerPid(): number { return this.opts.observerPid ?? process.pid; }

  private isLauncher(p: ProcEntry, _parent: ProcEntry | null): boolean {
    return this.record !== null && this.launcherPids.get(p.pid) === p.startKey;
  }

  /**
   * A process that has been part of one of the agent's commands is never a launcher (`acts.ts`,
   * once the command's, always) — unless the agent's own re-record walked to exactly this process.
   */
  /**
   * Is the process with this start key still running? Linux: its /proc entry, start time included (a
   * reused pid never matches). Elsewhere the lane reads the whole table every poll, so the last read
   * says. A test that scripts the lane's reads supplies its own (or nothing is ever pruned).
   */
  private isAlive(startKey: string): boolean {
    if (this.opts.isAlive) return this.opts.isAlive(startKey);
    if (!this.opts.osLiveness && (this.opts.reader || this.opts.subtreeReader || this.opts.scanLight)) return true;
    // Unknown = keep: a read that cannot see this daemon itself (a failed `ps`, an unreadable /proc)
    // says nothing about anyone, and dropping a live claim would let a harness copy launch (round 8).
    if (this.platform === 'linux') {
      const read = this.opts.readEntry ?? readLinuxProcEntry;
      if (read(this.observerPid) === null) return true;
      const [pid, ticks] = startKey.split(':');
      const light = read(Number(pid));
      return light !== null && light.startKey === `${pid}:${ticks}`;
    }
    if (!this.lastFullTrusted) return true;
    return this.lastFullKeys.has(startKey);
  }

  /** The exact process the agent's own (re-)record walked to. */
  private namedByRecord(p: { startKey: string }): boolean {
    return this.record?.launcher_start_key !== undefined && this.record.launcher_start_key === p.startKey;
  }

  /**
   * Which fingerprint matches may launch ( — the one rule, used by discovery and
   * by the audit's own read). A match is the launcher unless it runs inside one of the agent's
   * commands: an ancestor started the way commands start, or an ancestor (or the match itself) has
   * been part of a command (`claimed`). That holds on every reader and across restarts, with no state:
   * a dev or test copy of the harness a command starts never launches, even after the real harness
   * exits and the command is reparented. Then only the outermost remain. The exact process the
   * agent's own re-record named is always allowed. Returns whether a match was set aside as inside a
   * command (the harness may now run only inside a command — flagged if it lasts).
   */
  private eligibleLaunchers(matches: Map<number, string>, entryOf: (pid: number) => ProcEntry | null): boolean {
    let insideCommand = false;
    // Only a distinctive command shape marks an ancestor as one of the agent's commands: a bare
    // `bash` (a harness that feeds commands on stdin) is also a person's shell, and a harness started
    // from that shell must still launch (round 8). Short shapes rely on claims alone.
    const distinctive = this.record !== null && this.record.mode === 'template' && this.record.template.length >= DISTINCTIVE_TEMPLATE_TOKENS;
    for (const [pid, startKey] of [...matches]) {
      if (this.namedByRecord({ startKey })) continue;
      let inside = this.tracker.isClaimed(startKey);
      let anc = entryOf(entryOf(pid)?.ppid ?? 0);
      for (let depth = 0; !inside && anc && anc.pid > 1 && depth < 64; depth++) {
        if (distinctive && matchesTemplate(anc.argv, this.record!.template)) inside = true;
        else if (this.tracker.isClaimed(anc.startKey) && !this.namedByRecord(anc)) inside = true;
        anc = entryOf(anc.ppid);
      }
      if (inside) { matches.delete(pid); insideCommand = true; }
    }
    return insideCommand;
  }

  /**
   * The launcher fingerprint of one process, cached by start key AND process name. An exec keeps
   * the pid and start key but changes the program: a harness started through `sh -c "exec node …"`,
   * `npm start`, or a container runtime's init is first seen as that wrapper. Keyed on the start key
   * alone, the wrapper's fingerprint stuck to the harness for its whole life and the lane never
   * recognised its commands (the 2026-10-21 restart episode). The fingerprint is the process's own
   * program only, so a reparented harness keeps it ( ).
   */
  private programOf(p: ProcEntry): string {
    // Keyed on what it runs: an exec that keeps the process name (python3 → python3) is a new program.
    const cacheKey = `${p.startKey}\0${p.argv.join('\0')}`;
    const cached = this.fingerprintCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const program = launcherProgram({ pid: p.pid, ppid: p.ppid, comm: p.comm ?? '', argv: p.argv, ...(p.exe ? { exe: p.exe } : {}) });
    if (this.fingerprintCache.size > 20_000) this.fingerprintCache.clear();
    this.fingerprintCache.set(cacheKey, program);
    return program;
  }

  private fingerprintOf(p: ProcEntry, parent: ProcEntry | null): string {
    return launcherFingerprintOf(this.programOf(p), parent ? this.programOf(parent) : null);
  }

  /** a new root is the agent's command only when the recorded launcher started it the recorded way. */
  private classify(p: ProcEntry, parent: ProcEntry | null, grandparent: ProcEntry | null): RootClass {
    return this.classifyAgainst(p, parent, grandparent, (x, xParent) => this.isLauncher(x, xParent));
  }

  private classifyAgainst(
    p: ProcEntry, parent: ProcEntry | null, grandparent: ProcEntry | null,
    isLauncher: (x: ProcEntry, xParent: ProcEntry | null) => boolean,
  ): RootClass {
    if (!this.record) return { kind: 'foreign' };
    const parentIsLauncher = parent !== null && isLauncher(parent, grandparent);
    // Forked but not yet exec'd: it still runs the launcher's own program, so it would match the
    // record itself when the recorded launcher is a worker under a same-program master. Decided on a
    // later poll, before it is ever taken for the launcher ( ).
    if (parentIsLauncher && p.argv.join('\0') === parent.argv.join('\0') && (p.exe ?? '') === (parent.exe ?? '')) return { kind: 'pending' };
    if (isLauncher(p, parent)) return { kind: 'launcher' };
    if (!parent || !parentIsLauncher) return { kind: 'foreign' };
    // Another user's program is never this agent's command; an owner the OS did not report is
    // unknown, and unknown is not this agent's (unknown = block).
    if (this.myUid !== null && p.uid !== this.myUid) return { kind: 'foreign' };
    // Forked but not yet exec'd (it still carries the launcher's own command line), or read mid-exec
    // with no command line at all: decided on a later poll.
    if (p.argv.length === 0) return { kind: 'pending' };
    if (this.record.mode !== 'template') return { kind: 'foreign' };
    if (matchesTemplate(p.argv, this.record.template)) return { kind: 'command', originTokens: [] };
    return { kind: 'housekeeping', argvHash: sha(p.argv.join('\0')) };
  }

  /** The program of a launcher the audit found (its fresh read). */
  private auditLauncherProgram(startKey: string): string | null {
    for (const l of this.auditLaunchers.values()) if (l.startKey === startKey) return this.programOf(l);
    return null;
  }

  /** Discovery's bookkeeping of when each process was first seen (live processes only). */
  private noteScan(scan: readonly { startKey: string }[]): void {
    const seen = new Map<string, number>();
    const programs = new Map<string, { program: string; since: number; lastFresh: number; otherUntil?: number; comm?: string; lastNamed?: number }>();
    for (const e of scan) {
      seen.set(e.startKey, this.firstSeenScan.get(e.startKey) ?? this.scanNo);
      const n = this.programSeen.get(e.startKey);
      if (n !== undefined) programs.set(e.startKey, n);
    }
    this.firstSeenScan = seen;
    this.programSeen = programs;
    this.baseScan ??= this.scanNo;
  }

  /** A fresh read of a process's command line (see `programSeen`). */
  private noteProgram(startKey: string, program: string, comm?: string): void {
    const e = this.programSeen.get(startKey);
    const named = comm === undefined ? {} : { comm, lastNamed: this.scanNo };
    if (!e) this.programSeen.set(startKey, { program, since: this.scanNo, lastFresh: this.scanNo, ...named });
    else if (e.program === program) { e.lastFresh = this.scanNo; if (comm !== undefined) { e.comm = comm; e.lastNamed = this.scanNo; } }
    else {
      // An exec that changed the process's name happened after every read that still showed the old
      // name, cached command line or not (review of release 93: a child the old program started
      // between its last fresh read and the exec is unknown, never the harness's). One that kept the
      // name is placed after the last fresh read only (round 13).
      const renamed = e.comm !== undefined && comm !== undefined && e.comm !== comm;
      const otherUntil = renamed ? Math.max(e.lastFresh, e.lastNamed ?? e.lastFresh) : e.lastFresh;
      this.programSeen.set(startKey, { program, since: this.scanNo, lastFresh: this.scanNo, otherUntil, ...named });
    }
  }

  /** A read showed the process under the same name (its command line not re-read). */
  private noteName(startKey: string, comm: string): void {
    const e = this.programSeen.get(startKey);
    if (e && e.comm === comm) e.lastNamed = this.scanNo;
  }

  /** The lane read nothing for a while: what it saw before says nothing about what started since. */
  private forgetSightings(): void {
    // Nor do its clocks run: a launcher not seen, or seen only inside a command, is timed from the
    // first read after it resumes ( 7).
    this.lastLauncherSeenAtMs = null;
    this.insideCommandSinceMs = null;
    if (this.firstSeenScan.size === 0 && this.programSeen.size === 0 && this.baseScan === null) return;
    this.firstSeenScan = new Map();
    this.programSeen = new Map();
    this.baseScan = null;
  }

  /** Find the processes that match the recorded launcher (every 2 s). */
  private discover(): void {
    const now = this.now();
    // While no launcher is bound (the harness is restarting), look every read, so the new harness's
    // first commands are seen ( ); while one is, every `DISCOVERY_BOUND_MS` (a timer
    // a few ms early still counts as the next read).
    const bound = this.discoveryMs ?? (this.subtree ? DISCOVERY_BOUND_MS : DISCOVERY_FULL_READ_MS);
    const interval = this.launcherPids.size === 0 ? Math.min(bound, this.pollMs) : bound;
    if (now - this.lastDiscoveryAtMs < interval - 5) return;
    this.lastDiscoveryAtMs = now;
    if (!this.record) return;
    this.scanNo += 1;
    const found = new Map<number, string>();
    let insideCommand = false;
    let scan: { pid: number; ppid: number; startKey: string }[] = [];
    const foundProgram = new Map<string, string>();
    if (this.platform === 'linux' || this.opts.scanLight) {
      const light = (this.opts.scanLight ?? scanLinuxLight)();
      const readEntry = this.opts.readEntry ?? readLinuxProcEntry;
      // A process's command line is read once and kept while its name stays; while no launcher is
      // bound it is read again every 2 s, so an exec that keeps the name is still found (round 13).
      const ttl = this.launcherPids.size === 0 ? LIGHT_PROGRAM_TTL_UNBOUND_MS : LIGHT_PROGRAM_TTL_BOUND_MS;
      const launcherComms = new Set<string>();
      for (const [pid, key] of this.launcherPids) { const v = light.get(pid); if (v && v.startKey === key) launcherComms.add(v.comm); }
      const programFor = (pid: number): string | null => {
        const v = light.get(pid);
        if (!v) return null;
        const cached = this.lightProgramCache.get(v.startKey);
        // A process under a bound launcher's name has its command line read at every discovery: one
        // that execs into the harness without changing its name is found at once, never after the
        // cache's 60 s (in which a command its earlier program started would read as the harness's).
        if (cached && cached.comm === v.comm && now - cached.atMs < ttl && !launcherComms.has(v.comm)) {
          this.noteName(v.startKey, v.comm);
          return cached.program;
        }
        const e = readEntry(pid);
        if (!e || e.startKey !== v.startKey) return null;
        const program = this.programOf(e);
        if (this.lightProgramCache.size > 20_000) this.lightProgramCache.clear();
        this.lightProgramCache.set(v.startKey, { comm: v.comm, program, atMs: now });
        this.noteProgram(v.startKey, program, v.comm);
        return program;
      };
      for (const [pid, v] of light) {
        const program = programFor(pid);
        if (program === null) continue;
        if (launcherFingerprintOf(program, programFor(v.ppid)) === this.record.fingerprint) { found.set(pid, v.startKey); foundProgram.set(v.startKey, program); }
      }
      const entries = new Map<number, ProcEntry | null>();
      const entryOf = (pid: number): ProcEntry | null => {
        if (entries.has(pid)) return entries.get(pid) ?? null;
        const v = light.get(pid);
        const e = v ? readEntry(pid) : null;
        const ok = e && v && e.startKey === v.startKey ? e : null;
        entries.set(pid, ok);
        return ok;
      };
      insideCommand = this.eligibleLaunchers(found, entryOf);
      outermostOnly(found, (pid) => light.get(pid)?.ppid);
      for (const [pid, l] of this.auditLaunchers) if (light.get(pid)?.startKey === l.startKey) found.set(pid, l.startKey);
      scan = [...light].map(([pid, v]) => ({ pid, ppid: v.ppid, startKey: v.startKey }));
    } else {
      const snap = this.reader.read();
      const byPid = new Map([...snap.procs.values()].map((e) => [e.pid, e]));
      for (const e of snap.procs.values()) {
        this.noteProgram(e.startKey, this.programOf(e));   // every read here carries its command line
        if (this.fingerprintOf(e, byPid.get(e.ppid) ?? null) === this.record.fingerprint) { found.set(e.pid, e.startKey); foundProgram.set(e.startKey, this.programOf(e)); }
      }
      insideCommand = this.eligibleLaunchers(found, (pid) => byPid.get(pid) ?? null);
      outermostOnly(found, (pid) => byPid.get(pid)?.ppid);
      for (const [pid, l] of this.auditLaunchers) if (snap.procs.has(l.startKey)) found.set(pid, l.startKey);
      scan = [...snap.procs.values()].map((e) => ({ pid: e.pid, ppid: e.ppid, startKey: e.startKey }));
    }
    // A read without the daemon's own process failed (a `ps` timeout, an unreadable /proc): it says
    // nothing — it neither unbinds a launcher nor counts as a sighting ( 5).
    if (!scan.some((e) => e.pid === this.observerPid)) {
      this.lastLauncherSeenAtMs ??= now - 1;   // reads failing from the start still end in launcher_not_seen (round 16)
      return;
    }
    // A harness copy that has been part of one of the agent's commands never launches (unless the
    // agent's re-record named it). Is the agent's harness now ONLY such a copy (it restarted its harness
    // from a command and the old one exited)? Then say so at once: the agent re-records (round 6).
    // The harness runs only inside one of the agent's commands (it restarted its harness from a command
    // and the old one exited): flagged once that has lasted past a supervisor's restart gap, so the
    // agent re-records from its new harness ( : never a false alarm in the gap).
    if (insideCommand && found.size === 0) this.insideCommandSinceMs ??= now;
    else this.insideCommandSinceMs = null;
    this.launcherInsideCommand = this.insideCommandSinceMs !== null && now - this.insideCommandSinceMs >= LAUNCHER_INSIDE_COMMAND_MS;
    this.noteScan(scan);
    this.bindLaunchers(found, now, scan, (k) => foundProgram.get(k) ?? this.auditLauncherProgram(k));
    if (found.size > 0) this.lastLauncherSeenAtMs = now;
    else if (this.lastLauncherSeenAtMs === null) this.lastLauncherSeenAtMs = now - 1; // start the not-seen clock
  }

  /**
   * Bind the lane to these launchers; one the tracker first saw as something else is promoted.
   *
   * A launcher no daemon has bound before may have children it never started: the program that
   * exec'd into the harness may have started them (review rounds 12–13). A child first seen no
   * later than the last read that showed the launcher still running that earlier program — or, never
   * read so, than the read the launcher was first seen in — is unknown and never mints, except the
   * command that wrote the record. A child that appeared since is the harness's command (a restarted
   * harness's first command, started the moment it exec'd, still mints; so does one a stale read
   * missed until the audit found the launcher). A launcher a daemon bound before (its ledger claim)
   * keeps every child: those started while the daemon restarted are its commands. While the lane
   * reads nothing (no record, another lane, an unsupported harness) these first sightings are forgotten.
   */
  private bindLaunchers(found: Map<number, string>, now: number, scan: readonly { pid: number; ppid: number; startKey: string }[], programOfLauncher: (startKey: string) => string | null): void {
    const unknown: string[] = [];
    const recorded = this.record?.command_start_key ?? null;
    for (const [pid, startKey] of found) {
      if (this.boundStartKeys.has(startKey)) continue;
      this.boundStartKeys.add(startKey);
      if (this.tracker.wasBoundLauncher(startKey)) continue;
      this.tracker.noteBoundLauncher(startKey);
      // The last read that showed it running something else (it exec'd since): a child seen by then may
      // be the earlier program's. Never read so: at the first read since the lane began reading, what
      // was already running is unknown; a harness that appeared later, already the harness, started
      // the children first seen with it (round 14). Found by the audit before discovery ever read the
      // table: every child is unknown (round 15).
      const seen = this.firstSeenScan.get(startKey);
      const read = this.programSeen.get(startKey);
      const current = programOfLauncher(startKey);
      // The last fresh read that showed it running something other than what it runs now.
      const execEvidence = read === undefined ? undefined : read.program === current ? read.otherUntil : read.lastFresh;
      const cut = execEvidence
        ?? (seen === undefined ? (this.baseScan === null ? Infinity : this.scanNo) : seen === this.baseScan ? seen : seen - 1);
      // Beside a harness already bound, this read is the first to show it as the harness, after one
      // that showed it running something else: a child also first read now, which the lane's own reads
      // have not seen either, may have been started by the program before the exec — unknown (round 14;
      // discovery runs every read while a launcher is bound, so it can bind a harness in the very read
      // it exec'd, before the tracker reads that child). With no harness bound it is the harness
      // restarting, whose first command in that read is its own (round 12).
      const besideBound = [...this.launcherPids].some(([q, k]) => q !== pid && found.get(q) === k);
      const execdThisRead = besideBound && read !== undefined && read.program === current && read.since === this.scanNo && read.otherUntil !== undefined;
      for (const e of scan) {
        if (e.ppid !== pid || e.startKey === recorded) continue;
        const first = this.firstSeenScan.get(e.startKey) ?? Infinity;
        if (first <= cut || (execdThisRead && first === this.scanNo && !this.tracker.wasRead(e.pid, e.startKey))) unknown.push(e.startKey);
      }
    }
    if (this.boundStartKeys.size > 10_000) this.boundStartKeys = new Set(found.values());
    this.tracker.markUnknown(unknown);
    this.launcherPids = found;
    // Discovery's launchers are the outermost matches (`outermostOnly`).
    if (found.size > 0) this.tracker.promoteLaunchers(new Set(found.values()), now, true);
  }

  private poll(): void {
    try {
      this.refreshConfig();
      const now = this.now();
      // Time the daemon spent suspended (the machine asleep) is no time without seeing the launcher.
      if (this.lastTickAtMs !== null && now - this.lastTickAtMs > SUSPEND_GAP_MS && this.lastLauncherSeenAtMs !== null) {
        this.lastLauncherSeenAtMs += now - this.lastTickAtMs;
      }
      if (this.lastTickAtMs !== null && now - this.lastTickAtMs > SUSPEND_GAP_MS && this.insideCommandSinceMs !== null) {
        this.insideCommandSinceMs += now - this.lastTickAtMs;
      }
      this.lastTickAtMs = now;
      if (this.platform !== 'linux' && this.platform !== 'darwin' && !this.opts.reader) { this.setState('unsupported_platform'); return; }
      if (this.inert) { this.forgetSightings(); this.setState('inert_other_lane'); this.lastPollAtMs = now; return; }
      // With no record the lane reads nothing, so the next discovery has no "previous read" to go by.
      // A record this version cannot read (`launcherRecordStatus` 'stale') is no usable record: `no_launcher`, never a
      // harness change. The fix is the same one command.
      if (!this.record) { this.forgetSightings(); this.setState('no_launcher'); this.lastPollAtMs = now; return; }
      // : a launcher that hands the command to its child itself cannot be told
      // apart from its own programs; the lane mints nothing there and says so.
      if (this.record.mode !== 'template') { this.forgetSightings(); this.setState('launcher_unsupported'); this.lastPollAtMs = now; return; }
      this.discover();
      if (this.rejudgePending) { this.rejudgePending = false; this.tracker.rejudgeRoots(now); }
      if (now - this.lastAuditAtMs >= this.auditMs) { this.lastAuditAtMs = now; this.audit(now); }
      let snapshot: ProcSnapshot | null = null;
      if (this.subtree) {
        // Idle fast path: one read per tick while the launcher has no children (most of the time);
        // the full subtree read runs whenever it has any, and at least every 250 ms for the seal grace.
        const pids = [...this.launcherPids.keys()];
        const idleNow = this.subtree.hasChildren ? !this.subtree.hasChildren(pids) : false;
        if (idleNow && this.launcherIdle && now - this.lastSubtreeReadAtMs < this.pollMs) return;
        this.launcherIdle = idleNow;
        this.lastSubtreeReadAtMs = now;
        const s = this.subtree.read(pids, now);
        // A bound launcher that is gone (the harness exited or is restarting): look for the next one now.
        if (s !== 'unsupported' && [...this.launcherPids].some(([, key]) => !s.procs.has(key))) this.lastDiscoveryAtMs = -Infinity;
        if (s === 'unsupported') {
          this.observer.log('warn', 'process lane: no per-thread children lists on this kernel; reading the whole process table instead', {});
          this.subtree = null;
          if (this.timer) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), this.pollMs); this.timer.unref?.(); }
        } else snapshot = s;
      }
      if (!this.subtree) {
        if (now - this.lastFullAtMs < this.pollMs - 5) return;
        this.lastFullAtMs = now;
        snapshot = this.reader.read();
        // A read that failed (`ps` timed out, /proc unreadable) shows nothing at all: it says nothing
        // about any process, so it is never judged — a running command never looks finished (round 9).
        // The lane's state is still judged, so reads that keep failing end in `launcher_not_seen`.
        if (snapshot.procs.size === 0) { this.lastFullTrusted = false; this.updateDriftState(now); return; }
        this.lastFullKeys = new Set(snapshot.procs.keys());
        this.lastFullTrusted = [...snapshot.procs.values()].some((e) => e.pid === this.observerPid);
        const read = snapshot;
        if ([...this.launcherPids].some(([, key]) => !read.procs.has(key))) this.lastDiscoveryAtMs = -Infinity;
      }
      if (snapshot) { this.tracker.observe(snapshot); this.auditObserve(snapshot, now); }
      this.ledger.flush?.();
      this.lastPollAtMs = now;
      this.enqueueSealed();
      this.updateDriftState(now);
    } catch (err) {
      this.observer.log('warn', 'process lane poll failed', { error: (err as Error).message });
    }
  }

  /**
   * The independent audit. Every 15 s it reads the whole process table fresh, sharing no
   * cache with the lane, and finds the recorded launcher by fingerprint:
   * - it re-binds the lane to a launcher discovery missed (a harness restart or a machine update
   * must never stop the lane minting the agent's commands);
   * - on every lane read in between it judges, on its own, which of that launcher's children are the
   * agent's commands, and counts per capture-health window the commands past the time they must
   * have sealed by and how many the lane sealed — so capture health alarms when a launcher is live
   * and launching matching commands but nothing seals (parity).
   * It sees every command the lane's reads see ( : a 15 s sample caught a 60 ms
   * command 0.4% of the time). A command shorter than one read is missed by both — the declared
   * residual, in the under-mint direction.
   */
  private audit(now: number): void {
    if (!this.record) return;
    // A test that injects the lane's readers but no audit scan runs without the audit (it must never
    // read the real machine, nor consume a scripted reader).
    const scan = this.opts.auditScan ?? (this.opts.reader || this.opts.scanLight || this.opts.subtreeReader ? null : () => this.freshScan());
    if (!scan) return;
    let snap: ProcSnapshot;
    try { snap = scan(); } catch { return; }
    if (![...snap.procs.values()].some((e) => e.pid === this.observerPid)) return;   // a failed read (round 15)
    const launchers = new Map<number, ProcEntry>();
    const byPid = new Map<number, ProcEntry>();
    for (const e of snap.procs.values()) byPid.set(e.pid, e);
    const asLauncherProc = (e: ProcEntry) => ({ pid: e.pid, ppid: e.ppid, comm: e.comm ?? '', argv: e.argv, ...(e.exe ? { exe: e.exe } : {}) });
    for (const e of snap.procs.values()) {
      const parent = byPid.get(e.ppid);
      if (launcherFingerprint(asLauncherProc(e), parent ? asLauncherProc(parent) : null) === this.record.fingerprint) launchers.set(e.pid, e);
    }
    const keys = new Map([...launchers].map(([pid, e]) => [pid, e.startKey]));
    this.eligibleLaunchers(keys, (pid) => byPid.get(pid) ?? null);
    for (const pid of [...launchers.keys()]) if (!keys.has(pid)) launchers.delete(pid);
    outermostOnly(launchers, (pid) => byPid.get(pid)?.ppid);
    if (launchers.size > 0) this.window.launcherLive = true;
    // Children already running when the audit first finds a launcher (at start, under a new record,
    // or a launcher that just appeared) predate its judgement: it cannot tell whether the launcher or
    // the program before an exec started them, so they are not its to count ( ).
    for (const e of snap.procs.values()) {
      const l = launchers.get(e.ppid);
      if (l && this.auditLaunchers.get(l.pid)?.startKey !== l.startKey) this.auditIgnore.add(e.startKey);
    }
    this.auditLaunchers = launchers;
    const bound = new Map(this.launcherPids);
    let healed = false;
    for (const l of launchers.values()) {
      if (bound.get(l.pid) === l.startKey) continue;
      bound.set(l.pid, l.startKey);
      healed = true;
      this.window.launcherHeals += 1;
    }
    if (healed) {
      this.lastLauncherSeenAtMs = now;
      this.fingerprintCache.clear();
      this.lightProgramCache.clear();
      this.bindLaunchers(bound, now, [...snap.procs.values()].map((e) => ({ pid: e.pid, ppid: e.ppid, startKey: e.startKey })), (k) => this.auditLauncherProgram(k));
      this.observer.log('warn', 'process lane: the audit found a launcher discovery had missed; the lane is bound to it again', {});
    }
    if (this.auditIgnore.size > 5_000) this.auditIgnore.clear();
    // Its own fresh read is judged too: a lane read that is itself blind still leaves a trace here.
    this.auditJudge(snap, now);
  }

  /** The audit's own judgement of one lane read (see `audit`). */
  private auditObserve(snapshot: ProcSnapshot, now: number): void {
    if (this.auditLaunchers.size === 0 && this.auditSeen.size === 0) return;
    this.auditJudge(snapshot, now);
    if (now - this.lastAuditDueAtMs < 1_000) return;
    this.lastAuditDueAtMs = now;
    const dueMs = DEFAULT_SEAL_GRACE_MS + AUDIT_DUE_MARGIN_MS;
    for (const [startKey, lastAliveMs] of this.auditSeen) {
      // Due once its root has been gone this long. A command whose root still runs is seen on every
      // read, so never due; one that backgrounded a server is over when its own tree ends (the
      // tracker detaches what the OS reparented), so it has sealed by then ( ).
      if (now - lastAliveMs < dueMs) continue;
      this.auditSeen.delete(startKey);
      this.window.commandsDue += 1;
      if (this.tracker.outcomeOf(startKey) === 'sealed') this.window.commandsDueSealed += 1;
    }
  }

  /** Which of the audit's launchers' children in one read are the agent's commands. */
  private auditJudge(snapshot: ProcSnapshot, now: number): void {
    const isAuditLauncher = (x: ProcEntry): boolean => this.auditLaunchers.get(x.pid)?.startKey === x.startKey;
    for (const e of snapshot.procs.values()) {
      // A command already counted is alive wherever it is read (its launcher may have been replaced).
      if (this.auditSeen.has(e.startKey)) { this.auditSeen.set(e.startKey, now); continue; }
      const parent = this.auditLaunchers.get(e.ppid);
      if (!parent || this.auditIgnore.has(e.startKey)) continue;
      if (this.classifyAgainst(e, parent, null, isAuditLauncher).kind !== 'command') continue;
      this.auditSeen.set(e.startKey, now);
    }
  }

  /** Every process, read fresh (the audit never shares the lane's caches). */
  private freshScan(): ProcSnapshot {
    if (this.platform === 'linux') {
      const procs = new Map<string, ProcEntry>();
      for (const [pid] of scanLinuxLight()) { const e = readLinuxProcEntry(pid); if (e) procs.set(e.startKey, e); }
      return { atMs: this.now(), procs };
    }
    return this.reader.read();
  }

  /** This capture-health window's audit counters; the next window starts empty. */
  takeCaptureWindow(): ProcessLaneWindow {
    const w = this.window;
    this.window = { launcherLive: false, commandsDue: 0, commandsDueSealed: 0, launcherHeals: 0 };
    return w;
  }

  /**
   * addition 1, as the design requires it on 2026-10-22: a harness change never leaves the lane silently
   * dark, and nothing that clears itself is shown.
   * - No live process matches the recorded fingerprint for `LAUNCHER_NOT_SEEN_MS` flagged.
   * - The fingerprinted launcher starts programs that do not start the recorded way: an unshown
   * suspicion. Any `provian` command the agent runs under it re-records the wrapper; a matching
   * command clears it. Only once the agent's own commands had their chance
   * (`LAUNCHER_CHANGE_FLAG_COMMANDS`) is it flagged, cause 'wrapper', since the streak began.
   * - The harness runs only inside one of the agent's commands: flagged, cause 'inside_command'.
   */
  private updateDriftState(now: number): void {
    const drift = this.tracker.launcherDrift();
    // A flag restored across a daemon restart clears only on its own evidence.
    if ((this.restoredFlag === 'launcher_changed' || this.restoredFlag === 'launcher_unconfirmed') && drift.commandsSeen > 0) this.restoredFlag = null;
    // A launcher bound (discovery never binds a process that was part of one of the agent's commands)
    // ends a launcher that was not running, and a harness that ran only inside a command.
    if ((this.restoredFlag === 'launcher_not_seen' || (this.restoredFlag === 'launcher_changed' && this.restoredCause === 'inside_command')) && this.launcherPids.size > 0) this.restoredFlag = null;
    if (this.launcherInsideCommand) { this.setState('launcher_changed', null, 'inside_command'); return; }
    // The suspicion's chance starts the poll after it is written: from then a `provian` command heals it.
    if (this.state === 'launcher_unconfirmed' && this.stateWritten === 'launcher_unconfirmed') {
      if (this.commandLikeAtSuspicion === null || drift.commandLike < this.commandLikeAtSuspicion) this.commandLikeAtSuspicion = drift.commandLike;
    } else if (this.state !== 'launcher_changed' || this.stateCause !== 'wrapper') {
      this.commandLikeAtSuspicion = null;
    }
    const chances = this.commandLikeAtSuspicion === null ? 0 : drift.commandLike - this.commandLikeAtSuspicion;
    if (chances >= LAUNCHER_CHANGE_FLAG_COMMANDS && drift.streak >= LAUNCHER_DRIFT_STREAK && drift.distinct >= 2) {
      // Since the streak began: the agent's commands stopped being witnessed then, not when it was flagged.
      const since = this.restoredFlag === 'launcher_changed' && this.restoredSinceMs !== null
        ? Math.min(this.restoredSinceMs, drift.startedAtMs ?? this.restoredSinceMs) : drift.startedAtMs;
      this.setState('launcher_changed', since, 'wrapper'); return;
    }
    if (this.restoredFlag) { this.setState(this.restoredFlag, this.restoredSinceMs, this.restoredFlag === 'launcher_changed' ? this.restoredCause : null); return; }
    if (drift.streak >= LAUNCHER_DRIFT_STREAK && drift.distinct >= 2) { this.setState('launcher_unconfirmed'); return; }
    // Not seen by a read that worked for this long (reads that keep failing keep the last binding, but
    // never refresh this): the lane says so.
    if (this.lastLauncherSeenAtMs !== null && now - this.lastLauncherSeenAtMs >= LAUNCHER_NOT_SEEN_MS) {
      this.setState('launcher_not_seen'); return;
    }
    this.setState('active');
  }

  /** `sinceMs`: when the state began, if earlier than now (a restored flag). `cause`: launcher_changed's. */
  private setState(next: ProcessLaneState, sinceMs: number | null = null, cause: ChangeCause | null = null): void {
    if (next === this.state && this.stateWritten === next && cause === this.stateCause) return;
    const prev = this.state;
    const firstWrite = this.stateWritten === null;
    const now = this.now();
    // A restart that lands in the state its predecessor last wrote keeps that state's moment; a state
    // that stands (only its cause changed) keeps its own.
    if (sinceMs === null && firstWrite && next === this.persistedState) sinceMs = this.persistedSinceMs;
    if (sinceMs === null && !firstWrite && next === prev) sinceMs = this.stateSinceMs;
    this.state = next;
    this.stateWritten = next;
    this.stateCause = next === 'launcher_changed' ? cause : null;
    this.stateSinceMs = sinceMs !== null && sinceMs <= now ? sinceMs : now;
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.provian');
    // `record`: which launcher record the state was judged under, so a restart restores only its own flag.
    // `v`: this file's meaning of `launcher_changed` (a flag, with its `cause`); `since_ms`: when the state began.
    try { writeLocal(path.join(dir, 'process-lane-state.json'), { state: next, at_ms: now, since_ms: this.stateSinceMs, v: PROCESS_LANE_STATE_FILE_VERSION, record: sha(this.recordKey), ...(this.stateCause ? { cause: this.stateCause } : {}) }); } catch { /* best-effort */ }
    const actionFile = path.join(dir, 'witness-action-required.json');
    if (next === 'launcher_changed' || next === 'launcher_not_seen') {
      const instruction = next === 'launcher_not_seen' ? PROCESS_LANE_NOT_SEEN_INSTRUCTION
        : this.stateCause === 'inside_command' ? PROCESS_LANE_INSIDE_COMMAND_INSTRUCTION : PROCESS_LANE_ACTION_INSTRUCTION;
      try { writeLocal(actionFile, { instruction, lane: 'process', state: next }); } catch { /* best-effort */ }
      this.observer.log('warn', `capture.process_${next} — re-record the launcher from your own harness`, {});
    } else if (next === 'launcher_unconfirmed') {
      this.observer.log('info', 'process lane: the launcher is starting programs that do not start the recorded way; any provian command run under it re-records the wrapper', {});
    } else if (next === 'no_launcher') {
      try { writeLocal(actionFile, { instruction: PROCESS_LANE_NO_LAUNCHER_INSTRUCTION, lane: 'process', state: next }); } catch { /* best-effort */ }
      this.observer.log('warn', 'capture.process_no_launcher — no launcher recorded; the agent runs process-lane record once from its own session', {});
    } else if (next === 'launcher_unsupported') {
      this.observer.log('warn', 'capture.process_launcher_unsupported — this harness hands each command to its child itself; the process lane cannot tell its commands from its own programs', {});
    }
    // Recovered, or a daemon restart found nothing to restore (a re-record while it was down, the lane
    // inert): remove an instruction this lane left. An unrecorded lane leaves its own (above). A flag that stands is restored first
    // (`restoreFlag`), so this first write never clears one.
    if (!ACTION_STATES.has(next) && (firstWrite || ACTION_STATES.has(prev))) {
      try {
        const cur = JSON.parse(fs.readFileSync(actionFile, 'utf8')) as { lane?: unknown };
        if (cur.lane === 'process') fs.unlinkSync(actionFile);
      } catch { /* none */ }
    }
  }

  private enqueueSealed(): void {
    for (const act of this.tracker.drainSealed()) {
      // Sealed while another lane became active : the act is that lane's program's, never this one's.
      if (this.inert) continue;
      this.inFlight.set(act.turnId, { act, attempts: 0 });
      this.queue.push(this.toPE(act));
      this.observer.log('info', 'process lane sealed command act', {
        turn_id: act.turnId, processes: act.processCount, connections: act.connectionCount,
      });
    }
  }

  drainPEs(): PluginPE[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, this.queue.length);
  }

  onCommitted(pe: PluginPE, outcome: PECommitOutcome): void {
    const turnId = pe.idempotencyKey;
    if (typeof turnId !== 'string') return;
    const entry = this.inFlight.get(turnId);
    if (!entry) return;
    if (outcome === 'submitted' || outcome === 'journaled') {
      this.ledger.recordMinted(entry.act.key);
      this.actsSealed += 1;
      this.lastActAtMs = this.now();
      this.inFlight.delete(turnId);
    } else if (outcome === 'rejected' || outcome === 'suppressed') {
      // A content judgement / design suppression is not retryable; do not re-emit.
      this.inFlight.delete(turnId);
    } else { // 'failed' — transient; retry under the SAME deterministic key (relay dedups).
      entry.attempts += 1;
      if (entry.attempts >= MAX_RETRIES) { this.inFlight.delete(turnId); return; }
      this.queue.push(this.toPE(entry.act));
    }
  }

  async finalize(): Promise<void> { /* ledger is persisted eagerly on each commit */ }

  private toPE(act: SealedAct): PluginPE {
    return {
      actionType: 'agent_tool_orchestration',
      metadata: {
        source: PROCESS_LANE_SOURCE,
        tool: PROCESS_LANE_TOOL,
        capture_lane: 'process',
        turn_id: act.turnId,
        tool_count: 1,
        process_count: act.processCount,
        connection_count: act.connectionCount,
        bytes_written: act.bytesWritten,
      },
      input_origins: act.origins.length > 0 ? act.origins : null,
      windowStart: act.startedAtMs,
      windowEnd: act.completedAtMs,
      // A command is its own distinct act: its window never suppresses, and is never suppressed by,
      // a session/other-lane window. The lane decides its own mint identity (turn_id).
      skipDedupClaim: true,
      identityDecided: true,
      idempotencyKey: act.turnId,
      // When the command ran (its start), never when it was read or sealed.
      occurredAtMs: act.startedAtMs,
    };
  }

  // --- capture-health view (the plugin's own live state) -------------------
  isActive(): boolean { return this.active; }
  isWatching(): boolean { return this.lastPollAtMs !== null && this.state === 'active'; }
  getState(): ProcessLaneState { return this.state; }
  /** When the current state began (null before the first judgement). */
  getStateSinceMs(): number | null { return this.stateWritten === null ? null : this.stateSinceMs; }
  actsEverSealed(): boolean { return this.actsSealed > 0; }
  getLastActAtMs(): number | null { return this.lastActAtMs; }
}
