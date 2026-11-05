/**
 * FEATURED PLACEMENT — a burn auction with deterministic ranking and closure.
 *
 * Featured placement on the wants board and on the Commons jobs board is a scarce good like a name
 * claim: every bid is its OWN burn on the global single-use ledger (`burn_consumptions/{burn_id}`,
 * product `featured_placement`, floor 15 PVT — the name-claim / filing-fee family, no ceiling). The
 * bid amount is the burn's verified on-chain amount; each bid is live for a term
 * ({@link FEATURED_TERM_MS}, the handshake window). Filing the item itself is covered by the speech
 * window; a bid is the only extra burn.
 *
 * * - ONE ITEM, ONE SLOT, BURNS STACK. An item appears once in {@link listFeatured}; its rank is the
 * SUM of every unexpired bid on it. More bids on the same item are allowed — each burns in full
 * and adds to the total. Ties go to the earlier first (live) bid.
 * - PLACEMENT ENDS WHEN THE ITEM CLOSES. Only an OPEN item is featured: a cancelled / matched /
 * fulfilled / expired want, or a job that is no longer open (filled, completed, cancelled,
 * refunded, disputed), drops out of the list at once — read at list time from the item itself,
 * so no close path can forget it — and a closed item cannot be bid on. Nothing refunds; the burn
 * stays burned.
 *
 * The bid seals a `commons_featured_placement` PE (record_only: a PVT-cost event mints nothing)
 * in the SAME transaction that consumes the burn and creates the placement (mirrors
 * `name-registry.ts::claimName` all reads before any write, `create()` for uniqueness, the
 * consumption marker co-created).
 */

import type { Transaction } from 'firebase-admin/firestore';
import { generatePE } from '../agent-bank/pe-utils';
import { ValidationError, NotFoundError, ForbiddenError } from '../agent-bank/errors';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  BURN_CONSUMPTIONS_COLLECTION,
  PVT_BURN_RECORDS_COLLECTION,
  BurnConsumptionError,
  BURN_ALREADY_CONSUMED,
  assertBurnRowUsable,
  buildBurnConsumptionMarker,
  isBurnId,
  parseAmountAtomic,
  resolveBurnFloorAtomic,
} from './burn-consumption';
import { RAIL_HANDSHAKE_WINDOW_MS } from '../rail/handshake';
import { resolveSpeechCommitter } from './speech-window';
import { COMMONS_COLLECTIONS } from './types';
import { isHiddenPrelaunchTest } from './public-visibility';

export type FeaturedBoard = 'wants' | 'jobs' | 'human_jobs';
export const FEATURED_BOARDS: readonly FeaturedBoard[] = Object.freeze(['wants', 'jobs', 'human_jobs']);

/** A featured term: the handshake window (the existing 7-day literal), never renewed in place. */
export const FEATURED_TERM_MS = RAIL_HANDSHAKE_WINDOW_MS;

/** The wants collection (`wants.ts::COMMONS_WANTS_COLLECTION`; not imported — wants.ts imports this module). */
const WANTS_COLLECTION = 'commons_wants';

/**
 * where each board's items live and when one is OPEN (featurable). The ONE predicate both
 * the bid (inside its transaction) and the list read. Anything but an open item — including a
 * missing item or an unreadable status — is closed (Unknown = block).
 */
export const FEATURED_BOARD_ITEMS: Readonly<Record<FeaturedBoard, { collection: string; isOpen: (item: Record<string, unknown>, nowMs: number) => boolean }>> = Object.freeze({
  // A want is open until matched / fulfilled / cancelled, or past its expiry (`wants.ts::projectStatus`).
  wants: {
    collection: WANTS_COLLECTION,
    isOpen: (w, nowMs) => w.status === 'open' && !(typeof w.expiry === 'number' && w.expiry <= nowMs),
  },
  // The folded agent-only board (legacy placements only; its feature route answers 410).
  jobs: { collection: 'jobs', isOpen: (j) => j.status === 'open' },
  // The Commons jobs board: open until accepted (in_progress) or otherwise closed.
  human_jobs: { collection: COMMONS_COLLECTIONS.HUMAN_JOBS, isOpen: (j) => j.status === 'open' },
});

/** Is this board item open (featurable) right now? */
export function isFeaturedItemOpen(board: FeaturedBoard, item: Record<string, unknown> | undefined, nowMs: number): boolean {
  return item !== undefined && FEATURED_BOARD_ITEMS[board].isOpen(item, nowMs);
}

