import { enumDisplayCopy } from '../../i18n/displayCopy';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import { useWalletStore } from '../../store/walletStore';
import TransactionHistoryService, { Transaction, TransactionType, ChainType } from '../../core/history/TransactionHistoryService';
import { format, isToday, isYesterday } from 'date-fns';
import { getTransactionIcon, getTransactionColor, getTransactionLabel } from '../../utils/actionTypeDisplay';
import WalletRecovery from '../../components/wallet/WalletRecovery';
import BackButton from '../../components/BackButton';
import { displayBalance } from '../../utils/displayBalance';

type ChainFilter = 'All' | 'Base' | 'Arbitrum' | 'Optimism' | 'Solana';
type TypeFilter = 'All' | 'Sent' | 'Received' | 'Earned' | 'Swap' | 'Approve';

const CHAIN_FILTERS: ChainFilter[] = ['All', 'Base', 'Arbitrum', 'Optimism', 'Solana'];
const TYPE_FILTERS: TypeFilter[] = ['All', 'Sent', 'Received', 'Earned', 'Swap', 'Approve'];

// Filter values are matched by code; only the chip labels are localized. Chain names stay as-is.
const FILTER_LABEL_KEYS: Partial<Record<ChainFilter | TypeFilter, string>> = {
    All: 'ui.activityLog.filterAll',
    Sent: 'dashboard.transactionSent',
    Received: 'dashboard.transactionReceived',
    Earned: 'dashboard.transactionEarned',
    Swap: 'dashboard.transactionSwap',
    Approve: 'dashboard.transactionApprove',
};

const TransactionHistoryScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { address, solanaAddress } = useWalletStore();
    const { colors: themeColors } = useTheme();

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [page, setPage] = useState(1);

    const [chainFilter, setChainFilter] = useState<ChainFilter>('All');
    const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');
    const [showUnverified, setShowUnverified] = useState(false);

    const getChainFilterValues = (filter: ChainFilter): ChainType[] | undefined => {
        if (filter === 'All') return undefined;
        return [filter as ChainType];
    };

    const getTypeFilterValues = (filter: TypeFilter): TransactionType[] | undefined => {
        switch (filter) {
            case 'Sent':
                return ['sent'];
            case 'Received':
                return ['received'];
            case 'Earned':
                return ['earned'];
            case 'Swap':
                return ['swap'];
            case 'Approve':
                return ['approve'];
            default:
                return undefined;
        }
    };

    const loadTransactions = useCallback(async (pageNum: number = 1, refresh: boolean = false) => {
        try {
            if (pageNum === 1) {
                refresh ? setRefreshing(true) : setLoading(true);
            } else {
                setLoadingMore(true);
            }

            const txAddresses: Record<ChainType, string> = {
                Base: address,
                Arbitrum: address,
                Optimism: address,
                // Solana uses its own (base58) address, not the EVM one.
                Solana: solanaAddress || '',
            };

            if (refresh) {
                await TransactionHistoryService.refreshTransactions(txAddresses);
            }

            const result = await TransactionHistoryService.getTransactions(txAddresses, {
                chains: getChainFilterValues(chainFilter),
                types: getTypeFilterValues(typeFilter),
                page: pageNum,
                limit: 20,
                filterVerified: !showUnverified,
            });

            if (pageNum === 1) {
                setTransactions(result.items);
            } else {
                setTransactions(prev => [...prev, ...result.items]);
            }

            setHasMore(result.hasMore);
            setPage(pageNum);
        } catch (error) {
            console.error('[TransactionHistory] Load error:', error);
        } finally {
            setLoading(false);
            setRefreshing(false);
            setLoadingMore(false);
        }
    }, [address, solanaAddress, chainFilter, typeFilter, showUnverified]);

    useEffect(() => {
        loadTransactions(1);
    }, [chainFilter, typeFilter, showUnverified]);

    const handleRefresh = () => {
        loadTransactions(1, true);
    };

    const handleLoadMore = () => {
        if (!loadingMore && hasMore) {
            loadTransactions(page + 1);
        }
    };

    const formatDate = (timestamp: number): string => {
        const date = new Date(timestamp);
        if (isToday(date)) {
            return t('transactionHistory.todayAt', { time: format(date, 'h:mm a') });
        }
        if (isYesterday(date)) {
            return t('transactionHistory.yesterdayAt', { time: format(date, 'h:mm a') });
        }
        return format(date, 'MMM d, h:mm a');
    };

    const truncateAddress = (addr: string): string => {
        if (!addr || addr.length < 10) return addr;
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    };

    // Icon and color lookups now use the shared utility with unknown type fallback

    const getStatusColor = (status: string): string => {
        switch (status) {
            case 'confirmed':
                return COLORS.success;
            case 'failed':
                return COLORS.error;
            default:
                return COLORS.warning;
        }
    };

    const FilterChip = ({
        label,
        selected,
        onPress
    }: {
        label: string;
        selected: boolean;
        onPress: () => void;
    }) => (
        <TouchableOpacity
            style={[styles.filterChip, selected && styles.filterChipSelected]}
            onPress={onPress}
        >
            <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>
                {label}
            </Text>
        </TouchableOpacity>
    );

    const renderTransaction = ({ item }: { item: Transaction }) => (
        <TouchableOpacity
            style={styles.transactionItem}
            onPress={() => navigation.navigate('TransactionDetail', { transaction: item })}
        >
            <View style={[styles.txIconContainer, { backgroundColor: `${getTransactionColor(item.type)}20` }]}>
                <Ionicons
                    name={getTransactionIcon(item.type) as any}
                    size={20}
                    color={getTransactionColor(item.type)}
                />
            </View>

            <View style={styles.txDetails}>
                <View style={styles.txTopRow}>
                    <Text style={styles.txType}>
                        {item.isMigrationReceipt
                            ? t('dashboard.transactionMigrated')
                            : getTransactionLabel(item.type)}
                    </Text>
                    <Text style={[
                        styles.txAmount,
                        (item.type === 'received' || item.type === 'earned') && styles.txAmountReceived,
                        item.type === 'sent' && styles.txAmountSent,
                    ]}>
                        {item.type === 'sent' ? '-' : (item.type === 'received' || item.type === 'earned') ? '+' : ''}{displayBalance(item.amount)} {item.symbol}
                    </Text>
                </View>

                <View style={styles.txBottomRow}>
                    <View style={styles.txInfo}>
                        <Text style={styles.txAddress}>
                            {item.type === 'earned'
                                ? t('ui.transactionHistory.minted')
                                : item.type === 'sent'
                                    ? t('ui.transactionHistory.to', { address: truncateAddress(item.to) })
                                    : t('ui.transactionHistory.from', { address: truncateAddress(item.from) })}
                        </Text>
                        <View style={styles.txMeta}>
                            <View style={[styles.chainBadge, { backgroundColor: `${COLORS.primary}15` }]}>
                                <Text style={styles.chainBadgeText}>{item.chain}</Text>
                            </View>
                            {item.isRetiredPvt && (
                                <View style={[styles.statusBadge, { backgroundColor: `${COLORS.warning}20` }]}>
                                    <Text style={[styles.statusText, { color: COLORS.warning }]}>{t('dashboard.transactionRetiredPvt')}</Text>
                                </View>
                            )}
                            {item.contractAddress && item.isVerifiedToken === false && (
                                <View style={[styles.statusBadge, { backgroundColor: `${COLORS.warning}20` }]}>
                                    <Text style={[styles.statusText, { color: COLORS.warning }]}>{t('transactionHistory.unverified')}</Text>
                                </View>
                            )}
                            {item.status !== 'confirmed' && (
                                <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(item.status)}20` }]}>
                                    <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>
                                        {enumDisplayCopy(item.status)}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </View>
                    <Text style={styles.txDate}>{formatDate(item.timestamp)}</Text>
                </View>

                {item.agentId && (
                    <View style={styles.agentBadge}>
                        <Ionicons name="hardware-chip" size={12} color={COLORS.purple} />
                        <Text style={styles.agentText}>{item.agentId}</Text>
                    </View>
                )}
            </View>

            <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
    );

    const renderEmpty = () => (
        <View style={styles.emptyContainer}>
            <Ionicons name="receipt-outline" size={64} color={COLORS.textTertiary} />
            <Text style={styles.emptyTitle}>{t('settings.noTransactions')}</Text>
            <Text style={styles.emptySubtitle}>{t('transactionHistory.emptyMsg')}</Text>
        </View>
    );

    const renderFooter = () => {
        if (!loadingMore) return null;
        return (
            <View style={styles.loadingMore}>
                <ActivityIndicator color={COLORS.primary} />
            </View>
        );
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('transactionHistory.title')}</Text>
                <TouchableOpacity style={styles.headerAction} onPress={() => setShowUnverified(v => !v)}>
                    <Ionicons
                        name={showUnverified ? 'eye' : 'eye-off'}
                        size={22}
                        color={showUnverified ? COLORS.warning : themeColors.textPrimary}
                    />
                </TouchableOpacity>
            </View>

            {/* Chain Filters */}
            <View style={styles.filterSection}>
                <Text style={styles.filterLabel}>{t('transactionDetail.chain')}</Text>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.filterRow}
                >
                    {CHAIN_FILTERS.map(filter => (
                        <FilterChip
                            key={filter}
                            label={FILTER_LABEL_KEYS[filter] ? t(FILTER_LABEL_KEYS[filter] as string) : filter}
                            selected={chainFilter === filter}
                            onPress={() => setChainFilter(filter)}
                        />
                    ))}
                </ScrollView>
            </View>

            {/* Type Filters */}
            <View style={styles.filterSection}>
                <Text style={styles.filterLabel}>{t('transactionDetail.type')}</Text>
                <View style={styles.filterRow}>
                    {TYPE_FILTERS.map(filter => (
                        <FilterChip
                            key={filter}
                            label={FILTER_LABEL_KEYS[filter] ? t(FILTER_LABEL_KEYS[filter] as string) : filter}
                            selected={typeFilter === filter}
                            onPress={() => setTypeFilter(filter)}
                        />
                    ))}
                </View>
            </View>

            {/* Transaction List */}
            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={COLORS.primary} />
                    <Text style={styles.loadingText}>{t('transactionHistory.loading')}</Text>
                </View>
            ) : (
                <FlatList
                    ListHeaderComponent={<WalletRecovery openConnectedAppReview={() => navigation.navigate('WalletConnect')} />}
                    data={transactions}
                    keyExtractor={item => item.id}
                    renderItem={renderTransaction}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={renderEmpty}
                    ListFooterComponent={renderFooter}
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.5}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            tintColor={COLORS.primary}
                        />
                    }
                />
            )}
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
    filterSection: {
        paddingHorizontal: SPACING.m,
        marginBottom: SPACING.s,
    },
    filterLabel: {
        fontSize: 12,
        color: '#8B929E',
        marginBottom: SPACING.xs,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    filterRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.s,
    },
    filterChip: {
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: 16,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    filterChipSelected: {
        backgroundColor: 'rgba(74,142,232,0.15)',
        borderColor: '#4A8EE8',
    },
    filterChipText: {
        color: '#8B929E',
        fontSize: 13,
        fontWeight: '600',
    },
    filterChipTextSelected: {
        color: '#4A8EE8',
    },
    listContent: {
        padding: SPACING.m,
        flexGrow: 1,
    },
    transactionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 18,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
        elevation: 3,
    },
    txIconContainer: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    txDetails: {
        flex: 1,
    },
    txTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    txType: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.text,
    },
    txAmount: {
        fontSize: 15,
        fontWeight: '700',
        color: COLORS.chromeMuted,
    },
    txAmountReceived: {
        color: '#4CC38A',
    },
    txAmountSent: {
        color: COLORS.error,
    },
    txBottomRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
    },
    txInfo: {
        flex: 1,
    },
    txAddress: {
        fontSize: 12,
        color: '#8B929E',
        marginBottom: 4,
    },
    txMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.xs,
    },
    chainBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: 'rgba(74,142,232,0.12)',
    },
    chainBadgeText: {
        fontSize: 10,
        fontWeight: '600',
        color: '#4A8EE8',
    },
    statusBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    statusText: {
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'capitalize',
    },
    txDate: {
        fontSize: 11,
        color: '#9CA3AF',
    },
    agentBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 6,
        backgroundColor: 'rgba(155,109,255,0.15)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        alignSelf: 'flex-start',
    },
    agentText: {
        fontSize: 11,
        color: '#6BA3F0',
        fontWeight: '600',
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingText: {
        marginTop: SPACING.m,
        color: '#8B929E',
    },
    loadingMore: {
        paddingVertical: SPACING.l,
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: SPACING.xxxl,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.chromeMuted,
        marginTop: SPACING.m,
    },
    emptySubtitle: {
        fontSize: 14,
        color: '#8B929E',
        marginTop: SPACING.s,
        textAlign: 'center',
    },
});

export default TransactionHistoryScreen;
