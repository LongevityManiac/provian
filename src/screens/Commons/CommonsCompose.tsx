import { errorDisplayCopy } from '../../i18n/displayCopy';
/**
 * CommonsCompose (§4) — the full-screen composer. A pushed screen, not a Modal, so the
 * talking-pass screen can never end up underneath it.
 *
 * - New post: pick a topic (announcements is not offered — operators post those from their own
 * flow), a title (required), and the body.
 * - Reply (`parentPostId`): body only; the relay files it in the parent's topic.
 * - The draft is saved as you type (AsyncStorage: the text is about to be public, not a secret) and
 * restored when you come back.
 * - Without a talking pass the post is saved, the one talking-pass sheet opens, and the post goes
 * through by itself when you return.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GLASS, TYPE_SCALE } from '../../constants/theme';
import type { AppParamList } from '../../navigation/types';
import useCommonsStore from '../../store/commonsStore';
import * as CommonsService from '../../core/commons/CommonsService';
import { POSTABLE_TOPICS, topicIcon, topicLabelKey } from '../../core/commons/forumModel';
import { clearDraft, loadDraft, saveDraft, type PendingSpeech } from '../../core/commons/pendingSpeech';
import { useTalkingPass } from '../../components/commons/TalkingPassSheet';
import TalkingPassPill from '../../components/commons/TalkingPassPill';
import { invalidateForumFeed } from '../../components/commons/forum/ForumFeed';

type Props = NativeStackScreenProps<AppParamList, 'CommonsCompose'>;

export const TITLE_MAX = 200;
export const BODY_MAX = 10_000;

interface Draft {
  title: string;
  body: string;
}

function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Draft>;
    return { title: typeof d.title === 'string' ? d.title : '', body: typeof d.body === 'string' ? d.body : '' };
  } catch {
    return { title: '', body: raw };
  }
}

export default function CommonsCompose({ navigation, route }: Props) {
  const { t } = useTranslation();
  const joined = useCommonsStore((s) => s.profile !== null);
  const parentPostId = route.params?.parentPostId ?? null;
  const isReply = parentPostId !== null;
  const initialChannel = route.params?.channel && POSTABLE_TOPICS.includes(route.params.channel) ? route.params.channel : 'general';

  const [channel, setChannel] = useState(initialChannel);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [restored, setRestored] = useState(false);
  const draftKey = isReply ? `reply:${parentPostId}` : `compose:${channel}`;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nav = navigation as unknown as { navigate: (screen: string, params?: Record<string, unknown>) => void };

  // Restore the draft once.
  useEffect(() => {
    let cancelled = false;
    void loadDraft(isReply ? `reply:${parentPostId}` : `compose:${initialChannel}`).then((raw) => {
      if (cancelled) return;
      const d = parseDraft(raw);
      if (d) {
        setTitle(d.title);
        setBody(d.body);
      }
      setRestored(true);
    });
    return () => { cancelled = true; };
  }, [isReply, parentPostId, initialChannel]);

  // Save as you type (debounced).
  useEffect(() => {
    if (!restored) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveDraft(draftKey, title.trim() || body.trim() ? JSON.stringify({ title, body }) : '');
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [title, body, draftKey, restored]);

  const switchTopic = (next: string) => {
    if (next === channel) return;
    void clearDraft(`compose:${channel}`);
    setChannel(next);
  };

  const finish = useCallback(async (created: CommonsService.ForumPost, key: string) => {
    await clearDraft(key);
    invalidateForumFeed();
    const rootId = created.root_post_id ?? (isReply ? null : created.post_id);
    if (isReply && parentPostId) {
      navigation.replace('CommonsForumPost', { postId: rootId ?? parentPostId, focusCommentId: created.post_id });
    } else {
      navigation.replace('CommonsForumPost', { postId: created.post_id, channel: created.channel });
    }
  }, [isReply, parentPostId, navigation]);

  const send = useCallback(async (payload: { channel: string; title: string; content: string }): Promise<CommonsService.ForumPost> => {
    if (isReply && parentPostId) return CommonsService.replyToPost(parentPostId, { content: payload.content });
    return CommonsService.createForumPost({ channel: payload.channel, title: payload.title, content: payload.content });
  }, [isReply, parentPostId]);

  const execute = useCallback(async (p: PendingSpeech) => {
    if (p.kind !== 'post' && p.kind !== 'reply') return;
    const payload = {
      channel: typeof p.payload.channel === 'string' ? p.payload.channel : channel,
      title: typeof p.payload.title === 'string' ? p.payload.title : '',
      content: typeof p.payload.content === 'string' ? p.payload.content : '',
    };
    setSubmitting(true);
    try {
      const created = await send(payload);
      await finish(created, p.draftKey ?? draftKey);
    } finally {
      setSubmitting(false);
    }
  }, [channel, draftKey, finish, send]);

  const { requirePass } = useTalkingPass({
    owner: isReply ? `compose-reply:${parentPostId}` : 'compose',
    navigation: nav,
    execute,
    onResumeFailed: (err) => Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error && err.message ? err.message : t('commonsForum.error.post'))),
  });

  const titleOk = isReply || title.trim().length > 0;
  const canPost = joined && titleOk && body.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!joined) {
      Alert.alert(t('commonsForum.join.title'), t('commonsForum.join.toPost'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('commonsForum.join.cta'), onPress: () => navigation.navigate('CommonsOnboarding') },
      ]);
      return;
    }
    if (!canPost) return;
    const payload = { channel, title: title.trim(), content: body.trim() };
    setSubmitting(true);
    try {
      const created = await send(payload);
      await finish(created, draftKey);
    } catch (err) {
      const draft = JSON.stringify({ title, body });
      if (requirePass(err, { kind: isReply ? 'reply' : 'post', payload, draftKey, draft })) return;
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(err instanceof Error && err.message ? err.message : t('commonsForum.error.post')));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => navigation.goBack();

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={close} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Ionicons name="close" size={26} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{isReply ? t('commonsForum.compose.replyTitle') : t('commonsForum.compose.title')}</Text>
        <TalkingPassPill />
        <TouchableOpacity
          style={[styles.postBtn, !canPost && styles.postBtnDisabled]}
          onPress={submit}
          disabled={!canPost}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canPost }}
        >
          {submitting ? <ActivityIndicator color={COLORS.text} size="small" /> : <Text style={styles.postText}>{t('commons.post')}</Text>}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          {!isReply && (
            <>
              <Text style={styles.label}>{t('commonsForum.compose.topic')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topics}>
                {POSTABLE_TOPICS.map((c) => {
                  const active = c === channel;
                  return (
                    <TouchableOpacity
                      key={c}
                      style={[styles.topic, active && styles.topicActive]}
                      onPress={() => switchTopic(c)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                    >
                      <Ionicons name={topicIcon(c)} size={14} color={active ? COLORS.text : COLORS.textSecondary} />
                      <Text style={[styles.topicText, active && styles.topicTextActive]}>{t(topicLabelKey(c))}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TextInput
                style={styles.titleInput}
                placeholder={t('commonsForum.compose.titlePlaceholder')}
                placeholderTextColor={COLORS.textTertiary}
                value={title}
                onChangeText={setTitle}
                maxLength={TITLE_MAX}
                returnKeyType="next"
                accessibilityLabel={t('commonsForum.compose.titlePlaceholder')}
              />
              {title.length > TITLE_MAX - 30 && <Text style={styles.counter}>{title.length}/{TITLE_MAX}</Text>}
            </>
          )}
          <TextInput
            style={styles.bodyInput}
            placeholder={isReply ? t('commonsForum.compose.replyPlaceholder') : t('commonsForum.compose.bodyPlaceholder')}
            placeholderTextColor={COLORS.textTertiary}
            value={body}
            onChangeText={setBody}
            maxLength={BODY_MAX}
            multiline
            textAlignVertical="top"
            autoFocus={isReply}
            accessibilityLabel={isReply ? t('commonsForum.compose.replyPlaceholder') : t('commonsForum.compose.bodyPlaceholder')}
          />
          {body.length > BODY_MAX - 500 && <Text style={styles.counter}>{body.length}/{BODY_MAX}</Text>}
          <Text style={styles.footnote}>{t('commonsForum.compose.footnote')}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.s, paddingHorizontal: SPACING.s, paddingVertical: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...TYPE_SCALE.headingSm, color: COLORS.text, flex: 1 },
  postBtn: { backgroundColor: COLORS.primary, borderRadius: BORDER_RADIUS.round, paddingHorizontal: SPACING.m, minHeight: 36, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  postBtnDisabled: { opacity: 0.45 },
  postText: { ...TYPE_SCALE.bodyMd, color: COLORS.text, fontWeight: '600' },
  scroll: { padding: SPACING.m, paddingBottom: SPACING.xxl },
  label: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginBottom: SPACING.xs },
  topics: { gap: SPACING.s, paddingBottom: SPACING.m },
  topic: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: SPACING.m, minHeight: 36, borderRadius: BORDER_RADIUS.round, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  topicActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  topicText: { ...TYPE_SCALE.bodyMd, color: COLORS.textSecondary, fontWeight: '600' },
  topicTextActive: { color: COLORS.text },
  titleInput: { ...GLASS.input, ...TYPE_SCALE.headingSm, color: COLORS.text, padding: SPACING.m, borderRadius: BORDER_RADIUS.m },
  bodyInput: { ...GLASS.input, ...TYPE_SCALE.bodyLg, color: COLORS.text, padding: SPACING.m, minHeight: 220, marginTop: SPACING.s, borderRadius: BORDER_RADIUS.m },
  counter: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, alignSelf: 'flex-end', marginTop: 4 },
  footnote: { ...TYPE_SCALE.bodySm, color: COLORS.textTertiary, marginTop: SPACING.m },
});
