#!/usr/bin/env node
/**
 * recourse — the agent's Recourse Pool membership and theft reports, from its shell.
 *
 * Usage (npm: `npx @provian/agent-sdk@latest recourse <sub>`; hosted: `"$HOME/.provian/bin/provian" recourse <sub>`):
 *   recourse status                      membership state, dates, the current rule, any open action
 *   recourse join [--yes]                show the terms; --yes approves once and joins
 *   recourse rejoin [--yes]              after a lapse: show the unpaid protected months; --yes completes them and rejoins
 *   recourse leave [--yes]               end future burns and contributions
 *   recourse transfers [--before <block>] [--window <blocks>] [--windows <n>] [--limit <n>]
 *   recourse report --tx <hash> [--to <address>] [--yes]
 *   recourse requests                    your restoration requests and their status
 * Every subcommand takes --json and --directory <keystore dir> (default ~/.provian).
 *
 * The signing subcommands use the agent's encrypted keystore in that directory
 * (passphrase from PROVIAN_KEYSTORE_PASSPHRASE or agent-keystore.secret) — never
 * a raw key on the command line or in the environment. Nothing is signed or
 * submitted without --yes.
 */
import { isDirectCliEntry } from './cli-entry';
import { cliCommand } from '../cli-command';
import {
  defaultAgentRecourseDeps, loadRecourseIdentity, runAgentRecourseCommand, RecourseIdentityError,
  type AgentRecourseDeps, type RecourseCommandOptions, type RecourseCommandOutcome,
} from '../recourse-agent';

export interface ParsedRecourseArgs {
  readonly sub: string | null; readonly help: boolean; readonly json: boolean; readonly directory?: string;
  readonly options: RecourseCommandOptions;
}
export class RecourseUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'RecourseUsageError'; }
}

const VALUE_FLAGS = new Set(['directory', 'tx', 'to', 'before', 'window', 'windows', 'limit']);
const BOOL_FLAGS = new Set(['yes', 'json', 'help']);

function whole(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RecourseUsageError(`--${name} must be a whole number above 0`);
  return Number(value);
}

export function parseRecourseArgs(argv: readonly string[]): ParsedRecourseArgs {
  let sub: string | null = null;
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { bools.add('help'); continue; }
    if (!a.startsWith('--')) {
      if (sub !== null) throw new RecourseUsageError(`Unexpected argument: ${a}`);
      sub = a; continue;
    }
    const body = a.slice(2), eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    if (BOOL_FLAGS.has(key) && eq === -1) { bools.add(key); continue; }
    if (!VALUE_FLAGS.has(key)) throw new RecourseUsageError(`Unknown option: --${key}`);
    const value = eq !== -1 ? body.slice(eq + 1) : argv[++i];
    if (value === undefined || value.length === 0 || (eq === -1 && value.startsWith('--'))) throw new RecourseUsageError(`--${key} needs a value`);
    values[key] = value;
  }
  return { sub: sub === 'help' ? null : sub, help: bools.has('help') || sub === 'help', json: bools.has('json'), directory: values.directory,
    options: { yes: bools.has('yes'), tx: values.tx, to: values.to, beforeBlock: whole('before', values.before),
      windowBlocks: whole('window', values.window), windows: whole('windows', values.windows), limit: whole('limit', values.limit) } };
}

export function recourseHelp(command: (sub: string) => string = cliCommand): string[] {
  return [
    `Usage: ${command('recourse <subcommand> [options]')}`,
    '',
    'The Recourse Pool: optional membership that restores stolen PVT. Join by approving once; each month\'s',
    'burn and contribution then happen automatically, with no monthly signature and no ETH. The amounts are set',
    'by the signed membership rule and are shown before you approve.',
    '',
    'Subcommands:',
    '  status                               Your membership state, dates, the current rule and any open action',
    '  join [--yes]                         Show the terms; --yes approves once and joins',
    '  rejoin [--yes]                       After a lapse: show the unpaid protected months; --yes completes them and rejoins',
    '  leave [--yes]                        End future burns and contributions (contributions are not refundable)',
    '  transfers [--before <block>] [--window <blocks>] [--windows <n>] [--limit <n>]',
    '                                       Your finalized outgoing PVT transfers, newest first, read from Base',
    '  report --tx <hash> [--to <address>] [--yes]',
    '                                       Report a transfer you did not make; --yes submits the restoration request',
    '  requests                             Your restoration requests and their status',
    '',
    'Options:',
    '  --yes                 Sign and submit (without it nothing is signed or submitted)',
    '  --json                Print one JSON object',
    '  --directory <dir>     The agent keystore directory (default ~/.provian)',
  ];
}

export interface RecourseCliIo { stdout(line: string): void; stderr(line: string): void }
const CONSOLE_IO: RecourseCliIo = { stdout: line => console.log(line), stderr: line => console.error(line) };

/** The recourse CLI body (the npm bin and the hosted bundle's `recourse` verb). Returns the exit code. */
export async function runRecourseCli(argv: readonly string[] = process.argv.slice(2), io: RecourseCliIo = CONSOLE_IO,
  makeDeps: (directory: string | undefined) => AgentRecourseDeps = directory =>
    defaultAgentRecourseDeps(loadRecourseIdentity({ directory }), cliCommand)): Promise<number> {
  let parsed: ParsedRecourseArgs;
  try { parsed = parseRecourseArgs(argv); }
  catch (error) { io.stderr((error as Error).message); for (const line of recourseHelp()) io.stderr(line); return 2; }
  if (parsed.help || parsed.sub === null) { for (const line of recourseHelp()) (parsed.help ? io.stdout : io.stderr)(line); return parsed.help ? 0 : 2; }
  let outcome: RecourseCommandOutcome;
  try {
    outcome = await runAgentRecourseCommand(parsed.sub, parsed.options, makeDeps(parsed.directory));
  } catch (error) {
    const code = error instanceof RecourseIdentityError ? error.code : 'recourse_failed';
    outcome = { exitCode: 1, result: { status: 'error', code, error: (error as Error).message }, lines: [(error as Error).message] };
  }
  if (parsed.json) (outcome.exitCode === 0 ? io.stdout : io.stderr)(JSON.stringify(outcome.result));
  else for (const line of outcome.lines) (outcome.exitCode === 0 ? io.stdout : io.stderr)(line);
  return outcome.exitCode;
}

if (isDirectCliEntry(module)) {
  void runRecourseCli().then(code => { process.exitCode = code; });
}
