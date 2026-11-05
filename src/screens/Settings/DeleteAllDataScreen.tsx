import { errorDisplayCopy } from '../../i18n/displayCopy';
import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError, clearBiometricFallback } from '../../core/security/requireBiometric';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, GRADIENTS } from '../../constants/theme';
import { useTheme } from '../../theme';
import { useWalletStore } from '../../store/walletStore';
import RelayAPIService, { type DataDeletionOutcome } from '../../services/RelayAPIService';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import WalletCreationService from '../../core/wallet/WalletCreationService';
import { deleteCloudBackup } from '../../core/recovery/cloud/CloudBackupV2';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';
const DeleteAllDataScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { colors: themeColors } = useTheme();
    const { resetOnboarding } = useWalletStore();
    const bio = useBiometricLabel();
    const [isDeleting, setIsDeleting] = useState(false);

    const handleDeleteAllData = async () => {
        // First confirmation - ask about cloud shares
        Alert.alert(
            t('deleteData.confirmTitle'),
            t('deleteData.confirmMsg'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('deleteData.keepCloudBackup'),
                    onPress: () => handleSecondConfirmation(false),
                },
                {
                    text: t('deleteData.deleteEverything'),
                    style: 'destructive',
                    onPress: () => handleSecondConfirmation(true),
                },
            ]
        );
    };

    // D-3 fix: whether the user wants the cloud backup deleted too. The choice travels as an
    // argument from the first prompt to performDeletion — a state setter would not be visible to
    // handlers already bound in this render, so "Delete everything" would keep the backup.
    const handleSecondConfirmation = (deleteCloudBackupToo: boolean) => {
        Alert.alert(
            t('deleteData.absolutelySure'),
            t('deleteData.absolutelySureMsg'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('deleteData.confirmDelete'),
                    style: 'destructive',
                    onPress: () => handleBiometricAuth(deleteCloudBackupToo),
                },
            ]
        );
    };

    const handleBiometricAuth = async (deleteCloudBackupToo: boolean) => {
        try {
            // Every attempt (the first and each "Try again") is its own approval.
            await requireBiometric(t('deleteData.authenticateToDelete'));
            await performDeletion(deleteCloudBackupToo);
        } catch (error) {
            if (error instanceof BiometricNotAvailableError) {
                Alert.alert(t('deleteData.biometricRequired', { label: bio.label }), errorDisplayCopy(error.message));
            } else if (error instanceof BiometricAuthError) {
                Alert.alert(t('biometric.authenticationFailed'), t('deleteData.biometricRequired', { label: bio.label }));
            } else {
                console.error('[DeleteAllData] Biometric auth error:', error);
                Alert.alert(t('common.errorTitle'), t('deleteData.failedToAuthenticate'));
            }
        }
    };

    const performDeletion = async (deleteCloudBackupToo: boolean) => {
        setIsDeleting(true);

        // 1. Relay-side deletion FIRST (2026-10-23 close-out). The request is signed with this
        //    device's relay credentials, which the local wipe below removes; it used to run after
        //    the wipe, best-effort with its result ignored. Nothing local is touched until the relay
        //    has finished. The relay deletes in steps and keeps the sign-in until last, so:
        //    - deleted / account_gone (an earlier attempt already finished) → clear this phone;
        //    - not_finished / unknown (an error or timeout, possibly after part of it was deleted)
        //      → say so; "Try again" re-sends under a fresh approval and finishes it;
        //    - no_access → this phone cannot delete the server data; nothing was deleted.
        //    No credential recovery ever runs here (it would create a fresh account).
        let outcome: DataDeletionOutcome;
        try {
            outcome = await RelayAPIService.requestDataDeletion();
        } catch (relayErr) {
            console.warn('[DeleteAllData] Relay deletion request failed:', relayErr);
            outcome = 'unknown';
        }
        if (outcome === 'deleted' || outcome === 'account_gone') {
            console.log(`[DeleteAllData] Relay data deleted (${outcome})`);
            await wipeThisDevice(deleteCloudBackupToo);
            return;
        }
        setIsDeleting(false);
        const noAccess = outcome === 'no_access';
        Alert.alert(
            t(noAccess ? 'deleteData.relayNoAccessTitle' : 'deleteData.relayDeletionFailedTitle'),
            t(noAccess ? 'deleteData.relayNoAccessMsg' : 'deleteData.relayDeletionFailedMsg'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('common.tryAgain'), onPress: () => { void handleBiometricAuth(deleteCloudBackupToo); } },
                {
                    text: t('deleteData.deleteOnThisPhoneOnly'),
                    style: 'destructive',
                    onPress: () => { void wipeThisDevice(deleteCloudBackupToo); },
                },
            ],
        );
    };

    const wipeThisDevice = async (deleteCloudBackupToo: boolean) => {
        setIsDeleting(true);

        // The wallet whose cloud backup goes : read before the wipe below clears it, so
        // another wallet's backup on the same cloud account is never deleted with this one.
        const walletAddress = useWalletStore.getState().address
            ?? (await AsyncStorage.getItem('provian_evm_address').catch(() => null))
            ?? undefined;

        try {
            console.log('[DeleteAllData] Starting local data deletion...');

            // 2. Wipe wallet seed material via the canonical helper.
            //    SeedManager.deleteAll() drops MNEMONIC + MASTER_SEED from
            //    SecureStore, and WalletCreationService.deleteWallet() also
            //    clears DERIVATION_VERSION and chain-address caches in
            //    AsyncStorage.
            try {
                await WalletCreationService.getInstance().deleteWallet();
                console.log('[DeleteAllData] Wallet seed material wiped');
            } catch (walletErr) {
                console.warn('[DeleteAllData] Wallet wipe failed (continuing):', walletErr);
            }

            // 3. Cloud backup deletion. The synced backup blob lives in its own
            //     store (CloudBackupV2 -> iCloud Keychain on iOS / Google Drive
            //     encrypted app folder on Android) and is NOT touched by the
            //     local SecureStore/AsyncStorage wipes above. It must be deleted
            //     explicitly when the user opts in, or it persists in the cloud.
            let keptUnidentifiedBackup = false;
            if (deleteCloudBackupToo) {
                try {
                    keptUnidentifiedBackup = (await deleteCloudBackup(walletAddress)).keptUnidentifiedBackup;
                    console.log('[DeleteAllData] Cloud backup deleted');
                } catch (cloudErr) {
                    console.warn('[DeleteAllData] Cloud backup deletion failed (continuing):', cloudErr);
                }
            }

            // 4. Clear the biometric-fallback flag so a fresh wallet starts
            //    in normal (hardware-biometric) mode.
            try {
                await clearBiometricFallback();
            } catch {
                /* ignore */
            }

            // 5. Best-effort cleanup of any other Provian SecureStore keys
            //    not covered by the typed services above. Keys are stable
            //    string constants in their owning modules; if any new key is
            //    added it must be appended here AND its owning module's
            //    delete helper must be called above.
            const secureStoreKeys = [
                'provian_device_key',
                'provian_signing_key',
                'provian_encryption_key',
                'provian_recovery_key',
                'provian_session_token',
                'provian_hmac_storage_key', // Phase 2.10 HMAC wrapper key
            ];
            for (const key of secureStoreKeys) {
                try {
                    await SecureStore.deleteItemAsync(key);
                } catch {
                    /* ignore - key may not exist */
                }
            }
            // The relay credentials (auth secret + user id, SecureStore and the service's in-memory
            // copy). After a confirmed relay deletion they name an account that no longer exists;
            // on the phone-only path they are still this wallet's credentials and go with it.
            try {
                await RelayAPIService.clearRelayCredentials();
            } catch {
                /* ignore - keys may not exist */
            }
            console.log('[DeleteAllData] SecureStore cleared');

            // 6. Clear AsyncStorage (all remaining app data - onboarding
            //    flags, policy caches, HMAC envelopes, etc.). This must run
            //    AFTER the wallet/credential helpers above because some of
            //    them write final-state markers as part of their wipe.
            await AsyncStorage.clear();
            console.log('[DeleteAllData] AsyncStorage cleared');

            // 7. Reset Zustand store
            resetOnboarding();
            console.log('[DeleteAllData] Store reset');

            console.log('[DeleteAllData] Deletion complete');

            // Navigate to path selection
            const leave = () => navigation.reset({
                index: 0,
                routes: [{ name: 'Onboarding' }],
            });
            // A backup from before 2026-10-17 names no wallet; it may be another wallet's only
            // recovery, so it was left in place — say so rather than claim it was deleted.
            if (keptUnidentifiedBackup) {
                Alert.alert(t('deleteData.cloudBackupKeptTitle'), t('deleteData.cloudBackupKeptMsg'), [
                    { text: t('common.ok'), onPress: leave },
                ], { cancelable: false });
            } else {
                leave();
            }

        } catch (error) {
            console.error('[DeleteAllData] Deletion error:', error);
            setIsDeleting(false);
            Alert.alert(
                t('deleteData.deletionFailed'),
                t('deleteData.deletionFailedMsg')
            );
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
            />

            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} color={isDeleting ? '#9CA3AF' : COLORS.text} />
                <Text style={styles.headerTitle}>
                    {t('deleteData.headerTitle')}
                </Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.content}
            >
                <View style={styles.warningCard}>
                    <View style={styles.warningIconContainer}>
                        <Ionicons name="warning" size={48} color="#F2555A" />
                    </View>
                    <Text style={styles.warningTitle}>
                        {t('deleteData.permanentDeletion')}
                    </Text>
                    <Text style={styles.warningText}>
                        {t('deleteData.thisWillDelete')}
                    </Text>
                </View>

                <View style={styles.dataList}>
                    <DataItem icon="key" text={t('deleteData.securityKeys')} />
                    <DataItem icon="document-text" text={t('deleteData.allPromises')} />
                    <DataItem icon="hardware-chip" text={t('deleteData.agentSettings')} />
                    <DataItem icon="settings" text={t('deleteData.appSettings')} />
                </View>

                {/* Kept: the phone's PE store (meterFiles, under the app's document directory) and
                    the PEs' encrypted cloud backup are never touched by this deletion. */}
                <View style={styles.noteCard}>
                    <Ionicons name="checkmark-circle" size={20} color={COLORS.success} />
                    <Text style={styles.noteText}>
                        {t('deleteData.provenanceEnvelopes')}
                    </Text>
                </View>

                <View style={styles.noteCard}>
                    <Ionicons name="information-circle" size={20} color="#8B929E" />
                    <Text style={styles.noteText}>
                        {t('deleteData.cloudNote')}
                    </Text>
                </View>

                <TouchableOpacity
                    style={[
                        styles.deleteButton,
                        isDeleting && styles.deleteButtonDisabled
                    ]}
                    onPress={handleDeleteAllData}
                    disabled={isDeleting}
                >
                    {isDeleting ? (
                        <View style={styles.deletingContent}>
                            <ActivityIndicator color="white" size="small" />
                            <Text style={styles.deleteButtonText}>{t('deleteData.deleting')}</Text>
                        </View>
                    ) : (
                        <>
                            <Ionicons name="trash" size={20} color="white" />
                            <Text style={styles.deleteButtonText}>{t('deleteData.headerTitle')}</Text>
                        </>
                    )}
                </TouchableOpacity>

                <Text style={styles.footerText}>
                    {t('deleteData.cannotBeUndone')}
                </Text>
            </ScrollView>
        </SafeAreaView>
    );
};

