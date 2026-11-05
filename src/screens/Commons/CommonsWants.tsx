import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
/**
 * CommonsWants — the wants board: demand, posted as Commons speech (a live speech window,
 * one burn; every want mints at its class base). Featured placement is a burn auction: the poster
 * burns any amount from 15 PVT (no ceiling, bids on one want add up, the placement ends when
 * the want closes). Reaching a poster is a thread anchored to the want.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Alert, Modal, TextInput, KeyboardAvoidingView, Keyboard, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { WantView, FeaturedSlot } from '../../core/commons/CommonsService';
import { offerSpeechWindow } from '../../core/commons/speechGate';
import { requireBiometric, BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import { spendBurn } from '../../core/commons/burnForBenefit';
import { FeaturedBidSheet } from '../../components/commons/FeaturedBidSheet';
import { parseWantBudget, formatWantBudget, wantPostErrorKey } from '../../core/commons/wantBudget';
import { getMessageKeyPair, sealThreadMessage } from '../../core/commons/threadCrypto';
import { captureShownOutput, signedThreadPlaintext } from '../../core/commons/commonsOutputSigning';
import { wantOutputText } from '../../core/meter/output-signature';
import { InlinePostButton } from '../../components/commons/InlinePostButton';
import { LoadFailed } from '../../components/commons/LoadFailed';
import {
  claimPendingDraft, draftIsUncertain, keyMissingCopyKeys, onPendingDraftsChanged, pendingWantDrafts, releasePendingDraft, removePendingDraft,
  savePendingDraft, sendFailureOutcome, type PendingThreadDraft,
} from '../../core/commons/pendingThreadDrafts';
import RelayAPIService from '../../services/RelayAPIService';
import BackButton from '../../components/BackButton';

interface Props {
  navigation: {
    goBack: () => void;
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
  /** rendered inside the Commons › Work tab ("Requests") — no own header/background. */
  embedded?: boolean;
  /** the Work tab's cards + switch, scrolled WITH the list (fixed above it they hid the list). */
  header?: React.ReactNode;
}

/** the floating tab bar's height plus breathing room (see Commons tabs/layout.ts). */
const EMBEDDED_BOTTOM_CLEARANCE = 120;

