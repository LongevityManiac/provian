import { randomUUID } from 'node:crypto';
import { verifyExerciseMembershipChallenge, verifyExerciseMembershipSignature } from './exercise-membership.mjs';

/** Local exercise interaction only. The queue contains public challenges and
 * signatures, never wallet keys. Closing the workbench rejects the pending
 * request; it cannot silently substitute impersonation for an owner signature. */
export function exerciseSignatureQueue(timeoutMs = 180_000) {
  let pending = null;
  return {
    request(input) {
      const challenge = verifyExerciseMembershipChallenge(input);
      if (pending) return Promise.reject(Error('exercise_signature_already_pending'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending = null; reject(Error('exercise_signature_expired'));
        }, timeoutMs);
        pending = { id, challenge, resolve, reject, timer };
      });
    },
    read(account) {
      return pending?.challenge.account === account.toLowerCase()
        ? { id: pending.id, challenge: structuredClone(pending.challenge) } : null;
    },
    submit(account, id, signature) {
      if (!pending || pending.id !== id || pending.challenge.account !== account.toLowerCase()) throw Error('exercise_signature_request_changed');
      verifyExerciseMembershipSignature(pending.challenge, signature);
      const accepted = pending; pending = null; clearTimeout(accepted.timer); accepted.resolve(signature);
    },
    close() {
      if (!pending) return;
      const cancelled = pending; pending = null; clearTimeout(cancelled.timer); cancelled.reject(Error('exercise_workbench_closed'));
    },
  };
}
