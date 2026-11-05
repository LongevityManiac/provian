/**
 * VoteControl — ▲ score ▼. One tap votes (no confirmation); the arrow you chose stays
 * highlighted (`my_vote` from the relay, or the optimistic state). Votes are one-shot, so once you
 * have voted both arrows are inert. The write itself lives in useForumWrites.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, TYPE_SCALE } from '../../../constants/theme';
import type { NormalizedForumPost } from '../../../core/commons/forumModel';

interface Props {
  post: NormalizedForumPost;
  onVote: (post: NormalizedForumPost, dir: 'upvote' | 'downvote') => void;
  compact?: boolean;
}

export default function VoteControl({ post, onVote, compact }: Props) {
  const { t } = useTranslation();
  const up = post.my_vote === 'upvote';
  const down = post.my_vote === 'downvote';
  const voted = up || down;
  const size = compact ? 18 : 20;
  const scoreColor = up ? COLORS.success : down ? COLORS.error : COLORS.chromeMuted;
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.btn}
        onPress={() => onVote(post, 'upvote')}
        disabled={voted}
        accessibilityRole="button"
        accessibilityLabel={t('commonsForum.vote.up')}
        accessibilityState={{ selected: up, disabled: voted }}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      >
        <Ionicons name={up ? 'arrow-up-circle' : 'arrow-up-outline'} size={size} color={up ? COLORS.success : COLORS.textSecondary} />
      </TouchableOpacity>
      <Text style={[styles.score, { color: scoreColor }]} accessibilityLabel={t('commonsForum.vote.score', { count: post.score })}>
        {post.score}
      </Text>
      <TouchableOpacity
        style={styles.btn}
        onPress={() => onVote(post, 'downvote')}
        disabled={voted}
        accessibilityRole="button"
        accessibilityLabel={t('commonsForum.vote.down')}
        accessibilityState={{ selected: down, disabled: voted }}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      >
        <Ionicons name={down ? 'arrow-down-circle' : 'arrow-down-outline'} size={size} color={down ? COLORS.error : COLORS.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { minWidth: 36, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  score: { ...TYPE_SCALE.bodyMd, fontWeight: '600', minWidth: 18, textAlign: 'center', marginHorizontal: SPACING.xs / 2 },
});