/** The refusal a bid on a closed item gets (checked inside the bid transaction, before any write). */
export const FEATURED_ITEM_NOT_OPEN = 'Only an open item can be featured';

export interface FeaturedPlacement {
  burn_id: string;
  board: FeaturedBoard;
  item_id: string;
  /** The bidder's Commons wallet id (agent wallet id / human user id). */
  wallet_id: string;
  /** The bid: the burn's verified on-chain amount, atomic units (decimal string). */
  amount_atomic: string;
  featured_from: number;
  featured_until: number;
  pe_id: string;
  created_at: number;
}

/** One item's featured slot: every live bid on it, stacked. */
export interface FeaturedSlot {
  rank: number;
  item_id: string;
  /** The poster (only the poster can bid). */
  wallet_id: string;
  /** The rank key: the SUM of every unexpired bid on the item, atomic units (decimal string). */
  amount_atomic: string;
  /** When the LAST live bid lapses (the item stays featured until then, while it is open). */
  featured_until: number;
  /** The first live bid's burn (kept for existing readers). */
  burn_id: string;
  /** Every live bid's burn, in bid order. */
  burn_ids: string[];
  bid_count: number;
  /** The first live bid's time — the tie-break. */
  first_bid_at: number;
}

export interface BidFeaturedInput {
  board: FeaturedBoard;
  itemId: string;
  actor: { walletId: string; agentId: string; actorAddress: string | null; isAgent: boolean };
  burnId: unknown;
  /**
   * The board's own check, run INSIDE the bid transaction before any write: the item exists and
   * belongs to the bidder. Throw a `ValidationError` / `NotFoundError` / `ForbiddenError` to
   * refuse. Openness is checked HERE by `bidFeatured` itself, with the same predicate the
   * list reads, so no board can admit a bid its list would never show.
   */
  assertBiddable: (txn: Transaction) => Promise<void>;
  nowMs?: number;
}

/**
 * Place a featured bid: consume the burn, create the placement, seal the record-only PE. A second
 * bid on the same item is its own burn and stacks onto the item's total.
 */
export async function bidFeatured(deps: AgentBankDeps, input: BidFeaturedInput): Promise<FeaturedPlacement> {
  if (!FEATURED_BOARDS.includes(input.board)) throw new ValidationError('unknown board');
  if (!input.itemId) throw new ValidationError('item id is required');
  if (!isBurnId(input.burnId)) throw new ValidationError('burn_id must be a 64-hex burn id');
  const burnId = input.burnId;
  const now = input.nowMs ?? Date.now();

  const [minBurn, committer] = await Promise.all([
    resolveBurnFloorAtomic(deps.db, 'featured_placement'),
    resolveSpeechCommitter(deps.db, input.actor),
  ]);
  if (!committer.presenterWalletId) throw new ForbiddenError('No first-party wallet to bid from');

  const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);
  const placementRef = deps.db.collection(COMMONS_COLLECTIONS.FEATURED_PLACEMENTS).doc(burnId);
  const itemRef = deps.db.collection(FEATURED_BOARD_ITEMS[input.board].collection).doc(input.itemId);
  const ref = `${input.board}:${input.itemId}`;
  let amountAtomic = '0';

  const buildPlacement = (peId: string): FeaturedPlacement => ({
    burn_id: burnId,
    board: input.board,
    item_id: input.itemId,
    wallet_id: input.actor.walletId,
    amount_atomic: amountAtomic,
    featured_from: now,
    featured_until: now + FEATURED_TERM_MS,
    pe_id: peId,
    created_at: now,
  });

  let peId: string;
  try {
    ({ peId } = await generatePE(deps, {
      walletId: input.actor.walletId,
      agentId: input.actor.agentId,
      actorAddress: input.actor.actorAddress,
      ownerType: input.actor.isAgent ? 'agent' : 'human',
      actionType: 'commons_featured_placement',
      metadata: { board: input.board, item_id: input.itemId, burn_id: burnId, verified: true },
      witnessClass: 'relay_verified',
      atomicEntityPrecondition: async (txn) => {
        await input.assertBiddable(txn);
        const [itemSnap, burnSnap, consumptionSnap, placementSnap] = await Promise.all([
          txn.get(itemRef), txn.get(burnRef), txn.get(consumptionRef), txn.get(placementRef),
        ]);
        const item = itemSnap.exists ? (itemSnap.data() as Record<string, unknown>) : undefined;
        if (!item) throw new NotFoundError('item not found');
        if (isHiddenPrelaunchTest(item)) throw new NotFoundError('item not found');
        if (!isFeaturedItemOpen(input.board, item, now)) throw new ValidationError(FEATURED_ITEM_NOT_OPEN);
        const burn = burnSnap.exists ? (burnSnap.data() as Record<string, unknown>) : undefined;
        assertBurnRowUsable(burn, committer.presenterWalletId, minBurn);
        if (consumptionSnap.exists || placementSnap.exists) throw new BurnConsumptionError(409, BURN_ALREADY_CONSUMED);
        amountAtomic = parseAmountAtomic(burn!.amount_atomic).toString();
      },
      atomicEntityWrite: (txn, generatedPeId) => {
        txn.create(placementRef, buildPlacement(generatedPeId));
        txn.create(
          consumptionRef,
          buildBurnConsumptionMarker({ burnId, product: 'featured_placement', walletId: committer.presenterWalletId, ref, nowMs: now }),
        );
      },
    }));
  } catch (err) {
    if (err instanceof BurnConsumptionError) {
      if (err.status === 404) throw new NotFoundError(err.message);
      if (err.status === 403) throw new ForbiddenError(err.message);
      throw new ValidationError(err.message);
    }
    if ((err as { code?: number }).code === 6) throw new ValidationError(BURN_ALREADY_CONSUMED);
    throw err;
  }
  return buildPlacement(peId);
}

