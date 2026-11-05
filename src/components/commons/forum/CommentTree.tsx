/**
 * CommentTree (§3) — the threaded reply conversation under a post, Reddit-style.
 *
 * The tree is built and flattened by core/commons/forumModel (buildCommentTree →
 * flattenCommentTree); this file renders one flat row at a time so the post page can virtualize it
 * in a FlatList. Replies indent up to three levels with thin guide lines; tapping a guide line
 * collapses that branch ("N more replies"); deeper replies sit behind "Continue this thread →".
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../../constants/theme';
import type { FlatCommentRow, NormalizedForumPost } from '../../../core/commons/forumModel';
import AuthorLine, { authorName } from './AuthorLine';
import VoteControl from './VoteControl';

const GUIDE_WIDTH = 16;

export interface CommentRowHandlers {
  onVote: (c: NormalizedForumPost, dir: 'upvote' | 'downvote') => void;
  onReply: (c: NormalizedForumPost) => void;
  onMore: (c: NormalizedForumPost) => void;
  onAuthor: (c: NormalizedForumPost) => void;
  onToggle: (commentId: string) => void;
  onContinue: (commentId: string) => void;
}

interface RowProps extends CommentRowHandlers {
  row: FlatCommentRow;
  /** The original poster (their name is highlighted). */
  opWalletId?: string | null;
  highlightId?: string | null;
}

function Guides({ ancestors, onToggle }: { ancestors: string[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      {ancestors.map((id) => (
        <TouchableOpacity
          key={id}
          style={styles.guide}
          onPress={() => onToggle(id)}
          accessibilityRole="button"
          accessibilityLabel={t('commonsForum.thread.collapse')}
        >
          <View style={styles.guideLine} />
        </TouchableOpacity>
      ))}
    </>
  );
}

function CommentRowInner({ row, opWalletId, highlightId, onVote, onReply, onMore, onAuthor, onToggle, onContinue }: RowProps) {
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);

  if (row.kind === 'continue') {
    return (
      <View style={styles.row}>
        <Guides ancestors={row.ancestors} onToggle={onToggle} />
        <TouchableOpacity style={styles.continue} onPress={() => onContinue(row.parentId)} accessibilityRole="button">
          <Text style={styles.continueText}>{t('commonsForum.thread.continue', { count: row.count })}</Text>
          <Ionicons name="arrow-forward" size={14} color={COLORS.primaryLight} />
        </TouchableOpacity>
      </View>
    );
  }

  const c = row.node.comment;
  const highlighted = highlightId === c.post_id;

  if (row.collapsed) {
    return (
      <View style={styles.row}>
        <Guides ancestors={row.ancestors} onToggle={onToggle} />
        <TouchableOpacity style={styles.collapsed} onPress={() => onToggle(c.post_id)} accessibilityRole="button" accessibilityLabel={t('commonsForum.thread.expand')}>
          <Ionicons name="add-circle-outline" size={16} color={COLORS.textTertiary} />
          <Text style={styles.collapsedText} numberOfLines={1}>
            {authorName(c)} · {row.node.descendantCount > 0 ? t('commonsForum.thread.moreReplies', { count: row.node.descendantCount }) : t('commonsForum.thread.collapsed')}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (c.is_flagged && !reveal) {
    return (
      <View style={styles.row}>
        <Guides ancestors={row.ancestors} onToggle={onToggle} />
        <View style={[styles.body, styles.hidden]}>
          <Ionicons name="eye-off-outline" size={14} color={COLORS.textTertiary} />
          <Text style={styles.hiddenText}>{t('commonsForum.hidden.comment')}</Text>
          <TouchableOpacity onPress={() => setReveal(true)} style={styles.showBtn} accessibilityRole="button">
            <Text style={styles.showText}>{t('commonsForum.hidden.show')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, highlighted && styles.highlight]}>
      <Guides ancestors={row.ancestors} onToggle={onToggle} />
      <View style={styles.body}>
        <View style={styles.headRow}>
          <View style={{ flex: 1 }}>
            <AuthorLine post={c} onAuthor={() => onAuthor(c)} small isOp={!!opWalletId && c.author_wallet_id === opWalletId} />
          </View>
          <TouchableOpacity onPress={() => onToggle(c.post_id)} style={styles.collapseBtn} accessibilityRole="button" accessibilityLabel={t('commonsForum.thread.collapse')}>
            <Ionicons name="remove-circle-outline" size={18} color={COLORS.textTertiary} />
          </TouchableOpacity>
        </View>
        <Text style={styles.text} selectable>{c.content}</Text>
        <View style={styles.actions}>
          <VoteControl post={c} onVote={onVote} compact />
          <TouchableOpacity style={styles.action} onPress={() => onReply(c)} accessibilityRole="button" accessibilityLabel={t('commonsForum.thread.replyTo', { name: authorName(c) })}>
            <Ionicons name="arrow-undo-outline" size={16} color={COLORS.textSecondary} />
            <Text style={styles.actionText}>{t('commons.reply')}</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={styles.more} onPress={() => onMore(c)} accessibilityRole="button" accessibilityLabel={t('commonsForum.a11y.more')}>
            <Ionicons name="ellipsis-horizontal" size={18} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export const CommentRow = React.memo(CommentRowInner);

/** A non-virtualized rendering of the rows (for short threads embedded in other screens). */
export default function CommentTree(props: CommentRowHandlers & { rows: FlatCommentRow[]; opWalletId?: string | null; highlightId?: string | null }) {
  const { rows, ...rest } = props;
  return (
    <View>
      {rows.map((row) => (
        <CommentRow key={row.kind === 'comment' ? row.node.comment.post_id : `continue:${row.parentId}`} row={row} {...rest} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: SPACING.m },
  highlight: { backgroundColor: COLORS.primaryMuted },
  guide: { width: GUIDE_WIDTH, alignItems: 'center' },
  guideLine: { width: 2, flex: 1, backgroundColor: COLORS.border, borderRadius: BORDER_RADIUS.round },
  body: { flex: 1, paddingVertical: SPACING.s, paddingLeft: SPACING.xs },
  headRow: { flexDirection: 'row', alignItems: 'center' },
  collapseBtn: { minWidth: 36, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  text: { ...TYPE_SCALE.bodyMd, color: COLORS.chromeMuted, marginTop: SPACING.xs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, paddingHorizontal: SPACING.s },
  actionText: { ...TYPE_SCALE.bodySm, color: COLORS.textSecondary, fontWeight: '600' },
  more: { minWidth: 44, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  collapsed: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.s, minHeight: 44, paddingLeft: SPACING.xs },
  collapsedText: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, flex: 1 },
  hidden: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
  showBtn: { minWidth: 44, minHeight: 36, alignItems: 'flex-end', justifyContent: 'center' },
  showText: { ...TYPE_SCALE.bodySm, color: COLORS.primaryLight, fontWeight: '600' },
  hiddenText: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, flex: 1 },
  continue: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minHeight: 44, paddingLeft: SPACING.xs },
  continueText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
});
