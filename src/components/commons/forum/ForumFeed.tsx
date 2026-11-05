/**
 * ForumFeed (§2) — the Commons forum front page, Reddit-style. No header or back button of its
 * own: the Commons shell embeds it in its Feed tab, and the CommonsForum route wraps it in a header.
 *
 * - Topic chips (All, General, Introductions, …, and "More topics" for the quiet channels).
 * `announcements` is never a chip: its newest post is the pinned card at the top.
 * - Sort: Hot · New · Top (Today / Week / All).
 * - A FlatList with cursor paging, pull-to-refresh, and loading / empty / error states that never
 * flash "empty" before the first page resolves.
 * - A compose button for members; visitors see "Join to post and reply — reading is free".
 * - Falls back to the legacy relay routes when `/forum/posts` is missing (forumFeedSource).
 */
import { useCommonsBlockStore, withoutBlocked } from '../../../store/commonsBlockStore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../../constants/theme';
import useCommonsStore from '../../../store/commonsStore';
import * as CommonsService from '../../../core/commons/CommonsService';
import {
  appendUnique,
  MORE_TOPICS,
  PRIMARY_TOPICS,
  topicIcon,
  topicLabelKey,
  type FeedSort,
  type FeedWindow,
  type NormalizedForumPost,
} from '../../../core/commons/forumModel';
import { loadFeedPage, loadLatestAnnouncement, type FeedDeps } from '../../../core/commons/forumFeedSource';
import PostCard from './PostCard';
import OverflowMenu, { type OverflowAction } from './OverflowMenu';
import ChallengeSheet from './ChallengeSheet';
import { authorName } from './AuthorLine';
import { useForumWrites } from './useForumWrites';

type Navigator = { navigate: (screen: string, params?: Record<string, unknown>) => void };

interface Props {
  navigation: Navigator;
  /** Inside the Commons tab (the tab bar is visible): reserve room for it. Default true. */
  embedded?: boolean;
}

/** Room the floating tab bar needs under an embedded list (matches the Commons dashboard). */
const TAB_BAR_CLEARANCE = 120;
/** A feed older than this reloads when the screen regains focus. */
const STALE_MS = 60_000;

const FEED_DEPS: FeedDeps = {
  getForumPosts: (p) => CommonsService.getForumPosts(p),
  getChannelPosts: (c, p) => CommonsService.getChannelPosts(c, p),
};

let feedInvalidatedAt = 0;
/** Mark every mounted feed stale (e.g. after posting) so it reloads on focus. */
export function invalidateForumFeed(): void {
  feedInvalidatedAt = Date.now();
}

type LoadState = 'loading' | 'ready' | 'error';

