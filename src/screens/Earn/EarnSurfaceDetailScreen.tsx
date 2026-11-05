/**
 * EarnSurfaceDetailScreen - standardized detail view for one earning surface.
 *
 * Renders, for any registry entry: what the surface is, which PE types it
 * records (with impact tiers), how to start (numbered steps), and a
 * primary CTA that deep-links into the real flow - a tab for in-app
 * surfaces, ConnectAgentScreen for witness setup flows. Connect mechanics
 * (tokens, CLI commands, QR codes) intentionally stay in ConnectAgentScreen;
 * this screen is the education layer above them.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import {
    getSurface,
    resolveSurfaceStatus,
    shouldManageConnectedAgents,
    type SurfaceStatusInputs,
    type SurfaceStatusResult,
    type SurfaceTarget,
} from '../../core/earn/EarningSurfaceRegistry';
import RelayAPIService, { type RegisteredDevice, type DeviceCaptureStatus } from '../../services/RelayAPIService';
import { getMobileChatConsent } from '../../core/capture/mobileChatConsent';
import { anyLinkedAgentLive } from '../../utils/agentLiveness';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import useCommonsStore from '../../store/commonsStore';
import type { EarnSurfaceDetailScreenProps } from '../../navigation/types';
import BackButton from '../../components/BackButton';

const HISTORY_WINDOW = 200;

// Derive the AI-app (LLM-session) capture status line for a device row from the
// daemon's self-report. Returns null when there's nothing useful to show (the
// daemon hasn't reported yet). `showHint` flags the actionable "grant macOS
// permissions" case — the whole reason this surface exists.
type CaptureView = { textKey: string; icon: string; color: string; showHint: boolean };
function captureStatusView(cs: DeviceCaptureStatus | null | undefined): CaptureView | null {
    if (!cs) return null;
    if (!cs.llm_session_enabled) {
        return { textKey: 'earn.deviceCaptureOff', icon: 'moon-outline', color: '#8A94A6', showHint: false };
    }
    if (!cs.active) {
        return { textKey: 'earn.deviceCaptureUnsupported', icon: 'remove-circle-outline', color: '#8A94A6', showHint: false };
    }
    // macOS is the only platform where the observer needs OS permissions to see
    // foreground AI apps. Elsewhere, active === capturing.
    if (cs.platform === 'darwin' && (!cs.accessibility || !cs.input_monitoring)) {
        if (!cs.permissions_checked) {
            return { textKey: 'earn.deviceCaptureStarting', icon: 'ellipsis-horizontal-circle-outline', color: '#6BA3F0', showHint: false };
        }
        return { textKey: 'earn.deviceCaptureNeedsPermission', icon: 'alert-circle-outline', color: '#E8B84B', showHint: true };
    }
    return { textKey: 'earn.deviceCaptureOn', icon: 'sparkles', color: '#4CC38A', showHint: false };
}

export default function EarnSurfaceDetailScreen({
    navigation,
    route,
}: EarnSurfaceDetailScreenProps): React.JSX.Element {
    const { t } = useTranslation();
    const surface = getSurface(route.params.surfaceId);
    const commonsJoined = useCommonsStore((s) => s.isJoined);
    const commonsMembershipStatus = useCommonsStore((s) => s.membershipStatus);
    const refreshCommonsMembership = useCommonsStore((s) => s.refreshMembership);
    const [result, setResult] = useState<SurfaceStatusResult | null>(() => {
        if (surface.id !== 'connected_agents' && surface.id !== 'agent_external_wallet') return null;
        const cachedAgents = RelayAPIService.getCachedLinkedAgents()
            ?? RelayAPIService.getCachedLinkedAgentIdentities();
        if (cachedAgents === null) return null;
        return resolveSurfaceStatus(surface, {
            chatConsent: null,
            activeDeviceCount: 0,
            linkedAgentCount: cachedAgents.length,
            linkedAgentsWithExternalWalletCount: cachedAgents.filter(
                (agent) => 'external_address_linked' in agent && agent.external_address_linked === true,
            ).length,
            ownExternalWalletCount: 0,
            anyLinkedAgentLive: anyLinkedAgentLive(cachedAgents),
            commonsJoined: false,
            activeForgeInstallProviders: [],
            recentActionTypes: [],
        });
    });
    // Registered computers, so the daemon detail can show WHICH machines are
    // connected and whether each is actually witnessing (has recorded PEs).
    const [devices, setDevices] = useState<RegisteredDevice[]>([]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const needsAgentTruth =
                    surface.id === 'connected_agents' || surface.id === 'agent_external_wallet';

                // The linked identity is one cheap indexed query and is enough
                // to replace the long "Checking status" hold with truthful
                // Connected/Set up state. Full enrichment continues below and
                // may promote Connected → Earning without blocking the CTA.
                if (needsAgentTruth) {
                    try {
                        const identityData = await RelayAPIService.getLinkedAgentIdentities({ throwOnError: true });
                        if (cancelled) return;
                        setResult(resolveSurfaceStatus(surface, {
                            chatConsent: null,
                            activeDeviceCount: 0,
                            linkedAgentCount: identityData.linked_agents.length,
                            linkedAgentsWithExternalWalletCount: 0,
                            ownExternalWalletCount: 0,
                            anyLinkedAgentLive: anyLinkedAgentLive(identityData.linked_agents),
                            commonsJoined: false,
                            activeForgeInstallProviders: [],
                            recentActionTypes: [],
                        }));
                    } catch (error) {
                        console.error('[EarnSurfaceDetail] Failed to refresh linked-agent identity:', error);
                        // Unknown stays neutral. A transport failure is not proof
                        // that the user has no linked agent.
                    }
                }

                const [relayData, devices, forgeInstalls, history, chatConsent, commonsMembership, ownWallets] =
                    await Promise.all([
                        needsAgentTruth
                            ? RelayAPIService.getLinkedAgents({ throwOnError: true })
                            : Promise.resolve({ linked_agents: [] }),
                        RelayAPIService.getRegisteredDevices().catch(() => []),
                        RelayAPIService.listForgeInstalls().catch(() => []),
                        RelayAPIService.getPVTHistory(HISTORY_WINDOW),
                        getMobileChatConsent(),
                        refreshCommonsMembership(),
                        surface.id === 'own_external_wallet'
                            ? RelayAPIService.listOwnExternalAddresses().catch(() => null)
                            : Promise.resolve(null),
                    ]);
                if (cancelled) return;
                setDevices(devices);
                if (
                    surface.id === 'commons' &&
                    commonsMembership === null &&
                    commonsMembershipStatus === 'unknown'
                ) {
                    // Unknown is not "not joined". Keep the neutral loading
                    // presentation instead of showing setup after a failed read.
                    return;
                }
                const inputs: SurfaceStatusInputs = {
                    chatConsent,
                    activeDeviceCount: devices.filter((d) => d.status === 'active').length,
                    linkedAgentCount: relayData.linked_agents.length,
                    linkedAgentsWithExternalWalletCount: relayData.linked_agents.filter(
                        (a) => a.external_address_linked === true,
                    ).length,
                    ownExternalWalletCount: ownWallets?.length ?? 0,
                    anyLinkedAgentLive: anyLinkedAgentLive(relayData.linked_agents),
                    commonsJoined: commonsMembership ?? commonsJoined,
                    activeForgeInstallProviders: forgeInstalls
                        .filter((i) => i.revoked_at === null)
                        .map((i) => i.provider),
                    recentActionTypes: (history?.entries ?? []).map((e) => e.actionType),
                };
                setResult(resolveSurfaceStatus(surface, inputs));
            } catch (error) {
                console.error('[EarnSurfaceDetail] Failed to load status:', error);
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [surface, commonsJoined, commonsMembershipStatus, refreshCommonsMembership]);

    const handleCTA = useCallback(() => {
        const target: SurfaceTarget | undefined = surface.target;
        // Coming-soon connectors have no target and a non-actionable CTA.
        if (!target) return;
        switch (target.kind) {
            case 'tab':
                navigation.navigate('MainTabs', { screen: target.tab });
                break;
            case 'screen':
                navigation.navigate(target.screen);
                break;
            case 'connect':
                // Never let the neutral loading state fall through into the
                // first-agent flow. The relay response decides whether this is
                // setup or management; unknown stays non-actionable.
                if (surface.id === 'connected_agents' && result == null) break;
                // When the agents surface already has a connected/earning agent,
                // the CTA manages agents (Agent Hub) instead of walking through
                // first-time connect again. Only 'setup' (or unknown) status still
                // routes to the connect walkthrough.
                if (result != null && shouldManageConnectedAgents(surface.id, result.status)) {
                    navigation.navigate('AgentHub');
                    break;
                }
                navigation.navigate('ConnectAgent', { mode: target.mode });
                break;
            case 'forge':
                navigation.navigate('ForgeConnect', { provider: target.provider });
                break;
            case 'url':
                // Agent-side capability — the human cannot call the link endpoint,
                // so the CTA opens the public "how it works" page rather than an
                // in-app flow. Fail-soft: a rejected openURL just no-ops.
                Linking.openURL(target.url).catch(() => {});
                break;
        }
    }, [navigation, surface, result]);

    const statusRequiredBeforeCTA =
        result == null && (surface.id === 'connected_agents' || surface.id === 'commons');

    // Copy-to-clipboard feedback for the agent_external_wallet instruction row.
    const [copied, setCopied] = useState(false);
    const copyInstruction = useCallback(async () => {
        try {
            await Clipboard.setStringAsync(t('earn.surfaces.agent_external_wallet.instructionCommand'));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard unavailable — no-op */
        }
    }, [t]);

    const steps = Array.from({ length: surface.stepCount }, (_, i) => i + 1);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {t(`earn.surfaces.${surface.id}.title`)}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <View style={styles.heroIconBg}>
                    <Ionicons
                        name={surface.icon as keyof typeof Ionicons.glyphMap}
                        size={30}
                        color={COLORS.primary}
                    />
                </View>
                <Text style={styles.description}>{t(`earn.surfaces.${surface.id}.description`)}</Text>

                {/* What it records */}
                <Text style={styles.sectionTitle}>{t('earn.whatItEarns')}</Text>
                <View style={styles.chipsWrap}>
                    {surface.peTypes.map((pe) => {
                        const display = getActionTypeDisplay(pe.actionType);
                        return (
                            <View key={pe.actionType} style={styles.peChip}>
                                <Ionicons name={display.icon} size={14} color={COLORS.primary} />
                                <Text style={styles.peChipType}>{display.label}</Text>
                            </View>
                        );
                    })}
                </View>

                {surface.comingSoon ? (
                    <>
                        {/* Coming-soon connectors: no in-app connect flow yet. Local
                            commits to these forges already create PEs via the desktop daemon. */}
                        <View style={styles.comingSoonCard}>
                            <Ionicons name="time-outline" size={18} color="#9CA3AF" />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.comingSoonTitle}>
                                    {t('earn.comingSoonTitle')}
                                </Text>
                                <Text style={styles.comingSoonBody}>
                                    {t(`earn.surfaces.${surface.id}.comingSoonBody`)}
                                </Text>
                            </View>
                        </View>

                        <View style={[styles.ctaBtn, styles.ctaDisabled]}>
                            <View style={styles.ctaGradient}>
                                <Text style={styles.ctaTextDisabled}>{t('earn.status.comingSoon')}</Text>
                            </View>
                        </View>
                    </>
                ) : (
                    <>
                        {/* How to earn */}
                        <Text style={styles.sectionTitle}>{t('earn.howToEarn')}</Text>
                        <View style={styles.stepsCard}>
                            {steps.map((n) => (
                                <View key={n} style={[styles.step, n === surface.stepCount && { marginBottom: 0 }]}>
                                    <View style={styles.stepBadge}>
                                        <Text style={styles.stepBadgeText}>{n}</Text>
                                    </View>
                                    <Text style={styles.stepText}>{t(`earn.surfaces.${surface.id}.step${n}`)}</Text>
                                </View>
                            ))}
                        </View>

                        {surface.hasNote && (
                            <View style={styles.noteCard}>
                                <Ionicons name="link-outline" size={16} color="#6BA3F0" />
                                <Text style={styles.noteText}>{t(`earn.surfaces.${surface.id}.note`)}</Text>
                            </View>
                        )}

                        {/* Hand-to-your-agent instruction (agent_external_wallet only).
                            Linking is agent-authenticated — the human cannot call the
                            endpoint — so the operator's action is to give this
                            instruction to the agent they run. */}
                        {surface.id === 'agent_external_wallet' && (
                            <View style={styles.instructionCard}>
                                <View style={styles.instructionHeader}>
                                    <Ionicons name="chatbubbles-outline" size={16} color={COLORS.primary} />
                                    <Text style={styles.instructionTitle}>
                                        {t('earn.surfaces.agent_external_wallet.instructionTitle')}
                                    </Text>
                                </View>
                                <Text style={styles.instructionBody}>
                                    {t('earn.surfaces.agent_external_wallet.instructionBody')}
                                </Text>
                                <TouchableOpacity style={styles.commandRow} onPress={copyInstruction} activeOpacity={0.8}>
                                    <Text style={styles.commandText} numberOfLines={3}>
                                        {t('earn.surfaces.agent_external_wallet.instructionCommand')}
                                    </Text>
                                    <Ionicons
                                        name={copied ? 'checkmark' : 'copy-outline'}
                                        size={16}
                                        color={copied ? '#4CC38A' : COLORS.primary}
                                    />
                                </TouchableOpacity>
                                <View style={styles.instructionStatusRow}>
                                    <Ionicons
                                        name={
                                            result?.status === 'earning'
                                                ? 'checkmark-circle'
                                                : result?.status === 'connected'
                                                  ? 'radio-button-on'
                                                  : 'ellipse-outline'
                                        }
                                        size={14}
                                        color={
                                            result?.status === 'earning'
                                                ? '#4CC38A'
                                                : result?.status === 'connected'
                                                  ? '#6BA3F0'
                                                  : COLORS.textMuted
                                        }
                                    />
                                    <Text style={styles.instructionStatusText}>
                                        {result == null
                                            ? t('earn.statusLine.loading')
                                            : result.status === 'earning'
                                              ? t('earn.surfaces.agent_external_wallet.statusLinked', {
                                                    count: result.recentPECount,
                                                })
                                              : result.status === 'connected'
                                                ? t('earn.surfaces.agent_external_wallet.statusReady')
                                                : t('earn.surfaces.agent_external_wallet.statusNoAgent')}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {/* Live status (generic surfaces; agent_external_wallet renders
                            its own tailored status above) */}
                        {surface.id !== 'agent_external_wallet' && (
                        <View style={styles.statusRow}>
                            <Ionicons
                                name={
                                    result == null
                                        ? 'time-outline'
                                        : result.status === 'earning'
                                          ? 'checkmark-circle'
                                          : result.status === 'connected'
                                            ? 'radio-button-on'
                                            : 'ellipse-outline'
                                }
                                size={16}
                                color={
                                    result?.status === 'earning'
                                        ? '#4CC38A'
                                        : result?.status === 'connected'
                                          ? '#6BA3F0'
                                          : COLORS.textMuted
                                }
                            />
                            <Text style={styles.statusText}>
                                {result == null
                                    ? t('earn.statusLine.loading')
                                    : surface.id === 'own_external_wallet'
                                      ? result.recentPECount > 0
                                          ? t('earn.surfaces.own_external_wallet.statusProven', { count: result.recentPECount })
                                          : t('earn.surfaces.own_external_wallet.statusNone')
                                    : result.status === 'earning'
                                      ? t('earn.statusLine.earning', { count: result.recentPECount })
                                      : result.status === 'connected'
                                        ? t('earn.statusLine.connected')
                                        : t('earn.statusLine.setup')}
                            </Text>
                        </View>
                        )}

                        {/* Connected computers + whether each is actually
                            witnessing (has recorded PEs) — answers "is it working?" */}
                        {surface.id === 'desktop_daemon' &&
                            devices.filter((d) => d.status === 'active').length > 0 && (
                                <View style={styles.deviceListCard}>
                                    <Text style={styles.deviceListTitle}>{t('earn.devicesTitle')}</Text>
                                    {devices
                                        .filter((d) => d.status === 'active')
                                        .map((d) => {
                                            const witnessing = d.total_pes > 0;
                                            const cap = captureStatusView(d.capture_status);
                                            return (
                                                <View key={d.device_id} style={styles.deviceRow}>
                                                    <Ionicons
                                                        name={witnessing ? 'pulse' : 'ellipse-outline'}
                                                        size={14}
                                                        color={witnessing ? '#4CC38A' : '#6BA3F0'}
                                                    />
                                                    <View style={styles.deviceRowBody}>
                                                        <Text style={styles.deviceName} numberOfLines={1}>
                                                            {d.device_name}
                                                        </Text>
                                                        <Text style={styles.deviceStatus}>
                                                            {witnessing
                                                                ? t('earn.deviceWitnessing', { count: d.total_pes })
                                                                : t('earn.deviceWaiting')}
                                                        </Text>
                                                        {cap && (
                                                            <View style={styles.captureRow}>
                                                                <Ionicons name={cap.icon as never} size={11} color={cap.color} />
                                                                <Text style={[styles.captureText, { color: cap.color }]}>
                                                                    {t(cap.textKey)}
                                                                </Text>
                                                            </View>
                                                        )}
                                                        {cap?.showHint && (
                                                            <Text style={styles.captureHint}>
                                                                {t('earn.deviceCaptureHint')}
                                                            </Text>
                                                        )}
                                                    </View>
                                                </View>
                                            );
                                        })}
                                </View>
                            )}

                        <TouchableOpacity
                            style={[
                                styles.ctaBtn,
                                statusRequiredBeforeCTA && styles.ctaDisabled,
                            ]}
                            onPress={handleCTA}
                            activeOpacity={0.85}
                            disabled={statusRequiredBeforeCTA}
                        >
                            <LinearGradient colors={GRADIENTS.primary} style={styles.ctaGradient}>
                                <Text style={styles.ctaText}>
                                    {statusRequiredBeforeCTA
                                        ? t('earn.statusLine.loading')
                                        : t(
                                            result != null && result.status !== 'setup'
                                                ? `earn.surfaces.${surface.id}.ctaConnected`
                                                : `earn.surfaces.${surface.id}.cta`,
                                            { defaultValue: t(`earn.surfaces.${surface.id}.cta`) },
                                        )}
                                </Text>
                                <Ionicons name="arrow-forward" size={16} color="#FFF" />
                            </LinearGradient>
                        </TouchableOpacity>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
    },
    headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, flex: 1, textAlign: 'center' },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },

    heroIconBg: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.m,
    },
    description: {
        fontSize: 15,
        color: COLORS.textSecondary,
        lineHeight: 22,
        textAlign: 'center',
        marginBottom: SPACING.l,
    },

    sectionTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
    },
    chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginBottom: SPACING.l },
    peChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(74,142,232,0.10)',
        borderRadius: BORDER_RADIUS.m,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.20)',
    },
    peChipType: { fontSize: 13, color: '#C8D0DC', fontWeight: '500' },

    stepsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        padding: SPACING.l,
        marginBottom: SPACING.m,
    },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.m, marginBottom: SPACING.l },
    stepBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: 'rgba(74,142,232,0.18)',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    stepBadgeText: { fontSize: 13, fontWeight: '700', color: COLORS.primary },
    stepText: { flex: 1, fontSize: 14, color: COLORS.text, lineHeight: 20 },

    noteCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: 'rgba(107,163,240,0.06)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(107,163,240,0.18)',
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    noteText: { flex: 1, fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: SPACING.l,
        paddingHorizontal: 2,
    },
    statusText: { fontSize: 13, color: COLORS.textSecondary },

    instructionCard: {
        backgroundColor: 'rgba(74,142,232,0.06)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.20)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
        gap: SPACING.s,
    },
    instructionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    instructionTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text },
    instructionBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.s,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    commandText: { flex: 1, fontSize: 12, color: '#C8D0DC', fontFamily: 'Courier', lineHeight: 17 },
    instructionStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
    instructionStatusText: { flex: 1, fontSize: 12, color: COLORS.textSecondary, lineHeight: 17 },

    deviceListCard: {
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
        gap: SPACING.s,
    },
    deviceListTitle: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: COLORS.textMuted,
        marginBottom: 2,
    },
    deviceRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
    deviceRowBody: { flex: 1 },
    deviceName: { fontSize: 14, color: COLORS.text, fontWeight: '600' },
    deviceStatus: { fontSize: 12, color: COLORS.textSecondary, marginTop: 1 },
    captureRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
    captureText: { fontSize: 11, fontWeight: '600' },
    captureHint: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2, lineHeight: 15 },

    ctaBtn: { borderRadius: 24, overflow: 'hidden' },
    ctaGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 14,
    },
    ctaText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
    ctaDisabled: {
        opacity: 0.55,
        backgroundColor: 'rgba(156,163,175,0.10)',
        borderWidth: 1,
        borderColor: 'rgba(156,163,175,0.22)',
    },
    ctaTextDisabled: { color: '#9CA3AF', fontSize: 15, fontWeight: '600' },

    comingSoonCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: 'rgba(156,163,175,0.06)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(156,163,175,0.18)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    comingSoonTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 4 },
    comingSoonBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
});
