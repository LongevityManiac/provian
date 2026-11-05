import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { generateCoinbaseOnRampURL } from '../../core/onramp/OnRampManager';
import OnRampReconciler from '../../core/onramp/OnRampReconciler';
import { useWalletStore, type Asset } from '../../store/walletStore';
import BalanceService from '../../core/wallet/BalanceService';
import { getActiveChains } from '../../core/chains/evm/config';
import BackButton from '../../components/BackButton';

interface BuyCryptoScreenProps {
    navigation: {
        goBack: () => void;
        navigate: (screen: string) => void;
    };
}

// The Base chain id for the active environment (mainnet 8453 in production,
// Base Sepolia 84532 on testnet builds). Coinbase Onramp delivers USDC on Base;
// hardcoding 8453 made the arrival watcher inert on testnet (review #24).
const getBaseChainId = (): number =>
    getActiveChains().find((c) => c.name.startsWith('Base'))?.chainId ?? 8453;

// Arrival watcher: poll the on-chain USDC balance for a few minutes after the
// user returns from Coinbase. The system browser gives us no in-page "success"
// event, so the real on-chain deposit is the source of truth.
const POLL_INTERVAL_MS = 18_000;
const MAX_POLLS = 10; // ~3 minutes

type Phase = 'idle' | 'starting' | 'watching' | 'received' | 'processing' | 'error';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const formatAmount = (n: number): string =>
    n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Current USDC-on-Base balance from a freshly fetched asset list. */
