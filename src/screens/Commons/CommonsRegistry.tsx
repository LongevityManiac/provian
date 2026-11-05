/**
 * CommonsRegistry - Browse agents and humans in the Commons.
 *
 * Search bar with filters (participant type, capability).
 * Card-based results with avatar, name, attestation badge, metrics.
 * Tap card to navigate to CommonsProfile.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
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
import { shortAddress } from '../../utils/shortAddress';
import * as CommonsService from '../../core/commons/CommonsService';
import type { CommonsProfile } from '../../core/commons/CommonsService';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';
import { profilesWithoutBlocked, useCommonsBlockStore } from '../../store/commonsBlockStore';

// ─── Types ────────────────────────────────────────────────────────────────────

type ParticipantFilter = 'all' | 'agent' | 'human';
type SortOption = 'pe_count' | 'recent';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  /** rendered inside the Commons › People tab — no own header/background; clears the tab bar. */
  embedded?: boolean;
  /** content shown above the directory when nobody is searching (your agents, top contributors). */
  listHeader?: React.ReactNode;
}

/** the floating tab bar's height plus breathing room (see Commons tabs/layout.ts). */
const EMBEDDED_BOTTOM_CLEARANCE = 120;

// ─── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_ACCENT = '#4A8EE8';

const PARTICIPANT_FILTERS: { key: ParticipantFilter; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'all', labelKey: 'commons.all', icon: 'people' },
  { key: 'agent', labelKey: 'commons.agents', icon: 'hardware-chip' },
  { key: 'human', labelKey: 'commons.humans', icon: 'person' },
];

const SORT_OPTIONS: { key: SortOption; labelKey: string }[] = [
  { key: 'pe_count', labelKey: 'commons.pesLabel' },
  { key: 'recent', labelKey: 'commons.recent' },
];

const ATTESTATION_COLORS: Record<string, string> = {
  hardware: COLORS.success,
  corroborated: COLORS.successLight,
  software: COLORS.warning,
  software_verified: COLORS.primary,
  self_reported: '#9CA3AF',
};

/**
 * The registry's verification mark shows only the verification actually performed: a
 * hardware-backed device tier. `identity_verification_level` is set for every profile at
 * join (`device_attested` / `biometric_enrolled`) and proves nothing about the person, so it
 * never drives a mark. Mirrors the "Hardware-backed device" badge on CommonsProfile.
 */
const HARDWARE_BACKED_TIERS: ReadonlySet<string> = new Set([
  'hardware_partial',
  'hardware_tpm',
  'hardware_full',
  'hardware',
]);

function isHardwareBackedTier(profile: Pick<CommonsProfile, 'attestation_tier' | 'attestation_tier_raw'>): boolean {
  return HARDWARE_BACKED_TIERS.has(profile.attestation_tier_raw ?? profile.attestation_tier);
}

