/**
 * LinkExternalWalletScreen — the linked human links a third-party wallet to
 * one of their agents.
 *
 * Once linked, that address's go-forward on-chain activity on Base is
 * chain-witnessed work of the agent. The proof is one message the address
 * holder signs IN THAT WALLET — never with the Provian wallet key, which
 * refuses a "Provian proof of control" message (walletconnect/provianReserved.ts).
 *
 * Two signature channels, one relay flow
 * (POST /v1/agent/wallet/:id/external-address/challenge → sign → /verify):
 * 1. WalletConnect: the app proposes a session (dApp side,
 * ExternalWalletProofClient) to MetaMask / Coinbase Wallet / Rainbow / …,
 * reads the address the wallet exposes, then asks it to `personal_sign`
 * the exact challenge message.
 * 2. Paste: type the address, copy the exact message, sign it anywhere, paste
 * the signature.
 *
 * PERSON MODE (`ProveOwnWalletScreen`, reached from Earn): the same two channels,
 * but the wallet is proven as the PERSON's own — no agent involved
 * (POST /v1/wallet/external-address/challenge → sign → /verify). From the proof
 * on, that address's sends, swaps, and receives from people the person has dealt
 * with on Base earn like their Provian wallet; nothing before the proof counts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
    TextInput,
    Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { SessionTypes } from '@walletconnect/types';
import type { AppParamList } from '../../navigation/types';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import RelayAPIService, {
    type AgentExternalAddress,
    type AgentExternalAddressChallenge,
} from '../../services/RelayAPIService';
import {
    EXTERNAL_WALLET_APPS,
    accountFromSession,
    externalWalletProofClient,
    isExternalWalletConnectConfigured,
    type ExternalWalletApp,
} from '../../core/walletconnect/ExternalWalletProofClient';
import {
    externalLinkErrorKey,
    isWalletRejection,
    normalizeExternalAddress,
    normalizePastedSignature,
    shortAddress,
    type ExternalLinkErrorKey,
} from '../../core/agents/externalWalletLink';

type WcPhase = 'idle' | 'connecting' | 'awaiting_session' | 'signing' | 'verifying';

/** Who the proven wallet belongs to: one of the person's agents, or the person themself. */
export type ExternalWalletProofMode =
    | { kind: 'agent'; walletId: string; agentName?: string }
    | { kind: 'person' };

type ChallengeResult =
    | { ok: true; challenge: AgentExternalAddressChallenge }
    | { ok: false; error: string };
type VerifyResult = { ok: true; provenAddress: string } | { ok: false; error: string };

/** The three relay calls one proof flow needs, bound to its mode. */
export interface ExternalWalletProofApi {
    list: () => Promise<AgentExternalAddress[] | null>;
    challenge: (address: string) => Promise<ChallengeResult>;
    verify: (input: { address: string; challengeId: string; signature: string }) => Promise<VerifyResult>;
}

export function proofApiFor(mode: ExternalWalletProofMode): ExternalWalletProofApi {
    if (mode.kind === 'person') {
        return {
            list: () => RelayAPIService.listOwnExternalAddresses(),
            challenge: (address) => RelayAPIService.requestOwnExternalAddressChallenge(address),
            verify: (input) => RelayAPIService.verifyOwnExternalAddress(input),
        };
    }
    const { walletId } = mode;
    return {
        list: () => RelayAPIService.listAgentExternalAddresses(walletId),
        challenge: (address) => RelayAPIService.requestAgentExternalAddressChallenge(walletId, address),
        verify: (input) => RelayAPIService.verifyAgentExternalAddress(walletId, input),
    };
}

/**
 * Copy keys the person mode words for itself (under `proveOwnWallet.`); every other
 * key (the WalletConnect and paste mechanics, the errors) is shared under
 * `linkExternalWallet.`.
 */
export const PERSON_COPY_KEYS = [
    'title', 'intro', 'how', 'linkedTitle', 'linkedNone', 'linkedSince',
    'successTitle', 'successBody', 'verify',
] as const;

export function proofCopyKey(mode: ExternalWalletProofMode['kind'], key: string): string {
    return mode === 'person' && (PERSON_COPY_KEYS as readonly string[]).includes(key)
        ? `proveOwnWallet.${key}`
        : `linkExternalWallet.${key}`;
}

