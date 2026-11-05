import { errorDisplayCopy } from '../../i18n/displayCopy';
import { type BiometricAction } from '../../core/security/biometricAction';
import { withBiometricOrFallback } from '../../core/security/biometricOrFallback';
import { onWalletUnlocked, preparePeCloudAccess } from '../../core/meter/phoneMeterRuntime';
import React, { useState, useRef, useCallback } from 'react';
import {
    ScrollView,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
    StyleSheet,
    Platform,
    useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CommonActions } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import SeedManager, {
    OverwriteConfirmationRequired,
} from '../../core/wallet/SeedManager';
import { REQUIRED_CONFIRMATION_PHRASE } from '../../core/recovery/applyCloudRecovery';
import { restoreActivityHistory } from '../../core/recovery/restoreActivityHistory';
import { registerRecoveredHumanWallet } from '../../core/recovery/registerRecoveredWallet';
import { ensureSolanaAddressProven } from '../../core/chains/solana/solanaAddressProof';
import { ensureAppOutputKeyRegistered } from '../../core/meter/outputSigningRuntime';
import RelayAPIService from '../../services/RelayAPIService';
import { hasCloudBackup } from '../../core/recovery/cloud/CloudBackupV2';
import { markBackupRequired, clearBackupRequired, resolveBackupGate } from '../../core/recovery/cloud/backupRequirement';
import { useWalletStore } from '../../store/walletStore';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { WORD_GRID, wordGridColumns } from './wordGridColumns';

const WORD_COUNTS = [12, 24] as const;
type WordCount = (typeof WORD_COUNTS)[number];

interface Props {
    navigation: {
        navigate: (screen: string) => void;
        goBack: () => void;
        dispatch: (action: any) => void;
    };
}

// B-1 (audit 2026-05-11) sibling-path fix (2026-05-12): when the device
// already has a wallet, the typed mnemonic is held here pending the user
// typing the confirmation phrase + passing biometric. The state machine
// mirrors CloudRecoveryScreen's overwrite-confirm flow so a returning
// user with a funded wallet who lands on this screen cannot silently
// overwrite their seed.
type OverwriteState =
    | { kind: 'idle' }
    | { kind: 'confirm'; mnemonic: string }
    | { kind: 'applying'; mnemonic: string };

