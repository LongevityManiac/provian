/**
 * ForgeConnectScreen - in-app connect flow for the forge webhook connectors
 * (Witness 3): GitHub, GitLab, Bitbucket. Reached from the Earn tab's
 * surface detail CTA (B3,).
 *
 * Two shapes, one screen:
 * - GitHub: App-install handoff. The relay mints a pending connect session
 * (state nonce), the system browser opens github.com's install page, the
 * user authorizes THERE (Provian never receives a credential that can
 * read code), and this screen polls until the relay records the install.
 * - GitLab / Bitbucket: registration. The user enters their project id /
 * repo UUID; the relay links it to this wallet and returns a ONE-TIME
 * per-install webhook secret (B2) that must be surfaced immediately -
 * it is never shown again. Rotation is revoke + re-register.
 *
 * All relay calls ride the app's request-bound wallet auth
 * (RelayAPIService.makeAuthenticatedRequest) via the /v1/witnesses wallet
 * variants - the phone has no DeviceKey identity.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService, {
    type ForgeInstall,
    type ForgeRegisterResult,
} from '../../services/RelayAPIService';
import type { ForgeProvider } from '../../core/earn/EarningSurfaceRegistry';
import type { ForgeConnectScreenProps } from '../../navigation/types';
import BackButton from '../../components/BackButton';

// Mirror the relay's validation so obvious mistakes fail before a round-trip
// (routes/witnesses-gitlab.ts PROJECT_ID_RE / witnesses-bitbucket.ts REPO_UUID_RE).
const GITLAB_PROJECT_ID_RE = /^[0-9]{1,18}$/;
const BITBUCKET_REPO_UUID_RE =
    /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

const POLL_INTERVAL_MS = 3000;

type GitHubPhase =
    | 'idle'
    | 'starting'
    | 'waiting'
    | 'completed'
    | 'expired'
    | 'not_configured'
    | 'error';

/** Non-null exactly when the last registration minted the one-time secret. */
type IssuedSecret = { installationId: string; secret: string; setup: string };

