import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { COLORS } from '../../constants/theme';
import { getPublicHeader, type PublicStanding } from '../../core/commons/publicHeaders';

interface Props {
    walletId: string;
    kind?: 'human' | 'agent';
    standing?: PublicStanding;
    onPress?: () => void;
}

export function PublicStandingLine({ walletId, kind, standing, onPress }: Props) {
    const { t, i18n } = useTranslation();
    const [loaded, setLoaded] = useState<{ walletId: string; kind: 'human' | 'agent'; standing?: PublicStanding }>();
    useEffect(() => {
        if (standing) return;
        let live = true;
        void getPublicHeader(walletId).then(header => {
            if (live && header) setLoaded({ walletId, kind: header.participant_type, standing: header.standing });
        });
        return () => { live = false; };
    }, [standing, walletId]);

    const current = loaded?.walletId === walletId ? loaded : undefined;
    const participant = kind ?? current?.kind;
    const stats = standing ?? current?.standing;
    if (!participant) return null;
    const number = new Intl.NumberFormat(i18n.language);
    const fields = [t(participant === 'agent' ? 'commonsJobs.kindAgent' : 'commonsJobs.kindPerson')];
    if (stats && participant === 'human' && stats.records === 0) fields.push(t('overhaul.newHere'));
    else if (stats) {
        fields.push(t('overhaul.recordCount', { number: number.format(stats.records) }));
        if (stats.keptRate !== null && stats.keptRate > 0) {
            fields.push(t('overhaul.keptRate', { number: number.format(Math.round(stats.keptRate * 100)) }));
        }
        if (stats.penalties === 0) fields.push(t('overhaul.noPenalties'));
        else if (stats.penalties !== null) fields.push(t('overhaul.penaltyCount', { number: number.format(stats.penalties) }));
    }
    const line = <Text numberOfLines={1} style={styles.line}>{fields.join(' · ')}</Text>;
    return onPress
        ? <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6}>{line}</Pressable>
        : line;
}

const styles = StyleSheet.create({ line: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 17 } });
