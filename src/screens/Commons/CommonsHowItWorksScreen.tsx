import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING } from '../../constants/theme';
import BackButton from '../../components/BackButton';
import { actionStyles, DestinationRow } from '../../components/ScreenActions';
import { selectInstitutionRows } from '../../core/commons/institutionRows';
import { getNetworkStats } from '../../core/commons/CommonsService';

const rows = selectInstitutionRows([]);
const OUTLINE_ICONS = {
    escrow: 'lock-closed-outline', bonds: 'shield-checkmark-outline', market: 'briefcase-outline',
    recourse: 'refresh-outline', court: 'scale-outline', governance: 'checkmark-done-outline', compute: 'server-outline',
} as const;
const metrics = [
    { field: 'commons_humans', label: 'commonsDashboard.statMembers' },
    { field: 'commons_agents', label: 'commonsDashboard.statAgents' },
    { field: 'forum_posts', label: 'commonsDashboard.statPosts' },
] as const;

export default function CommonsHowItWorksScreen() {
    const { t } = useTranslation();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const [stats, setStats] = useState<Record<string, unknown> | null>(null);
    useFocusEffect(useCallback(() => {
        let active = true;
        void getNetworkStats().then(value => { if (active) setStats(value); }).catch(() => {});
        return () => { active = false; };
    }, []));

    return (
        <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.header}><BackButton onPress={navigation.goBack} /></View>
                <Text style={styles.title}>{t('overhaul.commonsHow')}</Text>
                <Text style={actionStyles.body}>{t('overhaul.commonsIntro')}</Text>
                {rows.live.map(row => {
                    const screen = row.screen;
                    return <DestinationRow key={row.id} label={t(row.nameKey)} detail={t(`overhaul.institution.${row.id}`)}
                        stockIcon={OUTLINE_ICONS[row.id]} onPress={screen ? () => navigation.navigate(screen) : undefined} />;
                })}
                <Text style={[actionStyles.sectionTitle, styles.section]}>{t('commonsDashboard.notOpenYet')}</Text>
                {rows.notOpen.map(row => <DestinationRow key={row.id} label={t(row.nameKey)}
                    detail={t(`overhaul.institution.${row.id}`)} stockIcon={OUTLINE_ICONS[row.id]} />)}
                {stats && <View style={styles.section}>
                    <Text style={actionStyles.sectionTitle}>{t('overhaul.networkNumbers')}</Text>
                    {metrics.map(({ field, label }) => {
                        const value = stats[field];
                        return typeof value === 'number' && Number.isFinite(value)
                            ? <DestinationRow key={field} label={t(label, { count: value })} detail={value.toLocaleString()} />
                            : null;
                    })}
                </View>}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    content: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xl },
    header: { flexDirection: 'row' },
    title: { color: COLORS.text, fontSize: 30, fontWeight: '700', marginVertical: SPACING.m },
    section: { marginTop: SPACING.l },
});
