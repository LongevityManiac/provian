import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { getLastRecourseOverview, pvtAmount, readRecourseOverview, type RecourseView } from '../../core/recourse/service';
import type { AppParamList } from '../../navigation/types';
import { useWalletStore } from '../../store/walletStore';
import { RecourseApprovalStatus } from './RecourseApprovalStatus';
import { RecourseMembershipSummary } from './RecourseMembershipSummary';

export default function RecourseMonthlyScreen({ navigation }: NativeStackScreenProps<AppParamList, 'RecourseMonthly'>): React.JSX.Element {
  const { t } = useTranslation();
  const wallet = useWalletStore(state => state.address)?.toLowerCase();
  const focused = useIsFocused();
  const [loaded, setView] = useState<RecourseView | null>(() => getLastRecourseOverview(wallet));
  const view = loaded?.currentAddress === wallet && loaded ? loaded : null;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    const next = await readRecourseOverview().catch(() => null);
    if (request !== sequence.current) return;
    if (next) setView(next);
    setFailed(next === null);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    setView(getLastRecourseOverview(wallet));
    setFailed(false);
    if (wallet) void load();
    else setLoading(false);
    return () => { ++sequence.current; };
  }, [wallet, load]));

  useEffect(() => {
    if (!focused || !wallet || loading || view?.membershipState !== 'in_progress') return;
    const timer = setTimeout(() => { void load(); }, failed ? 30_000 : 8_000);
    return () => clearTimeout(timer);
  }, [focused, wallet, view, failed, loading, load]);

  const approval = view?.monthlyApproval;
  const unavailable = failed || Boolean(view?.monthlyApprovalStale) || (!loading && Boolean(view?.enrolled) && !approval);
  const canAct = !loading && !unavailable && view?.membershipState === 'available';

  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}>
      <BackButton onPress={() => navigation.goBack()} />
      <Text style={styles.title}>{t('recourse.standing.details')}</Text>
    </View>
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading && !view} onRefresh={() => { void load(); }} />}>
      {view ? <RecourseMembershipSummary view={view} /> : null}
      {loading && !view ? <ActivityIndicator color={COLORS.primary} /> : null}
      <RecourseApprovalStatus approval={approval} unavailable={unavailable} />
      {view?.membershipState === 'available' ? <View style={styles.card}>
        <Text style={styles.body}>{!view.enrolled && view.unpaidAtomic !== '0'
          ? t('recourse.rejoin.explain') : t('recourse.standing.background')}</Text>
        {approval ? <Text style={styles.body}>{t('recourse.standing.limits', {
          burn: pvtAmount(approval.burnLimit),
          reserve: pvtAmount(approval.reserveLimit),
          percent: approval.earningsBpsLimit / 100,
        })}</Text> : null}
        <Text style={styles.body}>{t('recourse.standing.noEarnings')}</Text>
        <Text style={styles.body}>{view.unpaidAtomic === '0' ? t('recourse.standing.current')
          : !view.enrolled ? t('recourse.outstanding', { amount: pvtAmount(view.unpaidAtomic) })
          : t('recourse.standing.pendingAmount', { amount: pvtAmount(view.unpaidAtomic) })}</Text>
        <Text style={styles.body}>{t('recourse.graceSummary')}</Text>
      </View> : null}
      {canAct && !view.enrolled ? <ActionTouchable accessibilityRole="button" style={styles.button}
        onPress={() => navigation.navigate('RecourseMembership', { kind: 'join' })}>
        <Text style={styles.buttonText}>{t('recourse.join')}</Text>
      </ActionTouchable> : null}
      {canAct && view.enrolled && approval?.status === 'approval_required' ? <View style={styles.card}>
        <Text style={styles.body}>{t('recourse.standing.increase')}</Text>
        <ActionTouchable accessibilityRole="button" style={styles.button}
          onPress={() => navigation.navigate('RecourseMembership', { kind: 'renew' })}>
          <Text style={styles.buttonText}>{t('recourse.standing.review')}</Text>
        </ActionTouchable>
      </View> : null}
      {view?.membershipTransition ? <ActionTouchable accessibilityRole="button" style={styles.button}
        onPress={() => navigation.navigate('RecourseMembership', { kind: 'resume' })}>
        <Text style={styles.buttonText}>{t('recourse.flow.title')}</Text>
      </ActionTouchable> : null}
      <Text style={styles.body}>{t('recourse.standing.leave')}</Text>
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, padding: SPACING.m },
  content: { padding: SPACING.m, gap: SPACING.l },
  title: { fontSize: 22, fontWeight: '600', color: COLORS.text },
  body: { fontSize: 15, lineHeight: 23, color: COLORS.textSecondary },
  card: { padding: SPACING.l, borderRadius: BORDER_RADIUS.l, backgroundColor: COLORS.surface, gap: SPACING.m },
  button: { padding: SPACING.m, borderRadius: BORDER_RADIUS.m, backgroundColor: COLORS.primary },
  buttonText: { color: COLORS.onPrimary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
});
