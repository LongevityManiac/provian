/**
 * the registry-hold VERIFIER.
 *
 * The chain-reader defect made `resolveBeneficiary` THROW `tip_pe_missing`
 * for 14 agent wallets, so their PEs sealed `linkageState:'unverifiable'` → the registry
 * gate forced `pending_review` + `estimated_pvt 0`. Item 1 fixed the reader. This verifier
 * re-runs the exact same beneficiary resolution NOW and decides whether — and how — a held
 * row may be released:
 *
 * - the read STILL throws → the hold is a genuine/transient outage, NOT our defect →
 * leave the row pending (money-safety fence #4: never resolve on a failed read);
 * - the read succeeds, unlinked → the sealed 1.0x value IS the true live price → resolve
 * VERBATIM (no re-price, no routing);
 * - the read succeeds, linked → the row was under-priced at 1.0x and mis-routed → resolve
 * RE-PRICED to the true beneficiary_linked value + the 80/20 routing (a claimless Commons speech
 * act instead keeps the points its speech-window budget booked; the promoter applies that).
 *
 * This module only DECIDES. `registry-hold-promotion.ts` is the sole sanctioned writer.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { resolveBeneficiary, type BeneficiaryCacheEntry } from './beneficiary';

export type RegistryHoldVerdict =
  | { readonly kind: 'resolve'; readonly linkage: 'unlinked'; readonly beneficiary: null }
  | {
      readonly kind: 'resolve';
      readonly linkage: 'beneficiary_linked';
      readonly beneficiary: BeneficiaryCacheEntry;
    }
  | { readonly kind: 'leave_pending'; readonly reason: string };

/**
 * Re-verify the beneficiary linkage of a registry-held row's economic actor. Pure decision;
 * writes nothing. `economicActorId` is the row's `user_id` / `economic_actor_id` (the agent_id).
 */
export async function verifyRegistryHold(params: {
  db: Firestore;
  cache: RedisCache;
  economicActorId: string;
}): Promise<RegistryHoldVerdict> {
  let entry: BeneficiaryCacheEntry;
  try {
    entry = await resolveBeneficiary(params.economicActorId, params.cache, params.db);
  } catch (error) {
    // FENCE #4 — the hold was caused by this read throwing at seal. If it STILL throws,
    // the linkage is genuinely unresolvable right now; leave the row pending and retry
    // on a later sweep. Never release a mint on a failed read.
    return {
      kind: 'leave_pending',
      reason: `beneficiary_read_failed:${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
  if (!entry.linked) {
    // True linkage is standalone: the frozen 1.0x is exactly what it would have earned live.
    return { kind: 'resolve', linkage: 'unlinked', beneficiary: null };
  }
  // True linkage is beneficiary_linked: re-price to 2.0x + the configured agent/human split.
  return { kind: 'resolve', linkage: 'beneficiary_linked', beneficiary: entry };
}
