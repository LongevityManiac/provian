import type { BiometricAction } from '../security/biometricAction';
// OnRampReconciler - durable Provenance Envelope minting for fiat on-ramp deposits.
//
// The system browser used for Coinbase Onramp gives us no in-page "success"
// event, so the on-chain USDC deposit is the only signal that a purchase
// completed. The previous design watched for that deposit with a ~3-minute
// timer that only ran while the Buy Crypto screen stayed mounted: navigating
// away (e.g. tapping "Go to Wallet") or a settlement slower than the window
// meant the funds arrived but no PE was ever minted.
//
// This module makes arrival detection durable. When a buy starts we persist a
// baseline ("pending on-ramp") record to AsyncStorage. Reconciliation then runs
// from two places - the Buy Crypto screen while it is open, and the Wallet tab
// on focus - both routed through reconcile() so a balance increase produces
// exactly one 'onramp' PE no matter which surface observes it first. The record
// is removed before the PE is created, which is what guarantees no double-mint.

import AsyncStorage from '@react-native-async-storage/async-storage';
import BalanceService from '../wallet/BalanceService';
import ProvenanceEnvelopeManager from '../provenance/ProvenanceEnvelopeManager';
import { type Asset } from '../../store/walletStore';

const PENDING_KEY = 'provian_onramp_pending';

// USDC arrivals below this delta are treated as dust/rounding, not a deposit.
const EPSILON = 1e-6;

// How long after a buy we keep attributing the next USDC increase to the
// on-ramp.
//
// [Audit #30] We cannot verify ON-DEVICE that an inbound USDC transfer actually
// originated from Coinbase: the app never learns Coinbase Onramp's on-chain
// settlement address (the relay mints the session token; settlement addresses
// rotate and are not pinned anywhere we can trust), and a wide `getLogs` source
// scan is unreliable on the free-tier RPCs the wallet uses. So the mitigation is
// to SCOPE THE PENDING BASELINE TIGHTLY (the sanctioned alternative): the window
// must be short enough that an UNRELATED USDC arrival (a friend, an agent job, a
// bridge) landing inside it is unlikely.
//
// The window is anchored at BROWSER-CLOSE (see refreshPendingWindow) — i.e. when
// the user returns from Coinbase having placed the order — NOT at the Buy button
// tap. That matters because KYC + card entry + confirmation happen INSIDE the
// widget before the order is placed and can take many minutes for a first-time
// buyer; anchoring at return means these 30 minutes cover only the on-chain
// SETTLEMENT (typically minutes), so a slow first-time purchase is not dropped
// while the misattribution surface still shrinks ~12x vs the old 6h. The
// button-tap `startedAt` is the fallback anchor if the app is killed before the
// browser closes. The baseline is also dropped on account switch and never
// minted against an unconfirmed (null) baseline. Verifying the on-chain source
// proper is a backend concern (relay ↔ Coinbase Transaction Status API), tracked
// separately.
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes (from browser-close)

// Slack subtracted from buyStartedAt when computing the relay-verification
// `sinceMs` lower bound, to absorb device↔Coinbase clock skew so the buy's
// server-side created_at is never (incorrectly) filtered out as "too old".
const VERIFY_SINCE_SLACK_MS = 15 * 60 * 1000;

interface PendingOnRamp {
    address: string;
    chainId: number;
    // Pre-purchase USDC balance. `null` means it could not be confirmed at
    // start time (RPC failure); the reconciler must NOT mint a delta against an
    // unknown baseline, or it would overstate the deposit (review #4).
    baselineUsdc: number | null;
    // Expiry clock. RE-ANCHORED to browser-close by refreshPendingWindow so the
    // 30-min window covers only on-chain settlement (see that function).
    startedAt: number;
    // Immutable button-tap time (NEVER re-anchored). Used as the relay
    // verification `sinceMs` lower bound: it precedes the Coinbase buy's
    // created_at (order-placement), whereas startedAt is re-anchored LATER and
    // would filter the real buy out. Optional for records written pre-#30.
    buyStartedAt?: number;
}

export interface ReconcileResult {
    arrived: boolean;
    amountUsdc?: number;
    // True when the relay independently confirmed the buy came from Coinbase and
    // SERVER-MINTED the verified PE (so the device did NOT mint the heuristic PE).
    // False/absent when the source-unverified on-device heuristic minted instead.
    verified?: boolean;
}

