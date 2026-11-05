import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { safeFormatDate } from '../../utils/safeDate';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useTheme } from '../../theme';
import { useWalletStore } from '../../store/walletStore';
import PromiseService, { PromiseQRPayload, AcceptanceQRPayload } from '../../core/promises/PromiseService';
import { promiseRelayService } from '../../core/promises/PromiseRelayService';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';

const DISPLAY_NAME_KEY = 'provian_user_display_name';

type ScanState = 'scanning' | 'preview' | 'accepting' | 'success' | 'offline_acceptance' | 'acceptance_success';

const ScanPromiseScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const { address, userName } = useWalletStore();
    const { colors: themeColors } = useTheme();
    const [permission, requestPermission] = useCameraPermissions();
    const [scanState, setScanState] = useState<ScanState>('scanning');
    const [scannedPayload, setScannedPayload] = useState<PromiseQRPayload | null>(null);
    const [scanned, setScanned] = useState(false);
    const [acceptedPromiseId, setAcceptedPromiseId] = useState<string | null>(null);
    const [myIdentifier, setMyIdentifier] = useState<string>('');
    const [myDisplayName, setMyDisplayName] = useState<string>('');
    const [acceptanceQRData, setAcceptanceQRData] = useState<string | null>(null);
    const [acceptedCreatorName, setAcceptedCreatorName] = useState<string>('');

    const backgroundGradient = GRADIENTS.backgroundDiagonal;

    // Load identifier (wallet address or local display name)
    useEffect(() => {
        loadIdentifier();
    }, []);

    const loadIdentifier = async () => {
        // Load display name first
        try {
            const displayName = await AsyncStorage.getItem(DISPLAY_NAME_KEY);
            if (displayName) {
                setMyDisplayName(displayName);
            } else if (userName) {
                setMyDisplayName(userName);
            }
        } catch (err) {
            console.error('[ScanPromise] Failed to load display name:', err);
        }

        // Use wallet address if available
        if (address) {
            setMyIdentifier(address);
            return;
        }
        // Otherwise use display name for Promise-only users
        try {
            const displayName = await AsyncStorage.getItem(DISPLAY_NAME_KEY);
            if (displayName) {
                setMyIdentifier(`local:${displayName}`);
            } else if (userName) {
                setMyIdentifier(`local:${userName}`);
            } else {
                setMyIdentifier(`local:anonymous-${Date.now()}`);
            }
        } catch (err) {
            console.error('[ScanPromise] Failed to load identifier:', err);
            setMyIdentifier(`local:anonymous-${Date.now()}`);
        }
    };

    const handleBarCodeScanned = async ({ data }: { data: string }) => {
        if (scanned) return;

        // First, check if this is an acceptance QR (creator scanning acceptor's QR)
        const acceptancePayload = PromiseService.parseAcceptanceQRPayload(data);
        if (acceptancePayload) {
            setScanned(true);
            await handleAcceptanceQRScanned(acceptancePayload);
            return;
        }

        // Otherwise, check if it's a promise creation QR
        const payload = PromiseService.parseQRPayload(data);
        if (payload) {
            setScanned(true);
            // A promise already on this phone opens as it is NOW (R9,): its code may carry
            // terms the promise has moved past (a counter, an acceptance), and the preview's
            // Accept would act on the record, not on what the preview shows.
            const known = await PromiseService.findExistingForImport(payload).catch(() => null);
            if (known) {
                navigation.replace('PromiseDetail', { promiseId: known.id });
                return;
            }
            setScannedPayload(payload);
            setScanState('preview');
        } else {
            // Set scanned to prevent multiple alerts, then reset on dismiss
            setScanned(true);
            Alert.alert(
                t('promise.invalidQR'),
                t('promise.invalidQRMsg'),
                [
                    {
                        text: t('common.ok'),
                        onPress: () => {
                            setScanned(false);
                        },
                    },
                ],
                { cancelable: true, onDismiss: () => setScanned(false) }
            );
        }
    };

    // Handle when creator scans an acceptance QR from acceptor
    const handleAcceptanceQRScanned = async (acceptancePayload: AcceptanceQRPayload) => {
        setScanState('accepting');
        try {
            const promise = await PromiseService.importAcceptanceFromQR(acceptancePayload);
            if (promise) {
                setAcceptedPromiseId(promise.id);
                setAcceptedCreatorName(acceptancePayload.acceptorName);
                setScanState('acceptance_success');
            } else {
                Alert.alert(t('common.errorTitle'), t('promise.couldNotFind'));
                resetScanner();
            }
        } catch (error) {
            console.error('[ScanPromise] Failed to import acceptance:', error);
            Alert.alert(t('common.errorTitle'), t('promise.failedToImportAcceptance'));
            resetScanner();
        }
    };

    const resetScanner = () => {
        setScannedPayload(null);
        setScanned(false);
        setScanState('scanning');
        setAcceptanceQRData(null);
    };

    const handleAccept = async () => {
        if (!scannedPayload || !myIdentifier) return;

        setScanState('accepting');
        try {
            // Import the promise from QR
            const promise = await PromiseService.importPromiseFromQR(scannedPayload, myIdentifier);
            if (!promise) {
                Alert.alert(t('common.errorTitle'), t('promise.failedToImport'));
                setScanState('preview');
                return;
            }

            // Accept as the recipient : sign the EIP-191 accept over the
            // digest, encrypt this party's terms copy, and publish to the relay
            // with backoff (the creator's relay doc may not have replicated yet).
            // This is the SAME path PromiseDetail's "Open to accept" uses; a
            // confirmed publish (accepted_synced) marks the promise relay-backed so
            // a later OFFLINE close-out defers instead of unilaterally settling.
            const acceptorName = myDisplayName || userName || 'Anonymous';
            const result = await PromiseService.acceptImportedPromise(promise.id, myIdentifier, acceptorName);

            if (!result) {
                Alert.alert(t('common.errorTitle'), t('promise.failedToAccept'));
                setScanState('preview');
                return;
            }

            if (result.mode === 'accepted_synced') {
                // Online - the relay confirmed the acceptance.
                setAcceptedPromiseId(promise.id);
                setScanState('success');
                console.log('[ScanPromise] Promise accepted and synced:', promise.id);
            } else {
                // Offline / creator doc not present yet - hand off the acceptance
                // via QR for the creator to scan (the in-person two-QR flow).
                const qrData = PromiseService.generateAcceptanceQRPayload(
                    promise.id,
                    result.promise.counterpartySignature ?? '',
                    acceptorName,
                    myIdentifier
                );
                setAcceptanceQRData(qrData);
                setAcceptedPromiseId(promise.id);
                setAcceptedCreatorName(scannedPayload.creatorName || 'them');
                setScanState('offline_acceptance');
                console.log('[ScanPromise] Offline - showing acceptance QR:', promise.id);
            }
        } catch (error) {
            console.error('[ScanPromise] Failed to accept:', error);
            Alert.alert(t('common.errorTitle'), t('promise.failedToAccept'));
            setScanState('preview');
        }
    };

    const handleReject = () => {
        Alert.alert(
            t('promise.rejectPromise'),
            t('promise.rejectConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.reject'),
                    style: 'destructive',
                    onPress: () => {
                        // Pass-3 #29: signal the creator that their pending offer was
                        // declined, so their subscribed/polling device leaves
                        // "awaiting acceptance" instead of hanging on 'pending'
                        // forever. Best-effort + fire-and-forget: if the creator's
                        // relay doc doesn't exist yet (offline create) the publish
                        // just no-ops, exactly as the prior silent local discard did.
                        const rejectedId = scannedPayload?.promiseId;
                        if (rejectedId) {
                            promiseRelayService.publishPromiseRejected(rejectedId).catch((err) => {
                                console.log('[ScanPromise] Reject publish skipped:', err?.message);
                            });
                        }
                        setScannedPayload(null);
                        setScanned(false);
                        setScanState('scanning');
                    },
                },
            ]
        );
    };

    const handleScanAgain = () => {
        resetScanner();
    };

    if (!permission) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#4A8EE8" />
                </View>
            </SafeAreaView>
        );
    }

    if (!permission.granted) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />
                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} />
                    <Text style={styles.headerTitle}>{t('promise.scanTitle')}</Text>
                    <View style={{ width: 44 }} />
                </View>

                <View style={styles.permissionContainer}>
                    <View style={styles.permissionIcon}>
                        <Ionicons name="camera" size={48} color="#9CA3AF" />
                    </View>
                    <Text style={styles.permissionTitle}>{t('promise.cameraRequired')}</Text>
                    <Text style={styles.permissionText}>
                        {t('promise.cameraRequiredMsg')}
                    </Text>
                    <TouchableOpacity
                        style={styles.permissionButton}
                        onPress={requestPermission}
                    >
                        <Text style={styles.permissionButtonText}>{t('promise.grantAccess')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Success Screen
    if (scanState === 'success' && scannedPayload) {
        const creatorName = scannedPayload.creatorName || t('promise.someone');
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.successContent}>
                    <View style={styles.successIconCircle}>
                        <Ionicons name="checkmark-circle" size={64} color="#4CC38A" />
                    </View>

                    <Text style={styles.successTitle}>{t('promise.accepted')}</Text>
                    <Text style={styles.successSubtitle}>
                        {t('promise.acceptedMsg', { name: creatorName })}
                    </Text>

                    <View style={styles.successCard}>
                        <Text style={styles.previewLabel}>{t('promise.exchangeSection')}</Text>
                        {scannedPayload.theyGave && scannedPayload.theyOwe ? (
                            <View style={styles.exchangeRow}>
                                <Text style={styles.exchangeText}>{scannedPayload.theyGave}</Text>
                                <Ionicons name="arrow-forward" size={16} color="#E8A838" />
                                <Text style={styles.exchangeText}>{scannedPayload.theyOwe}</Text>
                            </View>
                        ) : (
                            <Text style={styles.previewValue}>{(scannedPayload as any).what || t('promise.detailsFallback')}</Text>
                        )}

                        <Text style={styles.previewLabel}>{t('promise.withSection')}</Text>
                        <Text style={styles.previewValue}>{creatorName}</Text>
                    </View>

                    <TouchableOpacity
                        style={styles.viewPromiseButton}
                        onPress={() => navigation.replace('PromiseDetail', { promiseId: acceptedPromiseId })}
                    >
                        <Text style={styles.viewPromiseButtonText}>{t('promise.viewPromise')}</Text>
                        <Ionicons name="arrow-forward" size={20} color="#0B0E14" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.doneButton}
                        onPress={() => navigation.goBack()}
                    >
                        <Text style={styles.doneButtonText}>{t('common.done')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Offline Acceptance Screen - Show QR for creator to scan
    if (scanState === 'offline_acceptance' && acceptanceQRData) {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.successCloseRow}>
                    <TouchableOpacity
                        onPress={() => navigation.goBack()}
                        style={styles.successCloseButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Ionicons name="close" size={26} color={themeColors.textSecondary} />
                    </TouchableOpacity>
                </View>

                <View style={styles.successContent}>
                    <View style={styles.offlineIcon}>
                        <Ionicons name="cloud-offline" size={40} color="#E8A838" />
                    </View>

                    <Text style={styles.offlineTitle}>{t('promise.youreOffline')}</Text>
                    <Text style={styles.offlineSubtitle}>
                        {t('promise.offlineInstruction', { name: acceptedCreatorName })}
                    </Text>

                    <View style={styles.qrContainer}>
                        <QRCode
                            value={acceptanceQRData}
                            size={200}
                            backgroundColor="white"
                            color="#0B0E14"
                        />
                    </View>

                    <Text style={styles.offlineHint}>
                        {t('promise.theyllScan')}
                    </Text>

                    <TouchableOpacity
                        style={styles.viewPromiseButton}
                        onPress={() => navigation.replace('PromiseDetail', { promiseId: acceptedPromiseId })}
                    >
                        <Text style={styles.viewPromiseButtonText}>{t('promise.viewPromise')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Acceptance Success Screen - When creator scans acceptor's QR
    if (scanState === 'acceptance_success') {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.successContent}>
                    <View style={styles.successIconCircle}>
                        <Ionicons name="checkmark-circle" size={64} color="#4CC38A" />
                    </View>

                    <Text style={styles.successTitle}>{t('promise.creatorAccepted', { name: acceptedCreatorName })}</Text>
                    <Text style={styles.successSubtitle}>
                        {t('promise.promiseNowActive')}
                    </Text>

                    <TouchableOpacity
                        style={styles.viewPromiseButton}
                        onPress={() => navigation.replace('PromiseDetail', { promiseId: acceptedPromiseId })}
                    >
                        <Text style={styles.viewPromiseButtonText}>{t('promise.viewPromise')}</Text>
                        <Ionicons name="arrow-forward" size={20} color="#0B0E14" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.doneButton}
                        onPress={() => navigation.goBack()}
                    >
                        <Text style={styles.doneButtonText}>{t('common.done')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Preview Screen
    if (scanState === 'preview' && scannedPayload) {
        const creatorName = scannedPayload.creatorName || scannedPayload.creatorAddress.slice(0, 12) + '...';
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />

                <View style={styles.header}>
                    <BackButton onPress={() => navigation.goBack()} />
                    <Text style={styles.headerTitle}>{t('promise.promiseFound')}</Text>
                    <View style={{ width: 44 }} />
                </View>

                <View style={styles.previewContent}>
                    <View style={styles.previewIcon}>
                        <Ionicons name="heart" size={48} color="#E8A838" />
                    </View>

                    <Text style={styles.previewTitle}>{t('promise.madeYouPromise', { name: creatorName })}</Text>

                    <View style={styles.previewCard}>
                        <Text style={styles.previewLabel}>{t('promise.exchangeSection')}</Text>
                        {scannedPayload.theyGave && scannedPayload.theyOwe ? (
                            <View style={styles.exchangeRow}>
                                <Text style={styles.exchangeText}>{scannedPayload.theyGave}</Text>
                                <Ionicons name="arrow-forward" size={16} color="#E8A838" />
                                <Text style={styles.exchangeText}>{scannedPayload.theyOwe}</Text>
                            </View>
                        ) : (
                            <Text style={styles.previewValue}>{(scannedPayload as any).what || t('promise.detailsFallback')}</Text>
                        )}

                        <Text style={styles.previewLabel}>{t('promise.fromSection')}</Text>
                        <Text style={styles.previewValue}>{creatorName}</Text>

                        {scannedPayload.dueDate && (
                            <>
                                <Text style={styles.previewLabel}>{t('promise.dueSection')}</Text>
                                <Text style={styles.previewValue}>
                                    {safeFormatDate(scannedPayload.dueDate, 'MMMM d, yyyy')}
                                </Text>
                            </>
                        )}
                    </View>

                    <View style={styles.previewActions}>
                        <TouchableOpacity
                            style={styles.acceptButton}
                            onPress={handleAccept}
                        >
                            <Ionicons name="checkmark-circle" size={20} color="#0B0E14" />
                            <Text style={styles.acceptButtonText}>{t('promise.acceptPromise')}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.rejectButton}
                            onPress={handleReject}
                        >
                            <Ionicons name="close-circle" size={20} color={COLORS.error} />
                            <Text style={styles.rejectButtonText}>{t('common.reject')}</Text>
                        </TouchableOpacity>
                    </View>

                    <TouchableOpacity style={styles.scanAgainButton} onPress={handleScanAgain}>
                        <Ionicons name="qr-code" size={18} color="#4A8EE8" />
                        <Text style={styles.scanAgainText}>{t('promise.scanDifferent')}</Text>
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        );
    }

    // Accepting Screen
    if (scanState === 'accepting') {
        return (
            <SafeAreaView style={styles.container}>
                <LinearGradient
                    colors={backgroundGradient}
                    style={StyleSheet.absoluteFill}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#E8A838" />
                    <Text style={styles.loadingText}>{t('promise.acceptingPromise')}</Text>
                </View>
            </SafeAreaView>
        );
    }

    // Scanner Screen
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('promise.scanTitle')}</Text>
                <View style={{ width: 44 }} />
            </View>

            <View style={styles.scannerContainer}>
                <CameraView
                    style={styles.camera}
                    facing="back"
                    onBarcodeScanned={handleBarCodeScanned}
                    barcodeScannerSettings={{
                        barcodeTypes: ['qr'],
                    }}
                />

                {/* Overlay */}
                <View style={styles.overlay}>
                    <View style={styles.overlayTop} />
                    <View style={styles.overlayMiddle}>
                        <View style={styles.overlaySide} />
                        <View style={styles.scanFrame}>
                            <View style={[styles.corner, styles.cornerTL]} />
                            <View style={[styles.corner, styles.cornerTR]} />
                            <View style={[styles.corner, styles.cornerBL]} />
                            <View style={[styles.corner, styles.cornerBR]} />
                        </View>
                        <View style={styles.overlaySide} />
                    </View>
                    <View style={styles.overlayBottom}>
                        <Text style={styles.scanText}>
                            {t('promise.pointCamera')}
                        </Text>
                    </View>
                </View>
            </View>

            {/* Instructions */}
            <View style={styles.instructions}>
                <View style={styles.instructionItem}>
                    <View style={styles.instructionIcon}>
                        <Ionicons name="qr-code" size={20} color="#4A8EE8" />
                    </View>
                    <Text style={styles.instructionText}>
                        {t('promise.scanInstruction')}
                    </Text>
                </View>
            </View>
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
        position: 'absolute',
        top: 50,
        left: 0,
        right: 0,
        zIndex: 10,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: COLORS.text,
        letterSpacing: 0.3,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingText: {
        color: COLORS.chromeMuted,
        marginTop: SPACING.m,
        fontSize: 16,
        fontWeight: '500',
    },
    permissionContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.xl,
    },
    permissionIcon: {
        width: 110,
        height: 110,
        borderRadius: 55,
        backgroundColor: 'rgba(18,21,26,0.70)',
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    permissionTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
    },
    permissionText: {
        fontSize: 14,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.xl,
    },
    permissionButton: {
        backgroundColor: '#4A8EE8',
        paddingHorizontal: SPACING.xl,
        paddingVertical: SPACING.m,
        borderRadius: 28,
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.4,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
    },
    permissionButtonText: {
        color: 'white',
        fontWeight: '700',
        fontSize: 16,
    },
    scannerContainer: {
        flex: 1,
    },
    camera: {
        flex: 1,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
    },
    overlayTop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
    },
    overlayMiddle: {
        flexDirection: 'row',
    },
    overlaySide: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
    },
    scanFrame: {
        width: 250,
        height: 250,
        position: 'relative',
    },
    corner: {
        position: 'absolute',
        width: 32,
        height: 32,
        borderColor: '#4A8EE8',
    },
    cornerTL: {
        top: 0,
        left: 0,
        borderTopWidth: 4,
        borderLeftWidth: 4,
        borderTopLeftRadius: 10,
    },
    cornerTR: {
        top: 0,
        right: 0,
        borderTopWidth: 4,
        borderRightWidth: 4,
        borderTopRightRadius: 10,
    },
    cornerBL: {
        bottom: 0,
        left: 0,
        borderBottomWidth: 4,
        borderLeftWidth: 4,
        borderBottomLeftRadius: 10,
    },
    cornerBR: {
        bottom: 0,
        right: 0,
        borderBottomWidth: 4,
        borderRightWidth: 4,
        borderBottomRightRadius: 10,
    },
    overlayBottom: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
        alignItems: 'center',
        paddingTop: SPACING.xl,
    },
    scanText: {
        color: COLORS.chromeMuted,
        fontSize: 14,
        textAlign: 'center',
        fontWeight: '500',
    },
    instructions: {
        padding: SPACING.l,
        backgroundColor: '#0B0E14',
    },
    instructionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.m,
    },
    instructionIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(74,142,232,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    instructionText: {
        flex: 1,
        color: '#8B929E',
        fontSize: 14,
    },
    previewContent: {
        flex: 1,
        padding: SPACING.l,
        alignItems: 'center',
        justifyContent: 'center',
    },
    previewIcon: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: 'rgba(255,179,0,0.10)',
        borderWidth: 2,
        borderColor: 'rgba(255,179,0,0.25)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    previewTitle: {
        fontSize: 22,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.xl,
        textAlign: 'center',
    },
    previewCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        width: '100%',
        marginBottom: SPACING.xl,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    previewLabel: {
        fontSize: 11,
        color: '#9CA3AF',
        letterSpacing: 2,
        textTransform: 'uppercase',
        fontWeight: '600',
        marginTop: SPACING.m,
    },
    previewValue: {
        fontSize: 16,
        color: COLORS.text,
        fontWeight: '600',
        marginTop: 4,
    },
    previewActions: {
        width: '100%',
        gap: SPACING.m,
    },
    acceptButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.l,
        borderRadius: 28,
        gap: SPACING.s,
        backgroundColor: '#E8A838',
        shadowColor: '#E8A838',
        shadowOpacity: 0.45,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    acceptButtonText: {
        color: '#0B0E14',
        fontSize: 18,
        fontWeight: '700',
    },
    rejectButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.l,
        borderRadius: 28,
        gap: SPACING.s,
        backgroundColor: 'rgba(255,71,87,0.15)',
        borderWidth: 1,
        borderColor: 'rgba(255,71,87,0.35)',
    },
    rejectButtonText: {
        color: COLORS.error,
        fontSize: 16,
        fontWeight: '600',
    },
    scanAgainButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: SPACING.m,
        marginTop: SPACING.l,
        gap: SPACING.s,
    },
    scanAgainText: {
        color: '#4A8EE8',
        fontWeight: '600',
    },
    // Exchange display
    exchangeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.s,
        marginTop: SPACING.s,
        flexWrap: 'wrap',
    },
    exchangeText: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
        flex: 1,
    },
    // Success screen
    successCloseRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: SPACING.m,
        paddingTop: SPACING.s,
    },
    successCloseButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    successContent: {
        flex: 1,
        padding: SPACING.l,
        alignItems: 'center',
        justifyContent: 'center',
    },
    successIconCircle: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(0,230,118,0.10)',
        borderWidth: 2,
        borderColor: 'rgba(0,230,118,0.25)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    successTitle: {
        fontSize: 28,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
        textAlign: 'center',
    },
    successSubtitle: {
        fontSize: 16,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.xl,
    },
    successCard: {
        backgroundColor: 'rgba(18,21,26,0.70)',
        padding: SPACING.l,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(200,205,214,0.08)',
        width: '100%',
        marginBottom: SPACING.xl,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    viewPromiseButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#E8A838',
        paddingVertical: SPACING.l,
        paddingHorizontal: SPACING.xxl,
        borderRadius: 28,
        gap: SPACING.s,
        width: '100%',
        shadowColor: '#E8A838',
        shadowOpacity: 0.45,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    viewPromiseButtonText: {
        color: '#0B0E14',
        fontSize: 18,
        fontWeight: '700',
    },
    doneButton: {
        paddingVertical: SPACING.m,
        marginTop: SPACING.m,
    },
    doneButtonText: {
        color: '#8B929E',
        fontSize: 16,
        fontWeight: '500',
    },
    // Offline acceptance screen
    offlineIcon: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(255,179,0,0.12)',
        borderWidth: 2,
        borderColor: 'rgba(255,179,0,0.25)',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: SPACING.l,
    },
    offlineTitle: {
        fontSize: 24,
        fontWeight: '700',
        color: COLORS.text,
        marginBottom: SPACING.s,
        textAlign: 'center',
    },
    offlineSubtitle: {
        fontSize: 16,
        color: '#8B929E',
        textAlign: 'center',
        marginBottom: SPACING.xl,
        paddingHorizontal: SPACING.l,
    },
    qrContainer: {
        backgroundColor: 'white',
        padding: SPACING.l,
        borderRadius: 18,
        marginBottom: SPACING.l,
        shadowColor: '#000',
        shadowOpacity: 0.4,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
    },
    offlineHint: {
        fontSize: 14,
        color: '#9CA3AF',
        textAlign: 'center',
        marginBottom: SPACING.xl,
        fontStyle: 'italic',
    },
});

export default ScanPromiseScreen;
