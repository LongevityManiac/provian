import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * CommonsConsentRequests — P4-10 response surface for pending publication
 * consent requests (invariant #33 mutual-consent gate).
 *
 * The Commons dashboard badge counts pending consents but previously had no
 * screen that called respondToConsent — a dead-end call-to-action. This screen
 * lists each pending request (who wants to publish, which PE, what it would
 * reveal, when it expires) and wires Approve / Deny to respondToConsent, then
 * refreshes the badge count.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS, SHADOWS } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import { safeFormatDate } from '../../utils/safeDate';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { PublicationConsent, RedactionConfig } from '../../core/commons/CommonsService';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}

// Which redaction flags reveal which field, for the "what will be shared" list.
const REVEAL_LABEL_KEYS: Array<{ key: keyof RedactionConfig; labelKey: string }> = [
  { key: 'show_intent_text', labelKey: 'commons.consent.fieldIntent' },
  { key: 'show_counterparty', labelKey: 'commons.consent.fieldCounterparty' },
  { key: 'show_amount', labelKey: 'commons.consent.fieldAmount' },
  { key: 'show_currency', labelKey: 'commons.consent.fieldCurrency' },
  { key: 'show_artifact_hash', labelKey: 'commons.consent.fieldArtifact' },
];

export default function CommonsConsentRequests({ navigation }: Props) {
  const { t } = useTranslation();
  const refreshNotifications = useCommonsStore(s => s.refreshNotifications);

  const [consents, setConsents] = useState<PublicationConsent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  // the raw record id is a detail, not the headline — shown only on request.
  const [detailsFor, setDetailsFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await CommonsService.getPendingConsents();
      setConsents(result.consents);
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsConsentRequests] Load error:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const respond = async (consent: PublicationConsent, decision: 'approved' | 'denied') => {
    setRespondingId(consent.consent_id);
    try {
      await CommonsService.respondToConsent(consent.consent_id, decision);
      // Drop the resolved request from the list and refresh the dashboard badge.
      setConsents(prev => prev.filter(c => c.consent_id !== consent.consent_id));
      refreshNotifications();
      Alert.alert(
        decision === 'approved' ? t('commons.consent.approvedTitle') : t('commons.consent.deniedTitle'),
        decision === 'approved' ? t('commons.consent.approvedBody') : t('commons.consent.deniedBody'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('commons.consent.responseFailed');
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(msg));
    } finally {
      setRespondingId(null);
    }
  };

  const confirmDeny = (consent: PublicationConsent) => {
    Alert.alert(
      t('commons.consent.denyTitle'),
      t('commons.consent.denyConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('commons.consent.deny'), style: 'destructive', onPress: () => respond(consent, 'denied') },
      ],
    );
  };

  const renderConsent = (consent: PublicationConsent) => {
    const revealed = REVEAL_LABEL_KEYS.filter(({ key }) => consent.redaction_config?.[key]);
    const isResponding = respondingId === consent.consent_id;
    return (
      <View key={consent.consent_id} style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconBg}>
            <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.requester}>
              {t('commons.consent.requestedBy', { who: shortAddress(consent.requesting_wallet_id) })}
            </Text>
            <Text style={styles.institution}>
              {t('commons.consent.toInstitution', { institution: t(`commonsHome.place_${consent.institution}`, { defaultValue: consent.institution.replace(/_/g, ' ') }) })}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={() => setDetailsFor(detailsFor === consent.consent_id ? null : consent.consent_id)}
          accessibilityRole="button"
          style={styles.detailsToggle}
        >
          <Text style={styles.detailsToggleText}>
            {detailsFor === consent.consent_id ? t('commonsHome.hideDetails') : t('commonsHome.showDetails')}
          </Text>
          <Ionicons name={detailsFor === consent.consent_id ? 'chevron-up' : 'chevron-down'} size={14} color={COLORS.textSecondary} />
        </TouchableOpacity>
        {detailsFor === consent.consent_id && (
          <>
            <Text style={styles.peLabel}>{t('commons.consent.peLabel')}</Text>
            <Text style={styles.peValue} numberOfLines={1}>{consent.pe_id}</Text>
          </>
        )}

        <Text style={styles.revealLabel}>{t('commons.consent.willReveal')}</Text>
        {revealed.length === 0 ? (
          <Text style={styles.revealNone}>{t('commons.consent.revealNone')}</Text>
        ) : (
          revealed.map(({ key, labelKey }) => (
            <View key={key} style={styles.revealRow}>
              <Ionicons name="eye-outline" size={13} color={COLORS.textSecondary} />
              <Text style={styles.revealItem}>{t(labelKey)}</Text>
            </View>
          ))
        )}

        <Text style={styles.expiry}>
          {t('commons.consent.expires', { when: safeFormatDate(consent.expires_at, 'MMM d, yyyy') })}
        </Text>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.denyButton, isResponding && styles.buttonDisabled]}
            onPress={() => confirmDeny(consent)}
            disabled={isResponding}
          >
            <Ionicons name="close-circle-outline" size={18} color={COLORS.error} />
            <Text style={styles.denyText}>{t('commons.consent.deny')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.approveButton, isResponding && styles.buttonDisabled]}
            onPress={() => respond(consent, 'approved')}
            disabled={isResponding}
          >
            {isResponding ? (
              <ActivityIndicator size="small" color="#0B0E14" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={18} color="#0B0E14" />
                <Text style={styles.approveText}>{t('commons.consent.approve')}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />

      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} />
        <Text style={styles.headerTitle}>{t('commons.consent.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.explainer}>{t('commons.consent.explainer')}</Text>
          {consents.length === 0 && loadFailed ? (
            <LoadFailed onRetry={() => { void load(); }} />
          ) : consents.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="checkmark-done-circle-outline" size={40} color={COLORS.textTertiary} />
              <Text style={styles.emptyTitle}>{t('commons.consent.emptyTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('commons.consent.emptySubtitle')}</Text>
            </View>
          ) : (
            consents.map(renderConsent)
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  detailsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 6, marginTop: 4 },
  detailsToggleText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
  },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m },
  headerSpacer: { width: 44 },
  content: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  explainer: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginBottom: SPACING.l },
  card: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: 18,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    ...SHADOWS.card,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginBottom: SPACING.m },
  iconBg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(74,142,232,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  requester: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  institution: { fontSize: 12, color: '#8B929E', marginTop: 2 },
  peLabel: {
    fontSize: 10,
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginBottom: 2,
  },
  peValue: { fontSize: 13, color: COLORS.textSecondary, fontFamily: 'monospace', marginBottom: SPACING.m },
  revealLabel: {
    fontSize: 10,
    color: '#9CA3AF',
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  revealNone: { fontSize: 13, color: '#8B929E', marginBottom: SPACING.s, fontStyle: 'italic' },
  revealRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  revealItem: { fontSize: 13, color: COLORS.textSecondary },
  expiry: { fontSize: 12, color: '#9CA3AF', marginTop: SPACING.s, marginBottom: SPACING.m },
  actions: { flexDirection: 'row', gap: SPACING.m },
  denyButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: SPACING.m,
    borderRadius: 28,
    backgroundColor: 'rgba(255,71,87,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,71,87,0.30)',
  },
  denyText: { fontSize: 15, fontWeight: '600', color: COLORS.error },
  approveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: SPACING.m,
    borderRadius: 28,
    backgroundColor: '#4CC38A',
  },
  approveText: { fontSize: 15, fontWeight: '700', color: '#0B0E14' },
  buttonDisabled: { opacity: 0.6 },
  empty: { alignItems: 'center', paddingVertical: SPACING.xxxl },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.text, marginTop: SPACING.m },
  emptySubtitle: { fontSize: 14, color: '#8B929E', marginTop: SPACING.xs, textAlign: 'center' },
});
