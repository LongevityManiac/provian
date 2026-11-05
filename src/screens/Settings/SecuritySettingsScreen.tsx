// I-U-6 fix: this screen previously rendered four Switches (biometrics,
// auto-lock, transaction alerts, "require approval for all") whose state
// was held in local useState with NO persistence. Users could toggle them,
// navigate away, and silently lose their changes. They were also
// duplicates of controls that already exist in canonical locations:
//   - biometrics + auto-lock → SettingsScreen + BiometricSettings
//   - transaction alerts     → NotificationSettings
//   - "require approval for all" → no backing logic existed
// This screen is now just a hub of action cards pointing to the canonical
// homes plus Agent Authorization / Recovery / Lockdown entrypoints.
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import KeyManager, { type AttestationTier } from '../../core/security/KeyManager';
import {
    dismissAttestationNudge,
    shouldShowAttestationNudge,
} from '../../core/security/attestationTierNudge';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import type { TFunction } from 'i18next';

/**
 * Plain-language label for the current device's attestation tier.
 * Reads from the same source the backend uses for tier resolution
 * (KeyManager.getKeyAttestation, which surfaces the native module's
 * actual key backing via getKeyBacking).
 */
function formatAttestationLabel(tier: AttestationTier | null, platform: 'ios' | 'android', t: TFunction): string {
    if (tier === null) return t('settings.attestationTierLabel.checking');
    if (tier === 'software') return t('settings.attestationTierLabel.software');
    if (tier === 'hardware_full') {
        return platform === 'ios' ? t('settings.attestationTierLabel.hardwareSecureEnclave') : t('settings.attestationTierLabel.hardwareStrongBox');
    }
    // hardware_tpm - Android TEE-backed (no StrongBox). iOS doesn't reach this
    // branch in practice, but if it did we'd surface a neutral "Hardware" label.
    if (tier === 'hardware_tpm') {
        return platform === 'ios' ? t('settings.attestationTierLabel.hardware') : t('settings.attestationTierLabel.hardwareTee');
    }
    return t('common.unknown');
}

const SecuritySettingsScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const [tier, setTier] = useState<AttestationTier | null>(null);
    const [showTierNudge, setShowTierNudge] = useState(false);
    const tierPlatform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

    useEffect(() => {
        let mounted = true;
        KeyManager.getKeyAttestation()
            .then((result) => {
                if (mounted) setTier(result.tier);
            })
            .catch(() => {
                if (mounted) setTier('software');
            });
        shouldShowAttestationNudge(tierPlatform, AsyncStorage)
            .then((show) => {
                if (mounted) setShowTierNudge(show);
            })
            .catch(() => {
                // AsyncStorage failure: leave the nudge hidden. The next
                // launch retries the read; missing the nudge is harmless.
            });
        return () => {
            mounted = false;
        };
    }, [tierPlatform]);

    const onDismissTierNudge = useCallback(() => {
        setShowTierNudge(false);
        // Fire-and-forget - UI already updated optimistically. A storage
        // write failure means the nudge reappears next launch (annoying,
        // not broken).
        dismissAttestationNudge(AsyncStorage).catch(() => {});
    }, []);

    const ActionCard = ({
        icon,
        dotColor,
        title,
        subtitle,
        onPress,
    }: {
        icon: keyof typeof Ionicons.glyphMap;
        dotColor: string;
        title: string;
        subtitle: string;
        onPress: () => void;
    }) => (
        <TouchableOpacity style={styles.actionCard} onPress={onPress}>
            <View style={styles.actionLeft}>
                <View style={[styles.categoryDot, { backgroundColor: dotColor }]} />
                <View style={styles.iconContainer}>
                    <Ionicons name={icon} size={18} color={COLORS.chromeMuted} />
                </View>
                <View style={styles.actionTextWrap}>
                    <Text style={styles.actionTitle}>{title}</Text>
                    <Text style={styles.actionSubtitle}>{subtitle}</Text>
                </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('settings.security')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.infoCard}>
                    <Ionicons name="shield-checkmark" size={24} color="#4A8EE8" />
                    <Text style={styles.infoText}>{t('settings.securityControlsIntro')}</Text>
                </View>

                <Text style={styles.sectionHeader}>{t('settings.deviceSecuritySection')}</Text>
                <View style={styles.tierCard}>
                    <View style={styles.tierIconWrap}>
                        <Ionicons name="hardware-chip-outline" size={18} color={COLORS.chromeMuted} />
                    </View>
                    <View style={styles.tierTextWrap}>
                        <Text style={styles.tierLabel}>{t('settings.attestationTier')}</Text>
                        <Text style={styles.tierValue}>{formatAttestationLabel(tier, tierPlatform, t)}</Text>
                    </View>
                </View>

                {showTierNudge && (
                    <View style={styles.nudgeCard}>
                        <View style={styles.nudgeHeader}>
                            <Ionicons name="information-circle-outline" size={18} color="#F0BD5C" />
                            <Text style={styles.nudgeTitle}>{t('settings.attestationRecalculated')}</Text>
                        </View>
                        <Text style={styles.nudgeBody}>{t('settings.attestationRecalculatedMsg')}</Text>
                        <TouchableOpacity style={styles.nudgeDismiss} onPress={onDismissTierNudge}>
                            <Text style={styles.nudgeDismissText}>{t('settings.gotIt')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                <Text style={styles.sectionHeader}>{t('settings.authenticationSection')}</Text>
                <ActionCard
                    icon="finger-print"
                    dotColor="#F2555A"
                    title={t('settings.biometrics')}
                    subtitle={t('settings.biometricSettingsSubtitle')}
                    onPress={() => navigation.navigate('BiometricSettings')}
                />
                <ActionCard
                    icon="link"
                    dotColor="#6BA3F0"
                    title={t('walletConnect.security.title')}
                    subtitle={t('settings.walletConnectSecuritySubtitle')}
                    onPress={() => navigation.navigate('WalletConnectSecurity')}
                />

                <Text style={styles.sectionHeader}>{t('settings.emergencySection')}</Text>
                <ActionCard
                    icon="alert-circle"
                    dotColor="#F2555A"
                    title={t('lockdown.title')}
                    subtitle={t('settings.lockdownSubtitle')}
                    onPress={() => navigation.navigate('Lockdown')}
                />
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
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.l,
    },
    infoCard: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        padding: SPACING.m,
        borderRadius: 20,
        marginBottom: SPACING.xl,
        flexDirection: 'row',
        gap: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.20)',
    },
    infoText: {
        flex: 1,
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 20,
    },
    sectionHeader: {
        color: '#9CA3AF',
        fontSize: 11,
        fontWeight: '600',
        marginTop: SPACING.l,
        marginBottom: SPACING.m,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    categoryDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: SPACING.s,
    },
    actionTextWrap: {
        flex: 1,
    },
    actionSubtitle: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    iconContainer: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    tierCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    tierIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    tierTextWrap: {
        flex: 1,
    },
    tierLabel: {
        color: '#8B929E',
        fontSize: 12,
    },
    tierValue: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '600',
        marginTop: 2,
    },
    nudgeCard: {
        backgroundColor: 'rgba(240,189,92,0.08)',
        borderColor: 'rgba(240,189,92,0.30)',
        borderWidth: 1,
        borderRadius: 18,
        padding: SPACING.m,
        marginTop: SPACING.s,
        marginBottom: SPACING.s,
    },
    nudgeHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    nudgeTitle: {
        color: '#F0BD5C',
        fontSize: 14,
        fontWeight: '600',
        flex: 1,
    },
    nudgeBody: {
        color: COLORS.chromeMuted,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: SPACING.m,
    },
    nudgeDismiss: {
        alignSelf: 'flex-start',
        paddingVertical: 6,
        paddingHorizontal: SPACING.m,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(240,189,92,0.40)',
        backgroundColor: 'rgba(240,189,92,0.05)',
    },
    nudgeDismissText: {
        color: '#F0BD5C',
        fontSize: 13,
        fontWeight: '600',
    },
    actionCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    actionLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    actionTitle: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '600',
    },
});

export default SecuritySettingsScreen;
