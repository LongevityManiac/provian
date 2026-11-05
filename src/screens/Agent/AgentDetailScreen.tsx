import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
import i18next from 'i18next';
/**
 * AgentDetailScreen - Per-Agent Witness View
 *
 * Shows the read-only witness / earning / beneficiary view of one agent this
 * human is linked to as beneficiary (the wallet witnesses agent work and
 * mints PVT; it does not govern agents — there is no policy, autonomy, budget,
 * goal, or session-lifecycle surface here):
 * - Identity header with the shared lifecycle status
 * - Capture-health / last-activity liveness, same signal as the hub
 * - Bond status (→ BondManagement / BondClaims)
 * - Agent wallet identity (EVM + Solana addresses, external-wallet link state)
 * - The human's beneficiary earnings projection
 * - Recent PE activity with sealed earning dispositions
 * - Recovery (→ RecoverAgent) and device setup (→ ConnectAgent)
 *
 * The agent record comes from the relay's `linked_agents` (with the agent's most
 * recent relay session, when one exists, feeding the status derivation). Local
 * sessions no longer exist.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from '@react-navigation/native';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Alert,
    RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { InfoModal, InfoButton } from '../../components/InfoModal';
import type { AgentDetailScreenProps } from '../../navigation/types';
import RelayAPIService from '../../services/RelayAPIService';
import type { AgentBeneficiary, LinkedAgent } from '../../services/RelayAPIService';
import * as Clipboard from 'expo-clipboard';
import { resolveAgentDetailSource } from '../../core/agents/agentDetailResolve';
import { deriveAgentStatus } from '../../core/agents/agentStatus';
import type { AgentStatusTone } from '../../core/agents/agentStatus';
import { checkRekeyBlocked } from '../../core/agents/rekeyInFlight';
import { agentLiveness, lastActivityDisplay, lastActivityTexts, workingLine } from '../../utils/agentLiveness';
import type { AgentCaptureHealth } from '../../utils/agentLiveness';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import { buildEarningChip } from '../../utils/peDisposition';
import type { EarningChipInput } from '../../utils/peDisposition';
import { DispositionChip } from '../../components/DispositionChip';
import { requireBiometric } from '../../core/security/requireBiometric';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import RenameAgentSheet from '../../components/RenameAgentSheet';
import AgentCaptureHealthHint from './AgentCaptureHealthHint';
import AgentReplyPolicyCard from './AgentReplyPolicyCard';

// Icons
const ICONS = {
    agent: '🤖',
    activity: '📈',
    back: '←',
};

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return i18next.t('provenanceDashboard.justNow');
    if (diff < 3_600_000) return i18next.t('provenanceDashboard.minutesAgo', { count: Math.floor(diff / 60_000) });
    if (diff < 86_400_000) return i18next.t('provenanceDashboard.hoursAgo', { count: Math.floor(diff / 3_600_000) });
    return i18next.t('provenanceDashboard.daysAgo', { count: Math.floor(diff / 86_400_000) });
}

function toneColor(tone: AgentStatusTone): string {
    return tone === 'positive' ? COLORS.success : tone === 'warning' ? COLORS.warning : COLORS.textSecondary;
}

interface ActivityItem {
    id: string;
    /**
     * Raw action type resolved through the ONE display map at render time, so
     * language changes update existing rows (, pitfall #59). NEVER a per-screen humanizer:
     * the local one this replaced was a raw underscore-replace, so a namespaced
     * type ("service:github_commit") leaked to the UI as "Service:github commit".
     */
    actionType: string;
    timestamp: number;
    /**
     * Raw sealed disposition inputs, rebuilt into a translated chip at render
     * time. A legacy row without mint_status makes no earning claim.
     * Agent PEs carry no settlement projection, so the chip is amount-free.
     */
    chipInput: EarningChipInput;
}

/** The relay-backed identity this screen renders. */
interface AgentRecord {
    agentId: string;
    displayName: string;
    /** The beneficiary-linked wallet record (the only relay-side record of an agent). */
    linked: LinkedAgent | null;
}

interface BondStatus {
    has_bond: boolean;
    bond_active: boolean;
    bond_healthy: boolean;
    amount_pvt: string | null;
    renewal_deadline: number | null;
}

function isBondStatus(value: unknown): value is BondStatus {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.has_bond === 'boolean'
        && typeof v.bond_active === 'boolean'
        && typeof v.bond_healthy === 'boolean';
}

async function fetchBondStatus(agentId: string): Promise<BondStatus | null> {
    try {
        const response = await fetch(`https://api.provian.ai/v1/bonds/status/${agentId}`);
        if (!response.ok) return null;
        const data: unknown = await response.json();
        return isBondStatus(data) ? data : null;
    } catch {
        return null;
    }
}

