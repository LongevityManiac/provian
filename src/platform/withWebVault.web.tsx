/**
 * Web only: a screen that will create or restore a wallet first makes this browser's vault — the
 * person chooses a PIN and creates a passkey (Touch ID / Face ID / Windows Hello). Then the
 * wrapped screen runs exactly as on the phone, with the passkey prompt where the phone shows
 * Face ID. A browser that already has a vault goes straight to the screen.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../components/ScreenActions';
import BackButton from '../components/BackButton';
import KeyboardSafeScrollView from '../components/KeyboardSafeScrollView';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import { createVault, hasVault, PasskeyNoPrfError } from './web/webVault';
import { PasskeyCancelledError, PasskeyUnavailableError, webAuthnAvailable } from './web/passkey';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, pinIsAcceptable } from './web/keyDerivation';

type ScreenProps = { navigation: { goBack(): void; canGoBack(): boolean; navigate(name: string): void } } & Record<string, unknown>;

export function WebVaultSetup({ onDone, onBack }: { onDone: () => void; onBack?: () => void }): React.ReactElement {
    const { t } = useTranslation();
    const [pin, setPin] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const supported = webAuthnAvailable();

    const create = async () => {
        if (busy) return;
        if (!pinIsAcceptable(pin)) { setError(t('webApp.vault.pinRule', { min: MIN_PIN_LENGTH, max: MAX_PIN_LENGTH })); return; }
        if (pin !== confirm) { setError(t('webApp.vault.pinMismatch')); return; }
        setBusy(true);
        setError(null);
        try {
            await createVault(pin, t('webApp.vault.passkeyName'));
            setPin('');
            setConfirm('');
            onDone();
        } catch (err) {
            setBusy(false);
            if (err instanceof PasskeyCancelledError) setError(t('webApp.vault.passkeyCancelled'));
            else if (err instanceof PasskeyUnavailableError) setError(t('webApp.vault.noPasskeys'));
            else if (err instanceof PasskeyNoPrfError) setError(t('webApp.vault.noPrf'));
            else setError(t('webApp.vault.failed', { message: err instanceof Error ? err.message : String(err) }));
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            {onBack && <View style={styles.header}><BackButton onPress={onBack} /></View>}
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                <View style={styles.icon}><Ionicons name="finger-print" size={44} color={COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{t('webApp.vault.title')}</Text>
                <Text style={styles.body}>{t('webApp.vault.body')}</Text>
                {!supported ? (
                    <Text style={styles.error}>{t('webApp.vault.noPasskeys')}</Text>
                ) : (
                    <>
                        <Text style={styles.label}>{t('webApp.vault.pinLabel')}</Text>
                        <TextInput style={styles.input} value={pin} onChangeText={setPin} secureTextEntry maxLength={MAX_PIN_LENGTH}
                            placeholder={t('webApp.vault.pinPlaceholder', { min: MIN_PIN_LENGTH })} placeholderTextColor={COLORS.textMuted}
                            autoComplete="new-password" accessibilityLabel={t('webApp.vault.pinLabel')} />
                        <TextInput style={styles.input} value={confirm} onChangeText={setConfirm} secureTextEntry maxLength={MAX_PIN_LENGTH}
                            placeholder={t('webApp.vault.confirmPlaceholder')} placeholderTextColor={COLORS.textMuted}
                            autoComplete="new-password" accessibilityLabel={t('webApp.vault.confirmPlaceholder')}
                            onSubmitEditing={() => { void create(); }} />
                        <Text style={styles.note}>{t('webApp.vault.pinNote')}</Text>
                        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                        <ActionTouchable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => { void create(); }}>
                            {busy ? <ActivityIndicator color={COLORS.onPrimary} /> : <Text style={styles.primaryText}>{t('webApp.vault.create')}</Text>}
                        </ActionTouchable>
                    </>
                )}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
}

export default function withWebVault<C>(Screen: C): C {
    const Inner = Screen as unknown as React.ComponentType<ScreenProps>;
    function WebVaultGate(props: ScreenProps): React.ReactElement {
        const [ready, setReady] = useState(hasVault());
        if (ready) return <Inner {...props} />;
        const back = () => (props.navigation.canGoBack() ? props.navigation.goBack() : props.navigation.navigate('Onboarding'));
        return <WebVaultSetup onDone={() => setReady(true)} onBack={back} />;
    }
    WebVaultGate.displayName = `withWebVault(${Inner.displayName ?? Inner.name ?? 'Screen'})`;
    return WebVaultGate as unknown as C;
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { paddingHorizontal: SPACING.l, paddingTop: SPACING.s },
    content: { flexGrow: 1, paddingHorizontal: SPACING.l, paddingVertical: SPACING.xl, maxWidth: 520, width: '100%', alignSelf: 'center' },
    icon: { width: 84, height: 84, borderRadius: 42, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 26, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.l },
    label: { color: COLORS.chromeMuted, fontSize: 13, marginBottom: SPACING.xs },
    input: { backgroundColor: COLORS.surfaceHighlight, color: COLORS.chrome, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.m, fontSize: 17, marginBottom: SPACING.s },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginBottom: SPACING.m },
    error: { color: COLORS.error, fontSize: 14, marginBottom: SPACING.m },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center' },
    disabled: { opacity: 0.6 },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});