const DataItem = ({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) => {
    return (
        <View style={styles.dataItem}>
            <Ionicons name={icon} size={18} color="#F2555A" />
            <Text style={styles.dataItemText}>{text}</Text>
        </View>
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
        paddingBottom: 32,
    },
    warningCard: {
        borderRadius: 22,
        borderWidth: 1,
        padding: SPACING.l,
        alignItems: 'center',
        marginBottom: SPACING.l,
        backgroundColor: 'rgba(242,85,90,0.06)',
        borderColor: 'rgba(242,85,90,0.25)',
        shadowColor: '#F2555A',
        shadowOpacity: 0.15,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    warningIconContainer: {
        marginBottom: SPACING.m,
    },
    warningTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: SPACING.s,
        color: COLORS.text,
    },
    warningText: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        color: '#8B929E',
    },
    dataList: {
        borderRadius: 20,
        borderWidth: 1,
        padding: SPACING.m,
        marginBottom: SPACING.l,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderColor: 'rgba(200,205,214,0.08)',
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    dataItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: SPACING.s,
    },
    dataItemText: {
        fontSize: 14,
        marginLeft: SPACING.s,
        color: COLORS.text,
    },
    noteCard: {
        flexDirection: 'row',
        borderRadius: 18,
        borderWidth: 1,
        padding: SPACING.m,
        alignItems: 'flex-start',
        marginBottom: SPACING.l,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderColor: 'rgba(200,205,214,0.08)',
    },
    noteText: {
        flex: 1,
        fontSize: 13,
        marginLeft: SPACING.s,
        lineHeight: 18,
        color: '#8B929E',
    },
    deleteButton: {
        backgroundColor: '#F2555A',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        borderRadius: 28,
        marginBottom: SPACING.m,
        shadowColor: '#F2555A',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
    },
    deleteButtonDisabled: {
        opacity: 0.6,
    },
    deletingContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    deleteButtonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
        marginLeft: SPACING.s,
    },
    footerText: {
        fontSize: 12,
        textAlign: 'center',
        color: '#9CA3AF',
    },
});

export default DeleteAllDataScreen;
