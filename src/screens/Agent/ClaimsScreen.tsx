import { enumDisplayCopy } from '../../i18n/displayCopy';
/**
 * ClaimsScreen: File and track claims against agent performance bonds.
 *
 * Shows claim history and allows filing new claims with PE evidence.
 */

import React, { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import type { BondClaimsScreenProps } from '../../navigation/types';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

const RELAY_BASE = 'https://api.provian.ai';

interface ClaimItem {
    claim_id: string;
    bond_id: string;
    claimant_wallet_id: string;
    respondent_wallet_id: string;
    description: string;
    evidence_pe_ids: string[];
    filing_fee_pvt: string;
    status: 'filed' | 'upheld' | 'dismissed';
    created_at: number;
    resolved_at?: number;
}

const STATUS_COLORS: Record<string, string> = {
    filed: '#E8A838',
    upheld: '#4CC38A',
    dismissed: '#FF4444',
};

// i18n keys, resolved with t() at render (module scope has no translation state).
const STATUS_LABEL_KEYS: Record<string, string> = {
    filed: 'claims.statusPending',
    upheld: 'claims.statusUpheld',
    dismissed: 'claims.statusDismissed',
};

export default function ClaimsScreen({ navigation, route }: BondClaimsScreenProps) {
    const { t } = useTranslation();
    const { agentId } = route.params;
    const [claims, setClaims] = useState<ClaimItem[]>([]);
    const [loading, setLoading] = useState(true);

    const loadClaims = useCallback(async () => {
        try {
            setLoading(true);
            const resp = await fetch(`${RELAY_BASE}/v1/bonds/${agentId}`);
            if (!resp.ok) throw new Error('Not found');
            const data = await resp.json();
            const bondData = data as { claims?: ClaimItem[] };
            setClaims(bondData.claims || []);
        } catch {
            setClaims([]);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useFocusEffect(
        useCallback(() => {
            loadClaims();
        }, [loadClaims])
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.background} style={styles.gradient}>
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} color={COLORS.white} />
                    <Text style={styles.headerTitle}>{t('claims.headerTitle')}</Text>
                    <View style={{ width: BACK_BUTTON_SIZE }} />
                </View>

                <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                    {loading ? (
                        <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 40 }} />
                    ) : claims.length === 0 ? (
                        <View style={styles.card}>
                            <Ionicons name="document-text-outline" size={48} color={COLORS.textSecondary} style={{ alignSelf: 'center' }} />
                            <Text style={[styles.emptyText, { textAlign: 'center', marginTop: SPACING.m }]}>
                                {t('claims.emptyTitle')}
                            </Text>
                            <Text style={[styles.infoText, { textAlign: 'center', marginTop: SPACING.s }]}>
                                {t('claims.emptyInfo')}
                            </Text>
                        </View>
                    ) : (
                        claims.map((claim) => (
                            <TouchableOpacity
                                key={claim.claim_id}
                                style={styles.card}
                                onPress={async () => {
                                    try {
                                        const claimResp = await fetch(`${RELAY_BASE}/v1/bonds/claim/${claim.claim_id}`);
                                        if (!claimResp.ok) throw new Error('Not found');
                                        const details = await claimResp.json();
                                        // For now, show an alert with details
                                        const d = details as ClaimItem;
                                        Alert.alert(
                                            t('claims.detailTitle', { status: enumDisplayCopy(d.status) }),
                                            `${d.description}\n\n${t('claims.detailEvidence', { count: d.evidence_pe_ids.length })}\n${t('claims.detailFilingFee', { fee: d.filing_fee_pvt })}\n${t('claims.detailFiled', { date: new Date(d.created_at).toLocaleDateString() })}${d.resolved_at ? `\n${t('claims.detailResolved', { date: new Date(d.resolved_at).toLocaleDateString() })}` : ''}`,
                                        );
                                    } catch {
                                        // Silently fail
                                    }
                                }}
                            >
                                <View style={styles.claimHeader}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.claimDescription} numberOfLines={2}>
                                            {claim.description}
                                        </Text>
                                        <Text style={styles.claimMeta}>
                                            {t('claims.evidenceMeta', { date: new Date(claim.created_at).toLocaleDateString(), count: claim.evidence_pe_ids.length })}
                                        </Text>
                                    </View>
                                    <View style={[
                                        styles.statusBadge,
                                        { backgroundColor: `${STATUS_COLORS[claim.status]}20` }
                                    ]}>
                                        <Text style={[
                                            styles.statusText,
                                            { color: STATUS_COLORS[claim.status] }
                                        ]}>
                                            {STATUS_LABEL_KEYS[claim.status] ? t(STATUS_LABEL_KEYS[claim.status]) : enumDisplayCopy(claim.status)}
                                        </Text>
                                    </View>
                                </View>
                                {claim.status === 'filed' && (
                                    <Text style={styles.pendingText}>
                                        {t('claims.awaitingAdjudication')}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        ))
                    )}

                    {/* Disclosure */}
                    <View style={[styles.card, { backgroundColor: 'rgba(255,255,255,0.03)' }]}>
                        <Ionicons name="information-circle-outline" size={16} color={COLORS.textSecondary} />
                        <Text style={styles.disclosureText}>
                            {t('claims.disclosure')}
                        </Text>
                    </View>
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
    claimHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    claimDescription: {
        fontSize: 15,
        color: COLORS.white,
        fontWeight: '500',
        lineHeight: 20,
    },
    claimMeta: {
        fontSize: 12,
        color: COLORS.textSecondary,
        marginTop: 4,
    },
    statusBadge: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: BORDER_RADIUS.m,
        marginLeft: SPACING.m,
    },
    statusText: {
        fontSize: 13,
        fontWeight: '600',
    },
    pendingText: {
        fontSize: 12,
        color: COLORS.textSecondary,
        fontStyle: 'italic',
        marginTop: SPACING.s,
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
