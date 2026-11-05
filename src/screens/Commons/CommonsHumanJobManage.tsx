import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
import { ZeroHash } from 'ethers';
/**
 * CommonsHumanJobManage - the job screen : one screen for any Commons job, in any of the four
 * hiring directions, for anyone who opens it.
 *
 * anyone reads the job; applies if it hires people (or is told why not)
 * poster + open features it (a burn bid of any amount from 15 PVT; bids stack), sees applicants, opens each applicant's thread,
 * accepts one (a 428 routes to a presentation to the applicant, which then accepts)
 * poster funds the escrow in PVT or USDC with their own key (the first escrow a wallet funds opens a
 * one-time acknowledgement of the admin key's dispute role first); RELEASES payment on-chain
 * (releaseEscrow, then /complete); DISPUTES a funded escrow before auto-release
 * (disputeEscrow, then /dispute); takes the refund once the dispute times out
 * hired delivers (a link and/or text) and is told auto-release protects them
 * either reads the dispute card and checks its status; rates the other party when done
 *
 * Every PE-generating act is biometric-gated (Commons invariant #38); every on-chain act is reviewed
 * on screen first and signed from the person's own key inside one biometric session. Court
 * escalation stays hidden: `court_escalation_available` is always false and no Court control exists.
 */

import { captureShownOutput } from '../../core/commons/commonsOutputSigning';
import { deliverableOutputText, jobPostOutputText } from '../../core/meter/output-signature';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  BiometricNotAvailableError,
  BiometricAuthError,
} from '../../core/security/requireBiometric';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { HumanJob, HumanJobApplication, JobDisputeView } from '../../core/commons/CommonsService';
import { formatHumanJobCompensation } from '../../core/commons/humanJobFormat';
import { speechWindowRequired, PRESENTATION_FLOOR_PVT } from '../../core/commons/speechGate';
import { spendBurn } from '../../core/commons/burnForBenefit';
import { applyEligibility, featuredRankOf, jobCurrencyOf, jobSeekingOf } from '../../core/commons/jobBoard';
import {
  fundHumanJobEscrowOnChain,
  buildEscrowFundingPlan,
  formatEscrowAmount,
  type EscrowFundingDetails,
} from '../../core/wallet/HumanJobEscrowFunder';
import { EscrowActionError, type EscrowActionErrorCode } from '../../core/wallet/HumanJobEscrowActions';
import {
  submitFundingWithRetry,
  releaseJobPayment,
  disputeJob,
  claimJobRefund,
  checkDisputeStatus,
} from '../../core/commons/jobEscrowFlows';
import { shortAddress } from '../../utils/shortAddress';
import { PosterHeader, applyBlockText } from '../../components/commons/JobCard';
import { useJobApply } from './useJobApply';
import BackButton from '../../components/BackButton';
import { LoadFailed } from '../../components/commons/LoadFailed';
import { FeaturedBidSheet } from '../../components/commons/FeaturedBidSheet';
import { EscrowAdminAckSheet } from '../../components/commons/EscrowAdminAckSheet';
import { hasAcknowledgedEscrowAdmin, recordEscrowAdminAck } from '../../core/commons/escrowAdminAck';
import { useWalletStore } from '../../store/walletStore';
import { FEATURED_BID_MIN_PVT } from '../../core/commons/featuredBid';

const ACCENT = '#E8A838';


interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  route: { params?: { jobId?: string } };
}

function formatDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Plain words for a refused on-chain act. */
function escrowActionText(code: EscrowActionErrorCode, t: TFunction): string {
  switch (code) {
    case 'no_onchain_id': return t('commonsJobs.escrowErrNoOnchainId');
    case 'not_depositor': return t('commonsJobs.escrowErrNotPayer');
    case 'not_funded': return t('commonsJobs.escrowErrNotFunded');
    case 'auto_release_passed': return t('commonsJobs.escrowErrAutoReleasePassed');
    case 'auto_release_not_reached': return t('commonsJobs.escrowErrNotPayer');
    case 'not_disputed': return t('commonsJobs.escrowErrNotDisputed');
    case 'bad_contract':
    default: return t('commonsJobs.escrowErrGeneric');
  }
}

function statusLabel(status: string, t: TFunction): string {
  switch (status) {
    case 'open': return t('commonsJobs.statusOpen');
    case 'in_progress': return t('commonsJobs.statusInProgress');
    case 'completed': return t('commonsJobs.statusCompleted');
    case 'disputed': return t('commonsJobs.statusDisputed');
    case 'refunded': return t('commonsJobs.statusRefunded');
    case 'cancelled': return t('commonsJobs.statusCancelled');
    default: return status.replace(/_/g, '  ');
  }
}

