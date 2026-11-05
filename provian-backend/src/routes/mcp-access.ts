/**
 * MCP admission — decoupled from `PUBLIC_LAUNCH`, and OPEN, not allowlisted.
 *
 * WHY. Self-serve agent onboarding IS the product: agents find Provian through
 * registries and onboard themselves, and Atlas brings other agents in. A curated key
 * allowlist is incompatible with that — it does not scale and defeats
 * registry-driven discovery. So `/mcp` opens to any caller once onboarding is on;
 * the controls that hold are (a) each tool's OWN downstream auth — every
 * value/write/identity tool re-enters the Express stack and is validated by
 * createAgentAuthMiddleware / device auth / PoP, none of which this gate replaces —
 * and (b) per-IP rate limits (the tool endpoints' existing limits plus a per-IP
 * limit on `/mcp` itself; see routes/mcp.ts). Admission is now identity-INDEPENDENT.
 *
 * The capability surface an arbitrary key reaches through the tool set was
 * established by execution before this opened : self-scoped reads +
 * link-own-address + the Commons/on-chain acts behind their own witnesses
 * (the own-PE report tools submit_pe / submit_sovereign_work were removed by
 * an agent's own claim about its work is never a PE);
 * cross-agent, admin, operator, and mint paths all refuse; `create_wallet` is
 * remote-disabled. So opening the transport grants no privilege the underlying
 * REST routes did not already grant a valid key (opened those directly).
 *
 * THE RULE. `/mcp` admits when EITHER
 * (a) `PUBLIC_LAUNCH === 'true'` the product is public; or
 * (b) `MCP_AGENT_ONBOARDING === 'true'` self-serve onboarding is open.
 * Everything else is a 404.
 *
 * FAIL CLOSED ON UNKNOWN, NOT MERELY ON A FALSE CONJUNCT. A flag present but not
 * exactly `'true'`/`'false'` is UNKNOWN and refuses as its own named verdict, so a
 * typo can never be mistaken for a deliberate posture. There is no default-admit
 * branch: the verdict union has exactly two admits and a verdict added tomorrow
 * refuses by construction.
 *
 * DEFAULTS. Both flags default to false/absent, so with `MCP_AGENT_ONBOARDING`
 * unset and `PUBLIC_LAUNCH=false`, `/mcp` 404s for everyone.
 *
 * `MCP_AGENT_ALLOWLIST` IS RETIRED. It is no longer read (removed the
 * allowlist gate). A stale value in the environment is ignored, not honored.
 */

export type McpAccessVerdict =
  | 'open_public_launch'
  | 'open_agent_onboarding'
  | 'public_launch_unknown_value'
  | 'onboarding_flag_absent'
  | 'onboarding_flag_unknown_value'
  | 'onboarding_flag_false';

export interface McpAccessEnv {
  readonly PUBLIC_LAUNCH?: string;
  readonly MCP_AGENT_ONBOARDING?: string;
  /** Retired. Present only so a stale env value type-checks; never read. */
  readonly MCP_AGENT_ALLOWLIST?: string;
}

/** Exactly two admits. Anything else — including anything added later — refuses. */
export function mcpAccessAdmits(verdict: McpAccessVerdict): boolean {
  return verdict === 'open_public_launch' || verdict === 'open_agent_onboarding';
}

/**
 * A boolean env var that distinguishes ABSENT from UNKNOWN from a real value.
 * `undefined` means "cannot answer" and every caller treats it as refuse.
 */
function readStrictBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  return undefined;
}

/**
 * Judge one request and return the NAMED verdict.
 *
 * `_callerApiKeyId` is retained for call-site compatibility and telemetry only —
 * admission is identity-independent now (open on the onboarding flag). It never
 * affects the verdict; a caller's key is validated (or not) by the individual
 * tool's downstream auth, not here.
 */
export function explainMcpAccess(
  _callerApiKeyId: string | null,
  env: McpAccessEnv,
): McpAccessVerdict {
  const publicLaunch = readStrictBoolean(env.PUBLIC_LAUNCH);
  // An UNKNOWN PUBLIC_LAUNCH value is not silently "false": it is reported, so a
  // typo in the launch flag can never be mistaken for a deliberate posture.
  if (publicLaunch === undefined && env.PUBLIC_LAUNCH !== undefined) {
    return 'public_launch_unknown_value';
  }
  if (publicLaunch === true) return 'open_public_launch';

  if (env.MCP_AGENT_ONBOARDING === undefined) return 'onboarding_flag_absent';
  const onboarding = readStrictBoolean(env.MCP_AGENT_ONBOARDING);
  if (onboarding === undefined) return 'onboarding_flag_unknown_value';
  if (onboarding === false) return 'onboarding_flag_false';

  // Onboarding is ON — self-serve open. No allowlist; downstream tool auth + rate
  // limits are the controls.
  return 'open_agent_onboarding';
}

/** The boolean the route consults. */
export function isMcpAccessPermitted(
  callerApiKeyId: string | null,
  env: McpAccessEnv = process.env as McpAccessEnv,
): boolean {
  return mcpAccessAdmits(explainMcpAccess(callerApiKeyId, env));
}
