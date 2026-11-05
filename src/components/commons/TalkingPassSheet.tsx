/**
 * TalkingPassSheet (§4) — the ONE plain sheet that explains the talking pass (the
 * speech window) and starts it.
 *
 * - `TalkingPassSheet` is the presentational bottom sheet (the app's transparent-Modal pattern).
 * - `TalkingPassHost` is mounted once at the navigator root and registers itself on the
 * talking-pass bus, so any screen can open the sheet without stacking its own Modals.
 * - `useTalkingPass` is the screen hook: `requirePass(err, action)` saves the refused write and
 * opens the sheet; on focus it resumes the saved write once (see core/commons/pendingSpeech).
 *
 * "Start talking" closes the sheet FIRST and only then navigates to HumanPresentment, so the sheet
 * can never sit on top of the burn screen.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../constants/theme';
import { InfoModal } from '../InfoModal';
import { openTalkingPass, SPEECH_WINDOW_BURN_PVT } from '../../core/commons/speechGate';
import { presentTalkingPass, registerTalkingPassPresenter, type TalkingPassRequest } from '../../core/commons/talkingPassBus';
import {
  armPendingSpeech,
  cancelPendingSpeech,
  capturePendingSpeech,
  resumePendingSpeech,
  savePendingSpeech,
  type PendingPayload,
  type PendingSpeech,
  type PendingSpeechKind,
} from '../../core/commons/pendingSpeech';

export const COMMONS_AUDIENCE = 'provian:commons';

interface SheetProps {
  visible: boolean;
  audience: string;
  onStart: () => void;
  onClose: () => void;
  /** iOS: fires once the Modal has fully gone (the moment it is safe to navigate). */
  onDismiss?: () => void;
}

export function TalkingPassSheet({ visible, audience, onStart, onClose, onDismiss }: SheetProps) {
  const { t } = useTranslation();
  const [showHow, setShowHow] = useState(false);
  const pvt = SPEECH_WINDOW_BURN_PVT;
  const isCommons = audience === COMMONS_AUDIENCE;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} onDismiss={onDismiss}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.iconWrap}>
            <Ionicons name="chatbubbles" size={24} color={COLORS.primary} />
          </View>
          <Text style={styles.title}>{isCommons ? t('commonsForum.pass.title') : t('commonsForum.pass.titleTo')}</Text>
          <Text style={styles.body}>{isCommons ? t('commonsForum.pass.body', { pvt }) : t('commonsForum.pass.bodyTo', { pvt })}</Text>
          <TouchableOpacity onPress={() => setShowHow(true)} accessibilityRole="button" style={styles.howLink} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="information-circle-outline" size={16} color={COLORS.primaryLight} />
            <Text style={styles.howText}>{t('commonsForum.pass.howLink')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={onStart} accessibilityRole="button">
            <Text style={styles.primaryText}>{t('commonsForum.pass.start', { pvt })}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.secondaryText}>{t('commonsForum.pass.notNow')}</Text>
          </TouchableOpacity>
        </View>
        <InfoModal visible={showHow} onClose={() => setShowHow(false)} title={t('commonsForum.pass.howTitle')} body={t('commonsForum.pass.howBody', { pvt })} />
      </View>
    </Modal>
  );
}

/**
 * The single sheet host. Mount once, at the navigator root. A request arriving while a sheet is
 * already open replaces it (the newest refusal wins).
 */
export function TalkingPassHost() {
  const [req, setReq] = useState<TalkingPassRequest | null>(null);
  const [visible, setVisible] = useState(false);
  const startRef = useRef<(() => void) | null>(null);

  useEffect(() => registerTalkingPassPresenter((r) => {
    startRef.current = null;
    setReq(r);
    setVisible(true);
  }), []);

  const runStart = useCallback(() => {
    const fn = startRef.current;
    startRef.current = null;
    fn?.();
  }, []);

  const onStart = useCallback(() => {
    if (!req) return;
    startRef.current = req.onStart;
    setVisible(false);
    // iOS navigates from onDismiss (once the Modal is really gone); Android hides synchronously.
    // The timer is a backstop in case onDismiss never fires; runStart is idempotent.
    setTimeout(runStart, Platform.OS === 'ios' ? 450 : 0);
  }, [req, runStart]);

  const onClose = useCallback(() => {
    startRef.current = null;
    setVisible(false);
    req?.onCancel?.();
  }, [req]);

  if (!req) return null;
  return <TalkingPassSheet visible={visible} audience={req.audience} onStart={onStart} onClose={onClose} onDismiss={runStart} />;
}

