import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
/**
 * ActivityLogScreen - Unified Activity Hub
 *
 * Displays a filtered view of all user activity:
 * - All: Complete PE audit trail (default)
 * - Transactions: Send/receive/swap/stake PEs
 * - Agent Activity: Agent-related PEs
 * - Promises: Promise records from PromiseService
 * - Chat: Placeholder (chatStore only tracks unread counts, no conversation list)
 *
 * Uses tiered PE storage:
 * - Hot tier (last 7 days) loads instantly
 * - Warm tier (cloud) loaded on demand via "Load older activity"
 */

import React, { useCallback, useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    TouchableOpacity,
    RefreshControl,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import type { ActivityLogScreenProps } from '../../navigation/types';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import { PELifecycleManager } from '../../core/provenance';
import type { ProvenanceEnvelope, ActionType } from '../../core/provenance/types';
import type { MonthlyArchiveEntry } from '../../core/provenance/lifecycleTypes';
import PromiseService from '../../core/promises/PromiseService';
import type { PromiseRecord } from '../../core/promises/PromiseService';
import RelayAPIService from '../../services/RelayAPIService';
import type { PVTHistoryEntry } from '../../services/RelayAPIService';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import { agentNameForRecord, loadAgentNameMaps, type AgentNameMaps } from '../../core/agents/agentNames';
import BackButton from '../../components/BackButton';

// ─── Action type icons and labels ────────────────────────────────────────────

// the private ACTION_CONFIG map was deleted. This screen now renders every
// PE through the ONE canonical map (utils/actionTypeDisplay.ts) \u2014 see
// getActionConfig below \u2014 so a commit / conversation / work-product PE gets a real
// icon + human label instead of the generic fallback, and there is a single
// action-type map for the whole app.

// ─── Filter types ────────────────────────────────────────────────────────────

type FilterType = 'all' | 'transactions' | 'agents' | 'promises';

const ACTIVITY_FILTERS: { key: FilterType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'all', label: 'ui.activityLog.filterAll', icon: 'list-outline' },
    { key: 'transactions', label: 'ui.activityLog.filterTransactions', icon: 'swap-horizontal-outline' },
    { key: 'agents', label: 'ui.activityLog.filterWork', icon: 'code-slash-outline' },
    { key: 'promises', label: 'ui.activityLog.filterPromises', icon: 'heart-outline' },
];

const TX_ACTION_TYPES: ActionType[] = ['send', 'receive', 'swap'];

