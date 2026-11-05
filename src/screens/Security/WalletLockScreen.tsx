import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
import React, { useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    Image,
    StyleSheet,
    TouchableOpacity,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError, BiometricRateLimitError } from '../../core/security/requireBiometric';
import SeedManager from '../../core/wallet/SeedManager';
import WalletCreationService from '../../core/wallet/WalletCreationService';
import { onWalletUnlocked } from '../../core/meter/phoneMeterRuntime';
import { hasCloudBackup } from '../../core/recovery/cloud/CloudBackupV2';
import { resolveBackupGate } from '../../core/recovery/cloud/backupRequirement';
import { landAfterUnlock } from '../../navigation/afterUnlock';
import { legalReviewRequired } from '../../core/legal/legalAcceptance';

const isSimulator = !Device.isDevice;

const WalletLockScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { setAuthenticated, userName } = useWalletStore();
    const bio = useBiometricLabel();
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // N-2: Track when biometric is unavailable so we can show recovery option
    const [biometricUnavailable, setBiometricUnavailable] = useState(false);
    // Re-entry guard: don't fire a second authenticate() while one is in
    // flight (double-tap Try Again, or a remount-triggered auto-trigger).
    // A ref avoids duplicate tap handling and redundant state churn, so the
    // check is synchronous and survives the render between calls.
    const authInFlight = useRef(false);

    const authenticate = async () => {
        if (authInFlight.current) {
            return;
        }
        authInFlight.current = true;
        setIsAuthenticating(true);
        setError(null);

        try {
            return await withBiometricAction(t('walletLock.biometricPrompt'), async (biometricAction) => {

                assertBiometricAction(biometricAction);
                setBiometricUnavailable(false);
                // [] Carry an installed wallet's seed over to the re-enrollment-
                // proof store right after unlock (no user step beyond the OS prompts
                // the ACLs require; the old item is removed only after the new one
                // reads back verified; failure retries next unlock). For a wallet that
                // already moved, the live seed slot is checked WITHOUT a prompt (a
                // missing item, or on Android a permanently invalidated key) and any
                // doubt is settled by a real read. If the wallet is known but its seed
                // cannot be read, open the restore flow on top of the wallet — never
                // "no wallet", never a new seed over it. (The unlock prompt itself is
                // not the seed read: the seed ACL admits the device passcode, which
                // C-17 forbids as an app-unlock factor.)
                const seedStorage = await SeedManager.migrateSeedStorageIfNeeded(biometricAction).catch(() => 'deferred' as const);
                const seedUnreadable = seedStorage === 'unreadable';
                // [] The persisted display address must name the wallet whose
                // seed is stored (a create/import killed after the seed committed but
                // before the screen saved the address would otherwise keep showing,
                // and receiving to, the previous wallet).
                const known = await WalletCreationService.getInstance().reconcileStoredAddresses().catch(() => null);
                if (known) {
                    const state = useWalletStore.getState();
                    if (state.address && state.address.toLowerCase() !== known.evm.toLowerCase()) state.setAddress(known.evm);
                    if (known.sol && state.solanaAddress && state.solanaAddress !== known.sol) state.setSolanaAddress(known.sol);
                }
                assertBiometricAction(biometricAction);
                // PE METER: publish the message key if the relay has none (so PEs can reach this phone).
                if (!seedUnreadable) await onWalletUnlocked(biometricAction).catch(err => console.warn('[WalletLock] key initialization deferred', err));
                assertBiometricAction(biometricAction);
                // A restored wallet that still owes its cloud backup (the app was closed on the
                // backup screen) goes back to it before the app.
                const backupGate = seedUnreadable
                    ? 'app'
                    : await resolveBackupGate(known?.evm ?? useWalletStore.getState().address ?? null, hasCloudBackup);
                // Terms or a Privacy Policy changed since this install accepted them: review and accept first.
                const termsGate = legalReviewRequired(useWalletStore.getState()) ? 'terms' as const : 'app' as const;
                // A notification tapped while locked opens on top of the app, never raced by this reset.
                landAfterUnlock(navigation, seedUnreadable ? 'restore' : backupGate === 'backup' ? 'backup' : termsGate, () => setAuthenticated(true));

            }, undefined);
        } catch (err) {
            if (err instanceof BiometricNotAvailableError) {
                // N-2: When biometric is unavailable (user removed enrollment),
                // show a clear message with a recovery option instead of a dead end.
                setBiometricUnavailable(true);
                setError(
                    errorDisplayCopy(err.isEnrolled === false
                        ? t('walletLock.errorNoBiometricEnrolled')
                        : err.message),
                );
            } else if (err instanceof BiometricRateLimitError) {
                // [Audit #24] Surface the cooldown honestly with the wait time
                // instead of a generic "Something went wrong". This path is
                // reachable after repeated genuine biometric failures (a cancel
                // no longer arms the cooldown).
                const secs = Math.ceil(err.retryAfterMs / 1000);
                setError(t('walletLock.errorTooManyAttempts', { seconds: secs }));
            } else if (err instanceof BiometricAuthError) {
                setError(t('walletLock.errorAuthFailed'));
            } else {
                setError(t('walletLock.errorGeneric'));
                console.error('[WalletLockScreen] Auth error:', err);
            }
        } finally {
            setIsAuthenticating(false);
            authInFlight.current = false;
        }
    };

    const handleSkipForTesting = () => {
        console.log('[WalletLockScreen] Skipping auth for simulator testing');
        onWalletUnlocked();
        landAfterUnlock(navigation, 'app', () => setAuthenticated(true));
    };

    // Auto-trigger authentication on mount (skip on simulator)
    useEffect(() => {
        if (isSimulator) {
            // Don't auto-trigger on simulator - let user tap skip button
            return;
        }
        const timer = setTimeout(() => {
            authenticate();
        }, 500);
        return () => clearTimeout(timer);
    }, []);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.content}>
                {/* Logo */}
                <View style={styles.logoContainer}>
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={{ width: 140, height: 140 }}
                        resizeMode="contain"
                    />
                </View>

                {/* App Name */}
                <Text style={styles.appName}>PROVIAN</Text>
                <Text style={styles.subtitle}>{t('walletLock.subtitle')}</Text>

                {/* Welcome Back */}
                {userName && (
                    <Text style={styles.welcomeText}>
                        {t('walletLock.welcomeBack', { name: userName })}
                    </Text>
                )}

                {/* Spacer */}
                <View style={{ flex: 1 }} />

                {/* Lock Icon & Status */}
                <View style={styles.lockContainer}>
                    {isAuthenticating ? (
                        <ActivityIndicator size="large" color={COLORS.primary} />
                    ) : (
                        <TouchableOpacity
                            style={styles.unlockButton}
                            onPress={authenticate}
                            activeOpacity={0.7}
                        >
                            <View style={styles.faceIdIcon}>
                                <Ionicons name="finger-print" size={40} color={COLORS.primary} />
                            </View>
                            <Text style={styles.unlockText}>{t('walletLock.unlockWith', { method: bio.label })}</Text>
                        </TouchableOpacity>
                    )}

                    {error && (
                        <View style={styles.errorContainer}>
                            <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                            <TouchableOpacity
                                style={styles.tryAgainButton}
                                onPress={authenticate}
                            >
                                <Text style={styles.tryAgainText}>{t('walletLock.tryAgain')}</Text>
                            </TouchableOpacity>
                            {/* N-2: When biometric is unavailable, offer seed phrase recovery
                                as an escape hatch instead of leaving the user locked out. */}
                            {biometricUnavailable && (
                                <TouchableOpacity
                                    style={styles.recoveryButton}
                                    onPress={() => navigation.navigate('RecoveryStart')}
                                >
                                    <Text style={styles.recoveryText}>{t('walletLock.recoverWithSeed')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                </View>

                {/* Spacer */}
                <View style={{ flex: 1 }} />

                {/* SECURITY FIX: E-1 - Simulator bypass requires __DEV__ guard */}
                {__DEV__ && isSimulator && (
                    <TouchableOpacity
                        style={styles.skipButton}
                        onPress={handleSkipForTesting}
                    >
                        <View style={styles.skipContent}>
                            <Ionicons name="bug" size={16} color={COLORS.warning} />
                            <Text style={styles.skipText}>Skip for Simulator Testing</Text>
                        </View>
                    </TouchableOpacity>
                )}
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    content: {
        flex: 1,
        padding: SPACING.l,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        marginBottom: SPACING.xl,
    },
    logoCircle: {
        width: 110,
        height: 110,
        borderRadius: 55,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.4,
        shadowRadius: 20,
        elevation: 8,
    },
    appName: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.xs,
    },
    subtitle: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.xl,
    },
    welcomeText: {
        fontSize: 16,
        color: COLORS.chromeMuted,
        fontWeight: '500',
    },
    lockContainer: {
        alignItems: 'center',
        minHeight: 140,
        justifyContent: 'center',
    },
    unlockButton: {
        alignItems: 'center',
    },
    faceIdIcon: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.35,
        shadowRadius: 16,
        elevation: 6,
    },
    unlockText: {
        fontSize: 15,
        color: '#8B929E',
        fontWeight: '500',
    },
    errorContainer: {
        alignItems: 'center',
        marginTop: SPACING.l,
    },
    errorText: {
        fontSize: 14,
        color: '#F2555A',
        marginBottom: SPACING.m,
        textAlign: 'center',
    },
    tryAgainButton: {
        backgroundColor: '#4A8EE8',
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 5,
    },
    tryAgainText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
    recoveryButton: {
        marginTop: SPACING.m,
        paddingVertical: SPACING.s,
    },
    recoveryText: {
        color: '#8B929E',
        fontSize: 14,
        fontWeight: '500',
        textDecorationLine: 'underline',
    },
    skipButton: {
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.l,
        borderRadius: 28,
        borderWidth: 2,
        borderColor: COLORS.warning,
        borderStyle: 'dashed',
        backgroundColor: `${COLORS.warning}10`,
    },
    skipContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    skipText: {
        color: COLORS.warning,
        fontSize: 14,
        fontWeight: '600',
    },
});

export default WalletLockScreen;
