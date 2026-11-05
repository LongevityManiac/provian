/**
 * bootstrap — the Node entrypoint the hosted `curl … | sh` bundle runs.
 *
 * Reads the connection code + relay from the environment (the sh wrapper passes
 * them by env, never argv, so the code never hits the process list) and runs the
 * unattended onboarding. Prints only plain sentences — never a raw error, stack,
 * or relay code (onboarding no-raw-errors rule).
 */

import { runAgentBootstrap, defaultBootstrapDeps, renderBootstrapOutcome } from '../bootstrap-flow';
import { markCliDispatched } from './cli-entry';
import { applyRuntimeEnvAtEntry, persistRuntimeEnv, RUNTIME_ENV_REEXEC_GUARD } from '../runtime-env';
import { takeShimMarker } from '../provian-shim';
import { standingEgressAllowLines } from '../bootstrap-flow';
import { describeSetupFailure, proxyForRelay, proxyVarForRelay } from '../setup-failure';

function relayHostForMessages(relay: string): string {
  try { return new URL(relay).host || 'api.provian.ai'; } catch { return 'api.provian.ai'; }
}

/**
 * Print why setup stopped: the actual reason, and connection advice only when the network
 * path itself failed (— never a connection message when the connection worked).
 */
function reportSetupFailure(error: unknown, relay: string): void {
  const host = relayHostForMessages(relay);
  const failure = describeSetupFailure(error, { relayHost: host, proxy: proxyForRelay(), proxyVar: proxyVarForRelay(), retry: 'paste the command again' });
  console.error('');
  for (const line of failure.lines) console.error(line);
  if (failure.connection) for (const line of standingEgressAllowLines(host, '  ')) console.error(line);
}
import { restoreWalletFromStdin, restoreWalletInteractive } from '../restore-wallet-flow';

/**
 * The verb a bundle invocation selects, or null for the default onboarding flow.
 *
 * PURE and exported so its one dangerous property has a test: a verb is chosen
 * ONLY from the argument position (`node <bundle> <verb> …`), never from a later
 * argument's VALUE. The post-commit hook passes `--branch "$BRANCH"` and
 * `--description "$SUBJECT"`, so an `includes()` scan would let a branch named
 * `repair` run the repair verb — rewriting the service and git hook — from
 * inside an ordinary commit. Only the token at index 2 is a verb.
 */
export const BOOTSTRAP_VERBS = [
  'observe', 'witness', 'backfill-transcript', 'repair', 'report-pe', 'restore-wallet', 'rotate-key', 'export-agent-keystore', 'fleet-code', 'register-device',
  // the maintenance commands the hosted install's own output names (doctor, the transcript
  // watcher's `configure`, the Commons catch-up join, git identity, uninstall) — installed commands on
  // the curl|sh install, never an npx line.
  'doctor', 'configure', 'join-commons', 'register-git-identity', 'git-identity', 'github-pr-request', 'uninstall',
  // The catch-up for the default-on Solana address proof the onboarding runs.
  'prove-solana-address',
  // re-record which program launches the agent's commands (after a harness change).
  'process-lane',
] as const;
export type BootstrapVerb = typeof BOOTSTRAP_VERBS[number];

export function resolveBootstrapVerb(argv: readonly string[]): BootstrapVerb | null {
  const candidate = argv[2];
  return (BOOTSTRAP_VERBS as readonly string[]).includes(candidate)
    ? (candidate as BootstrapVerb)
    : null;
}

