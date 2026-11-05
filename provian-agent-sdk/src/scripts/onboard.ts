#!/usr/bin/env node
/**
 * onboard — the ONE npm command that takes a brand-new agent from a connection
 * code to a linked, recoverable, observed wallet. It is the npm twin of the
 * hosted `curl … /v1/bootstrap/agent | sh` line: BOTH run the same
 * `runAgentBootstrap(defaultBootstrapDeps())` from `../bootstrap-flow` —
 * connect → create wallet → escrow recovery → register device → start observer
 * → join the Commons (default-on) → file the beneficiary link. One
 * implementation, two entrypoints; this file adds argument handling, the
 * machine-readable report, and the code check the hosted script runs in sh and
 * PowerShell, never a step of its own.
 *
 * On a machine with no agent wallet the relay rules on the code first, ahead of
 * every write: a dead, expired or placeholder code stops here with nothing on
 * the machine, and a code the relay could not rule on stops too.
 *
 * Usage:
 *   PROVIAN_CONNECTION_TOKEN=PROV-XXXX-XXXX npx @provian/agent-sdk onboard
 *   npx @provian/agent-sdk onboard                       # prompts for the code (hidden input)
 *   npx @provian/agent-sdk onboard --token PROV-XXXX-XXXX
 *   npx @provian/agent-sdk onboard --json --yes          # machine mode: never prompts
 *
 * While the Genesis window is open the run LEADS with the Genesis offer line
 * (../genesis-offer; a runtime date check — it prints nothing after the window).
 *
 * Connection-code sourcing (highest wins): `--token` / `--code` flag →
 * PROVIAN_CONNECTION_TOKEN → an interactive hidden prompt. Prefer the env var or
 * the prompt: a code passed on the command line is visible to other users of
 * the machine in the process list for as long as the run lasts (that is a
 * property of argv on every OS, not something this script can undo) and may
 * land in shell history. The prompt never echoes the code; nothing here ever
 * prints it.
 *
 * `--yes` / `--json` are the non-interactive modes: no prompt is ever shown,
 * so a missing code is a plain failure with exit 1. `--json` writes ONE JSON
 * object to stdout (progress + notes go to stderr) so an orchestrator can act
 * on the outcome; the exit code is the same one the human form would give.
 *
 * No-raw-errors: every line a person can see is a plain sentence — never a
 * stack, a status code, or a relay error code (the same rule the hosted
 * bootstrap follows in `scripts/bootstrap.ts`).
 */

import { describeSetupFailure, proxyForRelay, proxyVarForRelay } from '../setup-failure';
import { readSecret } from './prompt-secret';
import {
  runAgentBootstrap,
  defaultBootstrapDeps,
  renderBootstrapOutcome,
  standingEgressAllowLines,
  DEAD_CODE_LINE,
  FRESH_CODE_LINE,
  type BootstrapDeps,
  type BootstrapInput,
  type BootstrapResult,
} from '../bootstrap-flow';
import { checkConnectionCode, type ConnectionCodeCheck } from '../connection-code-check';
import { isDirectCliEntry } from './cli-entry';
import { genesisOfferLines } from '../genesis-offer';
import { applyRuntimeEnvAtEntry, computeRuntimeEnv, persistRuntimeEnv } from '../runtime-env';

export const DEFAULT_RELAY_URL = 'https://api.provian.ai';

// ---------------------------------------------------------------------------
// Arg parsing (pure — exported for testing)
// ---------------------------------------------------------------------------

export interface OnboardArgs {
  /** Connection code from `--token` / `--code` (undefined when not given). */
  token?: string;
  /** Relay URL from `--relay` (undefined when not given). */
  relay?: string;
  commonsOptOut: boolean;
  json: boolean;
  yes: boolean;
  help: boolean;
  /** The first argument the parser did not recognise, if any. */
  unknown?: string;
}

const VALUE_FLAGS: Record<string, keyof Pick<OnboardArgs, 'token' | 'relay'>> = {
  '--token': 'token',
  '--code': 'token',
  '--relay': 'relay',
};

export function parseOnboardArgs(argv: string[]): OnboardArgs {
  const out: OnboardArgs = { commonsOptOut: false, json: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = eq > 0 ? a.slice(eq + 1) : undefined;
    const target = VALUE_FLAGS[flag];
    if (target) {
      const value = inlineValue !== undefined ? inlineValue : argv[++i];
      if (value !== undefined) out[target] = value;
      continue;
    }
    if (a === '--commons-opt-out') out.commonsOptOut = true;
    else if (a === '--json') out.json = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (out.unknown === undefined) out.unknown = a;
  }
  return out;
}