const LinkExternalWalletScreen = (): React.JSX.Element => {
    const route = useRoute<RouteProp<AppParamList, 'LinkExternalWallet'>>();
    return (
        <ExternalWalletProofFlow
            mode={{
                kind: 'agent',
                walletId: route.params?.walletId ?? '',
                agentName: route.params?.agentName,
            }}
        />
    );
};

export const ExternalWalletProofFlow = ({ mode }: { mode: ExternalWalletProofMode }): React.JSX.Element => {
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const { t: translate, i18n } = useTranslation();
    const { colors: themeColors } = useTheme();
    const isPerson = mode.kind === 'person';
    const walletId = mode.kind === 'agent' ? mode.walletId : '';
    const api = useMemo(
        () => proofApiFor(isPerson ? { kind: 'person' } : { kind: 'agent', walletId }),
        [isPerson, walletId],
    );
    // `t('linkExternalWallet.x')` resolves to the person-mode wording where one exists.
    const t = useCallback(
        (key: string, opts?: Record<string, unknown>): string => {
            const prefix = 'linkExternalWallet.';
            const resolved = key.startsWith(prefix)
                ? proofCopyKey(mode.kind, key.slice(prefix.length))
                : key;
            return translate(resolved, opts);
        },
        [translate, mode.kind],
    );
    const agentName = (mode.kind === 'agent' ? mode.agentName?.trim() : undefined) || t('linkExternalWallet.yourAgent');

    const [linked, setLinked] = useState<AgentExternalAddress[] | null>(null);
    const [error, setError] = useState<ExternalLinkErrorKey | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // WalletConnect channel
    const wcConfigured = isExternalWalletConnectConfigured();
    const [wcPhase, setWcPhase] = useState<WcPhase>('idle');
    const [wcUri, setWcUri] = useState<string | null>(null);
    const [wcApp, setWcAppState] = useState<ExternalWalletApp | null>(null);
    // The in-flight proposal reads the chosen app after the user picks it.
    const wcAppRef = useRef<ExternalWalletApp | null>(null);
    const setWcApp = useCallback((app: ExternalWalletApp | null) => {
        wcAppRef.current = app;
        setWcAppState(app);
    }, []);
    const sessionRef = useRef<SessionTypes.Struct | null>(null);
    const runRef = useRef(0);

    // Paste channel
    const [addressInput, setAddressInput] = useState('');
    const [challenge, setChallenge] = useState<AgentExternalAddressChallenge | null>(null);
    const [signatureInput, setSignatureInput] = useState('');
    const [pasteBusy, setPasteBusy] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    const loadLinked = useCallback(async () => {
        const rows = await api.list();
        setLinked(rows ?? []);
    }, [api]);

    useEffect(() => {
        void loadLinked();
    }, [loadLinked]);

    // Leaving the screen ends any in-flight proposal.
    useEffect(() => () => {
        runRef.current += 1;
        void externalWalletProofClient.disconnect(sessionRef.current);
        sessionRef.current = null;
    }, []);

    const copy = useCallback(async (text: string, key: string) => {
        await Clipboard.setStringAsync(text);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    }, []);

    const finishLinked = useCallback(async (address: string) => {
        setSuccess(address);
        setError(null);
        setChallenge(null);
        setSignatureInput('');
        setAddressInput('');
        await loadLinked();
    }, [loadLinked]);

    const resetWc = useCallback(async () => {
        runRef.current += 1;
        await externalWalletProofClient.disconnect(sessionRef.current);
        sessionRef.current = null;
        setWcPhase('idle');
        setWcUri(null);
        setWcApp(null);
    }, [setWcApp]);

    const openWalletApp = useCallback(async (url: string) => {
        try {
            await Linking.openURL(url);
        } catch {
            // Not installed / no handler: the Copy link and the QR remain.
        }
    }, []);

    const startWalletConnect = useCallback(async () => {
        const run = ++runRef.current;
        setError(null);
        setSuccess(null);
        setWcPhase('connecting');
        try {
            const { uri, approval } = await externalWalletProofClient.connect();
            if (run !== runRef.current) return;
            setWcUri(uri);
            setWcPhase('awaiting_session');
            const session = await approval();
            if (run !== runRef.current) {
                void externalWalletProofClient.disconnect(session);
                return;
            }
            sessionRef.current = session;
            const account = accountFromSession(session.namespaces);
            if (!account) throw new Error('wallet_no_account');

            setWcPhase('signing');
            const issued = await api.challenge(account.address);
            if (run !== runRef.current) return;
            if (!issued.ok) throw new Error(issued.error);

            // Bring the wallet back to the front so the human sees the request.
            const redirect = session.peer.metadata.redirect?.native;
            const reopen = redirect || wcAppRef.current?.open;
            if (reopen) void openWalletApp(reopen);

            const signature = await externalWalletProofClient.requestPersonalSign(
                session, account, issued.challenge.message,
            );
            if (run !== runRef.current) return;

            setWcPhase('verifying');
            const verified = await api.verify({
                address: account.address,
                challengeId: issued.challenge.challengeId,
                signature,
            });
            if (run !== runRef.current) return;
            if (!verified.ok) throw new Error(verified.error);
            await resetWc();
            await finishLinked(verified.provenAddress);
        } catch (err) {
            if (run !== runRef.current) return;
            const message = err instanceof Error ? err.message : '';
            setError(isWalletRejection(err) ? 'errorWalletRejected' : externalLinkErrorKey(message));
            await resetWc();
        }
    }, [api, openWalletApp, resetWc, finishLinked]);

    const getMessage = useCallback(async () => {
        setError(null);
        setSuccess(null);
        const address = normalizeExternalAddress(addressInput);
        if (!address) {
            setError('errorInvalidAddress');
            return;
        }
        setPasteBusy(true);
        const issued = await api.challenge(address);
        setPasteBusy(false);
        if (!issued.ok) {
            setError(externalLinkErrorKey(issued.error));
            return;
        }
        setChallenge(issued.challenge);
        setSignatureInput('');
    }, [addressInput, api]);

    const verifyPasted = useCallback(async () => {
        if (!challenge) return;
        setError(null);
        const signature = normalizePastedSignature(signatureInput);
        if (!signature) {
            setError('errorSignature');
            return;
        }
        setPasteBusy(true);
        const verified = await api.verify({
            address: challenge.address,
            challengeId: challenge.challengeId,
            signature,
        });
        setPasteBusy(false);
        if (!verified.ok) {
            const key = externalLinkErrorKey(verified.error);
            setError(key);
            if (key === 'errorExpired') setChallenge(null);
            return;
        }
        await finishLinked(verified.provenAddress);
    }, [challenge, signatureInput, api, finishLinked]);

    const dateFmt = (ms: number): string => {
        try {
            return new Date(ms).toLocaleDateString(i18n.language);
        } catch {
            return new Date(ms).toDateString();
        }
    };

    const wcBusy = wcPhase !== 'idle';
    const wcStatus = wcPhase === 'connecting' || wcPhase === 'awaiting_session'
        ? t('linkExternalWallet.wcWaiting')
        : wcPhase === 'signing'
            ? t('linkExternalWallet.wcSigning')
            : wcPhase === 'verifying'
                ? t('linkExternalWallet.verifying')
                : null;

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
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]} numberOfLines={2}>
                    {t('linkExternalWallet.title')}
                </Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <Text style={[styles.intro, { color: themeColors.textSecondary }]}>
                    {t('linkExternalWallet.intro', { name: agentName })}
                </Text>
                <View style={styles.noteRow}>
                    <Ionicons name="shield-checkmark-outline" size={14} color={COLORS.textSecondary} />
                    <Text style={styles.noteText}>{t('linkExternalWallet.how')}</Text>
                </View>
                {isPerson && (
                    <>
                        <View style={styles.noteRow}>
                            <Ionicons name="trending-up-outline" size={14} color={COLORS.textSecondary} />
                            <Text style={styles.noteText}>{t('proveOwnWallet.earns')}</Text>
                        </View>
                        <View style={styles.noteRow}>
                            <Ionicons name="swap-horizontal-outline" size={14} color={COLORS.textSecondary} />
                            <Text style={styles.noteText}>{t('proveOwnWallet.ownMoney')}</Text>
                        </View>
                    </>
                )}

                {/* Linked wallets */}
                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('linkExternalWallet.linkedTitle')}
                    </Text>
                    {linked === null ? (
                        <ActivityIndicator size="small" color={COLORS.primary} style={styles.loader} />
                    ) : linked.length === 0 ? (
                        <Text style={styles.body}>{t('linkExternalWallet.linkedNone')}</Text>
                    ) : (
                        linked.map((row) => (
                            <TouchableOpacity
                                key={row.address}
                                style={styles.linkedRow}
                                onPress={() => copy(row.address, `linked:${row.address}`)}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={row.address}
                            >
                                <Ionicons name="link" size={16} color={COLORS.success} />
                                <View style={styles.linkedTextWrap}>
                                    <Text style={styles.linkedAddress} numberOfLines={1} ellipsizeMode="middle">
                                        {row.address}
                                    </Text>
                                    <Text style={styles.linkedSince}>
                                        {t('linkExternalWallet.linkedSince', { date: dateFmt(row.provenAt) })}
                                    </Text>
                                </View>
                                <Ionicons
                                    name={copiedKey === `linked:${row.address}` ? 'checkmark-circle' : 'copy-outline'}
                                    size={16}
                                    color={copiedKey === `linked:${row.address}` ? COLORS.success : COLORS.primary}
                                />
                            </TouchableOpacity>
                        ))
                    )}
                </View>

                {success && (
                    <View style={styles.successCard}>
                        <Ionicons name="checkmark-circle" size={20} color={COLORS.success} />
                        <View style={styles.flexText}>
                            <Text style={[styles.successTitle, { color: themeColors.textPrimary }]}>
                                {t('linkExternalWallet.successTitle')}
                            </Text>
                            <Text style={styles.body}>
                                {t('linkExternalWallet.successBody', { address: shortAddress(success), name: agentName })}
                            </Text>
                        </View>
                    </View>
                )}

                {error && (
                    <View style={styles.errorCard} accessibilityLiveRegion="polite">
                        <Ionicons name="alert-circle" size={18} color={COLORS.error} />
                        <Text style={styles.errorText}>{t(`linkExternalWallet.${error}`)}</Text>
                    </View>
                )}

                {/* Channel 1: WalletConnect */}
                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('linkExternalWallet.wcTitle')}
                    </Text>
                    {!wcConfigured ? (
                        <Text style={styles.body}>{t('linkExternalWallet.wcUnavailable')}</Text>
                    ) : !wcBusy ? (
                        <>
                            <Text style={styles.body}>{t('linkExternalWallet.wcBody')}</Text>
                            <TouchableOpacity
                                style={styles.primaryBtn}
                                onPress={startWalletConnect}
                                activeOpacity={0.8}
                                accessibilityRole="button"
                            >
                                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                    <Ionicons name="qr-code-outline" size={16} color="#FFF" />
                                    <Text style={styles.primaryBtnText}>{t('linkExternalWallet.wcStart')}</Text>
                                </LinearGradient>
                            </TouchableOpacity>
                        </>
                    ) : (
                        <>
                            <View style={styles.statusRow}>
                                <ActivityIndicator size="small" color={COLORS.primary} />
                                <Text style={styles.statusText}>{wcStatus}</Text>
                            </View>
                            {wcPhase === 'awaiting_session' && wcUri && (
                                <>
                                    <Text style={styles.label}>{t('linkExternalWallet.wcOpenLabel')}</Text>
                                    <View style={styles.walletGrid}>
                                        {EXTERNAL_WALLET_APPS.map((app) => (
                                            <TouchableOpacity
                                                key={app.id}
                                                style={styles.walletChip}
                                                onPress={() => {
                                                    setWcApp(app);
                                                    void openWalletApp(app.connect(wcUri));
                                                }}
                                                activeOpacity={0.7}
                                                accessibilityRole="button"
                                            >
                                                <Text style={styles.walletChipText}>{app.label}</Text>
                                            </TouchableOpacity>
                                        ))}
                                        <TouchableOpacity
                                            style={styles.walletChip}
                                            onPress={() => {
                                                setWcApp(null);
                                                void openWalletApp(wcUri);
                                            }}
                                            activeOpacity={0.7}
                                            accessibilityRole="button"
                                        >
                                            <Text style={styles.walletChipText}>{t('linkExternalWallet.wcOtherWallet')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.linkBtn}
                                        onPress={() => copy(wcUri, 'wcUri')}
                                        activeOpacity={0.7}
                                        accessibilityRole="button"
                                    >
                                        <Ionicons
                                            name={copiedKey === 'wcUri' ? 'checkmark-circle' : 'copy-outline'}
                                            size={16}
                                            color={copiedKey === 'wcUri' ? COLORS.success : COLORS.primary}
                                        />
                                        <Text style={styles.linkBtnText}>
                                            {copiedKey === 'wcUri'
                                                ? t('linkExternalWallet.copied')
                                                : t('linkExternalWallet.wcCopyLink')}
                                        </Text>
                                    </TouchableOpacity>
                                    <Text style={styles.fine}>{t('linkExternalWallet.wcQrHint')}</Text>
                                    <View style={styles.qrWrap}>
                                        <QRCode value={wcUri} size={180} backgroundColor="white" color="#111827" />
                                    </View>
                                </>
                            )}
                            {wcPhase === 'signing' && wcApp && (
                                <TouchableOpacity
                                    style={styles.linkBtn}
                                    onPress={() => void openWalletApp(wcApp.open)}
                                    activeOpacity={0.7}
                                    accessibilityRole="button"
                                >
                                    <Ionicons name="open-outline" size={16} color={COLORS.primary} />
                                    <Text style={styles.linkBtnText}>
                                        {t('linkExternalWallet.wcReopen', { wallet: wcApp.label })}
                                    </Text>
                                </TouchableOpacity>
                            )}
                            <TouchableOpacity
                                style={styles.linkBtn}
                                onPress={() => void resetWc()}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                            >
                                <Ionicons name="close-circle-outline" size={16} color={COLORS.textSecondary} />
                                <Text style={[styles.linkBtnText, { color: COLORS.textSecondary }]}>
                                    {t('linkExternalWallet.cancel')}
                                </Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>

                {/* Channel 2: paste a signature */}
                <View style={styles.card}>
                    <Text style={[styles.cardTitle, { color: themeColors.textPrimary }]}>
                        {t('linkExternalWallet.pasteTitle')}
                    </Text>
                    <Text style={styles.body}>{t('linkExternalWallet.pasteBody')}</Text>

                    <Text style={styles.label}>{t('linkExternalWallet.addressLabel')}</Text>
                    <TextInput
                        style={styles.input}
                        value={challenge ? challenge.address : addressInput}
                        onChangeText={setAddressInput}
                        editable={!challenge && !pasteBusy}
                        placeholder="0x…"
                        placeholderTextColor={COLORS.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        accessibilityLabel={t('linkExternalWallet.addressLabel')}
                    />

                    {!challenge ? (
                        <TouchableOpacity
                            style={[styles.secondaryBtn, (pasteBusy || !addressInput.trim()) && styles.disabled]}
                            onPress={getMessage}
                            disabled={pasteBusy || !addressInput.trim()}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                        >
                            {pasteBusy ? (
                                <ActivityIndicator size="small" color={COLORS.primary} />
                            ) : (
                                <Text style={styles.secondaryBtnText}>{t('linkExternalWallet.getMessage')}</Text>
                            )}
                        </TouchableOpacity>
                    ) : (
                        <>
                            <Text style={styles.label}>{t('linkExternalWallet.messageLabel')}</Text>
                            <TouchableOpacity
                                style={styles.messageBlock}
                                onPress={() => copy(challenge.message, 'message')}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('linkExternalWallet.copyMessage')}
                            >
                                <Text style={styles.messageText} selectable>{challenge.message}</Text>
                                <View style={styles.copyRow}>
                                    <Ionicons
                                        name={copiedKey === 'message' ? 'checkmark-circle' : 'copy-outline'}
                                        size={16}
                                        color={copiedKey === 'message' ? COLORS.success : COLORS.primary}
                                    />
                                    <Text style={styles.linkBtnText}>
                                        {copiedKey === 'message'
                                            ? t('linkExternalWallet.copied')
                                            : t('linkExternalWallet.copyMessage')}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                            <Text style={styles.fine}>{t('linkExternalWallet.messageExpires')}</Text>

                            <Text style={styles.label}>{t('linkExternalWallet.signatureLabel')}</Text>
                            <TextInput
                                style={[styles.input, styles.signatureInput]}
                                value={signatureInput}
                                onChangeText={setSignatureInput}
                                editable={!pasteBusy}
                                placeholder="0x…"
                                placeholderTextColor={COLORS.textMuted}
                                autoCapitalize="none"
                                autoCorrect={false}
                                spellCheck={false}
                                multiline
                                accessibilityLabel={t('linkExternalWallet.signatureLabel')}
                            />
                            <TouchableOpacity
                                style={[styles.primaryBtn, (pasteBusy || !signatureInput.trim()) && styles.disabled]}
                                onPress={verifyPasted}
                                disabled={pasteBusy || !signatureInput.trim()}
                                activeOpacity={0.8}
                                accessibilityRole="button"
                            >
                                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                    {pasteBusy ? (
                                        <ActivityIndicator size="small" color="#FFF" />
                                    ) : (
                                        <Text style={styles.primaryBtnText}>{t('linkExternalWallet.verify')}</Text>
                                    )}
                                </LinearGradient>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.linkBtn}
                                onPress={() => {
                                    setChallenge(null);
                                    setSignatureInput('');
                                }}
                                disabled={pasteBusy}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                            >
                                <Text style={[styles.linkBtnText, { color: COLORS.textSecondary }]}>
                                    {t('linkExternalWallet.changeAddress')}
                                </Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>
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
        paddingHorizontal: SPACING.m,
        paddingTop: SPACING.s,
        paddingBottom: SPACING.s,
    },
    headerTitle: { fontSize: 17, fontWeight: '700', flex: 1, minWidth: 0, textAlign: 'center', marginHorizontal: SPACING.s },
    scrollContent: { paddingHorizontal: SPACING.m, paddingBottom: SPACING.xxl },
    intro: { fontSize: 15, lineHeight: 22, marginBottom: SPACING.s },
    noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, marginBottom: SPACING.l },
    noteText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 19, color: COLORS.textSecondary },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        marginBottom: SPACING.m,
    },
    cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: SPACING.s },
    body: { fontSize: 13, lineHeight: 20, color: COLORS.textSecondary },
    loader: { alignSelf: 'flex-start', marginVertical: SPACING.s },
    label: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: COLORS.primaryLight,
        marginTop: SPACING.m,
        marginBottom: SPACING.xs,
    },
    fine: { fontSize: 12, lineHeight: 18, color: COLORS.textMuted, marginTop: SPACING.s },
    linkedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.s,
        borderTopWidth: 1,
        borderTopColor: COLORS.borderLight,
    },
    linkedTextWrap: { flex: 1, minWidth: 0 },
    linkedAddress: { fontSize: 13, color: COLORS.text, fontFamily: 'Courier' },
    linkedSince: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
    successCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: COLORS.successMuted,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(76,195,138,0.30)',
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    flexText: { flex: 1, minWidth: 0 },
    successTitle: { fontSize: 15, fontWeight: '700', marginBottom: SPACING.xs },
    errorCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: COLORS.errorMuted,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(242,85,90,0.30)',
        padding: SPACING.m,
        marginBottom: SPACING.m,
    },
    errorText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 19, color: COLORS.text },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.xs },
    statusText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 19, color: COLORS.textSecondary },
    walletGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.s },
    walletChip: {
        paddingVertical: SPACING.s,
        paddingHorizontal: SPACING.m,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: COLORS.primaryMuted,
        borderWidth: 1,
        borderColor: COLORS.borderFocus,
        maxWidth: '100%',
    },
    walletChipText: { fontSize: 13, fontWeight: '600', color: COLORS.primaryLight, flexShrink: 1 },
    qrWrap: {
        alignSelf: 'center',
        padding: SPACING.s,
        backgroundColor: 'white',
        borderRadius: BORDER_RADIUS.m,
        marginTop: SPACING.s,
    },
    input: {
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.border,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        fontSize: 14,
        color: COLORS.text,
        fontFamily: 'Courier',
    },
    signatureInput: { minHeight: 72, textAlignVertical: 'top' },
    messageBlock: {
        backgroundColor: 'rgba(0,0,0,0.35)',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.borderLight,
        gap: SPACING.s,
    },
    messageText: { fontSize: 11, lineHeight: 16, color: '#C8D0DC', fontFamily: 'Courier' },
    copyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, alignSelf: 'flex-end', maxWidth: '100%' },
    primaryBtn: { borderRadius: 24, overflow: 'hidden', marginTop: SPACING.m },
    primaryBtnGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        paddingVertical: 12,
        paddingHorizontal: SPACING.l,
    },
    primaryBtnText: { flexShrink: 1, color: '#FFF', fontSize: 15, fontWeight: '600', textAlign: 'center' },
    secondaryBtn: {
        marginTop: SPACING.m,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: SPACING.l,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: COLORS.borderFocus,
        backgroundColor: COLORS.primaryMuted,
    },
    secondaryBtnText: { flexShrink: 1, color: COLORS.primaryLight, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    linkBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
        marginTop: SPACING.m,
        maxWidth: '100%',
    },
    linkBtnText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: COLORS.primary },
    disabled: { opacity: 0.5 },
});

export default LinkExternalWalletScreen;
