/**
 * Runtime detection for `provian init`.
 *
 * The connector is runtime-adaptive, not runtime-specific: we never ship a
 * per-agent package. We read a few environment signals to pick the most
 * helpful wiring to print, and fall back to plain instructions whenever the
 * environment is ambiguous. Detection is pure and side-effect free (the
 * filesystem and environment are injected) so it is trivially testable and
 * never blocks the link on a wrong guess.
 *
 * Two channels:
 *   - `cli`: the agent reaches the wallet by shelling out to `provian`
 *            (works for any runtime that can run a command).
 *   - `sdk`: the agent imports @provian/agent-sdk in-process (code agents).
 */

export type RuntimeId = 'claude-code' | 'node-sdk' | 'python' | 'cli';

export type RuntimeChannel = 'cli' | 'sdk';

export interface RuntimeWiring {
  /** Stable identifier for the detected runtime. */
  id: RuntimeId;
  /** Human-facing label for the detected runtime. */
  label: string;
  /** How the agent will reach the wallet afterwards. */
  channel: RuntimeChannel;
  /**
   * 'high' when a strong signal was found. 'low' when we are guessing — the
   * wizard then leans on printed instructions rather than writing runtime
   * specific wiring it is not sure about.
   */
  confidence: 'high' | 'low';
  /** Human-readable reasons the runtime was chosen (shown in --json output). */
  signals: string[];
}

/**
 * Injected view of the world so detection stays pure and testable.
 */
export interface DetectContext {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Returns true if a path relative to cwd exists. */
  fileExists: (relativePath: string) => boolean;
}

function truthyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Pick the most helpful wiring for the current environment.
 *
 * Order matters: a strong, specific signal wins over a generic one. The final
 * branch is always the universal `cli` fallback, marked low-confidence so the
 * caller knows to prefer printed instructions.
 */
export function detectRuntime(ctx: DetectContext): RuntimeWiring {
  // Claude Code / OpenClaw style runtimes that can run hooks and shell
  // commands. These reach the wallet through the `provian` command.
  if (truthyEnv(ctx.env.CLAUDECODE) || truthyEnv(ctx.env.CLAUDE_CODE)) {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      channel: 'cli',
      confidence: 'high',
      signals: ['CLAUDECODE environment variable set'],
    };
  }

  // A JavaScript/TypeScript project can import the SDK in-process. Prefer the
  // code-level snippet for these.
  if (ctx.fileExists('package.json')) {
    return {
      id: 'node-sdk',
      label: 'Node.js / TypeScript project',
      channel: 'sdk',
      confidence: 'high',
      signals: ['package.json found in the current directory'],
    };
  }

  // Python projects have no in-process SDK; they shell out to `provian`.
  if (ctx.fileExists('pyproject.toml') || ctx.fileExists('requirements.txt') || ctx.fileExists('setup.py')) {
    const marker = ctx.fileExists('pyproject.toml')
      ? 'pyproject.toml'
      : ctx.fileExists('requirements.txt')
        ? 'requirements.txt'
        : 'setup.py';
    return {
      id: 'python',
      label: 'Python project',
      channel: 'cli',
      confidence: 'high',
      signals: [`${marker} found in the current directory`],
    };
  }

  // Universal fallback: any runtime that can run a command can call `provian`.
  // Low confidence is the signal to the wizard that it should print generic
  // instructions rather than assume a specific framework.
  return {
    id: 'cli',
    label: 'generic command-line agent',
    channel: 'cli',
    confidence: 'low',
    signals: ['no specific runtime signal found; defaulting to the portable CLI path'],
  };
}
