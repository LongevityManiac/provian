/**
 * Item 3 — the Agent Hub shows ONE consistent set of counts. RED controls :
 * - the old card summed agents + devices under "Connected" (2 agents + 1 device → "3"); the
 * derivation keeps them separate and each matches its own list;
 * - the old first paint counted cached agents against devices `[]`; nothing is counted until both
 * reads have settled;
 * - the old device read swallowed errors into `[]` → 0; a never-read device list is `unavailable`.
 */
import { describe, expect, it } from 'vitest';
import { activeDevices, deriveAgentHubCounts, liveLinkRequests } from './agentHubCounts';

const NOW = 1_000_000;
const agents = [{ wallet_id: 'a' }, { wallet_id: 'b' }];
const devices = [{ status: 'active' }, { status: 'revoked' }];

describe('deriveAgentHubCounts', () => {
    it('counts each list separately and matches what the lists render (2 agents, 1 active device)', () => {
        const c = deriveAgentHubCounts({ agents, agentsSettled: true, devices, devicesSettled: true, linkRequests: [], nowMs: NOW });
        expect(c).toEqual({
            ready: true,
            linkedAgents: { kind: 'count', value: 2 },
            yourDevices: { kind: 'count', value: 1 },
            pendingLinkRequests: null,
        });
        // The counts are the lengths of the same filtered arrays the screen renders.
        expect(activeDevices(devices)).toHaveLength(1);
        // RED control: the old "Connected" total (agents + devices) is NOT a number this derivation produces.
        if (c.ready) {
            const shown = [c.linkedAgents, c.yourDevices].map((x) => (x.kind === 'count' ? x.value : -1));
            expect(shown).not.toContain(agents.length + activeDevices(devices).length);
        }
    });

    it('holds (ready:false) until BOTH reads have settled — no stale first paint from cached agents', () => {
        expect(deriveAgentHubCounts({ agents, agentsSettled: true, devices: null, devicesSettled: false, linkRequests: null, nowMs: NOW }))
            .toEqual({ ready: false });
        expect(deriveAgentHubCounts({ agents: null, agentsSettled: false, devices, devicesSettled: true, linkRequests: null, nowMs: NOW }))
            .toEqual({ ready: false });
    });

    it('a device read that never succeeded is UNAVAILABLE, never 0 (RED control for the swallowed-error 0)', () => {
        const c = deriveAgentHubCounts({ agents, agentsSettled: true, devices: null, devicesSettled: true, linkRequests: [], nowMs: NOW });
        expect(c.ready && c.yourDevices).toEqual({ kind: 'unavailable' });
        // A genuinely empty successful read IS zero — the two are distinguishable.
        const empty = deriveAgentHubCounts({ agents, agentsSettled: true, devices: [], devicesSettled: true, linkRequests: [], nowMs: NOW });
        expect(empty.ready && empty.yourDevices).toEqual({ kind: 'count', value: 0 });
    });

    it('an agent read that never succeeded is unavailable too', () => {
        const c = deriveAgentHubCounts({ agents: null, agentsSettled: true, devices, devicesSettled: true, linkRequests: [], nowMs: NOW });
        expect(c.ready && c.linkedAgents).toEqual({ kind: 'unavailable' });
    });

    it('pending link requests: unexpired only, shown only when > 0, hidden when the read failed', () => {
        const reqs = [{ expires_at: NOW + 1 }, { expires_at: NOW - 1 }, { expires_at: NOW + 5 }];
        const c = deriveAgentHubCounts({ agents, agentsSettled: true, devices, devicesSettled: true, linkRequests: reqs, nowMs: NOW });
        expect(c.ready && c.pendingLinkRequests).toBe(2);
        expect(liveLinkRequests(reqs, NOW)).toHaveLength(2);
        const failed = deriveAgentHubCounts({ agents, agentsSettled: true, devices, devicesSettled: true, linkRequests: null, nowMs: NOW });
        expect(failed.ready && failed.pendingLinkRequests).toBeNull();
        const allExpired = deriveAgentHubCounts({ agents, agentsSettled: true, devices, devicesSettled: true, linkRequests: [{ expires_at: NOW }], nowMs: NOW });
        expect(allExpired.ready && allExpired.pendingLinkRequests).toBeNull();
    });
});
