import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * Request & verify a presentation — the human REQUESTER leg of burn-to-present.
 *
 * The requester is whoever asks a counterparty to prove something. Two steps, both
 * voluntary for the counterparty to answer:
 * 1. REQUEST — the relay issues a fresh challenge SIGNED for your wallet (* `POST /v1/wallet/present/challenge`; audience = your wallet id), so the presenter sees
 * who is asking before it burns. Hand the envelope over (QR / text); starting from their
 * profile pins WHO you're asking. Trust Layer §2.6: the challenge may NAME PREDICATES
 * over the reputation vocabulary (`continuity.chain_depth ≥ 100`, `standing.bond_active
 * in {1}`, …). Provian computes each answer from the presenter's live record and
 * co-signs the results; you get booleans.
 * 2. VERIFY — paste/scan the token they hand back and check it against the exact
 * envelope you issued (`challenge_envelope`). An expired or mismatched token, a token
 * that did not answer a predicate you named (or is not a reputation presentation when
 * you named any), or a token from the WRONG presenter is refused with a reason. The
 * relay's public /v1/present/verify is stateless (§2.7) — the same valid token verifies
 * again inside its window — so THIS screen accepts each `presentation_id` once
 * (`acceptVerifiedPresentation`). It returns predicate results + the always-present
 * `standing.*` adverse facts — never the chain.
 *
 * This is NOT a burn — the requester never burns. Only the presenter burns.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
    View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Share, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import RelayAPIService, { type PresentationVerifyResult } from '../../services/RelayAPIService';
import {
    presenterMatchesCounterparty, extractPresenterLabel, normalizePredicateRequests, PREDICATE_OPS,
    type PredicateOp, type PredicateRequest,
} from '../../core/presentation/humanPresentation';
import type { ChallengeEnvelope } from '../../core/presentation/challengeEnvelope';
import { canonicalDisclosureRequest, DISCLOSURE_CONTENT_ELECTIONS, type CanonicalDisclosureRequest, type DisclosureAnswer, type DisclosureContent } from '../../core/presentation/disclosureRequest';
import { describeDisclosureRequest, describeDisclosureExtras, describeDisclosedRecord } from '../../core/presentation/disclosureDisplay';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import { acceptVerifiedPresentation, type RequesterRejectReason } from '../../core/presentation/acceptedPresentations';
import type { AppParamList } from '../../navigation/types';

/** Byte-mode QR capacity at the default error-correction level is ~2.3 KB; stay under it. */
const QR_MAX_CHARS = 2000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type RequesterRoute = RouteProp<AppParamList, 'PresentationRequester'>;

/**
 * Common vocabulary fields a requester reaches for first (any field is typeable). Every entry is a
 * real fixed field of the relay's reputation vocabulary (`provian-backend/src/core/presentation/
 * vocabulary.ts`) — the relay refuses a predicate on an unknown field.
 */
const SUGGESTED_FIELDS = [
    'continuity.chain_depth', 'continuity.active_days', 'continuity.streak_days', 'continuity.highest_attestation_rank',
    'work.witnessed', 'consumption.independent_parties', 'money.witnessed_financial',
    'standing.adverse_events', 'standing.bond_active', 'accountability.human_beneficiary',
];

/**
 * Plain-language checks a person can pick without knowing the vocabulary. Each maps
 * to one exact predicate. `tunable` ones expose the number; boolean ones don't.
 * This is what makes "add a predicate" legible — the raw field editor stays behind
 * "Advanced" for anyone who wants an arbitrary field.
 */
interface PredicatePreset {
    key: string;
    /** i18n key of the plain-language label ('' for a raw advanced field). */
    label: string;
    /** i18n key of the one-line help ('' for a raw advanced field). */
    help: string;
    field: string;
    op: PredicateOp;
    value: string;
    /** i18n key of the unit shown beside a tunable number. */
    unit?: string;
    tunable?: boolean;
}
const PRESET = 'trustLayer.requester.preset';
const UNIT_ENTRIES = 'trustLayer.requester.unitEntries';
const UNIT_DAYS = 'trustLayer.requester.unitDays';
const PREDICATE_PRESETS: readonly PredicatePreset[] = [
    { key: 'clean', label: `${PRESET}.clean.label`, help: `${PRESET}.clean.help`, field: 'standing.adverse_events', op: 'lte', value: '0' },
    { key: 'bond', label: `${PRESET}.bond.label`, help: `${PRESET}.bond.help`, field: 'standing.bond_active', op: 'in', value: '1' },
    { key: 'human', label: `${PRESET}.human.label`, help: `${PRESET}.human.help`, field: 'accountability.human_beneficiary', op: 'gte', value: '1' },
    { key: 'work', label: `${PRESET}.work.label`, help: `${PRESET}.work.help`, field: 'work.witnessed', op: 'gte', value: '1', unit: UNIT_ENTRIES, tunable: true },
    { key: 'depth', label: `${PRESET}.depth.label`, help: `${PRESET}.depth.help`, field: 'continuity.chain_depth', op: 'gte', value: '10', unit: UNIT_ENTRIES, tunable: true },
    { key: 'active', label: `${PRESET}.active.label`, help: `${PRESET}.active.help`, field: 'continuity.active_days', op: 'gte', value: '30', unit: UNIT_DAYS, tunable: true },
    { key: 'streak', label: `${PRESET}.streak.label`, help: `${PRESET}.streak.help`, field: 'continuity.streak_days', op: 'gte', value: '7', unit: UNIT_DAYS, tunable: true },
];

const OP_LABEL: Record<PredicateOp, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=', in: 'in' };

