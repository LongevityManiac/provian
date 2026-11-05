/**
 * TalkingPassPill (§4) — the small header pill: "Talking until Sep 29" while a talking pass
 * is live, "Start talking" when there is none (tap → the one talking-pass sheet).
 *
 * No required props (the Commons shell drops it into its header). It renders nothing for a visitor
 * who has not joined the Commons, and nothing while the pass status is unknown (a pre- relay
 * has no status route — until a write teaches us otherwise, a "Start talking" pill could invite a
 * burn the person does not need).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import { peekTalkingPass, presentTalkingPass, readTalkingPass, subscribeTalkingPass, type TalkingPassState } from '../../core/commons/talkingPassBus';
import { armPendingSpeech, cancelPendingSpeech } from '../../core/commons/pendingSpeech';
import { isRouteMissing } from '../../core/commons/forumFeedSource';
import { openTalkingPass, SPEECH_WINDOW_BURN_PVT } from '../../core/commons/speechGate';
import { InfoModal } from '../InfoModal';
import { COMMONS_AUDIENCE } from './TalkingPassSheet';

/** The status read: null when the relay has no such route (keeps what a 428 taught us). */
export async function fetchTalkingPassStatus(): Promise<{ live: boolean; expires_at: number | null } | null> {
  try {
    const r = await CommonsService.getSpeechWindowStatus();
    return { live: r.live === true, expires_at: typeof r.expires_at === 'number' ? r.expires_at : null };
  } catch (err) {
    if (isRouteMissing(err)) return null;
    throw err;
  }
}

export default function TalkingPassPill() {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation();
  const joined = useCommonsStore((s) => s.profile !== null);
  const [pass, setPass] = useState<TalkingPassState>(peekTalkingPass());
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => subscribeTalkingPass(setPass), []);
  useFocusEffect(
    useCallback(() => {
      if (!joined) return;
      // A cached 'none' is re-read on every focus: the person may have just opened a pass elsewhere.
      void readTalkingPass(fetchTalkingPassStatus, { force: peekTalkingPass().state !== 'live' }).then(setPass);
    }, [joined]),
  );

  if (!joined || pass.state === 'unknown') return null;

  if (pass.state === 'live') {
    const label = pass.expiresAt
      ? t('commonsForum.pill.liveUntil', {
          date: new Date(pass.expiresAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }),
        })
      : t('commonsForum.pill.live');
    return (
      <>
        <TouchableOpacity
          style={[styles.pill, styles.pillLive]}
          onPress={() => setShowInfo(true)}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Ionicons name="chatbubbles" size={13} color={COLORS.success} />
          <Text style={[styles.text, { color: COLORS.success }]} numberOfLines={1}>{label}</Text>
        </TouchableOpacity>
        <InfoModal
          visible={showInfo}
          onClose={() => setShowInfo(false)}
          title={t('commonsForum.pass.howTitle')}
          body={t('commonsForum.pass.howBody', { pvt: SPEECH_WINDOW_BURN_PVT })}
        />
      </>
    );
  }

  const start = () => {
    const nav = navigation as unknown as { navigate: (screen: string, params?: Record<string, unknown>) => void };
    const go = () => {
      armPendingSpeech();
      openTalkingPass(nav, COMMONS_AUDIENCE);
    };
    if (!presentTalkingPass({ audience: COMMONS_AUDIENCE, onStart: go, onCancel: cancelPendingSpeech })) go();
  };
  return (
    <TouchableOpacity
      style={styles.pill}
      onPress={start}
      accessibilityRole="button"
      accessibilityLabel={t('commonsForum.pill.start')}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
    >
      <Ionicons name="chatbubble-ellipses-outline" size={13} color={COLORS.primaryLight} />
      <Text style={styles.text} numberOfLines={1}>{t('commonsForum.pill.start')}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.s + 2,
    minHeight: 30,
    borderRadius: BORDER_RADIUS.round,
    backgroundColor: COLORS.primaryMuted,
    borderWidth: 1,
    borderColor: COLORS.borderFocus,
    maxWidth: 190,
  },
  pillLive: { backgroundColor: COLORS.successMuted, borderColor: 'transparent' },
  text: { ...TYPE_SCALE.bodySm, fontWeight: '600', color: COLORS.primaryLight },
});