const AGENT_ACTION_TYPES: ActionType[] = [
    'agent_authorization', 'agent_action',
    'agent_communicate', 'agent_commit', 'agent_share_data',
    'agent_session_started', 'agent_session_suspended', 'agent_session_revoked',
    'request_expired', 'request_auto_approved',
    'agent_transaction_reported', 'agent_transaction_synced',
    'coding_session', 'refactor', 'test_run', 'deployment', 'research', 'document',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return i18next.t('provenanceDashboard.justNow');
    if (diffMins < 60) return i18next.t('provenanceDashboard.minutesAgo', { count: diffMins });
    if (diffHours < 24) return i18next.t('provenanceDashboard.hoursAgo', { count: diffHours });
    if (diffDays < 7) return i18next.t('provenanceDashboard.daysAgo', { count: diffDays });

    return date.toLocaleDateString(i18next.resolvedLanguage, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

function formatMonthKey(monthKey: string): string {
    const [year, month] = monthKey.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function getActionConfig(actionType: ActionType) {
    // derived from the ONE canonical map. `icon` here is the EMOJI (the row
    // renders it as text); `.label`/`.color` come straight from the map, and an
    // unknown type gets a clean formatted label, never a raw underscored string.
    const display = getActionTypeDisplay(actionType);
    return { icon: display.emoji, label: display.label, color: display.color };
}

const PROMISE_STATUS_LABELS: Record<string, string> = {
    pending: 'pe.disposition.pending',
    accepted: 'promise.active',
    fulfilled: 'ui.activityLog.fulfilled',
    broken: 'ui.activityLog.broken',
    disputed: 'promise.disputed',
    expired: 'trustLayer.approvalInbox.expired',
    offered: 'ui.activityLog.offered',
    countered: 'promise.counterTitle',
    rejected: 'ui.activityLog.rejected',
};

const PROMISE_STATUS_COLORS: Record<string, string> = {
    pending: '#E8A838',
    accepted: COLORS.success,
    fulfilled: COLORS.success,
    broken: COLORS.error,
    disputed: COLORS.warning,
    expired: COLORS.textSecondary,
    offered: '#6BA3F0',
    countered: '#E8A838',
    rejected: COLORS.error,
};

// ─── PE Item Component ───────────────────────────────────────────────────────

interface EnvelopeItemProps {
    envelope: ProvenanceEnvelope;
    onPress: (envelope: ProvenanceEnvelope) => void;
    /** item 10: the human's name for the agent this PE names, when it is one of theirs. */
    agentName?: string | null;
}

function EnvelopeItem({ envelope, onPress, agentName }: EnvelopeItemProps) {
    useTranslation();
    const config = getActionConfig(envelope.action_type);
    const isEmergency = envelope.action_type === 'emergency_stop';
    const isHidden = envelope.hidden === true;

    return (
        <TouchableOpacity
            style={[
                styles.envelopeItem,
                isEmergency && styles.emergencyItem,
                isHidden && styles.hiddenItem,
            ]}
            onPress={() => onPress(envelope)}
            activeOpacity={0.7}
        >
            <View style={[styles.iconContainer, { backgroundColor: `${config.color}20` }]}>
                <Text style={styles.icon}>{config.icon}</Text>
            </View>
            <View style={styles.envelopeContent}>
                <View style={styles.envelopeHeader}>
                    <Text style={[styles.actionLabel, isEmergency && styles.emergencyLabel]}>
                        {config.label}
                    </Text>
                    <Text style={styles.timestamp}>{formatTimestamp(envelope.timestamp)}</Text>
                </View>
                <Text style={styles.intentText} numberOfLines={2}>
                    {envelope.intent_text || i18next.t('envelope.noDescription')}
                </Text>
                {envelope.action_type === 'x402_payment' && envelope.envelope_id && (
                    <Text style={styles.peIdLine}>
                        PE #{envelope.envelope_id.slice(0, 8)}
                    </Text>
                )}
                {isHidden && (
                    <View style={styles.hiddenBadge}>
                        <Text style={styles.hiddenBadgeText}>{i18next.t('ui.activityLog.hidden')}</Text>
                    </View>
                )}
                {envelope.agent_id && (
                    <View style={styles.agentBadge}>
                        <Text style={styles.agentBadgeText}>
                            {i18next.t('ui.activityLog.agent', { name: agentName ?? `${envelope.agent_id.slice(0, 8)}...` })}
                        </Text>
                    </View>
                )}
                {envelope.authorization_decision && (
                    <View style={[
                        styles.decisionBadge,
                        envelope.authorization_decision === 'allow' && styles.decisionAllow,
                        envelope.authorization_decision === 'deny' && styles.decisionDeny,
                        envelope.authorization_decision === 'require_human' && styles.decisionHuman,
                    ]}>
                        <Text style={styles.decisionText}>
                            {envelope.authorization_decision === 'allow' && '\u2705 ' + i18next.t('ui.activityLog.allowed')}
                            {envelope.authorization_decision === 'deny' && '\u274C ' + i18next.t('commons.consent.deniedTitle')}
                            {envelope.authorization_decision === 'require_human' && '\uD83D\uDC64 ' + i18next.t('ui.activityLog.humanRequired')}
                        </Text>
                    </View>
                )}
            </View>
            <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
    );
}

// ─── Promise Item Component ──────────────────────────────────────────────────

interface PromiseItemProps {
    promise: PromiseRecord;
    onPress: (promise: PromiseRecord) => void;
}

function PromiseItem({ promise, onPress }: PromiseItemProps) {
    useTranslation();
    const statusColor = PROMISE_STATUS_COLORS[promise.status] || COLORS.textSecondary;
    const statusLabel = i18next.t(PROMISE_STATUS_LABELS[promise.status] || 'common.unknown');

    return (
        <TouchableOpacity
            style={styles.envelopeItem}
            onPress={() => onPress(promise)}
            activeOpacity={0.7}
        >
            <View style={[styles.iconContainer, { backgroundColor: 'rgba(255, 140, 0, 0.15)' }]}>
                <Ionicons name="heart" size={20} color="#E8A838" />
            </View>
            <View style={styles.envelopeContent}>
                <View style={styles.envelopeHeader}>
                    <Text style={styles.actionLabel}>
                        {promise.direction === 'i_owe' ? i18next.t('promise.typeIOwe') : i18next.t('ui.activityLog.owedToMe')}
                    </Text>
                    <Text style={styles.timestamp}>{formatTimestamp(promise.updatedAt)}</Text>
                </View>
                <Text style={styles.intentText} numberOfLines={1}>
                    {promise.theyGave} → {promise.theyOwe}
                </Text>
                <View style={styles.envelopeHeader}>
                    <Text style={[styles.agentBadgeText, { color: '#8B929E' }]}>{promise.who}</Text>
                    <View style={[styles.decisionBadge, { backgroundColor: `${statusColor}20` }]}>
                        <Text style={[styles.decisionText, { color: statusColor }]}>{statusLabel}</Text>
                    </View>
                </View>
            </View>
            <Text style={styles.arrow}>›</Text>
        </TouchableOpacity>
    );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function ActivityLogScreen({ navigation }: ActivityLogScreenProps) {
    useTranslation();
    // PE state - this screen is now PE-only. Crypto transactions are shown
    // in the Wallet tab (DashboardScreen → TransactionHistoryScreen).
    const [envelopes, setEnvelopes] = useState<ProvenanceEnvelope[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [filter, setFilter] = useState<FilterType>('all');
    const [availableArchives, setAvailableArchives] = useState<MonthlyArchiveEntry[]>([]);
    const [loadingArchive, setLoadingArchive] = useState(false);
    const [loadedMonths, setLoadedMonths] = useState<Set<string>>(new Set());
    const [storageSummary, setStorageSummary] = useState<{
        hotCount: number;
        warmCount: number;
    } | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    // item 10: the human's names for their agents, so a PE row names the agent, not its id.
    const [agentNames, setAgentNames] = useState<AgentNameMaps | null>(null);
    useEffect(() => {
        let live = true;
        void loadAgentNameMaps().then((maps) => { if (live) setAgentNames(maps); });
        return () => { live = false; };
    }, []);

    // First PE banner
    const [firstPEBannerDismissed, setFirstPEBannerDismissed] = useState(true);

    useEffect(() => {
        AsyncStorage.getItem('pe_first_banner_dismissed').then((val) => {
            setFirstPEBannerDismissed(val === 'true');
        });
    }, []);

    const dismissFirstPEBanner = useCallback(async () => {
        setFirstPEBannerDismissed(true);
        await AsyncStorage.setItem('pe_first_banner_dismissed', 'true');
    }, []);

    // Non-PE data sources
    const [promises, setPromises] = useState<PromiseRecord[]>([]);

    // Convert a relay PVTHistoryEntry to a minimal ProvenanceEnvelope for unified display.
    // Fields not present in PVTHistoryEntry are set to safe defaults - these entries are
    // display-only and never written back to the hash chain.
    function relayEntryToEnvelope(entry: PVTHistoryEntry): ProvenanceEnvelope {
        return {
            envelope_id: entry.peId,
            prev_envelope_hash: '',
            timestamp: entry.timestamp,
            actor_address: '',
            chain_id: '',
            action_type: entry.actionType as ActionType,
            intent_text: entry.description ?? '',
            asset_symbol: '',
            amount: '',
            risk_score: 0,
            risk_category: 'low',
            policy_decision: 'allow',
            device_attestation_id: '',
            subscription_state_snapshot: 'active',
            null_state_flags: [],
            hidden: entry.hidden,
        };
    }


    // Load PE data sources for the Activity screen.
    //
    // ActivityLog is now PE-ONLY. On-chain crypto transactions are shown
    // separately in the Wallet tab (DashboardScreen Recent Activity →
    // TransactionHistoryScreen). The Wallet/Abundance split is the
    // architectural rule:
    //
    //   Wallet tab    → on-chain crypto txns (TransactionHistoryService)
    //                   tap → TransactionDetail
    //   Abundance tab → PE history + PVT accrual (the PEs this phone keeps)
    //                   tap → EnvelopeDetail / PVTDetail
    //   ActivityLog   → PE audit trail across all PE types (this screen)
    //                   tap → EnvelopeDetail
    //
    // The Transactions filter tab in this screen still exists but now
    // filters PEs by crypto-related action_types (send/receive/swap/etc.)
    // - it shows the PROVENANCE side of crypto activity, not the
    // on-chain side. Users who want raw tx info (hash, gas, explorer)
    // open the Wallet tab; users who want to see what their wallet
    // PE chain looks like for crypto actions stay here.
    const loadRecentEnvelopes = useCallback(async () => {
        try {
            const [recentEnvelopes, relayHistory, archives, summary] = await Promise.all([
                ProvenanceEnvelopeManager.getRecentPEs(),
                RelayAPIService.getPVTHistory(50, 0, showHidden).catch(() => null),
                PELifecycleManager.getAvailableArchives(),
                ProvenanceEnvelopeManager.getStorageSummary(),
            ]);

            // Merge relay PEs with local PEs (dedupe by envelope_id, prefer local)
            const localIds = new Set(recentEnvelopes.map(pe => pe.envelope_id));
            const relayPEs: ProvenanceEnvelope[] = (relayHistory?.entries ?? [])
                .filter(entry => !localIds.has(entry.peId))
                .map(relayEntryToEnvelope);

            const mergedPEs = [...recentEnvelopes, ...relayPEs];
            mergedPEs.sort((a, b) => b.timestamp - a.timestamp);
            setEnvelopes(mergedPEs);

            setAvailableArchives(archives);
            setStorageSummary({ hotCount: summary.hotCount, warmCount: summary.warmCount });
        } catch (error) {
            console.error('[ActivityLog] Load error:', error);
            try {
                const allEnvelopes = await ProvenanceEnvelopeManager.getHistory();
                const sorted = allEnvelopes.sort((a, b) => b.timestamp - a.timestamp);
                setEnvelopes(sorted);
            } catch (fallbackError) {
                console.error('[ActivityLog] Fallback load error:', fallbackError);
            }
        } finally {
            setLoading(false);
        }
    }, [showHidden]);

    // Load non-PE data sources (for "All" merged view and individual filters)
    const loadAllExtraSources = useCallback(async () => {
        try {
            const allPromises = await PromiseService.getAllPromises().catch(() => [] as PromiseRecord[]);
            setPromises(allPromises);
        } catch (e) {
            console.warn('[ActivityLog] Extra sources load error:', e);
        }
    }, []);

    // Initial load: PEs first (fast), then extra sources in background
    useEffect(() => {
        loadRecentEnvelopes().then(() => loadAllExtraSources());
    }, [loadRecentEnvelopes, loadAllExtraSources]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        setPromises([]);
        await loadRecentEnvelopes();
        await loadAllExtraSources();
        setRefreshing(false);
    }, [loadRecentEnvelopes, loadAllExtraSources]);

    // Load archived PEs for a specific month
    const loadMonthArchive = useCallback(async (monthKey: string) => {
        if (loadedMonths.has(monthKey)) return;
        setLoadingArchive(true);
        try {
            const archivePEs = await ProvenanceEnvelopeManager.loadMonthArchive(monthKey);
            setEnvelopes(prev => {
                const existingIds = new Set(prev.map(pe => pe.envelope_id));
                const newPEs = archivePEs.filter(pe => !existingIds.has(pe.envelope_id));
                const merged = [...prev, ...newPEs];
                return merged.sort((a, b) => b.timestamp - a.timestamp);
            });
            setLoadedMonths(prev => new Set([...prev, monthKey]));
        } catch (error) {
            console.error('[ActivityLog] Archive load error:', error);
        } finally {
            setLoadingArchive(false);
        }
    }, [loadedMonths]);

    const handleEnvelopePress = useCallback((envelope: ProvenanceEnvelope) => {
        navigation.navigate('EnvelopeDetail', { envelopeId: envelope.envelope_id });
    }, [navigation]);

    const handlePromisePress = useCallback((promise: PromiseRecord) => {
        navigation.navigate('PromiseDetail', { promiseId: promise.id });
    }, [navigation]);


    // ─── Filtered PE lists ───────────────────────────────────────────────────

    const visibleEnvelopes = showHidden
        ? envelopes
        : envelopes.filter((e) => !e.hidden);

    const getFilteredPEs = (): ProvenanceEnvelope[] => {
        switch (filter) {
            case 'transactions':
                // Show PEs whose action_type represents a crypto movement.
                // This is the PROVENANCE side of crypto activity - for the
                // on-chain side (hash, gas, block, explorer), users tap into
                // the Wallet tab → TransactionHistory.
                return visibleEnvelopes.filter(e => TX_ACTION_TYPES.includes(e.action_type));
            case 'agents':
                return visibleEnvelopes.filter(e =>
                    AGENT_ACTION_TYPES.includes(e.action_type) || e.agent_id
                );
            default:
                return visibleEnvelopes;
        }
    };

    // ─── Unified "All" feed ─────────────────────────────────────────────────

    interface UnifiedActivityItem {
        id: string;
        type: 'pe' | 'promise';
        title: string;
        subtitle: string;
        timestamp: number;
        icon: keyof typeof Ionicons.glyphMap;
        iconColor: string;
        iconBg: string;
        onPress: () => void;
    }

    const buildUnifiedFeed = (): UnifiedActivityItem[] => {
        const items: UnifiedActivityItem[] = [];

        // PEs
        for (const pe of visibleEnvelopes) {
            const config = getActionConfig(pe.action_type);
            items.push({
                id: `pe-${pe.envelope_id}`,
                type: 'pe',
                title: config.label,
                subtitle: pe.intent_text || pe.envelope_id.slice(0, 12) + '...',
                timestamp: pe.timestamp,
                // the real canonical Ionicon for this type (was a 3-way ternary).
                icon: getActionTypeDisplay(pe.action_type).icon as keyof typeof Ionicons.glyphMap,
                iconColor: config.color,
                iconBg: `${config.color}20`,
                onPress: () => handleEnvelopePress(pe),
            });
        }

        // Promises
        for (const p of promises) {
            const statusLabel = i18next.t(PROMISE_STATUS_LABELS[p.status] || 'common.unknown');
            items.push({
                id: `promise-${p.id}`,
                type: 'promise',
                title: i18next.t('ui.activityLog.promise', { description: (p.theyGave + ' → ' + p.theyOwe).slice(0, 30) }),
                subtitle: `${p.who} · ${statusLabel}`,
                timestamp: p.updatedAt,
                icon: 'heart-outline',
                iconColor: '#E8A838',
                iconBg: 'rgba(255, 140, 0, 0.15)',
                onPress: () => handlePromisePress(p),
            });
        }

        // Sort by timestamp descending, cap at 50
        items.sort((a, b) => b.timestamp - a.timestamp);
        return items.slice(0, 50);
    };

    const unifiedFeed = filter === 'all' ? buildUnifiedFeed() : [];

    // ─── Is this a PE-only filter? ──────────────────────────────────────────

    const isPEFilter = filter === 'transactions' || filter === 'agents';

    // ─── Group PEs by date (for PE-only filters) ────────────────────────────

    const filteredPEs = isPEFilter ? getFilteredPEs() : [];
    const groupedByDate = filteredPEs.reduce<Record<string, ProvenanceEnvelope[]>>((acc, envelope) => {
        const dateKey = new Date(envelope.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
        });
        if (!acc[dateKey]) acc[dateKey] = [];
        acc[dateKey].push(envelope);
        return acc;
    }, {});

    const sections = Object.entries(groupedByDate);

    // ─── Empty state messages ────────────────────────────────────────────────

    const getEmptyState = (): { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string } => {
        switch (filter) {
            case 'all':
                return { icon: 'list-outline', title: i18next.t('ui.activityLog.emptyAllTitle'), subtitle: i18next.t('ui.activityLog.emptyAllBody') };
            case 'transactions':
                return { icon: 'swap-horizontal-outline', title: i18next.t('ui.activityLog.emptyTransactionsTitle'), subtitle: i18next.t('ui.activityLog.emptyTransactionsBody') };
            case 'agents':
                return { icon: 'code-slash-outline', title: i18next.t('ui.activityLog.emptyWorkTitle'), subtitle: i18next.t('ui.activityLog.emptyWorkBody') };
            case 'promises':
                return { icon: 'heart-outline', title: i18next.t('ui.activityLog.emptyPromisesTitle'), subtitle: i18next.t('ui.activityLog.emptyPromisesBody') };
        }
    };

    // ─── Render ──────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                </View>
            </SafeAreaView>
        );
    }

    // Show first PE banner?
    const showFirstPEBanner =
        !firstPEBannerDismissed &&
        envelopes.length === 1 &&
        envelopes[0].action_type === 'wallet_created';

    const renderFirstPEBanner = () => {
        if (!showFirstPEBanner) return null;
        return (
            <View style={styles.firstPEBanner}>
                <TouchableOpacity
                    style={styles.firstPEDismiss}
                    onPress={dismissFirstPEBanner}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                    <Ionicons name="close" size={16} color={COLORS.textMuted} />
                </TouchableOpacity>
                <Text style={styles.firstPEBannerText}>
                    {i18next.t('ui.activityLog.firstProof')}</Text>
                <TouchableOpacity onPress={() => navigation.navigate('Vision')} activeOpacity={0.7}>
                    <Text style={styles.firstPEBannerLink}>{i18next.t('ui.activityLog.learnMore')}</Text>
                </TouchableOpacity>
            </View>
        );
    };

    // Render unified "All" feed
    const renderUnifiedList = () => (
        <FlatList
            data={unifiedFeed}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
                <TouchableOpacity
                    style={styles.envelopeItem}
                    onPress={item.onPress}
                    activeOpacity={0.7}
                >
                    <View style={[styles.iconContainer, { backgroundColor: item.iconBg }]}>
                        <Ionicons name={item.icon} size={20} color={item.iconColor} />
                    </View>
                    <View style={styles.envelopeContent}>
                        <View style={styles.envelopeHeader}>
                            <Text style={styles.actionLabel} numberOfLines={1}>{item.title}</Text>
                            <Text style={styles.timestamp}>{formatTimestamp(item.timestamp)}</Text>
                        </View>
                        <Text style={styles.intentText} numberOfLines={1}>{item.subtitle}</Text>
                    </View>
                    <Text style={styles.arrow}>›</Text>
                </TouchableOpacity>
            )}
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
            }
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={renderFirstPEBanner()}
            ListEmptyComponent={renderEmpty()}
        />
    );

    // Render the PE-based list (Transactions filter, Work filter)
    const renderPEList = () => (
        <FlatList
            data={sections}
            keyExtractor={([date]) => date}
            renderItem={({ item: [date, items] }) => (
                <View style={styles.dateSection}>
                    <Text style={styles.dateHeader}>{date}</Text>
                    {items.map((envelope) => (
                        <EnvelopeItem
                            key={envelope.envelope_id}
                            envelope={envelope}
                            onPress={handleEnvelopePress}
                            agentName={envelope.agent_id && agentNames ? agentNameForRecord({ agentId: envelope.agent_id }, agentNames) : null}
                        />
                    ))}
                </View>
            )}
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
            }
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={renderEmpty()}
            ListFooterComponent={renderArchiveFooter()}
        />
    );

    // Render promise list
    const renderPromiseList = () => (
        <FlatList
            data={promises}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
                <PromiseItem promise={item} onPress={handlePromisePress} />
            )}
            refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
            }
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={renderEmpty()}
        />
    );


    const renderEmpty = () => {
        const empty = getEmptyState();
        return (
            <View style={styles.emptyState}>
                <Ionicons name={empty.icon} size={48} color={COLORS.textMuted} />
                <Text style={styles.emptyTitle}>{empty.title}</Text>
                <Text style={styles.emptySubtitle}>{empty.subtitle}</Text>
            </View>
        );
    };

    const renderArchiveFooter = () => {
        if (availableArchives.length === 0) return null;
        return (
            <View style={styles.archiveSection}>
                {loadingArchive ? (
                    <View style={styles.archiveLoading}>
                        <ActivityIndicator size="small" color={COLORS.primary} />
                        <Text style={styles.archiveLoadingText}>{i18next.t('ui.activityLog.loadingArchive')}</Text>
                    </View>
                ) : (
                    <>
                        <Text style={styles.archiveHeader}>{i18next.t('ui.activityLog.archiveTitle')}</Text>
                        <Text style={styles.archiveSubtext}>
                            {i18next.t('ui.activityLog.cloudActions', { count: storageSummary?.warmCount || 0 })}
                        </Text>
                        {availableArchives
                            .filter(a => !loadedMonths.has(a.monthKey))
                            .slice(0, 6)
                            .map((archive) => (
                                <TouchableOpacity
                                    key={archive.monthKey}
                                    style={styles.archiveItem}
                                    onPress={() => loadMonthArchive(archive.monthKey)}
                                >
                                    <Text style={styles.archiveMonth}>
                                        {formatMonthKey(archive.monthKey)}
                                    </Text>
                                    <Text style={styles.archiveCount}>
                                        {i18next.t('ui.activityLog.actions', { count: archive.peCount })}
                                    </Text>
                                    <Text style={styles.archiveArrow}>{'>'}</Text>
                                </TouchableOpacity>
                            ))}
                        {availableArchives.filter(a => !loadedMonths.has(a.monthKey)).length > 6 && (
                            <Text style={styles.archiveMore}>
                                {i18next.t('ui.activityLog.moreMonths', { count: availableArchives.filter(a => !loadedMonths.has(a.monthKey)).length - 6 })}
                            </Text>
                        )}
                    </>
                )}
            </View>
        );
    };

    const renderActiveList = () => {
        switch (filter) {
            case 'all':
                return renderUnifiedList();
            case 'transactions':
            case 'agents':
                // Both filters render through the PE list - the difference
                // is just which subset of PEs `getFilteredPEs()` returns.
                // 'transactions' = crypto-action PEs, 'agents' = agent/work
                // PEs. The on-chain crypto tx side lives in the Wallet tab.
                return renderPEList();
            case 'promises':
                return renderPromiseList();
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{i18next.t('ui.activityLog.title')}</Text>
                <TouchableOpacity
                    style={[styles.hiddenToggle, showHidden && styles.hiddenToggleActive]}
                    onPress={() => setShowHidden(!showHidden)}
                >
                    <Ionicons
                        name={showHidden ? 'eye' : 'eye-off-outline'}
                        size={18}
                        color={showHidden ? COLORS.primary : COLORS.textSecondary}
                    />
                </TouchableOpacity>
            </View>

            {/* Filter Pills */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.filterScrollView}
                contentContainerStyle={styles.filterContainer}
            >
                {ACTIVITY_FILTERS.map((f) => (
                    <TouchableOpacity
                        key={f.key}
                        style={[styles.filterTab, filter === f.key && styles.filterTabActive]}
                        onPress={() => setFilter(f.key)}
                    >
                        <Ionicons
                            name={f.icon}
                            size={14}
                            color={filter === f.key ? '#4A8EE8' : '#8B929E'}
                            style={{ marginRight: 4 }}
                        />
                        <Text
                            style={[
                                styles.filterText,
                                filter === f.key && styles.filterTextActive,
                            ]}
                        >
                            {i18next.t(f.label)}
                        </Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>

            {/* Active List - wrapped in flex:1 so the FlatList inside takes
                the remaining vertical space below the (now non-shrinkable)
                filter pill row, instead of fighting it for layout space. */}
            <View style={{ flex: 1 }}>
                {renderActiveList()}
            </View>
        </SafeAreaView>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    // First PE banner
    firstPEBanner: {
        backgroundColor: 'rgba(232, 168, 56, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(232, 168, 56, 0.25)',
        borderRadius: 16,
        padding: SPACING.l,
        marginBottom: SPACING.m,
    },
    firstPEDismiss: {
        position: 'absolute',
        top: SPACING.s,
        right: SPACING.s,
        padding: 4,
    },
    firstPEBannerText: {
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 21,
        marginBottom: SPACING.s,
        paddingRight: SPACING.l,
    },
    firstPEBannerLink: {
        fontSize: 13,
        color: '#E8A838',
        fontWeight: '600',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    hiddenToggle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    hiddenToggleActive: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        borderColor: '#4A8EE8',
    },

    // Filter Pills
    filterScrollView: {
        flexGrow: 0,
        // [Layout fix] Without flexShrink:0 the FlatList below can compress
        // this horizontal ScrollView, squishing the right-side pills against
        // the screen edge whenever the active list has content. Locking
        // shrink at 0 keeps the row at its natural height regardless.
        flexShrink: 0,
    },
    filterContainer: {
        flexDirection: 'row',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
        gap: SPACING.s,
    },
    filterTab: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: 18,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        // [Layout fix] Hold natural width inside the horizontal ScrollView so
        // the right-side filter pills (Transactions / Work / Promises / etc.)
        // can't get visually compressed against the screen edge when the
        // leftmost tab is selected.
        flexShrink: 0,
    },
    filterTabActive: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        borderColor: '#4A8EE8',
    },
    filterText: {
        fontSize: 13,
        fontWeight: '500',
        color: '#8B929E',
    },
    filterTextActive: {
        color: '#4A8EE8',
    },

    // List
    listContent: {
        padding: SPACING.m,
        paddingTop: 0,
        flexGrow: 1,
    },

    // Date Section
    dateSection: {
        marginBottom: SPACING.l,
    },
    dateHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: '#8B929E',
        marginBottom: SPACING.m,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },

    // Envelope / Activity Item
    envelopeItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderLeftWidth: 3,
        borderLeftColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
        elevation: 3,
    },
    emergencyItem: {
        backgroundColor: 'rgba(255,71,87,0.10)',
        borderColor: 'rgba(255,71,87,0.30)',
        borderLeftColor: COLORS.error,
    },
    hiddenItem: {
        opacity: 0.5,
    },
    hiddenBadge: {
        marginTop: SPACING.xs,
        backgroundColor: 'rgba(18,21,26,0.60)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        alignSelf: 'flex-start',
    },
    hiddenBadgeText: {
        fontSize: 10,
        color: '#8B929E',
        fontWeight: '500',
    },
    iconContainer: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: SPACING.m,
    },
    icon: {
        fontSize: 20,
    },
    envelopeContent: {
        flex: 1,
    },
    envelopeHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    actionLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.text,
    },
    emergencyLabel: {
        color: COLORS.error,
    },
    timestamp: {
        fontSize: 11,
        color: '#9CA3AF',
    },
    intentText: {
        fontSize: 12,
        color: '#8B929E',
        lineHeight: 18,
    },
    peIdLine: {
        marginTop: SPACING.xs,
        fontSize: 10,
        color: COLORS.textSecondary,
        fontWeight: '500',
        letterSpacing: 0.3,
    },
    agentBadge: {
        marginTop: SPACING.xs,
        backgroundColor: 'rgba(155,109,255,0.15)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        alignSelf: 'flex-start',
    },
    agentBadgeText: {
        fontSize: 10,
        color: '#6BA3F0',
        fontWeight: '500',
    },
    decisionBadge: {
        marginTop: SPACING.xs,
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        alignSelf: 'flex-start',
    },
    decisionAllow: {
        backgroundColor: 'rgba(0,230,118,0.15)',
    },
    decisionDeny: {
        backgroundColor: 'rgba(255,71,87,0.15)',
    },
    decisionHuman: {
        backgroundColor: 'rgba(255,179,0,0.15)',
    },
    decisionText: {
        fontSize: 10,
        fontWeight: '500',
        color: COLORS.chromeMuted,
    },
    arrow: {
        fontSize: 20,
        color: '#9CA3AF',
        marginLeft: SPACING.s,
    },
    chatUnreadBadge: {
        minWidth: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#4A8EE8',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 5,
        marginRight: SPACING.xs,
    },
    chatUnreadText: {
        color: '#FFFFFF',
        fontSize: 11,
        fontWeight: '700',
    },

    // Empty State
    emptyState: {
        alignItems: 'center',
        padding: SPACING.xxl,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: COLORS.chromeMuted,
        marginTop: SPACING.m,
        marginBottom: SPACING.s,
    },
    emptySubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
    },

    // Archive Section
    archiveSection: {
        marginTop: SPACING.l,
        paddingTop: SPACING.l,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.08)',
    },
    archiveHeader: {
        fontSize: 14,
        fontWeight: '600',
        color: '#8B929E',
        marginBottom: SPACING.xs,
    },
    archiveSubtext: {
        fontSize: 12,
        color: '#9CA3AF',
        marginBottom: SPACING.m,
    },
    archiveItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    archiveMonth: {
        flex: 1,
        fontSize: 14,
        fontWeight: '500',
        color: COLORS.text,
    },
    archiveCount: {
        fontSize: 12,
        color: '#8B929E',
        marginRight: SPACING.s,
    },
    archiveArrow: {
        fontSize: 16,
        color: '#9CA3AF',
    },
    archiveMore: {
        fontSize: 12,
        color: '#9CA3AF',
        textAlign: 'center',
        marginTop: SPACING.s,
    },
    archiveLoading: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.l,
        gap: SPACING.s,
    },
    archiveLoadingText: {
        fontSize: 14,
        color: '#8B929E',
    },
});
