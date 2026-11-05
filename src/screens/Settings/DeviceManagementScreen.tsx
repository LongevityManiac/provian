import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    RefreshControl,
    Alert,
    ActivityIndicator,
    Platform,
    Modal,
    TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import type { RegisteredDevice } from '../../services/RelayAPIService';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AppParamList } from '../../navigation/types';
import BackButton from '../../components/BackButton';
import { devicesRegisterNoteKey, useLaunchState } from '../../core/relay/launchState';
import type { TFunction } from 'i18next';

type Props = NativeStackScreenProps<AppParamList, 'DeviceManagement'>;

const PLATFORM_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    darwin: 'logo-apple',
    linux: 'logo-tux',
    win32: 'logo-windows',
    android: 'logo-android',
};

const TYPE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    workstation: 'desktop-outline',
    server: 'server-outline',
    gpu_cluster: 'hardware-chip-outline',
    iot: 'wifi-outline',
    mobile: 'phone-portrait-outline',
};

function getDeviceIcon(device: RegisteredDevice): keyof typeof Ionicons.glyphMap {
    return TYPE_ICONS[device.device_type] || 'hardware-chip-outline';
}

function getPlatformIcon(platform: string): keyof typeof Ionicons.glyphMap {
    return PLATFORM_ICONS[platform.toLowerCase()] || 'globe-outline';
}