const ImportRecoveryPhraseScreen = ({ navigation }: Props) => {
    const { t } = useTranslation();
    const { width: windowWidth } = useWindowDimensions();
    const { setAddress, completeOnboarding } = useWalletStore();
    const [wordCount, setWordCount] = useState<WordCount>(12);
    const [words, setWords] = useState<string[]>(Array(12).fill(''));
    const [loading, setLoading] = useState(false);
    const [overwriteState, setOverwriteState] = useState<OverwriteState>({ kind: 'idle' });
    const [confirmText, setConfirmText] = useState('');
    const [confirmError, setConfirmError] = useState<string | null>(null);
    // WS7 follow-up: post-recovery history-restore state. 'retry' shows the
    // Retry / Skip panel after a declined biometric; 'restoring' shows a spinner
    // while an attempt is in flight. The wallet is already recovered before this
    // state is ever reached, so it never blocks wallet access.
    const [historyRestore, setHistoryRestore] = useState<'idle' | 'retry' | 'restoring'>('idle');
    const [recoveredAddress, setRecoveredAddress] = useState<string | null>(null);
    const inputRefs = useRef<(TextInput | null)[]>([]);

    const allFilled = words.slice(0, wordCount).every((w) => w.trim().length > 0);

    const handleWordCountToggle = useCallback(
        (count: WordCount) => {
            if (count === wordCount) return;
            const newWords = Array(count).fill('');
            for (let i = 0; i < Math.min(words.length, count); i++) {
                newWords[i] = words[i];
            }
            setWords(newWords);
            setWordCount(count);
        },
        [wordCount, words],
    );

    const handleWordChange = useCallback(
        (index: number, value: string) => {
            const trimmed = value.replace(/\n/g, '').trim();
            const pastedWords = trimmed.split(/\s+/);

            if (pastedWords.length >= 12) {
                const targetCount = pastedWords.length >= 24 ? 24 : 12;
                const filled = Array(targetCount).fill('');
                for (let i = 0; i < Math.min(pastedWords.length, targetCount); i++) {
                    filled[i] = pastedWords[i].toLowerCase();
                }
                if (targetCount !== wordCount) {
                    setWordCount(targetCount as WordCount);
                }
                setWords(filled);
                return;
            }

            setWords((prev) => {
                const updated = [...prev];
                updated[index] = value.toLowerCase().replace(/\s/g, '');
                return updated;
            });
        },
        [wordCount],
    );

    const handlePasteFromClipboard = useCallback(async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text) {
                Alert.alert(t('importRecovery.clipboardEmpty'), t('importRecovery.clipboardEmptyMsg'));
                return;
            }
            const clipWords = text.trim().split(/\s+/);
            if (clipWords.length < 12) {
                Alert.alert(
                    t('recovery.invalidClipboard'),
                    t('recovery.invalidClipboardMsg'),
                );
                return;
            }
            const targetCount = clipWords.length >= 24 ? 24 : 12;
            const filled = Array(targetCount).fill('');
            for (let i = 0; i < Math.min(clipWords.length, targetCount); i++) {
                filled[i] = clipWords[i].toLowerCase();
            }
            setWordCount(targetCount as WordCount);
            setWords(filled);
        } catch {
            Alert.alert(t('importRecovery.pasteFailed'), t('importRecovery.pasteFailedMsg'));
        }
    }, []);

    /**
     * WS7 follow-up: restore PE activity history, then record the
     * wallet_created PE and navigate into the app.
     *
     * #35 ORDERING: restore runs (and sets CHAIN_HEAD to the restored tip)
     * BEFORE createEnvelope, so wallet_created links to the restored tip rather
     * than GENESIS. A declined biometric returns 'session_declined' → we show
     * the Retry / Skip panel instead of silently completing with empty Activity
     * (and we do NOT record wallet_created yet — Retry/Skip re-drives it). The
     * wallet is already recovered + accessible before this runs, so nothing here
     * blocks wallet access; Skip is always available and always navigates in.
     */
    const finishAfterRestore = useCallback(
        async (mode: 'with_session' | 'skip', evmAddress: string, biometricAction?: BiometricAction): Promise<void> => {
            setHistoryRestore('restoring');
            const outcome = await restoreActivityHistory(mode, undefined, biometricAction);
            if (outcome.status === 'session_declined') {
                setHistoryRestore('retry');
                return;
            }
            console.log(`[ImportRecovery] history ${outcome.status}: ${outcome.restoredCount} from ${outcome.source}`);

            try {
                const ProvenanceEnvelopeManager = (await import('../../core/provenance/ProvenanceEnvelopeManager')).default;
                await ProvenanceEnvelopeManager.createEnvelope({
                    actionType: 'wallet_created',
                    intentText: 'Wallet restored from recovery phrase',
                    assetSymbol: 'ETH',
                    amount: '0',
                    chainId: 0,
                    riskScore: 0,
                    riskCategory: 'low',
                    policyDecision: 'allow',
                    actorAddress: evmAddress,
                });
            } catch (peError) {
                console.warn('[ImportRecovery] wallet_created PE generation failed:', peError);
            }

            // A restored wallet with no cloud backup of its own goes to the backup screen before
            // the app — the backup is mandatory on every onboarding path.
            const gate = await resolveBackupGate(evmAddress, hasCloudBackup);
            navigation.dispatch(
                CommonActions.reset({
                    index: 0,
                    routes: gate === 'backup'
                        ? [{ name: 'CloudBackupConfirm', params: { requiredBeforeApp: true } }]
                        : [{ name: 'MainTabs' }],
                })
            );
        },
        [navigation],
    );

    const handleRetryHistory = useCallback(() => {
        if (recoveredAddress) void finishAfterRestore('with_session', recoveredAddress);
    }, [recoveredAddress, finishAfterRestore]);

    const handleSkipHistory = useCallback(() => {
        if (recoveredAddress) void finishAfterRestore('skip', recoveredAddress);
    }, [recoveredAddress, finishAfterRestore]);

    /**
     * Commit the mnemonic to SecureStore + AsyncStorage + Zustand and
     * navigate into the main app. When `force` is true, SeedManager
     * skips its overwrite guard - only set this after the user has
     * passed the typed-phrase + biometric confirmation gate below.
     */
    const performRestore = useCallback(async (mnemonic: string, force: boolean, biometricAction?: BiometricAction): Promise<void> => {
        if (!biometricAction) {
            await preparePeCloudAccess().catch(() => false);
            return withBiometricOrFallback(t('recovery.confirmWalletReplacement'), action => performRestore(mnemonic, force, action));
        }
        await SeedManager.importMnemonic(mnemonic, force ? { force: true } : undefined, biometricAction);
        const walletAddress = await SeedManager.getEVMAddress(biometricAction);

        await AsyncStorage.multiSet([
            ['provian_wallet_address', walletAddress],
            ['provian_wallet_created_at', new Date().toISOString()],
            ['provian_key_source', 'bip39_seed'],
            ['provian_evm_address', walletAddress],
        ]);

        setAddress(walletAddress);

        await AsyncStorage.multiSet([
            ['@provian_device_key_created', 'true'],
            ['@provian_cloud_backup_enabled', 'false'],
        ]);

        const evmAddress = walletAddress;

        // Recover relay credentials AND register the human wallet. Unlike fresh
        // onboarding (BiometricSetupScreen), the recovery path never registered
        // the wallet with the relay - so the wallets doc, the wallet_created PE,
        // and accrual were never created and the user's record stayed empty.
        //
        // finding #1: these two legs used to be CHAINED
        // (recover().then(register)), so a failing recovery (throttle, declined
        // biometric, network blip) skipped registration entirely and the first
        // POST /v1/human-promises/create 404'd until an app restart. They now run
        // INDEPENDENTLY (registerRecoveredHumanWallet): registration is always
        // attempted, and makeAuthenticatedRequest auto-recovers credentials for
        // it when the recovery leg did not. Non-blocking; AppNavigator reconciles
        // on launch as a final backstop if both fail.
        await registerRecoveredHumanWallet(evmAddress, {
            recoverRelayCredentials: (a) => RelayAPIService.recoverRelayCredentials(a, biometricAction),
            ensureHumanWalletRegistered: async (a, options) => { await RelayAPIService.ensureHumanWalletRegistered(a, options, biometricAction); },
            // The restored wallet's own Solana address (best-effort; retried on later app opens).
            proveSolanaAddress: () => ensureSolanaAddressProven(biometricAction),
            // The phone's output-signing key for the restored wallet (best-effort; retried on later opens).
            registerOutputSigningKey: () => ensureAppOutputKeyRegistered(),
        });

        // The wallet is now fully recovered and ACCESSIBLE — seed in SecureStore,
        // address set, onboarding marked complete (persisted). Mark it complete
        // BEFORE the history restore so nothing about restore (a declined
        // biometric, a retry loop) can block wallet access: even a force-quit on
        // the retry panel leaves a complete, unlockable wallet (relaunch →
        // WalletLock → the backup screen while one is owed, then MainTabs).
        // completeOnboarding does not auto-navigate.
        setRecoveredAddress(evmAddress);
        // The restored wallet owes a backup until one is PROVEN : the mark is written before
        // onboarding completes, so no crash, kill or failed check between the two can land the
        // wallet in the app without it. A failed write aborts here, before completion.
        await markBackupRequired(evmAddress);
        completeOnboarding('wallet');
        // A wallet restored from its phrase has a cloud backup only if THIS wallet's blob is on the
        // account (2026-10-17: the banner flag was left as the previous wallet set it). The mark routes the wallet to the backup screen now and, after a force-quit, at every
        // unlock until this wallet's backup is proven; it clears only on that proof. A failed
        // check counts as missing.
        const backedUp = await hasCloudBackup(evmAddress).catch(() => false);
        if (backedUp) await clearBackupRequired().catch(() => undefined);
        try {
            await AsyncStorage.setItem('@provian_backup_skipped', backedUp ? 'false' : 'true');
        } catch { /* best-effort: the banner reads the flag again on the next focus */ }

        // History restore + the wallet_created PE happen in finishAfterRestore so
        // Retry / Skip can re-drive them. A declined biometric surfaces the retry
        // panel (no silent empty-Activity completion).
        await onWalletUnlocked(biometricAction).catch(() => undefined);
        await finishAfterRestore('with_session', evmAddress, biometricAction);
    }, [setAddress, completeOnboarding, finishAfterRestore]);

    const handleRestore = useCallback(async () => {
        const mnemonic = words
            .slice(0, wordCount)
            .map((w) => w.trim().toLowerCase())
            .join(' ');

        if (!SeedManager.validate(mnemonic)) {
            Alert.alert(
                t('recovery.invalidRecoveryPhrase'),
                t('recovery.invalidRecoveryPhraseMsg'),
            );
            return;
        }

        setLoading(true);
        try {
            // UX-1 (2026-06-13): if the entered phrase derives the wallet
            // that's already on this device, it's a no-op restore - there is
            // nothing to lose by re-importing the same seed. Skip the
            // destructive overwrite gate and restore directly (force=true
            // writes identical bytes). seedMatches fails safe (false on any
            // error), so the gated path below still fires for a genuinely
            // different seed.
            const sameWallet =
                (await SeedManager.hasSeed()) && (await SeedManager.seedMatches(mnemonic));
            await performRestore(mnemonic, sameWallet);
        } catch (error: unknown) {
            // B-1 sibling fix: a wallet already exists on this device.
            // Stash the validated mnemonic and pivot to the destructive-
            // action confirmation panel. SecureStore is untouched.
            if (error instanceof OverwriteConfirmationRequired) {
                setOverwriteState({ kind: 'confirm', mnemonic });
                setConfirmText('');
                setConfirmError(null);
                return;
            }
            const message =
                error instanceof Error ? error.message : t('common.error');
            Alert.alert(t('recovery.restoreFailed'), errorDisplayCopy(message));
        } finally {
            setLoading(false);
        }
    }, [words, wordCount, performRestore]);

    /**
     * B-1 sibling fix (2026-05-12): the user typed the confirmation
     * phrase and tapped "Replace wallet". Run the biometric prompt then
     * call performRestore with force=true. On any failure stay on the
     * confirm panel with a specific error.
     */
    const handleConfirmOverwrite = useCallback(async () => {
        if (overwriteState.kind !== 'confirm') return;
        if (confirmText !== REQUIRED_CONFIRMATION_PHRASE) {
            setConfirmError(t('recovery.confirmPhraseError'));
            return;
        }
        const pendingMnemonic = overwriteState.mnemonic;
        setConfirmError(null);
        setOverwriteState({ kind: 'applying', mnemonic: pendingMnemonic });
        try {
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();
            if (!hasHardware || !isEnrolled) {
                setConfirmError(t('recovery.biometricUnavailableReplace'));
                setOverwriteState({ kind: 'confirm', mnemonic: pendingMnemonic });
                return;
            }
            await preparePeCloudAccess().catch(() => false);
            await withBiometricOrFallback(t('recovery.confirmWalletReplacement'), action => performRestore(pendingMnemonic, true, action), undefined, true);
        } catch (err) {
            const msg = err instanceof Error ? err.message : t('recovery.failedToReplaceWallet');
            setConfirmError(msg);
            setOverwriteState({ kind: 'confirm', mnemonic: pendingMnemonic });
        }
    }, [overwriteState, confirmText, performRestore]);

    const handleCancelOverwrite = useCallback(() => {
        setOverwriteState({ kind: 'idle' });
        setConfirmText('');
        setConfirmError(null);
    }, []);

    const renderWordInput = (index: number) => {
        const wordNumber = index + 1;
        return (
            <View key={index} style={styles.wordCell}>
                <Text style={styles.wordNumber}>{wordNumber}</Text>
                <TextInput
                    ref={(ref) => {
                        inputRefs.current[index] = ref;
                    }}
                    style={styles.wordInput}
                    value={words[index]}
                    onChangeText={(val) => handleWordChange(index, val)}
                    onSubmitEditing={() => {
                        const next = index + 1;
                        if (next < wordCount) {
                            inputRefs.current[next]?.focus();
                        }
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    returnKeyType={index < wordCount - 1 ? 'next' : 'done'}
                    blurOnSubmit={index === wordCount - 1}
                    placeholder="..."
                    placeholderTextColor={COLORS.textTertiary}
                    editable={!loading}
                />
            </View>
        );
    };

    // Three cells leave ~50pt for the word at a 320pt screen, which cuts off
    // eight-letter BIP-39 words; below 360pt the grid runs two columns.
    const columns = wordGridColumns(windowWidth);
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < wordCount; i += columns) {
        rows.push(
            <View key={`row-${i}`} style={styles.wordRow}>
                {Array.from({ length: columns }, (_, c) => renderWordInput(i + c))}
            </View>,
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('importRecovery.title')}</Text>
                <View style={styles.headerSpacer} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {historyRestore !== 'idle' ? (
                    // WS7 follow-up: history-restore retry / skip. The wallet is
                    // already recovered + accessible; this only governs whether
                    // the PE activity history is restored. Retry re-prompts the
                    // biometric (the seed IS in SecureStore, so it's a real
                    // re-attempt); Skip falls to the seedless backend-summary path
                    // and still completes recovery (navigates into the wallet).
                    <View style={styles.restoreRetryContainer}>
                        <View style={styles.iconContainer}>
                            <Ionicons name="time-outline" size={40} color={COLORS.primary} />
                        </View>
                        <Text style={styles.restoreRetryTitle}>{t('recovery.historyRestoreTitle')}</Text>
                        <Text style={styles.subtitle}>{t('recovery.historyRestoreBody')}</Text>
                        <TouchableOpacity
                            style={[styles.restoreButton, historyRestore === 'restoring' && styles.restoreButtonDisabled]}
                            onPress={handleRetryHistory}
                            disabled={historyRestore === 'restoring'}
                            activeOpacity={0.8}
                        >
                            {historyRestore === 'restoring' ? (
                                <ActivityIndicator color={COLORS.white} size="small" />
                            ) : (
                                <>
                                    <Ionicons name="finger-print" size={20} color={COLORS.white} />
                                    <Text style={styles.restoreButtonText}>{t('recovery.historyRestoreRetry')}</Text>
                                </>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.overwriteCancelButton}
                            onPress={handleSkipHistory}
                            disabled={historyRestore === 'restoring'}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.overwriteCancelButtonText}>{t('recovery.historyRestoreSkip')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : overwriteState.kind === 'idle' ? (
                    <>
                        <View style={styles.iconContainer}>
                            <Ionicons name="key-outline" size={40} color={COLORS.primary} />
                        </View>

                        <Text style={styles.subtitle}>{t('importRecovery.subtitleAllChains')}</Text>

                        <View style={styles.toggleRow}>
                            {WORD_COUNTS.map((count) => (
                                <TouchableOpacity
                                    key={count}
                                    style={[
                                        styles.toggleButton,
                                        wordCount === count && styles.toggleButtonActive,
                                    ]}
                                    onPress={() => handleWordCountToggle(count)}
                                    disabled={loading}
                                >
                                    <Text
                                        style={[
                                            styles.toggleText,
                                            wordCount === count && styles.toggleTextActive,
                                        ]}
                                    >
                                        {t('importRecovery.wordCount', { count })}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <TouchableOpacity
                            style={styles.pasteButton}
                            onPress={handlePasteFromClipboard}
                            disabled={loading}
                        >
                            <Ionicons name="clipboard-outline" size={16} color={COLORS.primaryLight} />
                            <Text style={styles.pasteText}>{t('importRecovery.pasteClipboard')}</Text>
                        </TouchableOpacity>

                        <View style={styles.grid}>{rows}</View>

                        <View style={styles.warningBanner}>
                            <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.warning} />
                            <Text style={styles.warningText}>
                                {t('importRecovery.securityWarning')}
                            </Text>
                        </View>

                        <TouchableOpacity
                            style={[styles.restoreButton, (!allFilled || loading) && styles.restoreButtonDisabled]}
                            onPress={handleRestore}
                            disabled={!allFilled || loading}
                            activeOpacity={0.8}
                        >
                            {loading ? (
                                <ActivityIndicator color={COLORS.white} size="small" />
                            ) : (
                                <>
                                    <Ionicons
                                        name="download-outline"
                                        size={20}
                                        color={allFilled ? COLORS.white : COLORS.textTertiary}
                                    />
                                    <Text
                                        style={[
                                            styles.restoreButtonText,
                                            !allFilled && styles.restoreButtonTextDisabled,
                                        ]}
                                    >
                                        {t('importRecovery.restoreWallet')}
                                    </Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </>
                ) : (
                    // B-1 sibling fix (2026-05-12): destructive-action gate.
                    // Mirrors CloudRecoveryScreen's overwrite-confirm UX -
                    // deliberately stark, with the same typed phrase +
                    // biometric requirement.
                    <View style={styles.overwriteContainer}>
                        <View style={styles.overwriteWarningHeader}>
                            <Ionicons name="alert-circle" size={20} color="#FFFFFF" />
                            <Text style={styles.overwriteWarningHeaderText}>{t('recovery.destructiveAction')}</Text>
                        </View>
                        <Text style={styles.overwriteTitle}>{t('recovery.replaceExistingWallet')}</Text>
                        <Text style={styles.overwriteBody}>
                            {t('recovery.existingWalletImportWarning')}
                            {'\n\n'}{t('recovery.seedLossWarning')}{'\n\n'}{t('recovery.confirmReplaceInstruction')}</Text>
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
                            editable={overwriteState.kind === 'confirm'}
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
                                (confirmText !== REQUIRED_CONFIRMATION_PHRASE ||
                                    overwriteState.kind === 'applying') && styles.buttonDisabled,
                            ]}
                            onPress={handleConfirmOverwrite}
                            disabled={
                                confirmText !== REQUIRED_CONFIRMATION_PHRASE ||
                                overwriteState.kind === 'applying'
                            }
                            activeOpacity={0.8}
                        >
                            {overwriteState.kind === 'applying' ? (
                                <ActivityIndicator color="#FFFFFF" size="small" />
                            ) : (
                                <Text style={styles.overwriteDangerButtonText}>{t('recovery.replaceWallet')}</Text>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.overwriteCancelButton}
                            onPress={handleCancelOverwrite}
                            disabled={overwriteState.kind === 'applying'}
                            activeOpacity={0.8}
                        >
                            <Text style={styles.overwriteCancelButtonText}>{t('recovery.cancelKeepCurrentWallet')}</Text>
                        </TouchableOpacity>
                    </View>
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
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
    },
    headerTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: COLORS.text,
        textAlign: 'center',
        flex: 1,
    },
    headerSpacer: {
        width: 44,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        paddingHorizontal: WORD_GRID.screenPadding,
        paddingBottom: SPACING.xxl,
    },
    iconContainer: {
        width: 72,
        height: 72,
        borderRadius: BORDER_RADIUS.l,
        backgroundColor: COLORS.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        marginTop: SPACING.l,
        marginBottom: SPACING.m,
    },
    subtitle: {
        fontSize: 15,
        lineHeight: 22,
        color: COLORS.textSecondary,
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    toggleRow: {
        flexDirection: 'row',
        alignSelf: 'center',
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        padding: 3,
        marginBottom: SPACING.m,
    },
    toggleButton: {
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.m - 2,
    },
    toggleButtonActive: {
        backgroundColor: COLORS.primary,
    },
    toggleText: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.textSecondary,
    },
    toggleTextActive: {
        color: COLORS.white,
    },
    pasteButton: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        paddingVertical: SPACING.xs,
        marginBottom: SPACING.m,
    },
    pasteText: {
        fontSize: 14,
        color: COLORS.primaryLight,
        marginLeft: SPACING.xs,
        fontWeight: '500',
    },
    grid: {
        marginBottom: SPACING.l,
    },
    wordRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: SPACING.s,
    },
    wordCell: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: WORD_GRID.cellBorder,
        borderColor: COLORS.border,
        marginHorizontal: WORD_GRID.cellMargin,
        paddingLeft: WORD_GRID.cellPaddingLeft,
        height: 44,
    },
    wordNumber: {
        fontSize: 11,
        fontWeight: '700',
        color: COLORS.textTertiary,
        width: WORD_GRID.numberWidth,
        textAlign: 'center',
    },
    wordInput: {
        flex: 1,
        fontSize: WORD_GRID.fontSize,
        color: COLORS.text,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        paddingVertical: 0,
        paddingRight: WORD_GRID.cellPaddingRight,
        height: 44,
    },
    warningBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.warningMuted,
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    warningText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        color: COLORS.warning,
        marginLeft: SPACING.s,
    },
    restoreButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.primary,
        borderRadius: BORDER_RADIUS.m,
        paddingVertical: 16,
        marginBottom: SPACING.l,
    },
    restoreButtonDisabled: {
        backgroundColor: COLORS.surfaceHighlight,
    },
    restoreButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.white,
        marginLeft: SPACING.s,
    },
    restoreButtonTextDisabled: {
        color: COLORS.textTertiary,
    },
    // B-1 sibling fix (2026-05-12): destructive-action gate.
    // Hex values match CloudRecoveryScreen's overwrite styles so both
    // recovery paths render the same warning treatment - there's no
    // dedicated destructive-action token in theme.ts and adding one
    // for a two-screen surface would be premature abstraction.
    overwriteContainer: {
        marginTop: SPACING.l,
        borderWidth: 1,
        borderColor: '#E63946',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        backgroundColor: 'rgba(230, 57, 70, 0.08)',
    },
    // WS7 follow-up: history-restore retry panel (non-destructive, so no red
    // treatment - this is an optional "restore your activity" step, not a
    // wallet-replacement gate). No alignItems:center so the buttons stretch
    // full-width like the main Restore button; the icon/title/subtitle center
    // themselves (alignSelf / textAlign).
    restoreRetryContainer: {
        marginTop: SPACING.xl,
    },
    restoreRetryTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.s,
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
    overwriteTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
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
    buttonDisabled: {
        opacity: 0.5,
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
});

export default ImportRecoveryPhraseScreen;
