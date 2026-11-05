import { enumDisplayCopy } from '../../i18n/displayCopy';
import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * Record-only Commons protocol reference.
 *
 * PVT9 and economic governance are unavailable. This screen intentionally
 * exposes only the independent PE type catalog and constitutional reference.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { BORDER_RADIUS, COLORS, GRADIENTS, SPACING } from '../../constants/theme';
import * as CommonsService from '../../core/commons/CommonsService';
import { shortAddress } from '../../utils/shortAddress';
import { useTranslation } from 'react-i18next';
import {
  getNetworkConstitution,
} from '../../generated/networkConstitution';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

type Tab = 'pe_types' | 'constitution';

interface PETypeProposal {
  proposal_id: string;
  action_type: string;
  description: string;
  use_case: string;
  proposer_wallet_id: string;
  upvotes: number;
  status: string;
  created_at: number;
}

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

const TABS: { key: Tab; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'pe_types', labelKey: 'commonsGovernance.tabPeTypes', icon: 'cube-outline' },
  { key: 'constitution', labelKey: 'commonsGovernance.tabConstitution', icon: 'book-outline' },
];

export default function CommonsGovernance({ navigation }: Props) {
  const { t, i18n } = useTranslation();
  const charter = getNetworkConstitution(i18n.resolvedLanguage || i18n.language);
  const [activeTab, setActiveTab] = useState<Tab>('pe_types');
  const [peProposals, setPeProposals] = useState<PETypeProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const result = await CommonsService.getPETypeProposals();
      setPeProposals(result.proposals);
      setLoadFailed(false);
    } catch (error) {
      console.log('[CommonsGovernance] PE catalog load error:', error);
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

  const handleUpvote = async (proposalId: string) => {
    try {
      await CommonsService.upvotePETypeProposal(proposalId);
      await loadData();
    } catch (error: unknown) {
      Alert.alert(t('commonsGovernance.upvoteFailedTitle'), errorDisplayCopy(error instanceof Error ? error.message : t('commonsGovernance.upvoteFailedFallback')));
    }
  };

  const renderPETypes = () => (
    <>
      <View style={styles.statusCard}>
        <View style={styles.statusHeader}>
          <Ionicons name="lock-closed-outline" size={16} color={COLORS.primary} />
          <Text style={styles.statusTitle}>{t('commonsGovernance.statusTitle')}</Text>
        </View>
        {/* The English copy stays inline as defaultValue because the source test
            pins the inactive-governance boundary and PE-type proposal rule. */}
        <Text style={styles.statusBody}>
          {t('commonsGovernance.statusBody', { defaultValue: 'No economic proposal or voting runtime is active, and PVT settlement is live on Base. When community voting opens, it will be announced in the Commons.' })}
        </Text>
      </View>

      <Text style={styles.peTypeHeader}>
        {t('commonsGovernance.peTypeHeader', { defaultValue: 'PE types are permissionless record labels. Upvotes are documentation and demand signals only; they grant no economic authority or mint eligibility.' })}
      </Text>

      {peProposals.length === 0 && loadFailed ? (
        <LoadFailed onRetry={() => { void loadData(); }} />
      ) : peProposals.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="cube-outline" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{t('commonsGovernance.emptyTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('commonsGovernance.emptySubtitle')}</Text>
        </View>
      ) : (
        peProposals.map((proposal) => (
          <View key={proposal.proposal_id} style={styles.peCard}>
            <View style={styles.peCardHeader}>
              <View style={styles.peTypeTag}>
                <Ionicons name="code-slash" size={12} color={COLORS.secondary} />
                <Text style={styles.peTypeText}>{proposal.action_type}</Text>
              </View>
              <TouchableOpacity
                style={styles.upvoteRow}
                onPress={() => handleUpvote(proposal.proposal_id)}
              >
                <Ionicons name="arrow-up" size={16} color={COLORS.primary} />
                <Text style={styles.upvoteCount}>{proposal.upvotes}</Text>
              </TouchableOpacity>
            </View>
            {proposal.description ? (
              <Text style={styles.peDescription}>{proposal.description}</Text>
            ) : null}
            {proposal.use_case ? (
              <Text style={styles.peUseCase}>{t('commonsGovernance.useCase', { useCase: proposal.use_case })}</Text>
            ) : null}
            <View style={styles.peFooter}>
              <Text style={styles.peProposer}>
                {proposal.proposer_wallet_id
                  ? t('commonsGovernance.documentedBy', { address: shortAddress(proposal.proposer_wallet_id) })
                  : t('commonsGovernance.observedOnRecordPath')}
              </Text>
              <Text style={styles.peStatusText}>{enumDisplayCopy(proposal.status)}</Text>
            </View>
          </View>
        ))
      )}
    </>
  );

  const renderConstitution = () => (
    <>
      <View style={styles.constitutionIntro}>
        <Ionicons name="book" size={32} color={COLORS.warning} />
        <Text style={styles.constitutionTitle}>{charter.title}</Text>
        <Text style={styles.constitutionSubtitle}>
          {t('commonsGovernance.constitutionIntro')}
        </Text>
        <TouchableOpacity
          style={styles.constitutionButton}
          onPress={() => navigation.navigate('NetworkConstitution')}
          accessibilityRole="button"
        >
          <Text style={styles.constitutionButtonText}>
            {t('commonsGovernance.readConstitution', { defaultValue: 'Read the Network Constitution' })}
          </Text>
          <Ionicons name="arrow-forward" size={16} color={COLORS.background} />
        </TouchableOpacity>
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
      <View style={styles.hero}>
        <Image
          source={require('../../../assets/images/governance-hero.png')}
          style={styles.heroImage}
          resizeMode="cover"
        />
        <LinearGradient colors={['transparent', COLORS.background]} style={styles.heroFade} />
      </View>
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <Text style={styles.headerTitle}>{t('commonsGovernance.headerTitle')}</Text>
      </View>
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
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
        >
          {activeTab === 'pe_types' ? renderPETypes() : renderConstitution()}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  hero: { height: 180, overflow: 'hidden' },
  heroImage: { width: '100%', height: '100%', position: 'absolute' },
  heroFade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  headerTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m },
  tabBar: { flexDirection: 'row', marginHorizontal: SPACING.l, marginBottom: SPACING.m, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.xs, borderWidth: 1, borderColor: COLORS.border },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.s + 2, gap: 4, borderRadius: BORDER_RADIUS.s },
  tabActive: { backgroundColor: 'rgba(59, 130, 246, 0.15)' },
  tabText: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '500' },
  tabTextActive: { color: COLORS.primary, fontWeight: '600' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  statusCard: { backgroundColor: 'rgba(74, 142, 232, 0.08)', borderRadius: BORDER_RADIUS.l, padding: SPACING.l, marginBottom: SPACING.m, borderWidth: 1, borderColor: 'rgba(74, 142, 232, 0.15)' },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: SPACING.s },
  statusTitle: { fontSize: 14, fontWeight: '700', color: COLORS.primary },
  statusBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
  peTypeHeader: { fontSize: 13, color: COLORS.textSecondary, marginBottom: SPACING.l, lineHeight: 18 },
  emptyState: { alignItems: 'center', paddingVertical: SPACING.xxxl },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 13, color: COLORS.textTertiary, marginTop: SPACING.xs },
  peCard: { backgroundColor: COLORS.glass, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.m, borderWidth: 1, borderColor: COLORS.border },
  peCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.s },
  peTypeTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(6, 182, 212, 0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: BORDER_RADIUS.s },
  peTypeText: { fontSize: 12, color: COLORS.secondary, fontFamily: 'monospace', fontWeight: '500' },
  upvoteRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  upvoteCount: { fontSize: 14, fontWeight: '600', color: COLORS.primary },
  peDescription: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginBottom: SPACING.xs },
  peUseCase: { fontSize: 12, color: COLORS.textTertiary, fontStyle: 'italic', marginBottom: SPACING.s },
  peFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  peProposer: { fontSize: 11, color: COLORS.textTertiary, fontFamily: 'monospace' },
  peStatusText: { fontSize: 10, fontWeight: '500', color: COLORS.primary, textTransform: 'capitalize' },
  constitutionIntro: { alignItems: 'center', paddingVertical: SPACING.l, marginBottom: SPACING.l },
  constitutionTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text, marginTop: SPACING.m },
  constitutionSubtitle: { fontSize: 14, color: COLORS.textSecondary, textAlign: 'center', marginTop: SPACING.s, lineHeight: 20, paddingHorizontal: SPACING.l },
  constitutionButton: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.l,
    backgroundColor: COLORS.warning, borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.l, paddingVertical: SPACING.m,
  },
  constitutionButtonText: { color: COLORS.background, fontSize: 14, fontWeight: '700' },
});
