/**
 * Key custody guard for the MCP tool core.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored into
 * `provian-backend/src/mcp/core/`. Edit only the canonical copy and run
 * `scripts/sync-mcp-core.sh`.
 *
 * A hosted agent that cannot run the install line creates its own wallet through the
 * remote endpoint: it generates the key inside its own runtime, keeps it there,
 * and sends only the public key and a signature. The private key never crosses
 * the wire. Two guards hold that line:
 * - a SCHEMA guard: no remote-capable tool declares an input that names private
 * key material (`findPrivateKeyFields`), asserted over the whole registry by
 * the tool-set tests, with the one historical local-only field named;
 * - an ARGUMENT guard: a call that carries such a field anyway (an agent that
 * guessed a parameter name) is refused before anything is forwarded
 * (`privateKeyArgumentNames`).
 * Self-contained (no imports) so both guards and their tests bind to ONE pattern.
 */

/** An input name that denotes private key material. `device_secret`/`api_secret` are credentials, not keys. */
export const PRIVATE_KEY_FIELD_PATTERN = /(^|_|-)(priv(ate)?[_-]?key|privkey|secret[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase|seed)($|_|-)/i;

/** JSON-Schema property names, at any depth, that name private key material. */
export function findPrivateKeyFields(schema: unknown, prefix = ''): string[] {
  const found: string[] = [];
  if (!schema || typeof schema !== 'object') return found;
  const node = schema as Record<string, unknown>;
  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (PRIVATE_KEY_FIELD_PATTERN.test(name)) found.push(path);
      found.push(...findPrivateKeyFields(child, path));
    }
  }
  if (node.items) found.push(...findPrivateKeyFields(node.items, `${prefix}[]`));
  return found;
}

/** Top-level argument names in a tool call that name private key material. */
export function privateKeyArgumentNames(args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((name) => PRIVATE_KEY_FIELD_PATTERN.test(name));
}

/**
 * The one pre-existing input that names key material: link_external_address's
 * `external_private_key`, which only the LOCAL stdio server ever uses (the remote
 * endpoint refuses it before any network call). Named here so the registry-wide
 * schema guard is exact rather than skipping a tool.
 */
export const LOCAL_ONLY_PRIVATE_KEY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  link_external_address: ['external_private_key'],
};
