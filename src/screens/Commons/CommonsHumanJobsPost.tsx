import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction } from '../../core/security/biometricAction';
/**
 * CommonsHumanJobsPost - a person posts a job on the Commons hiring board : they choose who it
 * hires (a person or an agent) and the currency (PVT, or USDC in dollars). Posting is Commons speech,
 * so it rides the talking pass — a 428 offers to open it (offerSpeechWindow), then Post again.
 *
 * Replaces the "rolling out soon" Alert that previously sat behind the
 * FAB on CommonsHumanJobs. The submit step generates a PE on the backend
 * and is therefore biometric-gated, mirroring the apply flow.
 *
 * Form -> body mapping lives in core/commons/postHumanJobForm.ts so the
 * conversion can be tested under vitest without an RN render harness.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import {
  requireBiometric,
  BiometricNotAvailableError,
  BiometricAuthError,
} from '../../core/security/requireBiometric';
import * as CommonsService from '../../core/commons/CommonsService';
import { offerSpeechWindow } from '../../core/commons/speechGate';
import {
  buildPostHumanJobBody,
  PostHumanJobValidationError,
  HUMAN_JOB_CATEGORIES,
  HUMAN_JOB_COMPENSATION_TYPES,
  HUMAN_JOB_LOCATION_TYPES,
  type PostHumanJobForm,
  type HumanJobCategory,
  type HumanJobCompensationType,
  type HumanJobLocationType,
  type HumanJobSeeking,
  type HumanJobCurrency,
} from '../../core/commons/postHumanJobForm';
import BackButton from '../../components/BackButton';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  /** the Market opens this with `seeking: 'agent'` (hire an agent). */
  route?: { params?: { seeking?: HumanJobSeeking } };
}

const ACCENT = '#E8A838';

/**
 * Advisory threshold for an unusually large escrow budget, in whole PVT.
 *
 * Basis: the 2026-06 PVT value recalibration anchored ~1 PE ≈ 1 PVT and
 * ~300 PVT/month of typical participation, so a single escrow above roughly
 * one month's typical earning is "unusually large" for an advisory.
 *
 * This is a UI heuristic, NOT a protocol value: there is no on-chain cap and
 * no backend gate (that absence is the ratified institution parameters Escrow economics
 * decision). The warning below is advisory-only and never blocks submission.
 */
const LARGE_ESCROW_ADVISORY_PVT = 300;

const INITIAL_FORM: PostHumanJobForm = {
  title: '',
  description: '',
  category: 'other',
  skillsRequired: '',
  locationType: 'remote',
  locationRegion: '',
  compensationType: 'pvt',
  budgetPvtWhole: '',
  deadlineHours: '48',
  requiresIdentityVerification: false,
  requiresPeHistory: false,
  // No preselection: the poster must choose who the job hires (a preselected
  // 'agent' silently posted person jobs as agent jobs, live finding).
  seeking: undefined,
  currency: 'pvt',
  budgetUsdc: '',
};

