import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const hub = readFileSync(`${root}/src/screens/Earn/EarnHubScreen.tsx`, 'utf8');
const detail = readFileSync(`${root}/src/screens/Earn/EarnSurfaceDetailScreen.tsx`, 'utf8');
const agentHub = readFileSync(`${root}/src/screens/Agent/AgentHubScreen.tsx`, 'utf8');
const relay = readFileSync(`${root}/provian-backend/src/server.ts`, 'utf8');

describe(' linked-agent truth wiring', () => {
    it('Earn hub and detail resolve the cheap identity view before rich enrichment', () => {
        expect(hub).toContain('getLinkedAgentIdentities({ throwOnError: true })');
        expect(detail).toContain('getLinkedAgentIdentities({ throwOnError: true })');
        expect(hub.indexOf('getLinkedAgentIdentities({ throwOnError: true })'))
            .toBeLessThan(hub.indexOf('getLinkedAgents({ throwOnError: true })'));
        expect(detail.indexOf('getLinkedAgentIdentities({ throwOnError: true })'))
            .toBeLessThan(detail.indexOf('getLinkedAgents({ throwOnError: true })'));
    });

    it('RED: agent screens never turn a failed linked-agent read into []', () => {
        expect(hub).not.toContain("getLinkedAgents().catch(() => ({ linked_agents: [] }))");
        expect(detail).not.toContain("getLinkedAgents().catch(() => ({ linked_agents: [] }))");
        expect(agentHub).toContain('getLinkedAgents({ throwOnError: true })');
    });

    it('coalesces rich Agent Hub loads and no longer polls faster than the old endpoint latency', () => {
        expect(agentHub).toContain('if (loadInFlight.current) return loadInFlight.current;');
        expect(agentHub).toContain('setInterval(loadData, 30_000)');
        expect(agentHub).not.toContain('setInterval(loadData, 5000)');
    });

    it('the relay identity response exits before PE-count enrichment', () => {
        const routeStart = relay.indexOf("app.get('/v1/relay/agent/sessions'");
        const identityExit = relay.indexOf("if (req.query.view === 'identity')", routeStart);
        const enrichment = relay.indexOf('const LIVE_COUNT_FANOUT_CAP = 25', routeStart);
        expect(routeStart).toBeGreaterThanOrEqual(0);
        expect(identityExit).toBeGreaterThan(routeStart);
        expect(enrichment).toBeGreaterThan(identityExit);
    });
});
