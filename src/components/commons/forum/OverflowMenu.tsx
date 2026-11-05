/**
 * OverflowMenu — the ⋯ bottom sheet on a post or comment: Question this post, Message the author,
 * View profile, Report to Provian (a private email, free), Block (hides the author on this phone,
 * free), and Flag publicly (a signed Commons write). The chosen action runs only after the sheet is fully closed,
 * so an action that opens another sheet (a challenge) or navigates never fights this Modal.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../../constants/theme';
import { useAfterClose } from './useAfterClose';

export type OverflowAction = 'report' | 'question' | 'message' | 'profile' | 'reportToProvian' | 'block';

interface Props {
  visible: boolean;
  /** Who wrote it (for the "Message …" label). */
  authorName: string;
  /** Your own post: no report / question / message. */
  isMine: boolean;
  /** Offer "Question this post" (top-level posts only). */
  canQuestion: boolean;
  onClose: () => void;
  onSelect: (action: OverflowAction) => void;
}

const ICONS: Record<OverflowAction, keyof typeof Ionicons.glyphMap> = {
  report: 'flag-outline',
  question: 'help-circle-outline',
  message: 'mail-outline',
  profile: 'person-circle-outline',
  reportToProvian: 'mail-unread-outline',
  block: 'eye-off-outline',
};

export default function OverflowMenu({ visible, authorName, isMine, canQuestion, onClose, onSelect }: Props) {
  const { t } = useTranslation();
  const { afterClose, onDismiss } = useAfterClose();
  const [open, setOpen] = useState(visible);
  useEffect(() => setOpen(visible), [visible]);

  const items: OverflowAction[] = isMine
    ? ['profile']
    : [...(canQuestion ? (['question'] as OverflowAction[]) : []), 'message', 'profile', 'reportToProvian', 'block', 'report'];

  const choose = (a: OverflowAction) => {
    setOpen(false);
    onClose();
    afterClose(() => onSelect(a));
  };

  const label = (a: OverflowAction): string => {
    switch (a) {
      case 'report': return t('commonsForum.menu.flagPublic');
      case 'reportToProvian': return t('commonsSafety.report');
      case 'block': return t('commonsSafety.block', { name: authorName });
      case 'question': return t('commonsForum.menu.question');
      case 'message': return t('commonsForum.menu.message', { name: authorName });
      case 'profile': return t('commonsForum.menu.profile');
    }
  };

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose} onDismiss={onDismiss}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {items.map((a) => (
            <TouchableOpacity key={a} style={styles.item} onPress={() => choose(a)} accessibilityRole="button">
              <Ionicons name={ICONS[a]} size={22} color={a === 'report' ? COLORS.error : COLORS.chromeMuted} />
              <Text style={[styles.itemText, a === 'report' && { color: COLORS.error }]} numberOfLines={1}>{label(a)}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.item, styles.cancel]} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: {
    backgroundColor: COLORS.surfaceElevated,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.s,
    paddingBottom: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    borderBottomWidth: 0,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.border, marginBottom: SPACING.s },
  item: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, minHeight: 52, paddingHorizontal: SPACING.s },
  itemText: { ...TYPE_SCALE.bodyLg, color: COLORS.text, flex: 1 },
  cancel: { justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, marginTop: SPACING.xs },
  cancelText: { ...TYPE_SCALE.bodyLg, color: COLORS.textSecondary, textAlign: 'center', flex: 1 },
});
