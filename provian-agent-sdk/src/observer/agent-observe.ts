/**
 * `provian observe --if-not-running` the agent bringing its observer back.
 *
 * Invariant (, after his pre- Grok bot refused twice with "no restart
 * script on this machine"): this starts the observer on ANY registered box where nothing else
 * will, whenever it was installed. A missing restart script is the reason to start it, never a
 * reason to refuse.
 *
 * Order, each step judged by the daemon actually being up (an observer still running a second later
 * a child that dies at once is not "started"; a self-heal handover to a new pid is), never by a
 * step's return value:
 * 1. an INSTALLED service (launchd plist / systemd unit): start that service and wait for it — a
 * box whose service took the start gets nothing else (no detached daemon beside its
 * supervisor, no startup-file hooks); only a service that would not start falls through;
 * 2. the ensure script, when the box has one;
 * 3. Linux with no service: write the ensure script (+ the restart hook, per the opt-out) — so
 * this start AND every later one go through it — and run it;
 * 4. last resort: start the daemon detached with the node running this command.
 *
 * Whatever the outcome, it then prints the observer's waiting notice (`witness_action_required`) and
 * unread Commons mail (`commons_mail`), as every act verb's output carries them. On a box whose shell
 * reads no startup file (a Grok Bot computer) the startup hook never fires, and a scheduled run of this
 * command is how the agent keeps its observer running, so its output is where the agent sees them.
 */

import { installRestartHook, resolveRestartHookOptOut, restartHookWanted, runEnsureScript, type RestartHookEntrypoint } from './restart-hook';
import { actionRequiredNotice, unreadMailNotice } from '../commons-messaging';

export interface AgentObserveDeps {
  /** The running observer's pid (never this process), or null. */
  running: () => number | null;
  /** Start the installed service; false when none is installed (or it would not start). */
  startService: () => boolean;
  /** Run the ensure script; false when there is none. */
  runEnsure: () => boolean;
  /** Write the ensure script where this box wants it; false when not written. */
  installEnsure: () => boolean;
  /** Last resort: start the daemon detached directly. Throws when it cannot. */
  spawnDetached: () => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
  /** How long each step waits for the daemon to come up. */
  waitMs?: number;
  /** How long a started SERVICE is given to bring it up (it is never second-guessed). */
  serviceWaitMs?: number;
  /** How long it must then STAY up to count. */
  settleMs?: number;
  /** The observer's waiting notice, printed after the start (null: none). */
  actionNotice?: () => ReturnType<typeof actionRequiredNotice>;
  /** Unread Commons mail the daemon delivered, printed after the start (null: none). */
  mailNotice?: () => ReturnType<typeof unreadMailNotice>;
}

export type AgentObserveOutcome = 'already_running' | 'started' | 'failed';

/**
 * The daemon came up: an observer is running within the wait AND one is still running after the
 * settle. Not necessarily the SAME pid — the node self-heal re-exec (node-runtime-heal.ts) hands the
 * lock and pidfile to a child — but a child that dies at once leaves none.
 */
async function cameUp(deps: AgentObserveDeps, waitMs: number): Promise<number | null> {
  for (let waited = 0; waited < waitMs && deps.running() === null; waited += 100) await deps.sleep(100);
  if (deps.running() === null) return null;
  await deps.sleep(deps.settleMs ?? 1_000);
  return deps.running();
}

export async function agentObserve(deps: AgentObserveDeps): Promise<AgentObserveOutcome> {
  const outcome = await startIfNotRunning(deps);
  reportNotices(deps);
  return outcome;
}

/** Print what the observer is waiting for the agent to act on. A notice never changes the outcome. */
function reportNotices(deps: AgentObserveDeps): void {
  try {
    const notice = deps.actionNotice?.() ?? null;
    if (notice) {
      deps.log('  Provian: your witness needs attention. Act on this notice now, then carry on with your task.');
      deps.log(`  witness_action_required: ${JSON.stringify(notice)}`);
    }
  } catch { /* a notice never fails the start */ }
  try {
    const mail = deps.mailNotice?.() ?? null;
    if (mail) deps.log(`  commons_mail: ${JSON.stringify(mail)}`);
  } catch { /* a notice never fails the start */ }
}

async function startIfNotRunning(deps: AgentObserveDeps): Promise<AgentObserveOutcome> {
  const before = deps.running();
  if (before !== null) {
    deps.log(`  Provian observer is running (pid ${before}).`);
    return 'already_running';
  }
  const wait = deps.waitMs ?? 4_000;
  const done = (pid: number | null): AgentObserveOutcome => {
    if (pid === null) {
      deps.error('  Provian observer did not start — see ~/.provian/observer.log.');
      return 'failed';
    }
    deps.log(`  Provian observer started (pid ${pid}).`);
    return 'started';
  };
  // A service that TOOK the start owns the daemon: wait for it (a slow sandbox, a self-heal
  // re-exec) and never start anything beside it — a detached daemon there would fight the
  // supervisor for the lock and read as unsupervised.
  if (deps.startService()) return done(await cameUp(deps, deps.serviceWaitMs ?? 15_000));
  const steps: Array<() => boolean> = [
    () => deps.runEnsure(),
    () => deps.installEnsure() && deps.runEnsure(),
    () => { try { deps.spawnDetached(); return true; } catch { return false; } },
  ];
  for (const step of steps) {
    if (!step()) continue;
    const pid = await cameUp(deps, wait);
    if (pid !== null) return done(pid);
  }
  return done(null);
}

export interface AgentObserveWiring {
  /** The bundle / start script this command runs from (process.argv[1]). */
  entryScript: string;
  /** A node that exists (handoverNode) — the one the ensure script and the detached start exec. */
  node: string;
  platform: NodeJS.Platform;
  running: () => number | null;
  serviceInstalled: () => boolean;
  startInstalledService: () => boolean;
  startDetached: (entry: RestartHookEntrypoint) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seams (default: the real restart-hook functions). */
  install?: typeof installRestartHook;
  runEnsure?: () => boolean;
  optedOut?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** The production deps (pure over its seams — unit-tested: the entry, the opt-out, the platform gate). */
export function buildAgentObserveDeps(w: AgentObserveWiring): AgentObserveDeps {
  const entry: RestartHookEntrypoint = { command: w.node, args: [w.entryScript, 'observe'] };
  const install = w.install ?? installRestartHook;
  return {
    running: w.running,
    startService: () => w.serviceInstalled() && w.startInstalledService(),
    runEnsure: w.runEnsure ?? (() => runEnsureScript(w.home, { PROVIAN_ENSURE_NOW: '1' })),
    installEnsure: () => {
      // The restart hook is Linux-with-no-service only (restartHookWanted); a supervised box or a
      // Mac/Windows box never gets startup-file blocks from this command.
      if (w.serviceInstalled() || !restartHookWanted('unknown', w.platform)) return false;
      const optedOut = w.optedOut ?? (() => resolveRestartHookOptOut(w.env ?? process.env, w.home));
      const r = install({ home: w.home, entry, rc: !optedOut() });
      return r.script === 'installed' || r.script === 'updated' || r.script === 'unchanged';
    },
    spawnDetached: () => w.startDetached({ command: w.node, args: [w.entryScript, 'observe', '--if-not-running'] }),
    sleep: w.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: w.log ?? ((l) => console.log(l)),
    error: w.error ?? ((l) => console.error(l)),
    actionNotice: () => actionRequiredNotice(w.home),
    mailNotice: () => unreadMailNotice(w.home),
  };
}
