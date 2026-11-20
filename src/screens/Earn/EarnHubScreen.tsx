/**
 * EarnHubScreen - the Earn tab root.
 *
 * Organizes every PE creation / PVT eligibility surface (EarningSurfaceRegistry) by witness
 * class and shows live connection status for each. This screen is the
 * acquisition layer: it tells each class of user how to plug their life into
 * the PE pipeline. The Abundance tab remains the results ledger.
 *
 * the wallet no longer governs agents, so there is no emergency stop,
 * pending-approval queue, or governance console here. Pending beneficiary
 * link requests stay pinned at the top (the link is one glance away); the
 * agent & device list (AgentHubScreen) is reached from the agents surface.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    RefreshControl,
    AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { matchesSurface } from '../../core/earn/EarningSurfaceRegistry';
import {
    CONNECTION_OPTIONS, additionalConnectionOptions, connectionState, hasEarningConnection, refreshEarningConnections, useEarningConnections,
} from '../../core/earn/earningConnections';
import RelayAPIService from '../../services/RelayAPIService';
import { useWalletStore } from '../../store/walletStore';
import { isSavedAccrual, readWalletTop, saveWalletTop } from '../../core/wallet/walletTopCache';
import { initialWalletTop, walletTopNote, WalletTopLoader, type WalletTopShown } from '../../core/wallet/walletTopLoad';
import type { PVTAccrual } from '../../services/RelayAPIService';
import { ActionTouchable, actionStyles, DestinationRow } from '../../components/ScreenActions';
import ParticipationCard from '../../components/ParticipationCard';
import { AppMenu } from '../../components/AppMenu';
import StatusBarBackground from '../../components/StatusBarBackground';
import { useNavigation } from '@react-navigation/native';
import type { AppParamList } from '../../navigation/types';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { timeAgo } from '../../utils/timeAgo';

/** Window of recent PE history used for per-surface activity. */
const HISTORY_WINDOW = 200;

interface EarnHubNavigation {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
}

interface EarnHubScreenProps {
    navigation: EarnHubNavigation;
}

interface HubActivity {
    recentActionTypes: readonly string[] | null;
    pendingLinkCount: number;
    pendingApprovalCount: number;
}

const EMPTY_ACTIVITY: HubActivity = { recentActionTypes: null, pendingLinkCount: 0, pendingApprovalCount: 0 };

