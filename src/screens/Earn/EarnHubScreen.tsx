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
import {
    EARNING_SURFACES,
    getSurface,
    isSurfaceConnectionKnown,
    resolveAllSurfaceStatuses,
    shouldManageConnectedAgents,
    type EarningSurfaceId,
    type SurfaceStatusInputs,
    type SurfaceStatusResult,
    type SurfaceConnectionReadiness,
} from '../../core/earn/EarningSurfaceRegistry';
import RelayAPIService from '../../services/RelayAPIService';
import { getMobileChatConsent } from '../../core/capture/mobileChatConsent';
import { anyLinkedAgentLive } from '../../utils/agentLiveness';
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
import useCommonsStore from '../../store/commonsStore';

/** Window of recent PE history used for per-surface activity. */
const HISTORY_WINDOW = 200;

const CONNECTION_OPTIONS = EARNING_SURFACES.filter(({ id }) => id !== 'promises' && id !== 'wallet_activity');

interface EarnHubNavigation {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
}

interface EarnHubScreenProps {
    navigation: EarnHubNavigation;
}

interface HubData {
    statuses: Record<EarningSurfaceId, SurfaceStatusResult>;
    pendingLinkCount: number;
    /** §2.1: agents awaiting THIS human's approval of a described action. */
    pendingApprovalCount: number;
    /** Each setup-producing source resolves independently; unknown never renders as setup. */
    readiness: SurfaceConnectionReadiness;
    /**
     * Whether recent PE history has loaded. Until it has, a Connected card must
     * not claim "No recent activity yet" — the history may still promote it to
     * Earning (no false empty state while loading).
     */
    historyKnown: boolean;
}

