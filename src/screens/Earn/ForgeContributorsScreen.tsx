import { withBiometricAction } from '../../core/security/biometricAction';
/**
 * ForgeContributorsScreen - the owner-side Contributors surface for ONE
 * connected forge install (Part 2). Reached from ForgeConnectScreen's
 * install row.
 *
 * Lists the git identity → wallet mappings this owner vouched on the
 * install's forge account, revokes one (biometric-gated: a consequential
 * write), and ADDS a contributor: the owner enters the agent's wallet id and
 * git author email, and the screen hands back the exact one-line command the
 * agent runs on its own machine.
 *
 * - A LINKED agent (one of this owner's beneficiary-linked agents) registers
 * itself under the standing authorization of the link: no challenge, no
 * expiry — the command is shown immediately.
 * - Any other agent: the screen issues a claims-bound challenge under the
 * owner's wallet auth and shows the `--challenge <id>` command. The agent
 * signs with its own key and completes under its OWN auth; the signature
 * travels through the relay and is never pasted into this phone.
 *
 * All relay calls ride the app's request-bound wallet auth
 * (RelayAPIService.makeAuthenticatedRequest). Pure logic lives in
 * forgeContributors.ts (unit-tested); this file is the view.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
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
import RelayAPIService, { type AuthorMapping, type ForgeInstall } from '../../services/RelayAPIService';
import type { ForgeContributorsScreenProps } from '../../navigation/types';
import {
    buildRegisterGitIdentityCommand,
    challengeMinutesLeft,
    chooseContributorHandoff,
    describeMapping,
    mappingsForInstall,
    validateContributorInput,
    type ContributorHandoff,
} from './forgeContributors';
import BackButton from '../../components/BackButton';

type Handoff =
    | { kind: 'linked_self'; command: string }
    | { kind: 'owner_challenge'; command: string; expiresAt: number };

export default function ForgeContributorsScreen({
    navigation,
    route,
}: ForgeContributorsScreenProps): React.JSX.Element {
    const { t } = useTranslation();
    const { provider, installationId } = route.params;

    const [install, setInstall] = useState<ForgeInstall | null | undefined>(undefined);
    const [ownerWalletId, setOwnerWalletId] = useState<string>('');
    const [mappings, setMappings] = useState<AuthorMapping[] | null | undefined>(undefined);
    const [linkedAgentIds, setLinkedAgentIds] = useState<string[]>([]);

    const [agentWalletId, setAgentWalletId] = useState('');
    const [email, setEmail] = useState('');
    const [inputError, setInputError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [handoff, setHandoff] = useState<Handoff | null>(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        const [installs, listed, linked] = await Promise.all([
            RelayAPIService.listForgeInstalls(),
            RelayAPIService.listAuthorMappings(),
            RelayAPIService.getLinkedAgents().catch(() => ({ linked_agents: [] })),
        ]);
        setInstall(installs.find((i) => i.provider === provider && i.installation_id === installationId) ?? null);
        if (listed) {
            setOwnerWalletId(listed.ownerWalletId);
            setMappings(listed.mappings);
        } else {
            setMappings(null);
        }
        setLinkedAgentIds(linked.linked_agents.map((a) => a.wallet_id));
    }, [provider, installationId]);

    useEffect(() => {
        load();
    }, [load]);

    const forgeAccountId = install?.forge_account_id ?? null;
    const rows = useMemo(
        () => mappingsForInstall(mappings ?? [], { provider, forgeAccountId }),
        [mappings, provider, forgeAccountId],
    );

    const handleAdd = useCallback(async () => {
        const error = validateContributorInput({ agentWalletId, email });
        if (error) {
            setInputError(t(error === 'agent_wallet_id'
                ? 'earn.forge.contributors.invalidAgentWallet'
                : 'earn.forge.contributors.invalidEmail'));
            return;
        }
        setInputError(null);
        setCopied(false);
        const trimmedId = agentWalletId.trim();
        const kind: ContributorHandoff = chooseContributorHandoff(trimmedId, linkedAgentIds);
        if (kind === 'linked_self') {
            setHandoff({
                kind,
                command: buildRegisterGitIdentityCommand({ handoff: kind, provider, installationId, email }),
            });
            return;
        }
        setSubmitting(true);
        const issued = await RelayAPIService.issueAuthorMappingChallenge({
            provider,
            installationId,
            agentWalletId: trimmedId,
            authorKeyType: 'email',
            authorKey: email.trim(),
        });
        setSubmitting(false);
        if (!issued.ok) {
            if (issued.code === 'install_forge_account_unknown') setInputError(t('earn.forge.contributors.unstamped'));
            else if (issued.status === 404 && issued.code.startsWith('active agent_wallet_id')) setInputError(t('earn.forge.contributors.errorAgentNotFound'));
            else if (issued.code === 'author_key_already_mapped') setInputError(t('earn.forge.contributors.errorAlreadyMapped'));
            else setInputError(t('earn.forge.contributors.errorGeneric'));
            return;
        }
        setHandoff({
            kind,
            command: buildRegisterGitIdentityCommand({
                handoff: kind, provider, installationId, email, challengeId: issued.challengeId,
            }),
            expiresAt: issued.expiresAt,
        });
    }, [agentWalletId, email, linkedAgentIds, provider, installationId, t]);

    const handleCopy = useCallback(async () => {
        if (!handoff) return;
        await Clipboard.setStringAsync(handoff.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [handoff]);

    const handleRevoke = useCallback((mapping: AuthorMapping) => {
        Alert.alert(
            t('earn.forge.contributors.revokeConfirmTitle'),
            t('earn.forge.contributors.revokeConfirmBody'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('earn.forge.contributors.revoke'),
                    style: 'destructive',
                    onPress: async () => {
                        // Consequential write: the mapping decides who is credited for
                        // pushes on this repository. Biometric, fail-closed.
                        let result;
                        try {
                            result = await withBiometricAction(t('earn.forge.contributors.revokeConfirmTitle'),
                                action => RelayAPIService.revokeAuthorMapping(mapping.mapping_id, action));
                        } catch { return; }
                        if (!result.ok) {
                            Alert.alert(t('common.error'), t('earn.forge.contributors.errorGeneric'));
                            return;
                        }
                        load();
                    },
                },
            ],
        );
    }, [load, t]);

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
                    {t('earn.forge.contributors.title')}
                </Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <Text style={styles.explainer}>{t('earn.forge.contributors.subtitle')}</Text>
                <Text style={styles.installLine} numberOfLines={1}>
                    {t(`earn.surfaces.${provider}.title`)} · {installationId}
                    {install?.forge_account_login ? ` · ${install.forge_account_login}` : ''}
                </Text>

                {/* Add a contributor */}
                <Text style={styles.sectionTitle}>{t('earn.forge.contributors.addTitle')}</Text>
                {install === null || (install && !forgeAccountId) ? (
                    <View style={styles.infoCard}>
                        <Ionicons name="information-circle-outline" size={18} color={COLORS.warning} />
                        <Text style={styles.infoCardText}>{t('earn.forge.contributors.unstamped')}</Text>
                    </View>
                ) : (
                    <View style={styles.formCard}>
                        <Text style={styles.inputLabel}>{t('earn.forge.contributors.agentWalletLabel')}</Text>
                        <TextInput
                            style={styles.input}
                            value={agentWalletId}
                            onChangeText={(v) => { setAgentWalletId(v); setInputError(null); setHandoff(null); }}
                            placeholder={t('earn.forge.contributors.agentWalletPlaceholder')}
                            placeholderTextColor={COLORS.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <Text style={styles.inputLabel}>{t('earn.forge.contributors.emailLabel')}</Text>
                        <TextInput
                            style={styles.input}
                            value={email}
                            onChangeText={(v) => { setEmail(v); setInputError(null); setHandoff(null); }}
                            placeholder={t('earn.forge.contributors.emailPlaceholder')}
                            placeholderTextColor={COLORS.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                        />
                        {inputError && <Text style={styles.inputError}>{inputError}</Text>}
                        <TouchableOpacity
                            style={[styles.ctaBtn, submitting && styles.ctaBtnDisabled]}
                            onPress={handleAdd}
                            disabled={submitting}
                            activeOpacity={0.85}
                        >
                            <LinearGradient colors={GRADIENTS.primary} style={styles.ctaGradient}>
                                {submitting ? (
                                    <ActivityIndicator size="small" color="#FFF" />
                                ) : (
                                    <>
                                        <Text style={styles.ctaText}>{t('earn.forge.contributors.addCta')}</Text>
                                        <Ionicons name="terminal-outline" size={16} color="#FFF" />
                                    </>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                    </View>
                )}

                {handoff && (
                    <View style={styles.commandCard}>
                        <View style={styles.commandHeader}>
                            <Ionicons name="terminal-outline" size={18} color={COLORS.primary} />
                            <Text style={styles.commandTitle}>
                                {t(handoff.kind === 'linked_self'
                                    ? 'earn.forge.contributors.handoffLinkedTitle'
                                    : 'earn.forge.contributors.handoffChallengeTitle')}
                            </Text>
                        </View>
                        <Text style={styles.commandBody}>
                            {handoff.kind === 'linked_self'
                                ? t('earn.forge.contributors.handoffLinkedBody')
                                : t('earn.forge.contributors.handoffChallengeBody', {
                                    minutes: challengeMinutesLeft(handoff.expiresAt, Date.now()),
                                })}
                        </Text>
                        <View style={styles.commandValueRow}>
                            <Text style={styles.commandValue} selectable>{handoff.command}</Text>
                        </View>
                        <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} activeOpacity={0.85}>
                            <Ionicons
                                name={copied ? 'checkmark-outline' : 'copy-outline'}
                                size={16}
                                color={copied ? COLORS.success : COLORS.primary}
                            />
                            <Text style={[styles.copyBtnText, copied && { color: COLORS.success }]}>
                                {copied ? t('earn.forge.contributors.copied') : t('earn.forge.contributors.copyCommand')}
                            </Text>
                        </TouchableOpacity>
                        <Text style={styles.mintNote}>{t('earn.forge.contributors.mintNote')}</Text>
                    </View>
                )}

                {/* Registered identities on this install */}
                <Text style={styles.sectionTitle}>{t('earn.forge.contributors.listTitle')}</Text>
                {mappings === undefined || install === undefined ? (
                    <ActivityIndicator size="small" color={COLORS.primary} style={{ marginVertical: SPACING.m }} />
                ) : mappings === null ? (
                    <Text style={styles.emptyText}>{t('earn.forge.contributors.loadError')}</Text>
                ) : rows.length === 0 ? (
                    <Text style={styles.emptyText}>{t('earn.forge.contributors.empty')}</Text>
                ) : (
                    <View style={styles.listCard}>
                        {rows.map((mapping) => {
                            const d = describeMapping(mapping, ownerWalletId);
                            const active = mapping.status === 'active';
                            return (
                                <View key={mapping.mapping_id} style={styles.row}>
                                    <Ionicons
                                        name={active ? 'checkmark-circle' : 'close-circle-outline'}
                                        size={16}
                                        color={active ? COLORS.success : COLORS.textMuted}
                                    />
                                    <View style={{ flex: 1 }}>
                                        <Text style={[styles.rowTitle, !active && { color: COLORS.textMuted }]} numberOfLines={1}>
                                            {d.title}
                                        </Text>
                                        <Text style={styles.rowMeta} numberOfLines={1}>
                                            {t(d.kindKey)} · {d.keyLabel} · {t(d.statusKey)}
                                        </Text>
                                    </View>
                                    {d.revocable && (
                                        <TouchableOpacity
                                            onPress={() => handleRevoke(mapping)}
                                            style={styles.revokeBtn}
                                            activeOpacity={0.8}
                                        >
                                            <Text style={styles.revokeBtnText}>{t('earn.forge.contributors.revoke')}</Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            );
                        })}
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

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
    explainer: {
        fontSize: 14,
        color: COLORS.textSecondary,
        lineHeight: 21,
        textAlign: 'center',
        marginTop: SPACING.s,
        marginBottom: SPACING.s,
    },
    installLine: {
        fontSize: 12,
        color: COLORS.textMuted,
        fontFamily: 'Courier',
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: COLORS.textMuted,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
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
        marginBottom: SPACING.m,
    },
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
    infoCardText: { flex: 1, fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
    commandCard: {
        backgroundColor: 'rgba(74,142,232,0.08)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.30)',
        padding: SPACING.l,
        marginBottom: SPACING.l,
    },
    commandHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.s,
    },
    commandTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
    commandBody: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19, marginBottom: SPACING.m },
    commandValueRow: {
        backgroundColor: 'rgba(11,14,20,0.85)',
        borderRadius: BORDER_RADIUS.m,
        padding: SPACING.m,
        marginBottom: SPACING.s,
    },
    commandValue: { fontSize: 13, color: COLORS.text, fontFamily: 'Courier', lineHeight: 19 },
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
    mintNote: { fontSize: 12, color: COLORS.textMuted, lineHeight: 17 },
    emptyText: { fontSize: 13, color: COLORS.textMuted, marginBottom: SPACING.l },
    listCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        padding: SPACING.m,
        marginBottom: SPACING.l,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingVertical: SPACING.s,
    },
    rowTitle: { fontSize: 13, color: COLORS.text, fontFamily: 'Courier' },
    rowMeta: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
    revokeBtn: {
        paddingHorizontal: SPACING.m,
        paddingVertical: 6,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: 'rgba(242,85,90,0.35)',
    },
    revokeBtnText: { fontSize: 12, fontWeight: '600', color: COLORS.error },
});
