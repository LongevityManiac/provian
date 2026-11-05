import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * CommonsForumPost — one post with its threaded conversation underneath (§3).
 *
 * - The post at the top: full body, votes, the ⋯ menu (Report, Question this post, Message the
 * author, View profile), and — when it has been questioned — the challenge box in plain words.
 * The author answers an open challenge through HumanPresentment exactly as before.
 * - The replies as a Reddit-style tree (CommentTree): up to three levels inline, collapsible
 * branches, "Continue this thread →" for deeper replies (pushes this screen rooted at that reply).
 * Sort Best / New.
 * - A composer pinned to the bottom: "Add a comment", or "Replying to Maya ✕" after tapping Reply.
 * - `focusCommentId` (a reply notification) scrolls to that reply and highlights it.
 * - No talking pass → the reply / vote is saved and goes through by itself on return.
 * - A pre- relay returns direct replies only; they render as one level.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import useCommonsStore from '../../store/commonsStore';
import { captureShownForumPosts } from '../../core/commons/commonsOutputSigning';
import * as CommonsService from '../../core/commons/CommonsService';
import type { CommonsChallenge, PublicChallengeOutcome } from '../../core/commons/CommonsService';
import {
  buildCommentTree,
  challengeChipFor,
  descendantsOf,
  flattenCommentTree,
  isKnownTopic,
  MAX_INLINE_DEPTH,
  normalizeForumPost,
  pathToComment,
  topicLabelKey,
  type CommentSort,
  type FlatCommentRow,
  type NormalizedForumPost,
} from '../../core/commons/forumModel';
import { toPostThread } from '../../core/commons/forumFeedSource';
import { describePredicate } from '../../core/commons/predicatePicker';
import { CHALLENGE_ANSWER_FEE_PVT } from '../../core/commons/speechGate';
import type { PendingSpeech } from '../../core/commons/pendingSpeech';
import type { AppParamList } from '../../navigation/types';
import AuthorLine, { authorName } from '../../components/commons/forum/AuthorLine';
import VoteControl from '../../components/commons/forum/VoteControl';
import { CommentRow } from '../../components/commons/forum/CommentTree';
import OverflowMenu, { type OverflowAction } from '../../components/commons/forum/OverflowMenu';
import { useCommonsBlockStore, withoutBlocked } from '../../store/commonsBlockStore';
import ChallengeSheet from '../../components/commons/forum/ChallengeSheet';
import { ChallengeChipView } from '../../components/commons/forum/PostCard';
import { useForumWrites } from '../../components/commons/forum/useForumWrites';
import { invalidateForumFeed } from '../../components/commons/forum/ForumFeed';
import TalkingPassPill from '../../components/commons/TalkingPassPill';
import BackButton from '../../components/BackButton';

type Props = NativeStackScreenProps<AppParamList, 'CommonsForumPost'>;

const REPLY_MAX = 10_000;
const HIGHLIGHT_MS = 3000;

