#!/usr/bin/env node
/**
 * npx @provian/agent-sdk start — the ONE interactive command that shepherds a user from nothing
 * to CONFIRMED tool-call capture, and does not declare success until it is
 * proven. Each program has exactly one witness lane — its own session records
 * if it keeps them (zero harness changes), otherwise the local model proxy,
 * otherwise OTel, otherwise, on an agent's own machine with none of those, the
 * process lane (each command it runs, read from the OS,) — and this
 * wizard's job is to PROVE the program's lane is actually working, because silent
 * zero-capture is the failure mode that hid the Atlas gap.
 *
 * One terminal session:
 * [1/4] Wallet + device — onboard (observer + receiver up, endpoint published,
 * git commits already capturing). Reuses `register-device`.
 * [2/4] Detect the harness — process scan; confirm or note it.
 * [3/4] Guide the ONE enable step for THAT harness (copy-paste ready), then
 * pause for the human to add it.
 * [4/4] PROVE it — `npx @provian/agent-sdk doctor` synthetic span → PE (Provian side), then
 * watch for the user's REAL spans → GREEN, or RED with the exact next
 * step. Loop until GREEN.
 *
 * Two audiences, same command:
 * • Human developer (interactive default): prompts, pauses, loops to GREEN.
 * • Autonomous agent (`--yes` / `--json`): NEVER blocks on a prompt. `--json`
 * emits a structured report (status + next_step + next_command + enable_steps)
 * on stdout so an orchestrator can act; a remaining manual step is RETURNED,
 * never waited on.
 *
 * `register-device` (non-interactive onboarding) and `doctor` (the verifier) stay
 * usable standalone; this wizard composes them.
 */

import { createInterface } from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadCredentials } from './credentials';
import { isObserverRunning } from '../observer/service';
import { detectAgentHarness } from '../observer/plugins/OTelPlugin';
import { readPrograms } from '../observer/program-witness';
import { witnessSetupLines } from '../witness-setup';
import { harnessEnableGuidance, type HarnessTier } from './harness-guidance';
import { runDoctor, renderReportLines, type DoctorReport } from './doctor';
import { probeLocalInferenceRuntimes, describeLocalInferenceProbe } from '../observer/plugins/local-inference/runtimes';
import { isDirectCliEntry } from './cli-entry';

// ---------------------------------------------------------------------------
// Arg parsing (pure — exported for testing)
// ---------------------------------------------------------------------------

export interface StartArgs {
  json: boolean;
  yes: boolean;
  help: boolean;
  /** Force a specific harness (overrides auto-detect). */
  harness?: string;
  /** Args forwarded to register-device (start-only flags stripped). */
  passthrough: string[];
}

/** Flags consumed by start itself and NOT forwarded to register-device. */
const START_ONLY_FLAGS = new Set(['--json', '--harness', '--skip-onboard']);