const EMPTY_INPUTS: SurfaceStatusInputs = {
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

    const commonsJoined = useCommonsStore((s) => s.isJoined);
    const commonsMembershipStatus = useCommonsStore((s) => s.membershipStatus);
    const refreshCommonsMembership = useCommonsStore((s) => s.refreshMembership);

    const [cachedIdentities] = useState(() => RelayAPIService.getCachedLinkedAgentIdentities());
    const [initialInputs] = useState<SurfaceStatusInputs>(() => ({
        ...EMPTY_INPUTS,
        linkedAgentCount: cachedIdentities?.length ?? 0,
        anyLinkedAgentLive: anyLinkedAgentLive(cachedIdentities ?? []),
    }));
    const inputsRef = useRef<SurfaceStatusInputs>(initialInputs);
    const [data, setData] = useState<HubData>({
        statuses: resolveAllSurfaceStatuses(initialInputs),
        pendingLinkCount: 0,
        pendingApprovalCount: 0,
        historyKnown: false,
        readiness: {
            chatConsent: false,
            devices: false,
            linkedAgents: cachedIdentities !== null,
            commons: commonsMembershipStatus !== 'unknown',
            forgeInstalls: false,
            ownExternalWallets: false,
        },
    });
    const [refreshing, setRefreshing] = useState(false);
    const [checkedConnections, setCheckedConnections] = useState(false);

    const updateInputs = useCallback((
        patch: Partial<SurfaceStatusInputs>,
        dataPatch: Partial<Omit<HubData, 'statuses' | 'readiness'>> = {},
        readinessPatch: Partial<SurfaceConnectionReadiness> = {},
    ) => {
        inputsRef.current = { ...inputsRef.current, ...patch };
        setData((prev) => ({
            ...prev,
            ...dataPatch,
            readiness: { ...prev.readiness, ...readinessPatch },
            statuses: resolveAllSurfaceStatuses(inputsRef.current),
        }));
    }, []);

    const loadData = useCallback(async () => {
        // Identity first: this is one indexed wallet query and is enough to show
        // "Connected" immediately. Full liveness/count enrichment follows in the
        // background and may promote the card to "Earning" without blocking it.
        const agentTask = RelayAPIService.getLinkedAgentIdentities({ throwOnError: true })
            .then(({ linked_agents }) => {
                updateInputs({
                    linkedAgentCount: linked_agents.length,
                    anyLinkedAgentLive: anyLinkedAgentLive(linked_agents),
                }, {}, { linkedAgents: true });
                return RelayAPIService.getLinkedAgents({ throwOnError: true });
            })
            .then(({ linked_agents }) => {
                updateInputs({
                    linkedAgentCount: linked_agents.length,
                    linkedAgentsWithExternalWalletCount: linked_agents.filter(
                        (agent) => agent.external_address_linked === true,
                    ).length,
                    anyLinkedAgentLive: anyLinkedAgentLive(linked_agents),
                }, {}, { linkedAgents: true });
            })
            .catch((error) => {
                console.error('[EarnHub] Failed to refresh linked agents:', error);
                // Preserve a prior confirmed state; on a cold failure the agent
                // cards remain neutral/loading rather than becoming "Set up".
            });

        const tasks: Promise<unknown>[] = [
            agentTask,
            RelayAPIService.getRegisteredDevicesOrThrow()
                .then((devices) => {
                    const activeDevices = devices.filter((device) => device.status === 'active');
                    updateInputs(
                        { activeDeviceCount: activeDevices.length },
                        {},
                        { devices: true },
                    );
                })
                .catch((error) => console.error('[EarnHub] Failed to refresh devices:', error)),
            RelayAPIService.listForgeInstallsOrThrow()
                .then((forgeInstalls) => updateInputs({
                    activeForgeInstallProviders: forgeInstalls
                        .filter((install) => install.revoked_at === null)
                        .map((install) => install.provider),
                }, {}, { forgeInstalls: true }))
                .catch((error) => console.error('[EarnHub] Failed to refresh forge installs:', error)),
            RelayAPIService.listOwnExternalAddresses()
                .then((rows) => {
                    if (rows !== null) updateInputs({ ownExternalWalletCount: rows.length }, {}, { ownExternalWallets: true });
                })
                .catch((error) => console.error('[EarnHub] Failed to refresh proven wallets:', error)),
            RelayAPIService.getPVTHistory(HISTORY_WINDOW)
                .then((history) => {
                    if (history) updateInputs({ recentActionTypes: history.entries.map(entry => entry.actionType) }, { historyKnown: true });
                })
                .catch((error) => console.error('[EarnHub] Failed to refresh history:', error)),
            getMobileChatConsent()
                .then((chatConsent) => updateInputs({ chatConsent }, {}, { chatConsent: true }))
                .catch((error) => console.error('[EarnHub] Failed to read chat consent:', error)),
            RelayAPIService.getLinkRequests()
                .then((linkReq) => setData((prev) => ({
                    ...prev,
                    pendingLinkCount: (linkReq?.link_requests ?? []).length,
                })))
                .catch((error) => console.error('[EarnHub] Failed to refresh link requests:', error)),
            RelayAPIService.getWalletApprovalRequests()
                .then((approvalReqs) => setData((prev) => ({
                    ...prev,
                    pendingApprovalCount: approvalReqs.length,
                })))
                .catch((error) => console.error('[EarnHub] Failed to refresh approval requests:', error)),
            refreshCommonsMembership()
                .then((commonsMembership) => {
                    const known = commonsMembership !== null || commonsMembershipStatus !== 'unknown';
                    if (known) {
                        updateInputs(
                            { commonsJoined: commonsMembership ?? commonsJoined },
                            {},
                            { commons: true },
                        );
                    }
                })
                .catch((error) => console.error('[EarnHub] Failed to refresh Commons membership:', error)),
        ];

        await Promise.all(tasks);
        setCheckedConnections(true);
    }, [commonsJoined, commonsMembershipStatus, refreshCommonsMembership, updateInputs]);

    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([loadData(), loadParticipation()]);
        setRefreshing(false);
    }, [loadData, loadParticipation]);

    const openSurface = useCallback(
        (surfaceId: EarningSurfaceId) => {
            if (!isSurfaceConnectionKnown(getSurface(surfaceId), data.readiness)) return;
            if (shouldManageConnectedAgents(surfaceId, data.statuses[surfaceId].status)) {
                navigation.navigate('AgentHub');
                return;
            }
            if (surfaceId === 'desktop_daemon' && data.statuses[surfaceId].status === 'setup') {
                navigation.navigate('ComputerPairing');
                return;
            }
            navigation.navigate('EarnSurfaceDetail', { surfaceId });
        },
        [data.readiness, data.statuses, navigation]
    );

    const known = (surface: typeof CONNECTION_OPTIONS[number]) => isSurfaceConnectionKnown(surface, data.readiness);
    const isConnected = (surface: typeof CONNECTION_OPTIONS[number]) => {
        if (!known(surface)) return false;
        if (surface.target?.kind === 'forge') return inputsRef.current.activeForgeInstallProviders.includes(surface.target.provider);
        if (surface.id === 'commons') return inputsRef.current.commonsJoined;
        if (surface.id === 'agent_external_wallet') return data.statuses[surface.id].status === 'earning';
        return data.statuses[surface.id].status !== 'setup';
    };
    const connected = CONNECTION_OPTIONS.filter(isConnected);
    const available = CONNECTION_OPTIONS.filter(surface => !isConnected(surface));
    const connectionStatusKnown = CONNECTION_OPTIONS.every(known);
    const hasConnection = connected.some(surface => surface.id !== 'commons');
    const connectPrompt = hasConnection ? 'overhaul.connectNext'
        : connectionStatusKnown ? 'overhaul.connectFirst' : 'overhaul.connections';

    const renderConnection = (surface: typeof CONNECTION_OPTIONS[number], active: boolean) => {
        const result = data.statuses[surface.id];
        const isKnown = known(surface);
        const label = surface.id === 'github' && !active ? t('overhaul.connectGitHub') : t(`earn.surfaces.${surface.id}.title`);
        const icon = surface.id === 'desktop_daemon' ? 'computer'
            : surface.id === 'connected_agents' || surface.id === 'agent_external_wallet' ? 'agent'
            : surface.id === 'chat_capture' ? 'chat' : undefined;
        const statusLabel = active ? t('earn.status.connected')
            : isKnown || checkedConnections ? t('overhaul.needsAttention') : t('common.loading');
        const note = !isKnown ? checkedConnections ? t('overhaul.couldNotCheckConnection') : null
            : !active ? t(`earn.surfaces.${surface.id}.tagline`)
            : surface.id === 'agent_external_wallet' ? t('earn.surfaces.agent_external_wallet.cardLinked', { count: result.recentPECount })
            : result.status === 'earning' && data.historyKnown ? t('earn.recentCount', { count: result.recentPECount })
            : null;
        const start = () => {
            if (active) return openSurface(surface.id);
            const target = surface.target;
            if (target?.kind === 'forge') return stack.navigate('ForgeConnect', { provider: target.provider });
            if (surface.id === 'own_external_wallet') return stack.navigate('ProveOwnWallet');
            if (surface.id === 'desktop_daemon') return stack.navigate('ComputerPairing');
            if (surface.id === 'connected_agents') return stack.navigate('ConnectAgent', { mode: 'agent' });
            openSurface(surface.id);
        };
        return <DestinationRow key={surface.id} label={label} detail={note ? `${statusLabel} · ${note}` : statusLabel} icon={icon}
            stockIcon={icon ? undefined : surface.icon as keyof typeof Ionicons.glyphMap}
            busy={!isKnown && !checkedConnections} onPress={isKnown && !surface.comingSoon ? start : undefined} />;
    };

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
                    {connected.map(surface => renderConnection(surface, true))}
                </View>}

                <View style={styles.section}>
                    <DestinationRow label={t('overhaul.proofsAndEarnings')} icon="proof"
                        detail={participation.value?.weeklyPEs === undefined ? undefined
                            : t('earn.recentCount', { count: participation.value.weeklyPEs })}
                        onPress={() => navigation.navigate('MyProvenance')} />
                    <Text style={actionStyles.body}>{t('overhaul.standardSettlement')}</Text>
                    <DestinationRow label={t('overhaul.resumeFirstAction')} icon="home"
                        onPress={() => stack.navigate('MainTabs', { screen: 'WalletTab', params: { starterRequest: Date.now() } })} />
                </View>

                {available.length > 0 && <View style={styles.section}>
                    <Text accessibilityRole="header" style={actionStyles.sectionTitle}>{t(connectPrompt)}</Text>
                    {available.map(surface => renderConnection(surface, false))}
                </View>}
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
