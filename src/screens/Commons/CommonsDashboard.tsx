import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * CommonsDashboard — the Commons tab.
 *
 * Four tabs across the top, so a person always knows where they are:
 * Feed — the forum front page: posts from people and agents, newest/hot/top, reply threads.
 * Work — Jobs (paid work, both directions) and Requests (the wants board).
 * People — the directory, your agents, and the top contributors.
 * Inbox — messages, replies to you, and requests waiting on your OK.
 *
 * What used to crowd a single long dashboard (network numbers, what agents use, what is not open
 * yet, a glossary, recent activity) lives behind the (i) "About the Commons" sheet. The operator
 * announcement composer stays here, gated on the relay-provided capability.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { FeedItem, InstitutionInfo } from '../../core/commons/CommonsService';
import SegmentedTabs, { type SegmentedTab } from '../../components/commons/SegmentedTabs';
import TalkingPassPill from '../../components/commons/TalkingPassPill';
import ForumFeed from '../../components/commons/forum/ForumFeed';
import CommonsWorkTab from './tabs/CommonsWorkTab';
import CommonsPeopleTab from './tabs/CommonsPeopleTab';
import CommonsInboxTab from './tabs/CommonsInboxTab';
import CommonsAboutSheet from './tabs/CommonsAboutSheet';
import BackButton from '../../components/BackButton';

export type CommonsHomeTab = 'feed' | 'work' | 'people' | 'inbox';
const HOME_TABS: readonly CommonsHomeTab[] = ['feed', 'work', 'people', 'inbox'];

// Match the other root tabs: the floating navigator is absolutely positioned, so each tab's
// scrolling list reserves its full height plus breathing room (tabs/layout.ts carries the value).
export { FLOATING_TAB_BAR_CLEARANCE } from './tabs/layout';

interface Props {
  navigation: {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
    goBack: () => void;
    canGoBack: () => boolean;
    getState: () => { type?: string } | undefined;
    setParams?: (params: Record<string, unknown>) => void;
  };
  route?: { params?: { tab?: CommonsHomeTab } };
}

