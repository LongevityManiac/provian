import { errorDisplayCopy } from '../../i18n/displayCopy';
import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Alert,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import { requireBiometric, BiometricNotAvailableError, BiometricAuthError } from '../../core/security/requireBiometric';
import * as Device from 'expo-device';
import { useTranslation } from 'react-i18next';
import { COLORS, SPACING, BORDER_RADIUS, GRADIENTS } from '../../constants/theme';
import type { IoniconsName } from '../../types/icons';
import { useBiometricLabel } from '../../core/security/biometricLabel';
import BackButton, { BACK_BUTTON_SIZE } from '../../components/BackButton';

const BiometricSettingsScreen = ({ navigation }: any) => {
    const { t } = useTranslation();
    const [biometricAvailable, setBiometricAvailable] = useState(false);
    const [biometricEnrolled, setBiometricEnrolled] = useState(false);
    const [testing, setTesting] = useState(false);

    const bio = useBiometricLabel();
    const isSimulator = !Device.isDevice;
    const biometricType = bio.label;
    const biometricIcon = bio.method === 'face' ? 'scan' : 'finger-print';

    useEffect(() => {
        checkBiometricStatus();
    }, []);

    const checkBiometricStatus = async () => {
        try {
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();
            setBiometricAvailable(hasHardware);
            setBiometricEnrolled(isEnrolled);
        } catch (error) {
            console.error('[BiometricSettings] Check error:', error);
        }
    };

    const handleTestBiometric = async () => {
        setTesting(true);
        try {
            await requireBiometric(t('biometric.testBiometric', { type: biometricType }));
            Alert.alert(t('common.success'), t('biometric.authSuccessful', { type: biometricType }));
        } catch (error) {
            if (error instanceof BiometricNotAvailableError) {
                Alert.alert(t('biometric.biometricNotAvailable'), errorDisplayCopy(error.message));
            } else if (error instanceof BiometricAuthError) {
                Alert.alert(t('biometric.failed'), t('biometric.authCancelledOrFailed'));
            } else {
                Alert.alert(t('common.errorTitle'), errorDisplayCopy(error instanceof Error ? error.message : t('biometric.couldNotAuthenticate')));
            }
        } finally {
            setTesting(false);
        }
    };

    const biometricEnabled = biometricAvailable && biometricEnrolled;

    return (
        <SafeAreaView style={styles.container}>
            <LinearGradient
                colors={GRADIENTS.backgroundDiagonal}
                style={StyleSheet.absoluteFill}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
            />

            {/* Header */}
            <View style={styles.header}>
                <BackButton onPress={() => navigation.goBack()} />
                <Text style={styles.headerTitle}>{t('biometric.headerTitle')}</Text>
                <View style={{ width: BACK_BUTTON_SIZE }} />
            </View>

            <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
                {/* Status Card */}
                <View style={[
                    styles.statusCard,
                    biometricEnabled ? styles.statusCardEnabled : styles.statusCardDisabled
                ]}>
                    <Ionicons
                        name={biometricEnabled ? 'checkmark-circle' : 'alert-circle'}
                        size={32}
                        color={biometricEnabled ? '#4CC38A' : '#E8A838'}
                    />
                    <View style={styles.statusContent}>
                        <Text style={styles.statusTitle}>
                            {biometricEnabled ? t('biometric.enabled', { type: biometricType }) : t('biometric.notSetUp', { type: biometricType })}
                        </Text>
                        <Text style={styles.statusSubtitle}>
                            {biometricEnabled
                                ? t('biometric.availableReady')
                                : isSimulator
                                    ? t('biometric.simulatorUnavailable')
                                    : t('biometric.enableInSettings', { type: biometricType })}
                        </Text>
                    </View>
                </View>

                {/* Simulator Warning */}
                {isSimulator && (
                    <View style={styles.warningCard}>
                        <Ionicons name="information-circle" size={20} color="#E8A838" />
                        <Text style={styles.warningText}>
                            {t('biometric.notAvailableWarning', { type: biometricType })}
                        </Text>
                    </View>
                )}

                {/* Test Button */}
                {biometricEnabled && (
                    <TouchableOpacity
                        style={styles.testButton}
                        onPress={handleTestBiometric}
                        disabled={testing}
                    >
                        <Ionicons name={biometricIcon} size={20} color="#4A8EE8" />
                        <Text style={styles.testButtonText}>
                            {testing ? t('biometric.testing') : t('biometric.testBiometric', { type: biometricType })}
                        </Text>
                    </TouchableOpacity>
                )}
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
    scrollView: {
        flex: 1,
    },
    content: {
        padding: SPACING.m,
        paddingBottom: SPACING.xxxl,
    },
    statusCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: SPACING.l,
        borderRadius: 20,
        marginBottom: SPACING.m,
        gap: SPACING.m,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 5,
    },
    statusCardEnabled: {
        backgroundColor: 'rgba(76, 195, 138, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(76, 195, 138, 0.25)',
    },
    statusCardDisabled: {
        backgroundColor: 'rgba(255, 140, 0, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255, 140, 0, 0.25)',
    },
    statusContent: {
        flex: 1,
    },
    statusTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: COLORS.text,
    },
    statusSubtitle: {
        fontSize: 13,
        color: '#8B929E',
        marginTop: 2,
    },
    warningCard: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: SPACING.m,
        backgroundColor: 'rgba(255,179,0,0.08)',
        borderRadius: 18,
        marginBottom: SPACING.l,
        gap: SPACING.s,
        borderWidth: 1,
        borderColor: 'rgba(255,179,0,0.25)',
    },
    warningText: {
        flex: 1,
        fontSize: 13,
        color: '#E8A838',
        lineHeight: 18,
    },
    testButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.s,
        padding: SPACING.m,
        borderRadius: 28,
        borderWidth: 1,
        borderColor: 'rgba(74,142,232,0.30)',
        backgroundColor: 'rgba(74,142,232,0.08)',
        marginTop: SPACING.l,
        shadowColor: '#4A8EE8',
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
    },
    testButtonText: {
        fontSize: 16,
        fontWeight: '500',
        color: '#4A8EE8',
    },
});

export default BiometricSettingsScreen;