export default function ForgeConnectScreen({
    navigation,
    route,
}: ForgeConnectScreenProps): React.JSX.Element {
    const { t } = useTranslation();
    const provider: ForgeProvider = route.params.provider;

    const [installs, setInstalls] = useState<ForgeInstall[] | null>(null);

    // ── GitHub handoff state ─────────────────────────────────────────
    const [githubPhase, setGithubPhase] = useState<GitHubPhase>('idle');
    const connectSession = useRef<{ state: string; expiresAt: number } | null>(null);

    // ── GitLab / Bitbucket registration state ────────────────────────
    const [installationIdInput, setInstallationIdInput] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [inputError, setInputError] = useState<string | null>(null);
    const [notConfigured, setNotConfigured] = useState(false);
    const [issuedSecret, setIssuedSecret] = useState<IssuedSecret | null>(null);
    const [alreadyIssued, setAlreadyIssued] = useState<{ installationId: string; setup: string } | null>(null);
    const [secretCopied, setSecretCopied] = useState(false);

    const loadInstalls = useCallback(async () => {
        const all = await RelayAPIService.listForgeInstalls();
        setInstalls(all.filter((i) => i.provider === provider));
    }, [provider]);

    useEffect(() => {
        loadInstalls();
    }, [loadInstalls]);

    // GitHub connect polling loop: runs only while the handoff is pending.
    useEffect(() => {
        if (githubPhase !== 'waiting') return;
        let cancelled = false;
        const timer = setInterval(async () => {
            const session = connectSession.current;
            if (!session) return;
            if (Date.now() > session.expiresAt) {
                if (!cancelled) setGithubPhase('expired');
                return;
            }
            const result = await RelayAPIService.pollGitHubForgeConnect(session.state);
            if (cancelled || !result.ok) return; // transient poll errors: keep trying until TTL
            if (result.status === 'completed') {
                setGithubPhase('completed');
                loadInstalls();
            } else if (result.status === 'expired') {
                setGithubPhase('expired');
            }
        }, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [githubPhase, loadInstalls]);

    const handleGitHubConnect = useCallback(async () => {
        setGithubPhase('starting');
        const started = await RelayAPIService.startGitHubForgeConnect();
        if (!started.ok) {
            // B1 pending: the GitHub App is not registered on the relay yet.
            setGithubPhase(started.code === 'github_connect_not_configured' ? 'not_configured' : 'error');
            return;
        }
        connectSession.current = { state: started.state, expiresAt: started.expiresAt };
        setGithubPhase('waiting');
        try {
            await Linking.openURL(started.installUrl);
        } catch {
            // Browser refused to open; the poll loop is harmless to leave running.
            setGithubPhase('error');
        }
    }, []);

    const handleRegister = useCallback(async () => {
        if (provider === 'github') return;
        const trimmed = installationIdInput.trim();
        const valid = provider === 'gitlab'
            ? GITLAB_PROJECT_ID_RE.test(trimmed)
            : BITBUCKET_REPO_UUID_RE.test(trimmed);
        if (!valid) {
            setInputError(t(`earn.forge.${provider}.invalidId`));
            return;
        }
        setInputError(null);
        setSubmitting(true);
        setSecretCopied(false);
        const result: ForgeRegisterResult = await RelayAPIService.registerForgeInstall(provider, trimmed);
        setSubmitting(false);
        if (!result.ok) {
            if (result.status === 503) {
                setNotConfigured(true);
            } else if (result.status === 409) {
                setInputError(t('earn.forge.alreadyLinkedElsewhere'));
            } else if (result.status === 400) {
                setInputError(t(`earn.forge.${provider}.invalidId`));
            } else {
                setInputError(t('earn.forge.genericError'));
            }
            return;
        }
        if (result.webhookSecret) {
            // One-time disclosure (B2): this is the only moment the secret exists
            // outside the relay. Keep it on screen until the user leaves.
            setIssuedSecret({
                installationId: result.installationId,
                secret: result.webhookSecret,
                setup: result.setup,
            });
            setAlreadyIssued(null);
        } else if (result.webhookSecretAlreadyIssued) {
            setIssuedSecret(null);
            setAlreadyIssued({ installationId: result.installationId, setup: result.setup });
        }
        setInstallationIdInput('');
        loadInstalls();
    }, [provider, installationIdInput, loadInstalls, t]);

    const handleCopySecret = useCallback(async () => {
        if (!issuedSecret) return;
        await Clipboard.setStringAsync(issuedSecret.secret);
        setSecretCopied(true);
        setTimeout(() => setSecretCopied(false), 2000);
    }, [issuedSecret]);

    const handleRevoke = useCallback(
        (installationId: string) => {
            Alert.alert(
                t('earn.forge.revokeConfirmTitle'),
                t(
                    provider === 'github'
                        ? 'earn.forge.revokeConfirmBodyGithub'
                        : 'earn.forge.revokeConfirmBodyWebhook',
                ),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('earn.forge.revoke'),
                        style: 'destructive',
                        onPress: async () => {
                            const result = await RelayAPIService.revokeForgeInstall(provider, installationId);
                            if (!result.ok) {
                                Alert.alert(t('common.error'), t('earn.forge.genericError'));
                                return;
                            }
                            // A revoked install's one-time secret is dead; drop any
                            // lingering disclosure card for it.
                            setIssuedSecret((s) => (s?.installationId === installationId ? null : s));
                            setAlreadyIssued((s) => (s?.installationId === installationId ? null : s));
                            loadInstalls();
                        },
                    },
                ],
            );
        },
        [provider, loadInstalls, t],
    );

    const activeInstalls = (installs ?? []).filter((i) => i.revoked_at === null);
    const revokedInstalls = (installs ?? []).filter((i) => i.revoked_at !== null);

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {t(`earn.surfaces.${provider}.title`)}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.heroIconBg}>
                    <Ionicons
                        name={`logo-${provider}` as keyof typeof Ionicons.glyphMap}
                        size={30}
                        color={COLORS.primary}
                    />
                </View>
                <Text style={styles.explainer}>{t(`earn.forge.${provider}.explainer`)}</Text>

                {provider === 'github' ? (
                    <>
                        <GitHubIdentityLink t={t} />
                        <GitHubHandoff phase={githubPhase} onConnect={handleGitHubConnect} t={t} />
                    </>
                ) : (
                    <>
                        {notConfigured ? (
                            <View style={styles.infoCard}>
                                <Ionicons name="time-outline" size={18} color={COLORS.textMuted} />
                                <Text style={styles.infoCardText}>{t('earn.forge.notConfigured')}</Text>
                            </View>
                        ) : (
                            <View style={styles.formCard}>
                                <Text style={styles.inputLabel}>{t(`earn.forge.${provider}.inputLabel`)}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={installationIdInput}
                                    onChangeText={(v) => {
                                        setInstallationIdInput(v);
                                        setInputError(null);
                                    }}
                                    placeholder={t(`earn.forge.${provider}.inputPlaceholder`)}
                                    placeholderTextColor={COLORS.textMuted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType={provider === 'gitlab' ? 'number-pad' : 'default'}
                                />
                                <Text style={styles.inputHelp}>{t(`earn.forge.${provider}.inputHelp`)}</Text>
                                {inputError && <Text style={styles.inputError}>{inputError}</Text>}
                                <TouchableOpacity
                                    style={[styles.ctaBtn, submitting && styles.ctaBtnDisabled]}
                                    onPress={handleRegister}
                                    disabled={submitting}
                                    activeOpacity={0.85}
                                >
                                    <LinearGradient colors={GRADIENTS.primary} style={styles.ctaGradient}>
                                        {submitting ? (
                                            <ActivityIndicator size="small" color="#FFF" />
                                        ) : (
                                            <>
                                                <Text style={styles.ctaText}>{t('earn.forge.registerCta')}</Text>
                                                <Ionicons name="link-outline" size={16} color="#FFF" />
                                            </>
                                        )}
                                    </LinearGradient>
                                </TouchableOpacity>
                            </View>
                        )}

                        {issuedSecret && (
                            <View style={styles.secretCard}>
                                <View style={styles.secretHeader}>
                                    <Ionicons name="key-outline" size={18} color={COLORS.warning} />
                                    <Text style={styles.secretTitle}>{t('earn.forge.secretTitle')}</Text>
                                </View>
                                <Text style={styles.secretWarning}>{t('earn.forge.secretWarning')}</Text>
                                <View style={styles.secretValueRow}>
                                    <Text style={styles.secretValue} selectable>
                                        {issuedSecret.secret}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={styles.copyBtn}
                                    onPress={handleCopySecret}
                                    activeOpacity={0.85}
                                >
                                    <Ionicons
                                        name={secretCopied ? 'checkmark-outline' : 'copy-outline'}
                                        size={16}
                                        color={secretCopied ? COLORS.success : COLORS.primary}
                                    />
                                    <Text style={[styles.copyBtnText, secretCopied && { color: COLORS.success }]}>
                                        {secretCopied ? t('earn.forge.copied') : t('earn.forge.copySecret')}
                                    </Text>
                                </TouchableOpacity>
                                <Text style={styles.setupTitle}>{t('earn.forge.setupTitle')}</Text>
                                <Text style={styles.setupText}>{issuedSecret.setup}</Text>
                            </View>
                        )}

                        {alreadyIssued && (
                            <View style={styles.infoCard}>
                                <Ionicons name="information-circle-outline" size={18} color={COLORS.warning} />
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.infoCardTitle}>{t('earn.forge.alreadyIssuedTitle')}</Text>
                                    <Text style={styles.infoCardText}>{t('earn.forge.alreadyIssuedBody')}</Text>
                                </View>
                            </View>
                        )}
                    </>
                )}

                {/* Linked installs (all providers) */}
                <Text style={styles.sectionTitle}>{t('earn.forge.installsTitle')}</Text>
                {installs === null ? (
                    <ActivityIndicator size="small" color={COLORS.primary} style={{ marginVertical: SPACING.m }} />
                ) : activeInstalls.length === 0 && revokedInstalls.length === 0 ? (
                    <Text style={styles.emptyText}>{t('earn.forge.noInstalls')}</Text>
                ) : (
                    <View style={styles.installsCard}>
                        {activeInstalls.map((install) => (
                            <View key={install.installation_id} style={styles.installBlock}>
                                <View style={styles.installRow}>
                                    <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.installId} numberOfLines={1}>
                                            {install.installation_id}
                                        </Text>
                                        <Text style={styles.installMeta}>
                                            {new Date(install.installed_at).toLocaleDateString()}
                                        </Text>
                                    </View>
                                    <TouchableOpacity
                                        onPress={() => handleRevoke(install.installation_id)}
                                        style={styles.revokeBtn}
                                        activeOpacity={0.8}
                                    >
                                        <Text style={styles.revokeBtnText}>{t('earn.forge.revoke')}</Text>
                                    </TouchableOpacity>
                                </View>
                                {/* Contributors is its own full-width action row (was a cramped pill
                                    next to Revoke): person-add icon + destination label + the
                                    "Add a contributor" subtitle + chevron make the add flow a clear
                                    tap target. Reuses existing i18n keys — no new strings. */}
                                <TouchableOpacity
                                    onPress={() => navigation.navigate('ForgeContributors', {
                                        provider,
                                        installationId: install.installation_id,
                                    })}
                                    style={styles.contributorsRow}
                                    activeOpacity={0.8}
                                    accessibilityLabel={t('earn.forge.contributors.addTitle')}
                                >
                                    <Ionicons name="person-add-outline" size={18} color={COLORS.primary} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.contributorsRowText}>{t('earn.forge.contributors.openCta')}</Text>
                                        <Text style={styles.contributorsRowSub}>{t('earn.forge.contributors.addTitle')}</Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
                                </TouchableOpacity>
                            </View>
                        ))}
                        {revokedInstalls.map((install) => (
                            <View key={`revoked-${install.installation_id}`} style={styles.installRow}>
                                <Ionicons name="close-circle-outline" size={16} color={COLORS.textMuted} />
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.installId, { color: COLORS.textMuted }]} numberOfLines={1}>
                                        {install.installation_id}
                                    </Text>
                                    <Text style={styles.installMeta}>{t('earn.forge.revoked')}</Text>
                                </View>
                            </View>
                        ))}
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

