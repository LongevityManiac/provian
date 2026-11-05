import { ActionWallet } from '../security/ActionWallet';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * CrossChainSwapEngine — every swap that is not same-chain EVM.
 *
 * Solana ⇄ Solana (any pair) → Jupiter, via the relay's POST /api/proxy/jupiter/order
 * Solana ⇄ EVM (either way) → LI.FI, via the relay's GET /api/proxy/lifi/quote
 * Base ⇄ Arbitrum ⇄ Optimism → LI.FI, the same relay route (Mayan Swift v2)
 *
 * The in-app 0x SwapEngine handles same-chain EVM swaps only. Both routes here go through the relay,
 * which sets Provian's 0.25% swap fee itself and verifies the upstream answer carries it to the
 * treasury before returning it (provian-backend core/swap/swap-fees.ts). The app never calls
 * li.quest or jup.ag directly, so no request it builds can be fee-free.
 *
 * Both aggregators are non-custodial: they return a ready source-chain transaction that WE sign
 * locally (EVM with the secp256k1 key, Solana with the ed25519 key — both biometric-gated in
 * SeedManager) and broadcast; funds land at the user's own destination address (derived from the
 * same seed). Funds are never custodied by Provian or the relay.
 *
 * Money-safety: assertWalletEnabled + biometric-gated keys, and the quote's amounts are what the
 * SendScreen-style review shows before signing. If no route exists (e.g. an illiquid token like
 * PVT), or the relay refuses the quote, the quote is null and the swap fails closed — never a
 * fabricated/mock execution.
 */

import { ethers } from 'ethers';
import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { assertWalletEnabled } from '../AppModeManager';
import SeedManager from '../wallet/SeedManager';
import solanaRpc from '../chains/solana/SolanaRpc';
import { getSolanaTxExplorerUrl } from '../chains/solana/config';
import { ALL_CHAINS } from '../chains/evm/config';
import ProxyConfig from '../../services/ProxyConfig';
import type { Asset } from '../../store/walletStore';
import type { SwapResult, SwapCost } from './SwapEngine';
import type { EnvelopeContext } from '../provenance/ProvenanceEnvelopeManager';
import { parseSolanaCosts, type SolanaCostSummary } from './solanaCosts';
import {
    SwapRouteRefusedError,
    WORMHOLE_CHAIN_BY_EVM,
    assertLifiEvmRoute,
    assertLifiMayanEvmSource,
    bytes32Of,
    type LifiEvmSourceExpectation,
} from './evmSwapGuard';
import {
    SOLANA_NATIVE_LIFI,
    ZERO_WORD,
    canonicalEvmAsset,
    decimalsFor,
    displayedBps,
    evmSourceExpectation,
    evmTokenDecimals,
    isNativeEvm,
    jupiterMint,
    lifiChainId,
    lifiTokenAddress,
    toAtomic,
} from './lifiReview';
import {
    parseLookupTableAccount,
    verifySolanaSwapTransaction,
    type SolanaRouteCheck,
    type SolanaRouteReview,
} from './solanaSwapGuard';
import { translate } from '../../i18n/translate';


/** SwapQuote-compatible object (matches SwapService.SwapQuote). */
export interface CrossChainSwapQuote {
    id: string;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    rate: number;
    priceImpact: number;
    fee: string;
    feeUsd: number;
    feeToken?: string;
    provianFee: string;
    provianFeeToken: string;
    provianFeeUsd: number;
    otherFees: SwapCost[];
    netToAmount: string;
    estimatedGas: string;
    route: string[];
    provider: string;
    validUntil: number;
    guaranteedAmount?: string;
    /** The slippage (percent) the route was requested at — the one the review shows. */
    slippagePercent: number;
    isMock?: boolean;
    /** The SOL a swap starting on Solana needs, each cost by name (relay-measured). */
    solanaCosts?: SolanaCostSummary;
    /** Marks this as a CrossChainSwapEngine quote (any Solana leg) for the facade router. */
    crossChain: true;
}

export interface CrossChainSwapParams {
    fromAsset: Asset;
    toAsset: Asset;
    amount: string;
    slippage: number; // percentage, e.g. 0.5
    evmAddress: string;
    solanaAddress: string;
}

/** The swap the screen is showing when the user taps Swap: executeSwap signs only this. */
export interface DisplayedSwap {
    fromAsset: Pick<Asset, 'chain' | 'symbol' | 'tokenAddress'>;
    toAsset: Pick<Asset, 'chain' | 'symbol' | 'tokenAddress'>;
    amount: string;
}