export function parseStartArgs(argv: string[]): StartArgs {
  const out: StartArgs = { json: false, yes: false, help: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--yes' || a === '-y') { out.yes = true; out.passthrough.push('--yes'); }
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--harness' && argv[i + 1]) { out.harness = argv[++i]; }
    else if (a === '--skip-onboard') { /* start-only; consumed */ }
    else if (!START_ONLY_FLAGS.has(a)) out.passthrough.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structured report (the --json contract)
// ---------------------------------------------------------------------------

export interface StartReport {
  status: 'green' | 'red';
  onboarded: boolean;
  detected_harness: string | null;
  harness_tier: HarnessTier;
  enable_steps: string[];
  doctor: DoctorReport | null;
  next_step: string | null;
  next_command: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSiblingScript(name: string): string | null {
  const p = path.resolve(__dirname, `${name}.js`);
  return fs.existsSync(p) ? p : null;
}

/** Run register-device as a child, inheriting stdio. Returns its exit code. */
function runRegisterDevice(passthrough: string[]): number {
  const script = resolveSiblingScript('register-device');
  if (!script) {
    // Fall back to the published bin via npx if the sibling isn't on disk.
    const r = spawnSync('npx', ['@provian/agent-sdk', 'register-device', ...passthrough], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  const r = spawnSync(process.execPath, [script, ...passthrough], { stdio: 'inherit' });
  return r.status ?? 1;
}

function isOnboarded(): boolean {
  return loadCredentials() != null;
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

export async function runStart(args: StartArgs): Promise<StartReport> {
  // Interactive only when a real TTY is present AND neither machine mode is set.
  const interactive = Boolean(process.stdin.isTTY) && !args.json && !args.yes;
  const say = (line: string) => process.stderr.write(`${line}\n`);

  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stderr })
    : null;
  const pause = async (question: string): Promise<string> => {
    if (!rl) return '';
    return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
  };

  try {
    // ---- [1/4] Wallet + device -------------------------------------------
    say('');
    say('  [1/4] Wallet + device');
    let onboarded = isOnboarded();
    if (onboarded) {
      say('    Already registered. The observer + OTLP receiver are set up and git commits capture automatically.');
    } else if (args.json) {
      // Machine path: onboarding must be done first (keeps stdout clean for JSON).
      say('    Not registered. Onboard non-interactively first, then re-run.');
    } else {
      say('    Registering this device (observer + receiver + endpoint publish, git-commit capture)…');
      const code = runRegisterDevice(args.passthrough);
      onboarded = isOnboarded();
      if (code !== 0 && !onboarded) {
        say('    Registration did not complete. Fix the error above and re-run `npx @provian/agent-sdk start`.');
      }
    }

    if (!onboarded) {
      const report: StartReport = {
        status: 'red',
        onboarded: false,
        detected_harness: args.harness ?? detectAgentHarness(),
        harness_tier: harnessEnableGuidance(args.harness ?? detectAgentHarness()).tier,
        enable_steps: [],
        doctor: null,
        next_step: 'Register this device, then re-run `npx @provian/agent-sdk start`.',
        next_command: 'npx @provian/agent-sdk register-device --yes',
      };
      return report;
    }

    if (isObserverRunning()) {
      say('    Observer is running.');
    } else {
      say('    Note: the observer is not running yet — it starts at registration and at login; `npx @provian/agent-sdk observe` starts it now.');
    }

    // ---- [2/4] Detect the harness ----------------------------------------
    say('');
    say('  [2/4] Detect your harness');
    // Session records found on disk are captured automatically — say so first.
    const transcriptSources = readPrograms().filter(p => p.lane === 'transcript').map(p => p.program);
    for (const line of witnessSetupLines()) say('    ' + line);
    if (transcriptSources.length > 0) {
      say(`    Found session records on disk: ${transcriptSources.join(', ')} — these described session witnesses stay fixed across sign-in changes.`);
    }
    // Zero-config local inference (Ollama / LM Studio / llama.cpp): witnessed
    // by the observer with no setup; say what was found on this machine.
    try {
      const inference = await probeLocalInferenceRuntimes({ timeoutMs: 750 });
      say(`    Local inference: ${describeLocalInferenceProbe(inference)}`);
      if (inference.detected) say('    Local model work is witnessed as inference_session PEs automatically.');
    } catch { /* advisory only */ }
    let harness: string | null = args.harness ?? detectAgentHarness() ?? transcriptSources[0] ?? null;
    if (harness) {
      say(`    Harness: ${harness}`);
    } else if (interactive) {
      say('    No known harness detected. If you know it, type its name (e.g. langchain, crewai, openclaw), or press Enter to see both paths.');
      const answer = await pause('    Harness name (optional): ');
      harness = answer || null;
    } else {
      say('    No known harness detected — returning guidance for both paths.');
    }
    const guidance = harnessEnableGuidance(harness);

    // ---- [3/4] The enable step (often: nothing to do) --------------------
    say('');
    say(`  [3/4] Tool-call capture for ${guidance.label}`);
    say(`    ${guidance.summary}`);
    for (const line of guidance.steps) say(`    ${line}`);
    if (interactive && guidance.tier !== 'tier1') {
      say('');
      await pause('    Run one agent turn (a tool call or two) in your harness, then press Enter to verify… ');
    } else if (interactive) {
      say('');
      await pause('    Enable your framework\'s OTel instrumentation above, run one turn with one or more tool calls, then press Enter to verify… ');
    }

    // ---- [4/4] PROVE it --------------------------------------------------
    say('');
    say('  [4/4] Verify capture end-to-end');
    let report = await runDoctor({ logSink: (l) => say(`    ${l}`) });
    if (!args.json) {
      for (const line of renderReportLines(report)) say(line);
    }

    // Interactive: loop until GREEN (or the user stops).
    while (interactive && report.status !== 'green') {
      const answer = await pause('    Press Enter to re-check, or type "skip" to stop: ');
      if (answer.toLowerCase() === 'skip') break;
      report = await runDoctor({ logSink: (l) => say(`    ${l}`) });
      for (const line of renderReportLines(report)) say(line);
    }

    return {
      status: report.status,
      onboarded: true,
      detected_harness: harness,
      harness_tier: guidance.tier,
      enable_steps: guidance.steps,
      doctor: report,
      next_step: report.next_step,
      next_command: report.next_command,
    };
  } finally {
    if (rl) rl.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseStartArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Usage: npx @provian/agent-sdk start [options]

The guided, one-terminal-session setup for Provian tool-call capture:
onboard → detect your harness → enable the one emission step → PROVE capture.
It won't declare success until capture is confirmed.

Options:
  --yes, -y        Non-interactive: never pause on a prompt. Onboards with --yes
                   and runs the verifier once. For CI / headless boxes.
  --json           Machine-readable report on stdout (status, next_step,
                   next_command, enable_steps); progress on stderr. For
                   autonomous agents. Assumes onboarding is already done.
  --harness <name> Force a specific harness (langchain, crewai, openclaw, …)
                   instead of auto-detecting.
  --help, -h       Show this help.

Any other flags (e.g. --agent, --api-key, --token) are forwarded to
register-device during onboarding.
`);
    process.exit(0);
  }

  const report = await runStart(args);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (report.status === 'green') {
    process.stderr.write('\n  All set — capture is confirmed. Your agent is earning from tool calls.\n\n');
  } else {
    process.stderr.write('\n  Not confirmed yet. Follow the next step above and re-run `npx @provian/agent-sdk start` (or `npx @provian/agent-sdk doctor`).\n\n');
  }
  process.exit(report.status === 'green' ? 0 : 1);
}

if (isDirectCliEntry(module)) {
  main().catch((err) => {
    console.error(`Unexpected error: ${err}`);
    process.exit(1);
  });
}
