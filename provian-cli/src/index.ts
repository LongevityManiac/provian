/**
 * @provian/cli
 *
 * The generic `provian` command-line tool. Connect an agent to a Provian
 * wallet and report actions as Provenance Envelopes. Self-describing via
 * `provian --help`; any agent runtime that can call a command can use it.
 *
 * For code-level integration, import `ProvianClient` from `@provian/agent-sdk`
 * instead.
 */

export { run } from './cli/commands';
export type { SessionData } from './cli/session';
export type { ParsedArgs } from './cli/parse-args';
