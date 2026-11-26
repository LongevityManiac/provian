/**
 * The web app's "Face ID" sheet: shown whenever code needs the wallet's seed (opening the wallet,
 * signing, sending, showing the recovery phrase). It asks for the passkey, and for the PIN when
 * the wallet is closed or the action needs both. Rendered once, at the app root, on the web only.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { subscribeUnlockRequests, settleUnlockRequest, UnlockCancelledError, type UnlockRequest } from './unlockRequests';
import { confirmPresence, readVault, unlockVault, WrongPinError, VaultLockedOutError } from './webVault';
import { getPasskey, PasskeyCancelledError } from './passkey';
import { fromB64Url } from './webKv';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH } from './keyDerivation';

export default function WebUnlockHost(): React.ReactElement | null {
    const { t } = useTranslation();
    const [request, setRequest] = useState<UnlockRequest | null>(null);
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => subscribeUnlockRequests(next => {
        setRequest(next);
        setPin('');
        setError(null);
        setBusy(false);
    }), []);

    if (!request) return null;
    const needsPin = request.mode !== 'presence';
    const title = request.mode === 'presence'
        ? t('webApp.unlock.presenceTitle')
        : request.mode === 'reveal' ? t('webApp.unlock.revealTitle')
        : request.mode === 'move' ? t('webApp.unlock.moveTitle') : t('webApp.unlock.title');

    const submit = async () => {
        if (busy) return;
        if (needsPin && pin.length < MIN_PIN_LENGTH) {
            setError(t('webApp.unlock.pinTooShort', { min: MIN_PIN_LENGTH }));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            if (needsPin) {
                const record = readVault();
                if (!record) throw new Error(t('webApp.unlock.noWallet'));
                // The passkey sheet first: Safari shows it only inside the click.
                const assertion = await getPasskey({ allow: [fromB64Url(record.credentialId)] });
                await unlockVault(pin, assertion);
            } else {
                await confirmPresence();
            }
            settleUnlockRequest(request.id);
        } catch (err) {
            setBusy(false);
            if (err instanceof PasskeyCancelledError) setError(t('webApp.unlock.cancelled'));
            else if (err instanceof WrongPinError) setError(err.remainingBeforeWait > 0
                ? t('webApp.unlock.wrongPin', { count: err.remainingBeforeWait })
                : t('webApp.unlock.wrongPinNoCount'));
            else if (err instanceof VaultLockedOutError) setError(t('webApp.unlock.wait', { time: new Date(err.until).toLocaleTimeString() }));
            else setError(t('webApp.unlock.failed', { message: err instanceof Error ? err.message : String(err) }));
        }
    };

    const cancel = () => settleUnlockRequest(request.id, new UnlockCancelledError());

    return (
        <Modal visible transparent animationType="fade" onRequestClose={cancel}>
            <View style={styles.backdrop}>
                <View style={styles.card} accessibilityRole="none">
                    <Text style={styles.title} accessibilityRole="header">{title}</Text>
                    {!!request.reason && <Text style={styles.reason}>{request.reason}</Text>}
                    <Text style={styles.hint}>{t('webApp.unlock.hint')}</Text>
                    {needsPin && (
                        <TextInput
                            style={styles.input}
                            value={pin}
                            onChangeText={setPin}
                            secureTextEntry
                            autoFocus
                            maxLength={MAX_PIN_LENGTH}
                            placeholder={t('webApp.unlock.pinPlaceholder')}
                            placeholderTextColor={COLORS.textMuted}
                            accessibilityLabel={t('webApp.unlock.pinLabel')}
                            onSubmitEditing={() => { void submit(); }}
                            autoComplete="current-password"
                        />
                    )}
                    {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                    <ActionTouchable style={[styles.primary, busy && styles.disabled]} onPress={() => { void submit(); }} disabled={busy} accessibilityRole="button">
                        {busy ? <ActivityIndicator color={COLORS.onPrimary} /> : <Text style={styles.primaryText}>{t('webApp.unlock.continue')}</Text>}
                    </ActionTouchable>
                    <ActionTouchable style={styles.secondary} onPress={cancel} disabled={busy} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('webApp.unlock.cancel')}</Text>
                    </ActionTouchable>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(5, 8, 14, 0.82)', alignItems: 'center', justifyContent: 'center', padding: SPACING.m },
    card: { width: '100%', maxWidth: 420, backgroundColor: COLORS.surfaceElevated, borderRadius: BORDER_RADIUS.l, padding: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 20, fontFamily: 'Inter_600SemiBold', marginBottom: SPACING.s },
    reason: { color: COLORS.chromeMuted, fontSize: 15, marginBottom: SPACING.s },
    hint: { color: COLORS.chromeMuted, fontSize: 13, opacity: 0.8, marginBottom: SPACING.m },
    input: { backgroundColor: COLORS.surfaceHighlight, color: COLORS.chrome, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.s, fontSize: 18, letterSpacing: 2, marginBottom: SPACING.m },
    error: { color: COLORS.error, fontSize: 14, marginBottom: SPACING.m },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center' },
    disabled: { opacity: 0.6 },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    secondary: { paddingVertical: SPACING.m, alignItems: 'center' },
    secondaryText: { color: COLORS.chromeMuted, fontSize: 15 },
});
