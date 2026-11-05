/**
 * process-lane/acts — the pure decision core of the process lane.
 *
 * Given a stream of whole-machine process snapshots, decide which COMMANDS the
 * agent launched, fold everything each command starts into one act, and seal one
 * mintable act per command — never the daemon's own activity, the OS, or the VM
 * runtime's background services.
 *
 * FRANK'S RULINGS, transcribed into behaviour:
 * 1. Unit: one PE per command. Every descendant process, connection and file
 * change of that command belongs to the SAME act (a build spawning 50
 * processes is one PE). Here: a command is the ROOT of a new process tree;
 * every new process whose parent is already a member folds into that act.
 * 2. Capture continuously (the plugin polls tightly); never a coarse sampler.
 * 3. Only the agent's acts mint. EXCLUDED, deterministically:
 * - the daemon's own process tree (self + descendants);
 * - everything already running when the lane started (baseline) as a
 * command root — only a NEW top-level command mints; the OS and the
 * agent runtime are baseline;
 * - a program a DESCRIBED lane already witnesses;
 * - a background SERVICE: a tree that never completes within `maxActMs`
 * (persistent), or an identity a parent relaunches after it exits
 * (supervised). Both are the VM runtime's own services.
 * 4. One lane per program; mint-once keys on the daemon's OWN record (the
 * durable ledger the plugin owns), never on anything the agent or its
 * runtime stores. A restart re-baselines, so an in-flight pre-restart
 * command is never re-minted.
 * 5. No catalog: the logic is generic process ancestry + lifecycle; it names no
 * agent, framework or runtime.
 * 6. Structure-only privacy: argv and environments are hashed here; only hashes
 * and counts (and privacy-classed origins) ever leave. No command text.
 * 7. Origins: destinations observed in the command's argv become `input_origins`
 * under the existing privacy rule (public domain resolvable, private hashed),
 * stamped with the observer-device witness.
 * 8. Pricing parity: the sealed act is an ordinary `agent_tool_orchestration`
 * act (tool_count 1) — same base, same independence multiplier, same factors.
 *
 * DECLARED RESIDUAL (money-safe, under-mint direction): a process that starts and
 * exits inside one poll gap is missed (its act never mints); and a quick periodic
 * job the VM runtime relaunches may mint its FIRST instance once before the lane
 * recognises the identity as a service (then never again — the identity is
 * marked serviced durably). A long-lived supervised service never completes and
 * never mints at all. No path over-mints a wrong AMOUNT or mints twice.
 */

import { createHash } from 'crypto';
import type { InputOrigin, OriginWitness } from '../../../input-origins';
import { resolvableOrigin, domainOf } from '../../origin-capture';
import type { PeerProcessEntry } from '../../peer-process';

export interface ActTrackerConfig {
  /** The observer daemon's own pid; its whole subtree is excluded. */
  readonly observerPid: number;
  /** The device id (mint-once key input — the daemon's own identity, not the agent's). */
  readonly deviceId: string;
  /** The observer-device witness stamped on captured origins (null → origins are witnessed:false). */
  readonly witness: OriginWitness | null;
  /** Map a process to a described-lane program (exclusion); null → not witnessed elsewhere. */
  readonly identifyProgram: (entry: PeerProcessEntry) => string | null;
  /** A tree alive longer than this without completing is a persistent service (excluded). Default 10 min. */
  readonly maxActMs?: number;
  /** Hold a completed act this long before sealing, so a fast relaunch can out itself as a service. Default 20 s. */
  readonly sealGraceMs?: number;
  /** Relaunches of one identity (after the prior exited) that mark it a service. Default 2. */
  readonly respawnThreshold?: number;
  /** Window over which relaunches are counted. Default 180 s. */
  readonly serviceWindowMs?: number;
  /**
   * which new process roots are the AGENT's commands. When set (production
   * always sets it), a root mints only if the classifier calls it a `command` a child of the
   * recorded launcher that starts the way the agent's commands start. Everything else is excluded
   * with its whole tree: the OS's and the platform's background jobs (`foreign`) and the harness's
   * own checks (`housekeeping`). A `launcher` is never an act; its children are new roots.
   */
  readonly classify?: (p: import('./snapshot').ProcEntry, parent: import('./snapshot').ProcEntry | null, grandparent: import('./snapshot').ProcEntry | null) => RootClass;
  /** Is the process with this start key still running (claims of exited processes are pruned)? */
  readonly isAlive?: (startKey: string) => boolean;
  /** When the OS says this process started (ms since the epoch), or null when it cannot say. */
  readonly startedAtMs?: (p: import('./snapshot').ProcEntry) => number | null;
  /** Does this process run the recorded launcher's program (whatever it has been part of)? */
  readonly isLauncherProgram?: (p: import('./snapshot').ProcEntry, parent: import('./snapshot').ProcEntry | null) => boolean;
}

/** What a new process root is. `originTokens` the command's own argv tokens (never the
 * harness wrapper's), the only root text origins are read from. */
export type RootClass =
  | { readonly kind: 'launcher' }
  | { readonly kind: 'command'; readonly originTokens: readonly string[] }
  | { readonly kind: 'housekeeping'; readonly argvHash: string }
  /** A launcher child caught between fork and exec (it still carries the launcher's own argv):
   * decided once it execs. One that exits without exec'ing is the launcher's own (never minted). */
  | { readonly kind: 'pending' }
  | { readonly kind: 'foreign' };

/** A sealed, mintable command act — the plugin turns this into one PluginPE. */
export interface SealedAct {
  readonly key: string;
  readonly turnId: string;
  readonly openedAtMs: number;
  /** When the command ran: its root's start (see `runStartOf`). */
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly processCount: number;
  readonly connectionCount: number;
  readonly bytesWritten: number;
  readonly origins: InputOrigin[];
}

/** What the lane did with one command root, kept after the act is forgotten (the audit's cross-check). */
export type RootOutcome = 'open' | 'pending' | 'sealed' | 'housekeeping' | 'excluded';

/** The durable ledger the plugin owns (mint-once + known services), injected so acts.ts stays pure. */
export interface ActLedger {
  hasMinted(key: string): boolean;
  recordMinted(key: string): void;
  isServiced(identity: string): boolean;
  recordServiced(identity: string): void;
  /** Processes that have been part of a command act (start keys), kept across daemon restarts. */
  isClaimed?(startKey: string): boolean;
  claim?(startKeys: readonly string[]): void;
  pruneClaims?(isAlive: (startKey: string) => boolean): void;
  /** Write out buffered claims (at most once a second; `force`: now). */
  flush?(force?: boolean): void;
  /** The launcher children's start shapes known to be the harness's own (kept across daemon restarts). */
  housekeepingShapes?(): readonly string[];
  learnHousekeeping?(shapes: readonly string[]): void;
  /** How many of a launcher record's first commands may still teach the harness's own check. */
  housekeepingBaseline?(): { readonly record: string; readonly left: number } | null;
  setHousekeepingBaseline?(record: string, left: number): void;
}

type ExclusionReason = 'daemon' | 'witnessed_program' | 'service' | 'foreign' | 'housekeeping';

