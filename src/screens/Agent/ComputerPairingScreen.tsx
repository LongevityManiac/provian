import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import BackButton from '../../components/BackButton';
import ProvianIcon from '../../components/ProvianIcon';
import { actionStyles, DestinationRow, PrimaryAction } from '../../components/ScreenActions';
import { useWalletStore } from '../../store/walletStore';
import RelayAPIService, { type ComputerPairingStatus } from '../../services/RelayAPIService';

const QR_PREFIX = 'provian-computer:';
const waitingKey = (wallet: string) => `provian.pairing.${wallet.toLowerCase()}`;
const normalizeCode = (raw: string) => raw.replace(/[\s-]/g, '').toLowerCase();
const validCode = (code: string) => /^[0-9a-f]{12}$/.test(code);

export async function getWaitingPairing(wallet: string): Promise<string | null> {
    if (!wallet) return null;
    const code = await SecureStore.getItemAsync(waitingKey(wallet));
    return code && validCode(code) ? code : null;
}

export default function ComputerPairingScreen() {
    const { t } = useTranslation();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const wallet = useWalletStore(state => state.address);
    const [permission, requestPermission] = useCameraPermissions();
    const [scanning, setScanning] = useState(false);
    const [input, setInput] = useState('');
    const [waitingCode, setWaitingCode] = useState<string | null>(null);
    const [status, setStatus] = useState<ComputerPairingStatus | null>(null);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const hapticPlayed = useRef(false);
    const code = normalizeCode(input);

    useFocusEffect(useCallback(() => {
        let live = true;
        void getWaitingPairing(wallet).catch(() => null).then(saved => {
            if (live) {
                if (saved) setWaitingCode(saved);
                setLoaded(true);
            }
        });
        return () => { live = false; };
    }, [wallet]));

    useFocusEffect(useCallback(() => {
        if (!waitingCode) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout>;
        async function check(currentCode: string) {
            try {
                const result = await RelayAPIService.computerPairingStatus(currentCode);
                if (!live) return;
                if (result === null) {
                    await SecureStore.deleteItemAsync(waitingKey(wallet)).catch(() => {});
                    if (!live) return;
                    setWaitingCode(null);
                    setError(true);
                    return;
                }
                setStatus(result);
                setError(false);
                if (result.state === 'connected') {
                    if (!hapticPlayed.current) {
                        hapticPlayed.current = true;
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                    }
                    void SecureStore.deleteItemAsync(waitingKey(wallet)).catch(() => {});
                    if (result.firstProof) return;
                }
            } catch {
                if (live) setError(true);
            }
            if (live) timer = setTimeout(() => { void check(currentCode); }, 5000);
        }
        void check(waitingCode);
        return () => { live = false; clearTimeout(timer); };
    }, [waitingCode, wallet]));

    const confirm = async () => {
        if (!validCode(code) || busy || !wallet) return;
        setBusy(true);
        setError(false);
        try {
            await RelayAPIService.confirmComputerPairing(code);
            if (useWalletStore.getState().address !== wallet) return;
            setWaitingCode(code);
            void SecureStore.setItemAsync(waitingKey(wallet), code, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            }).catch(() => {});
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    const scan = async () => {
        const access = permission?.granted ? permission : await requestPermission();
        if (access.granted) setScanning(true);
        else setError(true);
    };

    return (
        <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <View style={styles.header}><BackButton onPress={navigation.goBack} /></View>
                <ProvianIcon name="computer" size={56} color={COLORS.primaryLight} connected={status?.state === 'connected'} />
                <Text style={styles.title}>{t('overhaul.connectComputer')}</Text>

                {!loaded ? <ActivityIndicator color={COLORS.primary} /> : status?.state === 'connected' ? (
                    <>
                        <Text style={actionStyles.sectionTitle} accessibilityLiveRegion="polite">
                            {t('overhaul.computerConnected', { name: status.name })}
                        </Text>
                        {status.firstProof && <Text style={actionStyles.body}>{t('overhaul.firstProof')}</Text>}
                        <PrimaryAction label={t('overhaul.viewComputer')}
                            onPress={() => navigation.navigate('DeviceManagement', { deviceId: status.deviceId })} />
                    </>
                ) : waitingCode ? (
                    <>
                        <Text style={actionStyles.sectionTitle} accessibilityLiveRegion="polite">{t('overhaul.waitingComputer')}</Text>
                        <Text style={actionStyles.body}>{t('overhaul.runOnComputer')}</Text>
                        <ActivityIndicator color={COLORS.primary} />
                    </>
                ) : scanning ? (
                    <>
                        <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                            onBarcodeScanned={({ data }) => {
                                if (!data.startsWith(QR_PREFIX)) return;
                                const scanned = data.slice(QR_PREFIX.length);
                                if (!validCode(scanned)) return;
                                setInput(scanned.toUpperCase());
                                setScanning(false);
                                setError(false);
                            }} />
                        <DestinationRow label={t('overhaul.enterComputerCode')} stockIcon="keypad-outline" onPress={() => setScanning(false)} />
                    </>
                ) : (
                    <>
                        <Text style={actionStyles.body}>{t('overhaul.observerWatches')}</Text>
                        <View style={styles.addressPanel}>
                            <Text style={actionStyles.body}>{t('overhaul.openOnComputer')}</Text>
                            <Text style={styles.address}>provian.ai/pair</Text>
                        </View>
                        <DestinationRow label={t('overhaul.scanComputerCode')} icon="scan" onPress={() => { void scan(); }} />
                        <TextInput style={[styles.input, actionStyles.money]} value={input} onChangeText={setInput}
                            autoCapitalize="characters" autoCorrect={false} maxLength={16}
                            placeholder={t('overhaul.enterComputerCode')} placeholderTextColor={COLORS.textSecondary}
                            accessibilityLabel={t('overhaul.enterComputerCode')} />
                        <PrimaryAction label={t('overhaul.confirmPairing')} disabled={!validCode(code) || busy}
                            onPress={() => { void confirm(); }} />
                        <DestinationRow label={t('overhaul.headlessSetup')} stockIcon="terminal-outline"
                            onPress={() => navigation.navigate('ConnectAgent', { mode: 'device' })} />
                    </>
                )}
                {error && <Text style={styles.error} accessibilityLiveRegion="polite">{t('overhaul.pairingError')}</Text>}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    content: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xl, gap: SPACING.m },
    header: { flexDirection: 'row' },
    title: { color: COLORS.text, fontSize: 30, fontWeight: '700' },
    addressPanel: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.m, gap: SPACING.xs },
    address: { color: COLORS.primaryLight, fontSize: 24, fontWeight: '700' },
    camera: { minHeight: 300, overflow: 'hidden', borderRadius: BORDER_RADIUS.l },
    input: { backgroundColor: COLORS.surface, color: COLORS.text, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, fontSize: 17 },
    error: { color: COLORS.error, fontSize: 15 },
});
