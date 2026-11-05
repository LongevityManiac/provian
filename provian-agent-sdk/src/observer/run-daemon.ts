import {startCommonsEvents,signalCommonsMailWaiting} from '../commons-events';
import {commonsRuntime} from '../commons-runtime';
/**
 * run-daemon — the Provian observer daemon runner, extracted from
 * scripts/start-observer so BOTH entrypoints share ONE implementation:
 *   - `scripts/start-observer.ts` — the `npx @provian/agent-sdk observe` CLI, and
 *     the launchd/systemd/schtasks exec target for a normally-installed SDK.
 *   - the hosted onboarding bundle's `observe` subcommand
 *     (`node ~/.provian/agent.js observe`). Pre-publish the bundle IS the SDK, so
 *     the LaunchAgent runs the observer FROM the bundle instead of
 *     `npx @provian/agent-sdk observe`, which E404s until the npm-publish flip and
 *     exited 78 (empty observer.log, service dead).
 * One source = no drift between the two (never redeclare the logic the other
 * entrypoint runs).
 */

import { ensureRecoveryEscrow, type EscrowHealInput, type EscrowHealOutcome } from '../recovery-escrow-heal';
import { ensureDaemonWritesLog } from './log-sink';
import { homedir } from 'os';
import * as path from 'path';
import { ProvianObserver } from './ProvianObserver';
import { ProcessPlugin } from './plugins/ProcessPlugin';
import { ProcessLanePlugin } from './plugins/process-lane/ProcessLanePlugin';
import { GitPlugin } from './plugins/GitPlugin';
import { registerBuiltInLane } from './built-in-lanes';
import { OTelPlugin } from './plugins/OTelPlugin';
import { TranscriptPlugin } from './plugins/transcript/TranscriptPlugin';
import { sqliteAvailability } from './plugins/transcript/record-store';
import { buildCaptureHealthReport } from './capture-health';
import { LLMPlugin } from './plugins/LLMPlugin';
import { LLMSessionPlugin } from './plugins/llm-session/LLMSessionPlugin';
import { detectHarnessHomes, type SupervisionMethod } from './capture-health';
import { removeModelProxyFromExistingProfiles } from '../scripts/shell-profile';
import { unrepointGrok } from '../grok-proxy-config';
import { FINAL_SUBMIT_BUDGET_MS } from './commit-budget';
import { runRetiredLanesCleanup, RetiredGrokHooksJournalPlugin, retiredGrokHooksJournalPath } from './retired-lanes-cleanup';
import { ModelProxyPlugin, resolveModelProxyConfig } from './plugins/ModelProxyPlugin';
import { MODEL_PROXY_DEFAULT_PORT } from './plugins/model-proxy/routing';
import { probeLocalInferenceRuntimes, describeLocalInferenceProbe } from './plugins/local-inference/runtimes';
import { parsePathList } from './parse-path-list';
import { ensureDaemonRunning, probeLoopbackPort, startDaemonForEnsure } from './ensure-running';
import {
  healRestartHook, restartHookInstalled, runningObserverEntry, probeCronDaemon,
  resolveRestartMechanism, restartHookFired, readInstallShellProbe,
} from './restart-hook';
import {
  PID_FILE, OBSERVER_LOG, SUPERVISOR_ENV, LAUNCHD_LABEL, writePidFile, isZombie, isObserverProcess, isLiveObserver, observerLockHolder, listOwnProcesses, type ListedProcess, publishSessionOtelEndpoint, claimObserverLock,
  releaseObserverLock, removeOwnPidFile, readInstalledWindowsTaskXml, windowsTaskRestartsDaemon, repointServiceNode,
} from './service';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ensureStoreCapableNodeRuntime, SELFHEAL_FROM_ENV, SELFHEAL_GUARD_ENV } from './node-runtime-heal';
import { provianNodeBin } from './provian-node';
import { applyRuntimeEnvAtEntry, RUNTIME_ENV_REEXEC_GUARD } from '../runtime-env';
import { defaultPeOutboxDir } from '../pe-outbox';
import { defaultPeStoreRoot } from '../meter/pe-store';
import { agentMessagePublicKey, agentMessageSecretProvider } from '../meter/message-key';
import { CommonsInstitutions } from '../commons-institutions';
import { startCommonsMessageKeyHeal, startThreadDelivery, syncCommonsHeartbeatNotice } from '../commons-messaging';
import { healGlobalHook } from '../hook-install';
import { ensureProvianShim, provianShimPath } from '../provian-shim';
import { OTLP_DEFAULT_PORT } from './plugins/OTelPlugin';
import { loadCredentials, getCredentialsPath } from '../scripts/credentials';
import { loadAgentCredentialsFile } from '../scripts/agent-credentials-file';
import {
  checkAtRestSecretHealth,
  describeAtRestSecretFailure,
  reportRecoveryAlarm,
  reportRecoveryHealthy,
} from '../at-rest-secret-health';
import {
  resolveSelfUpdateConfig,
  selfUpdateEntryFor,
  runSelfUpdateOnce,
  isTransientSelfUpdateOutcome,
  RELEASE_RETRY_INTERVAL_MS,
  type SelfUpdateConfig,
} from './self-update';
import { buildSelfUpdateIO } from './self-update-io';
import { PeerAttributor } from './peer-process';
import { ProgramWitnessRegistry } from './program-witness';
import { cliCommand, HOSTED_BUNDLE } from '../cli-command';

