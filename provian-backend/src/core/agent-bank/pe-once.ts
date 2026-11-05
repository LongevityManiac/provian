/**
 * seal ONE Provenance Envelope per named event, however many times the caller runs.
 *
 * Several relay writers seal a row and only then flip the state that stops them running again (the
 * escrow dispute resolution seals both parties' rows BEFORE it marks the escrow resolved, so a
 * failure between the two is retried; the Commons challenge resolution is best-effort and is
 * repeated by a sweep). A row that Standing counts must never be sealed twice by such a retry.
 *
 * The lock document `standing_event_locks/{key}` is created INSIDE the same transaction that
 * advances the actor's chain tip and writes the envelope (`atomicEntityPrecondition` reads it,
 * `atomicEntityWrite` creates it), so PE ⟺ lock: either both exist or neither does. A repeat call
 * finds the lock and returns the PE it names.
 */
import type { AgentBankDeps } from './types';
import { generatePE } from './pe-utils';

export const STANDING_EVENT_LOCKS_COLLECTION = 'standing_event_locks';

const ALREADY = 'standing_event_lock_exists';

/** Lock ids are document ids: no slash, bounded length. */
export function standingEventLockId(parts: readonly string[]): string {
  const id = parts.map((p) => p.replace(/[^A-Za-z0-9_.:-]/g, '_')).join('__');
  if (id.length === 0 || id.length > 512) throw new Error('standing_event_lock_id_invalid');
  return id;
}

export async function generatePEOnce(
  deps: AgentBankDeps,
  lockParts: readonly string[],
  params: Parameters<typeof generatePE>[1],
  generate: typeof generatePE = generatePE,
): Promise<{ peId: string; sealed: boolean }> {
  const lockRef = deps.db.collection(STANDING_EVENT_LOCKS_COLLECTION).doc(standingEventLockId(lockParts));
  try {
    const { peId } = await generate(deps, {
      ...params,
      atomicEntityPrecondition: async (txn) => {
        const snap = await txn.get(lockRef);
        if (snap.exists) throw new Error(ALREADY);
      },
      atomicEntityWrite: (txn, newPeId) => {
        txn.create(lockRef, { pe_id: newPeId, action_type: params.actionType, wallet_id: params.walletId, at_ms: Date.now() });
      },
    });
    return { peId, sealed: true };
  } catch (err) {
    if ((err as Error).message !== ALREADY) throw err;
    const existing = (await lockRef.get()).data() as { pe_id?: unknown } | undefined;
    if (typeof existing?.pe_id !== 'string') throw new Error('standing_event_lock_unreadable');
    return { peId: existing.pe_id, sealed: false };
  }
}
