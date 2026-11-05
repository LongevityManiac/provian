/**
 * harness-tool-vocabulary — the ONE list of tool names a self-report may seal
 * verbatim (review 2: a tool NAME must never carry prose).
 *
 * WHY. On the self-report lanes (the loopback witness endpoint and the MCP
 * report tools) the tool name is written by the agent. "Normalize to a token"
 * was not enough: `refactored billing module for Acme Corp` became
 * `refactored_billing_module_for_Acme_Corp` prose with underscores. So a name
 * is sealed verbatim ONLY when it is a real harness tool name — one of the names
 * the transcript extractors recognise from Claude Code, OpenClaw, Codex, Gemini
 * CLI and Grok Build (the harnesses whose records the daemon reads). Any other
 * name is sealed as `h:` + the first 12 hex of sha256(name): the same name
 * always seals the same token (so counts and repeats stay meaningful), and the
 * text never leaves the device.
 *
 * THE REPORTING APP TOO (review 3). A self-report's `source_app` (and the
 * compute block's `framework`, which carries the same value) is agent-written as
 * well: `refactored billing for acme` slugged to `refactored_billing_for_acme`
 * was prose with underscores again. So `source_app` follows the same rule: a
 * name in the app vocabulary below (harnesses, agent platforms, generic runners)
 * is sealed verbatim as its lowercase slug, anything else as `h:` + 12 hex.
 *
 * ONE DEFINITION, CARRIED BYTE-IDENTICAL. This file lives in the SDK
 * (`provian-agent-sdk/src/observer/`), the relay (`provian-backend/src/mcp/core/`,
 * which the relay's self-report reduction and the hosted MCP tools both import)
 * and the stdio MCP package (`provian-mcp/src/core/`). The packages cannot
 * import one another, so `scripts/check-mcp-tool-parity.mjs` byte-compares the
 * three and `harness-tool-vocabulary-parity.test.ts` (backend) pins them.
 */

import { createHash } from 'crypto';

/** Tool names the harness transcript extractors recognise, sealed verbatim. */
export const HARNESS_TOOL_NAMES: readonly string[] = Object.freeze([
  // Claude Code
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Bash', 'BashOutput',
  'KillShell', 'KillBash', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
  'TodoRead', 'ExitPlanMode', 'SlashCommand', 'Skill', 'AskUserQuestion',
  // OpenClaw
  'read', 'write', 'edit', 'exec', 'process', 'apply_patch', 'browser', 'web_search', 'web_fetch',
  'image', 'message', 'cron', 'canvas', 'nodes', 'sessions_spawn', 'sessions_send', 'sessions_list',
  'sessions_history', 'memory_search', 'memory_get',
  // Codex
  'shell', 'local_shell', 'exec_command', 'write_stdin', 'update_plan', 'view_image',
  // Gemini CLI
  'read_file', 'write_file', 'replace', 'run_shell_command', 'glob', 'search_file_content',
  'list_directory', 'read_many_files', 'google_web_search', 'save_memory', 'write_todos',
  // Grok Build
  'search_replace', 'list_dir', 'run_terminal_command', 'grep', 'todo_write', 'task',
  // Generic
  'fetch', 'search',
]);

const VOCABULARY: ReadonlySet<string> = new Set(HARNESS_TOOL_NAMES);

/**
 * Reporting-app names a self-report may seal verbatim as `source_app` /
 * `compute.framework` — lowercase slugs of the agent harnesses the daemon reads,
 * agent platforms, and generic runners. A label, never a sentence.
 */
export const HARNESS_APP_NAMES: readonly string[] = Object.freeze([
  'local_process',
  // Agent harnesses whose records the daemon reads or witnesses
  'claude-code', 'claude_code', 'claude', 'openclaw', 'codex', 'gemini', 'gemini-cli', 'gemini_cli',
  'grok', 'grok-build', 'grok_build',
  // Other coding / IDE agents
  'cursor', 'windsurf', 'cline', 'roo', 'aider', 'continue', 'copilot', 'goose', 'amp', 'opencode',
  'zed', 'kiro', 'jules', 'devin', 'hermes',
  // Hosted agent platforms
  'chatgpt', 'openai', 'anthropic', 'perplexity', 'venice', 'manus', 'replit',
  // Generic runners
  'sdk', 'cli', 'mcp', 'ci', 'cron', 'script', 'agent',
]);

const APP_VOCABULARY: ReadonlySet<string> = new Set(HARNESS_APP_NAMES);

/** The source_app sealed when none is given. */
export const DEFAULT_SOURCE_APP = 'local_process';

/** A name already sealed as a hash token (`h:` + 12 lowercase hex). */
export const HASHED_TOOL_NAME_RE = /^h:[0-9a-f]{12}$/;

/**
 * The name a self-report seals: a harness tool name verbatim, an already-hashed
 * token as-is, anything else `h:` + the first 12 hex of sha256(trimmed name).
 * Null for a non-string or empty name.
 */
export function sealedToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0) return null;
  if (VOCABULARY.has(name) || HASHED_TOOL_NAME_RE.test(name)) return name;
  return `h:${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * The `source_app` a self-report seals (and its `compute.framework`): the
 * lowercase slug when it is in the app vocabulary, an already-hashed token
 * as-is, anything else `h:` + the first 12 hex of sha256(the full slug).
 * A non-string or empty value is `local_process`.
 */
export function sealedSourceApp(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SOURCE_APP;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_SOURCE_APP;
  if (HASHED_TOOL_NAME_RE.test(trimmed)) return trimmed;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug.length === 0) return DEFAULT_SOURCE_APP;
  if (APP_VOCABULARY.has(slug)) return slug;
  return `h:${createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 12)}`;
}
