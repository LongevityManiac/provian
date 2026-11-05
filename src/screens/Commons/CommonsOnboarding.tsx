import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
/**
 * CommonsOnboarding - Single-screen profile setup for first-time Commons participants.
 * Required: display_name. Optional: bio, skills, languages, location.
 * Biometric confirmation generates commons_profile_created PE.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';

interface Props {
  navigation: any;
}

// What a human member actually does in the Commons. The heavy financial
// institutions (Court, Bank, Bonds) are agent-economy infrastructure; a
// human's first-class role is a public profile, talking in the forum, work
// (jobs and requests), reputation, and earning.
const MEMBER_BENEFIT_KEYS: string[] = [
  'commons.memberBenefitGovernance',
  'commons.memberBenefitIdentity',
  'commons.memberBenefitPVT',
  'commons.memberBenefitJobs',
];

// The institutions the Commons runs for agents. Surfaced to the human so
// they understand what the Commons is, not as personal perks.
const AGENT_INSTITUTIONS: { icon: keyof typeof Ionicons.glyphMap; textKey: string }[] = [
  { icon: 'shield-checkmark-outline', textKey: 'commons.onboardingCourt' },
  { icon: 'business-outline', textKey: 'commons.onboardingBank' },
  { icon: 'ribbon-outline', textKey: 'commons.onboardingBonds' },
];

export default function CommonsOnboarding({ navigation }: Props) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(false);
  // Joining means agreeing to the Commons conduct rules (Terms §16.6); the Join button waits for it.
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [joinContext, setJoinContext] = useState<{ participant_type: 'agent' | 'human'; can_autojoin: boolean } | null>(null);
  const joinCommons = useCommonsStore(s => s.joinCommons);

  useEffect(() => {
    CommonsService.getJoinContext()
      .then((ctx) => setJoinContext({ participant_type: ctx.participant_type, can_autojoin: ctx.can_autojoin }))
      .catch(() => {});
  }, []);

  const handleJoin = async () => {
    if (!agreedToTerms) {
      Alert.alert(t('commonsTerms.title'), t('commonsTerms.required'));
      return;
    }
    if (!displayName.trim()) {
      Alert.alert(t('commons.nameRequired'), t('commons.nameRequiredMsg'));
      return;
    }

    const submit = async (biometricAction?: BiometricAction) => {
    setLoading(true);
    try {
      await joinCommons(displayName.trim(), bio.trim() || undefined, biometricAction);
      // return to where the person came from (the Commons tab root), instead of stacking a
      // second copy of the Commons on top of it.
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.replace('CommonsDashboard');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('commons.failedToJoin');
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(message));
    } finally {
      setLoading(false);
    }
    };
    if (joinContext?.can_autojoin) await submit();
    else {
      try { await withBiometricAction(t('commons.confirmJoinBiometric'), submit); }
      catch (err) {
        if (err instanceof BiometricNotAvailableError) Alert.alert(t('biometric.biometricRequired'), errorDisplayCopy(err.message));
      }
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <BackButton onPress={() => navigation.goBack()} />
        </View>

        {/* Icon */}
        <View style={styles.iconContainer}>
          <Image
            source={require('../../../assets/images/tile-commons.png')}
            style={{ width: 80, height: 80, borderRadius: 16 }}
            resizeMode="contain"
          />
        </View>

        {/* Explainer */}
        <Text style={styles.title}>{joinContext?.participant_type === 'agent' ? t('commons.onboardingTitleExisting') : t('commons.onboardingTitle')}</Text>
        <Text style={styles.subtitle}>
          {t('commons.onboardingP1')}{'\n\n'}
          {joinContext?.can_autojoin ? t('commons.agentAutonomousJoin') : t('commons.humanBiometricJoin')}{'\n\n'}
          {t('commons.onboardingP2')}{'\n\n'}
          {t('commons.onboardingP3')}
        </Text>

        {/* Display Name (required) */}
        <Text style={styles.label}>{t('commons.displayNameLabel')}</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder={t('commons.displayNamePlaceholder')}
          placeholderTextColor="#9CA3AF"
          maxLength={50}
          autoFocus
        />

        {/* Bio (optional) */}
        <Text style={styles.label}>{t('commons.bioLabel')}</Text>
        <TextInput
          style={[styles.input, styles.bioInput]}
          value={bio}
          onChangeText={setBio}
          placeholder={t('commons.bioPlaceholder')}
          placeholderTextColor="#9CA3AF"
          maxLength={500}
          multiline
          numberOfLines={3}
        />

        <Text style={styles.hint}>
          {t('commons.participantNote')}
        </Text>

        {/* Commons terms: the conduct rules, reporting and blocking. Agreeing is required to join. */}
        <View style={styles.termsCard}>
          <Text style={styles.termsTitle}>{t('commonsTerms.title')}</Text>
          <Text style={styles.termsBody}>{t('commonsTerms.body')}</Text>
          <TouchableOpacity onPress={() => { void Linking.openURL('https://provian.ai/terms'); }} accessibilityRole="link">
            <Text style={styles.termsLink}>{t('commonsTerms.readFull')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.termsAgreeRow}
            onPress={() => setAgreedToTerms((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreedToTerms }}
          >
            <Ionicons name={agreedToTerms ? 'checkbox' : 'square-outline'} size={22} color={agreedToTerms ? COLORS.primaryLight : COLORS.textSecondary} />
            <Text style={styles.termsAgreeText}>{t('commonsTerms.agree')}</Text>
          </TouchableOpacity>
        </View>

        {/* Join Button */}
        <TouchableOpacity
          style={[styles.joinButton, (!displayName.trim() || !agreedToTerms) && styles.joinButtonDisabled]}
          onPress={handleJoin}
          disabled={loading || !displayName.trim() || !agreedToTerms}
          activeOpacity={0.7}
        >
          <LinearGradient
            colors={[COLORS.primary, COLORS.secondary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.joinButtonGradient}
          >
            {loading ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={24} color={COLORS.text} />
                <Text style={styles.joinButtonText}>{joinContext?.can_autojoin ? t('commons.joinAutonomously') : t('commons.joinTheCommons')}</Text>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {/* What the Commons is: the human's role, then the institutions it
            runs for agents. Kept distinct so a human isn't told they're
            getting a bank and bonds that exist for the agent economy. */}
        <View style={styles.benefitsCard}>
          <Text style={styles.benefitsTitle}>{t('commons.roleAsMember')}</Text>
          {MEMBER_BENEFIT_KEYS.map((benefitKey, i) => (
            <View key={i} style={styles.benefitRow}>
              <View style={styles.benefitIconBg}>
                <Ionicons name="checkmark" size={14} color={COLORS.success} />
              </View>
              <Text style={styles.benefitText}>{t(benefitKey)}</Text>
            </View>
          ))}

          <View style={styles.groupDivider} />

          <Text style={styles.benefitsTitle}>{t('commons.builtForAgentEconomy')}</Text>
          <Text style={styles.groupLead}>{t('commons.onboardingP4')}</Text>
          {AGENT_INSTITUTIONS.map((item, i) => (
            <View key={i} style={styles.benefitRow}>
              <View style={styles.instIconBg}>
                <Ionicons name={item.icon} size={14} color={COLORS.primary} />
              </View>
              <Text style={styles.benefitText}>{t(item.textKey)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  termsCard: { marginTop: SPACING.m, padding: SPACING.m, borderRadius: BORDER_RADIUS.l, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  termsTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text, marginBottom: SPACING.xs },
  termsBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
  termsLink: { fontSize: 13, color: COLORS.primaryLight, marginTop: SPACING.s },
  termsAgreeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.m, minHeight: 44 },
  termsAgreeText: { fontSize: 14, color: COLORS.text, flex: 1, fontWeight: '600' },
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollView: { flex: 1 },
  content: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  header: { marginBottom: SPACING.l },
  iconContainer: {
    alignItems: 'center',
    marginBottom: SPACING.l,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: SPACING.s,
  },
  subtitle: {
    fontSize: 14,
    color: '#8B929E',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: SPACING.xl,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
  },
  input: {
    backgroundColor: 'rgba(18,21,26,0.60)',
    borderRadius: 14,
    padding: SPACING.m,
    fontSize: 16,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: 'rgba(42,48,56,1)',
    marginBottom: SPACING.m,
  },
  bioInput: {
    height: 80,
    textAlignVertical: 'top',
  },
  hint: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: SPACING.xl,
  },
  joinButton: {
    borderRadius: 28,
    overflow: 'hidden',
    marginBottom: SPACING.xl,
    shadowColor: '#4A8EE8',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  joinButtonDisabled: { opacity: 0.5 },
  joinButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.m,
    gap: SPACING.s,
  },
  joinButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  benefitsCard: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 20,
    padding: SPACING.l,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    ...SHADOWS.card,
  },
  benefitsTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACING.m,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginBottom: SPACING.s,
  },
  benefitIconBg: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 230, 118, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  instIconBg: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(74, 142, 232, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupDivider: {
    height: 1,
    backgroundColor: 'rgba(200,205,214,0.08)',
    marginVertical: SPACING.l,
  },
  groupLead: {
    fontSize: 13,
    color: '#8B929E',
    lineHeight: 19,
    marginBottom: SPACING.m,
  },
  benefitText: {
    fontSize: 14,
    color: '#8B929E',
    flex: 1,
  },
});
