/**
 * — the x402 seller registry, READ side.
 *
 * Provian's x402 facilitator (`provian-x402-facilitator`, its own service) writes the sellers who
 * registered with it — each identified by a wallet signature, never an account — to
 * `x402_sellers_v1/{chain}:{address}` in the relay's database. The relay only READS them: the
 * public list (`GET /v1/x402/sellers`) and the agent directory (`GET /v1/agents/directory`). Only
 * `active` sellers are shown, and only the public profile fields — never a signature, a nonce, or
 * a counter the facilitator keeps for itself (e.g. its strike count).
 *
 * PVT prices are PVT atomic amounts (18 decimals) as the seller set them. Provian never quotes PVT
 * in dollars, so no dollar figure is derived or shown.
 */

import { FieldPath, type Firestore } from 'firebase-admin/firestore';

export const X402_SELLERS_COLLECTION = 'x402_sellers_v1';
export const X402_SELLERS_MAX_PAGE = 100;
export const X402_SELLERS_DEFAULT_PAGE = 50;

export type X402SellerChain = 'base' | 'solana';
const NETWORK_OF: Readonly<Record<X402SellerChain, string>> = Object.freeze({
  base: 'eip155:8453',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

export interface X402SellerPredicate {
  readonly field: string;
  readonly op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
  readonly threshold?: number;
  readonly set?: readonly number[];
}

export interface X402SellerRequirePresentation {
  readonly tier: 'pe_fact' | 'reputation';
  readonly predicates?: readonly X402SellerPredicate[];
}

/** The public projection of one seller — the ONLY fields any relay surface returns. */
export interface X402PublicSeller {
  readonly seller_id: string;
  readonly chain: X402SellerChain;
  readonly network: string;
  readonly address: string;
  readonly display_name: string;
  readonly description: string;
  readonly resource_urls: readonly string[];
  readonly require_presentation: X402SellerRequirePresentation | null;
  readonly pvt_prices: ReadonlyArray<{ readonly resource: string; readonly amount_atomic: string }>;
  readonly status: 'active';
  readonly registered_at_ms: number;
  readonly updated_at_ms: number;
  readonly settlement_count: number;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PVT_ATOMIC = /^[1-9][0-9]{0,59}$/;
const PREDICATE_OPS: ReadonlySet<string> = new Set(['gte', 'gt', 'lte', 'lt', 'eq', 'in']);

export function isX402SellerChain(value: unknown): value is X402SellerChain {
  return value === 'base' || value === 'solana';
}

/** A seller id is `${chain}:${address}`, EVM lowercased, Solana base58 as-is. */
export function isX402SellerId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const sep = value.indexOf(':');
  if (sep < 0) return false;
  const chain = value.slice(0, sep);
  const address = value.slice(sep + 1);
  if (chain === 'base') return EVM_ADDRESS.test(address);
  if (chain === 'solana') return SOLANA_ADDRESS.test(address);
  return false;
}

function stringOr(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function projectPresentation(raw: unknown): X402SellerRequirePresentation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.tier !== 'pe_fact' && r.tier !== 'reputation') return null;
  const predicates = Array.isArray(r.predicates)
    ? r.predicates.flatMap((p): X402SellerPredicate[] => {
      if (!p || typeof p !== 'object') return [];
      const q = p as Record<string, unknown>;
      if (typeof q.field !== 'string' || typeof q.op !== 'string' || !PREDICATE_OPS.has(q.op)) return [];
      return [{
        field: q.field.slice(0, 64),
        op: q.op as X402SellerPredicate['op'],
        ...(typeof q.threshold === 'number' && Number.isFinite(q.threshold) ? { threshold: q.threshold } : {}),
        ...(Array.isArray(q.set) ? { set: q.set.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 32) } : {}),
      }];
    }).slice(0, 8)
    : undefined;
  return { tier: r.tier, ...(predicates ? { predicates } : {}) };
}

/**
 * Project a stored seller doc to its public fields, or null when it is not an active, well-formed
 * seller (suspended, malformed, or an id that does not match its own chain/address — never shown).
 */
