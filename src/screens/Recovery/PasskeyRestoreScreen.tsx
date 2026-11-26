/**
 * PasskeyRestoreScreen (web app): "I already have a wallet" with the passkey backup.
 *
 * The person enters their PIN and uses their passkey (synced through iCloud Keychain, Google
 * Password Manager or another passkey manager). One passkey prompt signs the relay's challenge and
 * yields the passkey's secret; the relay hands back the encrypted backup; the PIN opens it in this
 * browser. The same passkey and PIN then protect the wallet here, and the restore continues
 * exactly like a recovery-phrase restore (same relay sign-in, history and backup checks).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import { assertForRestore, fetchAndOpenPasskeyBackup, PasskeyBackupUnsupportedError, PasskeyBackupWrongPinError } from '../../platform/web/passkeyBackup';
import { PasskeyCancelledError, webAuthnAvailable } from '../../platform/web/passkey';
import { createVaultFromPasskey, hasVault } from '../../platform/web/webVault';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, pinIsAcceptable } from '../../platform/web/keyDerivation';

const CHALLENGE_REFRESH_MS = 4 * 60 * 1000;

export default function PasskeyRestoreScreen({ navigation }: { navigation: any }): React.ReactElement {
    const { t } = useTranslation();
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const challenge = useRef<{ value: string; at: number } | null>(null);

    const refreshChallenge = useCallback(async () => {
        try {
            challenge.current = { value: await RelayAPIService.passkeyBackupChallenge(), at: Date.now() };
        } catch {
            challenge.current = null;
        }
    }, []);

    useEffect(() => {
        void refreshChallenge();
        const timer = setInterval(() => { void refreshChallenge(); }, CHALLENGE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [refreshChallenge]);

    const restore = async () => {
        if (busy) return;
        if (!pinIsAcceptable(pin)) { setError(t('webApp.vault.pinRule', { min: MIN_PIN_LENGTH, max: MAX_PIN_LENGTH })); return; }
        const current = challenge.current;
        if (!current) { setError(t('webApp.restore.offline')); void refreshChallenge(); return; }
        setBusy(true);
        setError(null);
        try {
            // The passkey sheet first, inside the click (Safari requires it).
            const assertion = await assertForRestore(current.value);
            challenge.current = null;
            const opened = await fetchAndOpenPasskeyBackup(RelayAPIService, assertion, pin);
            if (!hasVault()) await createVaultFromPasskey(pin, assertion, opened.publicKey);
            setPin('');
            navigation.replace('ImportRecoveryPhrase', { restoredMnemonic: opened.mnemonic });
        } catch (err) {
            setBusy(false);
            void refreshChallenge();
            const code = err instanceof Error ? err.message : String(err);
            if (err instanceof PasskeyCancelledError) setError(t('webApp.unlock.cancelled'));
            else if (err instanceof PasskeyBackupWrongPinError) setError(t('webApp.restore.wrongPin'));
            else if (err instanceof PasskeyBackupUnsupportedError) setError(t('webApp.restore.noPrf'));
            else if (code === 'no_passkey_backup') setError(t('webApp.restore.noBackup'));
            else setError(t('webApp.restore.failed', { message: code }));
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}><BackButton onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('RecoveryStart'))} /></View>
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                <View style={styles.icon}><Ionicons name="finger-print" size={44} color={COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{t('webApp.restore.title')}</Text>
                <Text style={styles.body}>{t('webApp.restore.body')}</Text>
                {!webAuthnAvailable() ? (
                    <Text style={styles.error}>{t('webApp.vault.noPasskeys')}</Text>
                ) : (
                    <>
                        <TextInput style={styles.input} value={pin} onChangeText={setPin} secureTextEntry autoFocus maxLength={MAX_PIN_LENGTH}
                            placeholder={t('webApp.unlock.pinPlaceholder')} placeholderTextColor={COLORS.textMuted}
                            accessibilityLabel={t('webApp.unlock.pinLabel')} autoComplete="current-password"
                            onSubmitEditing={() => { void restore(); }} />
                        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                        <ActionTouchable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => { void restore(); }}>
                            {busy ? <ActivityIndicator color={COLORS.onPrimary} /> : <Text style={styles.primaryText}>{t('webApp.restore.button')}</Text>}
                        </ActionTouchable>
                        <Text style={styles.note}>{t('webApp.restore.note')}</Text>
                    </>
                )}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { paddingHorizontal: SPACING.l, paddingTop: SPACING.s },
    content: { flexGrow: 1, paddingHorizontal: SPACING.l, paddingVertical: SPACING.xl, maxWidth: 520, width: '100%', alignSelf: 'center' },
    icon: { width: 84, height: 84, borderRadius: 42, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 26, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.l },
    input: { backgroundColor: COLORS.surfaceHighlight, color: COLORS.chrome, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.m, fontSize: 17, marginBottom: SPACING.m },
    error: { color: COLORS.error, fontSize: 14, marginBottom: SPACING.m },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center' },
    disabled: { opacity: 0.6 },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: SPACING.m, textAlign: 'center' },
});
