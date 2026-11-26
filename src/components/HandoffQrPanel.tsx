/**
 * Web app: the QR code that moves a wallet between this browser and the Provian phone app.
 *
 *   mode 'send'     (Add your phone): the phone scans, this browser shows where the wallet is going
 *                   and the match code, the person confirms with the passkey and PIN, the sealed
 *                   seed goes to the phone.
 *   mode 'receive'  (I already have a wallet): the phone scans and sends; this browser opens the
 *                   sealed seed and hands the phrase to the restore flow (onReceived).
 *
 * A code lasts ten minutes; leaving the screen ends the session on the relay.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from 'react-i18next';
import { ActionTouchable } from './ScreenActions';
import { COLORS, SPACING, BORDER_RADIUS } from '../constants/theme';
import RelayAPIService from '../services/RelayAPIService';
import {
    HandoffExpiredError,
    cancelSession,
    openWebSession,
    waitForJoin,
    waitForWallet,
    watchSession,
    type HandoffPeer,
    type HandoffSession,
} from '../core/walletHandoff/handoffFlow';
import { thisHandoffDevice } from '../core/walletHandoff/deviceLabel';
import { HandoffUnlockCancelledError, confirmAndSendWallet } from '../core/walletHandoff/handoffSender';

type Phase =
    | { kind: 'opening' }
    | { kind: 'waiting'; qrText: string }
    | { kind: 'joined'; peer: HandoffPeer }
    | { kind: 'sending'; peer: HandoffPeer }
    | { kind: 'sent'; peer: HandoffPeer }
    | { kind: 'expired' }
    /** receive: the phrase went on to the restore; a person who comes back can ask for a new code. */
    | { kind: 'used' }
    | { kind: 'error'; message: string };

export interface HandoffQrPanelProps {
    mode: 'send' | 'receive';
    /** send: this browser's wallet address. */
    walletAddress?: string | null;
    /** receive: the phrase the phone sent, opened here. */
    onReceived?: (mnemonic: string) => void;
}