export default function CommonsWants({ navigation, embedded = false, header }: Props) {
  const { t } = useTranslation();
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
  const profile = useCommonsStore((s) => s.profile);
  const [wants, setWants] = useState<WantView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [featured, setFeatured] = useState<FeaturedSlot[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [caps, setCaps] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  // "Reach" used Alert.prompt, which does nothing on Android. A cross-platform sheet instead.
  const [reachWant, setReachWant] = useState<WantView | null>(null);
  const [reachText, setReachText] = useState('');
  // answers kept until the poster can receive them, by want id; `reachDraft` is the
  // kept answer the reply sheet is sending by hand ("Send now").
  const [wantDrafts, setWantDrafts] = useState<Map<string, PendingThreadDraft>>(() => new Map());
  const [reachDraft, setReachDraft] = useState<PendingThreadDraft | null>(null);
  // the person picks the bid amount (floor 15 PVT, no ceiling) in a cross-platform sheet.
  const [bidWant, setBidWant] = useState<WantView | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, f] = await Promise.all([
        CommonsService.listWants({ status: 'open' }),
        CommonsService.featuredWants().catch(() => ({ featured: [] as FeaturedSlot[] })),
      ]);
      setWants(w.wants);
      setFeatured(f.featured);
      setLoadFailed(false);
    } catch (err) {
      console.log('[CommonsWants] load error:', err);
      setLoadFailed(true);
      setWants((prev) => prev ?? []);
    }
  }, []);
  // the speech gate closes the want sheet before navigating to the burn screen; it reopens with the draft on return.
  const resumeWantRef = useRef(false);
  useFocusEffect(useCallback(() => { void load(); if (resumeWantRef.current) { resumeWantRef.current = false; setShowPost(true); } }, [load]));
  useFocusEffect(useCallback(() => {
    if (!myId) return undefined;
    const reload = () => { void pendingWantDrafts(myId).then(setWantDrafts); };
    reload();
    return onPendingDraftsChanged(reload);
  }, [myId]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const gate = async (reason: string, fn: (action: BiometricAction) => Promise<void>): Promise<boolean> => {
    try { await withBiometricAction(reason, fn); return true; } catch (err) {
      if (err instanceof BiometricNotAvailableError || err instanceof BiometricAuthError) Alert.alert(t('commons.confirmationNeededTitle'), errorDisplayCopy(err.message));
      return false;
    }
  };

  // The budget is typed in PVT and sent in PVT atomic units (18 decimals), the relay's unit.
  const budgetParse = parseWantBudget(budget);

  const submitWant = async () => {
    const capabilities = caps.split(',').map((c) => c.trim()).filter(Boolean);
    if (!outcome.trim() || capabilities.length === 0) return;
    const parsed = parseWantBudget(budget);
    if (!parsed.ok) { Alert.alert(t('common.errorTitle'), t('commons.wantBudgetInvalid')); return; }
    await gate(t('commons.biometricPromptWant'), async (biometricAction) => {
    setBusy(true);
    try {
      await CommonsService.postWant({ outcome: outcome.trim(), capabilities, ...(parsed.atomic !== null ? { budget_max_pvt: parsed.atomic } : {}) }, biometricAction);
      setShowPost(false); setOutcome(''); setCaps(''); setBudget('');
      Alert.alert(t('commons.wantPostedTitle'), t('commons.wantPostedBody'));
      await load();
    } catch (err) {
      if (!offerSpeechWindow(err, navigation, t, () => { resumeWantRef.current = true; setShowPost(false); })) Alert.alert(t('common.errorTitle'), t(wantPostErrorKey(err)));
    } finally {
      setBusy(false);
    }
    });
  };

  const feature = (w: WantView) => setBidWant(w);

  const placeBid = async (amountPvt: string) => {
    const w = bidWant;
    if (!w) return;
    setBusy(true);
    try {
      // spendBurn: the burn is saved on the phone the moment it is broadcast; a failed bid keeps it
      // for the next attempt (pendingBurns) — the sheet offers it first, never a second burn.
      await spendBurn(amountPvt, (burnId, action) => CommonsService.featureWant(w.want_id, burnId, action));
      setBidWant(null);
      Alert.alert(t('commons.featuredTitle'), t('commons.featuredBody'));
      await load();
    } catch (err) {
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.featureFailed')));
    } finally { setBusy(false); }
  };

  const reach = (w: WantView, draft?: PendingThreadDraft) => { setReachDraft(draft ?? null); setReachText(draft?.text ?? ''); setReachWant(w); };

  const sendReach = async () => {
    const w = reachWant;
    if (!w) return;
    const body = reachText.trim();
    if (!body || !myId) return;
    await gate(t('commons.biometricPromptMessage'), async (biometricAction) => {
    setBusy(true);
    let claimedId: string | null = null;
    let requested = false;
    try {
      const kp = await getMessageKeyPair(t('commons.biometricPromptMessage'), biometricAction);
      const mine = await CommonsService.readMessageKey(myId, biometricAction);
      if (!mine || mine.pubkey_b64u !== kp.pubkeyB64u) await CommonsService.publishMessageKey(kp.pubkeyB64u, biometricAction);
      const theirs = await CommonsService.readMessageKey(w.poster_wallet_id, biometricAction);
      if (!theirs && reachDraft) {
        // Still no key: the kept answer keeps waiting as it was.
        setReachWant(null); setReachText(''); setReachDraft(null);
        Alert.alert(t('commons.threadKeyMissingTitle'), t('commons.threadDraftWaiting'));
        return;
      }
      if (!theirs) {
        // kept, and sent on its own once the poster's key appears.
        await savePendingDraft({ myId, myPubkey: kp.pubkeyB64u, counterparty: w.poster_wallet_id, threadId: null, anchor: { kind: 'want', id: w.want_id }, text: body });
        // The person answered this want now, whenever the answer reaches the poster.
        captureShownOutput(w.provian_output_signature, wantOutputText(w.outcome, w.capabilities, w.preferred_chains ?? []), { authorId: w.poster_wallet_id, myId });
        const linked = await RelayAPIService.getLinkedAgents().then((r) => r.linked_agents.find((a) => a.wallet_id === w.poster_wallet_id) ?? null, () => null);
        const copy = keyMissingCopyKeys(linked !== null);
        setReachWant(null); setReachText('');
        Alert.alert(t(copy.title), `${t(copy.body, { name: linked?.display_name || shortAddress(w.poster_wallet_id) })}\n\n${t('commons.threadDraftKept')}`);
        return;
      }
      const sealed = sealThreadMessage(await signedThreadPlaintext(body), { [myId]: kp.pubkeyB64u, [w.poster_wallet_id]: theirs.pubkey_b64u });
      // A kept answer sent by hand is claimed first, so the automatic flush never sends it too.
      if (reachDraft && !(await claimPendingDraft(reachDraft.id))) { setReachWant(null); setReachDraft(null); return; }
      claimedId = reachDraft?.id ?? null;
      requested = true;
      const r = await CommonsService.openThread({ anchor: { kind: 'want', id: w.want_id }, counterparty: w.poster_wallet_id, message: { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 } }, biometricAction);
      if (claimedId) { await removePendingDraft(claimedId); claimedId = null; }
      // the person answered this want; its signed text is captured (hash-checked).
      captureShownOutput(w.provian_output_signature, wantOutputText(w.outcome, w.capabilities, w.preferred_chains ?? []), { authorId: w.poster_wallet_id, myId });
      setReachWant(null); setReachText(''); setReachDraft(null);
      navigation.navigate('CommonsThread', { threadId: r.thread.thread_id });
    } catch (err) {
      if (claimedId) { await releasePendingDraft(claimedId, sendFailureOutcome(err, requested)); claimedId = null; }
      if (!offerSpeechWindow(err, navigation, t, () => setReachWant(null))) Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.threadSendFailed')));
    } finally { setBusy(false); }
    });
  };

  const rankOf = (id: string) => featured.find((f) => f.item_id === id)?.rank ?? null;
  const ordered = wants ? [...wants].sort((a, b) => (rankOf(a.want_id) ?? 1e9) - (rankOf(b.want_id) ?? 1e9) || b.created_at - a.created_at) : null;

  const Frame = embedded ? View : SafeAreaView;
  return (
    <Frame style={embedded ? styles.embeddedContainer : styles.container}>
      {!embedded && <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />}
      {!embedded && (
        <View style={styles.header}>
          <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
          <Text style={styles.headerTitle}>{t('commons.wantsTitle')}</Text>
          <View style={{ width: 44 }} />
        </View>
      )}
      <ScrollView contentContainerStyle={[!header && styles.scrollContent, embedded && { paddingBottom: EMBEDDED_BOTTOM_CLEARANCE + SPACING.xl }, embedded && !header && { paddingTop: SPACING.s }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}>
        {header}
        <View style={header ? styles.headerBody : undefined}>
        {/* Inside the Commons tabs "Post a request" sits in the list, never floating over it. */}
        {profile && embedded && (
          <InlinePostButton label={t('commonsHome.postRequest')} onPress={() => setShowPost(true)} testID="commons-post-request" />
        )}
        <View style={styles.explainer}>
          <Ionicons name="megaphone-outline" size={18} color={COLORS.textSecondary} style={{ marginRight: 10, marginTop: 1 }} />
          <Text style={styles.explainerText}>{t('commons.wantsExplainer')}</Text>
        </View>
        {ordered === null ? <ActivityIndicator color={COLORS.primary} /> : ordered.length === 0 && loadFailed ? (
          <LoadFailed onRetry={() => { void load(); }} />
        ) : ordered.length === 0 ? (
          <View style={styles.center}><Ionicons name="megaphone-outline" size={40} color={COLORS.textTertiary} /><Text style={styles.emptyText}>{t('commons.wantsEmpty')}</Text></View>
        ) : ordered.map((w) => {
          const rank = rankOf(w.want_id);
          const mine = w.poster_wallet_id === myId;
          return (
            <View key={w.want_id} style={[styles.card, rank !== null && styles.cardFeatured]}>
              {rank !== null && <Text style={styles.featuredTag}>{t('commons.featuredRank', { rank })}</Text>}
              <Text style={styles.outcome}>{w.outcome}</Text>
              <Text style={styles.caps}>{w.capabilities.join(' · ')}</Text>
              <Text style={styles.meta}>{shortAddress(w.poster_wallet_id)}{formatWantBudget(w.budget_max_pvt) ? ` · ≤ ${formatWantBudget(w.budget_max_pvt)} PVT` : ''}</Text>
              {!mine && wantDrafts.has(w.want_id) && (() => {
                const d = wantDrafts.get(w.want_id)!;
                return (
                  <View style={styles.draftRow}>
                    <Text style={styles.draftText} numberOfLines={2}>{d.text}</Text>
                    <Text style={styles.meta}>{draftIsUncertain(d) ? t('commons.threadDraftUncertain') : d.failedAt ? t('commons.threadDraftNotSent') : t('commons.threadDraftWaiting')}</Text>
                    {d.failedAt || draftIsUncertain(d) ? (
                      <TouchableOpacity style={styles.actionBtn} onPress={() => reach(w, d)} disabled={busy} accessibilityRole="button">
                        <Ionicons name="send" size={14} color={COLORS.primary} /><Text style={styles.actionText}>{t('commons.threadDraftSendNow')}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })()}
              <View style={styles.actions}>
                {mine ? (
                  <TouchableOpacity style={styles.actionBtn} onPress={() => feature(w)} disabled={busy}><Ionicons name="star-outline" size={14} color={COLORS.warning} /><Text style={styles.actionText}>{t('commons.featureAction')}</Text></TouchableOpacity>
                ) : wantDrafts.has(w.want_id) ? null : (
                  // One kept answer per want: while it waits, the card shows it instead of Reach.
                  <TouchableOpacity style={styles.actionBtn} onPress={() => reach(w)} disabled={busy}><Ionicons name="chatbubble-outline" size={14} color={COLORS.primary} /><Text style={styles.actionText}>{t('commons.wantReach')}</Text></TouchableOpacity>
                )}
              </View>
            </View>
          );
        })}
        </View>
      </ScrollView>
      {profile && !embedded && (
        <TouchableOpacity style={styles.fab} activeOpacity={0.8} onPress={() => setShowPost(true)} accessibilityRole="button" accessibilityLabel={t('commonsHome.postRequest')}>
          <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
          <Ionicons name="add" size={22} color={COLORS.text} />
          <Text style={styles.fabText}>{t('commonsHome.postRequest')}</Text>
        </TouchableOpacity>
      )}
      <FeaturedBidSheet visible={bidWant !== null} busy={busy} onClose={() => setBidWant(null)} onConfirm={(pvt) => { void placeBid(pvt); }} />
      <Modal visible={showPost} animationType="slide" transparent>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={Keyboard.dismiss} accessibilityLabel={t('common.done')} />
          <ScrollView style={styles.modalContent} contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('commons.wantPostTitle')}</Text>
              <TouchableOpacity onPress={() => setShowPost(false)}><Ionicons name="close" size={24} color={COLORS.text} /></TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>{t('commons.wantPostHint')}</Text>
            <TextInput style={styles.modalInput} placeholder={t('commons.wantOutcomePlaceholder')} placeholderTextColor={COLORS.textTertiary} value={outcome} onChangeText={setOutcome} multiline />
            <TextInput style={styles.modalInput} placeholder={t('commons.wantCapsPlaceholder')} placeholderTextColor={COLORS.textTertiary} value={caps} onChangeText={setCaps} autoCapitalize="none" />
            <TextInput style={styles.modalInput} placeholder={t('commons.wantBudgetPlaceholder')} placeholderTextColor={COLORS.textTertiary} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" testID="want-budget" />
            {!budgetParse.ok && <Text style={styles.fieldError}>{t('commons.wantBudgetInvalid')}</Text>}
            <TouchableOpacity style={[styles.submitButton, (busy || !outcome.trim() || !caps.trim() || !budgetParse.ok) && styles.disabled]} onPress={submitWant} disabled={busy || !outcome.trim() || !caps.trim() || !budgetParse.ok}>
              {busy ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.submitButtonText}>{t('commons.wantPostSubmit')}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
      <Modal visible={reachWant !== null} animationType="slide" transparent onRequestClose={() => setReachWant(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={Keyboard.dismiss} accessibilityLabel={t('common.done')} />
          <ScrollView style={styles.modalContent} contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('commons.wantReachTitle')}</Text>
              <TouchableOpacity onPress={() => setReachWant(null)} accessibilityRole="button" accessibilityLabel={t('common.cancel')}><Ionicons name="close" size={24} color={COLORS.text} /></TouchableOpacity>
            </View>
            {reachWant && <Text style={styles.reachQuote} numberOfLines={3}>{reachWant.outcome}</Text>}
            <Text style={styles.modalHint}>{t('commons.wantReachBody')}</Text>
            <TextInput style={[styles.modalInput, { minHeight: 110 }]} placeholder={t('commonsHome.reachPlaceholder')} placeholderTextColor={COLORS.textTertiary} value={reachText} onChangeText={setReachText} multiline textAlignVertical="top" autoFocus />
            <TouchableOpacity style={[styles.submitButton, (busy || !reachText.trim()) && styles.disabled]} onPress={sendReach} disabled={busy || !reachText.trim()}>
              {busy ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.submitButtonText}>{t('commonsHome.reachSend')}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </Frame>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  embeddedContainer: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: COLORS.text, marginLeft: SPACING.m },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.xxxl },
  headerBody: { paddingHorizontal: SPACING.l, paddingTop: SPACING.xs },
  explainer: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.m },
  explainerText: { color: COLORS.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 },
  center: { alignItems: 'center', paddingVertical: SPACING.xxl, gap: SPACING.s },
  emptyText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  card: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, marginBottom: SPACING.s },
  cardFeatured: { borderWidth: 1, borderColor: COLORS.warning },
  featuredTag: { color: COLORS.warning, fontSize: 11, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  outcome: { color: COLORS.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  caps: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4 },
  meta: { color: COLORS.textTertiary, fontSize: 11, marginTop: 6, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: SPACING.m, marginTop: SPACING.s },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  draftRow: { marginTop: SPACING.s, padding: SPACING.s, borderRadius: BORDER_RADIUS.m, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.primary, gap: 4 },
  draftText: { color: COLORS.text, fontSize: 13 },
  actionText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  fab: { position: 'absolute', right: SPACING.l, bottom: SPACING.xl, height: 52, paddingHorizontal: SPACING.m + 2, borderRadius: 26, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fabText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  reachQuote: { color: COLORS.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20, borderLeftWidth: 2, borderLeftColor: COLORS.primary, paddingLeft: SPACING.s },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBackdrop: { flex: 1 },
  modalContent: { backgroundColor: COLORS.background, borderTopLeftRadius: BORDER_RADIUS.xl, borderTopRightRadius: BORDER_RADIUS.xl, maxHeight: '85%', flexGrow: 0 },
  modalScroll: { padding: SPACING.l, paddingBottom: SPACING.xxl, gap: SPACING.s },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  modalHint: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18 },
  modalInput: { backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, color: COLORS.text, fontSize: 15 },
  fieldError: { color: COLORS.error, fontSize: 13, marginTop: -SPACING.xs },
  submitButton: { marginTop: SPACING.s, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, alignItems: 'center' },
  submitButtonText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
