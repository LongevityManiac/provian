import { errorDisplayCopy } from '../../i18n/displayCopy';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { LinearGradient } from 'expo-linear-gradient';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

// I-U-9: shape-of-truth for the legacy envelope objects returned by
// ProvenanceEnvelopeManager.getHistory(). None of these fields were
// previously typed and `pe.deviceId.slice(...)` below crashed at runtime
// when deviceId was missing on older PEs.
interface LegacyEnvelope {
    id?: string;
    actionType?: string;
    timestamp?: number;
    details?: unknown;
    deviceId?: string;
    hash?: string;
}

const PEViewerScreen = ({ navigation }: any) => {
    useTranslation();
    const [envelopes, setEnvelopes] = useState<LegacyEnvelope[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadEnvelopes();
    }, []);

    const loadEnvelopes = async () => {
        setLoading(true);
        setError(null);
        try {
            const history = await ProvenanceEnvelopeManager.getHistory();
            setEnvelopes(history as LegacyEnvelope[]);
        } catch (err: unknown) {
            console.error('[PEViewer] Failed to load history:', err);
            setError(i18next.t('ui.peViewer.loadError'));
        } finally {
            setLoading(false);
        }
    };

    const handleShare = async (envelope: LegacyEnvelope) => {
        try {
            await Share.share({
                message: JSON.stringify(envelope, null, 2),
                title: i18next.t('ui.peViewer.shareTitle', { id: envelope.id ?? i18next.t('common.unknown') })
            });
        } catch (error) {
            console.error(error);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.background}
                style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{i18next.t('ui.peViewer.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.infoCard}>
                    <Ionicons name="eye" size={24} color={COLORS.primary} />
                    <Text style={styles.infoText}>
                        {i18next.t('ui.peViewer.body')}</Text>
                </View>

                {loading ? (
                    <View style={styles.centerState}>
                        <ActivityIndicator size="large" color={COLORS.primary} />
                    </View>
                ) : error ? (
                    <View style={styles.centerState}>
                        <Ionicons name="alert-circle" size={28} color={COLORS.error} />
                        <Text style={styles.centerStateText}>{errorDisplayCopy(error)}</Text>
                        <TouchableOpacity onPress={loadEnvelopes} style={styles.retryButton}>
                            <Text style={styles.retryButtonText}>{i18next.t('chatWebView.retry')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : envelopes.length === 0 ? (
                    <View style={styles.centerState}>
                        <Ionicons name="shield-outline" size={32} color={COLORS.textTertiary} />
                        <Text style={styles.centerStateText}>
                            {i18next.t('ui.peViewer.empty')}</Text>
                    </View>
                ) : (
                    envelopes.map((pe, index) => (
                        <View key={pe.id ?? index} style={styles.card}>
                            <View style={styles.cardHeader}>
                                <View>
                                    <Text style={styles.actionType}>{getActionTypeDisplay(pe.actionType ?? '').label}</Text>
                                    <Text style={styles.timestamp}>
                                        {pe.timestamp ? new Date(pe.timestamp).toLocaleString(i18next.resolvedLanguage) : '–'}
                                    </Text>
                                </View>
                                <TouchableOpacity onPress={() => handleShare(pe)}>
                                    <Ionicons name="share-outline" size={20} color={COLORS.primary} />
                                </TouchableOpacity>
                            </View>

                            <View style={styles.jsonContainer}>
                                <Text style={styles.jsonText}>
                                    {JSON.stringify(pe.details ?? {}, null, 2)}
                                </Text>
                            </View>

                            <View style={styles.footer}>
                                <Text style={styles.deviceId}>
                                    {i18next.t('ui.peViewer.device', { id: pe.deviceId ? pe.deviceId.slice(0, 8) + '…' : '–' })}
                                </Text>
                                <Text style={styles.hash}>
                                    {i18next.t('ui.peViewer.hash', { hash: pe.hash ? pe.hash.slice(0, 10) + '…' : i18next.t('pe.disposition.pending') })}
                                </Text>
                            </View>
                        </View>
                    ))
                )}
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
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxl,
    },
    infoCard: {
        flexDirection: 'row',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        alignItems: 'center',
        gap: SPACING.m,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    infoText: {
        flex: 1,
        color: COLORS.chromeMuted,
        fontSize: 14,
        lineHeight: 20,
    },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: SPACING.m,
    },
    actionType: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    timestamp: {
        fontSize: 11,
        color: '#9CA3AF',
    },
    jsonContainer: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        padding: SPACING.m,
        borderRadius: 14,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    jsonText: {
        fontFamily: 'monospace',
        fontSize: 11,
        color: '#8B929E',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    deviceId: {
        fontSize: 10,
        color: '#9CA3AF',
        fontFamily: 'monospace',
    },
    hash: {
        fontSize: 10,
        color: '#9CA3AF',
        fontFamily: 'monospace',
    },
    centerState: {
        alignItems: 'center',
        paddingVertical: SPACING.xxl,
        gap: SPACING.m,
    },
    centerStateText: {
        color: '#8B929E',
        fontSize: 13,
        textAlign: 'center',
        paddingHorizontal: SPACING.l,
        lineHeight: 19,
    },
    retryButton: {
        paddingHorizontal: SPACING.l,
        paddingVertical: 10,
        borderRadius: 20,
        backgroundColor: 'rgba(74,142,232,0.15)',
    },
    retryButtonText: {
        color: COLORS.primary,
        fontWeight: '700',
        fontSize: 13,
    },
});

export default PEViewerScreen;
