import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import SeedManager from '../../core/wallet/SeedManager';
import { cloudBackupStatus } from '../../core/recovery/cloud/CloudBackupV2';
import { useWalletStore } from '../../store/walletStore';
import { getItemHmac } from '../../core/security/hmacAsyncStorage';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

interface BackupState {
    deviceKey: boolean;
    cloudBackup: boolean;
    backupSkipped: boolean;
    cloudProvider: 'icloud' | 'googleDrive';
    lastBackupAt: string | null;
    seedPhraseExported: boolean;
}

const BackupAndRecoveryScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const [state, setState] = useState<BackupState | null>(null);

    const loadState = useCallback(async () => {
        const provider: 'icloud' | 'googleDrive' = Platform.OS === 'ios' ? 'icloud' : 'googleDrive';
        // [Group 8] last-backup and seed-exported are read via hmacAsyncStorage
        // so a filesystem-access attacker cannot spoof these flags to mislead
        // the user into thinking they have a current backup or have exported
        // their seed when they have not. backup_skipped is a soft preference
        // and stays in plain AsyncStorage.
        const [deviceKey, cloud, skipped, lastAt, exported] = await Promise.all([
            SeedManager.hasSeed().catch(() => false),
            // A pre-2026-10-17 backup names no wallet: shown as this wallet's, as before (display
            // only — the restore gate requires proof,).
            (async () => {
                const address = useWalletStore.getState().address;
                return address ? (await cloudBackupStatus(address)) !== 'missing' : false;
            })().catch(() => false),
            AsyncStorage.getItem('@provian_backup_skipped').catch(() => null),
            getItemHmac<string>('@provian_last_cloud_backup_at').catch(() => null),
            getItemHmac<boolean>('@provian_seed_phrase_exported').catch(() => null),
        ]);
        setState({
            deviceKey,
            cloudBackup: cloud,
            backupSkipped: skipped === 'true',
            cloudProvider: provider,
            lastBackupAt: lastAt ?? null,
            seedPhraseExported: exported === true,
        });
    }, []);

    useEffect(() => {
        loadState();
    }, [loadState]);

    useFocusEffect(
        useCallback(() => {
            loadState();
        }, [loadState]),
    );

    const yesNo = (v: boolean) =>
        v ? t('settings.backupAndRecovery.statusYes') : t('settings.backupAndRecovery.statusNo');

    const cloudProviderLabel = (p: 'icloud' | 'googleDrive') =>
        p === 'icloud'
            ? t('settings.backupAndRecovery.statusCloudProviderIcloud')
            : t('settings.backupAndRecovery.statusCloudProviderGoogleDrive');

    const StatusRow = ({
        icon,
        label,
        value,
        ok,
    }: {
        icon: keyof typeof Ionicons.glyphMap;
        label: string;
        value: string;
        ok: boolean;
    }) => (
        <View style={styles.statusRow}>
            <View style={styles.statusLeft}>
                <View style={styles.statusIconBox}>
                    <Ionicons name={icon} size={18} color={COLORS.chromeMuted} />
                </View>
                <Text style={styles.statusLabel}>{label}</Text>
            </View>
            <View style={styles.statusValueWrap}>
                <View
                    style={[
                        styles.statusDot,
                        { backgroundColor: ok ? '#4CC38A' : '#E8A838' },
                    ]}
                />
                <Text style={styles.statusValue}>{value}</Text>
            </View>
        </View>
    );

    const ActionCard = ({
        icon,
        dotColor,
        title,
        subtitle,
        onPress,
    }: {
        icon: keyof typeof Ionicons.glyphMap;
        dotColor: string;
        title: string;
        subtitle?: string;
        onPress: () => void;
    }) => (
        <TouchableOpacity style={styles.actionCard} onPress={onPress} activeOpacity={0.8}>
            <View style={styles.actionLeft}>
                <View style={[styles.categoryDot, { backgroundColor: dotColor }]} />
                <View style={styles.iconContainer}>
                    <Ionicons name={icon} size={18} color={COLORS.chromeMuted} />
                </View>
                <View style={styles.actionTextWrap}>
                    <Text style={styles.actionTitle}>{title}</Text>
                    {subtitle ? <Text style={styles.actionSubtitle}>{subtitle}</Text> : null}
                </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
    );

    const handleBackup = () => navigation.navigate('CloudBackupConfirm', { fromSettings: true });
    const handleRecover = () => navigation.navigate('RecoveryStart');
    const handleShowPhrase = () => navigation.navigate('ExportMnemonic');

    const cloudBackupValue = state
        ? state.cloudBackup
            ? `${yesNo(true)} (${cloudProviderLabel(state.cloudProvider)})`
            : yesNo(false)
        : '...';

    const formatLastBackup = (iso: string | null): string => {
        if (!iso) return t('settings.backupAndRecovery.statusLastBackupNever');
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return t('settings.backupAndRecovery.statusLastBackupNever');
        return d.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    };

    const backupActionTitle = state?.cloudBackup
        ? t('settings.backupAndRecovery.actionRedoBackup')
        : t('settings.backupAndRecovery.actionBackUpNow');

    const showRecover = state ? !state.deviceKey : false;

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient colors={GRADIENTS.backgroundDiagonal} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('settings.backupAndRecovery.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <Text style={styles.sectionHeader}>{t('settings.backupStatusSection')}</Text>
                <View style={styles.statusCard}>
                    <StatusRow
                        icon="key-outline"
                        label={t('settings.backupAndRecovery.statusDeviceKey')}
                        value={state ? yesNo(state.deviceKey) : '...'}
                        ok={!!state?.deviceKey}
                    />
                    <View style={styles.statusDivider} />
                    <StatusRow
                        icon="cloud-outline"
                        label={t('settings.backupAndRecovery.statusCloudBackup')}
                        value={cloudBackupValue}
                        ok={!!state?.cloudBackup}
                    />
                    <View style={styles.statusDivider} />
                    <StatusRow
                        icon="time-outline"
                        label={t('settings.backupAndRecovery.statusLastBackup')}
                        value={state ? formatLastBackup(state.lastBackupAt) : '...'}
                        ok={!!state?.lastBackupAt}
                    />
                    <View style={styles.statusDivider} />
                    <StatusRow
                        icon="alert-circle-outline"
                        label={t('settings.backupAndRecovery.statusBackupSkipped')}
                        value={state ? yesNo(state.backupSkipped) : '...'}
                        ok={!state?.backupSkipped}
                    />
                    <View style={styles.statusDivider} />
                    <StatusRow
                        icon="document-text-outline"
                        label={t('settings.backupAndRecovery.statusSeedPhraseExported')}
                        value={state ? yesNo(state.seedPhraseExported) : '...'}
                        ok={!!state?.seedPhraseExported}
                    />
                </View>

                <Text style={styles.sectionHeader}>{t('promise.actionsSection')}</Text>
                <ActionCard
                    icon="cloud-upload-outline"
                    dotColor="#4A8EE8"
                    title={backupActionTitle}
                    onPress={handleBackup}
                />
                {showRecover && (
                    <ActionCard
                        icon="cloud-download-outline"
                        dotColor="#6BA3F0"
                        title={t('settings.backupAndRecovery.actionRecoverFromBackup')}
                        onPress={handleRecover}
                    />
                )}
                <ActionCard
                    icon="document-text-outline"
                    dotColor="#E8A838"
                    title={t('settings.backupAndRecovery.actionShowRecoveryPhrase')}
                    onPress={handleShowPhrase}
                />

                <View style={styles.footer}>
                    <Text style={styles.footerText}>
                        {t('settings.backupAndRecovery.modelExplainer')}
                    </Text>
                </View>
            </ScrollView>
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
        padding: SPACING.m,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
    },
    content: {
        padding: SPACING.l,
        paddingBottom: SPACING.xxxl,
    },
    sectionHeader: {
        color: '#9CA3AF',
        fontSize: 11,
        fontWeight: '600',
        marginTop: SPACING.l,
        marginBottom: SPACING.s,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    statusCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderRadius: BORDER_RADIUS.l,
        padding: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: SPACING.s,
    },
    statusLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: SPACING.s,
    },
    statusIconBox: {
        width: 32,
        height: 32,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    statusLabel: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
        flex: 1,
    },
    statusValueWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusValue: {
        color: COLORS.chromeMuted,
        fontSize: 13,
        fontWeight: '500',
        flexShrink: 1,
        textAlign: 'right',
    },
    statusDivider: {
        height: 1,
        backgroundColor: 'rgba(200,205,214,0.06)',
        marginVertical: 2,
    },
    actionCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        marginBottom: SPACING.s,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    actionLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    categoryDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: SPACING.s,
    },
    iconContainer: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: 'rgba(18,21,26,0.60)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: SPACING.m,
        borderWidth: 1,
        borderColor: 'rgba(42,48,56,1)',
    },
    actionTextWrap: {
        flex: 1,
    },
    actionTitle: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '600',
    },
    actionSubtitle: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    footer: {
        marginTop: SPACING.l,
        padding: SPACING.m,
        borderRadius: BORDER_RADIUS.l,
        backgroundColor: 'rgba(74,142,232,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.18)',
    },
    footerText: {
        color: COLORS.chromeMuted,
        fontSize: 13,
        lineHeight: 19,
    },
});

export default BackupAndRecoveryScreen;
