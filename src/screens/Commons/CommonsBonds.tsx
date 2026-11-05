/**
 * CommonsBonds - Read-only observation of performance bonds across the network.
 *
 * Agents stake PVT to back their work. This screen shows active bonds and
 * recent claim activity for anyone to verify bond health before engaging.
 * Observe-only: posting, renewing, and filing claims happens in the Agent
 * flows and via the `/v1/bonds/` API, not here.
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
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import * as CommonsService from '../../core/commons/CommonsService';
import type { BondSummary, BondClaimSummary } from '../../core/commons/CommonsService';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

// ─── Constants ────────────────────────────────────────────────────────────────

const BONDS_ACCENT = '#4CC38A';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddress(addrOrId: string | undefined): string {
  if (!addrOrId) return '–';
  if (addrOrId.length <= 12) return addrOrId;
  return `${addrOrId.slice(0, 6)}...${addrOrId.slice(-4)}`;
}

function formatPVT(amount: string | undefined): string {
  if (!amount) return '0 PVT';
  try {
    const n = BigInt(amount);
    // 18-decimal fixed point → human string with up to 2 decimals
    const whole = n / 10n ** 18n;
    const frac = (n % 10n ** 18n) / 10n ** 16n; // two decimals
    return `${whole.toString()}.${frac.toString().padStart(2, '0')} PVT`;
  } catch {
    return `${amount} PVT`;
  }
}

function timeAgo(t: TFunction, timestamp: number | undefined): string {
  if (!timestamp) return '–';
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return t('commonsBonds.justNow');
  if (hours < 24) return t('commonsBonds.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('commonsBonds.daysAgo', { count: days });
  return t('commonsBonds.weeksAgo', { count: Math.floor(days / 7) });
}

function timeUntil(timestamp: number | undefined): string | null {
  if (!timestamp) return null;
  const diff = timestamp - Date.now();
  if (diff <= 0) return 'overdue';
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  return `${hours}h`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsBonds({ navigation }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bonds, setBonds] = useState<BondSummary[]>([]);
  const [claims, setClaims] = useState<BondClaimSummary[]>([]);
  const [totals, setTotals] = useState<{
    active: number;
    claims: number;
    lockedPvt: string;
  }>({ active: 0, claims: 0, lockedPvt: '0' });

  const loadData = useCallback(async () => {
    try {
      const stats = await CommonsService.getCommonsBondStats();
      setBonds(stats.active_bonds || []);
      setClaims(stats.recent_claims || []);
      setTotals({
        active: stats.active_bond_count || 0,
        claims: stats.recent_claim_count || 0,
        lockedPvt: stats.total_locked_pvt || '0',
      });
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsBonds] Load error:', err);
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
        <BackButton onPress={() => navigation.goBack()} />
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIconBg}>
            <Ionicons name="shield-checkmark" size={16} color={BONDS_ACCENT} />
          </View>
          <Text style={styles.headerTitle}>{t('commonsBonds.headerTitle')}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={BONDS_ACCENT} />
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {/* Observe-only banner */}
          <View style={styles.observeBanner}>
            <Ionicons name="eye-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
            <Text style={styles.observeText}>
              {t('commonsBonds.observeBanner')}
            </Text>
          </View>

          {/* Totals */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totals.active}</Text>
              <Text style={styles.statLabel}>{t('commonsBonds.activeBonds')}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{formatPVT(totals.lockedPvt)}</Text>
              <Text style={styles.statLabel}>{t('commonsBonds.locked')}</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{totals.claims}</Text>
              <Text style={styles.statLabel}>{t('commonsBonds.recentClaims')}</Text>
            </View>
          </View>

          {/* Active Bonds */}
          <Text style={styles.sectionTitle}>{t('commonsBonds.activeBonds')}</Text>
          {bonds.length === 0 && loadFailed ? (
            <LoadFailed onRetry={() => { void loadData(); }} />
          ) : bonds.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="shield-outline" size={40} color={COLORS.textTertiary} />
              <Text style={styles.emptyTitle}>{t('commonsBonds.emptyBondsTitle')}</Text>
              <Text style={styles.emptySubtitle}>
                {t('commonsBonds.emptyBondsSubtitle')}
              </Text>
            </View>
          ) : (
            bonds.map((b) => {
              const renewal = timeUntil(b.renewal_due_at);
              return (
                <View key={b.bond_id} style={styles.row}>
                  <View style={styles.rowHeader}>
                    <View style={styles.rowTitleBlock}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {shortAddress(b.agent_address || b.agent_wallet_id)}
                      </Text>
                    </View>
                    <Text style={styles.rowValue}>{formatPVT(b.amount_pvt)}</Text>
                  </View>
                  <View style={styles.rowFooter}>
                    <Text style={styles.rowMeta}>{t('commonsBonds.posted', { time: timeAgo(t, b.created_at) })}</Text>
                    {renewal && (
                      <Text style={[
                        styles.rowMeta,
                        renewal === 'overdue' && { color: COLORS.error },
                      ]}>
                        {renewal === 'overdue' ? t('commonsBonds.renewalOverdue') : t('commonsBonds.renewsIn', { time: renewal })}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })
          )}

          {/* Recent Claims */}
          <Text style={styles.sectionTitle}>{t('commonsBonds.recentClaims')}</Text>
          {/* one load feeds both lists; its failure is already shown above */}
          {claims.length === 0 && loadFailed ? null : claims.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="document-text-outline" size={40} color={COLORS.textTertiary} />
              <Text style={styles.emptyTitle}>{t('commonsBonds.emptyClaimsTitle')}</Text>
              <Text style={styles.emptySubtitle}>
                {t('commonsBonds.emptyClaimsSubtitle')}
              </Text>
            </View>
          ) : (
            claims.map((c) => (
              <View key={c.claim_id} style={styles.row}>
                <View style={styles.rowHeader}>
                  <View style={styles.rowTitleBlock}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {shortAddress(c.claimant_wallet_id)}
                    </Text>
                    <Ionicons name="arrow-forward" size={12} color="#8B929E" style={{ marginHorizontal: 4 }} />
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {shortAddress(c.respondent_wallet_id)}
                    </Text>
                  </View>
                  <Text style={styles.rowValue}>{formatPVT(c.amount_pvt)}</Text>
                </View>
                <View style={styles.rowFooter}>
                  <Text style={styles.rowMeta}>{c.status || t('commonsBonds.statusFiled')}</Text>
                  <Text style={styles.rowMeta}>{timeAgo(t, c.filed_at)}</Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E14' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(200,205,214,0.08)',
  },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerIconBg: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(76, 195, 138, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text },
  headerSpacer: { width: 44 },

  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  observeBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(74, 142, 232, 0.06)',
    borderRadius: BORDER_RADIUS.m,
    padding: 14,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(74, 142, 232, 0.12)',
  },
  observeText: { color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 },

  statsRow: {
    flexDirection: 'row',
    gap: SPACING.s,
    marginBottom: SPACING.l,
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    alignItems: 'center',
    ...SHADOWS.small,
  },
  statValue: { fontSize: 18, fontWeight: '700', color: BONDS_ACCENT },
  statLabel: { fontSize: 11, color: '#8B929E', marginTop: 4, fontWeight: '500' },

  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: SPACING.l,
    marginBottom: SPACING.s,
    letterSpacing: 0.5,
  },

  row: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: BORDER_RADIUS.m,
    padding: SPACING.m,
    marginBottom: SPACING.s,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitleBlock: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text, marginRight: 6 },
  rowValue: { fontSize: 14, fontWeight: '700', color: BONDS_ACCENT },
  rowFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  rowMeta: { fontSize: 11, color: '#8B929E' },

  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xl,
  },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text, marginTop: SPACING.s },
  emptySubtitle: {
    fontSize: 12,
    color: COLORS.textTertiary,
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: SPACING.l,
  },
});
