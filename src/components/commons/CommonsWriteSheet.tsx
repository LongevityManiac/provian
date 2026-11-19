import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { BORDER_RADIUS, COLORS, SPACING } from '../../constants/theme';
import { actionStyles, PrimaryAction } from '../ScreenActions';
import { useWalletStore } from '../../store/walletStore';
import useCommonsStore from '../../store/commonsStore';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
import { getJoinContext, getSpeechWindowStatus } from '../../core/commons/CommonsService';
import { speechWindowRequired } from '../../core/commons/speechGate';
import { currentSpeechWindowPrice, openApprovedSpeechWindow } from '../../core/commons/openSpeechWindow';
import { errorDisplayCopy } from '../../i18n/displayCopy';

type WriteResult<T> = { completed: true; value: T } | { completed: false };
interface Request {
    label: string;
    needsProfile: boolean;
    price: number | null;
    conditional: boolean;
    run: (name: string | null) => Promise<void>;
    cancel: () => void;
}

let present: ((request: Request) => boolean) | undefined;
let requestInFlight = false;

/** The displayed price only applies when the relay actually requires an opening. */
export async function confirmCommonsWrite<T>(
    label: string, write: (action: BiometricAction) => Promise<T>,
    options: { mayNeedSpeechWindow?: boolean; conditional?: boolean } = {},
): Promise<WriteResult<T>> {
    if (requestInFlight) return { completed: false };
    requestInFlight = true;
    try {
        const wallet = useWalletStore.getState().address;
        const profile = useCommonsStore.getState().profile;
        const context = profile ? null : await getJoinContext();
        if (context?.already_joined) await useCommonsStore.getState().refreshMembership();
        const needsProfile = !profile && context?.already_joined !== true;
        const mayNeedSpeechWindow = options.mayNeedSpeechWindow !== false;
        const active = mayNeedSpeechWindow
            ? await getSpeechWindowStatus().then(response => response.live).catch(() => false)
            : true;
        const price = active ? null : await currentSpeechWindowPrice();
        const run = (name: string | null) => withBiometricAction(label, async action => {
            if (useWalletStore.getState().address !== wallet || !wallet) throw new Error('wallet_changed');
            // A failed burn can be resumed after the profile was created by the same tap.
            if (needsProfile && name && !useCommonsStore.getState().profile) {
                await useCommonsStore.getState().joinCommons(name, undefined, action);
            }
            try {
                return await write(action);
            } catch (error) {
                const audience = speechWindowRequired(error);
                if (!audience || price === null || useWalletStore.getState().address !== wallet) throw error;
                await openApprovedSpeechWindow(wallet, audience, price, action);
                return write(action);
            }
        });
        if (!needsProfile && price === null) return { completed: true, value: await run(null) };
        return await new Promise<WriteResult<T>>(resolve => {
            if (!present?.({
                label, needsProfile, price, conditional: options.conditional === true,
                run: async name => {
                    const value = await run(name);
                    resolve({ completed: true, value });
                },
                cancel: () => resolve({ completed: false }),
            })) resolve({ completed: false });
        });
    } finally {
        requestInFlight = false;
    }
}

export function CommonsWriteHost() {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const profile = useCommonsStore(state => state.profile);
    const [request, setRequest] = useState<Request | null>(null);
    const [name, setName] = useState('');
    const [agreed, setAgreed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        present = next => {
            setName('');
            setAgreed(false);
            setError(null);
            setRequest(next);
            return true;
        };
        return () => { present = undefined; };
    }, []);

    const close = () => {
        if (busy) return;
        request?.cancel();
        setRequest(null);
    };
    const needsProfile = request?.needsProfile === true && profile === null;
    const price = request?.price ?? null;
    const run = async () => {
        if (!request || busy || (needsProfile && (!name.trim() || !agreed))) return;
        setBusy(true);
        setError(null);
        try {
            await request.run(name.trim() || null);
            setRequest(null);
        } catch (failure) {
            setError(failure instanceof Error && failure.message === 'commons_speech_price_changed'
                ? t('overhaul.priceChanged')
                : errorDisplayCopy(failure instanceof Error ? failure.message : t('common.tryAgain')));
        } finally { setBusy(false); }
    };

    return (
        <Modal transparent visible={request !== null} animationType="slide" onRequestClose={close}>
            <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <Pressable style={StyleSheet.absoluteFillObject} onPress={close} accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')} />
                <ScrollView style={[styles.sheet, { paddingBottom: insets.bottom }]} contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled" accessibilityViewIsModal>
                    <Text style={actionStyles.sectionTitle}>{t(needsProfile ? 'overhaul.joinAndAct' : 'overhaul.confirmCommonsAction')}</Text>
                    {needsProfile && <>
                        <TextInput value={name} onChangeText={setName} maxLength={50} style={styles.input}
                            placeholder={t('commons.displayNameLabel')} placeholderTextColor={COLORS.textSecondary}
                            accessibilityLabel={t('commons.displayNameLabel')} />
                        <Text style={actionStyles.body}>{t('commonsTerms.body')}</Text>
                        <Pressable onPress={() => { void Linking.openURL('https://provian.ai/terms'); }} accessibilityRole="link">
                            <Text style={styles.link}>{t('commonsTerms.readFull')}</Text>
                        </Pressable>
                        <Pressable onPress={() => setAgreed(value => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }}>
                            <Text style={styles.link}>{agreed ? '✓' : '□'} {t('commonsTerms.agree')}</Text>
                        </Pressable>
                    </>}
                    {price !== null && <Text style={actionStyles.body}>
                        {t(request?.conditional ? 'overhaul.commonsPriceIfNeeded' : 'overhaul.commonsPrice', { pvt: price })}
                    </Text>}
                    {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
                    {busy && <ActivityIndicator color={COLORS.primary} />}
                    {!!request && <PrimaryAction label={price === null ? request.label : `${request.label} · ${price} PVT`}
                        onPress={() => { void run(); }} disabled={busy || (needsProfile && (!name.trim() || !agreed))} />}
                </ScrollView>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.62)' },
    sheet: { flexGrow: 0, maxHeight: '80%', backgroundColor: COLORS.surface, borderTopLeftRadius: BORDER_RADIUS.xl, borderTopRightRadius: BORDER_RADIUS.xl },
    content: { padding: SPACING.l, gap: SPACING.m },
    input: { color: COLORS.text, backgroundColor: COLORS.background, fontSize: 16, padding: SPACING.m, borderRadius: BORDER_RADIUS.m },
    link: { color: COLORS.primaryLight, fontSize: 15, paddingVertical: SPACING.xs },
    error: { color: COLORS.error, fontSize: 14 },
});
