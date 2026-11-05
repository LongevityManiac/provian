/**
 * featuredBid — the person's own featured-placement bid amount. Featured placement is a burn
 * auction (backend `core/commons/featured.ts`): the bid is whatever the person burns, from the
 * `featured_placement` floor up, with no ceiling — the same terms an agent bids on. Bids on one
 * item stack into its total. The relay's floor (schedulable, `burn_floor_policy`) is the authority;
 * this module only refuses an amount the relay would refuse before anything is burned.
 */
import { ethers } from 'ethers';
import { parsePvtInput, formatPvtExact } from './pvtAmountInput';

/** The launch floor of the `featured_placement` burn product (BURN_FLOOR_LAUNCH_LITERALS). */
export const FEATURED_BID_MIN_PVT = '15';

const PVT_DECIMALS = 18;

export type FeaturedBidParse =
  | { ok: true; pvt: string; atomic: bigint }
  | { ok: false; reason: 'empty' | 'invalid' | 'below_floor' };

/** Whole-PVT decimal string for display/burn: "25", "25.5" (no trailing zeros). */
export function formatPvt(atomic: bigint): string {
  return formatPvtExact(atomic);
}

/**
 * Parse what the person typed (`pvtAmountInput.parsePvtInput`: a decimal comma only where it cannot
 * be a thousands separator, at most 18 places, never throws); refuses anything below the floor.
 */
export function parseFeaturedBid(input: string, minPvt: string = FEATURED_BID_MIN_PVT): FeaturedBidParse {
  const parsed = parsePvtInput(input);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const atomic = parsed.atomic;
  if (atomic < ethers.parseUnits(minPvt, PVT_DECIMALS)) return { ok: false, reason: 'below_floor' };
  return { ok: true, pvt: formatPvt(atomic), atomic };
}

/**
 * The largest saved (burned, not yet spent) burn at or above the floor, as whole PVT — offered first
 * so a bid that failed after its burn is finished with that burn, never a second one.
 */
export function savedBidBurnPvt(saved: ReadonlyArray<{ amountAtomic: string }>, minPvt: string = FEATURED_BID_MIN_PVT): string | null {
  const floor = ethers.parseUnits(minPvt, PVT_DECIMALS);
  let best: bigint | null = null;
  for (const b of saved) {
    if (!/^\d+$/.test(b.amountAtomic)) continue;
    const v = BigInt(b.amountAtomic);
    if (v >= floor && (best === null || v > best)) best = v;
  }
  return best === null ? null : formatPvt(best);
}