export default function ForumFeed({ navigation, embedded = true }: Props) {
  const { t } = useTranslation();
  const joined = useCommonsStore((s) => s.profile !== null);
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);

  const [channel, setChannel] = useState<string>('all');
  const [sort, setSort] = useState<FeedSort>('hot');
  const [timeWindow, setTimeWindow] = useState<FeedWindow>('week');
  const [showMore, setShowMore] = useState(false);

  const [posts, setPosts] = useState<NormalizedForumPost[]>([]);
  // Posts by an author this person blocked are not shown on this phone.
  const blocked = useCommonsBlockStore((st) => st.blocked);
  const visiblePosts = useMemo(() => withoutBlocked(posts, blocked), [posts, blocked]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [announcement, setAnnouncement] = useState<NormalizedForumPost | null>(null);
  const [menuPost, setMenuPost] = useState<NormalizedForumPost | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const requestSeq = useRef(0);
  const loadedAt = useRef(0);

  const updatePost = useCallback((postId: string, fn: (p: NormalizedForumPost) => NormalizedForumPost) => {
    setPosts((prev) => prev.map((p) => (p.post_id === postId ? fn(p) : p)));
    setAnnouncement((a) => (a && a.post_id === postId ? fn(a) : a));
  }, []);

  const writes = useForumWrites({ owner: 'feed', navigation, joined, updatePost });

  /** Load the first page for the current topic + sort (replacing the list). */
  const loadFirst = useCallback(async (mode: 'initial' | 'refresh') => {
    const seq = ++requestSeq.current;
    if (mode === 'initial') setState('loading');
    try {
      const [page, ann] = await Promise.all([
        loadFeedPage({ channel, sort, window: timeWindow, cursor: null }, FEED_DEPS),
        loadLatestAnnouncement(FEED_DEPS),
      ]);
      if (seq !== requestSeq.current) return;
      setPosts(page.posts);
      setCursor(page.nextCursor);
      setAnnouncement(ann);
      setState('ready');
      loadedAt.current = Date.now();
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.log('[ForumFeed] load failed:', err instanceof Error ? err.message : err);
      setState((s) => (mode === 'refresh' && s === 'ready' ? s : 'error'));
    }
  }, [channel, sort, timeWindow]);

  useEffect(() => {
    void loadFirst('initial');
  }, [loadFirst]);

  useFocusEffect(
    useCallback(() => {
      const stale = Date.now() - loadedAt.current > STALE_MS || feedInvalidatedAt > loadedAt.current;
      if (loadedAt.current > 0 && stale) void loadFirst('refresh');
    }, [loadFirst]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirst('refresh');
    setRefreshing(false);
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || state !== 'ready') return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await loadFeedPage({ channel, sort, window: timeWindow, cursor }, FEED_DEPS);
      if (seq !== requestSeq.current) return;
      setPosts((prev) => appendUnique(prev, page.posts));
      setCursor(page.nextCursor);
    } catch (err) {
      console.log('[ForumFeed] next page failed:', err instanceof Error ? err.message : err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, state, channel, sort, timeWindow]);

  const openPost = useCallback((p: NormalizedForumPost) => {
    navigation.navigate('CommonsForumPost', { postId: p.post_id, channel: p.channel });
  }, [navigation]);

  const openAuthor = writes.viewProfile;
  const openMenu = useCallback((p: NormalizedForumPost) => {
    setMenuPost(p);
    setMenuOpen(true);
  }, []);

  const onMenuSelect = useCallback((a: OverflowAction) => {
    const p = menuPost;
    if (!p) return;
    if (a === 'report') writes.report(p);
    else if (a === 'reportToProvian') writes.reportToProvian(p);
    else if (a === 'block') writes.blockAuthor(p);
    else if (a === 'question') void writes.question(p);
    else if (a === 'message') writes.messageAuthor(p);
    else writes.viewProfile(p);
  }, [menuPost, writes]);

  const compose = useCallback(() => {
    navigation.navigate('CommonsCompose', { channel: channel === 'all' ? 'general' : channel });
  }, [navigation, channel]);

  const pickTopic = (c: string) => {
    if (c === channel) return;
    setChannel(c);
  };

  const topicChips = useMemo(() => ['all', ...PRIMARY_TOPICS], []);
  const moreSelected = (MORE_TOPICS as readonly string[]).includes(channel);

  const renderChip = (c: string) => {
    const active = c === channel;
    const label = c === 'all' ? t('commonsForum.topic.all') : t(topicLabelKey(c));
    return (
      <TouchableOpacity
        key={c}
        style={[styles.chip, active && styles.chipActive]}
        onPress={() => pickTopic(c)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
      >
        {c !== 'all' && <Ionicons name={topicIcon(c)} size={14} color={active ? COLORS.text : COLORS.textSecondary} />}
        <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const header = (
    <View>
      {!joined && (
        <TouchableOpacity style={styles.joinBanner} onPress={() => navigation.navigate('CommonsOnboarding')} accessibilityRole="button">
          <Ionicons name="people-outline" size={20} color={COLORS.primaryLight} />
          <Text style={styles.joinText}>{t('commonsForum.join.banner')}</Text>
          <Text style={styles.joinCta}>{t('commonsForum.join.cta')}</Text>
        </TouchableOpacity>
      )}
      {announcement && (
        <TouchableOpacity style={styles.announcement} onPress={() => openPost(announcement)} accessibilityRole="button">
          <View style={styles.annHead}>
            <Ionicons name="megaphone-outline" size={14} color={COLORS.warning} />
            <Text style={styles.annLabel}>{t('commonsForum.announcement.label')}</Text>
          </View>
          <Text style={styles.annTitle} numberOfLines={2}>{announcement.title || announcement.content}</Text>
          {announcement.title ? <Text style={styles.annBody} numberOfLines={2}>{announcement.content}</Text> : null}
        </TouchableOpacity>
      )}
    </View>
  );

  const empty = state === 'loading' ? (
    <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
  ) : state === 'error' ? (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={36} color={COLORS.textTertiary} />
      <Text style={styles.emptyTitle}>{t('commonsForum.feed.errorTitle')}</Text>
      <TouchableOpacity style={styles.retry} onPress={() => void loadFirst('initial')} accessibilityRole="button">
        <Text style={styles.retryText}>{t('common.tryAgain')}</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <View style={styles.center}>
      <Ionicons name="chatbubbles-outline" size={36} color={COLORS.textTertiary} />
      <Text style={styles.emptyTitle}>{t('commonsForum.feed.emptyTitle')}</Text>
      <Text style={styles.emptyBody}>{joined ? t('commonsForum.feed.emptyBody') : t('commonsForum.feed.emptyBodyVisitor')}</Text>
    </View>
  );

  // Room for the floating tab bar (embedded) and the compose button, so the last card is reachable.
  const bottomPad = (embedded ? TAB_BAR_CLEARANCE : 0) + (joined ? 56 + SPACING.xl : SPACING.l);

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {topicChips.map(renderChip)}
          <TouchableOpacity
            style={[styles.chip, (showMore || moreSelected) && styles.chipOutline]}
            onPress={() => setShowMore((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showMore || moreSelected }}
          >
            <Text style={styles.chipText}>{t('commonsForum.topic.more')}</Text>
            <Ionicons name={showMore || moreSelected ? 'chevron-up' : 'chevron-down'} size={14} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </ScrollView>
        {(showMore || moreSelected) && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {MORE_TOPICS.map(renderChip)}
          </ScrollView>
        )}
        <View style={styles.sortRow}>
          {(['hot', 'new', 'top'] as FeedSort[]).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.sortBtn, sort === s && styles.sortBtnActive]}
              onPress={() => setSort(s)}
              accessibilityRole="tab"
              accessibilityState={{ selected: sort === s }}
            >
              <Ionicons
                name={s === 'hot' ? 'flame-outline' : s === 'new' ? 'sparkles-outline' : 'trophy-outline'}
                size={14}
                color={sort === s ? COLORS.primaryLight : COLORS.textSecondary}
              />
              <Text style={[styles.sortText, sort === s && styles.sortTextActive]}>{t(`commonsForum.sort.${s}`)}</Text>
            </TouchableOpacity>
          ))}
          {sort === 'top' && (
            <View style={styles.windowRow}>
              {(['day', 'week', 'all'] as FeedWindow[]).map((w) => (
                <TouchableOpacity
                  key={w}
                  style={[styles.windowBtn, timeWindow === w && styles.windowBtnActive]}
                  onPress={() => setTimeWindow(w)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: timeWindow === w }}
                >
                  <Text style={[styles.windowText, timeWindow === w && styles.sortTextActive]}>{t(`commonsForum.window.${w}`)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </View>

      <FlatList
        data={state === 'ready' ? visiblePosts : []}
        keyExtractor={(p) => p.post_id}
        renderItem={({ item }) => (
          <PostCard post={item} onOpen={openPost} onVote={writes.vote} onMore={openMenu} onAuthor={openAuthor} showTopic={channel === 'all'} />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ marginVertical: SPACING.m }} color={COLORS.primary} /> : null}
        contentContainerStyle={[styles.list, { paddingBottom: bottomPad }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        initialNumToRender={8}
        windowSize={9}
      />

      {joined && (
        <TouchableOpacity
          style={[styles.fab, { bottom: embedded ? TAB_BAR_CLEARANCE + SPACING.m : SPACING.xl }]}
          onPress={compose}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('commonsForum.compose.fab')}
        >
          <Ionicons name="add" size={28} color={COLORS.text} />
        </TouchableOpacity>
      )}

      <OverflowMenu
        visible={menuOpen}
        authorName={menuPost ? authorName(menuPost) : ''}
        isMine={!!menuPost && menuPost.author_wallet_id === myId}
        canQuestion
        onClose={() => setMenuOpen(false)}
        onSelect={onMenuSelect}
      />
      <ChallengeSheet {...writes.challenge} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { paddingTop: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  chipRow: { paddingHorizontal: SPACING.m, gap: SPACING.s, paddingBottom: SPACING.s },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACING.m,
    minHeight: 36,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipOutline: { borderColor: COLORS.borderFocus },
  chipText: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, fontWeight: '600' },
  chipTextActive: { color: COLORS.text },
  sortRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.m, paddingBottom: SPACING.s, gap: SPACING.xs, flexWrap: 'wrap' },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: SPACING.s + 2, minHeight: 36, borderRadius: BORDER_RADIUS.round },
  sortBtnActive: { backgroundColor: COLORS.primaryMuted },
  sortText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  sortTextActive: { color: COLORS.primaryLight },
  windowRow: { flexDirection: 'row', marginLeft: 'auto', gap: 2 },
  windowBtn: { paddingHorizontal: SPACING.s, minHeight: 36, justifyContent: 'center', borderRadius: BORDER_RADIUS.round },
  windowBtnActive: { backgroundColor: COLORS.surfaceHighlight },
  windowText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  list: { paddingHorizontal: SPACING.m, paddingTop: SPACING.s },
  joinBanner: { ...GLASS.card, flexDirection: 'row', alignItems: 'center', gap: SPACING.s, padding: SPACING.m, marginBottom: SPACING.s, borderRadius: BORDER_RADIUS.l, borderColor: COLORS.borderFocus },
  joinText: { ...TYPE_SCALE.bodyMd, color: COLORS.chromeMuted, flex: 1 },
  joinCta: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  announcement: { ...GLASS.card, padding: SPACING.m, marginBottom: SPACING.s, borderRadius: BORDER_RADIUS.l, borderColor: COLORS.warningMuted, backgroundColor: COLORS.surface },
  annHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  annLabel: { ...TYPE_SCALE.bodySm, color: COLORS.warning, fontWeight: '600' },
  annTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  annBody: { ...TYPE_SCALE.bodyMd, color: COLORS.chromeMuted, marginTop: 2 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xxl, gap: SPACING.s },
  emptyTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text, textAlign: 'center' },
  emptyBody: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, textAlign: 'center', paddingHorizontal: SPACING.l },
  retry: { marginTop: SPACING.s, paddingHorizontal: SPACING.l, minHeight: 44, justifyContent: 'center', borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.primaryMuted },
  retryText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: SPACING.l,
    width: 56,
    height: 56,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
});
