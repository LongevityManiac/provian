import { errorDisplayCopy } from '../../../i18n/displayCopy';
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, SHADOWS } from '../../../constants/theme';
import { MnemonicExportService } from '../../../core/wallet/export/MnemonicExportService';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError } from '../../../core/security/requireBiometric';
import { useSensitiveDisplay } from '../../../hooks/useSensitiveDisplay';
import BackButton from '../../../components/BackButton';

const ExportMnemonicScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const [hasMnemonic, setHasMnemonic] = useState<boolean | null>(null); // null = checking
    const { value: mnemonic, reveal: revealMnemonic, copyToClipboard, copied } = useSensitiveDisplay({
        ttlSeconds: 60,
        clipboardClearMs: 60_000,
    });
    const revealed = mnemonic !== null;

    // Check upfront whether this wallet has a mnemonic at all.
    // CRITICAL [C-9]: Use hasMnemonic() - calling exportMnemonic() here would
    // pull the plaintext seed into memory before the biometric gate fires.
    useEffect(() => {
        (async () => {
            try {
                setHasMnemonic(await MnemonicExportService.hasMnemonic());
            } catch {
                setHasMnemonic(false);
            }
        })();
    }, []);

    const handleReveal = () => {
        Alert.alert(t('exportMnemonic.dangerTitle'), t('exportMnemonic.dangerMsg'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('exportMnemonic.iUnderstandReveal'), style: 'destructive', onPress: fetchMnemonic },
        ]);
    };

    const fetchMnemonic = async () => {
        try {
            const result = await MnemonicExportService.exportMnemonic();
            revealMnemonic(result.mnemonic);
        } catch (error: any) {
            Alert.alert(t('exportMnemonic.unavailable'), errorDisplayCopy(error.message));
        }
    };

    const handleCopyMnemonic = async () => {
        const ok = await copyToClipboard();
        if (ok) {
            Alert.alert(t('common.copied'), t('exportMnemonic.copiedMsg'));
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={COLORS.chrome} />
                <Text style={styles.headerTitle}>{t('exportMnemonic.headerTitle')}</Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Seedless wallet - no mnemonic exists */}
                {hasMnemonic === false && (
                    <View style={styles.seedlessCard}>
                        <View style={styles.seedlessIconGlow}>
                            <Ionicons name="shield-checkmark" size={40} color={COLORS.primary} />
                        </View>
                        <Text style={styles.seedlessTitle}>{t('exportMnemonic.noRecoveryPhrase')}</Text>
                        <Text style={styles.seedlessBody}>
                            {t('exportMnemonic.seedlessDesc')}
                        </Text>
                        <Text style={styles.seedlessBody}>
                            {t('exportMnemonic.seedlessNote')}
                        </Text>
                    </View>
                )}

                {/* Migrated wallet - mnemonic available */}
                {hasMnemonic === true && (
                    <>
                        <Text style={styles.introText}>
                            {t('exportMnemonic.intro')}
                        </Text>

                        <View style={styles.warningBanner}>
                            <View style={styles.warningBannerIcon}>
                                <Ionicons name="skull" size={24} color={COLORS.warning} />
                            </View>
                            <View style={styles.warningBannerContent}>
                                <Text style={styles.warningBannerTitle}>{t('exportMnemonic.doNotShare')}</Text>
                                <Text style={styles.warningBannerText}>
                                    {t('exportMnemonic.doNotShareMsg')}
                                </Text>
                            </View>
                        </View>

                        {!revealed ? (
                            <TouchableOpacity style={styles.revealButton} onPress={handleReveal}>
                                <Ionicons name="eye" size={22} color="#FFFFFF" />
                                <Text style={styles.revealButtonText}>{t('exportMnemonic.revealPhrase')}</Text>
                            </TouchableOpacity>
                        ) : (
                            <View style={styles.keyContainer}>
                                <Text style={styles.sectionLabel}>{t('exportMnemonic.bip39Label')}</Text>
                                <View style={styles.mnemonicBox}>
                                    {mnemonic?.split(' ').map((word, index) => (
                                        <View key={index} style={styles.wordBadge}>
                                            <Text style={styles.wordIndex}>{index + 1}</Text>
                                            <Text style={styles.wordText}>{word}</Text>
                                        </View>
                                    ))}
                                </View>

                                <TouchableOpacity style={styles.copyButton} onPress={handleCopyMnemonic}>
                                    <Ionicons name={copied ? 'checkmark-circle' : 'copy'} size={18} color={copied ? COLORS.success : COLORS.primary} />
                                    <Text style={[styles.copyButtonText, copied && { color: COLORS.success }]}>
                                        {copied ? t('exportMnemonic.copiedClears') : t('exportMnemonic.copyToClipboard')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </>
                )}

                {/* Still checking */}
                {hasMnemonic === null && (
                    <Text style={styles.introText}>{t('exportMnemonic.checkingWalletType')}</Text>
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
        alignItems: 'center',
        paddingBottom: SPACING.xxl,
    },
    introText: {
        color: COLORS.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        marginBottom: SPACING.l,
        lineHeight: 21,
    },
    warningBanner: {
        flexDirection: 'row',
        backgroundColor: 'rgba(255, 179, 0, 0.10)',
        padding: SPACING.m,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(255, 179, 0, 0.25)',
        marginBottom: SPACING.xl,
        width: '100%',
        gap: SPACING.m,
    },
    warningBannerIcon: {
        width: 44,
        height: 44,
        borderRadius: 14,
        backgroundColor: 'rgba(255, 179, 0, 0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    warningBannerContent: {
        flex: 1,
    },
    warningBannerTitle: {
        color: COLORS.warning,
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 1.5,
        marginBottom: 4,
    },
    warningBannerText: {
        color: COLORS.textSecondary,
        fontSize: 13,
        lineHeight: 19,
    },
    revealButton: {
        backgroundColor: COLORS.error,
        paddingHorizontal: SPACING.xl,
        paddingVertical: 14,
        borderRadius: 28,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        shadowColor: '#F2555A',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 14,
        elevation: 6,
    },
    revealButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
    },
    keyContainer: {
        width: '100%',
        alignItems: 'center',
    },
    sectionLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.m,
        alignSelf: 'flex-start',
    },
    mnemonicBox: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.s,
        marginBottom: SPACING.l,
        justifyContent: 'center',
    },
    wordBadge: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        paddingHorizontal: SPACING.m,
        paddingVertical: 10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
        elevation: 3,
    },
    wordIndex: {
        color: COLORS.textTertiary,
        fontSize: 11,
        fontWeight: '600',
    },
    wordText: {
        color: COLORS.text,
        fontWeight: '700',
        fontSize: 15,
        fontFamily: 'monospace',
    },
    copyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: 12,
        paddingHorizontal: SPACING.l,
        backgroundColor: 'rgba(74, 142, 232, 0.12)',
        borderRadius: 28,
    },
    copyButtonText: {
        color: COLORS.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    seedlessCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.xl,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        gap: SPACING.m,
        width: '100%',
        ...SHADOWS.card,
    },
    seedlessIconGlow: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: 'rgba(74, 142, 232, 0.12)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(74, 142, 232, 0.20)',
    },
    seedlessTitle: {
        color: COLORS.text,
        fontSize: 22,
        fontWeight: '700',
        marginTop: SPACING.xs,
        letterSpacing: -0.3,
    },
    seedlessBody: {
        color: COLORS.textSecondary,
        fontSize: 14,
        lineHeight: 21,
        textAlign: 'center',
    },
    moveAssetsButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: COLORS.primary,
        paddingHorizontal: SPACING.xl,
        paddingVertical: 14,
        borderRadius: 28,
        marginTop: SPACING.s,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.4,
        shadowRadius: 14,
        elevation: 6,
    },
    moveAssetsText: {
        color: '#FFFFFF',
        fontSize: 15,
        fontWeight: '700',
    },
});

export default ExportMnemonicScreen;
