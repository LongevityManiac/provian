import { errorDisplayCopy } from '../../i18n/displayCopy';
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import KeyManager from '../../core/security/KeyManager';
import WalletCreationService from '../../core/wallet/WalletCreationService';
import { ensureSolanaAddressProven } from '../../core/chains/solana/solanaAddressProof';
import { ensureAppOutputKeyRegistered } from '../../core/meter/outputSigningRuntime';
import { Ionicons } from '@expo/vector-icons';
import { useWalletStore } from '../../store/walletStore';

type AttestationStatus = 'verifying' | 'generating' | 'evm_wallet' | 'success' | 'failed';

const AttestationScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { completeOnboarding } = useWalletStore();
    const [status, setStatus] = useState<AttestationStatus>('verifying');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        runAttestationFlow();
    }, []);

    const runAttestationFlow = async () => {
        try {
            // 1. Check device security level
            setStatus('verifying');
            const securityLevel = await KeyManager.getSecurityLevel();

            // Warn if not hardware-backed (but don't block in development)
            if (securityLevel === 'software') {
                console.warn('Running in software mode - hardware security not available');
            }

            await new Promise(r => setTimeout(r, 1000)); // UX delay

            // 2. Key Verification
            // The wallet key was already created by BiometricSetupScreen via WalletCreationService.
            // We verify it exists rather than generating a second key.
            setStatus('generating');
            const service = WalletCreationService.getInstance();
            const existingWallet = await service.getStoredWallet();

            let keyAddress: string;
            let isHardwareBacked: boolean;

            if (existingWallet) {
                keyAddress = existingWallet.walletAddress;
                isHardwareBacked = false; // BIP-39 keys are software-backed
                console.log('Wallet key verified:', {
                    address: keyAddress,
                    keySource: existingWallet.keySource,
                });
            } else {
                // No wallet found. This shouldn't happen in normal flow,
                // but handle it by creating one
                console.warn('[Attestation] No wallet found, creating via WalletCreationService');
                const result = await service.createWallet();
                keyAddress = result.walletAddress;
                isHardwareBacked = false;
            }

            await new Promise(r => setTimeout(r, 1000)); // UX delay

            // 3. EVM wallet already created by WalletCreationService (BIP-44 derived EOA).
            // Additional keys are derived on demand from the unified BIP-39 seed
            // via SeedManager. Wallet metadata is backed up via CloudBackupV2
            // (PIN-encrypted AES-256-GCM to iCloud Keychain or Google Drive app
            // data folder), not here.
            setStatus('evm_wallet');
            console.log('EVM EOA wallet already created:', keyAddress);
            await new Promise(r => setTimeout(r, 400)); // Brief UX delay

            // 4. Success - Complete onboarding
            setStatus('success');

            // Mark onboarding complete (this sets walletMode='wallet' in the store —
            // retired the separate setMode call).
            completeOnboarding('wallet');

            // Prove the new wallet's OWN Solana address to the relay (its Solana x402 receipts
            // become witnessed PEs; proving pays nothing). Fire-and-forget inside the biometric
            // session the backup step opened; never blocks setup, retried on later app opens.
            void ensureSolanaAddressProven();
            // Register this phone's output-signing key (its PE attestation key, never the wallet key)
            // so what the person hands out on the Commons is signed and citable. Never prompts;
            // retried on later opens.
            void ensureAppOutputKeyRegistered();

            // One optional, skippable stop before MainTabs: the community-email
            // opt-in (StayInTheLoopScreen). It never gates the wallet — it
            // replaces itself with MainTabs on subscribe, skip, or any error.
            setTimeout(() => {
                navigation.replace('StayInTheLoop');
            }, 1500);

        } catch (e: any) {
            setStatus('failed');
            setError(errorDisplayCopy(e.message));
        }
    };

    return (
        <View style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <View style={styles.content}>
                {status === 'verifying' && (
                    <>
                        <View style={styles.statusIconContainer}>
                            <ActivityIndicator size="large" color="#4A8EE8" />
                        </View>
                        <Text style={styles.statusText}>{t('onboarding.attestingDevice')}</Text>
                    </>
                )}

                {status === 'generating' && (
                    <>
                        <View style={styles.statusIconContainer}>
                            <ActivityIndicator size="large" color="#6BA3F0" />
                        </View>
                        <Text style={styles.statusText}>{t('onboarding.generatingKeys')}</Text>
                        <Text style={styles.subText}>{t('onboarding.secureEnclave')}</Text>
                    </>
                )}

                {status === 'evm_wallet' && (
                    <>
                        <View style={styles.statusIconContainer}>
                            <ActivityIndicator size="large" color="#4A8EE8" />
                        </View>
                        <Text style={styles.statusText}>{t('onboarding.settingUpWallet')}</Text>
                        <Text style={styles.subText}>{t('onboarding.supportedChains')}</Text>
                    </>
                )}

                {status === 'success' && (
                    <>
                        <View style={[styles.statusIconContainer, { backgroundColor: 'rgba(0,230,118,0.14)' }]}>
                            <Ionicons name="shield-checkmark" size={56} color="#4CC38A" />
                        </View>
                        <Text style={styles.successText}>{t('onboarding.attestationSuccess')}</Text>
                    </>
                )}

                {status === 'failed' && (
                    <>
                        <View style={[styles.statusIconContainer, { backgroundColor: 'rgba(255,71,87,0.14)' }]}>
                            <Ionicons name="alert-circle" size={56} color={COLORS.error} />
                        </View>
                        <Text style={styles.errorText}>{t('onboarding.attestationFailed')}</Text>
                        <Text style={styles.errorDetail}>
                            {error?.includes('bad point') || error?.includes('equation')
                                ? t('onboarding.attestationCorruptKey')
                                : error?.includes('already exists')
                                ? t('onboarding.attestationKeyExists')
                                : t('onboarding.attestationTemporary')
                            }
                        </Text>
                        <TouchableOpacity
                            style={styles.retryButton}
                            onPress={() => {
                                setStatus('verifying');
                                setError(null);
                                runAttestationFlow();
                            }}
                        >
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.retryButtonGradient}
                            >
                                <Text style={styles.retryButtonText}>{t('common.tryAgain')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                        {/* "Skip for now" is DEV-ONLY. This 'failed' state means an
                            exception was thrown during wallet setup (corrupted/duplicate
                            key or a transient error) - NOT that the device lacks hardware
                            security (software-tier devices pass through above). Completing
                            onboarding here would drop the user into a wallet whose signing
                            key may be missing or corrupt, so in production the only paths
                            are Try Again or going back to recreate the wallet
                            ("Unknown = Block, Not Warn"). */}
                        {__DEV__ && (
                            <TouchableOpacity
                                style={styles.skipButton}
                                onPress={() => {
                                    completeOnboarding('wallet');
                                    navigation.replace('MainTabs');
                                }}
                            >
                                <Text style={styles.skipButtonText}>{t('onboarding.skipForNowDev')}</Text>
                            </TouchableOpacity>
                        )}
                        {__DEV__ && <Text style={styles.devError}>{errorDisplayCopy(error)}</Text>}
                    </>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
        justifyContent: 'center',
        alignItems: 'center',
    },
    content: {
        alignItems: 'center',
        padding: SPACING.xl,
    },
    statusIconContainer: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    statusText: {
        marginTop: SPACING.s,
        fontSize: 20,
        color: COLORS.text,
        fontWeight: '700',
        textAlign: 'center',
    },
    subText: {
        marginTop: SPACING.s,
        fontSize: 14,
        color: '#8B929E',
    },
    successText: {
        marginTop: SPACING.s,
        fontSize: 22,
        color: '#4CC38A',
        fontWeight: 'bold',
        textAlign: 'center',
    },
    errorText: {
        marginTop: SPACING.s,
        fontSize: 22,
        color: COLORS.error,
        fontWeight: 'bold',
        textAlign: 'center',
    },
    errorDetail: {
        marginTop: SPACING.m,
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 22,
        paddingHorizontal: SPACING.m,
    },
    retryButton: {
        marginTop: SPACING.xl,
        borderRadius: 28,
        overflow: 'hidden',
        width: '100%',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    retryButtonGradient: {
        paddingVertical: 16,
        paddingHorizontal: SPACING.xl * 2,
        alignItems: 'center',
        borderRadius: 28,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: 'white',
    },
    skipButton: {
        marginTop: SPACING.m,
        paddingVertical: 12,
    },
    skipButtonText: {
        fontSize: 14,
        color: '#9CA3AF',
        fontWeight: '500',
    },
    devError: {
        marginTop: SPACING.l,
        fontSize: 11,
        color: '#9CA3AF',
        textAlign: 'center',
        fontFamily: 'monospace',
    },
});

export default AttestationScreen;
