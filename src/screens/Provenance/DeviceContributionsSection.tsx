/**
 * DeviceContributionsSection - per-device PE contribution bars.
 *
 * Folded into the Abundance tab (MyProvenanceDashboardScreen) from the
 * retired AbundanceDashboard detail screen; reuses that screen's
 * `abundanceDashboard.*` i18n keys so no locale re-translation was needed.
 * Renders nothing while loading or when the wallet has no active devices.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING } from '../../constants/theme';
import RelayAPIService from '../../services/RelayAPIService';
import type { RegisteredDevice } from '../../services/RelayAPIService';

const FALLBACK_COLOR = '#6BA3F0';

const DEVICE_TYPE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    workstation: 'desktop-outline',
    // The SDK register-device / bootstrap curl both send device_type
    // 'coding_workstation' for every developer machine, so it is the common
    // real value — give it the desktop icon rather than the generic fallback.
    coding_workstation: 'desktop-outline',
    server: 'server-outline',
    gpu_cluster: 'hardware-chip-outline',
    iot: 'wifi-outline',
    mobile: 'phone-portrait-outline',
};

const DEVICE_TYPE_COLORS: Record<string, string> = {
    workstation: '#4A8EE8',
    coding_workstation: '#4A8EE8',
    server: '#6BA3F0',
    gpu_cluster: '#E8A838',
    iot: '#4CAF50',
    mobile: '#9B6DFF',
};

const DEVICE_TYPE_LABEL_KEYS: Record<string, string> = {
    workstation: 'abundanceDashboard.deviceType.workstation',
    server: 'abundanceDashboard.deviceType.server',
    gpu_cluster: 'abundanceDashboard.deviceType.gpuCluster',
    iot: 'abundanceDashboard.deviceType.iot',
    mobile: 'abundanceDashboard.deviceType.mobile',
};

function formatNumber(val: number): string {
    if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
    return String(val);
}

export function useDeviceContributions() {
    const [devices, setDevices] = useState<RegisteredDevice[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchDevices = useCallback(async () => {
        try {
            const result = await RelayAPIService.getRegisteredDevices();
            const active = result
                .filter((d) => d.status === 'active')
                .sort((a, b) => b.total_pes - a.total_pes);
            setDevices(active);
        } catch {
            // Non-critical - section will just not render
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchDevices();
    }, [fetchDevices]);

    return { devices, loading };
}

const DeviceContributionsSection = () => {
    const { t } = useTranslation();
    const { devices, loading } = useDeviceContributions();

    if (loading || devices.length === 0) return null;

    const maxPes = devices[0]?.total_pes || 1;

    return (
        <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('abundanceDashboard.deviceContributionsTitle')}</Text>
            <Text style={styles.sectionSubtitle}>{t('abundanceDashboard.deviceContributionsDesc')}</Text>
            {devices.map((device) => {
                const pct = Math.max(4, Math.round((device.total_pes / maxPes) * 100));
                const color = DEVICE_TYPE_COLORS[device.device_type] || FALLBACK_COLOR;
                const icon = DEVICE_TYPE_ICONS[device.device_type] || 'hardware-chip-outline';
                const labelKey = DEVICE_TYPE_LABEL_KEYS[device.device_type];
                return (
                    <View key={device.device_id} style={styles.deviceContribCard}>
                        <View style={styles.deviceContribRow}>
                            <View style={[styles.deviceContribIcon, { borderColor: `${color}33` }]}>
                                <Ionicons name={icon} size={18} color={color} />
                            </View>
                            <View style={styles.deviceContribInfo}>
                                <Text style={styles.deviceContribName} numberOfLines={1}>
                                    {device.device_name}
                                </Text>
                                <Text style={styles.deviceContribType}>
                                    {labelKey ? t(labelKey) : device.device_type.replace('_', ' ')}
                                </Text>
                            </View>
                            <Text style={styles.deviceContribCount}>
                                {t('abundanceDashboard.peCount', {
                                    count: device.total_pes,
                                    formattedCount: formatNumber(device.total_pes),
                                })}
                            </Text>
                        </View>
                        <View style={styles.deviceContribBarBg}>
                            <View
                                style={[
                                    styles.deviceContribBarFill,
                                    { width: `${pct}%`, backgroundColor: color },
                                ]}
                            />
                        </View>
                    </View>
                );
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    section: { marginBottom: SPACING.l },
    sectionLabel: {
        fontSize: 13, fontWeight: '600', color: '#9CA3AF',
        textTransform: 'uppercase', letterSpacing: 1.5,
        marginBottom: SPACING.s,
    },
    sectionSubtitle: {
        fontSize: 13, color: '#8B929E', lineHeight: 19,
        marginBottom: SPACING.m,
    },
    deviceContribCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: 14,
        padding: SPACING.m,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
    },
    deviceContribRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: SPACING.s,
    },
    deviceContribIcon: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
    },
    deviceContribInfo: {
        flex: 1,
        marginRight: SPACING.s,
    },
    deviceContribName: {
        fontSize: 14,
        fontWeight: '500',
        color: COLORS.chromeMuted,
    },
    deviceContribType: {
        fontSize: 11,
        color: '#9CA3AF',
        textTransform: 'capitalize',
    },
    deviceContribCount: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    deviceContribBarBg: {
        height: 6,
        borderRadius: 3,
        backgroundColor: 'rgba(18,21,26,0.70)',
        overflow: 'hidden',
    },
    deviceContribBarFill: {
        height: 6,
        borderRadius: 3,
    },
});

export default DeviceContributionsSection;
