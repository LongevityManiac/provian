import { PublicStandingLine } from '../../../components/commons/PublicStandingLine';
import { ActionTouchable, DestinationRow, PrimaryAction } from '../../../components/ScreenActions';
/**
 * Commons › Inbox : everything waiting on you in one list — messages, replies to your posts
 * and comments, and requests to publish a shared record. Filter chips narrow it; tapping opens the
 * conversation, the comment in its thread, or the request.
 */
import React, { useCallback, useMemo, useState, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, BORDER_RADIUS, GLASS } from '../../../constants/theme';
import { shortAddress } from '../../../utils/shortAddress';
import { timeAgo } from '../../../utils/timeAgo';
import useCommonsStore from '../../../store/commonsStore';
import * as CommonsService from '../../../core/commons/CommonsService';
import { buildInbox, filterInbox, REPLIES_SEEN_KEY, type InboxFilter, type InboxItem } from '../../../core/commons/inbox';
import { FLOATING_TAB_BAR_CLEARANCE } from './layout';

interface Props {
  navigation: { navigate: (screen: string, params?: Record<string, unknown>) => void };
  /**
   * True only while the Inbox is the selected Commons tab. The shell keeps visited tabs mounted (and
   * hidden), so a hidden Inbox must never load-and-mark-seen on a Commons refocus — that would clear
   * the badge for replies nobody looked at .
   */
  active: boolean;
}

const FILTERS: { key: InboxFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'commonsHome.inboxAll' },
  { key: 'messages', labelKey: 'commonsHome.inboxMessages' },
  { key: 'replies', labelKey: 'commonsHome.inboxReplies' },
  { key: 'requests', labelKey: 'overhaul.needsYourOk' },
];