function formatRelativeTime(timestamp: number | null, t: TFunction): string {
    if (!timestamp) return t('relativeTime.never');
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return t('relativeTime.justNow');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('relativeTime.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('relativeTime.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return t('relativeTime.daysAgo', { count: days });
    const months = Math.floor(days / 30);
    return t('relativeTime.monthsAgo', { count: months });
}

const DeviceManagementScreen = ({ navigation }: Props) => {
    const { t } = useTranslation();
    // The launch switch : the npm note is right before and after the flip.
    const launch = useLaunchState();
    const [devices, setDevices] = useState<RegisteredDevice[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
    // I-U-5: Alert.prompt is iOS-only. Use an in-app Modal for Android.
    const [renameModal, setRenameModal] = useState<{ device: RegisteredDevice } | null>(null);
    const [renameInput, setRenameInput] = useState('');

    const loadDevices = useCallback(async () => {
        try {
            const result = await RelayAPIService.getRegisteredDevices();
            setDevices(result);
        } catch {
            // getRegisteredDevices already handles errors internally
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadDevices();
    }, [loadDevices]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadDevices();
        setRefreshing(false);
    }, [loadDevices]);

    const handleRevoke = (device: RegisteredDevice) => {
        Alert.alert(
            t('devices.revokeDevice'),
            t('devices.revokeConfirm', { name: device.device_name }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('devices.revoke'),
                    style: 'destructive',
                    onPress: async () => {
                        const success = await RelayAPIService.revokeDevice(device.device_id);
                        if (success) {
                            setDevices(prev =>
                                prev.map(d =>
                                    d.device_id === device.device_id
                                        ? { ...d, status: 'revoked' as const }
                                        : d
                                )
                            );
                        } else {
                            Alert.alert(t('common.errorTitle'), t('devices.failedToRevoke'));
                        }
                    },
                },
            ]
        );
    };

    const commitRename = async (device: RegisteredDevice, newName: string) => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        const success = await RelayAPIService.renameDevice(device.device_id, trimmed);
        if (success) {
            setDevices(prev =>
                prev.map(d =>
                    d.device_id === device.device_id
                        ? { ...d, device_name: trimmed }
                        : d
                )
            );
        } else {
            Alert.alert(t('common.errorTitle'), t('devices.failedToRename'));
        }
    };

    const handleRename = (device: RegisteredDevice) => {
        // Alert.prompt only exists on iOS. On Android we show a custom Modal
        // with a TextInput so rename actually works there too.
        if (Platform.OS === 'ios') {
            Alert.prompt(
                t('devices.renameDevice'),
                t('devices.renamePrompt', { name: device.device_name }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('common.save'),
                        onPress: (newName?: string) => { void commitRename(device, newName ?? ''); },
                    },
                ],
                'plain-text',
                device.device_name
            );
        } else {
            setRenameInput(device.device_name);
            setRenameModal({ device });
        }
    };

    const toggleExpanded = (deviceId: string) => {
        setExpandedDeviceId(prev => (prev === deviceId ? null : deviceId));
    };

    const renderDevice = (device: RegisteredDevice) => {
        const isExpanded = expandedDeviceId === device.device_id;
        const isRevoked = device.status === 'revoked';

        return (
            <View key={device.device_id} style={[styles.deviceCard, isRevoked && styles.deviceCardRevoked]}>
                <TouchableOpacity
                    style={styles.deviceRow}
                    onPress={() => toggleExpanded(device.device_id)}
                    onLongPress={() => {
                        if (!isRevoked) {
                            Alert.alert(device.device_name, t('devices.chooseAction'), [
                                { text: t('common.cancel'), style: 'cancel' },
                                { text: t('devices.rename'), onPress: () => handleRename(device) },
                                { text: t('devices.revoke'), style: 'destructive', onPress: () => handleRevoke(device) },
                            ]);
                        }
                    }}
                >
                    <View style={styles.deviceIconBox}>
                        <Ionicons
                            name={getDeviceIcon(device)}
                            size={20}
                            color={isRevoked ? '#9CA3AF' : COLORS.chromeMuted}
                        />
                    </View>
                    <View style={styles.deviceInfo}>
                        <View style={styles.deviceNameRow}>
                            <Text style={[styles.deviceName, isRevoked && styles.textRevoked]} numberOfLines={1}>
                                {device.device_name}
                            </Text>
                            <View style={[styles.statusBadge, isRevoked ? styles.statusRevoked : styles.statusActive]}>
                                <Text style={[styles.statusText, isRevoked ? styles.statusTextRevoked : styles.statusTextActive]}>
                                    {isRevoked ? t('devices.revoked') : t('devices.active')}
                                </Text>
                            </View>
                        </View>
                        <View style={styles.deviceMeta}>
                            <Ionicons name={getPlatformIcon(device.platform)} size={12} color="#9CA3AF" />
                            <Text style={styles.metaText}>{device.platform}</Text>
                            <Text style={styles.metaDot}>&middot;</Text>
                            <Text style={styles.metaText}>{t('devices.peCount', { count: device.total_pes })}</Text>
                            <Text style={styles.metaDot}>&middot;</Text>
                            <Text style={styles.metaText}>{formatRelativeTime(device.last_pe_at, t)}</Text>
                        </View>
                    </View>
                    <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color="#9CA3AF"
                    />
                </TouchableOpacity>

                {isExpanded && (
                    <View style={styles.expandedSection}>
                        <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>{t('devices.deviceId')}</Text>
                            <Text style={styles.detailValue} numberOfLines={1}>{device.device_id}</Text>
                        </View>
                        <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>{t('devices.type')}</Text>
                            <Text style={styles.detailValue}>{device.device_type}</Text>
                        </View>
                        <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>{t('devices.attestation')}</Text>
                            <Text style={styles.detailValue}>{device.attestation_capability}</Text>
                        </View>
                        <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>{t('devices.registered')}</Text>
                            <Text style={styles.detailValue}>
                                {new Date(device.created_at).toLocaleDateString()}
                            </Text>
                        </View>

                        {!isRevoked && (
                            <View style={styles.actionButtons}>
                                <TouchableOpacity
                                    style={styles.actionBtn}
                                    onPress={() => handleRename(device)}
                                >
                                    <Ionicons name="pencil-outline" size={16} color="#4A8EE8" />
                                    <Text style={styles.actionBtnText}>{t('devices.rename')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.actionBtn, styles.actionBtnDanger]}
                                    onPress={() => handleRevoke(device)}
                                >
                                    <Ionicons name="close-circle-outline" size={16} color="#F2555A" />
                                    <Text style={[styles.actionBtnText, styles.actionBtnTextDanger]}>{t('devices.revoke')}</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                )}
            </View>
        );
    };

    const renderEmptyState = () => (
        <View style={styles.emptyState}>
            <View style={styles.emptyIconBox}>
                <Ionicons name="hardware-chip-outline" size={48} color="#9CA3AF" />
            </View>
            <Text style={styles.emptyTitle}>{t('devices.noDevices')}</Text>
            <Text style={styles.emptyDescription}>
                {t('devices.noDevicesDesc')}
            </Text>
            <View style={styles.emptyInstructions}>
                <Text style={styles.emptyFootnote}>
                    {t(devicesRegisterNoteKey(launch?.launched ?? true))}
                </Text>
            </View>
        </View>
    );

    return (
        <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={styles.gradient}>
            <SafeAreaView style={styles.container} edges={['top']}>
                {/* Header */}
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} color={COLORS.chromeMuted} />
                    <Text style={styles.headerTitle}>{t('devices.headerTitle')}</Text>
                    <View style={styles.headerRight} />
                </View>

                {loading ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={COLORS.primary} />
                    </View>
                ) : (
                    <ScrollView
                        contentContainerStyle={styles.content}
                        refreshControl={
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={onRefresh}
                                tintColor={COLORS.primary}
                            />
                        }
                    >
                        {devices.length === 0 ? (
                            renderEmptyState()
                        ) : (
                            <>
                                <Text style={styles.sectionHeader}>
                                    {devices.length}{t('devices.deviceSection')}{devices.length !== 1 ? 'S' : ''}
                                </Text>
                                {devices.map(renderDevice)}
                                <Text style={styles.hint}>
                                    {t('devices.hint')}
                                </Text>
                            </>
                        )}
                    </ScrollView>
                )}
                {/* Android rename modal (I-U-5 cross-platform fix) */}
                <Modal
                    visible={renameModal !== null}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setRenameModal(null)}
                >
                    <View style={styles.modalBackdrop}>
                        <View style={styles.modalCard}>
                            <Text style={styles.modalTitle}>{t('devices.renameDevice')}</Text>
                            <Text style={styles.modalSubtitle}>
                                {t('devices.renamePromptWithName', { name: renameModal?.device.device_name ?? '' })}
                            </Text>
                            <TextInput
                                style={styles.modalInput}
                                value={renameInput}
                                onChangeText={setRenameInput}
                                autoFocus
                                maxLength={64}
                                placeholder={t('devices.renamePlaceholder')}
                                placeholderTextColor="#8B929E"
                                returnKeyType="done"
                                onSubmitEditing={() => {
                                    const target = renameModal?.device;
                                    setRenameModal(null);
                                    if (target) void commitRename(target, renameInput);
                                }}
                            />
                            <View style={styles.modalActions}>
                                <TouchableOpacity
                                    style={[styles.actionBtn, { flex: 1 }]}
                                    onPress={() => setRenameModal(null)}
                                >
                                    <Text style={styles.actionBtnText}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.actionBtn, { flex: 1 }]}
                                    onPress={() => {
                                        const target = renameModal?.device;
                                        setRenameModal(null);
                                        if (target) void commitRename(target, renameInput);
                                    }}
                                >
                                    <Text style={styles.actionBtnText}>{t('common.save')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
            </SafeAreaView>
        </LinearGradient>
    );
};

