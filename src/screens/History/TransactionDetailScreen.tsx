import { enumDisplayCopy } from '../../i18n/displayCopy';
import React from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Linking,
    Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { format } from 'date-fns';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useTheme } from '../../theme';
import TransactionHistoryService, { Transaction } from '../../core/history/TransactionHistoryService';
import type { TransactionDetailScreenProps } from '../../navigation/types';
import { getTransactionIcon, getTransactionColor, getTransactionLabel } from '../../utils/actionTypeDisplay';
import BackButton from '../../components/BackButton';
import { displayBalance } from '../../utils/displayBalance';

const TransactionDetailScreen = ({ navigation, route }: TransactionDetailScreenProps) => {
    const { t } = useTranslation();
    const { transaction } = route.params;
    const { colors: themeColors } = useTheme();

    const backgroundGradient = GRADIENTS.backgroundDiagonal;

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

    // Use shared utility - handles unknown action_types gracefully
    const getTypeIcon = (type: string): string => getTransactionIcon(type);
    const getTypeColor = (type: string): string => getTransactionColor(type);

    const copyToClipboard = async (text: string, label: string, caution?: boolean) => {
        await Clipboard.setStringAsync(text);
        if (caution) {
            // This is the sender of a transfer the user did not initiate -
            // an unsolicited/received counterparty. Copying it is legitimate
            // (reporting, viewing on an explorer), but it must never read as
            // "copied, therefore trusted": that silent implication is what
            // lets an address-poisoning dust sender get reused as a send
            // recipient. See CLAUDE.md security invariants.
            Alert.alert(
                t('transactionDetail.copiedUnverifiedTitle'),
                t('transactionDetail.copiedUnverifiedMsg', { label }),
            );
        } else {
            Alert.alert(t('common.copied'), t('transactionDetail.copiedToClipboard', { label }));
        }
    };

    const openExplorer = () => {
        const url = TransactionHistoryService.getExplorerUrl(transaction.hash, transaction.chain);
        Linking.openURL(url);
    };

    const DetailRow = ({
        label,
        value,
        copyable = false,
        onPress,
        valueColor,
        caution,
    }: {
        label: string;
        value: string;
        copyable?: boolean;
        onPress?: () => void;
        valueColor?: string;
        /** This value is an unverified counterparty (e.g. the sender of a
         *  transfer the user didn't initiate) - copy shows a caution instead
         *  of a plain "Copied" toast. */
        caution?: boolean;
    }) => (
        <TouchableOpacity
            style={styles.detailRow}
            onPress={copyable ? () => copyToClipboard(value, label, caution) : onPress}
            disabled={!copyable && !onPress}
            activeOpacity={copyable || onPress ? 0.7 : 1}
        >
            <Text style={styles.detailLabel}>{label}</Text>
            <View style={styles.detailValueContainer}>
                <Text
                    style={[styles.detailValue, valueColor && { color: valueColor }]}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                >
                    {value}
                </Text>
                {copyable && (
                    <Ionicons name="copy" size={16} color="#9CA3AF" style={{ marginLeft: 8 }} />
                )}
            </View>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: themeColors.background }]}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={themeColors.textPrimary} />
                <Text style={[styles.headerTitle, { color: themeColors.textPrimary }]}>{t('transactionDetail.title')}</Text>
                <TouchableOpacity style={styles.headerAction} onPress={openExplorer}>
                    <Ionicons name="open" size={24} color="#4A8EE8" />
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Status Card */}
                <View style={styles.statusCard}>
                    <View style={[styles.iconContainer, { backgroundColor: `${getTypeColor(transaction.type)}20` }]}>
                        <Ionicons
                            name={getTypeIcon(transaction.type) as any}
                            size={48}
                            color={getTypeColor(transaction.type)}
                        />
                    </View>

                    <Text style={styles.amount}>
                        {transaction.type === 'sent' ? '-' : (transaction.type === 'received' || transaction.type === 'earned') ? '+' : ''}
                        {displayBalance(transaction.amount)} {transaction.symbol}
                    </Text>

                    {transaction.usdValue && (
                        <Text style={styles.usdValue}>
                            ${transaction.usdValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </Text>
                    )}

                    <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(transaction.status)}20` }]}>
                        <View style={[styles.statusDot, { backgroundColor: getStatusColor(transaction.status) }]} />
                        <Text style={[styles.statusText, { color: getStatusColor(transaction.status) }]}>
                            {enumDisplayCopy(transaction.status)}
                        </Text>
                    </View>
                </View>

                {/* Details Card */}
                <View style={styles.detailsCard}>
                    <Text style={styles.sectionTitle}>{t('transactionDetail.details')}</Text>

                    <DetailRow
                        label={t('transactionDetail.type')}
                        value={(transaction.isMigrationReceipt
                            ? t('dashboard.transactionMigrated')
                            : getTransactionLabel(transaction.type))
                            + (transaction.isRetiredPvt ? ` · ${t('dashboard.transactionRetiredPvt')}` : '')}
                    />

                    <DetailRow
                        label={t('transactionDetail.chain')}
                        value={transaction.chain}
                    />

                    <DetailRow
                        label={t('transactionDetail.date')}
                        value={format(new Date(transaction.timestamp), 'MMM d, yyyy h:mm:ss a')}
                    />

                    <DetailRow
                        label={t('transactionDetail.from')}
                        value={transaction.from}
                        copyable
                        caution={transaction.type === 'received'}
                    />

                    <DetailRow
                        label={t('transactionDetail.to')}
                        value={transaction.to}
                        copyable
                    />

                    <DetailRow
                        label={t('transactionDetail.txHash')}
                        value={transaction.hash}
                        copyable
                    />

                    {transaction.blockNumber && (
                        <DetailRow
                            label={t('transactionDetail.blockNumber')}
                            value={transaction.blockNumber.toString()}
                        />
                    )}

                    {transaction.confirmations !== undefined && (
                        <DetailRow
                            label={t('transactionDetail.confirmations')}
                            value={transaction.confirmations.toString()}
                            valueColor={transaction.confirmations > 0 ? COLORS.success : COLORS.warning}
                        />
                    )}

                    {transaction.fee && (
                        <DetailRow
                            label={t('transactionDetail.networkFee')}
                            value={`${transaction.fee} ${transaction.feeSymbol || transaction.symbol}`}
                        />
                    )}
                </View>

                {/* Swap Details */}
                {transaction.type === 'swap' && transaction.swapFromSymbol && (
                    <View style={styles.detailsCard}>
                        <Text style={styles.sectionTitle}>{t('transactionDetail.swapDetails')}</Text>

                        <DetailRow
                            label={t('transactionDetail.from')}
                            value={`${transaction.swapFromAmount} ${transaction.swapFromSymbol}`}
                        />

                        <DetailRow
                            label={t('transactionDetail.to')}
                            value={`${transaction.swapToAmount} ${transaction.swapToSymbol}`}
                        />
                    </View>
                )}

                {/* Agent Details */}
                {transaction.agentId && (
                    <View style={styles.detailsCard}>
                        <Text style={styles.sectionTitle}>{t('transactionDetail.agentTransaction')}</Text>

                        <DetailRow
                            label={t('transactionDetail.agentLabel')}
                            value={transaction.agentId}
                        />

                        {transaction.agentPurpose && (
                            <DetailRow
                                label={t('transactionDetail.purpose')}
                                value={transaction.agentPurpose}
                            />
                        )}

                        {transaction.provenanceEnvelopeId && (
                            <TouchableOpacity
                                style={styles.peButton}
                                onPress={() => navigation.navigate('PEViewer', { envelopeId: transaction.provenanceEnvelopeId! })}
                            >
                                <Ionicons name="shield-checkmark" size={20} color={COLORS.primary} />
                                <Text style={styles.peButtonText}>{t('transactionDetail.viewPE')}</Text>
                                <Ionicons name="chevron-forward" size={20} color={COLORS.primary} />
                            </TouchableOpacity>
                        )}
                    </View>
                )}

                {/* View on Explorer Button */}
                <TouchableOpacity style={styles.explorerButton} onPress={openExplorer}>
                    <Ionicons name="globe" size={20} color={COLORS.chromeMuted} />
                    <Text style={styles.explorerButtonText}>{t('transactionDetail.viewExplorer')}</Text>
                </TouchableOpacity>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    // Right-hand header action, sized like BackButton so the title stays centered.
    headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxxl,
    },
    statusCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.xl,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        marginBottom: SPACING.l,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    iconContainer: {
        width: 88,
        height: 88,
        borderRadius: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.m,
    },
    amount: {
        fontSize: 32,
        fontWeight: 'bold',
        color: COLORS.text,
        marginBottom: SPACING.xs,
    },
    usdValue: {
        fontSize: 16,
        color: '#8B929E',
        marginBottom: SPACING.m,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.s,
        borderRadius: BORDER_RADIUS.round,
        gap: SPACING.xs,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '600',
    },
    detailsCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginBottom: SPACING.l,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    sectionTitle: {
        fontSize: 11,
        fontWeight: '600',
        color: '#9CA3AF',
        textTransform: 'uppercase',
        letterSpacing: 2,
        marginBottom: SPACING.m,
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: SPACING.s,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(200,205,214,0.08)',
    },
    detailLabel: {
        fontSize: 14,
        color: '#8B929E',
        flex: 1,
    },
    detailValueContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 2,
        justifyContent: 'flex-end',
    },
    detailValue: {
        fontSize: 14,
        color: COLORS.text,
        fontWeight: '500',
        textAlign: 'right',
        flex: 1,
    },
    peButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(74, 142, 232, 0.14)',
        padding: SPACING.m,
        borderRadius: 14,
        marginTop: SPACING.s,
        gap: SPACING.s,
    },
    peButtonText: {
        flex: 1,
        color: '#4A8EE8',
        fontWeight: '600',
    },
    explorerButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 28,
        gap: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    explorerButtonText: {
        color: COLORS.chromeMuted,
        fontWeight: '600',
        fontSize: 16,
    },
});

export default TransactionDetailScreen;
