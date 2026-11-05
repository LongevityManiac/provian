/**
 * PostCard — one post in the feed, Reddit-style: author line, bold title, a 3-line preview,
 * and a footer with ▲ score ▼, 💬 N comments, and ⋯. Tapping anywhere else opens the post.
 * A reported post collapses to "Hidden — reported by the community · Show".
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../../constants/theme';
import { challengeChipFor, type ChallengeChip, type NormalizedForumPost } from '../../../core/commons/forumModel';
import AuthorLine from './AuthorLine';
import VoteControl from './VoteControl';

interface Props {
  post: NormalizedForumPost;
  onOpen: (post: NormalizedForumPost) => void;
  onVote: (post: NormalizedForumPost, dir: 'upvote' | 'downvote') => void;
  onMore: (post: NormalizedForumPost) => void;
  onAuthor: (post: NormalizedForumPost) => void;
  showTopic?: boolean;
}

export function ChallengeChipView({ chip }: { chip: ChallengeChip }) {
  const { t } = useTranslation();
  if (!chip) return null;
  const color = chip === 'upheld' ? COLORS.warning : chip === 'proof_shown' ? COLORS.success : COLORS.primaryLight;
  const bg = chip === 'upheld' ? COLORS.warningMuted : chip === 'proof_shown' ? COLORS.successMuted : COLORS.primaryMuted;
  const icon: keyof typeof Ionicons.glyphMap = chip === 'upheld' ? 'alert-circle-outline' : chip === 'proof_shown' ? 'checkmark-circle-outline' : 'help-circle-outline';
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[styles.chipText, { color }]}>{t(`commonsForum.challengeChip.${chip}`)}</Text>
    </View>
  );
}

function PostCardInner({ post, onOpen, onVote, onMore, onAuthor, showTopic }: Props) {
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);

  if (post.is_flagged && !reveal) {
    return (
      <View style={[styles.card, styles.hiddenCard]}>
        <Ionicons name="eye-off-outline" size={16} color={COLORS.textTertiary} />
        <Text style={styles.hiddenText} numberOfLines={2}>{t('commonsForum.hidden.label')}</Text>
        <TouchableOpacity onPress={() => setReveal(true)} style={styles.showBtn} accessibilityRole="button">
          <Text style={styles.showText}>{t('commonsForum.hidden.show')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const chip = challengeChipFor(undefined, post.challenge_count);
  const comments = post.counts_known
    ? t('commonsForum.card.comments', { count: post.comment_count })
    : t('commonsForum.card.commentsUnknown');
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.8} onPress={() => onOpen(post)} accessibilityRole="button" accessibilityHint={t('commonsForum.a11y.openPost')}>
      <AuthorLine post={post} onAuthor={() => onAuthor(post)} showTopic={showTopic} />
      {post.is_pinned && (
        <View style={styles.pinned}>
          <Ionicons name="pin" size={12} color={COLORS.warning} />
          <Text style={styles.pinnedText}>{t('commons.pinned')}</Text>
        </View>
      )}
      {post.title ? <Text style={styles.title} numberOfLines={2}>{post.title}</Text> : null}
      <Text style={styles.body} numberOfLines={3}>{post.content}</Text>
      {chip && <View style={styles.chipRow}><ChallengeChipView chip={chip} /></View>}
      <View style={styles.footer}>
        <VoteControl post={post} onVote={onVote} compact />
        <TouchableOpacity style={styles.footerBtn} onPress={() => onOpen(post)} accessibilityRole="button" accessibilityLabel={comments}>
          <Ionicons name="chatbubble-outline" size={17} color={COLORS.textSecondary} />
          <Text style={styles.footerText}>{comments}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.moreBtn} onPress={() => onMore(post)} accessibilityRole="button" accessibilityLabel={t('commonsForum.a11y.more')}>
          <Ionicons name="ellipsis-horizontal" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const PostCard = React.memo(PostCardInner);
export default PostCard;

const styles = StyleSheet.create({
  card: { ...GLASS.card, padding: SPACING.m, paddingBottom: SPACING.xs, marginBottom: SPACING.s, borderRadius: BORDER_RADIUS.l },
  hiddenCard: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingBottom: SPACING.m, minHeight: 56 },
  hiddenText: { ...TYPE_SCALE.bodyMd, color: COLORS.textTertiary, flex: 1 },
  showBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  showText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  pinned: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: SPACING.s },
  pinnedText: { ...TYPE_SCALE.bodySm, color: COLORS.warning, fontWeight: '600' },
  title: { ...TYPE_SCALE.headingSm, color: COLORS.text, marginTop: SPACING.s },
  body: { ...TYPE_SCALE.bodyMd, color: COLORS.chromeMuted, marginTop: SPACING.xs },
  chipRow: { flexDirection: 'row', marginTop: SPACING.s },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: SPACING.s, paddingVertical: 2, borderRadius: BORDER_RADIUS.round },
  chipText: { fontSize: 11, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: SPACING.xs, gap: SPACING.s },
  footerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: SPACING.xs },
  footerText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  moreBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
