import type { BiometricAction } from '../security/biometricAction';
/**
 * Agent names for human-facing rows (item 4). Approval, presentation, and link-request rows used to
 * print the raw `agent_wallet_id` ("wallet_aw_3f9c…"); they now print the agent's display name —
 * the name the human chose, when they named it (item 5) — resolved from the linked-agent list.
 */
import RelayAPIService from '../../services/RelayAPIService';

export type AgentNameMap = ReadonlyMap<string, string>;

/** wallet_id → display_name for the given linked-agent rows (blank names are skipped). */
export function buildAgentNameMap(agents: ReadonlyArray<{ wallet_id: string; display_name?: string | null }>): AgentNameMap {
    const map = new Map<string, string>();
    for (const a of agents) {
        const name = typeof a.display_name === 'string' ? a.display_name.trim() : '';
        if (a.wallet_id && name.length > 0) map.set(a.wallet_id, name);
    }
    return map;
}

/** The display name for an agent wallet id, or null when it is not one of this human's linked agents. */
export function agentNameFor(walletId: string | null | undefined, names: AgentNameMap): string | null {
    if (!walletId) return null;
    return names.get(walletId) ?? null;
}

/**
 * (item 10): agent_id → the human's name for that agent. Kept SEPARATE from the wallet-id map
 * (an agent chooses its own agent_id, so one could pick a string equal to another agent's wallet id;
 * a shared map would let it borrow that agent's name). Used where a record carries the agent_id
 * rather than the wallet id (local PE rows, transaction rows).
 */
export function buildAgentIdNameMap(agents: ReadonlyArray<{ agent_id?: string | null; display_name?: string | null }>): AgentNameMap {
    const map = new Map<string, string>();
    for (const a of agents) {
        const name = typeof a.display_name === 'string' ? a.display_name.trim() : '';
        if (typeof a.agent_id === 'string' && a.agent_id && name.length > 0) map.set(a.agent_id, name);
    }
    return map;
}

export interface AgentNameMaps {
    readonly byWalletId: AgentNameMap;
    readonly byAgentId: AgentNameMap;
}

/**
 * The human's name for an agent a record names by agent_id and/or wallet id: the wallet id wins,
 * then the agent_id; null when the agent is not one of this human's linked agents (the caller shows
 * the identifier, never a guessed name).
 */
export function agentNameForRecord(
    ids: { walletId?: string | null; agentId?: string | null },
    maps: AgentNameMaps,
): string | null {
    return agentNameFor(ids.walletId, maps.byWalletId) ?? agentNameFor(ids.agentId, maps.byAgentId);
}

/** Both name maps from the relay's identity view (cached rows if that read fails). Never throws. */
export async function loadAgentNameMaps(biometricAction?: BiometricAction): Promise<AgentNameMaps> {
    let rows: ReadonlyArray<{ wallet_id: string; agent_id?: string | null; display_name?: string | null }>;
    try {
        rows = (await RelayAPIService.getLinkedAgentIdentities(undefined, biometricAction)).linked_agents;
    } catch {
        rows = RelayAPIService.getCachedLinkedAgentIdentities?.() ?? [];
    }
    return { byWalletId: buildAgentNameMap(rows), byAgentId: buildAgentIdNameMap(rows) };
}

/**
 * The linked agents' names, from the relay's identity view (cached rows if that read fails).
 * Never throws; an empty map when nothing is known.
 */
export async function loadAgentNameMap(biometricAction?: BiometricAction): Promise<AgentNameMap> {
    try {
        const { linked_agents } = await RelayAPIService.getLinkedAgentIdentities(undefined, biometricAction);
        return buildAgentNameMap(linked_agents);
    } catch {
        return buildAgentNameMap(RelayAPIService.getCachedLinkedAgentIdentities?.() ?? []);
    }
}
