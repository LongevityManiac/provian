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
import { Text, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, TYPE_SCALE } from '../../constants/theme';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import { peekTalkingPass, readTalkingPass, subscribeTalkingPass, type TalkingPassState } from '../../core/commons/talkingPassBus';
import { isRouteMissing } from '../../core/commons/forumFeedSource';

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
  const joined = useCommonsStore(state => state.isJoined);
  const [status, setStatus] = useState<TalkingPassState>(peekTalkingPass());
  useEffect(() => subscribeTalkingPass(setStatus), []);
  useFocusEffect(useCallback(() => {
    if (joined) void readTalkingPass(fetchTalkingPassStatus, { force: true }).then(setStatus).catch(() => {});
  }, [joined]));

  if (!joined || status.state !== 'live') return null;
  return <Text style={styles.label}>{status.expiresAt
    ? t('commonsForum.pill.liveUntil', { date: new Date(status.expiresAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }) })
    : t('commonsForum.pill.live')}</Text>;
}
const styles = StyleSheet.create({
  label: { padding: SPACING.s, fontSize: TYPE_SCALE.bodySm.fontSize, borderRadius: BORDER_RADIUS.m, color: COLORS.success },
});