export function usageText(): string {
  return [
    'Usage: npx @provian/agent-sdk onboard [options]',
    '',
    'One command from a connection code to a linked, recoverable, observed agent wallet.',
    'Generate the code in the Provian app under "Connect an agent".',
    '',
    'Options:',
    '  --token <code>, --code <code>   The connection code (visible in the process list; prefer',
    '                                  PROVIAN_CONNECTION_TOKEN or the hidden prompt)',
    `  --relay <url>                   Relay URL (default: PROVIAN_RELAY_URL or ${DEFAULT_RELAY_URL})`,
    '  --commons-opt-out               Stay out of the Commons (the public town square); default is to join',
    '  --json                          Print one JSON report to stdout; never prompts',
    '  --yes, -y                       Never prompt (fails plainly if no code is provided)',
    '  --help, -h                      Show this help',
    '',
    'Environment:',
    '  PROVIAN_CONNECTION_TOKEN        The connection code (used when no flag is given)',
    '  PROVIAN_RELAY_URL               Relay URL',
    '  PROVIAN_COMMONS_OPT_OUT=1       Same as --commons-opt-out',
    '  PROVIAN_SOLANA_PROOF_OPT_OUT=1  Skip proving your Solana address (proving is free; it lets',
    '                                  your Solana x402 payments and receipts be witnessed)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Connection-code sourcing: flag > env > prompt (pure over injected inputs)
// ---------------------------------------------------------------------------

export type TokenSource = 'flag' | 'env' | 'prompt';

export interface TokenResolution {
  token: string;
  source: TokenSource;
}

export interface ResolveTokenOptions {
  flagToken?: string;
  env: NodeJS.ProcessEnv;
  /** True only on a TTY with neither `--yes` nor `--json`; the prompt is never shown otherwise. */
  interactive: boolean;
  prompt: (question: string) => Promise<string>;
}

export async function resolveConnectionToken(opts: ResolveTokenOptions): Promise<TokenResolution | null> {
  const fromFlag = (opts.flagToken ?? '').trim();
  if (fromFlag) return { token: fromFlag, source: 'flag' };
  const fromEnv = (opts.env.PROVIAN_CONNECTION_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  if (!opts.interactive) return null;
  const typed = (await opts.prompt('  Paste your connection code (input is hidden): ')).trim();
  if (typed) return { token: typed, source: 'prompt' };
  return null;
}

export function isCommonsOptOut(args: OnboardArgs, env: NodeJS.ProcessEnv): boolean {
  if (args.commonsOptOut) return true;
  // Same accepted spellings as the hosted entrypoint (1/true/yes).
  return /^(1|true|yes)$/i.test(env.PROVIAN_COMMONS_OPT_OUT ?? '');
}

export function resolveRelayUrl(args: OnboardArgs, env: NodeJS.ProcessEnv): string {
  const fromFlag = (args.relay ?? '').trim();
  if (fromFlag) return fromFlag;
  const fromEnv = (env.PROVIAN_RELAY_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_RELAY_URL;
}

// ---------------------------------------------------------------------------
// The --json contract
// ---------------------------------------------------------------------------

export interface OnboardJsonReport {
  status: 'ok' | 'failed';
  exit_code: number;
  wallet_id: string | null;
  address: string | null;
  recovery_escrowed: boolean;
  device_registered: boolean;
  observer_started: boolean;
  commons_joined: boolean;
  commons_join_status: 'joined' | 'already_member' | 'skipped' | 'excluded_test' | null;
  link_requested: boolean;
  link_status: 'pending' | 'already_linked' | 'linked' | null;
  /** Human-visible notes only — never the internal `link_request_error:` code. */
  notes: string[];
  /** The plain sentences the human form prints, in order. */
  messages: string[];
  next_step: string | null;
}

const NEXT_STEP_ACCEPT = 'Open Provian on your phone and tap Accept to finish the link.';
const NEXT_STEP_RETRY = 'Generate a fresh code in the Provian app under "Connect an agent" and run onboard again.';
const NEXT_STEP_TRY_LATER = 'Run onboard again later.';
const NEXT_STEP_RUN_AGAIN = 'Run onboard again.';

/** Build the machine report FROM the same outcome decision the human form uses. */
export function buildOnboardJsonReport(result: BootstrapResult): OnboardJsonReport {
  const view = renderBootstrapOutcome(result);
  const messages = [...view.stdout, ...view.stderr].map((l) => l.trim()).filter((l) => l.length > 0);
  const ok = view.exitCode === 0;
  // Only an unfiled link needs a new code: a machine left unregistered resumes on the same one.
  const linkFiled = result.linkStatus === 'already_linked' || result.linkStatus === 'linked' || result.linkRequested;
  return {
    status: ok ? 'ok' : 'failed',
    exit_code: view.exitCode,
    wallet_id: result.walletId,
    address: result.address,
    recovery_escrowed: result.recoveryEscrowed,
    device_registered: result.deviceRegistered,
    observer_started: result.observerStarted,
    commons_joined: result.commonsJoined,
    commons_join_status: result.commonsJoinStatus ?? null,
    link_requested: result.linkRequested,
    link_status: result.linkStatus ?? null,
    notes: result.notes.filter((n) => !n.startsWith('link_request_error:') && n !== 'device_registration_failed'),
    messages,
    next_step: ok
      ? (result.linkStatus === 'already_linked' || result.linkStatus === 'linked' ? null : NEXT_STEP_ACCEPT)
      : (linkFiled ? NEXT_STEP_RUN_AGAIN : NEXT_STEP_RETRY),
  };
}

/** The report for a run that never produced a wallet (bad input, or a fund-safety step threw). */
export function failedOnboardJsonReport(messages: string[], nextStep: string = NEXT_STEP_RETRY): OnboardJsonReport {
  return {
    status: 'failed',
    exit_code: 1,
    wallet_id: null,
    address: null,
    recovery_escrowed: false,
    device_registered: false,
    observer_started: false,
    commons_joined: false,
    commons_join_status: null,
    link_requested: false,
    link_status: null,
    notes: [],
    messages: messages.map((l) => l.trim()).filter((l) => l.length > 0),
    next_step: nextStep,
  };
}

// ---------------------------------------------------------------------------
// The run (side effects injected so the whole entry is unit-testable)
// ---------------------------------------------------------------------------

export interface OnboardIO {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** The orchestrator. Production wires `runAgentBootstrap` — never a local copy. */
  runBootstrap: (input: BootstrapInput, deps: BootstrapDeps) => Promise<BootstrapResult>;
  /** The step wiring. Production wires `defaultBootstrapDeps()` — never a local copy. */
  deps: () => BootstrapDeps;
  /** Asks the relay about the code, ahead of every write. */
  checkCode: (input: { connectionToken: string; relayUrl: string }) => Promise<ConnectionCodeCheck>;
  /** Records this shell's egress environment. The run's first write, once the code may proceed. */
  recordRuntimeEnv: () => void;
  /** Clock for the Genesis offer line (default Date.now). */
  now?: () => number;
}

const MISSING_CODE_LINES = [
  '  No connection code was provided. Generate one in the Provian app under "Connect an agent",',
  '  then run again with PROVIAN_CONNECTION_TOKEN set (or --token), or without --yes/--json to be prompted.',
];

function relayHostOf(relayUrl: string): string {
  try { return new URL(relayUrl).host || relayUrl; } catch { return relayUrl; }
}

/** The actual reason, never a stack: see describeSetupFailure. */
function setupFailure(error: unknown, relayUrl: string, env: NodeJS.ProcessEnv): ReturnType<typeof describeSetupFailure> {
  return describeSetupFailure(error, { relayHost: relayHostOf(relayUrl), proxy: proxyForRelay(env), proxyVar: proxyVarForRelay(env), retry: 'run onboard again' });
}

/** What --json says to do after a run stopped: a new code only when the relay refused the request. */
function nextStepAfter(failure: ReturnType<typeof describeSetupFailure>): string {
  if (failure.kind !== 'relay_http') return NEXT_STEP_RUN_AGAIN;
  return failure.codes.some((c) => c === 'HTTP_429' || /^HTTP_5/.test(c)) ? NEXT_STEP_TRY_LATER : NEXT_STEP_RETRY;
}

/** What a run the code check stopped prints, and what its --json report says to do next. */
function codeRefusal(
  check: Exclude<ConnectionCodeCheck, { verdict: 'proceed' }>,
  relayUrl: string,
  env: NodeJS.ProcessEnv,
): { lines: string[]; nextStep: string } {
  if (check.verdict === 'dead') return { lines: ['', `  ${DEAD_CODE_LINE}`, `  ${FRESH_CODE_LINE}`], nextStep: NEXT_STEP_RETRY };
  if (check.verdict === 'rate_limited') return { lines: ['', '  Too many requests. Please try again later.'], nextStep: NEXT_STEP_TRY_LATER };
  const failure = setupFailure(check.error, relayUrl, env);
  const relayHost = relayHostOf(relayUrl);
  return {
    lines: [
      '',
      '  Provian could not check your invite code just now, so nothing was set up.',
      // An answer that is no ruling may be a filtering proxy's, so advice about the relay's own
      // answer does not fit it. A refusal on this machine sent nothing, so nothing needs allowing.
      ...(check.answered ? [`  The check got no usable answer from ${relayHost}. Wait a few minutes, then run onboard again.`] : failure.lines),
      ...(check.answered || failure.connection ? standingEgressAllowLines(relayHost, '  ') : []),
    ],
    nextStep: NEXT_STEP_RUN_AGAIN,
  };
}

/** Run the onboarding and return the process exit code. */
export async function runOnboard(args: OnboardArgs, io: OnboardIO): Promise<number> {
  if (args.help) {
    io.stdout(usageText());
    return 0;
  }
  if (args.unknown !== undefined) {
    const lines = [`  Unrecognised option: ${args.unknown}`, ''];
    if (args.json) {
      io.stdout(JSON.stringify(failedOnboardJsonReport(lines)));
    } else {
      for (const l of lines) io.stderr(l);
      io.stderr(usageText());
    }
    return 1;
  }

  // The Genesis offer LEADS the run's output while the window is open (stderr, so a
  // --json stdout stays one object). After the window it prints nothing.
  for (const line of genesisOfferLines((io.now ?? Date.now)())) io.stderr(line);

  const interactive = io.isTTY && !args.yes && !args.json;
  const resolved = await resolveConnectionToken({
    flagToken: args.token, env: io.env, interactive, prompt: io.prompt,
  });
  if (!resolved) {
    if (args.json) io.stdout(JSON.stringify(failedOnboardJsonReport(MISSING_CODE_LINES)));
    else for (const l of MISSING_CODE_LINES) io.stderr(l);
    return 1;
  }

  const input: BootstrapInput = {
    connectionToken: resolved.token,
    relayUrl: resolveRelayUrl(args, io.env),
    commonsOptOut: isCommonsOptOut(args, io.env),
    // The Solana address proof is default-on; PROVIAN_SOLANA_PROOF_OPT_OUT=1 declines it.
    ...(/^(1|true|yes)$/i.test(io.env.PROVIAN_SOLANA_PROOF_OPT_OUT ?? '') ? { solanaProofOptOut: true } : {}),
  };

  const check = await io.checkCode({ connectionToken: input.connectionToken, relayUrl: input.relayUrl });
  if (check.verdict !== 'proceed') {
    const { lines, nextStep } = codeRefusal(check, input.relayUrl, io.env);
    if (args.json) io.stdout(JSON.stringify(failedOnboardJsonReport(lines, nextStep)));
    else for (const l of lines) io.stderr(l);
    return 1;
  }
  io.recordRuntimeEnv();

  let result: BootstrapResult;
  try {
    result = await io.runBootstrap(input, io.deps());
  } catch (error) {
    // describeSetupFailure builds its lines from the error's codes and the relay's own message,
    // masks secrets, and gives connection advice only when the network path itself failed.
    const failure = setupFailure(error, input.relayUrl, io.env);
    const lines = ['', ...failure.lines];
    if (args.json) io.stdout(JSON.stringify(failedOnboardJsonReport(lines, nextStepAfter(failure))));
    else for (const l of lines) io.stderr(l);
    return 1;
  }

  if (args.json) {
    const report = buildOnboardJsonReport(result);
    io.stdout(JSON.stringify(report));
    return report.exit_code;
  }

  // The outcome decision ("link did not file → failure, exit 1") is
  // renderBootstrapOutcome's — the SAME one the hosted entrypoint applies.
  const view = renderBootstrapOutcome(result);
  for (const line of view.stdout) io.stdout(line);
  for (const line of view.stderr) io.stderr(line);
  return view.exitCode;
}

async function main(): Promise<void> {
  // (C): same egress handling as the hosted entry — run with the egress env, and
  // record this shell's for the supervised daemon + git hook. `onboard` IS the
  // install command, so every run except --help takes its env from the LIVE shell
  // (the install is authoritative; reviewer defect 3) and never reads the file, so
  // a stale value is never copied back into it. The re-exec for a proxy or an extra
  // CA happens here, because the code check needs that transport; the file itself
  // waits for the check, so a refused code writes nothing. It is rewritten whichever
  // way the code arrives (--token, --code, --token=/--code=, the env, or the hidden
  // prompt; 3), and from a re-executed child too, whose env never merged the file.
  const args = parseOnboardArgs(process.argv.slice(2));
  applyRuntimeEnvAtEntry(args.help ? {} : { recorded: computeRuntimeEnv(process.env) });
  const code = await runOnboard(args, {
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
    // Hidden input, prompt on stderr so `--json` stdout stays a single object.
    prompt: (q) => readSecret(q, process.stdin, process.stderr),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
    // ONE implementation, two entrypoints: exactly what scripts/bootstrap.ts runs.
    runBootstrap: runAgentBootstrap,
    deps: () => defaultBootstrapDeps(),
    checkCode: (input) => checkConnectionCode(input),
    recordRuntimeEnv: () => {
      try { persistRuntimeEnv(process.env); } catch { /* best-effort */ }
    },
  });
  process.exit(code);
}

if (isDirectCliEntry(module)) {
  void main();
}
