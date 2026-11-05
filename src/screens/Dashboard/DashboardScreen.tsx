import { enumDisplayCopy } from '../../i18n/displayCopy';
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, Alert, Animated, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError } from '../../core/security/requireBiometric';
// [F19] expo-device import removed with the DEV agent-send simulator button.
import * as Clipboard from 'expo-clipboard';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useWalletStore } from '../../store/walletStore';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import { useTheme } from '../../theme';
import BalanceService from '../../core/wallet/BalanceService';
import OnRampReconciler from '../../core/onramp/OnRampReconciler';
import TokenIcon from '../../components/TokenIcon';
import BackupNotConfiguredBanner from '../../components/BackupNotConfiguredBanner';
import FilingRecordsLine from '../../components/FilingRecordsLine';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import ParticipationCard from '../../components/ParticipationCard';
import relayService from '../../services/RelayAPIService';
import type { PVTAccrual, LinkedAgent } from '../../services/RelayAPIService';
import { deriveAgentStatus, type AgentStatusTone } from '../../core/agents/agentStatus';
import { useAttentionCount } from '../../core/attention/useAttentionCount';
import TransactionHistoryService, { isApprovalScanEnabled } from '../../core/history/TransactionHistoryService';
import type { Transaction } from '../../core/history/TransactionHistoryService';
import { displayBalance } from '../../utils/displayBalance';
import { assetUsdValue, formatUsd, portfolioTotal, priceAgeLabel, totalAgeLabel } from '../../utils/fiatDisplay';