/** Turn a raw vocabulary field into everyday words for display (i18n keys; falls back to the raw name). */
const FIELD_LABEL: Record<string, string> = {
    'standing.adverse_events': 'trustLayer.requester.field.adverseEvents',
    'standing.bond_active': 'trustLayer.requester.field.bondActive',
    'accountability.human_beneficiary': 'trustLayer.requester.field.humanBeneficiary',
    'work.witnessed': 'trustLayer.requester.field.witnessedWork',
    'continuity.chain_depth': 'trustLayer.requester.field.chainDepth',
    'continuity.active_days': 'trustLayer.requester.field.activeDays',
    'continuity.streak_days': 'trustLayer.requester.field.streakDays',
    'continuity.highest_attestation_rank': 'trustLayer.requester.field.attestationRank',
    'consumption.independent_parties': 'trustLayer.requester.field.independentConsumers',
    'money.witnessed_financial': 'trustLayer.requester.field.witnessedFinancial',
};
function humanizeField(t: TFunction, field: string): string {
    const key = FIELD_LABEL[field];
    return key ? t(key) : field;
}

/** A friendly, whole-sentence rendering of a predicate for display. */
function humanizePredicate(t: TFunction, p: PredicateRequest): string {
    const name = humanizeField(t, p.field);
    if (p.op === 'in') return t('trustLayer.requester.predicateYes', { name });
    if (p.field === 'standing.adverse_events' && p.op === 'lte' && (p.threshold ?? 0) <= 0) return t('trustLayer.requester.cleanRecordShort');
    return `${name} ${OP_LABEL[p.op]} ${p.threshold ?? ''}`;
}

interface DraftPredicate { field: string; op: PredicateOp; value: string; label?: string; unit?: string; tunable?: boolean }

/** 2026-10-10: a requester-named disclosure request as drafted on screen. */
interface DraftDisclosure { kind: 'pe' | 'witness'; digest: string; issuer: string; signer: string; limit: string; fields: string; content: DisclosureContent[] }
const CONTENT_LABEL: Record<DisclosureContent, string> = {
    description: 'trustLayer.disclosure.contentDescription', intent: 'trustLayer.disclosure.contentIntent',
    artifacts: 'trustLayer.disclosure.contentArtifacts', fact_tier: 'trustLayer.disclosure.contentFactTier',
};
function draftToDisclosure(d: DraftDisclosure): CanonicalDisclosureRequest | null {
    const fields = d.fields.split(/[,\s]+/).map((f) => f.trim()).filter(Boolean);
    const tail = { ...(fields.length > 0 ? { fields } : {}), ...(d.content.length > 0 ? { content: d.content } : {}) };
    if (d.kind === 'pe') return canonicalDisclosureRequest({ kind: 'pe', output_digest: d.digest.trim(), ...(d.issuer.trim() ? { issuer: d.issuer.trim() } : {}), ...tail });
    const limit = Number(d.limit);
    return canonicalDisclosureRequest({ kind: 'witness', ...(d.issuer.trim() ? { issuer: d.issuer.trim() } : {}), ...(d.signer.trim() ? { signer: d.signer.trim() } : {}), ...(d.limit.trim() ? { limit } : {}), ...tail });
}

function draftToRequest(d: DraftPredicate): PredicateRequest | null {
    const field = d.field.trim();
    if (!field) return null;
    if (d.op === 'in') {
        const set = d.value.split(/[,\s]+/).filter(Boolean).map(Number);
        if (set.length === 0 || set.some((n) => !Number.isFinite(n))) return null;
        return { field, op: 'in', set };
    }
    const threshold = Number(d.value);
    if (d.value.trim() === '' || !Number.isFinite(threshold)) return null;
    return { field, op: d.op, threshold };
}

/** Legible rendering used in the issued list + verify results (delegates to humanize). */
function describePredicate(t: TFunction, p: PredicateRequest): string {
    return humanizePredicate(t, p);
}

interface VerifyView {
    valid: boolean;
    tier?: string;
    reason?: string;
    onchain?: boolean;
    presenter?: string | null;
    presenterMismatch?: boolean;
    /** why an otherwise-valid presentation was not accepted here. */
    rejectReason?: RequesterRejectReason;
    predicates?: NonNullable<PresentationVerifyResult['predicates']>;
    standing?: Record<string, number>;
    disclosed?: Record<string, number>;
    /** 2026-10-10: the disclosure answers (each record checked against its proof by the verifier). */
    disclosures?: DisclosureAnswer[];
}