function BondStatusBadge({ agentId, navigation }: { agentId: string; navigation: AgentDetailScreenProps['navigation'] }) {
    const { t } = useTranslation();
    const [bondStatus, setBondStatus] = useState<BondStatus | null>(null);

    useEffect(() => {
        fetchBondStatus(agentId).then((data) => {
            if (data) setBondStatus(data);
        });
    }, [agentId]);

    if (!bondStatus) return null;

    const state = bondStatus.has_bond && bondStatus.bond_active && bondStatus.bond_healthy
        ? 'active'
        : bondStatus.has_bond && bondStatus.bond_active
        ? 'expiring'
        : 'none';

    const color = state === 'active'
        ? '#4CC38A'
        : state === 'expiring'
        ? '#E8A838'
        : COLORS.textSecondary;

    const iconName = state === 'active'
        ? 'shield-checkmark' as const
        : state === 'expiring'
        ? 'shield-half' as const
        : 'shield-outline' as const;

    return (
        <View style={styles.card}>
            <TouchableOpacity
                style={styles.cardHeader}
                onPress={() => navigation.navigate('BondManagement', { agentId })}
                accessibilityRole="button"
                accessibilityLabel={i18next.t('ui.agentDetail.viewBond')}
            >
                <Ionicons name={iconName} size={18} color={color} />
                <Text style={[styles.cardTitle, { marginLeft: SPACING.s, flex: 1 }]}>
                    {t(state === 'active' ? 'ui.agentDetail.bondActive' : state === 'expiring' ? 'ui.agentDetail.bondExpiring' : 'ui.agentDetail.bondNone')}
                </Text>
                {bondStatus.amount_pvt && (
                    <Text style={[styles.policyValue, { marginRight: SPACING.s }]}>
                        {Number(bondStatus.amount_pvt).toLocaleString()} PVT
                    </Text>
                )}
                <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={COLORS.textSecondary}
                />
            </TouchableOpacity>
            <TouchableOpacity
                style={styles.inlineLinkRow}
                onPress={() => navigation.navigate('BondClaims', { agentId })}
                accessibilityRole="button"
                accessibilityLabel={t('bondManagement.claimsTitle')}
                activeOpacity={0.7}
            >
                <Ionicons name="document-text-outline" size={14} color={COLORS.primary} />
                <Text style={styles.inlineLinkText}>{t('bondManagement.claimsTitle')}</Text>
                <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
            </TouchableOpacity>
        </View>
    );
}