interface Act {
  key: string;
  turnId: string;
  identity: string;
  rootStartKey: string;
  /** The root as last read (kept after it exits, so a record that arrives later can judge it). */
  rootEntry: import('./snapshot').ProcEntry;
  openedAtMs: number;
  /** When the command ran: its root's start, between the read before its first and that first read. */
  startedAtMs: number;
  /** Already running at the daemon's first read (adopted): the OS's start time, set right at seal. */
  adoptedOsStartMs?: number;
  lastActivityAtMs: number;
  completedAtMs: number | null;
  members: Set<string>;
  live: Set<string>;
  argvHashes: Set<string>;
  origins: Map<string, InputOrigin>;
  lastBytesByMember: Map<string, number>;
  bytesWritten: number;
  connectionCount: number;
  excluded: ExclusionReason | null;
  /** A command the agent's launcher started : never a service, never dropped for running long. */
  launched: boolean;
  /** Not yet classifiable (a fork before its exec); never sealed while set. */
  pending: boolean;
  /** A launcher child that is not a command: the hash of how it started (its root's argv). */
  housekeepingShape?: string;
  /** The launcher process (start key + program) that started this root. */
  launcherId?: string;
  /** Counted once as that launcher's post-command child (`creditPostCommand`). */
  postCommandCredited?: boolean;
  /** A command within its record's learning window (`HOUSEKEEPING_BASELINE_COMMANDS`). */
  inBaseline?: boolean;
}

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
/** A command root's own claim: which act it roots (so a restarted daemon may adopt that act alone). */
const rootClaimKey = (startKey: string, actKey: string): string => `root\0${startKey}\0${actKey}`;
/** The process a claim is about (a root claim carries its start key in the middle). */
/** A process already running when its launcher was first bound, started by who knows (round 12). */
const unknownClaimKey = (startKey: string): string => `unknown\0${startKey}`;
/** A launcher a daemon has bound: a restarted daemon knows its children are commands. */
const launcherClaimKey = (startKey: string): string => `launcher\0${startKey}`;
const claimStartKey = (claim: string): string => (claim.includes('\0') ? claim.split('\0')[1] : claim);
/** What a process is running (an exec changes it; nothing else does). */
const programSig = (e: { comm?: string; exe?: string; argv: readonly string[] }): string => `${e.comm ?? ''}\0${e.exe ?? ''}\0${e.argv.join('\0')}`;