// In-process guard so a focus event and the foreground watcher can't both pass
// the balance check before either removes the record. AsyncStorage writes are
// async, so the removeItem alone is not enough to serialize two concurrent
// callers in the same JS context.
let reconciling = false;

/** Current balance for the on-ramped token (USDC) on the given chain. */
function readUsdc(assets: Asset[], chainId: number): number {
    const usdc = assets.find((a) => a.symbol === 'USDC' && a.chainId === chainId);
    if (!usdc) return 0;
    const n = parseFloat(usdc.balance.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function formatAmount(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Record the pre-purchase USDC baseline so a deposit can be reconciled later,
 * even if the app is backgrounded or the Buy Crypto screen is closed.
 */
export async function beginPending(
    address: string,
    chainId: number,
    baselineUsdc: number | null,
): Promise<void> {
    const now = Date.now();
    const record: PendingOnRamp = {
        address,
        chainId,
        baselineUsdc,
        startedAt: now,
        buyStartedAt: now, // fixed lower bound for relay verification; never re-anchored
    };
    try {
        await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(record));
    } catch {
        // Non-fatal: without the record we simply fall back to the foreground
        // watcher's in-memory baseline. The deposit itself is unaffected.
    }
}

/**
 * Reset the pending window's clock to NOW while KEEPING the pre-purchase
 * baseline. Called when the user returns from the Coinbase system browser (i.e.
 * the purchase has been placed). This re-anchors the 30-minute window to cover
 * only on-chain SETTLEMENT (minutes) instead of the whole button-tap → KYC →
 * purchase → settlement span — so a slow first-time purchase whose KYC ate most
 * of the budget isn't dropped ([Audit #30]). The button-tap `startedAt` remains
 * the fallback anchor if the app is killed before the browser closes.
 */
export async function refreshPendingWindow(address: string): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(PENDING_KEY);
        if (!raw) return;
        let record: PendingOnRamp;
        try {
            record = JSON.parse(raw) as PendingOnRamp;
        } catch {
            return;
        }
        if (record.address?.toLowerCase() !== address.toLowerCase()) return;
        record.startedAt = Date.now();
        await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(record));
    } catch {
        // Non-fatal: fall back to the button-tap anchor.
    }
}

/** True when a pending on-ramp record exists (cheap, no network). */
export async function hasPending(): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(PENDING_KEY)) !== null;
    } catch {
        return false;
    }
}

async function clearPending(): Promise<void> {
    try {
        await AsyncStorage.removeItem(PENDING_KEY);
    } catch {
        // ignore
    }
}

/**
 * Check whether a pending on-ramp deposit has landed and, if so, mint exactly
 * one 'onramp' PE for the delta. Safe to call repeatedly and from multiple
 * surfaces; returns immediately (no network) when there is nothing pending.
 */
