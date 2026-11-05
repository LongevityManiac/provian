/**
 * The home screen's quiet line while records from the person's agents and devices are being filed
 * (findings, 2026-10-23): "Filing N records from your agents…", counting down, gone when
 * filing ends. It asks nothing of the person: the app stays usable the whole time.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../constants/theme';
import { getPhoneMeter } from '../core/meter/phoneMeterRuntime';
import type { MailboxProgress } from '../core/meter/phoneBatcher';

export default function FilingRecordsLine(): React.ReactElement | null {
    const { t } = useTranslation();
    const [filing, setFiling] = React.useState<MailboxProgress | null>(null);
    React.useEffect(() => {
        const meter = getPhoneMeter();
        setFiling(meter.filing());
        return meter.subscribe(() => setFiling(meter.filing()));
    }, []);
    if (filing === null) return null;
    const text = filing.remaining === null
        ? t('dashboard.filingRecordsNoCount')
        : t('dashboard.filingRecords', { count: filing.remaining });
    return (
        <View style={styles.line} accessibilityRole="text" accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color={COLORS.textMuted} />
            <Text style={styles.text}>{text}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingHorizontal: SPACING.xs,
        marginBottom: SPACING.m,
    },
    text: {
        color: COLORS.textMuted,
        fontSize: 13,
    },
});
