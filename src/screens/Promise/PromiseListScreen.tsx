import React, { useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    RefreshControl,
    Modal,
    TextInput,
    Alert,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { format, isToday, isYesterday, isPast } from 'date-fns';
import { safeFormatDate } from '../../utils/safeDate';
import { COLORS, SPACING, BORDER_RADIUS, SHADOWS, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import PromiseService, { PromiseRecord as PromiseType, PromiseStatus } from '../../core/promises/PromiseService';
import type { IoniconsName } from '../../types/icons';
import { useTranslation } from 'react-i18next';
import { useWalletStore } from '../../store/walletStore';
import { requestAttentionRefresh } from '../../core/attention/attentionRefresh';

type TabType = 'active' | 'completed';

const PromiseListScreen = ({ navigation, route }: any) => {
    const { t } = useTranslation();
    const { address } = useWalletStore();
    const { colors: themeColors } = useTheme();
    const initialTab = route?.params?.tab === 'completed' ? 'completed' : 'active';
    const [promises, setPromises] = useState<PromiseType[]>([]);

    const backgroundGradient = GRADIENTS.backgroundDiagonal;
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>(initialTab);
    const [selectedPromise, setSelectedPromise] = useState<PromiseType | null>(null);
    const [showActionSheet, setShowActionSheet] = useState(false);
    const [showDisputeModal, setShowDisputeModal] = useState(false);
    const [disputeReason, setDisputeReason] = useState('');
    const [actionLoading, setActionLoading] = useState(false);

    const loadPromises = useCallback(async () => {
        try {
            const data = activeTab === 'active'
                ? await PromiseService.getActivePromises()
                : await PromiseService.getCompletedPromises();
            setPromises(data);
        } catch (error) {
            console.error('[PromiseList] Load error:', error);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [activeTab]);

    useFocusEffect(
        useCallback(() => {
            loadPromises();
        }, [loadPromises])
    );

    const handleRefresh = () => {
        setRefreshing(true);
        loadPromises();
    };

    const handleLongPress = (promise: PromiseType) => {
        // P4-11: the long-press sheet offers Mark Fulfilled / Dispute, which are
        // valid only from 'accepted' and throw Invalid transition on 'pending'.
        // Open it for 'accepted' only. A pending promise is accepted/declined
        // from its detail screen (tap through), not settled from here.
        if (promise.status === 'accepted') {
            setSelectedPromise(promise);
            setShowActionSheet(true);
        }
    };

    const handleFulfill = () => {
        if (!selectedPromise) return;
        setShowActionSheet(false);
        const target = selectedPromise;

        Alert.alert(
            t('promise.markFulfilled'),
            t('promise.markFulfilledConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('promise.yesFulfilled'),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            // C4: route through the SAME mutual close-out path the
                            // detail screen uses. For an ACCEPTED bilateral promise
                            // this INITIATES a close-out (awaits the counterparty)
                            // rather than unilaterally writing a settlement PE +
                            // corroboration; closeOutPromise still falls back to a
                            // local fulfill for purely-local (offline) promises.
                            const result = await PromiseService.closeOutPromise(target.id, address);
                            requestAttentionRefresh(); // item 9: a close-out moves the bell
                            loadPromises();
                            if (result?.mode === 'awaiting_counterparty') {
                                Alert.alert(
                                    t('promise.closeoutRequestedTitle'),
                                    t('promise.closeoutRequestedSent', { who: target.who }),
                                );
                            } else if (result?.mode === 'offline_pending') {
                                // Relay-backed but offline: recorded locally, NOT settled.
                                Alert.alert(
                                    t('promise.closeoutOfflineTitle'),
                                    t('promise.closeoutOfflineBody', { who: target.who }),
                                );
                            } else {
                                Alert.alert(t('common.success'), t('promise.promiseFulfilled'));
                            }
                        } catch (error) {
                            Alert.alert(t('common.errorTitle'), t('promise.failedToUpdate'));
                        } finally {
                            setActionLoading(false);
                            setSelectedPromise(null);
                        }
                    },
                },
            ]
        );
    };

    const handleOpenDispute = () => {
        setShowActionSheet(false);
        setShowDisputeModal(true);
    };

    const handleSubmitDispute = async () => {
        if (!selectedPromise) return;

        if (!disputeReason.trim()) {
            Alert.alert(t('common.required'), t('promise.disputeReason'));
            return;
        }

        setActionLoading(true);
        try {
            await PromiseService.disputePromise(selectedPromise.id, address, disputeReason);
            setShowDisputeModal(false);
            setDisputeReason('');
            loadPromises();
            Alert.alert(t('promise.disputed'), t('promise.disputedMsg'));
        } catch (error) {
            Alert.alert(t('common.errorTitle'), t('promise.failedToDispute'));
        } finally {
            setActionLoading(false);
            setSelectedPromise(null);
        }
    };

    const formatDate = (timestamp: number): string => {
        const date = new Date(timestamp);
        if (isToday(date)) return t('promise.today');
        if (isYesterday(date)) return t('promise.yesterday');
        return format(date, 'MMM d');
    };

    const getDirectionIcon = (direction: string): IoniconsName => {
        return direction === 'i_owe' ? 'arrow-up-circle' : 'arrow-down-circle';
    };

    const getDirectionColor = (direction: string): string => {
        return direction === 'i_owe' ? '#E8A838' : '#4CC38A';
    };

    const isDueSoon = (dueDate?: number): boolean => {
        if (!dueDate) return false;
        const daysUntilDue = (dueDate - Date.now()) / (1000 * 60 * 60 * 24);
        return daysUntilDue <= 3 && daysUntilDue > 0;
    };

    const isOverdue = (dueDate?: number): boolean => {
        if (!dueDate) return false;
        return isPast(new Date(dueDate));
    };

    const renderPromise = ({ item }: { item: PromiseType }) => (
        <TouchableOpacity
            style={styles.promiseCard}
            onPress={() => navigation.navigate('PromiseDetail', { promiseId: item.id })}
            onLongPress={() => handleLongPress(item)}
            delayLongPress={400}
            activeOpacity={0.7}
        >
            <View style={styles.promiseHeader}>
                <View style={[styles.directionIcon, { backgroundColor: `${getDirectionColor(item.direction)}15` }]}>
                    <Ionicons
                        name={getDirectionIcon(item.direction)}
                        size={24}
                        color={getDirectionColor(item.direction)}
                    />
                </View>
                <View style={styles.promiseInfo}>
                    <Text style={styles.promiseWhat} numberOfLines={2}>
                        {PromiseService.getPromiseDisplayText(item)}
                    </Text>
                    <Text style={styles.promiseWho}>
                        {t('promise.withPerson', { name: item.who })}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </View>

            <View style={styles.promiseFooter}>
                <View style={[styles.statusBadge, { backgroundColor: `${PromiseService.getStatusColor(item.status)}15` }]}>
                    <Text style={[styles.statusText, { color: PromiseService.getStatusColor(item.status) }]}>
                        {PromiseService.getStatusLabelWithName(item.status, item.who)}
                    </Text>
                </View>

                {item.dueDate && (
                    <View style={[
                        styles.dueDateBadge,
                        isOverdue(item.dueDate) && styles.dueDateOverdue,
                        isDueSoon(item.dueDate) && styles.dueDateSoon,
                    ]}>
                        <Ionicons
                            name="time"
                            size={12}
                            color={isOverdue(item.dueDate) ? COLORS.error : isDueSoon(item.dueDate) ? '#E8A838' : '#8B929E'}
                        />
                        <Text style={[
                            styles.dueDateText,
                            isOverdue(item.dueDate) && { color: COLORS.error },
                            isDueSoon(item.dueDate) && { color: '#E8A838' },
                        ]}>
                            {isOverdue(item.dueDate) ? t('promise.overdue') : safeFormatDate(item.dueDate, 'MMM d')}
                        </Text>
                    </View>
                )}

                <Text style={styles.dateText}>{formatDate(item.updatedAt)}</Text>
            </View>
        </TouchableOpacity>
    );

    const renderEmpty = () => (
        <View style={styles.emptyContainer}>
            <View style={styles.emptyIconContainer}>
                <Ionicons name="heart" size={48} color="#9CA3AF" />
            </View>
            <Text style={styles.emptyTitle}>
                {activeTab === 'active' ? t('promise.noActivePromises') : t('promise.noHistoryYet')}
            </Text>
            <Text style={styles.emptySubtitle}>
                {activeTab === 'active'
                    ? t('promise.startPrompt')
                    : t('promise.historyPrompt')}
            </Text>
            {activeTab === 'active' && (
                <TouchableOpacity
                    style={styles.createButton}
                    onPress={() => navigation.navigate('CreatePromise')}
                >
                    <Ionicons name="heart" size={18} color="#0B0E14" />
                    <Text style={styles.createButtonText}>{t('promise.makePromise')}</Text>
                </TouchableOpacity>
            )}
        </View>
    );

    const TabButton = ({ tab, label, icon }: { tab: TabType; label: string; icon: IoniconsName }) => (
        <TouchableOpacity
            style={[styles.tabButton, activeTab === tab && styles.tabButtonActive]}
            onPress={() => setActiveTab(tab)}
        >
            <Ionicons
                name={icon}
                size={16}
                color={activeTab === tab ? '#0B0E14' : '#8B929E'}
                style={{ marginRight: 6 }}
            />
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{label}</Text>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={backgroundGradient}
                style={StyleSheet.absoluteFill}
            />

            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{t('promise.listTitle')}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.s }}>
                    {/* finding #2: a persistent create affordance. The
                        renderEmpty "Make a Promise" button only shows when the
                        active list is EMPTY, so once a wallet held any active
                        promise there was no way to create another. This header
                        "+" is always rendered (a wallet holds many promises). */}
                    <TouchableOpacity
                        style={styles.headerButton}
                        onPress={() => navigation.navigate('CreatePromise')}
                        accessibilityLabel={t('promise.makePromise')}
                    >
                        <Ionicons name="add" size={24} color="#E8A838" />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.headerButton}
                        onPress={() => navigation.navigate('ScanPromise')}
                    >
                        <Ionicons name="qr-code" size={20} color="#E8A838" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                        <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Tabs */}
            <View style={styles.tabContainer}>
                <TabButton tab="active" label={t("promise.active")} icon="heart" />
                <TabButton tab="completed" label={t("promise.history")} icon="time" />
            </View>

            {/* Stats Summary */}
            <View style={styles.statsContainer}>
                <View style={styles.statItem}>
                    <Text style={styles.statValue}>
                        {promises.filter(p => p.direction === 'i_owe').length}
                    </Text>
                    <Text style={styles.statLabel}>{t('promise.iOweSection')}</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statItem}>
                    <Text style={styles.statValue}>
                        {promises.filter(p => p.direction === 'owed_to_me').length}
                    </Text>
                    <Text style={styles.statLabel}>{t('promise.theyOweMeSection')}</Text>
                </View>
            </View>

            {/* Promise List */}
            <FlatList
                data={promises}
                keyExtractor={item => item.id}
                renderItem={renderPromise}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={renderEmpty}
                ListFooterComponent={promises.length > 0 ? (
                    <TouchableOpacity
                        style={styles.exportRow}
                        onPress={() => navigation.navigate('ActivityLog')}
                        activeOpacity={0.7}
                    >
                        <Ionicons name="download-outline" size={20} color={COLORS.primary} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.exportRowLabel}>{t('promise.exportAndHistory')}</Text>
                            <Text style={styles.exportRowSubtitle}>{t('promise.exportAndHistoryDesc')}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={18} color={COLORS.textMuted} />
                    </TouchableOpacity>
                ) : null}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor="#4A8EE8"
                    />
                }
            />

            {/* Action Sheet Modal */}
            <Modal
                visible={showActionSheet}
                animationType="slide"
                transparent
                onRequestClose={() => setShowActionSheet(false)}
            >
                <TouchableOpacity
                    style={styles.actionSheetOverlay}
                    activeOpacity={1}
                    onPress={() => setShowActionSheet(false)}
                >
                    <View style={styles.actionSheetContainer}>
                        {selectedPromise && (
                            <>
                                <View style={styles.actionSheetHandle} />
                                <Text style={styles.actionSheetTitle}>
                                    {PromiseService.getPromiseDisplayText(selectedPromise)}
                                </Text>
                                <Text style={styles.actionSheetSubtitle}>
                                    {t('promise.withPerson', { name: selectedPromise.who })}
                                </Text>

                                <TouchableOpacity
                                    style={styles.fulfillActionButton}
                                    onPress={handleFulfill}
                                >
                                    <Ionicons name="checkmark-circle" size={22} color="#0B0E14" />
                                    <Text style={styles.fulfillActionText}>{t('promise.markFulfilled')}</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.disputeActionButton}
                                    onPress={handleOpenDispute}
                                >
                                    <Ionicons name="alert-circle" size={22} color="#E8A838" />
                                    <Text style={styles.disputeActionText}>{t('promise.dispute')}</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.actionSheetCancelButton}
                                    onPress={() => setShowActionSheet(false)}
                                >
                                    <Text style={styles.actionSheetCancelText}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </TouchableOpacity>
            </Modal>

            {/* Dispute Modal */}
            <Modal
                visible={showDisputeModal}
                animationType="slide"
                transparent
                onRequestClose={() => {
                    setShowDisputeModal(false);
                    setDisputeReason('');
                }}
            >
                <View style={styles.disputeModalOverlay}>
                    <View style={styles.disputeModalContainer}>
                        <Text style={styles.disputeModalTitle}>{t('promise.disputeTitle')}</Text>
                        <Text style={styles.disputeModalSubtitle}>
                            {t('promise.disputeConfirm')}
                        </Text>
                        <TextInput
                            style={styles.disputeInput}
                            placeholder={t("promise.disputeReasonPlaceholder")}
                            placeholderTextColor="#9CA3AF"
                            value={disputeReason}
                            onChangeText={setDisputeReason}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                        />
                        <View style={styles.disputeButtonRow}>
                            <TouchableOpacity
                                style={styles.disputeCancelButton}
                                onPress={() => {
                                    setShowDisputeModal(false);
                                    setDisputeReason('');
                                    setSelectedPromise(null);
                                }}
                            >
                                <Text style={styles.disputeCancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.disputeSubmitButton}
                                onPress={handleSubmitDispute}
                                disabled={actionLoading}
                            >
                                {actionLoading ? (
                                    <ActivityIndicator color="#0B0E14" size="small" />
                                ) : (
                                    <Text style={styles.disputeSubmitText}>{t('promise.submitDispute')}</Text>
                                )}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0B0E14',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
    },
    headerButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        letterSpacing: 0.3,
    },
    tabContainer: {
        flexDirection: 'row',
        marginHorizontal: SPACING.m,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        padding: 4,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    tabButton: {
        flex: 1,
        flexDirection: 'row',
        paddingVertical: SPACING.s + 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 14,
    },
    tabButtonActive: {
        backgroundColor: '#E8A838',
        shadowColor: '#E8A838',
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 4,
    },
    tabText: {
        color: '#8B929E',
        fontWeight: '600',
        fontSize: 14,
    },
    tabTextActive: {
        color: '#0B0E14',
        fontWeight: '700',
    },
    statsContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.m,
        marginHorizontal: SPACING.m,
        marginTop: SPACING.m,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    statItem: {
        flex: 1,
        flexBasis: 0,
        alignItems: 'center',
    },
    statValue: {
        fontSize: 28,
        fontWeight: '700',
        color: COLORS.text,
    },
    statLabel: {
        fontSize: 11,
        color: '#9CA3AF',
        marginTop: 2,
        letterSpacing: 2,
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    statDivider: {
        width: 1,
        height: 36,
        backgroundColor: 'rgba(42,48,56,0.8)',
    },
    listContent: {
        padding: SPACING.m,
        paddingBottom: 120,
    },
    exportRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(17,24,39,0.9)',
        padding: SPACING.l,
        borderRadius: BORDER_RADIUS.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        marginTop: SPACING.l,
        gap: SPACING.s,
    },
    exportRowLabel: {
        fontSize: 15,
        fontWeight: '600',
        color: COLORS.text,
    },
    exportRowSubtitle: {
        fontSize: 12,
        color: '#8B929E',
        marginTop: 2,
    },
    promiseCard: {
        backgroundColor: 'rgba(17,24,39,0.85)',
        padding: SPACING.m,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.18)',
        marginBottom: SPACING.m,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    promiseHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    directionIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
    },
    promiseInfo: {
        flex: 1,
    },
    promiseWhat: {
        fontSize: 16,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: 4,
    },
    promiseWho: {
        fontSize: 14,
        color: '#8B929E',
    },
    promiseFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: SPACING.m,
        gap: SPACING.s,
    },
    statusBadge: {
        paddingHorizontal: SPACING.s + 2,
        paddingVertical: 4,
        borderRadius: 8,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '600',
    },
    dueDateBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: SPACING.s + 2,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: 'rgba(18,21,26,0.70)',
    },
    dueDateOverdue: {
        backgroundColor: 'rgba(255,71,87,0.15)',
    },
    dueDateSoon: {
        backgroundColor: 'rgba(255,179,0,0.15)',
    },
    dueDateText: {
        fontSize: 12,
        color: '#8B929E',
    },
    dateText: {
        fontSize: 12,
        color: '#9CA3AF',
        marginLeft: 'auto',
    },
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        // xl, not xxxl: on a 667pt screen (iPhone SE) the extra 32pt pushed the
        // "Make a Promise" CTA under the floating tab bar on first render.
        paddingVertical: SPACING.xl,
    },
    emptyIconContainer: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    emptySubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        paddingHorizontal: SPACING.xl,
        marginBottom: SPACING.l,
    },
    createButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#E8A838',
        paddingHorizontal: SPACING.l,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        gap: SPACING.s,
        shadowColor: '#E8A838',
        shadowOpacity: 0.4,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
    },
    createButtonText: {
        color: '#0B0E14',
        fontWeight: '700',
        fontSize: 16,
    },
    // Action Sheet Styles
    actionSheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    actionSheetContainer: {
        backgroundColor: 'rgba(17,24,39,0.98)',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        padding: SPACING.l,
        paddingBottom: SPACING.xxxl,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.20)',
        borderBottomWidth: 0,
    },
    actionSheetHandle: {
        width: 40,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.20)',
        alignSelf: 'center',
        marginBottom: SPACING.l,
    },
    actionSheetTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        textAlign: 'center',
        marginBottom: SPACING.xs,
    },
    actionSheetSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.l,
    },
    fulfillActionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.s,
        gap: SPACING.s,
        backgroundColor: '#4CC38A',
        shadowColor: '#4CC38A',
        shadowOpacity: 0.3,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 4,
    },
    fulfillActionText: {
        fontSize: 16,
        fontWeight: '700',
        color: '#0B0E14',
    },
    disputeActionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.s,
        gap: SPACING.s,
        backgroundColor: 'rgba(255,179,0,0.15)',
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.35)',
    },
    disputeActionText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#E8A838',
    },
    actionSheetCancelButton: {
        padding: SPACING.m,
        alignItems: 'center',
        marginTop: SPACING.s,
    },
    actionSheetCancelText: {
        fontSize: 16,
        color: '#9CA3AF',
        fontWeight: '600',
    },
    // Dispute Modal Styles
    disputeModalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.85)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    disputeModalContainer: {
        backgroundColor: 'rgba(17,24,39,0.98)',
        padding: SPACING.l,
        borderRadius: 24,
        width: '90%',
        maxWidth: 400,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.10)',
        borderTopColor: 'rgba(200,205,214,0.20)',
    },
    disputeModalTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    disputeModalSubtitle: {
        fontSize: 14,
        color: '#8B929E',
        marginBottom: SPACING.l,
    },
    disputeInput: {
        backgroundColor: 'rgba(18,21,26,0.60)',
        borderRadius: 14,
        padding: SPACING.m,
        color: COLORS.text,
        fontSize: 16,
        minHeight: 100,
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    disputeButtonRow: {
        flexDirection: 'row',
        gap: SPACING.m,
    },
    disputeCancelButton: {
        flex: 1,
        padding: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    disputeCancelText: {
        color: COLORS.chromeMuted,
        fontWeight: '600',
    },
    disputeSubmitButton: {
        flex: 1,
        padding: SPACING.m,
        borderRadius: 28,
        alignItems: 'center',
        backgroundColor: '#E8A838',
        shadowColor: '#E8A838',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    disputeSubmitText: {
        color: '#0B0E14',
        fontWeight: '700',
    },
});

export default PromiseListScreen;