function pretty(label: string): string {
  return label.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function CommonsHumanJobsPost({ navigation, route }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PostHumanJobForm>(() => ({
    ...INITIAL_FORM,
    seeking: route?.params?.seeking ?? INITIAL_FORM.seeking,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [errorField, setErrorField] = useState<keyof PostHumanJobForm | 'general' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const update = <K extends keyof PostHumanJobForm>(key: K, value: PostHumanJobForm[K]) => {
    setForm((prev) => ({
      ...prev, [key]: value,
      ...(key === 'seeking' && value !== 'human' ? { requiresIdentityVerification: false } : {}),
    }));
    if (errorField === key) {
      setErrorField(null);
      setErrorMessage(null);
    }
  };

  const handleSubmit = async () => {
    setErrorField(null);
    setErrorMessage(null);

    let body: ReturnType<typeof buildPostHumanJobBody>;
    try {
      body = buildPostHumanJobBody(form);
    } catch (err) {
      if (err instanceof PostHumanJobValidationError) {
        setErrorField(err.field);
        setErrorMessage(errorDisplayCopy(err.message));
      } else {
        setErrorField('general');
        setErrorMessage(errorDisplayCopy((err as Error).message));
      }
      return;
    }

    try {
      await withBiometricAction(t('commonsHumanJobsPost.biometricPromptPost'), async biometricAction => {
    setSubmitting(true);
    try {
      const job = await CommonsService.postHumanJob(body, biometricAction);
      Alert.alert(t('commonsHumanJobsPost.postedTitle'), t('commonsHumanJobsPost.postedMessage'), [
        {
          text: t('commonsHumanJobsPost.ok'),
          onPress: () => {
            navigation.goBack();
          },
        },
      ]);
      // Defensive: log the new job_id so a developer tailing logs can
      // jump straight to the Firestore doc.
      if (typeof console !== 'undefined' && (job as { job_id?: string }).job_id) {
        console.log(`[CommonsHumanJobsPost] posted ${(job as { job_id: string }).job_id}`);
      }
    } catch (err) {
      // posting is Commons speech — without a live talking pass the relay answers 428.
      // Offer to open it; the form keeps its values, so Post works on return.
      if (offerSpeechWindow(err, navigation, t)) return;
      const msg = err instanceof Error ? err.message : t('commonsHumanJobsPost.postFailed');
      setErrorField('general');
      setErrorMessage(msg);
    } finally {
      setSubmitting(false);
    }
      });
    } catch (err) {
      if (err instanceof BiometricNotAvailableError) {
        Alert.alert(t('commonsHumanJobsPost.biometricRequiredTitle'), errorDisplayCopy(err.message));
      } else if (err instanceof BiometricAuthError) {
        Alert.alert(
          t('commonsHumanJobsPost.confirmationNeededTitle'),
          t('commonsHumanJobsPost.confirmationNeededMessage'),
        );
      }
      return;
    }


  };

  const showFieldError = (field: keyof PostHumanJobForm) =>
    errorField === field ? errorMessage : null;

  const generalError = errorField === 'general' ? errorMessage : null;

  const previewBudget = useMemo(() => {
    const trimmed = form.budgetPvtWhole.trim();
    return trimmed.length > 0 && /^[0-9]+$/.test(trimmed) ? trimmed : null;
  }, [form.budgetPvtWhole]);

  // Advisory-only: rendered as an informational note under the Budget field
  // when the amount is unusually large. Never gates or disables submission.
  const largeBudgetAdvisory = useMemo<number | null>(() => {
    const trimmed = form.budgetPvtWhole.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const whole = parseInt(trimmed, 10);
    return whole > LARGE_ESCROW_ADVISORY_PVT ? whole : null;
  }, [form.budgetPvtWhole]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <View style={styles.headerTitleRow}>
          <View style={styles.headerIconBg}>
            <Ionicons name="briefcase" size={16} color={ACCENT} />
          </View>
          <Text style={styles.headerTitle}>{t('commonsHumanJobsPost.headerTitle')}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.helper}>
            {t('commonsHumanJobsPost.helper')}
          </Text>

          <Field label={t('commonsHumanJobsPost.titleLabel')} error={showFieldError('title')}>
            <TextInput
              value={form.title}
              onChangeText={(v) => update('title', v)}
              placeholder={t('commonsHumanJobsPost.titlePlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              maxLength={200}
              style={styles.input}
            />
          </Field>

          <Field label={t('commonsHumanJobsPost.descriptionLabel')} error={showFieldError('description')}>
            <TextInput
              value={form.description}
              onChangeText={(v) => update('description', v)}
              placeholder={t('commonsHumanJobsPost.descriptionPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              multiline
              style={[styles.input, styles.inputMultiline]}
            />
          </Field>

          <ChipPicker
            label={t('commonsHumanJobsPost.categoryLabel')}
            options={HUMAN_JOB_CATEGORIES as readonly string[]}
            selected={form.category}
            onSelect={(v) => update('category', v as HumanJobCategory)}
            error={showFieldError('category')}
          />

          <Field label={t('commonsHumanJobsPost.skillsLabel')} error={showFieldError('skillsRequired')}>
            <TextInput
              value={form.skillsRequired}
              onChangeText={(v) => update('skillsRequired', v)}
              placeholder={t('commonsHumanJobsPost.skillsPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              autoCapitalize="none"
              style={styles.input}
            />
          </Field>

          <ChipPicker
            label={t('commonsHumanJobsPost.locationLabel')}
            options={HUMAN_JOB_LOCATION_TYPES as readonly string[]}
            selected={form.locationType}
            onSelect={(v) => update('locationType', v as HumanJobLocationType)}
            error={showFieldError('locationType')}
          />

          {form.locationType !== 'remote' && (
            <Field label={t('commonsHumanJobsPost.regionLabel')} error={null}>
              <TextInput
                value={form.locationRegion ?? ''}
                onChangeText={(v) => update('locationRegion', v)}
                placeholder={t('commonsHumanJobsPost.regionPlaceholder')}
                placeholderTextColor={COLORS.textTertiary}
                style={styles.input}
              />
            </Field>
          )}

          {/* who the job hires, and what it pays in. */}
          <OptionPicker
            label={t('commonsJobs.postSeekingLabel')}
            options={[
              { value: 'human', label: t('commonsJobs.postSeekingPerson') },
              { value: 'agent', label: t('commonsJobs.postSeekingAgent') },
            ]}
            selected={form.seeking}
            onSelect={(v) => update('seeking', v as HumanJobSeeking)}
            error={showFieldError('seeking')}
          />

          <OptionPicker
            label={t('commonsJobs.postCurrencyLabel')}
            options={[
              { value: 'pvt', label: 'PVT' },
              { value: 'usdc', label: 'USDC' },
            ]}
            selected={form.currency ?? 'pvt'}
            onSelect={(v) => update('currency', v as HumanJobCurrency)}
            error={showFieldError('currency')}
          />

          <ChipPicker
            label={t('commonsHumanJobsPost.compensationTypeLabel')}
            options={HUMAN_JOB_COMPENSATION_TYPES as readonly string[]}
            selected={form.compensationType}
            onSelect={(v) => update('compensationType', v as HumanJobCompensationType)}
            error={showFieldError('compensationType')}
          />

          {form.currency === 'usdc' ? (
          <Field label={t('commonsJobs.postBudgetUsdcLabel')} error={showFieldError('budgetUsdc')}>
            <TextInput
              value={form.budgetUsdc ?? ''}
              onChangeText={(v) => update('budgetUsdc', v)}
              placeholder={t('commonsJobs.postBudgetUsdcPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              keyboardType="decimal-pad"
              style={styles.input}
            />
            <Text style={styles.fieldHint}>{t('commonsJobs.postBudgetUsdcHint')}</Text>
          </Field>
          ) : (
          <Field
            label={previewBudget ? t('commonsHumanJobsPost.budgetLabelPreview', { amount: previewBudget }) : t('commonsHumanJobsPost.budgetLabel')}
            error={showFieldError('budgetPvtWhole')}
          >
            <TextInput
              value={form.budgetPvtWhole}
              onChangeText={(v) => update('budgetPvtWhole', v)}
              placeholder={t('commonsHumanJobsPost.budgetPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              keyboardType="number-pad"
              style={styles.input}
            />
            {largeBudgetAdvisory !== null && (
              <View style={styles.advisoryBanner}>
                <Ionicons name="information-circle" size={16} color={COLORS.warning} />
                <Text style={styles.advisoryBannerText}>
                  {t('commonsHumanJobsPost.largeBudgetAdvisory', { amount: largeBudgetAdvisory })}
                </Text>
              </View>
            )}
          </Field>
          )}

          <Field label={t('commonsHumanJobsPost.deadlineLabel')} error={showFieldError('deadlineHours')}>
            <TextInput
              value={form.deadlineHours}
              onChangeText={(v) => update('deadlineHours', v)}
              placeholder="48"
              placeholderTextColor={COLORS.textTertiary}
              keyboardType="number-pad"
              style={styles.input}
            />
          </Field>

          {form.seeking === 'human' && (
            <ToggleRow
              label={t('commonsHumanJobsPost.requireIdentityVerification')}
              value={form.requiresIdentityVerification}
              onChange={(v) => update('requiresIdentityVerification', v)}
            />
          )}

          <ToggleRow
            label={t('commonsHumanJobsPost.requireTrackRecord')}
            value={form.requiresPeHistory}
            onChange={(v) => update('requiresPeHistory', v)}
          />

          {generalError && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={16} color={COLORS.warning} />
              <Text style={styles.errorBannerText}>{generalError}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.submit, submitting && styles.submitDisabled]}
            disabled={submitting}
            onPress={handleSubmit}
            activeOpacity={0.8}
          >
            <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
            {submitting ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <Text style={styles.submitText}>{t('commonsHumanJobsPost.postJob')}</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface FieldProps {
  label: string;
  error: string | null;
  children: React.ReactNode;
}

function Field({ label, error, children }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {error && <Text style={styles.fieldError}>{errorDisplayCopy(error)}</Text>}
    </View>
  );
}

interface ChipPickerProps {
  label: string;
  options: readonly string[];
  selected: string | undefined;
  onSelect: (value: string) => void;
  error: string | null;
}

function ChipPicker({ label, options, selected, onSelect, error }: ChipPickerProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const active = opt === selected;
          return (
            <TouchableOpacity
              key={opt}
              onPress={() => onSelect(opt)}
              style={[styles.chip, active && styles.chipActive]}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{pretty(opt)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {error && <Text style={styles.fieldError}>{errorDisplayCopy(error)}</Text>}
    </View>
  );
}

interface OptionPickerProps {
  label: string;
  options: { value: string; label: string }[];
  selected: string | undefined;
  onSelect: (value: string) => void;
  error: string | null;
}

/** Like ChipPicker, but with translated labels (the values stay the wire values). */
function OptionPicker({ label, options, selected, onSelect, error }: OptionPickerProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((opt) => {
          const active = opt.value === selected;
          return (
            <TouchableOpacity
              key={opt.value}
              onPress={() => onSelect(opt.value)}
              style={[styles.chip, active && styles.chipActive]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {error && <Text style={styles.fieldError}>{errorDisplayCopy(error)}</Text>}
    </View>
  );
}

interface ToggleRowProps {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, value, onChange }: ToggleRowProps) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  kav: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginLeft: SPACING.m,
    flex: 1,
  },
  headerIconBg: {
    width: 28,
    height: 28,
    borderRadius: BORDER_RADIUS.s,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(232,168,56,0.18)',
  },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '600' },
  headerSpacer: { width: 32 },

  helper: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: SPACING.l,
  },

  field: { marginBottom: SPACING.l },
  fieldLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: SPACING.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldHint: {
    color: COLORS.textTertiary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: SPACING.xs,
  },
  fieldError: {
    color: COLORS.warning,
    fontSize: 12,
    marginTop: SPACING.xs,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    color: COLORS.text,
    fontSize: 15,
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.s,
  },
  chip: {
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  chipActive: {
    backgroundColor: ACCENT,
  },
  chipText: { color: COLORS.textSecondary, fontSize: 13 },
  chipTextActive: { color: '#1F1502', fontWeight: '600' },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.s,
    marginBottom: SPACING.s,
  },
  toggleLabel: { color: COLORS.text, fontSize: 14 },

  // Informational note (advisory channel), distinct from fieldError/errorBanner:
  // amber-tinted per theme, but paired with an info icon and secondary text so
  // it reads as guidance, not a validation failure.
  advisoryBanner: {
    flexDirection: 'row',
    gap: SPACING.s,
    alignItems: 'flex-start',
    backgroundColor: COLORS.warningMuted,
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    marginTop: SPACING.s,
  },
  advisoryBannerText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    flex: 1,
  },

  errorBanner: {
    flexDirection: 'row',
    gap: SPACING.s,
    alignItems: 'center',
    backgroundColor: 'rgba(232,168,56,0.12)',
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    marginBottom: SPACING.l,
  },
  errorBannerText: { color: COLORS.text, fontSize: 13, flex: 1 },

  submit: {
    height: 52,
    borderRadius: BORDER_RADIUS.l,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
});
