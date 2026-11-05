/**
 * Which record the Agent Detail screen renders for a given agent id (,
 * re-based in).
 *
 * removed relay agent sessions, so the ONLY relay-side record of an
 * agent this human owns is its beneficiary-linked wallet (`linked_agents`).
 * An agent that is linked but has never reported from a device still opens
 * (read-only, with a "finish setup" status) instead of dead-ending at
 * "not found".
 */

export type AgentDetailSource =
  | { source: 'linked'; linkedIndex: number }
  | { source: 'not_found' };

export function resolveAgentDetailSource(
  agentId: string,
  linkedAgentIds: readonly string[],
): AgentDetailSource {
  const linkedIndex = linkedAgentIds.indexOf(agentId);
  if (linkedIndex >= 0) return { source: 'linked', linkedIndex };
  return { source: 'not_found' };
}
