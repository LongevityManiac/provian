/**
 * `provian recourse status|join|rejoin|leave|transfers|report|requests` — the generic-CLI
 * front door for the agent's Recourse Pool membership and theft reports. One
 * implementation, two front doors: this delegates to the SDK's recourse-agent module
 * exactly as `npx @provian/agent-sdk@latest recourse …` does, reading the SAME agent
 * keystore directory (default ~/.provian; --directory overrides).
 *
 * Signing uses the encrypted keystore in that directory, never a raw key: membership
 * consent also needs the keystore's encrypted recovery material, and a theft report
 * rotates the agent to a fresh recovery key in that directory. Nothing is signed or
 * submitted without --yes; without it the command prints the terms or the transfer
 * to review. Every amount comes from the signed membership rule, read from Base.
 */
import {
  defaultAgentRecourseDeps,
  loadRecourseIdentity,
  runAgentRecourseCommand,
  RecourseIdentityError,
  type AgentRecourseDeps,
  type RecourseCommandOptions,
} from '@provian/agent-sdk';
import type { CommandResult } from './relay-http';

export const CLI_RECOURSE_COMMAND = (sub: string): string => `provian ${sub}`;

export function defaultRecourseDeps(directory: string | undefined): AgentRecourseDeps {
  return defaultAgentRecourseDeps(loadRecourseIdentity({ directory }), CLI_RECOURSE_COMMAND);
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function whole(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`--${key} must be a whole number above 0`);
  return Number(v);
}

export async function cmdRecourse(
  subcommand: string | null,
  flags: Record<string, string | boolean>,
  makeDeps: (directory: string | undefined) => AgentRecourseDeps = defaultRecourseDeps,
): Promise<CommandResult> {
  if (subcommand === null) {
    return { status: 'error', error: 'Usage: provian recourse status|join|rejoin|leave|transfers|report|requests [options]. Run provian recourse --help.' };
  }
  let options: RecourseCommandOptions;
  try {
    options = { yes: flags.yes === true, tx: str(flags, 'tx'), to: str(flags, 'to'), beforeBlock: whole(flags, 'before'),
      windowBlocks: whole(flags, 'window'), windows: whole(flags, 'windows'), limit: whole(flags, 'limit') };
  } catch (error) {
    return { status: 'error', code: 'USAGE', error: (error as Error).message };
  }
  let deps: AgentRecourseDeps;
  try { deps = makeDeps(str(flags, 'directory')); }
  catch (error) {
    return { status: 'error', code: error instanceof RecourseIdentityError ? error.code : 'NO_AGENT_IDENTITY', error: (error as Error).message };
  }
  const outcome = await runAgentRecourseCommand(subcommand, options, deps);
  return { ...outcome.result, summary: outcome.lines };
}

export function printRecourseHelp(): void {
  console.log(`provian recourse - Your Recourse Pool membership and theft reports

The Recourse Pool is optional membership that restores stolen PVT. Join by approving
once: each month's burn and contribution then happen automatically, with no monthly
signature and no ETH. The amounts are set by the signed membership rule, read from
Base, and shown before you approve. Pool contributions are not refundable. Recourse
records and restores PVT only. Restoration is a discretionary determination of the
pool; until the Court opens, Provian reviews a theft report and decides what the pool
can restore.

Usage:
  provian recourse status                    Membership state, dates, the current rule, any open action
  provian recourse join [--yes]              Show the terms; --yes approves once and joins
  provian recourse rejoin [--yes]            After a lapse: show the unpaid protected months; --yes completes them and rejoins
  provian recourse leave [--yes]             End future burns and contributions
  provian recourse transfers [--before <block>] [--window <blocks>] [--windows <n>] [--limit <n>]
                                             Your finalized outgoing PVT transfers, newest first, read from Base
  provian recourse report --tx <hash> [--to <address>] [--yes]
                                             Report a transfer you did not make
  provian recourse requests                  Your restoration requests and their status

Options:
  --yes              Sign and submit (without it nothing is signed or submitted)
  --directory <dir>  The agent keystore directory (default ~/.provian); the passphrase
                     comes from PROVIAN_KEYSTORE_PASSPHRASE or agent-keystore.secret
`);
}
