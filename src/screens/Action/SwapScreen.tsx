import { withBiometricAction, assertBiometricAction } from '../../core/security/biometricAction';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, Modal, FlatList, KeyboardAvoidingView, Platform, ScrollView, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useWalletStore, Asset } from '../../store/walletStore';
import SwapService, { SwapQuote } from '../../core/swap/SwapService';
import type { SwapCost } from '../../core/swap/SwapEngine';
import CrossChainSwapEngine from '../../core/swap/CrossChainSwapEngine';
import { quoteSwap, swapRouteKind } from '../../core/swap/swapQuoteRouter';
import { beginSubmission, requoteApplies } from '../../core/swap/swapSubmission';
import { solanaCostRows, lamportsToSol, type SolanaCostSummary } from '../../core/swap/solanaCosts';
import { swapDestinationAssets } from '../../core/chains/solana/tokens';
import { formatSolAtLeast, formatSolHeld } from './sendAssetSelection';
import { BiometricAuthError, BiometricNotAvailableError } from '../../core/security/requireBiometric';
import SeedManager from '../../core/wallet/SeedManager';
import PriceService from '../../core/prices/PriceService';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import UserProtectionManager, { TransactionWarning } from '../../core/protection/UserProtectionManager';
import CoercionDetector from '../../core/security/CoercionDetector';
import { swapFailureKey } from '../../core/swap/swapFailureText';
import RiskEngine from '../../core/risk/RiskEngine';
import { useTheme } from '../../theme';
import TokenIcon from '../../components/TokenIcon';
import BackButton from '../../components/BackButton';
import { assetUsdValue, formatUsd, hasKnownPrice } from '../../utils/fiatDisplay';
import { canonicalizeAmount, sendDecimalsOf } from '../../core/wallet/amountInput';

/**
 * Render a fee in the most useful units we have.
 *  - $0.01 or more  → "$X.XX"
 *  - 0 < fee < $0.01 → "< $0.01"
 *  - No USD value   → token amount with up to 6 significant digits ("0.000003 ETH")
 *  - Fee is exactly 0 or invalid → "–"
 */
function formatFee(usdValue: number, tokenAmountStr: string, tokenSymbol: string): string {
    const tokenAmount = parseFloat(tokenAmountStr);
    if (usdValue >= 0.01) return `$${usdValue.toFixed(2)}`;
    if (usdValue > 0) return '< $0.01';
    if (tokenAmount > 0) {
        const sig = tokenAmount.toPrecision(2);
        // Trim trailing scientific notation if present (e.g. 1.0e-7 → 0.0000001)
        const display = Number(sig).toLocaleString('fullwide', { useGrouping: false, maximumSignificantDigits: 6 });
        return `${display} ${tokenSymbol}`;
    }
    return '–';
}

/**
 * Render a fee exactly as charged, in the token it is charged in ("0.05 USDC",
 * "0.000025 ETH"), up to 6 significant digits. "–" when zero or invalid.
 */
function formatFeeExact(tokenAmountStr: string, tokenSymbol: string): string {
    const tokenAmount = parseFloat(tokenAmountStr);
    if (!(tokenAmount > 0)) return '–';
    const display = Number(tokenAmount.toPrecision(6)).toLocaleString('fullwide', { useGrouping: false, maximumSignificantDigits: 6 });
    return `${display} ${tokenSymbol}`;
}

/** i18n key for each route cost that is not Provian's fee, by its true name. */
/**
 * The slippage every quote on this screen is requested at, in percent. The review shows the
 * quote's own slippage (the one its guaranteed minimum was checked against), never a literal.
 */
const SWAP_SLIPPAGE_PERCENT = 0.5;

const OTHER_FEE_LABEL_KEY: Record<SwapCost['kind'], string> = {
    zerox: 'swap.zeroExFee',
    lifi: 'swap.lifiFee',
    bridge: 'swap.bridgeFees',
    rent: 'swap.rentDeposit',
};

/** i18n key for each SOL cost of a swap starting on Solana, by its own name. */
const SOL_COST_LABEL_KEY: Record<ReturnType<typeof solanaCostRows>[number]['kind'], string> = {
    network: 'swap.networkFee',
    receiving: 'swap.solReceivingAccount',
    treasury: 'swap.solTreasuryAccount',
    temporary: 'swap.solTemporaryAccount',
    other: 'swap.solOtherAccounts',
};

const SwapScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { assets, address, solanaAddress } = useWalletStore(); // [Fix 9G] Get address from store
    const { colors: themeColors } = useTheme();

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const [fromAsset, setFromAsset] = useState(assets[0] ?? null);
    const [toAsset, setToAsset] = useState(assets[3] ?? assets[1] ?? null);
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quote, setQuote] = useState<SwapQuote | null>(null);
    const [quoteError, setQuoteError] = useState<string | null>(null);
    // The review opened by "Review Exchange"; only its Confirm Swap executes.
    const [reviewVisible, setReviewVisible] = useState(false);
    // [#11] Re-entrancy guard for the swap submit (the button is enabled while
    // async safety checks run, so a ref guard prevents concurrent submissions).
    const submittingRef = useRef(false);
    // [] Only the newest quote request may set the quote: an answer for a pair (or amount)
    // no longer on screen is dropped, never shown.
    const quoteSeq = useRef(0);

    // Asset Selection State
    const [isSelectorVisible, setSelectorVisible] = useState(false);
    const [selectingFor, setSelectingFor] = useState<'from' | 'to'>('from');

    // Price state
    const [fromUsdValue, setFromUsdValue] = useState<number>(0);
    const [toUsdValue, setToUsdValue] = useState<number>(0);

    // Coercion monitoring during the swap flow
    useEffect(() => {
        CoercionDetector.startMonitoring();
        return () => CoercionDetector.stopMonitoring();
    }, []);

    // Guard: no assets loaded
    if (!fromAsset || !toAsset) {
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
                <LinearGradient colors={backgroundGradient} style={StyleSheet.absoluteFill} />
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: SPACING.m }}>
                    <BackButton onPress={() => navigation.goBack()} />
                    <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600', marginLeft: SPACING.m }}>{t('swap.title')}</Text>
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl }}>
                    <Ionicons name="swap-horizontal" size={48} color={COLORS.textTertiary} />
                    <Text style={{ color: COLORS.textSecondary, fontSize: 16, marginTop: SPACING.m, textAlign: 'center' }}>
                        {t('swap.noAssets')}
                    </Text>
                    <TouchableOpacity style={{ marginTop: SPACING.l }} onPress={() => navigation.goBack()}>
                        <Text style={{ color: COLORS.primary, fontSize: 16 }}>{t('common.goBack')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // [] The route is decided by chain INEQUALITY (swapQuoteRouter): a pair across chains —
    // Solana ⇄ EVM or Base ⇄ Arbitrum ⇄ Optimism — runs in CrossChainSwapEngine (LI.FI / Mayan
    // Swift), Solana ⇄ Solana on Jupiter, and only a same-chain EVM pair on the in-app 0x engine.
    // Every route's 0.25% fee is set by the relay.
    const routeKind = swapRouteKind(fromAsset, toAsset);
    // The review names the amount that executes — the canonical form of the typed text, the same
    // value the quote was built from ("1,000" showed while 1 executed).
    const reviewPayAmount = React.useMemo(() => {
        const c = canonicalizeAmount(amount, sendDecimalsOf(fromAsset));
        return c.ok ? c.value : amount;
    }, [amount, fromAsset]);
    const onChain = (a: Asset) => t('swap.symbolOnChain', { symbol: a.symbol, chain: a.chain });
    const pairText = `${onChain(fromAsset)} → ${onChain(toAsset)}`;
    const isSwapSupported = SwapService.isSwapSupported(fromAsset.chain);
    const unsupportedReason = !isSwapSupported ? SwapService.getUnsupportedReason(fromAsset.chain) : '';

    // Fetch quote when the amount or the pair changes
    useEffect(() => {
        // [] A new pair or amount retires whatever quote was on screen at once: the screen
        // never shows a rate that is not a live quote for the exact pair and amount picked.
        const seq = ++quoteSeq.current;
        const current = () => seq === quoteSeq.current;
        setQuote(null);
        setQuoteError(null);
        setToUsdValue(0);
        // An open review belongs to the quote it showed: never carry it over to a new one.
        setReviewVisible(false);

        const fetchQuote = async () => {
            // The typed amount in canonical form (2026-10-17: a locale comma or too many
            // decimals used to reach the router as typed).
            const canonical = canonicalizeAmount(amount, sendDecimalsOf(fromAsset));
            if (!canonical.ok) {
                if (amount.trim().length > 0 && canonical.reason === 'too_many_decimals') {
                    setQuoteError(t('send.tooManyDecimals', { decimals: sendDecimalsOf(fromAsset), symbol: fromAsset.symbol }));
                }
                return;
            }
            if (!isSwapSupported) {
                return;
            }

            setQuoteLoading(true);
            try {
                // One router for every pair (swapQuoteRouter): 0x only within one EVM chain,
                // LI.FI / Mayan Swift across chains, Jupiter within Solana. Never a mock.
                const newQuote = await quoteSwap({
                    fromAsset,
                    toAsset,
                    amount: canonical.value,
                    slippage: SWAP_SLIPPAGE_PERCENT,
                    evmAddress: address,
                    solanaAddress,
                });
                if (!current()) return;
                setQuote(newQuote);
                if (!newQuote) {
                    setQuoteError(t('swap.noRoute'));
                }

                // Update USD values
                const fromPrice = await PriceService.getPrice(fromAsset.symbol);
                const toPrice = await PriceService.getPrice(toAsset.symbol);
                if (!current()) return;
                // an unknown price leaves the USD line blank (never $0.00).
                setFromUsdValue(parseFloat(canonical.value) * (fromPrice?.usd || (hasKnownPrice(fromAsset) ? fromAsset.price : 0)));
                if (newQuote) {
                    setToUsdValue(parseFloat(newQuote.netToAmount) * (toPrice?.usd || (hasKnownPrice(toAsset) ? toAsset.price : 0)));
                }
            } catch (error) {
                console.error('[SwapScreen] Quote error:', error);
                if (!current()) return;
                setQuote(null);
                setQuoteError(t('swap.quoteRetry'));
            } finally {
                if (current()) setQuoteLoading(false);
            }
        };

        const debounce = setTimeout(fetchQuote, 500);
        return () => clearTimeout(debounce);
    }, [amount, fromAsset, toAsset, isSwapSupported, routeKind, address, solanaAddress, t]); // [Fix 9H] Added isSwapSupported to deps

    // While a swap is in flight the pair and the amount are frozen: the
    // controls are disabled, and every handler refuses on its own as well.
    const openSelector = (type: 'from' | 'to') => {
        if (submittingRef.current) return;
        setSelectingFor(type);
        setSelectorVisible(true);
    };

    const sameAsset = (a: Asset, b: Asset) => a.symbol === b.symbol && a.chain === b.chain;
    const selectAsset = (asset: Asset) => {
        if (submittingRef.current) return;
        if (selectingFor === 'from') {
            // If the picked "from" is the current "to" (same symbol AND chain),
            // swap them. USDC-on-Base and USDC-on-Solana are distinct assets, so
            // selecting one as `from` while the other is `to` is a valid
            // cross-chain pair and must NOT collapse them.
            if (sameAsset(asset, toAsset)) {
                setToAsset(fromAsset);
            }
            setFromAsset(asset);
        } else {
            if (sameAsset(asset, fromAsset)) {
                setFromAsset(toAsset);
            }
            setToAsset(asset);
        }
        setSelectorVisible(false);
        setQuote(null);
    };

    const handleSwapAssets = () => {
        if (submittingRef.current) return;
        const temp = fromAsset;
        setFromAsset(toAsset);
        setToAsset(temp);
        setQuote(null);
    };

    /**
     * Run all safety checks (UserProtectionManager, RiskEngine, CoercionDetector)
     * and surface warnings as sequential alerts. Returns true if the user
     * acknowledged everything, false if anything blocked or was cancelled.
     */
    const runSafetyChecks = async (): Promise<boolean> => {
        const warnings: TransactionWarning[] = [];

        // 1. Coercion check
        CoercionDetector.recordInteraction();
        const coercion = CoercionDetector.analyze();
        if (coercion.isCoerced) {
            Alert.alert(
                t('send.unusualActivity'),
                t('swap.coercionAlert', { triggers: coercion.triggers.join(' and ').toLowerCase() })
            );
            return false;
        }

        // 2. UserProtectionManager warnings (fake token, large balance %, etc.)
        try {
            const fromBalance = parseFloat(fromAsset.balance.replace(/,/g, ''));
            const upmWarnings = await UserProtectionManager.checkForWarnings({
                action: 'swap',
                amount: parseFloat(amount) || 0,
                amountUsd: fromUsdValue,
                assetSymbol: toAsset.symbol,
                contract: toAsset.tokenAddress,
                networkId: toAsset.chainId,
                userBalance: fromBalance,
                userBalanceUsd: assetUsdValue(fromAsset) ?? 0,
            });
            warnings.push(...upmWarnings);
        } catch {
            // Non-fatal
        }

        // 3. RiskEngine - drainer + impersonation signals on the destination token
        try {
            const aggregated = await RiskEngine.calculateRiskScore({
                tx: {
                    from: address || '',
                    to: toAsset.tokenAddress || '',
                    data: '0x',
                    value: '0',
                    chainId: toAsset.chainId || 1,
                    assetSymbol: toAsset.symbol,
                },
            });
            for (const sig of aggregated.signals) {
                if (sig.score < 50) continue;
                warnings.push({
                    id: `risk_${sig.source}`,
                    severity: sig.riskLevel === 'critical' ? 'critical' : 'high',
                    title: t('send.safetyCheck'),
                    message: sig.details,
                    plainEnglish: sig.details,
                    consequences: t('swap.riskConsequences'),
                    recommendation: t('swap.riskRecommendation'),
                    canProceed: sig.riskLevel !== 'critical',
                    requiresConfirmation: true,
                });
            }
        } catch {
            // Non-fatal
        }

        // Hard-block on any !canProceed warning
        const blocking = warnings.find(w => !w.canProceed);
        if (blocking) {
            Alert.alert(blocking.title, `${blocking.plainEnglish}\n\n${blocking.recommendation}`);
            return false;
        }

        // Show remaining warnings sequentially as confirm dialogs
        for (const w of warnings) {
            const ok = await new Promise<boolean>(resolve => {
                Alert.alert(
                    w.title,
                    `${w.plainEnglish}\n\n${w.consequences}\n\n${w.recommendation}`,
                    [
                        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
                        { text: t('swap.iUnderstandContinue'), onPress: () => resolve(true) },
                    ],
                    { cancelable: false }
                );
            });
            if (!ok) return false;
        }

        return true;
    };

    /**
     * The quote is usable right now: live, unexpired, and payable. Alerts and returns false
     * otherwise. Checked when the review opens AND again on Confirm (a quote can expire while
     * the review sits open).
     */
    const quoteIsSubmittable = (q: SwapQuote | null): q is SwapQuote => {
        if (!q) {
            Alert.alert(t('common.errorTitle'), t('swap.quote_error'));
            return false;
        }

        if (q.isMock) {
            Alert.alert(
                t('swap.liveRatesUnavailable'),
                t('swap.liveRatesUnavailableMsg'),
            );
            return false;
        }

        // [#22] Don't act on a stale quote. The engine fails closed on a stale
        // quote anyway, but surface it up front so the user re-fetches a fresh
        // rate instead of submitting a rate that's no longer valid.
        if (q.validUntil && Date.now() > q.validUntil) {
            Alert.alert(t('swap.quoteExpiredTitle'), t('swap.quoteExpiredMsg'));
            return false;
        }

        // A swap starting on Solana pays every cost in SOL. When the wallet cannot cover them,
        // say exactly how much is needed instead of sending a transaction the network rejects.
        if (q.solanaCosts && !q.solanaCosts.sufficient) {
            Alert.alert(t('swap.solNeedTitle'), solNeedMessage(q.solanaCosts));
            return false;
        }
        return true;
    };

    /**
     * "Review Exchange": runs the safety checks, then opens the review. It never signs or
     * sends anything; only Confirm Swap on the review does, after a fresh Face ID.
     */
    const handleReview = async () => {
        // [#11] Guard against double-submit while the async safety checks run.
        if (submittingRef.current) return;
        if (!quoteIsSubmittable(quote)) return;

        submittingRef.current = true;
        setLoading(true);
        let safe = false;
        try {
            safe = await runSafetyChecks();
        } finally {
            submittingRef.current = false;
            setLoading(false);
        }
        if (safe) setReviewVisible(true);
    };

    const closeReview = () => {
        if (submittingRef.current) return;
        setReviewVisible(false);
    };

    /** "Confirm Swap" on the review: a fresh Face ID on every route, then the swap reviewed. */
    const handleConfirm = async () => {
        if (submittingRef.current) return;
        if (!quoteIsSubmittable(quote)) {
            setReviewVisible(false);
            return;
        }

        // What is on screen now is what executes, what a re-quote may
        // replace, and what the result names — never whatever the screen shows later.
        // The amount the quote was built from (canonical), never the raw text: the cross-chain and
        // Solana engines refuse a route whose amount differs from what was shown (// "0.50" quoted as 0.5 then failed at Confirm as swap_not_shown).
        const canonicalConfirm = canonicalizeAmount(amount, sendDecimalsOf(fromAsset));
        const shownAmount = canonicalConfirm.ok ? canonicalConfirm.value : amount;
        const sub = beginSubmission(fromAsset, toAsset, shownAmount, quoteSeq.current, quote);
        submittingRef.current = true;
        setLoading(true);
        try {
            return await withBiometricAction(t('swap.approveSwapBiometric'), async (biometricAction) => {

                // A fresh Face ID for THIS swap on every route, the same bar as a send: a session
                // left open by an earlier approval never lets a swap through without a prompt. The
                // engines reuse this explicit approval for their reads and signatures.
                try {
                    assertBiometricAction(biometricAction);
                } catch (bioErr) {
                    if (bioErr instanceof BiometricNotAvailableError) {
                        Alert.alert(t('biometric.biometricRequired'), t('swap.errorBiometricUnavailable'));
                        return;
                    }
                    if (bioErr instanceof BiometricAuthError) {
                        return; // cancelled or failed: nothing is signed, the review stays open
                    }
                    throw bioErr;
                }

                let result;
                // [] Only the 0x path can ask for a re-review; a cross-chain route never does.
                let requoteQuote: SwapQuote | undefined;
                if (quote.crossChain) {
                    // Cross-chain or Solana: execute via Jupiter, LI.FI or Mayan Swift.
                    result = await CrossChainSwapEngine.executeSwap(sub.quoteId, sub, biometricAction);
                } else {
                    // [Fix 9G] Use wallet address from store instead of hardcoded value
                    const evmResult = await SwapService.executeSwap(
                        quote,
                        address,
                        sub.fromAsset.chain, biometricAction
                    );
                    if (evmResult.requoteRequired && evmResult.freshQuote) requoteQuote = evmResult.freshQuote;
                    result = evmResult;
                }

                // The result alert shows OVER the review (an alert raised while a sheet is closing
                // can fail to appear on iOS); its buttons close the review.
                if (result.success) {
                    // [N3] The swap confirmed. If its provenance record could not be
                    // created yet (createEnvelope threw), it was durably queued for
                    // reconciliation — say so instead of an unqualified clean success.
                    const body = t('swap.swappedResult', { fromAmount: result.fromAmount, fromToken: onChain(sub.fromAsset), toAmount: result.toAmount, toToken: onChain(sub.toAsset) })
                        + (result.peDeferred ? `\n\n${t('swap.peDeferredNote')}` : '');
                    Alert.alert(
                        t('swap.successful'),
                        body,
                        [
                            { text: t('swap.viewHistory'), onPress: () => { setReviewVisible(false); navigation.navigate('TransactionHistory'); } },
                            { text: t('common.done'), onPress: () => { setReviewVisible(false); navigation.goBack(); } },
                        ]
                    );
                } else if (requoteQuote && requoteApplies(sub, quoteSeq.current, requoteQuote)) {
                    // [] The price moved while the approval confirmed and the fresh quote
                    // guarantees less than the one reviewed, so nothing was broadcast. Show the new
                    // quote in place of the old one — the open review now shows it — for a fresh
                    // review; the approval stays, so the next Confirm swaps without a second approval.
                    const was = quote.guaranteedAmount ?? quote.toAmount;
                    const fresh = requoteQuote;
                    setQuote(fresh);
                    setToUsdValue(parseFloat(fresh.netToAmount) * (hasKnownPrice(sub.toAsset) ? sub.toAsset.price : 0));
                    Alert.alert(
                        t('swap.requoteTitle'),
                        t('swap.requoteMsg', {
                            min: fresh.guaranteedAmount ?? fresh.toAmount,
                            was,
                            token: onChain(sub.toAsset),
                        }),
                    );
                } else {
                    Alert.alert(t('swap.failed'), t(swapFailureKey(result.error)), [
                        { text: t('common.ok'), onPress: () => setReviewVisible(false) },
                    ]);
                }

            }, undefined);
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('swap.execution_error'), [
                { text: t('common.ok'), onPress: () => setReviewVisible(false) },
            ]);
        } finally {
            submittingRef.current = false;
            setLoading(false);
        }
    };

    const solNeedMessage = (c: SolanaCostSummary): string =>
        t(BigInt(c.lamports.swapped) > 0n ? 'swap.solNeedMessageWithSwap' : 'swap.solNeedMessage', {
            need: formatSolAtLeast(Number(c.requiredLamports)),
            have: formatSolHeld(Number(c.balanceLamports)),
            short: formatSolAtLeast(Number(c.shortfallLamports)),
        });
    const solShort = !!quote?.solanaCosts && !quote.solanaCosts.sufficient;

    const NATIVE_SYMBOLS = ['ETH', 'MATIC', 'AVAX', 'BNB'];
    const GAS_RESERVE = 0.005; // Reserve for gas on native assets

    const handleMaxPress = () => {
        if (submittingRef.current) return;
        const balance = parseFloat(fromAsset.balance.replace(/,/g, ''));
        if (NATIVE_SYMBOLS.includes(fromAsset.symbol) && balance > GAS_RESERVE) {
            setAmount((balance - GAS_RESERVE).toString());
        } else {
            setAmount(balance.toString());
        }
    };

    const renderAssetItem = ({ item }: { item: Asset }) => (
        <TouchableOpacity
            style={styles.assetItem}
            onPress={() => selectAsset(item)}
        >
            <TokenIcon
                symbol={item.symbol}
                size={40}
                chain={item.chain}
                style={styles.assetIconPlaceholder}
            />
            <View style={styles.assetInfo}>
                <Text style={styles.assetName}>{item.name}</Text>
                <Text style={styles.assetChain}>{t('swap.symbolOnChain', { symbol: item.symbol, chain: item.chain })}</Text>
            </View>
            <View style={styles.assetRight}>
                <Text style={styles.assetBalance}>{item.balance}</Text>
                <Text style={styles.assetValue}>{formatUsd(assetUsdValue(item))}</Text>
            </View>
        </TouchableOpacity>
    );

    // [#9] Derive a real price-impact figure from the USD values we already
    // compute (value going in vs value coming out), since the 0x v2 quote does
    // not expose price impact. Null when we can't compute it (so the UI shows
    // "—" instead of a falsely reassuring 0.00%).
    const priceImpactPct: number | null =
        quote && fromUsdValue > 0 && toUsdValue > 0
            ? Math.max(0, ((fromUsdValue - toUsdValue) / fromUsdValue) * 100)
            : null;

    // The quote's full terms: shown under the amounts, and again on the review Confirm Swap
    // executes, so what is confirmed is exactly what was shown.
    const quoteDetails = quote ? (
        <View style={styles.detailsCard}>
            {/* [] The exact pair this quote is for: token AND chain, both sides. */}
            <Text style={styles.pairText} testID="swap-pair">{pairText}</Text>
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.rate')}</Text>
                <Text style={styles.detailValue}>1 {fromAsset.symbol} = {quote.rate.toFixed(6)} {toAsset.symbol}</Text>
            </View>
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.priceImpact')}</Text>
                <Text style={[styles.detailValue, priceImpactPct !== null && priceImpactPct > 1 && { color: COLORS.warning }]}>
                    {priceImpactPct !== null ? `${priceImpactPct.toFixed(2)}%` : '—'}
                </Text>
            </View>
            {quote.guaranteedAmount && (
                <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>{t('swap.minReceived')}</Text>
                    <Text style={styles.detailValue}>
                        {Number(quote.guaranteedAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {onChain(toAsset)}
                    </Text>
                </View>
            )}
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.slippage')}</Text>
                <Text style={styles.detailValue}>{`${quote.slippagePercent ?? SWAP_SLIPPAGE_PERCENT}%`}</Text>
            </View>
            {quote.solanaCosts ? (
                <>
                    {/* A swap starting on Solana: every SOL cost under its own name,
                        exactly as the relay measured the user's own transaction. */}
                    {solanaCostRows(quote.solanaCosts).map((row) => (
                        <View style={styles.detailRow} key={`sol_${row.kind}`}>
                            <Text style={styles.detailLabel}>
                                {t(SOL_COST_LABEL_KEY[row.kind], {
                                    token: row.kind === 'treasury' ? quote.provianFeeToken : toAsset.symbol,
                                })}
                            </Text>
                            <Text style={styles.detailValue}>{lamportsToSol(row.lamports)} SOL</Text>
                        </View>
                    ))}
                    <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>{t('swap.solNeeded')}</Text>
                        <Text style={[styles.detailValue, solShort && { color: COLORS.error }]}>
                            {formatSolAtLeast(Number(quote.solanaCosts.requiredLamports))} SOL
                        </Text>
                    </View>
                </>
            ) : (
                <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>{t('swap.networkFee')}</Text>
                    {/* [#10] 0x gives the gas as a native-token amount with no USD
                        oracle; LI.FI gives only USD. Show whichever is real. */}
                    <Text style={styles.detailValue}>{formatFee(quote.feeUsd, quote.feeToken ? quote.fee : '0', quote.feeToken ?? '')}</Text>
                </View>
            )}
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.provianFee')}</Text>
                <Text style={styles.detailValue}>{formatFeeExact(quote.provianFee, quote.provianFeeToken)}</Text>
            </View>
            {(quote.otherFees ?? []).map((cost) => (
                <View style={styles.detailRow} key={`cost_${cost.kind}`}>
                    <Text style={styles.detailLabel}>{t(OTHER_FEE_LABEL_KEY[cost.kind])}</Text>
                    <Text style={styles.detailValue}>
                        {cost.amount && cost.token
                            ? formatFeeExact(cost.amount, cost.token)
                            : formatFee(cost.usd ?? 0, '0', '')}
                    </Text>
                </View>
            ))}
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.route')}</Text>
                <Text style={styles.detailValue}>{quote.route.join(' → ')}</Text>
            </View>
            <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>{t('swap.provider')}</Text>
                <Text style={styles.detailValue}>{quote.provider}</Text>
            </View>
        </View>
    ) : null;

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('swap.title')}</Text>
                <TouchableOpacity style={styles.headerAction} onPress={() => navigation.navigate('TransactionHistory')}>
                    <Ionicons name="time-outline" size={24} color={themeColors.textPrimary} />
                </TouchableOpacity>
            </View>

            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
            >
            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {/* Unsupported Chain Warning */}
                {!isSwapSupported && (
                    <View style={[styles.warningBanner, { backgroundColor: themeColors.warningMuted, borderColor: themeColors.warning }]}>
                        <Ionicons name="information-circle" size={20} color={themeColors.warning} />
                        <Text style={[styles.warningText, { color: themeColors.warning }]}>{unsupportedReason}</Text>
                    </View>
                )}

                {/* From Card */}
                <View style={[styles.swapCard, { backgroundColor: themeColors.cardBackground, borderColor: themeColors.border }]}>
                    <View style={styles.cardHeader}>
                        <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('swap.from')}</Text>
                        <TouchableOpacity onPress={handleMaxPress} disabled={loading}>
                            <Text style={[styles.maxButton, { color: themeColors.accent }]}>{t('common.max')}</Text>
                        </TouchableOpacity>
                    </View>
                    <View style={styles.row}>
                        <TextInput
                            style={[styles.input, { color: themeColors.textPrimary }]}
                            placeholder="0.00"
                            placeholderTextColor={themeColors.textMuted}
                            keyboardType="numeric"
                            value={amount}
                            onChangeText={(v) => { if (!submittingRef.current) setAmount(v); }}
                            editable={isSwapSupported && !loading}
                        />
                        <TouchableOpacity
                            style={[styles.assetBadge, { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border }]}
                            onPress={() => openSelector('from')}
                            disabled={loading}
                        >
                            <View>
                                <Text style={[styles.assetText, { color: themeColors.textPrimary }]}>{fromAsset.symbol}</Text>
                                <Text style={[styles.assetChainText, { color: themeColors.textSecondary }]}>{fromAsset.chain}</Text>
                            </View>
                            <Ionicons name="chevron-down" size={16} color={themeColors.accent} />
                        </TouchableOpacity>
                    </View>
                    <View style={styles.cardFooter}>
                        <Text style={[styles.usdValue, { color: themeColors.textSecondary }]}>
                            {fromUsdValue > 0 ? `$${fromUsdValue.toFixed(2)}` : ''}
                        </Text>
                        <Text style={[styles.balanceText, { color: themeColors.textSecondary }]}>{t('swap.balanceLabel', { balance: fromAsset.balance })}</Text>
                    </View>
                    {quoteError && !quoteLoading && (
                        <TouchableOpacity
                            onPress={() => { if (submittingRef.current) return; setQuoteError(null); const cur = amount; setAmount(''); setTimeout(() => setAmount(cur), 0); }}
                            disabled={loading}
                            style={styles.quoteErrorBanner}
                        >
                            <Ionicons name="alert-circle" size={16} color={COLORS.error} />
                            <Text style={styles.quoteErrorText}>{quoteError}</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Swap Button */}
                <View style={styles.divider}>
                    <TouchableOpacity style={[styles.swapIconCircle, { backgroundColor: themeColors.cardBackground, borderColor: themeColors.border }]} onPress={handleSwapAssets} disabled={loading}>
                        <Ionicons name="swap-vertical" size={24} color={themeColors.accent} />
                    </TouchableOpacity>
                </View>

                {/* To Card */}
                <View style={[styles.swapCard, { backgroundColor: themeColors.cardBackground, borderColor: themeColors.border }]}>
                    <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('swap.to')}</Text>
                    <View style={styles.row}>
                        {quoteLoading ? (
                            <ActivityIndicator color={themeColors.accent} style={styles.input} />
                        ) : (
                            <Text style={[styles.input, { color: quote ? themeColors.textPrimary : themeColors.textMuted }]}>
                                {quote ? quote.netToAmount : '0.00'}
                            </Text>
                        )}
                        <TouchableOpacity
                            style={[styles.assetBadge, { backgroundColor: themeColors.chipBackground, borderColor: themeColors.border }]}
                            onPress={() => openSelector('to')}
                            disabled={loading}
                        >
                            <View>
                                <Text style={[styles.assetText, { color: themeColors.textPrimary }]}>{toAsset.symbol}</Text>
                                <Text style={[styles.assetChainText, { color: themeColors.textSecondary }]}>{toAsset.chain}</Text>
                            </View>
                            <Ionicons name="chevron-down" size={16} color={themeColors.accent} />
                        </TouchableOpacity>
                    </View>
                    <View style={styles.cardFooter}>
                        <Text style={[styles.usdValue, { color: themeColors.textSecondary }]}>
                            {toUsdValue > 0 ? `$${toUsdValue.toFixed(2)}` : ''}
                        </Text>
                        <Text style={[styles.rateText, { color: themeColors.textSecondary }]}>
                            {quote ? `1 ${fromAsset.symbol} = ${quote.rate.toFixed(6)} ${toAsset.symbol}` : ''}
                        </Text>
                    </View>
                </View>

                {/* Quote Details */}
                {quoteDetails}

                {/* Not enough SOL for a swap starting on Solana: the exact figure, before confirm. */}
                {quote?.solanaCosts && solShort && (
                    <View style={styles.solNeedBanner}>
                        <Ionicons name="alert-circle" size={18} color={COLORS.error} />
                        <Text style={styles.solNeedText}>{solNeedMessage(quote.solanaCosts)}</Text>
                    </View>
                )}

                {/* Swap Button */}
                <TouchableOpacity
                    style={[styles.swapButton, { backgroundColor: themeColors.primary }, (!quote || loading || !isSwapSupported || solShort) && styles.swapButtonDisabled]}
                    onPress={() => { Keyboard.dismiss(); handleReview(); }}
                    disabled={!quote || loading || !isSwapSupported || solShort}
                >
                    {loading ? (
                        <ActivityIndicator color={COLORS.background} />
                    ) : (
                        <Text style={styles.buttonText}>
                            {!isSwapSupported ? t('swap.notAvailable') : solShort ? t('swap.notEnoughSol') : quote ? t('swap.review') : t('swap.enterAmount')}
                        </Text>
                    )}
                </TouchableOpacity>
            </ScrollView>
            </KeyboardAvoidingView>

            {/* Review: opened by "Review Exchange". Only Confirm Swap here executes, after a
                fresh Face ID; while it runs, nothing on this sheet can be dismissed. */}
            <Modal
                visible={reviewVisible && !!quote}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={closeReview}
            >
                <View style={[styles.modalContainer, { backgroundColor: themeColors.background }]}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>{t('swap.review')}</Text>
                        <TouchableOpacity onPress={closeReview} disabled={loading} testID="swap-review-close">
                            <Ionicons name="close" size={24} color={COLORS.text} />
                        </TouchableOpacity>
                    </View>
                    <ScrollView contentContainerStyle={styles.reviewContent} showsVerticalScrollIndicator={false}>
                        {quote && (
                            <>
                                <View style={[styles.swapCard, { backgroundColor: themeColors.cardBackground, borderColor: themeColors.border }]}>
                                    <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('swap.reviewYouPay')}</Text>
                                    <Text style={[styles.reviewAmount, { color: themeColors.textPrimary }]} testID="swap-review-pay">
                                        {reviewPayAmount} {onChain(fromAsset)}
                                    </Text>
                                    {fromUsdValue > 0 && (
                                        <Text style={[styles.usdValue, { color: themeColors.textSecondary }]}>${fromUsdValue.toFixed(2)}</Text>
                                    )}
                                </View>
                                <View style={styles.reviewArrow}>
                                    <Ionicons name="arrow-down" size={20} color={themeColors.accent} />
                                </View>
                                <View style={[styles.swapCard, { backgroundColor: themeColors.cardBackground, borderColor: themeColors.border }]}>
                                    <Text style={[styles.label, { color: themeColors.textSecondary }]}>{t('swap.reviewYouReceive')}</Text>
                                    <Text style={[styles.reviewAmount, { color: themeColors.textPrimary }]} testID="swap-review-receive">
                                        {quote.netToAmount} {onChain(toAsset)}
                                    </Text>
                                    {toUsdValue > 0 && (
                                        <Text style={[styles.usdValue, { color: themeColors.textSecondary }]}>${toUsdValue.toFixed(2)}</Text>
                                    )}
                                </View>
                                {quoteDetails}
                                <Text style={[styles.reviewNote, { color: themeColors.textSecondary }]}>{t('swap.reviewNote')}</Text>
                            </>
                        )}
                        <TouchableOpacity
                            style={[styles.swapButton, styles.reviewConfirmButton, { backgroundColor: themeColors.primary }, loading && styles.swapButtonDisabled]}
                            onPress={handleConfirm}
                            disabled={loading}
                            testID="swap-review-confirm"
                        >
                            {loading ? (
                                <ActivityIndicator color={COLORS.background} />
                            ) : (
                                <Text style={styles.buttonText}>{t('swap.confirmSwap')}</Text>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.reviewCancelButton} onPress={closeReview} disabled={loading}>
                            <Text style={[styles.reviewCancelText, { color: themeColors.textSecondary }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                    </ScrollView>
                </View>
            </Modal>

            {/* Asset Selector Modal */}
            <Modal
                visible={isSelectorVisible}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setSelectorVisible(false)}
            >
                <View style={styles.modalContainer}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>{t('swap.selectToken')}</Text>
                        <TouchableOpacity onPress={() => setSelectorVisible(false)}>
                            <Ionicons name="close" size={24} color={COLORS.text} />
                        </TouchableOpacity>
                    </View>
                    <FlatList
                        data={selectingFor === 'to' ? swapDestinationAssets(assets) : assets}
                        keyExtractor={item => `${item.symbol}-${item.chain}`}
                        renderItem={renderAssetItem}
                        contentContainerStyle={styles.listContent}
                    />
                </View>
            </Modal>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    // Right-hand header action, sized like BackButton so the title stays centered.
    headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    content: {
        padding: SPACING.l,
        flexGrow: 1,
        paddingBottom: SPACING.xxl,
    },
    warningBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,179,0,0.12)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.m,
        gap: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.25)',
    },
    warningText: {
        color: '#E8A838',
        flex: 1,
        fontSize: 13,
    },
    swapCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
        elevation: 6,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    label: {
        color: '#8B929E',
        marginBottom: SPACING.s,
        letterSpacing: 0.3,
    },
    maxButton: {
        color: '#6BA3F0',
        fontWeight: 'bold',
        fontSize: 12,
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.s,
    },
    input: {
        fontSize: 28,
        fontWeight: 'bold',
        color: COLORS.text,
        flex: 1,
    },
    assetBadge: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#4A8EE8',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    assetText: {
        color: '#4A8EE8',
        fontWeight: 'bold',
    },
    cardFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    usdValue: {
        color: '#8B929E',
        fontSize: 14,
    },
    balanceText: {
        color: '#8B929E',
        fontSize: 12,
    },
    divider: {
        alignItems: 'center',
        marginVertical: -12,
        zIndex: 1,
    },
    swapIconCircle: {
        backgroundColor: '#111827',
        padding: 10,
        borderRadius: 22,
        borderWidth: 3,
        borderColor: '#4A8EE8',
        shadowColor: '#4A8EE8',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.4,
        shadowRadius: 8,
        elevation: 6,
    },
    rateText: {
        color: '#8B929E',
        fontSize: 12,
    },
    detailsCard: {
        marginTop: SPACING.l,
        padding: SPACING.m,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    detailLabel: {
        color: '#8B929E',
        fontSize: 13,
    },
    detailValue: {
        color: COLORS.chromeMuted,
        fontWeight: '600',
        fontSize: 13,
    },
    swapButton: {
        backgroundColor: '#4A8EE8',
        paddingVertical: SPACING.l,
        borderRadius: 28,
        alignItems: 'center',
        marginTop: 'auto',
        shadowColor: '#6BA3F0',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 8,
    },
    swapButtonDisabled: {
        backgroundColor: 'rgba(37,43,69,0.80)',
        shadowOpacity: 0,
    },
    buttonText: {
        color: 'white',
        fontSize: 18,
        fontWeight: 'bold',
    },
    modalContainer: {
        flex: 1,
        backgroundColor: '#0B0E14',
        paddingTop: 20,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    listContent: {
        padding: SPACING.m,
    },
    assetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.m,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    assetIconPlaceholder: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(18,21,26,0.70)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    assetIconText: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
    },
    assetInfo: {
        flex: 1,
    },
    assetName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    assetChain: {
        fontSize: 13,
        color: '#8B929E',
        marginTop: 2,
    },
    assetRight: {
        alignItems: 'flex-end',
    },
    assetBalance: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
    },
    assetValue: {
        fontSize: 13,
        color: '#8B929E',
        marginTop: 2,
    },
    assetChainText: {
        fontSize: 11,
        color: '#8B929E',
    },
    pairText: {
        color: COLORS.chromeMuted,
        fontWeight: '700',
        fontSize: 14,
        marginBottom: SPACING.s,
    },
    solNeedBanner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: SPACING.s,
        padding: SPACING.m,
        marginTop: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        borderWidth: 1,
        borderColor: COLORS.error,
        backgroundColor: 'rgba(255,82,82,0.08)',
    },
    solNeedText: {
        flex: 1,
        color: COLORS.error,
        fontSize: 13,
        lineHeight: 18,
    },
    quoteErrorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: SPACING.s,
        paddingVertical: SPACING.xs,
    },
    reviewContent: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxl,
    },
    reviewAmount: {
        fontSize: 24,
        fontWeight: 'bold',
        color: COLORS.text,
        marginBottom: SPACING.xs,
    },
    reviewArrow: {
        alignItems: 'center',
        marginVertical: SPACING.s,
    },
    reviewNote: {
        fontSize: 13,
        lineHeight: 18,
        marginTop: SPACING.m,
        textAlign: 'center',
    },
    reviewConfirmButton: {
        marginTop: SPACING.l,
    },
    reviewCancelButton: {
        alignItems: 'center',
        paddingVertical: SPACING.m,
        marginTop: SPACING.s,
    },
    reviewCancelText: {
        fontSize: 16,
        fontWeight: '600',
    },
    quoteErrorText: {
        fontSize: 13,
        color: COLORS.error,
    },
});

export default SwapScreen;
