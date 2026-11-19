import { AppMenu } from '../../components/AppMenu';
import { ActionTouchable, actionStyles, DestinationRow, PrimaryAction } from '../../components/ScreenActions';
import BackButton from '../../components/BackButton';
import { cachedPvtAsset } from '../../core/wallet/pvtBalanceDisplay';
import { isTestnet } from '../../core/shared/environment';
import { enumDisplayCopy } from '../../i18n/displayCopy';
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert, Animated, AppState, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppParamList } from '../../navigation/types';
import { useTranslation } from 'react-i18next';
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
import { useAttentionCount } from '../../core/attention/useAttentionCount';
import TransactionHistoryService, { isApprovalScanEnabled } from '../../core/history/TransactionHistoryService';
import type { Transaction } from '../../core/history/TransactionHistoryService';
import { displayBalance } from '../../utils/displayBalance';
import { assetUsdValue, formatUsd, portfolioTotal, priceAgeLabel, totalAgeLabel } from '../../utils/fiatDisplay';

const DashboardScreen = ({ navigation }: NativeStackScreenProps<AppParamList, 'Dashboard'>) => {
    const {
        assets,
        lastConfirmedPvt,
        pvtBalanceStatus,
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

    const refreshBalances = useCallback(async () => {
        if (!address) return;
        setIsLoadingBalances(true);
        setBalanceError(null);
        try {
            const { failedChainIds } = await BalanceService.fetchAllBalancesDetailed(address);
            setLastBalanceUpdate(Date.now());
            if (failedChainIds.length) setBalanceError(t('dashboard.balanceOutdated'));
        } catch (error) {
            console.warn('[Dashboard] Balance fetch failed:', error);
            setBalanceError(t('dashboard.balanceLoadFailed'));
        } finally { setIsLoadingBalances(false); }
    }, [address, t]);
    useFocusEffect(useCallback(() => {
        void refreshBalances();
        if (address) OnRampReconciler.reconcile(address).catch(() => {});
    }, [address, refreshBalances]));

    React.useEffect(() => {
        let previous = AppState.currentState;
        const subscription = AppState.addEventListener('change', next => {
            if (next === 'active' && previous !== 'active') void refreshBalances();
            previous = next;
        });
        return () => subscription.remove();
    }, [refreshBalances]);

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const cardGradient = GRADIENTS.balanceCardGlow;

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

    const [addressCopied, setAddressCopied] = useState(false);

    // PVT9 is now a live, sendable wallet asset (, human PVT spendability).
    // Include the real PVT balance (isPVT, injected by BalanceService from the
    // relay reader) while still excluding any stale legacy `PVT`-symbol rows that
    // predate the reader wiring and carry no on-chain balance.
    const cachedPvt = cachedPvtAsset(lastConfirmedPvt, address, !isTestnet());
    const displayAssets = !assets.some(asset => asset.isPVT) && cachedPvt ? [cachedPvt, ...assets] : assets;
    const hasDisplayedPvt = displayAssets.some(asset => asset.isPVT);
    React.useEffect(() => {
        if (hasDisplayedPvt) console.log(`[Dashboard] PVT card displayed (${pvtBalanceStatus})`);
    }, [hasDisplayedPvt, pvtBalanceStatus]);
    const walletAssets = displayAssets
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

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <BackButton onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                        else navigation.navigate('MainTabs', { screen: 'WalletTab' });
                    }} />
                    <View style={{ flexShrink: 1 }}>
                        <Text accessibilityRole="header" style={[styles.assetTitle, { color: themeColors.textPrimary }]}>{t('overhaul.assetsAndHistory')}</Text>
                        {userName ? <Text style={[styles.username, { color: themeColors.textPrimary }]} numberOfLines={1}>{userName}</Text> : !!address && (
                            <ActionTouchable
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
                                {!addressCopied && <Ionicons name="copy-outline" size={14} color={COLORS.textMuted} />}
                            </ActionTouchable>
                        )}
                    </View>
                </View>
                <View style={styles.headerRight}>
                    {isLockdownActive && (
                        <ActionTouchable onPress={() => navigation.navigate('Lockdown')}>
                            <View style={[styles.statusBadge, { backgroundColor: COLORS.error }]}>
                                <Text style={styles.statusText}>{t('dashboard.lockdownBadge')}</Text>
                            </View>
                        </ActionTouchable>
                    )}
                    {/* attention bell: one tap to everything needing action, badge-counted. */}
                    <ActionTouchable
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
                    </ActionTouchable>
                    <ActionTouchable style={styles.profileBtn} onPress={() => navigation.navigate('ProfileEdit')}>
                        <Ionicons name="person" size={20} color={COLORS.text} />
                    </ActionTouchable>
                    <AppMenu />
                </View>
            </View>
            <ScrollView contentContainerStyle={styles.scrollContent}
                refreshControl={<RefreshControl refreshing={isLoadingBalances} onRefresh={() => { void refreshBalances(); }} tintColor={COLORS.primary} />}>

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
                    <ActionTouchable style={styles.syncButton} onPress={handleSync}>
                        <Ionicons name="sync" size={20} color="white" />
                        <Text style={styles.syncText}>{t('offline.sync', { count: transactionQueue.length })}</Text>
                    </ActionTouchable>
                )}



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

                <View style={styles.assetActions}>
                    <PrimaryAction label={t('dashboard.send')} icon="send" onPress={() => navigation.navigate('Send')} />
                    <DestinationRow label={t('dashboard.receive')} icon="receive" onPress={() => navigation.navigate('Receive')} />
                    <DestinationRow label={t('dashboard.swap')} stockIcon="swap-horizontal-outline" onPress={() => navigation.navigate('Swap')} />
                    <DestinationRow label={t('walletConnect.connect')} icon="scan" onPress={() => navigation.navigate('WalletConnect')} />
                    <DestinationRow label={t('dashboard.buy')} stockIcon="card-outline" onPress={() => navigation.navigate('BuyCrypto')} />
                </View>

                {/* 7. Assets section */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: themeColors.textPrimary }]}>{t('dashboard.assets')}</Text>
                    {walletAssets.length === 0 && !isLoadingBalances && (
                        <DestinationRow label={t('dashboard.noOtherAssets')} stockIcon="wallet-outline" />
                    )}
                    {walletAssets.map((asset) => {
                        const detail = asset.isPVT
                            ? [asset.chain, pvtBalanceStatus === 'updating' ? t('dashboard.pvtUpdating')
                                : pvtBalanceStatus === 'outdated' ? t('dashboard.balanceOutdated') : null]
                            : [asset.chain, formatUsd(assetUsdValue(asset)), priceAgeLabel(asset, t)];
                        return <DestinationRow key={`${asset.chain}:${asset.symbol}`}
                            label={asset.symbol} detail={detail.filter(Boolean).join(' · ')}
                            leading={<TokenIcon symbol={asset.symbol} size={33} chain={asset.chain} showChainBadge />}
                            end={<Text style={[styles.assetBalance, actionStyles.money, asset.isPVT && styles.pvtBalance]}>
                                {displayBalance(asset.balance)}
                            </Text>} />;
                    })}

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
                        <ActionTouchable onPress={() => navigation.navigate('TransactionHistory')}>
                            <Text style={[styles.seeAll, { color: themeColors.primary }]}>{t('dashboard.seeAll')}</Text>
                        </ActionTouchable>
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
                                <ActionTouchable
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
                                </ActionTouchable>
                            );
                        })
                    )}
                </View>

                {/* 9. Settings Row */}
                <ActionTouchable
                    style={styles.settingsRow}
                    onPress={() => navigation.navigate('Settings')}
                    activeOpacity={0.7}
                >
                    <Ionicons name="settings-outline" size={20} color={COLORS.text} />
                    <Text style={styles.settingsRowText}>{t('dashboard.settingsSecurity')}</Text>
                    <View style={{ flex: 1 }} />
                    <Ionicons name="chevron-forward" size={20} color={COLORS.textMuted} />
                </ActionTouchable>
            </ScrollView>
        </SafeAreaView>
    );
};


const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    assetActions: { marginBottom: SPACING.l },
    scrollContent: {
        padding: SPACING.m,
        paddingBottom: 120,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        marginBottom: SPACING.s,
        marginTop: SPACING.s,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        marginRight: SPACING.s,
        gap: SPACING.s,
    },
    assetTitle: {
        fontSize: 16,
        fontWeight: '700',
    },
    username: {
        fontSize: 14,
        color: COLORS.textSecondary,
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
        fontVariant: ['tabular-nums'],
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
    assetBalance: { color: COLORS.text, fontSize: 17, fontWeight: '700', flexShrink: 1 },
    pvtBalance: { color: COLORS.platinum },

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