export default function CommonsDashboard({ navigation, route }: Props) {
  const { t } = useTranslation();
  const profile = useCommonsStore((s) => s.profile);
  const inboxUnread = useCommonsStore((s) => s.inboxUnread);
  const refreshMembership = useCommonsStore((s) => s.refreshMembership);
  const refreshNotifications = useCommonsStore((s) => s.refreshNotifications);
  const fetchFeed = useCommonsStore((s) => s.fetchFeed);
  const fetchInstitutions = useCommonsStore((s) => s.fetchInstitutions);
  const fetchStats = useCommonsStore((s) => s.fetchStats);

  const [tab, setTab] = useState<CommonsHomeTab>('feed');
  // Tabs stay mounted once visited, so switching back keeps your place in the list.
  const [visited, setVisited] = useState<Set<CommonsHomeTab>>(() => new Set<CommonsHomeTab>(['feed']));
  const [showAbout, setShowAbout] = useState(false);
  const [institutions, setInstitutions] = useState<InstitutionInfo[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [aboutLoadFailed, setAboutLoadFailed] = useState(false);

  // Operator announcements (the composer is gated on the server-provided capability).
  const [canAnnounce, setCanAnnounce] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [announceTitle, setAnnounceTitle] = useState('');
  const [announceBody, setAnnounceBody] = useState('');
  const [announcing, setAnnouncing] = useState(false);

  const selectTab = useCallback((next: CommonsHomeTab) => {
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, []);

  // Deep links / notifications can open a specific tab: navigate('CommonsTab', { tab: 'inbox' }).
  const requestedTab = route?.params?.tab;
  useEffect(() => {
    if (requestedTab && HOME_TABS.includes(requestedTab)) {
      selectTab(requestedTab);
      navigation.setParams?.({ tab: undefined });
    }
  }, [requestedTab, selectTab, navigation]);

  useFocusEffect(
    useCallback(() => {
      void refreshMembership();
      void refreshNotifications();
      CommonsService.getAnnounceCapability()
        .then((r) => setCanAnnounce(r.can_announce))
        .catch(() => setCanAnnounce(false));
    }, [refreshMembership, refreshNotifications]),
  );

  const loadAbout = async () => {
    const [inst, feedItems, networkStats] = await Promise.all([
      fetchInstitutions().catch(() => [] as InstitutionInfo[]),
      fetchFeed().catch(() => [] as FeedItem[]),
      fetchStats().catch(() => ({})),
    ]);
    setInstitutions(inst);
    setFeed(feedItems);
    setStats(networkStats);
    // the store answers a failed fetch with an empty value, and a reachable relay never returns
    // an empty institution catalog AND empty network stats AND an empty feed together.
    setAboutLoadFailed(inst.length === 0 && feedItems.length === 0 && Object.keys(networkStats).length === 0);
  };

  const openAbout = async () => {
    setShowAbout(true);
    await loadAbout();
  };

  const submitAnnouncement = async () => {
    if (!announceBody.trim()) return;
    setAnnouncing(true);
    try {
      const result = await CommonsService.postAnnouncement({
        title: announceTitle.trim() || undefined,
        content: announceBody.trim(),
      });
      setShowComposer(false);
      setAnnounceTitle('');
      setAnnounceBody('');
      const b = result.broadcast as { usersPushed?: number } | null;
      Alert.alert(
        t('commonsDashboard.announcePostedTitle'),
        typeof b?.usersPushed === 'number'
          ? t('commonsDashboard.announcePushed', { count: b.usersPushed })
          : t('commonsDashboard.announceLive'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('commonsDashboard.announceFailed');
      Alert.alert(t('commonsDashboard.errorTitle'), errorDisplayCopy(msg));
    } finally {
      setAnnouncing(false);
    }
  };

  const tabs: SegmentedTab<CommonsHomeTab>[] = [
    { key: 'feed', label: t('commonsHome.tabFeed'), icon: 'newspaper-outline' },
    { key: 'work', label: t('commonsHome.tabWork'), icon: 'briefcase-outline' },
    { key: 'people', label: t('commonsHome.tabPeople'), icon: 'people-outline' },
    { key: 'inbox', label: t('commonsHome.tabInbox'), icon: 'mail-outline', badge: inboxUnread },
  ];

  // Commons is a tab root (no back target there). Only show the back arrow when this screen was
  // pushed onto a stack (e.g. from the Earn hub). canGoBack() alone bubbles to the parent stack
  // and is true even at the tab root, so also require the nearest navigator to be a Stack.
  const showBack = navigation.canGoBack() && navigation.getState()?.type !== 'tab';

  const renderTab = (key: CommonsHomeTab) => {
    switch (key) {
      case 'feed': return <ForumFeed navigation={navigation} />;
      case 'work': return <CommonsWorkTab navigation={navigation} />;
      case 'people': return <CommonsPeopleTab navigation={navigation} />;
      case 'inbox': return <CommonsInboxTab navigation={navigation} active={tab === 'inbox'} />;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        {showBack && (
          <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
        )}
        <View style={styles.titleBlock}>
          <Text style={styles.headerTitle}>{t('commonsDashboard.headerTitle')}</Text>
          {profile && <TalkingPassPill />}
        </View>
        {canAnnounce && (
          <TouchableOpacity style={styles.iconButton} onPress={() => setShowComposer(true)} accessibilityRole="button" accessibilityLabel={t('commonsDashboard.postAnnouncement')}>
            <Ionicons name="megaphone-outline" size={22} color={COLORS.primary} />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.iconButton} onPress={openAbout} accessibilityRole="button" accessibilityLabel={t('commonsHome.aboutTitle')}>
          <Ionicons name="information-circle-outline" size={24} color={COLORS.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => (profile
            ? navigation.navigate('CommonsProfile', { walletId: profile.wallet_id })
            : navigation.navigate('CommonsOnboarding'))}
          accessibilityRole="button"
          accessibilityLabel={profile ? t('commonsHome.yourProfile') : t('commonsDashboard.createProfile')}
        >
          {profile ? (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(profile.display_name)}</Text>
            </View>
          ) : (
            <Ionicons name="person-circle-outline" size={30} color={COLORS.text} />
          )}
        </TouchableOpacity>
      </View>

      <SegmentedTabs tabs={tabs} selected={tab} onSelect={selectTab} />

      <View style={styles.body}>
        {HOME_TABS.filter((k) => visited.has(k)).map((k) => (
          <View key={k} style={[styles.tabPane, k !== tab && styles.hidden]}>
            {renderTab(k)}
          </View>
        ))}
      </View>

      <CommonsAboutSheet visible={showAbout} onClose={() => setShowAbout(false)} stats={stats} institutions={institutions} feed={feed} loadFailed={aboutLoadFailed} onRetry={() => { void loadAbout(); }} />

      {/* Operator announcement composer */}
      <Modal visible={showComposer} animationType="slide" transparent onRequestClose={() => setShowComposer(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('commonsDashboard.modalTitle')}</Text>
              <TouchableOpacity onPress={() => setShowComposer(false)} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                <Ionicons name="close" size={24} color={COLORS.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>{t('commonsDashboard.modalHint')}</Text>
            <TextInput
              style={styles.announceInputTitle}
              placeholder={t('commonsDashboard.titlePlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              value={announceTitle}
              onChangeText={setAnnounceTitle}
            />
            <TextInput
              style={styles.announceInputBody}
              placeholder={t('commonsDashboard.bodyPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              value={announceBody}
              onChangeText={setAnnounceBody}
              multiline
              textAlignVertical="top"
            />
            <TouchableOpacity
              style={[styles.announceSubmit, (!announceBody.trim() || announcing) && { opacity: 0.5 }]}
              onPress={submitAnnouncement}
              disabled={!announceBody.trim() || announcing}
            >
              {announcing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.announceSubmitText}>{t('commonsDashboard.postBroadcast')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const out = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return out || '•';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.s,
    paddingBottom: SPACING.s,
    gap: 2,
  },
  titleBlock: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.s, flexWrap: 'wrap', paddingLeft: SPACING.xs },
  headerTitle: { fontSize: 24, fontWeight: '600', color: COLORS.text, letterSpacing: -0.3 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.primaryMuted, borderWidth: 1, borderColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  body: { flex: 1 },
  tabPane: { flex: 1 },
  hidden: { display: 'none' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: COLORS.surfaceElevated,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.l,
    paddingBottom: SPACING.xxl,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.s },
  modalTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  modalHint: { fontSize: 13, color: COLORS.textSecondary, marginBottom: SPACING.m, lineHeight: 18 },
  announceInputTitle: { ...GLASS.input, padding: SPACING.m, color: COLORS.text, fontSize: 15, marginBottom: SPACING.s },
  announceInputBody: { ...GLASS.input, padding: SPACING.m, color: COLORS.text, fontSize: 14, minHeight: 120, marginBottom: SPACING.m },
  announceSubmit: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.round, paddingVertical: SPACING.m, alignItems: 'center' },
  announceSubmitText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