async function main(): Promise<void> {
  // (C): run every verb — install, `observe` under systemd/launchd/cron,
  // `report-pe` from the git hook — with the egress environment the installer
  // recorded (forward proxy, loopback NO_PROXY, extra CA). Re-execs once when a
  // start-time-only variable (NODE_USE_ENV_PROXY, NODE_EXTRA_CA_CERTS, the
  // proxy vars) differs from what this process started with; otherwise returns.
  //
  // The INSTALL path (no verb) is the one place that WRITES runtime.env, and it
  // writes it from the LIVE shell BEFORE applying the file:
  // the pasted line is authoritative, so a box that dropped its proxy
  // re-installs clean instead of having
  // the stale value copied back and re-exec'd through a dead proxy. A re-exec'd
  // child never re-persists (its env already carries the merged values).
  // Only a REAL install (no verb AND a connection code) rewrites the file —
  // `node agent.js --help`, `doctor`, or any unknown argument from a shell
  // without the proxy must never erase it.
  if (resolveBootstrapVerb(process.argv) === null
    && ((process.env.PROVIAN_CONNECTION_TOKEN ?? '').trim().length > 0
      || (process.env.PROVIAN_AGENT_DEVICE_TOKEN ?? '').trim().length > 0)
    && process.argv.length <= 2
    && process.env[RUNTIME_ENV_REEXEC_GUARD] !== '1') {
    try { persistRuntimeEnv(process.env); } catch { /* the install itself already has the env */ }
  }
  applyRuntimeEnvAtEntry();
  // review r2 #1: the wrapper's marker is taken off the environment here, before any
  // verb runs, so no daemon this process spawns (configure / repair restart it) inherits it.
  const viaShim = takeShimMarker();
  // This process is the dispatcher. Mark it BEFORE importing any verb module so a
  // dispatched submodule's own `isDirectCliEntry` guard does not ALSO self-exec
  // (Node 26 evaluates require.main === module true for a bundled submodule; see
  // cli-entry.ts). Without this, report-pe/backfill run twice from the bundle.
  markCliDispatched();
  // `node <bundle> observe` — run the observer daemon FROM the bundle. Pre-publish
  // the bundle is the only SDK artifact on the machine, so the installed service
  // (launchd/systemd/schtasks) execs `node ~/.provian/agent.js observe` here
  // instead of `npx @provian/agent-sdk observe`, which is unpublished (E404) and
  // exited 78 with a dead observer.
  // Dispatch on the VERB POSITION (argv[2] = `node <bundle> <verb> …`), never on
  // `argv.includes(<verb>)`. A hook argument VALUE can equal a verb — the
  // post-commit hook passes `--branch "$BRANCH"`, so a branch literally named
  // `repair` or `observe` would, under an includes() scan, select that verb
  // instead of `report-pe` and (for `repair`) rewrite the service and git hook
  // from inside a commit. The verb is only ever the first token.
  const verb = resolveBootstrapVerb(process.argv);
  // The correction: any `provian` command run through the wrapper fills or heals the launcher record.
  try {
    const { recordLauncherForProvianCommand } = await import('../observer/plugins/process-lane/launcher.js');
    recordLauncherForProvianCommand(viaShim, verb);
  } catch { /* best-effort */ }

  // the act verbs (`help`, `post`, `transfer`, `swap`, …): every act a hosted
  // agent does through Provian, run from its shell, signed with its own key on this machine. Same
  // position rule as above: only argv[2] selects a verb. Each run also (re)writes the
  // `~/.provian/bin/provian` wrapper, so a self-updated install gets it without a re-install.
  if (verb === null) {
    const acts = await import('../act-verbs.js');
    const actVerb = acts.resolveActVerb(process.argv);
    if (actVerb !== null || acts.isHelpVerb(process.argv)) {
      const { ensureProvianShim } = await import('../provian-shim.js');
      ensureProvianShim(process.argv[1]);
      if (actVerb === null) {
        for (const line of acts.renderActHelp()) console.log(line);
        for (const line of renderMaintenanceHelp()) console.log(line);
        process.exit(0);
      }
      // second restart trigger: every act verb first makes sure the observer daemon is up (a
      // cheap pure-sh check; it starts one detached only when none is running). On a box whose agent
      // shell reads no startup file (plain `bash -c`), this is what brings the daemon back.
      const { runEnsureScript } = await import('../observer/restart-hook.js');
      runEnsureScript();
      // an act verb is a command the agent ran through its harness; fill a missing launcher record.
      try {
        const { recordLauncher } = await import('../observer/plugins/process-lane/launcher.js');
        recordLauncher({ source: 'act_verb', force: false });
      } catch { /* best-effort */ }
      process.exit(await acts.runActVerbCli(actVerb, process.argv.slice(3)));
    }
    // anything else on the command line is an unknown command — never read as an invite code.
    // (The curl|sh install runs this file with NO arguments; that is the only onboarding entry.)
    if (process.argv.length > 2) {
      console.error(`  Unknown command: ${process.argv[2]}. Run \`"$HOME/.provian/bin/provian" help\` for the commands.`);
      process.exit(2);
    }
  }

  // the maintenance verbs, run as installed commands (`"$HOME/.provian/bin/provian" <verb>`).
  if (verb === 'doctor') {
    const { runDoctorCli } = await import('./doctor.js');
    await runDoctorCli(process.argv.slice(3));
    return;
  }
  if (verb === 'process-lane') {
    const { runProcessLaneCli } = await import('./process-lane.js');
    process.exit(runProcessLaneCli(process.argv.slice(3)));
  }
  if (verb === 'configure') {
    const { runConfigureCli } = await import('./configure.js');
    await runConfigureCli(process.argv.slice(3));
    return;
  }
  if (verb === 'join-commons') {
    const { runJoinCommonsCli } = await import('./join-commons.js');
    await runJoinCommonsCli(process.argv.slice(3));
    return;
  }
  if (verb === 'prove-solana-address') {
    const { runProveSolanaAddressCli } = await import('./prove-solana-address.js');
    process.exit(await runProveSolanaAddressCli(process.argv.slice(3)));
  }
  if (verb === 'github-pr-request') {
    const { runGitHubPrRequest } = await import('./github-pr-request.js');
    try { await runGitHubPrRequest(process.argv.slice(3)); process.exit(0); }
    catch (error) { console.error(error instanceof Error ? error.message : 'PR request failed'); process.exit(2); }
  }
  if (verb === 'git-identity') {
    const { runRegisterGitIdentity, parseArgs, defaultDeps } = await import('./register-git-identity.js');
    if (process.argv[3] !== 'github-link') {
      console.error('Usage: provian git-identity github-link [--state <state>]');
      process.exit(2);
    }
    process.exit(await runRegisterGitIdentity(parseArgs(['--github-link', '--json', ...process.argv.slice(4)]), defaultDeps()));
  }
  if (verb === 'register-git-identity') {
    const { runRegisterGitIdentity, parseArgs, defaultDeps } = await import('./register-git-identity.js');
    process.exit(await runRegisterGitIdentity(parseArgs(process.argv.slice(3)), defaultDeps()));
  }
  if (verb === 'uninstall') {
    const { runUninstallCli } = await import('./uninstall.js');
    await runUninstallCli(process.argv.slice(3));
    return;
  }

  if (verb === 'observe' && viaShim) {
    const { ensureInstallerNodeAvailable } = await import('../observer/node-runtime-heal.js');
    await ensureInstallerNodeAvailable();
    // (/29): the agent typed `provian observe --if-not-running` on a box
    // where nothing else restarts the observer, the agent does, as setup. Start it DETACHED and
    // return; never run the daemon in the agent's shell. A box installed before the restart script
    // existed gets the script written now — a missing script is the reason to start, never to refuse.
    const { isObserverRunning, startDetachedObserver, LAUNCHD_LABEL } = await import('../observer/service.js');
    const { installedServiceKind, startInstalledService } = await import('../observer/ensure-running.js');
    const { agentObserve, buildAgentObserveDeps } = await import('../observer/agent-observe.js');
    const outcome = await agentObserve(buildAgentObserveDeps({
      entryScript: process.argv[1],
      node: (await import('../observer/node-runtime-heal.js')).resolveStoreCapableNodeBin(),
      platform: process.platform,
      // Never count THIS process as the running observer (its cmdline says `observe` too).
      running: () => { const p = isObserverRunning(); return p === process.pid ? null : p; },
      serviceInstalled: () => installedServiceKind({ launchdLabel: LAUNCHD_LABEL }) !== null,
      startInstalledService: () => startInstalledService({ launchdLabel: LAUNCHD_LABEL }) !== null,
      startDetached: (entry) => startDetachedObserver(entry),
    }));
    process.exit(outcome === 'failed' ? 1 : 0);
  }

  if (verb === 'observe') {
    const { runObserverDaemon } = await import('../observer/run-daemon.js');
    await runObserverDaemon(process.argv.slice(3));
    return;
  }

  // `node <bundle> backfill-transcript …` — recover turns a capture DEFECT lost.
  // Dry run by default; `--submit` must be typed. Money-safety rules (no
  // straddle, no pre-window work, duplicate turn ids are a hard stop) live in
  // the planner, not here.
  if (verb === 'witness') {
    const { runWitnessCli } = await import('./witness.js');
    await runWitnessCli(process.argv.slice(process.argv.indexOf(verb) + 1)); return;
  }
  if (verb === 'backfill-transcript') {
    const { runBackfillCli } = await import('./backfill-transcript.js');
    await runBackfillCli();
    return;
  }

  // `node <bundle> repair` — the restore runbook's verb. Re-points the launchd
  // plist / systemd unit and the global git hook at THIS bundle and verifies
  // they resolve. Identity is untouched: no wallet, no credentials, no PE.
  if (verb === 'repair') {
    const { repairInstall, renderRepairOutcome } = await import('../repair-install.js');
    const { installService } = await import('../observer/service.js');
    const { installGlobal } = await import('../hook-install.js');
    const { OTLP_DEFAULT_PORT } = await import('../observer/plugins/OTelPlugin.js');
    const outcome = await repairInstall({
      installService,
      installGlobalHook: installGlobal,
      otlpPort: OTLP_DEFAULT_PORT,
    });
    const view = renderRepairOutcome(outcome);
    for (const l of view.lines) console.log(l);
    const { ensureProvianShim, provianShimPath } = await import('../provian-shim.js');
    const shim = ensureProvianShim(process.argv[1]);
    if (shim !== 'skipped') console.log(`  provian command: ${shim} (${provianShimPath()})`);
    process.exit(view.exitCode);
  }

  // `node <bundle> report-pe …` — the git post-commit hook's entry when the
  // bundle is the machine's runtime artifact. Without this the hook has nothing
  // durable to point at and falls back to a source path that dies with the
  // checkout (the Atlas defect); with it, hook and observer bake the SAME file.
  if (verb === 'report-pe') {
    const { runReportPeCli } = await import('./report-pe.js');
    await runReportPeCli();
    return;
  }

  // Pre-publish, the hosted bundle is the ONLY runnable SDK artifact, so it
  // also carries the recovery leg: the app's RecoverAgent command downloads
  // this bundle and invokes `node <bundle> restore-wallet`.
  //
  // PREFERRED : no `--from-stdin` → prompt for the key with echo OFF
  // (interactive), so the key never rides the pasted command (not in the clipboard-
  // as-command, not in the shell history). `--from-stdin` is retained for automation
  // (key piped in from a script).
  if (verb === 'restore-wallet') {
    try {
      if (process.argv.includes('--from-stdin')) {
        await restoreWalletFromStdin(process.env.PROVIAN_WALLET_ID ?? '');
      } else {
        await restoreWalletInteractive(process.env.PROVIAN_WALLET_ID ?? '');
      }
      process.exit(0);
    } catch (err) {
      console.error(`  ${err instanceof Error ? err.message : 'Wallet restore could not finish.'}`);
      process.exit(1);
    }
  }

  // `node <bundle> rotate-key` — the VOLUNTARY key-rotation verb. Rotates this
  // agent's signing key AND sweeps its earned PVT into the new address, then
  // re-provisions the machine with the new key + rotated credentials. Preserves
  // the retired key and resumes the sweep on a later run when the old address has
  // no gas — so a stranded balance is recoverable, never silently lost.
  if (verb === 'rotate-key') {
    const { runRotateKeyFlow } = await import('../rotate-key-flow.js');
    try {
      await runRotateKeyFlow({
        relayUrl: process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai',
        walletId: process.env.PROVIAN_WALLET_ID?.trim() || undefined,
        newRotation: process.argv.includes('--new-rotation'),
      });
      process.exit(0);
    } catch (err) {
      console.error(`  ${err instanceof Error ? err.message : 'Key rotation could not finish.'}`);
      process.exit(1);
    }
  }

  if (verb === 'export-agent-keystore') {
    const { runExportKeystoreCli } = await import('./export-agent-keystore.js');
    runExportKeystoreCli(process.argv.slice(3));
    return;
  }

  // `node <bundle> fleet-code` any linked agent issues a
  // one-hour, single-use link code for another of its human's agents (which runs
  // the printed install line on its own machine). Same implementation as the
  // `fleet-code` bin and CommonsInstitutions.issueFleetCode.
  if (verb === 'fleet-code') {
    const { runFleetCodeCli } = await import('./fleet-code.js');
    await runFleetCodeCli(process.argv.slice(3));
    return;
  }

  // `node <bundle> register-device --from-credentials <file>` an agent
  // whose wallet was created over MCP registers this machine as its
  // device from the credential file it names (0600, exact wallet-bound shape),
  // then starts `observe` itself if it chooses. Installs nothing else.
  if (verb === 'register-device') {
    const { runRegisterFromCredentialsCli } = await import('./register-from-credentials.js');
    await runRegisterFromCredentialsCli(process.argv.slice(3));
    return;
  }

  const token = process.env.PROVIAN_CONNECTION_TOKEN ?? '';
  const relay = process.env.PROVIAN_RELAY_URL ?? 'https://api.provian.ai';

  // "A device for your agent" the emailed agent-device line runs this bundle with a
  // single-use agent_device_registration token instead of a connection code. Same device leg as
  // the Connect install (register → credentials → observer service, profile blocks, git hook),
  // attributed to the agent's EXISTING wallet; no second wallet, and the agent's key never moves.
  const agentDeviceToken = (process.env.PROVIAN_AGENT_DEVICE_TOKEN ?? '').trim();
  if (!token && agentDeviceToken) {
    const {
      isAgentDeviceToken, runAgentDeviceInstall, renderAgentDeviceOutcome, resolveAgentDeviceName,
    } = await import('../agent-device-install.js');
    if (!isAgentDeviceToken(agentDeviceToken)) {
      console.error('  That device setup code is not valid. Ask for a fresh one in the Provian app under "A device for your agent" and paste the new line.');
      process.exit(1);
    }
    try {
      const { registerAgentOwnedDevice } = await import('../bootstrap-flow.js');
      const deps = defaultBootstrapDeps();
      const result = await runAgentDeviceInstall(
        { relayUrl: relay, token: agentDeviceToken, deviceName: resolveAgentDeviceName(process.env) },
        {
          registerDevice: (input) => registerAgentOwnedDevice(input),
          startObserver: () => deps.startObserver(),
        },
      );
      const { ensureProvianShim } = await import('../provian-shim.js');
      ensureProvianShim(process.argv[1]);
      const view = renderAgentDeviceOutcome(result);
      for (const line of view.stdout) console.log(line);
      for (const line of view.stderr) console.error(line);
      process.exit(view.exitCode);
    } catch (error) {
      reportSetupFailure(error, relay);
      process.exit(1);
    }
  }
  // Commons join is DEFAULT-ON; the agent may self-sovereignly opt out of public
  // presence with PROVIAN_COMMONS_OPT_OUT (1/true/yes). Nothing else is gated on it.
  const commonsOptOut = /^(1|true|yes)$/i.test(process.env.PROVIAN_COMMONS_OPT_OUT ?? '');
  // The Solana address proof is DEFAULT-ON too (it pays nothing; it lets the agent's Solana
  // x402 payments and receipts be witnessed). PROVIAN_SOLANA_PROOF_OPT_OUT declines it.
  const solanaProofOptOut = /^(1|true|yes)$/i.test(process.env.PROVIAN_SOLANA_PROOF_OPT_OUT ?? '');

  if (!token) {
    console.error('  Something went wrong reading your invite code. Generate a fresh code in the Provian app under "Connect an agent" and paste the command again.');
    process.exit(1);
  }

  try {
    const result = await runAgentBootstrap({
      connectionToken: token, relayUrl: relay, commonsOptOut, solanaProofOptOut,
      // This entry IS the hosted `curl … | sh` bundle: the printed commands run it.
      hostedInstall: true,
    }, defaultBootstrapDeps());

    // (defect 5): the output names `"$HOME/.provian/bin/provian"`, so the
    // wrapper exists before it is printed (not only once the daemon's first start writes it).
    const { ensureProvianShim } = await import('../provian-shim.js');
    ensureProvianShim(process.argv[1]);
    // The outcome decision (esp. "link did not file → failure, exit 1") lives in
    // renderBootstrapOutcome so it is unit-tested without process.exit.
    const view = renderBootstrapOutcome(result);
    for (const line of view.stdout) console.log(line);
    for (const line of view.stderr) console.error(line);
    process.exit(view.exitCode);
  } catch (error) {
    reportSetupFailure(error, relay);
    process.exit(1);
  }
}