export default function CommonsHumanJobManage({ navigation, route }: Props) {
  const { t } = useTranslation();
  const jobId = route.params?.jobId;
  const profile = useCommonsStore((s) => s.profile);
  const myWallet = profile?.wallet_id;

  const [job, setJob] = useState<HumanJob | null>(null);
  const [applicants, setApplicants] = useState<HumanJobApplication[]>([]);
  const [applicantsLoadFailed, setApplicantsLoadFailed] = useState(false);
  const [escrow, setEscrow] = useState<EscrowFundingDetails | null>(null);
  const [dispute, setDispute] = useState<JobDisputeView | null>(null);
  const [featuredRank, setFeaturedRank] = useState<number | null>(null);
  const [showBid, setShowBid] = useState(false);
  const [showEscrowAck, setShowEscrowAck] = useState(false);
  const walletAddress = useWalletStore((s) => s.address);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [deliverUri, setDeliverUri] = useState('');
  const [deliverBody, setDeliverBody] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeEvidence, setDisputeEvidence] = useState('');

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      return;
    }
    try {
      const fresh = await CommonsService.getHumanJob(jobId);
      setJob(fresh);
      const isPoster = !!myWallet && fresh.poster_wallet_id === myWallet;
      const isHired = !!myWallet && fresh.accepted_applicant_wallet_id === myWallet;
      // the job read carries only the deliverable's sha256; a party reads the body + URI here.
      if ((isPoster || isHired) && fresh.deliverable) {
        const d = await CommonsService.getHumanJobDeliverable(jobId).catch(() => null);
        if (d?.deliverable) {
          setJob({ ...fresh, deliverable: d.deliverable });
          // the poster SEES the deliverer's signed deliverable; it is captured
          // (hash-checked) for this phone's next PE. The deliverer's own view captures nothing.
          if (isPoster && fresh.accepted_applicant_wallet_id) {
            captureShownOutput(d.deliverable.provian_output_signature, deliverableOutputText(d.deliverable.uri, d.deliverable.body),
              { authorId: fresh.accepted_applicant_wallet_id, myId: myWallet });
          }
        }
      }
      // The hired worker builds on the job post: its signed title + description is captured.
      if (isHired) {
        captureShownOutput(fresh.provian_output_signature, jobPostOutputText(fresh.title, fresh.description),
          { authorId: fresh.poster_wallet_id, myId: myWallet });
      }
      // Only the poster lists applicants, and only while the job is open.
      if (isPoster && fresh.status === 'open') {
        // a failed read keeps the applicants already shown
        const res = await CommonsService.getHumanJobApplications(jobId).catch((): null => null);
        if (res) setApplicants(res.applications);
        setApplicantsLoadFailed(!res);
      } else {
        setApplicants([]);
        setApplicantsLoadFailed(false);
      }
      // Featured rank (open jobs only — a placement is a bid on the open board).
      if (fresh.status === 'open') {
        const board = await CommonsService.browseHumanJobs({ status: 'open', page_size: 1 }).catch(() => null);
        setFeaturedRank(board ? featuredRankOf(fresh.job_id, board.featured) : null);
      } else {
        setFeaturedRank(null);
      }
      // both parties read the escrow (the hired party sees whether it is funded / disputed).
      let esc: EscrowFundingDetails | null = null;
      if ((isPoster || isHired) && fresh.escrow_id) {
        esc = await CommonsService.getHumanJobEscrowFunding(jobId).catch(() => null);
      }
      setEscrow(esc);
      // The dispute card: whenever the job or its escrow says disputed / refunded.
      const disputed = fresh.status === 'disputed' || fresh.status === 'refunded' || !!fresh.disputed_at || !!esc?.disputed_at;
      if ((isPoster || isHired) && disputed) {
        setDispute(await CommonsService.getJobDispute(jobId).catch(() => null));
      } else {
        setDispute(null);
      }
    } catch (err) {
      console.log('[CommonsHumanJobManage] load error:', err);
    } finally {
      setLoading(false);
    }
  }, [jobId, myWallet]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  const { applyingJobId, startApply, appliedJobIds } = useJobApply({ myWalletId: myWallet, navigation, t, onApplied: () => { void load(); } });

  const showError = (err: unknown, fallbackKey: string) => {
    const msg = err instanceof EscrowActionError
      ? escrowActionText(err.code, t)
      : err instanceof Error ? err.message : t(fallbackKey);
    Alert.alert(t('commonsHumanJobManage.errorTitle'), errorDisplayCopy(msg));
  };

  // Run a PE-generating relay action behind biometric verification (invariant #38).
  const runAction = async (reason: string, fn: (action: BiometricAction) => Promise<unknown>, successMsg: string) => {
    try {
      return await withBiometricAction(reason, async (biometricAction) => {
    setBusy(true);
    try {
      await fn(biometricAction);
      Alert.alert(t('commonsHumanJobManage.doneTitle'), successMsg);
      await load();
    } catch (err) {
      showError(err, 'commonsHumanJobManage.actionFailed');
    } finally {
      setBusy(false);
    }

      });
    } catch (err) {
      if (err instanceof BiometricNotAvailableError) {
        Alert.alert(t('commonsHumanJobManage.biometricRequiredTitle'), errorDisplayCopy(err.message));
      } else if (err instanceof BiometricAuthError) {
        Alert.alert(
          t('commonsHumanJobManage.confirmationNeededTitle'),
          t('commonsHumanJobManage.confirmationNeededMessage'),
        );
      }
      return;
    }
  };

  // ── Poster + open: feature (burn auction, same pattern as wants) ─────────────
  // the poster picks the amount (floor 15 PVT, no ceiling); bids on this job add up.
  const handleFeature = () => { if (jobId) setShowBid(true); };

  const placeBid = async (amountPvt: string) => {
    if (!jobId) return;
    setBusy(true);
    try {
      // Re-read the job before burning: a job hired since this screen loaded can no longer be
      // featured, and burning for it would only park the burn.
      const fresh = await CommonsService.getHumanJob(jobId);
      if (fresh.status !== 'open') {
        setShowBid(false);
        Alert.alert(t('common.errorTitle'), t('commonsJobs.featureNotOpen'));
        await load();
        return;
      }
      // spendBurn: the burn is saved on the phone the moment it is broadcast; a failed bid
      // keeps it for the next attempt (pendingBurns) — never a second burn.
      await spendBurn(amountPvt, (burnId, action) => CommonsService.featureHumanJob(jobId, burnId, action));
      setShowBid(false);
      Alert.alert(t('commons.featuredTitle'), t('commons.featuredBody'));
      await load();
    } catch (err) {
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.featureFailed')));
    } finally { setBusy(false); }
  };

  // ── Poster + open: accept (rail handshake to the applicant) ──────────────────
  const handleAccept = (applicantWalletId: string, displayName?: string) => {
    if (!jobId) return;
    const name = displayName || t('commonsHumanJobManage.thisApplicant');
    Alert.alert(
      t('commonsHumanJobManage.acceptAlertTitle'),
      t('commonsHumanJobManage.acceptAlertMessage', { name }),
      [
        { text: t('commonsHumanJobManage.cancel'), style: 'cancel' },
        {
          text: t('commonsHumanJobManage.accept'),
          onPress: async () => {
    try {
      return await withBiometricAction(t('commonsHumanJobManage.biometricPromptAccept'), async (biometricAction) => {
            setBusy(true);
            try {
              await CommonsService.acceptHumanJobApplicant(jobId, applicantWalletId, biometricAction);
              Alert.alert(t('commonsHumanJobManage.doneTitle'), t('commonsHumanJobManage.acceptSuccess'));
              await load();
            } catch (err) {
              // hiring forms the escrow — the poster must hold a live presentation to the
              // applicant (428). Route to it; the presentation then accepts the applicant.
              if (speechWindowRequired(err)) {
                Alert.alert(
                  t('commonsJobs.handshakeTitle'),
                  t('commonsJobs.handshakeBody', { name, pvt: PRESENTATION_FLOOR_PVT }),
                  [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('commonsJobs.handshakeContinue', { pvt: PRESENTATION_FLOOR_PVT }),
                      onPress: () => navigation.navigate('HumanPresentment', {
                        audience: applicantWalletId,
                        selfChallenge: true,
                        deliverTo: { kind: 'hire', jobId, applicantWalletId, applicantName: displayName },
                      }),
                    },
                  ],
                );
              } else {
                showError(err, 'commonsHumanJobManage.actionFailed');
              }
            } finally {
              setBusy(false);
            }

      });
    } catch (err) {
              if (err instanceof BiometricNotAvailableError || err instanceof BiometricAuthError) {
                Alert.alert(t('commonsHumanJobManage.confirmationNeededTitle'), t('commonsHumanJobManage.confirmationNeededMessage'));
              }
              return;
            }
  },
        },
      ],
    );
  };

  // ── Poster: fund the escrow (PVT or USDC) with their own key ─────────────────
  // The first escrow a wallet funds opens the one-time admin-key acknowledgement first.
  const handleFundEscrow = async () => {
    if (!jobId || !escrow || !job) return;
    if (await hasAcknowledgedEscrowAdmin(walletAddress)) reviewFundEscrow();
    else setShowEscrowAck(true);
  };

  const acknowledgeEscrowAdmin = async () => {
    setShowEscrowAck(false);
    await recordEscrowAdminAck(walletAddress);
    reviewFundEscrow();
  };

  const reviewFundEscrow = () => {
    if (!jobId || !escrow || !job) return;
    Alert.alert(
      t('commonsHumanJobManage.setPaymentAside'),
      t('commonsJobs.fundReview', { amount: formatHumanJobCompensation(job), to: shortAddress(escrow.recipient_address) }),
      [
        { text: t('commonsHumanJobManage.cancel'), style: 'cancel' },
        {
          text: t('commonsHumanJobManage.fund'),
          onPress: async () => {
            setBusy(true);
            try {
              buildEscrowFundingPlan(escrow, ZeroHash);
              await withBiometricAction(t('biometricPrompts.fundJobEscrow', { amount: formatEscrowAmount(escrow) }), async action => {
                const result = await fundHumanJobEscrowOnChain(escrow, action);
                await submitFundingWithRetry(jobId, result.fundTxHash, undefined, action);
              });
              Alert.alert(t('commonsHumanJobManage.fundSuccessTitle'), t('commonsHumanJobManage.fundSuccessMessage'));
              await load();
            } catch (err) {
              Alert.alert(t('commonsHumanJobManage.fundErrorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commonsHumanJobManage.fundErrorFallback')));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  // ── Hired: deliver (a link and/or text, hashed onto the delivery PE and posted in the thread) ──
  const handleDeliver = () => {
    if (!jobId) return;
    const uri = deliverUri.trim();
    const body = deliverBody.trim();
    const deliverable = { ...(uri ? { deliverable_uri: uri } : {}), ...(body ? { deliverable_body: body } : {}) };
    runAction(
      t('commonsHumanJobManage.biometricPromptDeliver'),
      async (biometricAction) => {
        await CommonsService.deliverHumanJob(jobId, deliverable, biometricAction);
        setDeliverUri('');
        setDeliverBody('');
      },
      t('commonsHumanJobManage.deliverSuccess'),
    );
  };

  // ── Poster: release payment — releaseEscrow on-chain from the payer's key, then /complete ──
  const handleComplete = () => {
    if (!jobId || !job) return;
    Alert.alert(
      t('commonsJobs.releaseTitle'),
      t('commonsJobs.releaseReview', { amount: formatHumanJobCompensation(job), to: escrow ? shortAddress(escrow.recipient_address) : '' }),
      [
        { text: t('commonsHumanJobManage.cancel'), style: 'cancel' },
        {
          text: t('commonsJobs.releaseConfirm'),
          onPress: async () => {
            setBusy(true);
            try {
              const out = await releaseJobPayment(jobId, t('commonsJobs.biometricRelease'));
              Alert.alert(
                t('commonsHumanJobManage.doneTitle'),
                out.pending ? t('commonsJobs.releasePendingMessage') : t('commonsJobs.releaseDoneMessage'),
              );
              await load();
            } catch (err) {
              showError(err, 'commonsHumanJobManage.actionFailed');
              await load();
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  // ── Poster: dispute a funded escrow before auto-release ──────────────────────
  const submitDispute = async () => {
    if (!jobId) return;
    const reason = disputeReason.trim();
    if (!reason) {
      Alert.alert(t('commonsJobs.disputeTitle'), t('commonsJobs.disputeReasonRequired'));
      return;
    }
    setDisputeOpen(false);
    setBusy(true);
    try {
      await disputeJob(jobId, { reason, evidence: disputeEvidence }, t('commonsJobs.biometricDispute'));
      setDisputeReason('');
      setDisputeEvidence('');
      Alert.alert(t('commonsJobs.disputeFiledTitle'), t('commonsJobs.disputeFiledMessage'));
      await load();
    } catch (err) {
      showError(err, 'commonsHumanJobManage.actionFailed');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── Payer: take the refund once the dispute timed out (permissionless claim) ─
  const handleClaimRefund = () => {
    if (!jobId) return;
    Alert.alert(t('commonsJobs.claimRefundTitle'), t('commonsJobs.claimRefundReview'), [
      { text: t('commonsHumanJobManage.cancel'), style: 'cancel' },
      {
        text: t('commonsJobs.claimRefund'),
        onPress: async () => {
          setBusy(true);
          try {
            const out = await claimJobRefund(jobId, t('commonsJobs.biometricClaimRefund'));
            Alert.alert(
              t('commonsHumanJobManage.doneTitle'),
              out.kind === 'pending'
                ? t('commonsJobs.disputePendingMessage', { date: formatDate(out.refundOpensAt) })
                : t('commonsJobs.refundDoneMessage'),
            );
            await load();
          } catch (err) {
            showError(err, 'commonsHumanJobManage.actionFailed');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  // ── Either party: ask the relay to record whatever the chain allows ──────────
  const handleCheckStatus = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      const out = await checkDisputeStatus(jobId);
      if (out.kind === 'pending') {
        Alert.alert(t('commonsJobs.disputeCardTitle'), t('commonsJobs.disputePendingMessage', { date: formatDate(out.refundOpensAt ?? dispute?.refund_opens_at) }));
      } else {
        Alert.alert(t('commonsJobs.disputeCardTitle'), disputeOutcomeText(out.view, t) ?? t('commonsJobs.disputeStillOpen'));
      }
      await load();
    } catch (err) {
      showError(err, 'commonsHumanJobManage.actionFailed');
    } finally {
      setBusy(false);
    }
  };

  const handleRate = () => {
    if (!jobId) return;
    if (ratingValue < 1 || ratingValue > 5) {
      Alert.alert(t('commonsHumanJobManage.pickRatingTitle'), t('commonsHumanJobManage.pickRatingMessage'));
      return;
    }
    runAction(
      t('commonsHumanJobManage.biometricPromptRate'),
      (biometricAction) =>
        CommonsService.rateHumanJob(jobId, {
          rating: ratingValue,
          comment: ratingComment.trim() || undefined,
        }, biometricAction),
      t('commonsHumanJobManage.rateSuccess'),
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Header navigation={navigation} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      </SafeAreaView>
    );
  }

  if (!job) {
    return (
      <SafeAreaView style={styles.container}>
        <Header navigation={navigation} />
        <View style={styles.loadingContainer}>
          <Text style={styles.muted}>{t('commonsHumanJobManage.jobNotFound')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isPoster = !!myWallet && job.poster_wallet_id === myWallet;
  const isWorker = !!myWallet && job.accepted_applicant_wallet_id === myWallet;
  const isParty = isPoster || isWorker;
  const delivered = !!job.completion_pe_id;
  const alreadyRated = isPoster ? !!job.rating_pe_id : !!job.human_rating_pe_id;
  const seeking = jobSeekingOf(job);
  const currency = jobCurrencyOf(job);
  const eligibility = applyEligibility(job, { walletId: myWallet, kind: profile?.participant_type ?? null, appliedJobIds });
  // After accept the escrow exists but is 'created' (unfunded) until the poster funds it on-chain.
  const escrowUnfunded = !!escrow && escrow.status === 'created';
  const escrowFunded = !!escrow && escrow.status === 'funded';
  const beforeAutoRelease = !!escrow && Date.now() < escrow.auto_release_at;
  const inDispute = job.status === 'disputed' || !!dispute;
  // The other party on this job (for the "Message" shortcut into the job's thread).
  const counterpartWallet = isPoster ? job.accepted_applicant_wallet_id ?? null : isWorker ? job.poster_wallet_id : null;

  const openJobThread = async (walletId: string, name?: string) => {
    try {
      const { threads } = await CommonsService.listThreads();
      const match = threads.find((th) => th.anchor_kind === 'human_job' && th.anchor_id === job.job_id
        && (th.party_a === walletId || th.party_b === walletId));
      if (match) {
        navigation.navigate('CommonsThread', { threadId: match.thread_id, counterpartyName: name });
        return;
      }
    } catch {
      // fall through to a direct thread with the counterpart
    }
    navigation.navigate('CommonsThread', { counterparty: walletId, counterpartyName: name });
  };

  return (
    <SafeAreaView style={styles.container}>
      <Header navigation={navigation} />
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Job summary */}
        <View style={styles.card}>
          <View style={styles.posterLine}>
            <PosterHeader walletId={job.poster_wallet_id} size={32} />
            {featuredRank !== null && (
              <View style={styles.featuredBadge}>
                <Ionicons name="flame" size={12} color={ACCENT} />
                <Text style={styles.featuredText}>{t('commons.featuredRank', { rank: featuredRank })}</Text>
              </View>
            )}
          </View>
          <View style={styles.summaryHeader}>
            <Text style={styles.jobTitle}>{job.title}</Text>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>{statusLabel(job.status, t)}</Text>
            </View>
          </View>
          <Text style={styles.muted}>{job.description}</Text>
          <View style={styles.metaRow}>
            <Ionicons name={currency === 'usdc' ? 'card' : 'diamond'} size={14} color={COLORS.success} />
            <Text style={styles.metaText}>{formatHumanJobCompensation(job)}</Text>
            <Ionicons name={seeking === 'agent' ? 'hardware-chip-outline' : 'person-outline'} size={14} color={COLORS.textSecondary} style={{ marginLeft: SPACING.m }} />
            <Text style={styles.metaTextMuted}>{seeking === 'agent' ? t('commonsJobs.hiresAgent') : t('commonsJobs.hiresPerson')}</Text>
          </View>
          <Text style={styles.roleNote}>
            {isPoster ? t('commonsHumanJobManage.roleNotePoster') : isWorker ? t('commonsHumanJobManage.roleNoteWorker') : t('commonsHumanJobManage.roleNoteNone')}
          </Text>
          {counterpartWallet ? (
            <TouchableOpacity
              style={styles.messageLink}
              onPress={() => openJobThread(counterpartWallet)}
              accessibilityRole="button"
            >
              <Ionicons name="chatbubbles-outline" size={16} color={COLORS.primary} />
              <Text style={styles.messageLinkText}>
                {isPoster ? t('commonsHome.messageWorker') : t('commonsHome.messagePoster')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* ── Not a party: apply, or why not ─────────────────────────── */}
        {!isParty && (
          <View style={styles.section}>
            {eligibility.canApply ? (
              <>
                <Text style={styles.muted}>{t('commonsJobs.applyExplainer')}</Text>
                <PrimaryButton label={t('commonsHumanJobs.apply')} onPress={() => startApply(job)} busy={applyingJobId === job.job_id} />
              </>
            ) : (
              <Text style={styles.muted}>{applyBlockText(eligibility.reason, t)}</Text>
            )}
          </View>
        )}

        {/* ── Poster + open: feature ─────────────────────────────────── */}
        {isPoster && job.status === 'open' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsJobs.featureSectionTitle')}</Text>
            <Text style={styles.muted}>
              {featuredRank !== null
                ? t('commonsJobs.featuredNow', { rank: featuredRank })
                : t('commonsJobs.featureExplainer', { pvt: FEATURED_BID_MIN_PVT })}
            </Text>
            <SecondaryButton label={featuredRank !== null ? t('commonsJobs.featureRaise') : t('commons.featureAction')} onPress={handleFeature} busy={busy} icon="flame-outline" />
          </View>
        )}

        {/* ── Poster + open: applicants ─────────────────────────────── */}
        {isPoster && job.status === 'open' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsHumanJobManage.applicantsTitle', { count: applicants.length })}</Text>
            {applicants.length === 0 && applicantsLoadFailed ? (
              <LoadFailed onRetry={() => { void load(); }} />
            ) : applicants.length === 0 ? (
              <Text style={styles.muted}>{t('commonsHumanJobManage.noApplicants')}</Text>
            ) : (
              applicants.map((app) => (
                <View key={app.application_id} style={styles.applicantCard}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => navigation.navigate('CommonsProfile', { walletId: app.applicant_wallet_id })}
                    accessibilityRole="button"
                    accessibilityHint={t('commonsHome.viewProfile')}
                  >
                    <Text style={styles.applicantName}>
                      {app.applicant?.display_name || t('commonsHumanJobManage.anonymousParticipant')}
                      {'  '}<Ionicons name="chevron-forward" size={13} color={COLORS.textSecondary} />
                    </Text>
                    <Text style={styles.applicantMeta}>
                      {t('commonsHumanJobManage.applicantMeta', {
                        records: app.applicant?.pe_count ?? 0,
                        jobs: app.applicant?.human_jobs_completed ?? 0,
                      })}
                    </Text>
                    {app.cover_note ? (
                      <Text style={styles.coverNote} numberOfLines={3}>
                        “{app.cover_note}”
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  <View style={styles.applicantActions}>
                    <TouchableOpacity
                      style={styles.iconButton}
                      onPress={() => openJobThread(app.applicant_wallet_id, app.applicant?.display_name)}
                      accessibilityRole="button"
                      accessibilityLabel={t('commonsJobs.messageApplicant')}
                    >
                      <Ionicons name="chatbubbles-outline" size={18} color={COLORS.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.smallButton, busy && styles.buttonDisabled]}
                      disabled={busy}
                      onPress={() => handleAccept(app.applicant_wallet_id, app.applicant?.display_name)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.smallButtonText}>{t('commonsHumanJobManage.accept')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* ── In progress: fund escrow (poster) ──────────────────────── */}
        {job.status === 'in_progress' && escrowUnfunded && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsHumanJobManage.setPaymentAside')}</Text>
            {isPoster ? (
              <>
                <Text style={styles.muted}>
                  {t('commonsHumanJobManage.fundPosterExplainer', { amount: formatHumanJobCompensation(job) })}
                </Text>
                {currency === 'usdc' ? <Text style={[styles.muted, styles.gap]}>{t('commonsJobs.fundUsdcNote')}</Text> : null}
                <PrimaryButton label={t('commonsHumanJobManage.holdPayment')} onPress={() => { void handleFundEscrow(); }} busy={busy} />
              </>
            ) : (
              <Text style={styles.muted}>
                {t('commonsHumanJobManage.fundWaitingWorker')}
              </Text>
            )}
          </View>
        )}

        {/* ── In progress, funded: deliver / release / dispute ───────── */}
        {isParty && job.status === 'in_progress' && !escrowUnfunded && !inDispute && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsHumanJobManage.workInProgressTitle')}</Text>
            {isWorker && escrowFunded && (
              <View style={styles.protectNote}>
                <Ionicons name="shield-checkmark-outline" size={16} color={COLORS.success} />
                <Text style={styles.protectText}>{t('commonsJobs.autoReleaseProtects', { date: formatDate(escrow?.auto_release_at) })}</Text>
              </View>
            )}
            {isWorker && !delivered && (
              <>
                <Text style={styles.muted}>{t('commonsJobs.deliverExplainer')}</Text>
                <TextInput
                  value={deliverUri}
                  onChangeText={setDeliverUri}
                  placeholder={t('commonsJobs.deliverUriPlaceholder')}
                  placeholderTextColor={COLORS.textTertiary}
                  autoCapitalize="none"
                  keyboardType="url"
                  style={[styles.input, styles.inputSingle]}
                />
                <TextInput
                  value={deliverBody}
                  onChangeText={setDeliverBody}
                  placeholder={t('commonsJobs.deliverBodyPlaceholder')}
                  placeholderTextColor={COLORS.textTertiary}
                  multiline
                  style={styles.input}
                />
                <PrimaryButton label={t('commonsHumanJobManage.markDelivered')} onPress={handleDeliver} busy={busy} />
              </>
            )}
            {isWorker && delivered && (
              <Text style={styles.muted}>
                {job.payment_release_pending ? t('commonsJobs.releasePendingWorker') : t('commonsHumanJobManage.deliveredWaiting')}
              </Text>
            )}
            {isPoster && delivered && job.deliverable && (
              <View style={styles.deliverableBox}>
                <Text style={styles.sectionSubTitle}>{t('commonsJobs.deliverableTitle')}</Text>
                {job.deliverable.uri ? <Text style={styles.deliverableText} selectable>{job.deliverable.uri}</Text> : null}
                {job.deliverable.body ? <Text style={styles.deliverableText} selectable>{job.deliverable.body}</Text> : null}
              </View>
            )}
            {isPoster && delivered && job.payment_release_pending && (
              <View style={styles.pendingNote}>
                <Ionicons name="time-outline" size={16} color={COLORS.warning} />
                <Text style={styles.pendingText}>{t('commonsJobs.releasePendingPoster')}</Text>
              </View>
            )}
            {isPoster && delivered && !job.payment_released && (
              <>
                {!job.payment_release_pending && <Text style={styles.muted}>{t('commonsJobs.releaseExplainer')}</Text>}
                <PrimaryButton
                  label={job.payment_release_pending ? t('commonsJobs.releaseCheckAgain') : t('commonsJobs.releaseButton')}
                  onPress={handleComplete}
                  busy={busy}
                />
              </>
            )}
            {isPoster && !delivered && (
              <Text style={styles.muted}>{t('commonsHumanJobManage.waitingForDelivery')}</Text>
            )}
            {isPoster && escrowFunded && beforeAutoRelease && !job.payment_released && !job.payment_release_pending && (
              <View style={styles.disputeEntry}>
                <Text style={styles.mutedSmall}>{t('commonsJobs.disputeEntryHint', { date: formatDate(escrow?.auto_release_at) })}</Text>
                <SecondaryButton label={t('commonsJobs.disputeButton')} onPress={() => setDisputeOpen(true)} busy={busy} icon="alert-circle-outline" />
              </View>
            )}
          </View>
        )}

        {/* ── Dispute card (either party) ────────────────────────────── */}
        {isParty && inDispute && (
          <View style={[styles.section, styles.disputeSection]}>
            <View style={styles.disputeHeader}>
              <Ionicons name="alert-circle" size={18} color={COLORS.warning} />
              <Text style={styles.sectionTitle}>{t('commonsJobs.disputeCardTitle')}</Text>
            </View>
            {dispute ? (
              <>
                {disputeOutcomeText(dispute, t) ? (
                  <Text style={styles.muted}>{disputeOutcomeText(dispute, t)}</Text>
                ) : (
                  <Text style={styles.muted}>
                    {dispute.refund_opens_at
                      ? t('commonsJobs.disputeWithAdmin', { date: formatDate(dispute.refund_opens_at) })
                      : t('commonsJobs.disputeWithAdminNoDate')}
                  </Text>
                )}
                {dispute.dispute_reason ? (
                  <Text style={[styles.coverNote, styles.gap]}>{t('commonsJobs.disputeReasonShown', { reason: dispute.dispute_reason })}</Text>
                ) : null}
                {isWorker && !dispute.resolution && (
                  <Text style={[styles.mutedSmall, styles.gap]}>{t('commonsJobs.disputeWorkerNote')}</Text>
                )}
                {isPoster && dispute.refund_claimable && !dispute.resolution && (
                  <PrimaryButton label={t('commonsJobs.claimRefund')} onPress={handleClaimRefund} busy={busy} />
                )}
                {!dispute.resolution && (
                  <SecondaryButton label={t('commonsJobs.checkStatus')} onPress={handleCheckStatus} busy={busy} icon="refresh" />
                )}
              </>
            ) : (
              <>
                <Text style={styles.muted}>{t('commonsJobs.disputeWithAdminNoDate')}</Text>
                <SecondaryButton label={t('commonsJobs.checkStatus')} onPress={handleCheckStatus} busy={busy} icon="refresh" />
              </>
            )}
          </View>
        )}

        {/* ── Completed: payment status + rating ────────────────────── */}
        {job.status === 'completed' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('commonsHumanJobManage.completedTitle')}</Text>
            <View style={styles.metaRow}>
              <Ionicons
                name={job.payment_released ? 'checkmark-circle' : 'time'}
                size={14}
                color={job.payment_released ? COLORS.success : COLORS.warning}
              />
              <Text style={styles.metaTextMuted}>
                {job.payment_released
                  ? t('commonsHumanJobManage.paymentSent')
                  : job.payment_release_pending
                    ? t('commonsHumanJobManage.paymentPending')
                    : t('commonsHumanJobManage.paymentUpdating')}
              </Text>
            </View>

            {isParty && (
              alreadyRated ? (
                <Text style={[styles.muted, { marginTop: SPACING.m }]}>
                  {t('commonsHumanJobManage.alreadyRated')}
                </Text>
              ) : (
                <View style={{ marginTop: SPACING.m }}>
                  <Text style={styles.sectionSubTitle}>{t('commonsHumanJobManage.rateOtherPerson')}</Text>
                  <View style={styles.starRow}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <TouchableOpacity key={star} onPress={() => setRatingValue(star)} activeOpacity={0.7}>
                        <Ionicons
                          name={star <= ratingValue ? 'star' : 'star-outline'}
                          size={28}
                          color={ACCENT}
                          style={{ marginRight: SPACING.xs }}
                        />
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    value={ratingComment}
                    onChangeText={setRatingComment}
                    placeholder={t('commonsHumanJobManage.optionalComment')}
                    placeholderTextColor={COLORS.textTertiary}
                    multiline
                    style={styles.input}
                  />
                  <PrimaryButton label={t('commonsHumanJobManage.submitRating')} onPress={handleRate} busy={busy} />
                </View>
              )
            )}
          </View>
        )}
      </ScrollView>

      {/* Dispute sheet: reason (required) + evidence (optional) → biometric → on-chain → relay */}
      <FeaturedBidSheet visible={showBid} busy={busy} onClose={() => setShowBid(false)} onConfirm={(pvt) => { void placeBid(pvt); }} />
      <EscrowAdminAckSheet visible={showEscrowAck} onClose={() => setShowEscrowAck(false)} onAcknowledge={() => { void acknowledgeEscrowAdmin(); }} />
      <Modal visible={disputeOpen} transparent animationType="slide" onRequestClose={() => setDisputeOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetOverlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setDisputeOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{t('commonsJobs.disputeTitle')}</Text>
            <Text style={styles.muted}>{t('commonsJobs.disputeSheetBody', { date: formatDate(escrow?.auto_release_at) })}</Text>
            <TextInput
              value={disputeReason}
              onChangeText={setDisputeReason}
              placeholder={t('commonsJobs.disputeReasonPlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              multiline
              maxLength={1000}
              style={[styles.input, styles.gap]}
            />
            <TextInput
              value={disputeEvidence}
              onChangeText={setDisputeEvidence}
              placeholder={t('commonsJobs.disputeEvidencePlaceholder')}
              placeholderTextColor={COLORS.textTertiary}
              multiline
              maxLength={2000}
              style={styles.input}
            />
            <View style={styles.sheetButtons}>
              <TouchableOpacity style={styles.sheetCancel} onPress={() => setDisputeOpen(false)} accessibilityRole="button">
                <Text style={styles.sheetCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sheetConfirm, !disputeReason.trim() && styles.buttonDisabled]}
                disabled={!disputeReason.trim()}
                onPress={() => { void submitDispute(); }}
                accessibilityRole="button"
              >
                <Text style={styles.sheetConfirmText}>{t('commonsJobs.disputeConfirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

/** The outcome of a settled dispute, in plain words — or null while it is still open. */
function disputeOutcomeText(view: JobDisputeView, t: TFunction): string | null {
  if (view.resolution === 'release_to_recipient') return t('commonsJobs.disputeOutcomeReleased');
  if (view.resolution === 'refund_to_depositor') return t('commonsJobs.disputeOutcomeRefunded');
  return null;
}

function Header({ navigation }: { navigation: Props['navigation'] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      <BackButton onPress={() => navigation.goBack()} />
      <View style={styles.headerTitleRow}>
        <View style={styles.headerIconBg}>
          <Ionicons name="briefcase" size={16} color={ACCENT} />
        </View>
        <Text style={styles.headerTitle}>{t('commonsHumanJobManage.headerTitle')}</Text>
      </View>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function PrimaryButton({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.primaryButton, busy && styles.buttonDisabled]}
      disabled={busy}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
    >
      <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
      {busy ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.primaryButtonText}>{label}</Text>}
    </TouchableOpacity>
  );
}

function SecondaryButton({ label, onPress, busy, icon }: { label: string; onPress: () => void; busy: boolean; icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <TouchableOpacity
      style={[styles.secondaryButton, busy && styles.buttonDisabled]}
      disabled={busy}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={16} color={COLORS.text} />
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  messageLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: SPACING.s, paddingVertical: 6 },
  messageLinkText: { color: COLORS.primary, fontSize: 14, fontWeight: '600' },
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollView: { flex: 1 },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  muted: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18 },
  mutedSmall: { color: COLORS.textTertiary, fontSize: 12, lineHeight: 17 },
  gap: { marginTop: SPACING.s },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.m,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginLeft: SPACING.m,
    flex: 1,
  },
  headerIconBg: {
    width: 28,
    height: 28,
    borderRadius: BORDER_RADIUS.s,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(232,168,56,0.18)',
  },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '600' },
  headerSpacer: { width: 32 },

  card: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    marginBottom: SPACING.l,
  },
  posterLine: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, marginBottom: SPACING.s },
  featuredBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(232,168,56,0.15)', paddingHorizontal: SPACING.s, paddingVertical: 3, borderRadius: BORDER_RADIUS.round,
  },
  featuredText: { color: ACCENT, fontSize: 11, fontWeight: '700' },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: SPACING.s,
    marginBottom: SPACING.s,
  },
  jobTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700', flex: 1 },
  statusPill: {
    backgroundColor: 'rgba(232,168,56,0.18)',
    paddingHorizontal: SPACING.s,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.s,
  },
  statusPillText: { color: ACCENT, fontSize: 11, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: SPACING.s, flexWrap: 'wrap' },
  metaText: { color: COLORS.success, fontSize: 13, fontWeight: '600', marginLeft: 4 },
  metaTextMuted: { color: COLORS.textSecondary, fontSize: 13, marginLeft: 4, flexShrink: 1 },
  roleNote: { color: COLORS.textTertiary, fontSize: 12, marginTop: SPACING.s, fontStyle: 'italic' },

  section: {
    backgroundColor: 'rgba(18,21,26,0.70)',
    borderRadius: BORDER_RADIUS.l,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: 'rgba(200,205,214,0.08)',
    marginBottom: SPACING.l,
  },
  disputeSection: { borderColor: 'rgba(232,168,56,0.35)' },
  disputeHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  disputeEntry: { marginTop: SPACING.m, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.m },
  sectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginBottom: SPACING.s },
  sectionSubTitle: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: SPACING.xs },

  protectNote: { flexDirection: 'row', gap: SPACING.s, alignItems: 'flex-start', backgroundColor: COLORS.successMuted, borderRadius: BORDER_RADIUS.m, padding: SPACING.s, marginBottom: SPACING.s },
  protectText: { color: COLORS.text, fontSize: 13, lineHeight: 18, flex: 1 },
  pendingNote: { flexDirection: 'row', gap: SPACING.s, alignItems: 'flex-start', backgroundColor: COLORS.warningMuted, borderRadius: BORDER_RADIUS.m, padding: SPACING.s, marginBottom: SPACING.s },
  pendingText: { color: COLORS.text, fontSize: 13, lineHeight: 18, flex: 1 },
  deliverableBox: { backgroundColor: COLORS.surfaceHighlight, borderRadius: BORDER_RADIUS.m, padding: SPACING.s, marginBottom: SPACING.s },
  deliverableText: { color: COLORS.text, fontSize: 13, lineHeight: 18, marginTop: 2 },

  applicantCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    paddingVertical: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: 'rgba(200,205,214,0.08)',
  },
  applicantActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primaryMuted },
  applicantName: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  applicantMeta: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },
  coverNote: { color: COLORS.textSecondary, fontSize: 12, marginTop: SPACING.xs, fontStyle: 'italic' },

  starRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.s },
  input: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: BORDER_RADIUS.m,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    color: COLORS.text,
    fontSize: 15,
    minHeight: 64,
    textAlignVertical: 'top',
    marginBottom: SPACING.m,
  },
  inputSingle: { minHeight: 44, marginTop: SPACING.s, marginBottom: SPACING.s },

  primaryButton: {
    height: 48,
    borderRadius: BORDER_RADIUS.l,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.m,
  },
  primaryButtonText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    height: 44,
    borderRadius: BORDER_RADIUS.l,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceHighlight,
    flexDirection: 'row',
    gap: SPACING.xs,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.m,
  },
  secondaryButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  smallButton: {
    backgroundColor: ACCENT,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: BORDER_RADIUS.round,
  },
  smallButtonText: { color: '#1F1502', fontSize: 13, fontWeight: '700' },
  buttonDisabled: { opacity: 0.6 },

  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: COLORS.surfaceElevated,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.l,
    paddingBottom: SPACING.xxl,
  },
  sheetTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700', marginBottom: SPACING.s },
  sheetButtons: { flexDirection: 'row', gap: SPACING.s },
  sheetCancel: { flex: 1, height: 48, borderRadius: BORDER_RADIUS.l, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' },
  sheetCancelText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  sheetConfirm: { flex: 1, height: 48, borderRadius: BORDER_RADIUS.l, backgroundColor: COLORS.warning, alignItems: 'center', justifyContent: 'center' },
  sheetConfirmText: { color: '#1F1502', fontSize: 15, fontWeight: '700' },
});
