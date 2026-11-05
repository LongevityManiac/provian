#!/usr/bin/env node
/**
 * npx @provian/agent-sdk run -- <agent cmd> [args…]
 *
 * Lever 2: the GUARANTEED, launch-mode-independent fallback for OTel tool-call
 * capture. It execs the given command with OTEL_EXPORTER_OTLP_ENDPOINT injected
 * into ITS OWN environment, so any OTel-emitting agent exports to the local
 * observer receiver no matter how it would otherwise be launched (a login shell,
 * launchd, systemd, cron, a supervisor). This is the recommended path for a
 * headless agent that the session-wide publish (Lever 1) cannot reach — e.g. a
 * root LaunchDaemon in a different session, or an agent that was already running.
 *
 * It NEVER overrides an endpoint the caller already set (respecting an explicit
 * collector), inherits stdio, and forwards the child's exit code / signal so it
 * is a transparent wrapper.
 *
 *   npx @provian/agent-sdk run -- python my_agent.py
 *   npx @provian/agent-sdk run -- ./openclaw --serve
 */

import { spawn } from 'child_process';
import { OTLP_DEFAULT_PORT } from '../observer/plugins/OTelPlugin';
import { SESSION_OTEL_ENV_KEY } from '../observer/service';
import { isDirectCliEntry } from './cli-entry';

function printUsage(): void {
  console.log(`
Usage: npx @provian/agent-sdk run [--] <command> [args…]

Runs <command> with ${SESSION_OTEL_ENV_KEY}=http://localhost:${OTLP_DEFAULT_PORT}
injected into its environment, so an OTel-emitting agent exports its tool/API
spans to the local Provian observer receiver regardless of how it is launched.

An endpoint the caller already set is respected (not overridden).

Examples:
  npx @provian/agent-sdk run -- python my_agent.py
  npx @provian/agent-sdk run -- ./openclaw --serve
`);
}

/**
 * Split the wrapper's own argv from the child command. Accepts an optional
 * leading `--` separator. Pure + exported for unit testing.
 * Returns null when there is no command to run.
 */
export function parseRunArgs(argv: string[]): { command: string; args: string[] } | null {
  let rest = argv;
  if (rest[0] === '--') rest = rest.slice(1);
  if (rest.length === 0) return null;
  return { command: rest[0], args: rest.slice(1) };
}

/**
 * Build the child environment: the parent env plus the OTLP endpoint, but only
 * when the caller has not already set one. Pure + exported for unit testing.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  port: number = OTLP_DEFAULT_PORT,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  if (!env[SESSION_OTEL_ENV_KEY]) {
    env[SESSION_OTEL_ENV_KEY] = `http://localhost:${port}`;
  }
  return env;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const parsed = parseRunArgs(argv);
  if (!parsed) {
    printUsage();
    process.exit(1);
  }

  const child = spawn(parsed.command, parsed.args, {
    stdio: 'inherit',
    env: buildChildEnv(process.env),
  });

  // Forward the common termination signals so `npx @provian/agent-sdk run` is transparent to a
  // supervisor that signals it (Ctrl-C, SIGTERM from launchd/systemd).
  const forward = (sig: NodeJS.Signals) => {
    try { child.kill(sig); } catch { /* child already gone */ }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGHUP', () => forward('SIGHUP'));

  child.on('error', (err) => {
    console.error(`agent-sdk run: failed to launch ${parsed.command}: ${err.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the child's signal on ourselves so the parent sees the true
      // cause of death; fall back to 128+n-style exit if re-raise is a no-op.
      process.kill(process.pid, signal);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

if (isDirectCliEntry(module)) {
  main();
}
