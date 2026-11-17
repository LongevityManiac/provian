/**
 * Which Etherscan-family `module`/`action` pairs `GET /api/proxy/explorer/:network`
 * forwards to the keyed upstream.
 *
 * The allowlist is exactly what the wallet app and the SDK send through this
 * proxy. Neither sends anything: the app reads EVM history through the Alchemy
 * JSON-RPC proxy, and no other client calls this route. The list is therefore
 * empty and every request is refused before the rate limiter or the upstream
 * is touched. A caller that needs an action adds its exact `module:action`
 * pair here in the same change that adds the caller.
 */
export const EXPLORER_ALLOWED_ACTIONS: ReadonlySet<string> = new Set<string>([]);

/** `module:action` as the allowlist spells it, or null when either is not a single plain string. */
export function explorerActionKey(query: Record<string, unknown>): string | null {
  const moduleName = query.module;
  const action = query.action;
  if (typeof moduleName !== 'string' || typeof action !== 'string') return null;
  if (moduleName.length === 0 || action.length === 0) return null;
  return `${moduleName}:${action}`;
}

/**
 * True only for a query naming one allowlisted `module:action`. A missing,
 * repeated (array-valued) or non-string `module` / `action` is refused.
 */
export function explorerQueryAllowed(
  query: Record<string, unknown>,
  allowed: ReadonlySet<string> = EXPLORER_ALLOWED_ACTIONS,
): boolean {
  const key = explorerActionKey(query);
  return key !== null && allowed.has(key);
}
