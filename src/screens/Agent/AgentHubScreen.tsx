import { enumDisplayCopy } from '../../i18n/displayCopy';
/**
 * AgentHubScreen - Agents & devices list
 *
 * Displays:
 * - Beneficiary link requests awaiting the human's authorization
 * - Linked agents (beneficiary-linked agents; no relay sessions) with liveness
 * - Registered witness devices
 * - Connect new agent / device entry
 *
 * the wallet no longer governs agents. There is no emergency stop,
 * pending-approval queue, local session list, budget, or policy surface here;
 * the relay's `linked_agents` is the source of truth for what this human owns.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { agentLiveness, lastActivityDisplay, lastActivityTexts, workingLine, type AgentCaptureHealth } from '../../utils/agentLiveness';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    RefreshControl,
    ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import type { AgentHubScreenProps } from '../../navigation/types';
import RelayAPIService, {
    type AgentLinkRequest,
    type LinkedAgent,
    type LinkedAgentIdentity,
    type RegisteredDevice,
} from '../../services/RelayAPIService';
import { deriveAgentStatus, type AgentStatusTone } from '../../core/agents/agentStatus';
import {
    activeDevices,
    deriveAgentHubCounts,
    liveLinkRequests,
    type HubCount,
} from '../../core/agents/agentHubCounts';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import AgentCaptureHealthHint from './AgentCaptureHealthHint';
import RenameAgentSheet from '../../components/RenameAgentSheet';
export default function AgentHubScreen({ navigation }: AgentHubScreenProps) {
    const { t } = useTranslation();
    const [cachedLinkedAgents] = useState(() => RelayAPIService.getCachedLinkedAgents());
    const [cachedLinkedAgentIdentities] = useState(() => RelayAPIService.getCachedLinkedAgentIdentities());
    const initialLinkedAgents = cachedLinkedAgents ?? cachedLinkedAgentIdentities ?? [];
    const [linkedAgentMap, setLinkedAgentMap] = useState<Map<string, LinkedAgent | LinkedAgentIdentity>>(
        () => new Map(initialLinkedAgents.map((agent) => [agent.wallet_id, agent])),
    );
    // Item 3: the last SUCCESSFUL device read (null = never read). A failed read keeps the last
    // value and never becomes "0 devices".
    const [registeredDevicesAll, setRegisteredDevicesAll] = useState<RegisteredDevice[] | null>(null);
    // agents that connected with this human's connection code and are
    // waiting for the human to authorize the link (the accept anchor). null = not read yet.
    const [linkRequestsAll, setLinkRequestsAll] = useState<AgentLinkRequest[] | null>(null);
    // Item 3: counts hold until BOTH the linked-agent read and the device read of this visit settle.
    const [agentsSettled, setAgentsSettled] = useState(false);
    const [devicesSettled, setDevicesSettled] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // False until the first load resolves, so the screen never flashes the "No agents connected"
    // first-time empty state before real data lands (a user who owns active agents saw it flash).
    const [loaded, setLoaded] = useState(
        cachedLinkedAgents !== null || cachedLinkedAgentIdentities !== null,
    );
    // Item 5: the agent the human is renaming (null = sheet closed).
    const [renaming, setRenaming] = useState<{ walletId: string; name: string } | null>(null);
    const loadInFlight = useRef<Promise<void> | null>(null);
    const unreadCount = 0;
    const unreadBySession: Record<string, number> = {};
    const [x402CardDismissed, setX402CardDismissed] = useState(true);

    useEffect(() => {
        AsyncStorage.getItem('agent_hub_x402_card_dismissed').then((val) => {
            setX402CardDismissed(val === 'true');
        });
    }, []);

    const dismissX402Card = useCallback(async () => {
        setX402CardDismissed(true);
        await AsyncStorage.setItem('agent_hub_x402_card_dismissed', 'true');
    }, []);

    // Load data
    const loadData = useCallback((): Promise<void> => {
        if (loadInFlight.current) return loadInFlight.current;
        const run = (async () => {
            // Each read settles on its own: a failure in one never blanks the others, and a
            // failed read keeps the last known value (unknown is never "zero").
            const [agentsResult, devicesResult, linkReqResult] = await Promise.allSettled([
                RelayAPIService.getLinkedAgents({ throwOnError: true }),
                RelayAPIService.getRegisteredDevicesOrThrow(),
                RelayAPIService.getLinkRequests(),
            ]);
            if (agentsResult.status === 'fulfilled') {
                // Build a map of wallet_id → LinkedAgent for quick lookup. Only
                // a successful relay response may replace the confirmed map; a
                // 304/503/network failure is unknown, never "zero agents".
                const walletMap = new Map<string, LinkedAgent | LinkedAgentIdentity>();
                for (const la of agentsResult.value.linked_agents) {
                    walletMap.set(la.wallet_id, la);
                }
                setLinkedAgentMap(walletMap);
                setLoaded(true);
            } else {
                console.error('[AgentHub] Linked-agent read failed:', agentsResult.reason);
            }
            if (devicesResult.status === 'fulfilled') {
                setRegisteredDevicesAll(devicesResult.value);
            } else {
                console.error('[AgentHub] Device read failed:', devicesResult.reason);
            }
            if (linkReqResult.status === 'fulfilled' && linkReqResult.value) {
                setLinkRequestsAll(linkReqResult.value.link_requests ?? []);
            }
            setAgentsSettled(true);
            setDevicesSettled(true);
        })();
        loadInFlight.current = run;
        void run.finally(() => {
            if (loadInFlight.current === run) loadInFlight.current = null;
        });
        return run;
    }, []);

    useFocusEffect(
        useCallback(() => {
            loadData();
            // Capture health does not need a five-second poll. The old interval
            // was shorter than this endpoint's observed 7–23 s response time and
            // stacked overlapping reads until Cloud Run returned 503. Coalescing
            // above is the safety net; 30 s is the humane refresh cadence.
            const interval = setInterval(loadData, 30_000);
            return () => clearInterval(interval);
        }, [loadData])
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    // Handle agent tap
    const handleAgentPress = useCallback(
        (agentId: string) => {
            navigation.navigate('AgentDetail', { agentId });
        },
        [navigation]
    );

    // Handle connect new agent
    //
    // Agents are not "connected" through the app anymore. They register
    // their own wallet via POST /v1/agent/wallet/create from their own
    // environment, then send a beneficiary invite to the human wallet.
    //
    // Human-initiated connect: the phone mints a short-lived connection code
    // that the user hands to any agent or tool using @provian/agent-sdk (or the
    // openclaw skill). The complementary agent-initiated beneficiary invite is
    // surfaced inside ConnectAgentScreen and handled by LinkAccept.
    const handleConnectAgent = useCallback(() => {
        navigation.navigate('ConnectAgent');
    }, [navigation]);

    // Format relative time
    const formatRelativeTime = (timestamp: number | null): string => {
        if (!timestamp) return t('agentHub.never');
        const diff = Date.now() - timestamp;
        if (diff < 60000) return t('agentHub.justNow');
        if (diff < 3600000) return t('agentHub.minAgo', { count: Math.floor(diff / 60000) });
        if (diff < 86400000) return t('agentHub.hoursAgo', { count: Math.floor(diff / 3600000) });
        return t('agentHub.daysAgo', { count: Math.floor(diff / 86400000) });
    };

    // beneficiary-LINKED agents are first-class here, not just enrichment
    // for a session row. A linked agent with no live session (e.g. accepted an
    // invite, never opened a session) was previously invisible — the list only
    // rendered `relaySessions`, so the human saw the empty "connect an agent"
    // state despite owning an active agent. Render those linked agents too.
    const linkedAgents = Array.from(linkedAgentMap.values());
    // relay sessions no longer exist — every beneficiary-linked agent renders
    // from its linked record, with liveness read off its device capture heartbeat.

    // Item 3: ONE derivation for every number on this screen — the header, the count cards, and
    // the lists below all read these same arrays (core/agents/agentHubCounts.ts).
    const nowMs = Date.now();
    const registeredDevices = activeDevices(registeredDevicesAll);
    const linkRequests = liveLinkRequests(linkRequestsAll, nowMs);
    const counts = deriveAgentHubCounts({
        agents: loaded ? linkedAgents : null,
        agentsSettled,
        devices: registeredDevicesAll,
        devicesSettled,
        linkRequests: linkRequestsAll,
        nowMs,
    });
    const hasAnyConnection = linkedAgents.length + registeredDevices.length > 0;

    const countText = (c: HubCount): string => (c.kind === 'count' ? String(c.value) : '—');
    const countParts = counts.ready
        ? [
              { key: 'agents', label: t('agentHub.linkedAgentsTitle'), value: counts.linkedAgents },
              { key: 'devices', label: t('agentHub.yourDevicesTitle'), value: counts.yourDevices },
              ...(counts.pendingLinkRequests !== null
                  ? [{ key: 'requests', label: t('agentHub.linkRequestsTitle'), value: { kind: 'count', value: counts.pendingLinkRequests } as HubCount }]
                  : []),
          ]
        : [];
    // The header says exactly what the cards say: the same labels, the same numbers.
    const subtitleText = counts.ready
        ? countParts.map((p) => t('agentHub.countSummary', { label: p.label, value: countText(p.value) })).join(' · ')
        : t('common.loading');

    const openRename = useCallback((walletId: string | undefined, name: string) => {
        if (walletId) setRenaming({ walletId, name });
    }, []);
    const onRenamed = useCallback((displayName: string) => {
        const walletId = renaming?.walletId;
        if (walletId) {
            // Show the new name at once; the reload below confirms it from the relay.
            setLinkedAgentMap((prev) => {
                const next = new Map(prev);
                const row = next.get(walletId);
                if (row) next.set(walletId, { ...row, display_name: displayName });
                return next;
            });
        }
        setRenaming(null);
        void loadData();
    }, [loadData, renaming]);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
                }
            >
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        {/* Back affordance for when this console is pushed from the
                            Earn tab (it is no longer a tab root itself). */}
                        {navigation.canGoBack() && (
                            <BackButton onPress={() => navigation.goBack()} color={COLORS.textSecondary} style={styles.backButton} />
                        )}
                        <View style={styles.titleRow}>
                            <Text style={styles.title}>{t('agentHub.title')}</Text>
                            {unreadCount > 0 && (
                                <View style={styles.unreadBadge}>
                                    <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
                                </View>
                            )}
                        </View>
                        <Text style={styles.subtitle}>
                            {subtitleText}
                        </Text>
                    </View>
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>

                {/* Item 3: labelled counts — each says what it counts and matches its list below.
                    Held in a neutral loading state until both reads have settled (no 0 flash). */}
                <View style={styles.statsRow}>
                    {!counts.ready ? (
                        <View style={[styles.statCard, styles.statCardLoading]}>
                            <ActivityIndicator color={COLORS.primary} />
                        </View>
                    ) : (
                        countParts.map((p) => (
                            <View key={p.key} style={styles.statCard} accessible accessibilityLabel={`${p.label}: ${p.value.kind === 'count' ? p.value.value : t('agentHub.countUnavailable')}`}>
                                <Ionicons
                                    name={p.key === 'agents' ? 'hardware-chip-outline' : p.key === 'devices' ? 'laptop-outline' : 'link-outline'}
                                    size={20}
                                    color={p.key === 'requests' ? COLORS.warning : COLORS.primary}
                                    style={{ marginBottom: SPACING.xs }}
                                />
                                <Text style={styles.statValue}>{countText(p.value)}</Text>
                                <Text style={styles.statLabel} numberOfLines={2}>{p.label}</Text>
                                {p.value.kind === 'unavailable' && (
                                    <Text style={styles.statUnavailable} numberOfLines={2}>{t('agentHub.countUnavailable')}</Text>
                                )}
                            </View>
                        ))
                    )}
                </View>

                {/* agents awaiting the human's authorization to link (connection-code flow) */}
                {linkRequests.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('agentHub.linkRequestsTitle')}</Text>
                        <Text style={styles.sectionCaption}>{t('agentHub.linkRequestsSubtitle')}</Text>
                        {linkRequests.map((req) => (
                            <TouchableOpacity
                                key={req.request_id}
                                style={styles.pendingCard}
                                onPress={() => navigation.navigate('LinkAccept', {
                                    inviteId: req.invite_id,
                                    agentWalletId: req.agent_wallet_id,
                                })}
                                activeOpacity={0.7}
                            >
                                <View style={styles.pendingIconContainer}>
                                    <Ionicons name="link" size={20} color={COLORS.primary} />
                                </View>
                                <View style={styles.pendingContent}>
                                    <Text style={styles.pendingMerchant}>{req.agent_name}</Text>
                                    <Text style={styles.pendingPurpose}>{t('agentHub.linkRequestAuthorize')}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {/* Connected Agents */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={[styles.sectionTitle, !hasAnyConnection && { textAlign: 'center', flex: 1 }]}>{t('agentHub.linkedAgentsTitle')}</Text>
                        {hasAnyConnection && (
                            <TouchableOpacity style={styles.addButton} onPress={handleConnectAgent}>
                                <View style={styles.addButtonRow}>
                                    <Ionicons name="add" size={16} color={COLORS.primary} />
                                    <Text style={styles.addButtonText}>{t('agentHub.connectBtn')}</Text>
                                </View>
                            </TouchableOpacity>
                        )}
                    </View>

                    {!loaded ? (
                        <View style={styles.emptyState}>
                            <ActivityIndicator color={COLORS.primary} />
                        </View>
                    ) : !hasAnyConnection ? (
                        <View style={styles.emptyState}>
                            <Ionicons name="hardware-chip" size={48} color={COLORS.textMuted} style={{ marginBottom: SPACING.m }} />
                            <Text style={styles.emptyTitle}>{t('agentHub.noAgentsConnected')}</Text>
                            <Text style={styles.emptySubtitle}>
                                {t('agentHub.noAgentsDesc')}
                            </Text>
                            <TouchableOpacity style={styles.connectButton} onPress={handleConnectAgent}>
                                <LinearGradient colors={GRADIENTS.primary} style={styles.connectButtonGradient}>
                                    <Text style={styles.connectButtonText}>{t('agentHub.connectToolOrAgent')}</Text>
                                </LinearGradient>
                            </TouchableOpacity>

                            {!x402CardDismissed && (
                                <View style={styles.x402Card}>
                                    <TouchableOpacity
                                        style={styles.x402Dismiss}
                                        onPress={dismissX402Card}
                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                    >
                                        <Ionicons name="close" size={16} color={COLORS.textMuted} />
                                    </TouchableOpacity>
                                    <View style={styles.x402TitleRow}>
                                        <Ionicons name="swap-horizontal-outline" size={20} color="#6BA3F0" style={{ marginRight: SPACING.s }} />
                                        <Text style={styles.x402Title} numberOfLines={1} adjustsFontSizeToFit>{t('agentHub.agenticEconomy')}</Text>
                                    </View>
                                    <Text style={styles.x402Body}>
                                        {t('agentHub.agenticEconomyDesc')}
                                    </Text>
                                    <TouchableOpacity onPress={() => navigation.navigate('Vision')} activeOpacity={0.7}>
                                        <Text style={styles.x402Link}>{t('agentHub.readFullVision')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    ) : (
                        <>
                            {/* Beneficiary-linked agents (the relay's only record of an agent) */}
                            {linkedAgents.map((la) => {
                                const walletInfo: LinkedAgent | LinkedAgentIdentity | undefined = la;
                                const hasWallet = true;
                                const session = { id: la.wallet_id, agent_id: la.agent_id, agent_name: la.display_name || la.agent_id, agent_wallet_id: la.wallet_id as string | undefined, last_active: la.created_at };
                                // Requirement C: plain-language "is it actually working?" signal
                                // derived only from fields the backend already returns
                                // (pe_count = work produced, last_active = heartbeat). No
                                // invented telemetry; degrade to an honest "nothing yet" state.
                                //
                                // LIVENESS IS RECENCY, NOT A LIFETIME TOTAL.
                                // This used to be `pe_count > 0`, which only ever
                                // grows — so once an agent had produced a single PE
                                // the card read "connected and recording work"
                                // permanently. That is exactly what the hub showed
                                // for the five days Atlas's capture was broken.
                                // Three states, because "never started" and "stopped"
                                // need different sentences.
                                //
                                // the card now reads the EARNING device's
                                // capture-health — the direct "is it receiving NOW"
                                // signal the relay enriches onto each linked agent —
                                // not just the day-granular last_pe_date. This is what
                                // reconciles the Atlas-link identity with the earning
                                // identity: a broken/silent earning device reads stale
                                // even when a PE landed earlier today, and the ms-precise
                                // last capture beats the stale session-connect heartbeat.
                                const capture: AgentCaptureHealth | null =
                                    walletInfo
                                    && 'capture_broken' in walletInfo
                                    && (walletInfo.capture_broken != null || walletInfo.last_capture_at_ms != null)
                                        ? {
                                              broken: walletInfo.capture_broken === true,
                                              lastCaptureAtMs: walletInfo.last_capture_at_ms ?? null,
                                              brokenReason: walletInfo.capture_broken_reason ?? null,
                                          }
                                        : null;
                                const liveness = agentLiveness(walletInfo?.last_pe_date, Date.now(), undefined, capture);
                                const isEarning = liveness.state === 'live';
                                // display a real moment or a bare date — never the end-of-UTC-day
                                // judging value (a new agent read "Last active 6:59:59 PM", in the future).
                                // Only when nothing has been captured does it fall back to the connect time.
                                const lastActivity = lastActivityTexts(
                                    lastActivityDisplay(walletInfo?.last_pe_date, capture, Date.now()),
                                    t,
                                    formatRelativeTime,
                                ) ?? {
                                    absolute: new Date(session.last_active).toLocaleString(),
                                    relative: formatRelativeTime(session.last_active),
                                };
                                const working = workingLine({
                                    liveness,
                                    lastActivityRelative: lastActivity.relative,
                                    brokenSinceMs: walletInfo && 'capture_broken_since_ms' in walletInfo ? walletInfo.capture_broken_since_ms ?? null : null,
                                    relative: formatRelativeTime,
                                    nowMs: Date.now(),
                                });
                                const workingColor = working.tone === 'live' ? COLORS.success : working.tone === 'stale' ? COLORS.error : COLORS.warning;
                                return (
                                <View key={session.id} style={styles.agentCardContainer}>
                                    <TouchableOpacity
                                        style={styles.agentCard}
                                        onPress={() => handleAgentPress(session.agent_id)}
                                    >
                                        <View style={[styles.agentIconContainer, styles.cloudAgentIcon]}>
                                            <Ionicons name="hardware-chip" size={24} color={COLORS.primary} />
                                        </View>
                                        <View style={styles.agentContent}>
                                            <View style={styles.agentNameRow}>
                                                <Text style={styles.agentName}>{session.agent_name}</Text>
                                                <View style={styles.cloudBadge}>
                                                    <Text style={styles.cloudBadgeText}>{hasWallet ? t('agentHub.wallet') : t('agentHub.cloudLabel')}</Text>
                                                </View>
                                                {walletInfo && 'external_address_linked' in walletInfo && walletInfo.external_address_linked && (
                                                    <View style={styles.walletLinkedBadge}>
                                                        <Ionicons name="link" size={10} color={COLORS.success} />
                                                        <Text style={styles.walletLinkedBadgeText}>{t('agentHub.externalWalletBadge')}</Text>
                                                    </View>
                                                )}
                                            </View>
                                            {hasWallet && walletInfo && 'pe_count' in walletInfo ? (
                                                <Text style={[styles.agentStatus, { color: COLORS.success }]}>
                                                    {t('agentHub.peScoreLabel', { peCount: walletInfo.pe_count })}
                                                </Text>
                                            ) : hasWallet ? (
                                                <Text style={[styles.agentStatus, { color: COLORS.success }]}>{t('agentHub.activeWalletLinked')}</Text>
                                            ) : (
                                                <Text style={[styles.agentStatus, { color: COLORS.warning }]}>{t('agentHub.connectedSetupIncomplete')}</Text>
                                            )}
                                            {/*
                                              * the absolute-time line now reflects the
                                              * agent's last REAL activity (ms-precise capture, else
                                              * last PE), not `session.last_active` the connect
                                              * heartbeat that froze at 2026-08-26 while Atlas kept
                                              * earning through 2026-09-13, the exact stale reading
                                              * this ruling reconciles. Only when no work has ever
                                              * been captured (state 'never') does it fall back to
                                              * the connect time, the only fact we have then.
                                              */}
                                            <Text style={styles.agentLastActive}>
                                                {t('agentHub.lastActive', {
                                                    time: lastActivity.absolute,
                                                })}
                                            </Text>

                                            {/* Working signal (plain language) */}
                                            <View style={styles.workingRow}>
                                                <Ionicons
                                                    name={working.tone === 'live' ? 'pulse' : working.tone === 'stale' ? 'alert-circle' : 'ellipse-outline'}
                                                    size={13}
                                                    color={workingColor}
                                                />
                                                <Text style={[styles.workingText, { color: workingColor }]}>
                                                    {t(working.key, working.time === null
                                                        ? { name: session.agent_name }
                                                        : { name: session.agent_name, time: working.time })}
                                                </Text>
                                            </View>
                                            {!isEarning && (
                                                <AgentCaptureHealthHint
                                                    compact
                                                    reason={walletInfo && 'capture_broken_reason' in walletInfo ? walletInfo.capture_broken_reason ?? null : null}
                                                    reported={!!walletInfo && 'capture_reported_at_ms' in walletInfo && walletInfo.capture_reported_at_ms != null}
                                                />
                                            )}
                                        </View>
                                        {hasWallet && (
                                            <View style={styles.agentActions}>
                                                <TouchableOpacity
                                                    style={styles.settingsButton}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('agentName.renameAccessibility', { name: session.agent_name })}
                                                    onPress={() => openRename(session.agent_wallet_id, session.agent_name)}
                                                >
                                                    <Ionicons name="create-outline" size={20} color={COLORS.textSecondary} />
                                                </TouchableOpacity>
                                                <TouchableOpacity
                                                    style={styles.settingsButton}
                                                    accessibilityLabel={t('agentHub.recoverAgentAccessibility')}
                                                    onPress={() => navigation.navigate('RecoverAgent', {
                                                        walletId: session.agent_wallet_id as string,
                                                        agentName: session.agent_name,
                                                    })}
                                                >
                                                    <Ionicons name="key-outline" size={20} color={COLORS.textSecondary} />
                                                </TouchableOpacity>
                                            </View>
                                        )}
                                    </TouchableOpacity>
                                </View>
                                );
                            })}

                        </>
                    )}
                </View>

                {/* Registered Devices */}
                {registeredDevices.length > 0 && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Ionicons name="laptop-outline" size={20} color={COLORS.textSecondary} style={{ marginRight: SPACING.s }} />
                            <Text style={styles.sectionTitle}>{t('agentHub.yourDevicesTitle')}</Text>
                        </View>
                        {registeredDevices.map((device) => (
                            <View key={device.device_id} style={styles.deviceCard}>
                                <View style={styles.deviceIconBg}>
                                    <Ionicons
                                        name={device.platform === 'darwin' || device.platform === 'linux' ? 'laptop-outline' : 'desktop-outline'}
                                        size={24}
                                        color="#E8A838"
                                    />
                                </View>
                                <View style={styles.deviceContent}>
                                    <Text style={styles.deviceName}>{device.device_name}</Text>
                                    <View style={styles.deviceMeta}>
                                        <View style={[styles.statusBadge, device.status === 'active' && styles.statusBadgeActive]}>
                                            <Text style={[styles.statusBadgeText, device.status === 'active' && styles.statusBadgeTextActive]}>
                                                {enumDisplayCopy(device.status)}
                                            </Text>
                                        </View>
                                        <Text style={styles.devicePlatform}>
                                            {device.platform || device.device_type}
                                        </Text>
                                    </View>
                                    <Text style={styles.deviceStats}>
                                        {t('agentHub.totalPEs', { count: device.total_pes })}
                                        {device.last_pe_at ? ` \u00B7 ${t('agentHub.last', { time: formatRelativeTime(device.last_pe_at) })}` : ''}
                                    </Text>
                                    <Text style={styles.deviceRegistered}>
                                        {t('agentHub.registeredDate', { date: new Date(device.created_at).toLocaleDateString() })}
                                    </Text>
                                </View>
                            </View>
                        ))}
                    </View>
                )}

                {loaded && !hasAnyConnection && (
                    <TouchableOpacity
                        style={styles.devicesPrompt}
                        onPress={handleConnectAgent}
                        activeOpacity={0.7}
                    >
                        <Ionicons name="laptop-outline" size={20} color={COLORS.textMuted} style={{ marginRight: SPACING.s }} />
                        <Text style={styles.devicesPromptText}>
                            {t('agentHub.registerDevicePrompt')}
                        </Text>
                        <Ionicons name="chevron-forward" size={16} color={COLORS.textMuted} />
                    </TouchableOpacity>
                )}

                {/* Commons Ecosystem */}
                <TouchableOpacity
                    style={styles.commonsLink}
                    onPress={() => navigation.navigate('CommonsDashboard')}
                    activeOpacity={0.7}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.s }}>
                        <Ionicons name="globe-outline" size={22} color={COLORS.primary} />
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: COLORS.chromeMuted, fontSize: 15, fontWeight: '600' }}>{t('agentHub.commonsTitle')}</Text>
                            <Text style={{ color: '#8B929E', fontSize: 12, marginTop: 2 }}>{t('agentHub.commonsDesc')}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                    </View>
                </TouchableOpacity>
            </ScrollView>
            <RenameAgentSheet
                visible={renaming !== null}
                agentWalletId={renaming?.walletId ?? null}
                currentName={renaming?.name ?? ''}
                onClose={() => setRenaming(null)}
                onSaved={onRenamed}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: 120,
    },

    // Header
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: SPACING.l,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
        marginRight: SPACING.m,
    },
    backButton: {
        marginBottom: SPACING.s,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    title: {
        flexShrink: 1,
        fontSize: 32,
        fontWeight: '700',
        color: COLORS.chromeMuted,
        letterSpacing: 0.5,
    },
    unreadBadge: {
        backgroundColor: '#F2555A',
        borderRadius: BORDER_RADIUS.round,
        minWidth: 22,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        shadowColor: '#F2555A',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 6,
    },
    unreadBadgeText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    agentUnreadDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: '#F2555A',
        marginLeft: SPACING.s,
        shadowColor: '#F2555A',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 4,
    },
    subtitle: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: SPACING.xs,
    },

    // Stats Row
    // Up to three labelled count cards; they wrap to a second row at 320pt rather than crushing
    // their labels.
    statsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        rowGap: SPACING.s,
        marginBottom: SPACING.l,
    },
    statCard: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 88,
        minWidth: 0,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginHorizontal: SPACING.xs,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
    },
    statValue: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.chromeMuted,
    },
    statLabel: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: SPACING.xs,
        textAlign: 'center',
    },
    statUnavailable: {
        fontSize: 11,
        color: COLORS.warning,
        marginTop: 2,
        textAlign: 'center',
    },
    statCardLoading: {
        minHeight: 88,
        justifyContent: 'center',
    },

    // Section
    section: {
        marginBottom: SPACING.l,
    },
    // Wraps: at the smallest phone width (or a long translation) the
    // "+ Connect another agent" button drops below the heading instead of
    // running off the right edge.
    sectionHeader: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        columnGap: SPACING.s,
        rowGap: SPACING.s,
        marginBottom: SPACING.m,
    },
    sectionTitle: {
        flexShrink: 1,
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        letterSpacing: 0.3,
    },
    addButton: {
        flexShrink: 1,
        maxWidth: '100%',
        backgroundColor: 'rgba(74,142,232,0.12)',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: 28,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(74,142,232,0.4)',
    },
    addButtonRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    addButtonText: {
        flexShrink: 1,
        color: '#4A8EE8',
        fontWeight: '600',
        fontSize: 14,
    },

    // Pending Card. The cards here have translucent backgrounds, so they carry the
    // iOS shadow only: Android paints an elevation shadow through a translucent
    // card as a dark inner box.
    pendingCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,179,0,0.10)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.25)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
    },
    pendingIconContainer: {
        width: 44,
        height: 44,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(255,179,0,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    pendingContent: {
        flex: 1,
        minWidth: 0,
    },
    pendingMerchant: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    pendingPurpose: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: SPACING.xs,
    },
    sectionCaption: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: SPACING.xs,
        marginBottom: SPACING.m,
    },

    // Agent Card
    agentCardContainer: {
        marginBottom: SPACING.s,
    },
    agentCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderLeftWidth: 3,
        borderLeftColor: '#6BA3F0',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
    },
    agentActions: {
        marginLeft: SPACING.xs,
        alignItems: 'center',
    },
    settingsButton: {
        padding: SPACING.s,
    },
    agentIconContainer: {
        width: 48,
        height: 48,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(155,109,255,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    cloudAgentIcon: {
        backgroundColor: 'rgba(74,142,232,0.14)',
    },
    agentContent: {
        flex: 1,
        minWidth: 0,
    },
    // Name + badges wrap to a second line instead of pushing a badge off the card.
    agentNameRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: SPACING.s,
        rowGap: 4,
    },
    agentName: {
        flexShrink: 1,
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    cloudBadge: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.25)',
    },
    cloudBadgeText: {
        fontSize: 10,
        fontWeight: '600',
        color: '#4A8EE8',
    },
    walletLinkedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        backgroundColor: 'rgba(76,195,138,0.14)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        borderWidth: 1,
        borderColor: 'rgba(76,195,138,0.30)',
    },
    walletLinkedBadgeText: {
        fontSize: 10,
        fontWeight: '600',
        color: COLORS.success,
    },
    agentStatus: {
        fontSize: 12,
        color: '#4CC38A',
        marginTop: 2,
    },
    agentLastActive: {
        fontSize: 11,
        color: '#9CA3AF',
        marginTop: SPACING.xs,
    },
    workingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: SPACING.xs,
    },
    workingText: {
        flex: 1,
        fontSize: 12,
        fontWeight: '600',
    },

    // Empty State
    emptyState: {
        alignItems: 'center',
        padding: SPACING.xl,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.4,
        shadowRadius: 16,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        marginBottom: SPACING.s,
    },
    emptySubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    connectButton: {
        maxWidth: '100%',
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(74,142,232,0.4)',
    },
    connectButtonGradient: {
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
    },
    connectButtonText: {
        textAlign: 'center',
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 16,
    },
    x402Card: {
        marginTop: SPACING.l,
        backgroundColor: 'rgba(107, 163, 240, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(107, 163, 240, 0.20)',
        borderRadius: 16,
        padding: SPACING.l,
        width: '100%',
    },
    x402Dismiss: {
        position: 'absolute',
        top: SPACING.s,
        right: SPACING.s,
        padding: 4,
        zIndex: 1,
    },
    // Right padding keeps the title clear of the absolutely-positioned dismiss button.
    x402TitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.s,
        paddingRight: SPACING.l,
    },
    x402Title: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
        flex: 1,
    },
    x402Body: {
        fontSize: 13,
        color: '#8B929E',
        lineHeight: 20,
        marginBottom: SPACING.s,
    },
    x402Link: {
        fontSize: 13,
        color: '#6BA3F0',
        fontWeight: '600',
    },
    commonsLink: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        marginTop: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        ...SHADOWS.card,
        elevation: 0, // translucent card: iOS shadow only (see pendingCard)
    },
    deviceCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderLeftWidth: 3,
        borderLeftColor: '#E8A838',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 10,
    },
    deviceIconBg: {
        width: 48,
        height: 48,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: 'rgba(232,168,56,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    deviceContent: {
        flex: 1,
        minWidth: 0,
    },
    deviceName: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: 4,
    },
    deviceMeta: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginBottom: 4,
        gap: SPACING.s,
    },
    devicePlatform: {
        flexShrink: 1,
        fontSize: 13,
        color: '#8B929E',
    },
    statusBadge: {
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        backgroundColor: 'rgba(139,146,158,0.15)',
        borderWidth: 1,
        borderColor: 'rgba(139,146,158,0.25)',
    },
    statusBadgeActive: {
        backgroundColor: 'rgba(76,195,138,0.15)',
        borderColor: 'rgba(76,195,138,0.25)',
    },
    statusBadgeText: {
        fontSize: 10,
        fontWeight: '600',
        color: '#8B929E',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    statusBadgeTextActive: {
        color: '#4CC38A',
    },
    deviceStats: {
        fontSize: 13,
        color: '#8B929E',
        marginBottom: 2,
    },
    deviceRegistered: {
        fontSize: 12,
        color: '#9CA3AF',
    },
    devicesPrompt: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 16,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(200,205,214,0.15)',
    },
    devicesPromptText: {
        fontSize: 13,
        color: '#8B929E',
        flex: 1,
        flexWrap: 'wrap',
    },
});
