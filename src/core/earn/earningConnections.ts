import { create } from 'zustand';
import RelayAPIService from '../../services/RelayAPIService';
import type { RegisteredDevice } from '../../services/RelayAPIService';
import useCommonsStore from '../../store/commonsStore';
import { useWalletStore } from '../../store/walletStore';
import { getMobileChatConsentOrThrow } from '../capture/mobileChatConsent';
import { EARNING_SURFACES, type EarningSurface, type EarningSurfaceId } from './EarningSurfaceRegistry';

type SetupSurface = Exclude<EarningSurfaceId, 'promises' | 'wallet_activity'>;
export type ConnectionState = 'available' | 'connected' | 'stopped';
type ConnectionStates = Partial<Record<SetupSurface, ConnectionState>>;

export const CONNECTION_OPTIONS = EARNING_SURFACES.filter(
    (surface): surface is EarningSurface & { id: SetupSurface } => surface.id !== 'promises' && surface.id !== 'wallet_activity',
);

interface ConnectionSnapshot {
    states: ConnectionStates;
    checked: boolean;
    checksSucceeded: boolean;
    computers: readonly RegisteredDevice[];
    linkedAgentCount: number;
    linkedWalletCount: number;
}

const EMPTY: ConnectionSnapshot = {
    states: {}, checked: false, checksSucceeded: false, computers: [], linkedAgentCount: 0, linkedWalletCount: 0,
};
export const earningConnectionStore = create<{ wallet: string; snapshot: ConnectionSnapshot }>(() => ({ wallet: '', snapshot: EMPTY }));
const inFlight = new Map<string, Promise<void>>();

export function useEarningConnections(wallet: string): ConnectionSnapshot {
    return earningConnectionStore(state => state.wallet === wallet ? state.snapshot : EMPTY);
}

export function hasEarningConnection(snapshot: ConnectionSnapshot): boolean {
    return CONNECTION_OPTIONS.some(({ id }) => id !== 'commons' && connectionState(snapshot, id) === 'connected');
}

export function connectionState(snapshot: ConnectionSnapshot, id: SetupSurface): ConnectionState | undefined {
    return snapshot.states[id];
}

export function shouldShowStartEarning(snapshot: ConnectionSnapshot): boolean {
    return snapshot.checksSucceeded && snapshot.linkedAgentCount === 0
        && CONNECTION_OPTIONS.every(({ id }) => id === 'commons' || connectionState(snapshot, id) === 'available');
}

export function refreshEarningConnections(wallet: string): Promise<void> {
    if (!wallet || useWalletStore.getState().address !== wallet) return Promise.resolve();
    if (earningConnectionStore.getState().wallet !== wallet) earningConnectionStore.setState({ wallet, snapshot: EMPTY });
    const existing = inFlight.get(wallet);
    if (existing) return existing;

    const promise = readConnections(wallet).finally(() => inFlight.delete(wallet));
    inFlight.set(wallet, promise);
    return promise;
}

async function readConnections(wallet: string): Promise<void> {
    const update = (patch: Partial<ConnectionSnapshot>) => {
        if (useWalletStore.getState().address !== wallet || earningConnectionStore.getState().wallet !== wallet) return;
        earningConnectionStore.setState(state => ({ snapshot: { ...state.snapshot, ...patch } }));
    };
    const answer = (id: SetupSurface, state: ConnectionState) => {
        update({ states: { ...earningConnectionStore.getState().snapshot.states, [id]: state } });
    };
    const availability = (connected: boolean): ConnectionState => connected ? 'connected' : 'available';

    const checks = [
        getMobileChatConsentOrThrow().then(consent => answer('chat_capture', availability(consent === true))),
        RelayAPIService.getRegisteredDevicesOrThrow().then(devices => {
            const computers = devices.filter(device => device.status === 'active');
            update({ computers, states: {
                ...earningConnectionStore.getState().snapshot.states,
                desktop_daemon: availability(computers.length > 0),
            } });
        }),
        RelayAPIService.listForgeInstallsOrThrow().then(installs => {
            for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
                answer(provider, availability(installs.some(install =>
                    install.provider === provider && install.control_proven !== false && install.revoked_at === null)));
            }
        }),
        RelayAPIService.listOwnExternalAddresses().then(rows => {
            if (rows === null) throw new Error('Could not check linked wallets');
            answer('own_external_wallet', availability(rows.length > 0));
        }),
        useCommonsStore.getState().refreshMembership().then(joined => {
            if (joined === null) throw new Error('Could not check Commons membership');
            answer('commons', availability(joined));
        }),
        RelayAPIService.getLinkedAgentIdentities({ throwOnError: true }).then(({ linked_agents }) => {
            update({ linkedAgentCount: linked_agents.length });
            if (linked_agents.length === 0) {
                answer('connected_agents', 'available');
                update({ linkedWalletCount: 0 });
                answer('agent_external_wallet', 'available');
                return;
            }
            return RelayAPIService.getLinkedAgents({ throwOnError: true }).then(({ linked_agents: agents }) => {
                const linkedWalletCount = agents.filter(agent => agent.external_address_linked === true).length;
                update({ linkedAgentCount: agents.length, linkedWalletCount });
                const working = agents.some(agent => agent.capture_broken !== true);
                const brokeAfterWorking = agents.some(agent => agent.capture_broken === true
                    && Boolean(agent.last_pe_date || agent.last_capture_at_ms));
                // Only a reported failure on a still-linked witness is evidence of a break.
                answer('connected_agents', working ? 'connected' : brokeAfterWorking ? 'stopped' : 'available');
                answer('agent_external_wallet', availability(linkedWalletCount > 0));
            });
        }),
    ];
    const results = await Promise.allSettled(checks.map(check => check.catch(error => {
        update({ checksSucceeded: false });
        throw error;
    })));
    update({ checked: true, checksSucceeded: results.every(result => result.status === 'fulfilled') });
}
