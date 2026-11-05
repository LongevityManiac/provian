#!/usr/bin/env node
/**
 * agent-sdk - the npx dispatcher for @provian/agent-sdk.
 *
 * npm exec / npx resolves a multi-bin package by looking for a bin whose name
 * matches the package name with the scope stripped ("agent-sdk"). Without this
 * bin, `npx @provian/agent-sdk <command>` fails with "could not determine
 * executable to run" - and every doc, in-code help string, and relay email
 * template invokes the SDK exactly that way (`npx @provian/agent-sdk
 * register-device --agent-token <token>`, `... request-link --token <t>`).
 *
 * This dispatcher makes the documented form real: it maps the first argument
 * onto the package's OWN bin map (read from package.json at runtime, so new
 * bins are dispatchable with zero changes here) and execs the target script
 * with the remaining args, propagating the exit code.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isDirectCliEntry } from './cli-entry';

/** The dispatcher's own bin name - excluded from the dispatchable commands. */
export const DISPATCHER_BIN = 'agent-sdk';

export interface DispatchRun {
  kind: 'run';
  command: string;
  /** Absolute path to the target script. */
  scriptPath: string;
  /** Args forwarded to the target script (everything after the command). */
  args: string[];
}

export interface DispatchExit {
  kind: 'exit';
  exitCode: number;
  /** Printed to stdout when exitCode is 0, stderr otherwise. */
  message: string;
}

export type DispatchResolution = DispatchRun | DispatchExit;

interface PackageManifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}

/** Read the package manifest that owns this script (dist/scripts -> root). */
export function loadManifest(packageRoot: string): PackageManifest {
  const raw = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

/** The dispatchable command map: every bin except the dispatcher itself. */
export function dispatchableBins(manifest: PackageManifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, rel] of Object.entries(manifest.bin ?? {})) {
    if (name !== DISPATCHER_BIN) out[name] = rel;
  }
  return out;
}

export function buildUsage(manifest: PackageManifest): string {
  const commands = Object.keys(dispatchableBins(manifest)).sort();
  return [
    `Usage: npx ${manifest.name ?? '@provian/agent-sdk'} <command> [options]`,
    '',
    'Commands:',
    ...commands.map((c) => `  ${c}`),
    '',
    'Run any command with --help for its options, e.g.:',
    `  npx ${manifest.name ?? '@provian/agent-sdk'} register-device --help`,
  ].join('\n');
}

/**
 * Pure resolution: argv (already sliced past node + script) -> what to do.
 * Kept side-effect-free so it is unit-testable.
 */
export function resolveDispatch(
  manifest: PackageManifest,
  packageRoot: string,
  argv: string[],
): DispatchResolution {
  const bins = dispatchableBins(manifest);
  const [command, ...rest] = argv;

  if (!command) {
    return { kind: 'exit', exitCode: 1, message: buildUsage(manifest) };
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'exit', exitCode: 0, message: buildUsage(manifest) };
  }
  if (command === '--version' || command === '-v') {
    return { kind: 'exit', exitCode: 0, message: manifest.version ?? 'unknown' };
  }
  const rel = bins[command];
  if (!rel) {
    return {
      kind: 'exit',
      exitCode: 1,
      message: `Unknown command: ${command}\n\n${buildUsage(manifest)}`,
    };
  }
  return {
    kind: 'run',
    command,
    scriptPath: path.resolve(packageRoot, rel),
    args: rest,
  };
}

function main(): void {
  // dist/scripts/dispatch.js -> package root is two levels up.
  const packageRoot = path.resolve(__dirname, '..', '..');
  let resolution: DispatchResolution;
  try {
    resolution = resolveDispatch(loadManifest(packageRoot), packageRoot, process.argv.slice(2));
  } catch (err) {
    console.error(`agent-sdk dispatcher: failed to read package manifest: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  if (resolution.kind === 'exit') {
    (resolution.exitCode === 0 ? console.log : console.error)(resolution.message);
    process.exit(resolution.exitCode);
    return;
  }

  const child = spawn(process.execPath, [resolution.scriptPath, ...resolution.args], {
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`agent-sdk dispatcher: failed to launch ${resolution.command}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Mirror the child's signal-death as a conventional 128+n-style failure.
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (isDirectCliEntry(module)) {
  main();
}
