/**
 * The ONE comparator every tool-list pin binds to.
 *
 * `tools/list` serves `PROVIAN_TOOLS` verbatim (server.ts), in every mode, over stdio and over
 * the relay's `/mcp` mount (the relay serves this same core, mirrored by
 * scripts/sync-mcp-core.sh). A test that pins the served list must therefore compare it with
 * that registry, never with a redeclared literal: five such literals (three here, two in the
 * relay) each held their own copy of the tool names and went red when added tools
 * (`answer_challenge`, `feature_item`, …). Binding to the single source ends that class.
 *
 * The comparator is not vacuous by construction: an empty registry is refused (a comparison
 * over zero tools proves nothing), and a missing, an extra, or a duplicated served name each
 * fail with the offending names (see the RED control in tools.test.ts).
 */
import { PROVIAN_TOOLS } from './tools';
import { findPrivateKeyFields, LOCAL_ONLY_PRIVATE_KEY_FIELDS } from './key-custody';

export interface ToolSetDiff {
  /** Registered tools the served list omits. */
  readonly missing: string[];
  /** Served names the registry does not register. */
  readonly extra: string[];
  /** Names the served list carries more than once. */
  readonly duplicates: string[];
}

/** The registered tool names, sorted — the single source every pin compares against. */
export function registeredToolNames(): string[] {
  return PROVIAN_TOOLS.map((t) => t.name).sort();
}

export function diffToolSet(
  served: readonly string[],
  registered: readonly string[] = registeredToolNames(),
): ToolSetDiff {
  const servedSet = new Set(served);
  const registeredSet = new Set(registered);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of served) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return {
    missing: [...registeredSet].filter((name) => !servedSet.has(name)).sort(),
    extra: [...servedSet].filter((name) => !registeredSet.has(name)).sort(),
    duplicates: [...duplicates].sort(),
  };
}

/** Throws unless `served` is exactly the registered set, once each, over a non-empty registry. */
export function assertServedToolSet(
  served: readonly string[],
  registered: readonly string[] = registeredToolNames(),
): void {
  if (registered.length === 0) {
    throw new Error('tool registry is empty: a comparison over zero tools proves nothing');
  }
  const diff = diffToolSet(served, registered);
  if (diff.missing.length > 0 || diff.extra.length > 0 || diff.duplicates.length > 0) {
    throw new Error(
      `served tool set differs from the registry: missing [${diff.missing.join(', ')}] `
      + `extra [${diff.extra.join(', ')}] duplicated [${diff.duplicates.join(', ')}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Key custody over the registry
// ---------------------------------------------------------------------------

export interface KeyFieldViolation {
  readonly tool: string;
  readonly field: string;
}

/**
 * Every input, across the given tools, that names private key material and is not the one
 * declared local-only field. Empty means no tool schema accepts a private key. The input
 * type is wide on purpose (any name + schema) so a violating registry is constructible in
 * the RED control.
 */
export function privateKeyFieldViolations(
  tools: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }> = PROVIAN_TOOLS,
): KeyFieldViolation[] {
  const out: KeyFieldViolation[] = [];
  for (const tool of tools) {
    const allowed = LOCAL_ONLY_PRIVATE_KEY_FIELDS[tool.name] ?? [];
    for (const field of findPrivateKeyFields(tool.inputSchema)) {
      if (!allowed.includes(field)) out.push({ tool: tool.name, field });
    }
  }
  return out;
}
