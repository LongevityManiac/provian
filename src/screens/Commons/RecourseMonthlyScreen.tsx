import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { pvtAmount } from '../../core/recourse/service';
import { prepareHumanMembershipDebit, authorizeHumanMembershipDebit, readHumanMembershipApproval,
  resumeHumanMembershipApproval, type HumanMembershipApproval } from '../../core/recourse/human-membership-debit';
import type { MembershipDebitPreparation } from '../../core/recourse/membership-client';

export default function RecourseMonthlyScreen({ navigation }: NativeStackScreenProps<AppParamList, 'RecourseMonthly'>): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<MembershipDebitPreparation | null>(null), [approval, setApproval] = useState<HumanMembershipApproval | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [hash, setHash] = useState<string | null>(null), [result, setResult] = useState<string | null>(null);
  const active = useRef(true), sequence = useRef(0);
  const load = useCallback(async () => {
    const run = ++sequence.current; setLoading(true); setError(false);
    try {
      // Approval recovery stays available even if private reconciliation is pending.
      const pending = await readHumanMembershipApproval();
      if (active.current && run === sequence.current) setApproval(pending);
      const current = await prepareHumanMembershipDebit();
      if (active.current && run === sequence.current) setState(current);
    } catch { if (active.current && run === sequence.current) { setState(null); setError(true); } }
    finally { if (active.current && run === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; ++sequence.current; }; }, [load]);
  const run = async (work: () => Promise<void>) => {
    if (busy || loading) return;
    setBusy(true); setError(false); setResult(null);
    try { await work(); if (active.current) await load(); }
    catch { if (active.current) setError(true); }
    finally { if (active.current) setBusy(false); }
  };
  const button = (label: string, press: () => void) => <TouchableOpacity accessibilityRole="button" onPress={press} disabled={busy || loading}
    style={[styles.button, (busy || loading) && styles.disabled]}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>;
  const challenge = state?.status === 'ready' ? state.challenge : null;
  const month = challenge ? new Date(Date.UTC(Math.floor(Number(challenge.debit.month) / 12), Number(challenge.debit.month) % 12, 1)) : null;
  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /><Text style={styles.title}>{t('recourse.debit.title', 'Monthly burn and contribution')}</Text></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.body}>{t('recourse.debit.explain', 'Review the exact amounts below. The burn destroys PVT; the contribution goes to the Recourse Pool and is not refundable. A separate, exact token approval may require network gas in ETH.')}</Text>
      {loading || busy ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <Text style={styles.body}>{t('recourse.error')}</Text> : null}
      {result ? <Text style={styles.body}>{t(`recourse.debit.${result}`)}</Text> : null}
      {hash ? <Text selectable style={styles.address}>{hash}</Text> : null}
      {approval ? <View style={styles.card}>
        <Text style={styles.title}>{t('recourse.debit.previous', 'Finish the previous token approval')}</Text>
        <Text style={styles.body}>{t('recourse.debit.approvalAmount', 'Token allowance: {{amount}} PVT', { amount: pvtAmount(approval.amountAtomic) })}</Text>
        <Text style={styles.body}>{t('recourse.debit.token', 'Token contract')}</Text><Text selectable style={styles.address}>{approval.kernel}</Text>
        <Text style={styles.body}>{t('recourse.debit.spender', 'Authorized recipient')}</Text><Text selectable style={styles.address}>{approval.pool}</Text>
        <Text style={styles.small}>{t('recourse.debit.hashGas', 'For a recovered hash wallet, the original wallet address carries only ETH gas. The hash key controls PVT. The app confirms the result and next key before a new authorization.')}</Text>
        {button(t('recourse.debit.resume', 'Resume exact approval'), () => { void run(async () => {
          const delivery = await resumeHumanMembershipApproval(approval);
          if (active.current) { setHash(delivery.transactionHash); setResult(delivery.status === 'complete' ? delivery.outcome : delivery.status); }
        }); })}
      </View> : null}
      {challenge && !approval ? <View style={styles.card}>
        <Text style={styles.title}>{month?.toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', timeZone: 'UTC' })}</Text>
        <Text style={styles.body}>{t('recourse.debit.burn', 'Burn: {{amount}} PVT', { amount: pvtAmount(challenge.debit.burn) })}</Text>
        <Text style={styles.body}>{t('recourse.debit.reserve', 'Contribution: {{amount}} PVT', { amount: pvtAmount(challenge.debit.reserve) })}</Text>
        <Text style={styles.body}>{t('recourse.debit.total', 'Total from this wallet: {{amount}} PVT', { amount: pvtAmount(challenge.allowanceAtomic) })}</Text>
        <Text selectable style={styles.address}>{challenge.debit.payer}</Text>
        {button(t('recourse.debit.authorize', 'Authorize these exact amounts'), () => { void run(async () => {
          const outcome = await authorizeHumanMembershipDebit(challenge);
          if (!active.current) return;
          if (outcome.status === 'submitted') { setHash(outcome.operation.transactionHash); setResult('submitted'); }
          else { setHash(outcome.delivery.transactionHash); setResult(outcome.delivery.status === 'complete' ? outcome.delivery.outcome : outcome.delivery.status); }
        }); })}
      </View> : null}
      {state?.status === 'settled' ? <Text style={styles.body}>{t('recourse.debit.settled', 'All obligations currently due are complete. A no-earnings contribution is determined after that month ends.')}</Text> : null}
      {state?.status === 'pending' ? <View style={styles.card}><Text style={styles.body}>{t('recourse.debit.pending', 'An earlier action is still being reconciled. Refresh to check its result; its authorization will not be replaced while it is unresolved.')}</Text>
        {state.operation?.transactionHash ? <Text selectable style={styles.address}>{state.operation.transactionHash}</Text> : null}</View> : null}
      {button(t('recourse.refresh'), () => { void load(); })}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background }, header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, padding: SPACING.m },
  content: { padding: SPACING.m, paddingBottom: SPACING.xxxl, gap: SPACING.l }, title: { color: COLORS.text, fontSize: 21, fontWeight: '600' },
  body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 23 }, small: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 20 },
  address: { color: COLORS.text, fontSize: 12, lineHeight: 20 }, card: { padding: SPACING.l, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, gap: SPACING.m },
  button: { padding: SPACING.m, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.5 },
});