export interface ParsedArgs {
  pid?: number;
  idleMs: number;
  maxSessionMs: number;
  tickIntervalMs: number;
  plugins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Exit 0 silently when a daemon already holds the pidfile (the cron supervisor's tick). */
  ifNotRunning?: boolean;
  /**
   * Make sure the daemon is up and its shim (`--ensure-port`) is listening,
   * bounded, then exit 0. Never runs a daemon itself. The retired Grok
   * SessionStart hook ran this (dropped the hooks lane); it stays accepted
   * because a hook file an earlier daemon wrote can still invoke it until the
   * updated daemon's first start removes that file.
   */
  ensureRunning?: boolean;
  ensurePort?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    idleMs: 30_000,
    maxSessionMs: 15 * 60 * 1000,
    tickIntervalMs: 1000,
    plugins: ['process', 'process_lane', 'git', 'otel', 'transcript', 'llm', 'llm_session'],
    logLevel: 'info',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = argv[i + 1];
    if (arg === '--pid' && next) { args.pid = parseInt(next, 10); i++; }
    else if (arg === '--idle' && next) { args.idleMs = parseInt(next, 10); i++; }
    else if (arg === '--max-session' && next) { args.maxSessionMs = parseInt(next, 10); i++; }
    else if (arg === '--tick' && next) { args.tickIntervalMs = parseInt(next, 10); i++; }
    else if (arg === '--plugins' && next) { args.plugins = next.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (arg === '--log-level' && next) { args.logLevel = next as ParsedArgs['logLevel']; i++; }
    else if (arg === '--if-not-running') { args.ifNotRunning = true; }
    else if (arg === '--ensure-running') { args.ensureRunning = true; }
    else if (arg === '--ensure-port' && next) { args.ensurePort = parseInt(next, 10); i++; }
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
  }
  return args;
}

/**
 * Parse PROVIAN_GIT_REPOS into absolute repo paths for GitPlugin to watch.
 * Delegates to the shared parsePathList (one splitting-rule implementation for
 * PROVIAN_GIT_REPOS and PROVIAN_TRANSCRIPT_ROOTS). Empty/unset → no explicit
 * repos (GitPlugin still discovers a repo at cwd).
 */
export function parseGitRepoPaths(raw: string | undefined): string[] {
  return parsePathList(raw);
}

/** Requested plugins are filtered by prerequisites and the registered owner.
 * Tool-call witnesses and system process sampling run only on agent devices.
 * Human devices keep their existing commits, local inference and desktop chat.
 */
export function resolveActivePlugins(
  requested: string[],
  ctx: {
    ownerType: 'human' | 'agent';
    platform: string;
    hasLlmLog: boolean;
    /**
     * The startup probe found a local inference runtime (running OR installed)
     * — `probeLocalInferenceRuntimes().detected`. This is what keeps `llm` on
     * with NO env var: local model work on a registered machine is witnessed
     * on human AND agent devices alike. "Installed" counts so a runtime that
     * starts after the daemon (login-order race) is still picked up by the
     * plugin's own periodic re-probe.
     */
    localInferenceDetected: boolean;
  },
): Set<string> {
  const plugins = new Set(requested);
  if (!ctx.hasLlmLog && !ctx.localInferenceDetected) plugins.delete('llm');
  // LLMSessionPlugin ships native foreground helpers for macOS (darwin) and
  // Windows (win32) only.
  if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
    plugins.delete('llm_session');
  }
  // The foreground AI-app observer is a HUMAN Desktop-daemon source only
  //. On an agent's machine it either does nothing
  // (headless) or records a human's or a computer-use agent's foreground screen
  // time as the AGENT's work — the wrong author on the PE. So an agent device
  // never runs it, whatever `--plugins` or `capture.llm_session_enabled` say;
  // an already-installed agent daemon drops it on its next start, which a
  // self-update's re-exec supplies.
  if (ctx.ownerType === 'agent') {
    plugins.delete('llm_session');
    plugins.delete('llm');
  }
  if (ctx.ownerType !== 'agent') {
    // /human devices produce no tool-call witnesses by any lane. 'process' here is the
    // CPU-telemetry ProcessPlugin (dormant on humans anyway); 'process_lane' is the command
    // witness, which must never record a human's screen as an agent's work.
    plugins.delete('process');
    plugins.delete('process_lane');
    plugins.delete('otel');
    plugins.delete('transcript');
    plugins.delete('model_proxy');
  }
  return plugins;
}

function printUsage(): void {
  console.log(`
Usage: start-observer [options]

Options:
  --pid <pid>           Watch a specific process (default: own process group)
  --idle <ms>           Idle threshold in ms (default: 30000)
  --max-session <ms>    Max session duration in ms (default: 900000)
  --tick <ms>           Tick interval in ms (default: 1000)
  --plugins <list>      Comma-separated plugin names (default: process,process_lane,git,otel,transcript,llm,llm_session)
                        Available: process, process_lane, git, otel, transcript, llm, llm_session
  --log-level <level>   debug | info | warn | error (default: info)
  --if-not-running      Exit 0 quietly if an observer is already running (cron supervision)
  --help, -h            Show this help

Plugins activate when their prerequisites are present:
  llm         : witnesses LOCAL model inference with no configuration — Ollama
                (:11434), LM Studio (:1234) and llama.cpp llama-server (:8080) are
                detected on loopback and their own request logs are tailed; each
                window of completed requests becomes an inference_session PE.
                Token counts are recorded only where the runtime exposes them
                (llama.cpp / LM Studio logs, or a JSONL log at PROVIAN_LLM_LOG);
                Ollama sessions carry request + model counts with tokens null.
                Log overrides: PROVIAN_OLLAMA_LOG, PROVIAN_LMSTUDIO_LOG,
                PROVIAN_LLAMA_SERVER_LOG.
  llm_session : captures desktop AI foreground sessions (macOS/Windows, consent-gated;
                human devices only — never runs on an agent device)
`);
}

