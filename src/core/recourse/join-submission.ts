import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JoinSubmission, MembershipOperationStatus, MembershipTransitionView } from './membership-client';

const key = (wallet: string) => `recourse.join-submission.${wallet}`;
const hash = /^0x[0-9a-f]{64}$/;

// Only readback metadata survives a restart. The signature and exit material
// stay in the authorization flow or the relay's protected operation queue.
export async function readJoinSubmission(wallet: string): Promise<JoinSubmission | null> {
  const raw = await AsyncStorage.getItem(key(wallet));
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<JoinSubmission>;
  if (typeof value?.transitionId !== 'string' || !hash.test(value.transitionId)
    || typeof value.operationId !== 'string' || !hash.test(value.operationId)
    || typeof value.binding !== 'string' || !hash.test(value.binding)
    || typeof value.expiresAt !== 'string' || !/^[0-9]{1,12}$/.test(value.expiresAt)) throw Error('recourse_join_submission_invalid');
  return { transitionId: value.transitionId, operationId: value.operationId, binding: value.binding, expiresAt: value.expiresAt };
}

export function saveJoinSubmission(wallet: string, submission: JoinSubmission): Promise<void> {
  return AsyncStorage.setItem(key(wallet), JSON.stringify(submission));
}

export function clearJoinSubmission(wallet: string): Promise<void> {
  return AsyncStorage.removeItem(key(wallet));
}

export function canClearJoinSubmission(submission: JoinSubmission, view: MembershipTransitionView,
  operation: MembershipOperationStatus | null): boolean {
  if (submission.transitionId !== view.id) return false;
  if (view.status === 'complete' || view.status === 'superseded') return true;
  if (view.pending.some(row => row.binding === submission.binding)) return true;
  if (operation?.status === 'failed') return true;
  if (operation) return false;
  const challenge = view.challenges.find(row => row.consent.binding === submission.binding);
  // A challenge is issued at the relay's checked chain time plus five minutes.
  // Only that time (not the phone clock) can prove a lost submission expired.
  return !!challenge && BigInt(challenge.consent.expiresAt) - 300n > BigInt(submission.expiresAt);
}
