/**
 * AddYourPhoneScreen (web app): put the same wallet on a phone.
 *
 * It leads with the QR code: in the latest Provian app, "I already have a Provian wallet" → "From
 * your computer" scans it, this browser shows the phone and the match code, the person confirms
 * with the passkey and PIN, and the wallet moves over sealed (HandoffQrPanel). Below it, for a phone
 * on an older version: install Provian, choose the recovery phrase, and type the words this page
 * shows (after the passkey AND the PIN). On Android a Google Drive backup restores too. The phone
 * signs in beside this browser; neither signs the other out.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { MnemonicExportService } from '../../core/wallet/export/MnemonicExportService';
import { useSensitiveDisplay } from '../../hooks/useSensitiveDisplay';
import { useWalletStore } from '../../store/walletStore';
import HandoffQrPanel from '../../components/HandoffQrPanel';

export const DOWNLOAD_URL = 'https://provian.ai/download';
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.provian.wallet';

export default function AddYourPhoneScreen({ navigation }: { navigation: { goBack(): void; canGoBack(): boolean; navigate(name: string): void } }): React.ReactElement {
    const { t } = useTranslation();
    const onboarded = useWalletStore(s => s.onboardingComplete);
    const walletAddress = useWalletStore(s => s.address);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { value: phrase, reveal, hide } = useSensitiveDisplay({ ttlSeconds: 300 });
    const words = phrase === null ? [] : phrase.trim().split(/\s+/);

    const show = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await MnemonicExportService.exportMnemonic();
            reveal(result.mnemonic);
        } catch {
            setError(t('webApp.addPhone.revealFailed'));
        } finally {
            setBusy(false);
        }
    };

    const step = (n: number, title: string, body: string) => (
        <View style={styles.step} key={n}>
            <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{n}</Text></View>
            <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{title}</Text>
                <Text style={styles.stepBody}>{body}</Text>
            </View>
        </View>
    );

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('MainTabs'))} />
            </View>
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                <View style={styles.icon}><Ionicons name="phone-portrait-outline" size={40} color={COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{t('webApp.addPhone.title')}</Text>
                <Text style={styles.body}>{t('webApp.addPhone.body')}</Text>

                {onboarded && <HandoffQrPanel mode="send" walletAddress={walletAddress} />}

                <Text style={styles.sectionTitle}>{t('handoff.olderApp')}</Text>
                {step(1, t('webApp.addPhone.step1Title'), t('webApp.addPhone.step1Body'))}
                <View style={styles.links}>
                    <ActionTouchable style={styles.linkButton} onPress={() => { void Linking.openURL(DOWNLOAD_URL); }}>
                        <Ionicons name="logo-apple" size={18} color={COLORS.chrome} />
                        <Text style={styles.linkText}>{t('webApp.addPhone.iphone')}</Text>
                    </ActionTouchable>
                    <ActionTouchable style={styles.linkButton} onPress={() => { void Linking.openURL(PLAY_URL); }}>
                        <Ionicons name="logo-google-playstore" size={18} color={COLORS.chrome} />
                        <Text style={styles.linkText}>{t('webApp.addPhone.android')}</Text>
                    </ActionTouchable>
                </View>
                {step(2, t('webApp.addPhone.step2Title'), t('webApp.addPhone.step2Body'))}
                {step(3, t('webApp.addPhone.step3Title'), t('webApp.addPhone.step3Body'))}

                {!onboarded ? (
                    <Text style={styles.note}>{t('webApp.addPhone.noWallet')}</Text>
                ) : words.length === 0 ? (
                    <ActionTouchable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => { void show(); }}>
                        {busy ? <ActivityIndicator color={COLORS.onPrimary} /> : <Text style={styles.primaryText}>{t('webApp.addPhone.show')}</Text>}
                    </ActionTouchable>
                ) : (
                    <View style={styles.phraseBox}>
                        <Text style={styles.phraseWarning}>{t('webApp.addPhone.warning')}</Text>
                        <View style={styles.grid}>
                            {words.map((word, index) => (
                                <View key={index} style={styles.word}>
                                    <Text style={styles.wordIndex}>{index + 1}</Text>
                                    <Text style={styles.wordText} selectable={false}>{word}</Text>
                                </View>
                            ))}
                        </View>
                        <ActionTouchable style={styles.secondary} onPress={() => { void hide(); }}>
                            <Text style={styles.secondaryText}>{t('webApp.addPhone.hide')}</Text>
                        </ActionTouchable>
                    </View>
                )}
                {!!error && <Text style={styles.error}>{error}</Text>}
                <Text style={styles.note}>{t('webApp.addPhone.driveNote')}</Text>
                <Text style={styles.note}>{t('webApp.addPhone.together')}</Text>
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { paddingHorizontal: SPACING.l, paddingTop: SPACING.s },
    content: { flexGrow: 1, paddingHorizontal: SPACING.l, paddingVertical: SPACING.l, maxWidth: 620, width: '100%', alignSelf: 'center' },
    icon: { width: 80, height: 80, borderRadius: 40, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 26, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.xl },
    sectionTitle: { color: COLORS.chrome, fontSize: 17, fontFamily: 'Inter_600SemiBold', marginBottom: SPACING.m, marginTop: SPACING.s },
    step: { flexDirection: 'row', marginBottom: SPACING.m },
    stepNumber: { width: 30, height: 30, borderRadius: 15, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginRight: SPACING.m },
    stepNumberText: { color: COLORS.primary, fontFamily: 'Inter_700Bold' },
    stepText: { flex: 1 },
    stepTitle: { color: COLORS.chrome, fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 2 },
    stepBody: { color: COLORS.chromeMuted, fontSize: 14, lineHeight: 20 },
    links: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s, marginLeft: 46, marginBottom: SPACING.l },
    linkButton: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, backgroundColor: COLORS.surfaceHighlight, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s, paddingHorizontal: SPACING.m },
    linkText: { color: COLORS.chrome, fontSize: 14, fontFamily: 'Inter_600SemiBold' },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, alignItems: 'center', marginTop: SPACING.s },
    disabled: { opacity: 0.6 },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    phraseBox: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.m, marginTop: SPACING.s },
    phraseWarning: { color: COLORS.secondary, fontSize: 13, lineHeight: 19, marginBottom: SPACING.m },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s },
    word: { flexDirection: 'row', alignItems: 'center', width: '30%', minWidth: 120, backgroundColor: COLORS.surfaceHighlight, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s, paddingHorizontal: SPACING.s },
    wordIndex: { color: COLORS.textMuted, fontSize: 12, width: 22 },
    wordText: { color: COLORS.chrome, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    secondary: { paddingVertical: SPACING.m, alignItems: 'center' },
    secondaryText: { color: COLORS.primary, fontSize: 15 },
    error: { color: COLORS.error, fontSize: 14, marginTop: SPACING.m },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: SPACING.m, textAlign: 'center' },
});
