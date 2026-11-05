/**
 * FeaturedBidSheet — the ONE sheet a person uses to bid for featured placement on the wants
 * board and the Commons jobs board. The person types the amount to burn: floor 15 PVT, no ceiling —
 * the same terms an agent bids on. Bids on one item add up; the placement ends when the item closes;
 * nothing refunds.
 *
 * Cross-platform (a transparent Modal, not Alert.prompt, which does nothing on Android). If the phone
 * holds a saved burn from an earlier bid that failed after burning (pendingBurns), the sheet offers
 * that amount first — bidding it spends the saved burn instead of burning again.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import { listPendingBurns } from '../../core/presentation/pendingBurns';
import { FEATURED_BID_MIN_PVT, parseFeaturedBid, savedBidBurnPvt } from '../../core/commons/featuredBid';

interface Props {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  /** Called with the parsed whole-PVT amount (at or above the floor). */
  onConfirm: (amountPvt: string) => void;
}

export function FeaturedBidSheet({ visible, busy, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const address = useWalletStore((s) => s.address);
  const [amount, setAmount] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const min = FEATURED_BID_MIN_PVT;

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setAmount('');
    setSaved(null);
    if (address) {
      listPendingBurns(address)
        .then((list) => {
          if (!live) return;
          const pvt = savedBidBurnPvt(list);
          setSaved(pvt);
          if (pvt) setAmount(pvt);
        })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [visible, address]);

  const parsed = parseFeaturedBid(amount);
  const error = amount.trim() === '' || parsed.ok ? null
    : parsed.reason === 'below_floor' ? t('commons.featureAmountBelowFloor', { pvt: min })
    : t('commons.featureAmountInvalid');

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.iconWrap}>
            <Ionicons name="flame" size={24} color={COLORS.warning} />
          </View>
          <Text style={styles.title}>{t('commons.featureTitle')}</Text>
          <Text style={styles.body}>{t('commons.featureBody', { pvt: min })}</Text>
          <Text style={styles.label}>{t('commons.featureAmountLabel')}</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder={min}
            placeholderTextColor={COLORS.textTertiary}
            keyboardType="decimal-pad"
            editable={!busy}
            accessibilityLabel={t('commons.featureAmountLabel')}
            testID="featured-bid-amount"
          />
          <Text style={[styles.hint, error ? styles.error : null]}>{error ?? t('commons.featureAmountMin', { pvt: min })}</Text>
          {saved && <Text style={styles.saved}>{t('commons.featureSavedBurn', { pvt: saved })}</Text>}
          <TouchableOpacity
            style={[styles.primaryBtn, (!parsed.ok || busy) && styles.disabled]}
            disabled={!parsed.ok || busy}
            onPress={() => { if (parsed.ok) onConfirm(parsed.pvt); }}
            accessibilityRole="button"
            testID="featured-bid-confirm"
          >
            {busy ? <ActivityIndicator color={COLORS.text} /> : (
              <Text style={styles.primaryText}>{t('commons.featureBurn', { pvt: parsed.ok ? parsed.pvt : min })}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={onClose} disabled={busy} accessibilityRole="button">
            <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
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
  iconWrap: { width: 48, height: 48, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.warningMuted, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.m },
  title: { ...TYPE_SCALE.headingMd, color: COLORS.text, marginBottom: SPACING.s },
  body: { ...TYPE_SCALE.bodyLg, color: COLORS.chromeMuted },
  label: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, marginTop: SPACING.l, marginBottom: SPACING.xs, fontWeight: '600' },
  input: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.m,
    borderWidth: 1,
    borderColor: COLORS.border,
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '700',
    paddingHorizontal: SPACING.m,
    minHeight: 50,
  },
  hint: { ...TYPE_SCALE.bodyMd, color: COLORS.textTertiary, marginTop: SPACING.xs },
  error: { color: COLORS.error },
  saved: { ...TYPE_SCALE.bodyMd, color: COLORS.warning, marginTop: SPACING.s },
  primaryBtn: { marginTop: SPACING.l, backgroundColor: COLORS.error, borderRadius: BORDER_RADIUS.l, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
  primaryText: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  secondaryBtn: { marginTop: SPACING.s, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { ...TYPE_SCALE.bodyLg, color: COLORS.textSecondary },
});
