/**
 * linked-agent truth must not collapse a transport/cache failure into
 * "you have no agents". These tests pin the non-cacheable live read, the cheap
 * identity projection, and last-confirmed fallback semantics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../NotificationService', () => ({ default: {} }));

import RelayAPIService from '../RelayAPIService';

type AuthFetch = (endpoint: string, options?: RequestInit, retryOnAuth?: boolean) => Promise<Response>;
const svc = RelayAPIService as unknown as {
    makeAuthenticatedRequest: AuthFetch;
    linkedAgentsCache: unknown;
    linkedAgentIdentitiesCache: unknown;
    linkedAgentsInFlight: unknown;
    linkedAgentIdentitiesInFlight: unknown;
};

function response(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

const IDENTITY = {
    wallet_id: 'wallet_atlas',
    agent_id: 'atlas',
    display_name: 'Atlas',
    address: '0xabc',
    platform: 'claude',
    created_at: 123,
    solana_address: null,
    last_pe_date: '2026-09-21',
};

const FULL = {
    ...IDENTITY,
    pe_count: 86,
    external_address_linked: false,
    last_capture_at_ms: 456,
};

beforeEach(() => {
    vi.restoreAllMocks();
    svc.linkedAgentsCache = null;
    svc.linkedAgentIdentitiesCache = null;
    svc.linkedAgentsInFlight = null;
    svc.linkedAgentIdentitiesInFlight = null;
});

describe('linked-agent live reads', () => {
    it('uses a unique non-cacheable URL so iOS cannot turn ETag revalidation into HTTP 304', async () => {
        const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockImplementation(async (endpoint, options) => {
            calls.push({ endpoint, options });
            return response(200, { linked_agents: [FULL] });
        });

        await RelayAPIService.getLinkedAgents();
        await RelayAPIService.getLinkedAgents();

        expect(calls[0].endpoint).toMatch(/^\/v1\/relay\/agent\/sessions\?_=/);
        expect(calls[0].options?.cache).toBe('no-store');
        expect((calls[0].options?.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
        expect(calls[1].endpoint).not.toBe(calls[0].endpoint);
    });

    it('reads the cheap identity view without waiting for full enrichment', async () => {
        let endpoint = '';
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockImplementation(async (value) => {
            endpoint = value;
            return response(200, { linked_agents: [IDENTITY] });
        });

        await expect(RelayAPIService.getLinkedAgentIdentities({ throwOnError: true }))
            .resolves.toEqual({ linked_agents: [IDENTITY] });
        expect(endpoint).toMatch(/^\/v1\/relay\/agent\/sessions\?view=identity&_=/);
    });

    it('keeps the last confirmed full list when a refresh gets a 304 or 503', async () => {
        vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValueOnce(response(200, { linked_agents: [FULL] }))
            .mockResolvedValueOnce(response(304, {}))
            .mockResolvedValueOnce(response(503, {}));

        expect((await RelayAPIService.getLinkedAgents()).linked_agents).toEqual([FULL]);
        expect((await RelayAPIService.getLinkedAgents()).linked_agents).toEqual([FULL]);
        expect((await RelayAPIService.getLinkedAgents()).linked_agents).toEqual([FULL]);
    });

    it('coalesces concurrent rich reads from Earn and Agent Hub into one request', async () => {
        let release!: (value: Response) => void;
        const pending = new Promise<Response>((resolve) => { release = resolve; });
        const fetch = vi.spyOn(svc, 'makeAuthenticatedRequest').mockReturnValue(pending);

        const first = RelayAPIService.getLinkedAgents({ throwOnError: true });
        const second = RelayAPIService.getLinkedAgents({ throwOnError: true });
        expect(fetch).toHaveBeenCalledTimes(1);

        release(response(200, { linked_agents: [FULL] }));
        await expect(first).resolves.toEqual({ linked_agents: [FULL] });
        await expect(second).resolves.toEqual({ linked_agents: [FULL] });
    });

    it('RED: a first failed read with throwOnError stays unknown instead of becoming []', async () => {
        vi.spyOn(svc, 'makeAuthenticatedRequest').mockResolvedValue(response(503, {}));

        await expect(RelayAPIService.getLinkedAgentIdentities({ throwOnError: true }))
            .rejects.toThrow('HTTP 503');
        expect(RelayAPIService.getCachedLinkedAgentIdentities()).toBeNull();
    });

    it('a successful empty response is authoritative and clears the prior relationship', async () => {
        vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValueOnce(response(200, { linked_agents: [FULL] }))
            .mockResolvedValueOnce(response(200, { linked_agents: [] }));

        await RelayAPIService.getLinkedAgents();
        expect((await RelayAPIService.getLinkedAgents()).linked_agents).toEqual([]);
        expect(RelayAPIService.getCachedLinkedAgents()).toEqual([]);
    });

    it('a successful empty identity response also prunes prior rich cache state', async () => {
        vi.spyOn(svc, 'makeAuthenticatedRequest')
            .mockResolvedValueOnce(response(200, { linked_agents: [FULL] }))
            .mockResolvedValueOnce(response(200, { linked_agents: [] }));

        await RelayAPIService.getLinkedAgents();
        await RelayAPIService.getLinkedAgentIdentities({ throwOnError: true });
        expect(RelayAPIService.getCachedLinkedAgents()).toEqual([]);
        expect(RelayAPIService.getCachedLinkedAgentIdentities()).toEqual([]);
    });
});
