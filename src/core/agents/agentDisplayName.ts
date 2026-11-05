/**
 * The human's name for an agent (item 5) — the app-side mirror of the relay rule
 * (provian-backend/src/core/agent-wallet/human-agent-name.ts `validateAgentDisplayName`): a string,
 * trimmed, 1..100 characters, no `<` or `>`. The relay re-validates; this only lets the editor say
 * what is wrong before a round trip.
 */
export const AGENT_NAME_MAX = 100;

export type AgentNameCheck =
    | { ok: true; value: string }
    | { ok: false; error: 'required' | 'tooLong' | 'markup' };

export function checkAgentName(raw: string): AgentNameCheck {
    const value = raw.trim();
    if (value.length === 0) return { ok: false, error: 'required' };
    if (value.length > AGENT_NAME_MAX) return { ok: false, error: 'tooLong' };
    if (/[<>]/.test(value)) return { ok: false, error: 'markup' };
    return { ok: true, value };
}