export async function runObserverDaemon(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  // Start the daemon if it is down and wait (≤ 4 s) for its shim, then exit 0 —
  // fail-open, never a daemon itself, never a claim (a retired Grok hook file
  // may still invoke this until the updated daemon removes it).
  if (args.ensureRunning) {
    const port = Number.isInteger(args.ensurePort) && (args.ensurePort as number) > 0
      ? args.ensurePort as number : MODEL_PROXY_DEFAULT_PORT;
    const entry = process.argv[1];
    await ensureDaemonRunning(port, {
      probe: (p) => probeLoopbackPort(p),
      start: () => (typeof entry === 'string' && entry.length > 0
        ? startDaemonForEnsure({ entry, launchdLabel: LAUNCHD_LABEL, supervisorEnv: SUPERVISOR_ENV, logFile: OBSERVER_LOG })
        : null),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    process.exit(0);
  }
  // (F): a detached successor started by a self-update waits for its
  // predecessor to exit before it looks at the pidfile.
  //: claim the machine ATOMICALLY before anything
  // else — cron can launch two daemons at once, and a check-then-write pidfile
  // let both run. The pidfile is written immediately after the claim.
  const startClaim = await claimMachineAtStart();
  // A successor whose predecessor still runs (it ran the new bytes in place): that is the daemon.
  if (startClaim === 'stand_down') process.exit(0);
  const claim = startClaim;
  if (!claim.held) {
    // The cron supervisor (a box with no `systemctl --user`) runs
    // `observe --if-not-running` every minute; a live daemon is the expected
    // case there, so it exits 0 without a log line per minute.
    if (args.ifNotRunning) process.exit(0);
    console.error(`Observer already running${claim.holder ? ` (pid ${claim.holder})` : ' (starting)'}. See ${PID_FILE}.`);
    process.exit(1);
  }
  // follow-up: the daemon writes ~/.provian/observer.log itself, whoever started
  // it (an agent's shell included) — doctor and every log-derived check read that file.
  if (ensureDaemonWritesLog(OBSERVER_LOG) === 'teed') {
    console.log(`[observer] started with its output elsewhere; also writing ${OBSERVER_LOG}`);
  }
  // The run's first line: doctor reads this run's lanes from here on (they log before `started`).
  console.log(`[observer] starting (pid ${process.pid})`);
  writePidFile(process.pid);
  const releaseClaim = (): void => {
    removeOwnPidFile(process.pid);
    releaseObserverLock(process.pid);
  };
  // (C): the npm-installed observer (start-observer.js) is its own entry,
  // so it applies the recorded egress environment itself. Under the bundle the
  // dispatcher already did, and this is a no-op.
  applyRuntimeEnvAtEntry();

  const creds = loadCredentials();
  if (!creds) {
    console.error('Error: Device not registered.');
    console.error(`No credentials found in env or ${getCredentialsPath()}`);
    console.error(HOSTED_BUNDLE
      ? 'Generate a fresh code in the Provian app under "Connect an agent" and paste the install line again.'
      : `Run: ${cliCommand('register-device')}`);
    process.exit(1);
  }

  // Every start, including stale units and signed self-update successors, moves
  // onto the checksum-verified private installer Node22 before capture begins.
  // A failed fetch/handover stops startup. The healed child re-points old units.
  const healedFromNode = await prepareNodeRuntimeAtStart();

  const ownerType = creds.ownerType ?? 'human';
  const isAgentDevice = ownerType === 'agent';


  // recovery pre-flight: an agent whose wallet keystore is present but
  // whose at-rest secret is GONE (or does not decrypt it) has an unusable and —
  // absent a phone escrow — UNRECOVERABLE key. the invariant: REFUSE to start
  // earning and ALARM, never silently keep accruing PVT it can no longer reach
  // (the exact failure that stranded Atlas's 508 PVT). The relay alarm surfaces
  // it in the Command Center; recovery (re-key / restore) rewrites the secret and
  // the next daemon start proceeds normally.
  if (isAgentDevice) {
    const health = checkAtRestSecretHealth();
    if (!health.ok) {
      console.error(`[observer] REFUSING TO EARN — ${describeAtRestSecretFailure(health.reason)}`);
      const agentCreds = loadAgentCredentialsFile();
      if (agentCreds?.wallet_id && agentCreds.api_key && agentCreds.api_secret) {
        const posted = await reportRecoveryAlarm({
          relayUrl: creds.relayUrl,
          walletId: agentCreds.wallet_id,
          apiKey: agentCreds.api_key,
          apiSecret: agentCreds.api_secret,
          reason: health.reason,
        });
        console.error(`[observer] recovery alarm ${posted ? 'reported to the relay' : 'could not be reported (no reachable relay/creds)'}.`);
      } else {
        console.error('[observer] recovery alarm not reported: no agent API credentials on this machine.');
      }
      process.exit(1);
    } else {
      // Healthy again : auto-clear any outstanding recovery alarm so the Command Center
      // reflects recovery without manual intervention. Idempotent + best-effort; a no-op when no
      // alarm is active. Never blocks the daemon start.
      const agentCreds = loadAgentCredentialsFile();
      if (agentCreds?.wallet_id && agentCreds.api_key && agentCreds.api_secret) {
        const cleared = await reportRecoveryHealthy({
          relayUrl: creds.relayUrl,
          walletId: agentCreds.wallet_id,
          apiKey: agentCreds.api_key,
          apiSecret: agentCreds.api_secret,
        });
        if (cleared) console.log('[observer] recovery alarm cleared — at-rest secret healthy again.');
        // Item 11: an agent with no escrow (a fleet install before its human published a
        // recovery anchor) escrows itself as soon as the anchor is there.
        startRecoveryEscrowHeal({
          relayUrl: creds.relayUrl, walletId: agentCreds.wallet_id, apiKey: agentCreds.api_key, apiSecret: agentCreds.api_secret,
        });
        startCommonsMessaging({
          relayUrl: creds.relayUrl, walletId: agentCreds.wallet_id, apiKey: agentCreds.api_key, apiSecret: agentCreds.api_secret,
        });
      }
    }
  }

  // Lever 1 (self-heal): on an agent device the OTLP receiver always starts, so
  // publish the endpoint session-wide on every daemon start. Because the daemon
  // is RunAtLoad, this re-publishes on every login/reboot — an agent launched
  // headless / under launchd / systemd (which sources no shell rc file) still
  // inherits OTEL_EXPORTER_OTLP_ENDPOINT and exports to the local receiver.
  // Best-effort and never throws; a failure degrades to `npx @provian/agent-sdk run`.
  if (isAgentDevice) {
    try {
      const pub = publishSessionOtelEndpoint(OTLP_DEFAULT_PORT);
      if (pub.published) {
        console.log(`[observer] otel endpoint published session-wide (${pub.endpoint})`);
      } else if (pub.errors.length > 0) {
        console.log(`[observer] otel endpoint not published session-wide: ${pub.errors.join('; ')}`);
      }
    } catch { /* best-effort */ }
  }

  // : the Grok hooks lane, the local witness
  // endpoint and agent self-reporting are retired. BEFORE any lane is registered,
  // this start removes what an earlier daemon or installer left behind — the
  // Provian Grok hook file, the hooks lane's records (its decided-but-unsent
  // PEs are resubmitted once below, then its journal is deleted), the retired
  // PROVIAN_WITNESS_* lines in runtime.env, and the "# Provian PE Reporting"
  // section register-device appended to ~/.claude/CLAUDE.md. A self-update's
  // re-exec supplies this start on every installed box. The endpoint is never
  // constructed again (retired-lanes-cleanup.ts).
  const retired = runRetiredLanesCleanup({ instructionDirs: [process.cwd(), ...parseGitRepoPaths(process.env.PROVIAN_GIT_REPOS)] });
  if (retired.grokHookFile === 'removed') console.log('[observer] retired Grok hook file removed (~/.grok/hooks/provian.json)');
  else if (retired.grokHookFile === 'foreign') console.log('[observer] ~/.grok/hooks/provian.json is not Provian\'s; left in place');
  else if (retired.grokHookFile === 'error') console.warn('[observer] the retired Grok hook file could not be removed; the next start tries again');
  if (retired.recordsDeleted.length > 0) console.log(`[observer] retired Grok hooks records deleted (${retired.recordsDeleted.length})`);
  if (retired.runtimeEnvKeysRemoved.length > 0) console.log(`[observer] retired witness settings removed from runtime.env (${retired.runtimeEnvKeysRemoved.join(', ')})`);
  for (const f of retired.instructionFilesChanged) console.log(`[observer] removed the Provian PE Reporting section from ${f}`);
  if (retired.journal) {
    console.log(`[observer] retired Grok hooks journal: ${retired.journal.pending.length} decided PE(s) to resubmit, ${retired.journal.undecided} undecided turn(s) not minted`);
  }

  // Preserve human inference and desktop chat. Agent tool lanes consult the
  // machine-local fixed program registry; model calls alone never mint for agents.
  const localInference = await probeLocalInferenceRuntimes({ timeoutMs: 750 });
  const plugins = resolveActivePlugins(args.plugins, {
    ownerType,
    platform: process.platform,
    hasLlmLog: Boolean(process.env.PROVIAN_LLM_LOG),
    localInferenceDetected: localInference.detected,
  });
  console.log(`[observer] local inference: ${describeLocalInferenceProbe(localInference)}`);

  const observer = new ProvianObserver({
    targetPid: args.pid,
    idleThresholdMs: args.idleMs,
    maxSessionMs: args.maxSessionMs,
    tickIntervalMs: args.tickIntervalMs,
    plugins: Array.from(plugins),
    relayUrl: creds.relayUrl,
    credentials: creds,
    logLevel: args.logLevel,
    // PE meter : every PE is built, chained and kept on this machine
    // (one directory per device under ~/.provian/pe-store, or PROVIAN_PE_STORE_DIR); the batcher
    // sends one signed batch of act records a day. The legacy outbox is migrated in once.
    peOutboxDir: defaultPeOutboxDir(),
    peStoreDir: defaultPeStoreRoot(),
    meterBatching: true,
    // The mailbox (PEs sealed to this agent) opens only where the agent's keystore is readable.
    ...(isAgentDevice ? { messageSecretKey: agentMessageSecretProvider(creds.agentWalletId) } : {}),
  });

  console.log(`[observer] owner_type=${ownerType}` +
    (isAgentDevice && creds.agentWalletId ? ` agent_wallet=${creds.agentWalletId}` : ''));

  // The retired hooks journal's decided PEs: handed to the observer once (its PE
  // outbox journals each before sending), under their turns' deterministic relay
  // keys; the journal file is deleted once each is submitted or journaled.
  if (retired.journal) {
    registerBuiltInLane(observer, new RetiredGrokHooksJournalPlugin({
      journalPath: retiredGrokHooksJournalPath(),
      pending: retired.journal.pending,
      log: (m) => console.log(`[observer] ${m}`),
    }));
  }

  if (plugins.has('process')) registerBuiltInLane(observer, new ProcessPlugin());
  // GitPlugin watches repos given via PROVIAN_GIT_REPOS (plus a repo at cwd).
  // Whatever it watches, it publishes to observer-git-repos so the post-commit
  // hook defers only for those repos and otherwise captures the commit itself.
  if (plugins.has('git')) {
    registerBuiltInLane(observer, new GitPlugin(parseGitRepoPaths(process.env.PROVIAN_GIT_REPOS)));
  }
  // Keep the OTel reference so the capture-health heartbeat can report the OTel
  // witness lane's live state (active / listening / spans-ever-seen), which is
  // how a single-witness OpenClaw device reads as single-witness (item 5).
  const programs = new ProgramWitnessRegistry();
  const peerAttributor = new PeerAttributor({ identifyProgram: p => programs.identify(p) });
  const otelPlugin = isAgentDevice && plugins.has('otel') ? new OTelPlugin({ forceActive: true, programRegistry: programs, peerAttributor }) : null;
  if (otelPlugin) registerBuiltInLane(observer, otelPlugin);
  const transcriptPlugin = isAgentDevice && plugins.has('transcript') ? new TranscriptPlugin({ registry: programs }) : null;
  if (transcriptPlugin) registerBuiltInLane(observer, transcriptPlugin);
  if (plugins.has('llm')) registerBuiltInLane(observer, new LLMPlugin({ initialProbe: localInference }));
  if (plugins.has('llm_session')) registerBuiltInLane(observer, new LLMSessionPlugin());
  const modelProxyConfig = isAgentDevice ? resolveModelProxyConfig(process.env) : null;
  const modelProxyPlugin = modelProxyConfig ? new ModelProxyPlugin({ ...modelProxyConfig, programRegistry: programs, peerAttributor }) : null;
  if (modelProxyPlugin) registerBuiltInLane(observer, modelProxyPlugin);
  // the process lane: an agent VM's own commands, read from the OS, for work no described
  // lane sees. Agent devices only (resolveActivePlugins drops it on humans).
  const processLanePlugin = isAgentDevice && plugins.has('process_lane') ? new ProcessLanePlugin() : null;
  if (processLanePlugin) registerBuiltInLane(observer, processLanePlugin);
  const shutdown = async (signal: string) => {
    console.log(`[observer] received ${signal}, shutting down`);
    await stopObserverBounded(observer);
    releaseClaim();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Never two daemons, whatever started them: a daemon whose machine lock names another live daemon
  // stands down (a pair left by an older release's self-update converges on its next check).
  startLockGuard(() => {
    console.log('[observer] another observer holds this machine; standing down');
    void shutdown('lock_held_elsewhere');
  }, {
    // The stray usually held the proxy and OTLP ports; those lanes take them back once it is gone.
    onStraysStopped: () => { modelProxyPlugin?.rebindIfWaiting(); otelPlugin?.rebindIfWaiting(); },
  });
  installFatalHandlers(process, {
    onFatal: (err) => {
      console.error(`[observer] fatal: ${err instanceof Error ? err.message : String(err)}`);
      releaseClaim();
    },
  });

  try {
    await observer.start();
    // FIRST after the plugins bind: the Grok proxy repoint (durable, in
    // ~/.grok/config.toml). Written only while the shim is verified listening AND
    // a supervisor restarts this daemon; a shim that is off or failed to bind, or
    // a daemon nothing restarts, REMOVES any repoint an earlier run left (a
    // repoint to a dead port breaks Grok), and PROVIAN_GROK_PROXY=0 removes it.
    const supervision = supervisionFacts(process.env);
    // on a box with no service manager (detached) or an unreliable cron, write/refresh the
    // shell-startup restart hook — so a self-updated daemon installs it with no user action — or
    // remove it when opted out. It restarts the daemon only; the Grok repoint decision below is
    // unchanged and does not read it.
    const entryForHook = runningObserverEntry();
    if (entryForHook) {
      const hook = healRestartHook({ method: supervision.method, entry: entryForHook });
      const changed = hook ? Object.entries(hook.rc).filter(([, o]) => o === 'written' || o === 'created' || o === 'removed') : [];
      if (hook && (hook.script === 'installed' || hook.script === 'updated' || hook.script === 'removed' || changed.length > 0)) {
        console.log(`[observer] restart hook ${hook.script === 'removed' ? 'removed' : 'in place'} (script ${hook.script}; ${changed.map(([f, o]) => `${f} ${o}`).join(', ') || 'rc files current'})`);
      }
    }
    removeModelProxyFromExistingProfiles();
    try { unrepointGrok(); } catch { /* remove the old automatic harness repoint */ }
    console.log(`[observer] started (pid ${process.pid})`);
    // (D): a global commit hook baked before the absolute-node fix ran a
    // bare `node` that a private-runtime box does not have. Rewrite a stale one
    // (between its markers) so the self-update repairs boxes already installed.
    try {
      const healed = healGlobalHook();
      if (healed === 'healed') console.log('[observer] git commit hook refreshed (node path)');
    } catch (err) {
      console.warn(`[observer] git commit hook refresh skipped: ${(err as Error).message}`);
    }
    // the `provian` shell command for the act verbs, (re)written by the running
    // bundle so a self-updated install gets it. Never throws; a package install is skipped.
    const shim = ensureProvianShim(process.argv[1]);
    if (shim === 'installed' || shim === 'updated') console.log(`[observer] provian command ${shim} (${provianShimPath()})`);
    // a daemon healed onto ~/.provian/node re-points the service units
    // still baked with the node it came from, so the next restart starts there.
    repointUnitsAfterHeal(healedFromNode, process.execPath);
    startCaptureHealthHeartbeat(observer, transcriptPlugin, otelPlugin, modelProxyPlugin, processLanePlugin);
    // daemon self-update — DEFAULT ON, opt-out (PROVIAN_SELF_UPDATE=0;
    // the operator , close). The fix lands on every machine with no user
    // action; an operator can still turn it off. It polls the Provian-SIGNED
    // release channel and applies ONLY bytes whose hash matches the signed
    // manifest, fail-closed at every step.
    // Only the hosted bundle is a swappable entry; an npm install's start-observer.js is not.
    const selfUpdate = resolveSelfUpdateConfig(process.env, selfUpdateEntryFor(HOSTED_BUNDLE, process.argv[1]));
    if (selfUpdate) startSelfUpdateLoop(observer, selfUpdate);
  } catch (err) {
    console.error(`[observer] startup error: ${(err as Error).message}`);
    // A daemon that failed to come up has no listening shim.
    releaseClaim();
    process.exit(1);
  }
}

/**
 * a JS-level crash (an uncaught exception or an unhandled rejection —
 * both already ended the process) first runs `onFatal`, which takes the Grok
 * repoint with it, then exits 1 so the supervisor restarts the daemon (whose
 * start writes the repoint again). A hard kill (SIGKILL, OOM) runs nothing; the
 * supervisor's restart bounds how long Grok's calls fail (launchd at once,
 * systemd 10 s, cron and the Windows task within a minute).
 */
export function installFatalHandlers(
  proc: Pick<NodeJS.Process, 'on'>,
  deps: { onFatal: (err: unknown) => void; exit?: (code: number) => void },
): void {
  let handled = false;
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });
  const fatal = (err: unknown): void => {
    if (handled) return;
    handled = true;
    try { deps.onFatal(err); } catch { /* the exit below still happens */ }
    exit(1);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
}

/**
 * (F) / follow-up (: "applying a release never leaves the
 * observer stopped — the new bytes run in-process, no supervisor assumed"): how the
 * daemon hands over to verified new bytes.
 *
 * 1. `process.execve` (Node >= 22.15 — the pinned box runtime is v22.23.2): the new
 * bytes replace this process image IN PLACE — same pid, same parent (a sandbox's
 * process keeper, launchd, systemd), same stdio. Nothing has to relaunch anything,
 * and the observer lock (which names this pid) is re-claimed by the new image.
 * 2. No execve (an older node, Windows): a supervisor that PROVABLY relaunches — cron
 * (`PROVIAN_SUPERVISOR=cron`), launchd (`XPC_SERVICE_NAME` is our label) or systemd
 * (`INVOCATION_ID`) — gets a plain exit(0). Anything else, including an unset
 * marker (a daemon an agent's shell started), starts its own detached successor,
 * which waits for this pid (PROVIAN_WAIT_FOR_PID) and then claims the lock — so
 * there is never a second daemon, and never none.
 */
export function provenRelauncher(
  env: NodeJS.ProcessEnv,
  readCgroup: () => string = () => { try { return fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; } },
): 'cron' | 'launchd' | 'systemd' | null {
  if (env[SUPERVISOR_ENV] === 'cron') return 'cron';
  if (env[SUPERVISOR_ENV] === 'detached') return null;
  if (env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return 'launchd';
  // INVOCATION_ID is inherited by every descendant of ANY unit (an agent harness running as a
  // service starts us from its shell): only OUR unit relaunches us, so the cgroup must name it.
  if (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0
    && /\/provian-observer\.service(\/|$)/m.test(readCgroup())) return 'systemd';
  return null;
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never;

function nativeExecve(): Execve | null {
  const fn = (process as unknown as { execve?: unknown }).execve;
  return typeof fn === 'function' ? (fn as Execve).bind(process) : null;
}

function isReadableFile(p: string): boolean {
  try { fs.accessSync(p, fs.constants.R_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * the startup Node step. Runs the heal (which re-execs and never returns
 * when this runtime cannot read the harness stores), then, in a healed child,
 * returns the node it was healed FROM and removes both markers from the
 * environment so nothing this daemon starts (a self-update successor) inherits
 * the loop guard and skips its own heal.
 */
export async function prepareNodeRuntimeAtStart(
  deps: { env?: NodeJS.ProcessEnv; ensure?: (env: NodeJS.ProcessEnv) => Promise<void> } = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  await (deps.ensure ?? ((e) => ensureStoreCapableNodeRuntime({ env: e })))(env);
  const from = env[SELFHEAL_FROM_ENV] ?? null;
  delete env[SELFHEAL_FROM_ENV];
  delete env[SELFHEAL_GUARD_ENV];
  return from;
}

/** a healed daemon re-points the units still baked with the node it came from. */
export function repointUnitsAfterHeal(
  healedFrom: string | null,
  execPath: string,
  repoint: (from: string, to: string) => string[] = (f, t) => repointServiceNode(f, t),
  log: (line: string) => void = (line) => console.log(line),
): string[] {
  if (!healedFrom) return [];
  const repointed = repoint(healedFrom, execPath);
  if (repointed.length > 0) log(`[observer] node runtime: ${repointed.join(', ')} now start${repointed.length === 1 ? 's' : ''} on ${execPath} (was ${healedFrom})`);
  return repointed;
}

/**
 * The node to hand over to. A failed execve SYSCALL aborts the process (Node does not throw), so
 * the binary is checked BEFORE the call: the running one if it still exists (a Homebrew upgrade can
 * remove its versioned path), else the private runtime, else none.
 */
export function handoverNode(
  execPath: string,
  deps: { executable?: (p: string) => boolean; home?: string; pathEnv?: string } = {},
): string | null {
  const ok = deps.executable ?? isExecutable;
  // The restart hook's order (restart-hook.ts): the baked binary, the private runtime, then PATH —
  // a Homebrew upgrade removes the versioned Cellar path but leaves `node` on PATH.
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const onPath = (deps.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0).map((d) => path.join(d, exe));
  const candidates = [execPath, provianNodeBin(deps.home ?? homedir()), ...onPath];
  for (const c of candidates) if (ok(c)) return c;
  return null;
}

export function selfUpdateReExec(
  env: NodeJS.ProcessEnv,
  deps: {
    spawnDetached?: (command: string, args: string[], env: NodeJS.ProcessEnv) => void;
    exit?: (code: number) => never;
    argv?: string[];
    execArgv?: string[];
    execPath?: string;
    pid?: number;
    /** null = this runtime has no execve (tests); undefined = use process.execve when present. */
    execve?: Execve | null;
    /** Test seam for the binary/entry pre-checks (default: the real filesystem). */
    executable?: (p: string) => boolean;
    log?: (line: string) => void;
  } = {},
): () => never {
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
  const log = deps.log ?? ((line: string) => console.log(line));
  return () => {
    const argv = deps.argv ?? process.argv;
    const node = handoverNode(deps.execPath ?? process.execPath, { executable: deps.executable });
    const execve = deps.execve !== undefined ? deps.execve : nativeExecve();
    const entryOk = typeof argv[1] === 'string' && (deps.executable ?? isReadableFile)(argv[1]);
    const relauncher = provenRelauncher(env);
    const spawnDetached = deps.spawnDetached ?? ((command, args, childEnv) => {
      const out = fs.openSync(OBSERVER_LOG, 'a');
      const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out], cwd: homedir(), env: childEnv });
      child.unref();
    });
    const startSuccessor = (): void => {
      try {
        log('[observer] self-update: starting a successor on the new bytes');
        spawnDetached(node!, [argv[1], 'observe', '--if-not-running'], successorEnv(env, deps.pid ?? process.pid));
      } catch { /* nothing more we can do; exit so the new bytes run at the next start */ }
    };

    // A failed execve SYSCALL aborts this process (Node does not throw), so the catch below — and
    // the successor it would start — NEVER runs on an abort. On a box with no proven supervisor
    // (a detached VM like the Grok bot's), that orphans the daemon: it applied the update, died in
    // the swap, and nothing relaunched it (down 11 days, 2026-10-09→20). So when nothing else will
    // relaunch us, queue the successor FIRST. It waits out this pid and uses `--if-not-running` +
    // the single-instance lock: a successful in-place execve keeps this pid and re-claims the lock,
    // so the successor finds a live daemon and exits — never two daemons, and (the point) never none.
    const guardWithSuccessor = relauncher === null && node !== null && typeof argv[1] === 'string';
    if (guardWithSuccessor) startSuccessor();

    if (execve && node !== null && entryOk) {
      try {
        log('[observer] self-update: running the new bytes in place (execve, same pid)');
        return execve(node, [node, ...(deps.execArgv ?? process.execArgv), ...argv.slice(1)], { ...env });
      } catch (err) {
        // Only a pre-syscall refusal lands here (Windows, argument checks); the binary was checked above.
        log(`[observer] self-update: execve unavailable (${(err as Error).message}); a successor takes over`);
      }
    }
    if (node === null) {
      log('[observer] self-update: no node binary to run the new bytes; the next start runs them');
      return exit(0);
    }
    if (relauncher !== null) {
      log(`[observer] self-update: exiting for ${relauncher} to relaunch on the new bytes`);
      return exit(0);
    }
    // No supervisor and no in-place execve: the pre-execve guard already started the successor.
    if (!guardWithSuccessor) startSuccessor();
    return exit(0);
  };
}

/** Env var naming the predecessor pid a detached successor waits out. */
export const WAIT_FOR_PID_ENV = 'PROVIAN_WAIT_FOR_PID';

/**
 * A self-update successor's environment: detached, waiting out `pid` and never carrying a
 * re-exec marker. With one, its lock claim took the machine over from its parent (the live daemon
 * it was meant to stand behind), and two daemons ran (follow-up, the Grok bot 89 → 90).
 */
export function successorEnv(env: NodeJS.ProcessEnv, pid: number): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, [SUPERVISOR_ENV]: 'detached', [WAIT_FOR_PID_ENV]: String(pid) };
  delete out[RUNTIME_ENV_REEXEC_GUARD];
  delete out[SELFHEAL_GUARD_ENV];
  return out;
}

/**
 * How a starting daemon claims the machine. A self-update successor (`WAIT_FOR_PID_ENV` set) first
 * waits out its predecessor and stands down if it still runs; then it claims without taking the
 * lock over from its parent (follow-up: two daemons on the Grok bot after 89 → 90).
 */
export async function claimMachineAtStart(
  deps: { env?: NodeJS.ProcessEnv; awaitPredecessor?: typeof awaitPredecessor; claim?: typeof claimDaemonLock } = {},
): Promise<'stand_down' | ReturnType<typeof claimObserverLock>> {
  const env = deps.env ?? process.env;
  const waitFor = Number.parseInt(env[WAIT_FOR_PID_ENV] ?? '', 10);
  const successor = Number.isInteger(waitFor) && waitFor > 0;
  if (successor) {
    delete env[WAIT_FOR_PID_ENV];
    if ((await (deps.awaitPredecessor ?? awaitPredecessor)(waitFor)) === 'stand_down') return 'stand_down';
  }
  return (deps.claim ?? claimDaemonLock)(successor);
}

/** How often a running daemon re-reads the machine lock. */
export const LOCK_RECHECK_MS = 60_000;

/** Does the machine lock name another live observer (so this one must stand down)? */
export function lockStandDownCheck(
  deps: { pid?: number; holder?: () => number | null; alive?: (pid: number) => boolean } = {},
): 'keep' | 'stand_down' {
  const pid = deps.pid ?? process.pid;
  const holder = (deps.holder ?? (() => observerLockHolder()))();
  if (holder === null || holder === pid) return 'keep';
  return (deps.alive ?? isLiveObserver)(holder) ? 'stand_down' : 'keep';
}

/** A process this young may still be stepping aside on its own (a start that finds the lock held, a successor). */
export const STRAY_MIN_AGE_MS = 120_000;

/**
 * The lock holder's side: other observer daemons of THIS install (same user, same entry file) that
 * are not this daemon, not a wrapper waiting on it, and older than `STRAY_MIN_AGE_MS`. A wrapper is a
 * parent in this process's own group (the runtime-env / node self-heal re-exec waits on its child
 * there); a self-update successor is started detached, in its own group, so the predecessor it was
 * queued by is NOT exempt — that is the pair the Grok bot ran (89 → 90). An older release's daemon
 * has no lock guard of its own, so only the holder can end a pair it left (follow-up, review
 * round 3).
 */
export function strayObservers(
  procs: readonly ListedProcess[],
  self: { pid: number; entry: string },
  isObserver: (args: readonly string[]) => boolean = (args) => args.some((a) => a === 'observe' || a.endsWith('start-observer.js')),
): number[] {
  // /proc gives argv NUL-separated: the entry must be its own argument (never inside a `sh -c` string).
  // `ps` gives one space-joined line, so there the split is on whitespace.
  const argsOf = (command: string): string[] => (command.includes('\0') ? command.split('\0') : command.split(/\s+/)).filter((a) => a.length > 0);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const ancestors = new Set<number>();
  for (let child = byPid.get(self.pid), n = 0; child !== undefined && n < 64; n++) {
    const parent = byPid.get(child.ppid);
    if (parent === undefined || parent.pid <= 1 || parent.pgid !== child.pgid) break;
    ancestors.add(parent.pid);
    child = parent;
  }
  return procs
    .filter((p) => p.pid !== self.pid && !ancestors.has(p.pid) && p.ageMs >= STRAY_MIN_AGE_MS)
    .filter((p) => { const args = argsOf(p.command); return args.includes(self.entry) && isObserver(args); })
    .map((p) => p.pid);
}

/** Re-check the lock every minute; on another live holder, stand down once; as the holder, stop strays. */
export function startLockGuard(
  onStandDown: () => void,
  deps: {
    check?: () => 'keep' | 'stand_down';
    every?: (fn: () => void, ms: number) => { unref?: () => void } & object;
    stop?: (h: unknown) => void;
    /** As the holder: the strays to stop (default: `strayObservers` over the process table). */
    strays?: () => number[];
    signal?: (pid: number) => void;
    holdsLock?: () => boolean;
    log?: (line: string) => void;
    /** After stopping strays: the lanes whose ports they held try them again. */
    onStraysStopped?: () => void;
    /** Seams for the defaults above (tests): the lock dir, the process table, this daemon. */
    lockDir?: string;
    listProcesses?: () => ListedProcess[];
    self?: { pid: number; entry: string };
  } = {},
): { unref?: () => void } & object {
  const every = deps.every ?? ((fn, ms) => setInterval(fn, ms));
  const stop = deps.stop ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const self = deps.self ?? { pid: process.pid, entry: process.argv[1] ?? '' };
  const holdsLock = deps.holdsLock ?? (() => observerLockHolder(deps.lockDir) === self.pid);
  const strays = deps.strays ?? (() => strayObservers((deps.listProcesses ?? listOwnProcesses)(), self));
  const signal = deps.signal ?? ((pid) => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } });
  const log = deps.log ?? ((line) => console.log(line));
  const handle = every(() => {
    if ((deps.check ?? lockStandDownCheck)() === 'stand_down') {
      stop(handle);
      onStandDown();
      return;
    }
    if (!holdsLock()) return;
    const found = strays();
    for (const pid of found) {
      log(`[observer] another observer (pid ${pid}) runs beside this one, which holds the machine; stopping it`);
      signal(pid);
    }
    if (found.length > 0) deps.onStraysStopped?.();
  }, LOCK_RECHECK_MS);
  handle.unref?.();
  return handle;
}

