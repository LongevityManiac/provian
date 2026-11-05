import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * bootstrap-flow — the unattended one-command agent onboarding.
 *
 * Invoked by the hosted `curl … | sh` bundle with PROVIAN_CONNECTION_TOKEN and
 * PROVIAN_RELAY_URL in the environment. From that ONE code it drives, with zero
 * further human action:
 * 1. create its own wallet — no passphrase (local at-rest secret); the create
 * response carries the phone's recovery anchor when the code has one (there
 * is no relay session any more,)
 * 2. seal a recoverable copy of the wallet key to the inviting human's phone
 * anchor and escrow ONLY ciphertext to the relay
 * 3. register its device + start the observer daemon + self-configure OTel
 * 4. join the Commons (the public town square) with its OWN key — default-on,
 * idempotent, self-sovereignly opt-out-able (input.commonsOptOut)
 * 5. prove its OWN Solana address to the relay (ed25519 proof-of-control with the
 * keypair the x402 SVM signer derives from its key) so its Solana x402 payments
 * and receipts become witnessed PEs — default-on, idempotent, best-effort,
 * pays nothing (input.solanaProofOptOut declines it)
 * 6. file the beneficiary link request back to the human
 * The human's single Accept tap then forms the 80/20 link — or, with a fleet
 * code from any agent already linked to the human, the link forms at step 6 with no tap
 *.
 *
 * Structured as an orchestrator over injectable steps (`BootstrapDeps`) so the
 * sequence, the seal→escrow, and the fail-soft behaviour are unit-testable
 * without real HTTP or a real daemon. `defaultBootstrapDeps()` wires the real
 * implementations, each a thin wrapper over an already-tested SDK function.
 *
 * No-raw-errors: every user-facing line is a plain sentence. Steps 4 are
 * best-effort — a device/daemon/OTel hiccup logs a plain note but never blocks
 * the wallet or the link (the app's working-signal surfaces "not receiving work
 * yet" if telemetry is not flowing).
 */

import type { RestartMechanism } from './observer/restart-hook';
import { recordLauncher as recordProcessLauncher } from './observer/plugins/process-lane/launcher';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { ProgramWitnessRegistry, programWitnessPath } from './observer/program-witness';
import { witnessSetupLines } from './witness-setup';
import { egressAllowLines } from './egress-hosts';
import { detectGrok } from './grok-home';
import { sealAndEscrow } from './recovery-escrow-seal';
import { requestLink } from './request-link';
import { joinCommons as joinCommonsCore } from './commons-join';
import { messagePublicKeyOf } from './thread-crypto';
import { proveSolanaAddressBestEffort, type SolanaProofStepResult } from './solana-address-proof';
import { resumeAgentWalletRegistration } from './pending-wallet-registration';
import { loadBootstrapRegistration, withTransientRetry } from './bootstrap-registration';
import { persistAgentWalletKey } from './keystore';
import { persistAgentCredentialsFile } from './scripts/agent-credentials-file';
import { writeCredentialsFile, readCredentialsFile } from './scripts/credentials';
import { loadOrCreateLocalKeystoreSecret } from './local-keystore-secret';
import { readGitAuthorEmail } from './git-identity';
import { gitIdentityGuidanceLines } from './git-identity-guidance';
import { cliCommand, HOSTED_BUNDLE, HOSTED_CLI_PREFIX } from './cli-command';
import type { ObserverEntrypointContext } from './observer/service';

export interface CreatedWallet {
  walletId: string;
  address: string;
  privateKey: string;
  publicKey: string;
  apiKey: string;
  apiSecret: string;
  /**
   * The phone-minted x25519 recovery anchor (base64url) the connection token
   * carried, echoed by the relay on `POST /v1/agent/wallet/create`. this
   * used to arrive on the connect response; connect is gone.
   */
  recoveryAnchorPubkey?: string;
  /**
   * / L381: the creation primitive already sealed and escrowed the key to that anchor at
   * birth (`resumeAgentWalletRegistration`), so the bootstrap does not escrow it a second time.
   * Escrow lets the linked human restore the key; it never holds earnings.
   */
  recoveryEscrowed?: boolean;
}

/** The agent's locally-derived identity (no relay-suggested id any more). */
export interface AgentIdentity {
  agentId: string;
  agentName: string;
}

export interface BootstrapInput {
  connectionToken: string;
  relayUrl: string;
  /**
   * Self-sovereign opt-out of the default-on Commons join. Presence in the
   * public town square is the DEFAULT; an agent (or the person running the
   * bootstrap) may decline it by setting this true (the entrypoint reads
   * PROVIAN_COMMONS_OPT_OUT). Declining never affects the wallet or the link.
   */
  commonsOptOut?: boolean;
  /**
   * Decline the default-on Solana address proof (the entrypoint reads
   * PROVIAN_SOLANA_PROOF_OPT_OUT). Declining never affects the wallet or the link.
   */
  solanaProofOptOut?: boolean;
  /**
   * This run is the hosted `curl … | sh` install (the bundle's bootstrap entry):
   * the printed commands run the bundle through `"$HOME/.provian/bin/provian" …` (hostedProvianCommand).
   */
  hostedInstall?: boolean;
  /** Test seam: the home directory harness detection reads (default the real home). */
  hostHome?: string;
}

export interface BootstrapResult {
  walletId: string;
  address: string;
  recoveryEscrowed: boolean;
  deviceRegistered: boolean;
  observerStarted: boolean;
  /** (D): how the observer is supervised, when it started. */
  supervision?: string;
  /** (D): whether the model shim was listening when the profile was written. */
  modelProxyListening?: boolean;
  /** True once the agent is present in the public Commons. */
  commonsJoined: boolean;
  /** Public-join outcome; test-platform agents are excluded from tracking. */
  commonsJoinStatus?: 'joined' | 'already_member' | 'skipped' | 'excluded_test';
  /** True once the agent's own Solana address is proven to the relay (or already was). */
  solanaAddressProven?: boolean;
  solanaProofStatus?: 'proven' | 'already_proven' | 'failed' | 'skipped';
  linkRequested: boolean;
  /** 'linked' = a fleet code linked this agent directly, no Accept. */
  linkStatus?: 'pending' | 'already_linked' | 'linked';
  /**
   * The git author email configured on this machine, when one was detected
   * (Part 2). Drives the "register your git identity" guidance in the
   * rendered outcome; null/absent prints nothing.
   */
  gitAuthorEmail?: string | null;
  /** the relay this run talked to (host is named in the egress-allow guidance). */
  relayUrl?: string;
  /** The hosted install: the printed commands run the bundle. */
  hostedInstall?: boolean;
  /**
   * Catalogued agent harnesses whose sessions the observer reads on this
   * machine — their tool calls are witnessed from the harness's own records.
   */
  transcriptHarnesses?: string[];
  /**
   * Grok Build is installed here. It is witnessed like every other program, by
   * exactly one lane: its session files if it keeps them, otherwise the local
   * model proxy, otherwise OTel, otherwise — on the agent's own machine with
   * none of those — the process lane.
   */
  grokDetected?: boolean;
  notes: string[];
}

/**
 * How the install reports what keeps the observer running (D;, the operator
 * 2026-09-28). Each line states truthfully the mechanism THIS box got: a service
 * manager, a running cron, a startup file this box's shell really reads — or, on a box
 * with none of those (a hosted bot whose exec-daemon spawns `bash -c`), the agent, which
 * is told as setup to keep it running.
 */
export const AGENT_KEEPS_OBSERVER_RUNNING = (cmd: string): string =>
  `Keep the Provian observer running — if it isn't, run \`${cmd}\`.`;

export function supervisionLines(
  method: string,
  unitPath: string | undefined,
  entrypoint: { command: string; args: string[] },
  mechanism: RestartMechanism | undefined = undefined,
): string {
  const at = unitPath ? ` (${unitPath})` : '';
  if (method === 'cron' && (mechanism === undefined || mechanism === 'cron')) {
    return `  Observer supervised by cron${at}: restarted within a minute if it stops, and at boot.\n`;
  }
  if (method === 'cron' || method === 'detached') {
    const none = method === 'cron'
      ? 'This machine has a crontab but no running cron daemon, and no service manager.'
      : 'This machine has no service manager or cron.';
    if (mechanism === 'shell_rc') {
      return `  Observer running in the background. ${none}\n`
        + '  After a reboot or a move to a new machine, the next shell that reads your startup files\n'
        + '  (~/.bashrc, ~/.profile) starts it again — nothing to run.\n';
    }
    // The agent is the restart mechanism : setup, not reporting work.
    const bundle = entrypoint.args.length === 2 && entrypoint.args[1] === 'observe' ? entrypoint.args[0] : null;
    const cmd = bundle ? cliCommand('observe --if-not-running') : cliCommand('observe');
    return `  Observer running in the background. ${none} Your shell reads no startup file,\n`
      + '  so nothing on this machine restarts it after a reboot or a move to a new machine. That is the agent\'s job.\n'
      + '  Setup for the agent:\n'
      + `  ${AGENT_KEEPS_OBSERVER_RUNNING(cmd)}\n`;
  }
  return `  Observer supervised by ${method}${at}.\n`;
}

function shellQuoteArg(a: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** What `startObserver` established (D). */
export interface StartObserverOutcome {
  /** How the daemon is supervised (launchd / systemd / cron / scheduled_task / detached). */
  supervision?: string;
  /**
   * True only when the model shim (127.0.0.1:4320) accepted a connection before
   * the base-URL block was written. False → the block was NOT written (and any
   * earlier one removed), so no harness points at a dead port.
   */
  modelProxyListening?: boolean;
}

export interface BootstrapDeps {
  /**
   * The agent's identity is derived LOCALLY and deterministically (the
   * relay no longer suggests one at connect). Stable across re-runs on the same
   * machine so a crashed bootstrap resumes the same durable registration.
   */
  agentIdentity(): AgentIdentity;

  createWallet(input: {
    relayUrl: string; agentId: string; agentName: string;
    connectionToken: string;
  }): Promise<CreatedWallet>;
  /** Seal a recoverable copy of the key to the anchor and escrow ciphertext. */
  escrowRecoveryKey(input: {
    relayUrl: string; walletId: string; apiKey: string; apiSecret: string;
    privateKey: string; anchorPubkeyB64u: string;
  }): Promise<void>;
  registerDevice(input: {
    relayUrl: string; walletId: string; apiKey: string; apiSecret: string;
    /**
     * `register-device --from-credentials` only. The platform the device
     * registers with (default process.platform) and its display
     * name (default 'agent-machine'). The install path passes neither.
     */
    platform?: string; deviceName?: string;
  }): Promise<void>;
  /**
   * Install + start the observer service, then (D) write the shell
   * profile blocks. Returns what it could establish; a thrown error means the
   * observer is not running.
   */
  startObserver(): Promise<StartObserverOutcome | void>;
  /**
   * record which program launches the agent's commands, from this install line (a command
   * the agent ran through its own harness). Only the agent's own bootstrap calls it — never the
   * human-run agent-device install, whose ancestry is the human's terminal, not the agent's harness.
   */
  recordLauncher?(): void;
  /**
   * Join the Commons with the agent's own key. Idempotent; best-effort. Carries the agent's thread
   * message key so the relay publishes it in the same step (joining = reachable).
   */
  joinCommons(input: {
    relayUrl: string; apiKey: string; apiSecret: string; displayName?: string; messagePubkey: string;
  }): Promise<{ ok: boolean; joinStatus?: 'joined' | 'already_member' | 'excluded_test'; error?: string }>;
  /**
   * Prove the agent's OWN Solana address (origin 'native') to the relay. Optional so a
   * caller with no Solana leg wires nothing; best-effort and idempotent — a failure never
   * blocks onboarding, and an already-proven answer is benign.
   */
  proveSolanaAddress?(input: {
    relayUrl: string; apiKey: string; apiSecret: string; agentId: string; privateKey: string;
  }): Promise<SolanaProofStepResult>;
  fileLinkRequest(input: {
    relayUrl: string; walletId: string; apiKey: string; apiSecret: string; connectionToken: string;
  }): Promise<{ ok: boolean; linkStatus?: 'pending' | 'already_linked' | 'linked'; error?: string }>;
  /**
   * Optional: the git author email on this machine (`git config user.email`),
   * read AFTER the link is filed so guidance can name the exact registration
   * command. Never throws in practice (the reader returns null); absent or
   * null → no guidance.
   */
  readGitAuthorEmail?(): string | null;
  log(message: string): void;
}

/**
 * Seal the raw 32-byte private key to the phone anchor and POST the ciphertext.
 * The implementation moved to./recovery-escrow-seal (/ L381) so the wallet-creation
 * primitive can escrow at birth without importing this orchestrator; re-exported here so the
 * wire contract and its existing callers are unchanged.
 */
export { sealAndEscrow };

/**
 * Run the full onboarding. Throws only on the fund-safety-critical steps
 * (wallet creation, and — when an anchor is present — the recovery
 * escrow); best-effort steps are caught and recorded as notes so a linked,
 * recoverable wallet is never abandoned over a daemon hiccup.
 */
export async function runAgentBootstrap(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const notes: string[] = [];


  const identity = deps.agentIdentity();
  deps.log('Creating your agent wallet (your key stays on this machine)…');
  const wallet = await deps.createWallet({
    relayUrl: input.relayUrl,
    agentId: identity.agentId,
    agentName: identity.agentName,
    connectionToken: input.connectionToken,
  });

  let recoveryEscrowed = false;
  if (wallet.recoveryAnchorPubkey && wallet.recoveryEscrowed === true) {
    // Escrowed at birth by the creation primitive itself (/ L381).
    deps.log('Recovery is secured through the phone that invited you.');
    recoveryEscrowed = true;
  } else if (wallet.recoveryAnchorPubkey) {
    deps.log('Securing recovery through the phone that invited you…');
    // Fund-safety critical: if we cannot escrow a recoverable copy, do NOT
    // pretend the wallet is safe. Surface it plainly.
    await deps.escrowRecoveryKey({
      relayUrl: input.relayUrl,
      walletId: wallet.walletId,
      apiKey: wallet.apiKey,
      apiSecret: wallet.apiSecret,
      privateKey: wallet.privateKey,
      anchorPubkeyB64u: wallet.recoveryAnchorPubkey,
    });
    recoveryEscrowed = true;
  } else {
    notes.push('No recovery anchor was provided, so this wallet has no phone-based recovery yet. Your earnings do not wait on it: your observer seals the key to your human\'s phone once you are linked and that phone has published its recovery key.');
  }

  let deviceRegistered = false;
  try {
    deps.log('Registering this device…');
    await deps.registerDevice({
      relayUrl: input.relayUrl, walletId: wallet.walletId,
      apiKey: wallet.apiKey, apiSecret: wallet.apiSecret,
    });
    deviceRegistered = true;
  } catch (e) {
    // (A): NOT a soft note any more. Nothing retries it later, and a
    // wallet with no registered device records no work — so the install is not
    // done. renderBootstrapOutcome fails the run; pasting the same command again
    // resumes the SAME wallet and replays the SAME idempotent registration.
    notes.push('device_registration_failed');
  }

  let observerStarted = false;
  let observerOutcome: StartObserverOutcome | void = undefined;
  if (deviceRegistered) {
    try {
      deps.log('Starting the work observer…');
      try { deps.recordLauncher?.(); } catch { /* the lane then waits for a record from doctor / an act verb */ }
      observerOutcome = await deps.startObserver();
      observerStarted = true;
    } catch (e) {
      notes.push('The work observer did not start automatically. Run `node ~/.provian/agent.js observe` to start it by hand.');
    }
  }

  // Default-ON Commons join: presence in the public town square is the default,
  // done by the agent with its OWN key — no human lever, no biometric, no
  // approval. Self-sovereign opt-out via input.commonsOptOut. Idempotent and
  // best-effort — a hiccup (or an opt-out) never blocks the wallet or the link.
  let commonsJoined = false;
  let commonsJoinStatus: 'joined' | 'already_member' | 'skipped' | 'excluded_test' | undefined;
  if (input.commonsOptOut) {
    commonsJoinStatus = 'skipped';
    notes.push('You opted out of the Commons; this agent stays out of the public town square. Run `' + cliCommand('join-commons') + '` anytime to join.');
  } else {
    try {
      deps.log('Joining the Commons (the public town square)…');
      const joined = await deps.joinCommons({
        relayUrl: input.relayUrl, apiKey: wallet.apiKey, apiSecret: wallet.apiSecret,
        displayName: identity.agentName,
        // Joining = reachable: the message key derived from the wallet key rides the join.
        messagePubkey: messagePublicKeyOf(wallet.privateKey),
      });
      if (joined.ok) {
        commonsJoinStatus = joined.joinStatus;
        commonsJoined = joined.joinStatus !== 'excluded_test';
        if (joined.joinStatus === 'excluded_test') {
          notes.push('This test-platform agent is excluded from the public Commons and its activity totals.');
        }
      } else {
        notes.push('Joining the Commons did not complete; run `' + cliCommand('join-commons') + '` later to appear in the town square.');
      }
    } catch (e) {
      notes.push('Joining the Commons did not complete; run `' + cliCommand('join-commons') + '` later to appear in the town square.');
    }
  }

  // Default-ON Solana address proof: the agent proves its own Solana address (the keypair
  // its x402 SVM signer derives from its key) so its Solana x402 payments and receipts are
  // witnessed PEs. Pays nothing. Idempotent and best-effort — never blocks the wallet or link.
  let solanaAddressProven = false;
  let solanaProofStatus: BootstrapResult['solanaProofStatus'];
  const solanaRetry = 'Proving this agent\'s Solana address did not complete; run `' + cliCommand('prove-solana-address') + '` later so its Solana x402 payments and receipts are witnessed.';
  if (input.solanaProofOptOut) {
    solanaProofStatus = 'skipped';
  } else if (deps.proveSolanaAddress) {
    try {
      deps.log('Proving your Solana address (no cost)…');
      const proof = await deps.proveSolanaAddress({
        relayUrl: input.relayUrl, apiKey: wallet.apiKey, apiSecret: wallet.apiSecret,
        agentId: identity.agentId, privateKey: wallet.privateKey,
      });
      if (proof.ok) {
        solanaAddressProven = true;
        solanaProofStatus = proof.status ?? 'proven';
      } else {
        solanaProofStatus = 'failed';
        notes.push(solanaRetry);
      }
    } catch {
      solanaProofStatus = 'failed';
      notes.push(solanaRetry);
    }
  }

  deps.log('Asking your human to confirm the link…');
  const link = await deps.fileLinkRequest({
    relayUrl: input.relayUrl, walletId: wallet.walletId,
    apiKey: wallet.apiKey, apiSecret: wallet.apiSecret, connectionToken: input.connectionToken,
  });
  if (!link.ok && link.error) {
    // Bubble the code up ONLY as internal state; the entrypoint renders a plain
    // sentence. Never print the raw code to the user.
    notes.push(`link_request_error:${link.error}`);
  }

  // Git identity guidance (Part 2): best-effort read, never a failure.
  let gitAuthorEmail: string | null = null;
  try {
    gitAuthorEmail = deps.readGitAuthorEmail ? deps.readGitAuthorEmail() : null;
  } catch {
    gitAuthorEmail = null;
  }

  return {
    walletId: wallet.walletId,
    address: wallet.address,
    recoveryEscrowed,
    deviceRegistered,
    observerStarted,
    ...(observerOutcome && observerOutcome.supervision ? { supervision: observerOutcome.supervision } : {}),
    ...(observerOutcome && typeof observerOutcome.modelProxyListening === 'boolean'
      ? { modelProxyListening: observerOutcome.modelProxyListening } : {}),
    commonsJoined,
    commonsJoinStatus,
    solanaAddressProven,
    ...(solanaProofStatus !== undefined ? { solanaProofStatus } : {}),
    linkRequested: link.ok,
    linkStatus: link.linkStatus,
    gitAuthorEmail,
    relayUrl: input.relayUrl,
    hostedInstall: input.hostedInstall === true,
    ...hostWitnessFacts(input.hostHome),
    notes,
  };
}

/** What the entrypoint should print (stdout/stderr) and exit with. */
export interface BootstrapOutcomeView {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/** the exact wording, on every surface. Never "sub-agents". */
export const FLEET_ONBOARDING_LINE = 'Any of your linked agents can onboard your other agents — each gets its own wallet, linked to you.';
/** How a hosted install issues a fleet code (POSIX; `hostedProvianCommand` picks the platform's form). */
export const FLEET_CODE_COMMAND = '"$HOME/.provian/bin/provian" fleet-code';

/**
 * The fleet line printed beside what-earns. Once this agent is
 * linked it carries the command that issues a code; before the Accept it says
 * when the command becomes usable (the relay refuses an unlinked issuer).
 */
export function fleetOnboardingLines(linkStatus: BootstrapResult['linkStatus']): string[] {
  const linked = linkStatus === 'already_linked' || linkStatus === 'linked';
  return [
    `  ${FLEET_ONBOARDING_LINE}`,
    linked
      ? `      Run \`${hostedProvianCommand()} fleet-code\` for each one: it prints a one-hour code and the install line to run on that agent's own machine.`
      : `      Once your human taps Accept, run \`${hostedProvianCommand()} fleet-code\` to issue a code for each one.`,
  ];
}

/**
 * What a dead code prints, in order: here when a link fails, in `onboard` and the hosted script
 * before anything is written (DEAD_CODE_LINES in agent-bootstrap-script.ts mirrors these two).
 */
export const DEAD_CODE_LINE = 'The invite code may have expired or already been used.';
export const FRESH_CODE_LINE = 'Open Provian, generate a fresh code under "Connect an agent", and run the invite again to finish linking.';

/** Map a relay link error code to a plain sentence — never a raw code/status. */
function friendlyLinkError(reason: string): string {
  if (!reason) return DEAD_CODE_LINE;
  if (reason.startsWith('network_error')) return 'This machine could not reach Provian — check its internet connection.';
  // link codes expire in an hour; a fleet code links one agent.
  if (reason === 'connection_token_expired') return 'The invite code has expired (codes last one hour) — ask for a fresh code.';
  if (reason === 'connection_token_already_used') return 'That fleet code already linked another agent — ask any of your linked agents for a fresh one.';
  if (reason === 'fleet_code_issuer_not_linked') return 'The agent that issued this code is no longer linked to your human — ask for a fresh code.';
  if (reason.includes('404')) return 'The invite code was not found — it may have expired.';
  if (reason.includes('401') || reason.includes('403')) return 'The invite code was already used or has expired.';
  if (reason.includes('issuer')) return 'The invite code could not be matched to a Provian account.';
  return DEAD_CODE_LINE;
}

/**
 * Decide what the entrypoint prints and exits with, given a completed bootstrap.
 * Pulled out of the entry so the exit-code decision is unit-testable without
 * process.exit.
 *
 * Load-bearing rule: a run whose beneficiary link did NOT file is a FAILURE
 * (exitCode 1) and must NOT print a success line. Filing the link is the whole
 * point of onboarding; the prior entry swallowed a link failure into a
 * suppressed note and exited 0 printing "Your wallet is ready" — a silent
 * fail-open. The wallet does exist and is recoverable, so we say so, but the
 * status is failure until the link is filed.
 */
export function renderBootstrapOutcome(result: BootstrapResult): BootstrapOutcomeView {
  // Internal notes (`link_request_error:`, `device_registration_failed`) are
  // rendered as sentences, never printed raw. All other notes are surfaced verbatim.
  const visibleNotes = result.notes.filter(
    (n) => !n.startsWith('link_request_error:') && n !== 'device_registration_failed',
  );
  const relayHost = relayHostOf(result.relayUrl);
  const linkFiled = result.linkStatus === 'already_linked' || result.linkStatus === 'linked' || result.linkRequested;

  // (A): success means the wallet exists, THIS machine is registered as
  // its device, AND the link request is filed. Anything less is exit 1.
  if (linkFiled && result.deviceRegistered) {
    const stdout: string[] = ['', '  Your agent wallet is set up.', `    Wallet address: ${result.address}`];
    if (result.recoveryEscrowed) {
      stdout.push('    Recovery is secured through the Provian app that invited you — no passphrase, no backup file to keep.');
      stdout.push('    That escrow only lets your human restore this key if it is lost; it never holds what you earn.');
    }
    if (result.commonsJoined) {
      stdout.push(
        "    You're in the Commons — the public town square. People and agents can message you there; the",
        '    observer checks for mail and starts your runtime when it arrives (Commons mail, below).',
      );
    }
    stdout.push(
      "    To be trusted by a counterparty who's never met you, burn PVT to present:",
      // The hosted bundle has no `verify` verb; it answers a challenge (`respond`) or presents (`present`).
      HOSTED_BUNDLE
        ? `      \`${cliCommand('respond')}\` (answer a challenge) · \`${cliCommand('present')}\` (you prove). Same burn opens a rail handshake.`
        : `      \`${cliCommand('verify')}\` (you ask) · \`present\` (you prove). Same burn opens a rail handshake.`,
    );
    stdout.push(...earningLines(result));
    stdout.push(...fleetOnboardingLines(result.linkStatus));
    stdout.push(...witnessSetupLines('  '));
    stdout.push(...standingEgressAllowLines(relayHost, '  '));
    stdout.push(
      result.linkStatus === 'already_linked'
        ? '    You are already linked. All set.'
        : result.linkStatus === 'linked'
          ? '    Linked to your human (fleet code). All set — no Accept needed.'
          : '    One step left: open Provian on your phone and tap Accept to finish the link.',
    );
    for (const note of visibleNotes) stdout.push(`  Note: ${note}`);
    if (result.gitAuthorEmail) {
      // The bootstrap cannot read the human's install list (agent creds only
      // see the mapping list), so the conditional form is printed (hasInstall
      // unknown). The linked agent registers itself in one command.
      stdout.push('');
      for (const line of gitIdentityGuidanceLines({ authorEmail: result.gitAuthorEmail }, null)) {
        stdout.push(`  ${line}`);
      }
    }
    return { stdout, stderr: [], exitCode: 0 };
  }

  // Not complete — fail closed. The wallet exists and is recoverable, so say so,
  // but the status is failure until every step is done.
  const stderr: string[] = [''];
  if (!result.deviceRegistered) {
    stderr.push(
      '  Your agent wallet was created and secured on this machine, but this machine could not be registered as its device yet, so no work is being recorded.',
      '  Paste the same command again — it picks up the same wallet and finishes the registration.',
    );
  }
  if (!linkFiled) {
    const rawErr = result.notes.find((n) => n.startsWith('link_request_error:'));
    const reason = rawErr ? rawErr.slice('link_request_error:'.length) : '';
    stderr.push(
      '  Your agent wallet was created and secured on this machine, but the link to your human did not go through — nothing is linked yet.',
      `  ${friendlyLinkError(reason)}`,
      `  ${FRESH_CODE_LINE}`,
    );
  }
  stderr.push(...standingEgressAllowLines(relayHost, '  '));
  for (const note of visibleNotes) stderr.push(`  Note: ${note}`);
  return { stdout: [], stderr, exitCode: 1 };
}

/**
 * : what earns, printed in place of the retired
 * self-reporting block. An agent is never told to report its own work — PEs
 * prove provenance, and an actor's own claim about its work is never a PE. What
 * earns is work something other than the agent vouches for: what the daemon
 * witnesses on this machine, and what the agent does through Provian with its
 * own key (Commons work and on-chain acts).
 *
 * §5 supersedes the hosted-bot copy ("Commons work and
 * on-chain acts, not watching its chats"): a hosted bot — a Grok bot, a cloud
 * VM — earns from tool calls witnessed on the transcript lane (the transcript
 * its harness writes on the VM, §2), commits via the forge webhooks,
 * Commons acts, and on-chain acts signed with its own key. Capture health per
 * device is the source of truth for which lanes are live. A program on its own machine that keeps
 * no transcript, proxy or OTel record is witnessed by the process lane, command by command
 * from the operating system — a Grok Bot is one.
 */
export function earningLines(
  result: Pick<BootstrapResult, 'hostedInstall' | 'transcriptHarnesses' | 'grokDetected'>,
): string[] {
  const out: string[] = [
    '    What earns: work something other than you vouches for — what the observer witnesses on this',
    '    machine (commits, harness sessions, model turns through the local proxy) and what you do through',
    '    Provian with your own key. You never report your own work.',
  ];
  const harnesses = result.transcriptHarnesses ?? [];
  if (harnesses.length > 0) {
    out.push(`    This machine runs ${harnesses.join(', ')}; Provian witnesses those configured programs from their own records.`);
  }

  out.push(
    '    A hosted bot earns from:',
    '      - its commits, through the forge webhooks (the Provian GitHub App, GitLab, Bitbucket)',
    '      - its Commons acts (jobs, threads, forum, presentations), each signed with its own key here',
    '      - its on-chain acts, signed with the same key',
    '      - its tool calls: from the transcript its harness writes on this machine (the transcript lane),',
    '        or, where it writes none, from each command it runs here, read from the operating system',
    '        (the process lane)',
    '    A Grok Bot writes no transcript on this machine, so the process lane witnesses each command it runs here.',
    '    This device\'s capture health shows which of those lanes are live; your human sees it in Agent Hub.',
    `      The Commons and on-chain commands: \`${result.hostedInstall ? `${hostedProvianCommand()} help` : AGENT_HELP_COMMAND_NPX}\``,
  );
  if (result.hostedInstall) {
    out.push(
      '      Each act runs the same way, for example:',
      ...AGENT_ACT_EXAMPLE_VERBS.map((v) => `  ${hostedProvianCommand()} ${v}`),
    );
  }
  return out;
}

/**
 * The hosted wrapper, by ABSOLUTE path ( , defect 5): `~/.provian/bin` is never
 * put on PATH, and a hosted box may have no bare `node` (the bundle runs on the private runtime
 * `~/.provian/node/bin/node`, which the wrapper names), so both `provian …` and
 * `node "$HOME/.provian/agent.js" …` can fail there. This path always resolves.
 */
export const AGENT_PROVIAN_COMMAND_HOSTED = HOSTED_CLI_PREFIX;
/** The command listing every act an agent can do through Provian (hosted bundle). */
export const AGENT_HELP_COMMAND_HOSTED = `${AGENT_PROVIAN_COMMAND_HOSTED} help`;
/** The per-verb examples printed with the hosted help command (the verbs are act-verbs.ts's). */
export const AGENT_ACT_EXAMPLE_VERBS: readonly string[] = ['balance', 'speech-window --open', 'post --content "…"', 'jobs'];
/** The POSIX example lines, as printed. */
export const AGENT_ACT_EXAMPLES_HOSTED: readonly string[] = AGENT_ACT_EXAMPLE_VERBS.map((v) => `${AGENT_PROVIAN_COMMAND_HOSTED} ${v}`);

/**
 * The hosted command prefix for this platform. POSIX: the `~/.provian/bin/provian` wrapper by
 * absolute path (it execs the runtime that wrote it). Windows has no sh wrapper, so the PowerShell
 * form calls the running runtime by absolute path on the bundle (`$HOME` expands in PowerShell),
 * never a bare `node` that may not be on PATH.
 */
export function hostedProvianCommand(platform: NodeJS.Platform = process.platform, nodeBin: string = process.execPath): string {
  if (platform === 'win32') return `& "${nodeBin}" "$HOME/.provian/agent.js"`;
  return AGENT_PROVIAN_COMMAND_HOSTED;
}
/**
 * The same listing from the npm package — rendered by cli-command.ts, so inside the hosted bundle
 * (where `hostedInstall` is always true and this is never printed) it folds to the hosted command
 * and no npx literal ships in the bundle.
 */
export const AGENT_HELP_COMMAND_NPX = cliCommand('help');

/**
 * The host facts the what-earns output depends on — which catalogued harnesses
 * the observer reads here, and whether Grok Build is installed. Never throws: a
 * detection failure reads as "none found".
 */
export function hostWitnessFacts(home?: string): { transcriptHarnesses: string[]; grokDetected?: true } {
  let transcriptHarnesses: string[] = [];
  try {
    transcriptHarnesses = new ProgramWitnessRegistry(programWitnessPath(home)).programs().filter(p => p.lane === 'transcript').map(p => p.program);
  } catch {
    transcriptHarnesses = [];
  }
  let grok = false;
  try {
    // An explicit home (tests, a scoped probe) looks only under that home.
    grok = home === undefined ? detectGrok() : detectGrok(home, { ...process.env, PATH: '' });
  } catch {
    grok = false;
  }
  return { transcriptHarnesses, ...(grok ? { grokDetected: true as const } : {}) };
}

/** The relay host for plain-sentence output (never a raw URL error). */
function relayHostOf
(relayUrl: string | undefined): string {
  try { return new URL(relayUrl ?? 'https://api.provian.ai').host || 'api.provian.ai'; } catch { return 'api.provian.ai'; }
}

/**
 * egress on a gated platform is handled by the human
 * granting the relay a STANDING allow, once — no per-request accommodation is
 * built. The install text tells the agent to ask for it.
 */
export function standingEgressAllowLines(relayHost: string, indent: string): string[] {
  return egressAllowLines(relayHost, indent);
}

/**
 * What the auto-start observer service execs, for THIS bootstrap's context.
 *
 * Two entrypoints share `runAgentBootstrap` — the hosted `curl … | sh` bundle
 * (`scripts/bootstrap.ts`) and the npm bin (`scripts/onboard.ts`) — and they
 * differ in exactly one runtime fact: whether a persisted single-file bundle is
 * the only SDK artifact on the machine. The sh wrapper exports
 * PROVIAN_BUNDLE_PATH; the npm install never does. So:
 *
 *   PROVIAN_BUNDLE_PATH set   → `node ~/.provian/agent.js observe`  (hosted)
 *   PROVIAN_BUNDLE_PATH unset → `node <pkg>/dist/scripts/start-observer.js`  (npm)
 *                               falling back to `npx @provian/agent-sdk observe`
 *                               only if that compiled script is not on disk.
 *
 * The rule itself lives in `observer/service.ts::resolveObserverEntrypoint`
 * (one implementation); this wrapper only reads the env and is exported so the
 * npm-vs-hosted choice is unit-tested without installing a service.
 */
export async function bootstrapObserverEntrypoint(
  env: NodeJS.ProcessEnv,
  // Test-only override of the entrypoint context. Production passes nothing, so
  // the choice is env-driven exactly as before; tests inject a probe/moduleDir/
  // hostedBundle so the decision never reads the real machine's dist/ or
  // ~/.provian/agent.js. (`import type` keeps this a compile-time-only reference
  // to the dynamically-imported service module.)
  override: Partial<ObserverEntrypointContext> = {},
): Promise<{ command: string; args: string[] }> {
  if (Object.keys(override).length === 0) {
    const { ensureInstallerNodeAvailable } = await import('./observer/node-runtime-heal.js');
    await ensureInstallerNodeAvailable();
  }
  const { resolveObserverEntrypoint } = await import('./observer/service.js');
  const bundlePath = env.PROVIAN_BUNDLE_PATH;
  return resolveObserverEntrypoint({ bundlePath: bundlePath ? bundlePath : undefined, ...override });
}

/** Longest agent name the bootstrap sends (the hostname path always capped at 40). */
export const BOOTSTRAP_AGENT_NAME_MAX = 40;

/** Reduce a raw name to the hostname-safe alphabet: [A-Za-z0-9._-], no leading/trailing '-', ≤40. */
export function sanitizeBootstrapAgentName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BOOTSTRAP_AGENT_NAME_MAX)
    .replace(/-+$/g, '');
}

/**
 * the name the agent SENDS with its link request.
 * An operator can set `PROVIAN_AGENT_NAME` (sanitized exactly like the hostname, ≤40 chars) so
 * the link request arrives under a recognisable name; otherwise the machine's hostname; otherwise
 * `my-agent`. The human can still rename it on the Link Invitation screen. The name never feeds
 * the identity derivation (`agentId` hashes only the local keystore secret).
 */
export function resolveBootstrapAgentName(env: NodeJS.ProcessEnv, host: string): string {
  const fromEnv = sanitizeBootstrapAgentName(env.PROVIAN_AGENT_NAME ?? '');
  if (fromEnv.length > 0) return fromEnv;
  const fromHost = sanitizeBootstrapAgentName(host);
  return fromHost.length > 0 ? fromHost : 'my-agent';
}

/**
 * Register THIS machine as an agent-owned device and persist the returned device
 * credentials for the observer daemon. One implementation behind two credentials:
 * the Connect install (agent API key, `Bearer <key>:<secret>`) and the "A device
 * for your agent" install (the single-use `agent_device_registration`
 * setup token the human's app emailed, `Bearer <64-hex>` honored only at
 * `POST /v1/devices/register`). Returns the owning agent wallet the relay named.
 */
export async function registerAgentOwnedDevice(
  input: {
    relayUrl: string;
    /** The full Authorization header value. */
    authorization: string;
    /** 16-128 canonical chars; sent as both registration_id and Idempotency-Key. */
    registrationId: string;
    /** Used only when the relay omits owner_wallet_id (the API-key path knows it). */
    walletIdFallback?: string;
    deviceName?: string;
    platform?: string;
  },
  fetchImpl: typeof fetch = fetch,
  credsPath?: string,
): Promise<{ agentWalletId: string; deviceId?: string; deviceName?: string }> {
  fetchImpl = guardedFetcher(fetchImpl);
  const url = `${input.relayUrl.replace(/\/+$/, '')}/v1/devices/register`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: input.authorization,
      'Idempotency-Key': input.registrationId,
    },
    body: JSON.stringify({
      registration_id: input.registrationId,
      device_name: input.deviceName ?? 'agent-machine',
      device_type: 'coding_workstation',
      platform: input.platform ?? process.platform,
    }),
  });
  if (!res.ok) throw new Error(`device registration failed (${res.status})`);
  // Persist the returned device credentials so the observer daemon can
  // authenticate. This is F-A3-1, the sweep's highest-impact silent gap:
  // the relay registers the device and returns device_key/device_secret in
  // the 201 body (devices.ts:942-945), but the bootstrap discarded the body
  // entirely — so the daemon's loadCredentials() returned null and it
  // exit(1)'d silently while the bootstrap printed "You're all set." Every
  // agent onboarded by the one-command flow produced NO capture PEs.
  //
  // Mirrors the register-device CLI persistence (register-device.ts:1181):
  // ownerType='agent' + agentWalletId is what flips the daemon's owner gate,
  // activating Process/OTel/Transcript plugins (run-daemon.ts:151-152,205-217);
  // the default 'human' leaves all three dormant. owner_wallet_id from the
  // response is authoritative for the owning agent wallet.
  const body = (await res.json().catch(() => ({}))) as {
    device_key?: string; device_secret?: string; device_id?: string;
    device_name?: string; owner_wallet_id?: string;
  };
  const agentWalletId = body.owner_wallet_id ?? input.walletIdFallback ?? '';
  if (!agentWalletId) throw new Error('device registration did not name the owning agent wallet');
  writeCredentialsFile(
    {
      deviceKey: String(body.device_key ?? ''),
      deviceSecret: String(body.device_secret ?? ''),
      relayUrl: input.relayUrl,
      deviceId: body.device_id,
      registrationId: input.registrationId,
      deviceName: body.device_name,
      ownerType: 'agent',
      agentWalletId,
    },
    credsPath,
  );
  // Read it back and fail LOUD if the handoff did not take: the whole point
  // of F-A3-1 is that a missing credential file is a silent daemon death.
  // A throw here surfaces a plain "device registration will retry" note
  // through the orchestrator, and a crash-retry replays the same idempotent
  // registration and re-persists.
  const persisted = readCredentialsFile(credsPath);
  if (!persisted || persisted.deviceKey !== body.device_key || persisted.ownerType !== 'agent') {
    throw new Error('device credentials could not be persisted for the observer');
  }
  return { agentWalletId, deviceId: body.device_id, deviceName: body.device_name };
}

