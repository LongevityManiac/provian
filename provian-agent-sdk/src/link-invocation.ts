/**
 * link-invocation — which tool CALLS can produce a `link_spend` witness.
 *
 * THE RULE : link_spend mints only from an actual spend, never
 * from an `lsrq_` string appearing in tool output. Before this, the transcript
 * lane ran the Link recognizer over EVERY tool result: `echo '{"id" "lsrq_x",
 * "status" "succeeded",…}'`, a Read of a file, a WebFetch of a page — each became
 * an eligible link_spend, repeatable with a fresh id every time.
 *
 * A recognized record now counts only when the PAIRED tool call (same call id) was
 * an invocation of the Stripe Link CLI's own spend-request surface — the command
 * whose stdout IS the record — and the record's id is the id that invocation
 * named (or, for a create, the id it just minted):
 *
 * - SHELL: a shell/exec tool whose command is exactly ONE simple command —
 * `link-cli …`, `npx [-y] @stripe/link-cli[@v] …` (or pnpm/yarn dlx, bunx,
 * npm exec) — with no pipe, `;`, `&&`/`||`, redirection, command or variable
 * substitution, subshell, background `&`, or newline anywhere outside single
 * quotes. The one exception is a single trailing `2>&1` (stderr → stdout),
 * which cannot inject text that is not the CLI's own output. So `echo … | cat`, `link-cli … > f; cat f`, `cat saved.json` and
 * `echo lsrq_… && link-cli …` never pair: the result must be the CLI's own
 * output, not text piped or composed around it.
 * - MCP: the Link CLI's MCP server tools (`--mcp` / `serve`) for the same
 * spend-request verbs, the id taken from the tool arguments.
 *
 * Verbs: `spend-request retrieve|update|request-approval|cancel <lsrq_id>` (the
 * result id must equal the argument id), `spend-request create` (the result is
 * the freshly created record — any id), and `mpp pay` (`--spend-request-id` must
 * match when given; otherwise the flow created the request itself).
 *
 * The boundary this does NOT cross (stated, not hidden): the daemon reads a
 * transcript the agent's own machine writes. An agent that installs a fake
 * `link-cli` on PATH, or registers its own MCP tool with a Link verb name, is
 * forging its own evidence — the same class as any hand-built body-bound device
 * submission (the explicit `recordLinkSpend` API was removed,). There is no
 * Stripe-side verifier (the relay cannot read a user's Link account). What this
 * closes is the passive path: no ordinary tool output — a file, a web page, an
 * echo, a log — can become a link_spend.
 *
 * PURE: no I/O. The command text is read locally and dropped; only the verb, the
 * transport, and the spend-request id (already a witness field) leave.
 */
import { LINK_SPEND_ID_RE, type LinkSpendWitness } from './link-witness';

export type LinkInvocationVia = 'link_cli' | 'link_mcp';
export type LinkInvocationVerb = 'create' | 'retrieve' | 'update' | 'request_approval' | 'cancel' | 'mpp_pay';

/** A tool call that is a genuine Link spend-request invocation. Content-free. */
export interface LinkSpendInvocation {
  readonly via: LinkInvocationVia;
  readonly verb: LinkInvocationVerb;
  /** The spend-request id the call named; null when the call itself creates one. */
  readonly expectedId: string | null;
}

/** The `metadata.link_spend_binding` value the transcript lane stamps (relay fence). */
export function linkSpendBindingTag(inv: LinkSpendInvocation): string {
  return `${inv.via}:${inv.verb}`;
}

/** Relay-mirrored shape of a binding tag (see provian-backend link-spend-witness.ts). */
export const LINK_SPEND_BINDING_RE = /^link_(cli|mcp):(create|retrieve|update|request_approval|cancel|mpp_pay)$/;

/**
 * Tool names that run a shell command, across the harnesses the transcript lane
 * reads (Claude Code `Bash`, Codex `shell`/`exec_command`/`local_shell`, OpenClaw
 * `exec`/`bash`, Gemini CLI `run_shell_command`, Cursor `run_terminal_cmd`, Cline
 * `execute_command`, OpenHands `execute_bash`, Goose `developer__shell`).
 * Compared lowercased.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash', 'shell', 'sh', 'zsh', 'exec', 'exec_command', 'local_shell', 'shell_command',
  'run_shell_command', 'run_terminal_cmd', 'execute_command', 'execute_bash',
  'terminal', 'developer__shell', 'container.exec',
]);

const SPEND_REQUEST_VERBS: Readonly<Record<string, LinkInvocationVerb>> = {
  create: 'create',
  retrieve: 'retrieve',
  update: 'update',
  'request-approval': 'request_approval',
  cancel: 'cancel',
};

/** Link CLI global options that consume the following token as their value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--format', '--auth', '--filter-output', '--token-limit', '--token-offset',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Tokenize ONE simple POSIX shell command into argv, or null when the text is
 * anything more than a single command: an unquoted `|`, `&`, `;`, `<`, `>`, `(`,
 * `)`, backtick, `$`, `#` comment or newline; a `$` or backtick inside double
 * quotes (substitution); a trailing backslash; or an unterminated quote.
 * Single-quoted text is literal. Conservative by design — an unusual but
 * harmless command merely fails to pair (records nothing), never the reverse.
 */