export default function PresentationRequesterScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation();
    const route = useRoute<RequesterRoute>();
    const counterparty = route.params?.counterparty; // whose profile we came from (the presenter)

    // the relay-signed challenge envelope (audience = this wallet id). Null until issued.
    const [envelope, setEnvelope] = useState<ChallengeEnvelope | null>(null);
    const [issuing, setIssuing] = useState(false);
    // §2.6: the predicates this requester names. Frozen into the challenge payload when issued.
    const [drafts, setDrafts] = useState<DraftPredicate[]>([]);
    const [issuedPredicates, setIssuedPredicates] = useState<PredicateRequest[]>([]);
    // 2026-10-10: the disclosure requests this requester names — frozen into the signed challenge.
    const [discDrafts, setDiscDrafts] = useState<DraftDisclosure[]>([]);
    const [issuedDisclosures, setIssuedDisclosures] = useState<CanonicalDisclosureRequest[]>([]);
    const discRequests = useMemo(() => discDrafts.map(draftToDisclosure), [discDrafts]);
    const discValid = discRequests.every((r) => r !== null);
    const addDiscDraft = useCallback((kind: 'pe' | 'witness') => {
        setDiscDrafts((d) => [...d, { kind, digest: '', issuer: '', signer: '', limit: '5', fields: '', content: [] }]);
    }, []);
    const updateDiscDraft = useCallback((i: number, patch: Partial<DraftDisclosure>) => {
        setDiscDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    }, []);
    const removeDiscDraft = useCallback((i: number) => { setDiscDrafts((d) => d.filter((_, j) => j !== i)); }, []);
    const toggleDiscContent = useCallback((i: number, c: DisclosureContent) => {
        setDiscDrafts((d) => d.map((x, j) => (j === i ? { ...x, content: x.content.includes(c) ? x.content.filter((y) => y !== c) : [...x.content, c] } : x)));
    }, []);
    const [token, setToken] = useState('');
    const [result, setResult] = useState<VerifyView | null>(null);
    const [verifying, setVerifying] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    // HANDSHAKE STATE READ (Part C/C2) — a private counterparty read, on demand.
    const [hsState, setHsState] = useState<{ role: string; state: string; reason?: string } | null>(null);
    const [hsLoading, setHsLoading] = useState(false);

    const checkHandshake = useCallback(async () => {
        if (!counterparty) return;
        setHsLoading(true);
        try {
            // Show BOTH directions: this human as presenter → them, and them → this human.
            const [mine, theirs] = await Promise.all([
                RelayAPIService.readHandshakeState({ counterparty, role: 'presenter' }),
                RelayAPIService.readHandshakeState({ counterparty, role: 'audience' }),
            ]);
            const youToThem = t('trustLayer.requester.roleYouToThem');
            const themToYou = t('trustLayer.requester.roleThemToYou');
            const live = mine.state === 'live' ? { role: youToThem, state: mine.state, reason: mine.reasonClass }
                : theirs.state === 'live' ? { role: themToYou, state: theirs.state, reason: theirs.reasonClass }
                : mine.state !== 'none' ? { role: youToThem, state: mine.state, reason: mine.reasonClass }
                : { role: themToYou, state: theirs.state, reason: theirs.reasonClass };
            setHsState(live);
        } catch (e) {
            setHsState({ role: '', state: 'error', reason: e instanceof Error ? e.message : 'read_failed' });
        } finally {
            setHsLoading(false);
        }
    }, [counterparty, t]);

    const draftRequests = useMemo(() => drafts.map(draftToRequest), [drafts]);
    const draftsValid = draftRequests.every((r) => r !== null);

    // Addressed to a specific presenter when we came from an address-keyed profile.
    const presenterAddress = counterparty && ADDRESS_RE.test(counterparty.trim()) ? counterparty.trim().toLowerCase() : undefined;

    const issueChallenge = useCallback(async () => {
        // Freeze the named predicates into the challenge — the SAME canonical parser the presenter
        // runs over the QR, so a malformed draft never ships.
        const named = normalizePredicateRequests(draftRequests.filter((r): r is PredicateRequest => r !== null));
        if (named === null) { Alert.alert(t('trustLayer.requester.checkPredicatesTitle'), t('trustLayer.requester.checkPredicatesBody')); return; }
        if (!discValid) { Alert.alert(t('trustLayer.requester.checkDisclosuresTitle'), t('trustLayer.requester.checkDisclosuresBody')); return; }
        const namedDisclosures = discRequests.filter((r): r is CanonicalDisclosureRequest => r !== null);
        // the relay signs the challenge for this wallet. There is no unsigned fallback — a
        // presenter must be able to see who is asking before it burns.
        setIssuing(true);
        try {
            const env = await RelayAPIService.issueWalletPresentationChallenge({
                predicates: named,
                ...(namedDisclosures.length > 0 ? { disclosures: namedDisclosures } : {}),
                ...(presenterAddress ? { presenter: presenterAddress } : {}),
            });
            setEnvelope(env);
            setIssuedPredicates([...(env.predicates ?? [])]);
            setIssuedDisclosures([...(env.disclosures ?? [])]);
            setResult(null);
        } catch (e) {
            Alert.alert(t('trustLayer.requester.issueFailed'), errorDisplayCopy(e instanceof Error ? e.message : t('common.error')));
        } finally {
            setIssuing(false);
        }
    }, [draftRequests, discRequests, discValid, presenterAddress, t]);

    const challengePayload = useMemo(() => (envelope ? JSON.stringify(envelope) : ''), [envelope]);

    const shareChallenge = useCallback(async () => {
        if (!challengePayload) return;
        try { await Share.share({ message: challengePayload }); } catch { /* dismissed */ }
    }, [challengePayload]);

    const [showAdvanced, setShowAdvanced] = useState(false);

    const addPreset = useCallback((p: PredicatePreset) => {
        setDrafts((d) => (d.some((x) => x.field === p.field)
            ? d
            : [...d, { field: p.field, op: p.op, value: p.value, label: p.label, unit: p.unit, tunable: p.tunable }]));
    }, []);
    const addDraft = useCallback(() => {
        setShowAdvanced(true);
        setDrafts((d) => [...d, { field: SUGGESTED_FIELDS[0], op: 'gte', value: '' }]);
    }, []);
    const updateDraft = useCallback((i: number, patch: Partial<DraftPredicate>) => {
        setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    }, []);
    const removeDraft = useCallback((i: number) => { setDrafts((d) => d.filter((_, j) => j !== i)); }, []);
    const cycleOp = useCallback((i: number) => {
        setDrafts((d) => d.map((x, j) => (j === i ? { ...x, op: PREDICATE_OPS[(PREDICATE_OPS.indexOf(x.op) + 1) % PREDICATE_OPS.length] } : x)));
    }, []);

    const onScanToken = useCallback(async () => {
        if (!permission?.granted) {
            const res = await requestPermission();
            if (!res.granted) { Alert.alert(t('trustLayer.presenter.cameraNeededTitle'), t('trustLayer.requester.cameraNeededBody')); return; }
        }
        setScanning(true);
    }, [permission, requestPermission, t]);

    const handleScanned = useCallback((e: { data: string }) => { setScanning(false); setToken(e.data); }, []);

    const doVerify = useCallback(async () => {
        if (!token.trim() || !envelope) {
            Alert.alert(t('trustLayer.requester.missingInputTitle'), envelope ? t('trustLayer.requester.missingToken') : t('trustLayer.requester.missingChallenge'));
            return;
        }
        setVerifying(true);
        setResult(null);
        try {
            // verify against the EXACT envelope issued (audience, challenge, predicates, presenter,
            // deadline); the relay refuses a presentation that did not answer a named predicate.
            const r = await RelayAPIService.verifyPresentation({
                token: token.trim(),
                challenge_envelope: envelope,
                ...(counterparty ? { expected_presenter: presenterAddress ?? counterparty.trim() } : {}),
            });
            // Both tiers carry the SIGNED presenter_address + sub at the top level. Never read `sub`
            // from a pe_fact payload: it is outside every signature there.
            const identity = { presenter_address: r.presenter_address, sub: r.sub };
            const presenter = extractPresenterLabel(identity);
            // WHO presented matters as much as WHETHER it verifies (F8). When this
            // screen was opened from a specific counterparty's profile, a valid
            // presentation from a DIFFERENT presenter is NOT an answer to our ask —
            // treat it as not valid and say why, rather than showing a green check.
            const presenterMismatch = r.reason === 'presenter_mismatch' || Boolean(
                r.valid && counterparty && !presenterMatchesCounterparty(identity, counterparty),
            );
            // a valid token is ACCEPTED only when it is a reputation presentation (if checks were
            // named) from the presenter asked, carries its presentation_id, and was never accepted here.
            const decision = await acceptVerifiedPresentation(
                { valid: r.valid === true, tier: r.tier, presentation_id: r.presentation_id, challenge_expires_at: r.challenge_expires_at },
                { predicatesAsked: issuedPredicates.length, presenterMatches: !presenterMismatch },
            );
            const rejectReason = decision.accepted ? undefined : decision.reason;
            setResult({
                valid: decision.accepted,
                tier: r.tier,
                reason: rejectReason && rejectReason !== 'not_valid' ? rejectReason : (r.reason ?? r.error),
                onchain: r.onchain_checked,
                presenter,
                presenterMismatch,
                rejectReason,
                predicates: r.predicates,
                standing: r.standing,
                disclosed: r.disclosed,
                disclosures: r.disclosures,
            });
        } catch (e) {
            setResult({ valid: false, reason: e instanceof Error ? e.message : 'verify_failed' });
        } finally {
            setVerifying(false);
        }
    }, [token, envelope, counterparty, presenterAddress, issuedPredicates, t]);

    const adverse = useMemo(() => {
        const s = result?.standing ?? {};
        return Object.entries(s).filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b));
    }, [result]);
    const disclosedRows = useMemo(() => {
        const d = result?.disclosed ?? {};
        return Object.entries(d).filter(([k]) => !k.startsWith('standing.')).sort(([a], [b]) => a.localeCompare(b));
    }, [result]);

    if (scanning) {
        return (
            <SafeAreaView style={styles.safe} edges={['top']}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => setScanning(false)}><Ionicons name="close" size={26} color={COLORS.text} /></TouchableOpacity>
                    <Text style={styles.headerTitle}>{t('trustLayer.requester.scanTitle')}</Text>
                    <View style={{ width: 26 }} />
                </View>
                <CameraView style={{ flex: 1 }} facing="back" onBarcodeScanned={handleScanned} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} />
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.safe} edges={['top']}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Ionicons name="chevron-back" size={26} color={COLORS.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{t('trustLayer.requester.title')}</Text>
                <View style={{ width: 26 }} />
            </View>

            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                {counterparty ? (
                    <Text style={styles.lede}>
                        {t('trustLayer.requester.ledeAskLead')}
                        <Text style={styles.ledeStrong}>{counterparty}</Text>
                        {t('trustLayer.requester.ledeAskTail')}
                    </Text>
                ) : (
                    <Text style={styles.lede}>{t('trustLayer.requester.lede')}</Text>
                )}
                <View style={styles.explainer}>
                    <Text style={styles.explainerLine}>
                        <Text style={styles.explainerStrong}>{t('trustLayer.requester.explainerTitle')}</Text>{' '}
                        {t('trustLayer.requester.explainerBody')}
                    </Text>
                    <Text style={styles.explainerLine}>
                        <Text style={styles.explainerStrong}>{t('trustLayer.requester.checkExplainerTitle')}</Text>{' '}
                        {t('trustLayer.requester.checkExplainerBody')}
                    </Text>
                </View>

                {/* Relationship status — the live handshake read (Part C/C2), on demand.
                    Never sourced from Commons; a private read between the two parties. */}
                {counterparty && (
                    <View style={styles.hsBlock}>
                        <View style={styles.rowBetween}>
                            <Text style={styles.section}>{t('trustLayer.requester.relationshipTitle')}</Text>
                            <TouchableOpacity onPress={checkHandshake} disabled={hsLoading}>
                                <Text style={styles.scanLink}>{hsLoading ? '…' : hsState ? t('trustLayer.requester.refresh') : t('trustLayer.requester.check')}</Text>
                            </TouchableOpacity>
                        </View>
                        {hsState ? (
                            <View style={[styles.resultCard, { borderColor: hsState.state === 'live' ? COLORS.platinumMuted : COLORS.errorMuted, marginTop: SPACING.s }]}>
                                <Text style={styles.resultTitle}>
                                    {hsState.state === 'live' ? t('trustLayer.requester.hsLive')
                                        : hsState.state === 'lapsed' ? t('trustLayer.requester.hsLapsed')
                                        : hsState.state === 'invalidated' ? t('trustLayer.requester.hsInvalidated')
                                        : hsState.state === 'none' ? t('trustLayer.requester.hsNone')
                                        : t('trustLayer.requester.hsUnavailable')}
                                    {hsState.role ? `  ·  ${hsState.role}` : ''}
                                </Text>
                                <Text style={styles.resultSub}>
                                    {hsState.state === 'live' ? t('trustLayer.requester.hsLiveBody')
                                        : hsState.state === 'invalidated' ? (hsState.reason ? t('trustLayer.requester.hsInvalidatedBodyReason', { reason: hsState.reason }) : t('trustLayer.requester.hsInvalidatedBody'))
                                        : hsState.state === 'lapsed' ? t('trustLayer.requester.hsLapsedBody')
                                        : hsState.state === 'none' ? t('trustLayer.requester.hsNoneBody')
                                        : (hsState.reason ?? t('trustLayer.requester.hsReadFailed'))}
                                </Text>
                            </View>
                        ) : (
                            <Text style={styles.hsHint}>{t('trustLayer.requester.hsHint')}</Text>
                        )}
                    </View>
                )}

                {/* STEP 1 — build the request (the challenge) */}
                <Text style={styles.section}>{t('trustLayer.requester.step1')}</Text>
                <Text style={styles.hsHint} selectable>
                    {envelope?.requester
                        ? t('trustLayer.requester.signedBy', { id: envelope.requester.id })
                        : t('trustLayer.requester.signedHint')}
                </Text>

                {/* §2.6: name predicates — the checks you write against their record, in plain language. */}
                {!envelope && (
                    <View style={styles.predCard}>
                        <Text style={styles.cardTitle}>{t('trustLayer.requester.mustBeTrueTitle')}</Text>
                        <Text style={styles.hsHint}>{t('trustLayer.requester.mustBeTrueHint')}</Text>

                        {/* Chosen checks — friendly rows (a preset shows its plain label; an advanced row shows the raw field). */}
                        {drafts.map((d, i) => {
                            const ok = draftRequests[i] !== null;
                            if (d.label) {
                                return (
                                    <View key={i} style={[styles.predRow, !ok && styles.predRowBad]}>
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.predRowLabel}>{t(d.label)}</Text>
                                            {d.tunable && (
                                                <View style={styles.tuneRow}>
                                                    <Text style={styles.tuneWord}>{t('trustLayer.requester.atLeast')}</Text>
                                                    <TextInput style={[styles.input, styles.tuneInput]} value={d.value} onChangeText={(v) => updateDraft(i, { value: v })} keyboardType="numeric" placeholder="1" placeholderTextColor={COLORS.textMuted} />
                                                    {d.unit && <Text style={styles.tuneWord}>{t(d.unit)}</Text>}
                                                </View>
                                            )}
                                        </View>
                                        <TouchableOpacity onPress={() => removeDraft(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={20} color={COLORS.textMuted} /></TouchableOpacity>
                                    </View>
                                );
                            }
                            return (
                                <View key={i} style={[styles.predRow, !ok && styles.predRowBad]}>
                                    <TextInput style={[styles.input, styles.predField]} value={d.field} onChangeText={(v) => updateDraft(i, { field: v })} autoCapitalize="none" autoCorrect={false} placeholder={t('trustLayer.requester.fieldPlaceholder')} placeholderTextColor={COLORS.textMuted} />
                                    <TouchableOpacity style={styles.opBtn} onPress={() => cycleOp(i)}><Text style={styles.opText}>{OP_LABEL[d.op]}</Text></TouchableOpacity>
                                    <TextInput style={[styles.input, styles.predValue]} value={d.value} onChangeText={(v) => updateDraft(i, { value: v })} keyboardType={d.op === 'in' ? 'default' : 'numeric'} placeholder={d.op === 'in' ? '1, 2' : '0'} placeholderTextColor={COLORS.textMuted} />
                                    <TouchableOpacity onPress={() => removeDraft(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={20} color={COLORS.textMuted} /></TouchableOpacity>
                                </View>
                            );
                        })}

                        {/* The plain-language menu — tap to add. Only shows checks not already chosen. */}
                        <View style={styles.presetWrap}>
                            {PREDICATE_PRESETS.filter((p) => !drafts.some((d) => d.field === p.field)).map((p) => (
                                <TouchableOpacity key={p.key} style={styles.presetBtn} onPress={() => addPreset(p)}>
                                    <Ionicons name="add-circle-outline" size={18} color={COLORS.platinum} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.presetLabel}>{t(p.label)}</Text>
                                        <Text style={styles.presetHelp}>{t(p.help)}</Text>
                                    </View>
                                </TouchableOpacity>
                            ))}
                        </View>

                        {/* Advanced escape hatch — any raw vocabulary field. */}
                        {showAdvanced || drafts.some((d) => !d.label) ? (
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: SPACING.s }}>
                                {SUGGESTED_FIELDS.map((f) => (
                                    <TouchableOpacity key={f} style={styles.chip} onPress={() => addPreset({ key: f, label: '', help: '', field: f, op: 'gte', value: '' })}>
                                        <Text style={styles.chipText}>{f}</Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        ) : null}
                        <TouchableOpacity onPress={addDraft} style={{ marginTop: SPACING.m }}>
                            <Text style={styles.scanLink}>{t('trustLayer.requester.advancedCustom')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* 2026-10-10: ask to SEE — a specific record by digest, or records witnessed by an issuer / signer. */}
                {!envelope && (
                    <View style={styles.predCard} testID="disclosure-drafts">
                        <Text style={styles.cardTitle}>{t('trustLayer.requester.discTitle')}</Text>
                        <Text style={styles.hsHint}>{t('trustLayer.requester.discHint')}</Text>
                        {discDrafts.map((d, i) => {
                            const ok = discRequests[i] !== null;
                            return (
                                <View key={`dd-${i}`} style={[styles.discDraft, !ok && styles.predRowBad]}>
                                    <View style={styles.rowBetween}>
                                        <Text style={styles.cardTitle}>{d.kind === 'pe' ? t('trustLayer.requester.discKindPe') : t('trustLayer.requester.discKindWitness')}</Text>
                                        <TouchableOpacity onPress={() => removeDiscDraft(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Ionicons name="close-circle" size={20} color={COLORS.textMuted} /></TouchableOpacity>
                                    </View>
                                    {d.kind === 'pe' && (
                                        <TextInput style={[styles.input, styles.predField]} value={d.digest} onChangeText={(v) => updateDiscDraft(i, { digest: v })} autoCapitalize="none" autoCorrect={false} placeholder={t('trustLayer.requester.discDigestPlaceholder')} placeholderTextColor={COLORS.textMuted} />
                                    )}
                                    <TextInput style={[styles.input, styles.predField]} value={d.issuer} onChangeText={(v) => updateDiscDraft(i, { issuer: v })} autoCapitalize="none" autoCorrect={false} placeholder={t('trustLayer.requester.discIssuerPlaceholder')} placeholderTextColor={COLORS.textMuted} />
                                    {d.kind === 'witness' && (
                                        <View style={styles.predRow}>
                                            <TextInput style={[styles.input, styles.predField]} value={d.signer} onChangeText={(v) => updateDiscDraft(i, { signer: v })} autoCapitalize="none" autoCorrect={false} placeholder={t('trustLayer.requester.discSignerPlaceholder')} placeholderTextColor={COLORS.textMuted} />
                                            <Text style={styles.tuneWord}>{t('trustLayer.requester.discLimitLabel')}</Text>
                                            <TextInput style={[styles.input, styles.predValue]} value={d.limit} onChangeText={(v) => updateDiscDraft(i, { limit: v })} keyboardType="numeric" placeholder="5" placeholderTextColor={COLORS.textMuted} />
                                        </View>
                                    )}
                                    <TextInput style={[styles.input, styles.predField]} value={d.fields} onChangeText={(v) => updateDiscDraft(i, { fields: v })} autoCapitalize="none" autoCorrect={false} placeholder={t('trustLayer.requester.discFieldsPlaceholder')} placeholderTextColor={COLORS.textMuted} />
                                    <Text style={styles.hsHint}>{t('trustLayer.requester.discContentLabel')}</Text>
                                    <View style={styles.presetWrap}>
                                        {DISCLOSURE_CONTENT_ELECTIONS.map((c) => {
                                            const on = d.content.includes(c);
                                            return (
                                                <TouchableOpacity key={c} style={[styles.chip, on && styles.chipOn]} onPress={() => toggleDiscContent(i, c)}>
                                                    <Text style={[styles.chipText, on && { color: COLORS.platinum }]}>{t(CONTENT_LABEL[c])}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            );
                        })}
                        <View style={styles.presetWrap}>
                            <TouchableOpacity style={styles.presetBtn} onPress={() => addDiscDraft('pe')}>
                                <Ionicons name="add-circle-outline" size={18} color={COLORS.platinum} />
                                <View style={{ flex: 1 }}><Text style={styles.presetLabel}>{t('trustLayer.requester.discAddPe')}</Text><Text style={styles.presetHelp}>{t('trustLayer.requester.discAddPeHelp')}</Text></View>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.presetBtn} onPress={() => addDiscDraft('witness')}>
                                <Ionicons name="add-circle-outline" size={18} color={COLORS.platinum} />
                                <View style={{ flex: 1 }}><Text style={styles.presetLabel}>{t('trustLayer.requester.discAddWitness')}</Text><Text style={styles.presetHelp}>{t('trustLayer.requester.discAddWitnessHelp')}</Text></View>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}

                {envelope ? (
                    <View style={styles.card}>
                        {challengePayload.length <= QR_MAX_CHARS ? (
                            <View style={styles.qrWrap}><QRCode value={challengePayload} size={180} backgroundColor="white" color="#111827" onError={() => undefined} /></View>
                        ) : (
                            <Text style={styles.qrCaption}>{t('trustLayer.requester.tooLargeForQr')}</Text>
                        )}
                        <Text style={styles.mono} selectable numberOfLines={2}>{envelope.challenge}</Text>
                        {issuedPredicates.length > 0 && (
                            <View style={{ alignSelf: 'stretch', marginBottom: SPACING.s }}>
                                {issuedPredicates.map((p, i) => <Text key={i} style={styles.predIssued}>• {describePredicate(t, p)}</Text>)}
                            </View>
                        )}
                        {issuedDisclosures.length > 0 && (
                            <View style={{ alignSelf: 'stretch', marginBottom: SPACING.s }}>
                                {issuedDisclosures.map((r, i) => (
                                    <View key={`id-${i}`}>
                                        <Text style={styles.predIssued}>◦ {describeDisclosureRequest(t, r)}</Text>
                                        {describeDisclosureExtras(t, r).map((line, j) => <Text key={j} style={styles.predIssued}>   {line}</Text>)}
                                    </View>
                                ))}
                            </View>
                        )}
                        <Text style={styles.qrCaption}>{t('trustLayer.requester.qrCaption')}</Text>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={shareChallenge}>
                            <Ionicons name="share-outline" size={16} color={COLORS.platinum} />
                            <Text style={styles.secondaryBtnText}>{t('trustLayer.requester.sendRequest')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => { setEnvelope(null); setIssuedPredicates([]); setIssuedDisclosures([]); setResult(null); }}><Text style={styles.again}>{t('trustLayer.requester.newRequest')}</Text></TouchableOpacity>
                    </View>
                ) : (
                    <TouchableOpacity style={[styles.primaryBtn, (!draftsValid || !discValid || issuing) && styles.disabled]} onPress={() => void issueChallenge()} disabled={!draftsValid || !discValid || issuing}>
                        {issuing ? <ActivityIndicator color={COLORS.black} /> : <Text style={styles.primaryBtnText}>{t('trustLayer.requester.createRequest')}</Text>}
                    </TouchableOpacity>
                )}

                {/* STEP 2 — verify */}
                <Text style={styles.section}>{t('trustLayer.requester.step2')}</Text>
                <View style={styles.rowBetween}>
                    <Text style={styles.inputLabel}>{t('trustLayer.requester.tokenLabel')}</Text>
                    <TouchableOpacity onPress={onScanToken}><Text style={styles.scanLink}>{t('trustLayer.requester.scan')}</Text></TouchableOpacity>
                </View>
                <TextInput style={[styles.input, styles.tokenInput]} value={token} onChangeText={setToken} placeholder={t('trustLayer.requester.tokenPlaceholder')} placeholderTextColor={COLORS.textMuted} autoCapitalize="none" multiline />
                <TouchableOpacity style={[styles.primaryBtn, (!envelope || verifying) && styles.disabled]} onPress={doVerify} disabled={!envelope || verifying}>
                    {verifying ? <ActivityIndicator color={COLORS.black} /> : <Text style={styles.primaryBtnText}>{t('trustLayer.requester.verifyBtn')}</Text>}
                </TouchableOpacity>

                {result && (
                    <View style={[styles.resultCard, { borderColor: result.valid ? COLORS.platinumMuted : COLORS.errorMuted }]}>
                        <View style={styles.rowCenter}>
                            <Ionicons name={result.valid ? 'checkmark-circle' : 'close-circle'} size={22} color={result.valid ? COLORS.success : COLORS.error} />
                            <Text style={styles.resultTitle}>{result.valid ? t('trustLayer.requester.resultVerified') : result.presenterMismatch ? t('trustLayer.requester.resultWrongPresenter') : result.rejectReason === 'already_accepted' ? t('trustLayer.requester.alreadyAcceptedTitle') : t('trustLayer.requester.resultNotValid')}</Text>
                        </View>
                        {/* Always surface WHO presented — the presenter is part of what was verified. */}
                        {result.presenter && (
                            <Text style={styles.resultPresenter} selectable numberOfLines={1} ellipsizeMode="middle">
                                {t('trustLayer.requester.presenterLine', { presenter: result.presenter })}
                            </Text>
                        )}
                        {result.valid
                            ? <Text style={styles.resultSub}>{result.onchain ? t('trustLayer.requester.validSubOnchain', { tier: result.tier }) : t('trustLayer.requester.validSub', { tier: result.tier })}</Text>
                            : result.presenterMismatch
                                ? <Text style={styles.resultSub}>{t('trustLayer.requester.mismatchSub', { counterparty })}</Text>
                                : result.rejectReason === 'already_accepted'
                                    ? <Text style={styles.resultSub}>{t('trustLayer.requester.alreadyAcceptedBody')}</Text>
                                    : result.rejectReason === 'predicates_require_reputation_tier'
                                        ? <Text style={styles.resultSub}>{t('trustLayer.requester.tierMismatch')}</Text>
                                        : result.rejectReason === 'presentation_id_missing'
                                            ? <Text style={styles.resultSub}>{t('trustLayer.requester.missingId')}</Text>
                                            : <Text style={styles.resultSub}>{t('trustLayer.requester.notValidReason', { reason: result.reason ?? 'unknown' })}</Text>}

                        {/* §2.6: predicate results — the answer to what you asked. */}
                        {result.valid && result.predicates && result.predicates.length > 0 && (
                            <View style={styles.block}>
                                <Text style={styles.blockTitle}>{t('trustLayer.requester.predicatesTitle')}</Text>
                                {result.predicates.map((p, i) => (
                                    <View key={i} style={styles.factRow}>
                                        <Ionicons name={p.result ? 'checkmark-circle' : 'close-circle'} size={16} color={p.result ? COLORS.success : COLORS.error} />
                                        <Text style={styles.factText}>{describePredicate(t, p)}</Text>
                                        <Text style={[styles.factValue, { color: p.result ? COLORS.success : COLORS.error }]}>{p.result ? t('trustLayer.presenter.answerYes') : t('trustLayer.presenter.answerNo')}</Text>
                                    </View>
                                ))}
                            </View>
                        )}

                        {/* §2.5: Standing — always present; adverse facts the presenter could not withhold. */}
                        {result.valid && result.tier === 'reputation' && (
                            <View style={styles.block}>
                                <Text style={styles.blockTitle}>{t('trustLayer.ownProfile.group.standing')}</Text>
                                {adverse.length === 0
                                    ? <Text style={styles.factOk}>{t('trustLayer.ownProfile.adverseClean')}</Text>
                                    : adverse.map(([k, v]) => (
                                        <View key={k} style={styles.factRow}>
                                            <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                                            <Text style={styles.factText}>{k.slice('standing.'.length)}</Text>
                                            <Text style={[styles.factValue, { color: COLORS.error }]}>{v}</Text>
                                        </View>
                                    ))}
                            </View>
                        )}

                        {/* 2026-10-10: the disclosure answers — what they elected to disclose, record by record, and what they declined. */}
                        {result.valid && result.disclosures && result.disclosures.length > 0 && (
                            <View style={styles.block} testID="disclosure-answers">
                                <Text style={styles.blockTitle}>{t('trustLayer.requester.discResultTitle')}</Text>
                                {result.disclosures.map((a, i) => (
                                    <View key={`da-${i}`} style={{ marginBottom: SPACING.s }}>
                                        <View style={styles.factRow}>
                                            <Ionicons name={a.election === 'disclosed' ? 'eye-outline' : 'eye-off-outline'} size={16} color={a.election === 'disclosed' ? COLORS.success : COLORS.textMuted} />
                                            <Text style={styles.factText}>{describeDisclosureRequest(t, a.request)}</Text>
                                            <Text style={styles.factValue}>{a.election === 'disclosed' ? t('trustLayer.requester.discResultDisclosed') : t('trustLayer.requester.discResultDeclined')}</Text>
                                        </View>
                                        {a.election === 'disclosed' && (a.records ?? []).length === 0 && <Text style={styles.hsHint}>{t('trustLayer.requester.discResultNone')}</Text>}
                                        {(a.records ?? []).map((rec) => (
                                            <View key={rec.pe_id} style={{ paddingLeft: SPACING.l }}>
                                                <Text style={styles.factText}>{describeDisclosedRecord(t, rec, (at) => getActionTypeDisplay(at).label)}</Text>
                                                {rec.fields && Object.entries(rec.fields).map(([k, v]) => <Text key={k} style={styles.factText}>  {k} = {typeof v === 'string' ? v : JSON.stringify(v)}</Text>)}
                                                {rec.content?.description !== undefined && <Text style={styles.factText}>  {t('trustLayer.disclosure.contentDescription')}: {rec.content.description ?? '—'}</Text>}
                                                {rec.content?.intent !== undefined && <Text style={styles.factText}>  {t('trustLayer.disclosure.contentIntent')}: {rec.content.intent ?? '—'}</Text>}
                                                {rec.content?.artifacts !== undefined && <Text style={styles.factText}>  {t('trustLayer.disclosure.contentArtifacts')}: {rec.content.artifacts.length}</Text>}
                                                {rec.content?.fact_tier !== undefined && <Text style={styles.factText}>  {t('trustLayer.disclosure.contentFactTier')}: ✓</Text>}
                                            </View>
                                        ))}
                                    </View>
                                ))}
                            </View>
                        )}

                        {/* Disclosed raw facts (whatever the presenter chose to share). */}
                        {result.valid && disclosedRows.length > 0 && (
                            <View style={styles.block}>
                                <Text style={styles.blockTitle}>{t('trustLayer.requester.disclosedTitle')}</Text>
                                {disclosedRows.map(([k, v]) => (
                                    <View key={k} style={styles.factRow}>
                                        <Text style={styles.factText}>{k}</Text>
                                        <Text style={styles.factValue}>{v}</Text>
                                    </View>
                                ))}
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: COLORS.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
    headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
    body: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
    lede: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 21, marginBottom: SPACING.l },
    ledeStrong: { color: COLORS.platinum, fontWeight: '700' },
    section: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginTop: SPACING.l, marginBottom: SPACING.s },
    cardTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
    inputLabel: { color: COLORS.textSecondary, fontSize: 13, marginBottom: SPACING.s, marginTop: SPACING.s },
    input: { backgroundColor: COLORS.surfaceHighlight, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.l, paddingVertical: SPACING.m, color: COLORS.text, fontSize: 15, borderWidth: 1, borderColor: COLORS.border },
    tokenInput: { minHeight: 72, textAlignVertical: 'top' },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    rowCenter: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
    scanLink: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },
    card: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.platinumMuted, alignItems: 'center', marginTop: SPACING.m },
    predCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.border, marginTop: SPACING.m },
    predRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.s },
    predRowBad: { opacity: 0.7 },
    predField: { flex: 1, paddingHorizontal: SPACING.s, paddingVertical: SPACING.s, fontSize: 12, fontFamily: 'monospace' },
    predValue: { width: 72, paddingHorizontal: SPACING.s, paddingVertical: SPACING.s, fontSize: 13 },
    opBtn: { paddingHorizontal: SPACING.s, paddingVertical: SPACING.s, borderRadius: BORDER_RADIUS.s, backgroundColor: COLORS.surfaceHighlight, borderWidth: 1, borderColor: COLORS.platinumMuted, minWidth: 34, alignItems: 'center' },
    opText: { color: COLORS.platinum, fontSize: 14, fontWeight: '700' },
    chip: { paddingHorizontal: SPACING.s, paddingVertical: SPACING.xs, borderRadius: BORDER_RADIUS.round, borderWidth: 1, borderColor: COLORS.border, marginRight: SPACING.xs },
    chipText: { color: COLORS.textSecondary, fontSize: 11, fontFamily: 'monospace' },
    chipOn: { borderColor: COLORS.platinum, backgroundColor: COLORS.surfaceHighlight },
    discDraft: { marginTop: SPACING.s, padding: SPACING.s, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.xs },
    predIssued: { color: COLORS.textSecondary, fontSize: 12, fontFamily: 'monospace' },
    qrWrap: { backgroundColor: 'white', padding: SPACING.m, borderRadius: BORDER_RADIUS.m, marginBottom: SPACING.m },
    mono: { color: COLORS.textMuted, fontSize: 11, marginBottom: SPACING.m },
    primaryBtn: { backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.m, alignItems: 'center', marginTop: SPACING.m },
    primaryBtnText: { color: COLORS.black, fontSize: 15, fontWeight: '700' },
    disabled: { opacity: 0.4 },
    secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingVertical: SPACING.s },
    secondaryBtnText: { color: COLORS.platinum, fontSize: 14, fontWeight: '600' },
    again: { color: COLORS.primary, fontSize: 13, fontWeight: '600', marginTop: SPACING.s },
    resultCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, marginTop: SPACING.l },
    resultTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
    resultPresenter: { color: COLORS.text, fontSize: 12, fontFamily: 'monospace', marginTop: SPACING.s },
    resultSub: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19, marginTop: SPACING.s },
    block: { marginTop: SPACING.m, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.s },
    blockTitle: { color: COLORS.platinum, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.xs },
    factRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingVertical: SPACING.xs },
    factText: { color: COLORS.textSecondary, fontSize: 12, fontFamily: 'monospace', flex: 1 },
    factValue: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
    factOk: { color: COLORS.success, fontSize: 13 },
    hsBlock: { marginBottom: SPACING.s },
    hsHint: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18, marginTop: SPACING.xs },
    explainer: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, padding: SPACING.m, marginBottom: SPACING.m, gap: SPACING.s },
    explainerLine: { color: COLORS.textSecondary, fontSize: 12.5, lineHeight: 19 },
    explainerStrong: { color: COLORS.text, fontWeight: '700' },
    predRowLabel: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
    tuneRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginTop: SPACING.xs },
    tuneWord: { color: COLORS.textMuted, fontSize: 13 },
    tuneInput: { width: 72, paddingVertical: SPACING.s, paddingHorizontal: SPACING.s, fontSize: 14 },
    presetWrap: { marginTop: SPACING.s, gap: SPACING.xs },
    presetBtn: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, paddingVertical: SPACING.s, paddingHorizontal: SPACING.s, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceHighlight },
    presetLabel: { color: COLORS.text, fontSize: 13.5, fontWeight: '600' },
    presetHelp: { color: COLORS.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 1 },
    qrCaption: { color: COLORS.textMuted, fontSize: 11.5, textAlign: 'center', marginBottom: SPACING.s },
});
