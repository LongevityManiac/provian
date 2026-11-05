/**
 * MyProvenanceDashboardScreen - PVT (Provenance Value Token) Dashboard
 *
 * NOTE: This file IS the "Abundance" TAB (registered as the Abundance tab in
 * TabNavigator.tsx). Despite the name, the similarly-named
 * src/screens/Abundance/AbundanceDashboardScreen.tsx is a SEPARATE 'AbundanceDashboard'
 * DETAIL route (a PE/participation explainer) pushed from this screen - not the tab.
 *
 * Provenance and contribution tracking screen. Shows sealed record points,
 * a separately labelled non-final settlement projection, PE history, network
 * stats, and a PE-count leaderboard.
 *
 * Sections:
 * 1. Personal Stats (hero card with count-up animation)
 * 2. PE Breakdown by category
 * 3. PE History (paginated list)
 * 4. Network Stats (cached 60s client-side)
 * 5. Leaderboard (cached 5min client-side)
 * 6. Phase Roadmap
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    RefreshControl,
    TouchableOpacity,
    Animated,
    ActivityIndicator,
    Clipboard,
    Alert,
    Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import relayService from '../../services/RelayAPIService';
import type {
    PVTAccrual,
    PVTHistoryEntry,
    PVTNetworkStats,
    PVTLeaderboardEntry,
    PVTBreakdownItem,
    GenesisWalletStatus,
} from '../../services/RelayAPIService';
import { useWalletStore } from '../../store/walletStore';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import { getPhoneMeter } from '../../core/meter/phoneMeterRuntime';
import { localHistoryEntries } from '../../core/meter/peHistoryView';
import { RecentHistoryPager } from '../../core/meter/recentHistory';
import DeviceContributionsSection from './DeviceContributionsSection';
import { useTranslation } from 'react-i18next';
import {
    isHardwareAttestationTier,
    normalizePVTAttestationTier,
    pvtAttestationTierCode,
} from '../../core/provenance/attestationTiers';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import { shouldShowLeaderboard } from '../../utils/leaderboardVisibility';
import { buildEarningChip, chipForDisposition, normalizeMintStatus } from '../../utils/peDisposition';
import { DispositionChip } from '../../components/DispositionChip';
import { InfoModal, InfoButton } from '../../components/InfoModal';
import {
    groupByCommit,
    describeCommitWitnesses,
    bestDisposition,
    shortSha,
    type CommitGroup,
} from '../../utils/commitGrouping';
import BackButton from '../../components/BackButton';
import PeCustodyCard from '../../components/PeCustodyCard';
import SettleNowCard from '../../components/SettleNowCard';
import ArchiveCard from '../../components/ArchiveCard';
import { isGenesisWindowOpen } from '../Onboarding/genesisWindow';

// Category colors for breakdown bar
const CATEGORY_COLORS: Record<string, string> = {
    wallet: COLORS.primary,
    agent: COLORS.purple,
    x402: COLORS.secondary,
    promises: COLORS.success,
    other: '#7B8794',
};

const CATEGORY_LABEL_KEYS: Record<string, string> = {
    wallet: 'provenanceDashboard.categoryWallet',
    agent: 'provenanceDashboard.categoryAgent',
    x402: 'provenanceDashboard.categoryX402',
    promises: 'provenanceDashboard.categoryPromises',
    other: 'provenanceDashboard.categoryOther',
};

// the private ACTION_ICONS map + getActionIcon/getActionLabel were deleted.
// This screen now renders every PE through the ONE canonical map
// (utils/actionTypeDisplay.ts) \u2014 `getActionTypeDisplay(type).emoji` for the icon,
// `.label` for the label \u2014 so a commit / conversation / work-product PE gets a real
// icon + human label instead of the generic \uD83D\uDCCB fallback.

function formatTimestamp(timestamp: number, translate: (key: string, options?: Record<string, unknown>) => string): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return translate('provenanceDashboard.justNow');
    if (diffMins < 60) return translate('provenanceDashboard.minutesAgo', { count: diffMins });
    if (diffHours < 24) return translate('provenanceDashboard.hoursAgo', { count: diffHours });
    if (diffDays === 1) return translate('provenanceDashboard.yesterday');
    if (diffDays < 7) return translate('provenanceDashboard.daysAgo', { count: diffDays });

    return new Date(timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });
}

function formatNumber(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
}

/**
 * the per-row earning-disposition chip. Renders "Earns ~X PVT · pending" /
 * "Pending" / "Record only" / "Minted ✓" from the sealed mint_status. The amount,
 * when present, is the eligible-only projection only — never a record-points sum.
 * Renders nothing for an unknown/legacy disposition (never overclaims).
 */

// Skeleton loader component
function SkeletonBox({ width, height, style }: {
    width: number | string;
    height: number;
    style?: Record<string, unknown>;
}) {
    const opacity = useRef(new Animated.Value(0.4)).current;

    useEffect(() => {
        const anim = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 1.0, duration: 800, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.4, duration: 800, useNativeDriver: true }),
            ])
        );
        anim.start();
        return () => anim.stop();
    }, [opacity]);

    return (
        <Animated.View
            style={[{
                width: width as number,
                height,
                borderRadius: BORDER_RADIUS.s,
                backgroundColor: COLORS.surface,
                opacity,
            }, style]}
        />
    );
}

// Initial page size for PE history list inside the ScrollView
const HISTORY_PAGE_SIZE = 10;
/** Relay rows read per request; Your Proof Trail reads 50. */
const RELAY_HISTORY_PAGE_SIZE = 50;

interface MyProvenanceDashboardProps {
    navigation: {
        goBack: () => void;
        navigate: (screen: string, params?: Record<string, unknown>) => void;
    };
}

