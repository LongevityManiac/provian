import { ZeroAddress } from 'ethers';

/** Component order in the permanent protocol pointer. */
export const POINTER_SLOTS = Object.freeze({ token: 0, eligibilityVerifier: 1, beneficiaryVerifier: 2, escrow: 3, promises: 4,
  projectPool: 5, bonds: 6, court: 7, recoursePool: 8, settlementAdapter: 9 });
const ensure = (value, reason) => { if (!value) throw Error('pointer_manifest_' + reason); };
const lower = value => String(value).toLowerCase();
const isAddress = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Refuses a replacement manifest the live set cannot survive.
 *
 * The pointer contract itself refuses to replace the Recourse Pool (slot 8) or
 * the token-bound institutions (slots 3, 5, 6, 7) while the token (slot 0)
 * stays. It does not refuse replacing the settlement adapter (slot 9) alone,
 * and a retired address can never return. The Recourse Pool is built with one
 * settlement adapter and settles only while that adapter is the pointer's
 * current slot 9, and the pool cannot be replaced while the token stays. So a
 * manifest that swaps only the adapter retires the one adapter the pool will
 * ever accept and stops settlement for that token permanently. The three
 * move together or not at all. Every tool that prepares a pointer `publish`
 * call must pass its manifest through this check before the call is encoded.
 *
 * `current` is the ten addresses the pointer holds now (all zero before the
 * first publication); `next` is the ten addresses about to be published.
 */
export function assertManifestSuccession({ revision, current, next }) {
  ensure(typeof revision === 'bigint' && revision >= 0n, 'revision_invalid');
  ensure(Array.isArray(current) && current.length === 10 && current.every(isAddress), 'current_invalid');
  ensure(Array.isArray(next) && next.length === 10 && next.every(isAddress), 'next_invalid');
  const now = current.map(lower), then = next.map(lower);
  if (revision === 0n) {
    ensure(now.every(address => address === ZeroAddress), 'unpublished_set_not_empty');
    return;
  }
  ensure(now[POINTER_SLOTS.token] !== ZeroAddress, 'current_token_missing');
  if (then[POINTER_SLOTS.token] !== now[POINTER_SLOTS.token]) return;
  ensure(then[POINTER_SLOTS.settlementAdapter] === now[POINTER_SLOTS.settlementAdapter], 'settlement_adapter_replaced_under_same_token');
  ensure(then[POINTER_SLOTS.recoursePool] === now[POINTER_SLOTS.recoursePool], 'recourse_pool_replaced_under_same_token');
  for (const slot of [POINTER_SLOTS.escrow, POINTER_SLOTS.projectPool, POINTER_SLOTS.bonds, POINTER_SLOTS.court]) {
    ensure(then[slot] === now[slot], 'institution_replaced_under_same_token');
  }
}