export default function AgentDetailScreen({ navigation, route }: AgentDetailScreenProps) {
    const { t } = useTranslation();
    const { agentId } = route.params;
    const [agent, setAgent] = useState<AgentRecord | null>(null);
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [loading, setLoading] = useState(true);
    // Accurate live PE count + Solana address from the agent's relay PEs — the
    // wallet doc's pe_count undercounts (birth + settlements only) and the relay
    // never derives an agent's Solana address (self-sovereign key).
    const [livePeCount, setLivePeCount] = useState<number | null>(null);
    // The human's beneficiary earnings from THIS agent (their cut of its eligible
    // work). Read-only projection from the relay; null on older relays / no link.
    const [beneficiary, setBeneficiary] = useState<AgentBeneficiary | null>(null);
    const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
    const [projectionInfoVisible, setProjectionInfoVisible] = useState(false);
    // Trust Layer §2.10: the human approval PE — signed by THIS wallet at its own attestation tier.
    const [approving, setApproving] = useState(false);
    // the linked human ends the beneficiary link alone (wallet auth + biometric).
    const [endingLink, setEndingLink] = useState(false);
    // Item 5: the human renames this agent from the header.
    const [renameOpen, setRenameOpen] = useState(false);

    const copyToClipboard = useCallback(async (value: string, label: string) => {
        try {
            await Clipboard.setStringAsync(value);
            Alert.alert(t('common.copied'), t('ui.agentDetail.copied', { label }));
        } catch {
            // Clipboard failures are non-fatal — the address is still shown.
        }
    }, [t]);

    const loadData = useCallback(async () => {
        try {
            // Resolve the agent from the relay's LINKED-agent record (relay
            // sessions no longer exist; an idle linked agent still opens instead of
            // dead-ending at "not found").
            const { linked_agents } = await RelayAPIService.getLinkedAgents();
            const decision = resolveAgentDetailSource(agentId, linked_agents.map((a) => a.agent_id));
            if (decision.source === 'linked') {
                const linked = linked_agents[decision.linkedIndex];
                setAgent({
                    agentId: linked.agent_id,
                    displayName: linked.display_name || linked.agent_id,
                    linked,
                });
                if (linked.solana_address) setSolanaAddress(linked.solana_address);
            } else {
                setAgent(null);
            }

            // Get activity from the agent's RELAY PEs (keyed by agent_id) — NOT the
            // phone's local PE store, which only holds this human device's PEs and
            // is empty for an agent. This surfaces the agent's real lifecycle +
            // work PEs (wallet_created, genesis_signup, badges, ...).
            const peActivity = await RelayAPIService.getAgentPEActivity(agentId);
            const agentActivity: ActivityItem[] = (peActivity?.entries ?? []).map((e) => ({
                id: e.peId,
                actionType: e.actionType,
                timestamp: e.timestamp ?? 0,
                // the relay already sends the sealed disposition per entry.
                // Render THAT rather than asserting every agent PE is "approved"
                // (agent PEs are recorded facts, not approve/deny decisions). The
                // amount, when present, is the human's BENEFICIARY projection for
                // this PE — the relay's eligible-only settlement number, NEVER a
                // record-points sum (null on minted/record_only/no-factor rows).
                chipInput: {
                    mintStatus: e.mintStatus,
                    currentSettlementProjectionPVT: e.beneficiaryProjectionPvt ?? null,
                },
            }));
            setActivity(agentActivity);
            setLivePeCount(peActivity?.pe_count ?? null);
            setBeneficiary(peActivity?.beneficiary ?? null);
            if (peActivity?.solana_address) setSolanaAddress(peActivity.solana_address);
        } catch (error) {
            console.error('[AgentDetail] Load error:', error);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Re-read on focus (e.g. returning from ConnectAgent / RecoverAgent) so the
    // status and liveness rows reflect current reality whenever the user looks.
    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    /**
     * Trust Layer §2.10 — HUMAN APPROVAL PE. The human signs an approval at its existing
     * attestation tier (biometric → device-bound envelope → the mobile lane); the agent cites
     * it as a `pe:` origin and the vocabulary counts it (approvals given / cited). The reference
     * is METADATA ONLY: agent wallet id, decision, and the subject PE (the agent's latest act) —
     * never a note or free text. `human_approval` mints at its witness-class base, but
     * mint-once anchors on an approval REQUEST id (or a subject hash): this endorsement carries
     * neither, so it records without minting. An approval answered from the Approval Inbox
     * carries the request id and mints.
     */
    const approveLatest = useCallback(async (decision: 'approved' | 'rejected') => {
        if (!agent || approving) return;
        const subject = activity[0] ?? null;
        setApproving(true);
        try {
            return await withBiometricAction(decision === 'approved' ? t('agentDetail.endorseBiometric') : t('agentDetail.disputeBiometric'), async (biometricAction) => {

                assertBiometricAction(biometricAction);
                const envelope = await ProvenanceEnvelopeManager.createEnvelope({
                    actionType: 'human_approval',
                    intentText: '',           // metadata-first: no free text rides an approval (§3 privacy)
                    assetSymbol: '',
                    amount: '0',
                    chainId: 'provian',
                    riskScore: 0,
                    riskCategory: 'low',
                    policyDecision: 'allow',
                    agentId: agent.agentId,
                    approvalMetadata: {
                        agent_wallet_id: agent.agentId,
                        decision,
                        subject_pe_id: subject ? subject.id : null,
                        subject_hash: null,
                    },
                }, biometricAction);
                Alert.alert(
                    decision === 'approved' ? t('agentDetail.endorseRecorded') : t('agentDetail.disputeRecorded'),
                    t('agentDetail.endorseSealed', { id: `${envelope.envelope_id.slice(0, 18)}\u2026`, agent: agent.displayName }),
                );
                void loadData();

            }, undefined);
        } catch (e) {
            Alert.alert(t('agentDetail.endorseFailed'), errorDisplayCopy(e instanceof Error ? e.message : t('common.error')));
        } finally {
            setApproving(false);
        }
    }, [agent, activity, approving, loadData]);

    /**
     * End the beneficiary link, alone. Two deliberate steps, like the accept:
     * a confirmation that says exactly what changes and what does not, then a biometric, then the
     * wallet-auth call. The agent keeps its wallet, record and credentials; everything already
     * recorded still settles to you as it was sealed; its future work stops routing to you.
     */
    const confirmEndLink = useCallback(() => {
        const linked = agent?.linked;
        if (!agent || !linked || endingLink) return;
        Alert.alert(
            t('agentDetail.endLinkConfirmTitle', { agent: agent.displayName }),
            t('agentDetail.endLinkConfirmBody', { agent: agent.displayName }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('agentDetail.endLinkConfirm'),
                    style: 'destructive',
                    onPress: () => {
                        void (async () => {
                            setEndingLink(true);
                            try {
                                return await withBiometricAction(t('agentDetail.endLinkBiometric', { agent: agent.displayName }), async (biometricAction) => {

                                    try {
                                        assertBiometricAction(biometricAction);
                                    } catch {
                                        Alert.alert(t('agentDetail.endLinkFailed'), t('agentDetail.endLinkBiometricRequired'));
                                        return;
                                    }
                                    const result = await RelayAPIService.endAgentLink(linked.wallet_id, biometricAction);
                                    if (!result.ok) {
                                        Alert.alert(t('agentDetail.endLinkFailed'), errorDisplayCopy(result.error));
                                        return;
                                    }
                                    Alert.alert(
                                        t('agentDetail.endLinkDoneTitle'),
                                        t('agentDetail.endLinkDoneBody', { agent: agent.displayName }),
                                        [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                                    );

                                }, undefined);
                            } finally {
                                setEndingLink(false);
                            }
                        })();
                    },
                },
            ],
        );
    }, [agent, endingLink, navigation, t]);

    if (loading) {
        return (
            <SafeAreaView style={styles.loadingContainer}>
                <Text style={styles.loadingText}>{i18next.t('common.loading')}</Text>
            </SafeAreaView>
        );
    }

    if (!agent) {
        return (
            <SafeAreaView style={styles.errorContainer}>
                <Text style={styles.errorText}>{i18next.t('ui.agentDetail.notFound')}</Text>
                <TouchableOpacity onPress={() => navigation.goBack()}>
                    <Text style={styles.errorBack}>{ICONS.back} {t('common.goBack')}</Text>
                </TouchableOpacity>
            </SafeAreaView>
        );
    }

    const walletInfo = agent.linked;
    const status = deriveAgentStatus({ linked: walletInfo, livePeCount });
    const statusColor = toneColor(status.tone);

    // liveness reads the EARNING device's capture-health (the direct
    // "is it receiving NOW" signal the relay enriches onto each linked agent),
    // falling back to the day-granular last_pe_date — the SAME derivation the
    // Agent Hub card uses, so the two surfaces cannot disagree.
    const capture: AgentCaptureHealth | null =
        walletInfo && (walletInfo.capture_broken != null || walletInfo.last_capture_at_ms != null)
            ? {
                  broken: walletInfo.capture_broken === true,
                  lastCaptureAtMs: walletInfo.last_capture_at_ms ?? null,
                  brokenReason: walletInfo.capture_broken_reason ?? null,
              }
            : null;
    const liveness = agentLiveness(walletInfo?.last_pe_date, Date.now(), undefined, capture);
    // what is SHOWN is a real moment (capture, else the newest PE's timestamp) or a bare
    // date — never liveness.lastPeAtMs, which is the end-of-UTC-day judging value for a
    // day-granular last_pe_date and rendered a future "Last active 6:59:59 PM".
    const lastActivity = lastActivityTexts(
        lastActivityDisplay(walletInfo?.last_pe_date, capture, Date.now(), activity.length > 0 ? activity[0].timestamp : null),
        t,
        formatRelativeTime,
    );
    const working = workingLine({
        liveness,
        lastActivityRelative: lastActivity?.relative ?? null,
        brokenSinceMs: walletInfo?.capture_broken_since_ms ?? null,
        relative: formatRelativeTime,
        nowMs: Date.now(),
    });
    const livenessColor = working.tone === 'live' ? COLORS.success : working.tone === 'stale' ? COLORS.error : COLORS.warning;

    return (
        <SafeAreaView style={styles.container}>
            {/* Fixed header bar (back + the agent's name + rename): content scrolls BELOW it,
                never under a floating back button. */}
            <View style={styles.navBar}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.navTitle} numberOfLines={1}>{agent.displayName}</Text>
                {walletInfo ? (
                    <TouchableOpacity
                        style={styles.navAction}
                        onPress={() => setRenameOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('agentName.renameAccessibility', { name: agent.displayName })}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="create-outline" size={20} color={COLORS.text} />
                    </TouchableOpacity>
                ) : (
                    <View style={styles.navSpacer} />
                )}
            </View>
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
                }
            >
                {/* Agent Header — the shared lifecycle status, so this agent
                    reads identically here, on the hub, and on the wallet home. */}
                <View style={styles.header}>
                    <View style={styles.agentIcon}>
                        <Text style={styles.agentIconText}>{ICONS.agent}</Text>
                    </View>
                    <Text style={styles.agentName}>{agent.displayName}</Text>
                    <View style={[styles.statusBadge, { backgroundColor: `${statusColor}24` }]}>
                        <Text style={[styles.statusText, { color: statusColor }]}>{t(status.labelKey)}</Text>
                    </View>
                    {walletInfo?.platform ? (
                        <Text style={styles.agentType}>{walletInfo.platform}</Text>
                    ) : null}
                </View>

                {/* Liveness — is this agent's work reaching us right now? Only a
                    linked wallet carries the capture-health / last-PE fields. */}
                {walletInfo && (
                    <View style={styles.card}>
                        <View style={styles.workingRow}>
                            <Ionicons
                                name={working.tone === 'live' ? 'pulse' : working.tone === 'stale' ? 'alert-circle' : 'ellipse-outline'}
                                size={16}
                                color={livenessColor}
                            />
                            <Text style={[styles.workingText, { color: livenessColor }]}>
                                {t(working.key, working.time === null
                                    ? { name: agent.displayName }
                                    : { name: agent.displayName, time: working.time })}
                            </Text>
                        </View>
                        {lastActivity !== null && (
                            <Text style={styles.workingMeta}>
                                {t('agentHub.lastActive', { time: lastActivity.absolute })}
                            </Text>
                        )}
                        {liveness.state !== 'live' && (
                            <AgentCaptureHealthHint
                                reason={walletInfo.capture_broken_reason ?? null}
                                reported={walletInfo.capture_reported_at_ms != null}
                            />
                        )}
                    </View>
                )}

                {/* talk to your agent directly — an end-to-end encrypted Commons thread.
                    Free: a beneficiary link is an open relationship, so no speech window is needed. */}
                {walletInfo && (
                    <TouchableOpacity
                        style={[styles.card, { flexDirection: 'row', alignItems: 'center' }]}
                        activeOpacity={0.7}
                        onPress={() => navigation.navigate('CommonsThread', { counterparty: walletInfo.wallet_id, counterpartyName: agent.displayName })}
                        accessibilityRole="button"
                        accessibilityLabel={t('commons.messageAgent', { name: agent.displayName })}
                    >
                        <Ionicons name="chatbubbles-outline" size={20} color={COLORS.primary} />
                        <View style={{ flex: 1, minWidth: 0, marginLeft: SPACING.m }}>
                            <Text style={styles.cardTitle}>{t('commons.messageAgent', { name: agent.displayName })}</Text>
                            <Text style={styles.workingMeta}>{t('commons.messageLinkedSub')}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                    </TouchableOpacity>
                )}

                {/* item 4: how this agent answers Commons mail — anyone, or ask me first. */}
                {walletInfo && <AgentReplyPolicyCard walletId={walletInfo.wallet_id} agentName={agent.displayName} />}

                {/* Bond Status */}
                <BondStatusBadge agentId={agentId} navigation={navigation} />

                {/* Wallet Identity Card - agents with wallets */}
                {walletInfo && (
                    <View style={styles.card}>
                        <View style={styles.cardHeader}>
                            <Ionicons name="wallet-outline" size={18} color={COLORS.primary} />
                            <Text style={[styles.cardTitle, { marginLeft: 8 }]}>{i18next.t('ui.agentDetail.wallet')}</Text>
                        </View>
                        <View style={{ marginTop: SPACING.s }}>
                            <View style={styles.walletStats}>
                                <Text style={styles.walletStat}>{t('agentDetail.peCount', { count: livePeCount ?? walletInfo.pe_count })}</Text>
                            </View>
                            <Text style={[styles.walletStat, { marginTop: SPACING.s, fontSize: 11, color: COLORS.textMuted }]}>
                                {walletInfo.platform} · EVM (Base / Arbitrum / Optimism)
                            </Text>
                            <TouchableOpacity
                                onPress={() => copyToClipboard(walletInfo.address, t('ui.agentDetail.evmAddress'))}
                                activeOpacity={0.7}
                                style={styles.addressRow}
                            >
                                <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                                    {walletInfo.address}
                                </Text>
                                <Ionicons name="copy-outline" size={16} color={COLORS.primary} style={{ marginLeft: 8 }} />
                            </TouchableOpacity>
                            {(() => {
                                const sol = solanaAddress || walletInfo.solana_address || null;
                                return sol ? (
                                    <TouchableOpacity
                                        onPress={() => copyToClipboard(sol, t('ui.agentDetail.solanaAddress'))}
                                        activeOpacity={0.7}
                                        style={styles.addressRow}
                                    >
                                        <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                                            SOL: {sol}
                                        </Text>
                                        <Ionicons name="copy-outline" size={16} color={COLORS.primary} style={{ marginLeft: 8 }} />
                                    </TouchableOpacity>
                                ) : (
                                    <Text style={styles.addressHint}>
                                        {i18next.t('ui.agentDetail.solanaHint')}</Text>
                                );
                            })()}
                            {/* Attestation tier only, NO multiplier: "0.8x" came from
                                pe-weight-framework's retired float table, which C-2
                                quarantined from every user-facing earnings surface.
                                The tier itself is accurate — agent-owned devices are
                                forced to `software` server-side (invariant #9). */}
                            <View style={[styles.policyRow, { marginTop: SPACING.s }]}>
                                <Text style={styles.policyLabel}>{i18next.t('ui.agentDetail.attestation')}</Text>
                                <Text style={styles.policyValue}>{i18next.t('ui.agentDetail.software')}</Text>
                            </View>
                            {/* External-wallet link status : the linked human
                                links a third-party wallet to this agent in-app — both rows open
                                the Link-a-wallet flow, which also lists the linked addresses. */}
                            <TouchableOpacity
                                onPress={() => navigation.navigate('LinkExternalWallet', {
                                    walletId: walletInfo.wallet_id,
                                    agentName: agent.displayName,
                                })}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                style={styles.externalRow}
                            >
                                <Ionicons
                                    name={walletInfo.external_address_linked ? 'link' : 'link-outline'}
                                    size={14}
                                    color={walletInfo.external_address_linked ? COLORS.success : COLORS.primary}
                                />
                                <Text
                                    style={[
                                        styles.externalRowText,
                                        walletInfo.external_address_linked && { color: COLORS.success },
                                    ]}
                                >
                                    {walletInfo.external_address_linked
                                        ? t('agentHub.externalLinkedRow')
                                        : t('agentHub.externalNotLinkedRow')}
                                </Text>
                                <Ionicons name="chevron-forward" size={14} color={COLORS.textMuted} />
                            </TouchableOpacity>
                        </View>
                        {/* Wallet actions: recover the wallet. */}
                        <View style={styles.walletActions}>
                            <TouchableOpacity
                                style={styles.walletActionButton}
                                accessibilityRole="button"
                                accessibilityLabel={t('agentHub.recoverAgentAccessibility')}
                                onPress={() => navigation.navigate('RecoverAgent', {
                                    walletId: walletInfo.wallet_id,
                                    agentName: agent.displayName,
                                })}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="key-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.walletActionText}>{t('recoverAgent.title')}</Text>
                            </TouchableOpacity>
                            {/* Direct re-key entry : reachable straight from the agent's screen,
                                not only after a failed recovery. Refused with a clear message when a
                                re-key is already in flight / within its post-re-key cooldown. */}
                            <TouchableOpacity
                                style={styles.walletActionButton}
                                accessibilityRole="button"
                                accessibilityLabel={t('rekeyAgent.title')}
                                onPress={async () => {
                                    const block = await checkRekeyBlocked(walletInfo.wallet_id);
                                    if (block.blocked) {
                                        Alert.alert(
                                            t('rekeyAgent.blockedTitle'),
                                            block.reason === 'in_flight'
                                                ? t('rekeyAgent.blockedInFlight')
                                                : t('rekeyAgent.blockedCooldown'),
                                        );
                                        return;
                                    }
                                    navigation.navigate('RekeyAgent', {
                                        walletId: walletInfo.wallet_id,
                                        agentName: agent.displayName,
                                    });
                                }}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="sync-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.walletActionText}>{t('rekeyAgent.title')}</Text>
                            </TouchableOpacity>
                        </View>
                        {/* link a third-party wallet; set up card spending
                            through Stripe Link (Provian never holds the card). */}
                        <View style={styles.walletActions}>
                            <TouchableOpacity
                                style={styles.walletActionButton}
                                accessibilityRole="button"
                                accessibilityLabel={t('agentHub.linkWalletCta')}
                                onPress={() => navigation.navigate('LinkExternalWallet', {
                                    walletId: walletInfo.wallet_id,
                                    agentName: agent.displayName,
                                })}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="wallet-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.walletActionText}>{t('agentHub.linkWalletCta')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.walletActionButton}
                                accessibilityRole="button"
                                accessibilityLabel={t('agentHub.cardSpendingCta')}
                                onPress={() => navigation.navigate('AgentCardSpending', {
                                    walletId: walletInfo.wallet_id,
                                    agentName: agent.displayName,
                                })}
                                activeOpacity={0.7}
                            >
                                <Ionicons name="card-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.walletActionText}>{t('agentHub.cardSpendingCta')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}

                {/* Your Beneficiary Earnings — the human's projected cut under
                    the current settlement state. Every figure is the relay's eligible-only
                    settlement projection; never record points. When
                    no live rate is available the headline falls back to the PE
                    count, never a record-points sum. */}
                {beneficiary && (
                    <View style={styles.card}>
                        <View style={styles.cardHeader}>
                            <Ionicons name="cash-outline" size={18} color={COLORS.platinum} />
                            <Text style={[styles.cardTitle, { marginLeft: SPACING.s }]}>{t('agentDetail.beneficiaryEarnings')}</Text>
                            {beneficiary.projection_available && (
                                <InfoButton onPress={() => setProjectionInfoVisible(true)} />
                            )}
                        </View>
                        <View style={{ alignItems: 'center', marginVertical: SPACING.m }}>
                            {beneficiary.projection_available ? (
                                <>
                                    <Text style={styles.beneficiaryHeadline}>
                                        ~{beneficiary.projected_pending_pvt} PVT
                                    </Text>
                                    <Text style={styles.beneficiaryCaption}>
                                        {t('agentDetail.projectedPendingNonFinal')}
                                    </Text>
                                </>
                            ) : (
                                <>
                                    <Text style={styles.beneficiaryHeadline}>
                                        {t('agentDetail.peCount', { count: beneficiary.pe_count })}
                                    </Text>
                                    <Text style={styles.beneficiaryCaption}>
                                        {t('agentDetail.routedProjectionUnavailable')}
                                    </Text>
                                </>
                            )}
                        </View>
                        <View>
                            <View style={styles.policyRow}>
                                <Text style={styles.policyLabel}>{t('agentDetail.yourShare')}</Text>
                                <Text style={styles.policyValue}>{beneficiary.human_share_bps / 100}%</Text>
                            </View>
                            <View style={[styles.policyRow, { borderBottomWidth: 0 }]}>
                                <Text style={styles.policyLabel}>{t('agentDetail.pesRoutedToYou')}</Text>
                                <Text style={styles.policyValue}>{beneficiary.pe_count}</Text>
                            </View>
                        </View>
                        <Text style={styles.beneficiaryNote}>
                            {t('agentDetail.beneficiaryProjectionNote', { share: beneficiary.human_share_bps / 100 })}
                        </Text>
                    </View>
                )}

                {/* The beneficiary link is yours: end it alone. */}
                {agent.linked && (
                    <View style={styles.card}>
                        <View style={styles.cardHeader}>
                            <Ionicons name="link-outline" size={18} color={COLORS.platinum} />
                            <Text style={[styles.cardTitle, { marginLeft: SPACING.s }]}>{t('agentDetail.endLinkTitle')}</Text>
                        </View>
                        <Text style={styles.approveHint}>{t('agentDetail.endLinkHint', { agent: agent.displayName })}</Text>
                        <TouchableOpacity
                            style={[styles.endLinkBtn, endingLink && styles.approveBtnDisabled]}
                            onPress={confirmEndLink}
                            disabled={endingLink}
                            accessibilityRole="button"
                            accessibilityLabel={t('agentDetail.endLinkButton')}
                        >
                            <Ionicons name="unlink-outline" size={18} color={COLORS.error} />
                            <Text style={styles.endLinkBtnText}>{endingLink ? t('agentDetail.endLinkWorking') : t('agentDetail.endLinkButton')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Recent Activity */}
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Text style={styles.cardIcon}>{ICONS.activity}</Text>
                        <Text style={styles.cardTitle}>{i18next.t('dashboard.recentActivity')}</Text>
                    </View>
                    {/* §2.10: the human proactively ENDORSES the agent's latest work — distinct from
                        the Approval Inbox, where the human RESPONDS to an agent's explicit request.
                        Deliberately styled unlike the inbox's platinum "Approve" (outline + ribbon)
                        so the two are never confused. */}
                    <View style={styles.approveRow}>
                        <TouchableOpacity style={[styles.endorseBtn, approving && styles.approveBtnDisabled]} onPress={() => void approveLatest('approved')} disabled={approving}>
                            <Ionicons name="ribbon-outline" size={18} color={COLORS.platinum} />
                            <Text style={styles.endorseBtnText}>{activity.length > 0 ? t('agentDetail.endorseLatest') : t('agentDetail.endorse')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.rejectBtn, approving && styles.approveBtnDisabled]} onPress={() => void approveLatest('rejected')} disabled={approving}>
                            <Text style={styles.rejectBtnText}>{t('agentDetail.dispute')}</Text>
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.approveHint}>
                        {activity.length > 0
                            ? t('agentDetail.endorseHintFor', { label: getActionTypeDisplay(activity[0].actionType).label })
                            : t('agentDetail.endorseHint')}
                    </Text>
                    {activity.length > 0 ? (
                        activity.slice(0, 5).map((item) => (
                            <View key={item.id} style={styles.activityRow}>
                                <View style={styles.activityIcon}>
                                    <Text>{getActionTypeDisplay(item.actionType).emoji}</Text>
                                </View>
                                <View style={styles.activityContent}>
                                    <Text style={styles.activityMerchant}>
                                        {getActionTypeDisplay(item.actionType).label}
                                    </Text>
                                    <Text style={styles.activityTime}>
                                        {new Date(item.timestamp).toLocaleString()}
                                    </Text>
                                </View>
                                <DispositionChip chip={buildEarningChip(item.chipInput)} />
                            </View>
                        ))
                    ) : (
                        <Text style={styles.noActivityText}>{i18next.t('ui.agentDetail.noActivity')}</Text>
                    )}
                </View>
            </ScrollView>
            <InfoModal
                visible={projectionInfoVisible}
                onClose={() => setProjectionInfoVisible(false)}
                title={t('pvtProjectionInfo.title')}
                body={t('pvtProjectionInfo.body')}
            />
            <RenameAgentSheet
                visible={renameOpen}
                agentWalletId={walletInfo?.wallet_id ?? null}
                currentName={agent.displayName}
                onClose={() => setRenameOpen(false)}
                onSaved={(displayName) => {
                    setRenameOpen(false);
                    setAgent((prev) => (prev ? { ...prev, displayName } : prev));
                    void loadData();
                }}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    approveRow: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.xs },
    approveBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xs, backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s },
    approveBtnDisabled: { opacity: 0.4 },
    approveBtnText: { color: COLORS.black, fontSize: 14, fontWeight: '700' },
    // Endorse = outline + platinum text (NOT the inbox's platinum-fill "Approve"), so the human
    // never confuses proactively endorsing work with responding to an approval request.
    endorseBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xs, backgroundColor: 'transparent', borderWidth: 1, borderColor: COLORS.platinum, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s },
    endorseBtnText: { color: COLORS.platinum, fontSize: 14, fontWeight: '700' },
    rejectBtn: { paddingHorizontal: SPACING.l, alignItems: 'center', justifyContent: 'center', borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border },
    rejectBtnText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
    approveHint: { color: COLORS.textMuted, fontSize: 12, lineHeight: 17, marginBottom: SPACING.m },
    endLinkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xs, backgroundColor: 'transparent', borderWidth: 1, borderColor: COLORS.error, borderRadius: BORDER_RADIUS.m, paddingVertical: SPACING.s },
    endLinkBtnText: { color: COLORS.error, fontSize: 14, fontWeight: '700' },
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: COLORS.background,
    },
    loadingText: {
        color: '#8B929E',
        fontSize: 16,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: COLORS.background,
    },
    errorText: {
        color: '#F2555A',
        fontSize: 18,
        marginBottom: SPACING.m,
    },
    errorBack: {
        color: '#4A8EE8',
        fontSize: 16,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxxl,
    },

    // Nav — a fixed header bar on the screen background (hairline divider below).
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        backgroundColor: COLORS.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: COLORS.border,
    },
    navTitle: {
        flex: 1,
        minWidth: 0,
        textAlign: 'center',
        fontSize: 17,
        fontWeight: '700',
        color: COLORS.text,
        marginHorizontal: SPACING.s,
    },
    navAction: {
        width: BACK_BUTTON_SIZE,
        height: BACK_BUTTON_SIZE,
        borderRadius: BORDER_RADIUS.round,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    navSpacer: {
        width: BACK_BUTTON_SIZE,
    },

    // Header
    header: {
        alignItems: 'center',
        marginBottom: SPACING.l,
    },
    agentIcon: {
        width: 80,
        height: 80,
        borderRadius: 22,
        backgroundColor: 'rgba(155, 109, 255, 0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    agentIconText: {
        fontSize: 40,
    },
    agentName: {
        fontSize: 24,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        alignSelf: 'stretch',
        paddingHorizontal: SPACING.s,
    },
    statusBadge: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: BORDER_RADIUS.round,
        marginTop: SPACING.s,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '600',
        color: COLORS.text,
    },
    agentType: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: SPACING.xs,
    },

    // Liveness
    workingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
    },
    workingText: {
        flex: 1,
        fontSize: 13,
        fontWeight: '600',
        lineHeight: 18,
    },
    workingMeta: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: SPACING.xs,
    },

    // Cards
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        padding: SPACING.l,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    cardIcon: {
        fontSize: 20,
        marginRight: SPACING.s,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        flex: 1,
        minWidth: 0,
    },
    inlineLinkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: -SPACING.xs,
    },
    inlineLinkText: {
        flex: 1,
        fontSize: 13,
        fontWeight: '600',
        color: COLORS.primary,
    },

    // Wallet
    walletStats: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: SPACING.s,
    },
    walletStat: {
        fontSize: 12,
        color: '#8B929E',
    },
    addressRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: SPACING.xs,
    },
    addressText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: COLORS.textSecondary,
        fontFamily: 'monospace',
    },
    addressHint: {
        marginTop: SPACING.xs,
        fontSize: 11,
        color: COLORS.textMuted,
        fontStyle: 'italic',
    },
    // the actions STACK full-width. Three across on a 320dp phone left each
    // button ~80dp wide, so words broke mid-word ("Reco/ver agent") and "Set up a
    // device for this agent" ran to six lines. A column never has to fit them side by side.
    walletActions: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: SPACING.s,
        marginTop: SPACING.m,
    },
    externalRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.s },
    externalRowText: { flex: 1, minWidth: 0, fontSize: 12, color: COLORS.textSecondary },
    walletActionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: SPACING.s,
        paddingVertical: SPACING.s + SPACING.xs,
        paddingHorizontal: SPACING.m,
        backgroundColor: 'rgba(74, 142, 232, 0.14)',
        borderRadius: 10,
    },
    walletActionText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        fontWeight: '600',
        color: COLORS.primary,
    },

    // Key/value rows
    // Label/value rows wrap at 320pt instead of running together.
    policyRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        columnGap: SPACING.m,
        rowGap: SPACING.xs,
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    policyLabel: {
        flexShrink: 0,
        fontSize: 14,
        color: '#8B929E',
    },
    policyValue: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        textAlign: 'right',
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.text,
    },

    // Beneficiary
    beneficiaryHeadline: {
        fontSize: 30,
        fontWeight: '800',
        color: COLORS.platinum,
    },
    beneficiaryCaption: {
        fontSize: 12,
        color: COLORS.textMuted,
        marginTop: 2,
    },
    beneficiaryNote: {
        fontSize: 11,
        color: COLORS.textMuted,
        lineHeight: 16,
        marginTop: SPACING.s,
    },

    // Activity
    activityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    activityIcon: {
        width: 32,
        height: 32,
        borderRadius: 10,
        backgroundColor: 'rgba(0, 230, 118, 0.14)',
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: SPACING.m,
    },
    activityContent: {
        flex: 1,
        minWidth: 0,
    },
    activityMerchant: {
        fontSize: 14,
        fontWeight: '500',
        color: COLORS.text,
    },
    activityTime: {
        fontSize: 12,
        color: '#8B929E',
    },
    noActivityText: {
        fontSize: 14,
        color: '#8B929E',
        fontStyle: 'italic',
        textAlign: 'center',
        paddingVertical: SPACING.m,
    },
});