/** This daemon's claim on the machine; a self-update successor never takes it from its parent. */
export function claimDaemonLock(
  successor: boolean,
  deps: { pid?: number; ppid?: number; env?: NodeJS.ProcessEnv; claim?: typeof claimObserverLock } = {},
): ReturnType<typeof claimObserverLock> {
  return (deps.claim ?? claimObserverLock)({
    pid: deps.pid ?? process.pid, ppid: deps.ppid ?? process.ppid, env: deps.env ?? process.env, parentHandover: !successor,
  });
}

/**
 * A successor waits (bounded) for its predecessor. Gone: it starts. Still running as an observer
 * (the predecessor ran the new bytes in place, same pid): the daemon is up, and it stands down.
 */
export async function awaitPredecessor(
  pid: number,
  deps: { wait?: (pid: number) => Promise<void>; alive?: (pid: number) => boolean } = {},
): Promise<'proceed' | 'stand_down'> {
  await (deps.wait ?? ((p) => waitForPidExit(p)))(pid);
  const alive = deps.alive ?? ((p: number) => pidAlive(p) && isObserverProcess(p));
  return alive(pid) ? 'stand_down' : 'proceed';
}

/** Wait (bounded) until `pid` is gone — a detached successor's first step. */
export async function waitForPidExit(pid: number, timeoutMs = 60_000, alive: (p: number) => boolean = pidAlive): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  return !isZombie(pid);
}