function pvtFromAtomic(atomic: string): string {
  try { const n = BigInt(atomic); const whole = n / 10n ** 18n; const frac = (n % 10n ** 18n) / 10n ** 16n; return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0')}`; } catch { return atomic; }
}

export default function CommonsForumPost({ navigation, route }: Props) {
  const { t } = useTranslation();
  const { postId, focusCommentId } = route.params;
  const joined = useCommonsStore((s) => s.profile !== null);
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
  const nav = navigation as unknown as { navigate: (screen: string, params?: Record<string, unknown>) => void };

  const [post, setPost] = useState<NormalizedForumPost | null>(null);
  const [rootPost, setRootPost] = useState<NormalizedForumPost | null>(null);
  const [comments, setComments] = useState<NormalizedForumPost[]>([]);
  const [legacy, setLegacy] = useState(false);
  // challenge OUTCOMES (never the predicate) + the author's own open challenges to answer.
  const [challenges, setChallenges] = useState<PublicChallengeOutcome[]>([]);
  const [outcomes, setOutcomes] = useState<{ open: number; answered: number; upheld: number } | undefined>(undefined);
  const [myOpen, setMyOpen] = useState<Array<CommonsChallenge & { challengerName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [sort, setSort] = useState<CommentSort>('best');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Deep focus: show the subtree of this comment so the focused reply is visible inline. */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const focusHandled = useRef(false);

  const [replyTo, setReplyTo] = useState<NormalizedForumPost | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<FlatCommentRow>>(null);

  const [menuTarget, setMenuTarget] = useState<NormalizedForumPost | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await CommonsService.getForumPost(postId);
      // signed posts the person OPENED are captured as shown (hash-checked), so
      // this phone's next PE cites what they read; their own posts are never captured.
      captureShownForumPosts([detail.post, detail.root, ...(detail.comments ?? detail.replies ?? [])], myId);
      const th = toPostThread(detail);
      setPost(th.post);
      setRootPost(th.root);
      setComments(th.comments);
      setLegacy(th.legacy);
      setChallenges(detail.challenges ?? []);
      setOutcomes(detail.challenge_outcomes);
      setFailed(false);
      if (myId && th.post.author_wallet_id === myId && (detail.challenges ?? []).some((c) => c.status === 'open')) {
        const mine = await CommonsService.getMyChallenges().catch(() => ({ challenges: [] as CommonsChallenge[] }));
        const open = mine.challenges.filter((c) => c.post_id === postId && c.status === 'open');
        const named = await Promise.all(open.map(async (c) => {
          const p = await CommonsService.getAgentProfile(c.challenger_wallet_id).catch(() => null);
          return { ...c, challengerName: p?.display_name ?? shortAddress(c.challenger_wallet_id) };
        }));
        setMyOpen(named);
      } else {
        setMyOpen([]);
      }
    } catch (err) {
      console.log('[CommonsForumPost] Load error:', err instanceof Error ? err.message : err);
      // A missing post is "not available", not a network failure worth retrying.
      setFailed(!(err instanceof CommonsService.CommonsError && err.status === 404));
    } finally {
      setLoading(false);
    }
  }, [postId, myId]);

  // Load on every focus (as before): returning from answering a challenge or opening a talking
  // pass shows the current tree and outcomes.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const updatePost = useCallback((id: string, fn: (p: NormalizedForumPost) => NormalizedForumPost) => {
    setPost((p) => (p && p.post_id === id ? fn(p) : p));
    setComments((prev) => prev.map((c) => (c.post_id === id ? fn(c) : c)));
  }, []);

  /** A reply the relay accepted: add it to the tree, count it, and show it. */
  const addReply = useCallback((raw: CommonsService.ForumPost, parentId: string) => {
    const c = normalizeForumPost({ ...raw, parent_post_id: raw.parent_post_id ?? parentId });
    setComments((prev) => (prev.some((x) => x.post_id === c.post_id) ? prev : [...prev, c]));
    setPost((p) => (p ? { ...p, comment_count: p.comment_count + 1, counts_known: p.counts_known } : p));
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    setHighlightId(c.post_id);
    setScrollTarget(c.post_id);
    invalidateForumFeed();
  }, []);

  const executeMore = useCallback(async (p: PendingSpeech): Promise<boolean> => {
    if (p.kind !== 'reply') return false;
    const parentId = typeof p.payload.parentId === 'string' ? p.payload.parentId : postId;
    const content = typeof p.payload.content === 'string' ? p.payload.content : '';
    if (!content) return true;
    setSending(true);
    try {
      const created = await CommonsService.replyToPost(parentId, { content });
      addReply(created, parentId);
      setText((cur) => (cur.trim() === content ? '' : cur));
      setReplyTo(null);
    } finally {
      setSending(false);
    }
    return true;
  }, [postId, addReply]);

  const writes = useForumWrites({ owner: `post:${postId}`, navigation: nav, joined, updatePost, executeMore });

  // ─── Tree ───────────────────────────────────────────────────────────────────

  const treeRootId = anchorId ?? post?.post_id ?? postId;
  // Replies by an author this person blocked are not shown on this phone.
  const blocked = useCommonsBlockStore((st) => st.blocked);
  const visibleComments = useMemo(() => withoutBlocked(comments, blocked), [comments, blocked]);
  const tree = useMemo(() => {
    const source = anchorId ? descendantsOf(anchorId, visibleComments) : visibleComments;
    return buildCommentTree(treeRootId, source, sort);
  }, [anchorId, visibleComments, treeRootId, sort]);
  const rows = useMemo(() => flattenCommentTree(tree, collapsed), [tree, collapsed]);

  // Focus a reply from a notification: expand its branch and, when it is deeper than the inline
  // depth, show the part of the thread it sits in.
  useEffect(() => {
    if (!post || focusHandled.current || !focusCommentId) return;
    focusHandled.current = true;
    const full = buildCommentTree(post.post_id, comments, sort);
    const path = pathToComment(full, focusCommentId);
    if (!path) return;
    if (path.length > MAX_INLINE_DEPTH) setAnchorId(path[path.length - 1 - MAX_INLINE_DEPTH]);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of path) next.delete(id);
      return next;
    });
    setHighlightId(focusCommentId);
    setScrollTarget(focusCommentId);
  }, [post, comments, sort, focusCommentId]);

  useEffect(() => {
    if (!scrollTarget) return;
    const index = rows.findIndex((r) => r.kind === 'comment' && r.node.comment.post_id === scrollTarget);
    if (index < 0) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
      setScrollTarget(null);
    }, 350);
    return () => clearTimeout(timer);
  }, [scrollTarget, rows]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const continueThread = useCallback((id: string) => {
    navigation.push('CommonsForumPost', { postId: id, channel: post?.channel });
  }, [navigation, post?.channel]);

  const startReply = useCallback((c: NormalizedForumPost) => {
    if (!joined) {
      writes.askToJoin(t('commonsForum.join.toReply'));
      return;
    }
    setReplyTo(c);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [joined, writes, t]);

  const openMenu = useCallback((c: NormalizedForumPost) => {
    setMenuTarget(c);
    setMenuOpen(true);
  }, []);

  const onMenuSelect = useCallback((a: OverflowAction) => {
    const target = menuTarget;
    if (!target) return;
    if (a === 'report') writes.report(target);
    else if (a === 'reportToProvian') writes.reportToProvian(target);
    else if (a === 'block') writes.blockAuthor(target);
    else if (a === 'question') void writes.question(target);
    else if (a === 'message') writes.messageAuthor(target);
    else writes.viewProfile(target);
  }, [menuTarget, writes]);

  // ─── Reply ──────────────────────────────────────────────────────────────────

  const sendReply = async () => {
    const content = text.trim();
    if (!content || sending || !post) return;
    if (!joined) {
      writes.askToJoin(t('commonsForum.join.toReply'));
      return;
    }
    const parentId = replyTo?.post_id ?? post.post_id;
    setSending(true);
    try {
      const created = await CommonsService.replyToPost(parentId, { content });
      addReply(created, parentId);
      setText('');
      setReplyTo(null);
    } catch (err) {
      if (writes.talkingPass.requirePass(err, { kind: 'reply', payload: { parentId, content }, draftKey: `reply:${parentId}`, draft: content })) return;
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error && err.message ? err.message : t('commonsForum.error.reply')));
    } finally {
      setSending(false);
    }
  };

  // the author answers an open challenge by presenting against its predicate — the binding
  // (audience + nonce) is read from the author's private list, then HumanPresentment burns,
  // produces the token, and delivers it to the challenge (verify-at-submit).
  const answerOpenChallenge = async () => {
    try {
      const mine = await CommonsService.getMyChallenges();
      const open = mine.challenges.find((c) => c.post_id === postId && c.status === 'open');
      if (!open) { Alert.alert(t('commons.challengeNoneOpenTitle'), t('commons.challengeNoneOpenBody')); return; }
      Alert.alert(
        t('commons.challengeAnswerTitle'),
        t('commons.challengeAnswerBody', { predicate: describePredicate(open.predicate, t) }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('commons.challengeAnswerGo'), onPress: () => navigation.navigate('HumanPresentment', { audience: open.audience, challenge: open.challenge_nonce, predicates: [open.predicate], deliverTo: { kind: 'challenge', challengeId: open.challenge_id } }) },
        ],
      );
    } catch (err) {
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.challengeAnswerFailed')));
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  const topicLabel = (() => {
    const ch = post?.channel ?? route.params.channel ?? '';
    if (!ch) return t('commons.forumTitle');
    return isKnownTopic(ch) ? t(topicLabelKey(ch)) : `#${ch}`;
  })();

  const isMine = !!post && post.author_wallet_id === myId;
  const isTopLevel = !!post && !post.parent_post_id;

  const renderPostBlock = () => {
    if (!post) return null;
    if (blocked[post.author_wallet_id] !== undefined && !isMine) {
      return (
        <View style={styles.postBlock}>
          <Text style={styles.emptyTitle}>{t('commonsSafety.blockedHidden')}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => { void useCommonsBlockStore.getState().unblock(post.author_wallet_id); }} accessibilityRole="button">
            <Text style={styles.retryText}>{t('commonsSafety.unblock')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const chip = challengeChipFor(outcomes, post.challenge_count);
    // A legacy relay has no counter and returns direct replies only: count what is shown.
    const commentLabel = t('commonsForum.card.comments', { count: legacy ? comments.length : Math.max(post.comment_count, comments.length) });
    return (
      <View>
        {rootPost && (
          <TouchableOpacity style={styles.rootLink} onPress={() => navigation.push('CommonsForumPost', { postId: rootPost.post_id, channel: rootPost.channel, focusCommentId: post.post_id })} accessibilityRole="button">
            <Ionicons name="return-up-back-outline" size={16} color={COLORS.primaryLight} />
            <Text style={styles.rootLinkText} numberOfLines={1}>{t('commonsForum.thread.viewWhole', { title: rootPost.title || rootPost.content })}</Text>
          </TouchableOpacity>
        )}
        <View style={styles.postBlock}>
          <AuthorLine post={post} onAuthor={() => writes.viewProfile(post)} />
          {post.is_pinned && (
            <View style={styles.pinned}>
              <Ionicons name="pin" size={12} color={COLORS.warning} />
              <Text style={styles.pinnedText}>{t('commons.pinned')}</Text>
            </View>
          )}
          {post.is_flagged && (
            <View style={styles.flagNote}>
              <Ionicons name="eye-off-outline" size={14} color={COLORS.textTertiary} />
              <Text style={styles.flagText}>{t('commonsForum.hidden.onPost')}</Text>
            </View>
          )}
          {post.title ? <Text style={styles.postTitle} selectable>{post.title}</Text> : null}
          <Text style={styles.postBody} selectable>{post.content}</Text>
          {chip && <View style={{ flexDirection: 'row', marginTop: SPACING.s }}><ChallengeChipView chip={chip} /></View>}

          {challenges.length > 0 && (
            <View style={styles.challengeBox}>
              <View style={styles.challengeHeaderRow}>
                <Text style={styles.challengeTitle}>{t('commonsForum.challengeBox.title', { count: challenges.length })}</Text>
              </View>
              {challenges.map((c) => (
                <Text key={c.challenge_id} style={[styles.challengeLine, c.status === 'upheld' && { color: COLORS.warning }, c.status === 'answered' && { color: COLORS.success }]}>
                  {c.status === 'open' ? t('commons.challengeOpen') : c.resolution === 'predicate_true' ? t('commons.challengeAnswered') : c.resolution === 'predicate_false' ? t('commons.challengeUpheldFalse') : t('commons.challengeUpheldSilent')}
                </Text>
              ))}
              {myOpen.map((c) => (
                <View key={`mine-${c.challenge_id}`} style={styles.challengeDetail}>
                  <Text style={styles.challengeDetailTitle}>{t('commons.challengeYouTitle', { who: c.challengerName })}</Text>
                  <Text style={styles.challengeLine}>{t('commons.challengeYouClaim', { stake: pvtFromAtomic(c.stake_amount_atomic), claim: describePredicate(c.predicate, t) })}</Text>
                  <Text style={styles.challengeLine}>{t('commons.challengeYouHow', { fee: CHALLENGE_ANSWER_FEE_PVT, deadline: new Date(c.window_expires_at).toLocaleDateString() })}</Text>
                </View>
              ))}
              {isMine && challenges.some((c) => c.status === 'open') && (
                <TouchableOpacity style={styles.answerBtn} onPress={() => void answerOpenChallenge()} accessibilityRole="button">
                  <Ionicons name="ribbon-outline" size={16} color={COLORS.text} />
                  <Text style={styles.answerBtnText}>{t('commons.challengeAnswerCta', { fee: CHALLENGE_ANSWER_FEE_PVT })}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <View style={styles.postFooter}>
            <VoteControl post={post} onVote={writes.vote} />
            <View style={styles.footerStat}>
              <Ionicons name="chatbubble-outline" size={17} color={COLORS.textSecondary} />
              <Text style={styles.footerText}>{commentLabel}</Text>
            </View>
            <View style={{ flex: 1 }} />
            {!isMine && isTopLevel && (
              <TouchableOpacity style={styles.footerBtn} onPress={() => void writes.question(post)} accessibilityRole="button" accessibilityLabel={t('commonsForum.menu.question')}>
                <Ionicons name="help-circle-outline" size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.footerBtn} onPress={() => openMenu(post)} accessibilityRole="button" accessibilityLabel={t('commonsForum.a11y.more')}>
              <Ionicons name="ellipsis-horizontal" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {anchorId && (
          <TouchableOpacity style={styles.partial} onPress={() => setAnchorId(null)} accessibilityRole="button">
            <Text style={styles.partialText}>{t('commonsForum.thread.partial')}</Text>
            <Text style={styles.partialCta}>{t('commonsForum.thread.showAll')}</Text>
          </TouchableOpacity>
        )}
        <View style={styles.sortRow}>
          <Text style={styles.sortLabel}>{t('commonsForum.thread.sortBy')}</Text>
          {(['best', 'new'] as CommentSort[]).map((s) => (
            <TouchableOpacity key={s} style={[styles.sortBtn, sort === s && styles.sortBtnActive]} onPress={() => setSort(s)} accessibilityRole="tab" accessibilityState={{ selected: sort === s }}>
              <Text style={[styles.sortText, sort === s && styles.sortTextActive]}>{t(`commonsForum.thread.sort.${s}`)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const emptyComments = (
    <View style={styles.emptyComments}>
      <Ionicons name="chatbubbles-outline" size={28} color={COLORS.textTertiary} />
      <Text style={styles.emptyTitle}>{t('commonsForum.thread.emptyTitle')}</Text>
      <Text style={styles.emptyBody}>{t('commonsForum.thread.emptyBody')}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
        <Text style={styles.headerTitle} numberOfLines={1}>{topicLabel}</Text>
        <TalkingPassPill />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>
      ) : !post ? (
        <View style={styles.center}>
          <Ionicons name={failed ? 'cloud-offline-outline' : 'alert-circle-outline'} size={40} color={COLORS.textTertiary} />
          <Text style={styles.emptyTitle}>{failed ? t('commonsForum.thread.loadFailed') : t('commonsForum.thread.notFound')}</Text>
          {failed && (
            <TouchableOpacity style={styles.retry} onPress={() => { setLoading(true); void load(); }} accessibilityRole="button">
              <Text style={styles.retryText}>{t('common.tryAgain')}</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => (r.kind === 'comment' ? r.node.comment.post_id : `continue:${r.parentId}`)}
            renderItem={({ item }) => (
              <CommentRow
                row={item}
                opWalletId={post.author_wallet_id}
                highlightId={highlightId}
                onVote={writes.vote}
                onReply={startReply}
                onMore={openMenu}
                onAuthor={writes.viewProfile}
                onToggle={toggle}
                onContinue={continueThread}
              />
            )}
            ListHeaderComponent={renderPostBlock()}
            ListEmptyComponent={emptyComments}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
            keyboardShouldPersistTaps="handled"
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
            }}
          />

          {joined ? (
            <View style={styles.composer}>
              {replyTo && (
                <View style={styles.replyChip}>
                  <Text style={styles.replyChipText} numberOfLines={1}>{t('commonsForum.thread.replyingTo', { name: authorName(replyTo) })}</Text>
                  <TouchableOpacity onPress={() => setReplyTo(null)} style={styles.replyChipX} accessibilityRole="button" accessibilityLabel={t('commonsForum.thread.cancelReply')}>
                    <Ionicons name="close" size={16} color={COLORS.textSecondary} />
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.composerRow}>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  placeholder={replyTo ? t('commonsForum.thread.replyPlaceholder', { name: authorName(replyTo) }) : t('commonsForum.thread.addComment')}
                  placeholderTextColor={COLORS.textTertiary}
                  value={text}
                  onChangeText={setText}
                  maxLength={REPLY_MAX}
                  multiline
                  accessibilityLabel={t('commonsForum.thread.addComment')}
                />
                <TouchableOpacity
                  style={[styles.send, (!text.trim() || sending) && styles.sendDisabled]}
                  onPress={() => void sendReply()}
                  disabled={!text.trim() || sending}
                  accessibilityRole="button"
                  accessibilityLabel={t('commonsForum.thread.send')}
                >
                  {sending ? <ActivityIndicator size="small" color={COLORS.text} /> : <Ionicons name="arrow-up" size={20} color={COLORS.text} />}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={[styles.composer, styles.joinBar]} onPress={() => navigation.navigate('CommonsOnboarding')} accessibilityRole="button">
              <Text style={styles.joinText}>{t('commonsForum.join.banner')}</Text>
              <Text style={styles.joinCta}>{t('commonsForum.join.cta')}</Text>
            </TouchableOpacity>
          )}
        </KeyboardAvoidingView>
      )}

      <OverflowMenu
        visible={menuOpen}
        authorName={menuTarget ? authorName(menuTarget) : ''}
        isMine={!!menuTarget && menuTarget.author_wallet_id === myId}
        canQuestion={!!menuTarget && !menuTarget.parent_post_id}
        onClose={() => setMenuOpen(false)}
        onSelect={onMenuSelect}
      />
      <ChallengeSheet {...writes.challenge} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingHorizontal: SPACING.s, paddingVertical: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  headerTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text, flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.m, padding: SPACING.l },
  list: { paddingBottom: SPACING.xl },
  rootLink: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginHorizontal: SPACING.m, marginTop: SPACING.s, minHeight: 40 },
  rootLinkText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, flex: 1 },
  postBlock: { padding: SPACING.m, paddingBottom: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  pinned: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: SPACING.s },
  pinnedText: { ...TYPE_SCALE.bodySm, color: COLORS.warning, fontWeight: '600' },
  flagNote: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.s },
  flagText: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary },
  postTitle: { ...TYPE_SCALE.headingMd, color: COLORS.text, marginTop: SPACING.s },
  postBody: { ...TYPE_SCALE.bodyLg, color: COLORS.chromeMuted, marginTop: SPACING.s },
  challengeBox: { ...GLASS.cardSubtle, marginTop: SPACING.m, padding: SPACING.m, gap: 6, borderRadius: BORDER_RADIUS.m },
  challengeHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  challengeTitle: { ...TYPE_SCALE.bodySm, fontWeight: '600', color: COLORS.textSecondary },
  challengeLine: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary },
  challengeDetail: { marginTop: SPACING.xs, gap: 4 },
  challengeDetailTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  answerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.round, paddingHorizontal: SPACING.m, minHeight: 40, marginTop: SPACING.xs },
  answerBtnText: { ...TYPE_SCALE.bodyMd, color: COLORS.text, fontWeight: '600' },
  postFooter: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.s },
  footerStat: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footerText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  footerBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  partial: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingHorizontal: SPACING.m, minHeight: 40, backgroundColor: COLORS.surface },
  partialText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, flex: 1 },
  partialCta: { ...TYPE_SCALE.bodySm, color: COLORS.primaryLight, fontWeight: '600' },
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingHorizontal: SPACING.m, paddingVertical: SPACING.xs },
  sortLabel: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginRight: SPACING.xs },
  sortBtn: { paddingHorizontal: SPACING.s + 2, minHeight: 32, justifyContent: 'center', borderRadius: BORDER_RADIUS.round },
  sortBtnActive: { backgroundColor: COLORS.primaryMuted },
  sortText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  sortTextActive: { color: COLORS.primaryLight },
  emptyComments: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.xs },
  emptyTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text, textAlign: 'center' },
  emptyBody: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, textAlign: 'center' },
  retry: { paddingHorizontal: SPACING.l, minHeight: 44, justifyContent: 'center', borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.primaryMuted },
  retryText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, backgroundColor: COLORS.surface, paddingHorizontal: SPACING.m, paddingTop: SPACING.s, paddingBottom: Platform.OS === 'ios' ? SPACING.l : SPACING.s },
  replyChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, backgroundColor: COLORS.primaryMuted, borderRadius: BORDER_RADIUS.round, paddingLeft: SPACING.m, marginBottom: SPACING.s, maxWidth: '100%' },
  replyChipText: { ...TYPE_SCALE.bodySm, color: COLORS.primaryLight, fontWeight: '600', flexShrink: 1 },
  replyChipX: { minWidth: 36, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.s },
  input: { ...GLASS.input, flex: 1, minHeight: 44, maxHeight: 140, borderRadius: BORDER_RADIUS.l, paddingHorizontal: SPACING.m, paddingTop: 12, paddingBottom: 12, color: COLORS.text, fontSize: 15 },
  send: { width: 44, height: 44, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.45 },
  joinBar: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, minHeight: 56 },
  joinText: { ...TYPE_SCALE.bodyMd, color: COLORS.chromeMuted, flex: 1 },
  joinCta: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
});
