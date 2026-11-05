import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * PresentationRequestScreen (§3f) — the REMOTE agent↔human presentation channel, human side.
 *
 * An agent asked to present to this human when they are not physically co-present (QR stays the
 * in-person path). The request arrived in the attention center. Here the human, as the requester:
 * 1. COMPOSES the predicates the agent must prove and issues a challenge (audience = this wallet,
 * a fresh 32-byte nonce). The relay records the challenge on the request; the agent polls it,
 * burns its own PVT, and presents (the EXISTING burn-to-present primitive — no new tier, no
 * burn-free path).
 * 2. VERIFIES the returned presentation against the composed challenge and records the verdict.
 *
 * The composed { audience, challenge, predicates } are held locally (keyed by request id) so the
 * verify step binds to the exact challenge the human issued, surviving an app restart between the
 * two legs.
 *
 * the relay SIGNS the envelope it composes for this wallet (requester = this human's wallet,
 * audience = its wallet id) and returns it; the agent sees who is asking before it burns. The screen
 * shows the signed status and verifies the fallback path against that envelope (`challenge_envelope`).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useRoute, useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { COLORS, GRADIENTS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import { useWalletStore } from '../../store/walletStore';
import RelayAPIService, { type HumanPresentationRequest } from '../../services/RelayAPIService';
import type { PredicateRequest, PredicateOp } from '../../core/presentation/humanPresentation';
import { isSignedChallenge } from '../../core/presentation/challengeEnvelope';
import BackButton from '../../components/BackButton';
import { agentNameFor, loadAgentNameMap } from '../../core/agents/agentNames';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';

interface Preset { key: string; label: string; field: string; op: PredicateOp; value: string; }
// The remote-flow presets: the common reputation checks (incl. the flow-1 proof's two).
const PRESETS: readonly Preset[] = [
    { key: 'depth', label: 'presentationRequest.presetDepth', field: 'continuity.chain_depth', op: 'gte', value: '10' },
    { key: 'work', label: 'presentationRequest.presetWork', field: 'work.total', op: 'gte', value: '100' },
    { key: 'witnessed', label: 'presentationRequest.presetWitnessed', field: 'work.witnessed', op: 'gte', value: '1' },
    { key: 'clean', label: 'presentationRequest.presetClean', field: 'standing.adverse_events', op: 'lte', value: '0' },
    { key: 'human', label: 'presentationRequest.presetHuman', field: 'accountability.human_beneficiary', op: 'gte', value: '1' },
];

export default function PresentationRequestScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation<NativeStackNavigationProp<AppParamList>>();
    const route = useRoute<RouteProp<AppParamList, 'PresentationRequest'>>();
    const requestId = route.params?.requestId;
    const address = useWalletStore((s) => s.address);

    const [request, setRequest] = useState<HumanPresentationRequest | null | undefined>(undefined);
    const [selected, setSelected] = useState<Set<string>>(new Set(['depth', 'work']));
    const [busy, setBusy] = useState(false);
    const [verdict, setVerdict] = useState<{ valid: boolean; results?: unknown[] } | null>(null);
    // Item 4: the agent's NAME (the human's name for it), never the raw wallet id.
    const [agentName, setAgentName] = useState<string | null>(null);

    const load = useCallback(async () => {
        const [all, names] = await Promise.all([RelayAPIService.getWalletPresentationRequests(), loadAgentNameMap()]);
        const named = all.find((r) => r.request_id === requestId);
        if (named) setAgentName(agentNameFor(named.agent_wallet_id, names));
        const found = all.find((r) => r.request_id === requestId);
        setRequest((prev) => {
            if (found) return found;
            // The human list returns only `requested` + `presented`. A `challenged` request (waiting
            // on the agent) or a `verified` one is absent — keep it visible rather than flipping to
            // "not found" (the agent will present and it reappears as `presented`).
            if (prev && (prev.status === 'challenged' || prev.status === 'verified')) return prev;
            return prev === undefined ? null : (prev ?? null);
        });
    }, [requestId]);

    useFocusEffect(useCallback(() => { void load(); }, [load]));
    useEffect(() => { setVerdict(null); }, [requestId]);

    // Auto-advance the "waiting on the agent" state. After the human composes, the
    // request sits at `challenged` until the agent burns + presents — which happens
    // out of band, seconds-to-minutes later. Without this the user is stranded on a
    // static spinner with nothing to do and no signal that anything will change. Poll
    // while `challenged` so the screen flips to `presented` (with a Verify button) on
    // its own the instant the agent responds; the interval clears as soon as the
    // status leaves `challenged`, so it never runs on a terminal or actionable state.
    useEffect(() => {
        if (request?.status !== 'challenged') return;
        const id = setInterval(() => { void load(); }, 5000);
        return () => clearInterval(id);
    }, [request?.status, load]);

    const predicatesFromSelection = useMemo((): PredicateRequest[] =>
        PRESETS.filter((p) => selected.has(p.key)).map((p) => ({ field: p.field, op: p.op, threshold: Number(p.value) })),
        [selected]);

    const toggle = useCallback((key: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }, []);

    const compose = useCallback(async () => {
        if (!requestId || predicatesFromSelection.length === 0) {
            Alert.alert(t('presentationRequest.pickOne'));
            return;
        }
        setBusy(true);
        try {
            const challenge = [...Crypto.getRandomBytes(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
            const audience = address || `human:${requestId}`;
            const res = await RelayAPIService.composePresentationChallenge(requestId, { audience, challenge, predicates: predicatesFromSelection });
            if (!res.ok) { Alert.alert(t('presentationRequest.composeFailed'), errorDisplayCopy(res.error ?? '')); return; }
            // Optimistically move to the "waiting on agent" state — a `challenged` request drops out
            // of the human list, so reloading here would lose it. It reappears as `presented`.
            // when the relay signed the envelope, ITS audience/challenge/predicates are the ones
            // the agent answers (the relay binds the audience to this wallet id).
            const env = res.envelope ?? null;
            setRequest((prev) => (prev ? {
                ...prev,
                status: 'challenged',
                audience: env?.audience ?? audience,
                challenge: env?.challenge ?? challenge,
                predicates: env ? [...(env.predicates ?? [])] : predicatesFromSelection,
                challenge_envelope: env,
            } : prev));
            // It now waits on the agent, not the human: clear it from the bell.
            requestAttentionRefresh();
            Alert.alert(t('presentationRequest.composedTitle'), t('presentationRequest.composedBody'));
        } catch (e) {
            Alert.alert(t('presentationRequest.composeFailed'), errorDisplayCopy(e instanceof Error ? e.message : t('common.error')));
        } finally {
            setBusy(false);
        }
    }, [requestId, predicatesFromSelection, address, load, t]);

    const verify = useCallback(async () => {
        if (!requestId || !request) return;
        setBusy(true);
        try {
            // verify-at-submit: a presentation token is only valid for ≤15 min, and in
            // the REMOTE channel we return long after the agent presented — the token is
            // expired, so we CANNOT re-verify it here. The relay verified the FRESH token at
            // submit time against this exact challenge and stored the authoritative verdict;
            // read THAT and acknowledge it. (Fall back to a local re-verify only when no fresh
            // verdict was recorded — the in-person immediate flow, where the token is still live.)
            if (request.verdict === 'valid' || request.verdict === 'invalid') {
                const valid = request.verdict === 'valid';
                setVerdict({ valid, results: (request.predicate_results ?? []) as unknown[] });
                await RelayAPIService.recordPresentationVerdict(requestId, {
                    verdict: request.verdict,
                    predicate_results: (request.predicate_results ?? []) as unknown[],
                });
                await load();
                requestAttentionRefresh();
                return;
            }
            if (!request.presentation_token || !request.audience || !request.challenge) return;
            const asked = (request.challenge_envelope?.predicates ?? request.predicates ?? []) as PredicateRequest[];
            const r = await RelayAPIService.verifyPresentation(request.challenge_envelope
                ? { token: request.presentation_token, challenge_envelope: request.challenge_envelope }
                : { token: request.presentation_token, audience: request.audience, challenge: request.challenge, predicates: asked });
            // checks were named → only a reputation presentation answers them.
            const valid = r.valid === true && (asked.length === 0 || r.tier === 'reputation');
            setVerdict({ valid, results: r.predicates });
            // Record the verdict back on the request so the agent learns the outcome.
            await RelayAPIService.recordPresentationVerdict(requestId, {
                verdict: valid ? 'valid' : 'invalid',
                predicate_results: r.predicates,
            });
            await load();
            requestAttentionRefresh();
        } catch (e) {
            Alert.alert(t('presentationRequest.verifyFailed'), errorDisplayCopy(e instanceof Error ? e.message : t('common.error')));
        } finally {
            setBusy(false);
        }
    }, [requestId, request, load, t]);

    // The verdict shown: the human's just-tapped result, else the relay-attested verdict
    // already stored on the request (fresh-at-submit for the remote channel).
    const shownInvalid = verdict ? verdict.valid === false : request?.verdict === 'invalid';
    const hasShownVerdict = verdict !== null || request?.status === 'verified'
        || request?.verdict === 'valid' || request?.verdict === 'invalid';

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
                <Text style={styles.headerTitle} numberOfLines={1}>{t('presentationRequest.title')}</Text>
                <View style={{ width: 44 }} />
            </View>
            <ScrollView contentContainerStyle={styles.scrollContent}>
                {request === undefined ? (
                    <View style={styles.centerBlock}><ActivityIndicator color={COLORS.primary} /></View>
                ) : request === null ? (
                    <View style={styles.centerBlock}><Text style={styles.muted}>{t('presentationRequest.notFound')}</Text></View>
                ) : (
                    <>
                        <Text style={styles.intro}>{t('presentationRequest.from', { agent: agentName ?? t('attention.unknownAgent') })}</Text>
                        {request.note ? <Text style={styles.note}>{request.note}</Text> : null}

                        {request.status === 'requested' && (
                            <>
                                <Text style={styles.sectionTitle}>{t('presentationRequest.composePrompt')}</Text>
                                {PRESETS.map((p) => {
                                    const on = selected.has(p.key);
                                    return (
                                        <TouchableOpacity key={p.key} style={[styles.presetRow, on && styles.presetRowOn]} onPress={() => toggle(p.key)} activeOpacity={0.7}>
                                            <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? COLORS.primary : COLORS.textMuted} />
                                            <Text style={styles.presetLabel}>{t(p.label)}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                                <TouchableOpacity style={[styles.primaryBtn, busy && styles.disabled]} onPress={compose} disabled={busy}>
                                    <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                        {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>{t('presentationRequest.composeButton')}</Text>}
                                    </LinearGradient>
                                </TouchableOpacity>
                            </>
                        )}

                        {/* the request the agent answers is signed by Provian for this wallet. */}
                        {request.challenge_envelope && isSignedChallenge(request.challenge_envelope) && request.status !== 'requested' && (
                            <View style={styles.signedRow}>
                                <Ionicons name="shield-checkmark" size={14} color={COLORS.success} />
                                <Text style={styles.signedText}>{t('presentationRequest.signedStatus')}</Text>
                            </View>
                        )}

                        {request.status === 'challenged' && (
                            <View style={styles.waitCard}>
                                <ActivityIndicator color={COLORS.primary} />
                                <Text style={styles.muted}>{t('presentationRequest.waitingForAgent')}</Text>
                                <Text style={styles.waitHint}>{t('presentationRequest.waitingForAgentHint')}</Text>
                            </View>
                        )}

                        {request.status === 'presented' && !verdict && (
                            <>
                                <Text style={styles.sectionTitle}>{t('presentationRequest.readyToVerify')}</Text>
                                <TouchableOpacity style={[styles.primaryBtn, busy && styles.disabled]} onPress={verify} disabled={busy}>
                                    <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGradient}>
                                        {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryBtnText}>{t('presentationRequest.verifyButton')}</Text>}
                                    </LinearGradient>
                                </TouchableOpacity>
                            </>
                        )}

                        {hasShownVerdict && (
                            <View style={[styles.verdictCard, shownInvalid && styles.verdictBad]}>
                                <Ionicons
                                    name={shownInvalid ? 'close-circle' : 'shield-checkmark'}
                                    size={22}
                                    color={shownInvalid ? COLORS.error : (COLORS.success || '#4CC38A')}
                                />
                                <Text style={styles.verdictText}>
                                    {shownInvalid ? t('presentationRequest.verdictInvalid') : t('presentationRequest.verdictValid')}
                                </Text>
                            </View>
                        )}
                        {request.status === 'declined' && (
                            <Text style={styles.muted}>{t('presentationRequest.declined')}</Text>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingTop: SPACING.s, paddingBottom: SPACING.s },
    headerTitle: { fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'center', color: COLORS.text },
    scrollContent: { paddingHorizontal: SPACING.l, paddingBottom: SPACING.xxl },
    centerBlock: { alignItems: 'center', paddingVertical: SPACING.xxxl, gap: SPACING.m },
    muted: { color: COLORS.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
    intro: { color: COLORS.text, fontSize: 15, fontWeight: '600', marginBottom: SPACING.s },
    note: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: SPACING.l, fontStyle: 'italic' },
    sectionTitle: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.m, marginBottom: SPACING.s },
    presetRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, paddingVertical: SPACING.m, paddingHorizontal: SPACING.m, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(200,205,214,0.08)', marginBottom: SPACING.s },
    presetRowOn: { borderColor: COLORS.primary, backgroundColor: 'rgba(74,142,232,0.08)' },
    presetLabel: { color: COLORS.text, fontSize: 14, flex: 1, minWidth: 0 },
    primaryBtn: { borderRadius: 24, overflow: 'hidden', marginTop: SPACING.l },
    primaryBtnGradient: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: SPACING.xl },
    primaryBtnText: { flexShrink: 1, color: '#FFF', fontSize: 15, fontWeight: '600', textAlign: 'center' },
    disabled: { opacity: 0.5 },
    waitCard: { alignItems: 'center', gap: SPACING.m, paddingVertical: SPACING.xl },
    waitHint: { color: COLORS.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17, opacity: 0.8, paddingHorizontal: SPACING.l },
    verdictCard: { flexDirection: 'row', alignItems: 'center', gap: SPACING.m, backgroundColor: 'rgba(76,195,138,0.10)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(76,195,138,0.30)', padding: SPACING.l, marginTop: SPACING.l },
    verdictBad: { backgroundColor: 'rgba(232,74,74,0.10)', borderColor: 'rgba(232,74,74,0.30)' },
    verdictText: { flex: 1, minWidth: 0, color: COLORS.text, fontSize: 14, fontWeight: '600' },
    signedRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: SPACING.s },
    signedText: { flex: 1, minWidth: 0, color: COLORS.textSecondary, fontSize: 12, lineHeight: 17 },
});