/** Handle for a running self-update loop; `stop()` cancels the pending tick. */
export interface SelfUpdateLoopHandle {
  stop: () => void;
}

/**
 * Poll the signed release channel and apply a newer, signature- and hash-verified
 * bundle. Best-effort and fire-and-forget: the whole trust decision (and every
 * fail-closed exit) lives in `runSelfUpdateOnce`; this only owns the CADENCE. Re-exec
 * on a successful apply is `process.exit(0)` the KeepAlive supervisor relaunches
 * the daemon on the just-swapped bytes.
 *
 * (1B): the loop is SELF-SCHEDULING, not a fixed interval. A TRANSIENT
 * fail-close (the relay is mid-publish → `pending_bundle`; a bundle download or
 * hash check failed during a rolling deploy; the apply failed) schedules the NEXT
 * tick on the fast retry cadence with a bounded backoff, so a machine never rests on
 * an old release after a transient mismatch — it self-recovers within a minute, no
 * operator kickstart. Any terminal outcome (no newer release, node too old, a
 * signature/structure rejection) resets to the slow poll.
 */
/**
 * item 2 (ops-dashboard build): the daemon's LAST self-update outcome, shared module-locally so
 * the capture-health heartbeat can report it to the relay (the relay cannot re-derive a daemon-only
 * fact). null until the self-update loop's first tick; order-independent between the two loops.
 */