export default function MyProvenanceDashboardScreen({ navigation }: MyProvenanceDashboardProps) {
    const { t } = useTranslation();
    // Tab-root-safe back guard (same idiom as VisionScreen): only show a back
    // arrow when the nearest navigator is a Stack (a pushed route), never at the
    // Abundance tab root. The prior `useNavigationState(state => state.index > 0)`
    // read the Tab navigator's selected-tab index (Abundance = 1), so it was
    // always true at the tab root and rendered a stray arrow.
    const nav = useNavigation();
    const canGoBack = nav.canGoBack() && nav.getState()?.type !== 'tab';
    const { promisesOnboardingComplete } = useWalletStore();

    // Data state
    const [accrual, setAccrual] = useState<PVTAccrual | null>(null);
    const [history, setHistory] = useState<PVTHistoryEntry[]>([]);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [networkStats, setNetworkStats] = useState<PVTNetworkStats | null>(null);
    const [genesis, setGenesis] = useState<GenesisWalletStatus | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [leaderboardPeriod, setLeaderboardPeriod] = useState<'all' | 'week'>('all');

    // Auth state
    const [notRegistered, setNotRegistered] = useState(false);

    // Loading state
    const [loading, setLoading] = useState(true);
    const [accrualLoading, setAccrualLoading] = useState(true);
    const [accrualError, setAccrualError] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyError, setHistoryError] = useState(false);
    const historyRequestRef = useRef(0);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    // Client-side per-window network-stats cache (60s each). The ref mirrors
    // leaderboardPeriod so zero-arg callers (loadAll) fetch whatever window is
    // currently on screen.
    const leaderboardPeriodRef = useRef<'all' | 'week'>('all');
    const networkStatsCache = useRef<{
        all?: { data: PVTNetworkStats; at: number };
        week?: { data: PVTNetworkStats; at: number };
    }>({});

    // Count-up animation
    const [displayPVT, setDisplayPVT] = useState('0.0');
    const [projectionInfoVisible, setProjectionInfoVisible] = useState(false);
    const pvtAnimRef = useRef<Animated.Value | null>(null);

    // Count-up animation for the hero PVT figure.
    //
    // MONEY-SAFETY GUARD: the hero figure is ONLY ever the eligible-only
    // settlement projection. When the projection is unavailable (the current state
    // — no live PVT9 settlement-factor reader) the hero shows the PE COUNT (see the
    // hero render), and the count-up must NOT fall back to a record-points sum
    // (record points are not PVT). So this animates the projection when available
    // and does nothing otherwise — re-enabling projection cannot resurrect a
    // record-points target because record points never appear here.
    useEffect(() => {
        if (!accrual) return;
        if (!accrual.currentSettlementProjection.available) {
            setDisplayPVT('0.0');
            return;
        }
        const target = parseFloat(accrual.currentSettlementProjection.totalPVT);
        if (isNaN(target)) return;

        // Clean up any previous animation
        if (pvtAnimRef.current) {
            pvtAnimRef.current.removeAllListeners();
        }

        const anim = new Animated.Value(0);
        pvtAnimRef.current = anim;

        anim.addListener(({ value }) => {
            setDisplayPVT(value.toFixed(1));
        });

        Animated.timing(anim, {
            toValue: target,
            duration: 1200,
            useNativeDriver: false,
        }).start();

        return () => {
            anim.removeAllListeners();
        };
    }, [
        accrual?.currentSettlementProjection.available,
        accrual?.currentSettlementProjection.available
            ? accrual.currentSettlementProjection.totalPVT
            : null,
    ]);

    // Data loading functions
    const loadAccrual = useCallback(async () => {
        setAccrualLoading(true);
        try {
            const data = await relayService.getPVTAccrual();
            setAccrual(data);
            setAccrualError(data === null);
        } catch {
            setAccrual(null);
            setAccrualError(true);
        } finally {
            setAccrualLoading(false);
        }
    }, [relayService]);

    /** Enrich history entries with card metadata from locally stored PEs */
    const enrichWithCardMetadata = async (entries: PVTHistoryEntry[]): Promise<PVTHistoryEntry[]> => {
        const spendingTypes = new Set([
            'agent_authorized', 'proxied_payment_completed', 'approval_only',
            'send', 'swap', 'credential_released', 'credential_injected',
        ]);
        try {
            const localPEs = await ProvenanceEnvelopeManager.getRecentPEs();
            const peMap = new Map(localPEs.map((pe: any) => [pe.envelope_id, pe]));

            return entries.map(entry => {
                if (!spendingTypes.has(entry.actionType)) return entry;
                const pe = peMap.get(entry.peId);
                if (!pe || !pe.authorization_purpose) return entry;
                try {
                    const purpose = JSON.parse(pe.authorization_purpose);
                    const nickname = purpose.cardNickname || purpose.card_nickname;
                    const lastFour = purpose.cardLastFour || purpose.card_last_four || purpose.lastFour;
                    if (nickname || lastFour) {
                        const label = nickname
                            ? `${nickname}${lastFour ? ` ****${lastFour}` : ''}`
                            : `****${lastFour}`;
                        return { ...entry, paymentMethod: label };
                    }
                } catch {
                    // authorization_purpose not valid JSON - skip
                }
                return entry;
            });
        } catch {
            return entries; // Local PEs unavailable - return as-is
        }
    };

    // PE METER : the relay stops storing PEs, so the list is read from the PEs
    // this phone HOLDS — each with the disposition + record points from its batch receipt — and
    // only after those, the relay's pre-meter history (deduplicated by id) for older rows.
    // Recent History merges the PEs this phone holds with the relay's history, newest first,
    // so it shows the same records as Your Proof Trail in the same order (core/meter/recentHistory).
    const historyPagerRef = useRef<RecentHistoryPager | null>(null);
    const loadHistory = useCallback(async (offset: number = 0) => {
        if (offset === 0) {
            historyRequestRef.current += 1;
            setHistoryLoading(true);
            setHistory([]);
        }
        const requestId = historyRequestRef.current;
        try {
            if (offset === 0) {
                let local: PVTHistoryEntry[] = [];
                try {
                    const meter = getPhoneMeter();
                    await meter.start();
                    local = await localHistoryEntries(meter.store, { showHidden });
                } catch {
                    local = [];
                }
                if (requestId !== historyRequestRef.current) return;
                historyPagerRef.current = new RecentHistoryPager(
                    local,
                    async () => ({ entries: [], hasMore: false, total: local.length }),
                    HISTORY_PAGE_SIZE,
                    RELAY_HISTORY_PAGE_SIZE,
                );
            }
            const pager = historyPagerRef.current;
            if (!pager) return;
            const view = offset === 0 ? await pager.first() : await pager.more();
            if (requestId !== historyRequestRef.current) return;
            if (view.failed) {
                setHistory([]);
                setHistoryError(true);
                return;
            }
            // Enrich spending entries with card metadata from local PEs
            const enriched = await enrichWithCardMetadata(view.entries);
            if (requestId !== historyRequestRef.current) return;
            setHistoryError(false);
            setHistory(enriched);
            setHistoryTotal(view.total);
            setHistoryHasMore(view.hasMore);
        } catch {
            if (offset === 0 && requestId === historyRequestRef.current) {
                setHistory([]);
                setHistoryError(true);
            }
        } finally {
            if (offset === 0 && requestId === historyRequestRef.current) setHistoryLoading(false);
        }
    }, [relayService, showHidden]);

    const loadGenesis = useCallback(async () => {
        // Read-only Genesis progress feedback (#28). Hidden unless the campaign
        // is live or this wallet has genesis progress to show.
        const data = await relayService.getGenesisStatus();
        setGenesis(data);
    }, [relayService]);

    const loadNetworkStats = useCallback(async (window?: 'all' | 'week') => {
        const w = window ?? leaderboardPeriodRef.current;
        const cached = networkStatsCache.current[w];
        if (cached && Date.now() - cached.at < 60000) {
            setNetworkStats(cached.data);
            return;
        }
        const data = await relayService.getPVTNetworkStats(w);
        if (data) {
            networkStatsCache.current[w] = { data, at: Date.now() };
            setNetworkStats(data);
        }
    }, [relayService]);

    // Leaderboard window toggle: actually refetches the ranked board for the
    // selected window (the pills used to be styling-only — the period changed
    // nothing). A cached window swaps in instantly.
    const handleLeaderboardPeriod = useCallback((w: 'all' | 'week') => {
        setLeaderboardPeriod(w);
        leaderboardPeriodRef.current = w;
        loadNetworkStats(w);
    }, [loadNetworkStats]);

    const loadAll = useCallback(async () => {
        try {
            const registered = await relayService.isRegistered();
            setLoading(false);
            if (!registered) {
                setNotRegistered(true);
                return;
            }
            setNotRegistered(false);
            // Each request updates its own section as soon as it resolves. The
            // full-screen gate is only for the local registration check, never
            // for the slow accrual endpoint or unrelated network sections.
            // The economic governance router is a dormant PVT9 candidate (not
            // mounted), so the active-proposals count is not polled here — it
            // would only ever hit a permanent 503 and read 0 (audit 2026-08-05
            // finding 23). The governance card shows the live phase + points instead.
            await Promise.allSettled([
                loadAccrual(),
                loadHistory(0),
                loadNetworkStats(),
                loadGenesis(),
            ]);
        } catch {
            setLoading(false);
            setAccrualError(true);
            setAccrual(null);
            setAccrualLoading(false);
            setHistoryError(true);
            setHistoryLoading(false);
        }
    }, [loadAccrual, loadHistory, loadNetworkStats, loadGenesis]);

    // Initial load + retry any pending PE submissions
    useEffect(() => {
        const run = async () => {
            // PE METER: send any unsent PEs now (it keeps its own schedule; non-blocking).
            void getPhoneMeter().tick('foreground');
            // [N3] Re-attempt any PE creations deferred because createEnvelope
            // threw after a confirmed on-chain action (send/swap). Non-blocking.
            ProvenanceEnvelopeManager.retryDeferredEnvelopes?.().catch(() => {});
            await loadAll();
        };
        run();
    }, []);

    // The tab mounts once and stays mounted, so a first look taken before this device had relay
    // credentials (a restore still reconnecting) would otherwise show "Not yet connected" until a
    // relaunch. Re-check on every focus while in that state.
    const notRegisteredRef = useRef(false);
    notRegisteredRef.current = notRegistered;
    useFocusEffect(useCallback(() => {
        if (notRegisteredRef.current) loadAll();
    }, [loadAll]));

    // Reload history when showHidden changes
    const historyFilterInitialized = useRef(false);
    useEffect(() => {
        if (!historyFilterInitialized.current) {
            historyFilterInitialized.current = true;
            return;
        }
        loadHistory(0);
    }, [showHidden]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        // Force network stats refresh
        networkStatsCache.current = {};
        await loadAll();
        setRefreshing(false);
    }, [loadAll]);

    const handleLoadMore = useCallback(async () => {
        if (loadingMore || !historyHasMore) return;
        setLoadingMore(true);
        await loadHistory(history.length);
        setLoadingMore(false);
    }, [loadingMore, historyHasMore, history.length, loadHistory]);

    const handleCopyHash = useCallback((hash: string) => {
        Clipboard.setString(hash);
        Alert.alert(t('common.copied'), t('provenanceDashboard.hashCopied'));
    }, []);

    // one history row, rendered through the canonical action-type map, with
    // the earning-disposition chip. The chip subsumes the old "~X PVT (non-final)"
    // line — it shows the eligible-only projection through its work, and never a
    // record-points number.
    const renderHistoryRow = (entry: PVTHistoryEntry) => {
        const display = getActionTypeDisplay(entry.actionType);
        const chip = buildEarningChip({
            mintStatus: entry.mintStatus,
            currentSettlementProjectionPVT: entry.currentSettlementProjectionPVT,
        });
        return (
            <TouchableOpacity
                key={entry.peId}
                style={[styles.historyItem, entry.hidden && styles.historyItemHidden]}
                onPress={() => navigation.navigate('EnvelopeDetail', { envelopeId: entry.peId })}
                activeOpacity={0.7}
            >
                <View style={styles.historyIcon}>
                    <Text style={styles.historyIconText}>{display.emoji}</Text>
                </View>
                <View style={styles.historyContent}>
                    <View style={styles.historyTopRow}>
                        <Text style={styles.historyAction} numberOfLines={1}>{display.label}</Text>
                        <Text style={styles.historyTimestamp}>{formatTimestamp(entry.timestamp, t)}</Text>
                    </View>
                    {entry.paymentMethod && (
                        <Text style={styles.historyPaymentMethod} numberOfLines={1}>
                            {t('provenanceDashboard.viaPayment', { method: entry.paymentMethod })}
                        </Text>
                    )}
                    <View style={styles.historyBottomRow}>
                        <View style={[
                            styles.attestationBadgeSmall,
                            isHardwareAttestationTier(entry.attestationDepth)
                                ? styles.attestationHW
                                : styles.attestationSW,
                        ]}>
                            <Text style={styles.attestationTextSmall}>
                                {pvtAttestationTierCode(entry.attestationDepth)}
                            </Text>
                        </View>
                        <DispositionChip chip={chip} />
                        <TouchableOpacity
                            onPress={() => handleCopyHash(entry.hash)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Text style={styles.historyHash}>{entry.hash.slice(0, 8)}...</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        );
    };

    // one collapsed commit row — the coding_session + service:github_commit
    // (+ any corroboration) witnesses of ONE commit, shown as a single "Commit
    // abc1234 · witnessed locally + by GitHub" row. Pay-once-by-SHA holds server
    // side; only one witness mints, so the group's chip is the best-of disposition
    // and the amount is the single non-null eligible-only projection among members.
    const renderCommitRow = (group: CommitGroup<PVTHistoryEntry>) => {
        const witnesses = describeCommitWitnesses(group.items.map((i) => i.actionType));
        const disposition = bestDisposition(group.items.map((i) => normalizeMintStatus(i.mintStatus)));
        const projection = group.items
            .map((i) => i.currentSettlementProjectionPVT)
            .find((p) => p != null) ?? null;
        const chip = chipForDisposition(disposition, projection);
        const newest = group.primary;
        const confirmed = disposition === 'minted' || disposition === 'earning';
        return (
            <TouchableOpacity
                key={`commit:${group.commitSha}`}
                style={styles.historyItem}
                onPress={() => navigation.navigate('EnvelopeDetail', { envelopeId: newest.peId })}
                activeOpacity={0.7}
            >
                <View style={styles.historyIcon}>
                    <Text style={styles.historyIconText}>{getActionTypeDisplay('service:github_commit').emoji}</Text>
                </View>
                <View style={styles.historyContent}>
                    <View style={styles.historyTopRow}>
                        <Text style={styles.historyAction} numberOfLines={1}>{t('ui.provenance.commit', { sha: shortSha(group.commitSha) })}</Text>
                        <Text style={styles.historyTimestamp}>{formatTimestamp(newest.timestamp, t)}</Text>
                    </View>
                    <Text style={styles.historyPaymentMethod} numberOfLines={1}>
                        {witnesses}{confirmed ? t('ui.provenance.confirmed') : ''}
                    </Text>
                    <View style={styles.historyBottomRow}>
                        <View style={styles.commitCountBadge}>
                            <Text style={styles.commitCountText}>{t('ui.provenance.witnessed', { count: group.items.length })}</Text>
                        </View>
                        <DispositionChip chip={chip} />
                        <TouchableOpacity
                            onPress={() => handleCopyHash(group.commitSha)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                            <Text style={styles.historyHash}>{shortSha(group.commitSha)}...</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        );
    };

    // Only the relay's confirmed zero, paired with a successful empty history,
    // is an empty record. A slow or failed accrual can never erase PE history.
    const isGenuineEmpty = accrual !== null && accrual.totalPEs === 0
        && !historyLoading && !historyError && history.length === 0;

    // Not registered - show explanation instead of "server unreachable"
    if (!loading && notRegistered) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={GRADIENTS.backgroundDiagonal}
                    style={StyleSheet.absoluteFill}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                />
                <View style={styles.header}>
                    {canGoBack ? (
                        <BackButton onPress={() => navigation.goBack()} />
                    ) : (
                        <Image
                            source={require('../../../assets/images/provian-logo.png')}
                            style={styles.headerLogo}
                            resizeMode="contain"
                        />
                    )}
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>
                <View style={styles.emptyState}>
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={styles.emptyLogo}
                        resizeMode="contain"
                    />
                    <Text style={styles.emptyTitle}>{t('provenanceDashboard.notYetConnected')}</Text>
                    <Text style={styles.emptySubtitle}>{t('provenanceDashboard.notYetConnectedMsg')}</Text>
                </View>
            </SafeAreaView>
        );
    }

    // Loading skeleton
    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={GRADIENTS.backgroundDiagonal}
                    style={StyleSheet.absoluteFill}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                />
                <View style={styles.header}>
                    {canGoBack ? (
                        <BackButton onPress={() => navigation.goBack()} />
                    ) : (
                        <Image
                            source={require('../../../assets/images/provian-logo.png')}
                            style={styles.headerLogo}
                            resizeMode="contain"
                        />
                    )}
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>
                <View style={styles.skeletonContainer}>
                    <ActivityIndicator size="small" color={COLORS.primary} style={{ marginBottom: SPACING.m }} />
                    <Text style={{ color: COLORS.textMuted, fontSize: 13, textAlign: 'center', marginBottom: SPACING.l }}>{t('provenanceDashboard.loadingRecord')}</Text>
                    <SkeletonBox width="100%" height={140} style={{ marginBottom: SPACING.m }} />
                    <SkeletonBox width="100%" height={80} style={{ marginBottom: SPACING.m }} />
                    <SkeletonBox width="100%" height={60} style={{ marginBottom: SPACING.s }} />
                    <SkeletonBox width="100%" height={60} style={{ marginBottom: SPACING.s }} />
                    <SkeletonBox width="100%" height={60} style={{ marginBottom: SPACING.s }} />
                </View>
            </SafeAreaView>
        );
    }

    // Confirmed empty state for a genuinely new record.
    if (isGenuineEmpty) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={GRADIENTS.backgroundDiagonal}
                    style={StyleSheet.absoluteFill}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                />
                <View style={styles.header}>
                    {canGoBack ? (
                        <BackButton onPress={() => navigation.goBack()} />
                    ) : (
                        <Image
                            source={require('../../../assets/images/provian-logo.png')}
                            style={styles.headerLogo}
                            resizeMode="contain"
                        />
                    )}
                    <View style={{ flex: 1 }} />
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>
                <View style={styles.emptyState}>
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={styles.emptyLogo}
                        resizeMode="contain"
                    />
                    <Text style={styles.emptyTitle}>{t('provenanceDashboard.recordStartsHere')}</Text>
                    <Text style={styles.emptySubtitle}>{t('provenanceDashboard.recordStartsHereMsg')}</Text>
                    {!promisesOnboardingComplete && (
                        <TouchableOpacity
                            style={styles.emptyCTASecondary}
                            onPress={() => navigation.navigate('PromiseList')}
                        >
                            <Text style={styles.emptyCTASecondaryText}>{t('provenanceDashboard.setUpPromises')}</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header */}
            <View style={styles.header}>
                {canGoBack ? (
                    <BackButton onPress={() => navigation.goBack()} />
                ) : (
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={styles.headerLogo}
                        resizeMode="contain"
                    />
                )}
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                    <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                </TouchableOpacity>
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={COLORS.primary}
                    />
                }
                showsVerticalScrollIndicator={false}
            >
                {/* Hero */}
                <View style={styles.heroVisual}>
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={styles.heroLogo}
                        resizeMode="contain"
                    />
                    <Text style={styles.heroVisualTitle}>{t('provenanceDashboard.yourAbundance')}</Text>
                    <Text style={styles.heroVisualSubtitle}>{t('provenanceDashboard.abundanceSubtitle')}</Text>
                </View>

                {/* Section 1: Personal Stats (Hero Card) */}
                {accrualLoading && (
                    <View style={styles.inlineLoadState}>
                        <ActivityIndicator size="small" color={COLORS.primary} />
                        <Text style={styles.inlineLoadText}>{t('provenanceDashboard.loadingRecord')}</Text>
                    </View>
                )}
                {!accrualLoading && accrualError && (
                    <View style={styles.inlineLoadState}>
                        <Text style={styles.inlineLoadText}>{t('provenanceDashboard.loadRecordErrorTitle')}</Text>
                        <TouchableOpacity onPress={loadAccrual}>
                            <Text style={styles.inlineRetryText}>{t('common.tryAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
                {accrual && (
                    <View style={styles.heroCard}>
                        <LinearGradient
                            colors={GRADIENTS.balanceCard}
                            style={styles.heroCardGradient}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                        >
                            <View style={styles.heroLabelRow}>
                                <Text style={styles.heroLabel}>
                                    {accrual.currentSettlementProjection.available
                                        ? t('provenanceDashboard.currentProjectionNonFinal')
                                        : t('provenanceDashboard.provenanceEnvelopes')}
                                </Text>
                                {accrual.currentSettlementProjection.available && (
                                    <InfoButton
                                        onPress={() => setProjectionInfoVisible(true)}
                                        color={COLORS.textSecondary}
                                    />
                                )}
                            </View>
                            <Text style={styles.heroPVT}>
                                {accrual.currentSettlementProjection.available
                                    ? displayPVT
                                    : accrual.totalPEs.toLocaleString()}
                            </Text>
                            {accrual.currentSettlementProjection.available && (
                                <Text style={styles.heroSubtitle}>
                                    {t('provenanceDashboard.basedOnPEs', { count: accrual.totalPEs, formattedCount: accrual.totalPEs.toLocaleString() })}
                                </Text>
                            )}

                            {/* Stats row */}
                            <View style={styles.heroStatsRow}>
                                <View style={styles.heroStat}>
                                    <Text style={styles.heroStatValue}>{accrual.weeklyPEs}</Text>
                                    <Text style={styles.heroStatLabel}>{t('provenanceDashboard.thisWeek')}</Text>
                                </View>
                                <View style={styles.heroStatDivider} />
                                <View style={styles.heroStat}>
                                    <Text style={styles.heroStatValue}>{accrual.totalPEs}</Text>
                                    <Text style={styles.heroStatLabel}>{t('commons.totalPEs')}</Text>
                                </View>
                            </View>

                            {/* Attestation badge - own row */}
                            <View style={styles.attestationRow}>
                                <View style={[
                                    styles.attestationBadge,
                                    isHardwareAttestationTier(accrual.attestationDepth)
                                        ? styles.attestationHW
                                        : styles.attestationSW,
                                ]}>
                                    <Text style={styles.attestationText}>
                                        {pvtAttestationTierCode(accrual.attestationDepth)}
                                    </Text>
                                </View>
                                <Text style={styles.heroStatLabel}>{t('devices.attestation')}</Text>
                                {normalizePVTAttestationTier(accrual.attestationDepth) === 'hardware_full' && (
                                    <Text style={styles.multiplierHint}>{t('provenanceDashboard.hardwareMintRate')}</Text>
                                )}
                            </View>

                            {/* PVT description */}
                            <Text style={styles.heroDescription}>
                                {t('provenanceDashboard.pvtEligibleComputeDesc')}
                            </Text>
                        </LinearGradient>
                    </View>
                )}

                {/* : standard earnings settle on a schedule Provian sets, currently every 30 days for free; settle now for $1. */}
                <SettleNowCard />

                {/* : the paid PE Archive — and its "Archive full — add 1 GB for $5" prompt. */}
                <ArchiveCard />

                {/* Trust Layer §2.3: the actor's own reputation vocabulary — the
                    live read a counterparty would see in a presentation. */}
                <TouchableOpacity
                    style={styles.reputationRow}
                    onPress={() => navigation.navigate('OwnProfile')}
                    activeOpacity={0.7}
                >
                    <Ionicons name="shield-checkmark" size={22} color={COLORS.platinum} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.reputationTitle}>{t('trustLayer.ownProfile.entryTitle')}</Text>
                        <Text style={styles.reputationSubtitle}>{t('trustLayer.ownProfile.entryDesc')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                </TouchableOpacity>

                {/* cutover reconciliation product truth: the Genesis view is a legacy RECORD ONLY.
                    The backend v3 projection deleted the ladder/pool/window/next
                    fields, so this section renders solely the historical issuance
                    record — shown only when a record exists, never as a live pool,
                    pending mint, or PVT9 state. */}
                {genesis && genesis.genesis_pvt_earned_record > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('provenanceDashboard.genesisTitle')}</Text>
                        <View style={styles.genesisCard}>
                            {/* The campaign line rides the Genesis window like every other
                                Genesis surface (genesisWindow.ts); the earned record stays. */}
                            {isGenesisWindowOpen() && (
                                <>
                                    <Text style={styles.genesisSubtitle}>{t('provenanceDashboard.genesisSubtitle')}</Text>
                                    <View style={styles.genesisDivider} />
                                </>
                            )}
                            <Text style={styles.genesisEarnedValue}>{formatNumber(genesis.genesis_pvt_earned_record)} PVT</Text>
                            <Text style={styles.genesisEarnedLabel}>{t('provenanceDashboard.genesisEarned')}</Text>
                        </View>
                    </View>
                )}

                {/* Section 2: PE Breakdown */}
                {accrual && accrual.breakdown.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('provenanceDashboard.breakdown')}</Text>
                        <View style={styles.breakdownCard}>
                            {/* Segment bar */}
                            <View style={styles.segmentBar}>
                                {accrual.breakdown.map((item) => {
                                    const percentage = accrual.totalPEs > 0
                                        ? (item.peCount / accrual.totalPEs) * 100
                                        : 0;
                                    if (percentage < 1) return null;
                                    return (
                                        <View
                                            key={item.category}
                                            style={[
                                                styles.segmentBarItem,
                                                {
                                                    flex: item.peCount,
                                                    backgroundColor: CATEGORY_COLORS[item.category] || COLORS.textTertiary,
                                                },
                                            ]}
                                        />
                                    );
                                })}
                            </View>

                            {/* Legend */}
                            <View style={styles.legendContainer}>
                                {accrual.breakdown.map((item) => (
                                    <View key={item.category} style={styles.legendItem}>
                                        <View style={[
                                            styles.legendDot,
                                            { backgroundColor: CATEGORY_COLORS[item.category] || COLORS.textTertiary },
                                        ]} />
                                        <Text style={styles.legendLabel}>
                                            {CATEGORY_LABEL_KEYS[item.category] ? t(CATEGORY_LABEL_KEYS[item.category]) : item.category}
                                        </Text>
                                        <Text style={styles.legendCount}>
                                            {t('provenanceDashboard.peCount', { count: item.peCount })}
                                        </Text>
                                        {item.currentSettlementProjectionPVT !== null && (
                                            <Text style={styles.legendPVT}>
                                                {t('provenanceDashboard.projectedNonFinal', { amount: item.currentSettlementProjectionPVT })}
                                            </Text>
                                        )}
                                    </View>
                                ))}
                            </View>
                        </View>
                    </View>
                )}

                {/* Why This Matters - consolidated card */}
                <View style={{ marginTop: SPACING.m, marginBottom: SPACING.m }}>
                    <TouchableOpacity
                        style={{
                            backgroundColor: 'rgba(255, 140, 0, 0.08)',
                            borderRadius: 14,
                            padding: SPACING.m,
                            borderWidth: 1,
                            borderColor: 'rgba(255, 140, 0, 0.15)',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: SPACING.s,
                        }}
                        onPress={() => navigation.navigate('Vision')}
                        activeOpacity={0.7}
                    >
                        <Ionicons name="sparkles" size={20} color="#E8A838" />
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: COLORS.text, fontSize: 14, fontWeight: '600' }}>{t('provenanceDashboard.whyMatters')}</Text>
                            <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 2 }}>{t('provenanceDashboard.whyMattersDesc')}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color="#E8A838" />
                    </TouchableOpacity>
                </View>

                {/* Section 3: PE History */}
                <View style={styles.section}>
                    <View style={styles.sectionHeaderRow}>
                        <Text style={styles.sectionTitle}>{t('provenanceDashboard.recentHistory')}</Text>
                        <TouchableOpacity
                            style={[styles.hiddenToggle, showHidden && styles.hiddenToggleActive]}
                            onPress={() => setShowHidden(!showHidden)}
                        >
                            <Ionicons
                                name={showHidden ? 'eye' : 'eye-off-outline'}
                                size={16}
                                color={showHidden ? COLORS.primary : COLORS.textSecondary}
                            />
                        </TouchableOpacity>
                    </View>
                    <PeCustodyCard compact />

                    {historyLoading ? (
                        <View style={styles.historyEmpty}>
                            <ActivityIndicator size="small" color={COLORS.primary} />
                        </View>
                    ) : historyError ? (
                        <View style={styles.historyEmpty}>
                            <Text style={styles.historyEmptyText}>{t('dashboard.participationLoadError')}</Text>
                            <TouchableOpacity onPress={() => loadHistory(0)}>
                                <Text style={styles.inlineRetryText}>{t('common.tryAgain')}</Text>
                            </TouchableOpacity>
                        </View>
                    ) : history.length === 0 ? (
                        <View style={styles.historyEmpty}>
                            <Text style={styles.historyEmptyText}>{t('provenanceDashboard.noEnvelopesYet')}</Text>
                        </View>
                    ) : (
                        <>
                            {groupByCommit(history, (e) => e.commitSha).map((row) =>
                                row.kind === 'commit'
                                    ? renderCommitRow(row.group)
                                    : renderHistoryRow(row.item),
                            )}

                            {/* Load More */}
                            {historyHasMore && (
                                <TouchableOpacity
                                    style={styles.loadMoreButton}
                                    onPress={handleLoadMore}
                                    disabled={loadingMore}
                                >
                                    {loadingMore ? (
                                        <ActivityIndicator size="small" color={COLORS.primary} />
                                    ) : (
                                        <Text style={styles.loadMoreText}>
                                            {t('provenanceDashboard.loadMore', { count: historyTotal - history.length })}
                                        </Text>
                                    )}
                                </TouchableOpacity>
                            )}
                        </>
                    )}
                </View>

                {/* Section 3b: Per-device contributions (folded in from the
                    retired AbundanceDashboard detail screen) */}
                <DeviceContributionsSection />

                {/* Section 4: Network Stats */}
                {networkStats && (
                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>{t('provenanceDashboard.network')}</Text>
                        <View style={styles.networkCard}>
                            <View style={styles.networkGrid}>
                                <View style={styles.networkStat}>
                                    <Text style={styles.networkStatValue}>
                                        {formatNumber(networkStats.totalPEs)}
                                    </Text>
                                    <Text style={styles.networkStatLabel}>{t('commons.totalPEs')}</Text>
                                </View>
                                <View style={styles.networkStat}>
                                    <Text style={styles.networkStatValue}>
                                        {formatNumber(networkStats.activeWallets)}
                                    </Text>
                                    <Text style={styles.networkStatLabel}>{t('provenanceDashboard.activeWallets')}</Text>
                                    <Text style={styles.networkStatDetail}>
                                        {t('provenanceDashboard.walletTypeSplit', { human: networkStats.humanWallets, agent: networkStats.agentWallets })}
                                    </Text>
                                </View>
                                <View style={styles.networkStat}>
                                    <Text style={styles.networkStatValue}>
                                        {formatNumber(networkStats.pesLast24h)}
                                    </Text>
                                    <Text style={styles.networkStatLabel}>{t('provenanceDashboard.pes24h')}</Text>
                                </View>
                            </View>
                        </View>
                    </View>
                )}

                {/* Section 5: Leaderboard — hidden until there are enough real
                    participants to rank (see leaderboardVisibility). */}
                {networkStats && shouldShowLeaderboard(networkStats.activeWallets) && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeaderRow}>
                            <Text style={styles.sectionTitle}>{t('provenanceDashboard.leaderboard')}</Text>
                            <View style={styles.leaderboardToggle}>
                                <TouchableOpacity
                                    style={[
                                        styles.togglePill,
                                        leaderboardPeriod === 'all' && styles.togglePillActive,
                                    ]}
                                    onPress={() => handleLeaderboardPeriod('all')}
                                >
                                    <Text style={[
                                        styles.togglePillText,
                                        leaderboardPeriod === 'all' && styles.togglePillTextActive,
                                    ]}>{t('provenanceDashboard.allTime')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.togglePill,
                                        leaderboardPeriod === 'week' && styles.togglePillActive,
                                    ]}
                                    onPress={() => handleLeaderboardPeriod('week')}
                                >
                                    <Text style={[
                                        styles.togglePillText,
                                        leaderboardPeriod === 'week' && styles.togglePillTextActive,
                                    ]}>{t('provenanceDashboard.thisWeek')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        <Text style={styles.leaderboardNote}>{t('provenanceDashboard.leaderboardNote')}</Text>

                        {networkStats.leaderboard.length === 0 && (
                            <View style={styles.leaderboardCard}>
                                <Text style={styles.leaderboardEmptyText}>
                                    {t('provenanceDashboard.leaderboardEmpty')}
                                </Text>
                            </View>
                        )}

                        {networkStats.leaderboard.length > 0 && (
                        <View style={styles.leaderboardCard}>
                            {networkStats.leaderboard.slice(0, 10).map((entry) => {
                                const isCurrentUser = networkStats.userAddress
                                    && entry.address.toLowerCase() === networkStats.userAddress.toLowerCase();
                                return (
                                    <View
                                        key={entry.address}
                                        style={[
                                            styles.leaderboardEntry,
                                            isCurrentUser && styles.leaderboardEntryCurrent,
                                        ]}
                                    >
                                        <Text style={styles.leaderboardRank}>#{entry.rank}</Text>
                                        <Ionicons
                                            name={entry.ownerType === 'human' ? 'person' : 'hardware-chip'}
                                            size={16}
                                            color={entry.ownerType === 'human' ? COLORS.primary : COLORS.purple}
                                            style={styles.leaderboardTypeIcon}
                                        />
                                        <Text style={styles.leaderboardAddress} numberOfLines={1}>
                                            {entry.displayName || `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`}
                                        </Text>
                                        <Text style={styles.leaderboardPVT}>{t('provenanceDashboard.peCount', { count: entry.peCount })}</Text>
                                    </View>
                                );
                            })}
                        </View>
                        )}

                        {/* Current user's rank if not in top 10 */}
                        {networkStats.userRank && networkStats.userRank > 10 && (
                            <View style={styles.userRankCard}>
                                <Text style={styles.userRankText}>
                                    {t('provenanceDashboard.userRank', { rank: networkStats.userRank, total: networkStats.activeWallets.toLocaleString() })}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Section 6 (the "governance power" card) DELETED per
                    / B12 ruled no governance activation, and
                    PEs do not confer governance power today. */}

                {/* Section 7: Phase Roadmap */}
                <View style={styles.section}>
                    <View style={styles.roadmapCard}>
                        <View style={styles.roadmapItem}>
                            <View style={[styles.roadmapDot, styles.roadmapDotActive]} />
                            <View style={styles.roadmapContent}>
                                <Text style={styles.roadmapPhase}>{t('provenanceDashboard.roadmapNow')}</Text>
                                <Text style={styles.roadmapDesc}>{t('provenanceDashboard.roadmapNowDesc')}</Text>
                            </View>
                        </View>
                        <View style={styles.roadmapItem}>
                            <View style={[styles.roadmapDot, styles.roadmapDotUpcoming]} />
                            <View style={styles.roadmapContent}>
                                <Text style={styles.roadmapPhase}>{t('provenanceDashboard.roadmapNext')}</Text>
                                <Text style={styles.roadmapDesc}>{t('provenanceDashboard.roadmapNextDesc')}</Text>
                            </View>
                        </View>
                        <View style={styles.roadmapItem}>
                            <View style={styles.roadmapDot} />
                            <View style={styles.roadmapContent}>
                                <Text style={styles.roadmapPhase}>{t('provenanceDashboard.roadmapBeyond')}</Text>
                                <Text style={styles.roadmapDesc}>{t('provenanceDashboard.roadmapBeyondDesc')}</Text>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Activity Log */}
                <TouchableOpacity
                    style={styles.proofTrailRow}
                    onPress={() => navigation.navigate('ActivityLog')}
                    activeOpacity={0.7}
                >
                    <Ionicons name="time-outline" size={22} color={COLORS.primary} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.proofTrailLabel}>{t('provenanceDashboard.proofTrail')}</Text>
                        <Text style={styles.proofTrailSubtitle}>{t('provenanceDashboard.proofTrailDesc')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                </TouchableOpacity>
            </ScrollView>
            <InfoModal
                visible={projectionInfoVisible}
                onClose={() => setProjectionInfoVisible(false)}
                title={t('pvtProjectionInfo.title')}
                body={t('pvtProjectionInfo.body')}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: 120,
    },

    // Header
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    headerLogo: {
        width: 28,
        height: 28,
        borderRadius: 6,
    },

    // Skeleton Loading
    skeletonContainer: {
        padding: SPACING.m,
    },

    // Hero Visual
    heroVisual: {
        alignItems: 'center',
        marginBottom: SPACING.l,
        paddingTop: SPACING.s,
    },
    heroLogo: {
        width: 80,
        height: 80,
        borderRadius: 16,
        shadowColor: '#E8A838',
        shadowOpacity: 0.35,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 0 },
    },
    heroVisualTitle: {
        fontSize: 28,
        fontWeight: '700',
        color: COLORS.text,
        marginTop: SPACING.m,
    },
    heroVisualSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: 4,
    },

    // Empty state logo
    emptyLogo: {
        width: 64,
        height: 64,
        borderRadius: 14,
        marginBottom: SPACING.m,
        shadowColor: '#E8A838',
        shadowOpacity: 0.25,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 0 },
    },

    // Trust Layer §2.3 own-profile entry row
    reputationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        padding: SPACING.l,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: COLORS.platinumMuted,
        marginTop: SPACING.l,
        gap: SPACING.s,
    },
    reputationTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.text,
    },
    reputationSubtitle: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },

    // Proof Trail row
    proofTrailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        padding: SPACING.l,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: COLORS.border,
        marginTop: SPACING.l,
        gap: SPACING.s,
    },
    proofTrailLabel: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.text,
    },
    proofTrailSubtitle: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },

    // Section
    section: {
        marginTop: SPACING.l,
    },
    sectionTitle: {
        fontSize: 11,
        fontWeight: '600',
        letterSpacing: 2,
        textTransform: 'uppercase',
        color: '#9CA3AF',
        marginBottom: SPACING.m,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: SPACING.m,
    },

    // Hero Card (Section 1)
    inlineLoadState: {
        minHeight: 100,
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: COLORS.glassBorder,
        backgroundColor: COLORS.surface,
    },
    inlineLoadText: {
        color: COLORS.textSecondary,
        fontSize: 13,
    },
    inlineRetryText: {
        color: COLORS.primary,
        fontSize: 13,
        fontWeight: '600',
        marginTop: SPACING.s,
    },
    heroCard: {
        borderRadius: BORDER_RADIUS.l,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: COLORS.glassBorder,
        ...SHADOWS.glowCard,
    },
    heroCardGradient: {
        padding: SPACING.l,
    },
    heroLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.xs,
    },
    heroLabel: {
        fontSize: 13,
        fontWeight: '500',
        color: COLORS.textSecondary,
    },
    heroPVT: {
        fontSize: 42,
        fontWeight: '700',
        color: COLORS.text,
        letterSpacing: -1,
    },
    heroSubtitle: {
        fontSize: 13,
        color: COLORS.textSecondary,
        marginTop: SPACING.xs,
    },
    heroDescription: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: SPACING.m,
        lineHeight: 17,
        opacity: 0.8,
    },
    heroStatsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: SPACING.l,
        backgroundColor: 'rgba(0, 0, 0, 0.15)',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
    },
    attestationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginTop: SPACING.s,
        paddingHorizontal: SPACING.s,
    },
    heroStat: {
        flex: 1,
        alignItems: 'center',
    },
    heroStatValue: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
    },
    heroStatLabel: {
        fontSize: 11,
        color: COLORS.textSecondary,
        marginTop: SPACING.xs,
    },
    heroStatDivider: {
        width: 1,
        height: 30,
        backgroundColor: COLORS.border,
    },

    // Attestation badges
    attestationBadge: {
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
    },
    attestationBadgeSmall: {
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
    },
    attestationHW: {
        backgroundColor: `${COLORS.success}30`,
    },
    attestationSW: {
        backgroundColor: `${COLORS.primary}30`,
    },
    attestationText: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.success,
    },
    multiplierHint: {
        fontSize: 11,
        color: COLORS.success,
        marginTop: 2,
        fontWeight: '500',
        flexShrink: 1,
    },
    attestationTextSmall: {
        fontSize: 9,
        fontWeight: '700',
        color: COLORS.success,
    },

    // Breakdown (Section 2)
    breakdownCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },

    // Genesis ladder (#28)
    genesisCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    genesisSubtitle: {
        fontSize: 13,
        color: COLORS.textSecondary,
        marginBottom: SPACING.m,
    },
    genesisDivider: {
        height: 1,
        backgroundColor: 'rgba(200,205,214,0.08)',
        marginVertical: SPACING.m,
    },
    genesisEarnedValue: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
    },
    genesisEarnedLabel: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },
    segmentBar: {
        flexDirection: 'row',
        height: 8,
        borderRadius: 4,
        overflow: 'hidden',
        marginBottom: SPACING.m,
    },
    segmentBarItem: {
        height: '100%',
    },
    legendContainer: {
        gap: SPACING.s,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    legendDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: SPACING.s,
    },
    legendLabel: {
        fontSize: 13,
        color: COLORS.text,
        flex: 1,
    },
    legendCount: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginRight: SPACING.m,
    },
    legendPVT: {
        fontSize: 12,
        fontWeight: '600',
        color: COLORS.primary,
    },

    // History (Section 3)
    hiddenToggle: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: COLORS.surface,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    hiddenToggleActive: {
        backgroundColor: COLORS.primaryMuted,
        borderColor: COLORS.primary,
    },
    historyEmpty: {
        padding: SPACING.l,
        alignItems: 'center',
    },
    historyEmptyText: {
        fontSize: 14,
        color: COLORS.textSecondary,
    },
    historyItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    historyItemHidden: {
        opacity: 0.5,
    },
    historyIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: COLORS.backgroundAlt,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    historyIconText: {
        fontSize: 16,
    },
    historyContent: {
        flex: 1,
    },
    historyTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    historyAction: {
        fontSize: 13,
        fontWeight: '600',
        color: COLORS.text,
        flex: 1,
        marginRight: SPACING.s,
    },
    historyTimestamp: {
        fontSize: 11,
        color: COLORS.textSecondary,
    },
    historyBottomRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        flexWrap: 'wrap',
    },
    historyPVT: {
        fontSize: 12,
        fontWeight: '600',
        color: COLORS.success,
    },
    // disposition chip + commit-count badge
    commitCountBadge: {
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        backgroundColor: `${COLORS.primary}18`,
    },
    commitCountText: {
        fontSize: 10,
        fontWeight: '600',
        color: COLORS.primary,
    },
    historyHash: {
        fontSize: 10,
        fontFamily: 'monospace',
        color: COLORS.textTertiary,
    },
    historyPaymentMethod: {
        fontSize: 12,
        color: COLORS.textTertiary,
        marginBottom: 2,
    },
    loadMoreButton: {
        padding: SPACING.m,
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.border,
        marginTop: SPACING.s,
    },
    loadMoreText: {
        fontSize: 14,
        fontWeight: '500',
        color: COLORS.primary,
    },

    // Network Stats (Section 4)
    networkCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    networkGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    // Three stats in one row (the human/agent split lives under Active Wallets).
    networkStat: {
        width: '33.33%',
        padding: SPACING.s,
        alignItems: 'center',
    },
    networkStatValue: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
    },
    networkStatLabel: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },
    networkStatDetail: {
        fontSize: 10,
        color: COLORS.textTertiary,
        marginTop: 2,
    },

    // Leaderboard (Section 5)
    leaderboardToggle: {
        flexDirection: 'row',
        gap: SPACING.xs,
    },
    togglePill: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: COLORS.surface,
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    togglePillActive: {
        backgroundColor: COLORS.primaryMuted,
        borderColor: COLORS.primary,
    },
    togglePillText: {
        fontSize: 12,
        fontWeight: '500',
        color: COLORS.textSecondary,
    },
    togglePillTextActive: {
        color: COLORS.primary,
    },
    leaderboardNote: {
        fontSize: 12,
        color: COLORS.textTertiary,
        fontStyle: 'italic',
        marginBottom: SPACING.m,
    },
    leaderboardEmptyText: {
        fontSize: 13,
        color: COLORS.textTertiary,
        fontStyle: 'italic',
        textAlign: 'center',
        paddingVertical: SPACING.l,
        paddingHorizontal: SPACING.m,
    },
    leaderboardCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    leaderboardEntry: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: COLORS.border,
    },
    leaderboardEntryCurrent: {
        backgroundColor: `${COLORS.primary}10`,
        borderLeftWidth: 3,
        borderLeftColor: COLORS.primary,
    },
    leaderboardRank: {
        fontSize: 14,
        fontWeight: '700',
        color: COLORS.textSecondary,
        width: 36,
    },
    leaderboardTypeIcon: {
        marginRight: SPACING.s,
    },
    leaderboardAddress: {
        flex: 1,
        fontSize: 13,
        color: COLORS.text,
    },
    leaderboardPVT: {
        fontSize: 13,
        fontWeight: '600',
        color: COLORS.primary,
        marginLeft: SPACING.s,
    },
    userRankCard: {
        marginTop: SPACING.s,
        padding: SPACING.m,
        backgroundColor: COLORS.primaryMuted,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: COLORS.primary,
    },
    userRankText: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.primary,
    },


    // Phase Roadmap (Section 7)
    roadmapCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    roadmapItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: SPACING.m,
    },
    roadmapDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: '#1E2D3D',
        marginTop: 4,
        marginRight: SPACING.m,
    },
    roadmapDotActive: {
        backgroundColor: COLORS.success,
        shadowColor: COLORS.success,
        shadowOpacity: 0.5,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 0 },
    },
    roadmapDotUpcoming: {
        backgroundColor: COLORS.warning,
        shadowColor: COLORS.warning,
        shadowOpacity: 0.5,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 0 },
    },
    roadmapContent: {
        flex: 1,
    },
    roadmapPhase: {
        fontSize: 13,
        fontWeight: '600',
        color: COLORS.text,
    },
    roadmapDesc: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },
    roadmapLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.s,
        paddingTop: SPACING.s,
        borderTopWidth: 1,
        borderTopColor: COLORS.border,
    },
    roadmapLinkText: {
        fontSize: 13,
        fontWeight: '500',
        color: COLORS.primary,
    },

    // Empty State
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.xl,
    },
    emptyIcon: {
        fontSize: 64,
        marginBottom: SPACING.l,
    },
    emptyTitle: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.m,
    },
    emptySubtitle: {
        fontSize: 15,
        color: COLORS.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: SPACING.xl,
    },
    emptyCTA: {
        width: '100%',
        borderRadius: BORDER_RADIUS.m,
        overflow: 'hidden',
        marginBottom: SPACING.m,
    },
    emptyCTAGradient: {
        paddingVertical: SPACING.m,
        alignItems: 'center',
    },
    emptyCTAText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
    },
    emptyCTASecondary: {
        width: '100%',
        paddingVertical: SPACING.m,
        alignItems: 'center',
        backgroundColor: COLORS.glass,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.glassBorder,
    },
    emptyCTASecondaryText: {
        fontSize: 16,
        fontWeight: '500',
        color: COLORS.primary,
    },
});
