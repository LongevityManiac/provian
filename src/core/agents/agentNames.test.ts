/**
 * item 10 — the human's name for an agent shows wherever the agent appears. A record that names
 * the agent by agent_id (local PE rows) resolves through a SEPARATE agent_id map, so an agent that
 * picks an agent_id equal to another agent's wallet id cannot borrow that agent's name.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/RelayAPIService', () => ({
    default: {
        getLinkedAgentIdentities: vi.fn(async () => ({ linked_agents: [
            { wallet_id: 'wallet_aw_1', agent_id: 'research-bot', display_name: 'D494 Renamed' },
            { wallet_id: 'wallet_aw_2', agent_id: 'wallet_aw_1', display_name: 'Impostor' },
            { wallet_id: 'wallet_aw_3', agent_id: 'blank', display_name: '   ' },
        ] })),
        getCachedLinkedAgentIdentities: () => null,
    },
}));

import {
    agentNameFor, agentNameForRecord, buildAgentIdNameMap, buildAgentNameMap, loadAgentNameMaps,
} from './agentNames';

describe('agent names by agent_id (item 10)', () => {
    it('resolves a record that names the agent by agent_id to the human\'s name', async () => {
        const maps = await loadAgentNameMaps();
        expect(agentNameForRecord({ agentId: 'research-bot' }, maps)).toBe('D494 Renamed');
        expect(agentNameForRecord({ agentId: 'not-mine' }, maps)).toBeNull();
        expect(agentNameForRecord({ agentId: 'blank' }, maps)).toBeNull();
    });

    it('RED control: an agent_id equal to another agent\'s wallet id does not take over the wallet-id lookup', async () => {
        const maps = await loadAgentNameMaps();
        // The wallet-id map still names wallet_aw_1 by its own name…
        expect(agentNameFor('wallet_aw_1', maps.byWalletId)).toBe('D494 Renamed');
        // …while the impostor's agent_id only resolves in the agent_id map.
        expect(agentNameFor('wallet_aw_1', maps.byAgentId)).toBe('Impostor');
        // A shared map would have let the later row overwrite the earlier one:
        const shared = new Map([...buildAgentNameMap([{ wallet_id: 'wallet_aw_1', display_name: 'D494 Renamed' }])]);
        for (const [k, v] of buildAgentIdNameMap([{ agent_id: 'wallet_aw_1', display_name: 'Impostor' }])) shared.set(k, v);
        expect(shared.get('wallet_aw_1')).toBe('Impostor');
        // The record helper prefers the wallet id when it has one.
        expect(agentNameForRecord({ walletId: 'wallet_aw_1', agentId: 'wallet_aw_1' }, maps)).toBe('D494 Renamed');
    });
});