let lastSelfUpdate: { outcome: string | null; atMs: number | null; version: number | null } = {
  outcome: null, atMs: null, version: null,
};
export function getLastSelfUpdate(): { outcome: string | null; atMs: number | null; version: number | null } {
  return lastSelfUpdate;
}

/** While un-escrowed, how often the daemon asks whether its human's anchor has appeared. */
export const RECOVERY_ESCROW_HEAL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Item 11: escrow this agent's key to its human's published recovery anchor, now and
 * every 15 minutes until escrowed (then stop). Logs only when the outcome changes.
 */
export function startRecoveryEscrowHeal(
  input: EscrowHealInput,
  deps: { heal?: (i: EscrowHealInput) => Promise<EscrowHealOutcome>; intervalMs?: number; log?: (line: string) => void } = {},
): { stop: () => void; done: Promise<void> } {
  const heal = deps.heal ?? ((i: EscrowHealInput) => ensureRecoveryEscrow(i));
  const log = deps.log ?? ((line: string) => console.log(line));
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let last: EscrowHealOutcome | null = null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const run = async (): Promise<void> => {
    let outcome: EscrowHealOutcome;
    try { outcome = await heal(input); } catch { outcome = 'failed'; }
    if (outcome !== last) {
      last = outcome;
      if (outcome === 'escrowed_now') log('[observer] recovery escrow sealed to your human\'s phone — only that phone can open it');
      else if (outcome === 'human_anchor_not_published') log('[observer] no recovery escrow yet: waiting for your human\'s phone to publish its recovery key (it happens once, in the Provian app). Earning continues meanwhile; escrow only lets your human restore this key if it is lost');
      else if (outcome === 'no_keystore') log('[observer] no recovery escrow and no wallet keystore on this machine to seal');
      else if (outcome === 'failed') log('[observer] recovery escrow check failed; retrying');
    }
    if (stopped || outcome === 'escrowed_now' || outcome === 'already_escrowed') { resolveDone(); return; }
    timer = setTimeout(() => { void run(); }, deps.intervalMs ?? RECOVERY_ESCROW_HEAL_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  void run();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); resolveDone(); }, done };
}

