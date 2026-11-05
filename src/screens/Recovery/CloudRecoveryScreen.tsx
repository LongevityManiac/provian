import { errorDisplayCopy } from '../../i18n/displayCopy';
import { type BiometricAction } from '../../core/security/biometricAction';
import { withBiometricOrFallback } from '../../core/security/biometricOrFallback';
import { onWalletUnlocked, preparePeCloudAccess } from '../../core/meter/phoneMeterRuntime';
/**
 * CloudRecoveryScreen - PIN-encrypted cloud backup recovery
 *
 * Attempts to recover the wallet from an encrypted backup in
 * iCloud Keychain (iOS) / Google Drive encrypted app folder (Android).
 * User enters their backup PIN
 * to decrypt the BIP-39 mnemonic and restore the wallet on this device.
 *
 * Fallback: "Import recovery phrase" for manual seed entry.
 *
 * Entry points:
 *   - "I already have a wallet" on onboarding step 0
 *   - RecoveryStartScreen
 */

import React, { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getItemHmac, setItemHmac, removeItemHmac } from '../../core/security/hmacAsyncStorage';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ActivityIndicator,
    TextInput,
    Platform,
    Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import * as LocalAuthentication from 'expo-local-authentication';
import { listCloudBackups, retrieveCloudBackup, CloudBackupPayload, type CloudBackupEntry } from '../../core/recovery/cloud/CloudBackupV2';
import { PRIMARY_BACKUP_KEY } from '../../core/recovery/cloud/cloudBackupSlots';
import { isSyncAvailable, signInForRecovery } from '../../core/recovery/cloud/ProvianCloudKeychainSync';
import SeedManager from '../../core/wallet/SeedManager';
import { restoreActivityHistory } from '../../core/recovery/restoreActivityHistory';
import { registerRecoveredHumanWallet } from '../../core/recovery/registerRecoveredWallet';
import { ensureSolanaAddressProven } from '../../core/chains/solana/solanaAddressProof';
import { ensureAppOutputKeyRegistered } from '../../core/meter/outputSigningRuntime';
import RelayAPIService from '../../services/RelayAPIService';
import {
    applyCloudRecovery,
    OverwriteConfirmationRequired,
    OverwriteConfirmationFailed,
    REQUIRED_CONFIRMATION_PHRASE,
    type OverwriteConfirmation,
} from '../../core/recovery/applyCloudRecovery';
import { useWalletStore } from '../../store/walletStore';
import { useTranslation } from 'react-i18next';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import BackButton from '../../components/BackButton';

// F-06: Recovery PIN tiered retry lockout.
// Mirrors the BiometricSetupScreen pattern. Wave 6 LOW-1 (re-audit
// docs/audit/chunk_h_reaudit_2026_05.md §4 LOW-1): the lockout
// counter and timestamp are now wrapped via hmacAsyncStorage so a
// tampered value (rooted device, backup-scrape edit) fails MAC
// verification and resets to zero failures. Defense-in-depth, not
// load-bearing: an attacker who can write the on-disk state can also
// reinstall the app to start the counter fresh anyway, but the
// existing Theme-4 callers (BehavioralBaseline, EnvironmentAttestation,
// EmergencyStopService) all use HMAC so this brings recovery into
// line with the project pattern.
const RECOVERY_PIN_FAILURES_KEY = 'provian.recovery.pin.failures';
const RECOVERY_PIN_LOCKOUT_KEY = 'provian.recovery.pin.lockout_until';
const RECOVERY_LOCKOUT_TIERS = [
    { failures: 5, cooldownMs: 30 * 1000 },        // 5 failures: 30 seconds
    { failures: 10, cooldownMs: 5 * 60 * 1000 },   // 10 failures: 5 minutes
    { failures: 15, cooldownMs: 30 * 60 * 1000 },  // 15 failures: 30 minutes
];

async function getRecoveryFailureCount(): Promise<number> {
    try {
        const stored = await getItemHmac<number>(RECOVERY_PIN_FAILURES_KEY);
        return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0
            ? Math.floor(stored)
            : 0;
    } catch {
        return 0;
    }
}

async function incrementRecoveryFailureCount(): Promise<{ count: number; lockoutUntil: number | null }> {
    const current = await getRecoveryFailureCount();
    const newCount = current + 1;
    await setItemHmac(RECOVERY_PIN_FAILURES_KEY, newCount);
    let lockoutUntil: number | null = null;
    for (const tier of RECOVERY_LOCKOUT_TIERS.slice().reverse()) {
        if (newCount >= tier.failures) {
            lockoutUntil = Date.now() + tier.cooldownMs;
            await setItemHmac(RECOVERY_PIN_LOCKOUT_KEY, lockoutUntil);
            break;
        }
    }
    return { count: newCount, lockoutUntil };
}

async function resetRecoveryLockout(): Promise<void> {
    await removeItemHmac(RECOVERY_PIN_FAILURES_KEY);
    await removeItemHmac(RECOVERY_PIN_LOCKOUT_KEY);
}

