import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, SHADOWS } from '../../../constants/theme';
import { useTranslation } from 'react-i18next';
import BackButton from '../../../components/BackButton';

const ExitStrategyInfoScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={COLORS.chrome} />
                <Text style={styles.headerTitle}>{t('exitStrategyInfo.headerTitle')}</Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.iconContainer}>
                    <View style={styles.iconGlow}>
                        <Ionicons name="exit" size={48} color={COLORS.primary} />
                    </View>
                </View>

                <Text style={styles.title}>{t('exitStrategyInfo.title')}</Text>
                <Text style={styles.subtitle}>
                    {t('exitStrategyInfo.subtitle')}
                </Text>

                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('exitStrategyInfo.sectionOptions')}</Text>

                    <View style={styles.optionCard}>
                        <View style={[styles.optionIcon, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                            <Ionicons name="swap-horizontal" size={22} color={COLORS.primary} />
                        </View>
                        <View style={styles.optionContent}>
                            <Text style={styles.optionTitle}>{t('exitStrategyInfo.sendTitle')}</Text>
                            <Text style={styles.optionDesc}>
                                {t('exitStrategyInfo.sendDesc')}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.optionCard}>
                        <View style={[styles.optionIcon, { backgroundColor: 'rgba(251, 191, 36, 0.14)' }]}>
                            <Ionicons name="key" size={22} color="#F59E0B" />
                        </View>
                        <View style={styles.optionContent}>
                            <Text style={styles.optionTitle}>{t('exitStrategyInfo.exportTitle')}</Text>
                            <Text style={styles.optionDesc}>
                                {t('exitStrategyInfo.exportDesc')}
                            </Text>
                            <TouchableOpacity
                                style={[styles.actionButton, { backgroundColor: 'rgba(251, 191, 36, 0.12)' }]}
                                onPress={() => navigation.navigate('ExportMnemonic')}
                            >
                                <Text style={[styles.actionButtonText, { color: '#F59E0B' }]}>{t('exitStrategyInfo.exportButton')}</Text>
                                <Ionicons name="arrow-forward" size={14} color="#F59E0B" />
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>

                <View style={styles.footer}>
                    <Ionicons name="shield-checkmark" size={15} color={COLORS.textTertiary} />
                    <Text style={styles.footerText}>{t('exitStrategyInfo.footerNote')}</Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    headerTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: COLORS.text,
        letterSpacing: 0.3,
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxl,
    },
    iconContainer: {
        alignItems: 'center',
        marginVertical: SPACING.l,
    },
    iconGlow: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(74, 142, 232, 0.12)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(74, 142, 232, 0.20)',
    },
    title: {
        fontSize: 26,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
        letterSpacing: -0.3,
    },
    subtitle: {
        fontSize: 15,
        color: COLORS.textSecondary,
        textAlign: 'center',
        marginBottom: SPACING.xl,
        lineHeight: 22,
    },
    section: {
        gap: SPACING.m,
    },
    sectionLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.xs,
    },
    optionCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        flexDirection: 'row',
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        ...SHADOWS.card,
    },
    optionIcon: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionContent: {
        flex: 1,
    },
    optionTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    optionDesc: {
        fontSize: 13,
        color: COLORS.textSecondary,
        marginBottom: SPACING.m,
        lineHeight: 19,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(74, 142, 232, 0.12)',
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 28,
        alignSelf: 'flex-start',
    },
    actionButtonText: {
        color: COLORS.primary,
        fontWeight: '600',
        fontSize: 13,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        marginTop: SPACING.xl,
        marginBottom: SPACING.l,
    },
    footerText: {
        color: COLORS.textTertiary,
        fontSize: 13,
    },
});

export default ExitStrategyInfoScreen;
