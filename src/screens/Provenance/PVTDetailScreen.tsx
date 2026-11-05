/**
 * PVTDetailScreen
 *
 * Shows truthful record-only participation data:
 * - Sealed record points and PE breakdown
 * - PE breakdown by category
 * - How PVT is earned
 * - Explicit unconfigured PVT9 status
 */

import React, { useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    ActivityIndicator,
    Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import relayService from '../../services/RelayAPIService';
import type { PVTAccrual } from '../../services/RelayAPIService';
import BackButton from '../../components/BackButton';

const PVT_PURPLE = '#6BA3F0';

interface PVTDetailScreenProps {
    navigation: {
        goBack: () => void;
        navigate: (screen: string, params?: Record<string, unknown>) => void;
    };
}

const CATEGORY_LABELS: Record<string, { labelKey: string; icon: keyof typeof Ionicons.glyphMap }> = {
    wallet: { labelKey: 'pvtDetail.categoryWallet', icon: 'wallet-outline' },
    agent: { labelKey: 'pvtDetail.categoryWork', icon: 'code-slash-outline' },
    x402: { labelKey: 'pvtDetail.categoryX402', icon: 'card-outline' },
    promises: { labelKey: 'pvtDetail.categoryPromises', icon: 'people-outline' },
    other: { labelKey: 'pvtDetail.categoryOther', icon: 'apps-outline' },
};

const PVTDetailScreen = ({ navigation }: PVTDetailScreenProps) => {
    const { t } = useTranslation();
    const [accrual, setAccrual] = useState<PVTAccrual | null>(null);
    const [loading, setLoading] = useState(true);
    const [retryToken, setRetryToken] = useState(0);

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            (async () => {
                setLoading(true);
                const data = await relayService.getPVTAccrual();
                if (!cancelled) {
                    setAccrual(data);
                    setLoading(false);
                }
            })();
            return () => { cancelled = true; };
        }, [retryToken])
    );

    const totalPEs = accrual?.totalPEs ?? 0;
    const weeklyPEs = accrual?.weeklyPEs ?? 0;
    const categories = Object.fromEntries(
        (accrual?.breakdown ?? []).map((item) => [item.category, item.peCount]),
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Hero Image */}
            <View style={{ height: 180, overflow: 'hidden' }}>
                <Image
                    source={require('../../../assets/images/pvt-hero.png')}
                    style={{ width: '100%', height: '100%', position: 'absolute' }}
                    resizeMode="cover"
                />
                <LinearGradient
                    colors={['transparent', COLORS.background]}
                    style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 60 }}
                />
            </View>

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>PVT</Text>
                <View style={styles.headerSpacer} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {loading ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={PVT_PURPLE} />
                    </View>
                ) : !accrual ? (
                    <View style={styles.loadingContainer}>
                        <Text style={{ color: COLORS.textSecondary }}>{t('provenanceDashboard.loadRecordErrorTitle')}</Text>
                        <TouchableOpacity onPress={() => setRetryToken((value) => value + 1)}>
                            <Text style={{ color: COLORS.primary, marginTop: SPACING.m }}>{t('common.tryAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <>
                        {/* Hero Card */}
                        <LinearGradient
                            colors={['#6BA3F0', '#4F46E5'] as const}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.heroCard}
                        >
                            <Text style={styles.heroLabel}>{t('pvtDetail.heroLabel')}</Text>
                            <Text style={styles.heroValue}>{totalPEs.toLocaleString()}</Text>
                            <Text style={styles.heroSub}>{t('pvtDetail.heroSettlementGated')}</Text>
                            <Text style={styles.heroSub}>{t('pvtDetail.heroNoRightToPvt')}</Text>
                            <Text style={styles.heroActions}>{t('pvtDetail.heroThisWeek', { value: weeklyPEs.toLocaleString() })}</Text>
                        </LinearGradient>

                        {/* PE Breakdown by Category */}
                        {accrual && (
                            <View style={styles.section}>
                                <Text style={styles.sectionLabel}>{t('pvtDetail.participationBreakdown')}</Text>
                                <View style={styles.categoryGrid}>
                                    {Object.entries(CATEGORY_LABELS).map(([key, { labelKey, icon }]) => (
                                        <View key={key} style={styles.categoryCard}>
                                            <Ionicons name={icon} size={20} color={PVT_PURPLE} />
                                            <Text style={styles.categoryCount}>
                                                {categories[key] ?? 0}
                                            </Text>
                                            <Text style={styles.categoryLabel}>{t(labelKey)}</Text>
                                        </View>
                                    ))}
                                </View>
                                <View style={styles.weeklyRow}>
                                    <Ionicons name="calendar-outline" size={16} color={COLORS.textSecondary} />
                                    <Text style={styles.weeklyText}>
                                        {t('pvtDetail.actionsThisWeek', { count: weeklyPEs })}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {/* Eligibility */}
                        <View style={styles.section}>
                            <Text style={styles.sectionLabel}>{t('pvtDetail.eligibilityTitle')}</Text>
                            <View style={styles.infoCard}>
                                {[
                                    t('pvtDetail.bulletCoveredActions'),
                                    t('pvtDetail.bulletRecordsNotPvt'),
                                    t('pvtDetail.bulletEligibleMayMint'),
                                    t('pvtDetail.bulletEligibilityDepends'),
                                ].map((text, i) => (
                                    <View key={i} style={styles.bulletRow}>
                                        <View style={styles.bullet} />
                                        <Text style={styles.bulletText}>{text}</Text>
                                    </View>
                                ))}
                                <Text style={[styles.bulletText, { marginTop: SPACING.xs, opacity: 0.7 }]}>
                                    {t('pvtDetail.noPriceNote')}
                                </Text>
                            </View>
                        </View>

                        {/* Current availability */}
                        <View style={styles.section}>
                            <Text style={styles.sectionLabel}>{t('pvtDetail.availabilityTitle')}</Text>
                            <View style={styles.infoCard}>
                                {[
                                    { icon: 'checkmark-circle-outline' as const, text: t('pvtDetail.availSettlement') },
                                    { icon: 'shield-outline' as const, text: t('pvtDetail.availInstitutions') },
                                    { icon: 'document-text-outline' as const, text: t('pvtDetail.availPeHistory') },
                                ].map((item, i) => (
                                    <View key={i} style={styles.useRow}>
                                        <Ionicons name={item.icon} size={18} color={PVT_PURPLE} />
                                        <Text style={styles.useText}>{item.text}</Text>
                                    </View>
                                ))}
                            </View>
                        </View>

                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    headerSpacer: { width: 44 },
    scrollContent: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxxl,
    },
    loadingContainer: {
        paddingTop: SPACING.xxxl,
        alignItems: 'center',
    },

    // Hero
    heroCard: {
        borderRadius: 18,
        padding: SPACING.xl,
        marginBottom: SPACING.xl,
        alignItems: 'center',
    },
    heroLabel: {
        fontSize: 14,
        color: 'rgba(255,255,255,0.7)',
        marginBottom: SPACING.xs,
    },
    heroValue: {
        fontSize: 40,
        fontWeight: '700',
        color: '#FFFFFF',
    },
    heroSub: {
        fontSize: 14,
        color: 'rgba(255,255,255,0.7)',
        marginTop: SPACING.xs,
    },
    heroActions: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.5)',
        marginTop: SPACING.xs,
    },

    // Sections
    section: {
        marginBottom: SPACING.xl,
    },
    sectionLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: '#9CA3AF',
        textTransform: 'uppercase',
        letterSpacing: 1.5,
        marginBottom: SPACING.m,
    },

    // Category Grid - glass cards
    categoryGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.s,
    },
    categoryCard: {
        flex: 1,
        minWidth: '45%',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        gap: SPACING.xs,
    },
    categoryCount: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.chromeMuted,
    },
    categoryLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: '#8B929E',
    },
    categoryPvt: {
        fontSize: 11,
        color: '#9CA3AF',
    },
    weeklyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
    },
    weeklyText: {
        fontSize: 13,
        color: '#8B929E',
    },

    // Info Cards - glass cards
    infoCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        gap: SPACING.m,
    },
    bulletRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
    },
    bullet: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: PVT_PURPLE,
        marginTop: 7,
    },
    bulletText: {
        flex: 1,
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 20,
    },
    useRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
    },
    useText: {
        flex: 1,
        fontSize: 14,
        color: '#8B929E',
        lineHeight: 20,
    },

    // Buttons
    buttonRow: {
        flexDirection: 'row',
        gap: SPACING.m,
    },
    actionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        backgroundColor: PVT_PURPLE,
        borderRadius: 28,
        paddingVertical: SPACING.m,
    },
    receiveButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: PVT_PURPLE,
    },
    actionButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
});

export default PVTDetailScreen;