export async function reconcile(address: string, biometricAction?: BiometricAction): Promise<ReconcileResult> {
    // Claim the guard synchronously, before the first await, so two callers in
    // the same tick (foreground watcher + Wallet focus) can't both pass the
    // balance check and double-mint.
    if (reconciling) return { arrived: false };
    reconciling = true;
    try {
        let raw: string | null;
        try {
            raw = await AsyncStorage.getItem(PENDING_KEY);
        } catch {
            return { arrived: false };
        }
        if (!raw) return { arrived: false };

        let record: PendingOnRamp;
        try {
            record = JSON.parse(raw) as PendingOnRamp;
        } catch {
            await clearPending();
            return { arrived: false };
        }

        // Drop records for a different wallet (account switched) or past the window.
        const sameAddress = record.address?.toLowerCase() === address.toLowerCase();
        const expired = Date.now() - record.startedAt > WINDOW_MS;
        if (!sameAddress || expired) {
            await clearPending();
            return { arrived: false };
        }

        // An unverified baseline (RPC failure at start time) means we cannot
        // compute a trustworthy delta. Don't mint - the funds still arrive, we
        // just decline to attribute an unknown amount to the on-ramp (review
        // #4). Keep the record until it expires in case a real baseline is
        // never establishable.
        if (record.baselineUsdc === null) {
            return { arrived: false };
        }

        let current: number;
        try {
            const { assets, failedChainIds } = await BalanceService.fetchAllBalancesDetailed(address, biometricAction);
            // If the relevant chain's balance couldn't be confirmed this tick,
            // treat it as transient and retry next focus/tick rather than
            // reading a failure-induced 0.
            if (failedChainIds.includes(record.chainId)) {
                return { arrived: false };
            }
            current = readUsdc(assets, record.chainId);
        } catch {
            return { arrived: false }; // transient RPC failure; retry next focus/tick
        }

        if (current <= record.baselineUsdc + EPSILON) {
            return { arrived: false };
        }

        const delta = current - record.baselineUsdc;

        // The funds arrived on-chain. Before minting the SOURCE-UNVERIFIED device
        // heuristic PE, ask the relay to CONFIRM the buy actually came from
        // Coinbase (#30). Only the relay can prove the source — it queries the
        // Coinbase Transaction Status API with the CDP Secret key. On a confirmed
        // settled buy the relay SERVER-MINTS the authoritative verified `onramp`
        // PE, so we clear the pending record and DO NOT mint the heuristic PE
        // (exactly one PE per buy — no double-mint / double-accrual). If the relay
        // can't verify (Coinbase not configured, offline, older relay, or no
        // matching settled tx yet), we fall through to the existing heuristic mint
        // scoped by the tight window — today's behavior, never a dropped PE.
        try {
            const RelayAPIService = (await import('../../services/RelayAPIService')).default;
            // sinceMs MUST precede the Coinbase buy's created_at (order-placement).
            // Use the immutable button-tap time (buyStartedAt), NOT the
            // browser-close-re-anchored startedAt (which is LATER than created_at
            // and would filter the real buy out), minus a clock-skew slack.
            const sinceMs = (record.buyStartedAt ?? record.startedAt) - VERIFY_SINCE_SLACK_MS;
            // Up to 2 attempts. A response lost in transit AFTER the relay already
            // server-minted the verified PE looks like `null` here; if we minted the
            // heuristic PE on that first null we'd double-count the buy. An immediate
            // retry hits the relay's transaction_id idempotency marker and returns
            // verified:true (idempotent), so the heuristic is skipped. If the relay
            // is genuinely unreachable, both attempts return null and we fall through
            // to the heuristic mint below (never a dropped PE).
            for (let attempt = 0; attempt < 2; attempt++) {
                const verdict = await RelayAPIService.verifyCoinbaseBuy(record.address, sinceMs, biometricAction);
                if (verdict?.verified) {
                    await clearPending();
                    return { arrived: true, amountUsdc: delta, verified: true };
                }
                if (verdict?.status === 'in_progress') {
                    // The buy settled on-chain (we see the delta) but Coinbase's
                    // status API hasn't flipped to SUCCESS yet (brief ledger lag).
                    // Keep the pending record and retry next tick so the relay can
                    // server-mint the VERIFIED PE — do NOT fall back to the
                    // source-unverified heuristic here (which would clear pending and
                    // let the unverified PE permanently win the race). The delta
                    // persists on-chain, so a later tick re-detects it.
                    return { arrived: false };
                }
                if (verdict?.status === 'none') {
                    // Coinbase definitively has no matching buy → this arrival isn't
                    // verifiable as a Coinbase buy → fall through to the heuristic.
                    break;
                }
                // verdict === null → relay unreachable OR a lost response after a
                // commit; loop once more to catch the committed-but-lost case.
            }
        } catch {
            // Relay unreachable / unauthenticated / no endpoint — fall back below.
        }

        // Remove the record before minting so no later call can mint again for
        // this deposit. createEnvelope is internally durable (WAL + retry
        // queue), so a transient relay failure does not lose the PE.
        await clearPending();

        await ProvenanceEnvelopeManager.createEnvelope({
            actionType: 'onramp',
            intentText: `Bought ${formatAmount(delta)} USDC via Coinbase Onramp`,
            assetSymbol: 'USDC',
            amount: String(delta),
            chainId: record.chainId,
            riskScore: 0,
            riskCategory: 'low',
            policyDecision: 'allow',
        }, biometricAction);

        return { arrived: true, amountUsdc: delta, verified: false };
    } finally {
        reconciling = false;
    }
}

export default { beginPending, refreshPendingWindow, hasPending, reconcile };
