import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import RelayAPIService from '../../services/RelayAPIService';
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
    linkedAgentCount: number;
    linkedWalletCount: number;
}

const EMPTY: ConnectionSnapshot = { states: {}, checked: false, linkedAgentCount: 0, linkedWalletCount: 0 };
const store = create<{ wallet: string; snapshot: ConnectionSnapshot }>(() => ({ wallet: '', snapshot: EMPTY }));
const inFlight = new Map<string, Promise<void>>();

export function useEarningConnections(wallet: string): ConnectionSnapshot {
    return store(state => state.wallet === wallet ? state.snapshot : EMPTY);
}

export function hasEarningConnection(snapshot: ConnectionSnapshot): boolean {
    return CONNECTION_OPTIONS.some(({ id }) => id !== 'commons' && connectionState(snapshot, id) === 'connected');
}

export function connectionState(snapshot: ConnectionSnapshot, id: SetupSurface): ConnectionState | undefined {
    return snapshot.states[id];
}

export function resolveConnection(working: boolean, workedBefore: boolean): ConnectionState {
    if (working) return 'connected';
    return workedBefore ? 'stopped' : 'available';
}

export function refreshEarningConnections(wallet: string): Promise<void> {
    if (!wallet) return Promise.resolve();
    if (store.getState().wallet !== wallet) store.setState({ wallet, snapshot: EMPTY });
    const existing = inFlight.get(wallet);
    if (existing) return existing;

    const promise = readConnections(wallet).finally(() => inFlight.delete(wallet));
    inFlight.set(wallet, promise);
    return promise;
}

async function readConnections(wallet: string): Promise<void> {
    const key = `provian.earn.connections.${wallet.toLowerCase()}`;
    const workedBefore = new Set<SetupSurface>();
    const update = (patch: Partial<ConnectionSnapshot>) => {
        if (useWalletStore.getState().address !== wallet || store.getState().wallet !== wallet) return;
        store.setState(state => ({ snapshot: { ...state.snapshot, ...patch } }));
    };
    try {
        const raw = await AsyncStorage.getItem(key);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) for (const { id } of CONNECTION_OPTIONS) {
            if (parsed.includes(id)) workedBefore.add(id);
        }
    } catch { /* A missing display history is not a failed connection. */ }

    if (useWalletStore.getState().address !== wallet || store.getState().wallet !== wallet) return;
    const beforeCount = workedBefore.size;
    for (const { id } of CONNECTION_OPTIONS) {
        const prior = connectionState(store.getState().snapshot, id);
        if (prior === 'connected' || prior === 'stopped') workedBefore.add(id);
    }
    const answer = (id: SetupSurface, working: boolean, hasHistory = false) => {
        if (working || hasHistory) workedBefore.add(id);
        update({ states: { ...store.getState().snapshot.states, [id]: resolveConnection(working, workedBefore.has(id)) } });
    };

    await Promise.allSettled([
        getMobileChatConsentOrThrow().then(consent => answer('chat_capture', consent === true)),
        RelayAPIService.getRegisteredDevicesOrThrow().then(devices => answer('desktop_daemon',
            devices.some(device => device.status === 'active'), devices.some(device => device.status === 'revoked'))),
        RelayAPIService.listForgeInstallsOrThrow().then(installs => {
            for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
                const proven = installs.filter(install => install.provider === provider && install.control_proven !== false);
                answer(provider, proven.some(install => install.revoked_at === null), proven.some(install => install.revoked_at !== null));
            }
        }),
        RelayAPIService.listOwnExternalAddresses().then(rows => {
            if (rows !== null) answer('own_external_wallet', rows.length > 0);
        }),
        useCommonsStore.getState().refreshMembership().then(joined => {
            const commons = useCommonsStore.getState();
            if (joined !== null || commons.membershipStatus !== 'unknown') answer('commons', joined ?? commons.isJoined);
        }),
        RelayAPIService.getLinkedAgentIdentities({ throwOnError: true }).then(({ linked_agents }) => {
            update({ linkedAgentCount: linked_agents.length });
            if (linked_agents.length === 0) {
                answer('connected_agents', false);
                update({ linkedWalletCount: 0 });
                answer('agent_external_wallet', false);
                return;
            }
            return RelayAPIService.getLinkedAgents({ throwOnError: true }).then(({ linked_agents: agents }) => {
                const linkedWalletCount = agents.filter(agent => agent.external_address_linked === true).length;
                update({ linkedAgentCount: agents.length, linkedWalletCount });
                answer('connected_agents', agents.some(agent => agent.capture_broken !== true),
                    agents.some(agent => agent.capture_broken === true && Boolean(agent.last_pe_date || agent.last_capture_at_ms)));
                answer('agent_external_wallet', linkedWalletCount > 0);
            });
        }),
    ]);
    update({ checked: true });
    if (workedBefore.size > beforeCount && useWalletStore.getState().address === wallet) {
        await AsyncStorage.setItem(key, JSON.stringify([...workedBefore])).catch(() => {});
    }
}