export function tokenizeSimpleCommand(script: string): string[] | null {
  if (typeof script !== 'string' || script.length === 0 || script.length > 16_384) return null;
  const argv: string[] = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i];
    if (ch === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += script.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        const c = script[i];
        if (c === '"') { closed = true; i += 1; break; }
        if (c === '$' || c === '`') return null;
        if (c === '\\') {
          const next = script[i + 1];
          if (next === undefined) return null;
          if (next === '"' || next === '\\' || next === '$' || next === '`') { cur += next; i += 2; continue; }
          if (next === '\n') return null;
          cur += c;
          i += 1;
          continue;
        }
        cur += c;
        i += 1;
      }
      if (!closed) return null;
      inToken = true;
      continue;
    }
    if (ch === '\\') {
      const next = script[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      cur += next;
      inToken = true;
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) { argv.push(cur); cur = ''; inToken = false; }
      i += 1;
      continue;
    }
    if ('|&;<>()`$\n\r'.includes(ch)) return null;
    if (ch === '#' && !inToken) return null;
    cur += ch;
    inToken = true;
    i += 1;
  }
  if (inToken) argv.push(cur);
  return argv.length > 0 ? argv : null;
}

/**
 * Exactly ONE trailing ` 2>&1` (stderr merged into stdout) is allowed: agents
 * routinely run `link-cli … --format json 2>&1` so a CLI error is visible, and
 * the merge cannot inject any text that is not the CLI's own output. Nothing else
 * is stripped — any other redirection, a second merge, or `2>&1` anywhere but the
 * very end still refuses the pairing in `tokenizeSimpleCommand`.
 */
export function withoutTrailingStderrMerge(script: string): string {
  const trimmed = script.trim();
  const m = /^(.*\S)\s+2>&1$/s.exec(trimmed);
  return m ? m[1] : trimmed;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LINK_PACKAGE_RE = /^@stripe\/link-cli(@[A-Za-z0-9._\-^~]+)?$/;

/** Strip `link-cli` / package-runner prefixes; returns the args after the CLI, or null. */
function linkCliArgs(argv: readonly string[]): string[] | null {
  let i = 0;
  while (i < argv.length && ENV_ASSIGN_RE.test(argv[i])) i += 1;
  const head = argv[i];
  if (head === undefined) return null;
  const base = head.split('/').pop() ?? head;
  if (base === 'link-cli') return argv.slice(i + 1);
  // Package runners: npx [-y|--yes|-q|--quiet] @stripe/link-cli[@v]; pnpm|yarn dlx; bunx; npm exec [--yes] [--].
  let j = i + 1;
  if (base === 'npx' || base === 'bunx') {
    // runner itself
  } else if ((base === 'pnpm' || base === 'yarn') && argv[j] === 'dlx') {
    j += 1;
  } else if (base === 'npm' && (argv[j] === 'exec' || argv[j] === 'x')) {
    j += 1;
  } else {
    return null;
  }
  while (j < argv.length && ['-y', '--yes', '-q', '--quiet', '--silent', '--'].includes(argv[j])) j += 1;
  if (j >= argv.length || !LINK_PACKAGE_RE.test(argv[j])) return null;
  j += 1;
  if (argv[j] === '--') j += 1;
  return argv.slice(j);
}

/** Parse the Link CLI's own arguments into an invocation (shell transport). */
export function linkInvocationFromArgv(argv: readonly string[]): LinkSpendInvocation | null {
  const args = linkCliArgs(argv);
  if (!args) return null;
  const positionals: string[] = [];
  let spendRequestIdOpt: string | null = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a.startsWith('--spend-request-id=')) { spendRequestIdOpt = a.slice('--spend-request-id='.length); continue; }
    if (a === '--spend-request-id') { spendRequestIdOpt = args[k + 1] ?? ''; k += 1; continue; }
    if (a.startsWith('-')) {
      if (VALUE_OPTIONS.has(a)) k += 1;
      continue;
    }
    positionals.push(a);
  }
  const [group, verbRaw, idArg] = positionals;
  if (group === 'spend-request') {
    const verb = verbRaw !== undefined ? SPEND_REQUEST_VERBS[verbRaw] : undefined;
    if (!verb) return null;
    if (verb === 'create') return { via: 'link_cli', verb, expectedId: null };
    if (idArg === undefined || !LINK_SPEND_ID_RE.test(idArg)) return null;
    return { via: 'link_cli', verb, expectedId: idArg };
  }
  if (group === 'mpp' && verbRaw === 'pay') {
    if (spendRequestIdOpt === null) return { via: 'link_cli', verb: 'mpp_pay', expectedId: null };
    return LINK_SPEND_ID_RE.test(spendRequestIdOpt)
      ? { via: 'link_cli', verb: 'mpp_pay', expectedId: spendRequestIdOpt }
      : null;
  }
  return null;
}

