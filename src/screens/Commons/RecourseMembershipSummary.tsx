import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import { pvtAmount, type RecourseView } from '../../core/recourse/service';

export function RecourseMembershipSummary({ view, pending = false, statusText }: { view: RecourseView; pending?: boolean; statusText?: string }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const details = view.membershipDetails;
  const status = view.membershipState === 'in_progress' ? 'membershipInProgress'
    : view.membershipState === 'unavailable' ? 'membershipUnavailable'
    : view.grace ? 'grace' : view.enrolled ? 'active' : details?.status === 'lapsed' ? 'lapsed' : 'inactive';
  const date = (ms: number): string => new Date(ms).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return <View style={styles.content}>
    <Text style={styles.status}>{pending ? t('common.loading') : statusText ?? t(`recourse.${status}`)}</Text>
    <Text style={styles.body}>{t('recourse.monthly', { burn: pvtAmount(view.participationBurnAtomic),
      percent: view.earningsBps / 100, reserve: pvtAmount(view.noEarningsContributionAtomic) })}</Text>
    {view.membershipState === 'available' && view.unpaidAtomic !== '0'
      ? <Text style={styles.body}>{t('recourse.outstanding', { amount: pvtAmount(view.unpaidAtomic) })}</Text> : null}
    {view.membershipState === 'available' && view.enrolled ? <>
      <Text style={styles.body}>{details?.protectionStartedAtMs != null
        ? t('recourse.protectionStarted', { date: date(details.protectionStartedAtMs) }) : t('recourse.protectionDateUnavailable')}</Text>
      {details?.nextMonthAtMs != null && details.nextBurnAtomic !== null ? <>
        <Text style={styles.body}>{t('recourse.nextBurn', { date: date(details.nextMonthAtMs), amount: pvtAmount(details.nextBurnAtomic) })}</Text>
        {details.noEarningsContributionAtomic !== null ? <Text style={styles.body}>{t('recourse.nextContribution', {
          date: date(details.nextMonthAtMs), amount: pvtAmount(details.noEarningsContributionAtomic) })}</Text> : null}
        <Text style={styles.body}>{t('recourse.earningsContribution', { percent: (details.earningsBps ?? view.earningsBps) / 100 })}</Text>
      </> : <Text style={styles.body}>{t('recourse.scheduleUnavailable')}</Text>}
    </> : null}
  </View>;
}
const styles = StyleSheet.create({ content: { gap: SPACING.s }, status: { color: COLORS.primary, fontSize: 20, fontWeight: '600' },
  body: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 23 } });