async function getRecoveryLockoutStatus(): Promise<{ isLocked: boolean; remainingMs: number }> {
    try {
        const lockoutUntil = await getItemHmac<number>(RECOVERY_PIN_LOCKOUT_KEY);
        if (typeof lockoutUntil !== 'number' || !Number.isFinite(lockoutUntil)) {
            return { isLocked: false, remainingMs: 0 };
        }
        const remaining = lockoutUntil - Date.now();
        if (remaining <= 0) {
            await removeItemHmac(RECOVERY_PIN_LOCKOUT_KEY);
            return { isLocked: false, remainingMs: 0 };
        }
        return { isLocked: true, remainingMs: remaining };
    } catch {
        return { isLocked: false, remainingMs: 0 };
    }
}

function formatLockoutRemaining(remainingMs: number): string {
    const seconds = Math.ceil(remainingMs / 1000);
    if (seconds < 60) return seconds + 's';
    const minutes = Math.ceil(seconds / 60);
    return minutes + 'm';
}

type RecoveryState =
    | 'checking'
    | 'sign_in_required'   // Android: no Google account signed in for Drive
    | 'signing_in'         // Android: Google sign-in intent is up
    // the cloud account holds more than one wallet's backup — pick which to restore.
    | 'choose_backup'
    | 'enter_pin'
    | 'decrypting'
    // B-1 (audit 2026-05-11): a wallet already exists on this device.
    // Decryption succeeded but importMnemonic is gated until the user
    // types REQUIRED_CONFIRMATION_PHRASE AND passes biometric.
    | 'overwrite_confirm'
    | 'overwrite_applying'
    // Wallet is recovered + accessible, but the biometric prompt that unlocks
    // the seed-derived PE archive was declined/unavailable. Offer Retry / Skip
    // rather than silently completing with empty Activity (WS7 follow-up).
    | 'restore_retry'
    | 'success'
    | 'not_found'
    | 'error';

// F-09: Recovery accepts the full alphanumeric range on both platforms
// (iOS creation stays 6-digit numeric in CloudBackupConfirmScreen; this
// screen only runs on the recovery side, where users may have created
// the backup on another platform and need to type the longer alphanumeric
// password they set on Android, or the 6-digit PIN they set on iOS).
// Showing the full keyboard makes both paths possible.
const PIN_KEYBOARD_TYPE: 'default' = 'default';
const MAX_PIN_LENGTH = 64;
const MIN_PIN_LENGTH = 6;

const CloudRecoveryScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const cloudName = Platform.OS === 'ios' ? 'iCloud Keychain' : 'Google Drive';
    const setAddress = useWalletStore(s => s.setAddress);
    const completeOnboarding = useWalletStore(s => s.completeOnboarding);

    const [state, setState] = useState<RecoveryState>('checking');
    const [error, setError] = useState<string | null>(null);
    const [pin, setPin] = useState('');
    const [payload, setPayload] = useState<CloudBackupPayload | null>(null);
    // every backup the account holds, and the one being restored.
    const [backups, setBackups] = useState<CloudBackupEntry[]>([]);
    const [selectedBackupKey, setSelectedBackupKey] = useState<string>(PRIMARY_BACKUP_KEY);

    // B-1 (audit 2026-05-11): when the device already has a wallet, the
    // decrypted payload is held here pending the user typing the
    // confirmation phrase + passing biometric. This state never persists
    // outside the component lifetime.
    const [pendingPayload, setPendingPayload] = useState<CloudBackupPayload | null>(null);
    const [confirmText, setConfirmText] = useState('');
    const [confirmError, setConfirmError] = useState<string | null>(null);

    // UX-1 (2026-06-13): true when the restored seed already matched the
    // wallet on this device - a no-op restore. Drives a calm success
    // message ("already on this device") instead of the recovery framing.
    const [alreadyOnDevice, setAlreadyOnDevice] = useState(false);

    // F-06: lockout state. lockoutRemainingMs > 0 disables the Decrypt button
    // and surfaces the wait time. A 1s ticker decrements it.
    const [lockoutRemainingMs, setLockoutRemainingMs] = useState(0);

    // WS7 follow-up: true while a history-restore attempt (initial / Retry /
    // Skip) is in flight, so the retry panel can show a spinner + disable buttons.
    const [restoringHistory, setRestoringHistory] = useState(false);

    useEffect(() => {
        checkForBackup();
    }, []);

    // F-06: On mount, check whether a prior lockout is still active.
    useEffect(() => {
        (async () => {
            const { isLocked, remainingMs } = await getRecoveryLockoutStatus();
            if (isLocked) setLockoutRemainingMs(remainingMs);
        })();
    }, []);

    // F-06: Tick the lockout countdown once a second while it's active.
    useEffect(() => {
        if (lockoutRemainingMs <= 0) return;
        const id = setInterval(() => {
            setLockoutRemainingMs((prev) => Math.max(0, prev - 1000));
        }, 1000);
        return () => clearInterval(id);
    }, [lockoutRemainingMs]);

    // F-09: No auto-submit. Recovery accepts variable-length alphanumeric
    // input on both platforms, so we cannot infer "user is done typing"
    // from length alone. The user taps Decrypt explicitly.

    const checkForBackup = async () => {
        try {
            // F-04: On Android, Drive recovery requires the user to be signed
            // into a Google account. If not signed in, show the sign-in CTA
            // before declaring "no backup found". Without this, fresh-device
            // recovery silently fails.
            if (Platform.OS === 'android') {
                const signedIn = await isSyncAvailable();
                if (!signedIn) {
                    setState('sign_in_required');
                    return;
                }
            }
            // One account can hold more than one wallet's backup : list them all and
            // ask which to restore when there is a choice.
            const { entries } = await listCloudBackups();
            setBackups(entries);
            if (entries.length === 0) {
                setState('not_found');
            } else {
                setSelectedBackupKey(entries[0].key);
                setState(entries.length > 1 ? 'choose_backup' : 'enter_pin');
            }
        } catch (err) {
            setState('not_found');
        }
    };

    const handleSignIn = async () => {
        setError(null);
        setState('signing_in');
        try {
            const ok = await signInForRecovery();
            if (!ok) {
                setError(t('cloudRecovery.googleSignInUnavailable'));
                setState('sign_in_required');
                return;
            }
            // After sign-in, re-run the backup check.
            setState('checking');
            await checkForBackup();
        } catch (err) {
            setError(t('cloudRecovery.signInFailed'));
            setState('sign_in_required');
        }
    };

    /**
     * Apply a decrypted recovery payload to local SecureStore + AsyncStorage
     * + the wallet store, optionally satisfying the overwrite-confirmation
     * gate. Throws OverwriteConfirmationRequired if a wallet already exists
     * on the device and the caller hasn't passed `overwriteConfirmation`;
     * the caller (attemptDecrypt or attemptOverwriteConfirmation) handles
     * the navigation.
     */
    const commitDecryptedRecovery = async (
        result: CloudBackupPayload,
        overwriteConfirmation: OverwriteConfirmation | undefined,
        biometricAction?: BiometricAction,
    ): Promise<void> => {
        if (!biometricAction) {
            await preparePeCloudAccess().catch(() => false);
            return withBiometricOrFallback(t('recovery.confirmWalletReplacement'), action => commitDecryptedRecovery(result, overwriteConfirmation, action));
        }
        const recoveryResult = await applyCloudRecovery(
            result.mnemonic,
            {
                hasSeed: () => SeedManager.hasSeed(),
                seedMatches: (m) => SeedManager.seedMatches(m, biometricAction),
                importMnemonic: (m, opts) => SeedManager.importMnemonic(m, opts, biometricAction),
                verifySeedReadable: () => SeedManager.verifySeedReadable(biometricAction),
            },
            overwriteConfirmation,
        );

        // The seed is now on the device. The remaining steps are idempotent; if
        // any of them throws, the import has ALREADY succeeded, so don't let the
        // failure surface as a generic "recovery failed" (or, worse, a wrong-PIN
        // penalty). Re-throw a clear "finish setup" message - a retry re-enters
        // applyCloudRecovery via the benign alreadyPresent path and completes
        // (review #12).
        try {
            // getEVMAddress() returns public material only and wipes the derived
            // private key internally.
            const walletAddress = await SeedManager.getEVMAddress(biometricAction);

            await AsyncStorage.multiSet([
                ['provian_wallet_address', walletAddress],
                ['provian_wallet_created_at', result.created_at || new Date().toISOString()],
                ['provian_key_source', 'bip39_seed'],
                ['provian_evm_address', walletAddress],
                ['@provian_device_key_created', 'true'],
                ['@provian_cloud_backup_enabled', 'true'],
            ]);

            // F-06: success clears the failure counter and any active lockout.
            await resetRecoveryLockout();
            setLockoutRemainingMs(0);

            // The wallet is now fully recovered and ACCESSIBLE — seed in
            // SecureStore, address set, onboarding marked complete (persisted).
            // From here, nothing about PE-history restore can block wallet
            // access: even a force-quit on the retry panel leaves a complete,
            // unlockable wallet (relaunch → WalletLock → MainTabs).
            setPayload(result);
            setPendingPayload(null);
            setConfirmText('');
            setAlreadyOnDevice(recoveryResult.alreadyPresent);
            setAddress(walletAddress);

            // Put this device on the restored wallet's OWN relay account (the one that holds its
            // PEs and PVT) and confirm its registration, exactly as the phrase restore does. The
            // cloud restore never did, so a fresh device read 0 PEs / 0 PVT until a relaunch, and a
            // device that held another wallet's relay credentials kept reading that wallet's record.
            // Fire-and-forget: both legs are best-effort and the launch backstop retries.
            await registerRecoveredHumanWallet(walletAddress, {
                recoverRelayCredentials: (a) => RelayAPIService.recoverRelayCredentials(a, biometricAction),
                ensureHumanWalletRegistered: async (a, options) => { await RelayAPIService.ensureHumanWalletRegistered(a, options, biometricAction); },
                // The restored wallet's own Solana address (best-effort; retried on later app opens).
                proveSolanaAddress: () => ensureSolanaAddressProven(biometricAction),
                // The phone's output-signing key for the restored wallet (best-effort; retried on later opens).
                registerOutputSigningKey: () => ensureAppOutputKeyRegistered(),
            });

            completeOnboarding('wallet');
            // Restored FROM the cloud backup: this wallet is backed up; the banner stays down.
            await AsyncStorage.setItem('@provian_backup_skipped', 'false').catch(() => undefined);
        } catch (finalizeErr) {
            console.error('[CloudRecovery] Post-import finalize failed (seed already imported):', finalizeErr);
            throw new Error(t('cloudRecovery.finishSetupFailed'));
        }

        // #3 (Pass-2 WS7) + WS7 follow-up: restore the PE activity history. The
        // archive is encrypted with a SEED-DERIVED key (getMnemonic, biometric-
        // SESSION gated), and the cloud-PIN flow establishes no session (the PIN
        // only decrypts the cloud blob). A DECLINED prompt must NOT silently
        // complete with empty Activity — runHistoryRestore('with_session')
        // surfaces a Retry / Skip choice instead. This is outside the finalize
        // try so a restore outcome never mis-reports a wrong-PIN/finish-setup
        // error, and runs only after completeOnboarding so the wallet is already
        // accessible regardless of outcome.
        await onWalletUnlocked(biometricAction).catch(() => undefined);
        await runHistoryRestore('with_session', biometricAction);
    };

    /**
     * WS7 follow-up: run the post-recovery PE-history restore and map the
     * outcome to UI. A declined biometric → 'restore_retry' (Retry / Skip),
     * NEVER a silent empty-Activity success. Wallet access is already granted
     * (completeOnboarding ran), so this only governs history + which screen
     * state shows next.
     */
    const runHistoryRestore = async (mode: 'with_session' | 'skip', biometricAction?: BiometricAction): Promise<void> => {
        setRestoringHistory(true);
        try {
            const outcome = await restoreActivityHistory(mode, undefined, biometricAction);
            if (outcome.status === 'session_declined') {
                setState('restore_retry');
            } else {
                console.log(`[CloudRecovery] history ${outcome.status}: ${outcome.restoredCount} from ${outcome.source}`);
                setState('success');
            }
        } finally {
            setRestoringHistory(false);
        }
    };

    const handleRetryHistoryRestore = () => { void runHistoryRestore('with_session'); };
    const handleSkipHistoryRestore = () => { void runHistoryRestore('skip'); };

    /**
     * B-1 (audit 2026-05-11): the user typed the confirmation phrase and
     * tapped "Replace wallet". Run the biometric prompt, then re-attempt
     * commitDecryptedRecovery with the overwrite confirmation. On any
     * failure stay on the confirm screen with an error.
     */
    const attemptOverwriteConfirmation = async () => {
        if (!pendingPayload) {
            setConfirmError(t('cloudRecovery.noPendingRecovery'));
            return;
        }
        if (confirmText !== REQUIRED_CONFIRMATION_PHRASE) {
            setConfirmError(t('recovery.confirmPhraseError'));
            return;
        }
        setConfirmError(null);
        setState('overwrite_applying');
        try {
            // The strict native gate below ignores the seed-phrase fallback: with no enrolled
            // biometric it can only fail, so say so first (the phrase screen
            // already does; without this the failed attempt also left the wallet in fallback mode).
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();
            if (!hasHardware || !isEnrolled) {
                setConfirmError(t('recovery.biometricUnavailableReplace'));
                setState('overwrite_confirm');
                return;
            }
            await preparePeCloudAccess().catch(() => false);
            // The typed phrase and this action's strict native biometric gate are both required.
            await withBiometricOrFallback(t('recovery.confirmWalletReplacement'), async biometricAction => {
                await commitDecryptedRecovery(pendingPayload, { typedPhrase: confirmText, biometricSuccess: true }, biometricAction);
            }, undefined, true);
        } catch (err) {
            if (err instanceof OverwriteConfirmationFailed) {
                if (err.message.includes('biometric_unavailable')) {
                    setConfirmError(t('recovery.biometricUnavailableReplace'));
                } else if (err.message.includes('biometric_denied')) {
                    setConfirmError(t('recovery.biometricCancelledReplace'));
                } else {
                    setConfirmError(t('recovery.confirmPhraseError'));
                }
            } else {
                const msg = err instanceof Error ? err.message : t('cloudRecovery.applyRecoveryFailed');
                setConfirmError(msg);
            }
            setState('overwrite_confirm');
        }
    };

    const attemptDecrypt = async () => {
        if (pin.length < MIN_PIN_LENGTH) {
            Alert.alert(t('cloudRecovery.invalidPin'), t('cloudRecovery.invalidPinMsg'));
            return;
        }

        // F-06: Refuse decrypt while the lockout window is active. Re-read
        // the HMAC-protected lockout state (rather than trusting React
        // state) so a foregrounded app doesn't bypass a lockout written
        // before backgrounding.
        const lockStatus = await getRecoveryLockoutStatus();
        if (lockStatus.isLocked) {
            setLockoutRemainingMs(lockStatus.remainingMs);
            setError(t('recovery.tooManyAttempts', { time: formatLockoutRemaining(lockStatus.remainingMs) }));
            return;
        }

        setState('decrypting');
        try {
            const result = await retrieveCloudBackup(pin, selectedBackupKey);
            if (!result) {
                // Treat a null result the same as a wrong PIN for lockout
                // accounting - both are "decrypt did not produce a payload".
                const { count, lockoutUntil } = await incrementRecoveryFailureCount();
                if (lockoutUntil) {
                    setLockoutRemainingMs(lockoutUntil - Date.now());
                }
                setError(
                    lockoutUntil
                        ? t('recovery.tooManyAttemptsWithCount', { count, time: formatLockoutRemaining(lockoutUntil - Date.now()) })
                        : t('cloudRecovery.decryptFailed'),
                );
                setState('error');
                return;
            }

            // B-1 (audit 2026-05-11): if a wallet already exists on this
            // device, defer to the overwrite-confirmation gate before
            // touching SecureStore. Without this, a returning user with a
            // funded wallet who lands here from RecoveryStartScreen / a
            // back-stack pop silently loses their wallet to whatever
            // mnemonic decrypted from cloud.
            try {
                await commitDecryptedRecovery(result, undefined);
            } catch (gateErr) {
                if (gateErr instanceof OverwriteConfirmationRequired) {
                    setPendingPayload(result);
                    setConfirmText('');
                    setConfirmError(null);
                    // Reset PIN failure counter - the PIN was correct;
                    // the gate is a separate friction layer.
                    await resetRecoveryLockout();
                    setLockoutRemainingMs(0);
                    setState('overwrite_confirm');
                    return;
                }
                throw gateErr;
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : t('cloudRecovery.decryptionFailed');
            // GCM auth-tag failure = wrong PIN. Match the SPECIFIC crypto-failure
            // markers (@noble/ciphers throws 'aes/gcm: invalid ghash tag'), not
            // broad words like 'auth' - a Google Drive 'authentication' transport
            // error would otherwise be miscounted as a wrong PIN and trigger the
            // lockout even though the user typed it correctly (review #26).
            const lower = message.toLowerCase();
            const wrongPin =
                lower.includes('ghash tag') ||
                lower.includes('invalid tag') ||
                lower.includes('gcm') ||
                lower.includes('decryption failed');
            if (wrongPin) {
                const { count, lockoutUntil } = await incrementRecoveryFailureCount();
                if (lockoutUntil) {
                    setLockoutRemainingMs(lockoutUntil - Date.now());
                    setError(
                        t('recovery.tooManyAttemptsWithCount', { count, time: formatLockoutRemaining(lockoutUntil - Date.now()) }),
                    );
                } else {
                    setError(t('cloudRecovery.wrongPin'));
                }
            } else {
                // Plain words, never the cloud layer's technical message.
                setError(t('cloudRecovery.restoreFailedPlain'));
            }
            setState('enter_pin');
            setPin('');
        }
    };

    const handleImportPhrase = () => {
        navigation.navigate('ImportRecoveryPhrase');
    };

    const handleBack = () => {
        if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            navigation.navigate('Onboarding');
        }
    };

    const handleCreateNew = () => {
        navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
    };

    const handleContinue = () => {
        // Wallet is already restored - go straight to MainTabs.
        navigation.reset({
            index: 0,
            routes: [{ name: 'MainTabs' }],
        });
    };

    const stateTitle =
        state === 'checking' ? t('cloudRecovery.titleChecking') :
        state === 'sign_in_required' ? t('cloudRecovery.titleSignInRequired') :
        state === 'signing_in' ? t('cloudRecovery.titleSigningIn') :
        state === 'choose_backup' ? t('cloudRecovery.titleChooseBackup') :
        state === 'enter_pin' ? t('cloudRecovery.titleEnterPassword') :
        state === 'decrypting' ? t('cloudRecovery.titleDecrypting') :
        state === 'overwrite_confirm' ? t('cloudRecovery.titleReplaceExisting') :
        state === 'overwrite_applying' ? t('cloudRecovery.titleReplacing') :
        state === 'restore_retry' ? t('recovery.historyRestoreTitle') :
        state === 'success' ? (alreadyOnDevice ? t('cloudRecovery.titleAlreadySet') : t('cloudRecovery.titleWalletFound')) :
        state === 'not_found' ? t('cloudRecovery.titleNotFound') :
        t('cloudRecovery.titleFailed');

    const stateSubtitle =
        state === 'checking' ? t('cloudRecovery.subtitleChecking', { cloudName }) :
        state === 'sign_in_required' ? t('cloudRecovery.subtitleSignInRequired') :
        state === 'signing_in' ? t('cloudRecovery.subtitleSigningIn') :
        state === 'choose_backup' ? t('cloudRecovery.subtitleChooseBackup', { count: backups.length }) :
        state === 'enter_pin' ? t('cloudRecovery.subtitleEnterPassword') :
        state === 'decrypting' ? t('cloudRecovery.subtitleDecrypting') :
        state === 'overwrite_confirm' ? t('recovery.existingWalletCloudWarning') :
        state === 'overwrite_applying' ? t('cloudRecovery.subtitleReplacing') :
        state === 'restore_retry' ? t('recovery.historyRestoreBody') :
        state === 'success' ? (alreadyOnDevice
            ? t('cloudRecovery.subtitleAlreadySet', {
                addressStart: payload?.wallet_address?.slice(0, 8),
                addressEnd: payload?.wallet_address?.slice(-6),
            })
            : t('cloudRecovery.subtitleRecovered', {
                addressStart: payload?.wallet_address?.slice(0, 8),
                addressEnd: payload?.wallet_address?.slice(-6),
            })) :
        state === 'not_found' ? (Platform.OS === 'android'
            ? t('cloudRecovery.subtitleNotFoundAndroid')
            : t('cloudRecovery.subtitleNotFoundIos')) :
        error || t('cloudRecovery.subtitleFailed');

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Back button */}
            <View style={styles.headerRow}>
                <BackButton onPress={handleBack} />
            </View>

            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                {/* Icon */}
                <View style={styles.iconContainer}>
                    {state === 'success' ? (
                        <Ionicons name="checkmark-circle" size={56} color="#4CC38A" />
                    ) : state === 'not_found' ? (
                        <Ionicons name="cloud-offline" size={56} color="#8B929E" />
                    ) : state === 'overwrite_confirm' || state === 'overwrite_applying' ? (
                        // B-1: red triangle warning for the overwrite gate.
                        <Ionicons name="warning" size={56} color="#E63946" />
                    ) : state === 'restore_retry' ? (
                        <Ionicons name="time-outline" size={56} color="#4A8EE8" />
                    ) : (
                        <Ionicons name="cloud-download" size={56} color="#4A8EE8" />
                    )}
                </View>

                {/* Title */}
                <Text style={styles.title}>
                    {stateTitle}
                </Text>

                {/*
                 * Subtitle - the not_found case is platform-aware. On iOS, if
                 * nothing shows up it means there really is no backup (iCloud
                 * Keychain syncs automatically). On Android, the most common
                 * cause is that the user isn't signed into the Google account
                 * that owns the Drive appDataFolder - so we lead with that
                 * check before sending them to the seed-phrase fallback.
                 */}
                <Text style={styles.subtitle}>
                    {stateSubtitle}
                </Text>

                {/* choose which wallet's backup to restore */}
                {state === 'choose_backup' && (
                    <View style={styles.optionsContainer}>
                        {backups.map((entry) => (
                            <TouchableOpacity
                                key={entry.key}
                                style={styles.backupChoice}
                                onPress={() => {
                                    setSelectedBackupKey(entry.key);
                                    setPin('');
                                    setError(null);
                                    setState('enter_pin');
                                }}
                                activeOpacity={0.8}
                            >
                                <Ionicons name="wallet-outline" size={20} color="#4A8EE8" />
                                <Text style={styles.backupChoiceText}>
                                    {entry.walletAddress
                                        ? t('cloudRecovery.backupForWallet', {
                                            addressStart: entry.walletAddress.slice(0, 8),
                                            addressEnd: entry.walletAddress.slice(-6),
                                        })
                                        : t('cloudRecovery.earlierBackupLabel')}
                                </Text>
                                <Ionicons name="chevron-forward" size={18} color="#8B929E" />
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {/* PIN entry */}
                {state === 'enter_pin' && (
                    <View style={styles.pinContainer}>
                        {error && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="warning" size={16} color={COLORS.errorLight} />
                                <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                            </View>
                        )}
                        <TextInput
                            style={styles.pinInput}
                            value={pin}
                            onChangeText={(v) => setPin(v.slice(0, MAX_PIN_LENGTH))}
                            placeholder={t('cloudRecovery.backupPasswordPlaceholder')}
                            placeholderTextColor="#6B7280"
                            keyboardType={PIN_KEYBOARD_TYPE}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            maxLength={MAX_PIN_LENGTH}
                            autoFocus
                        />
                        {lockoutRemainingMs > 0 && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="lock-closed" size={16} color={COLORS.errorLight} />
                                <Text style={styles.errorText}>
                                    {t('recovery.tooManyAttempts', { time: formatLockoutRemaining(lockoutRemainingMs) })}
                                </Text>
                            </View>
                        )}
                        <TouchableOpacity
                            style={[
                                styles.primaryButton,
                                (pin.length < MIN_PIN_LENGTH || lockoutRemainingMs > 0) && styles.buttonDisabled,
                            ]}
                            onPress={attemptDecrypt}
                            disabled={pin.length < MIN_PIN_LENGTH || lockoutRemainingMs > 0}
                            activeOpacity={0.8}
                        >
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                style={styles.buttonGradient}
                            >
                                <Text style={styles.buttonText}>{t('cloudRecovery.decryptBackup')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                        {backups.length > 1 && (
                            <TouchableOpacity
                                style={styles.secondaryButton}
                                onPress={() => { setPin(''); setError(null); setState('choose_backup'); }}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.secondaryButtonText}>{t('cloudRecovery.chooseAnotherBackup')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                )}

                {/* B-1 (audit 2026-05-11): overwrite confirmation gate.
                    Deliberately friction-heavy - typed phrase + biometric.
                    Without this, a returning user with a funded wallet who
                    reaches CloudRecovery via a back-stack pop or deep link
                    silently loses their wallet. */}
                {state === 'overwrite_confirm' && (
                    <View style={styles.overwriteContainer}>
                        <View style={styles.overwriteWarningHeader}>
                            <Ionicons name="alert-circle" size={20} color="#FFFFFF" />
                            <Text style={styles.overwriteWarningHeaderText}>{t('recovery.destructiveAction')}</Text>
                        </View>
                        <Text style={styles.overwriteBody}>
                            {t('recovery.existingWalletCloudWarning', { provider: cloudName })}
                            {'\n\n'}{t('recovery.seedLossWarningShort')}{'\n\n'}{t('recovery.confirmReplaceInstruction')}</Text>
                        <Text style={styles.overwritePhrasePrompt}>{t('recovery.typeLabel')}{REQUIRED_CONFIRMATION_PHRASE}
                        </Text>
                        <TextInput
                            style={styles.overwriteInput}
                            value={confirmText}
                            onChangeText={setConfirmText}
                            placeholder={REQUIRED_CONFIRMATION_PHRASE}
                            placeholderTextColor="#6B7280"
                            autoCapitalize="characters"
                            autoCorrect={false}
                            maxLength={REQUIRED_CONFIRMATION_PHRASE.length + 4}
                        />
                        {confirmError && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="warning" size={16} color={COLORS.errorLight} />
                                <Text style={styles.errorText}>{confirmError}</Text>
                            </View>
                        )}
                        <TouchableOpacity
                            style={[
                                styles.overwriteDangerButton,
                                confirmText !== REQUIRED_CONFIRMATION_PHRASE && styles.buttonDisabled,
                            ]}
                            onPress={attemptOverwriteConfirmation}
                            disabled={confirmText !== REQUIRED_CONFIRMATION_PHRASE}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.overwriteDangerButtonText}>{t('recovery.replaceWallet')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.overwriteCancelButton}
                            onPress={() => {
                                setPendingPayload(null);
                                setConfirmText('');
                                setConfirmError(null);
                                setError(null);
                                setState('enter_pin');
                            }}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.overwriteCancelButtonText}>{t('recovery.cancelKeepCurrentWallet')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* WS7 follow-up: history-restore retry / skip. The wallet is
                    already recovered + accessible; this only governs whether the
                    PE activity history is restored. Retry re-prompts the
                    biometric (the seed IS in SecureStore, so it's a real
                    re-attempt); Skip continues without restoring (the encrypted PE
                    backup stays in the person's cloud; the relay holds no PEs). */}
                {state === 'restore_retry' && (
                    <View style={styles.optionsContainer}>
                        <TouchableOpacity
                            style={[styles.primaryButton, restoringHistory && styles.buttonDisabled]}
                            onPress={handleRetryHistoryRestore}
                            disabled={restoringHistory}
                            activeOpacity={0.8}
                        >
                            <LinearGradient colors={GRADIENTS.primary} style={styles.buttonGradient}>
                                {restoringHistory ? (
                                    <ActivityIndicator color="white" size="small" />
                                ) : (
                                    <>
                                        <Ionicons name="finger-print" size={20} color="white" style={{ marginRight: 8 }} />
                                        <Text style={styles.buttonText}>{t('recovery.historyRestoreRetry')}</Text>
                                    </>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.secondaryButton}
                            onPress={handleSkipHistoryRestore}
                            disabled={restoringHistory}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.secondaryButtonText}>{t('recovery.historyRestoreSkip')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Spinner for active states */}
                {(state === 'checking' || state === 'decrypting' || state === 'signing_in' || state === 'overwrite_applying') && (
                    <ActivityIndicator size="large" color="#4A8EE8" style={{ marginTop: SPACING.l }} />
                )}

                {/* Android Drive sign-in CTA (F-04) */}
                {state === 'sign_in_required' && (
                    <View style={styles.optionsContainer}>
                        {error && (
                            <View style={styles.errorBanner}>
                                <Ionicons name="warning" size={16} color={COLORS.errorLight} />
                                <Text style={styles.errorText}>{errorDisplayCopy(error)}</Text>
                            </View>
                        )}
                        <TouchableOpacity style={styles.primaryButton} onPress={handleSignIn} activeOpacity={0.8}>
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.buttonGradient}
                            >
                                <Ionicons name="logo-google" size={20} color="white" style={{ marginRight: 8 }} />
                                <Text style={styles.buttonText}>{t('recovery.signInGoogle')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.primaryButton} onPress={handleImportPhrase} activeOpacity={0.8}>
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.buttonGradient}
                            >
                                <Ionicons name="key" size={20} color="white" style={{ marginRight: 8 }} />
                                <Text style={styles.buttonText}>{t('cloudRecovery.importRecoveryPhrase')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Success */}
                {state === 'success' && payload && (
                    <View style={styles.successCard}>
                        <SuccessRow label={t('cloudRecovery.backupDecrypted')} />
                        <SuccessRow label={t('cloudRecovery.addressLabel', { address: payload.wallet_address.slice(0, 10) + '...' })} />
                        <SuccessRow label={t('cloudRecovery.chainsLabel', { chains: payload.chain_ids.join(', ') })} />
                        <SuccessRow label={t('cloudRecovery.createdLabel', { date: new Date(payload.created_at).toLocaleDateString() })} />

                        <TouchableOpacity style={styles.primaryButton} onPress={handleContinue} activeOpacity={0.8}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.buttonGradient}>
                                <Text style={styles.buttonText}>{t('cloudRecovery.continueRecovery')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>

                        <Text style={styles.recoveryNote}>
                            {t('cloudRecovery.recoveryNote')}
                        </Text>
                    </View>
                )}

                {/* Not found - show options */}
                {state === 'not_found' && (
                    <View style={styles.optionsContainer}>
                        {/*
                         * Android: the user may land here simply because the
                         * wrong Google account is signed in. Offer a primary
                         * "Try again" button so they can sign-in switch and
                         * re-check without leaving the flow. iOS has no
                         * equivalent re-check - iCloud Keychain either has
                         * the item or doesn't.
                         */}
                        {Platform.OS === 'android' && (
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={() => { setState('checking'); checkForBackup(); }}
                                activeOpacity={0.8}
                            >
                                <LinearGradient
                                    colors={GRADIENTS.primary}
                                    start={{ x: 0, y: 0 }}
                                    end={{ x: 1, y: 0 }}
                                    style={styles.buttonGradient}
                                >
                                    <Ionicons name="refresh" size={20} color="white" style={{ marginRight: 8 }} />
                                    <Text style={styles.buttonText}>{t('connectAgent.retry')}</Text>
                                </LinearGradient>
                            </TouchableOpacity>
                        )}

                        <TouchableOpacity style={styles.primaryButton} onPress={handleImportPhrase} activeOpacity={0.8}>
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 0 }}
                                style={styles.buttonGradient}
                            >
                                <Ionicons name="key" size={20} color="white" style={{ marginRight: 8 }} />
                                <Text style={styles.buttonText}>{t('cloudRecovery.importRecoveryPhrase')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>

                        <TouchableOpacity style={styles.secondaryButton} onPress={handleCreateNew} activeOpacity={0.7}>
                            <Text style={styles.secondaryButtonText}>{t('cloudRecovery.createNewWallet')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
};

const SuccessRow = ({ label }: { label: string }) => (
    <View style={styles.successRow}>
        <Ionicons name="checkmark-circle" size={20} color="#4CC38A" />
        <Text style={styles.successRowText}>{label}</Text>
    </View>
);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    headerRow: {
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    content: {
        flexGrow: 1,
        paddingHorizontal: SPACING.l,
        justifyContent: 'center',
    },
    iconContainer: {
        width: 100,
        height: 100,
        borderRadius: 50,
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
        marginBottom: SPACING.l,
        paddingHorizontal: SPACING.s,
    },
    pinContainer: {
        width: '100%',
        marginTop: SPACING.m,
    },
    pinInput: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.15)',
        borderRadius: 16,
        padding: SPACING.m,
        fontSize: 24,
        color: COLORS.text,
        textAlign: 'center',
        letterSpacing: 2,
        marginBottom: SPACING.l,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
    successCard: {
        backgroundColor: 'rgba(0,230,118,0.08)',
        borderRadius: 16,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(0,230,118,0.15)',
        marginTop: SPACING.m,
    },
    successRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.s,
    },
    successRowText: {
        fontSize: 15,
        color: COLORS.text,
        marginLeft: SPACING.s,
    },
    recoveryNote: {
        fontSize: 13,
        color: '#8B929E',
        textAlign: 'center',
        marginTop: SPACING.m,
        lineHeight: 18,
    },
    optionsContainer: {
        marginTop: SPACING.l,
    },
    primaryButton: {
        borderRadius: 28,
        overflow: 'hidden',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 16,
        elevation: 8,
        marginTop: SPACING.m,
        marginBottom: SPACING.m,
    },
    buttonGradient: {
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        borderRadius: 28,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        color: 'white',
    },
    backupChoice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.15)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        marginBottom: SPACING.s,
    },
    backupChoiceText: {
        flex: 1,
        fontSize: 15,
        color: COLORS.text,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    secondaryButton: {
        paddingVertical: 14,
        alignItems: 'center',
    },
    secondaryButtonText: {
        fontSize: 15,
        color: '#8B929E',
        fontWeight: '500',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    // B-1 (audit 2026-05-11): styles for the overwrite-confirm gate.
    // Deliberately stark to break the user out of "tap through" mode.
    overwriteContainer: {
        marginTop: SPACING.l,
        borderWidth: 1,
        borderColor: '#E63946',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        backgroundColor: 'rgba(230, 57, 70, 0.08)',
    },
    overwriteWarningHeader: {
        backgroundColor: '#E63946',
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.s,
        marginBottom: SPACING.m,
    },
    overwriteWarningHeaderText: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '700',
        letterSpacing: 1,
        marginLeft: SPACING.s,
    },
    overwriteBody: {
        fontSize: 14,
        color: COLORS.text,
        lineHeight: 20,
        marginBottom: SPACING.m,
    },
    overwritePhrasePrompt: {
        fontSize: 13,
        color: '#FFB4BA',
        fontWeight: '600',
        marginBottom: SPACING.s,
    },
    overwriteInput: {
        borderWidth: 1,
        borderColor: '#E63946',
        borderRadius: BORDER_RADIUS.s,
        padding: SPACING.m,
        fontSize: 16,
        color: '#FFFFFF',
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
        marginBottom: SPACING.m,
    },
    overwriteDangerButton: {
        backgroundColor: '#E63946',
        paddingVertical: 16,
        borderRadius: BORDER_RADIUS.m,
        alignItems: 'center',
        marginTop: SPACING.s,
    },
    overwriteDangerButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
    },
    overwriteCancelButton: {
        paddingVertical: 14,
        alignItems: 'center',
        marginTop: SPACING.s,
    },
    overwriteCancelButtonText: {
        color: '#8B929E',
        fontSize: 14,
        fontWeight: '500',
    },
});

export default CloudRecoveryScreen;
