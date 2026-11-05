import { errorDisplayCopy } from '../../../i18n/displayCopy';
/**
 * useForumWrites — the forum's small writes, shared by the feed and the post page:
 * one-tap votes (haptic, optimistic, "already voted" shown as the voted state), Report, and the
 * talking-pass flow around both. A refused write (428) is saved and resumes by itself when the
 * screen regains focus after the pass is opened.
 *
 * Screens with more writes (the reply on the post page, the composer) pass `executeMore` for their
 * own pending kinds.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import * as CommonsService from '../../../core/commons/CommonsService';
import { applyVote, isAlreadyVotedError, revertVote, type NormalizedForumPost } from '../../../core/commons/forumModel';
import type { PendingSpeech } from '../../../core/commons/pendingSpeech';
import { readTalkingPass } from '../../../core/commons/talkingPassBus';
import { useTalkingPass, COMMONS_AUDIENCE } from '../TalkingPassSheet';
import { fetchTalkingPassStatus } from '../TalkingPassPill';
import type { ChallengeDraft } from './ChallengeSheet';
import { authorName } from './AuthorLine';
import { useAfterClose } from './useAfterClose';
import { confirmBlock, openReportToProvian } from '../safetyActions';

type Navigator = { navigate: (screen: string, params?: Record<string, unknown>) => void };

export type PostUpdater = (postId: string, fn: (p: NormalizedForumPost) => NormalizedForumPost) => void;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useForumWrites(opts: {
  owner: string;
  navigation: Navigator;
  joined: boolean;
  updatePost: PostUpdater;
  /** Resume a saved write this hook does not own; return true when handled. */
  executeMore?: (p: PendingSpeech) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { navigation, joined, updatePost, executeMore } = opts;
  // The challenge sheet target (and a draft to restore after the talking pass).
  const [challengeTarget, setChallengeTarget] = useState<{ postId: string; authorName: string } | null>(null);
  const [challengeInitial, setChallengeInitial] = useState<ChallengeDraft | null>(null);
  const { afterClose, onDismiss: onChallengeDismiss } = useAfterClose();

  const askToJoin = useCallback((why: string) => {
    Alert.alert(t('commonsForum.join.title'), why, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('commonsForum.join.cta'), onPress: () => navigation.navigate('CommonsOnboarding') },
    ]);
  }, [navigation, t]);

  const sendVote = useCallback(async (postId: string, vote: 'upvote' | 'downvote') => {
    try {
      await CommonsService.voteOnPost(postId, vote);
    } catch (err) {
      if (isAlreadyVotedError(err)) {
        // Already counted: show the voted state without counting it twice.
        updatePost(postId, (p) => (p.my_vote ? p : { ...p, my_vote: vote }));
        return;
      }
      throw err;
    }
  }, [updatePost]);

  const execute = useCallback(async (p: PendingSpeech) => {
    const postId = typeof p.payload.postId === 'string' ? p.payload.postId : '';
    if (p.kind === 'vote' && postId) {
      const vote = p.payload.vote === 'downvote' ? 'downvote' : 'upvote';
      updatePost(postId, (x) => applyVote(x, vote));
      try {
        await sendVote(postId, vote);
      } catch (err) {
        updatePost(postId, (x) => revertVote(x, vote));
        throw err;
      }
      return;
    }
    if (p.kind === 'flag' && postId) {
      try {
        await CommonsService.flagForumPost(postId);
      } catch (err) {
        if (!(err instanceof Error && /already flagged/i.test(err.message))) throw err;
      }
      updatePost(postId, (x) => ({ ...x, is_flagged: true }));
      return;
    }
    if (p.kind === 'challenge' && postId) {
      // Reopen the sheet, prefilled — never auto-file: filing burns a stake, so the person taps it.
      // If they came back without opening the pass, drop it silently (a fresh 428).
      const pass = await readTalkingPass(fetchTalkingPassStatus, { force: true });
      if (pass.state === 'none') throw new CommonsService.CommonsError('talking pass required', 428, 'rail_handshake_required', COMMONS_AUDIENCE);
      let restored: ChallengeDraft | null = null;
      if (typeof p.payload.draft === 'string' && p.payload.draft) {
        try { restored = JSON.parse(p.payload.draft) as ChallengeDraft; } catch { restored = null; }
      }
      setChallengeInitial(restored);
      setChallengeTarget({ postId, authorName: typeof p.payload.authorName === 'string' ? p.payload.authorName : '' });
      return;
    }
    if (executeMore && (await executeMore(p))) return;
  }, [executeMore, sendVote, updatePost]);

  const talkingPass = useTalkingPass({
    owner: opts.owner,
    navigation,
    execute,
    onResumeFailed: (err) => Alert.alert(t('common.errorTitle'), errorDisplayCopy(errorText(err, t('commonsForum.error.generic')))),
  });
  const { requirePass, passFirst } = talkingPass;

  /** One tap: haptic, optimistic count, no confirmation. Votes are one-shot. */
  const vote = useCallback(async (post: NormalizedForumPost, dir: 'upvote' | 'downvote') => {
    if (!joined) {
      askToJoin(t('commonsForum.join.toVote'));
      return;
    }
    if (post.my_vote) return;
    void Haptics.selectionAsync().catch(() => undefined);
    updatePost(post.post_id, (p) => applyVote(p, dir));
    try {
      await sendVote(post.post_id, dir);
    } catch (err) {
      updatePost(post.post_id, (p) => revertVote(p, dir));
      if (requirePass(err, { kind: 'vote', payload: { postId: post.post_id, vote: dir } })) return;
      Alert.alert(t('common.errorTitle'), errorDisplayCopy(errorText(err, t('commonsForum.error.vote'))));
    }
  }, [joined, askToJoin, updatePost, sendVote, requirePass, t]);

  /** Report: one confirmation (the post is hidden behind a notice for everyone). */
  const report = useCallback((post: NormalizedForumPost) => {
    if (!joined) {
      askToJoin(t('commonsForum.join.toReport'));
      return;
    }
    Alert.alert(t('commonsForum.report.title'), t('commonsForum.report.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('commonsForum.report.confirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await CommonsService.flagForumPost(post.post_id);
            updatePost(post.post_id, (p) => ({ ...p, is_flagged: true }));
            Alert.alert(t('commonsForum.report.doneTitle'), t('commonsForum.report.doneBody'));
          } catch (err) {
            if (err instanceof Error && /already flagged/i.test(err.message)) {
              updatePost(post.post_id, (p) => ({ ...p, is_flagged: true }));
              return;
            }
            if (requirePass(err, { kind: 'flag', payload: { postId: post.post_id } })) return;
            Alert.alert(t('common.errorTitle'), errorDisplayCopy(errorText(err, t('commonsForum.error.generic'))));
          }
        },
      },
    ]);
  }, [joined, askToJoin, updatePost, requirePass, t]);

  /** Report to Provian: a private email with the post's link. Free, not a Commons write, no join needed. */
  const reportToProvian = useCallback((post: NormalizedForumPost) => {
    void openReportToProvian(t, { kind: 'post', postId: post.post_id, authorWalletId: post.author_wallet_id, authorName: post.author_display_name ?? null });
  }, [t]);

  /** Block: hide this author's posts, replies and profile on this phone. Free, private. */
  const blockAuthor = useCallback((post: NormalizedForumPost) => {
    confirmBlock(t, post.author_wallet_id, post.author_display_name ?? null);
  }, [t]);

  const messageAuthor = useCallback((post: NormalizedForumPost) => {
    if (!joined) {
      askToJoin(t('commonsForum.join.toMessage'));
      return;
    }
    navigation.navigate('CommonsThread', { counterparty: post.author_wallet_id, counterpartyName: post.author_display_name ?? undefined });
  }, [joined, askToJoin, navigation, t]);

  /** "Question this post": check the pass first so no stake is burned before the pass exists. */
  const question = useCallback(async (post: NormalizedForumPost) => {
    if (!joined) {
      askToJoin(t('commonsForum.join.toQuestion'));
      return;
    }
    const name = authorName(post);
    // Always a FRESH read before a stake decision: a cached 'none' from before the person opened a
    // pass would send them to open (and burn for) a second one .
    const pass = await readTalkingPass(fetchTalkingPassStatus, { force: true });
    if (pass.state === 'none') {
      passFirst({ kind: 'challenge', payload: { postId: post.post_id, authorName: name, draft: '' } });
      return;
    }
    setChallengeInitial(null);
    setChallengeTarget({ postId: post.post_id, authorName: name });
  }, [joined, askToJoin, passFirst, t]);

  const challenge = useMemo(() => ({
    postId: challengeTarget?.postId ?? null,
    authorName: challengeTarget?.authorName ?? '',
    initial: challengeInitial,
    onClose: () => setChallengeTarget(null),
    onDismiss: onChallengeDismiss,
    onFiled: (id: string) => {
      setChallengeTarget(null);
      updatePost(id, (p) => ({ ...p, challenge_count: p.challenge_count + 1 }));
    },
    onNeedsPass: (err: unknown, id: string, draft: ChallengeDraft) => {
      const name = challengeTarget?.authorName ?? '';
      setChallengeTarget(null);
      afterClose(() => {
        requirePass(err, { kind: 'challenge', payload: { postId: id, authorName: name, draft: JSON.stringify(draft) } });
      });
    },
  }), [challengeTarget, challengeInitial, onChallengeDismiss, updatePost, afterClose, requirePass]);

  const viewProfile = useCallback((post: NormalizedForumPost) => {
    navigation.navigate('CommonsProfile', { walletId: post.author_wallet_id });
  }, [navigation]);

  return { vote, report, reportToProvian, blockAuthor, question, challenge, messageAuthor, viewProfile, askToJoin, talkingPass };
}
