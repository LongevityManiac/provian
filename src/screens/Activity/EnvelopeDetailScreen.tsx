import { enumDisplayCopy } from '../../i18n/displayCopy';
import i18next from 'i18next';
/**
 * EnvelopeDetailScreen - Provenance Envelope Details
 *
 * Shows complete details of a single provenance envelope:
 * - Action type and timestamp
 * - Agent and authorization details
 * - Risk evaluation breakdown
 * - Chain signature verification
 * - Raw envelope data for transparency
 */

import React, { useCallback, useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants/theme';
import { InfoModal, InfoButton } from '../../components/InfoModal';
import { useTranslation } from 'react-i18next';
import type { EnvelopeDetailScreenProps } from '../../navigation/types';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import type { RiskLevel } from '../../core/provenance/types';
import RelayAPIService from '../../services/RelayAPIService';
import type { PVTHistoryEntry } from '../../services/RelayAPIService';
import TransactionHistoryService from '../../core/history/TransactionHistoryService';
import type { Transaction } from '../../core/history/TransactionHistoryService';
import { useWalletStore } from '../../store/walletStore';
import { getActionTypeDisplay, getActionTypeDescription } from '../../utils/actionTypeDisplay';
import { buildEarningChip } from '../../utils/peDisposition';
import { DispositionChip } from '../../components/DispositionChip';
import {
    hasTrustDetail,
    ORIGIN_CLASS_ORDER,
    type OriginClass,
    type PeInputOriginView,
    type PeTrustDetail,
} from '../../utils/peTrustDetail';
import BackButton from '../../components/BackButton';
import { heldEnvelopeDetail, type EnvelopeDetailView } from '../../core/meter/envelopeDetailRecord';
import { agentNameForRecord, loadAgentNameMaps } from '../../core/agents/agentNames';

// Action types that represent crypto movements with a corresponding on-chain
// transaction. Used to gate the "View Transaction" cross-link below - only
// PEs of these types are candidates for matching against on-chain history.
const CRYPTO_TX_ACTION_TYPES = new Set(['send', 'receive', 'swap', 'approve']);

// Tolerance for matching a PE to a Transaction by timestamp. The PE is
// usually created within seconds of the on-chain confirmation, but allow
// 5 minutes either way to absorb client clock skew + chain finality delay.
const PE_TX_MATCH_WINDOW_MS = 5 * 60 * 1000;

const RISK_COLORS: Record<RiskLevel, string> = {
    low: '#4CC38A',
    medium: '#E8A838',
    high: '#F2555A',
    critical: '#F2555A',
    null_state: '#9CA3AF',
};

function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function truncateHash(hash: string, chars = 12): string {
    if (hash.length <= chars * 2) return hash;
    return `${hash.slice(0, chars)}...${hash.slice(-chars)}`;
}

interface DetailRowProps {
    label: string;
    value: string;
    copyable?: boolean;
    valueColor?: string;
    /** Full underlying value to copy when `value` is a truncated display
     *  string (e.g. truncateHash output). Defaults to `value`. Without
     *  this, tapping copy on a truncated field wrote the truncated,
     *  invalid string to the clipboard instead of the real address/hash. */
    copyValue?: string;
}

function DetailRow({ label, value, copyable, valueColor, copyValue }: DetailRowProps) {
    const { t } = useTranslation();
    // I-U-11: previously this fired an Alert saying "Copied" without
    // actually writing to the clipboard - the Clipboard.setString call
    // was commented out. Wired to the real expo-clipboard API.
    const handleCopy = async () => {
        await Clipboard.setStringAsync(copyValue ?? value);
        Alert.alert(t('common.copied'), t('envelope.valueCopied'));
    };

    return (
        <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{label}</Text>
            <View style={styles.detailValueContainer}>
                <Text
                    style={[styles.detailValue, valueColor && { color: valueColor }]}
                    numberOfLines={2}
                >
                    {value}
                </Text>
                {copyable && (
                    <TouchableOpacity onPress={handleCopy} style={styles.copyButton}>
                        <Ionicons name="copy" size={14} color="#9CA3AF" />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
}

export default function EnvelopeDetailScreen({
    navigation,
    route,
}: EnvelopeDetailScreenProps) {
    const { t } = useTranslation();
    const { envelopeId } = route.params;
    const insets = useSafeAreaInsets();
    const walletAddress = useWalletStore((s) => s.address);
    const [envelope, setEnvelope] = useState<EnvelopeDetailView | null>(null);
    const [recordKind, setRecordKind] = useState<'v1' | 'v2' | 'projection'>('projection');
    const [rawEnvelope, setRawEnvelope] = useState<unknown>(null);
    const [loading, setLoading] = useState(true);
    const [showRawData, setShowRawData] = useState(false);
    const [projectionInfoVisible, setProjectionInfoVisible] = useState(false);
    // the SECOND data read — the PVT history record for this PE, carrying the
    // earning fields (mint disposition, eligible-only projection, record points,
    // exact Genesis reserved gross, commit SHA). Kept separate from the envelope so
    // the earning line is correct even when the base envelope came via the
    // metadata-dropping relay history mapping.
    const [historyEntry, setHistoryEntry] = useState<PVTHistoryEntry | null>(null);
    // Trust Layer §2.2: witness class, evidence class, output digests, input
    // origins (pe: resolved), consumption count, hardware-attestation slot,
    // supervision / model / environment, adverse linkage. Read from the canonical
    // relay PE doc; null while loading or when the relay carries none of it.
    const [trust, setTrust] = useState<PeTrustDetail | null>(null);
    // Cross-link state: if this PE matches an on-chain transaction in the
    // user's history, store it here so the "View Transaction" button can
    // navigate directly to TransactionDetail without another lookup.
    const [matchedTransaction, setMatchedTransaction] = useState<Transaction | null>(null);
    // item 10: the human's name for the agent this PE names (the ID row stays: identity is the key).
    const [agentName, setAgentName] = useState<string | null>(null);
    const envelopeAgentId = envelope?.agent_id ?? null;
    useEffect(() => {
        if (!envelopeAgentId) { setAgentName(null); return; }
        let live = true;
        void loadAgentNameMaps().then((maps) => {
            if (live) setAgentName(agentNameForRecord({ agentId: envelopeAgentId }, maps));
        });
        return () => { live = false; };
    }, [envelopeAgentId]);

    const loadEnvelope = useCallback(async () => {
        try {
            try {
                const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
                const meter = getPhoneMeter();
                await meter.start();
                const held = await heldEnvelopeDetail(meter.store, envelopeId);
                if (held) {
                    setEnvelope(held.envelope);
                    setRawEnvelope(held.raw);
                    setRecordKind(held.kind);
                    return;
                }
            } catch (error: unknown) {
                console.warn('[EnvelopeDetail] Held proof read failed:', error);
            }
            // Legacy storage remains available for pre-meter proofs.
            const all = await ProvenanceEnvelopeManager.getHistory();
            let found: EnvelopeDetailView | undefined = all.find((e) => e.envelope_id === envelopeId);
            if (!found) {
                // PE may be in tiered storage (post-migration)
                try {
                    const { default: PELifecycleManager } = await import('../../core/provenance/PELifecycleManager');
                    const result = await PELifecycleManager.queryPEs({ limit: 500 });
                    found = result.envelopes.find((e) => e.envelope_id === envelopeId);
                } catch {
                    // Lifecycle manager not available - skip
                }
            }

            // If still not found locally, fetch from relay (server-side PEs)
            if (!found) {
                console.log('[EnvelopeDetail] PE not found locally, fetching from relay...');
                try {
                    // Try PVT history endpoint first (includes estimated PVT and attestation data)
                    const historyResponse = await RelayAPIService.getPVTHistory(500, 0, true);
                    if (historyResponse) {
                        const historyEntry = historyResponse.entries.find((e) => e.peId === envelopeId || e.clientPeId === envelopeId);
                        if (historyEntry) {
                            found = mapHistoryEntryToEnvelope(historyEntry);
                        }
                    }

                    // If not in PVT history, try the full PE endpoint
                    if (!found) {
                        const relayPEs = await RelayAPIService.getProvenanceEnvelopes(500, 0);
                        if (relayPEs && relayPEs.length > 0) {
                            found = relayPEs.find((pe: any) => pe.envelope_id === envelopeId);
                        }
                    }
                } catch (error: unknown) {
                    console.warn('[EnvelopeDetail] Relay fetch failed:', error);
                }
            }

            setEnvelope(found || null);
            setRawEnvelope(found ?? null);
            setRecordKind(found?.signature ? 'v1' : 'projection');
        } catch (error: unknown) {
            console.error('[EnvelopeDetail] Load error:', error);
        } finally {
            setLoading(false);
        }
    }, [envelopeId]);

    /** A history projection carries no chain predecessor or signature evidence. */
    const mapHistoryEntryToEnvelope = (entry: PVTHistoryEntry): EnvelopeDetailView => ({
        envelope_id: entry.peId,
        timestamp: entry.timestamp,
        action_type: entry.actionType,
        intent_text: entry.description,
        hidden: entry.hidden,
        authorization_merchant: entry.paymentMethod,
    });

    useEffect(() => {
        loadEnvelope();
    }, [loadEnvelope]);

    // second read — fetch this PE's earning record from PVT history. Best
    // effort: a failure just hides the earning section, never blocks the screen.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const resp = await RelayAPIService.getPVTHistory(500, 0, true);
                if (cancelled || !resp) return;
                const match = resp.entries.find((e) => e.peId === envelopeId || e.clientPeId === envelopeId);
                if (match) setHistoryEntry(match);
            } catch {
                // Non-fatal — earning section simply won't render.
            }
        })();
        return () => { cancelled = true; };
    }, [envelopeId]);

    // Trust Layer §2.2: fetch the trust-layer view of this PE. Best effort —
    // a failure or an all-empty detail simply hides the section. Metadata only.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const detail = await RelayAPIService.getPETrustDetail(envelopeId);
                if (!cancelled) setTrust(detail);
            } catch {
                // Non-fatal — the Trust Layer section simply won't render.
            }
        })();
        return () => { cancelled = true; };
    }, [envelopeId]);

    // Cross-link: PE → Transaction
    //
    // ProvenanceEnvelope doesn't carry a `tx_hash` field directly, so we
    // can't look up an on-chain transaction by hash from the PE. Instead,
    // we fetch the user's recent transactions via TransactionHistoryService
    // (Alchemy on-chain history) and search for one that matches this PE
    // by:
    //   1. The PE's action_type is a crypto-tx type (send/receive/swap/...)
    //   2. The transaction's symbol matches PE.asset_symbol
    //   3. The transaction's counterparty matches PE.counterparty_address
    //   4. The transaction's timestamp is within ±5 minutes of the PE
    //
    // If exactly one match is found we surface a "View Transaction" button.
    // No match means the PE is for a transaction we can't find on-chain
    // (could be on a non-EVM chain we don't support, could be older than
    // Alchemy's history window, etc.) and the button is hidden.
    useEffect(() => {
        if (!envelope || !walletAddress) return;
        if (!CRYPTO_TX_ACTION_TYPES.has(envelope.action_type)) return;

        let cancelled = false;
        (async () => {
            try {
                const result = await TransactionHistoryService.getTransactions(walletAddress, { limit: 100 });
                if (cancelled) return;

                const peSymbol = (envelope.asset_symbol || '').toLowerCase();
                const peCounterparty = (envelope.counterparty_address || '').toLowerCase();
                const peTimestamp = envelope.timestamp;

                const match = result.items.find((tx) => {
                    if (Math.abs(tx.timestamp - peTimestamp) > PE_TX_MATCH_WINDOW_MS) return false;
                    if (peSymbol && tx.symbol.toLowerCase() !== peSymbol) return false;
                    if (peCounterparty) {
                        const txCounterparty = (tx.type === 'received' ? tx.from : tx.to).toLowerCase();
                        if (txCounterparty !== peCounterparty) return false;
                    }
                    return true;
                });

                if (match) {
                    setMatchedTransaction(match);
                }
            } catch (err) {
                // Non-fatal - just skip the cross-link if the lookup fails.
                console.warn('[EnvelopeDetail] Transaction match lookup failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [envelope, walletAddress]);

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#4A8EE8" />
            </View>
        );
    }

    if (!envelope) {
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{t('envelope.notFound')}</Text>
                <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
                    <Text style={styles.backButtonText}>{t('common.goBack')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const riskColor = (envelope.risk_category ? RISK_COLORS[envelope.risk_category] : undefined) || '#9CA3AF';
    const hasSignature = !!envelope.signature;

    // derived display state.
    const description = getActionTypeDescription(envelope.action_type);
    const aiMeta = envelope.ai_conversation_metadata;
    const corrMeta = envelope.corroboration_metadata;
    const commitSha = historyEntry?.commitSha ?? null;
    const earningChip = historyEntry
        ? buildEarningChip({
            mintStatus: historyEntry.mintStatus,
            currentSettlementProjectionPVT: historyEntry.currentSettlementProjectionPVT,
        })
        : null;
    const genesisGross = historyEntry?.exactGenesisReservedGrossPVT;
    const hasGenesisGross = typeof genesisGross === 'string' && genesisGross.length > 0
        && genesisGross !== '0.0' && genesisGross !== '0';
    // An agent-era PE carries an agent identity or a real risk assessment. Compute
    // and first-party wallet PEs (ai_conversation, coding_session, commit, send)
    // do NOT — so the agent-era Risk/Agent sections stay hidden for them rather than
    // rendering empty fields with a fabricated risk_score:0.
    const isAgentEraPE = !!envelope.agent_id
        || (envelope.risk_score ?? 0) > 0
        || envelope.policy_decision === 'block';

    // §2.2 derived state: "what it earned" (eligible PVT projection, else record-only)
    // and the input origins grouped by class in the ruling's order.
    const showTrust = trust !== null && hasTrustDetail(trust);
    const trustEarnedLabel = historyEntry?.currentSettlementProjectionPVT != null
        ? `~${historyEntry.currentSettlementProjectionPVT} PVT`
        : earningChip?.disposition === 'record_only' ? t('trustLayer.peDetail.recordOnly') : t('common.unknown');
    const originGroups: { cls: OriginClass; origins: PeInputOriginView[] }[] = trust
        ? ORIGIN_CLASS_ORDER
            .map((cls) => ({ cls, origins: trust.inputOrigins.filter((o) => o.originClass === cls) }))
            .filter((g) => g.origins.length > 0)
        : [];

    return (
        <View style={styles.container}>
            <ScrollView style={styles.scrollView} contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + SPACING.s }]}>
                {/* Header */}
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} style={{ marginBottom: SPACING.s }} />
                    <View style={styles.actionTypeRow}>
                        <View style={[styles.actionTypeIconBg, { backgroundColor: `${getActionTypeDisplay(envelope.action_type).color}20` }]}>
                            <Ionicons
                                name={getActionTypeDisplay(envelope.action_type).icon as any}
                                size={18}
                                color={getActionTypeDisplay(envelope.action_type).color}
                            />
                        </View>
                        <Text style={styles.actionType}>
                            {getActionTypeDisplay(envelope.action_type).label.toUpperCase()}
                        </Text>
                    </View>
                    <Text style={styles.timestamp}>{formatDate(envelope.timestamp)}</Text>
                </View>

                {/* What is this? — a plain-language explanation per PE type. */}
                <View style={styles.section}>
                    <View style={styles.sectionTitleRow}>
                        <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                            <Ionicons name="help-circle" size={14} color="#4A8EE8" />
                        </View>
                        <Text style={styles.sectionTitle}>{t('envelope.whatIsThis')}</Text>
                    </View>
                    <View style={styles.card}>
                        <Text style={styles.intentText}>{description}</Text>
                    </View>
                </View>

                {/* Earning — mint disposition + eligible-only PVT + record
                    points (clearly labelled NOT PVT). Never a record-points sum shown
                    as earnings. */}
                {historyEntry && (earningChip !== null || hasGenesisGross || typeof historyEntry.recordPointsAtomic === 'string' || historyEntry.currentSettlementProjectionPVT !== null) && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(76, 195, 138, 0.14)' }]}>
                                <Ionicons name="diamond" size={14} color="#4CC38A" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.earningSection')}</Text>
                            {historyEntry.currentSettlementProjectionPVT !== null && (
                                <InfoButton onPress={() => setProjectionInfoVisible(true)} />
                            )}
                        </View>
                        <View style={styles.card}>
                            <DispositionChip chip={earningChip} size="detail" />
                            {/* PVT amounts are the ASSET → platinum (theme.ts rule). */}
                            {historyEntry.currentSettlementProjectionPVT !== null && (
                                <DetailRow
                                    label={t('envelope.projectedPvt')}
                                    value={`~${historyEntry.currentSettlementProjectionPVT} PVT`}
                                    valueColor={COLORS.platinum}
                                />
                            )}
                            {hasGenesisGross && (
                                <DetailRow
                                    label={t('envelope.genesisReserved')}
                                    value={`${genesisGross} PVT`}
                                    valueColor={COLORS.platinum}
                                />
                            )}
                            {typeof historyEntry.recordPointsAtomic === 'string' && (
                                <DetailRow label={t('envelope.recordPoints')} value={historyEntry.recordPoints} />
                            )}
                            <Text style={styles.earnNote}>{t('envelope.recordPointsNote')}</Text>
                        </View>
                    </View>
                )}

                {/* Trust Layer §2.2 — witness class, evidence class + earned, output
                    digests, input origins by class (pe: resolved to the cited party),
                    consumption reverse-index count, hardware-attestation metadata,
                    supervision / model / environment, adverse linkage. Hashes render
                    as hashes; no content is fetched. */}
                {showTrust && trust && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(155, 109, 255, 0.14)' }]}>
                                <Ionicons name="shield-checkmark" size={14} color="#9B6DFF" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('trustLayer.peDetail.sectionTitle')}</Text>
                        </View>
                        <View style={styles.card}>
                            {trust.witnessClass && (
                                <View style={styles.trustBadgeRow}>
                                    <Text style={styles.detailLabel}>{t('trustLayer.peDetail.witnessClass')}</Text>
                                    <View style={styles.trustBadge}>
                                        <Text style={styles.trustBadgeText}>{trust.witnessClass}</Text>
                                    </View>
                                </View>
                            )}
                            {trust.evidenceClass && (
                                <DetailRow label={t('trustLayer.peDetail.evidenceClass')} value={trust.evidenceClass} />
                            )}
                            <DetailRow
                                label={t('trustLayer.peDetail.earned')}
                                value={trustEarnedLabel}
                                valueColor={historyEntry?.currentSettlementProjectionPVT != null ? COLORS.platinum : undefined}
                            />

                            {/* Output digests — hashes only, never content. */}
                            <Text style={styles.trustGroupTitle}>{t('trustLayer.peDetail.outputDigests')}</Text>
                            {trust.outputDigests.length === 0 ? (
                                <Text style={styles.earnNote}>{t('trustLayer.peDetail.outputDigestsEmpty')}</Text>
                            ) : (
                                trust.outputDigests.map((d, i) => (
                                    <View key={`${d.hash}-${i}`} style={styles.trustLineRow}>
                                        {d.kind && <Text style={styles.trustKindTag}>{d.kind}</Text>}
                                        <Text style={styles.trustHash} numberOfLines={1} ellipsizeMode="middle" selectable>
                                            {d.hash}
                                        </Text>
                                    </View>
                                ))
                            )}

                            {/* Input origins, grouped by class; pe: shows the resolved handle. */}
                            <Text style={styles.trustGroupTitle}>{t('trustLayer.peDetail.inputOrigins')}</Text>
                            {originGroups.length === 0 ? (
                                <Text style={styles.earnNote}>{t('trustLayer.peDetail.inputOriginsEmpty')}</Text>
                            ) : (
                                originGroups.map((g) => (
                                    <View key={g.cls} style={styles.originGroup}>
                                        <Text style={styles.originClassLabel}>{t(`trustLayer.originClass.${g.cls}`)}</Text>
                                        {g.origins.map((o, i) => (
                                            <View key={`${o.originIdentifier}-${i}`} style={styles.trustLineRow}>
                                                {o.originClass === 'pe' && (o.citedHandle || o.citedSigner) ? (
                                                    <Text style={styles.trustCited} numberOfLines={1} ellipsizeMode="middle">
                                                        {t('trustLayer.peDetail.cites')} {o.citedHandle ?? truncateHash(o.citedSigner ?? '')}
                                                    </Text>
                                                ) : null}
                                                <Text style={styles.trustHash} numberOfLines={1} ellipsizeMode="middle" selectable>
                                                    {o.originIdentifier}
                                                </Text>
                                            </View>
                                        ))}
                                    </View>
                                ))
                            )}

                            {/* Consumption — reverse index; omitted entirely when absent. */}
                            {trust.consumptionIndependentParties !== null && (
                                <>
                                    <Text style={styles.trustGroupTitle}>{t('trustLayer.peDetail.consumption')}</Text>
                                    <Text style={styles.trustBody}>
                                        {t('trustLayer.peDetail.consumptionCount', { count: trust.consumptionIndependentParties })}
                                    </Text>
                                </>
                            )}

                            {/* Signals: supervision / model / environment. */}
                            {trust.supervisionRatioBps !== null && (
                                <DetailRow
                                    label={t('trustLayer.peDetail.supervisionRatio')}
                                    value={`${(trust.supervisionRatioBps / 100).toFixed(trust.supervisionRatioBps % 100 === 0 ? 0 : 2)}%`}
                                />
                            )}
                            {trust.modelFamily && (
                                <DetailRow label={t('trustLayer.peDetail.modelFamily')} value={trust.modelFamily} />
                            )}
                            {trust.environmentClass && (
                                <DetailRow label={t('trustLayer.peDetail.environmentClass')} value={trust.environmentClass} />
                            )}
                        </View>

                        {/* Hardware attestation — its own card. Metadata only; never a serial. */}
                        {trust.hardwareWitness && (
                            <View style={[styles.card, { marginTop: SPACING.s }]}>
                                <Text style={styles.trustGroupTitle}>{t('trustLayer.peDetail.hardwareAttestation')}</Text>
                                {trust.hardwareWitness.scheme && (
                                    <DetailRow label={t('trustLayer.peDetail.witnessScheme')} value={trust.hardwareWitness.scheme} />
                                )}
                                {trust.hardwareWitness.teeType && (
                                    <DetailRow label={t('trustLayer.peDetail.teeType')} value={trust.hardwareWitness.teeType} />
                                )}
                                {trust.hardwareWitness.measurementDigest && (
                                    <DetailRow
                                        label={t('trustLayer.peDetail.measurementDigest')}
                                        value={truncateHash(trust.hardwareWitness.measurementDigest)}
                                        copyValue={trust.hardwareWitness.measurementDigest}
                                        copyable
                                    />
                                )}
                                {trust.hardwareWitness.issuerRoot && (
                                    <DetailRow label={t('trustLayer.peDetail.issuerRoot')} value={trust.hardwareWitness.issuerRoot} />
                                )}
                                {trust.hardwareWitness.attestedRegion && (
                                    <DetailRow label={t('trustLayer.peDetail.attestedRegion')} value={trust.hardwareWitness.attestedRegion} />
                                )}
                                {trust.hardwareWitness.attestedTimeSource && (
                                    <DetailRow label={t('trustLayer.peDetail.attestedTimeSource')} value={trust.hardwareWitness.attestedTimeSource} />
                                )}
                                {trust.hardwareWitness.deviceClass && (
                                    <DetailRow label={t('trustLayer.peDetail.deviceClass')} value={trust.hardwareWitness.deviceClass} />
                                )}
                                {trust.hardwareWitness.verified !== null && (
                                    <DetailRow
                                        label={t('trustLayer.peDetail.verified')}
                                        value={trust.hardwareWitness.verified ? t('trustLayer.peDetail.verifiedYes') : t('trustLayer.peDetail.notVerified')}
                                        valueColor={trust.hardwareWitness.verified ? '#4CC38A' : '#E8A838'}
                                    />
                                )}
                            </View>
                        )}

                        {/* Adverse linkage — this PE is itself an adverse standing event. */}
                        {trust.isAdverse && (
                            <View style={styles.adverseCard}>
                                <View style={styles.adverseRow}>
                                    <Ionicons name="alert-circle" size={16} color="#F2555A" />
                                    <Text style={styles.adverseTitle}>{t('trustLayer.peDetail.adverseTitle')}</Text>
                                </View>
                                <Text style={styles.adverseBody}>
                                    {t('trustLayer.peDetail.adverseBody')}{trust.adverseType ? ` (${trust.adverseType})` : ''}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Conversation details (ai_conversation PEs only). */}
                {aiMeta && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(107, 163, 240, 0.14)' }]}>
                                <Ionicons name="chatbubbles" size={14} color="#6BA3F0" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.conversationSection')}</Text>
                        </View>
                        <View style={styles.card}>
                            <DetailRow label={t('envelope.provider')} value={aiMeta.provider} />
                            <DetailRow label={t('envelope.activeTime')} value={`${Math.round(aiMeta.active_duration_ms / 1000)}s`} />
                            <DetailRow label={t('envelope.foregroundTime')} value={`${Math.round(aiMeta.duration_ms / 1000)}s`} />
                            {aiMeta.input_fidelity !== 'presence_only' && (
                                <DetailRow label={t('envelope.turns')} value={String(aiMeta.turn_count)} />
                            )}
                            <Text style={styles.earnNote}>{t('envelope.conversationContentFree')}</Text>
                        </View>
                    </View>
                )}

                {/* Corroboration details (corroboration_signal PEs only). */}
                {corrMeta && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(76, 195, 138, 0.14)' }]}>
                                <Ionicons name="checkmark-done" size={14} color="#4CC38A" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.corroborationSection')}</Text>
                        </View>
                        <View style={styles.card}>
                            {corrMeta.signal_type && (
                                <DetailRow label={t('envelope.signalType')} value={corrMeta.signal_type} />
                            )}
                            {corrMeta.corroborating_party && (
                                <DetailRow label={t('envelope.corroboratingParty')} value={corrMeta.corroborating_party} />
                            )}
                            {corrMeta.target_pe_id && (
                                <DetailRow
                                    label={t('envelope.corroboratesPe')}
                                    value={truncateHash(corrMeta.target_pe_id)}
                                    copyValue={corrMeta.target_pe_id}
                                    copyable
                                />
                            )}
                            {corrMeta.evidence_ref && (
                                <DetailRow label={t('envelope.evidenceRef')} value={String(corrMeta.evidence_ref)} />
                            )}
                        </View>
                    </View>
                )}

                {/* Commit reference (commit-family PEs). */}
                {commitSha && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                                <Ionicons name="git-commit" size={14} color="#4A8EE8" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.commitSection')}</Text>
                        </View>
                        <View style={styles.card}>
                            <DetailRow
                                label={t('envelope.commitSha')}
                                value={commitSha.length > 12 ? `${commitSha.slice(0, 12)}...` : commitSha}
                                copyValue={commitSha}
                                copyable
                            />
                        </View>
                    </View>
                )}

                {/* Intent. Hidden for ai_conversation, whose intent_text is a
                    synthetic session key (the Conversation section covers it). */}
                {!aiMeta && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                                <Ionicons name="information-circle" size={14} color="#4A8EE8" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.intentSection')}</Text>
                        </View>
                        <View style={styles.card}>
                            <Text style={styles.intentText}>
                                {envelope.intent_text || t('envelope.noDescription')}
                            </Text>
                        </View>
                    </View>
                )}

                {/* Agent Info (if present) */}
                {envelope.agent_id && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(155, 109, 255, 0.14)' }]}>
                                <Ionicons name="hardware-chip" size={14} color="#6BA3F0" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.agentDetails')}</Text>
                        </View>
                        <View style={styles.card}>
                            {agentName && (
                                <DetailRow
                                    label={t('transactionDetail.agentLabel')}
                                    value={agentName}
                                />
                            )}
                            <DetailRow
                                label={t('envelope.agentId')}
                                value={envelope.agent_id}
                                copyable
                            />
                            {envelope.authorization_decision && (
                                <DetailRow
                                    label={t('envelope.decision')}
                                    value={enumDisplayCopy(envelope.authorization_decision)}
                                    valueColor={
                                        envelope.authorization_decision === 'allow'
                                            ? '#4CC38A'
                                            : envelope.authorization_decision === 'deny'
                                            ? '#F2555A'
                                            : '#E8A838'
                                    }
                                />
                            )}
                            {envelope.authorization_merchant && (
                                <DetailRow label={t('envelope.merchantLabel')} value={envelope.authorization_merchant} />
                            )}
                            {envelope.authorization_purpose && (
                                <DetailRow label={t('envelope.purposeLabel')} value={envelope.authorization_purpose} />
                            )}
                            {envelope.authorization_reason_codes && (
                                <DetailRow
                                    label={t('envelope.reasonCodes')}
                                    value={envelope.authorization_reason_codes.join(', ')}
                                />
                            )}
                        </View>
                    </View>
                )}

                {/* Risk Evaluation — agent-era PEs only. A compute or first-party
                    wallet PE has no meaningful risk assessment, so this section
                    stays hidden rather than rendering an empty risk_score:0. */}
                {isAgentEraPE && (
                <View style={styles.section}>
                    <View style={styles.sectionTitleRow}>
                        <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(242, 85, 90, 0.14)' }]}>
                            <Ionicons name="shield" size={14} color="#F2555A" />
                        </View>
                        <Text style={styles.sectionTitle}>{t('envelope.riskAssessment')}</Text>
                    </View>
                    <View style={styles.card}>
                        <View style={styles.riskHeader}>
                            <Text style={styles.riskLabel}>{t('envelope.riskLevel')}</Text>
                            <View style={[styles.riskBadge, { backgroundColor: `${riskColor}20` }]}>
                                <Text style={[styles.riskBadgeText, { color: riskColor }]}>
                                    {enumDisplayCopy(envelope.risk_category ?? 'unknown')}
                                </Text>
                            </View>
                        </View>
                        <View style={styles.riskScoreContainer}>
                            <Text style={styles.riskScoreLabel}>{t('envelope.score')}</Text>
                            <Text style={[styles.riskScore, { color: riskColor }]}>
                                {envelope.risk_score}/100
                            </Text>
                        </View>
                        <DetailRow
                            label={t('envelope.policyDecision')}
                            value={enumDisplayCopy(envelope.policy_decision ?? 'unknown')}
                            valueColor={
                                envelope.policy_decision === 'allow'
                                    ? '#4CC38A'
                                    : envelope.policy_decision === 'block'
                                    ? '#F2555A'
                                    : '#E8A838'
                            }
                        />
                        {envelope.risk_evaluation?.factors && (
                            <View style={styles.factorsContainer}>
                                <Text style={styles.factorsTitle}>{t('envelope.riskFactors')}</Text>
                                {Object.entries(envelope.risk_evaluation.factors).map(([key, factor]) =>
                                    factor ? (
                                        <View key={key} style={styles.factorRow}>
                                            <Text style={styles.factorName}>{key}</Text>
                                            <Text
                                                style={[
                                                    styles.factorRisk,
                                                    { color: RISK_COLORS[factor.risk] },
                                                ]}
                                            >
                                                {factor.risk}
                                            </Text>
                                        </View>
                                    ) : null
                                )}
                            </View>
                        )}
                    </View>
                </View>
                )}

                {/* Chain & Signature */}
                <View style={styles.section}>
                    <View style={styles.sectionTitleRow}>
                        <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                            <Ionicons name="link" size={14} color="#4A8EE8" />
                        </View>
                        <Text style={styles.sectionTitle}>{t('envelope.provenanceChain')}</Text>
                    </View>
                    <View style={styles.card}>
                        <DetailRow
                            label={t('envelope.envelopeId')}
                            value={truncateHash(envelope.envelope_id)}
                            copyValue={envelope.envelope_id}
                            copyable
                        />
                        <DetailRow
                            label={t('envelope.previousHash')}
                            value={envelope.prev_envelope_hash ? truncateHash(envelope.prev_envelope_hash) : t('common.unknown')}
                            copyValue={envelope.prev_envelope_hash}
                            copyable={!!envelope.prev_envelope_hash}
                        />
                        <DetailRow label={t('envelope.actorAddress')} value={envelope.actor_address || t('common.unknown')} copyable={!!envelope.actor_address} />
                        <DetailRow
                            label={t('envelope.chainId')}
                            value={envelope.chain_id === undefined ? t('common.unknown') : String(envelope.chain_id)}
                        />
                        <DetailRow
                            label={t('envelope.deviceAttestation')}
                            value={envelope.device_attestation_id ? truncateHash(envelope.device_attestation_id) : t('common.unknown')}
                            copyValue={envelope.device_attestation_id}
                            copyable={!!envelope.device_attestation_id}
                        />
                        {recordKind === 'v1' && <View style={styles.signatureRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Ionicons name="lock-closed" size={14} color="#9CA3AF" />
                                <Text style={styles.signatureLabel}>{t('envelope.signature')}</Text>
                            </View>
                            <View style={[
                                styles.signatureBadge,
                                hasSignature ? styles.signatureValid : styles.signatureInvalid,
                            ]}>
                                <Ionicons
                                    name={hasSignature ? 'checkmark-circle' : 'alert-circle'}
                                    size={12}
                                    color={hasSignature ? '#4CC38A' : '#E8A838'}
                                />
                                <Text style={[
                                    styles.signatureBadgeText,
                                    { color: hasSignature ? '#4CC38A' : '#E8A838' },
                                ]}>
                                    {hasSignature ? t('envelope.signed') : t('envelope.unsigned')}
                                </Text>
                            </View>
                        </View>}
                        {hasSignature && (
                            <Text style={styles.signatureHash}>
                                {truncateHash(envelope.signature!, 16)}
                            </Text>
                        )}
                    </View>
                </View>

                {/* Transaction Details (if present) */}
                {((envelope.amount !== undefined && envelope.amount !== '0') || envelope.asset_symbol) && (
                    <View style={styles.section}>
                        <View style={styles.sectionTitleRow}>
                            <View style={[styles.sectionIconBg, { backgroundColor: 'rgba(74, 142, 232, 0.14)' }]}>
                                <Ionicons name="swap-horizontal" size={14} color="#4A8EE8" />
                            </View>
                            <Text style={styles.sectionTitle}>{t('envelope.transactionSection')}</Text>
                        </View>
                        <View style={styles.card}>
                            <DetailRow label={t('envelope.amountLabel')} value={envelope.amount ?? t('common.unknown')} />
                            <DetailRow label={t('envelope.assetLabel')} value={envelope.asset_symbol ?? t('common.unknown')} />
                            {envelope.counterparty_address && (
                                <DetailRow
                                    label={t('envelope.counterparty')}
                                    value={truncateHash(envelope.counterparty_address)}
                                    copyValue={envelope.counterparty_address}
                                    copyable
                                />
                            )}
                            {envelope.contract_address && (
                                <DetailRow
                                    label={t('envelope.contract')}
                                    value={truncateHash(envelope.contract_address)}
                                    copyValue={envelope.contract_address}
                                    copyable
                                />
                            )}
                            {/* PE → Transaction cross-link. Only rendered when
                                we successfully matched this PE to a real
                                on-chain transaction in the user's history.
                                Tap navigates to TransactionDetail with the
                                full Transaction object as a route param. */}
                            {matchedTransaction && (
                                <TouchableOpacity
                                    style={styles.crossLinkButton}
                                    onPress={() => navigation.navigate('TransactionDetail', { transaction: matchedTransaction })}
                                    activeOpacity={0.7}
                                >
                                    <Ionicons name="link" size={16} color={COLORS.primary} />
                                    <Text style={styles.crossLinkText}>{t('envelope.viewTransaction')}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                )}

                {/* Raw Data Toggle */}
                <TouchableOpacity
                    style={styles.rawDataToggle}
                    onPress={() => setShowRawData(!showRawData)}
                >
                    <Ionicons name={showRawData ? 'chevron-up' : 'chevron-down'} size={16} color="#4A8EE8" />
                    <Text style={styles.rawDataToggleText}>
                        {showRawData ? t('common.hide') : t('common.show')}{t('envelope.rawData')}</Text>
                </TouchableOpacity>

                {showRawData && (
                    <View style={styles.rawDataContainer}>
                        <Text style={styles.rawData}>
                            {JSON.stringify(rawEnvelope ?? envelope, null, 2)}
                        </Text>
                    </View>
                )}

                {/* Hide / Unhide */}
                <TouchableOpacity
                    style={[styles.hideButton, envelope.hidden && styles.unhideButton]}
                    onPress={() => {
                        if (envelope.hidden) {
                            // Unhide immediately
                            ProvenanceEnvelopeManager.unhidePE(envelope.envelope_id).then(() => {
                                setEnvelope({ ...envelope, hidden: false });
                            });
                        } else {
                            // Show explanation before hiding
                            Alert.alert(
                                t('envelope.hideEntry'),
                                t('envelope.hideEntryMsg'),
                                [
                                    { text: t('common.cancel'), style: 'cancel' },
                                    {
                                        text: t('common.hide'),
                                        onPress: () => {
                                            ProvenanceEnvelopeManager.hidePE(envelope.envelope_id).then(() => {
                                                navigation.goBack();
                                            });
                                        },
                                    },
                                ],
                            );
                        }
                    }}
                >
                    <Ionicons
                        name={envelope.hidden ? 'eye' : 'eye-off'}
                        size={16}
                        color={envelope.hidden ? '#4A8EE8' : '#9CA3AF'}
                    />
                    <Text style={[styles.hideButtonText, envelope.hidden && { color: '#4A8EE8' }]}>
                        {envelope.hidden ? i18next.t('ui.envelopeDetail.unhide') : i18next.t('envelope.hideEntry')}
                    </Text>
                </TouchableOpacity>
            </ScrollView>
            <InfoModal
                visible={projectionInfoVisible}
                onClose={() => setProjectionInfoVisible(false)}
                title={t('pvtProjectionInfo.title')}
                body={t('pvtProjectionInfo.body')}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxxl,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: COLORS.background,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: COLORS.background,
        padding: SPACING.xl,
    },
    errorText: {
        fontSize: 18,
        color: COLORS.text,
        marginBottom: SPACING.l,
    },
    backButton: {
        backgroundColor: '#4A8EE8',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.3,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
    },
    backButtonText: {
        color: COLORS.white,
        fontSize: 16,
        fontWeight: '600',
    },

    // Header
    header: {
        marginBottom: SPACING.l,
    },
    actionTypeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.xs,
    },
    actionTypeIconBg: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionType: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        flexShrink: 1,
    },
    timestamp: {
        fontSize: 14,
        color: '#8B929E',
    },

    // Section
    section: {
        marginBottom: SPACING.l,
    },
    sectionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.m,
        gap: SPACING.s,
    },
    sectionIconBg: {
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sectionTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    card: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    intentText: {
        fontSize: 15,
        color: COLORS.text,
        lineHeight: 22,
    },
    // earning section
    earnNote: {
        fontSize: 12,
        color: '#8B929E',
        lineHeight: 18,
        marginTop: SPACING.s,
    },

    // Trust Layer §2.2
    trustBadgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    trustBadge: {
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: BORDER_RADIUS.s,
        backgroundColor: 'rgba(155, 109, 255, 0.16)',
    },
    trustBadgeText: {
        fontSize: 12,
        fontWeight: '700',
        color: '#B79BFF',
    },
    trustGroupTitle: {
        fontSize: 11,
        fontWeight: '700',
        color: '#9CA3AF',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        marginTop: SPACING.m,
        marginBottom: SPACING.xs,
    },
    trustLineRow: {
        paddingVertical: 3,
    },
    trustKindTag: {
        fontSize: 10,
        fontWeight: '700',
        color: '#6BA3F0',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    trustHash: {
        fontSize: 11,
        color: COLORS.textSecondary,
        fontFamily: 'monospace',
    },
    trustCited: {
        fontSize: 12,
        color: '#B79BFF',
        fontWeight: '600',
    },
    trustBody: {
        fontSize: 13,
        color: COLORS.text,
        lineHeight: 19,
    },
    originGroup: {
        marginBottom: SPACING.s,
    },
    originClassLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: COLORS.textSecondary,
        marginBottom: 2,
    },
    adverseCard: {
        backgroundColor: 'rgba(242, 85, 90, 0.10)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(242, 85, 90, 0.30)',
        marginTop: SPACING.s,
    },
    adverseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginBottom: SPACING.xs,
    },
    adverseTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#F2555A',
    },
    adverseBody: {
        fontSize: 12,
        color: COLORS.textSecondary,
        lineHeight: 18,
    },

    // Detail Row
    detailRow: {
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    detailLabel: {
        fontSize: 12,
        color: '#8B929E',
        marginBottom: 4,
    },
    detailValueContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    detailValue: {
        fontSize: 13,
        color: COLORS.text,
        fontWeight: '500',
        fontFamily: 'monospace',
        flexShrink: 1,
    },
    copyButton: {
        marginLeft: SPACING.s,
        padding: 4,
    },

    // Risk
    riskHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    riskLabel: {
        fontSize: 14,
        color: '#8B929E',
    },
    riskBadge: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.xs,
        borderRadius: 10,
    },
    riskBadgeText: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 1,
    },
    riskScoreContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    riskScoreLabel: {
        fontSize: 12,
        color: '#8B929E',
    },
    riskScore: {
        fontSize: 18,
        fontWeight: '700',
    },
    factorsContainer: {
        marginTop: SPACING.m,
    },
    factorsTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: SPACING.s,
    },
    factorRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 4,
    },
    factorName: {
        fontSize: 12,
        color: COLORS.chromeMuted,
        textTransform: 'capitalize',
    },
    factorRisk: {
        fontSize: 12,
        fontWeight: '600',
        textTransform: 'uppercase',
    },

    // Signature
    signatureRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        marginTop: SPACING.s,
    },
    signatureLabel: {
        fontSize: 12,
        color: '#9CA3AF',
    },
    signatureBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: SPACING.s,
        paddingVertical: 2,
        borderRadius: 8,
    },
    signatureValid: {
        backgroundColor: 'rgba(0, 230, 118, 0.14)',
    },
    signatureInvalid: {
        backgroundColor: 'rgba(255, 179, 0, 0.14)',
    },
    signatureBadgeText: {
        fontSize: 11,
        fontWeight: '600',
    },
    signatureHash: {
        fontSize: 10,
        color: '#9CA3AF',
        fontFamily: 'monospace',
        textAlign: 'right',
        marginTop: 4,
    },

    // PE → Transaction cross-link button (renders inside the TRANSACTION
    // section card when a matching on-chain tx is found in user history).
    crossLinkButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        marginTop: SPACING.m,
        paddingVertical: SPACING.s + 2,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: 'rgba(74, 142, 232, 0.10)',
        borderWidth: 1,
        borderColor: 'rgba(74, 142, 232, 0.25)',
    },
    crossLinkText: {
        fontSize: 14,
        color: COLORS.primary,
        fontWeight: '600',
    },

    // Raw Data
    rawDataToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: SPACING.m,
    },
    rawDataToggleText: {
        fontSize: 14,
        color: '#4A8EE8',
        fontWeight: '500',
    },
    rawDataContainer: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    rawData: {
        fontSize: 10,
        color: '#9CA3AF',
        fontFamily: 'monospace',
    },

    // Hide/Unhide
    hideButton: {
        marginTop: SPACING.l,
        paddingVertical: SPACING.m,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        backgroundColor: 'rgba(18,21,26,0.70)',
    },
    unhideButton: {
        borderColor: 'rgba(74, 142, 232, 0.30)',
        backgroundColor: 'rgba(74, 142, 232, 0.10)',
    },
    hideButtonText: {
        fontSize: 14,
        fontWeight: '500',
        color: '#9CA3AF',
    },
});
