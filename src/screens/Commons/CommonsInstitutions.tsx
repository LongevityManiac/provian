/**
 * CommonsInstitutions — the Escrow screen (Commons › Work › Escrow).
 *
 * renders exactly what `GET /v1/commons/institutions/stats` serves (core/commons/feed.ts
 * getInstitutionsStats) — escrow volume and counts, promise and pool counts, and the live PVT supply
 * read — and nothing the endpoint does not return (the old mint-rate / holders / completion-rate
 * / funded / default-rate tiles read fields that never existed, so they could only ever show "--").
 * Escrows with a test or display-hidden fixture agent are excluded relay-side.
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
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The exact response of GET /v1/commons/institutions/stats. */
interface InstitutionsStats {
  total_escrow_value_usd?: number;
  active_escrows?: number;
  completed_escrows?: number;
  promises_outstanding?: number;
  promises_settled?: number;
  active_pools?: number;
  /** Live kernel reads; null when the chain read failed (rendered "--", never a fabrication). */
  pvt_circulating_supply?: number | null;
  pvt_total_minted?: number | null;
  pvt_total_burned?: number | null;
}

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PVT_PURPLE = '#6BA3F0';
const PVT_GRADIENT: readonly [string, string] = ['rgba(124, 58, 237, 0.15)', 'rgba(124, 58, 237, 0.05)'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLargeNumber(val: string | number | null | undefined): string {
  if (val == null) return '--';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '--';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(2);
}

function formatUSD(val: string | number | null | undefined): string {
  if (val == null) return '$--';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return '$--';
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsInstitutions({ navigation }: Props) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<InstitutionsStats>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const result = await CommonsService.getInstitutionsStats();
      setStats(result as InstitutionsStats);
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsInstitutions] Load error:', err);
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

  // a failed first load shows the failure, never a page of placeholder dashes
  const statsFailed = loadFailed && Object.keys(stats).length === 0;

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={PVT_PURPLE} />
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

      {/* Hero Image */}
      <View style={{ height: 180, overflow: 'hidden' }}>
        <Image
          source={require('../../../assets/images/escrow-hero.png')}
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
        <Text style={styles.headerTitle}>{t('commonsDashboard.institutionEscrow')}</Text>
        <View style={styles.headerSpacer} />
      </View>

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
            {t('commonsInstitutions.observeBannerEscrow')}
          </Text>
        </View>
        {statsFailed ? (
          <LoadFailed onRetry={() => { void loadData(); }} />
        ) : (
          <>
            {/* ─── Escrow ────────────────────────────────────────────────── */}
            <Text style={styles.sectionTitle}>
              <Ionicons name="shield-checkmark" size={18} color={COLORS.primary} /> {t('commonsInstitutions.sectionEscrow')}
            </Text>
            <View style={styles.dashboardCard}>
              <LinearGradient colors={GRADIENTS.cardBlue} style={StyleSheet.absoluteFill} />
              <View style={styles.dashRow}>
                <View style={styles.dashStat}>
                  <Text style={styles.dashValue}>{stats.active_escrows ?? '--'}</Text>
                  <Text style={styles.dashLabel}>{t('commonsInstitutions.active')}</Text>
                </View>
                <View style={styles.dashStat}>
                  <Text style={styles.dashValue}>{stats.completed_escrows ?? '--'}</Text>
                  <Text style={styles.dashLabel}>{t('commonsInstitutions.completed')}</Text>
                </View>
              </View>
              <View style={styles.volumeRow}>
                <Text style={styles.volumeLabel}>{t('commonsInstitutions.totalVolume')}</Text>
                <Text style={styles.volumeValue}>{formatUSD(stats.total_escrow_value_usd)}</Text>
              </View>
            </View>

            {/* ─── Promises + Pools ──────────────────────────────────────── */}
            <Text style={styles.sectionTitle}>
              <Ionicons name="heart" size={18} color={COLORS.accent} /> {t('commonsInstitutions.sectionPromises')}
            </Text>
            <View style={styles.dashboardCard}>
              <LinearGradient colors={['rgba(244, 63, 94, 0.12)', 'rgba(244, 63, 94, 0.04)']} style={StyleSheet.absoluteFill} />
              <View style={styles.dashRow}>
                <View style={styles.dashStat}>
                  <Text style={styles.dashValue}>{stats.promises_outstanding ?? '--'}</Text>
                  <Text style={styles.dashLabel}>{t('commonsInstitutions.openPromises')}</Text>
                </View>
                <View style={styles.dashStat}>
                  <Text style={styles.dashValue}>{stats.promises_settled ?? '--'}</Text>
                  <Text style={styles.dashLabel}>{t('commonsInstitutions.completed')}</Text>
                </View>
              </View>
              <View style={styles.volumeRow}>
                <Text style={styles.volumeLabel}>{t('commonsInstitutions.activePools')}</Text>
                <Text style={styles.volumeValue}>{stats.active_pools ?? '--'}</Text>
              </View>
            </View>

            {/* ─── PVT supply (live kernel read) ─────────────────────────── */}
            <Text style={styles.sectionTitle}>
              <Ionicons name="diamond" size={18} color={PVT_PURPLE} /> {t('commonsInstitutions.sectionPvtToken')}
            </Text>
            <View style={styles.heroCard}>
              <LinearGradient colors={PVT_GRADIENT} style={StyleSheet.absoluteFill} />
              <View style={styles.heroRow}>
                <View style={styles.heroStat}>
                  <Text style={[styles.heroValue, { color: PVT_PURPLE }]} numberOfLines={1} adjustsFontSizeToFit>
                    {formatLargeNumber(stats.pvt_circulating_supply)}
                  </Text>
                  <Text style={styles.heroLabel}>{t('commonsInstitutions.circulating')}</Text>
                </View>
                <View style={styles.heroDivider} />
                <View style={styles.heroStat}>
                  <Text style={[styles.heroValue, { color: COLORS.success }]} numberOfLines={1} adjustsFontSizeToFit>
                    {formatLargeNumber(stats.pvt_total_minted)}
                  </Text>
                  <Text style={styles.heroLabel}>{t('commonsInstitutions.totalMinted')}</Text>
                </View>
                <View style={styles.heroDivider} />
                <View style={styles.heroStat}>
                  <Text style={[styles.heroValue, { color: COLORS.error }]} numberOfLines={1} adjustsFontSizeToFit>
                    {formatLargeNumber(stats.pvt_total_burned)}
                  </Text>
                  <Text style={styles.heroLabel}>{t('commonsInstitutions.totalBurned')}</Text>
                </View>
              </View>
            </View>
          </>
        )}

        {/* Bottom Spacer */}
        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
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

  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: SPACING.m,
    marginTop: SPACING.l,
  },

  // Hero Card (PVT)
  heroCard: {
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.l,
    borderWidth: 1,
    borderColor: 'rgba(124, 58, 237, 0.3)',
    overflow: 'hidden',
    ...SHADOWS.card,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroStat: { flex: 1, alignItems: 'center' },
  heroValue: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  heroLabel: { fontSize: 11, color: COLORS.textSecondary, marginTop: 4 },
  heroDivider: { width: 1, height: 36, backgroundColor: COLORS.border },

  // Stats Grid
  statsGrid: {
    flexDirection: 'row',
    gap: SPACING.s,
    marginTop: SPACING.m,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.glass,
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statValue: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  statLabel: { fontSize: 10, color: COLORS.textTertiary },

  // Dashboard Card
  dashboardCard: {
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    ...SHADOWS.card,
  },
  dashRow: {
    flexDirection: 'row',
    marginBottom: SPACING.m,
  },
  dashStat: { flex: 1, alignItems: 'center' },
  dashValue: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  dashLabel: { fontSize: 11, color: COLORS.textSecondary, marginTop: 4 },
  volumeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  volumeLabel: { fontSize: 13, color: COLORS.textSecondary },
  volumeValue: { fontSize: 15, fontWeight: '700', color: COLORS.primary },
});
