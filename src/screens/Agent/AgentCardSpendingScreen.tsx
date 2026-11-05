/**
 * AgentCardSpendingScreen — "Card spending (Stripe Link)" for a linked agent
 *.
 *
 * Explains the existing card rail truthfully and hands the human one
 * paste-ready message for their agent. The human's Link account holds the
 * card; the agent installs the Link CLI on its own computer and authorizes it
 * with that account; each spend is approved by the human in Link. Provian
 * never holds, asks for, or displays card data (Security Invariant #1), and
 * never tells the agent to report a spend itself — a spend is recorded as a
 * witnessed `link_spend` only where Provian's observer on the agent's computer
 * sees the Link CLI result.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { LINK_CARD_SETUP_MESSAGE } from '../../core/agents/linkCardSetup';

const Bullet = ({ icon, text }: { icon: React.ComponentProps<typeof Ionicons>['name']; text: string }): React.JSX.Element => (
    <View style={styles.bulletRow}>
        <Ionicons name={icon} size={16} color={COLORS.primary} style={styles.bulletIcon} />
        <Text style={styles.bulletText}>{text}</Text>
    </View>
);

const AgentCardSpendingScreen = (): React.JSX.Element => {
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList, 'AgentCardSpending'>>();
    const route = useRoute<RouteProp<AppParamList, 'AgentCardSpending'>>();
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    const agentName = route.params?.agentName?.trim() || t('agentCardSpending.yourAgent');

    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
    }, []);
    const copy = useCallback(async () => {
        await Clipboard.setStringAsync(LINK_CARD_SETUP_MESSAGE);
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    }, []);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]} numberOfLines={2}>
                    {t('agentCardSpending.title')}
                </Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <Text style={[styles.intro, { color: themeColors.textSecondary }]}>
                    {t('agentCardSpending.intro', { name: agentName })}
                </Text>

                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('agentCardSpending.howTitle')}
                    </Text>
                    <Bullet icon="person-circle-outline" text={t('agentCardSpending.how1')} />
                    <Bullet icon="terminal-outline" text={t('agentCardSpending.how2', { name: agentName })} />
                    <Bullet icon="checkmark-done-outline" text={t('agentCardSpending.how3')} />
                    <Bullet icon="shield-checkmark-outline" text={t('agentCardSpending.how4')} />
                </View>

                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('agentCardSpending.witnessTitle')}
                    </Text>
                    <Text style={styles.body}>{t('agentCardSpending.witnessBody')}</Text>
                    <Text style={styles.body}>{t('agentCardSpending.witnessHosted')}</Text>
                </View>

                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('agentCardSpending.messageTitle', { name: agentName })}
                    </Text>
                    <Text style={styles.body}>{t('agentCardSpending.messageLead')}</Text>
                    <TouchableOpacity
                        style={styles.messageBlock}
                        onPress={copy}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={t('agentCardSpending.copyMessage')}
                    >
                        <Text style={styles.messageText} selectable>{LINK_CARD_SETUP_MESSAGE}</Text>
                        <View style={styles.copyRow}>
                            <Ionicons
                                name={copied ? 'checkmark-circle' : 'copy-outline'}
                                size={16}
                                color={copied ? COLORS.success : COLORS.primary}
                            />
                            <Text style={styles.copyText}>
                                {copied ? t('agentCardSpending.copied') : t('agentCardSpending.copyMessage')}
                            </Text>
                        </View>
                    </TouchableOpacity>
                </View>

                <View style={styles.noteRow}>
                    <Ionicons name="lock-closed-outline" size={14} color={COLORS.textMuted} />
                    <Text style={styles.noteText}>{t('agentCardSpending.neverCard')}</Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingTop: SPACING.s,
        // the title can take two lines at 320dp ("Card spending (Stripe
        // Link)"); a real gap + hairline keeps it off the intro below.
        paddingBottom: SPACING.m,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: COLORS.borderLight,
    },
    headerTitle: { fontSize: 17, lineHeight: 22, fontWeight: '700', flex: 1, minWidth: 0, textAlign: 'center', marginHorizontal: SPACING.s },
    scrollContent: { paddingHorizontal: SPACING.m, paddingTop: SPACING.m, paddingBottom: SPACING.xxl },
    intro: { fontSize: 15, lineHeight: 22, marginBottom: SPACING.l },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        marginBottom: SPACING.m,
    },
    cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: SPACING.s },
    body: { fontSize: 13, lineHeight: 20, color: COLORS.textSecondary, marginBottom: SPACING.s },
    bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, marginTop: SPACING.s },
    bulletIcon: { marginTop: 2 },
    bulletText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20, color: COLORS.textSecondary },
    messageBlock: {
        backgroundColor: 'rgba(0,0,0,0.35)',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        gap: SPACING.s,
    },
    messageText: { fontSize: 11, lineHeight: 16, color: '#C8D0DC', fontFamily: 'Courier' },
    copyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, alignSelf: 'flex-end', maxWidth: '100%' },
    copyText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: COLORS.primary },
    noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, marginTop: SPACING.s },
    noteText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: COLORS.textMuted },
});

export default AgentCardSpendingScreen;
