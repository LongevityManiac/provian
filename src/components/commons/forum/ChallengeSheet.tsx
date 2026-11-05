import { errorDisplayCopy } from '../../../i18n/displayCopy';
/**
 * ChallengeSheet (§5) — "Question this post" ask the author to prove one thing about their
 * record, in plain sentences (PredicatePicker). The stake is explained once — "You put up 15 PVT.
 * If they can't prove it, you get it back." then the existing stake confirmation, the one
 * biometric burn through `spendBurn` (saved on the phone until the challenge is filed, so a retry
 * never burns twice), and `challengePost`.
 *
 * A talking-pass refusal is handed back to the parent (`onNeedsPass`) with the draft, so the parent
 * can close this sheet, open the talking-pass sheet, and reopen this one — prefilled — on return.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../../constants/theme';
import * as CommonsService from '../../../core/commons/CommonsService';
import { spendBurn } from '../../../core/commons/burnForBenefit';
import { CHALLENGE_STAKE_PVT, speechWindowRequired } from '../../../core/commons/speechGate';
import { initialPredicateDraft, predicateFromDraft, type PredicateDraft } from '../../../core/commons/predicatePicker';
import { InfoModal } from '../../InfoModal';
import PredicatePicker from './PredicatePicker';

export interface ChallengeDraft {
  predicate: PredicateDraft;
  reason: string;
}

interface Props {
  /** The post being questioned; null hides the sheet. */
  postId: string | null;
  authorName: string;
  initial?: ChallengeDraft | null;
  onClose: () => void;
  onDismiss?: () => void;
  onFiled: (postId: string) => void;
  onNeedsPass: (err: unknown, postId: string, draft: ChallengeDraft) => void;
}

export default function ChallengeSheet({ postId, authorName, initial, onClose, onDismiss, onFiled, onNeedsPass }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PredicateDraft>(initial?.predicate ?? initialPredicateDraft());
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [showWhat, setShowWhat] = useState(false);
  const pvt = CHALLENGE_STAKE_PVT;

  // A new target (or a resumed draft) starts from its own state.
  useEffect(() => {
    if (!postId) return;
    setDraft(initial?.predicate ?? initialPredicateDraft());
    setReason(initial?.reason ?? '');
  }, [postId, initial]);

  const submit = () => {
    if (!postId || busy) return;
    const built = predicateFromDraft(draft);
    if (!built.ok) {
      Alert.alert(t('commonsForum.picker.invalidTitle'), t(`commonsForum.picker.error.${built.error}`));
      return;
    }
    const target = postId;
    const why = reason.trim();
    Keyboard.dismiss();
    Alert.alert(t('commons.challengeStakeTitle', { pvt }), t('commons.challengeStakeBody', { pvt }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('commons.challengeStakeBurn', { pvt }),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            // biometric-gated on-chain burn, saved on the phone until the challenge is filed
            await spendBurn(pvt, (burnId) => CommonsService.challengePost(target, { predicate: built.predicate, burn_id: burnId, ...(why ? { reason: why } : {}) }));
            onFiled(target);
            Alert.alert(t('commonsForum.challenge.filedTitle'), t('commonsForum.challenge.filedBody', { name: authorName }));
          } catch (err) {
            if (speechWindowRequired(err)) {
              onNeedsPass(err, target, { predicate: draft, reason });
              return;
            }
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error && err.message ? err.message : t('commonsForum.error.generic')));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={postId !== null} animationType="slide" transparent onRequestClose={onClose} onDismiss={onDismiss}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={Keyboard.dismiss} accessibilityLabel={t('common.done')} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('commonsForum.challenge.title')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={24} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
            <Text style={styles.intro}>{t('commonsForum.challenge.intro', { name: authorName })}</Text>
            <View style={styles.stake}>
              <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.platinumDeep} />
              <Text style={styles.stakeText}>{t('commonsForum.challenge.stake', { pvt })}</Text>
            </View>
            <TouchableOpacity onPress={() => setShowWhat(true)} style={styles.link} accessibilityRole="button">
              <Text style={styles.linkText}>{t('commons.challengeWhatTitle')}</Text>
            </TouchableOpacity>

            <PredicatePicker draft={draft} onChange={setDraft} lead={t('commonsForum.picker.leadChallenge', { name: authorName })} />

            <Text style={styles.label}>{t('commonsForum.challenge.reason')}</Text>
            <TextInput
              style={styles.reason}
              value={reason}
              onChangeText={setReason}
              placeholder={t('commonsForum.challenge.reasonPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              multiline
              maxLength={500}
              textAlignVertical="top"
            />

            <TouchableOpacity style={[styles.submit, busy && styles.disabled]} onPress={submit} disabled={busy} accessibilityRole="button">
              {busy ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.submitText}>{t('commonsForum.challenge.submit', { pvt })}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
        <InfoModal visible={showWhat} onClose={() => setShowWhat(false)} title={t('commons.challengeWhatTitle')} body={t('commons.challengeWhatBody', { pvt })} />
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
    maxHeight: '88%',
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    borderBottomWidth: 0,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingTop: SPACING.m },
  title: { ...TYPE_SCALE.headingMd, color: COLORS.text },
  close: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  scroll: { padding: SPACING.l, paddingTop: SPACING.s, paddingBottom: SPACING.xl },
  intro: { ...TYPE_SCALE.bodyLg, color: COLORS.chromeMuted },
  stake: { flexDirection: 'row', gap: SPACING.s, alignItems: 'flex-start', marginTop: SPACING.m, padding: SPACING.m, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.platinumMuted },
  stakeText: { ...TYPE_SCALE.bodyMd, color: COLORS.platinum, flex: 1 },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  label: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginTop: SPACING.m, marginBottom: 4 },
  reason: { ...GLASS.input, minHeight: 72, padding: SPACING.m, color: COLORS.text, fontSize: 15 },
  submit: { marginTop: SPACING.l, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.l, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  submitText: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  disabled: { opacity: 0.5 },
});
