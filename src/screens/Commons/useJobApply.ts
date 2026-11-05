import { errorDisplayCopy } from '../../i18n/displayCopy';
import { withBiometricAction, type BiometricAction } from '../../core/security/biometricAction';
/**
 * useJobApply — applying to a Commons job from the app, shared by the board, the Market and
 * the job screen so the three can never drift.
 *
 * Only jobs that hire PEOPLE take a person's application (the relay refuses the other kind with a
 * 400; the cards hide Apply and say why). The application is biometric-gated (it seals a PE) and
 * opens the job's thread with the poster: the note travels as end-to-end ciphertext sealed to both
 * parties' message keys (the relay keeps only its hash). Without a talking pass or an open
 * relationship the relay answers 428, and the talking-pass sheet opens.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert, Platform } from 'react-native';
import type { TFunction } from 'i18next';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError } from '../../core/security/requireBiometric';
import * as CommonsService from '../../core/commons/CommonsService';
import type { HumanJob } from '../../core/commons/CommonsService';
import { getMessageKeyPair, sealThreadMessage } from '../../core/commons/threadCrypto';
import { signedThreadPlaintext } from '../../core/commons/commonsOutputSigning';
import { offerSpeechWindow } from '../../core/commons/speechGate';
import { formatHumanJobCompensation } from '../../core/commons/humanJobFormat';

type Navigator = { navigate: (screen: string, params?: Record<string, unknown>) => void };

export function useJobApply(params: {
  myWalletId: string | null | undefined;
  navigation: Navigator;
  t: TFunction;
  onApplied?: () => void;
}) {
  const { myWalletId, navigation, t, onApplied } = params;
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  // the jobs this wallet already applied to — the relay refuses a second application, so
  // the screens show "You applied" instead of an Apply that can only fail. Read on focus; a
  // successful apply adds its job at once (before the relay read catches up).
  const [appliedJobIds, setAppliedJobIds] = useState<ReadonlySet<string>>(() => new Set());
  useFocusEffect(useCallback(() => {
    let live = true;
    if (myWalletId) {
      CommonsService.getMyAppliedJobIds()
        .then((ids) => { if (live) setAppliedJobIds((prev) => new Set([...prev, ...ids])); })
        .catch(() => undefined); // Apply stays offered; the relay still refuses a duplicate
    }
    return () => { live = false; };
  }, [myWalletId]));

  // Seal the note for both parties. Null when either key is unavailable → hash-only cover note.
  const sealNote = useCallback(async (posterWalletId: string, note: string, biometricAction?: BiometricAction) => {
    if (!note || !myWalletId) return null;
    try {
      const kp = await getMessageKeyPair(t('commonsHumanJobs.biometricPromptApply'), biometricAction);
      const mine = await CommonsService.readMessageKey(myWalletId, biometricAction);
      if (!mine || mine.pubkey_b64u !== kp.pubkeyB64u) await CommonsService.publishMessageKey(kp.pubkeyB64u, biometricAction);
      const theirs = await CommonsService.readMessageKey(posterWalletId, biometricAction);
      if (!theirs) return null;
      const sealed = sealThreadMessage(await signedThreadPlaintext(note), { [myWalletId]: kp.pubkeyB64u, [posterWalletId]: theirs.pubkey_b64u });
      return { ciphertexts: sealed.ciphertexts, content_sha256: sealed.content_sha256 };
    } catch (err) {
      console.log('[useJobApply] note sealing unavailable:', err instanceof Error ? err.message : err);
      return null;
    }
  }, [myWalletId]);

  const confirmApply = useCallback(async (job: HumanJob, note: string) => {
    try {
      return await withBiometricAction(t('commonsHumanJobs.biometricPromptApply'), async (biometricAction) => {
        setApplyingJobId(job.job_id);
        try {
          const message = await sealNote(job.poster_wallet_id, note, biometricAction);
          await CommonsService.applyForHumanJob(job.job_id, message ? { message } : (note ? { cover_note: note } : {}), biometricAction);
          setAppliedJobIds((prev) => new Set([...prev, job.job_id]));
          Alert.alert(t('commonsHumanJobs.appliedTitle'), t('commonsHumanJobs.appliedMessage'));
          onApplied?.();
        } catch (err) {
          if (!offerSpeechWindow(err, navigation, t)) {
            Alert.alert(t('commonsHumanJobs.errorTitle'), errorDisplayCopy(err instanceof Error ? err.message : t('commonsHumanJobs.applyFailed')));
          }
        } finally {
          setApplyingJobId(null);
        }
      });
    } catch (err) {
      if (err instanceof BiometricNotAvailableError) {
        Alert.alert(t('commonsHumanJobs.confirmationNeededTitle'), errorDisplayCopy(err.message));
      } else if (err instanceof BiometricAuthError) {
        Alert.alert(t('commonsHumanJobs.confirmationNeededTitle'), t('commonsHumanJobs.confirmationNeededMessage'));
      }
      return;
    }
  }, [navigation, onApplied, sealNote, t]);

  const startApply = useCallback((job: HumanJob) => {
    if (!myWalletId) {
      Alert.alert(t('commonsHumanJobs.joinRequiredTitle'), t('commonsHumanJobs.joinRequiredMessage'));
      return;
    }
    const pay = formatHumanJobCompensation(job);
    // iOS offers a note field (Alert.prompt); elsewhere the application goes without a note.
    // Gate on the PLATFORM, not on `typeof Alert.prompt`: Android defines Alert.prompt as a
    // silent no-op, so the typeof check made Apply do nothing on Android (live finding).
    if (Platform.OS === 'ios') {
      Alert.prompt(
        t('commonsHumanJobs.applyNoteTitle'),
        t('commonsHumanJobs.applyNoteBody', { title: job.title, pay }),
        [
          { text: t('commonsHumanJobs.cancel'), style: 'cancel' },
          { text: t('commonsHumanJobs.apply'), onPress: (text?: string) => { void confirmApply(job, (text ?? '').trim()); } },
        ],
        'plain-text',
      );
      return;
    }
    Alert.alert(
      t('commonsHumanJobs.applyAlertTitle'),
      t('commonsHumanJobs.applyAlertMessage', { title: job.title, pay }),
      [
        { text: t('commonsHumanJobs.cancel'), style: 'cancel' },
        { text: t('commonsHumanJobs.apply'), onPress: () => { void confirmApply(job, ''); } },
      ],
    );
  }, [confirmApply, myWalletId, t]);

  return { applyingJobId, startApply, appliedJobIds };
}
