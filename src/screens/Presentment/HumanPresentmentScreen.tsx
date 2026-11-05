import { errorDisplayCopy } from '../../i18n/displayCopy';
import { ActionWallet } from '../../core/security/ActionWallet';
import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
/**
 * Present my credentials — the human PRESENTER leg of burn-to-present.
 *
 * This is the trust mechanism, not a burn-and-show. A counterparty (the requester)
 * hands you a CHALLENGE bound to their id; you burn PVT and produce a signed
 * presentation bound to that requester, that challenge and this moment, and hand the token
 * back. The burn is single-use at issuance; the presentation expires within minutes; they
 * verify it themselves — even with no Provian account — and a careful requester accepts it
 * once (the app requester and the SDK do).
 *
 * BEFORE any burn the screen verifies WHO is asking. A signed challenge (domain key or
 * relay-signed Provian wallet) shows "Requester: … — Verified"; an unsigned one shows
 * "Unverified (unsigned challenge)"; an invalid / expired / not-addressed one is REFUSED and no
 * burn can start (`presenterBurnDecision`). A verified envelope rides to `/present` as
 * `challenge_envelope`, and the presenter signs the v2 binding (requester + chal_exp).
 *
 * TWO TIERS (Trust Layer §2.6 — "the mobile presenter presents both tiers"):
 * - REPUTATION: your LIVE vocabulary (§2.5) — the flat numeric facts the relay computes
 * over your record right now. You choose which to withhold; `standing.*` (adverse
 * events, bond status, invalidation) is ALWAYS present and cannot be withheld. The
 * requester may NAME PREDICATES in its challenge (e.g. continuity.chain_depth ≥ 100);
 * the relay computes them, Provian co-signs the boolean results, and the raw field
 * behind a predicate is never disclosed (the relay withholds it even when it is also
 * shared) — except `standing.*`, which is always disclosed.
 * - PE FACT: specific anchored PEs of yours (id + envelope hash), proven against the
 * on-chain PEAnchor root and co-signed by Provian.
 *
 * The burn is the skin in the game. The fixed fee is the tier price (reputation 15 PVT,
 * pe_fact 5 PVT). Provian's verified repository gate sets its own 50 PVT price.
 * The presenter binding is signed with the
 * wallet's own secp256k1 key (EIP-191), biometric-gated via SeedManager — the same key path
 * WalletConnect personal_sign uses. Symmetric with the agent SDK (CommonsInstitutions.present).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { bytesToHex } from '@noble/hashes/utils';
import * as CommonsService from '../../core/commons/CommonsService';
import {
    View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView, Share, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { ethers } from 'ethers';
import { COLORS, SPACING, BORDER_RADIUS } from '../../constants/theme';
import { useWalletStore } from '../../store/walletStore';
import SeedManager from '../../core/wallet/SeedManager';
import TransactionService from '../../core/wallet/TransactionService';
import RelayAPIService, { PresentationRefusedError } from '../../services/RelayAPIService';
import { obtainBroadcastBurn, rememberRecordedBurn, markBurnConsumed, findPendingBurn, isBurnConsumedError, isRevertedBurnError, isRevokedBurnError, BurnStillFinalizingError, type BurnStage } from '../../core/presentation/pendingBurns';
import { getActionTypeDisplay } from '../../utils/actionTypeDisplay';
import {
    buildHumanPresentationRequest, validateRequesterBinding, evaluatePredicateLocally, burnIdForTx,
    type Eip191Signer, type PredicateRequest, type PresentationTier,
} from '../../core/presentation/humanPresentation';
import {
    parseChallengeEnvelope, verifyChallengeEnvelope, fetchRequesterKeysHttps, requesterDisplay,
    type ChallengeEnvelope, type ChallengeVerdict,
} from '../../core/presentation/challengeEnvelope';
import { presenterBurnDecision, type PresenterRefusal } from '../../core/presentation/presenterChallengeGate';
import type { AppParamList } from '../../navigation/types';
import { noteTalkingPassUsed } from '../../core/commons/talkingPassBus';
import { initialPresentmentChallenge, initialPresentmentEnvelope } from '../../core/presentation/presentmentChallenge';
import type { CanonicalDisclosureRequest } from '../../core/presentation/disclosureRequest';
import { describeDisclosureRequest, describeDisclosureExtras } from '../../core/presentation/disclosureDisplay';
import type { DisclosureAnswerInput } from '../../core/presentation/humanPresentation';
import type { DisclosureCandidate } from '../../core/meter/presentablePes';
import { classifyVouchError } from '../../core/commons/vouchModel';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';
import { provianPrGatePrice, provianPrGateOwnerExempt } from '../../core/presentation/prGatePrice';

/** Config-mirrored per-tier standalone fee (backend burn_floor_policy defaults). */
const TIER_FEE_PVT: Record<PresentationTier, number> = { reputation: 15, pe_fact: 5 };
/** Byte-mode QR capacity at the default error-correction level is ~2.3 KB; stay under it. */
const QR_MAX_CHARS = 2000;

/** The relay's per-presentation cap on pe_fact claims (MAX_PE_FACT_CLAIMS). */
const MAX_PE_FACTS = 50;

/** Vocabulary groups, in the order the §2.5 ruling lists them. */
const GROUP_ORDER = ['continuity', 'work', 'coupling', 'consumption', 'money', 'standing', 'accountability', 'composition', 'presentations', 'actor'];
/**
 * Group label i18n keys. The presenter shares the Own Profile group names, except Standing, which
 * reads "Standing (always shared)" here because it is the one group the presenter cannot withhold.
 */
const GROUP_LABEL_KEY: Record<string, string> = {
    continuity: 'trustLayer.ownProfile.group.continuity', work: 'trustLayer.ownProfile.group.work',
    coupling: 'trustLayer.ownProfile.group.coupling', consumption: 'trustLayer.ownProfile.group.consumption',
    money: 'trustLayer.ownProfile.group.money', standing: 'trustLayer.presenter.groupStanding',
    accountability: 'trustLayer.ownProfile.group.accountability', composition: 'trustLayer.ownProfile.group.composition',
    presentations: 'trustLayer.ownProfile.group.presentations', actor: 'trustLayer.ownProfile.group.actor',
    share: 'trustLayer.ownProfile.group.share',
};

const OP_LABEL: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=', in: 'in' };

function describePredicate(p: PredicateRequest): string {
    return p.op === 'in' ? `${p.field} in {${(p.set ?? []).join(', ')}}` : `${p.field} ${OP_LABEL[p.op] ?? p.op} ${p.threshold ?? ''}`;
}

type PresentmentRoute = RouteProp<AppParamList, 'HumanPresentment'>;
/** a thread / remote request may also hand over the relay-signed challenge envelope. */
type PresentmentParams = (NonNullable<AppParamList['HumanPresentment']> & { challengeEnvelope?: unknown }) | undefined;

const REFUSAL_KEY: Record<Exclude<PresenterRefusal, 'checking'>, string> = {
    invalid: 'trustLayer.presenter.refusedInvalid',
    key_unreachable: 'trustLayer.presenter.refusedKeyUnreachable',
    expired: 'trustLayer.presenter.refusedExpired',
    not_addressed: 'trustLayer.presenter.refusedNotAddressed',
    mismatch: 'trustLayer.presenter.refusedMismatch',
    needs_reputation: 'trustLayer.presenter.refusedNeedsReputation',
};

/** A PE this person can present (from the phone's own store; `archivedDay` = pulled from the PE Archive). */
interface PeFactRow { peId: string; hash: string; actionType: string | null; timestamp: number; archivedDay: string | null }