const ATTESTATION_LABEL_KEYS: Record<string, string> = {
  hardware: 'commons.hardwareAttested',
  corroborated: 'commons.corroborated',
  software: 'commons.software',
  software_verified: 'commons.softwareVerified',
  self_reported: 'commons.selfReported',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(val: number): string {
  if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
  return String(val);
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsRegistry({ navigation, embedded = false, listHeader }: Props) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<CommonsProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [participantFilter, setParticipantFilter] = useState<ParticipantFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('pe_count');
  const [showFilters, setShowFilters] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const params: Parameters<typeof CommonsService.browseRegistry>[0] = {
        sort_by: sortBy,
        page_size: 50,
      };
      if (participantFilter !== 'all') {
        params.participant_type = participantFilter;
      }
      if (searchQuery.trim()) {
        // Free text: name, bio or capability. (Sent as an exact `capability` tag until
        // 2026-10-17, so searching a name found nothing.)
        params.q = searchQuery.trim();
      }
      const result = await CommonsService.browseRegistry(params);
      setProfiles(result.profiles);
      setTotal(result.total);
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsRegistry] Load error:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [participantFilter, sortBy, searchQuery]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadData();
    }, [loadData]),
  );

  const blocked = useCommonsBlockStore((st) => st.blocked);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  // A blocked author is hidden from the directory on this phone, like their posts and profile.
  const visibleProfiles = profilesWithoutBlocked(profiles, blocked);
  const filteredProfiles = searchQuery.trim()
    ? visibleProfiles.filter(
        p =>
          p.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (p.capabilities ?? []).some(c => c.toLowerCase().includes(searchQuery.toLowerCase())) ||
          (p.skills ?? []).some(s => s.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : visibleProfiles;

  const renderProfileCard = (profile: CommonsProfile) => {
    const attestColor = ATTESTATION_COLORS[profile.attestation_tier] ?? '#9CA3AF';
    return (
      <TouchableOpacity
        key={profile.wallet_id}
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('CommonsProfile', { walletId: profile.wallet_id })}
      >
        <View style={styles.cardHeader}>
          {/* Avatar */}
          <View style={[styles.avatar, { borderColor: attestColor }]}>
            {profile.avatar_url ? (
              <Text style={styles.avatarText}>{getInitials(profile.display_name)}</Text>
            ) : (
              <Ionicons
                name={profile.participant_type === 'agent' ? 'hardware-chip' : 'person'}
                size={24}
                color={REGISTRY_ACCENT}
              />
            )}
          </View>

          {/* Name + Type */}
          <View style={styles.cardInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.cardName} numberOfLines={1}>
                {profile.display_name}
              </Text>
              <Text style={styles.cardAddress} numberOfLines={1}>
                ({shortAddress((profile as unknown as { address?: string }).address ?? profile.wallet_id)})
              </Text>
              {profile.participant_type === 'agent' && (
                <View style={styles.typeBadge}>
                  <Ionicons name="hardware-chip" size={10} color={COLORS.secondary} />
                  <Text style={styles.typeBadgeText}>{t('commons.agentBadge')}</Text>
                </View>
              )}
              {profile.participant_type === 'human' && (
                <View style={[styles.typeBadge, { backgroundColor: 'rgba(0, 230, 118, 0.15)' }]}>
                  <Ionicons name="person" size={10} color={COLORS.success} />
                  <Text style={[styles.typeBadgeText, { color: COLORS.success }]}>{t('commons.humanBadge')}</Text>
                </View>
              )}
            </View>

            {/* Attestation Badge */}
            <View style={styles.attestRow}>
              <View style={[styles.attestDot, { backgroundColor: attestColor }]} />
              <Text style={[styles.attestLabel, { color: attestColor }]}>
                {ATTESTATION_LABEL_KEYS[profile.attestation_tier] ? t(ATTESTATION_LABEL_KEYS[profile.attestation_tier]) : profile.attestation_tier.replace('_', ' ')}
              </Text>
              {isHardwareBackedTier(profile) && (
                <Ionicons
                  name="shield-checkmark"
                  size={12}
                  color={COLORS.success}
                  style={{ marginLeft: 4 }}
                  accessibilityLabel={t('commons.hardwareBackedDevice')}
                />
              )}
            </View>
          </View>
        </View>

        {/* Metrics Row */}
        <View style={styles.metricsRow}>
          <View style={styles.metric}>
            <Text style={styles.metricValue}>{formatNumber(profile.pe_count)}</Text>
            <Text style={styles.metricLabel}>{t('commons.pesLabel', { count: profile.pe_count })}</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricValue}>
              {profile.promise_fulfillment_rate > 0
                ? `${Math.round(profile.promise_fulfillment_rate * 100)}%`
                : '--'}
            </Text>
            <Text style={styles.metricLabel}>{t('commons.fulfillLabel')}</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricValue}>{profile.published_pe_count}</Text>
            <Text style={styles.metricLabel}>{t('commons.publishedLabel')}</Text>
          </View>
        </View>

        {/* Skills / Capabilities */}
        {((profile.skills ?? []).length > 0 || (profile.capabilities ?? []).length > 0) && (
          <View style={styles.tagsRow}>
            {[...(profile.skills ?? []), ...(profile.capabilities ?? [])].slice(0, 4).map((tag, i) => (
              <View key={i} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

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

      {/* Header (the Commons › People tab supplies its own) */}
      {!embedded && (
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIconBg}>
            <Ionicons name="people" size={16} color={REGISTRY_ACCENT} />
          </View>
          <Text style={styles.headerTitle}>{t('commons.registryTitle')}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.totalText}>{t('commons.registryCount', { count: total })}</Text>
        </View>
      </View>
      )}

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            placeholder={t('commons.searchPlaceholder')}
            placeholderTextColor="#9CA3AF"
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color="#9CA3AF" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={[styles.filterToggle, showFilters && styles.filterToggleActive]}
          onPress={() => setShowFilters(!showFilters)}
        >
          <Ionicons name="options" size={20} color={showFilters ? REGISTRY_ACCENT : '#8B929E'} />
        </TouchableOpacity>
      </View>

      {/* Filters Panel */}
      {showFilters && (
        <View style={styles.filtersPanel}>
          {/* Participant Type */}
          <Text style={styles.filterLabel}>{t('commons.typeFilter')}</Text>
          <View style={styles.filterChips}>
            {PARTICIPANT_FILTERS.map(f => (
              <TouchableOpacity
                key={f.key}
                style={[styles.chip, participantFilter === f.key && styles.chipActive]}
                onPress={() => setParticipantFilter(f.key)}
              >
                <Ionicons
                  name={f.icon}
                  size={14}
                  color={participantFilter === f.key ? COLORS.text : '#8B929E'}
                />
                <Text style={[styles.chipText, participantFilter === f.key && styles.chipTextActive]}>
                  {t(f.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Sort By */}
          <Text style={styles.filterLabel}>{t('commons.sortBy')}</Text>
          <View style={styles.filterChips}>
            {SORT_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.chip, sortBy === opt.key && styles.chipActive]}
                onPress={() => setSortBy(opt.key)}
              >
                <Text style={[styles.chipText, sortBy === opt.key && styles.chipTextActive]}>
                  {t(opt.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Results */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={REGISTRY_ACCENT} />
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, embedded && { paddingBottom: EMBEDDED_BOTTOM_CLEARANCE }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {!searchQuery.trim() && listHeader}
          {embedded && !searchQuery.trim() && (
            <Text style={styles.everyoneTitle}>{t('commonsHome.everyone', { count: total })}</Text>
          )}
          {!embedded && (<View style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            backgroundColor: 'rgba(74, 142, 232, 0.06)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: 'rgba(74, 142, 232, 0.12)',
          }}>
            <Ionicons name="eye-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
            <Text style={{ color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 }}>{t('commons.registryExplainer')}</Text>
          </View>)}
          {profiles.length === 0 && loadFailed ? (
            <LoadFailed onRetry={() => { void loadData(); }} />
          ) : filteredProfiles.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="people" size={48} color={COLORS.textTertiary} />
              <Text style={styles.emptyTitle}>{t('commons.noParticipants')}</Text>
              <Text style={styles.emptySubtitle}>{t('commons.adjustFilters')}</Text>
            </View>
          ) : (
            filteredProfiles.map(renderProfileCard)
          )}
        </ScrollView>
      )}
    </Frame>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  embeddedContainer: { flex: 1 },
  everyoneTitle: { fontSize: 13, fontWeight: '700', color: COLORS.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.s, marginTop: SPACING.xs },
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
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginLeft: SPACING.m, flex: 1 },
  headerIconBg: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  headerRight: { alignItems: 'flex-end' },
  totalText: { fontSize: 12, color: '#8B929E' },

  // Search
  searchContainer: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.l,
    marginBottom: SPACING.m,
    gap: SPACING.s,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(18,21,26,0.60)',
    borderRadius: 14,
    paddingHorizontal: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(42,48,56,1)',
    height: 44,
    gap: SPACING.s,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
  },
  filterToggle: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: 'rgba(18,21,26,0.60)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(42,48,56,1)',
  },
  filterToggleActive: {
    borderColor: REGISTRY_ACCENT,
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
  },

  // Filters
  filtersPanel: {
    paddingHorizontal: SPACING.l,
    paddingBottom: SPACING.m,
  },
  filterLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
    marginTop: SPACING.s,
  },
  filterChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.s,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.xs + 2,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
  },
  chipActive: {
    borderColor: REGISTRY_ACCENT,
    backgroundColor: 'rgba(74, 142, 232, 0.15)',
  },
  chipText: { fontSize: 12, color: '#8B929E' },
  chipTextActive: { color: COLORS.text, fontWeight: '600' },

  // Card
  card: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 20,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    borderTopWidth: 2,
    borderTopColor: REGISTRY_ACCENT,
    ...SHADOWS.card,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.m,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: COLORS.primary },
  cardInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
  cardName: { fontSize: 16, fontWeight: '600', color: COLORS.text, flexShrink: 1 },
  cardAddress: { fontSize: 12, color: '#8B929E', fontFamily: 'Menlo', flexShrink: 0 },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0, 229, 255, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
  },
  typeBadgeText: { fontSize: 10, fontWeight: '500', color: COLORS.secondary },

  // Attestation
  attestRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
  attestDot: { width: 6, height: 6, borderRadius: 3 },
  attestLabel: { fontSize: 11, fontWeight: '500', textTransform: 'capitalize' },

  // Metrics
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.m,
    paddingTop: SPACING.m,
    borderTopWidth: 1,
    borderTopColor: 'rgba(200,205,214,0.08)',
  },
  metric: { flex: 1, alignItems: 'center' },
  metricValue: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  metricLabel: { fontSize: 10, color: '#9CA3AF', marginTop: 2 },
  metricDivider: { width: 1, height: 24, backgroundColor: 'rgba(200,205,214,0.08)' },

  // Tags
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.s,
  },
  tag: {
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BORDER_RADIUS.s,
  },
  tagText: { fontSize: 11, color: COLORS.primaryLight },

  // Empty
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxxl,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 14, color: '#8B929E', marginTop: SPACING.xs },
});
