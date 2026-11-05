import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
/**
 * BiometricSetupScreen - Wallet Creation via Biometric Auth
 *
 * This is the critical integration screen where:
 * 1. User authenticates with Face ID / fingerprint
 * 2. BIP-39 mnemonic is generated and all chain keys derived
 * 3. Wallet address is computed from derived keys
 * 4. Wallet state is persisted locally
 *
 * After this screen, the user has real blockchain addresses
 * that can receive funds on all supported chains.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Animated,
    ActivityIndicator,
    Platform,
    Alert,
    TouchableOpacity,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { BiometricAuthError, BiometricNotAvailableError, enableBiometricFallback } from '../../core/security/requireBiometric';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import { useTranslation } from 'react-i18next';

// SECURITY FIX: E-3, failed auth attempt lockout constants
const AUTH_FAILURE_KEY = 'biometric_auth_failures';
const AUTH_LOCKOUT_KEY = 'biometric_auth_lockout_until';
const LOCKOUT_THRESHOLDS = [
    { failures: 5, cooldownMs: 30 * 1000 },      // 5 failures: 30 seconds
    { failures: 10, cooldownMs: 5 * 60 * 1000 }, // 10 failures: 5 minutes
    { failures: 15, cooldownMs: 30 * 60 * 1000 }, // 15 failures: 30 minutes
];
import { useWalletStore } from '../../store/walletStore';
import WalletCreationService from '../../core/wallet/WalletCreationService';
import type { WalletCreationResult } from '../../core/wallet/WalletCreationService';
import type { IoniconsName } from '../../types/icons';
import RelayAPIService from '../../services/RelayAPIService'; // [M-15]
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import BackButton from '../../components/BackButton';
import { walletCreateFailureKey } from '../../core/wallet/walletCreateFailureText';

type StepStatus = 'pending' | 'active' | 'done' | 'error';

interface SetupStep {
    id: string;
    label: string;
    icon: IoniconsName;
    status: StepStatus;
    detail?: string;
}

// SECURITY FIX: E-3, helper functions for auth lockout
async function getFailureCount(): Promise<number> {
    try {
        const stored = await SecureStore.getItemAsync(AUTH_FAILURE_KEY);
        return stored ? parseInt(stored, 10) : 0;
    } catch {
        return 0;
    }
}

async function incrementFailureCount(): Promise<number> {
    const current = await getFailureCount();
    const newCount = current + 1;
    await SecureStore.setItemAsync(AUTH_FAILURE_KEY, String(newCount));

    // Check if we should apply a lockout
    let lockoutUntilTs: number | null = null;
    for (const threshold of LOCKOUT_THRESHOLDS.slice().reverse()) {
        if (newCount >= threshold.failures) {
            lockoutUntilTs = Date.now() + threshold.cooldownMs;
            await SecureStore.setItemAsync(AUTH_LOCKOUT_KEY, String(lockoutUntilTs));
            break;
        }
    }

    // [M-15] Report to backend (fire-and-forget, non-blocking)
    RelayAPIService.reportBiometricLockout(newCount, lockoutUntilTs).catch(() => {});

    return newCount;
}

async function resetFailureCount(): Promise<void> {
    await SecureStore.deleteItemAsync(AUTH_FAILURE_KEY);
    await SecureStore.deleteItemAsync(AUTH_LOCKOUT_KEY);
}

async function getLockoutStatus(): Promise<{ isLocked: boolean; remainingMs: number }> {
    try {
        const lockoutUntil = await SecureStore.getItemAsync(AUTH_LOCKOUT_KEY);
        if (!lockoutUntil) {
            return { isLocked: false, remainingMs: 0 };
        }
        const until = parseInt(lockoutUntil, 10);
        const remaining = until - Date.now();
        if (remaining <= 0) {
            // Lockout expired, clear it
            await SecureStore.deleteItemAsync(AUTH_LOCKOUT_KEY);
            return { isLocked: false, remainingMs: 0 };
        }
        return { isLocked: true, remainingMs: remaining };
    } catch {
        return { isLocked: false, remainingMs: 0 };
    }
}

const BiometricSetupScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const { setAddress } = useWalletStore();
    const bio = useBiometricLabel();

    const [steps, setSteps] = useState<SetupStep[]>([
        { id: 'biometric', label: t('biometricSetup.stepVerifyIdentity'), icon: 'finger-print', status: 'pending' },
        { id: 'keygen', label: t('biometricSetup.stepGenerateKey'), icon: 'key', status: 'pending' },
        { id: 'wallet', label: t('biometricSetup.stepCreateWallet'), icon: 'wallet', status: 'pending' },
    ]);
    const [error, setError] = useState<string | null>(null);
    const [walletResult, setWalletResult] = useState<WalletCreationResult | null>(null);
    const [existingWalletConflict, setExistingWalletConflict] = useState(false);
    const [isDeletingKey, setIsDeletingKey] = useState(false);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(30)).current;

    useEffect(() => {
        Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
            Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ]).start();

        // Start the setup flow after a brief delay
        const timer = setTimeout(() => startSetup(), 800);
        return () => clearTimeout(timer);
    }, []);

    const updateStep = (id: string, status: StepStatus, detail?: string) => {
        setSteps(prev => prev.map(s => s.id === id ? { ...s, status, detail } : s));
    };

    const startSetup = async () => {
        try {
            // Cloud backup is performed transparently post-biometric setup. Proceed directly.
            await continueSetup();
        } catch (err: any) {
            console.error('[BiometricSetup] Backup check error:', err);
            // Non-fatal. Proceed with setup even if backup check fails.
            await continueSetup();
        }
    };

    const continueSetup = async (existingAction?: BiometricAction) => {
        try {

            // ── Step 1: Biometric Authentication ────────────────────────
            updateStep('biometric', 'active');

            // SECURITY FIX: E-3, check for active lockout before proceeding
            const lockoutStatus = await getLockoutStatus();
            if (lockoutStatus.isLocked) {
                const remainingSec = Math.ceil(lockoutStatus.remainingMs / 1000);
                const remainingMin = Math.ceil(remainingSec / 60);
                const displayTime = remainingSec >= 60
                    ? t('biometricSetup.durationMinutes', { count: remainingMin })
                    : t('biometricSetup.durationSeconds', { count: remainingSec });
                updateStep('biometric', 'error', t('biometricSetup.detailTooManyAttempts'));
                setError(t('biometricSetup.errorLockout', { time: displayTime }));
                return;
            }

            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();

            // DEV MODE: Skip biometric entirely in simulator when no hardware available
            if (!hasHardware && __DEV__ && !Device.isDevice) {
                console.warn('[BiometricSetup] DEV: No biometric hardware in simulator, skipping authentication');
                updateStep('biometric', 'done', 'Skipped (simulator)');
            } else if (hasHardware && isEnrolled) {
                // The native seed action below performs the one strict biometric approval.
                updateStep('biometric', 'active');
            } else {
                // Real device with no biometric hardware or no enrolled biometric.
                // Switch into seed-phrase fallback mode: future sensitive operations
                // will route through the passcode-fallback gate (PEs tagged
                // attestation_depth = 'software').
                console.warn('[BiometricSetup] No biometrics available, enabling seed-phrase fallback mode');
                await enableBiometricFallback();
                updateStep('biometric', 'done', t('biometricSetup.detailSeedFallback'));
            }

            return await withBiometricAction(t('biometricSetup.promptAuthenticate'), async (biometricAction) => {
                await resetFailureCount();
                updateStep('biometric', 'done', t('biometricSetup.detailBiometricVerified', { method: bio.label }));
                // ── Step 2: Key Generation ──────────────────────────────────
                updateStep('keygen', 'active');

                // Small delay for visual feedback
                await new Promise(r => setTimeout(r, 500));

                const service = WalletCreationService.getInstance();

                // Check if wallet already exists
                const existing = await service.getStoredWallet(biometricAction);
                if (existing) {
                    // DEV MODE SIMULATOR: auto-delete existing wallet and proceed fresh
                    if (__DEV__ && !Device.isDevice) {
                        console.warn('[BiometricSetup] DEV: Auto-clearing existing simulator wallet (iCloud sync)');
                        try {
                            await service.deleteWallet(biometricAction);
                            console.warn('[BiometricSetup] DEV: Cleared. Proceeding with fresh wallet creation.');
                        } catch (delErr: any) {
                            console.warn('[BiometricSetup] DEV: Could not clear wallet:', delErr.message);
                        }
                    } else {
                        updateStep('keygen', 'done', t('biometricSetup.detailKeysExist'));
                        updateStep('wallet', 'done', shortenAddress(existing.walletAddress));
                        setWalletResult({
                            walletAddress: existing.walletAddress,
                            solanaAddress: existing.solanaAddress ?? '',
                            attestationTier: 'software',
                        });
                        await finishSetup(existing.walletAddress, biometricAction);
                        return;
                    }
                }

                updateStep('keygen', 'done', t('biometricSetup.detailKeysDerived'));

                // ── Step 3: Wallet Creation ─────────────────────────────────
                updateStep('wallet', 'active');

                // DEV MODE: Clear existing wallet in simulator before fresh create
                if (__DEV__ && !Device.isDevice) {
                    try {
                        const existingWallet = await service.getStoredWallet(biometricAction);
                        if (existingWallet) {
                            console.warn('[BiometricSetup] DEV: Clearing existing simulator wallet before fresh create');
                            await service.deleteWallet(biometricAction);
                        }
                    } catch (clearErr: any) {
                        // Non-fatal. If deletion fails, createWallet will throw the proper error.
                        console.warn('[BiometricSetup] DEV: Failed to clear existing wallet:', clearErr.message);
                    }
                }

                const result = await service.createWallet(biometricAction);
                // round-robin fairness: a key generated on this device a moment ago cannot back any
                // other account's registration, so this device may sign its registration address proof.
                // (Recovery / import paths authorize only on a DEFINITIVE relay recovery answer.)
                await RelayAPIService.recordAddressProofAuthorization({ address: result.walletAddress, userId: null });

                updateStep('wallet', 'done', shortenAddress(result.walletAddress));
                setWalletResult(result);

                // Generate wallet_created PE (PE #1 for this wallet)
                // Pass actorAddress explicitly because KeyManager isn't initialized yet
                try {
                    console.log('[BiometricSetup] Creating wallet_created PE...');
                    await ProvenanceEnvelopeManager.createEnvelope({
                        actionType: 'wallet_created',
                        intentText: 'Wallet created during onboarding',
                        assetSymbol: 'ETH',
                        amount: '0',
                        chainId: 0,
                        riskScore: 0,
                        riskCategory: 'low',
                        policyDecision: 'allow',
                        actorAddress: result.walletAddress,
                    }, biometricAction);
                    console.log('[BiometricSetup] wallet_created PE created successfully');
                } catch (peError) {
                    console.error('[BiometricSetup] wallet_created PE generation FAILED:', peError);
                }

                // Brief pause to show success
                await new Promise(r => setTimeout(r, 600));

                await finishSetup(result.walletAddress, biometricAction);


            }, existingAction);
        } catch (err: any) {
            if (err instanceof BiometricAuthError) await incrementFailureCount();
            console.error('[BiometricSetup] Error:', err);

            // Mark current active step as error
            setSteps(prev => prev.map(s => s.status === 'active' ? { ...s, status: 'error' } : s));

            // Handle "wallet already exists" specifically
            const msg: string = err.message || '';
            if (msg.includes('already exists')) {
                setExistingWalletConflict(true);
                setError(t('biometricSetup.walletExists'));
            } else {
                // Plain words, never the key layer's technical message (that goes to the log above).
                setError(t(walletCreateFailureKey(err)));
            }
        }
    };

    const finishSetup = async (walletAddress: string, biometricAction: BiometricAction): Promise<void> => {
        setAddress(walletAddress);

        // The new address needs a wallet-key proof. Attempt registration inside the SAME approved
        // action that created/read the seed, before its capability is revoked or setup advances.
        // Registration failure is non-fatal; the existing launch/unlock paths retry it later.
        try {
            await RelayAPIService.ensureHumanWalletRegistered(walletAddress, undefined, biometricAction);
        } catch {
            // Keep the locally created wallet and continue through mandatory backup.
        }

        // Mark device key as created for recovery status tracking
        await AsyncStorage.setItem('@provian_device_key_created', 'true');

        // SECURITY (A4): a seed-backed wallet exists by the time finishSetup runs — it
        // is called only after wallet creation (line ~311) or for an existing wallet (line
        // ~259). Cloud backup is therefore MANDATORY and NON-SKIPPABLE for every path.
        // CloudBackupConfirm has no skip control and precedes the completeOnboarding call in
        // AttestationScreen, so onboarding cannot complete with an un-backed-up seed. The
        // former `mode !== 'full'` branch here went straight to MainTabs — completing
        // onboarding with NO cloud backup and no skip flag, a latent silent-fund-loss path
        // guarded only by a default route param. No caller ever passed a non-'full' mode, but
        // the "no wallet without a backup" invariant must not rest on that default. Every path
        // now routes through the backup screen.
        setTimeout(() => {
            navigation.navigate('CloudBackupConfirm');
        }, 400);
    };

    const handleRetry = () => {
        setError(null);
        setExistingWalletConflict(false);
        setSteps(prev => prev.map(s => ({ ...s, status: 'pending' as StepStatus, detail: undefined })));
        setTimeout(() => startSetup(), 300);
    };

    const handleRestore = () => {
        navigation.navigate('RecoveryStart');
    };

    const handleDeleteAndRetry = () => {
        Alert.alert(t('biometricSetup.deleteAlertTitle'), t('biometricSetup.deleteAlertMessage'), [
            { text: t('biometricSetup.deleteAlertCancel'), style: 'cancel' },
            {
                text: t('biometricSetup.deleteAlertConfirm'), style: 'destructive', onPress: async () => {
                    try {
                        await withBiometricAction(t('biometricSetup.promptConfirmDeletion'), async action => {
                            setIsDeletingKey(true);
                            await WalletCreationService.getInstance().deleteWallet(action);
                            setAddress('');
                            setExistingWalletConflict(false);
                            setSteps(prev => prev.map(step => ({ ...step, status: 'pending' as StepStatus, detail: undefined })));
                            await continueSetup(action);
                        });
                    } catch (err) {
                        if (!(err instanceof BiometricAuthError)) setError(errorDisplayCopy(t('biometricSetup.errorDeleteFailed', { message: errorDisplayCopy(err instanceof Error ? err.message : String(err)) })));
                    } finally { setIsDeletingKey(false); }
                } },
        ]);
    };

    const shortenAddress = (addr: string) =>
        `${addr.slice(0, 6)}...${addr.slice(-4)}`;

    const getStepIcon = (step: SetupStep) => {
        switch (step.status) {
            case 'done':
                return <Ionicons name="checkmark-circle" size={24} color="#4CC38A" />;
            case 'active':
                return <ActivityIndicator size="small" color="#4A8EE8" />;
            case 'error':
                return <Ionicons name="close-circle" size={24} color={COLORS.error} />;
            default:
                return <Ionicons name={step.icon} size={24} color="#9CA3AF" />;
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

            {/* Back button */}
            <View style={styles.backRow}>
                <BackButton onPress={() => navigation.goBack()} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
                {/* Header */}
                <View style={styles.header}>
                    <View style={styles.iconContainer}>
                        <Ionicons name="shield-checkmark" size={44} color="#4A8EE8" />
                    </View>
                    <Text style={styles.title}>{t('biometricSetup.title')}</Text>
                    <Text style={styles.subtitle}>
                        {t('biometricSetup.subtitle')}
                    </Text>
                </View>

                {/* Steps */}
                <View style={styles.stepsContainer}>
                    {steps.map((step, index) => (
                        <View key={step.id} style={styles.stepRow}>
                            <View style={styles.stepIconContainer}>
                                {getStepIcon(step)}
                                {index < steps.length - 1 && (
                                    <View style={[
                                        styles.stepLine,
                                        step.status === 'done' && { backgroundColor: '#4CC38A' },
                                    ]} />
                                )}
                            </View>
                            <View style={styles.stepContent}>
                                <Text style={[
                                    styles.stepLabel,
                                    step.status === 'done' && styles.stepLabelDone,
                                    step.status === 'active' && styles.stepLabelActive,
                                ]}>
                                    {step.label}
                                </Text>
                                {step.detail && (
                                    <Text style={styles.stepDetail}>{step.detail}</Text>
                                )}
                            </View>
                        </View>
                    ))}
                </View>

                {/* Wallet Address Display (when done) */}
                {walletResult && (
                    <View style={styles.addressContainer}>
                        <Text style={styles.addressLabel}>{t('biometricSetup.addressLabel')}</Text>
                        <Text style={styles.addressText}>{walletResult.walletAddress}</Text>
                        <View style={styles.addressNoteRow}>
                            <Ionicons
                                name="lock-closed"
                                size={14}
                                color="#4CC38A"
                            />
                            <Text style={styles.addressNote}>
                                {t('biometricSetup.addressNote')}
                            </Text>
                        </View>
                    </View>
                )}

                {/* Error State */}
                {error && !existingWalletConflict && (
                    <View style={styles.errorContainer}>
                        <Ionicons name="alert-circle" size={20} color={COLORS.error} style={{ marginBottom: SPACING.s }} />
                        <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                        <TouchableOpacity onPress={handleRetry}>
                            <Text style={styles.retryLink}>{t('biometricSetup.retryLink')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Existing Wallet Conflict */}
                {existingWalletConflict && (
                    <View style={styles.conflictContainer}>
                        <View style={styles.conflictIconContainer}>
                            <Ionicons name="wallet" size={28} color="#E8A838" />
                        </View>
                        <Text style={styles.conflictTitle}>{t('biometricSetup.walletExists')}</Text>
                        <Text style={styles.conflictSubtext}>
                            {t('biometricSetup.conflictSubtext')}
                        </Text>

                        <TouchableOpacity style={styles.restoreButton} onPress={handleRestore} activeOpacity={0.8}>
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.restoreButtonGradient}
                            >
                                <Text style={styles.restoreButtonText}>{t('biometricSetup.restoreButton')}</Text>
                                <Ionicons name="arrow-forward" size={18} color="white" />
                            </LinearGradient>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.deleteButton}
                            onPress={handleDeleteAndRetry}
                            disabled={isDeletingKey}
                            activeOpacity={0.8}
                        >
                            {isDeletingKey ? (
                                <ActivityIndicator size="small" color={COLORS.error} />
                            ) : (
                                <>
                                    <Text style={styles.deleteButtonText}>{t('biometricSetup.deleteButton')}</Text>
                                    <Text style={styles.deleteWarning}>{t('biometricSetup.deleteWarning')}</Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </View>
                )}

                {/* Security Note */}
                <View style={styles.securityNote}>
                    <View style={styles.securityNoteIconBg}>
                        <Ionicons name="information-circle" size={16} color="#4A8EE8" />
                    </View>
                    <Text style={styles.securityNoteText}>
                        {t('biometricSetup.securityNote')}
                    </Text>
                </View>
            </Animated.View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    backRow: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    scrollContent: {
        flexGrow: 1,
        justifyContent: 'center',
        paddingBottom: SPACING.xl,
    },
    content: {
        paddingHorizontal: SPACING.l,
    },
    header: {
        alignItems: 'center',
        marginBottom: SPACING.xl * 1.5,
    },
    iconContainer: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(74,142,232,0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    title: {
        fontSize: 26,
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
        paddingHorizontal: SPACING.m,
    },
    stepsContainer: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        marginBottom: SPACING.xl,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: SPACING.m,
    },
    stepIconContainer: {
        width: 32,
        alignItems: 'center',
    },
    stepLine: {
        width: 2,
        height: 24,
        backgroundColor: 'rgba(42,48,56,1)',
        marginTop: 4,
    },
    stepContent: {
        flex: 1,
        marginLeft: SPACING.m,
        paddingTop: 2,
    },
    stepLabel: {
        fontSize: 16,
        fontWeight: '500',
        color: '#9CA3AF',
    },
    stepLabelDone: {
        color: COLORS.text,
    },
    stepLabelActive: {
        color: '#4A8EE8',
        fontWeight: '600',
    },
    stepDetail: {
        fontSize: 13,
        color: '#8B929E',
        marginTop: 2,
    },
    addressContainer: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        alignItems: 'center',
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 5,
    },
    addressLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        textTransform: 'uppercase',
        letterSpacing: 2,
        marginBottom: SPACING.xs,
    },
    addressText: {
        fontSize: 13,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.xs,
    },
    addressNoteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
    },
    addressNote: {
        fontSize: 12,
        color: '#8B929E',
    },
    errorContainer: {
        backgroundColor: 'rgba(255,71,87,0.10)',
        borderRadius: 14,
        padding: SPACING.m,
        alignItems: 'center',
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.20)',
    },
    errorText: {
        fontSize: 14,
        color: COLORS.error,
        textAlign: 'center',
        marginBottom: SPACING.s,
    },
    retryLink: {
        fontSize: 14,
        fontWeight: '600',
        color: '#4A8EE8',
    },
    securityNote: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: SPACING.s,
        backgroundColor: 'rgba(74,142,232,0.08)',
        borderRadius: 14,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.15)',
    },
    securityNoteIconBg: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.s,
    },
    securityNoteText: {
        fontSize: 13,
        color: '#8B929E',
        flex: 1,
        lineHeight: 19,
    },
    conflictContainer: {
        backgroundColor: 'rgba(255,179,0,0.08)',
        borderRadius: 18,
        padding: SPACING.l,
        alignItems: 'center',
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.20)',
    },
    conflictIconContainer: {
        width: 52,
        height: 52,
        borderRadius: 26,
        backgroundColor: 'rgba(255,179,0,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
    },
    conflictTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
    },
    conflictSubtext: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: SPACING.l,
    },
    restoreButton: {
        borderRadius: 28,
        overflow: 'hidden',
        width: '100%',
        marginBottom: SPACING.m,
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    restoreButtonGradient: {
        paddingVertical: 14,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 28,
    },
    restoreButtonText: {
        fontSize: 15,
        fontWeight: '600',
        color: 'white',
    },
    deleteButton: {
        paddingVertical: 12,
        alignItems: 'center',
        width: '100%',
    },
    deleteButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.error,
    },
    deleteWarning: {
        fontSize: 12,
        color: '#9CA3AF',
        marginTop: 4,
    },
});

export default BiometricSetupScreen;