export default function HandoffQrPanel({ mode, walletAddress, onReceived }: HandoffQrPanelProps): React.ReactElement {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
    const [attempt, setAttempt] = useState(0);
    const sessionRef = useRef<HandoffSession | null>(null);
    // The confirm step's watch on the other side (send mode); stopped while sealing.
    const watchRef = useRef({ aborted: true });
    const receivedRef = useRef(onReceived);
    receivedRef.current = onReceived;

    const failure = useCallback((err: unknown): Phase => {
        if (err instanceof HandoffExpiredError) return { kind: 'expired' };
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'handoff_receiver_key_mismatch') return { kind: 'error', message: t('handoff.tampered') };
        return { kind: 'error', message: t('handoff.failed', { message: code }) };
    }, [t]);

    /** send: while the person decides, notice a phone that left (its session ends on the relay). */
    const watch = useCallback((session: HandoffSession) => {
        watchRef.current.aborted = true;
        const signal = { aborted: false };
        watchRef.current = signal;
        watchSession(RelayAPIService, session, { signal }).catch((err: unknown) => {
            if (signal.aborted) return;
            sessionRef.current = null;
            setPhase(failure(err));
        });
    }, [failure]);

    useEffect(() => {
        const signal = { aborted: false };
        setPhase({ kind: 'opening' });
        void (async () => {
            try {
                const { session, qrText } = await openWebSession(RelayAPIService, mode, thisHandoffDevice());
                sessionRef.current = session;
                if (signal.aborted) return;
                setPhase({ kind: 'waiting', qrText });
                const peer = await waitForJoin(RelayAPIService, session, { signal });
                if (signal.aborted) return;
                setPhase({ kind: 'joined', peer });
                if (mode === 'send') {
                    watch(session);
                    return;
                }
                const received = await waitForWallet(RelayAPIService, session, { signal });
                sessionRef.current = null;
                if (signal.aborted) return;
                setPhase({ kind: 'used' });
                receivedRef.current?.(received.mnemonic);
            } catch (err) {
                if (!signal.aborted) setPhase(failure(err));
            }
        })();
        return () => {
            signal.aborted = true;
            watchRef.current.aborted = true;
            void cancelSession(RelayAPIService, sessionRef.current);
            sessionRef.current = null;
        };
    }, [mode, attempt, failure, watch]);

    const send = async (peer: HandoffPeer) => {
        const session = sessionRef.current;
        if (!session || !walletAddress) return;
        // A delivered wallet also ends the session: stop watching for a phone that left.
        watchRef.current.aborted = true;
        setPhase({ kind: 'sending', peer });
        try {
            await confirmAndSendWallet(RelayAPIService, session, peer, walletAddress);
            // The phone picks it up and the relay deletes the session; nothing to cancel any more.
            sessionRef.current = null;
            setPhase({ kind: 'sent', peer });
        } catch (err) {
            // Cancelling the passkey or PIN just returns to the confirm step.
            if (err instanceof HandoffUnlockCancelledError) {
                setPhase({ kind: 'joined', peer });
                watch(session);
            } else {
                // Nothing went to the phone; end the session so the phone stops waiting too.
                sessionRef.current = null;
                void cancelSession(RelayAPIService, session);
                setPhase(failure(err));
            }
        }
    };

    const newCode = () => setAttempt(n => n + 1);

    return (
        <View style={styles.panel} accessibilityLiveRegion="polite">
            <Text style={styles.title}>{mode === 'send' ? t('handoff.qrTitleSend') : t('handoff.qrTitleReceive')}</Text>
            {phase.kind === 'opening' && <ActivityIndicator color={COLORS.primary} style={styles.spinner} />}
            {phase.kind === 'waiting' && (
                <>
                    <Text style={styles.body}>{mode === 'send' ? t('handoff.qrBodySend') : t('handoff.qrBodyReceive')}</Text>
                    <View style={styles.qr} accessibilityLabel={t('handoff.qrAlt')}>
                        <QRCode value={phase.qrText} size={220} backgroundColor="white" color="#111827" ecl="M" />
                    </View>
                    <Text style={styles.note}>{t('handoff.latestApp')}</Text>
                    <Text style={styles.note}>{t('handoff.expires')}</Text>
                </>
            )}
            {(phase.kind === 'joined' || phase.kind === 'sending') && (
                <>
                    <Text style={styles.body}>
                        {mode === 'send'
                            ? t('handoff.destination', { label: phase.peer.device.label })
                            : t('handoff.source', { label: phase.peer.device.label })}
                    </Text>
                    <Text style={styles.code} accessibilityLabel={t('handoff.matchCode', { code: phase.peer.matchCode })}>{phase.peer.matchCode}</Text>
                    <Text style={styles.note}>{t('handoff.matchHint')}</Text>
                    {mode === 'send' ? (
                        <>
                            <ActionTouchable style={[styles.primary, phase.kind === 'sending' && styles.disabled]} disabled={phase.kind === 'sending'}
                                onPress={() => { void send(phase.peer); }}>
                                {phase.kind === 'sending'
                                    ? <ActivityIndicator color={COLORS.onPrimary} />
                                    : <Text style={styles.primaryText}>{t('handoff.confirmSend')}</Text>}
                            </ActionTouchable>
                            <Text style={styles.note}>{t('handoff.confirmHintWeb')}</Text>
                        </>
                    ) : (
                        <>
                            <ActivityIndicator color={COLORS.primary} style={styles.spinner} />
                            <Text style={styles.note}>{t('handoff.waitingForSender', { label: phase.peer.device.label })}</Text>
                        </>
                    )}
                </>
            )}
            {phase.kind === 'sent' && (
                <>
                    <Text style={styles.body}>{t('handoff.sentBody', { label: phase.peer.device.label })}</Text>
                    <Text style={styles.note}>{t('handoff.together')}</Text>
                </>
            )}
            {phase.kind === 'used' && (
                <ActionTouchable style={styles.secondary} onPress={newCode}>
                    <Text style={styles.secondaryText}>{t('handoff.newCode')}</Text>
                </ActionTouchable>
            )}
            {(phase.kind === 'expired' || phase.kind === 'error') && (
                <>
                    <Text style={styles.error}>{phase.kind === 'expired' ? t('handoff.expired') : phase.message}</Text>
                    <ActionTouchable style={styles.secondary} onPress={newCode}>
                        <Text style={styles.secondaryText}>{t('handoff.newCode')}</Text>
                    </ActionTouchable>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    panel: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, marginBottom: SPACING.l, alignItems: 'center' },
    title: { color: COLORS.chrome, fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: SPACING.s },
    body: { color: COLORS.chromeMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: SPACING.m },
    qr: { backgroundColor: 'white', padding: SPACING.m, borderRadius: BORDER_RADIUS.m, marginBottom: SPACING.m },
    code: { color: COLORS.chrome, fontSize: 34, letterSpacing: 4, fontFamily: 'Inter_700Bold', marginBottom: SPACING.xs },
    note: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: SPACING.xs },
    spinner: { marginVertical: SPACING.m },
    primary: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, paddingHorizontal: SPACING.xl, alignItems: 'center', marginTop: SPACING.m, alignSelf: 'stretch' },
    disabled: { opacity: 0.6 },
    primaryText: { color: COLORS.onPrimary, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
    secondary: { paddingVertical: SPACING.m, alignItems: 'center' },
    secondaryText: { color: COLORS.primary, fontSize: 15 },
    error: { color: COLORS.error, fontSize: 14, textAlign: 'center', marginBottom: SPACING.s },
});