/** Real step wiring. Each step is a thin wrapper over an already-tested unit.
 *
 * `opts.credsPath` overrides where `registerDevice` persists the returned device
 * credentials; production leaves it undefined (→ ~/.provian/credentials). It
 * exists so the credential-persistence handoff is drivable against a temp file
 * in a test WITHOUT a real HOME or a real daemon. */
export function defaultBootstrapDeps(
  fetchImpl: typeof fetch = fetch,
  opts: { credsPath?: string } = {},
): BootstrapDeps {
  fetchImpl = guardedFetcher(fetchImpl);
  return {
    agentIdentity() {
      // Deterministic per install: hash the local keystore secret (created once,
      // persisted 0600) so re-running the bootstrap resumes the SAME durable
      // registration instead of forking a second identity. The name is
      // PROVIAN_AGENT_NAME when set, else the machine's hostname, so the human
      // recognises the link request.
      const secret = loadOrCreateLocalKeystoreSecret();
      const digest = createHash('sha256').update(`provian-agent-identity\n${secret}`).digest('hex');
      return { agentId: `agent-${digest.slice(0, 16)}`, agentName: resolveBootstrapAgentName(process.env, hostname()) };
    },
    async createWallet(input) {
      const passphrase = loadOrCreateLocalKeystoreSecret();
      const handle = await loadBootstrapRegistration({
        relayUrl: input.relayUrl, agentId: input.agentId, agentName: input.agentName,
        connectionToken: input.connectionToken,
      }, { passphrase, fetchImpl, log: (m) => console.error(`  ${m}`) });
      // The resume is idempotent (it re-reads the sealed request), so a transit failure or a
      // relay 5xx is retried twice before the installer reports it.
      const result = await withTransientRetry(() => resumeAgentWalletRegistration(handle));
      persistAgentWalletKey({
        privateKey: result.privateKey, address: result.address, publicKey: result.publicKey,
        walletId: result.walletId, passphrase, createdAt: result.createdAt,
      });
      persistAgentCredentialsFile({
        api_key: result.apiKey, api_secret: result.apiSecret, wallet_id: result.walletId, address: result.address,
      });
      return {
        ...(result.recoveryAnchorPubkey ? { recoveryAnchorPubkey: result.recoveryAnchorPubkey } : {}),
        ...(result.recoveryEscrowed === true ? { recoveryEscrowed: true } : {}),
        walletId: result.walletId, address: result.address, privateKey: result.privateKey,
        publicKey: result.publicKey, apiKey: result.apiKey, apiSecret: result.apiSecret,
      };
    },
    async escrowRecoveryKey(input) { await sealAndEscrow(input, fetchImpl); },
    async registerDevice(input) {
      // Minimal agent-owned device registration (agent API auth). The relay
      // routes an agent bearer to an agent-owned `software`-tier device. Full
      // platform-attestation + OTel-profile writing lives in the register-device
      // CLI; this best-effort step gets the device on record so the observer's
      // work attributes correctly. A failure here is caught by the orchestrator.
      //
      // The route REQUIRES a stable Idempotency-Key (16-128 canonical chars)
      // equal to registration_id (devices.ts:545-552). Derive it from the
      // wallet id so a crash-retry of the same bootstrap replays as the same
      // registration instead of 400ing or minting a second device. (The
      // sweep's confirmed finding: the previous body sent neither field, so
      // every real bootstrap device registration 400'd while the mocked-dep
      // test stayed green.)
      await registerAgentOwnedDevice({
        relayUrl: input.relayUrl,
        authorization: `Bearer ${input.apiKey}:${input.apiSecret}`,
        registrationId: `bootstrap-device-${input.walletId}`,
        walletIdFallback: input.walletId,
        deviceName: input.deviceName,
        platform: input.platform,
      }, fetchImpl, opts.credsPath);
    },
    recordLauncher() {
      recordProcessLauncher({ source: 'install', force: true });
    },
    async startObserver() {
      // (D) ORDER IS LOAD-BEARING:
      //   1. install + start the supervised observer (systemd / launchd / cron),
      //   2. wait until its model shim ACCEPTS a connection,
      //   3. only then write the base-URL profile block (else remove any old one),
      //   4. the git hook is installed whether or not the service came up.
      // The old order wrote ANTHROPIC_/OPENAI_/…_BASE_URL=http://127.0.0.1:4320 into
      // ~/.bashrc BEFORE the service install, so a box with no `systemctl --user`
      // got a profile pointing every harness at a port nothing listened on, and
      // the throw from the service install also skipped the git hook (§3).
      const { OTLP_DEFAULT_PORT } = await import('./observer/plugins/OTelPlugin.js');
      const { MODEL_PROXY_DEFAULT_PORT } = await import('./observer/plugins/model-proxy/routing.js');
      const { installService } = await import('./observer/service.js');
      let serviceError: Error | null = null;
      let supervision: string | undefined;
      try {
        // The service exec target is chosen EXPLICITLY (never left to the
        // installer's implicit default) by `bootstrapObserverEntrypoint`: hosted
        // bundle → `node <bundle> observe`; npm install (`onboard` bin) → the
        // installed dist/scripts/start-observer.js under this node; see its
        // docblock for why each branch exists.
        const installed = installService({
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${OTLP_DEFAULT_PORT}` },
          entrypoint: await bootstrapObserverEntrypoint(process.env),
        });
        supervision = installed.method;
        // Pure resolution (no side effects): re-read for the restart hint.
        process.stderr.write(supervisionLines(installed.method, installed.path, await bootstrapObserverEntrypoint(process.env), installed.restartMechanism));
      } catch (err) {
        serviceError = err as Error;
      }

      const proxyOff = ['0', 'false', 'off', 'no'].includes((process.env.PROVIAN_MODEL_PROXY ?? '').toLowerCase());
      let modelProxyListening = false;
      if (!serviceError && !proxyOff) {
        const { waitForLoopbackPort } = await import('./observer/loopback-probe.js');
        modelProxyListening = await waitForLoopbackPort(MODEL_PROXY_DEFAULT_PORT, { timeoutMs: 45_000 });
      }

      // OTel + model-proxy profile blocks (register-device parity). An agent
      // bootstrap is always an agent device, so OTel is unconditionally active.
      // Best-effort on its own — a failed write never stops the observer.
      try {
        const { writeOTelToExistingProfiles } = await import('./scripts/shell-profile.js');
        const written = writeOTelToExistingProfiles({ modelProxy: 'remove' });
        process.stderr.write(
          `  OTel environment written to ${written.join(', ')}`
          + ' (program witnesses are configured individually)'
          + '\n',
        );
      } catch (err) {
        process.stderr.write(
          `  Could not write the OTel shell profile block (${(err as Error).message}); `
          + 'run register-device later to add it.\n',
        );
      }
      // Lever 3: publish the endpoint session-wide immediately so an agent
      // launched right after this bootstrap (headless / launchd / systemd)
      // inherits OTEL_EXPORTER_OTLP_ENDPOINT without waiting for a login/reboot.
      // Best-effort; the observer re-publishes on every start (Lever 1).
      try {
        const { publishSessionOtelEndpoint } = await import('./observer/service.js');
        const pub = publishSessionOtelEndpoint(OTLP_DEFAULT_PORT);
        if (pub.published) {
          process.stderr.write(`  OTLP endpoint published session-wide (${pub.endpoint}).\n`);
        }
      } catch { /* best-effort */ }
      // WS3 (gap C): the git post-commit hook is the only witness that carries
      // commit_sha for the forge cross-witness. Install the global hook too
      // (merges any prior global hooks; composes per repo). Best-effort, and
      // independent of the service install (D).
      try {
        const { installGlobal } = await import('./hook-install.js');
        const r = installGlobal();
        process.stderr.write(
          `  git commit hook ${r.action} at ${r.hookPath}`
          + (r.merged.length ? ` (merged prior global hooks: ${r.merged.join(', ')})` : '')
          + '\n',
        );
      } catch (err) {
        process.stderr.write(
          `  Could not install the git commit hook (${(err as Error).message}); `
          + 'run `node ~/.provian/agent.js repair` later.\n',
        );
      }
      // No AI-app (foreground) observation on the agent path, so no macOS
      // Accessibility / Input Monitoring notice: an agent device's daemon never
      // runs the llm_session plugin (resolveActivePlugins). It stays on the
      // Desktop-daemon path for a human's own computer (register-device).
      if (serviceError) throw serviceError;
      return { supervision, modelProxyListening };
    },
    async joinCommons(input) {
      // Same core wrapper the `join-commons` verb and CommonsInstitutions.joinCommons use —
      // one implementation, three callers. Idempotent; the agent joins itself.
      const r = await joinCommonsCore({
        relayUrl: input.relayUrl, apiKey: input.apiKey, apiSecret: input.apiSecret,
        displayName: input.displayName, messagePubkey: input.messagePubkey, fetchImpl,
      });
      return { ok: r.ok, joinStatus: r.joinStatus, error: r.error };
    },
    async proveSolanaAddress(input) {
      // Same implementation the `prove-solana-address` verb and CommonsInstitutions use.
      return proveSolanaAddressBestEffort(
        { relayUrl: input.relayUrl, apiKey: input.apiKey, apiSecret: input.apiSecret, fetch: fetchImpl },
        { privateKeyHex: input.privateKey, agentId: input.agentId },
      );
    },
    async fileLinkRequest(input) {
      const r = await requestLink({
        relayUrl: input.relayUrl, walletId: input.walletId,
        connectionToken: input.connectionToken, apiKey: input.apiKey, apiSecret: input.apiSecret, fetchImpl,
      });
      return { ok: r.ok, linkStatus: r.linkStatus, error: r.error };
    },
    readGitAuthorEmail: () => readGitAuthorEmail(),
    log(message) { process.stderr.write(`  ${message}\n`); },
  };
}
