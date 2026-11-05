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
    TouchableOpacity,
    RefreshControl,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import {
    EARN_GROUP_ORDER,
    EARNING_SURFACES,
    getSurface,
    isSurfaceConnectionKnown,
    resolveAllSurfaceStatuses,
    shouldManageConnectedAgents,
    surfacesByGroup,
    type EarnGroup,
    type EarningSurface,
    type EarningSurfaceId,
    type SurfaceStatus,
    type SurfaceStatusInputs,
    type SurfaceStatusResult,
    type SurfaceConnectionReadiness,
} from '../../core/earn/EarningSurfaceRegistry';
import RelayAPIService from '../../services/RelayAPIService';
import { getMobileChatConsent } from '../../core/capture/mobileChatConsent';
import { anyLinkedAgentLive } from '../../utils/agentLiveness';
import useCommonsStore from '../../store/commonsStore';

/** Window of recent PE history used for per-surface activity. */
const HISTORY_WINDOW = 200;

// Shortcuts share the full catalog's readiness checks and management routing.
// The complete phone, computer, service and agent groups remain below.
const QUICK_CONNECTIONS: readonly { surfaceId: EarningSurfaceId; labelKey: string }[] = [
    { surfaceId: 'desktop_daemon', labelKey: 'earn.groups.computer' },
    { surfaceId: 'connected_agents', labelKey: 'earn.groups.agents' },
    { surfaceId: 'own_external_wallet', labelKey: 'earn.surfaces.own_external_wallet.title' },
];

interface EarnHubNavigation {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
}

interface EarnHubScreenProps {
    navigation: EarnHubNavigation;
}