/** A public-DNS-shaped bare host (≥2 labels, letters-only TLD), excluding obvious private/loopback. */
const PUBLIC_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const PRIVATE_SUFFIX_RE = /(?:^localhost$|\.local$|\.internal$|\.test$|\.localhost$|\.lan$|\.intranet$)/i;
/** scp-style git remote `user@host:path` → host. */
const SCP_RE = /^[^@\s/]+@((?:[a-z0-9-]+\.)+[a-z]{2,24}):/i;
/** A URL substring inside an argv word (handles `--url=https://…`, quoted `-c "curl https://…"`). */
const URL_IN_WORD_RE = /https?:\/\/[^\s'"`<>]+/i;

/** Common source/data file extensions a bare `name.ext` token carries — never a host. */
const FILE_EXT = new Set([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'c', 'h', 'hpp', 'cpp', 'cc', 'o', 'out', 'a', 'so',
  'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'zsh', 'go', 'rs', 'rb', 'java', 'class',
  'jar', 'php', 'pl', 'lua', 'sql', 'csv', 'tsv', 'log', 'lock', 'cfg', 'conf', 'ini', 'env', 'xml',
  'html', 'htm', 'css', 'scss', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'zip', 'tar', 'gz',
  'tgz', 'bz2', 'xz', 'exe', 'dll', 'bin', 'dat', 'db', 'sqlite', 'bak', 'tmp', 'swp',
]);

/** True for a host that is not publicly resolvable (loopback, private/CGNAT/benchmark IP, local suffix). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_SUFFIX_RE.test(h)) return true;
  // IPv4 private / loopback / link-local / CGNAT / benchmark (the 198.18.x egress-proxy range).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  return false;
}

/** A bare argv word → a public host, or null (private, file-ext, or not host-shaped). */
function bareHost(word: string): string | null {
  if (!PUBLIC_HOST_RE.test(word) || isPrivateHost(word)) return null;
  const tld = word.slice(word.lastIndexOf('.') + 1).toLowerCase();
  if (FILE_EXT.has(tld)) return null;
  return word.toLowerCase();
}

/** The seal hold the tracker uses by default (the plugin's audit derives its due time from it). */
export const DEFAULT_SEAL_GRACE_MS = 20_000;
/** A process first read within this long of the read before it measures the OS clock's skew. */
const OS_SKEW_SAMPLE_MS = 1_000;

/**
 * The harness's own check (witness check on release 91): the first child a launcher process
 * starts within this long after one of its commands the recorded way was read to have ended (Grok's
 * harness starts its check about 60 ms after each command). A child read before that end never counts.
 */
export const POST_COMMAND_WINDOW_MS = 500;
/**
 * Only a record's first commands teach the harness's own check: the record was just taken from a
 * command the harness started the recorded way, so it is that harness. A harness that changes later
 * — however it mixes old and new command lines — never teaches anything; it is flagged and re-recorded,
 * which opens a new window. Counted in the ledger, so a daemon restart never reopens it.
 */
export const HOUSEKEEPING_BASELINE_COMMANDS = 10;
/** Post-command sightings (after distinct commands) before a start shape is the harness's own. */
export const POST_COMMAND_SIGHTINGS = 2;
/** The harness's own start shapes kept (a harness runs a handful), and the shapes being counted. */
export const KNOWN_HOUSEKEEPING_CAP = 1_024;
const SIGHTINGS_CAP = 1_024;
const LAUNCHERS_DONE_CAP = 256;

export class ProcessActTracker {
  private readonly cfg: Required<Omit<ActTrackerConfig, 'witness' | 'identifyProgram' | 'classify' | 'isLauncherProgram' | 'isAlive' | 'startedAtMs'>> & Pick<ActTrackerConfig, 'witness' | 'identifyProgram' | 'classify' | 'isLauncherProgram' | 'isAlive' | 'startedAtMs'>;
  /** Acts whose root is a fork not yet exec'd (decided on a later poll). */
  private readonly pendingActs = new Set<string>();
  /** Root start key → what became of it once forgotten (bounded; read by the plugin's audit). */
  private readonly outcomes = new Map<string, RootOutcome>();
  /** startKeys of the launcher processes seen (never acts; their children are new roots). */
  private readonly launchers = new Set<string>();
  /** The CURRENT poll's pid → entry, so a classifier sees the parent admitted this poll. */
  private currentEntryByPid: Map<number, import('./snapshot').ProcEntry> = new Map();
  private prevEntryByPid: Map<number, import('./snapshot').ProcEntry> = new Map();
  /** Harness-change detection (addition 1): launcher children since the last command. */
  private housekeepingStreak = 0;
  private readonly streakHashes = new Set<string>();
  private commandsSeen = 0;
  /** When the current streak's first child started (null: no streak). */
  private streakStartedAtMs: number | null = null;
  /**
   * The correction: the streak's children that behaved like the agent's commands — the same
   * launcher process started its next child within `POST_COMMAND_WINDOW_MS` of their end, as a harness
   * does with its own check after each command. An idle harness's own check is never followed so
   * closely, so only a harness that is running the agent's commands another way raises this.
   */
  private commandLike = 0;
  private readonly lastUnmatchedDone = new Map<string, { at: number; taken: boolean }>();
  /**
   * Start shapes the harness's own children run (Grok diagnostic 6, 2026-10-21: one fixed check line
   * whose helpers differ run to run, run by every process running the harness program, about once a
   * minute while idle). A shape is the harness's own once a launcher process has started it as its
   * first child right after one of its commands the recorded way completed, after two different
   * commands (`POST_COMMAND_*`). A command under a changed wrapper waits for the agent's next tool
   * call and follows the harness's own check, so it never takes that place. Learning happens only in
   * a record's first commands (`HOUSEKEEPING_BASELINE_COMMANDS`). A known shape never counts as a
   * harness change. Kept as hashes in the ledger across daemon restarts; a re-record drops every
   * sighting still being counted (`resetDrift`), so nothing seen under one record completes under another.
   */
  private readonly knownHousekeeping = new Set<string>();
  /** The current record (hash) and how many of its first commands may still teach. */
  private baselineRecord = '';
  private baselineLeft = 0;
  /** When the tracker last read the table, and per live process its first read and the read before. */
  private lastReadAtMs: number | null = null;
  private readonly firstRead = new Map<string, { at: number; before: number }>();
  /** How far the OS's start times are from the daemon's clock, from the last process first read
   *  between two close reads (a paused sandbox's clock can be an hour off). */
  private osSkewMs: number | null = null;
  /** Per launcher process (start key + program): when its last command completed, and whether its
   *  first child after that has been taken. */
  private readonly lastCommandDone = new Map<string, { at: number; taken: boolean }>();
  /** Start shape → post-command sightings so far. */
  private readonly postCommandSightings = new Map<string, number>();
  /**
   * ONCE THE COMMAND'S, ALWAYS THE COMMAND'S ( ). A process that has been part of
   * a command the agent's launcher started is never a launcher and never the root of another act, for
   * its whole life: not when it is read again after dropping out of a read, not after a daemon
   * restart (kept in the ledger at seal, and at once for a copy of the harness), and not when the
   * harness it was started under exits. The one way out is the agent's own re-record naming that
   * exact process as its launcher (the plugin's check).
   */
  private readonly claimed = new Set<string>();
  /** Act keys of commands sealed this run (a root read again after a missed read never re-opens it). */
  private readonly sealedKeys = new Set<string>();
  private lastPruneAtMs = -Infinity;
  /** startKey → what its parent ran when it was first read (`noteAdmittedUnder`). */
  private readonly admittedUnder = new Map<string, string>();
  /** startKey → owning actKey (covers excluded acts too, so children inherit exclusion). */
  private readonly owner = new Map<string, string>();
  /** The daemon's own subtree (startKeys); never an act, never minted. */
  private readonly daemonTree = new Set<string>();
  private readonly acts = new Map<string, Act>();
  /** Relaunch bookkeeping per identity: timestamps of opens whose prior instance had exited. */
  private readonly relaunchAt = new Map<string, number[]>();
  /** Identities currently alive, for sequential-relaunch detection. */
  private readonly aliveByIdentity = new Map<string, number>();
  private started = false;
  private prev: ReadonlyMap<string, { pid: number; ppid: number; startKey: string }> | null = null;
  /** The CURRENT poll's pid → startKey, so a parent admitted earlier THIS poll is found. */
  private currentByPid: Map<number, string> = new Map();
  private readonly sealedQueue: SealedAct[] = [];

  constructor(cfg: ActTrackerConfig, private readonly ledger: ActLedger) {
    for (const shape of ledger.housekeepingShapes?.() ?? []) this.knownHousekeeping.add(shape);
    this.cfg = {
      observerPid: cfg.observerPid,
      deviceId: cfg.deviceId,
      witness: cfg.witness,
      identifyProgram: cfg.identifyProgram,
      maxActMs: cfg.maxActMs ?? 10 * 60_000,
      sealGraceMs: cfg.sealGraceMs ?? DEFAULT_SEAL_GRACE_MS,
      respawnThreshold: cfg.respawnThreshold ?? 2,
      serviceWindowMs: cfg.serviceWindowMs ?? 180_000,
      ...(cfg.classify ? { classify: cfg.classify } : {}),
      ...(cfg.isLauncherProgram ? { isLauncherProgram: cfg.isLauncherProgram } : {}),
      ...(cfg.isAlive ? { isAlive: cfg.isAlive } : {}),
      ...(cfg.startedAtMs ? { startedAtMs: cfg.startedAtMs } : {}),
    };
  }

  /**
   * The launcher's children that did not start the way its commands start, counted since the last
   * command it launched, and how many DIFFERENT starts they had. A harness's own per-command check
   * repeats one start; a harness update changes the start of its commands too, so a streak of
   * non-matching children with more than one distinct start and no command means the recorded
   * template no longer fits (the 10-08 format-break parity, addition 1).
   */
  launcherDrift(): { readonly streak: number; readonly distinct: number; readonly commandsSeen: number; readonly commandLike: number; readonly startedAtMs: number | null } {
    return { streak: this.housekeepingStreak, distinct: this.streakHashes.size, commandsSeen: this.commandsSeen, commandLike: this.commandLike, startedAtMs: this.streakStartedAtMs };
  }

  private clearStreak(): void {
    this.housekeepingStreak = 0;
    this.streakHashes.clear();
    this.streakStartedAtMs = null;
    this.commandLike = 0;
    this.lastUnmatchedDone.clear();
  }

  /** What the lane did with the process tree rooted at `rootStartKey` (null: never saw it as a root). */
  outcomeOf(rootStartKey: string): RootOutcome | null {
    // A root once sealed stays sealed: an act re-opened for it after a missed read is excluded (it is
    // claimed) and must never read as "nothing sealed" (round 12).
    if (this.outcomes.get(rootStartKey) === 'sealed') return 'sealed';
    const actKey = this.owner.get(rootStartKey);
    const act = actKey !== undefined ? this.acts.get(actKey) : undefined;
    if (act && act.rootStartKey === rootStartKey) {
      if (act.pending) return 'pending';
      if (act.excluded === 'housekeeping') return 'housekeeping';
      return act.excluded ? 'excluded' : 'open';
    }
    return this.outcomes.get(rootStartKey) ?? null;
  }

  /**
   * A launcher record just took effect ( ): the command that wrote it — `provian
   * doctor`, an act verb, `provian process-lane record` and any other command the launcher was
   * running were first seen before the record existed, so they were judged not the agent's. Each act
   * the lane still holds whose root the launcher started is judged again under the record: a command
   * started the recorded way is the agent's command and seals once (its act key is unchanged, and an
   * excluded act never sealed). A root another lane witnesses, a service, or a fork still pending is
   * left as it is.
   */
  rejudgeRoots(now: number): void {
    if (!this.cfg.classify) return;
    for (const act of [...this.acts.values()]) {
      if (act.launched || act.pending || (act.excluded !== 'foreign' && act.excluded !== 'housekeeping')) continue;
      if (this.isClaimed(act.rootStartKey)) continue;
      // Only a root its parent started while already running the launcher program (unknown = block:
      // a child the startup wrapper started before it exec'd is not the launcher's — round 6).
      const parent = this.currentEntryByPid.get(act.rootEntry.ppid);
      if (!parent || this.admittedUnder.get(act.rootStartKey) !== programSig(parent)) continue;
      const cls = this.classifyEntry(act.rootEntry);
      if (cls.kind === 'command') {
        act.excluded = null;
        this.applyRootClass(act, act.rootEntry, cls, now);
        // Its live processes price it, as if it had been the agent's command from its start (the
        // shape hashes kept while it was the harness's own would otherwise skip every one — round 6).
        act.argvHashes.clear();
        if (!act.excluded) {
          for (const e of this.currentEntryByPid.values()) {
            if (!act.live.has(e.startKey)) continue;
            this.claimMember(e.startKey, false);
            if (e.startKey !== act.rootStartKey) this.foldOrigins(act, e);
          }
        }
      } else if (cls.kind === 'housekeeping' && act.excluded === 'foreign') {
        act.excluded = 'housekeeping';
        act.argvHashes.add(cls.argvHash);
      }
    }
  }

  /** Has this process been part of a command act (in this run or, through the ledger, an earlier one)? */
  isClaimed(startKey: string): boolean {
    return this.claimed.has(startKey) || this.ledger.isClaimed?.(startKey) === true;
  }

  /**
   * Processes already running before their launcher became one (the plugin's discovery decides):
   * who started them is unknown, so they never mint — and a restarted daemon keeps that (ledger).
   */
  markUnknown(startKeys: readonly string[]): void {
    if (startKeys.length === 0) return;
    const keys = startKeys.map(unknownClaimKey);
    for (const k of keys) this.claimed.add(k);
    this.ledger.claim?.(keys);
    this.ledger.flush?.(true);
  }

  /** Did the tracker's last read include this process? */
  wasRead(pid: number, startKey: string): boolean {
    return this.currentEntryByPid.get(pid)?.startKey === startKey;
  }

  /** Has a daemon (this one or, through the ledger, an earlier one) bound this launcher? */
  wasBoundLauncher(startKey: string): boolean {
    return this.isClaimed(launcherClaimKey(startKey));
  }

  /** This launcher is bound: a restarted daemon takes the commands it starts in the gap as commands. */
  noteBoundLauncher(startKey: string): void {
    const k = launcherClaimKey(startKey);
    if (this.claimed.has(k)) return;
    this.claimed.add(k);
    this.ledger.claim?.([k]);
    this.ledger.flush?.(true);
  }

  /** A copy of the harness program (kept in the ledger at once when it joins a command). */
  private launcherProgram(p: import('./snapshot').ProcEntry): boolean {
    return this.cfg.isLauncherProgram?.(p, this.currentEntryByPid.get(p.ppid) ?? this.prevEntryByPid.get(p.ppid) ?? null) === true;
  }

  /**
   * Every member of a command is claimed in the ledger as it joins ( ), so a daemon
   * restart while the command still runs keeps it — the ledger writes at most once a second; `urgent`
   * (a copy of the harness program) writes now.
   */
  private claimMember(startKey: string, urgent: boolean): void {
    if (this.claimed.has(startKey) && !urgent) return;
    this.claimed.add(startKey);
    this.ledger.claim?.([startKey]);
    if (urgent) this.ledger.flush?.(true);
  }

  /** Claims leave only with their process ( ): pruned once a minute. */
  private pruneClaims(now: number): void {
    if (now - this.lastPruneAtMs < 60_000 || !this.cfg.isAlive) return;
    this.lastPruneAtMs = now;
    const live = this.cfg.isAlive;
    const isAlive = (k: string): boolean => live(claimStartKey(k));
    for (const k of [...this.claimed]) if (!isAlive(k)) this.claimed.delete(k);
    this.ledger.pruneClaims?.(isAlive);
  }

  /**
   * A fresh launcher record starts the harness-change count, and every sighting being counted, again.
   * `record` (a hash of the record; empty: none) opens its learning window unless the ledger shows it
   * was already used.
   */
  resetDrift(record = ''): void {
    this.clearStreak();
    this.lastCommandDone.clear();
    this.postCommandSightings.clear();
    if (record !== this.baselineRecord) {
      this.baselineRecord = record;
      const kept = record === '' ? null : this.ledger.housekeepingBaseline?.() ?? null;
      this.baselineLeft = record === '' ? 0 : (kept && kept.record === record ? Math.max(0, Math.min(kept.left, HOUSEKEEPING_BASELINE_COMMANDS)) : HOUSEKEEPING_BASELINE_COMMANDS);
      if (record !== '') this.ledger.setHousekeepingBaseline?.(record, this.baselineLeft);
    }
  }

  /** Feed one snapshot. Updates in-flight acts and queues any newly sealed acts. */
  observe(snapshot: import('./snapshot').ProcSnapshot): void {
    const now = snapshot.atMs;
    const procs = snapshot.procs;

    // Resolve parents from THIS poll so a parent and child appearing in the same gap are one tree.
    this.currentByPid = new Map();
    this.currentEntryByPid = new Map();
    for (const p of procs.values()) { this.currentByPid.set(p.pid, p.startKey); this.currentEntryByPid.set(p.pid, p); }

    if (!this.started) {
      // What already runs at the daemon's first read started before it: no read bounds it.
      for (const p of procs.values()) this.firstRead.set(p.startKey, { at: now, before: -Infinity });
      this.baseline(snapshot);
      this.started = true;
      this.prev = this.indexLight(procs);
      this.prevEntryByPid = this.currentEntryByPid;
      this.lastReadAtMs = now;
      return;
    }

    // New processes (startKeys not present last poll). A parent and its child can both be new in
    // one poll; the child must be admitted AFTER its parent so it folds into the parent's act
    // rather than rooting its own. PID order is NOT a sound proxy for start order (a long-lived VM
    // wraps its PID space, so a child can carry a LOWER pid than its parent), so we admit in
    // TOPOLOGICAL order: a new proc is admitted only once its same-poll parent is already admitted
    // (or its parent is external / already owned). PID order is a stable tiebreaker among roots.
    const prev = this.prev ?? new Map();

    // Exits FIRST: drop from live sets and from alive-identity bookkeeping before any new process is
    // admitted. A loop that starts its next instance the moment the last one exits shows both in
    // one poll; the exit must already be counted, or the new instance reads as running beside the
    // old one, its relaunch is never counted, and a background loop mints forever (2026-10-21).
    for (const [startKey, p] of prev) {
      if (!procs.has(startKey)) {
        this.launchers.delete(startKey);
        this.firstRead.delete(startKey);
        const actKey = this.owner.get(startKey);
        if (actKey) {
          const act = this.acts.get(actKey);
          act?.live.delete(startKey);
          if (act && startKey === act.rootStartKey) this.onIdentityExit(act.identity, p);
        }
      }
    }

    const newProcs = [...procs.values()]
      .filter((p) => !prev.has(p.startKey))
      .sort((a, b) => a.pid - b.pid);
    for (const p of newProcs) {
      if (this.firstRead.has(p.startKey)) continue;
      const before = this.lastReadAtMs ?? now;
      this.firstRead.set(p.startKey, { at: now, before });
      // Only a child of a process the read before also showed has just started: one that entered the
      // read with a newly bound launcher's tree may be hours old (review of release 93, round 2).
      if (now - before <= OS_SKEW_SAMPLE_MS && this.prevEntryByPid.has(p.ppid)) this.sampleOsSkew(p, before, now);
    }
    const pending = new Set(newProcs.map((p) => p.startKey));
    let progressed = true;
    while (pending.size > 0 && progressed) {
      progressed = false;
      for (const p of newProcs) {
        if (!pending.has(p.startKey)) continue;
        const parentStartKey = this.parentStartKey(p);
        // Admit now iff the parent is not itself a still-pending same-poll process.
        if (parentStartKey === null || !pending.has(parentStartKey)) {
          this.admit(p, now);
          pending.delete(p.startKey);
          progressed = true;
        }
      }
    }
    // Any left can only be an (impossible) ppid cycle among same-poll procs; admit them in pid
    // order so none is ever dropped.
    for (const p of newProcs) if (pending.has(p.startKey)) { this.admit(p, now); pending.delete(p.startKey); }

    // A launcher child first seen between fork and exec is decided once it has exec'd (its start
    // key is unchanged by exec, so it is never "new" again).
    for (const key of [...this.pendingActs]) {
      const act = this.acts.get(key);
      if (!act) { this.pendingActs.delete(key); continue; }
      const root = procs.get(act.rootStartKey);
      if (!root) continue; // exited: reaped below as the launcher's own
      const cls = this.cfg.classify ? this.classifyEntry(root) : { kind: 'foreign' as const };
      if (cls.kind === 'pending') continue;
      this.pendingActs.delete(key);
      act.pending = false;
      this.applyRootClass(act, root, cls, now);
    }

    // A tracked process that exec'd into the recorded launcher (a harness restarted through `sh -c
    // "…; exec node harness"`) is the launcher from this read on: promoted at once, so a command it
    // starts before the next discovery is the agent's too ( ).
    if (this.cfg.classify) {
      const execd = new Set<string>();
      for (const startKey of this.owner.keys()) {
        const cur = procs.get(startKey);
        const old = cur ? this.prevEntryByPid.get(cur.pid) : undefined;
        if (!cur || !old || old.startKey !== startKey) continue;
        if (old.comm === cur.comm && old.argv.join('\0') === cur.argv.join('\0') && old.exe === cur.exe) continue;
        if (this.acts.get(this.owner.get(startKey) ?? '')?.launched) {
          // Inside a command: the command's, for good — kept at once so a daemon restart knows it too.
          if (this.launcherProgram(cur)) this.claimMember(startKey, true);
          continue;
        }
        if (this.classifyEntry(cur).kind === 'launcher') execd.add(startKey);
      }
      if (execd.size > 0) this.promoteLaunchers(execd, now);
    }

    for (const act of this.acts.values()) { const r = procs.get(act.rootStartKey); if (r) act.rootEntry = r; }

    // A member that left the command's tree (its parent exited and the OS reparented it — `nohup …
    // &`, a daemonized server) is no longer the command: the command completes when its own tree does
    // ( ). The fast reader never sees such a process again; the full scan does.
    for (const act of this.acts.values()) {
      for (const member of [...act.live]) {
        if (member === act.rootStartKey) continue;
        const entry = procs.get(member);
        if (!entry) continue;
        const parentKey = this.currentByPid.get(entry.ppid);
        if (parentKey !== undefined && this.owner.get(parentKey) === act.key && act.live.has(parentKey)) continue;
        act.live.delete(member);
        this.owner.delete(member);
        this.admittedUnder.delete(member);
      }
    }

    // Fold write-byte growth and refresh liveness/activity for current members.
    for (const [startKey, actKey] of this.owner) {
      const live = procs.get(startKey);
      const act = this.acts.get(actKey);
      if (!act || !live || typeof live.bytesWritten !== 'number') continue;
      act.lastActivityAtMs = now;
      // A just-started member begins near 0, so first-seen value is its baseline; count only growth.
      const prevBytes = act.lastBytesByMember.get(startKey) ?? 0;
      act.bytesWritten += Math.max(0, live.bytesWritten - prevBytes);
      act.lastBytesByMember.set(startKey, live.bytesWritten);
    }

    this.reap(now);
    this.pruneClaims(now);
    this.prev = this.indexLight(procs);
    this.prevEntryByPid = this.currentEntryByPid;
    this.lastReadAtMs = now;
    if (this.firstRead.size > 50_000) this.firstRead.clear();
  }

  /**
   * When a process ran from: the OS's start time, held between the last read that did not show it
   * and the first that did (the OS's clock and the daemon's can disagree, as in a paused sandbox), so
   * a record carries when its command ran — never when it was read or sealed. With no OS time, its
   * first read.
   */
  private runStartOf(p: import('./snapshot').ProcEntry, now: number): { at: number; adoptedOs?: number } {
    const r = this.firstRead.get(p.startKey) ?? { at: now, before: this.lastReadAtMs ?? now };
    const os = this.osStartOf(p);
    // Already running at the daemon's first read (a restart adopting it): only the OS can say, held
    // to the daemon's clock by the skew the daemon has measured by the time it seals.
    if (r.before === -Infinity) return os === null ? { at: r.at } : { at: this.adoptedStart(os, r.at), adoptedOs: os };
    const t = os ?? r.at;
    return { at: Math.round(Math.min(r.at, Math.max(r.before, t))) };
  }

  private osStartOf(p: import('./snapshot').ProcEntry): number | null {
    const os = this.cfg.startedAtMs?.(p) ?? null;
    return os !== null && Number.isFinite(os) ? os : null;
  }

  private adoptedStart(os: number, firstReadAtMs: number): number {
    return Math.round(Math.min(firstReadAtMs, os + (this.osSkewMs ?? 0)));
  }

  /** The smallest shift that puts a process's OS start between the two reads around its first sighting. */
  private sampleOsSkew(p: import('./snapshot').ProcEntry, before: number, at: number): void {
    const os = this.osStartOf(p);
    if (os === null) return;
    const lo = before - os;
    const hi = at - os;
    this.osSkewMs = 0 < lo ? lo : 0 > hi ? hi : 0;
  }

  /** Remove the plugin's queue of sealed acts (drained once). */
  drainSealed(): SealedAct[] {
    if (this.sealedQueue.length === 0) return [];
    return this.sealedQueue.splice(0, this.sealedQueue.length);
  }

  // ---- internals ----------------------------------------------------------

  private indexLight(procs: ReadonlyMap<string, import('./snapshot').ProcEntry>): Map<string, { pid: number; ppid: number; startKey: string }> {
    const m = new Map<string, { pid: number; ppid: number; startKey: string }>();
    for (const p of procs.values()) m.set(p.startKey, { pid: p.pid, ppid: p.ppid, startKey: p.startKey });
    return m;
  }

  /** First snapshot: mark the daemon subtree; everything else is baseline infrastructure. */
  private baseline(snapshot: import('./snapshot').ProcSnapshot): void {
    const byPid = new Map<number, import('./snapshot').ProcEntry>();
    for (const p of snapshot.procs.values()) byPid.set(p.pid, p);
    // Walk descendants of the observer pid.
    const childrenOf = new Map<number, number[]>();
    for (const p of snapshot.procs.values()) {
      const arr = childrenOf.get(p.ppid) ?? [];
      arr.push(p.pid);
      childrenOf.set(p.ppid, arr);
    }
    const stack = [this.cfg.observerPid];
    const daemonPids = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (daemonPids.has(pid)) continue;
      daemonPids.add(pid);
      for (const c of childrenOf.get(pid) ?? []) stack.push(c);
    }
    for (const p of snapshot.procs.values()) if (daemonPids.has(p.pid)) this.daemonTree.add(p.startKey);
    // A command the recorded launcher is already running is the agent's, not infrastructure: a daemon
    // that restarts (a self-update, a machine update) adopts it and seals it when it completes, so a
    // restart never loses a command in flight ( ). Mint-once keys on the act key
    // (device, start key, argv), which a restart does not change.
    if (!this.cfg.classify) return;
    const launcherPids = new Set<number>();
    for (const p of snapshot.procs.values()) {
      if (this.daemonTree.has(p.startKey)) continue;
      if (this.classifyEntry(p).kind === 'launcher') launcherPids.add(p.pid);
    }
    // Only the outermost: a copy of the harness under a launcher is inside one of its commands, and is
    // that command's ( ).
    for (const pid of [...launcherPids]) {
      let cur = byPid.get(pid)?.ppid;
      for (let depth = 0; cur !== undefined && cur > 0 && depth < 64; depth++) {
        if (launcherPids.has(cur)) { launcherPids.delete(pid); break; }
        cur = byPid.get(cur)?.ppid;
      }
    }
    for (const pid of launcherPids) { const p = byPid.get(pid); if (p) this.launchers.add(p.startKey); }
    if (launcherPids.size === 0) return;
    const queue: number[] = [];
    for (const p of snapshot.procs.values()) if (launcherPids.has(p.ppid) && !this.daemonTree.has(p.startKey)) queue.push(p.pid);
    queue.sort((a, b) => a - b);
    for (let i = 0; i < queue.length; i++) {
      const p = byPid.get(queue[i]);
      if (!p || this.daemonTree.has(p.startKey) || this.owner.has(p.startKey)) continue;
      this.admit(p, snapshot.atMs);
      for (const c of childrenOf.get(p.pid) ?? []) queue.push(c);
    }
  }

  /**
   * Bind processes that became the launcher after the tracker first saw them ( ):
   * a harness restarted through `sh -c "…; exec node harness"`, `npm start`, or a container init is
   * first read as that wrapper, so it was admitted as an ordinary (excluded) process and the commands
   * it then launched folded into that excluded act. Its commands are taken back out and admitted as
   * the agent's commands, so a harness restart never stops the lane minting.
   */
  promoteLaunchers(startKeys: ReadonlySet<string>, now: number, outermost = false): void {
    for (const launcherKey of startKeys) {
      if (this.launchers.has(launcherKey)) continue;
      const actKey = this.owner.get(launcherKey);
      if (actKey === undefined) continue; // never tracked (baseline) or not yet seen: classified when read
      const act = this.acts.get(actKey);
      // Inside a command the agent's launcher started, a copy of the harness is that command's — while
      // an outer launcher runs. Once discovery finds it the OUTERMOST match (the agent restarted its
      // harness from a command and the old one exited), it is the launcher: it leaves the command, and
      // what it starts from now on are the agent's commands. What it already started stays the
      // command's ( ).
      if (act?.launched) {
        if (!outermost) continue;
        this.launchers.add(launcherKey);
        act.members.delete(launcherKey);
        act.live.delete(launcherKey);
        this.owner.delete(launcherKey);
        this.admittedUnder.delete(launcherKey);
        continue;
      }
      this.launchers.add(launcherKey);
      this.admittedUnder.delete(launcherKey);
      if (!act) { this.owner.delete(launcherKey); continue; }
      const live = new Map<string, import('./snapshot').ProcEntry>();
      for (const e of this.currentEntryByPid.values()) if (act.live.has(e.startKey)) live.set(e.startKey, e);
      const launcher = live.get(launcherKey) ?? null;
      const childrenOf = new Map<number, import('./snapshot').ProcEntry[]>();
      for (const e of live.values()) {
        if (e.startKey === launcherKey) continue;
        const arr = childrenOf.get(e.ppid) ?? [];
        arr.push(e);
        childrenOf.set(e.ppid, arr);
      }
      // Only what the launcher started is taken back: a live child first read while its parent was
      // already running the launcher program, with everything under it. A child the startup wrapper
      // started before it exec'd (or one whose start is ambiguous) stays where it was, excluded
      // ( : only the launcher's commands mint).
      const taken: import('./snapshot').ProcEntry[] = [];
      if (launcher) {
        const sig = programSig(launcher);
        const queue = (childrenOf.get(launcher.pid) ?? []).filter((c) => this.admittedUnder.get(c.startKey) === sig).sort((a, b) => a.pid - b.pid);
        for (let i = 0; i < queue.length; i++) {
          taken.push(queue[i]);
          for (const c of childrenOf.get(queue[i].pid) ?? []) queue.push(c);
        }
      }
      for (const m of [launcherKey, ...taken.map((e) => e.startKey)]) {
        act.members.delete(m);
        act.live.delete(m);
        this.owner.delete(m);
      }
      if (launcherKey === act.rootStartKey) {
        // The act was the wrapper that exec'd into the launcher: the launcher is no member of it. What
        // the wrapper started before the exec stays in it, excluded, until it ends.
        this.onIdentityExit(act.identity, { pid: launcher?.pid ?? 0 });
        if (act.members.size === 0) {
          this.noteOutcome(act.rootStartKey, 'excluded');
          this.acts.delete(actKey);
          this.pendingActs.delete(actKey);
        } else act.excluded = act.excluded ?? 'foreign';
      }
      // What the launcher started is admitted afresh: its children are the agent's commands (or its
      // own checks), their descendants fold into them.
      for (const e of taken) if (this.owner.get(e.startKey) === undefined) this.admit(e, now);
    }
  }

  /** Decide a newly-seen process: daemon tree, fold into a parent act, or open a new command. */
  private admit(p: import('./snapshot').ProcEntry, now: number): void {
    const parentStartKey = this.parentStartKey(p);

    // The daemon's own tree is never an act and never minted.
    if (p.pid === this.cfg.observerPid || (parentStartKey !== null && this.daemonTree.has(parentStartKey))) {
      this.daemonTree.add(p.startKey);
      return;
    }

    this.noteAdmittedUnder(p);
    const parentAct = parentStartKey !== null ? this.acts.get(this.owner.get(parentStartKey) ?? '') : undefined;

    // A launcher process is never an act: its children are the agent's commands. Never inside
    // a command the agent's launcher started: everything a command starts is that command,
    // even a copy of the harness program ( ).
    if (this.cfg.classify && !parentAct?.launched) {
      if (this.classifyEntry(p).kind === 'launcher') {
        this.launchers.add(p.startKey);
        this.admittedUnder.delete(p.startKey);
        return;
      }
    }

    // Fold into the parent's act (minting or excluded), so the whole tree is one act.
    if (parentStartKey !== null) {
      const parentActKey = this.owner.get(parentStartKey);
      if (parentActKey) {
        const act = parentAct;
        if (act) {
          if (act.launched) this.claimMember(p.startKey, this.launcherProgram(p));
          act.members.add(p.startKey);
          act.live.add(p.startKey);
          this.owner.set(p.startKey, parentActKey);
          if (!act.excluded) this.foldOrigins(act, p);
          else if (act.excluded === 'housekeeping') act.argvHashes.add(sha256(p.argv.join('\0')));
          act.lastActivityAtMs = now;
          return;
        }
      }
    }

    // A NEW TOP-LEVEL COMMAND. Parent is baseline / pid1 / untracked.
    this.openCommand(p, now);
  }

  private openCommand(p: import('./snapshot').ProcEntry, now: number): void {
    const argv0Hash = sha256(p.argv[0] ?? p.exe ?? '');
    const parentStartKey = this.parentStartKey(p);
    const identity = sha256(`${parentStartKey ?? 'orphan'}\0${argv0Hash}`);
    const key = this.actKeyOf(p);
    const turnId = `pl:${key}`;

    // A program a described lane already witnesses mints only on that lane.
    const witnessedProgram = this.cfg.identifyProgram?.({ pid: p.pid, args: p.argv.join(' '), argv: p.argv, ...(p.exe ? { exe: p.exe } : {}) }) ?? null;

    const act: Act = {
      key,
      turnId,
      identity,
      rootStartKey: p.startKey,
      rootEntry: p,
      openedAtMs: now,
      startedAtMs: 0,
      lastActivityAtMs: now,
      completedAtMs: null,
      members: new Set([p.startKey]),
      live: new Set([p.startKey]),
      argvHashes: new Set(),
      origins: new Map(),
      lastBytesByMember: new Map(),
      bytesWritten: 0,
      connectionCount: 0,
      excluded: null,
      launched: false,
      pending: false,
    };
    const start = this.runStartOf(p, now);
    act.startedAtMs = start.at;
    if (start.adoptedOs !== undefined) act.adoptedOsStartMs = start.adoptedOs;

    // Sequential-relaunch bookkeeping: this identity just (re)appeared.
    this.onIdentityOpen(identity, now);

    // Already part of a command: never a second act — unless it is that very command's root, its act
    // not yet sealed (a restarted daemon adopting the command in flight, round 9).
    const ownRoot = this.ownUnsealedRoot(p.startKey, key);
    if (this.isClaimed(p.startKey) && !ownRoot) act.excluded = 'foreign';
    else if (this.cfg.classify) {
      // only a command the agent's launcher started mints. Its origins come from what the
      // command itself is and runs — never from the harness wrapper every command shares.
      const cls = this.classifyEntry(p);
      if (cls.kind === 'pending') { act.pending = true; this.pendingActs.add(key); }
      else this.applyRootClass(act, p, cls, now, witnessedProgram);
    } else if (witnessedProgram !== null) act.excluded = 'witnessed_program';
    else if (this.ledger.isServiced(identity) || this.isServiceByRelaunch(identity)) act.excluded = 'service';
    else this.foldOrigins(act, p);

    this.acts.set(key, act);
    this.owner.set(p.startKey, key);
  }

  /** A command a daemon was already following (its root claim), not yet sealed or minted. */
  private ownUnsealedRoot(startKey: string, key: string): boolean {
    return this.isClaimed(rootClaimKey(startKey, key)) && !this.sealedKeys.has(key) && !this.ledger.hasMinted(key);
  }

  /** The mint-once key of the act a root opens: this device, the process, and what it runs. */
  private actKeyOf(p: import('./snapshot').ProcEntry): string {
    return sha256(`${this.cfg.deviceId}\0${p.startKey}\0${sha256((p.argv.join('\0')) || (p.exe ?? ''))}`);
  }

  /** Apply a root's classification : a command, the harness's check, or not this agent's. */
  private applyRootClass(
    act: Act, p: import('./snapshot').ProcEntry, cls: Exclude<RootClass, { kind: 'pending' }>, now: number,
    witnessed?: string | null,
  ): void {
    if (cls.kind === 'command') {
      // A command is keyed on what it runs once it is a command: a root first read before its exec
      // (or under an earlier record) opened its act on the harness's own command line. Re-keyed, so a
      // restarted daemon that reads it after the exec finds the same act (round 10).
      const key = this.actKeyOf(p);
      if (key !== act.key) {
        const held = this.acts.get(act.key) === act;
        if (held) this.acts.delete(act.key);
        const wasPending = this.pendingActs.delete(act.key);
        act.key = key;
        act.turnId = `pl:${key}`;
        if (held) this.acts.set(key, act);
        if (wasPending) this.pendingActs.add(key);
        for (const m of act.members) if (this.owner.has(m)) this.owner.set(m, key);
      }
      // Already running before its launcher became one (the program that exec'd into the harness may
      // have started it): unknown, so not the agent's (round 12; the plugin's discovery decides).
      if (this.isClaimed(unknownClaimKey(act.rootStartKey))) {
        act.excluded = 'foreign';
        return;
      }
      act.launched = true;
      // The process and its root claim go to disk together, at once: a crash right after a command
      // starts must never leave the one without the other (a restarted daemon would refuse it, round 11).
      const rootClaim = rootClaimKey(act.rootStartKey, act.key);
      this.claimed.add(act.rootStartKey);
      this.claimed.add(rootClaim);
      this.ledger.claim?.([act.rootStartKey, rootClaim]);
      this.ledger.flush?.(true);
      this.commandsSeen += 1;
      this.clearStreak();
      act.launcherId = this.launcherIdentityOf(p) ?? undefined;
      if (this.baselineLeft > 0) {
        act.inBaseline = true;
        this.baselineLeft -= 1;
        this.ledger.setHousekeepingBaseline?.(this.baselineRecord, this.baselineLeft);
      }
      const witnessedProgram = witnessed !== undefined ? witnessed
        : (this.cfg.identifyProgram?.({ pid: p.pid, args: p.argv.join(' '), argv: p.argv, ...(p.exe ? { exe: p.exe } : {}) }) ?? null);
      if (witnessedProgram !== null) { act.excluded = 'witnessed_program'; return; }
      this.foldOriginTokens(act, cls.originTokens);
    } else if (cls.kind === 'housekeeping') {
      act.excluded = 'housekeeping';
      act.argvHashes.add(cls.argvHash); // the tree's shape, for harness-change detection at completion
      act.housekeepingShape = cls.argvHash;
      act.launcherId = this.launcherIdentityOf(p) ?? undefined;
      const done = act.launcherId !== undefined ? this.lastCommandDone.get(act.launcherId) : undefined;
      if (done && !done.taken && act.openedAtMs >= done.at && act.openedAtMs - done.at <= POST_COMMAND_WINDOW_MS) { done.taken = true; this.creditPostCommand(act); }
      const unmatched = act.launcherId !== undefined ? this.lastUnmatchedDone.get(act.launcherId) : undefined;
      if (unmatched && !unmatched.taken && act.openedAtMs >= unmatched.at && act.openedAtMs - unmatched.at <= POST_COMMAND_WINDOW_MS) { unmatched.taken = true; this.commandLike += 1; }
    } else if (cls.kind === 'launcher') {
      act.excluded = 'foreign';
    } else {
      act.excluded = 'foreign';
    }
  }

  private foldOrigins(act: Act, p: import('./snapshot').ProcEntry): void {
    const hash = sha256(p.argv.join('\0'));
    if (act.argvHashes.has(hash)) return;
    act.argvHashes.add(hash);
    for (const origin of extractOrigins(p.argv, this.cfg.witness ?? null)) {
      if (!act.origins.has(origin.hash)) act.origins.set(origin.hash, origin);
    }
  }

  /** Origins from the command's own tokens only (the wrapper's argv never prices a command). */
  private foldOriginTokens(act: Act, tokens: readonly string[]): void {
    for (const origin of extractOrigins(tokens, this.cfg.witness ?? null)) {
      if (!act.origins.has(origin.hash)) act.origins.set(origin.hash, origin);
    }
  }

  /**
   * What `p`'s parent was running when `p` was first read, if the parent had already been running it
   * on the previous read. A process first read in the same read its parent exec'd may have been
   * started by the program before the exec: that is unknown, recorded as '' (unknown = block).
   */
  private noteAdmittedUnder(p: import('./snapshot').ProcEntry): void {
    const parent = this.currentEntryByPid.get(p.ppid);
    const before = this.prevEntryByPid.get(p.ppid);
    // Settled: the parent ran the same program at the last read — or is new in this one (it and the
    // child started inside one read; a fork-then-exec that fast is the declared one-read boundary,
    // round 14). A parent seen running something else last read exec'd since: the child is ambiguous.
    const settled = parent && (!before || before.startKey !== parent.startKey || programSig(before) === programSig(parent));
    this.admittedUnder.set(p.startKey, settled ? programSig(parent) : '');
  }

  /** The classifier's verdict on `p`, given its parent and grandparent from this poll (or the last). */
  private classifyEntry(p: import('./snapshot').ProcEntry): RootClass {
    const look = (pid: number) => this.currentEntryByPid.get(pid) ?? this.prevEntryByPid.get(pid) ?? null;
    const parent = look(p.ppid);
    return this.cfg.classify ? this.cfg.classify(p, parent, parent ? look(parent.ppid) : null) : { kind: 'foreign' };
  }

  /** The launcher process a root was started by, as itself: its start key and the program it runs. */
  private launcherIdentityOf(p: import('./snapshot').ProcEntry): string | null {
    const parent = this.currentEntryByPid.get(p.ppid) ?? this.prevEntryByPid.get(p.ppid);
    return parent ? sha256(`${parent.startKey}\0${programSig(parent)}`) : null;
  }

  private isKnownHousekeeping(act: Act): boolean {
    return act.housekeepingShape !== undefined && this.knownHousekeeping.has(act.housekeepingShape);
  }

  /** A launcher's first child right after one of its commands: one sighting of the harness's check. */
  private creditPostCommand(act: Act): void {
    if (act.postCommandCredited || act.housekeepingShape === undefined) return;
    act.postCommandCredited = true;
    const shape = act.housekeepingShape;
    if (this.knownHousekeeping.has(shape)) return;
    const n = (this.postCommandSightings.get(shape) ?? 0) + 1;
    if (n < POST_COMMAND_SIGHTINGS) {
      if (this.postCommandSightings.size >= SIGHTINGS_CAP) this.postCommandSightings.delete(this.postCommandSightings.keys().next().value as string);
      this.postCommandSightings.set(shape, n);
      return;
    }
    this.postCommandSightings.delete(shape);
    this.knownHousekeeping.add(shape);
    while (this.knownHousekeeping.size > KNOWN_HOUSEKEEPING_CAP) this.knownHousekeeping.delete(this.knownHousekeeping.values().next().value as string);
    this.ledger.learnHousekeeping?.([shape]);
  }

  /** A child of the streak ended: if its launcher starts its next child right away, it behaved like a command. */
  private noteUnmatchedDone(act: Act, now: number): void {
    if (act.launcherId === undefined) return;
    if (this.lastUnmatchedDone.size >= LAUNCHERS_DONE_CAP && !this.lastUnmatchedDone.has(act.launcherId)) this.lastUnmatchedDone.delete(this.lastUnmatchedDone.keys().next().value as string);
    const done = { at: now, taken: false };
    this.lastUnmatchedDone.set(act.launcherId, done);
    for (const other of this.acts.values()) {
      if (other === act || other.excluded !== 'housekeeping' || other.launcherId !== act.launcherId) continue;
      if (other.openedAtMs !== now) continue;   // read in the very poll this child's end was read
      done.taken = true;
      this.commandLike += 1;
      return;
    }
  }

  /** One of the launcher's commands in its record's learning window ended: its next child may be the check. */
  private noteCommandDone(act: Act, now: number): void {
    if (act.launcherId === undefined || !act.inBaseline) return;
    if (this.lastCommandDone.size >= LAUNCHERS_DONE_CAP && !this.lastCommandDone.has(act.launcherId)) this.lastCommandDone.delete(this.lastCommandDone.keys().next().value as string);
    const done = { at: now, taken: false };
    this.lastCommandDone.set(act.launcherId, done);
    let first: Act | null = null;
    for (const other of this.acts.values()) {
      if (other.excluded !== 'housekeeping' || other.launcherId !== act.launcherId || other.postCommandCredited) continue;
      if (other.openedAtMs !== now) continue;   // read in the very poll the command's end was read
      if (first === null || other.openedAtMs < first.openedAtMs) first = other;
    }
    if (first) { done.taken = true; this.creditPostCommand(first); }
  }

  private parentStartKey(p: import('./snapshot').ProcEntry): string | null {
    // Prefer this poll (a parent spawned in the same gap), then the previous snapshot.
    const cur = this.currentByPid.get(p.ppid);
    if (cur !== undefined) return cur;
    if (this.prev) for (const entry of this.prev.values()) if (entry.pid === p.ppid) return entry.startKey;
    return null;
  }

  private onIdentityOpen(identity: string, now: number): void {
    const prevAlive = this.aliveByIdentity.get(identity) ?? 0;
    // A relaunch is an open while a prior instance of the identity had already exited.
    if (prevAlive === 0) {
      const arr = (this.relaunchAt.get(identity) ?? []).filter((t) => now - t <= this.cfg.serviceWindowMs);
      arr.push(now);
      this.relaunchAt.set(identity, arr);
    }
    this.aliveByIdentity.set(identity, prevAlive + 1);
  }

  private onIdentityExit(identity: string, _p: { pid: number }): void {
    const n = (this.aliveByIdentity.get(identity) ?? 1) - 1;
    if (n <= 0) this.aliveByIdentity.delete(identity);
    else this.aliveByIdentity.set(identity, n);
  }

  private isServiceByRelaunch(identity: string): boolean {
    const arr = this.relaunchAt.get(identity) ?? [];
    return arr.length >= this.cfg.respawnThreshold;
  }

  /** Seal completed acts past the grace; exclude persistent ones; mark services. */
  private reap(now: number): void {
    for (const [key, act] of this.acts) {
      // Persistent (never completed in maxActMs) → a background service. Never a command the agent's
      // launcher started: a long build is still the agent's command and seals when it completes.
      if (!act.launched && act.completedAtMs === null && act.live.size > 0 && now - act.openedAtMs > this.cfg.maxActMs) {
        act.excluded = 'service';
        this.ledger.recordServiced(act.identity);
        this.noteOutcome(act.rootStartKey, 'excluded');
        this.forget(key, act);
        continue;
      }
      // Newly completed → start the seal grace.
      if (act.completedAtMs === null && act.live.size === 0) {
        act.completedAtMs = now;
        // A fork that exited before it exec'd was the launcher's own (never a command).
        if (act.pending) { act.pending = false; this.pendingActs.delete(key); act.excluded = 'foreign'; }
        // addition 1: a launcher child that did not start the way commands start counts toward
        // a harness change once its whole tree is known. The harness's own check runs the same tree
        // every time; commands under a changed wrapper run different trees.
        // A start shape the harness is known to run itself never counts (`knownHousekeeping`).
        if (act.launched) this.noteCommandDone(act, now);
        if (act.excluded === 'housekeeping' && !this.isKnownHousekeeping(act)) {
          if (this.housekeepingStreak === 0) this.streakStartedAtMs = act.openedAtMs;
          this.housekeepingStreak += 1;
          this.streakHashes.add(sha256([...act.argvHashes].sort().join(',')));
          this.noteUnmatchedDone(act, now);
        }
      }
      if (act.completedAtMs === null) continue;

      // During the grace, a relaunch of the identity outs it as a service → cancel the mint.
      if (!act.excluded && !act.launched && this.isServiceByRelaunch(act.identity)) {
        act.excluded = 'service';
        this.ledger.recordServiced(act.identity);
      }
      // The hold lets a relaunch out a background job as a service; a command the agent's launcher
      // started is never a service, so it seals the moment it completes (a daemon stop right after
      // a command never loses it — ).
      if (!act.launched && now - act.completedAtMs < this.cfg.sealGraceMs) continue;

      // Grace elapsed → seal. The ledger is advanced by the plugin only once the relay
      // accepts (or durably journals) the PE — never here — so a failed submit is retried,
      // not silently burned. Within a run the act is forgotten after sealing, so it cannot
      // re-seal; `hasMinted` guards only the (baseline-excluded) cross-run case.
      const sealing = !act.excluded && !act.pending;
      this.noteOutcome(act.rootStartKey, sealing ? 'sealed' : act.excluded === 'housekeeping' ? 'housekeeping' : 'excluded');
      if (act.launched) {
        this.ledger.claim?.([...act.members]); this.ledger.flush?.(true);
        this.sealedKeys.add(key);
        if (this.sealedKeys.size > 5_000) this.sealedKeys.delete(this.sealedKeys.values().next().value as string);
      }
      if (sealing && !this.ledger.hasMinted(key)) {
        this.sealedQueue.push({
          key,
          turnId: act.turnId,
          openedAtMs: act.openedAtMs,
          startedAtMs: act.adoptedOsStartMs !== undefined ? this.adoptedStart(act.adoptedOsStartMs, act.openedAtMs) : act.startedAtMs,
          completedAtMs: act.completedAtMs,
          processCount: act.members.size,
          connectionCount: act.connectionCount,
          bytesWritten: act.bytesWritten,
          origins: [...act.origins.values()],
        });
      }
      this.forget(key, act);
    }
  }

  private noteOutcome(rootStartKey: string, outcome: RootOutcome): void {
    if (this.outcomes.get(rootStartKey) === 'sealed') return;
    this.outcomes.set(rootStartKey, outcome);
    if (this.outcomes.size > 5_000) this.outcomes.delete(this.outcomes.keys().next().value as string);
  }

  private forget(key: string, act: Act): void {
    // Only what this act still owns: a root read again opened another act for the same process (a
    // missed read), which keeps its own entries (round 11).
    for (const m of act.members) {
      if (this.owner.get(m) !== key) continue;
      this.owner.delete(m);
      this.admittedUnder.delete(m);
    }
    this.acts.delete(key);
    this.pendingActs.delete(key);
  }
}

/** argv → privacy-classed origins : http(s) URLs and public-DNS hosts observed in the
 * command, stamped with the observer-device witness. Private/loopback hosts are skipped (they add
 * nothing to the independence test and carry no public provenance value). Never the raw token. */
export function extractOrigins(argv: readonly string[], witness: OriginWitness | null): InputOrigin[] {
  const out = new Map<string, InputOrigin>();
  const add = (host: string | null): void => {
    if (host === null || isPrivateHost(host)) return;
    const o = resolvableOrigin(`domain:${host.toLowerCase()}`, witness);
    if (!out.has(o.hash)) out.set(o.hash, o);
  };
  // argv tokens may bundle whitespace (`sh -c "curl https://x"`), so split each into words.
  for (const token of argv) {
    for (const word of token.split(/\s+/)) {
      if (!word) continue;
      const url = URL_IN_WORD_RE.exec(word);
      if (url) { add(domainOf(url[0])); continue; }
      const scp = SCP_RE.exec(word);
      if (scp) { add(scp[1]); continue; }
      add(bareHost(word));
    }
  }
  return [...out.values()];
}
