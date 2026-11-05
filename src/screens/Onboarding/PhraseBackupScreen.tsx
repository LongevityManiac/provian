import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * PhraseBackupScreen — back up the wallet by writing down its recovery phrase.
 *
 * The fallback for everyone whose phone cannot reach iCloud Keychain or Google Drive: the person
 * sees the 12 words (after Face ID / passcode), writes them on paper, and proves it by entering
 * three of them. That clears the backup step on the create path and the restore path alike
 * (`core/recovery/phraseBackup.ts`). Same continuation as the cloud backup screen.
 *
 * Only the three asked-for words are kept once the check begins; the displayed phrase lives in
 * `useSensitiveDisplay` (screen capture blocked, auto-hidden, wiped on blur).
 */
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BORDER_RADIUS, COLORS, GRADIENTS, SPACING } from '../../constants/theme';
import { MnemonicExportService } from '../../core/wallet/export/MnemonicExportService';
import { useSensitiveDisplay } from '../../hooks/useSensitiveDisplay';
import { checkWords, markPhraseBackupConfirmed, pickCheckPositions } from '../../core/recovery/phraseBackup';
import { clearBackupRequired } from '../../core/recovery/cloud/backupRequirement';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import BackButton from '../../components/BackButton';
import type { AppParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<AppParamList, 'PhraseBackup'>;
type Stage = 'intro' | 'show' | 'check' | 'done';

export default function PhraseBackupScreen({ navigation, route }: Props): React.ReactElement {
    const { t } = useTranslation();
    const fromSettings = route.params?.fromSettings === true;
    const requiredBeforeApp = route.params?.requiredBeforeApp === true;
    const [stage, setStage] = useState<Stage>('intro');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [check, setCheck] = useState<{ positions: number[]; expected: string[] } | null>(null);
    const [answers, setAnswers] = useState<string[]>(['', '', '']);
    const { value: phrase, reveal, hide } = useSensitiveDisplay({ ttlSeconds: 300 });
    const words = phrase === null ? [] : phrase.trim().split(/\s+/);

    const showPhrase = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            const result = await MnemonicExportService.exportMnemonic();
            reveal(result.mnemonic);
            setStage('show');
        } catch {
            setError(t('phraseBackup.revealFailed'));
        } finally {
            setBusy(false);
        }
    };

    const startCheck = (): void => {
        const positions = pickCheckPositions(words.length);
        setCheck({ positions, expected: positions.map((p) => words[p]) });
        setAnswers(['', '', '']);
        hide();
        setError(null);
        setStage('check');
    };

    const confirm = async (): Promise<void> => {
        if (check === null) return;
        // The expected words are indexed by their own order (0..2), not by phrase position.
        if (!checkWords(check.expected, [0, 1, 2], answers)) {
            setError(t('phraseBackup.checkWrong'));
            return;
        }
        setBusy(true);
        try {
            const { default: SeedManager } = await import('../../core/wallet/SeedManager');
            const address = await SeedManager.getEVMAddress();
            if (!address) throw new Error('no_wallet');
            await markPhraseBackupConfirmed(address);
            await clearBackupRequired().catch(() => undefined);
            setCheck(null);
            setStage('done');
            setTimeout(() => {
                if (fromSettings) navigation.goBack();
                else if (requiredBeforeApp) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
                else navigation.navigate('Attestation');
            }, 800);
        } catch {
            setError(t('phraseBackup.saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
            {stage !== 'done' && (
                <View style={styles.navBar}>
                    <BackButton onPress={() => navigation.goBack()} />
                </View>
            )}
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                {stage === 'intro' && (
                    <>
                        <View style={styles.icon}><Ionicons name="document-text-outline" size={48} color={COLORS.primaryLight} /></View>
                        <Text style={styles.title}>{t('phraseBackup.title')}</Text>
                        <Text style={styles.body}>{t('phraseBackup.intro')}</Text>
                        <Text style={styles.body}>{t('phraseBackup.introWarning')}</Text>
                        {error !== null && <Text style={styles.error}>{errorDisplayCopy(error)}</Text>}
                        <Primary label={t('phraseBackup.show')} busy={busy} onPress={() => { void showPhrase(); }} />
                    </>
                )}

                {stage === 'show' && (
                    <>
                        <Text style={styles.title}>{t('phraseBackup.writeTitle')}</Text>
                        <Text style={styles.body}>{t('phraseBackup.writeBody')}</Text>
                        <View style={styles.grid}>
                            {words.map((w, i) => (
                                <View key={i} style={styles.cell}>
                                    <Text style={styles.cellNum}>{i + 1}</Text>
                                    <Text style={styles.cellWord}>{w}</Text>
                                </View>
                            ))}
                        </View>
                        {words.length === 0 && <Text style={styles.body}>{t('phraseBackup.hiddenAgain')}</Text>}
                        <Primary
                            label={words.length === 0 ? t('phraseBackup.show') : t('phraseBackup.wroteItDown')}
                            busy={busy}
                            onPress={() => { if (words.length === 0) void showPhrase(); else startCheck(); }}
                        />
                    </>
                )}

                {stage === 'check' && check !== null && (
                    <>
                        <Text style={styles.title}>{t('phraseBackup.checkTitle')}</Text>
                        <Text style={styles.body}>{t('phraseBackup.checkBody')}</Text>
                        {check.positions.map((p, i) => (
                            <View key={p} style={styles.answerRow}>
                                <Text style={styles.answerLabel}>{t('phraseBackup.wordNumber', { n: p + 1 })}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={answers[i]}
                                    onChangeText={(v) => setAnswers((cur) => cur.map((a, j) => (j === i ? v : a)))}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    autoComplete="off"
                                    spellCheck={false}
                                    textContentType="none"
                                    importantForAutofill="no"
                                />
                            </View>
                        ))}
                        {error !== null && <Text style={styles.error}>{errorDisplayCopy(error)}</Text>}
                        <Primary label={t('phraseBackup.confirm')} busy={busy} onPress={() => { void confirm(); }} />
                        <TouchableOpacity style={styles.secondary} onPress={() => { setError(null); void showPhrase(); }} accessibilityRole="button">
                            <Text style={styles.secondaryText}>{t('phraseBackup.showAgain')}</Text>
                        </TouchableOpacity>
                    </>
                )}

                {stage === 'done' && (
                    <>
                        <View style={styles.icon}><Ionicons name="checkmark-circle" size={48} color={COLORS.success} /></View>
                        <Text style={styles.title}>{t('phraseBackup.doneTitle')}</Text>
                        <Text style={styles.body}>{t('phraseBackup.doneBody')}</Text>
                    </>
                )}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
}

function Primary({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }): React.ReactElement {
    return (
        <TouchableOpacity style={[styles.primary, busy && styles.disabled]} onPress={onPress} disabled={busy} accessibilityRole="button">
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryInner}>
                {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryText}>{label}</Text>}
            </LinearGradient>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    navBar: { paddingHorizontal: SPACING.m, paddingTop: SPACING.s },
    content: { padding: SPACING.l, paddingBottom: SPACING.xxl },
    icon: { alignItems: 'center', marginVertical: SPACING.l },
    title: { fontSize: 24, fontWeight: '700', color: COLORS.text, textAlign: 'center', marginBottom: SPACING.m },
    body: { fontSize: 15, color: COLORS.textSecondary, lineHeight: 22, marginBottom: SPACING.m, textAlign: 'center' },
    error: { fontSize: 14, color: COLORS.errorLight, textAlign: 'center', marginBottom: SPACING.m },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginVertical: SPACING.m },
    cell: { width: '48%', flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.s, paddingHorizontal: SPACING.s, marginBottom: SPACING.s, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
    cellNum: { width: 24, fontSize: 13, color: COLORS.textTertiary },
    cellWord: { fontSize: 16, color: COLORS.text, fontWeight: '600' },
    answerRow: { marginBottom: SPACING.m },
    answerLabel: { fontSize: 14, color: COLORS.textSecondary, marginBottom: SPACING.xs },
    input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.s, fontSize: 16, color: COLORS.text, backgroundColor: COLORS.surface },
    primary: { marginTop: SPACING.m, borderRadius: BORDER_RADIUS.m, overflow: 'hidden' },
    primaryInner: { paddingVertical: SPACING.m, alignItems: 'center' },
    primaryText: { fontSize: 16, fontWeight: '700', color: COLORS.white },
    disabled: { opacity: 0.6 },
    secondary: { marginTop: SPACING.m, paddingVertical: SPACING.s, alignItems: 'center' },
    secondaryText: { fontSize: 14, color: COLORS.textSecondary },
});