interface HubData {
    statuses: Record<EarningSurfaceId, SurfaceStatusResult>;
    weeklyPEs: number | null;
    linkedAgentCount: number;
    activeDeviceCount: number;
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

const STATUS_STYLE: Record<SurfaceStatus, { color: string; bg: string }> = {
    earning: { color: '#4CC38A', bg: 'rgba(76,195,138,0.14)' },
    connected: { color: '#6BA3F0', bg: 'rgba(107,163,240,0.14)' },
    setup: { color: '#E8A838', bg: 'rgba(232,168,56,0.14)' },
};

export default function EarnHubScreen({ navigation }: EarnHubScreenProps): React.JSX.Element {
    const { t } = useTranslation();
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
        weeklyPEs: null,
        linkedAgentCount: cachedIdentities?.length ?? 0,
        activeDeviceCount: 0,
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
                }, { linkedAgentCount: linked_agents.length }, { linkedAgents: true });
                return RelayAPIService.getLinkedAgents({ throwOnError: true });
            })
            .then(({ linked_agents }) => {
                updateInputs({
                    linkedAgentCount: linked_agents.length,
                    linkedAgentsWithExternalWalletCount: linked_agents.filter(
                        (agent) => agent.external_address_linked === true,
                    ).length,
                    anyLinkedAgentLive: anyLinkedAgentLive(linked_agents),
                }, { linkedAgentCount: linked_agents.length }, { linkedAgents: true });
            })
            .catch((error) => {
                console.error('[EarnHub] Failed to refresh linked agents:', error);
                // Preserve a prior confirmed state; on a cold failure the agent
                // cards remain neutral/loading rather than becoming "Set up".
            });

        const tasks: Promise<unknown>[] = [
            agentTask,
            RelayAPIService.getRegisteredDevices()
                .then((devices) => {
                    const activeDevices = devices.filter((device) => device.status === 'active');
                    updateInputs(
                        { activeDeviceCount: activeDevices.length },
                        { activeDeviceCount: activeDevices.length },
                        { devices: true },
                    );
                })
                .catch((error) => console.error('[EarnHub] Failed to refresh devices:', error)),
            RelayAPIService.listForgeInstalls()
                .then((forgeInstalls) => updateInputs({
                    activeForgeInstallProviders: forgeInstalls
                        .filter((install) => install.revoked_at === null)
                        .map((install) => install.provider),
                }, {}, { forgeInstalls: true }))
                .catch((error) => console.error('[EarnHub] Failed to refresh forge installs:', error)),
            // A failed read still settles readiness (count unchanged): the card must
            // never hold the person away from the proof flow, which re-reads the list.
            RelayAPIService.listOwnExternalAddresses()
                .then((rows) => updateInputs(
                    rows === null ? {} : { ownExternalWalletCount: rows.length },
                    {},
                    { ownExternalWallets: true },
                ))
                .catch((error) => console.error('[EarnHub] Failed to refresh proven wallets:', error)),
            RelayAPIService.getPVTAccrual()
                .then((accrual) => setData((prev) => ({ ...prev, weeklyPEs: accrual?.weeklyPEs ?? null })))
                .catch((error) => console.error('[EarnHub] Failed to refresh accrual:', error)),
            RelayAPIService.getPVTHistory(HISTORY_WINDOW)
                .then((history) => updateInputs({
                    recentActionTypes: (history?.entries ?? []).map((entry) => entry.actionType),
                }, history ? { historyKnown: true } : {}))
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
    }, [commonsJoined, commonsMembershipStatus, refreshCommonsMembership, updateInputs]);

    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    const openSurface = useCallback(
        (surfaceId: EarningSurfaceId) => {
            if (!isSurfaceConnectionKnown(getSurface(surfaceId), data.readiness)) return;
            if (shouldManageConnectedAgents(surfaceId, data.statuses[surfaceId].status)) {
                navigation.navigate('AgentHub');
                return;
            }
            navigation.navigate('EarnSurfaceDetail', { surfaceId });
        },
        [data.readiness, data.statuses, navigation]
    );

    // Coming-soon connectors have no in-app connect flow yet, so they are not
    // counted toward "surfaces active" (numerator or denominator).
    const liveSurfaces = EARNING_SURFACES.filter((s) => !s.comingSoon);
    const allStatusesKnown = liveSurfaces.every((surface) =>
        isSurfaceConnectionKnown(surface, data.readiness));
    const activeCount = allStatusesKnown
        ? liveSurfaces.filter((s) => data.statuses[s.id].status !== 'setup').length
        : null;

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
            >
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        <Text style={styles.title}>{t('earn.title')}</Text>
                        <Text style={styles.subtitle}>{t('earn.subtitle')}</Text>
                    </View>
                    <TouchableOpacity
                        onPress={() => navigation.navigate('Settings')}
                        style={styles.settingsButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.title')}
                    >
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>

                {/* Agents that connected with your code and are waiting to be linked.
                    Pinned above the stats so the beneficiary link is one glance away. */}
                {data.pendingLinkCount > 0 && (
                    <View style={styles.safetyRow}>
                        <TouchableOpacity
                            style={styles.pendingChip}
                            onPress={() => navigation.navigate('AgentHub')}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="link" size={14} color="#E8A838" />
                            <Text style={styles.pendingChipText}>
                                {t('agentHub.linkRequestsTitle')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* §2.1: agents asking THIS human to approve a described action. */}
                {data.pendingApprovalCount > 0 && (
                    <View style={styles.safetyRow}>
                        <TouchableOpacity
                            style={styles.approvalChip}
                            onPress={() => navigation.navigate('ApprovalInbox')}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="checkmark-done-circle" size={14} color={COLORS.platinum} />
                            <Text style={styles.approvalChipText}>
                                {t('trustLayer.approvalInbox.pendingChip', { count: data.pendingApprovalCount })}
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}

                <View style={styles.quickConnections}>
                    {QUICK_CONNECTIONS.map(({ surfaceId, labelKey }) => {
                        const surface = getSurface(surfaceId);
                        const loading = !isSurfaceConnectionKnown(surface, data.readiness);
                        return (
                            <TouchableOpacity
                                key={surfaceId}
                                testID={`earn-shortcut-${surfaceId}`}
                                style={styles.quickConnection}
                                onPress={() => openSurface(surfaceId)}
                                disabled={loading}
                                accessibilityRole="button"
                                accessibilityLabel={t(labelKey)}
                                accessibilityState={{ disabled: loading, busy: loading }}
                                activeOpacity={0.8}
                            >
                                <Ionicons name={surface.icon as keyof typeof Ionicons.glyphMap} size={20} color={COLORS.primary} />
                                <Text style={styles.quickConnectionText}>{t(labelKey)}</Text>
                                {loading
                                    ? <ActivityIndicator size="small" color={COLORS.textMuted} />
                                    : <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />}
                            </TouchableOpacity>
                        );
                    })}
                </View>

                <Text style={styles.quickConnectionText}>{t('earn.batchCadence')}</Text>
                <Text style={styles.quickConnectionText}>{t('earn.settlementCadence')}</Text>

                {/* Stats */}
                <View style={styles.statsRow}>
                    <View style={styles.statCard}>
                        <Text style={styles.statLabel}>{t('earn.surfacesActive')}</Text>
                        <Text style={styles.statValue}>
                            {activeCount ?? '–'}
                            <Text style={styles.statValueMuted}> / {liveSurfaces.length}</Text>
                        </Text>
                    </View>
                    <View style={styles.statCard}>
                        <Text style={styles.statLabel}>{t('earn.pesThisWeek')}</Text>
                        <Text style={styles.statValue}>{data.weeklyPEs ?? '–'}</Text>
                    </View>
                </View>

                {/* Surface groups */}
                {EARN_GROUP_ORDER.map((group) => (
                    <SurfaceGroup
                        key={group}
                        group={group}
                        statuses={data.statuses}
                        readiness={data.readiness}
                        historyKnown={data.historyKnown}
                        onPress={openSurface}
                        t={t}
                    />
                ))}
            </ScrollView>
        </SafeAreaView>
    );
}

// ─── Group + card components ────────────────────────────────────────────

interface SurfaceGroupProps {
    group: EarnGroup;
    statuses: Record<EarningSurfaceId, SurfaceStatusResult>;
    readiness: SurfaceConnectionReadiness;
    historyKnown: boolean;
    onPress: (surfaceId: EarningSurfaceId) => void;
    t: (key: string, opts?: Record<string, unknown>) => string;
}

const SurfaceGroup = ({ group, statuses, readiness, historyKnown, onPress, t }: SurfaceGroupProps): React.JSX.Element => (
    <View style={styles.group}>
        <Text style={styles.groupTitle}>{t(`earn.groups.${group}`)}</Text>
        <Text style={styles.groupHint}>{t(`earn.groupHints.${group}`)}</Text>
        {surfacesByGroup(group).map((surface) => (
            <SurfaceCard
                key={surface.id}
                surface={surface}
                result={statuses[surface.id]}
                loading={!isSurfaceConnectionKnown(surface, readiness)}
                historyKnown={historyKnown}
                onPress={() => onPress(surface.id)}
                t={t}
            />
        ))}
    </View>
);

interface SurfaceCardProps {
    surface: EarningSurface;
    result: SurfaceStatusResult;
    loading: boolean;
    historyKnown: boolean;
    onPress: () => void;
    t: (key: string, opts?: Record<string, unknown>) => string;
}

const SurfaceCard = ({ surface, result, loading, historyKnown, onPress, t }: SurfaceCardProps): React.JSX.Element => {
    const chip = STATUS_STYLE[result.status];
    // For the agent's-own-wallet surface, 'connected' means only the
    // prerequisite is met (a linked agent that COULD link a wallet) — no wallet
    // is linked yet, so the chip reads "Ready" rather than a misleading
    // "Connected" beside "Ready — tell your agent to link".
    const chipLabelKey = surface.id === 'agent_external_wallet' && result.status === 'connected'
        ? 'earn.status.ready'
        : `earn.status.${result.status}`;
    // Ladder reads consistently across cards: Set up -> tagline; Connected ->
    // "no recent activity yet"; Earning -> the recent count. So a Connected card
    // no longer looks like a different species from the one card that is Earning.
    // The agent_external_wallet surface's activity is the AGENT's own on-chain
    // movement, not the operator's recent PE history, so the generic
    // "N PEs recently" / "No recent activity" ladder would misread — its
    // recentPECount is "how many linked agents have a wallet linked".
    const subtitle = loading
        ? t('common.loading')
        : surface.comingSoon
        ? t(`earn.surfaces.${surface.id}.tagline`)
        : surface.id === 'own_external_wallet'
          ? result.recentPECount > 0
              ? t('earn.surfaces.own_external_wallet.cardProven', { count: result.recentPECount })
              : t('earn.surfaces.own_external_wallet.tagline')
        : surface.id === 'agent_external_wallet'
          ? result.status === 'earning'
              ? t('earn.surfaces.agent_external_wallet.cardLinked', { count: result.recentPECount })
              : result.status === 'connected'
                ? t('earn.surfaces.agent_external_wallet.cardReady')
                : t('earn.surfaces.agent_external_wallet.tagline')
          : result.status === 'earning'
            ? t('earn.recentCount', { count: result.recentPECount })
            : result.status === 'connected' && historyKnown
              ? t('earn.noRecent')
              : t(`earn.surfaces.${surface.id}.tagline`);

    return (
        <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8} disabled={loading}>
            <View style={styles.cardIconBg}>
                <Ionicons
                    name={surface.icon as keyof typeof Ionicons.glyphMap}
                    size={20}
                    color={COLORS.primary}
                />
            </View>
            {/* The status chip sits UNDER the title (not beside it), so at 320pt the title
                keeps the card's width and a long translation never pushes the chip off-card. */}
            <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{t(`earn.surfaces.${surface.id}.title`)}</Text>
                <Text style={styles.cardSubtitle} numberOfLines={2}>
                    {subtitle}
                </Text>
                {loading ? (
                    <View style={styles.statusChip}>
                        <ActivityIndicator size="small" color={COLORS.textMuted} />
                    </View>
                ) : surface.comingSoon ? (
                    <View style={[styles.statusChip, styles.comingSoonChip]}>
                        <Text style={[styles.statusChipText, styles.comingSoonChipText]}>
                            {t('earn.status.comingSoon')}
                        </Text>
                    </View>
                ) : (
                    <View style={[styles.statusChip, { backgroundColor: chip.bg }]}>
                        <Text style={[styles.statusChipText, { color: chip.color }]}>
                            {t(chipLabelKey)}
                        </Text>
                    </View>
                )}
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
        </TouchableOpacity>
    );
};

// ─── Styles ─────────────────────────────────────────────────────────────

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
    settingsButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: SPACING.s,
    },
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

    quickConnections: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginBottom: SPACING.m },
    quickConnection: {
        flexDirection: 'row',
        alignItems: 'center',
        flexGrow: 1,
        flexBasis: 150,
        minHeight: 56,
        gap: SPACING.s,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        backgroundColor: COLORS.surface,
    },
    quickConnectionText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: COLORS.text },

    statsRow: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.l },
    statCard: {
        flex: 1,
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
        padding: SPACING.m,
    },
    statLabel: { fontSize: 11, color: COLORS.textMuted, marginBottom: 4 },
    statValue: { fontSize: 20, fontWeight: '700', color: COLORS.text },
    statValueMuted: { fontSize: 14, fontWeight: '600', color: COLORS.textMuted },

    group: { marginBottom: SPACING.l },
    groupTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
    },
    groupHint: { fontSize: 12, color: COLORS.textMuted, marginTop: 2, marginBottom: SPACING.s },

    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
        padding: SPACING.m,
        marginBottom: SPACING.s,
    },
    cardIconBg: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(74,142,232,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    cardBody: { flex: 1, minWidth: 0 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: 2 },
    cardSubtitle: { fontSize: 12, color: COLORS.textSecondary },
    statusChip: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
        marginTop: SPACING.xs,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: BORDER_RADIUS.m,
    },
    statusChipText: { fontSize: 11, fontWeight: '700' },
    comingSoonChip: { backgroundColor: 'rgba(156,163,175,0.14)' },
    comingSoonChipText: { color: '#9CA3AF' },
});
