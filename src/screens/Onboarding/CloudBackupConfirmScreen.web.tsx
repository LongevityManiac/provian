/**
 * CloudBackupConfirmScreen, web app: back up the wallet before it is used, as on the phone.
 * Three choices, none skippable:
 *   1. Passkey backup — the seed encrypted under the passkey's secret and the PIN, stored by
 *      Provian, which can never open it. Restore on another computer with the passkey and PIN.
 *      Offered first on a Mac (iCloud Keychain syncs the passkey to the person's other devices).
 *   2. Google Drive — the same app folder and format the Android app uses, encrypted with the PIN.
 *   3. The recovery phrase, written down (PhraseBackupScreen).
 * Same continuation as the phone screen: back to Settings, into the app after a restore, or on to
 * Attestation during onboarding.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import KeyboardSafeScrollView from '../../components/KeyboardSafeScrollView';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { withBiometricAction } from '../../core/security/biometricAction';
import SeedManager from '../../core/wallet/SeedManager';
import RelayAPIService from '../../services/RelayAPIService';
import { createCloudBackup, CloudBackupBelongsToOtherWalletError } from '../../core/recovery/cloud/CloudBackupV2';
import { clearBackupRequired } from '../../core/recovery/cloud/backupRequirement';
import { signInForRecovery } from '../../core/recovery/cloud/ProvianCloudKeychainSync';
import { canMakePasskeyBackup, makePasskeyBackup } from '../../platform/web/passkeyBackup';
import { openVaultSecrets } from '../../platform/web/webVault';
import { preloadGoogleIdentity } from '../../platform/web/googleDriveWeb';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, pinIsAcceptable } from '../../platform/web/keyDerivation';
import { webConfirm } from '../../platform/web/webAlert';

export const PASSKEY_BACKUP_MARK = '@provian_web_passkey_backup_v1';

type Method = 'passkey' | 'drive' | 'phrase';

export function isMacBrowser(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
    return /mac/i.test(uaPlatform ?? navigator.platform ?? '') || /Macintosh/.test(navigator.userAgent);
}

const CloudBackupConfirmScreen = ({ navigation, route }: { navigation: any; route?: { params?: { fromSettings?: boolean; requiredBeforeApp?: boolean } } }) => {
    const { t } = useTranslation();
    const fromSettings = route?.params?.fromSettings === true;
    const requiredBeforeApp = route?.params?.requiredBeforeApp === true;
    const [busy, setBusy] = useState<Method | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pin, setPin] = useState('');
    const passkeyOk = canMakePasskeyBackup();
    const needsPin = openVaultSecrets() === null;

    useEffect(() => { preloadGoogleIdentity().catch(() => undefined); }, []);

    const order: Method[] = passkeyOk
        ? (isMacBrowser() ? ['passkey', 'drive', 'phrase'] : ['drive', 'passkey', 'phrase'])
        : ['drive', 'phrase'];

    const finish = async () => {
        await AsyncStorage.setItem('@provian_backup_skipped', 'false');
        await clearBackupRequired().catch(() => undefined);
        setDone(true);
        setTimeout(() => {
            if (fromSettings) navigation.goBack();
            else if (requiredBeforeApp) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
            else navigation.navigate('Attestation');
        }, 800);
    };

    const currentPin = (): string | null => {
        const secrets = openVaultSecrets();
        if (secrets) return secrets.pin;
        if (!pinIsAcceptable(pin)) { setError(t('webApp.vault.pinRule', { min: MIN_PIN_LENGTH, max: MAX_PIN_LENGTH })); return null; }
        return pin;
    };

    const backUpWithPasskey = async () => {
        if (busy) return;
        setBusy('passkey');
        setError(null);
        try {
            await withBiometricAction(t('webApp.backup.passkeyPrompt'), async (action) => {
                const mnemonic = await SeedManager.getMnemonic(action);
                if (!mnemonic) throw new Error('seed_unavailable');
                const address = await SeedManager.getEVMAddress(action);
                await makePasskeyBackup({ storePasskeyBackup: (body) => RelayAPIService.storePasskeyBackup(body, action) }, mnemonic, address);
                await AsyncStorage.setItem(PASSKEY_BACKUP_MARK, address.toLowerCase());
            });
            await finish();
        } catch (err) {
            setBusy(null);
            setError(t('webApp.backup.failed', { message: err instanceof Error ? err.message : String(err) }));
        }
    };

    const backUpToDrive = async (choice?: 'keep' | 'replace') => {
        if (busy && !choice) return;
        const backupPin = currentPin();
        if (!backupPin) return;
        setBusy('drive');
        setError(null);
        try {
            // The Google popup opens only from the click, so sign in before anything else.
            if (!(await signInForRecovery())) throw new Error(t('webApp.backup.googleNotSignedIn'));
            await createCloudBackup(backupPin, undefined, { keepExisting: choice === 'keep', replaceExisting: choice === 'replace' });
            await AsyncStorage.setItem('@provian_cloud_backup_enabled', 'true');
            await finish();
        } catch (err) {
            setBusy(null);
            if (err instanceof CloudBackupBelongsToOtherWalletError) {
                const keep = await webConfirm({
                    title: t('cloudBackupConfirm.otherWalletTitle'),
                    message: t('webApp.backup.otherWalletMessage'),
                    confirm: t('cloudBackupConfirm.keepBothBackups'),
                    cancel: t('cloudBackupConfirm.replaceBackup'),
                });
                void backUpToDrive(keep ? 'keep' : 'replace');
                return;
            }
            setError(t('webApp.backup.failed', { message: err instanceof Error ? err.message : String(err) }));
        }
    };

    const writePhrase = () => navigation.navigate('PhraseBackup', { fromSettings, requiredBeforeApp });

    const card = (method: Method, index: number) => {
        const recommended = index === 0;
        const icon = method === 'passkey' ? 'finger-print' : method === 'drive' ? 'logo-google' : 'key';
        const onPress = method === 'passkey' ? backUpWithPasskey : method === 'drive' ? () => backUpToDrive() : writePhrase;
        return (
            <ActionTouchable key={method} style={styles.card} onPress={() => { void onPress(); }} disabled={busy !== null}>
                <View style={styles.cardRow}>
                    <View style={styles.cardIcon}><Ionicons name={icon} size={22} color={COLORS.primary} /></View>
                    <View style={styles.cardText}>
                        <Text style={styles.cardTitle}>{t(`webApp.backup.${method}Title`)}</Text>
                        <Text style={styles.cardDesc}>{t(`webApp.backup.${method}Desc`)}</Text>
                    </View>
                    {busy === method ? <ActivityIndicator color={COLORS.primary} /> : <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />}
                </View>
                {recommended && <Text style={styles.badge}>{t(isMacBrowser() && method === 'passkey' ? 'webApp.backup.recommendedMac' : 'webApp.backup.recommended')}</Text>}
            </ActionTouchable>
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            {(fromSettings) && <View style={styles.header}><BackButton onPress={() => navigation.goBack()} /></View>}
            <KeyboardSafeScrollView contentContainerStyle={styles.content}>
                <View style={styles.icon}><Ionicons name={done ? 'checkmark-circle' : 'shield-checkmark'} size={44} color={done ? COLORS.success : COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{done ? t('webApp.backup.doneTitle') : t('webApp.backup.title')}</Text>
                {!done && <Text style={styles.body}>{t('webApp.backup.body')}</Text>}
                {!done && needsPin && (
                    <TextInput style={styles.input} value={pin} onChangeText={setPin} secureTextEntry maxLength={MAX_PIN_LENGTH}
                        placeholder={t('webApp.unlock.pinPlaceholder')} placeholderTextColor={COLORS.textMuted} accessibilityLabel={t('webApp.unlock.pinLabel')} />
                )}
                {!done && order.map(card)}
                {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                {!done && <Text style={styles.note}>{t('webApp.backup.note')}</Text>}
            </KeyboardSafeScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { paddingHorizontal: SPACING.l, paddingTop: SPACING.s },
    content: { flexGrow: 1, paddingHorizontal: SPACING.l, paddingVertical: SPACING.xl, maxWidth: 560, width: '100%', alignSelf: 'center' },
    icon: { width: 84, height: 84, borderRadius: 42, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: SPACING.l },
    title: { color: COLORS.chrome, fontSize: 26, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.l },
    input: { backgroundColor: COLORS.surfaceHighlight, color: COLORS.chrome, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: SPACING.m, fontSize: 17, marginBottom: SPACING.m },
    card: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.m, marginBottom: SPACING.m, borderWidth: 1, borderColor: COLORS.surfaceHighlight },
    cardRow: { flexDirection: 'row', alignItems: 'center' },
    cardIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginRight: SPACING.m },
    cardText: { flex: 1, marginRight: SPACING.s },
    cardTitle: { color: COLORS.chrome, fontSize: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 4 },
    cardDesc: { color: COLORS.chromeMuted, fontSize: 13, lineHeight: 19 },
    badge: { alignSelf: 'flex-start', marginTop: SPACING.s, color: COLORS.primary, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
    error: { color: COLORS.error, fontSize: 14, marginTop: SPACING.s, marginBottom: SPACING.m },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: SPACING.s, textAlign: 'center' },
});

export default CloudBackupConfirmScreen;
