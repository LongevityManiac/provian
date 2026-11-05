/**
 * EscrowAdminAckSheet — shown once, the first time a person funds an escrow, before the funding
 * review. It states who resolves a dispute on the escrow until the Commons Court opens, that the
 * funds can go only to the escrow's parties, and the contract's dispute-timeout refund. After
 * "I understand" it is never shown to that wallet again (see core/commons/escrowAdminAck).
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../constants/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onAcknowledge: () => void;
}

export function EscrowAdminAckSheet({ visible, onClose, onAcknowledge }: Props) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.iconWrap}>
            <Ionicons name="shield-checkmark" size={24} color={COLORS.primary} />
          </View>
          <Text style={styles.title}>{t('escrowAdminAck.title')}</Text>
          <Text style={styles.body}>{t('escrowAdminAck.resolver')}</Text>
          <Text style={[styles.body, styles.paragraph]}>{t('escrowAdminAck.timeout')}</Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={onAcknowledge}
            accessibilityRole="button"
            testID="escrow-admin-ack-confirm"
          >
            <Text style={styles.primaryText}>{t('escrowAdminAck.acknowledge')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
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
    paddingHorizontal: SPACING.l,
    paddingTop: SPACING.s,
    paddingBottom: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    borderBottomWidth: 0,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.border, marginBottom: SPACING.m },
  iconWrap: { width: 48, height: 48, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.m },
  title: { ...TYPE_SCALE.headingMd, color: COLORS.text, marginBottom: SPACING.s },
  body: { ...TYPE_SCALE.bodyLg, color: COLORS.chromeMuted },
  paragraph: { marginTop: SPACING.m },
  primaryBtn: { marginTop: SPACING.l, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.l, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  primaryText: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  secondaryBtn: { marginTop: SPACING.s, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { ...TYPE_SCALE.bodyLg, color: COLORS.textSecondary },
});
