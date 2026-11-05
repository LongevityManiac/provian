import { badgeDisplayCopy } from '../../i18n/displayCopy';
import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction } from '../../core/security/biometricAction';
/**
 * CommonsProfile - View/edit profile for Commons participants.
 *
 * Shows the track record, published records, and participation. Editable when viewing your own
 * profile. the things you DO on a profile (message, ask for proof, show your standing, edit)
 * sit in one button row under the header card instead of at the bottom of a long page.
 *
 * a person can VOUCH for someone else's profile (a person or an agent). A vouch rides a
 * 15 PVT reputation presentation to that profile — one burn covers vouching for it for 7 days —
 * so the action checks for a live one first and otherwise routes to the presentation, which then
 * stakes the vouch. It is hidden on your own profile and on your own beneficiary-linked agents
 * (the relay refuses that pair too: 403 linked_pair_vouch_refused).
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
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { CommonsProfile as CommonsProfileType, ProfileVouch, MyVouch } from '../../core/commons/CommonsService';
import RelayAPIService from '../../services/RelayAPIService';
import { requireBiometric, BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import { canShowVouch, classifyVouchError, hasVouchedFor, VOUCH_BURN_PVT, type LinkedAgentIds } from '../../core/commons/vouchModel';
import { useTranslation } from 'react-i18next';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import BackButton from '../../components/BackButton';
import { useCommonsBlockStore } from '../../store/commonsBlockStore';
import { confirmBlock, openReportToProvian } from '../../components/commons/safetyActions';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  route: {
    params?: {
      walletId?: string;
      editable?: boolean;
    };
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_ACCENT = '#4A8EE8';

const ATTESTATION_CONFIG: Record<string, { color: string; labelKey: string; icon: keyof typeof Ionicons.glyphMap }> = {
  hardware: { color: COLORS.success, labelKey: 'commons.hardwareAttested', icon: 'hardware-chip' },
  corroborated: { color: COLORS.successLight, labelKey: 'commons.corroborated', icon: 'shield-checkmark' },
  software_verified: { color: COLORS.primary, labelKey: 'commons.softwareVerified', icon: 'code-slash' },
  software: { color: COLORS.warning, labelKey: 'commons.software', icon: 'desktop' },
  self_reported: { color: COLORS.textTertiary, labelKey: 'commons.selfReported', icon: 'person' },
};

const STATUS_CONFIG: Record<string, { color: string; labelKey: string }> = {
  active: { color: COLORS.success, labelKey: 'commons.active' },
  dormant: { color: COLORS.warning, labelKey: 'commons.dormant' },
  suspended: { color: COLORS.error, labelKey: 'commons.suspended' },
};

const INSTITUTION_METRICS: {
  key: string;
  labelKey: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  format: (profile: CommonsProfileType, translate: (key: string, options?: Record<string, unknown>) => string) => string;
}[] = [
  { key: 'registry', labelKey: 'commons.registry', icon: 'people', color: '#4A8EE8', format: (p, translate) => translate('commons.peCount', { count: p.pe_count }) },
  { key: 'court', labelKey: 'commons.court', icon: 'hammer', color: '#F2555A', format: (p, translate) => translate('commons.casesCount', { count: p.court_record.arbitrations_completed }) },
  { key: 'jobs', labelKey: 'commons.humanJobs', icon: 'briefcase', color: '#E8A838', format: (p, translate) => translate('commons.completedCount', { count: p.human_jobs_completed }) },
  { key: 'forum', labelKey: 'commons.forum', icon: 'megaphone', color: '#6BA3F0', format: (p, translate) => translate('commons.postsCount', { count: p.forum_post_count }) },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function getInitials(name: string): string {
  return name.split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommonsProfile({ navigation, route }: Props) {
  const { t } = useTranslation();
  const walletId = route.params?.walletId;
  const ownProfile = useCommonsStore(s => s.profile);
  const updateStoreProfile = useCommonsStore(s => s.updateProfile);

  const isOwnProfile = walletId === ownProfile?.wallet_id;
  const blocked = useCommonsBlockStore((st) => st.blocked);
  const [editableFromRoute] = useState(route.params?.editable ?? false);

  const [profile, setProfile] = useState<CommonsProfileType | null>(null);
  const [publishedPEs, setPublishedPEs] = useState<unknown[]>([]);
  const [vouches, setVouches] = useState<ProfileVouch[]>([]);
  const [myVouches, setMyVouches] = useState<MyVouch[]>([]);
  const [linkedAgents, setLinkedAgents] = useState<LinkedAgentIds[] | null>(null);
  const [vouching, setVouching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Edit state
  const [editing, setEditing] = useState(editableFromRoute);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editAvailability, setEditAvailability] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    if (!walletId) {
      setLoading(false);
      return;
    }
    try {
      const [profileData, pesData, vouchesData] = await Promise.all([
        CommonsService.getAgentProfile(walletId),
        CommonsService.getPublishedPEs(walletId, { page_size: 20 }),
        CommonsService.getVouches(walletId),
      ]);
      setProfile(profileData);
      setPublishedPEs(pesData.projections);
      setVouches(vouchesData.vouches);

      // the person's own vouches ("Vouched" state) and linked agents (hide Vouch on them).
      if (!isOwnProfile && ownProfile?.participant_type === 'human') {
        const [mine, linked] = await Promise.all([
          CommonsService.getMyVouches().catch(() => ({ vouches: [] as MyVouch[] })),
          RelayAPIService.getLinkedAgents().then((r) => r.linked_agents.map((a) => ({ wallet_id: a.wallet_id, agent_id: a.agent_id }))).catch(() => null),
        ]);
        setMyVouches(mine.vouches);
        setLinkedAgents(linked);
      }

      // Initialize edit fields
      setEditName(profileData.display_name);
      setEditBio(profileData.bio ?? '');
      setEditAvailability(profileData.availability ?? '');
    } catch (err) {
      console.log('[CommonsProfile] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [walletId, isOwnProfile, ownProfile?.participant_type]);

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

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateStoreProfile({
        display_name: editName.trim() || undefined,
        bio: editBio.trim() || undefined,
        availability: editAvailability.trim() || undefined,
      });
      setEditing(false);
      await loadData();
      Alert.alert(t('profile.saved'), t('commons.profileSaved'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('commons.saveFailed');
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(msg));
    } finally {
      setSaving(false);
    }
  };

  // vouch — a 15 PVT reputation presentation to this profile backs it (7 days per burn).
  const stake = async (targetId: string, targetName: string) => {
    try {
      return await withBiometricAction(t('commons.vouchBiometric'), async (biometricAction) => {
    setVouching(true);
    try {
      await CommonsService.stakeVouch(targetId, undefined, biometricAction);
      Alert.alert(t('commons.vouched'), t('commons.vouchedMsg', { name: targetName }));
      await loadData();
    } catch (err) {
      const kind = classifyVouchError(err);
      if (kind === 'needs_presentation') {
        presentToVouch(targetId, targetName);
      } else if (kind === 'linked_pair') {
        Alert.alert(t('commons.vouchFailed'), t('commons.vouchLinkedRefused'));
      } else {
        Alert.alert(t('commons.vouchFailed'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.vouchFailed')));
      }
    } finally {
      setVouching(false);
    }

      });
    } catch (err) {
      if (err instanceof BiometricNotAvailableError || err instanceof BiometricAuthError) {
        Alert.alert(t('commons.confirmationNeededTitle'), errorDisplayCopy(err.message));
      }
      return;
    }
  };

  const presentToVouch = (targetId: string, targetName: string) => {
    navigation.navigate('HumanPresentment', {
      audience: targetId,
      selfChallenge: true,
      deliverTo: { kind: 'vouch', targetId, targetName },
    });
  };

  const handleVouch = () => {
    if (!walletId || !profile) return;
    const name = profile.display_name;
    Alert.alert(t('commons.vouchForName', { name }), t('commons.vouchCostBody', { pvt: VOUCH_BURN_PVT, name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('commons.vouch'),
        onPress: async () => {
          // A live presentation to this profile already backs the vouch — no second burn.
          const state = await RelayAPIService.readHandshakeState({ counterparty: walletId }).catch(() => null);
          if (state?.state === 'live') {
            await stake(walletId, name);
          } else {
            presentToVouch(walletId, name);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={REGISTRY_ACCENT} />
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.container}>
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
        <View style={styles.header}>
          <BackButton onPress={() => navigation.goBack()} />
          <Text style={styles.headerTitle}>{t('commons.profileTitle')}</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="person" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{t('commons.profileNotFound')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // An author this person blocked: their profile stays hidden on this phone until unblocked.
  if (!isOwnProfile && walletId && blocked[walletId] !== undefined) {
    return (
      <SafeAreaView style={styles.container}>
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
        <View style={styles.header}>
          <BackButton onPress={() => navigation.goBack()} />
          <Text style={styles.headerTitle}>{t('commons.profileTitle')}</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="eye-off-outline" size={48} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{t('commonsSafety.blockedHidden')}</Text>
          <TouchableOpacity style={[styles.actionButton, styles.safetyButton]} onPress={() => { void useCommonsBlockStore.getState().unblock(walletId); }} accessibilityRole="button">
            <Text style={styles.actionText}>{t('commonsSafety.unblock')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const attest = ATTESTATION_CONFIG[profile.attestation_tier] ?? ATTESTATION_CONFIG.self_reported;
  const status = STATUS_CONFIG[profile.status] ?? STATUS_CONFIG.active;

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
        <Text style={styles.headerTitle}>{t('commons.profileTitle')}</Text>
        {isOwnProfile && !editing && (
          <TouchableOpacity onPress={() => setEditing(true)} style={styles.editHeaderButton}>
            <Ionicons name="create" size={20} color={REGISTRY_ACCENT} />
          </TouchableOpacity>
        )}
        {!isOwnProfile && <View style={styles.headerSpacer} />}
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── Profile Hero ──────────────────────────────────────────── */}
        <View style={styles.heroCard}>
          <View style={styles.heroTop}>
            {/* Avatar */}
            <View style={[styles.avatar, { borderColor: attest.color }]}>
              {profile.participant_type === 'agent' ? (
                <Ionicons name="hardware-chip" size={32} color={COLORS.secondary} />
              ) : (
                <Text style={styles.avatarText}>{getInitials(profile.display_name)}</Text>
              )}
            </View>

            {/* Name + Type */}
            <View style={styles.heroInfo}>
              {editing ? (
                <TextInput
                  style={styles.editInput}
                  value={editName}
                  onChangeText={setEditName}
                  placeholder={t('commons.displayNameShort')}
                  placeholderTextColor="#9CA3AF"
                />
              ) : (
                <Text style={styles.heroName}>{profile.display_name}</Text>
              )}
              <Text style={styles.heroAddress}>
                ({shortAddress((profile as unknown as { address?: string }).address ?? profile.wallet_id)})
              </Text>

              <View style={styles.typeRow}>
                <View style={[styles.typeBadge, profile.participant_type === 'agent' ? styles.agentBadge : styles.humanBadge]}>
                  <Text style={[styles.typeText, { color: profile.participant_type === 'agent' ? COLORS.secondary : COLORS.success }]}>
                    {profile.participant_type === 'agent' ? t('commons.agentBadge') : t('commons.humanBadge')}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: `${status.color}20` }]}>
                  <View style={[styles.statusDot, { backgroundColor: status.color }]} />
                  <Text style={[styles.statusLabel, { color: status.color }]}>{t(status.labelKey)}</Text>
                </View>
              </View>
            </View>
          </View>

          {/* Attestation */}
          <View style={[styles.attestBanner, { backgroundColor: `${attest.color}15` }]}>
            <Ionicons name={attest.icon} size={16} color={attest.color} />
            <Text style={[styles.attestText, { color: attest.color }]}>{t(attest.labelKey)}</Text>
            {['hardware_partial', 'hardware_tpm', 'hardware_full', 'hardware'].includes(profile.attestation_tier_raw ?? profile.attestation_tier) && (
              <View style={styles.verifiedBadge}>
                <Ionicons name="shield-checkmark" size={12} color={COLORS.success} />
                <Text style={styles.verifiedText}>{t('commons.hardwareBackedDevice')}</Text>
              </View>
            )}
          </View>

          {/* Bio */}
          {editing ? (
            <TextInput
              style={[styles.editInput, styles.bioInput]}
              value={editBio}
              onChangeText={setEditBio}
              placeholder={t('commons.bioShort')}
              placeholderTextColor="#9CA3AF"
              multiline
            />
          ) : profile.bio ? (
            <Text style={styles.bioText}>{profile.bio}</Text>
          ) : null}

          <Text style={styles.joinDate}>{t('commons.joinedDate', { date: formatDate(profile.commons_join_date) })}</Text>
        </View>

        {/* ─── Actions (one row, right under who they are) ─────── */}
        {!editing && (
          <View style={styles.actionRow}>
            {isOwnProfile ? (
              <>
                <TouchableOpacity style={[styles.actionButton, styles.actionPrimary]} onPress={() => setEditing(true)} accessibilityRole="button">
                  <Ionicons name="create-outline" size={18} color="#FFFFFF" />
                  <Text style={styles.actionPrimaryText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsHome.editProfile')}</Text>
                </TouchableOpacity>
                {/* Burn-to-present — PRESENTER role, on the user's OWN profile. */}
                <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('HumanPresentment')} accessibilityRole="button" accessibilityHint={t('commonsHome.showStandingSub')}>
                  <Ionicons name="ribbon-outline" size={18} color={COLORS.text} />
                  <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsHome.showStanding')}</Text>
                </TouchableOpacity>
              </>
            ) : ownProfile && walletId ? (
              <>
                {/* message this wallet directly — an end-to-end encrypted thread. Free with an
                    open relationship; otherwise the first message uses your talking pass. */}
                <TouchableOpacity
                  style={[styles.actionButton, styles.actionPrimary]}
                  onPress={() => navigation.navigate('CommonsThread', { counterparty: walletId, counterpartyName: profile.display_name })}
                  accessibilityRole="button"
                  accessibilityLabel={t('commons.messageAgent', { name: profile.display_name })}
                >
                  <Ionicons name="chatbubbles-outline" size={18} color="#FFFFFF" />
                  <Text style={styles.actionPrimaryText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsHome.message')}</Text>
                </TouchableOpacity>
                {/* Burn-to-present — REQUESTER role, anchored on a counterparty's profile. Starting
                    from THEIR profile is the audience binding: they burn + present; you verify. */}
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => navigation.navigate('PresentationRequester', { counterparty: walletId })}
                  accessibilityRole="button"
                  accessibilityHint={t('commonsHome.askProofSub', { name: profile.display_name })}
                >
                  <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.text} />
                  <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsHome.askProof')}</Text>
                </TouchableOpacity>
                {/* vouch (a person, for a person or an agent) — never on your own linked agents. */}
                {ownProfile.participant_type === 'human' && linkedAgents !== null
                  && canShowVouch({ viewerId: ownProfile.wallet_id, targetId: walletId, linkedAgents }) && (
                  hasVouchedFor(myVouches, walletId) ? (
                    <View style={[styles.actionButton, styles.actionDone]} accessible accessibilityLabel={t('commons.vouched')}>
                      <Ionicons name="checkmark-circle" size={18} color={COLORS.success} />
                      <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commons.vouched')}</Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={[styles.actionButton, vouching && { opacity: 0.6 }]}
                      onPress={handleVouch}
                      disabled={vouching}
                      accessibilityRole="button"
                      accessibilityLabel={t('commons.vouchFor', { name: profile.display_name })}
                    >
                      {vouching ? <ActivityIndicator size="small" color={COLORS.text} /> : <Ionicons name="hand-left-outline" size={18} color={COLORS.text} />}
                      <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commons.vouch')}</Text>
                    </TouchableOpacity>
                  )
                )}
              </>
            ) : null}
          </View>
        )}

        {/* Report to Provian and Block: free and private, on every profile but your own. */}
        {!editing && !isOwnProfile && walletId && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => { void openReportToProvian(t, { kind: 'profile', walletId, name: profile.display_name ?? null }); }}
              accessibilityRole="button"
            >
              <Ionicons name="mail-unread-outline" size={18} color={COLORS.text} />
              <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsSafety.report')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => confirmBlock(t, walletId, profile.display_name ?? null)}
              accessibilityRole="button"
            >
              <Ionicons name="eye-off-outline" size={18} color={COLORS.text} />
              <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{t('commonsSafety.blockShort')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ─── Tier 1 Metrics ────────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>{t('commons.metrics')}</Text>
        <View style={styles.metricsGrid}>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{profile.pe_count}</Text>
            <Text style={styles.metricLabel}>{t('commons.totalPEs')}</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>
              {profile.promise_fulfillment_rate > 0
                ? `${Math.round(profile.promise_fulfillment_rate * 100)}%`
                : '--'}
            </Text>
            <Text style={styles.metricLabel}>{t('commons.fulfillment')}</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{profile.published_pe_count}</Text>
            <Text style={styles.metricLabel}>{t('commons.publishedLabel')}</Text>
          </View>
        </View>

        {/* Court Record — only when there is one (a wall of zeros tells a newcomer nothing). */}
        {(profile.court_record.cases_as_arbitrator + profile.court_record.wins + profile.court_record.losses + profile.court_record.slashing_events) > 0 && (
        <View style={styles.recordCard}>
          <Text style={styles.recordTitle}>{t('commons.courtRecord')}</Text>
          <View style={styles.recordRow}>
            <View style={styles.recordItem}>
              <Text style={styles.recordValue}>{profile.court_record.cases_as_arbitrator}</Text>
              <Text style={styles.recordLabel}>{t('commons.arbitrations')}</Text>
            </View>
            <View style={styles.recordItem}>
              <Text style={[styles.recordValue, { color: COLORS.success }]}>{profile.court_record.wins}</Text>
              <Text style={styles.recordLabel}>{t('commons.wins')}</Text>
            </View>
            <View style={styles.recordItem}>
              <Text style={[styles.recordValue, { color: COLORS.error }]}>{profile.court_record.losses}</Text>
              <Text style={styles.recordLabel}>{t('commons.losses')}</Text>
            </View>
            <View style={styles.recordItem}>
              <Text style={[styles.recordValue, { color: COLORS.warning }]}>{profile.court_record.slashing_events}</Text>
              <Text style={styles.recordLabel}>{t('commons.slashes')}</Text>
            </View>
          </View>
        </View>
        )}

        {/* ─── Badges (agent achievements; record-only) ──────────────── */}
        {(profile.badges?.length ?? 0) > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('commons.badges')}</Text>
            <View style={styles.badgeGrid}>
              {profile.badges!.map(badge => (
                <View key={badge.id} style={styles.badgeChip}>
                  <Ionicons name="ribbon" size={14} color={REGISTRY_ACCENT} />
                  <Text style={styles.badgeChipText}>{badgeDisplayCopy(badge.id)}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* ─── Institution Participation ─────────────────────────────── */}
        <Text style={styles.sectionTitle}>{t('commons.participation')}</Text>
        {INSTITUTION_METRICS.map(inst => (
          <View key={inst.key} style={styles.instRow}>
            <View style={[styles.instIcon, { backgroundColor: `${inst.color}22` }]}>
              <Ionicons name={inst.icon} size={18} color={inst.color} />
            </View>
            <Text style={styles.instLabel}>{t(inst.labelKey)}</Text>
            <Text style={styles.instValue}>{inst.format(profile, t)}</Text>
          </View>
        ))}

        {/* Forum Stats */}
        <View style={styles.instRow}>
          <View style={[styles.instIcon, { backgroundColor: 'rgba(0, 230, 118, 0.14)' }]}>
            <Ionicons name="thumbs-up" size={18} color={COLORS.success} />
          </View>
          <Text style={styles.instLabel}>{t('commons.forumUpvotes')}</Text>
          <Text style={styles.instValue}>{profile.forum_upvotes_received}</Text>
        </View>

        {/* Human Jobs */}
        {profile.human_jobs_completed > 0 && (
          <View style={styles.instRow}>
            <View style={[styles.instIcon, { backgroundColor: 'rgba(255, 179, 0, 0.14)' }]}>
              <Ionicons name="star" size={18} color={COLORS.warning} />
            </View>
            <Text style={styles.instLabel}>{t('commons.avgJobRating')}</Text>
            <Text style={styles.instValue}>
              {profile.human_jobs_avg_rating > 0 ? profile.human_jobs_avg_rating.toFixed(1) : '--'}
            </Text>
          </View>
        )}

        {/* ─── Skills / Capabilities ─────────────────────────────────── */}
        {((profile.skills ?? []).length > 0 || (profile.capabilities ?? []).length > 0) && (
          <>
            <Text style={styles.sectionTitle}>{t('commons.skillsCapabilities')}</Text>
            <View style={styles.tagsContainer}>
              {[...(profile.skills ?? []), ...(profile.capabilities ?? [])].map((tag, i) => (
                <View key={i} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Availability */}
        {(editing || profile.availability) && (
          <>
            <Text style={styles.sectionTitle}>{t('commons.availability')}</Text>
            {editing ? (
              <TextInput
                style={styles.editInput}
                value={editAvailability}
                onChangeText={setEditAvailability}
                placeholder={t('commons.availabilityPlaceholder')}
                placeholderTextColor="#9CA3AF"
              />
            ) : (
              <Text style={styles.availabilityText}>{profile.availability}</Text>
            )}
          </>
        )}

        {/* ─── Published PEs ─────────────────────────────────────────── */}
        {publishedPEs.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('commons.publishedPEsCount', { count: publishedPEs.length })}</Text>
            {publishedPEs.slice(0, 5).map((pe: unknown, i) => {
              const peObj = pe as Record<string, unknown>;
              return (
                <View key={i} style={styles.peCard}>
                  <View style={styles.peHeader}>
                    <Ionicons name="cube" size={14} color={COLORS.secondary} />
                    <Text style={styles.peType}>{getActionTypeDisplay(String(peObj.action_type ?? '')).label}</Text>
                  </View>
                  {peObj.institution ? (
                    <Text style={styles.peInstitution}>{String(peObj.institution).replace(/_/g, ' ')}</Text>
                  ) : null}
                </View>
              );
            })}
          </>
        )}

        {/* ─── Vouches ───────────────────────────────────────────────── */}
        {vouches.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('commons.vouchesCount', { count: vouches.length })}</Text>
            <View style={styles.vouchesRow}>
              {vouches.slice(0, 8).map((v) => (
                <View
                  key={v.vouch_id}
                  style={styles.vouchAvatar}
                  accessible
                  accessibilityLabel={v.voucher_kind === 'agent' ? t('commons.vouchByAgent') : t('commons.vouchByPerson')}
                >
                  <Ionicons name={v.voucher_kind === 'agent' ? 'hardware-chip' : 'person'} size={16} color={v.voucher_kind === 'agent' ? COLORS.secondary : REGISTRY_ACCENT} />
                </View>
              ))}
              {vouches.length > 8 && (
                <Text style={styles.moreVouches}>+{vouches.length - 8}</Text>
              )}
            </View>
          </>
        )}

        {/* ─── Actions ───────────────────────────────────────────────── */}
        {editing && (
          <View style={styles.editActions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => {
                setEditing(false);
                setEditName(profile.display_name);
                setEditBio(profile.bio ?? '');
                setEditAvailability(profile.availability ?? '');
              }}
            >
              <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveButton, saving && styles.saveButtonDisabled]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color={COLORS.text} />
              ) : (
                <Text style={styles.saveButtonText}>{t('common.save')}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: SPACING.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  actionRow: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.l },
  safetyButton: { flex: 0, marginTop: SPACING.l, paddingHorizontal: SPACING.l },
  actionButton: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.surfaceHighlight, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: SPACING.s },
  actionPrimary: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  actionText: { color: COLORS.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  actionDone: { borderColor: COLORS.success },
  actionPrimaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
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
  editHeaderButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACING.m,
    marginTop: SPACING.l,
  },

  // Hero Card
  heroCard: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 22,
    padding: SPACING.l,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    ...SHADOWS.card,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.m,
    marginBottom: SPACING.m,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
  },
  avatarText: { fontSize: 22, fontWeight: '700', color: COLORS.primary },
  heroInfo: { flex: 1 },
  heroName: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  heroAddress: { fontSize: 12, color: '#8B929E', fontFamily: 'Menlo', marginTop: 2 },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.xs },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
  },
  agentBadge: { backgroundColor: 'rgba(0, 229, 255, 0.15)' },
  humanBadge: { backgroundColor: 'rgba(0, 230, 118, 0.15)' },
  typeText: { fontSize: 11, fontWeight: '500', textTransform: 'capitalize' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 11, fontWeight: '500' },

  // Attestation Banner
  attestBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    padding: SPACING.s,
    borderRadius: 14,
    marginBottom: SPACING.s,
  },
  attestText: { fontSize: 12, fontWeight: '600' },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 'auto' },
  verifiedText: { fontSize: 11, color: COLORS.success, fontWeight: '500' },

  bioText: { fontSize: 14, color: '#8B929E', lineHeight: 20, marginBottom: SPACING.s },
  joinDate: { fontSize: 11, color: '#9CA3AF' },

  // Edit
  editInput: {
    backgroundColor: 'rgba(18,21,26,0.60)',
    borderRadius: 14,
    padding: SPACING.m,
    color: COLORS.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(42,48,56,1)',
    marginBottom: SPACING.s,
  },
  bioInput: { minHeight: 80, textAlignVertical: 'top' },

  // Metrics Grid
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.s,
  },
  metricCard: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 18,
    padding: SPACING.m,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    ...SHADOWS.card,
  },
  metricValue: { fontSize: 22, fontWeight: '700', color: COLORS.text },
  metricLabel: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },

  // Court Record
  recordCard: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 18,
    padding: SPACING.m,
    marginTop: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    ...SHADOWS.card,
  },
  recordTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACING.s,
  },
  recordRow: { flexDirection: 'row' },
  recordItem: { flex: 1, alignItems: 'center' },
  recordValue: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  recordLabel: { fontSize: 10, color: '#9CA3AF', marginTop: 2 },

  // Institution Rows
  instRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.s + 2,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(200,205,214,0.08)',
  },
  instIcon: {
    width: 34,
    height: 34,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.m,
  },
  instLabel: { flex: 1, fontSize: 14, color: COLORS.text },
  instValue: { fontSize: 14, fontWeight: '600', color: '#8B929E' },

  // Tags
  tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  tag: {
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.s,
  },
  tagText: { fontSize: 12, color: COLORS.primaryLight },

  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginBottom: SPACING.m },
  badgeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(74, 142, 232, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: BORDER_RADIUS.s,
    borderWidth: 1,
    borderColor: 'rgba(74, 142, 232, 0.25)',
  },
  badgeChipText: { fontSize: 12, color: COLORS.primaryLight, fontWeight: '600' },

  availabilityText: { fontSize: 14, color: '#8B929E' },

  // PE Cards
  peCard: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 14,
    padding: SPACING.s,
    marginBottom: SPACING.xs,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
  },
  peHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  peType: { fontSize: 12, color: COLORS.secondary, fontFamily: 'monospace' },
  peInstitution: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },

  // Vouches
  vouchesRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  vouchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreVouches: { fontSize: 12, color: '#8B929E', marginLeft: SPACING.xs },

  // Edit Actions
  editActions: {
    flexDirection: 'row',
    gap: SPACING.m,
    marginTop: SPACING.l,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: SPACING.m,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    alignItems: 'center',
  },
  cancelButtonText: { fontSize: 15, color: '#8B929E', fontWeight: '500' },
  saveButton: {
    flex: 1,
    paddingVertical: SPACING.m,
    borderRadius: 28,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    shadowColor: '#4A8EE8',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { fontSize: 15, color: COLORS.text, fontWeight: '600' },


  // Empty
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxxl,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m, textAlign: 'center', paddingHorizontal: SPACING.l },
});
