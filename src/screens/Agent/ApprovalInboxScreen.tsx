import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
/**
 * ApprovalInboxScreen — Trust Layer §2.1 (app half), the HUMAN APPROVAL INBOX.
 *
 * An agent asks THIS human, through the SDK/MCP, to approve a described action.
 * The request lands here (GET /v1/wallet/approval-requests) showing the agent and
 * the plain-language action description. The human taps Approve / Reject; a
 * biometric gate opens; a `human_approval` PE is sealed on the human's OWN chain
 * (at its existing attestation tier) via the EXISTING mobile PE path
 * (ProvenanceEnvelopeManager → RelayAPIService.submitPE, which auto-attaches App
 * Attest); the request is then resolved (POST.../resolve) with the sealed
 * approval PE id + decision. The agent's next PE cites the approval as a `pe:`
 * origin and the vocabulary counts it.
 *
 * this is NOT an agent gate. Nothing here authorizes, budgets, or blocks
 * an agent action — the agent already acted or will act regardless; the human's
 * approval is a signed record that prices accountability, not a permission.
 *
 * Metadata only: the approval PE carries the agent wallet id, a decision code, the
 * subject PE id, and the action-description CONTENT HASH — never the description
 * text itself (§3 privacy).
 */
import React, { useCallback, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import type { HumanApprovalRequest } from '../../services/RelayAPIService';
import { requireBiometric } from '../../core/security/requireBiometric';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import { agentNameFor, loadAgentNameMap, type AgentNameMap } from '../../core/agents/agentNames';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';

function formatExpiry(expiresAtMs: number, t: (k: string, o?: Record<string, unknown>) => string): string {
    if (!expiresAtMs) return '';
    const diff = expiresAtMs - Date.now();
    if (diff <= 0) return t('trustLayer.approvalInbox.expired');
    return t('trustLayer.approvalInbox.expires', { time: new Date(expiresAtMs).toLocaleString() });
}

export default function ApprovalInboxScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation();

    const [requests, setRequests] = useState<HumanApprovalRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    // Item 4: show the agent's NAME (the human's name for it), never the raw wallet id.
    const [names, setNames] = useState<AgentNameMap>(new Map());
    const agentLabel = useCallback(
        (walletId: string) => agentNameFor(walletId, names) ?? t('attention.unknownAgent'),
        [names, t],
    );

    const load = useCallback(async () => {
        const [list, nameMap] = await Promise.all([
            RelayAPIService.getWalletApprovalRequests(),
            loadAgentNameMap(),
        ]);
        setRequests(list);
        setNames(nameMap);
    }, []);

    useFocusEffect(
        useCallback(() => {
            (async () => { await load(); setLoading(false); })();
        }, [load]),
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const decide = useCallback(async (req: HumanApprovalRequest, decision: 'approved' | 'rejected') => {
        if (busyId) return;
        setBusyId(req.request_id);
        try {
            return await withBiometricAction(decision === 'approved'
                ? t('trustLayer.approvalInbox.biometricApprove')
                : t('trustLayer.approvalInbox.biometricReject'), async (biometricAction) => {

                    assertBiometricAction(biometricAction);
                    // Seal the human_approval PE on this human's chain (metadata only).
                    // subject_hash anchors on the request's action-description content hash;
                    // the description text never rides the record.
                    const envelope = await ProvenanceEnvelopeManager.createEnvelope({
                        actionType: 'human_approval',
                        intentText: '',
                        assetSymbol: '',
                        amount: '0',
                        chainId: 'provian',
                        riskScore: 0,
                        riskCategory: 'low',
                        policyDecision: 'allow',
                        agentId: req.agent_wallet_id,
                        approvalMetadata: {
                            agent_wallet_id: req.agent_wallet_id,
                            decision,
                            subject_pe_id: req.subject_pe_id,
                            subject_hash: req.action_description_sha256,
                            // the request id is the mint-once anchor — the relay keys the
                            // human_approval mint on it so one request mints once, however many
                            // approval PEs are sealed against it.
                            request_id: req.request_id,
                        },
                    }, biometricAction);
                    // Mark the request resolved with the sealed approval PE id. Best-effort:
                    // the approval PE is already the substantive artifact; a resolve failure
                    // just leaves the item to lapse by its own expiry.
                    await RelayAPIService.resolveApprovalRequest(req.request_id, {
                        approval_pe_id: envelope.envelope_id,
                        decision,
                    }, biometricAction);
                    // Optimistically drop it from the list, then re-read; the bell clears with it.
                    setRequests((prev) => prev.filter((r) => r.request_id !== req.request_id));
                    requestAttentionRefresh();
                    Alert.alert(
                        decision === 'approved'
                            ? t('trustLayer.approvalInbox.approved')
                            : t('trustLayer.approvalInbox.rejected'),
                        t('trustLayer.approvalInbox.sealedAs', { id: `${envelope.envelope_id.slice(0, 18)}…` }),
                    );
                    void load();

                }, undefined);
        } catch (e) {
            Alert.alert(t('trustLayer.approvalInbox.failed'), errorDisplayCopy(e instanceof Error ? e.message : t('common.error')));
        } finally {
            setBusyId(null);
        }
    }, [busyId, load, t]);

    const confirm = useCallback((req: HumanApprovalRequest, decision: 'approved' | 'rejected') => {
        Alert.alert(
            t('trustLayer.approvalInbox.reviewTitle'),
            t('trustLayer.approvalInbox.reviewBody', { agent: agentLabel(req.agent_wallet_id) }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: decision === 'approved' ? t('common.approve') : t('common.reject'),
                    style: decision === 'approved' ? 'default' : 'destructive',
                    onPress: () => void decide(req, decision),
                },
            ],
        );
    }, [agentLabel, decide, t]);

    return (
        <SafeAreaView style={styles.safe} edges={['top']}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle} numberOfLines={1}>{t('trustLayer.approvalInbox.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.body}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.platinum} />}
            >
                <Text style={styles.lede}>{t('trustLayer.approvalInbox.subtitle')}</Text>

                {loading ? (
                    <View style={styles.center}><ActivityIndicator color={COLORS.platinum} /></View>
                ) : requests.length === 0 ? (
                    <View style={styles.center}>
                        <Ionicons name="checkmark-done-circle-outline" size={40} color={COLORS.textMuted} />
                        <Text style={styles.empty}>{t('trustLayer.approvalInbox.empty')}</Text>
                    </View>
                ) : (
                    requests.map((req) => {
                        const busy = busyId === req.request_id;
                        const expired = req.expires_at_ms > 0 && req.expires_at_ms <= Date.now();
                        return (
                            <View key={req.request_id} style={styles.card}>
                                <Text style={styles.fromAgent}>
                                    {t('trustLayer.approvalInbox.fromAgent', { agent: agentLabel(req.agent_wallet_id) })}
                                </Text>
                                {/* The described action — the human sees WHAT it is approving. */}
                                <Text style={styles.description}>{req.action_description}</Text>
                                {req.subject_pe_id && (
                                    <Text style={styles.subjectPe} numberOfLines={1} ellipsizeMode="middle">
                                        {t('trustLayer.approvalInbox.subjectPe', { id: req.subject_pe_id })}
                                    </Text>
                                )}
                                <Text style={[styles.expiry, expired && styles.expired]}>{formatExpiry(req.expires_at_ms, t)}</Text>
                                <View style={styles.actionRow}>
                                    <TouchableOpacity
                                        style={[styles.approveBtn, (busy || expired) && styles.disabled]}
                                        onPress={() => confirm(req, 'approved')}
                                        disabled={busy || expired}
                                    >
                                        {busy ? <ActivityIndicator color={COLORS.black} /> : (
                                            <>
                                                <Ionicons name="checkmark-done-circle" size={18} color={COLORS.black} />
                                                <Text style={styles.approveBtnText}>{t('common.approve')}</Text>
                                            </>
                                        )}
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={[styles.rejectBtn, (busy || expired) && styles.disabled]}
                                        onPress={() => confirm(req, 'rejected')}
                                        disabled={busy || expired}
                                    >
                                        <Text style={styles.rejectBtnText}>{t('common.reject')}</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        );
                    })
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingVertical: SPACING.s,
        backgroundColor: COLORS.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border,
    },
    headerTitle: { flex: 1, minWidth: 0, textAlign: 'center', color: COLORS.text, fontSize: 18, fontWeight: '700', marginHorizontal: SPACING.s },
    body: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
    center: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xxl, gap: SPACING.m },
    lede: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 21, marginBottom: SPACING.l },
    empty: { color: COLORS.textMuted, fontSize: 14, textAlign: 'center' },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)', borderRadius: BORDER_RADIUS.l, padding: SPACING.l,
        borderWidth: 1, borderColor: 'rgba(200,205,214,0.08)', marginBottom: SPACING.m,
    },
    fromAgent: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: SPACING.s },
    description: { color: COLORS.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
    subjectPe: { color: COLORS.textMuted, fontSize: 11, fontFamily: 'monospace', marginTop: SPACING.s },
    expiry: { color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.s },
    expired: { color: COLORS.error },
    actionRow: { flexDirection: 'row', gap: SPACING.s, marginTop: SPACING.m },
    approveBtn: {
        flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xs,
        backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.m, paddingHorizontal: SPACING.s,
    },
    approveBtnText: { flexShrink: 1, color: COLORS.black, fontSize: 14, fontWeight: '700', textAlign: 'center' },
    rejectBtn: {
        flexShrink: 1, paddingHorizontal: SPACING.l, alignItems: 'center', justifyContent: 'center',
        borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border,
    },
    rejectBtnText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    disabled: { opacity: 0.4 },
});
