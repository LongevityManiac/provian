import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
/**
 * RekeyAgentScreen — re-key a linked agent whose OLD signing key is LOST.
 *
 * The same-key recovery (RecoverAgentScreen) unseals the escrow and restores the
 * SAME address. When there is no escrow to unseal (the key was lost before it was
 * ever escrowed — the Atlas failure), the only path is a RE-KEY to a fresh address
 * under the SAME agent identity (wallet id + PE chain preserved). The phone is the
 * recovery authority and does the whole non-custodial dance in `rekeyAgent` * 1. Biometric-gates (the outcome hands over a fresh fund-bearing key).
 * 2. Mints a new anchor, generates the new key, seals + escrows it, proves
 * possession, and authorizes the identity swap with the human's wallet auth.
 * 3. Presents a re-provision outcome — a one-paste restore command carrying the
 * new key + rotated API credentials for the agent machine.
 *
 * Every failure surfaces ONE plain sentence via mapAgentOnboardingError.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
    Alert,
    Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import {
    requireBiometric,
    BiometricAuthError,
    BiometricNotAvailableError,
} from '../../core/security/requireBiometric';
import { rekeyAgent } from '../../core/agents/agentRekey';
import type { AgentSweepResult, GasPrefundConfirm } from '../../core/agents/agentBalanceSweep';
import { beginRekey, completeRekey, clearRekey } from '../../core/agents/rekeyInFlight';
import { resolveRelayBaseUrl } from '../../core/relay/DevHostDiscovery';
import {
    mapAgentOnboardingError,
    type AgentOnboardingErrorMessage,
} from '../../core/agents/agentOnboardingErrors';
import BackButton from '../../components/BackButton';

type Phase = 'confirm' | 'gating' | 'running' | 'ready' | 'error';

const RekeyAgentScreen = (): React.JSX.Element => {
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList, 'RekeyAgent'>>();
    const route = useRoute<RouteProp<AppParamList, 'RekeyAgent'>>();
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();

    const walletId = route.params?.walletId;
    const agentName = route.params?.agentName;

    const [phase, setPhase] = useState<Phase>('confirm');
    const [command, setCommand] = useState<string | null>(null);
    const [payload, setPayload] = useState<string | null>(null);
    const [payloadRevealed, setPayloadRevealed] = useState(false);
    const [payloadCopied, setPayloadCopied] = useState(false);
    const payloadCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [newAddress, setNewAddress] = useState<string | null>(null);
    const [sweep, setSweep] = useState<AgentSweepResult | null>(null);
    const [error, setError] = useState<AgentOnboardingErrorMessage | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const run = useCallback(async () => {
        if (!walletId) {
            setError(mapAgentOnboardingError('agent wallet not found'));
            setPhase('error');
            return;
        }
        setPhase('gating');
        setError(null);
        // Mark this re-key in flight so a second one cannot be launched from the agent's screen
        // until it completes (and its cooldown lapses) — the operator’s double re-key invalidated the
        // agent's creds. A failure clears it below so the human can retry immediately.
        await beginRekey(walletId);
        try {
            return await withBiometricAction(agentName
                ? t('rekeyAgent.biometricReasonNamed', { name: agentName })
                : t('rekeyAgent.biometricReason'), async (biometricAction) => {

                    assertBiometricAction(biometricAction);
                    setPhase('running');
                    // Gas confirm: when the retired address holds PVT but no ETH, ask the
                    // human whether to fund the sweep gas from their OWN Base wallet. Skip
                    // ⇒ the balance is reported as stranded (recoverable later), not lost.
                    const confirmGasPrefund: GasPrefundConfirm = (info) =>
                        new Promise<boolean>((resolve) => {
                            Alert.alert(
                                t('rekeyAgent.sweepConfirmTitle'),
                                t('rekeyAgent.sweepConfirmBody', { amount: info.pvtDisplay, gas: info.gasEthEstimate }),
                                [
                                    { text: t('rekeyAgent.sweepConfirmSkip'), style: 'cancel', onPress: () => resolve(false) },
                                    { text: t('rekeyAgent.sweepConfirmRecover'), onPress: () => resolve(true) },
                                ],
                                { cancelable: true, onDismiss: () => resolve(false) },
                            );
                        });
                    const result = await rekeyAgent({ walletId, relayUrl: resolveRelayBaseUrl(), confirmGasPrefund }, biometricAction);
                    if (!result.ok) {
                        await clearRekey(walletId);
                        setError(mapAgentOnboardingError(result.code));
                        setPhase('error');
                        return;
                    }
                    await completeRekey(walletId);
                    setNewAddress(result.newAddress);
                    setSweep(result.sweep);
                    setCommand(result.command);
                    setPayload(result.payload);
                    setPayloadRevealed(false);
                    setPhase('ready');

                }, undefined);
        } catch (e) {
            await clearRekey(walletId);
            if (e instanceof BiometricNotAvailableError) {
                setError({
                    message: t('rekeyAgent.biometricUnavailable'),
                    action: t('rekeyAgent.biometricUnavailableAction'),
                });
            } else if (e instanceof BiometricAuthError) {
                setError({
                    message: t('rekeyAgent.biometricFailed'),
                    action: t('rekeyAgent.biometricFailedAction'),
                });
            } else {
                setError(mapAgentOnboardingError(e));
            }
            setPhase('error');
        }
    }, [walletId, agentName, t]);

    useEffect(() => {
        return () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
            if (payloadCopyTimer.current) clearTimeout(payloadCopyTimer.current);
        };
    }, []);

    const onCopy = useCallback(async () => {
        if (!command) return;
        await Clipboard.setStringAsync(command);
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }, [command]);

    const onCopyPayload = useCallback(async () => {
        if (!payload) return;
        await Clipboard.setStringAsync(payload);
        setPayloadCopied(true);
        if (payloadCopyTimer.current) clearTimeout(payloadCopyTimer.current);
        payloadCopyTimer.current = setTimeout(() => setPayloadCopied(false), 1800);
    }, [payload]);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]} numberOfLines={1}>
                    {t('rekeyAgent.title')}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <Text style={[styles.intro, { color: themeColors.textSecondary }]}>
                    {agentName
                        ? t('rekeyAgent.introNamed', { name: agentName })
                        : t('rekeyAgent.intro')}
                </Text>

                {phase === 'confirm' && (
                    <>
                        <View style={styles.warnCard}>
                            <Ionicons name="key-outline" size={18} color="#E8A838" style={{ marginRight: SPACING.s }} />
                            <Text style={styles.warnText}>{t('rekeyAgent.explain')}</Text>
                        </View>
                        <TouchableOpacity style={styles.primaryBtn} onPress={run}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                <Text style={styles.primaryBtnText}>{t('rekeyAgent.startButton')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </>
                )}

                {(phase === 'gating' || phase === 'running') && (
                    <View style={styles.centerBlock}>
                        <ActivityIndicator size="small" color={COLORS.primary} />
                        <Text style={[styles.muted, { marginTop: SPACING.m, textAlign: 'center' }]}>
                            {phase === 'gating' ? t('rekeyAgent.authenticating') : t('rekeyAgent.working')}
                        </Text>
                    </View>
                )}

                {phase === 'error' && error && (
                    <View style={styles.centerBlock}>
                        <Ionicons name="alert-circle-outline" size={40} color={COLORS.textMuted} />
                        <Text style={[styles.errorTitle, { color: themeColors.textPrimary }]}>{errorDisplayCopy(error.message)}</Text>
                        <Text style={[styles.muted, { textAlign: 'center' }]}>{error.action}</Text>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={run}>
                            <Ionicons name="refresh" size={16} color={COLORS.primary} />
                            <Text style={styles.secondaryBtnText}>{t('rekeyAgent.tryAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {phase === 'ready' && command && payload && (
                    <>
                        <View style={styles.successRow}>
                            <Ionicons name="shield-checkmark" size={18} color={COLORS.success || '#4CC38A'} />
                            <Text style={styles.successText}>{t('rekeyAgent.done', { address: newAddress ?? '' })}</Text>
                        </View>

                        {/* Balance recovery : what happened to the retired address's PVT. */}
                        {sweep && sweep.status !== 'no_old_key' && (
                            <View
                                style={sweep.status === 'swept' ? styles.successRow : styles.sweepNoteCard}
                            >
                                <Ionicons
                                    name={sweep.status === 'swept' ? 'swap-horizontal' : 'information-circle-outline'}
                                    size={18}
                                    color={sweep.status === 'swept' ? (COLORS.success || '#4CC38A') : '#E8A838'}
                                />
                                <Text style={sweep.status === 'swept' ? styles.successText : styles.warnText}>
                                    {sweep.status === 'swept'
                                        ? t('rekeyAgent.sweepSwept', { amount: sweep.amountDisplay })
                                        : sweep.status === 'insufficient_gas'
                                            ? t('rekeyAgent.sweepInsufficientGas', { amount: sweep.strandedDisplay, address: sweep.oldAddress })
                                            : sweep.status === 'nothing_to_sweep'
                                                ? t('rekeyAgent.sweepNothing')
                                                : t('rekeyAgent.sweepFailed')}
                                </Text>
                            </View>
                        )}
                        {sweep && sweep.status === 'swept' && (
                            <TouchableOpacity
                                style={styles.sweepTxLink}
                                onPress={() => { void Linking.openURL(sweep.explorerUrl); }}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="open-outline" size={14} color={COLORS.primary} />
                                <Text style={styles.copyText}>{t('rekeyAgent.sweepViewTx')}</Text>
                            </TouchableOpacity>
                        )}

                        {/* Warning FIRST — before the payload is ever on screen. */}
                        <View style={styles.warnCard}>
                            <Ionicons name="warning-outline" size={18} color="#E8A838" style={{ marginRight: SPACING.s }} />
                            <Text style={styles.warnText}>{t('rekeyAgent.dontScreenshot')}</Text>
                        </View>

                        <View style={styles.stepsCard}>
                            <Text style={[styles.stepsTitle, { color: themeColors.textPrimary }]}>
                                {t('rekeyAgent.step1Title')}
                            </Text>
                            <Text style={styles.stepBody}>{t('rekeyAgent.step1Body')}</Text>

                            <TouchableOpacity style={styles.cmdBlock} onPress={onCopy} activeOpacity={0.7}>
                                <Text style={styles.cmdText} selectable>{command}</Text>
                                <View style={styles.copyRow}>
                                    <Ionicons
                                        name={copied ? 'checkmark-circle' : 'copy-outline'}
                                        size={16}
                                        color={copied ? (COLORS.success || '#4CC38A') : COLORS.primary}
                                    />
                                    <Text style={styles.copyText}>
                                        {copied ? t('rekeyAgent.copied') : t('rekeyAgent.copyCommand')}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        </View>

                        <View style={styles.stepsCard}>
                            <Text style={[styles.stepsTitle, { color: themeColors.textPrimary }]}>
                                {t('rekeyAgent.step2Title')}
                            </Text>
                            <Text style={styles.stepBody}>{t('rekeyAgent.step2Body')}</Text>

                            <View style={styles.cmdBlock}>
                                <Text style={styles.keyText} selectable={payloadRevealed}>
                                    {payloadRevealed ? payload : '•'.repeat(48)}
                                </Text>
                                <View style={styles.keyActionRow}>
                                    <TouchableOpacity style={styles.keyAction} onPress={() => setPayloadRevealed((v) => !v)} activeOpacity={0.7}>
                                        <Ionicons name={payloadRevealed ? 'eye-off-outline' : 'eye-outline'} size={16} color={COLORS.primary} />
                                        <Text style={styles.copyText}>
                                            {payloadRevealed ? t('rekeyAgent.hideKey') : t('rekeyAgent.revealKey')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.keyAction} onPress={onCopyPayload} activeOpacity={0.7}>
                                        <Ionicons
                                            name={payloadCopied ? 'checkmark-circle' : 'copy-outline'}
                                            size={16}
                                            color={payloadCopied ? (COLORS.success || '#4CC38A') : COLORS.primary}
                                        />
                                        <Text style={styles.copyText}>
                                            {payloadCopied ? t('rekeyAgent.copied') : t('rekeyAgent.copyKey')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>

                        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                <Text style={styles.primaryBtnText}>{t('rekeyAgent.doneButton')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    headerTitle: { fontSize: 18, fontWeight: '700', flex: 1, minWidth: 0, textAlign: 'center', marginHorizontal: SPACING.s },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },
    intro: { fontSize: 15, lineHeight: 22, marginBottom: SPACING.l },
    centerBlock: { alignItems: 'center', paddingVertical: SPACING.xl },
    muted: { color: COLORS.textMuted, fontSize: 13 },
    errorTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginTop: SPACING.m,
        marginBottom: SPACING.xs,
        textAlign: 'center',
    },
    successRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        backgroundColor: 'rgba(76,195,138,0.10)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(76,195,138,0.30)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    successText: { flex: 1, minWidth: 0, fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
    sweepNoteCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: 'rgba(232,168,56,0.10)',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(232,168,56,0.25)',
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    sweepTxLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: SPACING.l,
        marginTop: -SPACING.s,
    },
    stepsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.l,
    },
    stepsTitle: { fontSize: 16, fontWeight: '700', marginBottom: SPACING.s },
    stepBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 20, marginBottom: SPACING.m },
    cmdBlock: {
        backgroundColor: 'rgba(0,0,0,0.35)',
        borderRadius: 10,
        paddingVertical: SPACING.m,
        paddingHorizontal: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.06)',
    },
    cmdText: { fontSize: 12, color: '#C8D0DC', fontFamily: 'Courier', lineHeight: 18 },
    keyText: { fontSize: 13, color: '#C8D0DC', fontFamily: 'Courier', lineHeight: 20, letterSpacing: 1 },
    // The two key actions wrap onto two lines at 320pt / long translations instead of overflowing.
    keyActionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACING.l, rowGap: SPACING.s, marginTop: SPACING.m },
    keyAction: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, flexShrink: 1, maxWidth: '100%' },
    copyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
        marginTop: SPACING.m,
    },
    copyText: { flexShrink: 1, fontSize: 13, color: COLORS.primary, fontWeight: '600' },
    warnCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: 'rgba(232,168,56,0.10)',
        borderRadius: 16,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(232,168,56,0.25)',
        marginBottom: SPACING.l,
    },
    warnText: { flex: 1, minWidth: 0, fontSize: 13, color: COLORS.textSecondary, lineHeight: 20 },
    primaryBtn: { borderRadius: 24, overflow: 'hidden' },
    primaryBtnGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: SPACING.xl,
    },
    primaryBtnText: { flexShrink: 1, color: '#FFF', fontSize: 15, fontWeight: '600', textAlign: 'center' },
    secondaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: SPACING.l,
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.l,
        maxWidth: '100%',
    },
    secondaryBtnText: { flexShrink: 1, color: COLORS.primary, fontSize: 14, fontWeight: '600', textAlign: 'center' },
});

export default RekeyAgentScreen;