export default function EarnHubScreen({ navigation }: EarnHubScreenProps): React.JSX.Element {
    const { t } = useTranslation();
    const address = useWalletStore(state => state.address);
    const stack = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const [participation, setParticipation] = useState<WalletTopShown<PVTAccrual>>(initialWalletTop);
    const participationLoader = useRef<WalletTopLoader<PVTAccrual> | null>(null);
    participationLoader.current ??= new WalletTopLoader<PVTAccrual>({
        read: () => RelayAPIService.getPVTAccrual(),
        readSaved: async (wallet) => {
            const saved = await readWalletTop('accrual', wallet, isSavedAccrual);
            return saved ? { value: saved.value as PVTAccrual, savedAtMs: saved.savedAtMs } : null;
        },
        save: (wallet, value) => saveWalletTop('accrual', wallet, value),
        onChange: setParticipation,
    });
    const loadParticipation = useCallback(() => participationLoader.current!.load(), []);
    React.useEffect(() => {
        participationLoader.current!.setAddress(address ?? null);
        void participationLoader.current!.load();
    }, [address]);

    useFocusEffect(
        useCallback(() => {
            void loadParticipation();
        }, [loadParticipation])
    );
    const participationNote = walletTopNote(participation, t, 'dashboard.participationUpdating', 'dashboard.participationUpdatedAgo');

    useFocusEffect(useCallback(() => {
        const sub = AppState.addEventListener('change', state => {
            if (state === 'active') void loadParticipation();
        });
        return () => sub.remove();
    }, [loadParticipation]));

    const connections = useEarningConnections(address);
    const [activity, setActivity] = useState<{ wallet: string; data: HubActivity }>();
    const data = activity?.wallet === address ? activity.data : EMPTY_ACTIVITY;
    const [refreshing, setRefreshing] = useState(false);

    const loadData = useCallback(async () => {
        if (!address) return;
        const update = (patch: Partial<HubActivity>) => {
            if (useWalletStore.getState().address !== address) return;
            setActivity(prior => ({ wallet: address, data: {
                ...(prior?.wallet === address ? prior.data : EMPTY_ACTIVITY), ...patch,
            } }));
        };

        await Promise.allSettled([
            refreshEarningConnections(address),
            RelayAPIService.getPVTHistory(HISTORY_WINDOW).then(history => {
                if (history) update({ recentActionTypes: history.entries.map(entry => entry.actionType) });
            }),
            RelayAPIService.getLinkRequests().then(requests => {
                if (requests) update({ pendingLinkCount: requests.link_requests.length });
            }),
            RelayAPIService.getWalletApprovalRequests().then(requests => update({ pendingApprovalCount: requests.length })),
        ]);
    }, [address]);

    useFocusEffect(useCallback(() => {
        void loadData();
        const sub = AppState.addEventListener('change', state => {
            if (state === 'active') void loadData();
        });
        return () => sub.remove();
    }, [loadData]));

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.allSettled([loadData(), loadParticipation()]);
        setRefreshing(false);
    }, [loadData, loadParticipation]);

    const connected = CONNECTION_OPTIONS.filter(({ id }) => connectionState(connections, id) === 'connected');
    const available = CONNECTION_OPTIONS.filter(({ id }) => connectionState(connections, id) !== 'connected');
    const hasConnection = hasEarningConnection(connections);
    const connectPrompt = hasConnection ? 'overhaul.connectNext'
        : connections.checked ? 'overhaul.connectFirst' : 'overhaul.connections';
    const additional = additionalConnectionOptions(connections);
    const connectionSetup = {
        desktop_daemon: {
            label: 'overhaul.anotherComputer', visual: { icon: 'computer' },
            open: () => stack.navigate('ComputerPairing'),
        },
        connected_agents: {
            label: 'overhaul.anotherAgent', visual: { icon: 'agent' },
            open: () => stack.navigate('ConnectAgent', { mode: 'agent' }),
        },
        own_external_wallet: {
            label: 'overhaul.anotherWallet', visual: { stockIcon: 'key-outline' },
            open: () => stack.navigate('ProveOwnWallet'),
        },
    } as const;

    const renderConnection = (surface: typeof CONNECTION_OPTIONS[number]) => {
        if (surface.id === 'desktop_daemon' && connections.computers.length > 0) {
            return connections.computers.map(computer => {
                const status = computer.capture_broken === true
                    ? t('overhaul.needsAttention') : t('earn.status.connected');
                const lastWork = computer.last_work_at_ms != null ? timeAgo(computer.last_work_at_ms, t) : '';
                const detail = lastWork ? `${status} · ${t('overhaul.lastRecordedWork', { time: lastWork })}` : status;
                return <DestinationRow key={computer.device_id}
                    label={connections.computers.length === 1 ? t('earn.surfaces.desktop_daemon.title') : computer.device_name}
                    detail={detail} icon="computer"
                    onPress={() => {
                        if (computer.capture_broken === true || connections.computers.length > 1) {
                            stack.navigate('DeviceManagement', { deviceId: computer.device_id });
                        } else {
                            navigation.navigate('EarnSurfaceDetail', { surfaceId: surface.id });
                        }
                    }} />;
            });
        }

        const state = connectionState(connections, surface.id);
        const label = surface.id === 'github' && state !== 'connected'
            ? t('overhaul.connectGitHub') : t(`earn.surfaces.${surface.id}.title`);
        const icon = surface.id === 'desktop_daemon' ? 'computer'
            : surface.id === 'connected_agents' || surface.id === 'agent_external_wallet' ? 'agent'
            : surface.id === 'chat_capture' ? 'chat' : undefined;
        const statusLabel = state === 'connected' ? t('earn.status.connected')
            : state === 'stopped' ? t('overhaul.needsAttention') : null;
        const recentCount = data.recentActionTypes?.filter(actionType => matchesSurface(surface, actionType)).length;
        const description = t(`earn.surfaces.${surface.id}.tagline`);
        const note = state === 'connected' && surface.id === 'agent_external_wallet'
            ? t('earn.surfaces.agent_external_wallet.cardLinked', { count: connections.linkedWalletCount })
            : state === 'connected' && recentCount ? t('earn.recentCount', { count: recentCount })
            : state === undefined && connections.checked ? t('overhaul.couldNotCheckConnection') : description;

        const open = () => {
            if (surface.id === 'connected_agents' && connections.linkedAgentCount > 0) return navigation.navigate('AgentHub');
            if (state !== 'connected') {
                const target = surface.target;
                if (target?.kind === 'forge') return stack.navigate('ForgeConnect', { provider: target.provider });
                if (surface.id === 'own_external_wallet' || surface.id === 'desktop_daemon' || surface.id === 'connected_agents') {
                    return connectionSetup[surface.id].open();
                }
            }
            navigation.navigate('EarnSurfaceDetail', { surfaceId: surface.id });
        };
        return <DestinationRow key={surface.id} label={label} detail={statusLabel ? `${statusLabel} · ${note}` : note}
            icon={icon} stockIcon={icon ? undefined : surface.icon as keyof typeof Ionicons.glyphMap}
            busy={state === undefined && !connections.checked} onPress={state !== undefined && !surface.comingSoon ? open : undefined} />;
    };

    const waysToEarn = (available.length > 0 || additional.length > 0) && <View style={styles.section}>
        <Text accessibilityRole="header" style={actionStyles.sectionTitle}>{t(connectPrompt)}</Text>
        {available.map(renderConnection)}
        {additional.map(id => {
            const { label, visual, open } = connectionSetup[id];
            return <DestinationRow key={id} label={t(label)} {...visual} onPress={open} />;
        })}
    </View>;

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                contentInsetAdjustmentBehavior="never"
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
            >
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        <Text style={styles.title}>{t('earn.title')}</Text>
                        <Text style={styles.subtitle}>{t('earn.subtitle')}</Text>
                    </View>
                    <AppMenu />
                </View>

                {!hasConnection && waysToEarn}

                <ParticipationCard
                    pvtAccrual={participation.value}
                    loadError={participation.phase === 'failed'}
                    note={participationNote}
                    onRetry={loadParticipation}
                    onPress={() => navigation.navigate('MyProvenance')}
                />

                {/* Agents that connected with your code and are waiting to be linked.
                    Pinned above the stats so the beneficiary link is one glance away. */}
                {data.pendingLinkCount > 0 && (
                    <View style={styles.safetyRow}>
                        <ActionTouchable
                            style={styles.pendingChip}
                            onPress={() => navigation.navigate('AgentHub')}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="link" size={14} color="#E8A838" />
                            <Text style={styles.pendingChipText}>
                                {t('agentHub.linkRequestsTitle')}
                            </Text>
                        </ActionTouchable>
                    </View>
                )}

                {/* §2.1: agents asking THIS human to approve a described action. */}
                {data.pendingApprovalCount > 0 && (
                    <View style={styles.safetyRow}>
                        <ActionTouchable
                            style={styles.approvalChip}
                            onPress={() => navigation.navigate('ApprovalInbox')}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="checkmark-done-circle" size={14} color={COLORS.platinum} />
                            <Text style={styles.approvalChipText}>
                                {t('trustLayer.approvalInbox.pendingChip', { count: data.pendingApprovalCount })}
                            </Text>
                        </ActionTouchable>
                    </View>
                )}

                {connected.length > 0 && <View style={styles.section}>
                    <Text accessibilityRole="header" style={actionStyles.sectionTitle}>{t('earn.status.connected')}</Text>
                    {connected.map(renderConnection)}
                </View>}

                <View style={styles.section}>
                    <DestinationRow label={t('overhaul.proofsAndEarnings')} icon="proof"
                        detail={participation.value?.weeklyPEs === undefined ? undefined
                            : t('earn.recentCount', { count: participation.value.weeklyPEs })}
                        onPress={() => navigation.navigate('MyProvenance')} />
                    <Text style={actionStyles.body}>{t('overhaul.standardSettlement')}</Text>
                </View>

                {hasConnection && waysToEarn}
            </ScrollView>
            <StatusBarBackground />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: 120 },
    header: {
        paddingTop: SPACING.m,
        marginBottom: SPACING.m,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { fontSize: 28, fontWeight: '700', color: COLORS.text },
    subtitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: 4, lineHeight: 20 },

    safetyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginBottom: SPACING.m },
    pendingChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(232,168,56,0.40)',
        backgroundColor: 'rgba(232,168,56,0.10)',
    },
    pendingChipText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: '#E8A838' },
    approvalChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.platinumMuted,
        backgroundColor: 'rgba(226,232,240,0.08)',
    },
    approvalChipText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: COLORS.platinum },

    section: { marginTop: SPACING.l },
});