export default function HumanPresentmentScreen(): React.ReactElement {
    const { t } = useTranslation();
    const navigation = useNavigation();
    const route = useRoute<PresentmentRoute>();
    const address = useWalletStore((s) => s.address);
    const params = route.params as PresentmentParams;
    // the requester's challenge envelope (signed or unsigned), verified BEFORE any burn.
    const [envelope, setEnvelope] = useState<ChallengeEnvelope | null>(() => initialPresentmentEnvelope(params));
    const [verdict, setVerdict] = useState<ChallengeVerdict | null>(null);

    const [tier, setTier] = useState<PresentationTier>('reputation');
    // §2.4: the live per-tier burn floor (GET /v1/present/floor); null → defaults.
    const [floor, setFloor] = useState<{ reputation: number; pe_fact: number } | null>(null);
    const [audience, setAudience] = useState(() => envelope?.audience ?? params?.audience ?? '');
    // a speech window / rail handshake binds on audience + window, not on a requester's nonce —
    // when the caller says `selfChallenge`, generate the nonce here (32 random bytes, hex).
    const [challenge, setChallenge] = useState(() => initialPresentmentChallenge(
        envelope ? { challenge: envelope.challenge } : params, () => bytesToHex(Crypto.getRandomBytes(32))));
    // §2.6: the predicates the requester named in its challenge (from the scanned QR, a thread
    // request, or a forum challenge).
    const [predicates, setPredicates] = useState<PredicateRequest[]>(() => (envelope ? [...(envelope.predicates ?? [])] : (params?.predicates ?? [])) as PredicateRequest[]);
    // 2026-10-10: the disclosure requests the signed challenge names. ELECT PER REQUEST, OFF BY DEFAULT:
    // an un-elected request is signed as declined; an elected one discloses the matching records this
    // phone holds (listed below before the burn, so the person sees exactly what travels).
    const disclosureRequests: readonly CanonicalDisclosureRequest[] = useMemo(() => envelope?.disclosures ?? [], [envelope]);
    const [discElected, setDiscElected] = useState<Set<number>>(new Set());
    const [discCandidates, setDiscCandidates] = useState<Map<number, DisclosureCandidate[]>>(new Map());
    useEffect(() => {
        setDiscElected(new Set());
        setDiscCandidates(new Map());
        if (disclosureRequests.length === 0) return;
        setTier('reputation');
        let cancelled = false;
        (async () => {
            const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
            const { findDisclosureCandidates } = await import('../../core/meter/presentablePes');
            const meter = getPhoneMeter();
            await meter.start();
            const found = new Map<number, DisclosureCandidate[]>();
            for (let i = 0; i < disclosureRequests.length; i++) found.set(i, await findDisclosureCandidates(meter.store, disclosureRequests[i]));
            if (!cancelled) setDiscCandidates(found);
        })().catch(() => { if (!cancelled) setDiscCandidates(new Map()); });
        return () => { cancelled = true; };
    }, [disclosureRequests]);
    const toggleDisclosure = useCallback((i: number) => {
        setDiscElected((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
    }, []);
    const electedRecordCount = useMemo(() => [...discElected].reduce((n, i) => n + (discCandidates.get(i)?.length ?? 0), 0), [discElected, discCandidates]);
    const deliverTo = route.params?.deliverTo;
    // a Commons act this presentation backs — a vouch (reputation, to the vouchee) or a hire
    // handshake (to the applicant). Both bind on audience + window, so the caller passes selfChallenge.
    const commonsAct = deliverTo?.kind === 'vouch' || deliverTo?.kind === 'hire' ? deliverTo : null;
    const selfChallenge = route.params?.selfChallenge === true && commonsAct === null;
    // The LIVE vocabulary (§2.5) — null until loaded; {} on a fresh actor.
    const [facts, setFacts] = useState<Record<string, number> | null>(null);
    const [standingPrefix, setStandingPrefix] = useState('standing.');
    // Selective disclosure, WITHHOLD BY DEFAULT: the non-standing fields the presenter chose to
    // SHARE as raw numbers. Empty = Standing + the answers to the requester's questions, nothing else.
    const [shared, setShared] = useState<Set<string>>(new Set());
    // pe_fact: the presenter's own relay PEs (id + canonical hash) and the chosen subset.
    const [peRows, setPeRows] = useState<PeFactRow[]>([]);
    const [chosenPes, setChosenPes] = useState<Set<string>>(new Set());
    const [balance, setBalance] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [token, setToken] = useState<string | null>(null);
    // A recorded-but-not-yet-consumed burn. If produce fails AFTER the burn (e.g.
    // a transient relay error), we retry present with THIS burn instead of burning
    // again — a burn is only consumed when produce succeeds (F9).
    // every broadcast burn is saved on the phone BEFORE the relay records it (pendingBurns);
    // `savedBurn` says one of exactly this fee is waiting, so the next tap uses it — never a re-burn.
    const [savedBurn, setSavedBurn] = useState(false);
    const [stage, setStage] = useState<BurnStage | null>(null);
    // A speech window binds on the audience alone — no disclosure choices matter, so the long
    // vocabulary list starts collapsed there.
    // Compact mode: the caller already fixed audience + challenge (a speech window, a forum challenge
    // answer, a thread request), so the raw fields and the long vocabulary list are noise — the
    // requester only needs the yes/no. Standing still rides along; Review opens the full list.
    const compact = route.params?.selfChallenge === true || route.params?.deliverTo !== undefined;
    // The full fact list starts collapsed everywhere: nothing in it is shared unless switched on, and
    // an open list pushes the present button far below the fold.
    const [showDisclosure, setShowDisclosure] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState('');

    // verify WHO is asking before anything can burn. A wallet requester verifies against the
    // Provian JWKS; a domain requester against its own well-known key (https, no redirects, 64 KiB,
    // 5 s). Re-runs when the envelope or this wallet's address changes (the not-addressed check).
    useEffect(() => {
        setVerdict(null);
        if (!envelope) return;
        let cancelled = false;
        (async () => {
            const provianKeys = envelope.requester?.type === 'wallet' ? await RelayAPIService.getPresentationJwks() : null;
            const v = await verifyChallengeEnvelope(envelope, {
                provianKeys,
                fetchRequesterKeys: (domain) => fetchRequesterKeysHttps(domain),
                presenterAddress: address ? address.toLowerCase() : undefined,
            });
            if (!cancelled) setVerdict(v);
        })().catch(() => {
            if (!cancelled) setVerdict({ status: 'invalid', reason: 'malformed', envelope });
        });
        return () => { cancelled = true; };
    }, [envelope, address]);

    // §2.4: prefer the live floor; fall back to the config-mirrored default.
    const prGatePrice = provianPrGatePrice(envelope, verdict);
    const ownerExemptPr = provianPrGateOwnerExempt(envelope, verdict);
    useEffect(() => { if (prGatePrice !== null) setTier('reputation'); }, [prGatePrice]);
    const fee = ownerExemptPr ? 0 : Math.max(floor ? floor[tier] : TIER_FEE_PVT[tier], prGatePrice ?? 0);
    const feeAtomic = useMemo(() => ethers.parseUnits(String(fee), 18).toString(), [fee]);
    useEffect(() => {
        if (!address) return;
        let cancelled = false;
        void findPendingBurn(address, feeAtomic).then((b) => { if (!cancelled) setSavedBurn(b !== null); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [address, feeAtomic]);

    // §2.4: read the exact burn floor once so the cost we show the presenter is the
    // real one it is about to burn (never a stale literal). Best effort → defaults.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const f = await RelayAPIService.getPresentationFloor();
            if (!cancelled && f) setFloor(f);
        })();
        return () => { cancelled = true; };
    }, []);

    const loadBalance = useCallback(async () => {
        if (!address) return;
        try {
            const b = await RelayAPIService.getPVTBalance(address);
            setBalance(b?.balance ?? '0');
        } catch {
            setBalance(null);
        }
    }, [address]);
    useEffect(() => { void loadBalance(); }, [loadBalance]);

    // §2.5: the disclosable set IS the live vocabulary — read it from the relay, never a local guess.
    const loadVocabulary = useCallback(async () => {
        const v = await RelayAPIService.getVocabulary();
        if (v) { setFacts(v.facts); setStandingPrefix(v.standingPrefix); } else { setFacts({}); }
    }, []);
    useEffect(() => { void loadVocabulary(); }, [loadVocabulary]);

    // pe_fact: the presenter's own PEs, from this phone's own store (the relay keeps no PE,),
    // including PEs dropped here after their day was confirmed in the person's PE Archive.
    const loadPeRows = useCallback(async () => {
        try {
            const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
            const meter = getPhoneMeter();
            await meter.start();
            const { listPresentablePes } = await import('../../core/meter/presentablePes');
            setPeRows(await listPresentablePes(meter.store, 50));
        } catch {
            setPeRows([]);
        }
    }, []);
    useEffect(() => { if (tier === 'pe_fact' && peRows.length === 0) void loadPeRows(); }, [tier, peRows.length, loadPeRows]);

    const balanceNum = balance !== null ? Number(balance) : 0;
    const canAfford = savedBurn || balanceNum >= fee;
    const tierReady = tier === 'reputation' ? true : prGatePrice === null && chosenPes.size > 0 && chosenPes.size <= MAX_PE_FACTS;
    // the burn gate — the SAME decision doPresent re-takes at tap time.
    const gate = presenterBurnDecision({ envelope, verdict, audience, challenge, tier, nowSeconds: Math.floor(Date.now() / 1000) });
    const ready = !ownerExemptPr && gate.allowed && audience.trim().length > 0 && challenge.trim().length >= 16 && canAfford && !busy && tierReady;
    const showRequesterCard = !selfChallenge && !commonsAct && (envelope !== null || audience.trim().length > 0);

    const isStanding = useCallback((field: string) => field.startsWith(standingPrefix), [standingPrefix]);

    // A field a requested predicate answers is never disclosed raw (the relay withholds it even if it
    // is listed in `share`), so it is not a sharing choice — only its yes/no rides the presentation.
    const answeredFields = useMemo(() => new Set(predicates.map((p) => p.field)), [predicates]);

    const toggleShared = useCallback((field: string) => {
        if (isStanding(field)) return; // §2.5: standing is always shared; nothing to toggle
        if (answeredFields.has(field)) return; // answered by a predicate: never disclosed raw
        setShared((prev) => {
            const next = new Set(prev);
            if (next.has(field)) next.delete(field); else next.add(field);
            return next;
        });
    }, [isStanding, answeredFields]);

    const togglePe = useCallback((peId: string) => {
        setChosenPes((prev) => {
            const next = new Set(prev);
            if (next.has(peId)) next.delete(peId); else if (next.size < MAX_PE_FACTS) next.add(peId);
            return next;
        });
    }, []);

    const onScan = useCallback(async () => {
        if (!permission?.granted) {
            const res = await requestPermission();
            if (!res.granted) { Alert.alert(t('trustLayer.presenter.cameraNeededTitle'), t('trustLayer.presenter.cameraNeededBody')); return; }
        }
        setScanning(true);
    }, [permission, requestPermission, t]);

    // One path for a scanned QR and a pasted request: parse the (signed or unsigned) envelope, then
    // the verdict effect decides who is asking. Validate the JSON shape + the requester-binding bounds
    // BEFORE trusting it, so a hostile/malformed request can never seed a burn (F9).
    const loadRequest = useCallback((data: string): boolean => {
        const parsed = parseChallengeEnvelope(data);
        if (!parsed) {
            Alert.alert(t('trustLayer.presenter.notValidRequestTitle'), t('trustLayer.presenter.notValidRequestBody'));
            return false;
        }
        setEnvelope(parsed);
        setAudience(parsed.audience);
        setChallenge(parsed.challenge);
        setPredicates([...(parsed.predicates ?? [])]);
        if ((parsed.predicates?.length ?? 0) > 0) setTier('reputation');
        return true;
    }, [t]);

    const handleScanned = useCallback((e: { data: string }) => {
        setScanning(false);
        loadRequest(e.data);
    }, [loadRequest]);

    const applyPasted = useCallback(() => {
        if (loadRequest(pasteText)) { setPasteOpen(false); setPasteText(''); }
    }, [loadRequest, pasteText]);

    const clearRequest = useCallback(() => {
        setEnvelope(null);
        setAudience('');
        setChallenge('');
        setPredicates([]);
    }, []);

    const doPresent = useCallback(async () => {
        if (!ready || !address || provianPrGateOwnerExempt(envelope, verdict)) return;
        // re-decide at tap time (the challenge may have expired while the screen was open).
        // An invalid / expired / not-addressed challenge never reaches the burn.
        const decision = presenterBurnDecision({ envelope, verdict, audience, challenge, tier, nowSeconds: Math.floor(Date.now() / 1000) });
        if (!decision.allowed) {
            if (decision.refusal !== 'checking') Alert.alert(t('trustLayer.presenter.refusedTitle'), t(REFUSAL_KEY[decision.refusal]));
            return;
        }
        // Validate audience + challenge against the RELAY'S bounds BEFORE the burn.
        // The relay enforces these again at produce time, but that is after the
        // on-chain burn — validating here first means a malformed request never
        // strands a burn (F9).
        const bindingCheck = validateRequesterBinding({ audience, challenge });
        if (bindingCheck.ok !== true) {
            Alert.alert(t('trustLayer.presenter.checkRequestTitle'), errorDisplayCopy(bindingCheck.error));
            return;
        }
        setBusy(true);
        const operation: { broadcast: { txHash: string; amountAtomic: string; burnId?: string } | null } = { broadcast: null };
        // pe_fact: each chosen PE with its two-hop proof, resolved BEFORE the burn (a PE whose day is
        // not anchored yet, or whose archived day cannot be pulled back here, never strands a burn).
        let resolvedFacts: Awaited<ReturnType<typeof import('../../core/meter/presentablePes').resolvePresentedPeFacts>> | undefined;
        // 2026-10-10: the disclosure answers — elected requests with their records (each with its
        // two-hop proof), the rest declined — are built BEFORE the burn too.
        let disclosureAnswers: DisclosureAnswerInput[] | undefined;
        if (disclosureRequests.length > 0) {
            if (tier !== 'reputation') { setBusy(false); Alert.alert(t('trustLayer.presenter.refusedTitle'), t('trustLayer.presenter.refusedNeedsReputation')); return; }
            try {
                const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
                const { resolveDisclosedRecords } = await import('../../core/meter/presentablePes');
                const meter = getPhoneMeter();
                await meter.start();
                disclosureAnswers = [];
                for (let i = 0; i < disclosureRequests.length; i++) {
                    if (!discElected.has(i)) { disclosureAnswers.push({ request: disclosureRequests[i], election: 'declined' }); continue; }
                    const records = await resolveDisclosedRecords(meter.store, (discCandidates.get(i) ?? []).map((c) => ({ peId: c.peId, hash: c.hash })), meter.archive ?? undefined);
                    disclosureAnswers.push({ request: disclosureRequests[i], election: 'disclosed', records });
                }
            } catch (err) {
                setBusy(false);
                const reason = err instanceof Error && 'reason' in err ? String((err as { reason: unknown }).reason) : (err instanceof Error ? err.message : 'unknown');
                Alert.alert(t('trustLayer.presenter.peFactUnavailableTitle'), t('trustLayer.presenter.discUnavailable', { reason }));
                return;
            }
        }
        if (tier === 'pe_fact') {
            try {
                const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
                const { resolvePresentedPeFacts } = await import('../../core/meter/presentablePes');
                const meter = getPhoneMeter();
                await meter.start();
                resolvedFacts = await resolvePresentedPeFacts(
                    meter.store,
                    peRows.filter((r) => chosenPes.has(r.peId)).map((r) => ({ peId: r.peId, hash: r.hash })),
                    meter.archive ?? undefined,
                );
            } catch (err) {
                setBusy(false);
                const reason = err instanceof Error && 'reason' in err ? String((err as { reason: unknown }).reason) : '';
                Alert.alert(
                    t('trustLayer.presenter.peFactUnavailableTitle'),
                    reason === 'not_anchored_yet' ? t('trustLayer.presenter.peFactNotAnchored')
                        : reason === 'archived_unavailable' ? t('trustLayer.presenter.peFactArchivedUnavailable')
                            : t('trustLayer.presenter.peFactUnavailable'),
                );
                return;
            }
        }
        try {
            const { getPhoneMeter } = await import('../../core/meter/phoneMeterRuntime');
            await getPhoneMeter().preflightPresentation([
                ...(resolvedFacts ?? []),
                ...(disclosureAnswers ?? []).flatMap(d => d.election === 'disclosed' ? (d.records ?? []) : []),
            ]);
            return await withBiometricAction(t('trustLayer.presenter.biometricPrompt'), async (biometricAction) => {
                // 3) Sign the requester-bound binding with the wallet key (EIP-191, biometric).
                const signEip191: Eip191Signer = async (message: string) => {
                    assertBiometricAction(biometricAction);
                    const pk = await SeedManager.getEVMPrivateKey(biometricAction);
                    return new ActionWallet(pk, biometricAction).signMessage(message);
                };
                const proofRequest = await buildHumanPresentationRequest({
                    tier,burnId:'0'.repeat(64),audience:audience.trim(),challenge:challenge.trim(),
                    peFacts:tier==='pe_fact'?resolvedFacts:undefined,
                    disclosure:{redact:[],predicates,share:[...shared].filter(f=>!isStanding(f)&&!answeredFields.has(f)).sort()},
                    disclosures:disclosureAnswers,challengeEnvelope:decision.signedEnvelope,
                },address.toLowerCase(),signEip191);
                await RelayAPIService.preflightPresentation(proofRequest.body,biometricAction);
                // 1) Burn the displayed tier fee or verified gate price, reusing an unspent
                //    burn from a prior attempt. A burn is consumed only when produce
                //    succeeds, so a failed produce leaves the burn reusable (no re-burn).
                //    The burn is saved on the phone the moment it is operation.broadcast — a failed produce
                //    leaves it saved, and the next tap uses it instead of burning again.
                // no confirmation wait and no separate record — the burn's tx rides to
                //    /present, where the relay records it once it is mined before issuing.
                operation.broadcast = await obtainBroadcastBurn(
                    { address, amountPvt: String(fee), amountAtomic: feeAtomic, onStage: setStage },
                    { burn: (amount, operationId) => TransactionService.burnPVT({ amount, operationId }, biometricAction), txStatus: (h) => TransactionService.burnTxStatus(h) }, // burn is biometric-gated
                );
                const burnId = operation.broadcast.burnId ?? burnIdForTx('base', operation.broadcast.txHash);
                const burnTx = operation.broadcast.burnId ? undefined : { txHash: operation.broadcast.txHash, amountAtomic: operation.broadcast.amountAtomic, chain: 'base' };
                setSavedBurn(true);
                const peFacts = tier === 'pe_fact' ? resolvedFacts : undefined;
                const { body } = await buildHumanPresentationRequest(
                    {
                        tier, burnId, audience: audience.trim(), challenge: challenge.trim(),
                        peFacts,
                        // §2.5/§2.6 + SHARE-ONLY: the relay reveals Standing, the answers to every
                        // predicate the requester named, and ONLY the raw numbers switched on here. Everything
                        // else is withheld AT ISSUANCE by the relay — including a field that first appears
                        // after this screen loaded, and even if this phone could not read the vocabulary.
                        disclosure: { redact: [], predicates, share: [...shared].filter((f) => !isStanding(f) && !answeredFields.has(f)).sort() },
                        ...(disclosureAnswers !== undefined ? { disclosures: disclosureAnswers } : {}),
                        // a verified signed challenge rides to /present; the binding becomes v2.
                        challengeEnvelope: decision.signedEnvelope,
                        ...(burnTx ? { burnTx } : {}),
                    },
                    address.toLowerCase(),
                    signEip191,
                );
                // 4) Produce the presentation and get the portable token. With a fresh burn the relay
                //    holds this call until the burn is mined (~one Base block), then issues.
                if (burnTx) setStage('finalizing');
                const out = await RelayAPIService.produceHumanPresentation(body as unknown as Parameters<typeof RelayAPIService.produceHumanPresentation>[0], biometricAction);
                setStage(null);
                // A speech window needs no token handed to anyone — the relay holds the presentation.
                // a vouch / hire presentation is consumed by the act it backs — no token to hand over.
                if (!selfChallenge && !commonsAct) setToken(out.token);
                await markBurnConsumed(address, { burnId }); // consumed by the produced presentation
                setSavedBurn(false);
                void loadBalance();
                // deliver the token where the caller said — answer a forum challenge, or present
                // inside a thread (verify-at-submit on the relay). The presentation is already produced
                // and its burn consumed; delivery failing leaves the token on screen to hand over by hand.
                if (deliverTo?.kind === 'challenge') {
                    const c = await CommonsService.answerChallenge(deliverTo.challengeId, { burn_id: burnId, presentation_token: out.token }, biometricAction);
                    requestAttentionRefresh(); // item 9: the challenge leaves the bell
                    Alert.alert(
                        c.status === 'answered' ? t('commons.challengeAnsweredTitle') : t('commons.challengeUpheldTitle'),
                        c.status === 'answered' ? t('commons.challengeAnsweredBody') : t('commons.challengeUpheldBody'),
                        [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                    );
                } else if (deliverTo?.kind === 'thread') {
                    const r = await CommonsService.presentInThread(deliverTo.threadId, deliverTo.requestId, { burn_id: burnId, presentation_token: out.token }, biometricAction);
                    requestAttentionRefresh(); // item 9: the thread request leaves the bell
                    Alert.alert(
                        t('commons.threadPresentedTitle'),
                        r.request.verdict === 'valid' ? t('commons.threadPresentedValid') : t('commons.threadPresentedInvalid'),
                        [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                    );
                } else if (commonsAct) {
                    // the presentation is live for 7 days to this audience — now do the act it backs.
                    // A failure here leaves the presentation in place, so trying the act again costs nothing.
                    try {
                        if (commonsAct.kind === 'vouch') {
                            await CommonsService.stakeVouch(commonsAct.targetId, undefined, biometricAction);
                            Alert.alert(
                                t('commons.vouched'),
                                t('commons.vouchedMsg', { name: commonsAct.targetName || commonsAct.targetId }),
                                [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                            );
                        } else {
                            await CommonsService.acceptHumanJobApplicant(commonsAct.jobId, commonsAct.applicantWalletId, biometricAction);
                            Alert.alert(
                                t('commonsJobs.hiredTitle'),
                                t('commonsJobs.hiredBody', { name: commonsAct.applicantName || t('commonsHumanJobManage.thisApplicant') }),
                                [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                            );
                        }
                    } catch (actErr) {
                        const detail = actErr instanceof Error ? actErr.message : '';
                        const linked = commonsAct.kind === 'vouch' && classifyVouchError(actErr) === 'linked_pair';
                        Alert.alert(
                            commonsAct.kind === 'vouch' ? t('commons.vouchFailed') : t('commonsJobs.hireFailedTitle'),
                            linked
                                ? t('commons.vouchLinkedRefused')
                                : commonsAct.kind === 'vouch'
                                    ? t('commons.vouchAfterPresentFailed', { detail })
                                    : t('commonsJobs.hireAfterPresentFailed', { detail }),
                            [{ text: t('common.ok'), onPress: () => navigation.goBack() }],
                        );
                    }
                } else if (selfChallenge) {
                    // the Commons now knows the pass is live (pill + "Question this post" never
                    // offer a second pass from a stale cache).
                    if (audience.trim() === 'provian:commons') noteTalkingPassUsed();
                    Alert.alert(t('commons.speechWindowOpenedTitle'), audience.trim() === 'provian:commons' ? t('commons.speechWindowOpenedBody', { audience: t('trustLayer.presenter.theCommons'), pvt: fee }) : t('commons.speechWindowOpenedBodyTo', { audience: audience.trim(), pvt: fee }), [{ text: t('common.ok'), onPress: () => navigation.goBack() }]);
                }
            });
        } catch (e) {
            setStage(null);
            // The relay recorded the burn before refusing: keep its id so the next tap presents it.
            if (operation.broadcast && e instanceof PresentationRefusedError && e.burnId) {
                await rememberRecordedBurn(address, operation.broadcast.txHash, e.burnId).catch(() => undefined);
            }
            if (operation.broadcast && isRevertedBurnError(e)) {
                // The burn tx reverted on Base: nothing was burned, so there is nothing to resume.
                await markBurnConsumed(address, { txHash: operation.broadcast.txHash }).catch(() => undefined);
                setSavedBurn(false);
                Alert.alert(t('trustLayer.presenter.notCompletedTitle'), t('trustLayer.presenter.burnReverted'));
                return;
            }
            if (operation.broadcast && isRevokedBurnError(e)) {
                // the relay revoked this burn — it never reached Base finality, so it
                // can never be used. Forget it; the next tap burns afresh.
                await markBurnConsumed(address, { txHash: operation.broadcast.txHash }).catch(() => undefined);
                setSavedBurn(false);
                Alert.alert(t('trustLayer.presenter.notCompletedTitle'), t('trustLayer.presenter.burnRevoked'));
                return;
            }
            if (isBurnConsumedError(e)) {
                // The saved burn already bought something (a crash between produce and our bookkeeping).
                const pending = await findPendingBurn(address, feeAtomic).catch(() => null);
                if (pending) await markBurnConsumed(address, { txHash: pending.txHash }).catch(() => undefined);
                setSavedBurn(false);
                Alert.alert(t('trustLayer.presenter.burnUsedTitle'), t('trustLayer.presenter.burnUsedBody', { fee }));
                return;
            }
            const stillSaved = await findPendingBurn(address, feeAtomic).then((b) => b !== null).catch(() => false);
            setSavedBurn(stillSaved);
            const base = e instanceof BurnStillFinalizingError ? e.message : e instanceof Error ? e.message : t('trustLayer.presenter.tryAgain');
            Alert.alert(
                t('trustLayer.presenter.notCompletedTitle'),
                errorDisplayCopy(stillSaved && !(e instanceof BurnStillFinalizingError)
                    ? t('trustLayer.presenter.notCompletedSaved', { base: errorDisplayCopy(base), fee })
                    : base),
            );
        } finally {
            setBusy(false);
        }
    }, [ready, address, envelope, verdict, fee, feeAtomic, tier, audience, challenge, shared, isStanding, answeredFields, predicates, peRows, chosenPes, loadBalance, deliverTo, commonsAct, selfChallenge, navigation, t, disclosureRequests, discElected, discCandidates]);

    const confirm = useCallback(() => {
        // On a retry we already hold an unspent burn — say so, and don't threaten a
        // second burn.
        if (commonsAct) {
            const name = commonsAct.kind === 'vouch' ? (commonsAct.targetName || commonsAct.targetId) : (commonsAct.applicantName || commonsAct.applicantWalletId);
            Alert.alert(
                commonsAct.kind === 'vouch' ? t('commons.vouchFor', { name }) : t('commonsJobs.hirePresentTitle', { name }),
                savedBurn
                    ? t('commonsJobs.presentSavedBurnBody', { pvt: fee })
                    : commonsAct.kind === 'vouch'
                        ? t('commons.vouchBurnConfirm', { pvt: fee, name })
                        : t('commonsJobs.hireBurnConfirm', { pvt: fee, name }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: savedBurn ? t('commonsJobs.useSavedBurn') : t('commons.featureBurn', { pvt: fee }), style: savedBurn ? 'default' : 'destructive', onPress: () => void doPresent() },
                ],
            );
            return;
        }
        if (savedBurn) {
            Alert.alert(
                t('trustLayer.presenter.useSavedTitle'),
                selfChallenge
                    ? t('trustLayer.presenter.useSavedBodyTalk', { fee })
                    : t('trustLayer.presenter.useSavedBodyPresent', { fee, audience: audience.trim() }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: t('commonsJobs.useSavedBurn'), onPress: () => void doPresent() },
                ],
            );
            return;
        }
        Alert.alert(
            selfChallenge ? t('trustLayer.presenter.talkConfirmTitle', { fee }) : t('trustLayer.presenter.confirmTitle'),
            selfChallenge
                ? t('trustLayer.presenter.talkConfirmBody', { fee })
                : tier === 'pe_fact'
                    ? t('trustLayer.presenter.confirmBodyPeFacts', { fee, count: chosenPes.size, audience: audience.trim() })
                    : discElected.size > 0
                        ? t('trustLayer.presenter.confirmBodyDisclosures', { fee, audience: audience.trim(), count: electedRecordCount, declined: disclosureRequests.length - discElected.size })
                        : t('trustLayer.presenter.confirmBodyReputation', { fee, audience: audience.trim() }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('trustLayer.presenter.confirmBurn', { fee }), style: 'destructive', onPress: () => void doPresent() },
            ],
        );
    }, [fee, tier, chosenPes.size, audience, doPresent, savedBurn, selfChallenge, commonsAct, t, discElected.size, electedRecordCount, disclosureRequests.length]);

    const shareToken = useCallback(async () => {
        if (!token) return;
        try { await Share.share({ message: token }); } catch { /* user dismissed */ }
    }, [token]);

    // Group the live facts by their prefix, in the ruling's order.
    const groups = useMemo(() => {
        const byGroup = new Map<string, string[]>();
        for (const field of Object.keys(facts ?? {}).sort()) {
            const g = field.split('.')[0];
            const list = byGroup.get(g) ?? [];
            list.push(field);
            byGroup.set(g, list);
        }
        const ordered = [...GROUP_ORDER.filter((g) => byGroup.has(g)), ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g))];
        return ordered.map((g) => {
            // A group this build has no label for falls back to its raw name.
            const key = GROUP_LABEL_KEY[g];
            return { group: g, label: key ? t(key) : g, fields: byGroup.get(g) ?? [] };
        });
    }, [facts, t]);

    const disclosureSummary = useMemo(() => {
        const extra = [...shared].filter((f) => !isStanding(f) && !answeredFields.has(f)).length;
        return extra === 0
            ? t('trustLayer.presenter.summaryStandingOnly')
            : t('trustLayer.presenter.summaryExtra', { count: extra });
    }, [shared, isStanding, answeredFields, t]);

    // §2.4: preview the yes/no this presenter is about to co-sign, computed LOCALLY
    // against its own live vocabulary. The relay recomputes and co-signs the
    // authoritative answer; this only shows the presenter what it will be BEFORE the
    // burn. Empty until the vocabulary loads (facts === null → no preview yet).
    const predicatePreview = useMemo(
        () => (facts !== null ? predicates.map((p) => ({ p, result: evaluatePredicateLocally(p, facts) })) : []),
        [facts, predicates],
    );

    if (scanning) {
        return (
            <SafeAreaView style={styles.safe} edges={['top']}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => setScanning(false)}><Ionicons name="close" size={26} color={COLORS.text} /></TouchableOpacity>
                    <Text style={styles.headerTitle}>{t('trustLayer.presenter.scanTitle')}</Text>
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
                <Text style={styles.headerTitle}>
                    {commonsAct?.kind === 'vouch' ? t('commons.vouch')
                        : commonsAct?.kind === 'hire' ? t('commonsJobs.hirePresentHeader')
                        : selfChallenge ? t('trustLayer.presenter.titleTalk')
                        : deliverTo?.kind === 'challenge' ? t('trustLayer.presenter.titleAnswerChallenge')
                        : deliverTo?.kind === 'thread' ? t('trustLayer.presenter.titlePresentThread')
                        : t('trustLayer.presenter.title')}
                </Text>
                <View style={{ width: 26 }} />
            </View>

            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                {commonsAct ? (
                    <Text style={styles.lede}>
                        {commonsAct.kind === 'vouch'
                            ? t('commons.vouchPresentLede', { pvt: fee, name: commonsAct.targetName || commonsAct.targetId })
                            : t('commonsJobs.hirePresentLede', { pvt: fee, name: commonsAct.applicantName || commonsAct.applicantWalletId })}
                    </Text>
                ) : selfChallenge ? (
                    <Text style={styles.lede}>
                        {t('trustLayer.presenter.ledeTalkLead')}
                        <Text style={styles.ledeStrong}>{t('trustLayer.presenter.feeBurn', { fee })}</Text>
                        {audience.trim() && audience.trim() !== 'provian:commons'
                            ? t('trustLayer.presenter.ledeTalkTailWith', { audience: audience.trim() })
                            : t('trustLayer.presenter.ledeTalkTail')}
                    </Text>
                ) : deliverTo ? (
                    <Text style={styles.lede}>
                        {deliverTo.kind === 'challenge' ? t('trustLayer.presenter.ledeChallengeLead') : t('trustLayer.presenter.ledeThreadLead')}
                        <Text style={styles.ledeStrong}>{t('trustLayer.presenter.feeBurn', { fee })}</Text>
                        {deliverTo.kind === 'challenge' ? t('trustLayer.presenter.ledeChallengeTail') : t('trustLayer.presenter.ledeThreadTail')}
                    </Text>
                ) : (
                    <Text style={styles.lede}>{t('trustLayer.presenter.lede', { fee })}</Text>
                )}

                {prGatePrice !== null && <Text style={styles.lede}>{t(ownerExemptPr ? 'trustLayer.presenter.prGateOwnerExemptNotice' : 'trustLayer.presenter.prGateNotice')}</Text>}

                {token ? (
                    <View style={styles.proofCard}>
                        <View style={styles.proofHeader}>
                            <Ionicons name="shield-checkmark" size={20} color={COLORS.platinum} />
                            <Text style={styles.proofTitle}>{t('trustLayer.presenter.proofReady')}</Text>
                        </View>
                        <Text style={styles.proofRow}>{t('trustLayer.presenter.handTo', { audience: audience.trim() })}</Text>
                        {/* A reputation token can exceed a QR code's capacity (~2.9 KB) — the library throws
                            without onError and crashed the app (live, 2026-09-22). Draw a QR only when it fits. */}
                        {token.length <= QR_MAX_CHARS ? (
                            <View style={styles.qrWrap}><QRCode value={token} size={200} backgroundColor="white" color="#111827" onError={() => undefined} /></View>
                        ) : (
                            <Text style={styles.proofRow}>{t('trustLayer.presenter.tooLargeForQr')}</Text>
                        )}
                        <Text style={styles.tokenText} selectable numberOfLines={4}>{token}</Text>
                        <TouchableOpacity style={styles.shareBtn} onPress={shareToken}>
                            <Ionicons name="share-outline" size={18} color={COLORS.black} />
                            <Text style={styles.shareBtnText}>{t('trustLayer.presenter.shareToken')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => { setToken(null); }}>
                            <Text style={styles.again}>{t('trustLayer.presenter.presentAgain')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <>
                        {!compact && (<>
                        <View style={styles.requestLinks}>
                            <TouchableOpacity onPress={onScan} disabled={busy} style={styles.requestLink} accessibilityRole="button">
                                <Ionicons name="qr-code-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.scanLink}>{t('trustLayer.presenter.scanQr')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setPasteOpen((v) => !v)} disabled={busy} style={styles.requestLink} accessibilityRole="button">
                                <Ionicons name="clipboard-outline" size={16} color={COLORS.primary} />
                                <Text style={styles.scanLink}>{t('trustLayer.presenter.pasteLink')}</Text>
                            </TouchableOpacity>
                        </View>
                        <Text style={styles.inputLabel}>{t('trustLayer.presenter.audienceLabel')}</Text>
                        {/* a digital (non-QR) request — a signed challenge sent by chat, email or an agent — is pasted here. */}
                        {pasteOpen && (
                            <View style={styles.pasteBlock}>
                                <Text style={styles.inputLabel}>{t('trustLayer.presenter.pasteLabel')}</Text>
                                <TextInput
                                    style={[styles.input, styles.pasteInput]} value={pasteText} onChangeText={setPasteText}
                                    placeholder={t('trustLayer.presenter.pastePlaceholder')} placeholderTextColor={COLORS.textMuted}
                                    autoCapitalize="none" autoCorrect={false} multiline editable={!busy}
                                />
                                <TouchableOpacity style={[styles.pasteBtn, pasteText.trim().length === 0 && styles.burnBtnDisabled]} onPress={applyPasted} disabled={pasteText.trim().length === 0 || busy}>
                                    <Text style={styles.pasteBtnText}>{t('trustLayer.presenter.pasteUse')}</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        {/* A loaded request is fixed — editing its fields would present to something it didn't ask. */}
                        <TextInput style={styles.input} value={audience} onChangeText={setAudience} placeholder={t('trustLayer.presenter.audiencePlaceholder')} placeholderTextColor={COLORS.textMuted} autoCapitalize="none" editable={!busy && envelope === null} />

                        <Text style={styles.inputLabel}>{t('trustLayer.presenter.challengeLabel')}</Text>
                        <TextInput style={styles.input} value={challenge} onChangeText={setChallenge} placeholder={t('trustLayer.presenter.challengePlaceholder')} placeholderTextColor={COLORS.textMuted} autoCapitalize="none" editable={!busy && envelope === null} />
                        {envelope !== null && (
                            <TouchableOpacity onPress={clearRequest} disabled={busy} style={{ marginTop: SPACING.s }}>
                                <Text style={styles.scanLink}>{t('trustLayer.presenter.clearRequest')}</Text>
                            </TouchableOpacity>
                        )}

                        {/* Tier picker (§2.6: both tiers on the mobile presenter). */}
                        <View style={styles.tierRow}>
                            {(['reputation', 'pe_fact'] as const).map((tr) => (
                                <TouchableOpacity key={tr} style={[styles.tierBtn, tier === tr && styles.tierBtnActive]} onPress={() => setTier(tr)} disabled={busy}>
                                    <Text style={[styles.tierBtnText, tier === tr && styles.tierBtnTextActive]}>{tr === 'reputation' ? t('trustLayer.presenter.tierReputation') : t('trustLayer.presenter.tierPeFacts')}</Text>
                                    <Text style={[styles.tierFee, tier === tr && styles.tierBtnTextActive]}>{t('trustLayer.presenter.feeBurn', { fee: TIER_FEE_PVT[tr] })}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        </>)}

                        {/* WHO is asking — verified before any burn. */}
                        {showRequesterCard && (
                            envelope !== null && verdict === null ? (
                                <View style={styles.requesterCard}>
                                    <ActivityIndicator color={COLORS.platinum} size="small" />
                                    <Text style={styles.requesterHint}>{t('trustLayer.presenter.requesterChecking')}</Text>
                                </View>
                            ) : verdict?.status === 'verified' ? (
                                <View style={[styles.requesterCard, styles.requesterCardVerified]}>
                                    <Ionicons name="shield-checkmark" size={18} color={COLORS.success} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.requesterTitle} selectable>{t('trustLayer.presenter.requesterVerified', { identity: requesterDisplay(verdict.requester) })}</Text>
                                        <Text style={styles.requesterHint}>
                                            {verdict.requester.type === 'domain'
                                                ? t('trustLayer.presenter.requesterVerifiedDomainHint', { domain: verdict.requester.id })
                                                : t('trustLayer.presenter.requesterVerifiedWalletHint')}
                                        </Text>
                                    </View>
                                </View>
                            ) : verdict === null || verdict.status === 'unverified' ? (
                                <View style={styles.requesterCard}>
                                    <Ionicons name="help-circle-outline" size={18} color={COLORS.textMuted} />
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.requesterTitle} selectable>{t('trustLayer.presenter.requesterUnverified', { identity: (envelope?.audience ?? audience).trim() })}</Text>
                                        <Text style={styles.requesterHint}>{t('trustLayer.presenter.requesterUnverifiedHint')}</Text>
                                    </View>
                                </View>
                            ) : null
                        )}
                        {!gate.allowed && gate.refusal !== 'checking' && (
                            <View style={[styles.requesterCard, styles.requesterCardRefused]}>
                                <Ionicons name="close-circle" size={18} color={COLORS.error} />
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.requesterTitle}>{t('trustLayer.presenter.refusedTitle')}</Text>
                                    <Text style={styles.requesterHint}>{t(REFUSAL_KEY[gate.refusal])}</Text>
                                </View>
                            </View>
                        )}

                        {/* §2.6: the requester's named predicates ride the challenge; the presenter sees exactly what is asked. */}
                        {predicates.length > 0 && (
                            <View style={styles.predCard}>
                                <Text style={styles.howTitle}>{t('trustLayer.presenter.requesterAsks')}</Text>
                                {predicates.map((p, i) => (
                                    <View key={`${p.field}-${i}`} style={styles.predRow}>
                                        <Ionicons name="help-circle-outline" size={16} color={COLORS.platinum} />
                                        <Text style={styles.predText}>{describePredicate(p)}</Text>
                                    </View>
                                ))}
                                <Text style={styles.disclosureHint}>{t('trustLayer.presenter.predicatesHint')}</Text>

                                {/* §2.4: the RESULTS you're about to co-sign, computed against your live record. */}
                                {predicatePreview.length > 0 && (
                                    <View style={styles.previewBlock}>
                                        <Text style={styles.previewTitle}>{t('trustLayer.presenter.willCoSign')}</Text>
                                        {predicatePreview.map(({ p, result }, i) => (
                                            <View key={`prev-${p.field}-${i}`} style={styles.previewRow}>
                                                <Ionicons name={result ? 'checkmark-circle' : 'close-circle'} size={16} color={result ? COLORS.success : COLORS.error} />
                                                <Text style={styles.previewText} numberOfLines={1}>{describePredicate(p)}</Text>
                                                <Text style={[styles.previewVerdict, { color: result ? COLORS.success : COLORS.error }]}>
                                                    {result ? t('trustLayer.presenter.answerYes') : t('trustLayer.presenter.answerNo')}
                                                </Text>
                                            </View>
                                        ))}
                                        <Text style={styles.previewHint}>{t('trustLayer.presenter.willAnswerHint')}</Text>
                                    </View>
                                )}
                            </View>
                        )}

                        {/* 2026-10-10: the requester-named DISCLOSURE requests — each answered only when the person
                            turns it on; what will travel is listed here, before the biometric burn. */}
                        {disclosureRequests.length > 0 && (
                            <View style={styles.predCard} testID="disclosure-requests">
                                <Text style={styles.howTitle}>{t('trustLayer.presenter.discTitle')}</Text>
                                <Text style={styles.disclosureHint}>{t('trustLayer.presenter.discHint')}</Text>
                                {disclosureRequests.map((req, i) => {
                                    const on = discElected.has(i);
                                    const cands = discCandidates.get(i);
                                    return (
                                        <View key={`disc-${i}`} style={styles.previewBlock}>
                                            <TouchableOpacity style={styles.discRow} onPress={() => toggleDisclosure(i)} accessibilityRole="switch" accessibilityState={{ checked: on }}>
                                                <View style={styles.discLeft}>
                                                    <Text style={styles.predText}>{describeDisclosureRequest(t, req)}</Text>
                                                    {describeDisclosureExtras(t, req).map((line, j) => <Text key={j} style={styles.discField}>{line}</Text>)}
                                                    <Text style={styles.discField}>{t('trustLayer.disclosure.floorLine')}</Text>
                                                </View>
                                                <View style={styles.discRight}>
                                                    <Text style={[styles.discState, on && { color: COLORS.platinum }]}>{on ? t('trustLayer.presenter.discOn') : t('trustLayer.presenter.discOff')}</Text>
                                                    <Ionicons name={on ? 'toggle' : 'toggle-outline'} size={28} color={on ? COLORS.platinum : COLORS.textMuted} />
                                                </View>
                                            </TouchableOpacity>
                                            {on && (
                                                cands === undefined ? <ActivityIndicator color={COLORS.platinum} />
                                                : cands.length === 0 ? <Text style={styles.previewHint}>{t('trustLayer.presenter.discNoMatch')}</Text>
                                                : (
                                                    <View>
                                                        <Text style={styles.previewTitle}>{t('trustLayer.presenter.discWillDisclose', { n: cands.length })}</Text>
                                                        {cands.map((c) => (
                                                            <View key={c.peId} style={styles.previewRow}>
                                                                <Ionicons name="document-text-outline" size={16} color={COLORS.platinum} />
                                                                <Text style={styles.previewText} numberOfLines={1}>{getActionTypeDisplay(c.actionType).label} · {new Date(c.timestamp).toLocaleString()}</Text>
                                                            </View>
                                                        ))}
                                                    </View>
                                                )
                                            )}
                                        </View>
                                    );
                                })}
                            </View>
                        )}

                        {/* §2.4: presenting consumes a single-use on-chain burn of the tier floor. */}
                        <Text style={styles.burnNote}>{t('trustLayer.presenter.burnCost', { fee })}</Text>

                        {tier === 'reputation' ? (
                            <View style={styles.disclosureCard}>
                                <View style={styles.rowBetween}>
                                    <Text style={styles.howTitle}>{t('trustLayer.presenter.discloseTitle')}</Text>
                                    <TouchableOpacity onPress={() => setShowDisclosure((v) => !v)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                                        <Text style={styles.scanLink}>{showDisclosure ? t('trustLayer.presenter.hide') : t('trustLayer.presenter.review')}</Text>
                                    </TouchableOpacity>
                                </View>
                                <Text style={styles.disclosureHint}>{t('trustLayer.presenter.disclosureHint', { summary: disclosureSummary })}</Text>
                                {/* Standing is always present and never withheld — so the DEFAULT
                                    (collapsed) view shows exactly the Standing values that ride along; Review opens the rest. */}
                                {showDisclosure ? null : facts === null ? (
                                    <ActivityIndicator color={COLORS.platinum} style={{ marginTop: SPACING.m }} />
                                ) : groups.filter((g) => g.group === standingPrefix.replace(/\.$/, '')).map((g) => (
                                    <View key={g.group} style={styles.group} testID="disclosure-standing-default">
                                        <Text style={styles.groupTitle}>{g.label}</Text>
                                        {g.fields.map((f) => (
                                            <View key={f} style={styles.discRow}>
                                                <View style={styles.discLeft}>
                                                    <Text style={styles.discField} numberOfLines={1}>{f.slice(g.group.length + 1)}</Text>
                                                    <Text style={styles.discValue}>{facts[f]}</Text>
                                                </View>
                                                <View style={styles.discRight}>
                                                    <Text style={styles.discState}>{t('trustLayer.presenter.stateAlways')}</Text>
                                                    <Ionicons name="lock-closed" size={16} color={COLORS.textMuted} />
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                ))}
                                {!showDisclosure ? null : facts === null ? (
                                    <ActivityIndicator color={COLORS.platinum} style={{ marginTop: SPACING.m }} />
                                ) : groups.length === 0 ? (
                                    <Text style={styles.disclosureHint}>{t('trustLayer.presenter.noFacts')}</Text>
                                ) : groups.map((g) => (
                                    <View key={g.group} style={styles.group}>
                                        <Text style={styles.groupTitle}>{g.label}</Text>
                                        {g.fields.map((f) => {
                                            const locked = isStanding(f);
                                            const answered = !locked && answeredFields.has(f);
                                            const on = locked || (!answered && shared.has(f));
                                            return (
                                                <View key={f} style={styles.discRow}>
                                                    <View style={styles.discLeft}>
                                                        <Text style={styles.discField} numberOfLines={1}>{f.slice(g.group.length + 1)}</Text>
                                                        <Text style={styles.discValue}>{facts[f]}</Text>
                                                    </View>
                                                    <View style={styles.discRight}>
                                                        <Text style={styles.discState}>{locked ? t('trustLayer.presenter.stateAlways') : answered ? t('trustLayer.presenter.stateAnswered') : on ? t('trustLayer.presenter.stateShared') : t('trustLayer.presenter.stateWithheld')}</Text>
                                                        {locked || answered
                                                            ? <Ionicons name="lock-closed" size={16} color={COLORS.textMuted} />
                                                            : <Switch value={on} onValueChange={() => toggleShared(f)} />}
                                                    </View>
                                                </View>
                                            );
                                        })}
                                    </View>
                                ))}
                            </View>
                        ) : (
                            <View style={styles.disclosureCard}>
                                <Text style={styles.howTitle}>{t('trustLayer.presenter.peFactsTitle')}</Text>
                                <Text style={styles.disclosureHint}>{t('trustLayer.presenter.peFactsHint', { max: MAX_PE_FACTS })}</Text>
                                {peRows.length === 0 ? (
                                    <Text style={styles.disclosureHint}>{t('trustLayer.presenter.peFactsEmpty')}</Text>
                                ) : peRows.map((r) => {
                                    const on = chosenPes.has(r.peId);
                                    const label = r.actionType !== null
                                        ? getActionTypeDisplay(r.actionType).label
                                        : t('trustLayer.presenter.peArchivedRow', { day: r.archivedDay ?? '' });
                                    return (
                                        <TouchableOpacity key={r.peId} style={styles.peRow} onPress={() => togglePe(r.peId)}>
                                            <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? COLORS.platinum : COLORS.textMuted} />
                                            <View style={{ flex: 1, marginLeft: SPACING.s }}>
                                                <Text style={styles.discField}>{label}</Text>
                                                <Text style={styles.discState}>{new Date(r.timestamp).toLocaleString()} · {r.peId.slice(0, 14)}…</Text>
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                <Text style={styles.discState}>{t('trustLayer.presenter.selectedCount', { n: chosenPes.size })}</Text>
                            </View>
                        )}

                        <View style={styles.feeCard}>
                            <Text style={styles.feeLabel}>{savedBurn ? t('trustLayer.presenter.feeLabelSaved') : t('trustLayer.presenter.feeLabel')}</Text>
                            <Text style={styles.feeValue}>{fee} PVT</Text>
                            <Text style={styles.feeSub}>{t('trustLayer.presenter.balance', { balance: balance === null ? '—' : balance })}</Text>
                        </View>
                        {!canAfford && !savedBurn && balance !== null && <Text style={styles.err}>{t('trustLayer.presenter.needAtLeast', { fee })}</Text>}
                        {stage && (
                            <Text style={styles.burnNote}>
                                {stage === 'burning' ? t('trustLayer.presenter.stageBurning', { fee }) : t('trustLayer.presenter.stageFinalizing', { fee })}
                            </Text>
                        )}

                        <TouchableOpacity style={[styles.burnBtn, !ready && styles.burnBtnDisabled]} onPress={confirm} disabled={!ready}>
                            {busy ? <ActivityIndicator color={COLORS.black} /> : <Text style={styles.burnBtnText}>{savedBurn ? (selfChallenge ? t('trustLayer.presenter.btnTalkSaved') : t('trustLayer.presenter.btnPresentSaved')) : selfChallenge ? t('trustLayer.presenter.btnTalk', { fee }) : t('trustLayer.presenter.btnPresent', { fee })}</Text>}
                        </TouchableOpacity>
                    </>
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
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    pasteBlock: { marginBottom: SPACING.s },
    pasteInput: { minHeight: 96, textAlignVertical: 'top', fontSize: 12, fontFamily: 'monospace' },
    pasteBtn: { alignSelf: 'flex-start', borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.platinum, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.m, marginTop: SPACING.s },
    pasteBtnText: { color: COLORS.platinum, fontSize: 13, fontWeight: '700' },
    requesterCard: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.s, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.m, borderWidth: 1, borderColor: COLORS.border, marginTop: SPACING.l },
    requesterCardVerified: { borderColor: COLORS.platinumMuted },
    requesterCardRefused: { borderColor: COLORS.errorMuted },
    requesterTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
    requesterHint: { color: COLORS.textMuted, fontSize: 12, lineHeight: 17, marginTop: 2 },
    scanLink: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },
    requestLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.l, marginBottom: SPACING.m },
    requestLink: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
    inputLabel: { color: COLORS.textSecondary, fontSize: 13, marginBottom: SPACING.s, marginTop: SPACING.m },
    input: { backgroundColor: COLORS.surfaceHighlight, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.l, paddingVertical: SPACING.m, color: COLORS.text, fontSize: 15, borderWidth: 1, borderColor: COLORS.border },
    tierRow: { flexDirection: 'row', gap: SPACING.s, marginTop: SPACING.l },
    tierBtn: { flex: 1, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderColor: COLORS.border, paddingVertical: SPACING.s, alignItems: 'center', backgroundColor: COLORS.surface },
    tierBtnActive: { borderColor: COLORS.platinum, backgroundColor: COLORS.surfaceHighlight },
    tierBtnText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '700' },
    tierBtnTextActive: { color: COLORS.platinum },
    tierFee: { color: COLORS.textMuted, fontSize: 12, marginTop: 2 },
    predCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.platinumMuted, marginTop: SPACING.l },
    predRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingVertical: SPACING.xs },
    predText: { color: COLORS.text, fontSize: 13, fontFamily: 'monospace', flex: 1 },
    previewBlock: { marginTop: SPACING.m, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.s },
    previewTitle: { color: COLORS.platinum, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.xs },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingVertical: SPACING.xs },
    previewText: { color: COLORS.textSecondary, fontSize: 12, fontFamily: 'monospace', flex: 1 },
    previewVerdict: { fontSize: 13, fontWeight: '700' },
    previewHint: { color: COLORS.textMuted, fontSize: 11, lineHeight: 16, marginTop: SPACING.xs },
    burnNote: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginTop: SPACING.m },
    disclosureCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.border, marginTop: SPACING.l },
    howTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700', marginBottom: SPACING.xs },
    disclosureHint: { color: COLORS.textMuted, fontSize: 12, lineHeight: 17, marginBottom: SPACING.s },
    group: { marginTop: SPACING.s },
    groupTitle: { color: COLORS.platinum, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: SPACING.xs },
    discRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: SPACING.xs },
    discLeft: { flex: 1, paddingRight: SPACING.s },
    discField: { color: COLORS.textSecondary, fontSize: 13 },
    discValue: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
    discRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
    discState: { color: COLORS.textMuted, fontSize: 12 },
    peRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.s, borderBottomWidth: 1, borderBottomColor: COLORS.border },
    feeCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.platinumMuted, marginTop: SPACING.l },
    feeLabel: { color: COLORS.textMuted, fontSize: 13 },
    feeValue: { color: COLORS.platinum, fontSize: 26, fontWeight: '700', marginTop: SPACING.xs },
    feeSub: { color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.xs },
    err: { color: COLORS.error, fontSize: 13, marginTop: SPACING.s },
    burnBtn: { backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.m, alignItems: 'center', marginTop: SPACING.xl },
    burnBtnDisabled: { opacity: 0.4 },
    burnBtnText: { color: COLORS.black, fontSize: 16, fontWeight: '700' },
    proofCard: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.l, padding: SPACING.l, borderWidth: 1, borderColor: COLORS.platinumMuted, alignItems: 'center' },
    proofHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.s },
    proofTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginLeft: SPACING.s },
    proofRow: { color: COLORS.textSecondary, fontSize: 14, marginBottom: SPACING.m, textAlign: 'center' },
    qrWrap: { backgroundColor: 'white', padding: SPACING.m, borderRadius: BORDER_RADIUS.m, marginBottom: SPACING.m },
    tokenText: { color: COLORS.textMuted, fontSize: 11, marginBottom: SPACING.m },
    shareBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, backgroundColor: COLORS.platinum, borderRadius: BORDER_RADIUS.l, paddingVertical: SPACING.s, paddingHorizontal: SPACING.l },
    shareBtnText: { color: COLORS.black, fontSize: 14, fontWeight: '700' },
    again: { color: COLORS.primary, fontSize: 14, fontWeight: '600', marginTop: SPACING.l },
});