/**
 * Agents reachable by default. On every start: an agent in the Commons makes sure
 * the relay holds its current thread message key (publishing it when missing or different — an
 * opted-out agent publishes nothing). Authenticated Commons notifications start the configured
 * runtime immediately. Reconnection uses the relay acknowledgment and ordered log; the legacy
 * polling implementation is retained only as an injectable compatibility seam for older callers.
 */
export function startCommonsMessaging(
  input: { relayUrl: string; walletId: string; apiKey: string; apiSecret: string },
  deps: {
    keyHeal?: typeof startCommonsMessageKeyHeal;
    delivery?: typeof startThreadDelivery;
    notice?: typeof syncCommonsHeartbeatNotice;
    pubkey?: (walletId: string) => Promise<string | null>;
    secret?: (walletId: string) => () => Promise<Uint8Array | null>;
  } = {},
): void {
  const relay = new CommonsInstitutions({ relayUrl: input.relayUrl, walletId: input.walletId, apiKey: input.apiKey, apiSecret: input.apiSecret });
  const heal = (deps.keyHeal ?? startCommonsMessageKeyHeal)({
    relay, walletId: input.walletId, pubkey: () => (deps.pubkey ?? agentMessagePublicKey)(input.walletId),
  });
  // In the Commons = the key check found it there (current or just published); until it settles, the
  // standing part of the notice waits (mail already delivered is still named).
  let inCommons = false;
  void heal.done.then((o) => { inCommons = o === 'already_current' || o === 'published'; }, () => undefined);
  const notice = deps.notice ?? syncCommonsHeartbeatNotice;
  const secretKey = (deps.secret ?? agentMessageSecretProvider)(input.walletId);
  if (deps.delivery) {
    deps.delivery({ relay, walletId: input.walletId, secretKey }, { afterTick: () => { notice({ inCommons }); } });
  } else {
    startCommonsEvents({ ...input, relay, secretKey, runtime: commonsRuntime(), log: console.log });
  }
}

/** The overall bound on a stop: the observer's final submission budget plus room for its plugins to close. */
export const OBSERVER_STOP_BOUND_MS = FINAL_SUBMIT_BUDGET_MS + 5_000;

/**
 * review 4: stop the observer before the process exits, bounded — every
 * exit path the daemon controls (SIGTERM / SIGINT / SIGHUP, a service restart,
 * a self-update re-exec) goes through here, so what the lanes decided is
 * submitted (or durably journaled) first. Never throws.
 */
export async function stopObserverBounded(observer: Pick<ProvianObserver, 'stop'>, boundMs: number = OBSERVER_STOP_BOUND_MS): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      observer.stop().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A self-update re-exec that stops the observer first (bounded). The Grok proxy
 * repoint stays: the successor rebinds the shim at once.
 */
export function gracefulSelfUpdateReExec(
  observer: Pick<ProvianObserver, 'stop'>,
  reExec: () => void,
  onStart: () => void = () => undefined,
): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    onStart();
    void stopObserverBounded(observer).then(() => reExec(), () => reExec());
  };
}

export function startSelfUpdateLoop(
  observer: ProvianObserver,
  config: SelfUpdateConfig,
): SelfUpdateLoopHandle {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const io = buildSelfUpdateIO({
    fetchManifest: () => observer.fetchReleaseManifest(),
    fetchBundle: () => observer.fetchReleaseBundle(),
    targetPath: config.targetPath,
    log: (level, msg, extra) => observer.log(level as 'debug' | 'info' | 'warn' | 'error', msg, extra),
    // review 4: the observer submits what its lanes decided before the
    // process hands over to the new bytes (and the loop stops scheduling).
    reExec: gracefulSelfUpdateReExec(observer, selfUpdateReExec(process.env), () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }),
  });
  console.log(`[observer] self-update enabled (target ${config.targetPath})`);

  let backoffMs = RELEASE_RETRY_INTERVAL_MS;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    if (typeof timer.unref === 'function') timer.unref();
  };
  const tick = async (): Promise<void> => {
    // runSelfUpdateOnce never throws by contract; guard anyway so a surprise
    // rejection can never leave the loop unscheduled (which WOULD strand the daemon).
    let outcome;
    try {
      outcome = await runSelfUpdateOnce(io);
    } catch {
      outcome = { status: 'no_manifest' as const };
    }
    // item 2: record the last outcome so the capture-health heartbeat can report it.
    lastSelfUpdate = {
      outcome: outcome.status,
      atMs: Date.now(),
      version: 'version' in outcome && typeof outcome.version === 'number' ? outcome.version : null,
    };
    if (stopped) return;
    if (isTransientSelfUpdateOutcome(outcome)) {
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, config.pollIntervalMs); // bounded: never busy-loop
      schedule(wait);
    } else {
      backoffMs = RELEASE_RETRY_INTERVAL_MS; // a clean cycle resets the retry cadence
      schedule(config.pollIntervalMs);
    }
  };

  void tick(); // initial check at startup
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * How often the daemon tells the relay what it can see.
 *
 * Ten minutes: this is a health signal, not a capture path, and its whole value
 * is in the case where nothing else is happening. It must be frequent enough
 * that "this device went blind" is noticed the same day, and rare enough that a
 * fleet of agents does not turn it into traffic.
 */