type Navigator = { navigate: (screen: string, params?: Record<string, unknown>) => void };

export interface TalkingPassAction {
  kind: PendingSpeechKind;
  payload: PendingPayload;
  draftKey?: string;
  draft?: string;
}

/**
 * The screen hook. `owner` identifies the screen that resumes a saved write (e.g. `feed`,
 * `post:<id>`, `compose:<channel>`). `execute` performs a saved write; it is read through a ref so
 * the latest screen state is used when it resumes.
 */
export function useTalkingPass(opts: {
  owner: string;
  navigation: Navigator;
  execute: (p: PendingSpeech) => Promise<void>;
  onResumeFailed?: (err: unknown, p: PendingSpeech) => void;
  onResumed?: (p: PendingSpeech) => void;
}) {
  const { t } = useTranslation();
  const { owner, navigation } = opts;
  const executeRef = useRef(opts.execute);
  executeRef.current = opts.execute;
  const failedRef = useRef(opts.onResumeFailed);
  failedRef.current = opts.onResumeFailed;
  const resumedRef = useRef(opts.onResumed);
  resumedRef.current = opts.onResumed;

  useFocusEffect(
    useCallback(() => {
      void resumePendingSpeech(owner, (p) => executeRef.current(p)).then((out) => {
        if (out.status === 'failed') failedRef.current?.(out.error, out.pending);
        if (out.status === 'done') resumedRef.current?.(out.pending);
      });
    }, [owner]),
  );

  /** Open the sheet (from a refusal, or the pill). "Start talking" arms any saved write. */
  const openSheet = useCallback((audience: string = COMMONS_AUDIENCE) => {
    const start = () => {
      armPendingSpeech();
      openTalkingPass(navigation, audience);
    };
    const shown = presentTalkingPass({ audience, onStart: start, onCancel: cancelPendingSpeech });
    if (shown) return;
    // No host mounted (should not happen in the app): a plain Alert with the same choice.
    const pvt = SPEECH_WINDOW_BURN_PVT;
    Alert.alert(t('commonsForum.pass.title'), t('commonsForum.pass.body', { pvt }), [
      { text: t('commonsForum.pass.notNow'), style: 'cancel', onPress: cancelPendingSpeech },
      { text: t('commonsForum.pass.start', { pvt }), onPress: start },
    ]);
  }, [navigation, t]);

  /** If `err` is the talking-pass refusal: save `action`, open the sheet, return true. */
  const requirePass = useCallback((err: unknown, action: TalkingPassAction): boolean => {
    const audience = capturePendingSpeech(err, { ...action, owner });
    if (!audience) return false;
    openSheet(audience);
    return true;
  }, [owner, openSheet]);

  /** The pass is known to be missing: save `action` without trying it, and open the sheet. */
  const passFirst = useCallback((action: TalkingPassAction, audience: string = COMMONS_AUDIENCE) => {
    savePendingSpeech({ ...action, owner }, audience);
    openSheet(audience);
  }, [owner, openSheet]);

  return { requirePass, openSheet, passFirst };
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: {
    backgroundColor: COLORS.surfaceElevated,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.l,
    paddingTop: SPACING.s,
    paddingBottom: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
    borderBottomWidth: 0,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.border, marginBottom: SPACING.m },
  iconWrap: { width: 48, height: 48, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.m },
  title: { ...TYPE_SCALE.headingMd, color: COLORS.text, marginBottom: SPACING.s },
  body: { ...TYPE_SCALE.bodyLg, color: COLORS.chromeMuted },
  howLink: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.m, alignSelf: 'flex-start', minHeight: 32 },
  howText: { ...TYPE_SCALE.bodyMd, color: COLORS.primaryLight, fontWeight: '600' },
  primaryBtn: { marginTop: SPACING.l, backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.l, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  primaryText: { ...TYPE_SCALE.headingSm, color: COLORS.text },
  secondaryBtn: { marginTop: SPACING.s, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { ...TYPE_SCALE.bodyLg, color: COLORS.textSecondary },
});
