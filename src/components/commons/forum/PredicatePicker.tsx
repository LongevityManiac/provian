import { errorDisplayCopy } from '../../../i18n/displayCopy';
/**
 * PredicatePicker (§5) — "what should they prove?" in plain sentences. Each sentence maps
 * 1:1 to a vocabulary predicate (core/commons/predicatePicker). "Advanced" keeps the raw
 * field / operator / threshold form for anything the sentences do not cover. Controlled: the
 * parent holds the draft and turns it into a predicate with `predicateFromDraft`.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../../constants/theme';
import {
  GUIDED_CLAIMS,
  PREDICATE_OPS,
  predicateFromDraft,
  selectGuidedClaim,
  type PredicateDraft,
} from '../../../core/commons/predicatePicker';

interface Props {
  draft: PredicateDraft;
  onChange: (d: PredicateDraft) => void;
  /** The lead line above the sentences ("They need to show they…"). */
  lead?: string;
}

const OP_SYMBOL: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' };

export default function PredicatePicker({ draft, onChange, lead }: Props) {
  const { t } = useTranslation();
  const [touched, setTouched] = useState(false);
  const result = predicateFromDraft(draft);
  const error = touched && !result.ok ? t(`commonsForum.picker.error.${result.error}`) : null;

  const step = (delta: number) => {
    const n = Number(draft.nText);
    const next = Math.max(0, (Number.isFinite(n) ? n : 0) + delta);
    onChange({ ...draft, nText: String(next) });
  };

  return (
    <View>
      <Text style={styles.lead}>{lead ?? t('commonsForum.picker.lead')}</Text>
      {draft.mode === 'guided' && GUIDED_CLAIMS.map((c) => {
        const selected = draft.claimId === c.id;
        const n = selected ? draft.nText : String(c.defaultN);
        return (
          <View key={c.id} style={[styles.option, selected && styles.optionSelected]}>
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => onChange(selectGuidedClaim(draft, c.id))}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? COLORS.primary : COLORS.textTertiary} />
              <Text style={styles.optionText}>{t(`commonsForum.claim.${c.id}`, { n: n || '…', count: Number(n) || 0 })}</Text>
            </TouchableOpacity>
            {selected && c.fixedN === undefined && (
              <View style={styles.stepper}>
                <TouchableOpacity style={styles.stepBtn} onPress={() => step(-1)} accessibilityRole="button" accessibilityLabel={t('commonsForum.picker.less')}>
                  <Ionicons name="remove" size={18} color={COLORS.text} />
                </TouchableOpacity>
                <TextInput
                  style={styles.stepInput}
                  value={draft.nText}
                  onChangeText={(v) => { setTouched(true); onChange({ ...draft, nText: v.replace(/[^0-9]/g, '') }); }}
                  keyboardType="number-pad"
                  maxLength={7}
                  accessibilityLabel={t('commonsForum.picker.number')}
                />
                <TouchableOpacity style={styles.stepBtn} onPress={() => step(1)} accessibilityRole="button" accessibilityLabel={t('commonsForum.picker.more')}>
                  <Ionicons name="add" size={18} color={COLORS.text} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}

      {draft.mode === 'advanced' && (
        <View style={styles.advanced}>
          <Text style={styles.label}>{t('commonsForum.picker.field')}</Text>
          <TextInput
            style={styles.input}
            value={draft.field}
            onChangeText={(v) => { setTouched(true); onChange({ ...draft, field: v }); }}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="work.hardware_rooted"
            placeholderTextColor={COLORS.textTertiary}
          />
          <View style={styles.opRow}>
            {PREDICATE_OPS.map((op) => (
              <TouchableOpacity
                key={op}
                style={[styles.opBtn, draft.op === op && styles.opBtnActive]}
                onPress={() => onChange({ ...draft, op })}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.op === op }}
                accessibilityLabel={op}
              >
                <Text style={[styles.opText, draft.op === op && styles.opTextActive]}>{OP_SYMBOL[op] ?? op}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>{t('commonsForum.picker.threshold')}</Text>
          <TextInput
            style={styles.input}
            value={draft.thresholdText}
            onChangeText={(v) => { setTouched(true); onChange({ ...draft, thresholdText: v }); }}
            keyboardType="numbers-and-punctuation"
          />
          <Text style={styles.hint}>{t('commonsForum.picker.advancedHint')}</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{errorDisplayCopy(error)}</Text>}

      <TouchableOpacity
        style={styles.toggle}
        onPress={() => onChange({ ...draft, mode: draft.mode === 'guided' ? 'advanced' : 'guided' })}
        accessibilityRole="button"
      >
        <Ionicons name={draft.mode === 'guided' ? 'options-outline' : 'list-outline'} size={16} color={COLORS.primaryLight} />
        <Text style={styles.toggleText}>{draft.mode === 'guided' ? t('commonsForum.picker.advanced') : t('commonsForum.picker.simple')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  lead: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, marginBottom: SPACING.s },
  option: { ...GLASS.cardSubtle, borderRadius: BORDER_RADIUS.m, marginBottom: SPACING.xs },
  optionSelected: { borderColor: COLORS.borderFocus, backgroundColor: COLORS.primaryMuted },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, minHeight: 48, paddingHorizontal: SPACING.m },
  optionText: { ...TYPE_SCALE.bodyMd, color: COLORS.text, flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingHorizontal: SPACING.m, paddingBottom: SPACING.s, marginLeft: 28 },
  stepBtn: { width: 44, height: 40, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.surfaceHighlight, alignItems: 'center', justifyContent: 'center' },
  stepInput: { ...GLASS.input, minWidth: 80, height: 40, color: COLORS.text, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  advanced: { marginTop: SPACING.xs },
  label: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginTop: SPACING.s, marginBottom: 4 },
  input: { ...GLASS.input, padding: SPACING.m, color: COLORS.text, fontSize: 15 },
  opRow: { flexDirection: 'row', gap: 6, marginTop: SPACING.s },
  opBtn: { minWidth: 44, minHeight: 40, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.surfaceHighlight, alignItems: 'center', justifyContent: 'center' },
  opBtnActive: { backgroundColor: COLORS.primary },
  opText: { color: COLORS.textSecondary, fontSize: 16, fontWeight: '600' },
  opTextActive: { color: COLORS.text },
  hint: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginTop: SPACING.xs },
  error: { ...TYPE_SCALE.bodySm, color: COLORS.error, marginTop: SPACING.s },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minHeight: 44, alignSelf: 'flex-start' },
  toggleText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
});