/** The command a shell tool call ran: a script string, or an argv array. */
function shellCommandOf(input: Record<string, unknown>): { script: string } | { argv: string[] } | null {
  const raw = input.command ?? input.cmd ?? input.argv;
  if (typeof raw === 'string') return { script: raw.trim() };
  if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')) {
    const arr = raw as string[];
    // ["bash","-lc","<script>"] / ["sh","-c","<script>"] → the script is the command.
    const shellBase = (arr[0].split('/').pop() ?? arr[0]);
    if (['bash', 'sh', 'zsh', 'dash'].includes(shellBase) && arr.length === 3 && /^-l?c$|^-cl$/.test(arr[1])) {
      return { script: arr[2].trim() };
    }
    return { argv: arr };
  }
  return null;
}

/** Normalize an MCP tool name: drop a harness `mcp__<server>__` / `<server>__` prefix; `-`/`.` → `_`. */
function mcpToolBaseName(toolName: string): string {
  let n = toolName.toLowerCase();
  const dbl = n.lastIndexOf('__');
  if (dbl >= 0) n = n.slice(dbl + 2);
  return n.replace(/[-.\s/]/g, '_');
}

const MCP_VERBS: Readonly<Record<string, LinkInvocationVerb>> = {
  spend_request_create: 'create',
  spend_request_retrieve: 'retrieve',
  spend_request_update: 'update',
  spend_request_request_approval: 'request_approval',
  spend_request_cancel: 'cancel',
  mpp_pay: 'mpp_pay',
};

/**
 * Classify one tool CALL: a Link spend-request invocation, or null. `input` is the
 * call's argument object (a JSON string is parsed tolerantly).
 */
export function linkSpendInvocationFromToolCall(toolName: string, input: unknown): LinkSpendInvocation | null {
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  let args: unknown = input;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  const lower = toolName.toLowerCase();
  if (SHELL_TOOL_NAMES.has(lower)) {
    if (!isRecord(args)) return null;
    const cmd = shellCommandOf(args);
    if (!cmd) return null;
    const argv = 'argv' in cmd ? cmd.argv : tokenizeSimpleCommand(withoutTrailingStderrMerge(cmd.script));
    return argv ? linkInvocationFromArgv(argv) : null;
  }
  const verb = MCP_VERBS[mcpToolBaseName(toolName)];
  if (!verb) return null;
  const a = isRecord(args) ? args : {};
  if (verb === 'create') return { via: 'link_mcp', verb, expectedId: null };
  if (verb === 'mpp_pay') {
    const id = a.spend_request_id ?? a.spendRequestId;
    if (id === undefined) return { via: 'link_mcp', verb, expectedId: null };
    return typeof id === 'string' && LINK_SPEND_ID_RE.test(id) ? { via: 'link_mcp', verb, expectedId: id } : null;
  }
  const id = a.id ?? a.spend_request_id ?? a.spendRequestId;
  return typeof id === 'string' && LINK_SPEND_ID_RE.test(id) ? { via: 'link_mcp', verb, expectedId: id } : null;
}

/**
 * The pairing gate: a recognized record becomes a witness ONLY when its paired
 * call was a Link invocation and the ids agree. Anything else → null.
 */
export function pairLinkSpend(
  invocation: LinkSpendInvocation | null | undefined,
  candidate: LinkSpendWitness | null | undefined,
): LinkSpendWitness | null {
  if (!invocation || !candidate) return null;
  if (invocation.expectedId !== null && invocation.expectedId !== candidate.link_spend_id) return null;
  return candidate;
}
