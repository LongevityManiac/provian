import { describe, it, expect } from 'vitest';
import {
    EARNING_SURFACES,
    EARN_GROUP_ORDER,
    getSurface,
    matchesSurface,
    resolveAllSurfaceStatuses,
    resolveSurfaceStatus,
    shouldManageConnectedAgents,
    isSurfaceConnectionKnown,
    surfacesByGroup,
    type SurfaceStatusInputs,
} from '../EarningSurfaceRegistry';

const NO_ACTIVITY: SurfaceStatusInputs = {
    chatConsent: null,
    activeDeviceCount: 0,
    linkedAgentCount: 0,
    linkedAgentsWithExternalWalletCount: 0,
    ownExternalWalletCount: 0,
    anyLinkedAgentLive: false,
    commonsJoined: false,
    activeForgeInstallProviders: [],
    recentActionTypes: [],
};

describe('EarningSurfaceRegistry catalog', () => {
    it('every surface belongs to a known group', () => {
        for (const s of EARNING_SURFACES) {
            expect(EARN_GROUP_ORDER).toContain(s.group);
        }
    });

    it('surface ids are unique', () => {
        const ids = EARNING_SURFACES.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every group in display order has at least one surface', () => {
        for (const g of EARN_GROUP_ORDER) {
            expect(surfacesByGroup(g).length).toBeGreaterThan(0);
        }
    });

    it('getSurface returns the matching entry', () => {
        expect(getSurface('github').group).toBe('services');
        expect(getSurface('desktop_daemon').target).toEqual({ kind: 'connect', mode: 'device' });
    });
});

describe('matchesSurface', () => {
    it('matches exact action types', () => {
        expect(matchesSurface(getSurface('chat_capture'), 'ai_conversation')).toBe(true);
        expect(matchesSurface(getSurface('chat_capture'), 'coding_session')).toBe(false);
    });

    it('matches prefixed action types', () => {
        expect(matchesSurface(getSurface('github'), 'service:github_commit')).toBe(true);
        expect(matchesSurface(getSurface('github'), 'service:github_pr_merged')).toBe(true);
        expect(matchesSurface(getSurface('github'), 'service_install_created')).toBe(false);
        expect(matchesSurface(getSurface('promises'), 'promise_fulfilled')).toBe(true);
        expect(matchesSurface(getSurface('connected_agents'), 'agent_work_delegated')).toBe(true);
        expect(matchesSurface(getSurface('connected_agents'), 'pvt_surplus_transfer')).toBe(false);
        expect(matchesSurface(getSurface('connected_agents'), 'pvt_retroactive_transfer')).toBe(false);
    });
});

