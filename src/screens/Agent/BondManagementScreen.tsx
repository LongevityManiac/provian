import { enumDisplayCopy } from '../../i18n/displayCopy';
/**
 * BondManagementScreen: read-only status view for an agent's performance bond.
 *
 * Shows current bond status, amount, renewal deadline, trust discount and a
 * tappable summary of claims filed against the bond (opens ClaimsScreen).
 * Renew/withdraw are bond-lifecycle actions performed by the agent operator
 * and are not yet surfaced here.
 */

import React, { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import type { BondManagementScreenProps } from '../../navigation/types';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

const RELAY_BASE = 'https://api.provian.ai';

interface BondData {
    bond: {
        bond_id: string;
        status: string;
        amount_pvt: string;
        trust_discount_bps: number;
        renewal_deadline: number;
        last_renewal_at: number;
        pending_claims: number;
        chain: string;
        created_at: number;
    };
    claims: Array<{
        claim_id: string;
        status: string;
        claimant_wallet_id: string;
        description: string;
        created_at: number;
    }>;
    renewals: Array<{
        renewal_id: string;
        new_deadline: number;
        renewed_at: number;
    }>;
}

export default function BondManagementScreen({ navigation, route }: BondManagementScreenProps) {
    const { t } = useTranslation();
    const { agentId } = route.params;
    const [bondData, setBondData] = useState<BondData | null>(null);
    const [loading, setLoading] = useState(true);

    const loadBondData = useCallback(async () => {
        try {
            setLoading(true);
            const resp = await fetch(`${RELAY_BASE}/v1/bonds/${agentId}`);
            if (!resp.ok) throw new Error('Not found');
            const data = await resp.json();
            setBondData(data as BondData);
        } catch {
            setBondData(null);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useFocusEffect(
        useCallback(() => {
            loadBondData();
        }, [loadBondData])
    );

    const daysUntilRenewal = bondData?.bond?.renewal_deadline
        ? Math.max(0, Math.ceil((bondData.bond.renewal_deadline - Date.now()) / (24 * 60 * 60 * 1000)))
        : null;

    const isHealthy = bondData?.bond?.status === 'active' &&
        bondData.bond.renewal_deadline > Date.now();

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.background} style={styles.gradient}>
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} color={COLORS.white} />
                    <Text style={styles.headerTitle}>{t('bondManagement.headerTitle')}</Text>
                    <View style={{ width: BACK_BUTTON_SIZE }} />
                </View>

                <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                    {loading ? (
                        <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 40 }} />
                    ) : !bondData?.bond ? (
                        <View style={styles.card}>
                            <Ionicons name="shield-outline" size={48} color={COLORS.textSecondary} style={{ alignSelf: 'center' }} />
                            <Text style={[styles.emptyText, { textAlign: 'center', marginTop: SPACING.m }]}>
                                {t('bondManagement.emptyNoBond')}
                            </Text>
                            <Text style={[styles.infoText, { textAlign: 'center', marginTop: SPACING.s }]}>
                                {t('bondManagement.emptyNoBondInfo')}
                            </Text>
                        </View>
                    ) : (
                        <>
                            {/* Bond Status Card */}
                            <View style={styles.card}>
                                <View style={styles.cardHeader}>
                                    <Ionicons
                                        name={isHealthy ? 'shield-checkmark' : 'shield-half'}
                                        size={24}
                                        color={isHealthy ? '#4CC38A' : '#E8A838'}
                                    />
                                    <View style={{ marginLeft: SPACING.m, flex: 1 }}>
                                        <Text style={styles.bondAmount}>
                                            {Number(bondData.bond.amount_pvt).toLocaleString()} PVT
                                        </Text>
                                        <Text style={[styles.statusText, { color: isHealthy ? '#4CC38A' : '#E8A838' }]}>
                                            {bondData.bond.status === 'active' && isHealthy
                                                ? t('bondManagement.statusActive')
                                                : bondData.bond.status === 'active'
                                                ? t('bondManagement.statusExpiringSoon')
                                                : enumDisplayCopy(bondData.bond.status)}
                                        </Text>
                                    </View>
                                </View>
                            </View>

                            {/* Details Card */}
                            <View style={styles.card}>
                                <Text style={styles.sectionTitle}>{t('bondManagement.detailsTitle')}</Text>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>{t('bondManagement.renewalDue')}</Text>
                                    <Text style={[
                                        styles.detailValue,
                                        daysUntilRenewal !== null && daysUntilRenewal < 14 && { color: '#E8A838' }
                                    ]}>
                                        {daysUntilRenewal !== null
                                            ? t('bondManagement.renewalDays', { count: daysUntilRenewal })
                                            : t('bondManagement.notAvailable')}
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>{t('bondManagement.trustDiscount')}</Text>
                                    <Text style={styles.detailValue}>
                                        {(bondData.bond.trust_discount_bps / 100).toFixed(1)}%
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>{t('bondManagement.pendingClaims')}</Text>
                                    <Text style={[
                                        styles.detailValue,
                                        bondData.bond.pending_claims > 0 && { color: COLORS.error }
                                    ]}>
                                        {bondData.bond.pending_claims}
                                    </Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>{t('bondManagement.chainLabel')}</Text>
                                    <Text style={styles.detailValue}>{bondData.bond.chain}</Text>
                                </View>
                                <View style={styles.detailRow}>
                                    <Text style={styles.detailLabel}>{t('bondManagement.createdLabel')}</Text>
                                    <Text style={styles.detailValue}>
                                        {new Date(bondData.bond.created_at).toLocaleDateString()}
                                    </Text>
                                </View>
                            </View>

                            {/* Claims Section - tap to review all claims filed against this bond */}
                            <TouchableOpacity
                                style={styles.card}
                                activeOpacity={0.7}
                                onPress={() => navigation.navigate('BondClaims', { agentId })}
                            >
                                <View style={styles.cardHeader}>
                                    <Text style={[styles.sectionTitle, { marginBottom: 0, flex: 1 }]}>
                                        {bondData.claims.length > 0
                                            ? t('bondManagement.claimsTitleWithCount', { count: bondData.claims.length })
                                            : t('bondManagement.claimsTitle')}
                                    </Text>
                                    <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
                                </View>
                                {bondData.claims.length === 0 ? (
                                    <Text style={[styles.infoText, { marginTop: SPACING.s }]}>
                                        {t('bondManagement.noClaims')}
                                    </Text>
                                ) : (
                                    bondData.claims.slice(0, 3).map((claim) => (
                                        <View key={claim.claim_id} style={styles.claimRow}>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.claimDescription} numberOfLines={1}>
                                                    {claim.description}
                                                </Text>
                                                <Text style={styles.claimDate}>
                                                    {new Date(claim.created_at).toLocaleDateString()}
                                                </Text>
                                            </View>
                                            <Text style={[
                                                styles.claimStatus,
                                                claim.status === 'filed' && { color: COLORS.warning },
                                                claim.status === 'upheld' && { color: COLORS.error },
                                                claim.status === 'dismissed' && { color: COLORS.success },
                                            ]}>
                                                {enumDisplayCopy(claim.status)}
                                            </Text>
                                        </View>
                                    ))
                                )}
                            </TouchableOpacity>

                            {/* Renewal History */}
                            {bondData.renewals.length > 0 && (
                                <View style={styles.card}>
                                    <Text style={styles.sectionTitle}>
                                        {t('bondManagement.renewalsTitle', { count: bondData.renewals.length })}
                                    </Text>
                                    {bondData.renewals.slice(0, 5).map((renewal) => (
                                        <View key={renewal.renewal_id} style={styles.detailRow}>
                                            <Text style={styles.detailLabel}>
                                                {new Date(renewal.renewed_at).toLocaleDateString()}
                                            </Text>
                                            <Text style={styles.detailValue}>
                                                {t('bondManagement.extendedTo', { date: new Date(renewal.new_deadline).toLocaleDateString() })}
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            )}

                            {/* Disclosure */}
                            <View style={[styles.card, { backgroundColor: 'rgba(255,255,255,0.03)' }]}>
                                <Ionicons name="information-circle-outline" size={16} color={COLORS.textSecondary} />
                                <Text style={styles.disclosureText}>
                                    {t('bondManagement.disclosure')}
                                </Text>
                            </View>
                        </>
                    )}
                </ScrollView>
            </LinearGradient>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    gradient: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.white,
    },
    content: { flex: 1, paddingHorizontal: SPACING.l },
    card: {
        backgroundColor: COLORS.surface,
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.l,
        marginBottom: SPACING.m,
        ...SHADOWS.card,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    bondAmount: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.white,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '600',
        marginTop: 2,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.white,
        marginBottom: SPACING.m,
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: SPACING.xs,
    },
    detailLabel: {
        fontSize: 14,
        color: COLORS.textSecondary,
    },
    detailValue: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.white,
    },
    claimRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255,255,255,0.08)',
    },
    claimDescription: {
        fontSize: 14,
        color: COLORS.white,
    },
    claimDate: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 2,
    },
    claimStatus: {
        fontSize: 13,
        fontWeight: '600',
        marginLeft: SPACING.m,
    },
    emptyText: {
        fontSize: 16,
        color: COLORS.white,
        fontWeight: '600',
    },
    infoText: {
        fontSize: 14,
        color: COLORS.textSecondary,
        lineHeight: 20,
    },
    disclosureText: {
        fontSize: 12,
        color: COLORS.textSecondary,
        lineHeight: 18,
        marginTop: SPACING.xs,
    },
});