/**
 * The maintenance commands printed under the act-verb help. Every name here is a
 * BOOTSTRAP_VERBS entry (bootstrap-verb.test.ts pins that), so help never names a command the
 * dispatcher does not run.
 */
export const MAINTENANCE_HELP: ReadonlyArray<{ verb: BootstrapVerb; usage: string; summary: string }> = [
  { verb: 'doctor', usage: 'doctor [--json]', summary: 'Check capture end-to-end: credentials, the observer, the receiver, real tool activity' },
  { verb: 'process-lane', usage: 'process-lane record | status', summary: 'Record which program launches your commands (run it from your own harness when capture health says no launcher is recorded, or after it changes); status shows the process lane\'s state' },
  { verb: 'repair', usage: 'repair', summary: 'Re-point the observer service (or background daemon + restart hook) and the git hook at this install' },
  { verb: 'configure', usage: 'configure --llm-log <path>', summary: 'Configure a human local-inference log' },
  { verb: 'join-commons', usage: 'join-commons [--display-name "…"]', summary: 'Join the Commons (idempotent)' },
  { verb: 'prove-solana-address', usage: 'prove-solana-address', summary: 'Prove your Solana address so its x402 payments are witnessed (free, idempotent)' },
  { verb: 'github-pr-request', usage: 'github-pr-request --request-json @request.json', summary: 'Retired: author the PR with the agent’s own GitHub account and use its own wallet' },
  { verb: 'git-identity', usage: 'git-identity github-link [--state <state>]', summary: 'Prove the GitHub account linked to this wallet for the PR gate' },
  { verb: 'register-git-identity', usage: 'register-git-identity [--email <address>]', summary: 'Bind your git author identity so connected-repo pushes credit you' },
  { verb: 'fleet-code', usage: 'fleet-code', summary: 'Issue a link code so another of your human\'s agents links with no tap' },
  { verb: 'uninstall', usage: 'uninstall --yes', summary: 'Stop the observer and remove the service, restart hook, git hook and ~/.provian' },
];

export function renderMaintenanceHelp(): string[] {
  return ['', 'Maintenance:', ...MAINTENANCE_HELP.map((m) => `  ${m.usage.padEnd(44)} ${m.summary}`)];
}

// Guarded so the pure helpers (resolveBootstrapVerb) can be imported by tests
// without running onboarding — mirrors report-pe.ts / register-device.ts.
if (require.main === module) {
  void main();
}