const sameShownAsset = (a: DisplayedSwap['fromAsset'], b: DisplayedSwap['fromAsset']): boolean =>
    a.chain === b.chain && a.symbol === b.symbol && (a.tokenAddress ?? '').toLowerCase() === (b.tokenAddress ?? '').toLowerCase();

/**
 * Why a cached route is not the swap on screen, or null when it is ( ): the
 * same source and destination asset (chain, symbol, token) and the same amount, exactly.
 */
export function displayedSwapMismatch(params: CrossChainSwapParams, shown: DisplayedSwap): string | null {
    if (!sameShownAsset(params.fromAsset, shown.fromAsset)) {
        return `the route sells ${params.fromAsset.symbol} on ${params.fromAsset.chain}, not the ${shown.fromAsset.symbol} on ${shown.fromAsset.chain} shown`;
    }
    if (!sameShownAsset(params.toAsset, shown.toAsset)) {
        return `the route buys ${params.toAsset.symbol} on ${params.toAsset.chain}, not the ${shown.toAsset.symbol} on ${shown.toAsset.chain} shown`;
    }
    if (params.amount !== shown.amount) return `the route sends ${params.amount}, not the ${shown.amount} shown`;
    return null;
}

interface LifiTransactionRequest {
    to?: string;
    data?: string;
    value?: string;
    gasPrice?: string;
    gasLimit?: string;
    chainId?: number;
    from?: string;
}

interface LifiFeeCost {
    name?: string;
    amount?: string;
    amountUSD?: string;
    included?: boolean;
    feeSplit?: { lifiFee?: string; integratorFee?: string } | null;
}

interface LifiEstimate {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    gasCosts?: Array<{ amount?: string; amountUSD?: string; token?: { symbol?: string } }>;
    feeCosts?: LifiFeeCost[];
}

interface LifiQuote {
    id?: string;
    tool?: string;
    estimate: LifiEstimate;
    transactionRequest?: LifiTransactionRequest;
    action?: { fromToken?: { decimals?: number }; toToken?: { decimals?: number } };
    /** Set by the relay after it verified the 25 bps fee to the treasury. */
    provian_fee?: { amount?: string; bps?: number };
    /** LI.FI's own fee, as the relay read it from the fee split. */
    lifi_fee?: { amount?: string };
    /** Set by the relay on a Solana-source quote. */
    solana_costs?: unknown;
}

interface JupiterOrder {
    quote: {
        inAmount: string;
        outAmount: string;
        otherAmountThreshold?: string;
        priceImpactPct?: string;
        routePlan?: Array<{ swapInfo?: { label?: string } }>;
    };
    swapTransaction: string;
    lastValidBlockHeight?: number;
    prioritizationFeeLamports?: number;
    /** The relay's fee plan: the mint the 25 bps is taken in, and from which side. */
    provian_fee?: { amount?: string; bps?: number; side?: 'input' | 'output'; mint?: string };
    solana_costs?: unknown;
}

/**
 * A cached route carries what the user reviewed (`review`, for a Solana-source transaction), so
 * execute() re-checks the exact transaction against it before signing.
 */
type CachedRoute =
    | {
          kind: 'lifi';
          quote: LifiQuote;
          params: CrossChainSwapParams;
          expiresAt: number;
          /** Solana source: what the Solana transaction is checked against. */
          review: SolanaRouteReview | null;
          /** EVM source: what the Diamond calldata is decoded and checked against. */
          evmReview: LifiEvmSourceExpectation | null;
      }
    | { kind: 'jupiter'; order: JupiterOrder; params: CrossChainSwapParams; expiresAt: number; review: SolanaRouteReview };

/** Lookup tables are read from the public cluster directly, never through the relay. */
async function loadLookupTable(key: string): Promise<string[] | null> {
    const account = await solanaRpc.getAccountInfoDirect(key);
    return account ? parseLookupTableAccount(account.owner, account.data) : null;
}

/** Run the Solana signing guard at quote time; any refusal or read failure hides the quote. */
async function solanaRouteAllowed(txBase64: string, review: SolanaRouteReview): Promise<SolanaRouteCheck | null> {
    try {
        return await verifySolanaSwapTransaction(txBase64, review, loadLookupTable);
    } catch (e) {
        console.warn('[CrossChainSwapEngine] Solana route refused:', e instanceof Error ? e.message : e);
        return null;
    }
}

function fromAtomic(atomic: string, decimals: number): string {
    return ethers.formatUnits(BigInt(atomic), decimals);
}

const isUint = (v: unknown): v is string => typeof v === 'string' && /^[0-9]+$/.test(v);