describe('resolveSurfaceStatus', () => {
    it('reports setup for unconnected surfaces with no activity', () => {
        const all = resolveAllSurfaceStatuses(NO_ACTIVITY);
        expect(all.chat_capture.status).toBe('setup');
        expect(all.commons.status).toBe('setup');
        expect(all.desktop_daemon.status).toBe('setup');
        expect(all.github.status).toBe('setup');
        expect(all.connected_agents.status).toBe('setup');
    });

    it('built-in surfaces are connected even with no activity', () => {
        const all = resolveAllSurfaceStatuses(NO_ACTIVITY);
        expect(all.promises.status).toBe('connected');
        expect(all.wallet_activity.status).toBe('connected');
    });

    it('chat consent moves chat capture to connected, recent PEs to earning', () => {
        const consented = { ...NO_ACTIVITY, chatConsent: true };
        expect(resolveSurfaceStatus(getSurface('chat_capture'), consented).status).toBe('connected');

        const active = { ...consented, recentActionTypes: ['ai_conversation', 'ai_conversation'] };
        const result = resolveSurfaceStatus(getSurface('chat_capture'), active);
        expect(result.status).toBe('earning');
        expect(result.recentPECount).toBe(2);
    });

    it('declined chat consent stays in setup', () => {
        const declined = { ...NO_ACTIVITY, chatConsent: false };
        expect(resolveSurfaceStatus(getSurface('chat_capture'), declined).status).toBe('setup');
    });

    it('a registered device connects the daemon; session PEs make it earning', () => {
        const registered = { ...NO_ACTIVITY, activeDeviceCount: 1 };
        expect(resolveSurfaceStatus(getSurface('desktop_daemon'), registered).status).toBe('connected');

        const working = { ...registered, recentActionTypes: ['coding_session', 'compute_session'] };
        expect(resolveSurfaceStatus(getSurface('desktop_daemon'), working).status).toBe('earning');
    });

    it('forge connectors target the in-app connect flow and are no longer coming soon', () => {
        for (const id of ['github', 'gitlab', 'bitbucket'] as const) {
            const surface = getSurface(id);
            expect(surface.comingSoon).toBeUndefined();
            expect(surface.target).toEqual({ kind: 'forge', provider: id });
        }
    });

    it('an active forge install connects its provider surface; service PEs make it earning', () => {
        for (const id of ['github', 'gitlab', 'bitbucket'] as const) {
            const surface = getSurface(id);
            // No install, no PEs: still setup.
            expect(resolveSurfaceStatus(surface, NO_ACTIVITY).status).toBe('setup');
            // Install for a DIFFERENT provider does not connect this one.
            const otherProvider = id === 'github' ? 'gitlab' : 'github';
            expect(
                resolveSurfaceStatus(surface, {
                    ...NO_ACTIVITY,
                    activeForgeInstallProviders: [otherProvider],
                }).status,
            ).toBe('setup');
            // An active install for this provider connects it.
            const connected = { ...NO_ACTIVITY, activeForgeInstallProviders: [id] as const };
            expect(resolveSurfaceStatus(surface, connected).status).toBe('connected');
            // Matching service PEs move it to earning (and count).
            const earning = {
                ...connected,
                recentActionTypes: [`service:${id}_commit`, `service:${id}_pr_merged`],
            };
            const result = resolveSurfaceStatus(surface, earning);
            expect(result.status).toBe('earning');
            expect(result.recentPECount).toBe(2);
            // Observed service PEs alone are also connection evidence
            // (install registered from the CLI before the list loaded).
            expect(
                resolveSurfaceStatus(surface, {
                    ...NO_ACTIVITY,
                    recentActionTypes: [`service:${id}_commit`],
                }).status,
            ).toBe('earning');
        }
    });

    it('a linked agent connects the agents surface (no session channel exists)', () => {
        expect(
            resolveSurfaceStatus(getSurface('connected_agents'), {
                ...NO_ACTIVITY,
                linkedAgentCount: 1,
            }).status,
        ).toBe('connected');
        // RED half: with no linked agent there is nothing that can connect it.
        expect(
            resolveSurfaceStatus(getSurface('connected_agents'), {
                ...NO_ACTIVITY,
            }).status,
        ).toBe('setup');
    });

    it('connected_agents reads earning only when a linked agent is ALSO live', () => {
        // Recent agent PEs in the human history + a live agent → earning.
        const live = resolveSurfaceStatus(getSurface('connected_agents'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 1,
            anyLinkedAgentLive: true,
            recentActionTypes: ['agent_work_delegated', 'agent_linked_to_human'],
        });
        expect(live.status).toBe('earning');
        expect(live.recentPECount).toBe(2);
    });

    it('connected_agents — RED CONTROL: recent agent PEs but every agent stale must NOT read earning', () => {
        // Reconciles with Agent Hub: the human history still carries agent PEs,
        // but every linked agent has gone stale (capture broken / no recent PE),
        // so the surface must read 'connected', not 'earning'.
        const stale = resolveSurfaceStatus(getSurface('connected_agents'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 1,
            anyLinkedAgentLive: false,
            recentActionTypes: ['agent_work_delegated', 'agent_linked_to_human'],
        });
        expect(stale.status).toBe('connected');
        expect(stale.status).not.toBe('earning');
        expect(stale.recentPECount).toBe(2);
    });

    it('connected_agents — a live agent with NO recent PEs is still only connected', () => {
        const noPes = resolveSurfaceStatus(getSurface('connected_agents'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 1,
            anyLinkedAgentLive: true,
        });
        expect(noPes.status).toBe('connected');
        expect(noPes.recentPECount).toBe(0);
    });

    it('recent PE counting only counts matching types', () => {
        const mixed = {
            ...NO_ACTIVITY,
            commonsJoined: true,
            recentActionTypes: ['commons_post_created', 'human_job_delivered', 'send', 'promise_created'],
        };
        const commons = resolveSurfaceStatus(getSurface('commons'), mixed);
        expect(commons.status).toBe('earning');
        expect(commons.recentPECount).toBe(2);

        const wallet = resolveSurfaceStatus(getSurface('wallet_activity'), mixed);
        expect(wallet.recentPECount).toBe(1);
    });
});

describe('connected-agent navigation', () => {
    it('opens management for connected/earning agents and onboarding only for setup', () => {
        expect(shouldManageConnectedAgents('connected_agents', 'connected')).toBe(true);
        expect(shouldManageConnectedAgents('connected_agents', 'earning')).toBe(true);
        expect(shouldManageConnectedAgents('connected_agents', 'setup')).toBe(false);
        expect(shouldManageConnectedAgents('github', 'earning')).toBe(false);
    });
});

describe('per-surface connection readiness', () => {
    const none = {
        chatConsent: false,
        devices: false,
        linkedAgents: false,
        commons: false,
        forgeInstalls: false,
        ownExternalWallets: false,
    };

    it('keeps agent setup unknown until the identity read answers', () => {
        expect(isSurfaceConnectionKnown(getSurface('connected_agents'), none)).toBe(false);
        expect(isSurfaceConnectionKnown(getSurface('agent_external_wallet'), none)).toBe(false);
        expect(isSurfaceConnectionKnown(getSurface('connected_agents'), {
            ...none,
            linkedAgents: true,
        })).toBe(true);
    });

    it('RED: unrelated sources cannot make the agent setup state authoritative', () => {
        expect(isSurfaceConnectionKnown(getSurface('connected_agents'), {
            ...none,
            chatConsent: true,
            devices: true,
            commons: true,
            forgeInstalls: true,
            ownExternalWallets: true,
        })).toBe(false);
    });

    it('built-in surfaces never wait on remote connection truth', () => {
        expect(isSurfaceConnectionKnown(getSurface('wallet_activity'), none)).toBe(true);
        expect(isSurfaceConnectionKnown(getSurface('promises'), none)).toBe(true);
    });
});

