/**
 * What the Wallet home's "Your Agents" card shows.
 *
 * "Connect an agent" is a statement that the person has no agents. It is shown only after a load
 * that answered with zero agents — never while the answer is still on its way, and never when the
 * load failed (a person with agents would be told to connect one).
 */
export type AgentsLoad = 'loading' | 'loaded' | 'failed';
export type YourAgentsCardMode = 'loading' | 'failed' | 'connect' | 'agents';

export function yourAgentsCardMode(load: AgentsLoad, agentCount: number): YourAgentsCardMode {
    if (load !== 'loaded') return load;
    return agentCount === 0 ? 'connect' : 'agents';
}

/** A refresh starting: a card that already holds an answer keeps showing it. */
export function agentsLoadOnStart(prev: AgentsLoad): AgentsLoad {
    return prev === 'loaded' ? 'loaded' : 'loading';
}

/** A refresh ending: a failed refresh never replaces an answer already on screen. */
export function agentsLoadOnEnd(prev: AgentsLoad, ok: boolean): AgentsLoad {
    if (ok) return 'loaded';
    return prev === 'loaded' ? 'loaded' : 'failed';
}
