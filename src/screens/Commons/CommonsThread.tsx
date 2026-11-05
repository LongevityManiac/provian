import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
/**
 * CommonsThread — one bilateral thread. Messages are end-to-end encrypted with the
 * seed-derived message key (threadCrypto); the relay holds ciphertext and seals only the hash in
 * the author's chain. Speech is speech: the only verifiable fact here is an attached presentation —
 * either party can REQUEST one (the relay composes the binding) and the other PRESENTS (a
 * burn-backed presentation through HumanPresentment, verify-at-submit). Deliverables and
 * application notes ride as attachments.
 *
 * a verdict renders ONLY from the relay-held request record, and a request / presentation /
 * deliverable renders only when the relay composed the message (`origin: 'relay'`) — see
 * `threadMessageView`. Nothing in a message attachment can make this screen say "verified".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Keyboard, Platform, ActivityIndicator, Alert, Modal, Pressable, AppState, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { shortAddress } from '../../utils/shortAddress';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import type { ThreadDocument, ThreadMessage, ThreadPresentationRequest } from '../../core/commons/CommonsService';
import { viewThreadAttachment, viewThreadBody } from '../../core/commons/threadMessageView';
import { getMessageKeyPair, sealThreadMessage, openThreadMessage, cachedMessageKeyPair } from '../../core/commons/threadCrypto';
import {
  claimPendingDraft, draftIsUncertain, flushPendingThreadDrafts, keyMissingCopyKeys, onPendingDraftsChanged, pendingDraftsFor, releasePendingDraft, removePendingDraft, savePendingDraft, sendFailureOutcome,
  type PendingThreadDraft, type SentDraft,
} from '../../core/commons/pendingThreadDrafts';
import RelayAPIService from '../../services/RelayAPIService';
import { captureShownOutput, readThreadPlaintext, signedThreadPlaintext } from '../../core/commons/commonsOutputSigning';
import { offerSpeechWindow } from '../../core/commons/speechGate';
import { BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import SeedManager from '../../core/wallet/SeedManager';
import PredicatePicker from '../../components/commons/forum/PredicatePicker';
import { describePredicate, initialPredicateDraft, predicateFromDraft, type PredicateDraft } from '../../core/commons/predicatePicker';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';
import { fetchedReadCursor, mergeThreadMessages, THREAD_PAGE_SIZE } from '../../core/commons/threadHistory';

type Props = NativeStackScreenProps<AppParamList, 'CommonsThread'>;

export default function CommonsThread({ navigation, route }: Props) {
  const { t } = useTranslation();
  // open by thread id, or start a DIRECT conversation with a wallet (`counterparty`) from its
  // profile or the Earn tab. With no thread yet the first message opens one (profile anchor); a thread
  // that already exists with them is reused.
  const counterparty = route.params.counterparty ?? null;
  const counterpartyName = route.params.counterpartyName ?? null;
  const [threadId, setThreadId] = useState<string | null>(route.params.threadId ?? null);
  const [resolving, setResolving] = useState(!route.params.threadId && !!counterparty);
  const myId = useCommonsStore((s) => s.profile?.wallet_id ?? null);
  const [thread, setThread] = useState<ThreadDocument | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [plain, setPlain] = useState<Record<string, string | null>>({});
  const plainRef = useRef(plain);
  plainRef.current = plain;
  const [requests, setRequests] = useState<Record<string, ThreadPresentationRequest>>({});
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keyMissing, setKeyMissing] = useState<string | null>(null);
  // a message to someone with no message key yet is kept and sends itself once the
  // key appears. `ownAgent` is that person's linked agent's name when the counterparty is one.
  const [drafts, setDrafts] = useState<PendingThreadDraft[]>([]);
  const [ownAgent, setOwnAgent] = useState<{ name: string } | null>(null);
  // Request-presentation modal
  const [showRequest, setShowRequest] = useState(false);
  // §5: plain sentences (PredicatePicker), the raw field/op/threshold form behind "Advanced".
  const [predDraft, setPredDraft] = useState<PredicateDraft>(initialPredicateDraft());
  const [requesting, setRequesting] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const visibleRef = useRef(false);
  const loadInFlight = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const scrollToLatest = useRef(true);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const fetchedCoverage = useRef<number | null>(null);
  const oldestCursor = useRef<{ at: number; id: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [shownCursor, setShownCursor] = useState(0);
  const [atLatest, setAtLatest] = useState(false);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const layoutReady = useRef(false);
  const acknowledged = useRef(0);

  const otherId = thread ? (thread.party_a === myId ? thread.party_b : thread.party_a) : counterparty;
  const otherName = ownAgent?.name ?? counterpartyName ?? (otherId ? thread?.display_names?.[otherId] ?? null : null) ?? (otherId ? shortAddress(otherId) : '');

  // Is the counterparty one of this person's own linked agents? (Decides the no-key copy.)
  useEffect(() => {
    if (!otherId) return;
    let cancelled = false;
    RelayAPIService.getLinkedAgents().then((r) => {
      const a = r.linked_agents.find((x) => x.wallet_id === otherId);
      if (!cancelled) setOwnAgent(a ? { name: a.display_name || counterpartyName || shortAddress(otherId) } : null);
    }, () => undefined);
    return () => { cancelled = true; };
  }, [otherId, counterpartyName]);

  // Only the drafts that belong to THIS conversation: written in this thread, or (no thread named, no
  // want anchor) the direct conversation this screen is. A want answer kept from the wants board never
  // shows — or sends — here.
  const loadDrafts = useCallback(async () => {
    if (!myId || !otherId) return;
    const direct = threadId === null || thread?.anchor_kind === 'profile';
    setDrafts((await pendingDraftsFor(myId, otherId)).filter((d) => (d.threadId ? d.threadId === threadId : !d.anchor && direct)));
  }, [myId, otherId, threadId, thread?.anchor_kind]);
  // A kept draft that went out (from here or the app-wide flush) joins the conversation.
  const applySent = useCallback((sent?: SentDraft) => {
    if (!sent || sent.draft.counterparty !== otherId || sent.draft.myId !== myId) return;
    setKeyMissing(null);
    setPlain((prev) => ({ ...prev, [sent.message.message_id]: sent.draft.text }));
    if (!threadId) { if (!sent.draft.anchor) setThreadId(sent.threadId); return; }
    if (sent.threadId === threadId) setMessages((prev) => (prev.some((p) => p.message_id === sent.message.message_id) ? prev : [...prev, sent.message]));
  }, [otherId, myId, threadId]);
  useEffect(() => {
    void loadDrafts();
    return onPendingDraftsChanged((sent) => { void loadDrafts(); applySent(sent); });
  }, [loadDrafts, applySent]);

  // (item 2): true while the message key could not be unlocked, so an unopened
  // message says "Couldn't unlock" with Try again — never "Encrypted for another key".
  const [keyUnavailable, setKeyUnavailable] = useState(false);
  /** Open every message addressed to this person. False when the key itself could not be unlocked. */
  const decrypt = useCallback(async (rows: ThreadMessage[]): Promise<boolean> => {
    if (!myId) return false;
    try {
      const kp = await getMessageKeyPair();
      setKeyUnavailable(false);
      const out: Record<string, string | null> = {};
      let allOpened = true;
      for (const m of rows) {
        if (typeof plainRef.current[m.message_id] === 'string') continue;
        const ct = m.ciphertexts?.[myId];
        const opened = ct ? openThreadMessage(kp.secretKey, ct) : null;
        if (opened === null) {
          out[m.message_id] = null;
          // Attachment-only job entries have no text to unlock. Match the body
          // renderer while retaining the read barrier for unopened ciphertext.
          if (viewThreadBody(m, opened, false).kind === 'other_key') allOpened = false;
          continue;
        }
        // a signed message shows its text (the signature trailer stripped); a
        // signed message from the OTHER party is captured as shown, for this phone's next PE.
        const { text, signature } = readThreadPlaintext(opened);
        out[m.message_id] = text;
        captureShownOutput(signature, text, { authorId: m.author_id, myId });
      }
      setPlain((prev) => ({ ...prev, ...out }));
      return allOpened;
    } catch (err) {
      console.log('[CommonsThread] decrypt unavailable:', err instanceof Error ? err.message : err);
      setKeyUnavailable(true);
      return false;
    }
  }, [myId]);

  // Direct mode: find an existing thread with the counterparty before offering a fresh one.
  useEffect(() => {
    if (threadId || !counterparty) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await CommonsService.listThreads();
        const withThem = r.threads.filter((th) => th.party_a === counterparty || th.party_b === counterparty)
          .sort((a, b) => (a.anchor_kind === 'profile' ? -1 : 0) - (b.anchor_kind === 'profile' ? -1 : 0) || b.last_message_at - a.last_message_at);
        if (!cancelled && withThem[0]) setThreadId(withThem[0].thread_id);
      } catch { /* no list → start fresh; openThread reuses an existing profile thread server-side */ }
      finally { if (!cancelled) { setResolving(false); setLoading(false); } }
    })();
    return () => { cancelled = true; };
  }, [threadId, counterparty]);

  const load = useCallback(async (older = false) => {
    if (!threadId || loadInFlight.current || !visibleRef.current || AppState.currentState !== 'active') return;
    loadInFlight.current = true;
    if (older) setLoadingOlder(true);
    const current = messagesRef.current;
    try {
      const before = older ? oldestCursor.current?.at : undefined;
      const [page, reqs] = await Promise.all([
        CommonsService.getThreadMessages(threadId, { limit: THREAD_PAGE_SIZE, ...(before ? { before, beforeId: oldestCursor.current!.id } : {}) }),
        CommonsService.listThreadPresentationRequests(threadId),
      ]);
      let rows = page.messages;
      // Never acknowledge past an unread gap, including on the first open.
      let oldestPage = page.messages;
      if (!older) {
        const coveredThrough = fetchedCoverage.current ?? page.thread.read_cursors?.[myId ?? ''] ?? 0;
        while (oldestPage.length === THREAD_PAGE_SIZE && oldestPage[0].created_at > coveredThrough) {
          oldestPage = (await CommonsService.getThreadMessages(threadId, { limit: THREAD_PAGE_SIZE, before: oldestPage[0].created_at, beforeId: oldestPage[0].message_id })).messages;
          rows = mergeThreadMessages(oldestPage, rows);
        }
      }
      if (!visibleRef.current || AppState.currentState !== 'active') return;
      const unlocked = await decrypt(mergeThreadMessages(current, rows));
      if (!visibleRef.current || AppState.currentState !== 'active') return;
      if (rows.some((row) => !current.some((held) => held.message_id === row.message_id))) {
        layoutReady.current = false;
        setAtLatest(false);
      }
      setThread(page.thread);
      setMessages((prev) => mergeThreadMessages(prev, rows));
      setRequests((prev) => ({ ...prev, ...Object.fromEntries(reqs.requests.map((r) => [r.request_id, r])) }));
      if (older || current.length === 0) {
        setOlderAvailable(oldestPage.length === THREAD_PAGE_SIZE);
        if (oldestPage[0]) oldestCursor.current = { at: oldestPage[0].created_at, id: oldestPage[0].message_id };
      }
      if (older) scrollToLatest.current = false;
      setLoadError(false);
      // A separate post-render effect acknowledges only the fetched, decrypted page.
      if (unlocked) {
        const fetchedThrough = fetchedReadCursor(rows);
        if (!older) fetchedCoverage.current = fetchedThrough;
        setShownCursor((prior) => Math.max(prior, fetchedThrough));
      }
    } catch {
      if (visibleRef.current) setLoadError(true);
    } finally {
      loadInFlight.current = false;
      setLoading(false);
      setLoadingOlder(false);
    }
  }, [threadId, decrypt, myId]);

  useFocusEffect(useCallback(() => {
    visibleRef.current = true;
    void load();
    const timer = setInterval(() => { void load(); }, 10_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void load(); });
    return () => { visibleRef.current = false; clearInterval(timer); subscription.remove(); };
  }, [load]));

  useEffect(() => {
    if (!threadId || loading || !atLatest || shownCursor <= acknowledged.current) return;
    const frame = requestAnimationFrame(() => {
      if (!visibleRef.current || !layoutReady.current || AppState.currentState !== 'active') return;
      void CommonsService.markThreadRead(threadId, shownCursor).then(() => {
        acknowledged.current = Math.max(acknowledged.current, shownCursor);
        void useCommonsStore.getState().refreshNotifications();
        requestAttentionRefresh();
      }).catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [threadId, loading, shownCursor, messages, atLatest]);

  // While a kept draft waits here, look for the recipient's key every 10 s (a send reaches applySent).
  const waiting = drafts.length > 0;
  useFocusEffect(useCallback(() => {
    if (!waiting || !myId) return undefined;
    void flushPendingThreadDrafts(myId);
    const id = setInterval(() => { void flushPendingThreadDrafts(myId); }, 10_000);
    return () => clearInterval(id);
  }, [waiting, myId]));
  const refresh = async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } };

  const ensureKeys = useCallback(async (biometricAction?: BiometricAction): Promise<Record<string, string> | null> => {
    if (!myId || !otherId) return null;
    const kp = await getMessageKeyPair(undefined, biometricAction);
    const mine = await CommonsService.readMessageKey(myId, biometricAction);
    if (!mine || mine.pubkey_b64u !== kp.pubkeyB64u) await CommonsService.publishMessageKey(kp.pubkeyB64u, biometricAction);
    const theirs = await CommonsService.readMessageKey(otherId, biometricAction);
    if (!theirs) { setKeyMissing(otherId); return null; }
    return { [myId]: kp.pubkeyB64u, [otherId]: theirs.pubkey_b64u };
  }, [myId, otherId]);

  /**
   * Send `body` (the composer's text, or a kept draft claimed for "Send now"). `outcome` says how it
   * ended: sent, not_sent (nothing reached the relay), refused (4xx) or uncertain (no answer after the
   * request left — it may have landed).
   */
  type SendOutcome = 'sent' | 'not_sent' | 'refused' | 'uncertain';
  const sendText = async (body: string, draft?: PendingThreadDraft): Promise<SendOutcome> => {
    if (!body || sending) return 'not_sent';
    let outcome: SendOutcome = 'not_sent';
    let attempted = false;
    try {
      await withBiometricAction(t('commons.biometricPromptMessage'), async (biometricAction) => {

        setSending(true);
        try {
          const keys = await ensureKeys(biometricAction);
          if (!keys) {
            // Keep it: it sends itself once their key appears (the approval just given covers it).
            const mine = cachedMessageKeyPair();
            if (!draft && mine && myId && otherId) {
              await savePendingDraft({ myId, myPubkey: mine.pubkeyB64u, counterparty: otherId, threadId, text: body });
              setText('');
            }
            const copy = keyMissingCopyKeys(ownAgent !== null);
            Alert.alert(t(copy.title), `${t(copy.body, { name: otherName })}\n\n${t('commons.threadDraftKept')}`);
            return;
          }
          // signed by this phone's device key, inside the sealed plaintext.
          const sealed = sealThreadMessage(await signedThreadPlaintext(body), keys);
          attempted = true;
          if (!threadId) {
            // First message of a direct conversation: it opens the thread (free with an open relationship
            // such as a linked agent; otherwise the relay asks for a speech window).
            const opened = await CommonsService.openThread({ anchor: { kind: 'profile', id: otherId! }, counterparty: otherId!, message: { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 } }, biometricAction);
            setThread(opened.thread);
            setThreadId(opened.thread.thread_id);
            setMessages([opened.message]);
            setPlain((prev) => ({ ...prev, [opened.message.message_id]: body }));
            if (!draft) setText('');
            outcome = 'sent';
            return;
          }
          const r = await CommonsService.sendThreadMessage(threadId, { kind: 'text', ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 }, biometricAction);
          setMessages((prev) => [...prev, r.message]);
          setPlain((prev) => ({ ...prev, [r.message.message_id]: body }));
          if (!draft) setText('');
          outcome = 'sent';
        } catch (err) {
          outcome = sendFailureOutcome(err, attempted);
          if (!offerSpeechWindow(err, navigation, t)) Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.threadSendFailed')));
        } finally {
          setSending(false);
        }

      }, undefined);
    } catch (err) {
      if (err instanceof BiometricNotAvailableError || err instanceof BiometricAuthError) Alert.alert(t('commons.confirmationNeededTitle'), errorDisplayCopy(err.message));
    }
    return outcome;
};
  const send = () => { void sendText(text.trim()); };
  // "Send now" on a kept draft: claim it first (the automatic flush can then never send it too), then
  // remove it once sent or release it with how the send ended.
  const sendDraftNow = async (d: PendingThreadDraft) => {
    const claimed = await claimPendingDraft(d.id);
    if (!claimed) return;
    const outcome = await sendText(claimed.text, claimed);
    if (outcome === 'sent') await removePendingDraft(claimed.id);
    else await releasePendingDraft(claimed.id, outcome);
  };

  const submitRequest = async () => {
    const built = predicateFromDraft(predDraft);
    if (!built.ok) {
      Alert.alert(t('commonsForum.picker.invalidTitle'), t(`commonsForum.picker.error.${built.error}`));
      return;
    }
    setRequesting(true);
    try {
      if (!threadId) return;
      const r = await CommonsService.requestPresentationInThread(threadId, { tier: 'reputation', predicates: [built.predicate] });
      setMessages((prev) => [...prev, r.message]);
      setRequests((prev) => ({ ...prev, [r.request.request_id]: r.request }));
      setShowRequest(false);
    } catch (err) {
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commons.threadRequestFailed')));
    } finally {
      setRequesting(false);
    }
  };

  // + the binding (audience, challenge, predicates, signed envelope) comes from the
  // relay-held request record, never from the message attachment.
  const presentFor = (req: ThreadPresentationRequest) => {
    if (!req.audience || !req.challenge) return;
    navigation.navigate('HumanPresentment', {
      audience: req.audience, challenge: req.challenge, predicates: req.predicates ?? [],
      // the relay-signed challenge — the presenter screen verifies it before any burn and
      // passes it to /present so the presentation binds the verified requester (v2).
      ...(req.challenge_envelope !== undefined && req.challenge_envelope !== null ? { challengeEnvelope: req.challenge_envelope } : {}),
      deliverTo: { kind: 'thread', threadId: threadId ?? '', requestId: req.request_id },
    });
  };

  const renderAttachment = (m: ThreadMessage) => {
    const view = viewThreadAttachment(m, requests, myId);
    if (!view) return null;
    if (view.kind === 'presentation_request') {
      const req = view.request;
      return (
        <View style={styles.attach}>
          <Text style={styles.attachTitle}>{view.mine ? t('commons.threadYouAsked') : t('commons.threadTheyAsk')}</Text>
          {view.predicates.map((p, i) => <Text key={i} style={styles.attachLine}>{describePredicate(p, t)}</Text>)}
          {view.outcome !== null && <Text style={[styles.attachLine, { color: view.outcome === 'valid' ? COLORS.success : COLORS.error }]}>{view.outcome === 'valid' ? t('commons.threadVerdictValid') : t('commons.threadVerdictInvalid')}</Text>}
          {view.canPresent && req && (
            <TouchableOpacity style={styles.attachBtn} onPress={() => presentFor(req)}>
              <Ionicons name="ribbon-outline" size={14} color={COLORS.text} />
              <Text style={styles.attachBtnText}>{t('commons.threadPresent')}</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }
    if (view.kind === 'presentation') {
      const valid = view.outcome === 'valid';
      return (
        <View style={styles.attach}>
          <Text style={[styles.attachTitle, { color: valid ? COLORS.success : COLORS.error }]}>{valid ? t('commons.threadPresentationValid') : t('commons.threadPresentationInvalid')}</Text>
          {view.results.map((r, i) => <Text key={i} style={styles.attachLine}>{r.field} {r.op}: {r.result ? '✓' : '✗'}</Text>)}
        </View>
      );
    }
    if (view.kind === 'deliverable') {
      return (
        <View style={styles.attach}>
          <Text style={styles.attachTitle}>{t('commons.threadDeliverable')}</Text>
          {view.uri && <Text style={styles.attachLine} selectable>{view.uri}</Text>}
          {view.sha256 && <Text style={styles.attachHash} numberOfLines={1}>sha256 {view.sha256}</Text>}
        </View>
      );
    }
    return <Text style={styles.attachLine}>{t('commons.threadApplication')}</Text>;
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      <View style={styles.header}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel={t('common.back')} />
        <View style={{ flex: 1, marginLeft: SPACING.m }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{otherName || t('commons.threadsTitle')}</Text>
          {thread && <Text style={styles.headerSub} numberOfLines={1}>{t(`commons.anchor_${thread.anchor_kind}`)} · {shortAddress(thread.anchor_id)}</Text>}
        </View>
        {threadId ? (
          <TouchableOpacity onPress={() => setShowRequest(true)} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('commons.threadAskToProve')}>
            <Ionicons name="ribbon-outline" size={22} color={COLORS.primary} />
          </TouchableOpacity>
        ) : <View style={styles.backButton} />}
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.primary} />}
          onScroll={(event) => {
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            scrollToLatest.current = layoutMeasurement.height + contentOffset.y >= contentSize.height - 80;
            if (layoutReady.current) setAtLatest(layoutMeasurement.height + contentOffset.y >= contentSize.height - 1);
          }} scrollEventThrottle={100}
          onLayout={(event) => {
            viewportHeight.current = event.nativeEvent.layout.height;
            if (contentHeight.current <= viewportHeight.current) setAtLatest(true);
          }}
          onContentSizeChange={(_width, height) => {
            contentHeight.current = height;
            layoutReady.current = true;
            setAtLatest(height <= viewportHeight.current);
            if (scrollToLatest.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}>
          {loadError && <View accessibilityRole="alert">
            <Text style={styles.warn}>{t('commons.threadLoadFailed')}</Text>
            <TouchableOpacity onPress={refresh} accessibilityRole="button"><Text style={styles.bubbleRetry}>{t('common.tryAgain')}</Text></TouchableOpacity>
          </View>}
          {loading || resolving ? <ActivityIndicator color={COLORS.primary} /> : (
            <>
              <Text style={styles.lock}>{t('commons.threadLockNote')}</Text>
              {thread && <Text style={styles.lock}>{t(olderAvailable ? 'commons.threadRecentPage' : 'commons.threadAllHistory')}</Text>}
              {olderAvailable && <TouchableOpacity onPress={() => { void load(true); }} disabled={loadingOlder} accessibilityRole="button">
                {loadingOlder ? <ActivityIndicator color={COLORS.primary} /> : <Text style={styles.bubbleRetry}>{t('commons.threadLoadOlder')}</Text>}
              </TouchableOpacity>}
              {!threadId && <Text style={styles.lock}>{t('commons.threadNewDirect', { name: counterpartyName ?? (otherId ? shortAddress(otherId) : '') })}</Text>}
              {messages.map((m) => {
                const mine = m.author_id === myId;
                const body = viewThreadBody(m, plain[m.message_id], keyUnavailable);
                return (
                  <View key={m.message_id} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                    {body.kind === 'text' ? <Text style={styles.bubbleText}>{body.text}</Text>
                      : body.kind === 'other_key' ? <Text style={styles.bubbleMuted}>{t('commons.threadUndecryptable')}</Text>
                      : body.kind === 'cant_unlock' ? (
                        <TouchableOpacity onPress={() => { void load(); }} accessibilityRole="button" accessibilityLabel={t('commons.threadUnlockRetry')}>
                          <Text style={styles.bubbleMuted}>{t('commons.threadCantUnlock')}</Text>
                          <Text style={styles.bubbleRetry}>{t('commons.threadUnlockRetry')}</Text>
                        </TouchableOpacity>
                      ) : null}
                    {renderAttachment(m)}
                    <Text style={styles.bubbleMeta}>{new Date(m.created_at).toLocaleString()}{m.minted_under_window ? ` · ${t('commons.threadMinted')}` : ''}</Text>
                  </View>
                );
              })}
              {drafts.map((d) => (
                <View key={d.id} style={[styles.bubble, styles.bubbleMine, styles.bubblePending]}>
                  <Text style={styles.bubbleText}>{d.text}</Text>
                  <Text style={styles.bubbleMeta}>
                    {draftIsUncertain(d) ? t('commons.threadDraftUncertain') : d.failedAt ? t('commons.threadDraftNotSent') : ownAgent ? t('commons.threadDraftWaitingOwnAgent', { name: otherName }) : t('commons.threadDraftWaiting')}
                  </Text>
                  {d.failedAt || draftIsUncertain(d) ? (
                    <TouchableOpacity style={styles.attachBtn} onPress={() => { void sendDraftNow(d); }} disabled={sending} accessibilityRole="button">
                      <Ionicons name="send" size={14} color={COLORS.text} />
                      <Text style={styles.attachBtnText}>{t('commons.threadDraftSendNow')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ScrollView>
        {keyMissing && drafts.length === 0 && <Text style={styles.warn}>{t(keyMissingCopyKeys(ownAgent !== null).body, { name: otherName })}</Text>}
        <View style={styles.composer}>
          <TextInput style={styles.input} placeholder={t('commons.threadPlaceholder')} placeholderTextColor={COLORS.textTertiary} value={text} onChangeText={setText} multiline editable={!sending} />
          <TouchableOpacity style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]} onPress={send} disabled={!text.trim() || sending}>
            {sending ? <ActivityIndicator color={COLORS.text} size="small" /> : <Ionicons name="send" size={18} color={COLORS.text} />}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showRequest} animationType="slide" transparent>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={Keyboard.dismiss} accessibilityLabel={t('common.done')} />
          <ScrollView style={styles.modalContent} contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('commons.threadAskToProve')}</Text>
              <TouchableOpacity onPress={() => setShowRequest(false)}><Ionicons name="close" size={24} color={COLORS.text} /></TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>{t('commons.threadAskHint')}</Text>
            <PredicatePicker draft={predDraft} onChange={setPredDraft} lead={t('commonsForum.picker.leadThread', { name: counterpartyName ?? (otherId ? shortAddress(otherId) : '') })} />
            <TouchableOpacity style={[styles.submitButton, requesting && styles.sendBtnDisabled]} onPress={submitRequest} disabled={requesting}>
              {requesting ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.submitButtonText}>{t('commons.threadAskSend')}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.l, paddingVertical: SPACING.m },
  backButton: { padding: SPACING.xs },
  headerTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text },
  headerSub: { fontSize: 12, color: COLORS.textSecondary },
  scrollContent: { padding: SPACING.l, paddingBottom: SPACING.l, gap: SPACING.s },
  lock: { fontSize: 11, color: COLORS.textTertiary, textAlign: 'center', marginBottom: SPACING.s },
  bubble: { maxWidth: '86%', borderRadius: BORDER_RADIUS.m, padding: SPACING.m },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: COLORS.primaryMuted },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: COLORS.surface },
  bubblePending: { opacity: 0.7, borderStyle: 'dashed', borderWidth: 1, borderColor: COLORS.primary },
  bubbleText: { color: COLORS.text, fontSize: 15, lineHeight: 20 },
  bubbleMuted: { color: COLORS.textTertiary, fontSize: 13, fontStyle: 'italic' },
  bubbleRetry: { color: COLORS.primary, fontSize: 13, fontWeight: '600', marginTop: SPACING.xs },
  bubbleMeta: { color: COLORS.textTertiary, fontSize: 10, marginTop: 6 },
  attach: { marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, paddingTop: 6, gap: 4 },
  attachTitle: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  attachLine: { color: COLORS.textSecondary, fontSize: 12, fontFamily: 'monospace' },
  attachHash: { color: COLORS.textTertiary, fontSize: 10, fontFamily: 'monospace' },
  attachBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.s, paddingHorizontal: SPACING.m, paddingVertical: 6, marginTop: 4 },
  attachBtnText: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  warn: { color: COLORS.warning, fontSize: 12, paddingHorizontal: SPACING.l, paddingBottom: SPACING.xs },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.s, padding: SPACING.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  input: { flex: 1, minHeight: 40, maxHeight: 120, backgroundColor: COLORS.surface, borderRadius: BORDER_RADIUS.m, paddingHorizontal: SPACING.m, paddingVertical: 10, color: COLORS.text, fontSize: 15 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.5 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBackdrop: { flex: 1 },
  modalContent: { backgroundColor: COLORS.background, borderTopLeftRadius: BORDER_RADIUS.xl, borderTopRightRadius: BORDER_RADIUS.xl, maxHeight: '85%', flexGrow: 0 },
  modalScroll: { padding: SPACING.l, paddingBottom: SPACING.xxl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.s },
  modalTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  modalHint: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18, marginBottom: SPACING.m },
  submitButton: { marginTop: SPACING.l, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.m, padding: SPACING.m, alignItems: 'center' },
  submitButtonText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
});
