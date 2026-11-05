/**
 * CommonsHumanJobs - the Commons hiring board (ONE board, all four directions — people and
 * agents hiring people and agents).
 *
 * Tabs: Available | Mine | Completed. Filters on Available: who's hiring (people / agents), who it
 * hires (people / agents), and the currency (PVT / USDC). Featured placements come first, with
 * their rank. Every card opens the job screen; Apply shows only on jobs that hire people, and a
 * card that cannot be applied to says why. "Post a job" is always reachable for a person.
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { HumanJob, FeaturedSlot } from '../../core/commons/CommonsService';
import { featuredFirst, featuredRankOf } from '../../core/commons/jobBoard';
import JobCard from '../../components/commons/JobCard';
import { useJobApply } from './useJobApply';
import { InlinePostButton } from '../../components/commons/InlinePostButton';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'available' | 'mine' | 'completed';

/** filters: who posted (who's hiring), who the job hires, and the currency. 'all' = no filter. */
type PartyFilter = 'all' | 'human' | 'agent';
type CurrencyFilter = 'all' | 'pvt' | 'usdc';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  /** rendered inside the Commons › Work tab — no own header/background; clears the tab bar. */
  embedded?: boolean;
  /**
   * the Work tab's cards + Jobs/Requests switch. Embedded, the board's tabs and filters
   * scroll WITH the list under this header: as fixed chrome above the list they left it a sliver
   * behind the floating tab bar, so the first job card was unreachable on a phone.
   */
  header?: React.ReactNode;
}

/** the floating tab bar's height plus breathing room (see Commons tabs/layout.ts). */
const EMBEDDED_BOTTOM_CLEARANCE = 120;

// ─── Constants ────────────────────────────────────────────────────────────────

const JOBS_ACCENT = '#E8A838';

const TABS: { key: Tab; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'available', labelKey: 'commonsHumanJobs.tabAvailable', icon: 'briefcase' },
  // "Mine": jobs the signed-in wallet posted OR is assigned to (C7 — scoped to the caller via
  // /jobs/mine, not a global browse).
  { key: 'mine', labelKey: 'commonsHumanJobs.tabMine', icon: 'document-text' },
  { key: 'completed', labelKey: 'commonsHumanJobs.tabCompleted', icon: 'checkmark-done' },
];

