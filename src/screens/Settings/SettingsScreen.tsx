import i18next from 'i18next';
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Alert, Linking, Image, Platform, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as LocalAuthentication from 'expo-local-authentication';
import { requireBiometric } from '../../core/security/requireBiometric';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import { COLORS, SPACING, SHADOWS, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import ProvenanceEnvelopeManager from '../../core/provenance/ProvenanceEnvelopeManager';
import PeCustodyCard from '../../components/PeCustodyCard';
import ArchiveCard from '../../components/ArchiveCard';
import NotificationService, { NotificationPreferences } from '../../services/NotificationService';
import { useWalletStore } from '../../store/walletStore';
import TransactionHistoryService from '../../core/history/TransactionHistoryService';
import EnvironmentAttestation from '../../core/agents/EnvironmentAttestation';
import { useTheme } from '../../theme';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import ProfileAvatarPicker, { AvatarData, loadStoredAvatar } from '../../components/ProfileAvatarPicker';
import RelayAPIService from '../../services/RelayAPIService';
import {
    getMobileChatConsent,
    setMobileChatConsent,
} from '../../core/capture/mobileChatConsent';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
import type { PhonePeExportProgress } from '../../core/meter/phoneExport';

// Storage keys for settings
const BIOMETRIC_ENABLED_KEY = '@provian_biometric_enabled';
const AUTO_LOCK_TIMEOUT_KEY = '@provian_auto_lock_timeout';


const SettingsScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { isOffline, setOffline, isDataSaver, setDataSaver, address, assets, resetOnboarding } = useWalletStore();
    const { colors: themeColors } = useTheme();
    const bio = useBiometricLabel();

    const handleDevReset = () => {
        Alert.alert(
            t('settings.resetApp'),
            t('settings.resetAppConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('settings.reset'),
                    style: 'destructive',
                    onPress: async () => {
                        await AsyncStorage.clear();
                        resetOnboarding();
                        navigation.reset({
                            index: 0,
                            routes: [{ name: 'Onboarding' }],
                        });
                    },
                },
            ]
        );
    };

    // Security settings
    const [biometricEnabled, setBiometricEnabled] = useState(true);
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [autoLockTimeout, setAutoLockTimeout] = useState(5); // minutes

    // Preferences
    // Phase 2c M6: mobile Chat-tab capture consent. null (never asked) is
    // rendered as off; toggling ON from null counts as implicit consent
    // since the user has already seen the subtitle copy.
    const [chatCaptureEnabled, setChatCaptureEnabled] = useState(false);

    // Notification preferences
    const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences>({
        agentActivity: true,
        transactionReceived: true,
        recoveryAlerts: true,
        promiseUpdates: true,
        priceAlerts: false,
        agentCommunicateRequests: true,
        agentCommitRequests: true,
        agentShareDataRequests: true,
    });

    // Profile avatar
    const [avatar, setAvatar] = useState<AvatarData | undefined>(undefined);

    useEffect(() => {
        loadSettings();
        checkBiometricAvailability();
        loadAvatar();
    }, []);

    const loadAvatar = async () => {
        const storedAvatar = await loadStoredAvatar();
        if (storedAvatar) {
            setAvatar(storedAvatar);
        }
    };

    const loadSettings = async () => {
        try {
            const biometric = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
            const timeout = await AsyncStorage.getItem(AUTO_LOCK_TIMEOUT_KEY);
            const prefs = await NotificationService.getPreferences();
            const chatCapture = await getMobileChatConsent();

            if (biometric !== null) setBiometricEnabled(JSON.parse(biometric));
            if (timeout !== null) setAutoLockTimeout(parseInt(timeout));
            setNotificationPrefs(prefs);
            setChatCaptureEnabled(chatCapture === true);
        } catch (error) {
            console.error('[Settings] Error loading settings:', error);
        }
    };

    const handleChatCaptureToggle = async (enabled: boolean): Promise<void> => {
        setChatCaptureEnabled(enabled);
        await setMobileChatConsent(enabled);
    };

    const checkBiometricAvailability = async () => {
        const available = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        setBiometricAvailable(available && enrolled);
    };

    const handleBiometricToggle = async (enabled: boolean) => {
        if (enabled && biometricAvailable) {
            try {
                await requireBiometric(t('biometricPrompts.enableBiometrics'));
                setBiometricEnabled(true);
                await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
            } catch {
                // User cancelled or auth failed - leave the toggle off
            }
        } else {
            setBiometricEnabled(false);
            await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, 'false');
        }
    };

    const handleAutoLockChange = () => {
        const options = [1, 5, 15, 30, 60];
        Alert.alert(
            t('settings.autoLockTimeout'),
            t('settings.lockAfterInactivity'),
            options.map(mins => ({
                text: mins === 60 ? t('settings.oneHour') : t('settings.minutes', { count: mins }),
                onPress: async () => {
                    setAutoLockTimeout(mins);
                    await AsyncStorage.setItem(AUTO_LOCK_TIMEOUT_KEY, String(mins));
                },
            }))
        );
    };

    const handleNotificationPrefChange = async (key: keyof NotificationPreferences, value: boolean) => {
        const updated = { ...notificationPrefs, [key]: value };
        setNotificationPrefs(updated);
        await NotificationService.updatePreferences({ [key]: value });
    };

    // "Export all my PEs" (Settings → Storage): one action, one verifiable file
    // (`provian.pe-export.v1`). Pulling Archive days can take a while; the row shows where it is.
    const [peExport, setPeExport] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });

    const peExportProgressText = (p: PhonePeExportProgress): string => {
        switch (p.stage) {
            case 'archive':
                return p.total ? t('settings.peExport.progressArchive', { done: p.done ?? 0, total: p.total }) : t('settings.peExport.progressStart');
            case 'chains':
                return t('settings.peExport.progressChains');
            case 'received':
                return t('settings.peExport.progressReceived');
            case 'legacy':
                return t('settings.peExport.progressLegacy');
            case 'verify':
                return t('settings.peExport.progressVerify');
            default:
                return t('settings.peExport.progressStart');
        }
    };

    const runPeExport = async (): Promise<void> => {
        if (peExport.busy) return;
        setPeExport({ busy: true, text: t('settings.peExport.progressStart') });
        try {
            const { exportAllMyPes } = await import('../../core/meter/phoneMeterRuntime');
            const { filePath, result } = await exportAllMyPes((p) => setPeExport({ busy: true, text: peExportProgressText(p) }));
            setPeExport({ busy: false, text: null });
            if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(filePath, {
                    mimeType: 'application/x-ndjson',
                    UTI: 'public.json',
                    dialogTitle: t('settings.peExport.shareTitle'),
                });
            }
            const lines = [t('settings.peExport.resultBody', {
                pe: result.counts.pe,
                received: result.counts.received,
                batches: result.counts.batch,
                legacy: result.counts.legacy,
            })];
            if (result.report.pending.length > 0) lines.push(t('settings.peExport.resultPending', { count: result.report.pending.length }));
            if (result.incomplete.length > 0) lines.push(t('settings.peExport.resultIncomplete', { count: result.incomplete.length }));
            if (result.report.failures.length > 0) lines.push(t('settings.peExport.resultFailures', { count: result.report.failures.length }));
            Alert.alert(
                result.complete ? t('settings.peExport.resultTitle') : t('settings.peExport.resultTitleIncomplete'),
                lines.join('\n\n'),
            );
        } catch (error) {
            console.error('[Settings] PE export error:', error);
            setPeExport({ busy: false, text: null });
            Alert.alert(t('common.errorTitle'), t('settings.peExport.failed'));
        }
    };

    const handleExportAllPes = (): void => {
        if (peExport.busy) return;
        Alert.alert(
            t('settings.peExport.confirmTitle'),
            t('settings.peExport.confirmBody'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('settings.peExport.confirmAction'), onPress: () => { void runPeExport(); } },
            ]
        );
    };

    const handleResetAgentData = () => {
        Alert.alert(
            t('settings.resetAgentDataConfirm'),
            t('settings.resetAgentDataMsg'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.continue'),
                    style: 'destructive',
                    onPress: () => {
                        Alert.alert(
                            t('settings.finalConfirmation'),
                            t('settings.finalConfirmationMsg'),
                            [
                                { text: t('common.cancel'), style: 'cancel' },
                                {
                                    text: t('settings.resetEverything'),
                                    style: 'destructive',
                                    onPress: async () => {
                                        try {
                                            await EnvironmentAttestation.clearAll();
                                            Alert.alert(t('settings.resetComplete'), t('settings.agentDataCleared'));
                                        } catch {
                                            Alert.alert(t('common.errorTitle'), t('settings.couldNotResetAgent'));
                                        }
                                    },
                                },
                            ]
                        );
                    },
                },
            ]
        );
    };

    const handleResetRelayConnection = () => {
        Alert.alert(
            t('settings.resetRelayTitle'),
            t('settings.resetRelayMsg'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('settings.resetConnection'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            const walletAddress = address;
                            if (!walletAddress) {
                                Alert.alert(t('common.errorTitle'), t('settings.noWalletAddress'));
                                return;
                            }

                            // Generate a new device ID
                            const randomBytes = await Crypto.getRandomBytesAsync(16);
                            const newDeviceId = `device_${Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

                            // Store the new device ID
                            await AsyncStorage.setItem('@provian_device_id', newDeviceId);

                            // Re-establish this phone's credentials on the wallet's OWN relay
                            // account by wallet signature (a fresh secret, bound to the new device
                            // ID). Never POST /v1/users: that mints a blank account, and the phone
                            // would then read 0 PEs / 0 PVT with nothing left to heal it.
                            // Recovery also re-registers the push token on the account.
                            await RelayAPIService.recoverRelayCredentials(walletAddress);

                            Alert.alert(
                                t('settings.connectionReset'),
                                t('settings.connectionResetMsg'),
                                [{ text: t('common.ok') }]
                            );
                        } catch (error) {
                            console.error('[Settings] Relay reset error:', error);
                            Alert.alert(
                                t('common.errorTitle'),
                                t('settings.connectionResetFailed'),
                                [{ text: t('common.ok') }]
                            );
                        }
                    },
                },
            ]
        );
    };

    const handleExportHistory = async () => {
        try {
            const result = await TransactionHistoryService.getTransactions(address, { limit: 1000 });

            if (result.items.length === 0) {
                Alert.alert(t('settings.noTransactions'), t('settings.noTransactionsMsg'));
                return;
            }

            const csv = generateCSV(result.items);
            const fileName = `provian-transactions-${new Date().toISOString().split('T')[0]}.csv`;
            const filePath = `${FileSystem.cacheDirectory}${fileName}`;

            await FileSystem.writeAsStringAsync(filePath, csv);

            // Check if sharing is available
            const canShare = await Sharing.isAvailableAsync();

            if (canShare) {
                await Sharing.shareAsync(filePath, {
                    mimeType: 'text/csv',
                    dialogTitle: t('settings.exportTransactionHistory'),
                    UTI: 'public.comma-separated-values-text',
                });
            } else {
                // Fallback to clipboard
                await Clipboard.setStringAsync(csv);
                Alert.alert(t('settings.exported'), t('settings.exportedTxHistory'));
            }

            await ProvenanceEnvelopeManager.createEnvelope({
                actionType: 'export_logs',
                intentText: 'Export Transaction History (CSV)',
                assetSymbol: 'N/A',
                amount: String(result.items.length),
                chainId: 0,
                riskScore: 0,
                riskCategory: 'low',
                policyDecision: 'allow',
            });
        } catch (error) {
            console.error('[Settings] Export error:', error);
            Alert.alert(t('common.errorTitle'), t('settings.failedExportTx'));
        }
    };

    const generateCSV = (transactions: any[]): string => {
        const headers = 'Date,Type,Amount,Symbol,Chain,From,To,Hash,Status\n';
        const rows = transactions.map(tx =>
            `${new Date(tx.timestamp).toISOString()},${tx.type},${tx.amount},${tx.symbol},${tx.chain},"${tx.from}","${tx.to}",${tx.hash},${tx.status}`
        ).join('\n');
        return headers + rows;
    };

    const handleViewAddresses = () => {
        const addressesByChain: Record<string, string> = {};
        if (assets.length > 0) {
            for (const asset of assets) {
                if (!addressesByChain[asset.chain]) {
                    addressesByChain[asset.chain] = address;
                }
            }
        } else {
            addressesByChain[t('nav.wallet')] = address;
        }

        const displayText = Object.entries(addressesByChain)
            .map(([chain, addr]) => `${chain}:\n${addr}`)
            .join('\n\n');

        Alert.alert(
            t('settings.walletAddresses'),
            displayText || `${t('nav.wallet')}:\n${address}`,
            [
                { text: t('settings.copyAll'), onPress: () => Clipboard.setStringAsync(displayText || address) },
                { text: t('common.ok') },
            ]
        );
    };

    const MenuItem = ({ icon, title, onPress, value, onValueChange, subtitle, disabled, busy }: {
        icon: keyof typeof Ionicons.glyphMap;
        title: string;
        onPress?: () => void;
        value?: boolean;
        onValueChange?: (v: boolean) => void;
        subtitle?: string;
        /** For toggle rows: render the Switch off/disabled (e.g. biometrics unavailable). */
        disabled?: boolean;
        /** A long action is running: a spinner instead of the chevron, and no second tap. */
        busy?: boolean;
    }) => (
        <TouchableOpacity
            style={styles.menuItem}
            onPress={onPress}
            disabled={disabled || busy === true || (value !== undefined && !onPress)}
        >
            <View style={styles.menuLeft}>
                <View style={styles.menuIconBox}>
                    <Ionicons name={icon} size={18} color={COLORS.chromeMuted} />
                </View>
                <View style={styles.menuTextContainer}>
                    <Text style={styles.menuTitle}>{title}</Text>
                    {subtitle && <Text style={styles.menuSubtitle}>{subtitle}</Text>}
                </View>
            </View>
            {value !== undefined ? (
                <Switch
                    value={value}
                    onValueChange={onValueChange || onPress}
                    disabled={disabled}
                    trackColor={{ false: 'rgba(42,48,56,1)', true: 'rgba(74,142,232,0.4)' }}
                    thumbColor={value ? '#4A8EE8' : '#9CA3AF'}
                />
            ) : busy ? (
                <ActivityIndicator size="small" color={COLORS.chromeMuted} />
            ) : (
                <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            )}
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('settings.title')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                {/* Logo */}
                <View style={{ alignItems: 'center', marginBottom: SPACING.m }}>
                    <Image
                        source={require('../../../assets/images/provian-logo.png')}
                        style={{ width: 48, height: 48 }}
                        resizeMode="contain"
                    />
                </View>

                {/* Profile Card */}
                <View style={styles.profileSection}>
                    <View style={styles.profileAvatarGlow}>
                        <ProfileAvatarPicker
                            currentAvatar={avatar}
                            onAvatarChange={setAvatar}
                            size={72}
                            editable={true}
                        />
                    </View>
                    <View style={styles.profileInfo}>
                        <Text style={styles.profileLabel}>{t('settings.profile')}</Text>
                        <Text style={styles.profileHint}>
                            {t('settings.tapToCustomize')}
                        </Text>
                    </View>
                </View>

                {/* Security */}
                <Text style={styles.sectionHeader}>{t('credential.securitySection')}</Text>

                <MenuItem
                    icon="finger-print"
                    title={t('settings.biometrics')}
                    subtitle={biometricAvailable ? bio.label : i18next.t('receiveScreen.notAvailable')}
                    value={biometricEnabled && biometricAvailable}
                    onValueChange={handleBiometricToggle}
                    disabled={!biometricAvailable}
                />
                <MenuItem
                    icon="timer-outline"
                    title={t('settings.autoLockTimeout')}
                    subtitle={autoLockTimeout === 60 ? t('settings.oneHour') : t('settings.minutes', { count: autoLockTimeout })}
                    onPress={handleAutoLockChange}
                />
                <MenuItem
                    icon="shield"
                    title={t('settings.security')}
                    onPress={() => navigation.navigate('SecuritySettings')}
                />
                <MenuItem
                    icon="cloud-outline"
                    title={t('settings.backupAndRecovery.title')}
                    onPress={() => navigation.navigate('BackupAndRecovery')}
                />
                {/* Burn-to-present is profile-anchored now : "Present my
                    credentials" lives on your own Commons profile, and the
                    requester role on a counterparty's profile — not in Settings. */}

                {/* Preferences */}
                <Text style={styles.sectionHeader}>{t('settings.preferencesSection')}</Text>
                <MenuItem
                    icon="language"
                    title={t('settings.language')}
                    onPress={() => navigation.navigate('Language')}
                />
                <MenuItem
                    icon="eye-off-outline"
                    title={t('commonsSafety.blockedTitle')}
                    onPress={() => navigation.navigate('CommonsBlocked')}
                />
                <MenuItem
                    icon="chatbubbles-outline"
                    title={t('settings.chatCapture')}
                    subtitle={t('settings.chatCaptureDesc')}
                    value={chatCaptureEnabled}
                    onValueChange={handleChatCaptureToggle}
                />
                {/* No Android "Usage access" row: out-of-app capture is not live. */}

                {/* Notifications */}
                <Text style={styles.sectionHeader}>{t('settings.notificationsSection')}</Text>
                <MenuItem
                    icon="hardware-chip"
                    title={t('settings.agentApprovals')}
                    value={notificationPrefs.agentActivity}
                    onValueChange={(v: boolean) => handleNotificationPrefChange('agentActivity', v)}
                />
                <MenuItem
                    icon="arrow-down-circle"
                    title={t('settings.transactionReceived')}
                    value={notificationPrefs.transactionReceived}
                    onValueChange={(v: boolean) => handleNotificationPrefChange('transactionReceived', v)}
                />
                <MenuItem
                    icon="shield"
                    title={t('settings.recoveryAlerts')}
                    value={notificationPrefs.recoveryAlerts}
                    onValueChange={(v: boolean) => handleNotificationPrefChange('recoveryAlerts', v)}
                />
                <MenuItem
                    icon="heart"
                    title={t('settings.promiseUpdates')}
                    value={notificationPrefs.promiseUpdates}
                    onValueChange={(v: boolean) => handleNotificationPrefChange('promiseUpdates', v)}
                />

                {/* Account */}
                <Text style={styles.sectionHeader}>{t('settings.accountSection')}</Text>

                <MenuItem
                    icon="wallet"
                    title={t('settings.viewAllAddresses')}
                    subtitle={t('settings.perChainAddresses')}
                    onPress={handleViewAddresses}
                />
                <MenuItem
                    icon="download-outline"
                    title={t('settings.exportTransactionHistory')}
                    subtitle={t('settings.shareOrSaveCSV')}
                    onPress={handleExportHistory}
                />
                <MenuItem icon="people" title={t('settings.contacts')} onPress={() => navigation.navigate('Contacts')} />

                {/* Connectivity */}
                <Text style={styles.sectionHeader}>{t('settings.connectivitySection')}</Text>
                <MenuItem
                    icon="cloud-offline-outline"
                    title={t('settings.offlineMode')}
                    subtitle={t('settings.queueTransactions')}
                    value={isOffline}
                    onValueChange={setOffline}
                />
                <MenuItem
                    icon="cellular-outline"
                    title={t('settings.dataSaver')}
                    subtitle={t('settings.reduceDataUsage')}
                    value={isDataSaver}
                    onValueChange={setDataSaver}
                />

                {/* Storage */}
                <Text style={styles.sectionHeader}>{t('settings.storageSection')}</Text>
                <PeCustodyCard />
                {/* : the paid PE Archive ($5 USDC per GB, kept permanently). */}
                <ArchiveCard />
                <MenuItem
                    icon="document-text-outline"
                    title={t('settings.peExport.title')}
                    subtitle={peExport.busy && peExport.text ? peExport.text : t('settings.peExport.subtitle')}
                    onPress={handleExportAllPes}
                    busy={peExport.busy}
                />

                {/* Agent Data */}
                <Text style={styles.sectionHeader}>{t('settings.agentData')}</Text>
                <MenuItem
                    icon="trash"
                    title={t('settings.resetAgentData')}
                    subtitle={t('settings.clearAttestationBaselines')}
                    onPress={handleResetAgentData}
                />

                {/* Advanced */}
                <Text style={styles.sectionHeader}>{t('settings.advancedSection')}</Text>
                <MenuItem
                    icon="hardware-chip-outline"
                    title={t('settings.registeredDevices')}
                    subtitle={t('settings.manageDevices')}
                    onPress={() => navigation.navigate('DeviceManagement')}
                />
                <MenuItem
                    icon="sync-outline"
                    title={t('settings.resetRelayConnection')}
                    subtitle={t('settings.reRegisterRelay')}
                    onPress={handleResetRelayConnection}
                />
                <MenuItem
                    icon="exit-outline"
                    title={t('settings.exitStrategy')}
                    subtitle={t('settings.exportSeedOrMigrate')}
                    onPress={() => navigation.navigate('ExitStrategyInfo')}
                />

                {/* Support */}
                <Text style={styles.sectionHeader}>{t('settings.supportSection')}</Text>
                <MenuItem
                    icon="help-circle"
                    title={t('settings.helpAndFaq')}
                    onPress={() => navigation.navigate('HelpSupport')}
                />
                <MenuItem
                    icon="mail-unread-outline"
                    title={t('settings.communityUpdates')}
                    onPress={() => navigation.navigate('StayInTheLoop', { fromSettings: true })}
                />
                <MenuItem
                    icon="chatbubble-outline"
                    title={t('settings.contactSupport')}
                    onPress={async () => {
                        const url = 'mailto:hello@provian.ai?subject=Provian%20Support%20Request';
                        const canOpen = await Linking.canOpenURL(url);
                        if (canOpen) {
                            Linking.openURL(url);
                        } else {
                            Alert.alert(t('settings.contactSupport'), t('settings.contactSupportMsg'), [{ text: t('common.ok') }]);
                        }
                    }}
                />
                <MenuItem
                    icon="bulb-outline"
                    title={t('settings.suggestFeature')}
                    subtitle={t('settings.suggestFeatureSub')}
                    onPress={async () => {
                        const url = 'mailto:hello@provian.ai?subject=Feature%20Suggestion%20-%20Provian%20Wallet&body=Hi%20Provian%20team%2C%0A%0AI%20have%20a%20suggestion%20for%20the%20app%3A%0A%0A';
                        const canOpen = await Linking.canOpenURL(url);
                        if (canOpen) {
                            Linking.openURL(url);
                        } else {
                            Alert.alert(t('settings.suggestFeature'), t('settings.suggestFeatureMsg'), [{ text: t('common.ok') }]);
                        }
                    }}
                />

                {/* Legal */}
                <Text style={styles.sectionHeader}>{t('settings.legalSection')}</Text>
                <MenuItem
                    icon="document-text"
                    title={t('settings.termsOfService')}
                    onPress={() => navigation.navigate('TermsOfService')}
                />
                <MenuItem
                    icon="lock-closed"
                    title={t('settings.privacyPolicy')}
                    onPress={() => navigation.navigate('PrivacyPolicy')}
                />
                <MenuItem
                    icon="information-circle"
                    title={t('settings.legalAndAbout')}
                    onPress={() => navigation.navigate('Legal')}
                />

                {/* Danger Zone */}
                <Text style={[styles.sectionHeader, { color: '#F2555A' }]}>{t('settings.dangerZoneSection')}</Text>
                <MenuItem
                    icon="trash"
                    title={t('settings.deleteAllData')}
                    subtitle={t('settings.permanentlyDelete')}
                    onPress={() => navigation.navigate('DeleteAllData')}
                />

                {/* Dev Section */}
                {__DEV__ && !Device.isDevice && (
                    <MenuItem
                        icon="refresh"
                        title={t('settings.resetApp')}
                        subtitle={t('settings.resetAppSub')}
                        onPress={handleDevReset}
                    />
                )}

                <Text style={styles.nameGloss}>{t('common.nameGloss')}</Text>
                <Text style={styles.versionText}>{t('common.version')}</Text>
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
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.m,
        borderRadius: 20,
        marginBottom: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    menuLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    menuIconBox: {
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
    menuTextContainer: {
        flex: 1,
    },
    menuTitle: {
        color: COLORS.text,
        fontSize: 15,
        fontWeight: '500',
    },
    menuSubtitle: {
        color: '#8B929E',
        fontSize: 12,
        marginTop: 2,
    },
    nameGloss: {
        textAlign: 'center',
        color: '#6B7280',
        marginTop: SPACING.xl,
        fontSize: 10,
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    versionText: {
        textAlign: 'center',
        color: '#9CA3AF',
        marginTop: SPACING.xs,
        marginBottom: SPACING.xl,
        fontSize: 12,
    },
    // Profile section styles
    profileSection: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.m,
        borderRadius: 22,
        marginBottom: SPACING.l,
        borderWidth: 1,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    profileAvatarGlow: {
        borderRadius: 40,
        borderWidth: 2,
        borderColor: 'rgba(74,142,232,0.4)',
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.4,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 0 },
    },
    profileInfo: {
        marginLeft: SPACING.m,
        flex: 1,
    },
    profileLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.chromeMuted,
    },
    profileHint: {
        fontSize: 12,
        marginTop: 2,
        color: '#8B929E',
    },
});

export default SettingsScreen;
