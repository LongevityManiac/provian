/**
 * Agent Hub counts (agent-path close-out, item 3) — ONE derivation for every number the Agent Hub
 * shows, so the header, the count cards, and the lists below can never disagree.
 *
 * The Hub used to say "2 agents · 1 device" in its header and "3 Connected" on its card (agents +
 * devices summed under a label that said neither), painted the header from cached agents while
 * devices were still `[]`, and read a failed device fetch as zero. The rules now:
 *
 *  - every number is derived from the SAME arrays the lists render;
 *  - nothing is counted until BOTH the linked-agent read and the device read have settled at least
 *    once (the screen holds a neutral loading state, never a flash of 0);
 *  - a read that has never succeeded is `unavailable`, never 0; a later failure keeps the last
 *    successful value (the screen passes its last known array, not `[]`);
 *  - devices count only `active` rows (the list renders only those);
 *  - pending link requests count only unexpired rows, and are shown only when there is at least one
 *    (a failed link-request read hides the row rather than claiming zero).
 */

export type HubCount = { readonly kind: 'count'; readonly value: number } | { readonly kind: 'unavailable' };

export interface AgentHubCountInput {
    /** The linked agents the list renders; null = never successfully read. */
    readonly agents: readonly unknown[] | null;
    /** True once the first linked-agent read of this visit has settled (success OR failure). */
    readonly agentsSettled: boolean;
    /** The last successfully read device rows (any status); null = never successfully read. */
    readonly devices: ReadonlyArray<{ readonly status: string }> | null;
    /** True once the first device read of this visit has settled (success OR failure). */
    readonly devicesSettled: boolean;
    /** Pending link requests; null = the read failed / has not succeeded. */
    readonly linkRequests: ReadonlyArray<{ readonly expires_at: number }> | null;
    readonly nowMs: number;
}

export type AgentHubCounts =
    | { readonly ready: false }
    | {
          readonly ready: true;
          readonly linkedAgents: HubCount;
          readonly yourDevices: HubCount;
          /** Present only when at least one unexpired request is known to be waiting. */
          readonly pendingLinkRequests: number | null;
      };

const count = (value: number): HubCount => ({ kind: 'count', value });
const UNAVAILABLE: HubCount = { kind: 'unavailable' };

/** The device rows the Hub's device list renders (and therefore counts). */
export function activeDevices<T extends { readonly status: string }>(devices: readonly T[] | null): T[] {
    return (devices ?? []).filter((d) => d.status === 'active');
}

/** The link requests the Hub lists (and therefore counts): unexpired only. */
export function liveLinkRequests<T extends { readonly expires_at: number }>(requests: readonly T[] | null, nowMs: number): T[] {
    return (requests ?? []).filter((r) => typeof r.expires_at === 'number' && r.expires_at > nowMs);
}

export function deriveAgentHubCounts(input: AgentHubCountInput): AgentHubCounts {
    if (!input.agentsSettled || !input.devicesSettled) return { ready: false };
    const pending = input.linkRequests === null ? 0 : liveLinkRequests(input.linkRequests, input.nowMs).length;
    return {
        ready: true,
        linkedAgents: input.agents === null ? UNAVAILABLE : count(input.agents.length),
        yourDevices: input.devices === null ? UNAVAILABLE : count(activeDevices(input.devices).length),
        pendingLinkRequests: pending > 0 ? pending : null,
    };
}
