/**
 * CommonsMarket - the Market : the Commons hiring board, filtered by default to the jobs that
 * hire AGENTS (people and agents hiring agents), with a toggle to jobs that hire people or all jobs.
 *
 * Featured placements come first, with their rank. The counts come from GET /v1/commons/market/stats.
 * Every job opens the job screen, where a person acts on it (apply, or — as its poster — feature,
 * hire, fund, release, dispute). A person can post from here to hire an agent (or a person).
 *
 * Reached from the "Agent market" card at the top of Commons › Work.
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { HumanJob, FeaturedSlot, MarketStats } from '../../core/commons/CommonsService';
import { featuredFirst, featuredRankOf } from '../../core/commons/jobBoard';
import JobCard from '../../components/commons/JobCard';
import { useJobApply } from './useJobApply';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

type SeekingView = 'agent' | 'human' | 'all';
type CurrencyView = 'all' | 'pvt' | 'usdc';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

const MARKET_ACCENT = '#6BA3F0';

export default function CommonsMarket({ navigation }: Props) {
  const { t } = useTranslation();
  const profile = useCommonsStore((s) => s.profile);
  const [seeking, setSeeking] = useState<SeekingView>('agent');
  const [currency, setCurrency] = useState<CurrencyView>('all');
  const [jobs, setJobs] = useState<HumanJob[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [featured, setFeatured] = useState<FeaturedSlot[]>([]);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [board, s] = await Promise.all([
      CommonsService.getMarketJobs({ seeking, ...(currency !== 'all' ? { currency } : {}), page_size: 50 }).catch((err) => {
        console.log('[CommonsMarket] jobs load error:', err);
        return null;
      }),
      CommonsService.getMarketStats().catch(() => null),
    ]);
    setJobs(board ? board.jobs : (prev) => prev ?? []);
    setLoadFailed(!board);
    if (board) setFeatured(board.featured);
    if (s) setStats(s);
  }, [seeking, currency]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const { applyingJobId, startApply, appliedJobIds } = useJobApply({ myWalletId: profile?.wallet_id, navigation, t, onApplied: () => { void load(); } });

  const openJob = (job: HumanJob) => navigation.navigate('CommonsHumanJobManage', { jobId: job.job_id });

  const viewer = { walletId: profile?.wallet_id, kind: profile?.participant_type ?? null, appliedJobIds };
  const ordered = jobs ? featuredFirst(jobs, featured) : null;

  const statTiles: { key: string; label: string; value: string }[] = stats ? [
    { key: 'open', label: t('commonsMarket.statOpen'), value: String(stats.open_jobs) },
    { key: 'progress', label: t('commonsMarket.statInProgress'), value: String(stats.in_progress_jobs) },
    { key: 'done', label: t('commonsMarket.statCompleted'), value: String(stats.completed_jobs) },
    { key: 'disputes', label: t('commonsMarket.statDisputeRate'), value: `${Math.round((stats.dispute_rate ?? 0) * 100)}%` },
  ] : [];

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />

      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIconBg}>
            <Ionicons name="briefcase" size={16} color={MARKET_ACCENT} />
          </View>
          <Text style={styles.headerTitle}>{t('commonsMarket.headerTitle')}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lede}>{t('commonsMarket.lede')}</Text>

        {/* Stats (GET /v1/commons/market/stats) */}
        {stats && (
          <>
            <View style={styles.statsRow}>
              {statTiles.map((s) => (
                <View key={s.key} style={styles.statCard}>
                  <Text style={styles.statValue}>{s.value}</Text>
                  <Text style={styles.statLabel}>{s.label}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.statsLine}>
              {t('commonsMarket.openByDirection', {
                peopleAgents: stats.open_by_direction.human_seeking_agent ?? 0,
                agentsAgents: stats.open_by_direction.agent_seeking_agent ?? 0,
                agentsPeople: stats.open_by_direction.agent_seeking_human ?? 0,
                peoplePeople: stats.open_by_direction.human_seeking_human ?? 0,
              })}
            </Text>
            <Text style={styles.statsLine}>
              {t('commonsMarket.openByCurrency', { pvt: stats.open_by_currency.pvt ?? 0, usdc: stats.open_by_currency.usdc ?? 0 })}
            </Text>
          </>
        )}

        {/* Who the jobs hire: agents (default) · people · all */}
        <View style={styles.segment}>
          {(['agent', 'human', 'all'] as const).map((v) => (
            <TouchableOpacity
              key={v}
              style={[styles.segmentOption, seeking === v && styles.segmentOptionActive]}
              onPress={() => setSeeking(v)}
              accessibilityRole="tab"
              accessibilityState={{ selected: seeking === v }}
            >
              <Text style={[styles.segmentText, seeking === v && styles.segmentTextActive]}>
                {v === 'agent' ? t('commonsMarket.viewHiresAgents') : v === 'human' ? t('commonsMarket.viewHiresPeople') : t('commonsMarket.viewAll')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.chipRow}>
          {(['all', 'pvt', 'usdc'] as const).map((v) => (
            <TouchableOpacity
              key={v}
              style={[styles.chip, currency === v && styles.chipActive]}
              onPress={() => setCurrency(v)}
              accessibilityRole="button"
              accessibilityState={{ selected: currency === v }}
            >
              <Text style={[styles.chipText, currency === v && styles.chipTextActive]}>
                {v === 'all' ? t('commonsJobs.filterAny') : v.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {ordered === null ? (
          <View style={styles.loading}><ActivityIndicator size="large" color={MARKET_ACCENT} /></View>
        ) : ordered.length === 0 && loadFailed ? (
          <LoadFailed onRetry={() => { void load(); }} />
        ) : ordered.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="briefcase-outline" size={44} color={COLORS.textTertiary} />
            <Text style={styles.emptyTitle}>{t('commonsMarket.emptyOpenTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('commonsMarket.emptyOpenSubtitle')}</Text>
          </View>
        ) : (
          ordered.map((job) => (
            <JobCard
              key={job.job_id}
              job={job}
              featuredRank={featuredRankOf(job.job_id, featured)}
              viewer={viewer}
              onOpen={openJob}
              onApply={startApply}
              applying={applyingJobId === job.job_id}
            />
          ))
        )}
      </ScrollView>

      {/* A person posts from the Market — to hire an agent by default, or a person from the People view. */}
      {profile?.participant_type === 'human' && (
        <TouchableOpacity
          style={styles.fab}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('CommonsHumanJobsPost', { seeking: seeking === 'human' ? 'human' : 'agent' })}
          accessibilityRole="button"
          accessibilityLabel={seeking === 'human' ? t('commonsMarket.postHirePerson') : t('commonsMarket.postHireAgent')}
        >
          <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
          <Ionicons name="add" size={22} color={COLORS.text} />
          <Text style={styles.fabText}>{seeking === 'human' ? t('commonsMarket.postHirePerson') : t('commonsMarket.postHireAgent')}</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginLeft: SPACING.m, flex: 1 },
  headerIconBg: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(107,163,240,0.16)',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  scroll: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl + 60 },
  lede: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: SPACING.m },
  statsRow: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.s },
  statCard: {
    flex: 1, alignItems: 'center', paddingVertical: SPACING.m, borderRadius: BORDER_RADIUS.l,
    backgroundColor: 'rgba(18,21,26,0.70)', borderWidth: 1, borderColor: COLORS.border,
  },
  statValue: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  statLabel: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2, textAlign: 'center' },
  statsLine: { color: COLORS.textTertiary, fontSize: 12, lineHeight: 17, marginBottom: SPACING.xs },
  segment: {
    flexDirection: 'row', marginTop: SPACING.m, marginBottom: SPACING.s,
    backgroundColor: 'rgba(18,21,26,0.70)', borderRadius: BORDER_RADIUS.m, padding: 3, borderWidth: 1, borderColor: COLORS.border,
  },
  segmentOption: { flex: 1, paddingVertical: SPACING.s + 2, alignItems: 'center', borderRadius: BORDER_RADIUS.s },
  segmentOptionActive: { backgroundColor: 'rgba(107,163,240,0.16)' },
  segmentText: { fontSize: 13, color: COLORS.textSecondary, fontWeight: '500' },
  segmentTextActive: { color: MARKET_ACCENT, fontWeight: '700' },
  chipRow: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.m },
  chip: {
    paddingHorizontal: SPACING.m, paddingVertical: SPACING.xs + 2, borderRadius: BORDER_RADIUS.round,
    backgroundColor: 'rgba(18,21,26,0.70)', borderWidth: 1, borderColor: COLORS.border,
  },
  chipActive: { borderColor: MARKET_ACCENT, backgroundColor: 'rgba(107,163,240,0.16)' },
  chipText: { fontSize: 12, color: COLORS.textSecondary },
  chipTextActive: { color: COLORS.text, fontWeight: '600' },
  loading: { paddingVertical: SPACING.xxxl, alignItems: 'center' },
  empty: { alignItems: 'center', paddingVertical: SPACING.xxxl },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: SPACING.xs, textAlign: 'center' },
  fab: {
    position: 'absolute', bottom: SPACING.xl, right: SPACING.l, height: 52, paddingHorizontal: SPACING.m + 2,
    borderRadius: 26, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  fabText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
});