// Compensation formatting (incl. C8 budget_pvt, budget_usdc) is formatHumanJobCompensation in
// core/commons/humanJobFormat, used by JobCard so the board, the Market and the job screen agree.

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsHumanJobs({ navigation, embedded = false, header }: Props) {
  const { t } = useTranslation();
  const profile = useCommonsStore(s => s.profile);

  const [activeTab, setActiveTab] = useState<Tab>('available');
  const [hiringFilter, setHiringFilter] = useState<PartyFilter>('all');
  const [hiresFilter, setHiresFilter] = useState<PartyFilter>('all');
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('all');
  const [jobs, setJobs] = useState<HumanJob[]>([]);
  const [featured, setFeatured] = useState<FeaturedSlot[]>([]);
  const [myJobs, setMyJobs] = useState<HumanJob[]>([]);
  const [completed, setCompleted] = useState<HumanJob[]>([]);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<{ total_open?: number; total_completed?: number }>({});

  const loadData = useCallback(async () => {
    try {
      const params: Parameters<typeof CommonsService.browseHumanJobs>[0] = {
        status: 'open',
        page_size: 50,
        ...(hiringFilter !== 'all' ? { posted_by: hiringFilter } : {}),
        ...(hiresFilter !== 'all' ? { seeking: hiresFilter } : {}),
        ...(currencyFilter !== 'all' ? { currency: currencyFilter } : {}),
      };
      if (selectedCategory) {
        params.category = selectedCategory;
      }

      const [jobsResult, categoriesResult, statsResult] = await Promise.all([
        CommonsService.browseHumanJobs(params),
        CommonsService.getJobCategories(),
        CommonsService.getHumanJobStats(),
      ]);

      setJobs(jobsResult.jobs);
      setFeatured(jobsResult.featured);
      setCategories(categoriesResult.categories);
      setStats(statsResult);

      // C7: "Mine" / "Completed" are the CALLER's jobs — posted + assigned — from the
      // authenticated, server-scoped /jobs/mine, NOT a global browse-by-status.
      if (profile?.wallet_id) {
        const mine = await CommonsService.getMyHumanJobs();
        const all = [...mine.posted, ...mine.assigned];
        setMyJobs(all.filter((j) => j.status !== 'completed'));
        setCompleted(all.filter((j) => j.status === 'completed'));
      } else {
        setMyJobs([]);
        setCompleted([]);
      }
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsHumanJobs] Load error:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, profile?.wallet_id, hiringFilter, hiresFilter, currencyFilter]);

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

  // applying is shared with the Market and the job screen (useJobApply).
  const { applyingJobId, startApply, appliedJobIds } = useJobApply({ myWalletId: profile?.wallet_id, navigation, t, onApplied: () => { void loadData(); } });

  // every card opens the job screen. A party (poster / hired) manages the job there; anyone
  // else reads it, applies (jobs that hire people), or sees why they cannot.
  const openJob = (job: HumanJob) => {
    navigation.navigate('CommonsHumanJobManage', { jobId: job.job_id });
  };

  const getActiveJobs = (): HumanJob[] => {
    switch (activeTab) {
      case 'available':
        return featuredFirst(jobs, featured);
      case 'mine':
        return myJobs;
      case 'completed':
        return completed;
      default:
        return jobs;
    }
  };

  const myWallet = profile?.wallet_id;
  const viewer = { walletId: myWallet, kind: profile?.participant_type ?? null, appliedJobIds };
  // A job the user is a party to shows "Manage" on its card (JobCard); every card opens the job screen.
  const renderJobCard = (job: HumanJob) => (
    <JobCard
      key={job.job_id}
      job={job}
      featuredRank={activeTab === 'available' ? featuredRankOf(job.job_id, featured) : null}
      viewer={viewer}
      onOpen={openJob}
      onApply={startApply}
      applying={applyingJobId === job.job_id}
    />
  );

  const filterGroup = <V extends string>(
    label: string,
    value: V,
    options: { v: V; label: string }[],
    onSelect: (v: V) => void,
  ) => (
    <View style={styles.filterGroup}>
      <Text style={styles.filterLabel}>{label}</Text>
      {options.map((o) => (
        <TouchableOpacity
          key={o.v}
          style={[styles.catChip, value === o.v && styles.catChipActive]}
          onPress={() => onSelect(o.v)}
          accessibilityRole="button"
          accessibilityState={{ selected: value === o.v }}
        >
          <Text style={[styles.catChipText, value === o.v && styles.catChipTextActive]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  // Tabs + filters: fixed above the list standalone, scrolled with it when embedded.
  const controls = (
    <>
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
              color={activeTab === tab.key ? JOBS_ACCENT : '#8B929E'}
            />
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {t(tab.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* filters: who's hiring · who it hires · currency */}
      {activeTab === 'available' && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoriesScroll}
          contentContainerStyle={styles.categoriesContent}
        >
          {filterGroup(t('commonsJobs.filterHiring'), hiringFilter, [
            { v: 'all', label: t('commonsJobs.filterAnyone') },
            { v: 'human', label: t('commonsJobs.filterPeople') },
            { v: 'agent', label: t('commonsJobs.filterAgents') },
          ], setHiringFilter)}
          {filterGroup(t('commonsJobs.filterHires'), hiresFilter, [
            { v: 'all', label: t('commonsJobs.filterAnyone') },
            { v: 'human', label: t('commonsJobs.filterPeople') },
            { v: 'agent', label: t('commonsJobs.filterAgents') },
          ], setHiresFilter)}
          {filterGroup(t('commonsJobs.filterPay'), currencyFilter, [
            { v: 'all', label: t('commonsJobs.filterAny') },
            { v: 'pvt', label: 'PVT' },
            { v: 'usdc', label: 'USDC' },
          ], setCurrencyFilter)}
        </ScrollView>
      )}

      {/* Category Filters */}
      {activeTab === 'available' && categories.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoriesScroll}
          contentContainerStyle={styles.categoriesContent}
        >
          <TouchableOpacity
            style={[styles.catChip, !selectedCategory && styles.catChipActive]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.catChipText, !selectedCategory && styles.catChipTextActive]}>{t('commonsHumanJobs.allCategories')}</Text>
          </TouchableOpacity>
          {categories.map(cat => (
            <TouchableOpacity
              key={cat.category}
              style={[styles.catChip, selectedCategory === cat.category && styles.catChipActive]}
              onPress={() => setSelectedCategory(selectedCategory === cat.category ? null : cat.category)}
            >
              <Text
                style={[styles.catChipText, selectedCategory === cat.category && styles.catChipTextActive]}
              >
                {cat.category.replace(/_/g, ' ')} ({cat.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </>
  );

  const listBody = (
    <>
      <View style={styles.banner}>
        <Ionicons name="eye-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
        <Text style={styles.bannerText}>{t('commonsJobs.boardBanner')}</Text>
      </View>
      {getActiveJobs().length === 0 && loadFailed ? (
        <LoadFailed onRetry={() => { void loadData(); }} />
      ) : getActiveJobs().length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="briefcase" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>
            {activeTab === 'available' ? t('commonsHumanJobs.emptyAvailableTitle') :
             activeTab === 'mine' ? t('commonsHumanJobs.emptyMineTitle') :
             t('commonsHumanJobs.emptyCompletedTitle')}
          </Text>
          <Text style={styles.emptySubtitle}>
            {activeTab === 'available'
              ? t('commonsHumanJobs.emptyAvailableSubtitle')
              : t('commonsHumanJobs.emptyDefaultSubtitle')}
          </Text>
        </View>
      ) : (
        getActiveJobs().map(renderJobCard)
      )}
    </>
  );

  const Frame = embedded ? View : SafeAreaView;
  return (
    <Frame style={embedded ? styles.embeddedContainer : styles.container}>
      {!embedded && (
      <LinearGradient
        colors={GRADIENTS.backgroundDiagonal}
        style={StyleSheet.absoluteFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      )}

      {/* Header (the Commons › Work tab supplies its own) */}
      {!embedded && (
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIconBg}>
            <Ionicons name="briefcase" size={16} color={JOBS_ACCENT} />
          </View>
          <Text style={styles.headerTitle}>{t('commonsHumanJobs.headerTitle')}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.statsText}>
            {t('commonsHumanJobs.openCount', { count: stats.total_open ?? 0 })}
          </Text>
        </View>
      </View>
      )}

      {!embedded && controls}

      {/* Job List */}
      {embedded ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: EMBEDDED_BOTTOM_CLEARANCE + SPACING.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {header}
          {controls}
          <View style={styles.embeddedList}>
            {/* Inside the Commons tabs "Post a job" sits in the list, never floating over it. */}
            {profile?.participant_type === 'human' && (
              <InlinePostButton label={t('commonsHome.postJob')} onPress={() => navigation.navigate('CommonsHumanJobsPost')} testID="commons-post-job" />
            )}
            {loading ? (
              <ActivityIndicator style={styles.embeddedLoading} size="large" color={JOBS_ACCENT} />
            ) : listBody}
          </View>
        </ScrollView>
      ) : loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={JOBS_ACCENT} />
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {listBody}
        </ScrollView>
      )}

      {/* FAB - a person posts a job and chooses who it hires (a person or an agent) and the
          currency (PVT or USDC). CommonsHumanJobsPost runs the submit behind requireBiometric (the
          post generates a PE) and handles the talking pass (428). Agents post through their own
          API key (POST /v1/commons/jobs/post). */}
      {profile?.participant_type === 'human' && !embedded && (
        <TouchableOpacity
          style={styles.fab}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('CommonsHumanJobsPost')}
          accessibilityRole="button"
          accessibilityLabel={t('commonsHome.postJob')}
        >
          <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
          <Ionicons name="add" size={22} color={COLORS.text} />
          <Text style={styles.fabText}>{t('commonsHome.postJob')}</Text>
        </TouchableOpacity>
      )}
    </Frame>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  embeddedContainer: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  embeddedList: { paddingHorizontal: SPACING.l },
  embeddedLoading: { paddingVertical: SPACING.xxxl },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginLeft: SPACING.m, flex: 1 },
  headerIconBg: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 179, 0, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  headerRight: { alignItems: 'flex-end' },
  statsText: { fontSize: 12, color: '#8B929E' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: SPACING.l,
    marginBottom: SPACING.m,
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 14,
    padding: SPACING.xs,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
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
  tabActive: {
    backgroundColor: 'rgba(255, 179, 0, 0.15)',
  },
  tabText: { fontSize: 12, color: '#8B929E', fontWeight: '500' },
  tabTextActive: { color: '#E8A838', fontWeight: '600' },

  // Category Chips
  categoriesScroll: { maxHeight: 44, marginBottom: SPACING.s },
  categoriesContent: { paddingHorizontal: SPACING.l, gap: SPACING.s },
  catChip: {
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.xs + 2,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
  },
  catChipActive: {
    borderColor: '#E8A838',
    backgroundColor: 'rgba(255, 179, 0, 0.15)',
  },
  catChipText: { fontSize: 12, color: '#8B929E', textTransform: 'capitalize' },
  catChipTextActive: { color: COLORS.text, fontWeight: '600' },
  filterGroup: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginRight: SPACING.m },
  filterLabel: { fontSize: 12, color: COLORS.textTertiary, fontWeight: '600', marginRight: 2 },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(74, 142, 232, 0.06)',
    borderRadius: BORDER_RADIUS.m,
    padding: 14,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(74, 142, 232, 0.12)',
  },
  bannerText: { color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 },

  fabText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },

  // FAB
  fab: {
    position: 'absolute',
    bottom: SPACING.xl,
    right: SPACING.l,
    height: 52,
    paddingHorizontal: SPACING.m + 2,
    borderRadius: 26,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#4A8EE8',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  // Empty
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxxl,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 14, color: '#8B929E', marginTop: SPACING.xs, textAlign: 'center' },
});