// ─── GitHub handoff sub-view ─────────────────────────────────────────────

const GitHubIdentityLink = ({ t }: { t: (key: string) => string }): React.JSX.Element => {
    const [session, setSession] = useState<{ state: string; code: string; expiresAt: number; interval: number } | null>(null);
    const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'completed' | 'error'>('idle');
    useEffect(() => {
        if (phase !== 'waiting' || !session) return;
        let cancelled = false; let polling = false;
        const timer = setInterval(async () => {
            if (polling) return;
            if (Date.now() >= session.expiresAt) { setPhase('error'); return; }
            polling = true;
            const result = await RelayAPIService.githubIdentityLink(session.state);
            polling = false;
            if (cancelled) return;
            if (result.ok && result.status === 'completed') setPhase('completed');
        }, session.interval * 1000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [phase, session]);
    const start = async (): Promise<void> => {
        setPhase('starting');
        const result = await RelayAPIService.githubIdentityLink();
        if (!result.ok || typeof result.state !== 'string' || typeof result.user_code !== 'string' ||
            result.verification_uri !== 'https://github.com/login/device' || typeof result.expires_at !== 'number') {
            setPhase('error'); return;
        }
        setSession({ state: result.state, code: result.user_code, expiresAt: result.expires_at, interval: Math.max(5, Number(result.interval) || 5) });
        setPhase('waiting');
        try { await Linking.openURL(result.verification_uri); } catch { setPhase('error'); }
    };
    return <View style={styles.formCard}>
        <Text style={styles.infoCardText}>{t('earn.forge.github.identityExplainer')}</Text>
        {phase === 'completed' ? <Text style={styles.infoCardText}>{t('earn.forge.github.identityComplete')}</Text> : <>
            {session && phase === 'waiting' && <Text selectable style={styles.waitingText}>{t('earn.forge.github.identityCode')} {session.code}</Text>}
            {phase === 'error' && <Text style={styles.inputError}>{t('earn.forge.genericError')}</Text>}
            <TouchableOpacity style={styles.ctaBtn} onPress={start} disabled={phase === 'starting' || phase === 'waiting'}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.ctaGradient}>
                    <Text style={styles.ctaText}>{t('earn.forge.github.identityCta')}</Text>
                    {phase === 'starting' && <ActivityIndicator size="small" color="#FFF" />}
                </LinearGradient>
            </TouchableOpacity>
        </>}
    </View>;
};

interface GitHubHandoffProps {
    phase: GitHubPhase;
    onConnect: () => void;
    t: (key: string) => string;
}

const GitHubHandoff = ({ phase, onConnect, t }: GitHubHandoffProps): React.JSX.Element => {
    if (phase === 'not_configured') {
        return (
            <View style={styles.infoCard}>
                <Ionicons name="time-outline" size={18} color={COLORS.textMuted} />
                <Text style={styles.infoCardText}>{t('earn.forge.github.notConfigured')}</Text>
            </View>
        );
    }
    if (phase === 'completed') {
        return (
            <View style={[styles.infoCard, styles.successCard]}>
                <Ionicons name="checkmark-circle" size={18} color={COLORS.success} />
                <Text style={styles.infoCardText}>{t('earn.forge.github.completed')}</Text>
            </View>
        );
    }
    return (
        <View style={styles.formCard}>
            {phase === 'waiting' && (
                <View style={styles.waitingRow}>
                    <ActivityIndicator size="small" color={COLORS.primary} />
                    <Text style={styles.waitingText}>{t('earn.forge.github.waiting')}</Text>
                </View>
            )}
            {phase === 'expired' && (
                <Text style={styles.inputError}>{t('earn.forge.github.expired')}</Text>
            )}
            {phase === 'error' && <Text style={styles.inputError}>{t('earn.forge.genericError')}</Text>}
            <TouchableOpacity
                style={[styles.ctaBtn, phase === 'starting' && styles.ctaBtnDisabled]}
                onPress={onConnect}
                disabled={phase === 'starting'}
                activeOpacity={0.85}
            >
                <LinearGradient colors={GRADIENTS.primary} style={styles.ctaGradient}>
                    {phase === 'starting' ? (
                        <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                        <>
                            <Text style={styles.ctaText}>
                                {phase === 'waiting' || phase === 'expired'
                                    ? t('earn.forge.github.retryCta')
                                    : t('earn.forge.github.connectCta')}
                            </Text>
                            <Ionicons name="open-outline" size={16} color="#FFF" />
                        </>
                    )}
                </LinearGradient>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.s,
    },
    headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, flex: 1, textAlign: 'center' },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },

    heroIconBg: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: 'rgba(74,142,232,0.14)',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.m,
    },
    explainer: {
        fontSize: 14,
        color: COLORS.textSecondary,
        lineHeight: 21,
        textAlign: 'center',
        marginBottom: SPACING.l,
    },

    formCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        padding: SPACING.l,
        marginBottom: SPACING.l,
    },
    inputLabel: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
    },
    input: {
        backgroundColor: 'rgba(11,14,20,0.80)',
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.14)',
        color: COLORS.text,
        fontSize: 15,
        fontFamily: 'Courier',
        paddingHorizontal: SPACING.m,
        paddingVertical: 12,
        marginBottom: SPACING.s,
    },
    inputHelp: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17, marginBottom: SPACING.m },
    inputError: { fontSize: 13, color: COLORS.error, marginBottom: SPACING.m },

    ctaBtn: { borderRadius: 24, overflow: 'hidden' },
    ctaBtnDisabled: { opacity: 0.6 },
    ctaGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 14,
    },
    ctaText: { color: '#FFF', fontSize: 15, fontWeight: '600' },

    waitingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.m,
    },
    waitingText: { flex: 1, fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    infoCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        backgroundColor: 'rgba(156,163,175,0.06)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(156,163,175,0.18)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    successCard: {
        backgroundColor: COLORS.successMuted,
        borderColor: 'rgba(76,195,138,0.30)',
    },
    infoCardTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 4 },
    infoCardText: { flex: 1, fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    // One-time secret disclosure (B2): visually loudest card on the screen.
    secretCard: {
        backgroundColor: COLORS.warningMuted,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(232,168,56,0.45)',
        padding: SPACING.l,
        marginBottom: SPACING.l,
    },
    secretHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    secretTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
    secretWarning: {
        fontSize: 13,
        color: COLORS.warningLight,
        lineHeight: 19,
        fontWeight: '600',
        marginBottom: SPACING.m,
    },
    secretValueRow: {
        backgroundColor: 'rgba(11,14,20,0.85)',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        marginBottom: SPACING.s,
    },
    secretValue: { fontSize: 13, color: COLORS.text, fontFamily: 'Courier', lineHeight: 19 },
    copyBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.35)',
        marginBottom: SPACING.m,
    },
    copyBtnText: { fontSize: 14, fontWeight: '600', color: COLORS.primary },
    setupTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
    },
    setupText: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },

    sectionTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
    },
    emptyText: { fontSize: 13, color: COLORS.textMuted, marginBottom: SPACING.l },
    installsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    installRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.s,
    },
    installId: { fontSize: 13, color: COLORS.text, fontFamily: 'Courier' },
    installMeta: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
    revokeBtn: {
        paddingHorizontal: SPACING.m,
        paddingVertical: 6,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(242,85,90,0.35)',
    },
    revokeBtnText: { fontSize: 12, fontWeight: '600', color: COLORS.error },
    installBlock: {
        paddingVertical: SPACING.xs,
        marginBottom: SPACING.xs,
    },
    contributorsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginTop: SPACING.s,
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.35)',
        backgroundColor: 'rgba(74,142,232,0.07)',
    },
    contributorsRowText: { fontSize: 13, fontWeight: '700', color: COLORS.primary },
    contributorsRowSub: { fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
});