const styles = StyleSheet.create({
    gradient: {
        flex: 1,
    },
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACING.m,
        paddingVertical: SPACING.m,
    },
    headerTitle: {
        color: COLORS.text,
        fontSize: 17,
        fontWeight: '600',
    },
    headerRight: {
        width: 44,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        paddingHorizontal: SPACING.m,
        paddingBottom: SPACING.xxl,
    },
    sectionHeader: {
        color: '#9CA3AF',
        fontSize: 11,
        fontWeight: '600',
        marginTop: SPACING.s,
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    deviceCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 20,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
        overflow: 'hidden',
    },
    deviceCardRevoked: {
        opacity: 0.6,
    },
    deviceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
    },
    deviceIconBox: {
        width: 40,
        height: 40,
        borderRadius: 12,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    deviceInfo: {
        flex: 1,
        marginRight: SPACING.s,
    },
    deviceNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    deviceName: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        marginRight: SPACING.s,
    },
    textRevoked: {
        color: '#9CA3AF',
    },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 8,
    },
    statusActive: {
        backgroundColor: 'rgba(76,175,80,0.15)',
    },
    statusRevoked: {
        backgroundColor: 'rgba(242,85,90,0.15)',
    },
    statusText: {
        fontSize: 11,
        fontWeight: '600',
    },
    statusTextActive: {
        color: '#4CAF50',
    },
    statusTextRevoked: {
        color: '#F2555A',
    },
    deviceMeta: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    metaText: {
        color: '#9CA3AF',
        fontSize: 12,
        marginLeft: 4,
    },
    metaDot: {
        color: '#9CA3AF',
        fontSize: 12,
        marginHorizontal: 6,
    },
    expandedSection: {
        paddingHorizontal: SPACING.m,
        paddingBottom: SPACING.m,
        borderTopWidth: 1,
        borderTopColor: 'rgba(200,205,214,0.06)',
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 8,
    },
    detailLabel: {
        color: '#9CA3AF',
        fontSize: 13,
    },
    detailValue: {
        color: '#8B929E',
        fontSize: 13,
        flex: 1,
        textAlign: 'right',
        marginLeft: SPACING.m,
    },
    actionButtons: {
        flexDirection: 'row',
        marginTop: SPACING.s,
        gap: SPACING.s,
    },
    actionBtn: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: 'rgba(74,142,232,0.1)',
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.2)',
        gap: 6,
    },
    actionBtnDanger: {
        backgroundColor: 'rgba(242,85,90,0.1)',
        borderColor: 'rgba(242,85,90,0.2)',
    },
    actionBtnText: {
        color: '#4A8EE8',
        fontSize: 14,
        fontWeight: '500',
    },
    actionBtnTextDanger: {
        color: '#F2555A',
    },
    hint: {
        color: '#9CA3AF',
        fontSize: 12,
        textAlign: 'center',
        marginTop: SPACING.m,
    },
    // Empty state
    emptyState: {
        alignItems: 'center',
        paddingTop: SPACING.xxl,
        paddingHorizontal: SPACING.l,
    },
    emptyIconBox: {
        width: 80,
        height: 80,
        borderRadius: 24,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    emptyTitle: {
        color: COLORS.text,
        fontSize: 18,
        fontWeight: '600',
        marginBottom: SPACING.s,
    },
    emptyDescription: {
        color: '#8B929E',
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: SPACING.l,
    },
    emptyInstructions: {
        width: '100%',
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 16,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    emptyFootnote: {
        color: '#9CA3AF',
        fontSize: 12,
        lineHeight: 18,
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: SPACING.l,
    },
    modalCard: {
        width: '100%',
        backgroundColor: '#12151A',
        borderRadius: 22,
        padding: SPACING.l,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        gap: SPACING.m,
    },
    modalTitle: {
        color: COLORS.text,
        fontSize: 17,
        fontWeight: '700',
    },
    modalSubtitle: {
        color: '#8B929E',
        fontSize: 13,
        lineHeight: 18,
    },
    modalInput: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
        paddingHorizontal: SPACING.m,
        paddingVertical: 12,
        color: COLORS.text,
        fontSize: 15,
    },
    modalActions: {
        flexDirection: 'row',
        gap: SPACING.s,
    },
});

export default DeviceManagementScreen;
