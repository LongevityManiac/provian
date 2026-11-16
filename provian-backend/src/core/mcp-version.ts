/**
 * Local MCP server version advertisement (staleness signal).
 *
 * The local stdio server (`npx -y @provian/mcp@latest`) pulls the newest
 * published version at each start, but a long-running session (or a config
 * pinned to a version) keeps running what it started with. The relay is the
 * one place that knows which @provian/mcp is current, so it advertises it:
 *
 *   1. `GET /v1/mcp/version`   — an explicit pull (public, ungated).
 *   2. `X-Provian-MCP-Latest`  — a response header on every relay call.
 *
 * The local server compares its own running version with `latest` and, when it
 * is behind, adds one line to its tool results. Advisory and fail-open, like the
 * SDK's signal (`sdk-version.ts`): it never blocks a tool.
 *
 * SOURCE OF TRUTH: `MCP_LATEST` mirrors `provian-mcp/package.json`'s version,
 * which is the version on npm after publish. Bump it here in the same change
 * that bumps the package. `mcp-version.test.ts` holds the two together.
 */

/** The @provian/mcp version that is published, mirrors provian-mcp/package.json. */
export const MCP_LATEST = '1.4.0';

/** The launch line that always runs the newest published server. */
export const MCP_LAUNCH_COMMAND = 'npx -y @provian/mcp@latest';

export interface McpVersionInfo {
  latest: string;
  launchCommand: string;
}

/** The public payload for `GET /v1/mcp/version`. */
export function mcpVersionInfo(): McpVersionInfo {
  return { latest: MCP_LATEST, launchCommand: MCP_LAUNCH_COMMAND };
}
