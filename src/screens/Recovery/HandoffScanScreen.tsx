/**
 * Phone app: scan the QR code the web app (app.provian.ai) shows, to move a wallet without typing
 * a recovery phrase.
 *
 *   mode 'receive'  "I already have a wallet" → "From your computer": the browser holds the wallet;
 *                   it shows where the wallet is going, the person confirms there, and this phone
 *                   restores it exactly as a typed phrase restores.
 *   mode 'send'     Backup & Recovery → "Add a computer": this phone holds the wallet; it shows the
 *                   browser it is going to and the match code, the person confirms with Face ID /
 *                   Touch ID, and the sealed seed goes to the browser.
 *
 * Both devices stay signed in: the browser signs in with its own credential beside the phone.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import { actionStyles, PrimaryAction } from '../../components/ScreenActions';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import { useWalletStore } from '../../store/walletStore';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import {
    HandoffExpiredError,
    HandoffNotACodeError,
    cancelSession,
    joinAsReceiver,
    joinAsSender,
    waitForWallet,
    watchSession,
    type HandoffPeer,
    type HandoffSession,
} from '../../core/walletHandoff/handoffFlow';
import { HANDOFF_QR_PREFIX } from '../../core/walletHandoff/handoffCrypto';
import { thisHandoffDevice } from '../../core/walletHandoff/deviceLabel';
import { HandoffUnlockCancelledError, confirmAndSendWallet } from '../../core/walletHandoff/handoffSender';

type Mode = 'receive' | 'send';

type Phase =
    | { kind: 'intro' }
    | { kind: 'scanning' }
    | { kind: 'joining' }
    | { kind: 'joined'; peer: HandoffPeer }
    | { kind: 'sending'; peer: HandoffPeer }
    | { kind: 'sent'; peer: HandoffPeer }
    | { kind: 'error'; message: string };

interface Props {
    navigation: { goBack(): void; canGoBack(): boolean; navigate(name: string, params?: object): void; replace(name: string, params?: object): void };
    route?: { params?: { mode?: Mode } };
}

export default function HandoffScanScreen({ navigation, route }: Props): React.ReactElement {
    const { t } = useTranslation();
    const bio = useBiometricLabel();
    const mode: Mode = route?.params?.mode === 'send' ? 'send' : 'receive';
    const walletAddress = useWalletStore(s => s.address);
    const [permission, requestPermission] = useCameraPermissions();
    const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
    const sessionRef = useRef<HandoffSession | null>(null);
    const signalRef = useRef({ aborted: false });
    const scannedRef = useRef(false);
    // The confirm step's watch on the computer (send mode); stopped while sealing.
    const watchRef = useRef({ aborted: true });

    /** Leave the session: the computer stops waiting and shows a new code. */
    const endSession = useCallback(() => {
        watchRef.current.aborted = true;
        const session = sessionRef.current;
        sessionRef.current = null;
        void cancelSession(RelayAPIService, session);
    }, []);

    useEffect(() => () => {
        signalRef.current.aborted = true;
        endSession();
    }, [endSession]);

    const failure = useCallback((err: unknown): Phase => {
        if (err instanceof HandoffExpiredError) return { kind: 'error', message: t('handoff.expired') };
        if (err instanceof HandoffNotACodeError) return { kind: 'error', message: t('handoff.notACode') };
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'handoff_receiver_key_mismatch') return { kind: 'error', message: t('handoff.tampered') };
        if (code === 'handoff_wrong_direction') return { kind: 'error', message: mode === 'receive' ? t('handoff.wrongCodeReceive') : t('handoff.wrongCodeSend') };
        if (code === 'handoff_already_joined') return { kind: 'error', message: t('handoff.alreadyUsed') };
        return { kind: 'error', message: t('handoff.failed', { message: code }) };
    }, [mode, t]);

    /** Any failure ends this phone's side of the session, so the computer does not wait on it. */
    const fail = useCallback((err: unknown) => {
        endSession();
        if (!signalRef.current.aborted) setPhase(failure(err));
    }, [endSession, failure]);

    /** send: while the person decides, notice a computer that left. */
    const watch = useCallback((session: HandoffSession) => {
        watchRef.current.aborted = true;
        const signal = { aborted: false };
        watchRef.current = signal;
        watchSession(RelayAPIService, session, { signal }).catch((err: unknown) => {
            if (!signal.aborted) fail(err);
        });
    }, [fail]);

    const startScan = async () => {
        const access = permission?.granted ? permission : await requestPermission();
        if (!access.granted) {
            setPhase({ kind: 'error', message: t('handoff.cameraNeeded') });
            return;
        }
        scannedRef.current = false;
        setPhase({ kind: 'scanning' });
    };

    const onScanned = async (data: string) => {
        // Other QR codes in view are ignored; only a Provian handoff code stops the camera.
        if (scannedRef.current || !data.startsWith(`${HANDOFF_QR_PREFIX}:`)) return;
        scannedRef.current = true;
        setPhase({ kind: 'joining' });
        try {
            const device = thisHandoffDevice();
            const joined = mode === 'receive'
                ? await joinAsReceiver(RelayAPIService, data, device)
                : await joinAsSender(RelayAPIService, data, device);
            if (signalRef.current.aborted) {
                // The person left while the join was on its way: end it now.
                void cancelSession(RelayAPIService, joined.session);
                return;
            }
            sessionRef.current = joined.session;
            setPhase({ kind: 'joined', peer: joined.peer });
            if (mode === 'send') {
                watch(joined.session);
                return;
            }
            const received = await waitForWallet(RelayAPIService, joined.session, { signal: signalRef.current });
            sessionRef.current = null;
            if (!signalRef.current.aborted) navigation.replace('ImportRecoveryPhrase', { restoredMnemonic: received.mnemonic });
        } catch (err) {
            fail(err);
        }
    };

    const send = async (peer: HandoffPeer) => {
        const session = sessionRef.current;
        if (!session || !walletAddress) return;
        // A delivered wallet also ends the session: stop watching for a computer that left.
        watchRef.current.aborted = true;
        setPhase({ kind: 'sending', peer });
        try {
            await confirmAndSendWallet(RelayAPIService, session, peer, walletAddress);
            sessionRef.current = null;
            setPhase({ kind: 'sent', peer });
        } catch (err) {
            // Cancelling Face ID / Touch ID just returns to the confirm step.
            if (err instanceof HandoffUnlockCancelledError) {
                setPhase({ kind: 'joined', peer });
                watch(session);
            } else {
                fail(err);
            }
        }
    };

    const title = mode === 'receive' ? t('handoff.scanTitleReceive') : t('handoff.scanTitleSend');

    return (
        <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <View style={styles.header}><BackButton onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('RecoveryStart'))} /></View>
                <View style={styles.icon}><Ionicons name={mode === 'receive' ? 'desktop-outline' : 'laptop-outline'} size={40} color={COLORS.primary} /></View>
                <Text style={styles.title} accessibilityRole="header">{title}</Text>

                {phase.kind === 'intro' && (
                    <>
                        <Text style={actionStyles.body}>{mode === 'receive' ? t('handoff.scanBodyReceive') : t('handoff.scanBodySend')}</Text>
                        <PrimaryAction label={t('handoff.scanButton')} onPress={() => { void startScan(); }} />
                    </>
                )}
                {phase.kind === 'scanning' && (
                    <>
                        <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                            onBarcodeScanned={({ data }) => { void onScanned(data); }} />
                        <Text style={styles.note}>{t('handoff.pointCamera')}</Text>
                    </>
                )}
                {phase.kind === 'joining' && <ActivityIndicator color={COLORS.primary} style={styles.spinner} />}
                {(phase.kind === 'joined' || phase.kind === 'sending') && (
                    <View style={styles.panel} accessibilityLiveRegion="polite">
                        <Text style={styles.body}>
                            {mode === 'send'
                                ? t('handoff.destination', { label: phase.peer.device.label })
                                : t('handoff.source', { label: phase.peer.device.label })}
                        </Text>
                        <Text style={styles.code} accessibilityLabel={t('handoff.matchCode', { code: phase.peer.matchCode })}>{phase.peer.matchCode}</Text>
                        <Text style={styles.note}>{t('handoff.matchHint')}</Text>
                        {mode === 'send' ? (
                            <>
                                <PrimaryAction label={t('handoff.confirmSend')} disabled={phase.kind === 'sending'}
                                    onPress={() => { void send(phase.peer); }} />
                                <Text style={styles.note}>{t('handoff.confirmHintPhone', { biometric: bio.label })}</Text>
                            </>
                        ) : (
                            <>
                                <ActivityIndicator color={COLORS.primary} style={styles.spinner} />
                                <Text style={styles.note}>{t('handoff.waitingForSender', { label: phase.peer.device.label })}</Text>
                            </>
                        )}
                    </View>
                )}
                {phase.kind === 'sent' && (
                    <>
                        <Text style={styles.body}>{t('handoff.sentBody', { label: phase.peer.device.label })}</Text>
                        <Text style={styles.note}>{t('handoff.together')}</Text>
                        <PrimaryAction label={t('handoff.done')} onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('MainTabs'))} />
                    </>
                )}
                {phase.kind === 'error' && (
                    <>
                        <Text style={styles.error} accessibilityLiveRegion="polite">{phase.message}</Text>
                        <PrimaryAction label={t('handoff.scanAgain')} onPress={() => { endSession(); void startScan(); }} />
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    content: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xl, gap: SPACING.m },
    header: { flexDirection: 'row' },
    icon: { width: 80, height: 80, borderRadius: 40, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
    title: { color: COLORS.chrome, fontSize: 24, fontFamily: 'Inter_700Bold', textAlign: 'center' },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
    camera: { minHeight: 320, overflow: 'hidden', borderRadius: BORDER_RADIUS.l },
    panel: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, alignItems: 'stretch', gap: SPACING.s },
    code: { color: COLORS.chrome, fontSize: 34, letterSpacing: 4, fontFamily: 'Inter_700Bold', textAlign: 'center' },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    spinner: { marginVertical: SPACING.m },
    error: { color: COLORS.error, fontSize: 15, textAlign: 'center' },
});
