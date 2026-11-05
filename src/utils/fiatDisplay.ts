/**
 * USD display for wallet assets (item 5).
 *
 * The rule: no dollar value ever renders $0.00 because a price source failed.
 * An asset whose price is unknown renders " "; a last-known price older than
 * STALE_PRICE_AFTER_MS is shown with its age. A genuinely zero balance at a known
 * price is a real $0.00 and renders as one.
 */
import type { Asset } from '../store/walletStore';
import { timeAgo } from './timeAgo';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A market price older than this is labelled with its age. */
export const STALE_PRICE_AFTER_MS = 5 * 60 * 1000;

export const UNKNOWN_USD = '—';

function parseBalance(balance: string): number {
    const n = parseFloat(String(balance).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/** True when the asset's USD price is usable (market or peg). */
export function hasKnownPrice(asset: Pick<Asset, 'price' | 'priceStatus' | 'isPVT'>): boolean {
    if (asset.isPVT === true) return false;
    if (asset.priceStatus === 'unknown') return false;
    return Number.isFinite(asset.price) && asset.price > 0;
}

/** USD value of one asset, or null when its price is unknown. */
export function assetUsdValue(asset: Pick<Asset, 'balance' | 'price' | 'priceStatus' | 'isPVT'>): number | null {
    if (!hasKnownPrice(asset)) return null;
    return parseBalance(asset.balance) * asset.price;
}

export function formatUsd(value: number | null, fractionDigits = 2): string {
    if (value === null || !Number.isFinite(value)) return UNKNOWN_USD;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

export interface PortfolioTotal {
    /** Sum of every held asset's USD value, or null when any held asset has no known price. */
    value: number | null;
    /** Oldest market-price observation among the held assets (ms), when one is stale. */
    staleSince: number | null;
}

/**
 * The fiat total. A held asset (balance > 0, not PVT) with no known price makes
 * the total unknown ("—") rather than silently understating it.
 */
export function portfolioTotal(
    assets: ReadonlyArray<Pick<Asset, 'balance' | 'price' | 'priceStatus' | 'priceAsOf' | 'isPVT'>>,
    now: number = Date.now(),
): PortfolioTotal {
    let sum = 0;
    let unknown = false;
    let oldest: number | null = null;
    for (const asset of assets) {
        if (asset.isPVT === true) continue;
        const held = parseBalance(asset.balance) > 0;
        if (!held) continue;
        const value = assetUsdValue(asset);
        if (value === null) {
            unknown = true;
            continue;
        }
        sum += value;
        if (asset.priceStatus === 'market' && typeof asset.priceAsOf === 'number' && now - asset.priceAsOf > STALE_PRICE_AFTER_MS) {
            oldest = oldest === null ? asset.priceAsOf : Math.min(oldest, asset.priceAsOf);
        }
    }
    return { value: unknown ? null : sum, staleSince: oldest };
}

/** "Prices as of 3h ago" when the asset's market price is stale; '' when fresh or not a market price. */
export function priceAgeLabel(
    asset: Pick<Asset, 'priceStatus' | 'priceAsOf'>,
    t: Translate,
    now: number = Date.now(),
): string {
    if (asset.priceStatus !== 'market' || typeof asset.priceAsOf !== 'number') return '';
    if (now - asset.priceAsOf <= STALE_PRICE_AFTER_MS) return '';
    return t('prices.asOf', { age: timeAgo(asset.priceAsOf, t, now) });
}

/** The total's age line, or '' when every price is fresh. */
export function totalAgeLabel(total: PortfolioTotal, t: Translate, now: number = Date.now()): string {
    if (total.staleSince === null) return '';
    return t('prices.asOf', { age: timeAgo(total.staleSince, t, now) });
}