describe('agent_external_wallet surface (education/nudge; agent-authenticated)', () => {
    it('is registered in the agents group', () => {
        const s = getSurface('agent_external_wallet');
        expect(s.group).toBe('agents');
        expect(surfacesByGroup('agents').map((x) => x.id)).toContain('agent_external_wallet');
    });

    // Three-state ladder driven by the AGENT's link status, not the human's PE
    // history. Each state ships with the input that produces it AND, below, the
    // negative control proving it does NOT fire in the wrong state.
    it('setup when the operator has no linked agent at all', () => {
        expect(
            resolveSurfaceStatus(getSurface('agent_external_wallet'), NO_ACTIVITY).status,
        ).toBe('setup');
    });

    it('connected — RED CONTROL: a linked agent with NO external wallet must NOT read as earning', () => {
        const res = resolveSurfaceStatus(getSurface('agent_external_wallet'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 2,
            linkedAgentsWithExternalWalletCount: 0,
        });
        expect(res.status).toBe('connected');
        expect(res.status).not.toBe('earning');
        expect(res.recentPECount).toBe(0);
    });

    it('earning only once a linked agent has actually proven an external wallet', () => {
        const res = resolveSurfaceStatus(getSurface('agent_external_wallet'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 3,
            linkedAgentsWithExternalWalletCount: 2,
        });
        expect(res.status).toBe('earning');
        expect(res.recentPECount).toBe(2);
    });

    it('does NOT borrow the human’s recent PE history — RED CONTROL for cross-surface bleed', () => {
        // send/swap/x402 in the human history must not flip this surface to
        // earning; only linkedAgentsWithExternalWalletCount can (its earning is
        // the agent’s own on-chain activity, recorded under the agent’s wallet).
        const res = resolveSurfaceStatus(getSurface('agent_external_wallet'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 1,
            linkedAgentsWithExternalWalletCount: 0,
            recentActionTypes: ['send', 'swap', 'x402_payment', 'send'],
        });
        expect(res.status).toBe('connected');
        expect(res.recentPECount).toBe(0);
    });
});

describe('own_external_wallet surface (a person proves a wallet they already hold)', () => {
    it('is the first card in the "your other accounts" group, before the forges', () => {
        const s = getSurface('own_external_wallet');
        expect(s.group).toBe('services');
        expect(surfacesByGroup('services').map((x) => x.id)).toEqual([
            'own_external_wallet', 'github', 'gitlab', 'bitbucket',
        ]);
    });

    it('opens the in-app person-mode proof screen, never a URL or an agent flow', () => {
        const target = getSurface('own_external_wallet').target;
        expect(target).toEqual({ kind: 'screen', screen: 'ProveOwnWallet' });
        expect(target?.kind).not.toBe('url');
        expect(target?.kind).not.toBe('connect');
    });

    it('needs no agent: a person with no linked agent reaches it (setup, then connected once proven)', () => {
        const surface = getSurface('own_external_wallet');
        expect(resolveSurfaceStatus(surface, NO_ACTIVITY)).toEqual({ status: 'setup', recentPECount: 0 });
        const proven = resolveSurfaceStatus(surface, { ...NO_ACTIVITY, ownExternalWalletCount: 2 });
        expect(proven).toEqual({ status: 'connected', recentPECount: 2 });
    });

    it('RED: agent links and the person history do not mark it proven', () => {
        const res = resolveSurfaceStatus(getSurface('own_external_wallet'), {
            ...NO_ACTIVITY,
            linkedAgentCount: 3,
            linkedAgentsWithExternalWalletCount: 3,
            recentActionTypes: ['send', 'swap', 'receive'],
        });
        expect(res.status).toBe('setup');
        expect(res.recentPECount).toBe(0);
    });

    it('records the wallet acts it witnesses (labels from the canonical map)', () => {
        expect(getSurface('own_external_wallet').peTypes.map((p) => p.actionType)).toEqual(['send', 'swap', 'receive']);
    });

    it('its setup state waits on its own list read; RED: other sources cannot settle it', () => {
        const none = {
            chatConsent: true, devices: true, linkedAgents: true, commons: true, forgeInstalls: true,
            ownExternalWallets: false,
        };
        expect(isSurfaceConnectionKnown(getSurface('own_external_wallet'), none)).toBe(false);
        expect(isSurfaceConnectionKnown(getSurface('own_external_wallet'), { ...none, ownExternalWallets: true })).toBe(true);
    });
});
