/**
 * Tells the agent when this local MCP server is behind the published one.
 *
 * The relay advertises the latest published @provian/mcp at `GET /v1/mcp/version`.
 * The local server compares it with its own running version (PROVIAN_MCP_VERSION)
 * and, when it is older, adds one line to every tool result naming the latest
 * version and the launch line that runs it. Advisory and fail-open, like the SDK's
 * staleness signal: a failed or slow check only means no line, never a blocked tool.
 * The check runs in the background; a tool call never waits for it.
 */
import { PROVIAN_MCP_VERSION } from './core/tools';

/** The launch line that always runs the newest published server. */
export const MCP_LATEST_LAUNCH_COMMAND = 'npx -y @provian/mcp@latest';

/** How long a known answer is reused before the relay is asked again. */
export const MCP_VERSION_REFRESH_MS = 6 * 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 5_000;

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True only when both versions parse and `running` is strictly older than `latest`. */
export function isOlder(running: string, latest: string): boolean {
  const a = parseSemver(running);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The one line a tool result carries when the running server is behind, else null. */
export function mcpUpdateNotice(running: string, latest: string | null): string | null {
  if (latest === null || !isOlder(running, latest)) return null;
  return `A newer Provian MCP server is published: ${latest} (this one is ${running}). ` +
    `Restart it with: ${MCP_LATEST_LAUNCH_COMMAND}`;
}

export interface McpVersionCheckerOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  running?: string;
  now?: () => number;
}

export interface McpVersionChecker {
  /** Start a background check if none is fresh or in flight. Never throws, never waits. */
  refresh(): void;
  /** The notice line for the last known latest version, or null. */
  notice(): string | null;
  /** Test seam: the in-flight check, if any. */
  pending(): Promise<void> | null;
}

export function createMcpVersionChecker(opts: McpVersionCheckerOptions): McpVersionChecker {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const running = opts.running ?? PROVIAN_MCP_VERSION;
  const now = opts.now ?? Date.now;
  let latest: string | null = null;
  let checkedAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function check(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/v1/mcp/version`, { signal: controller.signal });
      if (!res.ok) return;
      const body = (await res.json()) as { latest?: unknown };
      if (typeof body.latest === 'string' && parseSemver(body.latest)) latest = body.latest;
    } catch {
      // Fail-open: no answer, no line.
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    refresh() {
      if (inFlight || now() - checkedAt < MCP_VERSION_REFRESH_MS) return;
      checkedAt = now();
      inFlight = check().finally(() => { inFlight = null; });
    },
    notice: () => mcpUpdateNotice(running, latest),
    pending: () => inFlight,
  };
}