const readUsdcBase = (assets: Asset[], baseChainId: number): number => {
    const usdc = assets.find((a) => a.symbol === 'USDC' && a.chainId === baseChainId);
    if (!usdc) return 0;
    const n = parseFloat(usdc.balance.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};

const BuyCryptoScreen = ({ navigation }: BuyCryptoScreenProps) => {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [receivedAmount, setReceivedAmount] = useState<string>('');
    const address = useWalletStore((s) => s.address);

    // Guard against setState after the user navigates away mid-watch.
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

    const watchForArrival = useCallback(async () => {
        if (!address) return;
        for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_INTERVAL_MS);
            if (!mountedRef.current) return;
            // Reconcile against the persisted baseline. This mints exactly one
            // 'onramp' PE on arrival; if the user leaves this screen first, the
            // Wallet tab's focus handler completes the same reconciliation.
            const result = await OnRampReconciler.reconcile(address);
            if (!mountedRef.current) return;
            if (result.arrived) {
                setReceivedAmount(formatAmount(result.amountUsdc ?? 0));
                setPhase('received');
                return;
            }
        }
        // No arrival within the window. Don't claim completion - settlement
        // (especially a first-time KYC purchase) can outlast this watcher. The
        // pending record persists, so the Wallet tab reconciles it on focus.
        if (mountedRef.current) setPhase('processing');
    }, [address]);

    const startBuy = useCallback(async () => {
        if (!address) return;
        setErrorMsg(null);
        setPhase('starting');
        try {
            const url = await generateCoinbaseOnRampURL(address, {
                defaultAsset: 'USDC',
                presetFiatAmount: 50,
            });
            if (!url) {
                if (!mountedRef.current) return;
                setErrorMsg(t('buyCrypto.errorUnavailable'));
                setPhase('error');
                return;
            }

            // Baseline USDC balance so we can detect the arrival on return.
            // This MUST fail closed: if the Base balance can't be confirmed
            // (RPC failure), recording a baseline of 0 would later make the
            // reconciler attribute the user's ENTIRE pre-existing balance to
            // this purchase and mint a wildly overstated 'onramp' PE (review
            // #4). A null baseline tells the reconciler not to mint a delta it
            // can't trust, while still letting the purchase proceed.
            const baseChainId = getBaseChainId();
            let before: number | null = null;
            try {
                const { assets, failedChainIds } = await BalanceService.fetchAllBalancesDetailed(address);
                before = failedChainIds.includes(baseChainId) ? null : readUsdcBase(assets, baseChainId);
            } catch {
                before = null;
            }
            // Persist the baseline so the deposit reconciles into a PE even if
            // the user leaves this screen or the app before settlement.
            await OnRampReconciler.beginPending(address, baseChainId, before);

            // Open Coinbase in the system browser (SFSafariViewController /
            // Chrome Custom Tabs). The embedded WebView rendered a blank
            // checkout; the system browser handles Coinbase's widget and the
            // Persona KYC step reliably. Resolves when the user closes it.
            await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: 'close', showTitle: true });
            if (!mountedRef.current) return;

            // [Audit #30] The user has returned from Coinbase (an order may or may not have been placed). Re-anchor
            // the reconciliation window to NOW so it covers only on-chain settlement
            // (minutes), not the KYC/purchase time already spent inside the widget —
            // otherwise a slow first-time purchase could settle past the window and
            // never mint its 'onramp' PE. Keeps the pre-purchase baseline intact.
            await OnRampReconciler.refreshPendingWindow(address);

            setPhase('watching');
            watchForArrival();
        } catch {
            if (!mountedRef.current) return;
            setErrorMsg(t('buyCrypto.errorStart'));
            setPhase('error');
        }
    }, [address, watchForArrival, t]);

    // ── Arrival confirmed ────────────────────────────────────────────────
    if (phase === 'received') {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
                <View style={styles.header}>
                    <View style={styles.headerSpacer} />
                    <Text style={styles.headerTitle}>{t('buyCrypto.headerTitle')}</Text>
                    <View style={styles.headerSpacer} />
                </View>
                <View style={styles.content}>
                    <View style={styles.card}>
                        <View style={styles.iconContainer}>
                            <Ionicons name="checkmark-circle" size={64} color={COLORS.success} />
                        </View>
                        <Text style={styles.title}>{t('buyCrypto.fundsReceived')}</Text>
                        <Text style={styles.description}>
                            {t('buyCrypto.fundsReceivedDescription', { amount: receivedAmount })}
                        </Text>
                        <TouchableOpacity style={styles.actionButton} onPress={() => navigation.goBack()} activeOpacity={0.7}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.actionButtonGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                                <Text style={styles.actionButtonText}>{t('buyCrypto.done')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </View>
                </View>
            </SafeAreaView>
        );
    }

    // ── Watching for the deposit / slow settlement ───────────────────────
    if (phase === 'watching' || phase === 'processing') {
        const watching = phase === 'watching';
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} />
                    <Text style={styles.headerTitle}>{t('buyCrypto.headerTitle')}</Text>
                    <View style={styles.headerSpacer} />
                </View>
                <View style={styles.content}>
                    <View style={styles.card}>
                        <View style={styles.iconContainer}>
                            {watching ? (
                                <ActivityIndicator size="large" color={COLORS.primary} />
                            ) : (
                                <Ionicons name="time-outline" size={64} color={COLORS.primary} />
                            )}
                        </View>
                        <Text style={styles.title}>
                            {watching ? t('buyCrypto.lookingForPurchase') : t('buyCrypto.onItsWay')}
                        </Text>
                        <Text style={styles.description}>
                            {watching
                                ? t('buyCrypto.lookingDescription')
                                : t('buyCrypto.processingDescription')}
                        </Text>
                        <TouchableOpacity style={styles.actionButton} onPress={() => navigation.goBack()} activeOpacity={0.7}>
                            <LinearGradient colors={GRADIENTS.primary} style={styles.actionButtonGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                                <Ionicons name="wallet-outline" size={20} color="#FFFFFF" />
                                <Text style={styles.actionButtonText}>{t('buyCrypto.goToWallet')}</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </View>
                </View>
            </SafeAreaView>
        );
    }

    // ── Idle / starting / error ──────────────────────────────────────────
    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('buyCrypto.headerTitle')}</Text>
                <View style={styles.headerSpacer} />
            </View>

            <View style={styles.content}>
                {address && (
                    <View style={styles.card}>
                        <View style={styles.iconContainer}>
                            <Ionicons name="card-outline" size={64} color={COLORS.primary} />
                        </View>

                        <Text style={styles.title}>{t('buyCrypto.buyWithCoinbase')}</Text>
                        <Text style={styles.subtitle}>{t('buyCrypto.paymentOptions')}</Text>
                        <Text style={styles.description}>
                            {t('buyCrypto.buyDescription')}
                        </Text>

                        {errorMsg && <Text style={styles.inlineError}>{errorMsg}</Text>}

                        <TouchableOpacity
                            style={styles.actionButton}
                            onPress={startBuy}
                            activeOpacity={0.7}
                            disabled={phase === 'starting'}
                        >
                            <LinearGradient
                                colors={GRADIENTS.primary}
                                style={styles.actionButtonGradient}
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                            >
                                {phase === 'starting' ? (
                                    <ActivityIndicator size="small" color="#FFFFFF" />
                                ) : (
                                    <Ionicons name="flash" size={20} color="#FFFFFF" />
                                )}
                                <Text style={styles.actionButtonText}>
                                    {phase === 'starting' ? t('buyCrypto.openingCoinbase') : errorMsg ? t('buyCrypto.tryAgain') : t('buyCrypto.buyUsdc')}
                                </Text>
                            </LinearGradient>
                        </TouchableOpacity>
                    </View>
                )}

                {/* Receive fallback - always works, no provider needed */}
                <TouchableOpacity
                    style={styles.receiveRow}
                    onPress={() => navigation.navigate('Receive')}
                    activeOpacity={0.7}
                >
                    <View style={styles.receiveLeft}>
                        <Ionicons name="qr-code-outline" size={24} color="#8B929E" />
                        <Text style={styles.receiveText}>
                            {address
                                ? t('buyCrypto.receiveFallback')
                                : t('buyCrypto.receiveNoAddress')}
                        </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#8B929E" />
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    headerSpacer: {
        width: 44,
    },
    content: {
        flex: 1,
        padding: SPACING.l,
        justifyContent: 'center',
    },
    card: {
        backgroundColor: COLORS.surface,
        borderRadius: 20,
        padding: SPACING.xl,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        ...SHADOWS.card,
    },
    iconContainer: {
        marginBottom: SPACING.m,
    },
    title: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.xs,
    },
    subtitle: {
        fontSize: 15,
        color: COLORS.primary,
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    description: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: SPACING.xl,
    },
    inlineError: {
        fontSize: 13,
        color: '#F2555A',
        textAlign: 'center',
        marginBottom: SPACING.m,
    },
    actionButton: {
        borderRadius: 28,
        overflow: 'hidden',
        ...SHADOWS.card,
    },
    actionButtonGradient: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
    },
    actionButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
    receiveRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: SPACING.l,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: 'rgba(18,21,26,0.50)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.06)',
    },
    receiveLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        flex: 1,
    },
    receiveText: {
        fontSize: 14,
        color: '#8B929E',
        flex: 1,
    },
});

export default BuyCryptoScreen;