/**
 * The board's featured slots : ONE slot per OPEN item, ranked by the SUM of its unexpired
 * bids (higher first; ties to the earlier first live bid). A bid on an item that has since closed
 * or whose item cannot be read — is not shown.
 */
export async function listFeatured(deps: Pick<AgentBankDeps, 'db'>, board: FeaturedBoard, nowMs: number = Date.now()): Promise<FeaturedSlot[]> {
  const snap = await deps.db
    .collection(COMMONS_COLLECTIONS.FEATURED_PLACEMENTS)
    .where('board', '==', board)
    .get();
  const live = snap.docs
    .map((d) => d.data() as FeaturedPlacement)
    .filter((p) => p.featured_until > nowMs && typeof p.item_id === 'string' && p.item_id !== '');
  live.sort((a, b) => a.created_at - b.created_at);

  const byItem = new Map<string, FeaturedPlacement[]>();
  for (const p of live) {
    const bids = byItem.get(p.item_id);
    if (bids) bids.push(p);
    else byItem.set(p.item_id, [p]);
  }

  const { collection } = FEATURED_BOARD_ITEMS[board];
  const itemIds = [...byItem.keys()];
  const items = await Promise.all(itemIds.map(async (id) => {
    try {
      const s = await deps.db.collection(collection).doc(id).get();
      return s.exists ? (s.data() as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }));

  const slots: Array<Omit<FeaturedSlot, 'rank'> & { total: bigint }> = [];
  itemIds.forEach((id, i) => {
    if (isHiddenPrelaunchTest(items[i])) return;
    if (!isFeaturedItemOpen(board, items[i], nowMs)) return;
    const bids = byItem.get(id)!;
    const total = bids.reduce((sum, p) => sum + BigInt(p.amount_atomic || '0'), 0n);
    slots.push({
      item_id: id,
      wallet_id: bids[0].wallet_id,
      amount_atomic: total.toString(),
      total,
      featured_until: Math.max(...bids.map((p) => p.featured_until)),
      burn_id: bids[0].burn_id,
      burn_ids: bids.map((p) => p.burn_id),
      bid_count: bids.length,
      first_bid_at: bids[0].created_at,
    });
  });
  slots.sort((a, b) => {
    if (a.total !== b.total) return a.total > b.total ? -1 : 1;
    return a.first_bid_at - b.first_bid_at;
  });
  return slots.map(({ total: _total, ...slot }, i) => ({ rank: i + 1, ...slot }));
}

/** The live featured rank of one item on a board (null when not featured). */
export async function featuredRankOf(deps: Pick<AgentBankDeps, 'db'>, board: FeaturedBoard, itemId: string, nowMs: number = Date.now()): Promise<FeaturedSlot | null> {
  const slots = await listFeatured(deps, board, nowMs);
  return slots.find((s) => s.item_id === itemId) ?? null;
}