const DashboardScreen = ({ navigation }: any) => {
    const {
        assets,
        isLockdownActive,
        isOffline,
        transactionQueue,
        clearQueue,
        userName,
        address,
        solanaAddress
    } = useWalletStore();
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    const bio = useBiometricLabel();

    // FIX: L-3 - Track whether this is the user's first visit to the dashboard
    // so we can show "Welcome" instead of "Welcome back".
    const [isFirstVisit, setIsFirstVisit] = React.useState(true);
    React.useEffect(() => {
        // After the first render, mark as returning user for subsequent focuses
        const timer = setTimeout(() => setIsFirstVisit(false), 5000);
        return () => clearTimeout(timer);
    }, []);

    // / item 4: the attention bell — how many items need the human's action right now. The
    // SAME shared count as the Wallet-tab badge: loaded on mount, every 30 s, on app foreground, on
    // any push (requestAttentionRefresh), and on this screen's focus. Degrades to the last count.
    const { count: attentionCount, refresh: refreshAttention } = useAttentionCount();
    useFocusEffect(
        React.useCallback(() => {
            refreshAttention();
        }, [refreshAttention]),
    );

    // Fetch real on-chain balances when screen focuses
    const [isLoadingBalances, setIsLoadingBalances] = React.useState(false);
    const [balanceError, setBalanceError] = React.useState<string | null>(null);
    // D-7 fix: Track when balances were last successfully fetched
    const [lastBalanceUpdate, setLastBalanceUpdate] = React.useState<number | null>(null);

    useFocusEffect(
        useCallback(() => {
            if (address) {
                setIsLoadingBalances(true);
                setBalanceError(null);
                BalanceService.fetchAllBalancesDetailed(address)
                    .then(({ failedChainIds }) => {
                        setLastBalanceUpdate(Date.now());
                        // Some chains' RPCs failed: their balances are preserved
                        // from the prior snapshot, so warn the user the total may
                        // be out of date instead of showing a confidently-wrong
                        // figure with a fresh timestamp (review #5).
                        if (failedChainIds.length > 0) {
                            setBalanceError(t('dashboard.balanceOutdated'));
                        }
                    })
                    .catch((err: any) => {
                        console.warn('[Dashboard] Balance fetch failed:', err?.message);
                        setBalanceError(t('dashboard.balanceLoadFailed'));
                    })
                    .finally(() => setIsLoadingBalances(false));
                // Mint the on-ramp PE for any deposit that landed after the user
                // left the Buy Crypto screen. No-op (no network) when nothing is
                // pending; the reconciler dedupes so this never double-mints.
                OnRampReconciler.reconcile(address).catch(() => {});
            }
        }, [address, t])
    );

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const cardGradient = GRADIENTS.balanceCardGlow;

    // Value-free record data for the participation card.
    const [pvtAccrual, setPvtAccrual] = useState<PVTAccrual | null>(null);
    // Distinguish "still loading" (null, no error) from "load failed" (error)
    // from a real record. A failed fetch must NOT render as a confident zero —
    // see the 2026-08-12 incident, where a rate-limit storm made every read fail
    // and the card would have shown "0" as if the user had earned nothing.
    const [pvtLoadError, setPvtLoadError] = useState(false);
    const [pvtRefreshing, setPvtRefreshing] = useState(false);

    const loadParticipation = useCallback(async () => {
        setPvtRefreshing(true);
        setPvtAccrual(null);
        setPvtLoadError(false);
        try {
            const data = await relayService.getPVTAccrual();
            setPvtAccrual(data);
            setPvtLoadError(data === null);
        } catch {
            setPvtLoadError(true);
        } finally {
            setPvtRefreshing(false);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            void loadParticipation();
        }, [loadParticipation])
    );

    // Recent crypto transactions for the Wallet tab activity section.
    //
    // [Wallet/Abundance split] The Wallet tab shows ON-CHAIN crypto activity
    // - sends, receives, swaps, approvals - sourced from
    // TransactionHistoryService (Alchemy via the backend proxy). PEs no
    // longer appear in this section. PEs (including PEs that were generated
    // by these same crypto sends) live in the Abundance tab via
    // MyProvenanceDashboardScreen → PVTDetail.
    //
    // Why split: a crypto user looking at their wallet expects to see real
    // money movements with hashes and amounts, not provenance envelopes.
    // A user reviewing their participation record doesn't need raw tx
    // detail noise. The two views serve different audiences and now have
    // dedicated screens for each.
    const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([]);

    useFocusEffect(
        useCallback(() => {
            (async () => {
                if (!address) return;
                try {
                    const txAddresses = {
                        Base: address,
                        Arbitrum: address,
                        Optimism: address,
                        Solana: solanaAddress || '',
                    };
                    const result = await TransactionHistoryService.getTransactions(txAddresses, { limit: 3 });
                    setRecentTransactions(result.items ?? []);
                } catch { /* non-critical */ }
            })();
        }, [address, solanaAddress])
    );

    // the human's linked agents, for the first-class "Your Agents" card
    // (the one-tap path to see/manage an agent). liveness comes from the
    // linked record's capture heartbeat — relay sessions no longer exist.
    const [linkedAgents, setLinkedAgents] = useState<LinkedAgent[]>([]);

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            relayService.getLinkedAgents()
                .then(({ linked_agents }) => {
                    if (cancelled) return;
                    setLinkedAgents(linked_agents ?? []);
                })
                .catch(() => { /* card degrades to hidden on load failure */ });
            return () => { cancelled = true; };
        }, [])
    );

    const [addressCopied, setAddressCopied] = useState(false);

    // PVT9 is now a live, sendable wallet asset (, human PVT spendability).
    // Include the real PVT balance (isPVT, injected by BalanceService from the
    // relay reader) while still excluding any stale legacy `PVT`-symbol rows that
    // predate the reader wiring and carry no on-chain balance.
    const walletAssets = assets
        .filter((asset) => asset.isPVT === true || asset.symbol.toUpperCase() !== 'PVT')
        // PVT leads the assets scroller (far left) — it is the protocol's value
        // token and gets top billing on the wallet page. sort() runs on the new
        // array from filter() (never the store's `assets`), and is stable in
        // Hermes/modern engines, so every non-PVT asset keeps its prior order.
        .sort((a, b) => (b.isPVT ? 1 : 0) - (a.isPVT ? 1 : 0));
    // PVT has no USD price oracle, so it is deliberately excluded from the fiat
    // total. a held asset with no known price makes the total " " (never
    // an understated or $0.00 figure); last-known prices carry their age.
    const fiatTotal = portfolioTotal(walletAssets);
    const fiatTotalAge = totalAgeLabel(fiatTotal, t);

    // Chain accent colors for the asset card's left rail
    const getChainColor = (chain: string): string => {
        const chainColors: Record<string, string> = {
            Ethereum: '#627EEA',
            Base: '#0052FF',
            Arbitrum: '#28A0F0',
            Optimism: '#FF0420',
            Solana: '#14F195',
        };
        return chainColors[chain] || COLORS.primary;
    };

    // N-4: Real queue sync - warn user that queued txs require re-signing since
    // we can't persist signed raw transactions (private key would need to be
    // held in memory). Clearing the queue is the correct behavior because the
    // offline-queued records are _intents_, not signed transactions.
    const handleSync = async () => {
        const count = transactionQueue.length;
        Alert.alert(
            t('dashboard.syncQueuedTitle'),
            t('dashboard.syncQueuedMessage', { count, plural: count !== 1 ? 's' : '' }),
            [
                { text: t('dashboard.keepInQueue'), style: 'cancel' },
                {
                    text: t('dashboard.clearQueueAction'),
                    onPress: () => {
                        clearQueue();
                        Alert.alert(t('dashboard.queueCleared'), t('dashboard.queueClearedMsg'));
                    },
                },
            ],
        );
    };

    // [F19] handleTestAgentTransaction (DEV agent-send simulator) removed.

    // a status tone → theme color, shared with the "Your Agents" card.
    const agentToneColor = (tone: AgentStatusTone): string =>
        tone === 'positive' ? COLORS.success : tone === 'warning' ? COLORS.warning : themeColors.textSecondary;

    // the first-class "Your Agents" card — the ONE obvious tap from the
    // Wallet home to see/manage an agent (the operator’s decided placement). Lands
    // directly on the agent (AgentDetail if one, AgentHub if several). When no
    // agent is linked, it stays a discoverable "connect an agent" entry.
    const renderYourAgentsCard = () => {
        if (linkedAgents.length === 0) {
            return (
                <TouchableOpacity
                    style={styles.agentsCard}
                    onPress={() => navigation.navigate('ConnectAgent', { mode: 'agent' })}
                    activeOpacity={0.85}
                >
                    <View style={styles.agentsIcon}>
                        <Ionicons name="hardware-chip" size={20} color={COLORS.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={[styles.agentsTitle, { color: themeColors.textPrimary }]}>{t('yourAgents.connectTitle')}</Text>
                        <Text style={[styles.agentsSubtitle, { color: themeColors.textSecondary }]} numberOfLines={2}>{t('yourAgents.connectSubtitle')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={themeColors.textSecondary} />
                </TouchableOpacity>
            );
        }

        const primary = linkedAgents[0];
        const status = deriveAgentStatus({ linked: primary });
        const goToPrimary = () => {
            if (linkedAgents.length > 1) {
                navigation.navigate('AgentHub');
            } else {
                navigation.navigate('AgentDetail', { agentId: primary.agent_id });
            }
        };

        return (
            <TouchableOpacity style={styles.agentsCard} onPress={goToPrimary} activeOpacity={0.85}>
                <View style={styles.agentsIcon}>
                    <Ionicons name="hardware-chip" size={20} color={COLORS.primary} />
                </View>
                <View style={{ flex: 1 }}>
                    <View style={styles.agentsTitleRow}>
                        <Text style={[styles.agentsTitle, { color: themeColors.textPrimary }]}>{t('yourAgents.title')}</Text>
                        {linkedAgents.length > 1 && (
                            <Text style={[styles.agentsManage, { color: COLORS.primary }]}>{t('yourAgents.manage')}</Text>
                        )}
                    </View>
                    <View style={styles.agentsMetaRow}>
                        <Text style={[styles.agentsName, { color: themeColors.textPrimary }]} numberOfLines={1}>
                            {primary.display_name || primary.agent_id}
                        </Text>
                        <View style={[styles.agentsStatusDot, { backgroundColor: agentToneColor(status.tone) }]} />
                        <Text style={[styles.agentsStatusText, { color: agentToneColor(status.tone) }]}>{t(status.labelKey)}</Text>
                    </View>
                    <Text style={[styles.agentsSubtitle, { color: themeColors.textSecondary }]} numberOfLines={1}>
                        {t('yourAgents.peCount', { count: primary.pe_count })}
                        {linkedAgents.length > 1 ? ` · ${t('yourAgents.andMore', { count: linkedAgents.length - 1 })}` : ''}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={themeColors.textSecondary} />
            </TouchableOpacity>
        );
    };


    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <ScrollView contentContainerStyle={styles.scrollContent}
                refreshControl={<RefreshControl refreshing={pvtRefreshing} onRefresh={loadParticipation} tintColor={COLORS.primary} />}>
                {/* 1. Header */}
                <View style={styles.header}>
                    <View style={styles.headerLeft}>
                        <Image
                            source={require('../../../assets/images/provian-logo.png')}
                            style={{ width: 32, height: 32, marginRight: SPACING.s }}
                            resizeMode="contain"
                        />
                        <View style={{ flexShrink: 1 }}>
                            {(userName || address) ? (
                                <>
                                    <Text style={[styles.greeting, { color: themeColors.textSecondary }]}>{isFirstVisit ? t('dashboard.greetingFirst', { defaultValue: 'Welcome' }) : t('dashboard.greeting')}</Text>
                                    {userName ? (
                                        <Text style={[styles.username, { color: themeColors.textPrimary }]} numberOfLines={1}>{userName}</Text>
                                    ) : (
                                        <TouchableOpacity
                                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}
                                            onPress={async () => {
                                                await Clipboard.setStringAsync(address);
                                                setAddressCopied(true);
                                                setTimeout(() => setAddressCopied(false), 1500);
                                            }}
                                            activeOpacity={0.7}
                                        >
                                            <Text
                                                style={[styles.username, { color: themeColors.textPrimary, flexShrink: 1 }]}
                                                numberOfLines={1}
                                                adjustsFontSizeToFit
                                                minimumFontScale={0.7}
                                            >
                                                {addressCopied ? t('dashboard.copied') : `${address.slice(0, 6)}...${address.slice(-4)}`}
                                            </Text>
                                            {!addressCopied && (
                                                <Ionicons name="copy-outline" size={14} color={COLORS.textMuted} />
                                            )}
                                        </TouchableOpacity>
                                    )}
                                </>
                            ) : (
                                <Text style={[styles.username, { color: themeColors.textPrimary }]}>{isFirstVisit ? t('dashboard.greetingFirst', { defaultValue: 'Welcome' }) : t('dashboard.greeting')}</Text>
                            )}
                        </View>
                    </View>
                    <View style={styles.headerRight}>
                        {isLockdownActive && (
                            <TouchableOpacity onPress={() => navigation.navigate('Lockdown')}>
                                <View style={[styles.statusBadge, { backgroundColor: COLORS.error }]}>
                                    <Text style={styles.statusText}>{t('dashboard.lockdownBadge')}</Text>
                                </View>
                            </TouchableOpacity>
                        )}
                        {/* attention bell: one tap to everything needing action, badge-counted. */}
                        <TouchableOpacity
                            style={styles.bellBtn}
                            onPress={() => navigation.navigate('AttentionCenter')}
                            accessibilityRole="button"
                            accessibilityLabel={t('attention.title')}
                        >
                            <Ionicons name="notifications-outline" size={22} color={COLORS.textSecondary} />
                            {attentionCount > 0 && (
                                <View style={styles.bellBadge}>
                                    <Text style={styles.bellBadgeText}>{attentionCount > 9 ? '9+' : attentionCount}</Text>
                                </View>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.profileBtn} onPress={() => navigation.navigate('ProfileEdit')}>
                            <Ionicons name="person" size={20} color={COLORS.text} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                            <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Offline Banner */}
                {isOffline && (
                    <View style={styles.offlineBanner}>
                        <Ionicons name="cloud-offline" size={20} color={COLORS.warning} />
                        <Text style={styles.offlineText}>{t('offline.banner')}</Text>
                    </View>
                )}

                {/* Records from the person's agents being filed right now (quiet; gone when done). */}
                <FilingRecordsLine />

                {/* Backup not configured: shown when onboarding was skipped */}
                <BackupNotConfiguredBanner
                    onPress={() => navigation.navigate('CloudBackupConfirm', { fromSettings: true })}
                />

                {/* Sync Button */}
                {!isOffline && transactionQueue.length > 0 && (
                    <TouchableOpacity style={styles.syncButton} onPress={handleSync}>
                        <Ionicons name="sync" size={20} color="white" />
                        <Text style={styles.syncText}>{t('offline.sync', { count: transactionQueue.length })}</Text>
                    </TouchableOpacity>
                )}

                {/* 2. Participation Card */}
                <ParticipationCard
                    pvtAccrual={pvtAccrual}
                    loadError={pvtLoadError}
                    onRetry={loadParticipation}
                    onPress={() => navigation.navigate('MyProvenance')}
                />

                {/* 3. Agent Status Bar */}

                {/* 3.5 Your Agents — first-class one-tap path to see/manage an agent */}
                {renderYourAgentsCard()}

                {/* 4. Balance Card */}
                <View style={[
                    styles.balanceCard,
                    isLockdownActive && styles.balanceCardLocked,
                ]}>
                    <LinearGradient
                        colors={cardGradient}
                        style={StyleSheet.absoluteFill}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                    />
                    <View>
                        <Text style={[styles.balanceLabel, { color: themeColors.textSecondary }]}>{t('dashboard.totalBalance')}</Text>
                        <Text style={[styles.balanceAmount, { color: themeColors.textPrimary }]} numberOfLines={1} adjustsFontSizeToFit>{formatUsd(fiatTotal.value)}</Text>
                        {fiatTotal.value === null ? (
                            <Text style={styles.stalenessText}>{t('prices.unavailable')}</Text>
                        ) : fiatTotalAge ? (
                            <Text style={styles.stalenessText}>{fiatTotalAge}</Text>
                        ) : null}
                        {/* D-7 fix: Show staleness indicator when balances are old or failed */}
                        {balanceError ? (
                            <Text style={styles.stalenessText}>{balanceError}</Text>
                        ) : lastBalanceUpdate && (Date.now() - lastBalanceUpdate > 5 * 60 * 1000) ? (
                            <Text style={styles.stalenessText}>{t('dashboard.updatedMinutesAgo', { count: Math.round((Date.now() - lastBalanceUpdate) / 60000) })}</Text>
                        ) : null}
                    </View>
                </View>

                {/* 5. Quick Actions grid */}
                <View style={styles.quickActionsGrid}>
                    <TouchableOpacity style={styles.quickActionCell} onPress={() => navigation.navigate('Send')} activeOpacity={0.7}>
                        <View style={styles.quickActionIcon}>
                            <Ionicons name="arrow-up" size={20} color={COLORS.primary} />
                        </View>
                        <Text style={[styles.quickActionCellLabel, { color: themeColors.textPrimary }]}>{t('dashboard.send')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.quickActionCell} onPress={() => navigation.navigate('Receive')} activeOpacity={0.7}>
                        <View style={styles.quickActionIcon}>
                            <Ionicons name="arrow-down" size={20} color={COLORS.primary} />
                        </View>
                        <Text style={[styles.quickActionCellLabel, { color: themeColors.textPrimary }]}>{t('dashboard.receive')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.quickActionCell} onPress={() => navigation.navigate('Swap')} activeOpacity={0.7}>
                        <View style={styles.quickActionIcon}>
                            <Ionicons name="swap-horizontal" size={20} color={COLORS.primary} />
                        </View>
                        <Text style={[styles.quickActionCellLabel, { color: themeColors.textPrimary }]}>{t('dashboard.swap')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.quickActionCell} onPress={() => navigation.navigate('WalletConnect')} activeOpacity={0.7}>
                        <View style={styles.quickActionIcon}>
                            <Ionicons name="scan" size={20} color={COLORS.primary} />
                        </View>
                        <Text style={[styles.quickActionCellLabel, { color: themeColors.textPrimary }]}>{t('walletConnect.connect')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.quickActionCell} onPress={() => navigation.navigate('BuyCrypto')} activeOpacity={0.7}>
                        <View style={styles.quickActionIcon}>
                            <Ionicons name="card-outline" size={20} color={COLORS.primary} />
                        </View>
                        <Text style={[styles.quickActionCellLabel, { color: themeColors.textPrimary }]}>{t('dashboard.buy')}</Text>
                    </TouchableOpacity>
                    {/* Empty third column keeps the second row on the 3-column grid under space-between. */}
                    <View style={styles.quickActionSpacer} />
                </View>

                {/* [F19] DEV "Test Agent Transaction" button removed — it was the
                    only route that constructed Send with isAgentInitiated, driving an
                    agent-attributed on-chain send through first-party TransactionService
                    that bypassed evaluateCryptoTransaction and the shelved-crypto guard. */}

                {/* 7. Assets section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: themeColors.textPrimary }]}>{t('dashboard.assets')}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.assetList}>
                        {/* PVT9 now renders as a real, sendable asset card inside the
                            walletAssets loop below, fed by the relay balance
                            reader. The former informational "not deployed" tile is gone. */}
                        {walletAssets.length === 0 && !isLoadingBalances && (
                            <View style={{ padding: SPACING.xl, alignItems: 'center' }}>
                                <Ionicons name="wallet-outline" size={40} color={themeColors.textMuted} />
                                <Text style={{ color: themeColors.textSecondary, marginTop: SPACING.m, fontSize: 15, textAlign: 'center' }}>{t('dashboard.noOtherAssets')}</Text>
                            </View>
                        )}
                        {walletAssets.map((asset) => {
                            // Composite key: the same symbol (ETH, USDC, WETH) appears
                            // on multiple chains, so keying by symbol alone collides
                            // and triggers React's "two children with the same key"
                            // warning. chain:symbol is stable and unique per row.
                            //
                            // PVT is the value token: it leads the row (sorted first
                            // above) and wears the PLATINUM asset treatment — elevated
                            // surface, platinum left-rail, thicker accent — so it reads
                            // as the asset's proof mark, not just another ERC-20. The
                            // tokens are the same COLORS.platinum* the coin (PVTIcon)
                            // draws: PLATINUM OWNS THE ASSET (theme.ts header rule).
                            const isPvtCard = asset.isPVT === true;
                            return (
                            <View key={`${asset.chain}:${asset.symbol}`} style={[styles.assetCard, {
                                backgroundColor: isPvtCard ? COLORS.surfaceHighlight : themeColors.cardBackground,
                                borderColor: isPvtCard ? COLORS.platinumMuted : themeColors.border,
                            }]}>
                                {/* Accent rail is an inset bar, not a thick left border: a wide
                                    left border on a rounded card renders as a crescent. */}
                                <View style={[styles.assetRail, {
                                    backgroundColor: isPvtCard ? COLORS.platinum : getChainColor(asset.chain),
                                    width: isPvtCard ? 4 : 3,
                                }]} />
                                <View style={styles.assetHeader}>
                                    <TokenIcon
                                        symbol={asset.symbol}
                                        size={36}
                                        chain={asset.chain}
                                        showChainBadge={true}
                                        style={styles.assetIcon}
                                    />
                                    <View>
                                        <Text style={[styles.assetSymbol, { color: themeColors.textPrimary }]}>{asset.symbol}</Text>
                                        <Text style={[styles.assetChain, { color: themeColors.textSecondary }]}>{asset.chain}</Text>
                                    </View>
                                </View>
                                <Text style={[styles.assetBalance, { color: isPvtCard ? COLORS.platinum : themeColors.textPrimary }]}>{displayBalance(asset.balance)}</Text>
                                {asset.isPVT ? (
                                    // PVT has no USD price oracle — show the token name
                                    // instead of a misleading "$0.00" fiat value.
                                    <Text style={[styles.assetValue, { color: themeColors.textSecondary }]}>
                                        {t('dashboard.pvtTokenName')}
                                    </Text>
                                ) : (
                                    <Text style={[styles.assetValue, { color: themeColors.textSecondary }]} numberOfLines={1}>
                                        {formatUsd(assetUsdValue(asset))}
                                        {(assetUsdValue(asset) ?? 0) > 0 && priceAgeLabel(asset, t) ? ` · ${priceAgeLabel(asset, t)}` : ''}
                                    </Text>
                                )}
                                {asset.isStablecoin && (
                                    <View style={styles.stableBadge}>
                                        <Ionicons name="shield-checkmark" size={12} color={COLORS.success} />
                                        <Text style={styles.stableText}>{t('dashboard.stable')}</Text>
                                    </View>
                                )}
                            </View>
                            );
                        })}
                    </ScrollView>

                </View>

                {/* 8. Recent Activity - crypto transactions only */}
                {/* PEs (including PEs created by these crypto sends) live in
                       the Abundance tab. The Wallet tab is for on-chain activity
                       - sends, receives, swaps, approvals - with hashes and
                       amounts. Tap any item → TransactionDetail (block explorer
                       link, gas, full hash). Tap "See All" → TransactionHistory
                       screen with the complete crypto history. */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={[styles.sectionTitle, { color: themeColors.textPrimary }]}>{t('dashboard.recentActivity')}</Text>
                        <TouchableOpacity onPress={() => navigation.navigate('TransactionHistory')}>
                            <Text style={[styles.seeAll, { color: themeColors.primary }]}>{t('dashboard.seeAll')}</Text>
                        </TouchableOpacity>
                    </View>
                    {/*
                      Approval-scan status banner: honest signal that the
                      token-approval monitoring feature is disabled. Previously
                      the scan always ran but silently failed on Alchemy Free
                      tier (10-block eth_getLogs cap), leaving users with a
                      false sense of security. This banner appears when the
                      EXPO_PUBLIC_ALCHEMY_PAYG flag is off. Flipping the flag
                      when Alchemy PAYG is purchased hides the banner and
                      re-enables approval detection automatically.
                    */}
                    {!isApprovalScanEnabled() && (
                        <View style={[styles.historyItem, {
                            backgroundColor: themeColors.cardBackground,
                            borderColor: COLORS.warning,
                        }]}>
                            <View style={[styles.historyIcon, { backgroundColor: themeColors.surfaceHighlight }]}>
                                <Ionicons name="alert-circle-outline" size={20} color={COLORS.warning} />
                            </View>
                            <View style={styles.historyDetails}>
                                <Text style={[styles.historyTitle, { color: themeColors.textPrimary }]}>{t('dashboard.approvalMonitoringOff')}</Text>
                                <Text style={[styles.historyDate, { color: themeColors.textMuted }]} numberOfLines={2}>{t('dashboard.approvalMonitoringOffMsg')}</Text>
                            </View>
                        </View>
                    )}
                    {recentTransactions.length === 0 ? (
                        <View style={[styles.historyItem, {
                            backgroundColor: themeColors.cardBackground,
                            borderColor: themeColors.border
                        }]}>
                            <View style={[styles.historyIcon, { backgroundColor: themeColors.surfaceHighlight }]}>
                                <Ionicons name="swap-horizontal-outline" size={20} color={themeColors.textSecondary} />
                            </View>
                            <View style={styles.historyDetails}>
                                <Text style={[styles.historyTitle, { color: themeColors.textSecondary }]}>{t('dashboard.noTransactionsYet')}</Text>
                                <Text style={[styles.historyDate, { color: themeColors.textMuted }]}>{t('dashboard.noTransactionsMsg')}</Text>
                            </View>
                        </View>
                    ) : (
                        recentTransactions.map((tx) => {
                            const isReceived = tx.type === 'received';
                            const isSend = tx.type === 'sent';
                            const isSwap = tx.type === 'swap';
                            const isApprove = tx.type === 'approve';
                            // An 'earned' PVT mint is issued from the zero address,
                            // so it has no meaningful counterparty — render it as an
                            // earning, not a "received from 0x0000…".
                            const isEarned = tx.type === 'earned';
                            const shortAddr = (addr: string) =>
                                addr && addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
                            const counterparty = isEarned ? '' : isReceived ? tx.from : tx.to;
                            // the 1:1 carry of a predecessor PVT balance reads as a
                            // migration receipt, not an anonymous receive from the distributor.
                            const title = isEarned
                                ? t('dashboard.transactionEarned')
                                : isReceived
                                    ? t(tx.isMigrationReceipt ? 'dashboard.transactionMigrated' : 'dashboard.transactionReceived')
                                    : isSend
                                        ? t('dashboard.transactionSent')
                                        : isSwap
                                            ? t('dashboard.transactionSwap')
                                            : isApprove
                                                ? t('dashboard.transactionApprove')
                                                : enumDisplayCopy(tx.type);
                            // a row on the retired kernel is pre-migration history — say so.
                            const retired = tx.isRetiredPvt ? ` · ${t('dashboard.transactionRetiredPvt')}` : '';
                            const subtitle = `${displayBalance(tx.amount)} ${tx.symbol} · ${tx.chain}${retired}${counterparty ? ` · ${shortAddr(counterparty)}` : ''}`;
                            const iconName = isEarned
                                ? 'diamond'
                                : isReceived
                                    ? 'arrow-down'
                                    : isSend
                                        ? 'arrow-up'
                                        : isSwap
                                            ? 'swap-horizontal'
                                            : 'checkmark-circle-outline';
                            return (
                                <TouchableOpacity
                                    key={tx.id}
                                    style={[styles.historyItem, {
                                        backgroundColor: themeColors.cardBackground,
                                        borderColor: themeColors.border
                                    }]}
                                    onPress={() => navigation.navigate('TransactionDetail', { transaction: tx })}
                                    activeOpacity={0.7}
                                >
                                    <View style={[styles.historyIcon, { backgroundColor: themeColors.surfaceHighlight }]}>
                                        <Ionicons
                                            name={iconName}
                                            size={20}
                                            color={themeColors.textSecondary}
                                        />
                                    </View>
                                    <View style={styles.historyDetails}>
                                <Text style={[styles.historyTitle, { color: themeColors.textPrimary }]}>{title}</Text>
                                        <Text style={[styles.historyDate, { color: themeColors.textMuted }]} numberOfLines={1}>{subtitle}</Text>
                                    </View>
                                </TouchableOpacity>
                            );
                        })
                    )}
                </View>

                {/* 9. Settings Row */}
                <TouchableOpacity
                    style={styles.settingsRow}
                    onPress={() => navigation.navigate('Settings')}
                    activeOpacity={0.7}
                >
                    <Ionicons name="settings-outline" size={20} color={COLORS.text} />
                    <Text style={styles.settingsRowText}>{t('dashboard.settingsSecurity')}</Text>
                    <View style={{ flex: 1 }} />
                    <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
};


const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: 120,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.xl,
        marginTop: SPACING.s,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        marginRight: SPACING.s,
    },
    greeting: {
        fontSize: 14,
        color: COLORS.textSecondary,
        marginBottom: 4,
        letterSpacing: 1.5,
    },
    username: {
        fontSize: 22,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: SPACING.s,
    },
    bellBtn: {
        width: 44,
        height: 44,
        borderRadius: BORDER_RADIUS.round,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bellBadge: {
        position: 'absolute',
        top: 6,
        right: 6,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 4,
        backgroundColor: COLORS.error,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bellBadgeText: {
        color: 'white',
        fontSize: 11,
        fontWeight: '700',
    },
    statusBadge: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: BORDER_RADIUS.round,
        shadowColor: COLORS.error,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 8,
        elevation: 5,
    },
    statusText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 12,
        letterSpacing: 0.5,
    },
    profileBtn: {
        width: 44,
        height: 44,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: COLORS.surface,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    offlineBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.warningMuted,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: COLORS.warning,
        gap: SPACING.s,
    },
    offlineText: {
        color: COLORS.warning,
        fontWeight: 'bold',
    },
    syncButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.success,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.m,
        marginBottom: SPACING.l,
        gap: SPACING.s,
        ...SHADOWS.medium,
    },
    syncText: {
        color: 'white',
        fontWeight: 'bold',
    },

    // Agent Status Bar - compact glass pill
    agentStatusBar: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        marginBottom: SPACING.m,
        gap: SPACING.s,
    },
    // "Your Agents" first-class card
    agentsCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        marginBottom: SPACING.m,
        gap: SPACING.m,
        backgroundColor: COLORS.surface,
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    agentsIcon: {
        width: 40,
        height: 40,
        borderRadius: BORDER_RADIUS.m,
        backgroundColor: COLORS.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    agentsTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    agentsTitle: {
        fontSize: 15,
        fontWeight: '700',
    },
    agentsManage: {
        fontSize: 13,
        fontWeight: '600',
    },
    agentsMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 2,
    },
    agentsName: {
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
    agentsStatusDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    agentsStatusText: {
        fontSize: 12,
        fontWeight: '600',
    },
    agentsSubtitle: {
        fontSize: 12,
        marginTop: 2,
    },
    agentStatusEmergency: {
        backgroundColor: COLORS.error,
    },
    agentStatusPending: {
        backgroundColor: COLORS.warningMuted,
        borderWidth: 1,
        borderColor: COLORS.warning,
    },
    agentStatusActive: {
        backgroundColor: COLORS.surface,
        borderWidth: 1,
        borderColor: COLORS.border,
    },
    agentStatusNone: {
        backgroundColor: `${COLORS.primary}08`,
        borderWidth: 1,
        borderColor: `${COLORS.primary}30`,
    },
    agentStatusTextWhite: {
        color: 'white',
        fontWeight: '600',
        fontSize: 14,
    },
    agentStatusTextAmber: {
        color: COLORS.warning,
        fontWeight: '600',
        fontSize: 14,
    },
    agentStatusTextDefault: {
        color: COLORS.text,
        fontSize: 14,
    },
    agentStatusTextMuted: {
        color: COLORS.textMuted,
        fontSize: 14,
    },
    agentStatusAction: {
        color: 'rgba(255,255,255,0.8)',
        fontSize: 12,
    },
    greenDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: COLORS.success,
    },

    // Balance Card
    balanceCard: {
        padding: SPACING.xl,
        borderRadius: 22,
        marginBottom: SPACING.m,
        borderWidth: 1,
        borderColor: COLORS.border,
        overflow: 'hidden',
    },
    balanceCardLocked: {
        borderColor: COLORS.error,
        backgroundColor: COLORS.errorMuted,
    },
    balanceLabel: {
        color: COLORS.textSecondary,
        fontSize: 13,
        marginBottom: SPACING.xs,
        textTransform: 'uppercase',
        letterSpacing: 2,
        fontWeight: '600',
    },
    balanceAmount: {
        fontSize: 48,
        fontWeight: 'bold',
        color: COLORS.text,
        marginBottom: SPACING.m,
        letterSpacing: -1,
        textShadowColor: 'rgba(255, 255, 255, 0.1)',
        textShadowOffset: { width: 0, height: 2 },
        textShadowRadius: 4,
    },
    stalenessText: {
        fontSize: 11,
        color: COLORS.warning,
        marginTop: 2,
    },
    // Quick Actions - horizontal pill strip
    quickActionsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        marginBottom: SPACING.xl,
        rowGap: SPACING.s,
    },
    quickActionSpacer: {
        width: '31.5%',
    },
    quickActionCell: {
        width: '31.5%',
        alignItems: 'center',
        paddingVertical: 14,
        borderRadius: 18,
        backgroundColor: 'rgba(17,24,39,0.85)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
    },
    quickActionIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(74,142,232,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    quickActionCellLabel: {
        fontSize: 12,
        fontWeight: '600',
    },

    // DEV button
    devButton: {
        padding: SPACING.s,
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    devButtonText: {
        color: COLORS.purple,
        fontSize: 12,
        fontWeight: '600',
    },

    // Settings Row
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surface,
        padding: SPACING.l,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: COLORS.border,
        marginBottom: SPACING.xxl,
        gap: SPACING.m,
    },
    settingsRowText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
    },

    // Assets
    section: {
        marginBottom: SPACING.xxl,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
        letterSpacing: 1,
    },
    seeAll: {
        color: COLORS.primary,
        fontWeight: 'bold',
        fontSize: 13,
    },
    assetList: {
        flexGrow: 0,
        marginHorizontal: -SPACING.m,
        paddingHorizontal: SPACING.m,
    },
    assetCard: {
        backgroundColor: 'rgba(17,24,39,0.85)',
        padding: SPACING.m,
        borderRadius: 20,
        marginRight: SPACING.m,
        minWidth: 200,
        maxWidth: 280,
        // [Layout fix] Ensure asset cards in the horizontal scroller hold
        // their min/max width regardless of parent flex constraints.
        flexShrink: 0,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
        ...SHADOWS.small,
    },
    assetRail: {
        position: 'absolute',
        left: 0,
        top: SPACING.m,
        bottom: SPACING.m,
        borderTopRightRadius: 2,
        borderBottomRightRadius: 2,
    },
    assetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.m,
    },
    assetIcon: {
        marginRight: SPACING.s,
    },
    assetSymbol: {
        color: COLORS.text,
        fontWeight: 'bold',
        fontSize: 15,
    },
    assetChain: {
        color: COLORS.textSecondary,
        fontSize: 11,
    },
    assetBalance: {
        color: COLORS.text,
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 2,
    },
    assetValue: {
        color: COLORS.textSecondary,
        fontSize: 13,
    },
    stableBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: SPACING.s,
        backgroundColor: COLORS.successMuted,
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderRadius: 6,
        alignSelf: 'flex-start',
    },
    stableText: {
        color: COLORS.success,
        fontSize: 10,
        marginLeft: 4,
        fontWeight: 'bold',
    },
    // Recent Activity
    historyItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(17,24,39,0.80)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        borderTopColor: 'rgba(200,205,214,0.16)',
    },
    historyIcon: {
        width: 44,
        height: 44,
        borderRadius: BORDER_RADIUS.round,
        backgroundColor: COLORS.surfaceHighlight,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    historyDetails: {
        flex: 1,
    },
    historyTitle: {
        color: COLORS.text,
        fontWeight: 'bold',
        fontSize: 15,
        marginBottom: 2,
    },
    historyDate: {
        color: COLORS.textSecondary,
        fontSize: 12,
    },
    historyAmount: {
        color: COLORS.text,
        fontWeight: 'bold',
        fontSize: 15,
    },
});

export default DashboardScreen;