export function projectX402Seller(docId: string, raw: unknown): X402PublicSeller | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.status !== 'active') return null;
  if (!isX402SellerChain(r.chain) || typeof r.address !== 'string') return null;
  const expectedId = `${r.chain}:${r.address}`;
  if (docId !== expectedId || r.seller_id !== expectedId || !isX402SellerId(expectedId)) return null;
  const pvtPrices = Array.isArray(r.pvt_prices)
    ? r.pvt_prices.flatMap((p): Array<{ resource: string; amount_atomic: string }> => {
      if (!p || typeof p !== 'object') return [];
      const q = p as Record<string, unknown>;
      return typeof q.resource === 'string' && typeof q.amount_atomic === 'string' && PVT_ATOMIC.test(q.amount_atomic)
        ? [{ resource: q.resource.slice(0, 300), amount_atomic: q.amount_atomic }]
        : [];
    }).slice(0, 50)
    : [];
  return {
    seller_id: expectedId,
    chain: r.chain,
    network: NETWORK_OF[r.chain],
    address: r.address,
    display_name: stringOr(r.display_name, '', 80),
    description: stringOr(r.description, '', 500),
    resource_urls: Array.isArray(r.resource_urls)
      ? r.resource_urls.filter((u): u is string => typeof u === 'string' && u.startsWith('https://')).slice(0, 20)
      : [],
    require_presentation: projectPresentation(r.require_presentation),
    pvt_prices: pvtPrices,
    status: 'active',
    registered_at_ms: typeof r.registered_at_ms === 'number' ? r.registered_at_ms : 0,
    updated_at_ms: typeof r.updated_at_ms === 'number' ? r.updated_at_ms : 0,
    settlement_count: typeof r.settlement_count === 'number' && Number.isSafeInteger(r.settlement_count)
      ? r.settlement_count
      : 0,
  };
}

export interface X402SellerPage {
  readonly sellers: readonly X402PublicSeller[];
  /** The last seller id of this page when more may follow; pass it back as `cursor`. */
  readonly next_cursor: string | null;
}

/**
 * One page of ACTIVE sellers, in seller-id order (keyset paging on the document id, so no
 * composite index and no `offset()` reads). `chain` narrows to one chain.
 */
export async function listActiveX402Sellers(
  db: Firestore,
  options: { readonly chain?: X402SellerChain; readonly limit?: number; readonly cursor?: string | null } = {},
): Promise<X402SellerPage> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? X402_SELLERS_DEFAULT_PAGE)), X402_SELLERS_MAX_PAGE);
  let query: FirebaseFirestore.Query = db.collection(X402_SELLERS_COLLECTION).where('status', '==', 'active');
  if (options.chain) query = query.where('chain', '==', options.chain);
  query = query.orderBy(FieldPath.documentId());
  if (options.cursor) query = query.startAfter(options.cursor);
  const snap = await query.limit(limit).get();
  const sellers = snap.docs
    .map((doc) => projectX402Seller(doc.id, doc.data()))
    .filter((s): s is X402PublicSeller => s !== null);
  const last = snap.docs[snap.docs.length - 1];
  return { sellers, next_cursor: snap.docs.length === limit && last ? last.id : null };
}

/** How a seller appears in the agent directory (`GET /v1/agents/directory`, `x402_sellers`). */
export interface X402SellerDirectoryEntry {
  readonly kind: 'x402_seller';
  readonly seller_id: string;
  readonly chain: X402SellerChain;
  readonly network: string;
  readonly address: string;
  readonly display_name: string;
  readonly description: string;
  readonly resource_urls: readonly string[];
  /** USDC always; PVT when the seller set PVT prices. */
  readonly accepts: readonly ('USDC' | 'PVT')[];
  readonly pvt_prices: ReadonlyArray<{ readonly resource: string; readonly amount_atomic: string }>;
  readonly requires_presentation: boolean;
  readonly presentation_tier: 'pe_fact' | 'reputation' | null;
  readonly settlement_count: number;
}

export function x402SellerDirectoryEntry(seller: X402PublicSeller): X402SellerDirectoryEntry {
  return {
    kind: 'x402_seller',
    seller_id: seller.seller_id,
    chain: seller.chain,
    network: seller.network,
    address: seller.address,
    display_name: seller.display_name,
    description: seller.description,
    resource_urls: seller.resource_urls,
    // PVT is a Base asset; a Solana seller is paid in USDC only.
    accepts: seller.chain === 'base' && seller.pvt_prices.length > 0 ? ['USDC', 'PVT'] : ['USDC'],
    pvt_prices: seller.pvt_prices,
    requires_presentation: seller.require_presentation !== null,
    presentation_tier: seller.require_presentation?.tier ?? null,
    settlement_count: seller.settlement_count,
  };
}
