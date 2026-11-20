import { beforeEach, describe, expect, it, vi } from 'vitest';
import { additionalConnectionOptions, earningConnectionStore, refreshEarningConnections, shouldShowStartEarning } from '../earningConnections';

const mocks = vi.hoisted(() => ({
    wallet: '0x1234',
    chat: vi.fn(),
    devices: vi.fn(),
    forges: vi.fn(),
    wallets: vi.fn(),
    commons: vi.fn(),
    agents: vi.fn(),
    identities: vi.fn(),
}));

vi.mock('../../capture/mobileChatConsent', () => ({ getMobileChatConsentOrThrow: mocks.chat }));
vi.mock('../../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: mocks.wallet }) } }));
vi.mock('../../../store/commonsStore', () => ({ default: { getState: () => ({ refreshMembership: mocks.commons }) } }));
vi.mock('../../../services/RelayAPIService', () => ({ default: {
    getRegisteredDevicesOrThrow: mocks.devices,
    listForgeInstallsOrThrow: mocks.forges,
    listOwnExternalAddresses: mocks.wallets,
    getLinkedAgentIdentities: mocks.identities,
    getLinkedAgents: mocks.agents,
} }));

const snapshot = () => earningConnectionStore.getState().snapshot;
const refresh = () => refreshEarningConnections(mocks.wallet);

describe('earning connection checks', () => {
    beforeEach(() => {
        earningConnectionStore.setState(earningConnectionStore.getInitialState());
        mocks.chat.mockReset().mockResolvedValue(false);
        mocks.devices.mockReset().mockResolvedValue([]);
        mocks.forges.mockReset().mockResolvedValue([]);
        mocks.wallets.mockReset().mockResolvedValue([]);
        mocks.commons.mockReset().mockResolvedValue(false);
        mocks.identities.mockReset().mockResolvedValue({ linked_agents: [] });
        mocks.agents.mockReset().mockResolvedValue({ linked_agents: [] });
    });

    it('returns deliberately disabled or removed connections to the setup list without a warning', async () => {
        mocks.chat.mockResolvedValueOnce(true);
        mocks.devices.mockResolvedValueOnce([{ status: 'active' }]);
        mocks.forges.mockResolvedValueOnce([{ provider: 'github', revoked_at: null }]);
        mocks.wallets.mockResolvedValueOnce([{ address: '0x1234' }]);
        mocks.identities.mockResolvedValueOnce({ linked_agents: [{}] });
        mocks.agents.mockResolvedValueOnce({ linked_agents: [{ external_address_linked: true }] });
        await refresh();
        expect(snapshot().states).toMatchObject({
            chat_capture: 'connected', desktop_daemon: 'connected', github: 'connected',
            own_external_wallet: 'connected', connected_agents: 'connected', agent_external_wallet: 'connected',
        });
        expect(additionalConnectionOptions(snapshot())).toEqual(['desktop_daemon', 'connected_agents', 'own_external_wallet']);
        mocks.devices.mockResolvedValueOnce([{ status: 'revoked' }]);
        mocks.forges.mockResolvedValueOnce([{ provider: 'github', revoked_at: 123 }]);
        await refresh();
        expect(Object.values(snapshot().states).every(state => state === 'available')).toBe(true);
        expect(additionalConnectionOptions(snapshot())).toEqual([]);
    });

    it('offers each additional connection independently and waits for a matching connection', () => {
        expect(additionalConnectionOptions(snapshot())).toEqual([]);
        const states = { chat_capture: 'connected', agent_external_wallet: 'connected' } as const;
        expect(additionalConnectionOptions({ ...snapshot(), states })).toEqual([]);
        for (const id of ['desktop_daemon', 'connected_agents', 'own_external_wallet'] as const) {
            expect(additionalConnectionOptions({ ...snapshot(), states: { ...states, [id]: 'connected' } })).toEqual([id]);
        }
    });

    it('marks a still-linked agent only when capture reports a break and prior work exists', async () => {
        mocks.identities.mockResolvedValue({ linked_agents: [{}] });
        mocks.agents.mockResolvedValueOnce({ linked_agents: [{ capture_broken: true }] });
        await refresh();
        expect(snapshot().states.connected_agents).toBe('available');
        const stoppedAgent = { capture_broken: true, last_pe_date: '2026-11-19' };
        mocks.agents.mockResolvedValueOnce({ linked_agents: [stoppedAgent] });
        await refresh();
        expect(snapshot().states.connected_agents).toBe('stopped');
        mocks.agents.mockResolvedValueOnce({ linked_agents: [stoppedAgent, { capture_broken: false }] });
        await refresh();
        expect(snapshot().states.connected_agents).toBe('connected');
    });

    it.each(['devices', 'wallets', 'commons'] as const)('hides Home promotion when the %s check fails, including after success', async source => {
        expect(shouldShowStartEarning(snapshot())).toBe(false);
        await refresh();
        expect(shouldShowStartEarning(snapshot())).toBe(true);
        if (source === 'devices') mocks.devices.mockRejectedValueOnce(new Error('offline'));
        else mocks[source].mockResolvedValueOnce(null);
        await refresh();
        expect(snapshot().checked).toBe(true);
        expect(shouldShowStartEarning(snapshot())).toBe(false);
        await refresh();
        expect(shouldShowStartEarning(snapshot())).toBe(true);
    });

    it('keeps Home promotion after joining Commons alone and hides it after pairing a computer', async () => {
        mocks.commons.mockResolvedValue(true);
        await refresh();
        expect(snapshot().checksSucceeded).toBe(true);
        expect(snapshot().states.commons).toBe('connected');
        expect(shouldShowStartEarning(snapshot())).toBe(true);

        mocks.devices.mockResolvedValueOnce([{ status: 'active', capture_broken: true }]);
        await refresh();
        expect(shouldShowStartEarning(snapshot())).toBe(false);
    });

    it('keeps each active computer and its own work and fault data, omitting revoked computers', async () => {
        const idle = { device_id: 'idle', status: 'active', last_work_at_ms: 100 };
        const faulted = { device_id: 'faulted', status: 'active', capture_broken: true, last_work_at_ms: 50 };
        mocks.devices.mockResolvedValueOnce([idle, faulted, { status: 'revoked', capture_broken: true }]);
        await refresh();
        expect(snapshot().computers).toEqual([idle, faulted]);
        expect(snapshot().states.desktop_daemon).toBe('connected');
    });
});
