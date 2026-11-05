/**
 * Minimal CLI Argument Parser
 *
 * No external dependencies. Handles --flag value pairs and --boolean flags.
 */

export interface ParsedArgs {
  command: string;
  /**
   * First bare (non-flag) token after the command that was not consumed as a
   * flag value — e.g. `provian connect github` → command 'connect',
   * subcommand 'github'. Null when absent.
   */
  subcommand: string | null;
  /** Every bare token after the command, in order (the subcommand is the first). */
  positionals: string[];
  flags: Record<string, string | boolean>;
  /**
   * Every string value each flag received, in argv order. `flags` keeps the
   * last value (the historical behavior); a verb that accepts a repeatable
   * flag (e.g. `--predicate a>=1 --predicate b<2`, `--pe id:hash --pe …`)
   * reads the full list here.
   */
  lists: Record<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node and script path
  const command = args[0] && !args[0].startsWith('--') ? args[0] : '';
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const pushList = (key: string, value: string): void => {
    (lists[key] ??= []).push(value);
  };
  let subcommand: string | null = null;
  const positionals: string[] = [];

  for (let i = command ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      // A bare token here was NOT consumed as a --flag value (those are
      // swallowed by the flag branch below via i++), so it is a subcommand.
      if (subcommand === null) subcommand = arg;
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      // Support both `--key=value` and `--key value`. Every in-CLI --help
      // example uses the `=` form, which previously parsed as a boolean flag
      // named "key=value" (so e.g. --currency=pvt left flags.currency undefined
      // and the command errored "Missing or invalid --currency").
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        pushList(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const key = body;
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        pushList(key, next);
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, subcommand, positionals, flags, lists };
}
