/**
 * AuthorLine — avatar (initials, or a chip icon for an agent) · display name · a small
 * Human/Agent pill · optional topic · age. Tapping the name opens the author's Commons profile.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../../constants/theme';
import { shortAddress } from '../../../utils/shortAddress';
import { timeAgo } from '../../../utils/timeAgo';
import { initialsFor, isKnownTopic, topicLabelKey } from '../../../core/commons/forumModel';
import type { ForumPost } from '../../../core/commons/CommonsService';

interface Props {
  post: Pick<ForumPost, 'author_wallet_id' | 'author_display_name' | 'author_type' | 'created_at' | 'channel'>;
  onAuthor?: () => void;
  showTopic?: boolean;
  small?: boolean;
  /** Highlight (the original poster, on the post page). */
  isOp?: boolean;
}

export function authorName(post: Pick<ForumPost, 'author_display_name' | 'author_wallet_id'>): string {
  return post.author_display_name?.trim() || shortAddress(post.author_wallet_id);
}

export function Avatar({ post, size = 32 }: { post: Pick<ForumPost, 'author_wallet_id' | 'author_display_name' | 'author_type'>; size?: number }) {
  const agent = post.author_type === 'agent';
  return (
    <View style={[styles.avatar, { width: size, height: size, backgroundColor: agent ? COLORS.secondaryMuted : COLORS.primaryMuted }]}>
      {agent ? (
        <Ionicons name="hardware-chip-outline" size={size * 0.5} color={COLORS.secondary} />
      ) : (
        <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initialsFor(post.author_display_name, post.author_wallet_id)}</Text>
      )}
    </View>
  );
}

export default function AuthorLine({ post, onAuthor, showTopic, small, isOp }: Props) {
  const { t } = useTranslation();
  const agent = post.author_type === 'agent';
  const name = authorName(post);
  const topic = isKnownTopic(post.channel) ? t(topicLabelKey(post.channel)) : `#${post.channel}`;
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.who}
        onPress={onAuthor}
        disabled={!onAuthor}
        accessibilityRole="button"
        accessibilityLabel={t('commonsForum.a11y.openProfile', { name })}
        hitSlop={{ top: 6, bottom: 6 }}
      >
        <Avatar post={post} size={small ? 24 : 32} />
        <Text style={[styles.name, small && styles.nameSmall, isOp && styles.nameOp]} numberOfLines={1}>{name}</Text>
        <View style={[styles.kind, agent ? styles.kindAgent : styles.kindHuman]}>
          <Text style={[styles.kindText, { color: agent ? COLORS.secondary : COLORS.success }]}>
            {agent ? t('commonsForum.author.agent') : t('commonsForum.author.human')}
          </Text>
        </View>
      </TouchableOpacity>
      <Text style={styles.meta} numberOfLines={1}>
        {showTopic ? `${topic} · ` : ''}{timeAgo(post.created_at, t)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
  who: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, flexShrink: 1, minHeight: 32 },
  avatar: { borderRadius: BORDER_RADIUS.round, alignItems: 'center', justifyContent: 'center' },
  initials: { color: COLORS.primaryLight, fontWeight: '600' },
  name: { ...TYPE_SCALE.bodyMd, fontWeight: '600', color: COLORS.text, flexShrink: 1 },
  nameSmall: { ...TYPE_SCALE.bodySm, fontWeight: '600' },
  nameOp: { color: COLORS.primaryLight },
  kind: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: BORDER_RADIUS.round },
  kindAgent: { backgroundColor: COLORS.secondaryMuted },
  kindHuman: { backgroundColor: COLORS.successMuted },
  kindText: { fontSize: 10, fontWeight: '600' },
  meta: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, flexShrink: 0, marginLeft: 'auto' },
});
