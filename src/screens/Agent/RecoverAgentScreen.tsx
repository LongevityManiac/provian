import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
/**
 * RecoverAgentScreen - re-provision a linked agent's wallet when its machine is lost.
 *
 * The phone that invited the agent is the non-custodial recovery custodian
 * (two-touch onboarding). This screen:
 *   1. Biometric-gates (the outcome hands over the agent's fund-bearing key).
 *   2. Reads the relay's CIPHERTEXT-ONLY escrow for this agent wallet
 *      (GET /v1/agent/wallet/:id/recovery-escrow) — the relay holds no key.
 *   3. Opens the sealed box with the anchor secret held in this phone's
 *      cloud-backed keychain (survives phone replacement).
 *   4. Presents a RE-PROVISION outcome — a fresh one-paste restore command the
 *      human copies to the new machine. It is NOT a raw-key display; the key
 *      rides inside a locally-run command and never touches Provian's servers.
 *
 * Every failure surfaces ONE plain-English sentence + a next action via
 * mapAgentOnboardingError — never a raw code, stack, or resolver string.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
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
import RelayAPIService from '../../services/RelayAPIService';
import {
    requireBiometric,
    BiometricAuthError,
    BiometricNotAvailableError,
} from '../../core/security/requireBiometric';
import { recoverAgentKeyHex, buildAgentRestoreCommand, type AgentRestoreInstructions } from '../../core/agents/agentRecovery';
import { resolveRelayBaseUrl } from '../../core/relay/DevHostDiscovery';
import {
    mapAgentOnboardingError,
    type AgentOnboardingErrorMessage,
} from '../../core/agents/agentOnboardingErrors';
import BackButton from '../../components/BackButton';

type Phase = 'gating' | 'loading' | 'ready' | 'error';

const RecoverAgentScreen = (): React.JSX.Element => {
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList, 'RecoverAgent'>>();
    const route = useRoute<RouteProp<AppParamList, 'RecoverAgent'>>();
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();

    const walletId = route.params?.walletId;
    const agentName = route.params?.agentName;

    const [phase, setPhase] = useState<Phase>('gating');
    const [restore, setRestore] = useState<AgentRestoreInstructions | null>(null);
    const [keyRevealed, setKeyRevealed] = useState(false);
    const [keyCopied, setKeyCopied] = useState(false);
    const keyCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [error, setError] = useState<AgentOnboardingErrorMessage | null>(null);
    // When there is no escrow to unseal (the key was lost before it was ever
    // escrowed — the Atlas failure), same-key recovery is impossible and the only
    // path is a RE-KEY. Offer it from the error state.
    const [canRekey, setCanRekey] = useState(false);
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
        setCanRekey(false);
        try {
            return await withBiometricAction(agentName
                ? t('recoverAgent.biometricReasonNamed', { name: agentName })
                : t('recoverAgent.biometricReason'), async (biometricAction) => {

                    // Gate BEFORE any sensitive material is fetched or opened.
                    assertBiometricAction(biometricAction);

                    setPhase('loading');

                    const escrowResult = await RelayAPIService.getRecoveryEscrow(walletId, biometricAction);
                    if (!escrowResult.ok) {
                        // No escrow to unseal → same-key recovery is impossible; a re-key is
                        // the only path. Surface it as an actionable next step.
                        if (escrowResult.code === 'no_recovery_escrow' || escrowResult.code === 'http_404') {
                            setCanRekey(true);
                            setError({
                                message: t('recoverAgent.noEscrowTitle'),
                                action: t('recoverAgent.noEscrowAction'),
                            });
                        } else {
                            setError(mapAgentOnboardingError(escrowResult.code));
                        }
                        setPhase('error');
                        return;
                    }

                    // Open the sealed box with the phone-held anchor secret. Fail-closed:
                    // a wrong/absent anchor or a tampered blob throws and is humanised.
                    const recoveredKeyHex = await recoverAgentKeyHex({
                        sealedKeyBlobB64u: escrowResult.escrow.sealed_key_blob,
                        recoveryAnchorPubkeyB64u: escrowResult.escrow.recovery_anchor_pubkey,
                        walletId,
                    }, biometricAction);

                    setRestore(buildAgentRestoreCommand({ walletId, recoveredKeyHex, relayUrl: resolveRelayBaseUrl() }));
                    setKeyRevealed(false);
                    setPhase('ready');

                }, undefined);
        } catch (e) {
            if (e instanceof BiometricNotAvailableError) {
                setError({
                    message: t('recoverAgent.biometricUnavailable'),
                    action: t('recoverAgent.biometricUnavailableAction'),
                });
            } else if (e instanceof BiometricAuthError) {
                setError({
                    message: t('recoverAgent.biometricFailed'),
                    action: t('recoverAgent.biometricFailedAction'),
                });
            } else {
                setError(mapAgentOnboardingError(e));
            }
            setPhase('error');
        }
    }, [walletId, agentName, t]);

    useEffect(() => {
        run();
        // Run once on mount for this wallet.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        return () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
            if (keyCopyTimer.current) clearTimeout(keyCopyTimer.current);
        };
    }, []);

    const onCopy = useCallback(async () => {
        if (!restore) return;
        await Clipboard.setStringAsync(restore.command);
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }, [restore]);

    const onCopyKey = useCallback(async () => {
        if (!restore) return;
        await Clipboard.setStringAsync(restore.key);
        setKeyCopied(true);
        if (keyCopyTimer.current) clearTimeout(keyCopyTimer.current);
        keyCopyTimer.current = setTimeout(() => setKeyCopied(false), 1800);
    }, [restore]);

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
                    {t('recoverAgent.title')}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <Text style={[styles.intro, { color: themeColors.textSecondary }]}>
                    {agentName
                        ? t('recoverAgent.introNamed', { name: agentName })
                        : t('recoverAgent.intro')}
                </Text>

                {(phase === 'gating' || phase === 'loading') && (
                    <View style={styles.centerBlock}>
                        <ActivityIndicator size="small" color={COLORS.primary} />
                        <Text style={[styles.muted, { marginTop: SPACING.m, textAlign: 'center' }]}>
                            {phase === 'gating'
                                ? t('recoverAgent.authenticating')
                                : t('recoverAgent.recovering')}
                        </Text>
                    </View>
                )}

                {phase === 'error' && error && (
                    <View style={styles.centerBlock}>
                        <Ionicons name="alert-circle-outline" size={40} color={COLORS.textMuted} />
                        <Text style={[styles.errorTitle, { color: themeColors.textPrimary }]}>
                            {errorDisplayCopy(error.message)}
                        </Text>
                        <Text style={[styles.muted, { textAlign: 'center' }]}>{error.action}</Text>
                        {canRekey && walletId && (
                            <TouchableOpacity
                                style={styles.secondaryBtn}
                                onPress={() => navigation.replace('RekeyAgent', { walletId, agentName })}
                            >
                                <Ionicons name="key-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.secondaryBtnText}>{t('recoverAgent.rekeyInstead')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.secondaryBtn} onPress={run}>
                            <Ionicons name="refresh" size={16} color={COLORS.primary} />
                            <Text style={styles.secondaryBtnText}>{t('recoverAgent.tryAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {phase === 'ready' && restore && (
                    <>
                        <View style={styles.successRow}>
                            <Ionicons name="shield-checkmark" size={18} color={COLORS.success || '#4CC38A'} />
                            <Text style={styles.successText}>{t('recoverAgent.recovered')}</Text>
                        </View>

                        {/* Warning FIRST — before the key is ever on screen. */}
                        <View style={styles.warnCard}>
                            <Ionicons name="warning-outline" size={18} color="#E8A838" style={{ marginRight: SPACING.s }} />
                            <Text style={styles.warnText}>{t('recoverAgent.dontScreenshot')}</Text>
                        </View>

                        <View style={styles.stepsCard}>
                            <Text style={[styles.stepsTitle, { color: themeColors.textPrimary }]}>
                                {t('recoverAgent.step1Title')}
                            </Text>
                            <Text style={styles.stepBody}>{t('recoverAgent.step1Body')}</Text>

                            <TouchableOpacity style={styles.cmdBlock} onPress={onCopy} activeOpacity={0.7}>
                                <Text style={styles.cmdText} selectable>{restore.command}</Text>
                                <View style={styles.copyRow}>
                                    <Ionicons
                                        name={copied ? 'checkmark-circle' : 'copy-outline'}
                                        size={16}
                                        color={copied ? (COLORS.success || '#4CC38A') : COLORS.primary}
                                    />
                                    <Text style={styles.copyText}>
                                        {copied ? t('recoverAgent.copied') : t('recoverAgent.copyCommand')}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        </View>

                        <View style={styles.stepsCard}>
                            <Text style={[styles.stepsTitle, { color: themeColors.textPrimary }]}>
                                {t('recoverAgent.step2Title')}
                            </Text>
                            <Text style={styles.stepBody}>{t('recoverAgent.step2Body')}</Text>

                            {/* The key is MASKED by default (screenshot-safe). Reveal is an explicit tap. */}
                            <View style={styles.cmdBlock}>
                                <Text style={styles.keyText} selectable={keyRevealed}>
                                    {keyRevealed ? restore.key : '•'.repeat(Math.min(restore.key.length, 48))}
                                </Text>
                                <View style={styles.keyActionRow}>
                                    <TouchableOpacity style={styles.keyAction} onPress={() => setKeyRevealed((v) => !v)} activeOpacity={0.7}>
                                        <Ionicons name={keyRevealed ? 'eye-off-outline' : 'eye-outline'} size={16} color={COLORS.primary} />
                                        <Text style={styles.copyText}>
                                            {keyRevealed ? t('recoverAgent.hideKey') : t('recoverAgent.revealKey')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.keyAction} onPress={onCopyKey} activeOpacity={0.7}>
                                        <Ionicons
                                            name={keyCopied ? 'checkmark-circle' : 'copy-outline'}
                                            size={16}
                                            color={keyCopied ? (COLORS.success || '#4CC38A') : COLORS.primary}
                                        />
                                        <Text style={styles.copyText}>
                                            {keyCopied ? t('recoverAgent.copied') : t('recoverAgent.copyKey')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>

                        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                <Text style={styles.primaryBtnText}>{t('recoverAgent.done')}</Text>
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

export default RecoverAgentScreen;
