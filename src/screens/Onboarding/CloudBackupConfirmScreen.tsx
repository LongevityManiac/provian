import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * CloudBackupConfirmScreen - Mandatory backup-password setup for encrypted cloud backup.
 *
 * Flow:
 *   enter_pin → confirm_pin → creating → (success navigates onward)
 *
 * The user chooses a 6+ character backup password, confirms it, and the screen
 * calls createCloudBackup(password), which encrypts wallet metadata with a
 * password-derived key (PBKDF2 → AES-256-GCM) and stores the ciphertext in
 * iCloud Keychain (iOS) or Google Drive appDataFolder (Android) via the
 * native ProvianCloudKeychainSync module.
 *
 * Both platforms accept a 6–64 character alphanumeric password. iOS was
 * historically capped at a 6-digit numeric PIN (a UX choice — iCloud Keychain
 * rate-limits brute force, so 6 digits was judged adequate); that cap was a
 * pure UI constraint and was lifted to match Android. Legacy 6-digit PINs are
 * just short passwords to the KDF, so existing backups restore unchanged.
 *
 * This step is NOT skippable. No backup means no recovery on a new device,
 * which means lost funds if the phone is lost. A wallet without a backup
 * is a launch-blocker class of failure.
 *
 * Reached via BiometricSetupScreen after wallet creation.
 *
 * On failure (e.g. native module missing, iCloud/Google not signed in, sync
 * verification failed), the screen says what happened in plain words and lets the
 * user retry, or back up by writing down the recovery phrase instead
 * (PhraseBackupScreen) — offered to everyone whose phone cannot reach the cloud.
 * There is no way past this step without one of the two backups.
 */

import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Platform,
    ActivityIndicator,
    TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { createCloudBackup, CloudBackupBelongsToOtherWalletError, type OtherWalletBackupChoice } from '../../core/recovery/cloud/CloudBackupV2';
import { clearBackupRequired } from '../../core/recovery/cloud/backupRequirement';
import { cloudTargetLabel } from '../../core/recovery/cloud/ProvianCloudKeychainSync';
import { backupFailureKey } from '../../core/recovery/cloud/backupFailureText';
import { renderOtherWalletBackupMessage } from './otherWalletBackupCopy';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';

type Stage = 'enter_pin' | 'confirm_pin' | 'creating' | 'done';

// One policy on both platforms: 6–64 characters, full keyboard. The KDF
// (see validatePin in CloudBackupV2.ts) accepts any string ≥ 6 chars; the
// old iOS 6-digit numeric cap was UI-only and legacy PINs still restore.
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;

const CloudBackupConfirmScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const cloudName = cloudTargetLabel();
    // When reached from Settings/Dashboard (not the onboarding chain), the user
    // must be able to back out, and finishing should return them where they came
    // from rather than continuing into the onboarding Attestation step.
    const fromSettings = route?.params?.fromSettings === true;
    // Reached from a phrase restore (or the unlock gate after one) whose wallet has no cloud
    // backup yet: no way back, and finishing opens the app.
    const requiredBeforeApp = route?.params?.requiredBeforeApp === true;

    const [stage, setStage] = useState<Stage>('enter_pin');
    const [pin, setPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    // No cloud on this phone (the backup module is missing), or a backup attempt failed: offer the
    // recovery-phrase backup to everyone, as an equal way to finish this step.

    const resetToEnterPin = (errMessage: string) => {
        setPin('');
        setConfirmPin('');
        setError(errMessage);
        setStage('enter_pin');
    };

    // ── Stage transitions ──────────────────────────────────────────────────

    const handleEnterPinNext = () => {
        if (pin.length < MIN_PASSWORD_LENGTH) {
            setError(t('cloudBackupConfirm.errorMinLength', { min: MIN_PASSWORD_LENGTH }));
            return;
        }
        setError(null);
        setStage('confirm_pin');
    };

    const handleConfirmPinNext = async () => {
        if (confirmPin !== pin) {
            resetToEnterPin(t('cloudBackupConfirm.errorMismatch'));
            return;
        }
        setError(null);
        setStage('creating');

        await createBackupWith(pin);
    };

    /**
     * Create the backup. When the cloud account already holds a backup for ANOTHER wallet, the
     * person chooses: keep it (this wallet is backed up under its own key and both wallets stay
     * recoverable) or replace it (that wallet loses its cloud recovery). Either way this wallet
     * ends backed up — there is no third answer that leaves it without one. A re-backup
     * of this same wallet never asks.
     */
    const createBackupWith = async (backupPin: string, choice?: OtherWalletBackupChoice): Promise<void> => {
        try {
            await createCloudBackup(backupPin, undefined, {
                keepExisting: choice === 'keep',
                replaceExisting: choice === 'replace',
            });
            await AsyncStorage.setItem('@provian_backup_skipped', 'false');
            await AsyncStorage.setItem('@provian_cloud_backup_enabled', 'true');
            await clearBackupRequired().catch(() => undefined);
            setStage('done');

            // Brief success display before advancing. From settings we return
            // to the caller; after a phrase restore we open the app; in the
            // onboarding chain we continue to attestation.
            setTimeout(() => {
                if (fromSettings) {
                    navigation.goBack();
                } else if (requiredBeforeApp) {
                    navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
                } else {
                    navigation.navigate('Attestation');
                }
            }, 800);
        } catch (err) {
            if (err instanceof CloudBackupBelongsToOtherWalletError) {
                Alert.alert(
                    t('cloudBackupConfirm.otherWalletTitle'),
                    errorDisplayCopy(renderOtherWalletBackupMessage(t, err.existingWalletAddress)),
                    [
                        { text: t('cloudBackupConfirm.keepBothBackups'), style: 'default', onPress: () => { void createBackupWith(backupPin, 'keep'); } },
                        { text: t('cloudBackupConfirm.replaceBackup'), style: 'destructive', onPress: () => { void createBackupWith(backupPin, 'replace'); } },
                    ],
                    { cancelable: false },
                );
                return;
            }
            // Plain words, never the backup layer's technical message.
            // Wipe PINs and return to enter_pin for retry. We do not retain the
            // PIN across a failure. The user re-enters from scratch.
            resetToEnterPin(t(backupFailureKey(err), { cloudName }));
        }
    };

    const handleBackToEnterPin = () => {
        setConfirmPin('');
        setError(null);
        setStage('enter_pin');
    };

    // ── Stage UI ───────────────────────────────────────────────────────────

    const sanitize = (v: string): string => v.slice(0, MAX_PASSWORD_LENGTH);

    const placeholderEnter = t('cloudBackupConfirm.placeholderPassword');
    const hintText = t('cloudBackupConfirm.hint', { min: MIN_PASSWORD_LENGTH });

    const renderEnterPin = () => (
        <>
            <View style={styles.iconContainer}>
                <Ionicons name="lock-closed" size={48} color="#4A8EE8" />
            </View>
            <Text style={styles.title}>{t('cloudBackupConfirm.titleEnter')}</Text>
            <Text style={styles.subtitle}>
                {t('cloudBackupConfirm.subtitleEnter', {
                    location: Platform.OS === 'ios'
                        ? t('cloudBackupConfirm.locationIos')
                        : t('cloudBackupConfirm.locationAndroid'),
                })}
            </Text>

            {error && (
                <View style={styles.errorBanner}>
                    <Ionicons name="warning" size={16} color={COLORS.errorLight} />
                    <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                </View>
            )}

            <TextInput
                style={styles.pinInput}
                value={pin}
                onChangeText={(v) => setPin(sanitize(v))}
                placeholder={placeholderEnter}
                placeholderTextColor="#6B7280"
                keyboardType="default"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={MAX_PASSWORD_LENGTH}
                autoFocus
            />

            <Text style={styles.hint}>{hintText}</Text>

            <TouchableOpacity
                style={[styles.primaryButton, pin.length < MIN_PASSWORD_LENGTH && styles.buttonDisabled]}
                onPress={handleEnterPinNext}
                disabled={pin.length < MIN_PASSWORD_LENGTH}
                activeOpacity={0.8}
            >
                <LinearGradient colors={GRADIENTS.primary} style={styles.buttonGradient}>
                    <Text style={styles.buttonText}>{t('cloudBackupConfirm.buttonContinue')}</Text>
                </LinearGradient>
            </TouchableOpacity>

            {/* Offered to everyone, always: iOS cannot tell an app whether iCloud Keychain is on (a
                synced keychain write succeeds either way), so the phone never decides for the person. */}
            <Text style={[styles.hint, styles.fallbackHint]}>{t('cloudBackupConfirm.phraseFallbackHint', { cloudName })}</Text>
            <TouchableOpacity
                style={[styles.secondaryButton, styles.fallbackButton]}
                onPress={() => navigation.navigate('PhraseBackup', { fromSettings, requiredBeforeApp })}
                accessibilityRole="button"
            >
                <Text style={styles.secondaryButtonText}>{t('cloudBackupConfirm.usePhraseInstead')}</Text>
            </TouchableOpacity>
        </>
    );

    const renderConfirmPin = () => (
        <>
            <View style={styles.iconContainer}>
                <Ionicons name="shield-checkmark" size={48} color="#4A8EE8" />
            </View>
            <Text style={styles.title}>{t('cloudBackupConfirm.titleConfirm')}</Text>
            <Text style={styles.subtitle}>
                {t('cloudBackupConfirm.subtitleConfirm')}
            </Text>

            <TextInput
                style={styles.pinInput}
                value={confirmPin}
                onChangeText={(v) => setConfirmPin(sanitize(v))}
                placeholder={t('cloudBackupConfirm.placeholderReenter')}
                placeholderTextColor="#6B7280"
                keyboardType="default"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={MAX_PASSWORD_LENGTH}
                autoFocus
            />

            <TouchableOpacity
                style={[styles.primaryButton, confirmPin.length < MIN_PASSWORD_LENGTH && styles.buttonDisabled]}
                onPress={handleConfirmPinNext}
                disabled={confirmPin.length < MIN_PASSWORD_LENGTH}
                activeOpacity={0.8}
            >
                <LinearGradient colors={GRADIENTS.primary} style={styles.buttonGradient}>
                    <Text style={styles.buttonText}>{t('cloudBackupConfirm.buttonCreateBackup')}</Text>
                </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={handleBackToEnterPin}>
                <Text style={styles.secondaryButtonText}>{t('cloudBackupConfirm.buttonChangePassword')}</Text>
            </TouchableOpacity>
        </>
    );

    const renderCreating = () => (
        <>
            <View style={styles.iconContainer}>
                <ActivityIndicator size="large" color="#4A8EE8" />
            </View>
            <Text style={styles.title}>{t('cloudBackupConfirm.titleCreating')}</Text>
            <Text style={styles.subtitle}>
                {t('cloudBackupConfirm.subtitleCreating', { cloudName })}
            </Text>
        </>
    );

    // Platform-specific success copy: iOS backup surfaces automatically on a
    // new device via iCloud Keychain; Android requires signing into the same
    // Google account before Drive's appDataFolder is reachable. Be honest
    // about the difference so the user knows what to expect on recovery.
    //
    // A2: the iOS copy names the iCloud Keychain dependency instead of
    // promising unconditional automatic recovery. verifySync has already
    // confirmed an iCloud account is signed in and the item is queued for sync,
    // but iOS exposes no API to confirm the iCloud Keychain sub-toggle is ON —
    // so we tell the user it syncs *as long as iCloud Keychain is on*, rather
    // than making a promise we cannot verify.
    const doneSubtitle =
        Platform.OS === 'ios'
            ? t('cloudBackupConfirm.doneSubtitleIos')
            : t('cloudBackupConfirm.doneSubtitleAndroid');

    const renderDone = () => (
        <>
            <View style={styles.iconContainer}>
                <Ionicons name="checkmark-circle" size={48} color="#4CC38A" />
            </View>
            <Text style={styles.title}>{t('cloudBackupConfirm.titleDone')}</Text>
            <Text style={styles.subtitle}>{doneSubtitle}</Text>
        </>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            {/* Back affordance only on the settings entry path, and only before
                backup creation begins (don't let the user interrupt creation). */}
            {fromSettings && (stage === 'enter_pin' || stage === 'confirm_pin') && (
                <View style={styles.navBar}>
                    <BackButton onPress={() => navigation.goBack()} />
                </View>
            )}
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                {stage === 'enter_pin' && renderEnterPin()}
                {stage === 'confirm_pin' && renderConfirmPin()}
                {stage === 'creating' && renderCreating()}
                {stage === 'done' && renderDone()}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    content: {
        flexGrow: 1,
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
        marginBottom: SPACING.xl,
        paddingHorizontal: SPACING.s,
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,107,107,0.1)',
        borderRadius: 12,
        padding: SPACING.m,
        marginBottom: SPACING.m,
        gap: SPACING.s,
    },
    errorText: {
        color: COLORS.errorLight,
        fontSize: 14,
        flex: 1,
    },
    pinInput: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.15)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        fontSize: 24,
        color: COLORS.text,
        textAlign: 'center',
        letterSpacing: 2,
        marginBottom: SPACING.s,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    hint: {
        fontSize: 13,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    primaryButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
    },
    buttonGradient: {
        paddingVertical: 16,
        alignItems: 'center',
        borderRadius: 28,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        color: 'white',
    },
    buttonDisabled: {
        opacity: 0.5,
        shadowOpacity: 0,
    },
    secondaryButton: {
        marginTop: SPACING.m,
        paddingVertical: 14,
        alignItems: 'center',
    },
    secondaryButtonText: {
        fontSize: 15,
        color: '#8B929E',
        fontWeight: '500',
    },
    fallbackHint: {
        marginTop: SPACING.xl,
        marginBottom: 0,
    },
    fallbackButton: {
        marginTop: SPACING.xs,
    },
});

export default CloudBackupConfirmScreen;