/**
 * The relay could not simulate this transaction (its own simulation failed and no funded copy
 * ran), yet its top-level figures say the wallet can afford it. Those figures cannot see accounts
 * a program opens inside the swap, and the failed simulation is itself the sign the chain would
 * reject it, so the swap is not offered. An unmeasured shortfall is still shown: the need is at
 * least that much.
 */
const unverifiedAffordable = (c: SolanaCostSummary): boolean => !c.measured && c.sufficient;

class CrossChainSwapEngine {
    private static instance: CrossChainSwapEngine;
    // Cache the relay-verified route (with the executable transaction) under a key this engine
    // mints for each answer — never the relay's quote.id ( : a late answer
    // for a stale pair carrying the same id overwrote the route behind the quote on screen), so
    // execute() signs exactly the route the user reviewed. Short TTL.
    private routeCache: Map<string, CachedRoute> = new Map();
    private routeSeq = 0;

    /** A cache key no other answer has had: a counter, the time, and randomness. */
    private newRouteKey(prefix: 'jup' | 'lifi'): string {
        this.routeSeq += 1;
        return `${prefix}_${this.routeSeq}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    static getInstance(): CrossChainSwapEngine {
        if (!CrossChainSwapEngine.instance) {
            CrossChainSwapEngine.instance = new CrossChainSwapEngine();
        }
        return CrossChainSwapEngine.instance;
    }

    /**
     * True if this pair routes through this engine: any pair whose chains differ (Solana ⇄ EVM,
     * and Base ⇄ Arbitrum ⇄ Optimism,) and Solana ⇄ Solana. Only a same-chain EVM pair is
     * the 0x engine's. Decided by chain inequality, never by whether Solana is involved: an
     * EVM ⇄ EVM pick across chains handed to 0x was quoted, and executed, on the SOURCE chain.
     */
    handlesPair(fromAsset: Pick<Asset, 'chain'>, toAsset: Pick<Asset, 'chain'>): boolean {
        return fromAsset.chain !== toAsset.chain || fromAsset.chain === 'Solana';
    }

    async getQuote(params: CrossChainSwapParams): Promise<CrossChainSwapQuote | null> {
        if (params.fromAsset.chain === 'Solana' && params.toAsset.chain === 'Solana') {
            return this.getJupiterQuote(params);
        }
        // A same-chain EVM pair is 0x's, never a bridge.
        if (params.fromAsset.chain === params.toAsset.chain) return null;
        return this.getLifiQuote(params);
    }

    // ── Solana ⇄ Solana: Jupiter via the relay (fee account + 25 bps set by the relay) ──
    private async getJupiterQuote(params: CrossChainSwapParams): Promise<CrossChainSwapQuote | null> {
        const { fromAsset, toAsset, amount, slippage } = params;
        if (!params.solanaAddress) return null;
        const fromDecimals = decimalsFor(fromAsset);
        const toDecimals = decimalsFor(toAsset);

        let order: JupiterOrder;
        try {
            const res = await ProxyConfig.proxyFetch('jupiter', 'order', {
                method: 'POST',
                body: JSON.stringify({
                    inputMint: jupiterMint(fromAsset),
                    outputMint: jupiterMint(toAsset),
                    amount: toAtomic(amount, fromDecimals),
                    slippageBps: Math.round(slippage * 100),
                    userPublicKey: params.solanaAddress,
                }),
            });
            if (!res.ok) return null; // no route, or the relay refused: fail closed
            order = (await res.json()) as JupiterOrder;
        } catch {
            return null;
        }

        const fee = order.provian_fee;
        const inAtomic = toAtomic(amount, fromDecimals);
        if (!order?.swapTransaction || !order.quote || !isUint(order.quote.outAmount) || !fee || !isUint(fee.amount)
            || !isUint(inAtomic)) {
            return null; // not a relay-verified, fee-bearing order: never show it
        }

        // The relay takes the fee in the first of USDC, SOL, the input token, the output token
        // that is in the pair; it names that mint. A mint on neither side is not
        // an answer this screen can show.
        const feeAsset = fee.mint === jupiterMint(fromAsset) ? fromAsset
            : fee.mint === jupiterMint(toAsset) ? toAsset
            : null;
        if (!feeAsset) return null;
        // What the swap needs in SOL, by name. Without it the review cannot say whether the
        // wallet can pay, so there is no quote.
        const solanaCosts = parseSolanaCosts(order.solana_costs);
        if (!solanaCosts || unverifiedAffordable(solanaCosts)) return null;
        // only a transaction the wallet would sign is shown for review.
        // The transaction must sell exactly what the user asked to sell and promise at least the
        // output this screen shows, within the slippage the user chose.
        const review: SolanaRouteReview = {
            kind: 'jupiter',
            user: params.solanaAddress,
            networkFeeLamports: BigInt(solanaCosts.lamports.network),
            slippageBps: Math.round(slippage * 100),
            jupiter: {
                inputMint: jupiterMint(fromAsset),
                outputMint: jupiterMint(toAsset),
                inAmount: BigInt(inAtomic),
                outAmount: BigInt(order.quote.outAmount),
            },
        };
        if (!(await solanaRouteAllowed(order.swapTransaction, review))) return null;
        const provianFee = fromAtomic(fee.amount, decimalsFor(feeAsset));
        const toAmount = fromAtomic(order.quote.outAmount, toDecimals);
        const guaranteed = isUint(order.quote.otherAmountThreshold)
            ? fromAtomic(order.quote.otherAmountThreshold, toDecimals)
            : toAmount;
        const networkSol = fromAtomic(solanaCosts.lamports.network, 9);
        const rate = parseFloat(amount) > 0 ? parseFloat(toAmount) / parseFloat(amount) : 0;
        const impact = parseFloat(order.quote.priceImpactPct ?? '0');
        const venues = (order.quote.routePlan ?? [])
            .map((r) => r.swapInfo?.label)
            .filter((l): l is string => typeof l === 'string' && l.length > 0);

        const quoteId = this.newRouteKey('jup');
        // A Solana blockhash lives ~60-90s; keep the review window inside it.
        const expiresAt = Date.now() + 30_000;
        this.routeCache.set(quoteId, { kind: 'jupiter', order, params, expiresAt, review });
        this.pruneCache();

        return {
            id: quoteId,
            fromToken: fromAsset.symbol,
            toToken: toAsset.symbol,
            fromAmount: amount,
            toAmount,
            rate,
            priceImpact: Number.isFinite(impact) ? impact * 100 : 0,
            fee: networkSol,
            feeUsd: 0,
            feeToken: 'SOL',
            provianFee,
            provianFeeToken: feeAsset.symbol,
            provianFeeUsd: parseFloat(provianFee) * (feeAsset.isStablecoin ? 1 : feeAsset.price || 0),
            otherFees: [], // Jupiter charges no protocol fee of its own
            netToAmount: toAmount,
            estimatedGas: networkSol,
            route: [fromAsset.symbol, ...(venues.length ? venues : ['Jupiter']), toAsset.symbol],
            provider: 'jupiter',
            validUntil: expiresAt,
            guaranteedAmount: guaranteed,
            slippagePercent: slippage,
            solanaCosts,
            crossChain: true,
        };
    }

    // ── Across chains (Solana ⇄ EVM, EVM ⇄ EVM): LI.FI via the relay (integrator + 25 bps set by the relay) ──
    private async getLifiQuote(params: CrossChainSwapParams): Promise<CrossChainSwapQuote | null> {
        const { fromAsset, toAsset, amount, slippage } = params;
        // LI.FI carries a pair only across chains : same-chain EVM is 0x's,
        // same-chain Solana is Jupiter's.
        if (fromAsset.chain === toAsset.chain) return null;
        // An EVM leg is resolved against the canonical token table on its own chain, never taken
        // from the asset list (, Unknown = Block): an unknown token has no route.
        const fromCanon = fromAsset.chain === 'Solana' ? null : canonicalEvmAsset(fromAsset);
        const toCanon = toAsset.chain === 'Solana' ? null : canonicalEvmAsset(toAsset);
        if ((fromAsset.chain !== 'Solana' && !fromCanon) || (toAsset.chain !== 'Solana' && !toCanon)) return null;
        const fromDecimals = fromCanon ? fromCanon.decimals : decimalsFor(fromAsset);
        const toDecimals = toCanon ? toCanon.decimals : decimalsFor(toAsset);

        const fromChain = lifiChainId(fromAsset);
        const toChain = lifiChainId(toAsset);
        const fromToken = lifiTokenAddress(fromAsset);
        const toToken = lifiTokenAddress(toAsset);
        const fromAmount = toAtomic(amount, fromDecimals);

        const fromAddress = fromAsset.chain === 'Solana' ? params.solanaAddress : params.evmAddress;
        const toAddress = toAsset.chain === 'Solana' ? params.solanaAddress : params.evmAddress;
        if (!fromAddress || !toAddress) {
            return null; // fail closed: both chain addresses must be known
        }

        const query = new URLSearchParams({
            fromChain: String(fromChain),
            toChain: String(toChain),
            fromToken,
            toToken,
            fromAmount,
            fromAddress,
            toAddress,
            slippage: String(slippage / 100), // LI.FI wants a 0–1 decimal
        });

        let quote: LifiQuote;
        try {
            const res = await ProxyConfig.proxyFetch('lifi', `quote?${query.toString()}`, { method: 'GET' });
            if (!res.ok) {
                // 404 = no route (illiquid pair), 502 = relay refused an unverifiable fee. Fail closed.
                return null;
            }
            quote = (await res.json()) as LifiQuote;
        } catch {
            return null;
        }

        if (!quote?.estimate?.toAmount || !quote.transactionRequest || !isUint(quote.provian_fee?.amount)) {
            return null;
        }
        // A swap starting on Solana carries its SOL needs by name; without them, no quote.
        const fromSolana = fromAsset.chain === 'Solana';
        const solanaCosts = fromSolana ? parseSolanaCosts(quote.solana_costs) : null;
        if (fromSolana && (!solanaCosts || unverifiedAffordable(solanaCosts))) return null;
        // only a transaction the wallet would sign is shown for review. The guaranteed
        // amount shown is the minimum the bridge order itself enforces, decoded from the transaction.
        const reviewedMin = quote.estimate.toAmountMin ?? quote.estimate.toAmount;
        if (!isUint(reviewedMin) || !isUint(quote.estimate.toAmount)) return null;
        // The amount the review displays as received: the bridge order's minimum must be at least
        // this less the displayed slippage, whatever toAmountMin the relay sent.
        const shownToAmount = BigInt(quote.estimate.toAmount);
        let review: SolanaRouteReview | null = null;
        let evmReview: LifiEvmSourceExpectation | null = null;
        let enforcedMin: bigint;
        if (fromSolana) {
            const txData = quote.transactionRequest.data;
            if (typeof txData !== 'string' || !solanaCosts) return null;
            const wormholeChain = WORMHOLE_CHAIN_BY_EVM[toChain];
            if (wormholeChain === undefined) return null;
            review = {
                kind: 'lifi',
                user: params.solanaAddress,
                networkFeeLamports: BigInt(solanaCosts.lamports.network),
                slippageBps: displayedBps(slippage),
                lifi: {
                    sourceMint: fromToken === SOLANA_NATIVE_LIFI ? 'native' : fromToken,
                    provianFee: BigInt(quote.provian_fee!.amount!),
                    lifiFee: isUint(quote.lifi_fee?.amount) ? BigInt(quote.lifi_fee!.amount!) : 0n,
                    treasuryDepositLamports: BigInt(solanaCosts.lamports.treasury),
                    sourceAmount: BigInt(fromAmount),
                    bridge: {
                        evmAddress: params.evmAddress,
                        wormholeChain,
                        destToken: isNativeEvm(toAsset) ? ZERO_WORD : bytes32Of(toToken),
                        destDecimals: toDecimals,
                        minOutAtomic: BigInt(reviewedMin),
                        toAmountAtomic: shownToAmount,
                    },
                },
            };
            const checked = await solanaRouteAllowed(txData, review);
            if (checked?.bridgeMinOutAtomic === undefined) return null;
            enforcedMin = checked.bridgeMinOutAtomic;
        } else {
            try {
                assertLifiEvmRoute(fromChain, quote.transactionRequest, quote.estimate.approvalAddress, !isNativeEvm(fromAsset));
                evmReview = evmSourceExpectation(params, quote.transactionRequest.value, {
                    minOutAtomic: BigInt(reviewedMin),
                    toAmountAtomic: shownToAmount,
                    provianFee: BigInt(quote.provian_fee!.amount!),
                    lifiFee: isUint(quote.lifi_fee?.amount) ? BigInt(quote.lifi_fee!.amount!) : 0n,
                });
                enforcedMin = assertLifiMayanEvmSource(fromChain, quote.transactionRequest, evmReview, evmTokenDecimals(fromChain)).minOutAtomic;
            } catch (e) {
                if (e instanceof SwapRouteRefusedError) {
                    console.warn(`[CrossChainSwapEngine] LI.FI route refused (${e.code}): ${e.message}`);
                    return null;
                }
                throw e;
            }
        }

        // The engine's own key, never quote.id ( ).
        const quoteId = this.newRouteKey('lifi');
        // LI.FI's toAmount is already net of every included fee — what the user receives.
        const toAmount = fromAtomic(quote.estimate.toAmount, toDecimals);
        const guaranteed = fromAtomic(enforcedMin.toString(), toDecimals);
        const gasUsd = (quote.estimate.gasCosts ?? []).reduce((s, g) => s + (parseFloat(g.amountUSD ?? '0') || 0), 0);
        const provianFee = fromAtomic(quote.provian_fee!.amount!, fromDecimals);
        const otherFees: SwapCost[] = [];
        if (isUint(quote.lifi_fee?.amount) && BigInt(quote.lifi_fee!.amount!) > 0n) {
            otherFees.push({ kind: 'lifi', amount: fromAtomic(quote.lifi_fee!.amount!, fromDecimals), token: fromAsset.symbol });
        }
        // Every other cost is neither Provian's nor LI.FI's. A Solana account-rent deposit
        // (LI.FI names it "Rent Exemption Deposit") is shown under its own name; the rest
        // (bridge / solver / protocol fees) together as the bridge's fees, in USD as LI.FI
        // reports them. On a Solana-source swap the relay's SOL costs name every deposit
        // exactly, so the USD rent row is not shown twice.
        const unsplit = (quote.estimate.feeCosts ?? []).filter((c) => !c.feeSplit);
        const usdOf = (cs: LifiFeeCost[]) => cs.reduce((s, c) => s + (parseFloat(c.amountUSD ?? '0') || 0), 0);
        const isRent = (c: LifiFeeCost) => /\brent\b/i.test(c.name ?? '');
        const bridgeUsd = usdOf(unsplit.filter((c) => !isRent(c)));
        const rentUsd = usdOf(unsplit.filter(isRent));
        if (bridgeUsd > 0) otherFees.push({ kind: 'bridge', usd: bridgeUsd });
        if (rentUsd > 0 && !solanaCosts) otherFees.push({ kind: 'rent', usd: rentUsd });
        const rate = parseFloat(amount) > 0 ? parseFloat(toAmount) / parseFloat(amount) : 0;

        // 30s validity, matching the EVM engine.
        const expiresAt = Date.now() + 30_000;
        this.routeCache.set(quoteId, { kind: 'lifi', quote, params, expiresAt, review, evmReview });
        this.pruneCache();

        return {
            id: quoteId,
            fromToken: fromAsset.symbol,
            toToken: toAsset.symbol,
            fromAmount: amount,
            toAmount,
            rate,
            priceImpact: 0, // LI.FI folds price impact into toAmount; not separately surfaced
            ...(solanaCosts
                ? { fee: fromAtomic(solanaCosts.lamports.network, 9), feeUsd: 0, feeToken: 'SOL' }
                : { fee: gasUsd > 0 ? `$${gasUsd.toFixed(2)}` : '—', feeUsd: gasUsd }),
            provianFee,
            provianFeeToken: fromAsset.symbol,
            provianFeeUsd: fromAsset.isStablecoin ? parseFloat(provianFee) : 0,
            otherFees,
            netToAmount: toAmount,
            estimatedGas: gasUsd > 0 ? `$${gasUsd.toFixed(2)}` : '—',
            route: [fromAsset.symbol, `${fromAsset.chain}→${toAsset.chain}`, toAsset.symbol],
            provider: quote.tool ? `lifi:${quote.tool}` : 'lifi',
            validUntil: expiresAt,
            guaranteedAmount: guaranteed,
            slippagePercent: slippage,
            ...(solanaCosts ? { solanaCosts } : {}),
            crossChain: true,
        };
    }

    /**
     * Execute the cached route for `quoteId` only if it is the swap on screen (`shown` the
     * source and destination asset and the amount the user sees). Any difference is refused
     * before the biometric prompt and the key ( ).
     */
    async executeSwap(quoteId: string, shown: DisplayedSwap, biometricAction?: BiometricAction): Promise<SwapResult> {
        assertWalletEnabled('executeCrossChainSwap');

        const cached = this.routeCache.get(quoteId);
        if (!cached) {
            throw new Error('Swap quote expired. Please request a new quote.');
        }
        if (Date.now() > cached.expiresAt) {
            this.routeCache.delete(quoteId);
            throw new Error('Swap quote expired. Please request a new quote.');
        }
        const mismatch = displayedSwapMismatch(cached.params, shown);
        if (mismatch) {
            return this.refused(new SwapRouteRefusedError('swap_not_shown', mismatch), cached.params);
        }

        return await withBiometricAction(translate('swap.approveSwapBiometric', 'Approve swap'), async (biometricAction) => {
            if (cached.kind === 'jupiter') {
                // re-check the exact transaction before the biometric prompt and the key.
                try {
                    await verifySolanaSwapTransaction(cached.order.swapTransaction, cached.review, loadLookupTable);
                } catch (e) {
                    return this.refused(e, cached.params);
                }
                assertBiometricAction(biometricAction);
                const txHash = await this.signAndSendSolana(cached.order.swapTransaction, biometricAction);
                await this.recordSwap(txHash, cached.params, biometricAction);
                return this.result(true, txHash, cached.params);
            }

            const { quote, params } = cached;
            const txReq = quote.transactionRequest;
            if (!txReq) {
                throw new Error('Swap route has no executable transaction.');
            }

            // re-check the exact transaction before the biometric prompt and the key.
            try {
                if (params.fromAsset.chain === 'Solana') {
                    if (!txReq.data) throw new Error('Solana swap transaction missing.');
                    if (!cached.review) throw new SwapRouteRefusedError('solana_review_missing', 'Solana route has no review to check against');
                    await verifySolanaSwapTransaction(txReq.data, cached.review, loadLookupTable);
                } else {
                    if (!cached.evmReview) throw new SwapRouteRefusedError('lifi_review_missing', 'EVM route has no review to check against');
                    this.assertEvmSource(txReq, quote.estimate, params, cached.evmReview);
                }
            } catch (e) {
                return this.refused(e, params);
            }

            assertBiometricAction(biometricAction);

            if (params.fromAsset.chain === 'Solana') {
                const txHash = await this.signAndSendSolana(txReq.data!, biometricAction);
                await this.recordSwap(txHash, params, biometricAction);
                return this.result(true, txHash, params);
            }
            const txHash = await this.executeEvmSource(txReq, quote.estimate, params, cached.evmReview!, biometricAction);
            await this.recordSwap(txHash, params, biometricAction);
            return this.result(true, txHash, params);

        }, biometricAction);
    }

    // ── Solana source: deserialize the relay-verified base64 tx, sign with ed25519, send ──
    private async signAndSendSolana(txBase64: string, biometricAction?: BiometricAction): Promise<string> {
        return await withBiometricAction(translate('biometricPrompts.unlockWalletKey', 'Unlock your wallet key'), async (biometricAction) => {

            const seed = await SeedManager.getSolanaSeed(biometricAction);
            let keypair: Keypair;
            try {
                keypair = Keypair.fromSeed(seed);
            } finally {
                seed.fill(0);
            }
            try {
                const raw = Buffer.from(txBase64, 'base64');
                const vtx = VersionedTransaction.deserialize(new Uint8Array(raw));
                assertBiometricAction(biometricAction);
                vtx.sign([keypair]);
                const signed = Buffer.from(vtx.serialize()).toString('base64');
                assertBiometricAction(biometricAction);
                return await solanaRpc.sendRawTransaction(signed);
            } finally {
                keypair.secretKey.fill(0);
            }

        }, biometricAction);
    }

    // ── EVM source: approve LI.FI spender if needed, then sign+broadcast ──
    /**
     * The EVM-source transaction is checked against the source chain (its Diamond is the `to` and
     * the approval spender, a stated chainId equals the source chain) and its Mayan calldata is
     * decoded against what the user reviewed.
     */
    private assertEvmSource(
        txReq: LifiTransactionRequest,
        estimate: LifiEstimate,
        params: CrossChainSwapParams,
        evmReview: LifiEvmSourceExpectation,
    ): void {
        const chainId = lifiChainId(params.fromAsset);
        assertLifiEvmRoute(chainId, txReq, estimate.approvalAddress, !isNativeEvm(params.fromAsset));
        const want = evmSourceExpectation(params, txReq.value, evmReview);
        assertLifiMayanEvmSource(chainId, txReq, want, evmTokenDecimals(chainId));
    }

    private async executeEvmSource(
        txReq: LifiTransactionRequest,
        estimate: LifiEstimate,
        params: CrossChainSwapParams,
        evmReview: LifiEvmSourceExpectation, biometricAction?: BiometricAction,
    ): Promise<string> {
        return await withBiometricAction(translate('biometricPrompts.unlockWalletKey', 'Unlock your wallet key'), async (biometricAction) => {

            const chainId = lifiChainId(params.fromAsset);
            this.assertEvmSource(txReq, estimate, params, evmReview);
            // What is approved and what is sent are the amounts the user reviewed, never the relay's.
            const want = evmSourceExpectation(params, txReq.value, evmReview);
            const chain = ALL_CHAINS.find(c => c.chainId === chainId);
            if (!chain) throw new Error(`No RPC for chain ${chainId}`);
            const provider = new ethers.JsonRpcProvider(chain.rpcUrl);

            const privateKey = await SeedManager.getEVMPrivateKey(biometricAction);
            const wallet = new ActionWallet(privateKey, biometricAction, provider);

            // ERC-20 source: ensure the LI.FI spender is approved for the amount.
            const isNativeSource = isNativeEvm(params.fromAsset);
            if (!isNativeSource && params.fromAsset.tokenAddress && estimate.approvalAddress) {
                const erc20 = new ethers.Contract(
                    params.fromAsset.tokenAddress,
                    [
                        'function allowance(address owner, address spender) view returns (uint256)',
                        'function approve(address spender, uint256 amount) returns (bool)',
                    ],
                    wallet,
                );
                const needed = want.sellAmount;
                const current: bigint = await erc20.allowance(wallet.address, estimate.approvalAddress);
                if (current < needed) {
                    const approveTx = await erc20.approve(estimate.approvalAddress, needed);
                    const approveReceipt = await approveTx.wait();
                    if (!approveReceipt || approveReceipt.status === 0) {
                        throw new Error('Token approval for swap failed');
                    }
                }
            }

            const sent = await wallet.sendTransaction({
                to: txReq.to,
                data: txReq.data,
                value: want.value,
                ...(txReq.gasLimit ? { gasLimit: BigInt(txReq.gasLimit) } : {}),
            });
            const receipt = await sent.wait();
            if (!receipt || receipt.status === 0) {
                throw new Error('Swap transaction reverted on-chain');
            }
            return sent.hash;

        }, biometricAction);
    }

    /** A route the signing guard refused: nothing was signed. Any other error propagates. */
    private refused(e: unknown, params: CrossChainSwapParams): SwapResult {
        if (!(e instanceof SwapRouteRefusedError)) throw e;
        console.warn(`[CrossChainSwapEngine] Swap refused before signing (${e.code}): ${e.message}`);
        return {
            success: false,
            error: `Swap refused: ${e.message}. Nothing was signed.`,
            fromAmount: params.amount,
            toAmount: '',
            fromToken: params.fromAsset.symbol,
            toToken: params.toAsset.symbol,
        };
    }

    /**
     * Every executed swap leaves a PE (Security Invariant #5), as a same-chain 0x swap does in
     * SwapEngine. An EVM-source swap carries its transaction hash (on Base the relay re-reads it and
     * the chain-record lane decides whether it mints); a Solana-source swap is a record (its
     * signature is not an EVM hash, so none rides). A failed PE write is queued for reconciliation,
     * never swallowed: the swap itself already happened.
     */
    private async recordSwap(txHash: string, params: CrossChainSwapParams, biometricAction?: BiometricAction): Promise<void> {
        const sourceChain = params.fromAsset.chain;
        const peInput: EnvelopeContext = {
            actionType: 'swap',
            intentText: `Swap ${params.amount} ${params.fromAsset.symbol} (${sourceChain}) for ${params.toAsset.symbol} (${params.toAsset.chain})`,
            assetSymbol: params.fromAsset.symbol,
            amount: params.amount,
            chainId: sourceChain === 'Solana' ? 'solana' : lifiChainId(params.fromAsset),
            riskScore: 20,
            riskCategory: 'low',
            policyDecision: 'allow',
            txHash,
        };
        // Loaded on use (the ChatPEEmitter pattern), so the quote side never pulls in the signer.
        const { default: ProvenanceEnvelopeManager } = await import('../provenance/ProvenanceEnvelopeManager');
        try {
            await ProvenanceEnvelopeManager.createEnvelope(peInput, biometricAction);
        } catch (peErr) {
            console.error('[CrossChainSwapEngine] PE creation failed (swap sent) - deferring for reconciliation:', peErr);
            await ProvenanceEnvelopeManager.enqueueDeferredEnvelope(peInput).catch((qErr) => {
                console.error('[CrossChainSwapEngine] Failed to queue deferred PE:', qErr);
            });
        }
    }

    private result(success: boolean, txHash: string, params: CrossChainSwapParams): SwapResult {
        return {
            success,
            transactionHash: txHash,
            fromAmount: params.amount,
            toAmount: '',
            fromToken: params.fromAsset.symbol,
            toToken: params.toAsset.symbol,
        };
    }

    /** Explorer URL for a completed swap's SOURCE transaction. */
    explorerUrlFor(quoteId: string, txHash: string): string {
        const cached = this.routeCache.get(quoteId);
        if (cached?.params.fromAsset.chain === 'Solana') {
            return getSolanaTxExplorerUrl(txHash);
        }
        const chainId = cached ? lifiChainId(cached.params.fromAsset) : 8453;
        const chain = ALL_CHAINS.find(c => c.chainId === chainId);
        return chain ? `${chain.explorerUrl}/tx/${txHash}` : txHash;
    }

    private pruneCache(): void {
        const now = Date.now();
        for (const [id, entry] of this.routeCache) {
            if (now > entry.expiresAt) this.routeCache.delete(id);
        }
    }
}

export default CrossChainSwapEngine.getInstance();
