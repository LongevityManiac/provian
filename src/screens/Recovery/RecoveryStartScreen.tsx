/**
 * RecoveryStartScreen - Entry point for wallet recovery
 *
 * Two recovery paths:
 *   1. Cloud Recovery (primary): PIN-encrypted backup in iCloud Keychain (iOS) / Google Drive encrypted app folder (Android)
 *   2. Recovery Phrase (fallback): Manual 12/24 word seed entry. Offline escape hatch when cloud backup is unavailable or the user prefers seed-only recovery.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { useWalletStore, selectLegalAcceptanceCurrent } from '../../store/walletStore';
import { restoreEntry, type RestoreMethod } from '../../navigation/restoreConsent';

const RecoveryStartScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const cloudName = Platform.OS === 'ios' ? 'iCloud' : 'Google';
    const legalAccepted = useWalletStore(selectLegalAcceptanceCurrent);

    // Restoring passes through the same three acknowledgements as creating, unless this install
    // has already accepted the current Terms and Privacy Policy.
    const startRestore = (method: RestoreMethod) => {
        const entry = restoreEntry(method, legalAccepted);
        if (entry.screen === 'Consent') navigation.navigate('Consent', entry.params);
        else navigation.navigate(entry.screen);
    };

    const handleCloudRecovery = () => startRestore('CloudRecovery');

    const handleSeedPhraseRecovery = () => startRestore('ImportRecoveryPhrase');

    const handleBack = () => {
        if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            navigation.navigate('Onboarding');
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header with back button */}
            <View style={styles.header}>
                <BackButton onPress={handleBack} />
            </View>

            <View style={styles.content}>
                <View style={styles.iconContainer}>
                    <Ionicons name="wallet" size={48} color="#4A8EE8" />
                </View>

                <Text style={styles.title}>{t('recoveryStart.title')}</Text>
                <Text style={styles.subtitle}>
                    {t('recoveryStart.subtitle')}
                </Text>

                {/* Option 1: Cloud Recovery */}
                <TouchableOpacity
                    style={styles.optionCard}
                    onPress={handleCloudRecovery}
                    activeOpacity={0.7}
                >
                    <View style={styles.optionRow}>
                        <View style={[styles.optionIconBg, { backgroundColor: 'rgba(74,142,232,0.14)' }]}>
                            <Ionicons name="cloud-download" size={24} color="#4A8EE8" />
                        </View>
                        <View style={styles.optionContent}>
                            <Text style={styles.optionTitle}>{t('recoveryStart.cloudTitle', { cloudName })}</Text>
                            <Text style={styles.optionDesc}>
                                {t('recoveryStart.cloudDesc')}
                            </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
                    </View>
                    <View style={styles.recommendedBadge}>
                        <Text style={styles.recommendedText}>{t('recoveryStart.recommendedBadge')}</Text>
                    </View>
                </TouchableOpacity>

                {/* Option 2: Recovery Phrase */}
                <TouchableOpacity
                    style={styles.optionCard}
                    onPress={handleSeedPhraseRecovery}
                    activeOpacity={0.7}
                >
                    <View style={styles.optionRow}>
                        <View style={[styles.optionIconBg, { backgroundColor: 'rgba(232,168,56,0.14)' }]}>
                            <Ionicons name="key" size={24} color="#E8A838" />
                        </View>
                        <View style={styles.optionContent}>
                            <Text style={styles.optionTitle}>{t('recoveryStart.phraseTitle')}</Text>
                            <Text style={styles.optionDesc}>
                                {t('recoveryStart.phraseDesc')}
                            </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
                    </View>
                </TouchableOpacity>

                {/* Help link */}
                <TouchableOpacity
                    style={styles.helpLink}
                    onPress={() => navigation.navigate('HelpSupport')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.helpText}>{t('recoveryStart.helpLink')}</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    content: {
        flex: 1,
        paddingHorizontal: SPACING.l,
        justifyContent: 'center',
    },
    iconContainer: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(74,142,232,0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        alignSelf: 'center',
        marginBottom: SPACING.l,
    },
    title: {
        fontSize: 28,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
    },
    subtitle: {
        fontSize: 15,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: SPACING.xl,
    },
    optionCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    optionRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    optionIconBg: {
        width: 48,
        height: 48,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    optionContent: {
        flex: 1,
        marginRight: SPACING.s,
    },
    optionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        marginBottom: 4,
    },
    optionDesc: {
        fontSize: 13,
        color: '#8B929E',
        lineHeight: 18,
    },
    recommendedBadge: {
        alignSelf: 'flex-start',
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingHorizontal: SPACING.s,
        paddingVertical: 3,
        borderRadius: 6,
        marginTop: SPACING.s,
        marginLeft: 64,
    },
    recommendedText: {
        fontSize: 10,
        fontWeight: '700',
        color: '#4A8EE8',
        letterSpacing: 1,
    },
    helpLink: {
        paddingVertical: SPACING.m,
        alignItems: 'center',
        marginTop: SPACING.m,
    },
    helpText: {
        fontSize: 14,
        color: '#8B929E',
        textDecorationLine: 'underline',
    },
});

export default RecoveryStartScreen;