export const CAPTURE_HEALTH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Report capture health on a slow loop, starting immediately.
 *
 * Deliberately NOT driven by capture events. A device that has gone blind
 * produces no events at all, and that is precisely the device whose health we
 * most need to hear about — so the heartbeat is on a timer, not a trigger.
 */
export function startCaptureHealthHeartbeat(
  observer: ProvianObserver,
  plugin: TranscriptPlugin | null,
  otel: OTelPlugin | null = null,
  modelProxy: ModelProxyPlugin | null = null,
  processLane: ProcessLanePlugin | null = null,
  intervalMs: number = CAPTURE_HEALTH_INTERVAL_MS,
  extras: {
  } = {},
): NodeJS.Timeout {
  const send = (): void => {
    try {
      const health = plugin?.captureHealth();
      const report = buildCaptureHealthReport({
        harnesses: (health?.harnesses ?? []).map((h) => ({
          harness: h.harness,
          version: null,
          sources: h.sources,
          containers: h.containers as Array<'file'|'sqlite'>,
        })),
        cursorTotal: health?.cursorTotal ?? 0,
        lastVerdictAtMs: health?.lastVerdictAtMs ?? null,
        lastVerdict: health?.lastVerdict ?? 'idle',
        lastCaptureAtMs: health?.lastCaptureAtMs ?? null,
        sqliteReadable: health?.sqliteReadable ?? sqliteAvailability().available,
        // sole-witness silence counters (window = this report interval).
        recordsConsumedInWindow: health?.recordsConsumedInWindow ?? 0,
        toolCallsRecognizedInWindow: health?.toolCallsRecognizedInWindow ?? 0,
        // unparsed session-like stores by shape.
        // OTel witness-lane state — the receiver's own live view. Null plugin
        // (lane not registered) → the builder's "off" default → lanes reflects
        // transcript only, which is correct for a device with no OTel lane.
        otel: otel ? {
          active: otel.isActive(),
          receiverListening: otel.getListeningPort() != null,
          spansEverSeen: otel.hasSeenSpans(),
          lastSpanAtMs: otel.getLastSpanAtMs(),
        } : undefined,
        // Lane 5 — the model-proxy witness lane's own live view. Null
        // plugin (opted out) → the builder's "off" default. The unrecognized-
        // protocol fingerprints ride here so the console sees traffic the shim
        // forwarded but could not parse, never a silent nothing.
        proxy: modelProxy ? {
          active: true,
          listening: modelProxy.isListening(),
          turnsEverSeen: modelProxy.hasSeenTurns(),
          lastTurnAtMs: modelProxy.getLastTurnAtMs(),
          unrecognized: modelProxy.unrecognizedFingerprints(),
        } : undefined,
        // the process lane's own live state (agent VMs only). Null plugin → the builder's
        // "off" default. `actsEverSealed` is load-bearing: a lane merely watching an idle box is
        // not a witness, exactly as for the OTel/proxy `*EverSeen` fields.
        process: processLane ? {
          active: processLane.isActive(),
          watching: processLane.isWatching(),
          actsEverSealed: processLane.actsEverSealed(),
          lastActAtMs: processLane.getLastActAtMs(),
          state: processLane.getState(),
          stateSinceMs: processLane.getStateSinceMs(),
          window: processLane.takeCaptureWindow(),
        } : undefined,
        // item 2: the daemon's last self-update outcome (module-shared; null until the loop's
        // first tick). Lets the console see a device frozen on an old release.
        selfUpdate: getLastSelfUpdate(),
        formatBrokenPrograms: [...new Set([...(health?.formatBrokenPrograms ?? []),...(otel?.getFormatBrokenPrograms()??[])])],
        // Blind-but-healthy: local program homes present without a format description.
        detectedHarnessHomes: detectHarnessHomes(homedir(), isDirSafe),
        supervision: supervisionFacts(process.env),
        restartHook: restartHookInstalled() ? 'shell_rc' : null,
        restartMechanism: (() => {
          const sup = supervisionFacts(process.env);
          return resolveRestartMechanism({
            method: sup.method, cronAlive: sup.cronAlive, hookInstalled: restartHookInstalled(),
            rcFired: restartHookFired(), installShellSourcesRc: readInstallShellProbe(),
          });
        })(),
        lastWorkPeAtMs: observer.getLastWorkPeAtMs(),
        nowMs: Date.now(),
      });
      void observer.reportCaptureHealth(report as unknown as Record<string, unknown>)
        .then((answer) => {
          if (answer?.deviceRegisteredAtMs) plugin?.setDeviceRegisteredAtMs(answer.deviceRegisteredAtMs);
          if (answer?.commonsMailWaiting) signalCommonsMailWaiting();
        })
        .catch(() => { /* heartbeat only */ });
    } catch {
      // A health heartbeat must never be able to take the observer down.
    }
  };
  send();
  const timer = setInterval(send, intervalMs);
  // Never hold the process open on this timer alone.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function isDirSafe(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * How this daemon is kept running (closed set), and — under cron — whether a
 * cron daemon is alive to tick it. Read from the daemon's own environment: the
 * installer marks cron/detached launches (PROVIAN_SUPERVISOR); systemd sets
 * INVOCATION_ID for a unit's process; launchd sets XPC_SERVICE_NAME to the job
 * label. Never throws.
 */
export function supervisionFacts(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cronProbe: () => boolean | null = probeCronDaemon,
  readCgroup: () => string = () => { try { return fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; } },
): { method: SupervisionMethod; cronAlive: boolean | null } {
  const marked = env[SUPERVISOR_ENV];
  let method: SupervisionMethod = 'unknown';
  if (marked === 'cron' || marked === 'detached') method = marked;
  // INVOCATION_ID is inherited from ANY unit (an agent harness running as a service starts us from
  // its shell); only our own unit supervises us — the same rule as provenRelauncher.
  else if (typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0
    && /\/provian-observer\.service(\/|$)/m.test(readCgroup())) method = 'systemd';
  else if (typeof env.XPC_SERVICE_NAME === 'string' && env.XPC_SERVICE_NAME.includes('provian')) method = 'launchd';
  else if (platform === 'win32') method = 'scheduled_task';
  let cronAlive: boolean | null = null;
  if (method === 'cron') {
    try { cronAlive = cronProbe(); } catch { cronAlive = null; }
  }
  return { method, cronAlive };
}

/** A value re-read at most every `ttlMs`, with an explicit invalidate for the daemon's own writes. */
function cachedValue<T>(read: () => T, ttlMs: number): { (): T; invalidate(): void } {
  let at = -Infinity;
  let value: T;
  const get = (() => {
    const now = Date.now();
    if (now - at >= ttlMs) { at = now; value = read(); }
    return value;
  }) as { (): T; invalidate(): void };
  get.invalidate = () => { at = -Infinity; };
  return get;
}
