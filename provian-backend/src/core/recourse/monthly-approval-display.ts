import { randomUUID } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecourseMonthlyApproval, type RecourseMonthlyApproval } from './monthly-approval';
import { RECOURSE_COLLECTIONS } from './ownership';
import { readRecoursePoolState } from './pool-state';
import type { RecourseDisplayPool } from './pool-display';

const COLLECTION = 'recourse_private_approval_display_v1';
const REFRESH_MS = 5 * 60_000;

interface ApprovalDisplay {
  readonly binding: string;
  readonly pool: string;
  readonly ruleHash: string;
  readonly month: string;
  readonly observedAtMs: number;
  readonly approval: RecourseMonthlyApproval;
}

export async function readMonthlyApprovalDisplay(
  db: Firestore, ownerIdentity: string, binding: string, pool: RecourseDisplayPool,
): Promise<RecourseMonthlyApproval | null> {
  const ref = db.collection(COLLECTION).doc(ownerIdentity);
  const now = Date.now();
  const readDisplay = (data: ApprovalDisplay | undefined): ApprovalDisplay | undefined =>
    data?.binding === binding && data.pool === pool.pool && data.ruleHash === pool.signedRuleHash && data.month === pool.month
      ? data : undefined;
  const row = await ref.get();
  const display = readDisplay(row.get('display') as ApprovalDisplay | undefined);
  if (display && display.observedAtMs + REFRESH_MS > now) return display.approval;
  if (row.get('requestedBinding') !== binding || row.get('dueAtMs') == null) {
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.get('requestedBinding') === binding && current.get('dueAtMs') != null) return;
      const latest = readDisplay(current.get('display') as ApprovalDisplay | undefined);
      if (latest && latest.observedAtMs + REFRESH_MS > now) return;
      tx.set(ref, { requestedBinding: binding, dueAtMs: now, display: latest ?? null });
    });
  }
  return display?.approval ?? null;
}

/** Bounded work on the existing scheduler, with retries surviving instance
 * termination. The only data published here is an owner's display state. */
export async function refreshMonthlyApprovalDisplays(db: Firestore): Promise<void> {
  const now = Date.now();
  const rows = await db.collection(COLLECTION).where('dueAtMs', '<=', now).orderBy('dueAtMs').limit(3).get();
  await Promise.all(rows.docs.map(async row => {
    const claim = randomUUID();
    const binding = await db.runTransaction(async tx => {
      const current = await tx.get(row.ref);
      const candidate: unknown = current.get('requestedBinding');
      const due: unknown = current.get('dueAtMs');
      if (typeof candidate !== 'string' || !/^0x[0-9a-f]{64}$/.test(candidate)
        || typeof due !== 'number' || due > now) return null;
      tx.update(row.ref, { claim, dueAtMs: now + REFRESH_MS });
      return candidate;
    });
    if (!binding) return;
    const ownerRef = db.collection(RECOURSE_COLLECTIONS.owners).doc(row.id);
    const bindingRef = db.collection(RECOURSE_COLLECTIONS.identities).doc(binding);
    try {
      const [owner, identity] = await Promise.all([ownerRef.get(), bindingRef.get()]);
      let display: ApprovalDisplay | null = null;
      if (owner.get('ownerIdentity') === row.id && owner.get('membershipFixedDebitBinding') === binding
        && owner.get('membershipTransition') == null && identity.get('ownerIdentity') === row.id) {
        const deployment = await currentProtocolDeployment();
        const state = await readRecoursePoolState(binding, deployment);
        const approval = await readRecourseMonthlyApproval(binding, binding, state, deployment);
        display = { binding, pool: state.pool, ruleHash: state.signedRuleHash, month: state.month,
          observedAtMs: Date.now(), approval };
      }
      await db.runTransaction(async tx => {
        const [current, latestOwner, latestIdentity] = await Promise.all([
          tx.get(row.ref), tx.get(ownerRef), tx.get(bindingRef),
        ]);
        if (current.get('claim') !== claim) return;
        if (display && (latestOwner.get('membershipFixedDebitBinding') !== binding
          || latestOwner.get('membershipTransition') != null || latestIdentity.get('ownerIdentity') !== row.id
          || latestIdentity.get('recoveryGeneration') !== identity.get('recoveryGeneration'))) {
          tx.delete(row.ref);
          return;
        }
        if (display) tx.set(row.ref, { display });
        else tx.delete(row.ref);
      });
    } catch {
      // The claimed due time makes a failed lookup retryable while the last
      // successful display remains available for the same owner and rule.
      console.warn('[Recourse] Monthly approval display refresh unavailable');
    }
  }));
}
