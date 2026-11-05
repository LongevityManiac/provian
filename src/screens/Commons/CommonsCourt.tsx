/**
 * CommonsCourt - Court interface for the Commons.
 *
 * Public docket with active disputes.
 * Arbitrator directory with eligibility stats.
 * Court statistics (verdicts, resolution rate, avg time).
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import * as CommonsService from '../../core/commons/CommonsService';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'docket' | 'arbitrators' | 'statistics';

interface CourtStats {
  total_disputes?: number;
  active_disputes?: number;
  resolved_disputes?: number;
  resolution_rate?: number;
  avg_resolution_hours?: number;
  total_verdicts?: number;
  total_arbitrators?: number;
  eligible_arbitrators?: number;
  total_value_disputed?: string;
  total_value_resolved?: string;
}

interface Arbitrator {
  wallet_id: string;
  display_name?: string;
  pe_count: number;
  cases_completed: number;
  majority_rate?: number;
  opted_in_at: number;
  status: string;
}

interface Dispute {
  escrow_id: string;
  status: string;
  depositor_wallet_id: string;
  recipient_wallet_id: string;
  amount?: string;
  currency?: string;
  panel_assigned: boolean;
  votes_cast: number;
  created_at: number;
  deadline?: number;
}

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: { key: Tab; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'docket', labelKey: 'commonsCourt.tabDocket', icon: 'document-text-outline' },
  { key: 'arbitrators', labelKey: 'commonsCourt.tabArbitrators', icon: 'people-outline' },
  { key: 'statistics', labelKey: 'commonsCourt.tabStats', icon: 'stats-chart-outline' },
];

const STATUS_COLORS: Record<string, string> = {
  pending_panel: COLORS.warning,
  voting: COLORS.primary,
  resolved: COLORS.success,
  escalated: COLORS.error,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(t: TFunction, timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return t('commonsCourt.justNow');
  if (hours < 24) return t('commonsCourt.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('commonsCourt.daysAgo', { count: days });
}

function formatHours(hours: number | undefined): string {
  if (hours == null) return '--';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsCourt({ navigation }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('docket');
  const [stats, setStats] = useState<CourtStats>({});
  const [arbitrators, setArbitrators] = useState<Arbitrator[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [statsResult, arbitratorsResult] = await Promise.all([
        CommonsService.getCourtStats(),
        CommonsService.getCourtArbitrators(),
      ]);
      setStats(statsResult as CourtStats);
      setArbitrators(arbitratorsResult.arbitrators as Arbitrator[]);
      // Disputes come from stats payload or a separate call
      if ((statsResult as Record<string, unknown>).disputes) {
        setDisputes((statsResult as Record<string, unknown>).disputes as Dispute[]);
      }
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsCourt] Load error:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData();
    }, [loadData]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  // ─── Docket Tab ─────────────────────────────────────────────────────────────

  const renderDocket = () => (
    <>
      {/* Summary Bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Ionicons name="flame" size={16} color={COLORS.warning} />
          <Text style={styles.summaryValue}>{stats.active_disputes ?? 0}</Text>
          <Text style={styles.summaryLabel}>{t('commonsCourt.active')}</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
          <Text style={styles.summaryValue}>{stats.resolved_disputes ?? 0}</Text>
          <Text style={styles.summaryLabel}>{t('commonsCourt.resolved')}</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Ionicons name="cash" size={16} color={COLORS.primary} />
          <Text style={styles.summaryValue}>{stats.total_value_disputed ?? '$0'}</Text>
          <Text style={styles.summaryLabel}>{t('commonsCourt.disputed')}</Text>
        </View>
      </View>

      {/* Dispute List */}
      {disputes.length === 0 && loadFailed ? (
        <LoadFailed onRetry={() => { void loadData(); }} />
      ) : disputes.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="shield-checkmark" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{t('commonsCourt.emptyDocketTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('commonsCourt.emptyDocketSubtitle')}</Text>
        </View>
      ) : (
        disputes.map(dispute => {
          const statusColor = STATUS_COLORS[dispute.status] ?? COLORS.textTertiary;
          return (
            <View key={dispute.escrow_id} style={styles.disputeCard}>
              <LinearGradient colors={GRADIENTS.card} style={StyleSheet.absoluteFill} />

              <View style={styles.disputeHeader}>
                <View style={styles.disputeId}>
                  <Ionicons name="document-text" size={16} color={COLORS.primary} />
                  <Text style={styles.disputeIdText}>
                    {t('commonsCourt.escrowId', { id: shortAddress(dispute.escrow_id) })}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: `${statusColor}20` }]}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {dispute.status.replace(/_/g, ' ')}
                  </Text>
                </View>
              </View>

              <View style={styles.partiesRow}>
                <View style={styles.party}>
                  <Text style={styles.partyLabel}>{t('commonsCourt.depositor')}</Text>
                  <Text style={styles.partyAddress}>{shortAddress(dispute.depositor_wallet_id)}</Text>
                </View>
                <Ionicons name="swap-horizontal" size={16} color={COLORS.textTertiary} />
                <View style={styles.party}>
                  <Text style={styles.partyLabel}>{t('commonsCourt.recipient')}</Text>
                  <Text style={styles.partyAddress}>{shortAddress(dispute.recipient_wallet_id)}</Text>
                </View>
              </View>

              {dispute.amount && (
                <View style={styles.amountRow}>
                  <Text style={styles.amountLabel}>{t('commonsCourt.amount')}</Text>
                  <Text style={styles.amountValue}>
                    {dispute.amount} {dispute.currency ?? 'USDC'}
                  </Text>
                </View>
              )}

              <View style={styles.disputeFooter}>
                <View style={styles.disputeMeta}>
                  <Ionicons name="people" size={12} color={COLORS.textTertiary} />
                  <Text style={styles.disputeMetaText}>
                    {dispute.panel_assigned ? t('commonsCourt.votesCast', { count: dispute.votes_cast }) : t('commonsCourt.panelPending')}
                  </Text>
                </View>
                <Text style={styles.disputeTime}>{timeAgo(t, dispute.created_at)}</Text>
              </View>
            </View>
          );
        })
      )}
    </>
  );

  // ─── Arbitrators Tab ────────────────────────────────────────────────────────

  const renderArbitrators = () => (
    <>
      <View style={styles.arbHeader}>
        <Text style={styles.arbCount}>
          {t('commonsCourt.eligibleOfTotal', { eligible: stats.eligible_arbitrators ?? 0, total: stats.total_arbitrators ?? 0 })}
        </Text>
      </View>

      {arbitrators.length === 0 && loadFailed ? (
        <LoadFailed onRetry={() => { void loadData(); }} />
      ) : arbitrators.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="person-add-outline" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{t('commonsCourt.emptyArbitratorsTitle')}</Text>
          <Text style={styles.emptySubtitle}>
            {t('commonsCourt.emptyArbitratorsSubtitle')}
          </Text>
        </View>
      ) : (
        arbitrators.map(arb => (
          <TouchableOpacity
            key={arb.wallet_id}
            style={styles.arbCard}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('CommonsProfile', { walletId: arb.wallet_id })}
          >
            <View style={styles.arbCardLeft}>
              <View style={styles.arbAvatar}>
                <Ionicons name="shield" size={20} color={COLORS.primary} />
              </View>
              <View style={styles.arbInfo}>
                <Text style={styles.arbName}>
                  {arb.display_name ?? shortAddress(arb.wallet_id)}
                </Text>
                <Text style={styles.arbMeta}>
                  {t('commonsCourt.arbMeta', { peCount: arb.pe_count })}
                </Text>
              </View>
            </View>
            <View style={styles.arbStats}>
              <Text style={styles.arbStatValue}>{arb.cases_completed}</Text>
              <Text style={styles.arbStatLabel}>{t('commonsCourt.cases')}</Text>
            </View>
            {arb.majority_rate != null && (
              <View style={styles.arbStats}>
                <Text style={[styles.arbStatValue, { color: COLORS.success }]}>
                  {Math.round(arb.majority_rate * 100)}%
                </Text>
                <Text style={styles.arbStatLabel}>{t('commonsCourt.majority')}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))
      )}
    </>
  );

  // ─── Statistics Tab ─────────────────────────────────────────────────────────

  const renderStatistics = () => (
    <>
      <View style={styles.statsGrid}>
        {[
          { icon: 'document-text' as const, label: t('commonsCourt.totalDisputes'), value: stats.total_disputes ?? 0, color: COLORS.primary },
          { icon: 'checkmark-done' as const, label: t('commonsCourt.resolved'), value: stats.resolved_disputes ?? 0, color: COLORS.success },
          { icon: 'timer' as const, label: t('commonsCourt.avgResolution'), value: formatHours(stats.avg_resolution_hours), color: COLORS.warning },
          { icon: 'hand-right' as const, label: t('commonsCourt.totalVerdicts'), value: stats.total_verdicts ?? 0, color: COLORS.purple },
          { icon: 'trending-up' as const, label: t('commonsCourt.resolutionRate'), value: stats.resolution_rate != null ? `${Math.round(stats.resolution_rate * 100)}%` : '--', color: COLORS.success },
          { icon: 'cash' as const, label: t('commonsCourt.valueResolved'), value: stats.total_value_resolved ?? '$0', color: COLORS.primary },
        ].map((stat, i) => (
          <View key={i} style={styles.statCard}>
            <Ionicons name={stat.icon} size={22} color={stat.color} />
            <Text style={styles.statValue}>{String(stat.value)}</Text>
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
        ))}
      </View>

      {/* How Court Works */}
      <Text style={styles.sectionTitle}>{t('commonsCourt.howCourtWorks')}</Text>
      <View style={styles.infoCard}>
        {[
          { step: '1', title: t('commonsCourt.step1Title'), desc: t('commonsCourt.step1Desc') },
          { step: '2', title: t('commonsCourt.step2Title'), desc: t('commonsCourt.step2Desc') },
          { step: '3', title: t('commonsCourt.step3Title'), desc: t('commonsCourt.step3Desc') },
          { step: '4', title: t('commonsCourt.step4Title'), desc: t('commonsCourt.step4Desc') },
        ].map((item, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepNumber}>{item.step}</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepTitle}>{item.title}</Text>
              <Text style={styles.stepDesc}>{item.desc}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Eligibility */}
      <Text style={styles.sectionTitle}>{t('commonsCourt.arbitratorEligibility')}</Text>
      <View style={styles.infoCard}>
        {[
          { icon: 'checkmark-circle' as const, req: t('commonsCourt.reqCompletedEscrows') },
          { icon: 'shield-checkmark' as const, req: t('commonsCourt.reqCleanStanding') },
          { icon: 'lock-closed' as const, req: t('commonsCourt.reqActiveBond') },
        ].map((item, i) => (
          <View key={i} style={styles.reqRow}>
            <Ionicons name={item.icon} size={16} color={COLORS.primary} />
            <Text style={styles.reqText}>{item.req}</Text>
          </View>
        ))}
      </View>
    </>
  );

  // ─── Main Render ────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={GRADIENTS.backgroundDiagonal}
        style={StyleSheet.absoluteFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />

      {/* Hero Image */}
      <View style={{ height: 180, overflow: 'hidden' }}>
        <Image
          source={require('../../../assets/images/court-hero.png')}
          style={{ width: '100%', height: '100%', position: 'absolute' }}
          resizeMode="cover"
        />
        <LinearGradient
          colors={['transparent', COLORS.background]}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 60 }}
        />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <Text style={styles.headerTitle}>{t('commonsCourt.headerTitle')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Ionicons
              name={tab.icon}
              size={16}
              color={activeTab === tab.key ? COLORS.primary : COLORS.textSecondary}
            />
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {t(tab.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          <View style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            backgroundColor: 'rgba(74, 142, 232, 0.06)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: 'rgba(74, 142, 232, 0.12)',
          }}>
            <Ionicons name="eye-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
            <Text style={{ color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 }}>
              {t('commonsCourt.observeBanner')}
            </Text>
          </View>
          {activeTab === 'docket' && renderDocket()}
          {activeTab === 'arbitrators' && renderArbitrators()}
          {activeTab === 'statistics' && renderStatistics()}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m, flex: 1 },
  headerSpacer: { width: 44 },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.m,
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.s + 2,
    gap: 4,
    borderRadius: BORDER_RADIUS.s,
  },
  tabActive: { backgroundColor: 'rgba(59, 130, 246, 0.15)' },
  tabText: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '500' },
  tabTextActive: { color: COLORS.primary, fontWeight: '600' },

  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: SPACING.m,
    marginTop: SPACING.l,
  },

  // Summary Bar
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.glass,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.l,
  },
  summaryItem: { flex: 1, alignItems: 'center', gap: 2 },
  summaryValue: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  summaryLabel: { fontSize: 10, color: COLORS.textTertiary },
  summaryDivider: { width: 1, backgroundColor: COLORS.border },

  // Dispute Card
  disputeCard: {
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    ...SHADOWS.card,
  },
  disputeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.m,
  },
  disputeId: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  disputeIdText: { fontSize: 13, fontWeight: '600', color: COLORS.text, fontFamily: 'monospace' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BORDER_RADIUS.s,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: '500', textTransform: 'capitalize' },

  partiesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.s,
  },
  party: { alignItems: 'center' },
  partyLabel: { fontSize: 10, color: COLORS.textTertiary },
  partyAddress: { fontSize: 12, color: COLORS.textSecondary, fontFamily: 'monospace', marginTop: 2 },

  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginBottom: SPACING.s,
  },
  amountLabel: { fontSize: 12, color: COLORS.textSecondary },
  amountValue: { fontSize: 14, fontWeight: '700', color: COLORS.text },

  disputeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  disputeMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  disputeMetaText: { fontSize: 11, color: COLORS.textTertiary },
  disputeTime: { fontSize: 11, color: COLORS.textTertiary },

  // Arbitrators
  arbHeader: {
    marginBottom: SPACING.m,
  },
  arbCount: { fontSize: 13, color: COLORS.textSecondary },
  arbCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.glass,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  arbCardLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: SPACING.m },
  arbAvatar: {
    width: 40,
    height: 40,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: COLORS.iconBackground,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arbInfo: { flex: 1 },
  arbName: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  arbMeta: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2 },
  arbStats: { alignItems: 'center', marginLeft: SPACING.m },
  arbStatValue: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  arbStatLabel: { fontSize: 10, color: COLORS.textTertiary },

  // Statistics
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.s,
  },
  statCard: {
    width: '48%' as unknown as number,
    backgroundColor: COLORS.glass,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexGrow: 1,
    flexBasis: '45%',
  },
  statValue: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  statLabel: { fontSize: 11, color: COLORS.textTertiary, textAlign: 'center' },

  // Info Cards
  infoCard: {
    backgroundColor: COLORS.glass,
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.m,
    marginBottom: SPACING.m,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumber: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  stepContent: { flex: 1 },
  stepTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  stepDesc: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2, lineHeight: 18 },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginBottom: SPACING.s,
  },
  reqText: { fontSize: 13, color: COLORS.textSecondary },

  // Empty
  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xxxl,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: SPACING.xs, textAlign: 'center' },
});