export default function CommonsInboxTab({ navigation, active }: Props) {
  const { t } = useTranslation();
  const profile = useCommonsStore((s) => s.profile);
  const refreshNotifications = useCommonsStore((s) => s.refreshNotifications);
  const markRepliesSeen = useCommonsStore((s) => s.markRepliesSeen);
  const myId = profile?.wallet_id ?? null;

  const [standing, setStanding] = useState<{
    threads: CommonsService.ThreadPresentationRequest[];
    challenges: CommonsService.CommonsChallenge[];
  }>({ threads: [], challenges: [] });
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const visibleRef = useRef(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current || !visibleRef.current) return;
    loadingRef.current = true;
    try {
      const [threads, replyPage, consents, seenRaw, requests, challenges] = await Promise.all([
        CommonsService.listThreads().then((r) => r.threads),
        CommonsService.getMyReplies({ page_size: 50 }),
        CommonsService.getPendingConsents().then((r) => r.consents),
        AsyncStorage.getItem(REPLIES_SEEN_KEY),
        CommonsService.getPendingThreadPresentationRequests().then(answer => answer.requests).catch(() => []),
        CommonsService.getMyChallenges().then(answer => answer.challenges).catch(() => []),
      ]);
      const replies = [...replyPage.replies];
      let cursor = replyPage.next_cursor;
      const seenAt = Number(seenRaw) || 0;
      const cursors = new Set<string>();
      while (cursor && replies.every((reply) => reply.created_at > seenAt)) {
        if (cursors.has(cursor)) throw new Error('replies cursor did not advance');
        cursors.add(cursor);
        const page = await CommonsService.getMyReplies({ page_size: 50, cursor });
        replies.push(...page.replies);
        cursor = page.next_cursor;
      }
      if (!visibleRef.current) return;
      setItems(buildInbox({ myId, threads, replies, consents, repliesSeenAt: Number(seenRaw) || 0 }));
      setLoadError(false);
      const now = Date.now();
      setStanding({
        threads: requests.filter(request => request.thread_id && request.status === 'challenged'
          && request.audience && request.challenge && request.expires_at_ms > now),
        challenges: challenges.filter(challenge => challenge.status === 'open' && challenge.window_expires_at > now),
      });
      const newestReply = replies.reduce((at, reply) => Math.max(at, reply.created_at), 0);
      if (newestReply > 0) await markRepliesSeen(newestReply);
      else void refreshNotifications();
    } catch {
      if (visibleRef.current) setLoadError(true);
    } finally {
      loadingRef.current = false;
    }
  }, [myId, markRepliesSeen, refreshNotifications]);

  useFocusEffect(useCallback(() => {
    visibleRef.current = active;
    if (active) void load();
    return () => { visibleRef.current = false; };
  }, [active, load]));

  const onRefresh = async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } };

  const visible = useMemo(() => (items ? filterInbox(items, filter) : []), [items, filter]);

  const open = (item: InboxItem) => {
    if (item.kind === 'message') {
      navigation.navigate('CommonsThread', { threadId: item.threadId, counterpartyName: item.counterpartyName ?? undefined });
    } else if (item.kind === 'reply') {
      navigation.navigate('CommonsForumPost', { postId: item.postId, focusCommentId: item.commentId });
    } else {
      navigation.navigate('CommonsConsentRequests');
    }
  };

  const renderItem = ({ item }: { item: InboxItem }) => {
    let icon: React.ComponentProps<typeof Ionicons>['name'] = 'mail-outline';
    let title = '';
    let body = '';
    if (item.kind === 'message') {
      icon = item.counterpartyKind === 'agent' ? 'hardware-chip-outline' : 'person-outline';
      title = item.counterpartyName ?? shortAddress(item.counterpartyId);
      body = t('commonsHome.inboxMessageLine', {
        about: t(`commons.anchor_${item.anchorKind}`, { defaultValue: item.anchorKind }),
        count: item.messageCount,
      });
    } else if (item.kind === 'reply') {
      icon = 'chatbubble-ellipses-outline';
      title = item.rootTitle
        ? t('commonsHome.inboxReplyOn', { who: item.authorName ?? shortAddress(item.authorId), title: item.rootTitle })
        : t('commonsHome.inboxReplyTo', { who: item.authorName ?? shortAddress(item.authorId) });
      body = item.preview;
    } else {
      icon = 'shield-checkmark-outline';
      title = t('commonsHome.inboxRequestTitle');
      body = t('commonsHome.inboxRequestLine', { who: shortAddress(item.requesterId) });
    }
    return (
      <ActionTouchable
        style={[styles.row, item.unread && styles.rowUnread]}
        onPress={() => open(item)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${body}`}
      >
        <View style={styles.rowIcon}>
          <Ionicons name={icon} size={18} color={COLORS.primary} />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.rowTitle, item.unread && styles.rowTitleUnread]} numberOfLines={1}>{title}</Text>
            <Text style={styles.rowTime}>{timeAgo(item.at, t)}</Text>
          </View>
          {item.kind !== 'request' && <PublicStandingLine
            walletId={item.kind === 'message' ? item.counterpartyId : item.authorId}
            kind={item.kind === 'message' ? item.counterpartyKind : item.authorKind}
            onPress={() => navigation.navigate('CommonsProfile', {
              walletId: item.kind === 'message' ? item.counterpartyId : item.authorId,
            })} />}
          <Text style={styles.rowSub} numberOfLines={2}>{body}</Text>
        </View>
        {item.unread && <View style={styles.unreadDot} />}
      </ActionTouchable>
    );
  };

  if (!profile) {
    return (
      <View style={styles.center}>
        <Ionicons name="mail-outline" size={40} color={COLORS.textTertiary} />
        <Text style={styles.emptyTitle}>{t('commonsHome.inboxJoinTitle')}</Text>
        <Text style={styles.emptyText}>{t('commonsHome.inboxJoinBody')}</Text>
        <PrimaryAction label={t('commonsDashboard.createProfile')} onPress={() => navigation.navigate('CommonsOnboarding')} />
      </View>
    );
  }

  return (
    <FlatList
      data={visible}
      keyExtractor={(i) => i.id}
      renderItem={renderItem}

      ListHeaderComponent={
        <View>
          <ActionTouchable style={styles.primaryButton} onPress={() => navigation.navigate('CommonsNewMessage')} accessibilityRole="button">
            <Text style={styles.primaryButtonText}>{t('commons.newMessageTitle')}</Text>
          </ActionTouchable>
          {loadError && <View style={styles.center} accessibilityRole="alert">
            <Text style={styles.emptyTitle}>{t('commonsHome.inboxLoadFailed')}</Text>
            <ActionTouchable onPress={onRefresh} accessibilityRole="button">
              <Text style={styles.chipText}>{t('common.tryAgain')}</Text>
            </ActionTouchable>
          </View>}
        <View style={styles.chips}>
          {FILTERS.map((f) => (
            <ActionTouchable
              key={f.key}
              style={[styles.chip, filter === f.key && styles.chipActive]}
              onPress={() => setFilter(f.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === f.key }}
            >
              <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>{t(f.labelKey)}</Text>
            </ActionTouchable>
          ))}
        </View>
        {(filter === 'all' || filter === 'requests') && <View>
          {standing.threads.map(request => <DestinationRow key={request.request_id}
            icon="proof" label={t('commonsHome.showStanding')} onPress={() => navigation.navigate('HumanPresentment', {
              audience: request.audience, challenge: request.challenge, predicates: request.predicates ?? [],
              challengeEnvelope: request.challenge_envelope,
              deliverTo: { kind: 'thread', threadId: request.thread_id, requestId: request.request_id },
            })} />)}
          {standing.challenges.map(request => <DestinationRow key={request.challenge_id}
            icon="proof" label={t('commonsHome.showStanding')} onPress={() => navigation.navigate('HumanPresentment', {
              audience: request.audience, challenge: request.challenge_nonce, predicates: [request.predicate],
              deliverTo: { kind: 'challenge', challengeId: request.challenge_id },
            })} />)}
        </View>}
        </View>
      }
      ListEmptyComponent={
        loadError ? null : items === null ? (
          <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
        ) : (
          <View style={styles.center}>
            <Ionicons name="checkmark-done-outline" size={40} color={COLORS.textTertiary} />
            <Text style={styles.emptyTitle}>{t('commonsHome.inboxEmptyTitle')}</Text>
            <Text style={styles.emptyText}>{t('commonsHome.inboxEmptyBody')}</Text>
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: SPACING.m, paddingBottom: FLOATING_TAB_BAR_CLEARANCE },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginBottom: SPACING.m, marginTop: SPACING.xs },
  chip: { paddingHorizontal: 14, minHeight: 34, justifyContent: 'center', borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.surfaceHighlight },
  chipActive: { backgroundColor: COLORS.primaryMuted, borderWidth: 1, borderColor: COLORS.primary },
  chipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: COLORS.text },
  row: { ...GLASS.card, flexDirection: 'row', alignItems: 'center', padding: SPACING.m, marginBottom: SPACING.s, gap: SPACING.m },
  rowUnread: { borderColor: COLORS.primary },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primaryMuted },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '500', color: COLORS.text },
  rowTitleUnread: { fontWeight: '700' },
  rowTime: { fontSize: 12, color: COLORS.textTertiary },
  rowSub: { fontSize: 13, color: COLORS.textSecondary, marginTop: 3, lineHeight: 18 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: COLORS.primary },
  center: { alignItems: 'center', paddingVertical: SPACING.xxl, paddingHorizontal: SPACING.l, gap: SPACING.s },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  primaryButton: { marginTop: SPACING.m, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.round, paddingHorizontal: SPACING.l, minHeight: 44, justifyContent: 'center' },
  primaryButtonText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: '600' },
});
