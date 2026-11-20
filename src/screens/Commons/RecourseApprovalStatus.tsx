import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import type { RecourseMonthlyApproval } from '../../core/recourse/service';

export function RecourseApprovalStatus({ approval, unavailable }: {
  approval: RecourseMonthlyApproval | undefined;
  unavailable: boolean;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  if (!approval && !unavailable) return null;
  return <View style={styles.status}>
    {approval ? <Text style={styles.label}>{t(approval.status === 'approved'
      ? 'recourse.standing.enabled' : 'recourse.standing.approvalNeeded')}</Text> : null}
    {unavailable ? <Text style={styles.detail}>{t('recourse.standing.refreshFailed')}</Text> : null}
    {unavailable && approval ? <Text style={styles.detail}>{t('recourse.standing.lastChecked', {
      time: new Date(approval.checkedAtMs).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }),
    })}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  status: { gap: SPACING.xs },
  label: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  detail: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 20 },
});
